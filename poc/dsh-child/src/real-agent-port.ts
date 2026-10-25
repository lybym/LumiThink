/**
 * E2E-02 (issue #52) REAL `BridgeAgentPort` adapter — the bridge between the
 * LumiThink R1-V2 Bridge domain contract (`lib/domain/voice/bridge/agent-port.ts`)
 * and a genuine, locked-version DSH Cordis runtime process.
 *
 * Architecture (docs/VOICE_RUNTIME.md §2/§15):
 *  - `createAgent(sessionKey)` spawns ONE dedicated worker child process
 *    (`bridge-worker-child.ts`) that boots the real pinned runtime
 *    (`dsh-v0.2.0-rc.2`, profile `lumi-dsh-runtime-bridge`) in-process and
 *    exposes the REAL agent surface over a minimal JSON-lines control
 *    channel. One session ⇔ one worker ⇔ one process — a crash or forced
 *    kill isolates exactly that session's runtime.
 *  - `runPrompt` maps to `agent.followup(...)`; the adapter mints its own
 *    bounded attempt id and re-maps every upstream `agent/assistant-stream`
 *    frame onto it (upstream attempt ids never cross the Bridge boundary).
 *  - `cancel({ kind: 'user' })` maps to the REAL `agent.cancel` — no
 *    `keepInbox` (docs/VOICE_RUNTIME.md §4 step 3).
 *  - `whenIdle()` is the bounded stop verification the deployment wiring
 *    owns (lib/domain/voice/bridge/bridge.ts design note): the reply races a
 *    wall-clock deadline; on timeout the adapter reports un-verified stop so
 *    the Bridge's `isRunning()` re-check quarantines the worker
 *    (`cancel_timeout`). A hung worker therefore can never deadlock the
 *    Bridge turn state machine.
 *  - `dispose()` maps to `AgentHandle.dispose()` plus a graceful child
 *    shutdown with an EOF → SIGTERM → SIGKILL backstop ladder.
 *  - A worker process exit (crash) fires the fault signal → the Bridge
 *    quarantines the worker; recovery is an explicit `session.open` rebuild
 *    (fresh process, confirmed identity only, no side-effect replay).
 *
 * PRIVACY: the authorized transient prompt crosses this module exactly once
 * (adapter → worker control line → one synthetic user message) and is never
 * logged, persisted or echoed. Durable settlements forward message IDS only.
 * The stderr tail kept for crash diagnostics is bounded and never returned
 * through the Bridge surface.
 *
 * This module requires the pinned `@deepseek-ai/dsh-*` dependencies that the
 * root package deliberately does not carry (docs/VOICE_RUNTIME.md §12) — it
 * therefore lives in the PoC package and imports the dependency-free domain
 * contract across the package boundary.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  BridgeAgentCancelInput,
  BridgeAgentCancelResult,
  BridgeAgentFailureEvent,
  BridgeAgentHandle,
  BridgeAgentPort,
  BridgeAgentPortErrorCode,
  BridgeDurableEvent,
  BridgeStreamEvent,
} from '../../../lib/domain/voice/bridge/agent-port.ts'
import { buildChildEnv } from './child-env.ts'

/**
 * E2E-08 (issue #58): per-PORT-PROCESS boot epoch. The worker's DSH-side
 * session identity must be fresh per rebuild AND per port boot: when the
 * gateway host restarts against a PERSISTENT dshHome (operator deployment),
 * the DSH runtime reloads its persisted sessions and a counter-only `#w<n>`
 * suffix re-mints identities the persisted store already holds (observed
 * live: worker_error "session ... already exists" on the first create after
 * a gateway restart). The boot epoch salts every minted id so identities can
 * never collide with a previous port process's persisted store.
 */
const PORT_BOOT_EPOCH = randomBytes(4).toString('hex')

// ---------------------------------------------------------------------------
// Profile materialization
// ---------------------------------------------------------------------------

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url))

/** The bridge worker profile directory inside an isolated DSH home. */
export function bridgeProfileDir(dshHome: string): string {
  return join(dshHome, 'profiles', 'lumi-dsh-runtime-bridge')
}

/**
 * Materialize the committed `lumi-dsh-runtime-bridge` profile files into a
 * DSH home. Callers MUST await this before spawning the worker: the child
 * resolves its profile from disk at boot.
 */
export async function materializeBridgeProfileInto(dshHome: string): Promise<string> {
  const profileDir = bridgeProfileDir(dshHome)
  await mkdir(profileDir, { recursive: true })
  const source = join(MODULE_DIR, '..', 'profiles', 'lumi-dsh-runtime-bridge')
  await copyFile(join(source, 'package.json'), join(profileDir, 'package.json'))
  await copyFile(join(source, 'cordis.patch.yml'), join(profileDir, 'cordis.patch.yml'))
  return profileDir
}

// ---------------------------------------------------------------------------
// Worker control protocol (shared shape with bridge-worker-child.ts)
// ---------------------------------------------------------------------------

type WorkerRequest =
  | { readonly op: 'create'; readonly id: number; readonly sessionId: string }
  | { readonly op: 'resume'; readonly id: number; readonly sessionId: string }
  | { readonly op: 'followup'; readonly id: number; readonly sessionId: string; readonly text: string }
  | { readonly op: 'cancel'; readonly id: number; readonly sessionId: string }
  | { readonly op: 'whenIdle'; readonly id: number; readonly sessionId: string }
  | { readonly op: 'dispose'; readonly id: number; readonly sessionId: string }
  | { readonly op: 'shutdown'; readonly id: number }

type WorkerStreamFrame =
  | { readonly kind: 'start'; readonly attemptId: string; readonly stepId: string }
  | {
      readonly kind: 'chunk'
      readonly attemptId: string
      readonly stepId: string
      readonly index: number
      readonly channel: 'text' | 'tool_call' | 'thinking'
      readonly textDelta: string
    }
  | { readonly kind: 'end'; readonly attemptId: string; readonly stepId: string }

type WorkerEvent =
  | { readonly ev: 'ready'; readonly profile: string; readonly pid: number }
  | { readonly ev: 'reply'; readonly id: number; readonly ok: boolean; readonly code?: string; readonly message?: string }
  | { readonly ev: 'stream'; readonly sessionId: string; readonly frame: WorkerStreamFrame }
  | {
      readonly ev: 'durable'
      readonly sessionId: string
      readonly attemptId: string
      readonly messageId: string
      readonly messageRef: string
    }
  | { readonly ev: 'status'; readonly sessionId: string; readonly status: 'idle' | 'running' }
  | {
      /** Bounded turn-phase evidence (diagnostics only; no content). */
      readonly ev: 'phase'
      readonly sessionId: string
      readonly phase: 'pre_step' | 'request' | 'turn_stopping' | 'request_error' | 'step_error'
      readonly turn: number
      readonly step: number
      readonly detail: string
    }
  | { readonly ev: 'stopped' }

// ---------------------------------------------------------------------------
// Options + port surface
// ---------------------------------------------------------------------------

export interface RealAgentPortOptions {
  /** Isolated DSH_HOME with the materialized bridge profile. */
  readonly dshHome: string
  /** Loopback base URL of the local synthetic Messages mock. */
  readonly mockBaseUrl: string
  /** Model route for created agents (defaults mirror the R0 synthetic route). */
  readonly provider?: string
  readonly model?: string
  /**
   * Bounded stop verification: how long `whenIdle()` waits for the worker's
   * idle reply before reporting an un-verified stop (→ Bridge `cancel_timeout`
   * quarantine). Default 2000ms.
   */
  readonly whenIdleTimeoutMs?: number
  /** Bounded graceful dispose wait. Default 1000ms. */
  readonly disposeTimeoutMs?: number
  /** Bounded worker boot wait (ready signal). Default 60000ms. */
  readonly childBootTimeoutMs?: number
  /** Bounded per-request control reply wait (followup/cancel/dispose). Default 15000ms. */
  readonly controlReplyTimeoutMs?: number
  /** Extra worker-child environment entries (e.g. the named fault injections). */
  readonly workerEnv?: Readonly<Record<string, string>>
  /** Inject the worker child module path (tests may point at the same file). */
  readonly workerScriptPath?: string
}

export interface WorkerFaultInfo {
  readonly sessionKey: string
  readonly code: 'worker_crashed'
  /** Bounded structured reason; never carries prompt or model text. */
  readonly detail: 'process_exit' | 'boot_timeout' | 'protocol_violation' | 'control_timeout' | 'request_failed'
  readonly exitCode: number | null
  /** Bounded control-error message when the fault came from a failed reply. */
  readonly message?: string
}

/** The real adapter port plus its fault signal (mirrors MockCordisRuntime.onFault). */
export interface RealCordisAgentPort extends BridgeAgentPort {
  /** Worker fault entry point (wired to the Bridge's crash quarantine). */
  onFault(listener: (info: WorkerFaultInfo) => void): void
  /** Bounded stderr tail of one worker (crash diagnostics; never prompt text). */
  stderrTailSnapshot(sessionKey: string): string
  /** Whether one session still has a live (non-exited) worker process. */
  hasLiveWorker(sessionKey: string): boolean
  /** Forced crash injection: SIGKILL the session's worker process. */
  crashNow(sessionKey: string): boolean
  /** Dispose every worker (suite teardown). */
  disposeAll(): Promise<void>
}

interface PendingRequest {
  readonly resolve: (reply: { readonly ok: boolean; readonly code?: string; readonly message?: string }) => void
  readonly timer: NodeJS.Timeout
}

interface WorkerState {
  readonly sessionKey: string
  /** The fresh DSH-side session identity this worker's agent was created under. */
  dshSessionId: string
  child: ChildProcess | null
  ready: boolean
  readonly readyWaiters: ((ready: boolean) => void)[]
  exited: boolean
  exitCode: number | null
  disposedByRequest: boolean
  stderrTail: string
  readonly pending: Map<number, PendingRequest>
  nextRequestId: number
  handle: RealBridgeHandle
  bootTimer: NodeJS.Timeout | null
  protocolViolations: number
  /**
   * E2E-08 (issue #58): last activity timestamp (ms). The idle reaper disposes
   * workers whose session went quiet — one locked DSH runtime per session is a
   * full runtime process; unreaped idle workers accumulated across turns and
   * OOM-killed the gateway host (observed live). Touched on spawn, every
   * control request, every stream/durable frame and every status event.
   */
  lastActiveAt: number
}

/** Full internal (and test-observable) handle state: ids and counters only. */
export interface RealBridgeHandleState {
  readonly sessionKey: string
  disposed: boolean
  crashed: boolean
  adapterAttemptId: string | null
  cancelRequested: boolean
  idleConfirmed: boolean
  attemptCounter: number
  /**
   * Monotonic index handed to the Bridge for the current adapter attempt.
   * Upstream attempt indexes restart per LlmAttempt (a retried request mints
   * a new attempt id), so the adapter re-indexes — the Bridge's per-attempt
   * strictly-increasing order check must see one continuous attempt.
   */
  nextStreamIndex: number
  readonly upstreamToAdapter: Map<string, string>
  readonly streamListeners: ((event: BridgeStreamEvent) => void)[]
  readonly durableListeners: ((event: BridgeDurableEvent) => void)[]
  readonly failureListeners: ((event: BridgeAgentFailureEvent) => void)[]
  droppedDurableAfterCancel: number
  staleStreamFrames: number
  /**
   * E2E-03 (issue #53) failure tracking for the CURRENT attempt: the worker
   * reports `request_error`/`step_error` phases; a failure flag survives
   * only until the attempt either recovers (any further text chunk) or
   * settles durably. At the attempt `end` (or agent idle) with a still-set
   * flag and no durable settlement, the port notifies the Bridge so the
   * turn can settle FAILED instead of hanging RUNNING forever.
   */
  attemptFailed: boolean
  attemptSettled: boolean
}

const STDERR_TAIL_LIMIT = 4_000
const MAX_TRACKED_ATTEMPTS = 16

function appendStderrTail(state: WorkerState, chunk: string): void {
  state.stderrTail = (state.stderrTail + chunk).slice(-STDERR_TAIL_LIMIT)
}

function isHandleRunning(state: RealBridgeHandleState): boolean {
  return state.adapterAttemptId !== null && !state.crashed && !state.disposed && !state.idleConfirmed
}

// ---------------------------------------------------------------------------
// Port factory
// ---------------------------------------------------------------------------

export function createRealCordisAgentPort(options: RealAgentPortOptions): RealCordisAgentPort {
  if (options === null || typeof options !== 'object') {
    throw new Error('real agent port requires options.')
  }
  if (typeof options.dshHome !== 'string' || options.dshHome.length === 0) {
    throw new Error('real agent port requires an isolated dshHome.')
  }
  if (typeof options.mockBaseUrl !== 'string' || options.mockBaseUrl.length === 0) {
    throw new Error('real agent port requires the loopback mock base URL.')
  }
  const whenIdleTimeoutMs = options.whenIdleTimeoutMs ?? 2_000
  const disposeTimeoutMs = options.disposeTimeoutMs ?? 1_000
  const childBootTimeoutMs = options.childBootTimeoutMs ?? 60_000
  const controlReplyTimeoutMs = options.controlReplyTimeoutMs ?? 15_000
  const workerScriptPath = options.workerScriptPath ?? join(MODULE_DIR, 'bridge-worker-child.ts')
  const provider = options.provider ?? 'deepseek-official'
  const model = options.model ?? 'deepseek-v4-flash'

  const workers = new Map<string, WorkerState>()
  const faultListeners: ((info: WorkerFaultInfo) => void)[] = []
  /**
   * E2E-08 (issue #58): the idle reaper. Each worker is a full locked DSH
   * runtime process; unreaped idle workers accumulated across turns and
   * OOM-killed the gateway host (observed live). A worker whose session went
   * quiet for IDLE_REAP_MS is disposed through its own graceful dispose path
   * (dispose + shutdown requests, then SIGKILL backstop); the Bridge's
   * recovery design rebuilds it on the next turn (fresh process, confirmed
   * identity only). The reaper interval is unref'd so it never holds the
   * process open.
   */
  const IDLE_REAP_MS = 120_000
  const reaper = setInterval(() => {
    const now = Date.now()
    for (const [sessionKey, state] of [...workers.entries()]) {
      if (state.exited || state.child === null) continue
      const handleState = state.handle.state
      if (handleState.disposed || handleState.crashed) continue
      const idleMs = now - state.lastActiveAt
      if (idleMs <= IDLE_REAP_MS) continue
      state.lastActiveAt = now // reap exactly once per idle window
      process.stdout.write(`[real-agent-port] idle worker reaped session=${sessionKey} idleMs=${idleMs}\n`)
      void state.handle.dispose().catch(() => undefined)
    }
  }, 30_000)
  reaper.unref?.()
  /** Fresh DSH session identity per worker rebuild (issue #52 recovery: bind confirmed identity only, never replay). */
  let workerCounter = 0

  function fireFault(info: WorkerFaultInfo): void {
    for (const listener of [...faultListeners]) {
      try {
        listener(info)
      } catch {
        /* listener containment: quarantine must never depend on a listener */
      }
    }
  }

  function sendRequest(state: WorkerState, request: WorkerRequest): void {
    state.lastActiveAt = Date.now()
    const child = state.child
    if (child === null || child.stdin === null || state.exited) {
      throw new Error('worker_fault')
    }
    child.stdin.write(`${JSON.stringify(request)}\n`)
  }

  /** Send one control request and await its bounded reply. */
  async function request(
    state: WorkerState,
    op: WorkerRequest['op'],
    extra: Record<string, unknown> = {},
    timeoutMs = controlReplyTimeoutMs,
  ): Promise<{ readonly ok: boolean; readonly code?: string; readonly message?: string }> {
    // Profile boot may consume stdin before the control reader is mounted.
    // Queue control commands until ready; their reply deadline starts only
    // after boot, which already has its own bounded timeout.
    if (!state.ready) {
      let bootWaitTimedOut = false
      const ready = await new Promise<boolean>((resolve) => {
        if (state.exited || state.child === null) {
          resolve(false)
          return
        }
        // Stop verification/disposal retain their short deadline even during
        // boot. Only startup commands may use the full boot window.
        let timer: NodeJS.Timeout | undefined
        const onReady = (ready: boolean) => {
          if (timer !== undefined) clearTimeout(timer)
          resolve(ready)
        }
        state.readyWaiters.push(onReady)
        if (op !== 'create' && op !== 'followup') {
          timer = setTimeout(() => {
            const index = state.readyWaiters.indexOf(onReady)
            if (index !== -1) state.readyWaiters.splice(index, 1)
            bootWaitTimedOut = true
            resolve(false)
          }, timeoutMs)
          timer.unref?.()
        }
      })
      if (!ready) return { ok: false, code: bootWaitTimedOut ? 'control_timeout' : 'worker_fault' }
    }
    const id = state.nextRequestId
    state.nextRequestId += 1
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.pending.delete(id)
        resolve({ ok: false, code: 'control_timeout' })
      }, timeoutMs)
      timer.unref?.()
      state.pending.set(id, { resolve, timer })
      try {
        sendRequest(state, { op, id, ...extra } as WorkerRequest)
      } catch (error) {
        clearTimeout(timer)
        state.pending.delete(id)
        resolve({ ok: false, code: error instanceof Error ? error.message : 'worker_fault' })
      }
    })
  }

  function handleWorkerEvent(state: WorkerState, raw: string): void {
    state.lastActiveAt = Date.now()
    let event: WorkerEvent
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { ev?: unknown }).ev !== 'string') {
        throw new Error('not a worker event')
      }
      event = parsed as WorkerEvent
    } catch {
      // Stdout carries ONLY the control protocol. Any other byte is a
      // protocol violation and quarantines the worker (fail closed).
      state.protocolViolations += 1
      quarantine(state, 'protocol_violation')
      return
    }
    switch (event.ev) {
      case 'ready': {
        state.ready = true
        if (state.bootTimer !== null) {
          clearTimeout(state.bootTimer)
          state.bootTimer = null
        }
        for (const resolve of state.readyWaiters.splice(0)) resolve(true)
        return
      }
      case 'reply': {
        const pending = state.pending.get(event.id)
        if (pending === undefined) return
        state.pending.delete(event.id)
        clearTimeout(pending.timer)
        pending.resolve({ ok: event.ok, ...(event.code !== undefined ? { code: event.code } : {}), ...(event.message !== undefined ? { message: event.message } : {}) })
        return
      }
      case 'stream': {
        forwardStreamFrame(state, event.frame)
        return
      }
      case 'durable': {
        forwardDurable(state, event)
        return
      }
      case 'phase': {
        // E2E-03 (issue #53): bounded turn-phase diagnostics double as the
        // failure detector — a request/step error marks the CURRENT attempt
        // failed unless a later chunk proves the attempt recovered.
        if (event.phase === 'request_error' || event.phase === 'step_error') {
          state.handle.state.attemptFailed = true
        }
        return
      }
      case 'status': {
        // The agent went idle with a still-unfinished failed attempt and no
        // durable settlement: fire the failure now (belt and braces — the
        // attempt `end` frame usually arrives first).
        const handleState = state.handle.state
        if (
          event.status === 'idle' &&
          handleState.attemptFailed &&
          !handleState.attemptSettled &&
          !(handleState.cancelRequested && !handleState.idleConfirmed) &&
          handleState.adapterAttemptId !== null
        ) {
          fireAttemptFailure(handleState, handleState.adapterAttemptId)
        }
        return
      }
      case 'stopped':
        return
      default:
        return
    }
  }

  /** Notify the Bridge that the attempt ended without a durable settlement. */
  function fireAttemptFailure(handleState: RealBridgeHandleState, attemptId: string): void {
    if (!handleState.attemptFailed || handleState.attemptSettled) return
    if (handleState.cancelRequested && !handleState.idleConfirmed) {
      // Issue #53 review r2 P1-1: a user-cancelled attempt's settlement is
      // owned by the cancel path. An `end` frame for the interrupted attempt
      // commonly arrives BEFORE the `whenIdle` reply — and after a
      // request/step error the failure flag is still set — so this guard must
      // hold for EVERY fire path (streaming `end` and the `status:'idle'`
      // fallback alike), not just the idle one. Firing here would settle the
      // turn FAILED while the Bridge is CANCELLING it (the cancel-path
      // `activeTurn` clear happens after `whenIdle`), flipping an audited
      // user cancel into a model failure. The in-flight state is left for
      // the cancel path's own cleanup (`whenIdle()` or quarantine).
      return
    }
    handleState.attemptFailed = false
    handleState.attemptSettled = true
    // The failed attempt is OVER (its `end` frame arrived or the agent went
    // idle without settling durably): release the attempt binding so the
    // Bridge can schedule the NEXT turn against the same healthy worker
    // without a rebuild — a model failure must not brick the session
    // (issue #53 review r1 P1-1: scheduler liveness after a mid-stream
    // failure). Mirrors the verified-stop cleanup in `whenIdle()`. A late
    // durable settlement for this attempt can no longer map (the upstream
    // mapping is cleared) and the Bridge's activeTurn is already cleared by
    // the FAILED settlement, so neither path can double-settle.
    handleState.adapterAttemptId = null
    handleState.idleConfirmed = true
    handleState.upstreamToAdapter.clear()
    for (const listener of [...handleState.failureListeners]) {
      try {
        listener({ attemptId, code: 'model_request_failed' })
      } catch {
        /* listener containment */
      }
    }
  }

  /** Re-map one upstream stream frame onto the adapter's bounded attempt id. */
  function forwardStreamFrame(state: WorkerState, frame: WorkerStreamFrame): void {
    const handleState = state.handle.state
    if (handleState.disposed || handleState.crashed) return
    let adapterId = handleState.upstreamToAdapter.get(frame.attemptId)
    if (adapterId === undefined) {
      if (handleState.adapterAttemptId === null) {
        // No active adapter attempt: the frame is stale by definition.
        handleState.staleStreamFrames += 1
        return
      }
      adapterId = handleState.adapterAttemptId
      handleState.upstreamToAdapter.set(frame.attemptId, adapterId)
      if (handleState.upstreamToAdapter.size > MAX_TRACKED_ATTEMPTS) {
        const oldest = handleState.upstreamToAdapter.keys().next()
        if (oldest.done !== true) handleState.upstreamToAdapter.delete(oldest.value)
      }
    }
    const mapped: BridgeStreamEvent =
      frame.kind === 'start'
        ? { kind: 'start', attemptId: adapterId, stepId: frame.stepId }
        : frame.kind === 'chunk'
          ? {
              kind: 'chunk',
              attemptId: adapterId,
              stepId: frame.stepId,
              index: handleState.nextStreamIndex,
              channel: frame.channel,
              textDelta: frame.textDelta,
            }
          : { kind: 'end', attemptId: adapterId, stepId: frame.stepId }
    if (frame.kind === 'chunk') {
      // A chunk after a request error means the retried attempt recovered —
      // the failure flag only survives an attempt that ends with no output.
      handleState.nextStreamIndex += 1
      handleState.attemptFailed = false
    }
    for (const listener of [...handleState.streamListeners]) {
      try {
        listener(mapped)
      } catch {
        /* listener containment */
      }
    }
    if (frame.kind === 'end') {
      // The attempt's stream ended: with a still-set failure flag and no
      // durable settlement, the turn must settle FAILED (issue #53 DoD 2)
      // instead of hanging RUNNING forever. The user-cancel guard ("MUST NOT
      // fire it for a user-cancelled attempt", agent-port.ts) is enforced
      // inside fireAttemptFailure itself, so the end frame of an INTERRUPTED
      // attempt — which commonly arrives before the `whenIdle` reply — can
      // never race the cancel path's settlement (issue #53 review r2 P1-1).
      fireAttemptFailure(handleState, adapterId)
    }
  }

  function forwardDurable(
    state: WorkerState,
    event: { readonly sessionId: string; readonly attemptId: string; readonly messageId: string; readonly messageRef: string },
  ): void {
    const handleState = state.handle.state
    if (handleState.disposed || handleState.crashed) return
    const adapterId = handleState.upstreamToAdapter.get(event.attemptId)
    if (adapterId === null || adapterId === undefined) return
    // A durable settlement (even a dropped-after-cancel one) means the
    // attempt's outcome is owned by the durable/cancel paths — the failure
    // notification must never double-settle it.
    handleState.attemptSettled = true
    handleState.attemptFailed = false
    if (handleState.cancelRequested && !handleState.idleConfirmed) {
      // A cancelled attempt's interrupted settlement is audit-only upstream;
      // it must NEVER become a turn.settled(COMPLETED) notification.
      handleState.droppedDurableAfterCancel += 1
      return
    }
    const durable: BridgeDurableEvent = {
      event: 'assistant/message',
      attemptId: adapterId,
      messageId: event.messageId.slice(0, 64),
      messageRef: event.messageRef.slice(0, 64),
    }
    if (handleState.adapterAttemptId === adapterId) {
      // The attempt settled: the Bridge may schedule the next turn.
      handleState.adapterAttemptId = null
      handleState.idleConfirmed = true
    }
    for (const listener of [...handleState.durableListeners]) {
      try {
        listener(durable)
      } catch {
        /* listener containment */
      }
    }
  }

  /** Quarantine one worker: kill the process, fail pending requests, fire the fault. */
  function quarantine(state: WorkerState, detail: WorkerFaultInfo['detail']): void {
    const alreadyQuarantined = state.handle.state.crashed
    state.handle.state.crashed = true
    for (const [, pending] of [...state.pending.entries()]) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, code: 'worker_fault' })
    }
    state.pending.clear()
    killWorker(state)
    if (!alreadyQuarantined && !state.disposedByRequest) {
      fireFault({ sessionKey: state.sessionKey, code: 'worker_crashed', detail, exitCode: state.exitCode })
    }
  }

  function killWorker(state: WorkerState): void {
    for (const resolve of state.readyWaiters.splice(0)) resolve(false)
    const child = state.child
    if (child === null) return
    state.child = null
    if (state.bootTimer !== null) {
      clearTimeout(state.bootTimer)
      state.bootTimer = null
    }
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }

  function spawnWorker(sessionKey: string, dshHome: string, mockBaseUrl: string): WorkerState {
    const handleState: RealBridgeHandleState = {
      sessionKey,
      disposed: false,
      crashed: false,
      adapterAttemptId: null,
      cancelRequested: false,
      idleConfirmed: true,
      attemptCounter: 0,
      nextStreamIndex: 0,
      upstreamToAdapter: new Map(),
      streamListeners: [],
      durableListeners: [],
      failureListeners: [],
      droppedDurableAfterCancel: 0,
      staleStreamFrames: 0,
      attemptFailed: false,
      attemptSettled: false,
    }
    const state: WorkerState = {
      sessionKey,
      dshSessionId: sessionKey,
      child: null,
      ready: false,
      readyWaiters: [],
      exited: false,
      exitCode: null,
      disposedByRequest: false,
      stderrTail: '',
      pending: new Map(),
      nextRequestId: 1,
      handle: null as unknown as RealBridgeHandle,
      bootTimer: null,
      protocolViolations: 0,
      lastActiveAt: Date.now(),
    }
    const handle = createHandle(state, handleState)
    state.handle = handle

    const env = { ...buildChildEnv({ dshHome, mockBaseUrl }) }
    env.DSH_BRIDGE_PROVIDER = provider
    env.DSH_BRIDGE_MODEL = model
    if (options.workerEnv !== undefined) {
      for (const [key, value] of Object.entries(options.workerEnv)) {
        env[key] = value
      }
    }
    const child = spawn(process.execPath, ['--experimental-strip-types', workerScriptPath], {
      cwd: MODULE_DIR,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    state.child = child

    let lineBuffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      lineBuffer += chunk
      for (;;) {
        const newlineAt = lineBuffer.indexOf('\n')
        if (newlineAt < 0) break
        const line = lineBuffer.slice(0, newlineAt).trim()
        lineBuffer = lineBuffer.slice(newlineAt + 1)
        if (line.length === 0) continue
        handleWorkerEvent(state, line)
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      appendStderrTail(state, chunk)
    })
    child.on('error', () => {
      /* spawn failure surfaces through exit/boot-timeout paths */
    })
    child.on('exit', (code) => {
      for (const resolve of state.readyWaiters.splice(0)) resolve(false)
      state.exited = true
      state.exitCode = code
      if (state.bootTimer !== null) {
        clearTimeout(state.bootTimer)
        state.bootTimer = null
      }
      if (!state.disposedByRequest) {
        quarantine(state, 'process_exit')
      } else {
        for (const [, pending] of [...state.pending.entries()]) {
          clearTimeout(pending.timer)
          pending.resolve({ ok: false, code: 'worker_fault' })
        }
        state.pending.clear()
      }
    })
    state.bootTimer = setTimeout(() => {
      if (!state.ready && !state.exited) {
        state.exitCode = null
        quarantine(state, 'boot_timeout')
      }
    }, childBootTimeoutMs)
    state.bootTimer.unref?.()
    return state
  }

  function createHandle(state: WorkerState, handleState: RealBridgeHandleState): RealBridgeHandle {
    const handle: RealBridgeHandle = {
      sessionKey: handleState.sessionKey,
      state: handleState,
      runPrompt(input) {
        if (handleState.disposed) {
          throw new Error('handle_disposed')
        }
        if (handleState.crashed || state.exited) {
          throw new Error('worker_fault')
        }
        if (handleState.adapterAttemptId !== null && !handleState.idleConfirmed) {
          throw new Error('bridge_turn_conflict')
        }
        if (typeof input.promptText !== 'string' || input.promptText.length === 0) {
          // Issue #51 contract: no digest-only model input may exist.
          throw new Error('bridge_prompt_text_required')
        }
        handleState.attemptCounter += 1
        const attemptId = `att_${randomBytes(4).toString('hex')}${handleState.attemptCounter.toString().padStart(4, '0')}`
        handleState.adapterAttemptId = attemptId
        handleState.cancelRequested = false
        handleState.idleConfirmed = false
        handleState.nextStreamIndex = 0
        handleState.attemptFailed = false
        handleState.attemptSettled = false
        void request(state, 'followup', { sessionId: state.dshSessionId, text: input.promptText }).then((reply) => {
          if (!reply.ok && !handleState.crashed && !handleState.disposed) {
            // The wake itself failed inside the real runtime: worker fault.
            handleState.crashed = true
            fireFault({
              sessionKey: handleState.sessionKey,
              code: 'worker_crashed',
              detail: 'request_failed',
              exitCode: state.exitCode,
              ...(reply.code !== undefined || reply.message !== undefined
                ? { message: `${reply.code ?? ''}:${reply.message ?? ''.slice(0, 120)}`.slice(0, 160) }
                : {}),
            })
          }
        })
        return { ok: true, attemptId }
      },
      cancel(input: BridgeAgentCancelInput): BridgeAgentCancelResult {
        if (input.kind !== 'user') {
          return { ok: false, code: 'no_running_attempt' }
        }
        if (handleState.disposed || handleState.crashed || state.exited) {
          return { ok: false, code: 'no_running_attempt' }
        }
        if (handleState.adapterAttemptId === null || handleState.idleConfirmed) {
          return { ok: false, code: 'no_running_attempt' }
        }
        handleState.cancelRequested = true
        handleState.idleConfirmed = false
        void request(state, 'cancel', { sessionId: state.dshSessionId }).then((reply) => {
          if (!reply.ok && !handleState.crashed && !handleState.disposed) {
            handleState.crashed = true
            fireFault({ sessionKey: handleState.sessionKey, code: 'worker_crashed', detail: 'control_timeout', exitCode: state.exitCode })
          }
        })
        return { ok: true, attemptId: handleState.adapterAttemptId }
      },
      async whenIdle() {
        if (handleState.disposed || handleState.crashed || state.exited) {
          return { ok: true, attemptId: null }
        }
        if (handleState.adapterAttemptId === null || handleState.idleConfirmed) {
          handleState.idleConfirmed = true
          return { ok: true, attemptId: null }
        }
        const reply = await request(state, 'whenIdle', { sessionId: state.dshSessionId }, whenIdleTimeoutMs)
        if (reply.ok) {
          // The REAL agent reached quiescence: verified stop. Close the
          // attempt so a late interrupted settlement can never become a
          // turn.settled notification (the cancel already settled it).
          handleState.idleConfirmed = true
          handleState.adapterAttemptId = null
          handleState.upstreamToAdapter.clear()
          return { ok: true, attemptId: null }
        }
        // Bounded timeout: report the current attempt with an UN-verified
        // stop — the Bridge's isRunning() re-check quarantines the worker
        // (cancel_timeout) instead of deadlocking the turn state machine.
        handleState.idleConfirmed = false
        return { ok: true, attemptId: handleState.adapterAttemptId }
      },
      async dispose() {
        handleState.disposed = true
        handleState.streamListeners.length = 0
        handleState.durableListeners.length = 0
        handleState.failureListeners.length = 0
        if (state.child !== null && !state.exited) {
          state.disposedByRequest = true
          await request(state, 'dispose', { sessionId: state.dshSessionId }, disposeTimeoutMs)
          await request(state, 'shutdown', {}, disposeTimeoutMs)
          const child = state.child
          if (child !== null && !state.exited) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => resolve(), disposeTimeoutMs)
              timer.unref?.()
              child.once('exit', () => {
                clearTimeout(timer)
                resolve()
              })
              try {
                child.kill()
              } catch {
                clearTimeout(timer)
                resolve()
              }
            })
            killWorker(state)
          }
        }
        workers.delete(handleState.sessionKey)
        return { ok: true }
      },
      onStream(listener) {
        handleState.streamListeners.push(listener)
        return { ok: true }
      },
      onDurable(listener) {
        handleState.durableListeners.push(listener)
        return { ok: true }
      },
      onFailure(listener) {
        // E2E-03 (issue #53): the Bridge settles failed attempts FAILED so
        // the trusted turn state machine can never hang on a model failure.
        handleState.failureListeners.push(listener)
        return { ok: true }
      },
      isRunning() {
        return isHandleRunning(handleState)
      },
    }
    return handle
  }

  const port: RealCordisAgentPort = {
    createAgent(sessionKey) {
      if (typeof sessionKey !== 'string' || sessionKey.length === 0) {
        return { ok: false, code: 'session_unknown' satisfies BridgeAgentPortErrorCode as BridgeAgentPortErrorCode }
      }
      const existing = workers.get(sessionKey)
      if (existing !== undefined && !existing.exited && !existing.handle.state.disposed && !existing.handle.state.crashed) {
        return { ok: false, code: 'bridge_ownership_conflict' }
      }
      if (existing !== undefined) {
        killWorker(existing)
        workers.delete(sessionKey)
      }
      const state = spawnWorker(sessionKey, options.dshHome, options.mockBaseUrl)
      workers.set(sessionKey, state)
      // Register the agent inside the child BEFORE any followup can arrive:
      // the worker processes control requests strictly in order, so a
      // runPrompt issued right after this call still handles after `create`.
      // The DSH-side session identity is FRESH per worker rebuild AND per
      // port boot (PORT_BOOT_EPOCH above): a rebuilt worker — or a gateway
      // restart against a persistent dshHome — must never collide with a
      // persisted identity (docs/VOICE_RUNTIME.md §7 — recovery binds the
      // confirmed logical session only, replays nothing).
      workerCounter += 1
      const dshSessionId = `${sessionKey}#w${workerCounter}e${PORT_BOOT_EPOCH}`
      state.dshSessionId = dshSessionId
      void request(state, 'create', { sessionId: dshSessionId }).then((reply) => {
        if (!reply.ok && !state.handle.state.crashed && !state.handle.state.disposed) {
          state.handle.state.crashed = true
          fireFault({
            sessionKey,
            code: 'worker_crashed',
            detail: 'request_failed',
            exitCode: state.exitCode,
            ...(reply.code !== undefined ? { message: reply.code.slice(0, 100) } : {}),
            ...(reply.message !== undefined ? { message: `${reply.code ?? ''}:${reply.message.slice(0, 120)}` } : {}),
          })
        }
      })
      return { ok: true, handle: state.handle }
    },
    resumeAgent(sessionKey) {
      const existing = workers.get(sessionKey)
      if (existing === undefined || existing.exited || existing.handle.state.disposed) {
        return { ok: false, code: 'session_unknown' }
      }
      if (existing.handle.state.crashed) {
        return { ok: false, code: 'worker_fault' }
      }
      return { ok: true, handle: existing.handle }
    },
    onFault(listener) {
      faultListeners.push(listener)
    },
    stderrTailSnapshot(sessionKey) {
      return workers.get(sessionKey)?.stderrTail ?? ''
    },
    hasLiveWorker(sessionKey) {
      const state = workers.get(sessionKey)
      return state !== undefined && !state.exited && state.child !== null
    },
    crashNow(sessionKey) {
      const state = workers.get(sessionKey)
      if (state === undefined || state.exited || state.child === null) {
        return false
      }
      quarantine(state, 'process_exit')
      return true
    },
    async disposeAll() {
      for (const [, state] of [...workers.entries()]) {
        await state.handle.dispose().catch(() => undefined)
      }
      workers.clear()
    },
  }
  return port
}

/** The adapter-created handle (adds test observation of the internal state). */
export interface RealBridgeHandle extends BridgeAgentHandle {
  /** Test-only structured observation (ids and counters; never any text). */
  readonly state: RealBridgeHandleState
}
