/**
 * E2E-02 (issue #52) bridge worker child — a REAL locked-version DSH Cordis
 * runtime process (`dsh-v0.2.0-rc.2`, profile `lumi-dsh-runtime-bridge`) that
 * the parent-side {@link ../real-agent-port.ts} adapter drives.
 *
 * What this child actually does:
 *  - boots the pinned upstream runtime in-process via the official
 *    `@deepseek-ai/dsh/profile-boot` (resolve profile → stack patch layers →
 *    mount the allowlisted plugin tree; no upstream Agent Loop is modified);
 *  - mounts one small control plugin on the booted root context that maps the
 *    REAL agent surface (`ctx.agents.create/resume`, `agent.cancel({
 *    kind: 'user' })`, `agent.whenIdle()`, the `agent/assistant-stream`
 *    publication, `session/event` durable records, `AgentHandle.dispose()`)
 *    onto a minimal JSON-lines protocol over stdio;
 *  - stays alive until the parent sends `shutdown`.
 *
 * PRIVACY: the only transient text here is the authorized per-turn prompt
 * arriving over the local control channel; it is wrapped into one synthetic
 * user message, never logged, never echoed, and never persisted by this
 * module. Stream frames are forwarded as structural events; durable message
 * bodies NEVER leave this process (message ids only).
 *
 * Injection hooks (explicitly named, used only by the E2E-02 fault tests):
 *  - `DSH_BRIDGE_INJECT_IDLE_HANG=1` — every `whenIdle` control request is
 *    accepted but never answered, so the parent's bounded stop-verification
 *    timeout is exercised against a genuinely unresponsive worker.
 */
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
// Type-only imports: they carry the Cordis Context/Events augmentations and
// the branded id types into this file's program and are ERASED at runtime —
// the worker keeps the root PoC dependency surface unchanged (zero new
// runtime dependencies; the E2E-02 gate relies on that).
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

// ---------------------------------------------------------------------------
// Local micro-seams (structural stand-ins for two upstream helpers the worker
// needs at runtime; kept dependency-free by construction):
// ---------------------------------------------------------------------------

/** The pinned upstream LaunchEnvironmentSnapshot, built from child-env layers. */
type LaunchLayer = {
  readonly source: 'process' | 'project-env' | 'user-env'
  readonly path?: string
  readonly values: Readonly<Record<string, string>>
}

function launchEnvironmentFromLayers(layers: readonly LaunchLayer[]): LaunchEnvironmentSnapshot {
  const trustOrder = ['process', 'project-env', 'user-env'] as const
  const bySource = new Map<string, LaunchLayer>(layers.map((layer) => [layer.source, layer]))
  const find = (name: string, sources: readonly string[]): { value: string; source: string; path?: string } | undefined => {
    for (const source of trustOrder) {
      if (!sources.includes(source)) continue
      const layer = bySource.get(source)
      const value = layer?.values[name]
      if (layer !== undefined && value !== undefined) {
        return { value, source, ...(layer.path !== undefined ? { path: layer.path } : {}) }
      }
    }
    return undefined
  }
  return {
    get: (name) => find(name, trustOrder),
    getFrom: (name, sources) => find(name, sources),
  } as LaunchEnvironmentSnapshot
}

/**
 * Build the synthetic user message exactly like the upstream
 * `createUserMessage` (fresh UUID identity, frozen) without importing the
 * runtime helper — one content block, `kind: 'user'` source.
 */
function syntheticUserMessage(text: string): UserMessage {
  const message = structuredClone({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  return Object.freeze(message) as unknown as UserMessage
}

/** The Bridge contract's sessionKey doubles as the durable session identity. */
function asSessionId(value: string): SessionId {
  return value as unknown as SessionId
}

/** One channel-mapped transient stream frame (upstream attempt id verbatim). */
export type WorkerStreamFrame =
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

/** Parent → child control requests (one JSON object per stdin line). */
export type WorkerRequest =
  | { readonly op: 'create'; readonly id: number; readonly sessionId: string }
  | { readonly op: 'resume'; readonly id: number; readonly sessionId: string }
  | { readonly op: 'followup'; readonly id: number; readonly sessionId: string; readonly text: string }
  | { readonly op: 'cancel'; readonly id: number; readonly sessionId: string }
  | { readonly op: 'whenIdle'; readonly id: number; readonly sessionId: string }
  | { readonly op: 'dispose'; readonly id: number; readonly sessionId: string }
  | { readonly op: 'shutdown'; readonly id: number }

/** Child → parent control events (one JSON object per stdout line). */
export type WorkerEvent =
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
      readonly ev: 'phase'
      readonly sessionId: string
      readonly phase: 'pre_step' | 'request' | 'turn_stopping' | 'request_error' | 'step_error'
      readonly turn: number
      readonly step: number
      readonly detail: string
    }
  | { readonly ev: 'stopped' }

const IDLE_HANG_INJECTION = process.env.DSH_BRIDGE_INJECT_IDLE_HANG === '1'
const BRIDGE_PROFILE = 'lumi-dsh-runtime-bridge'

// Bounded crash diagnostics: anything escaping the request handlers lands on
// stderr (captured by the parent adapter's bounded tail), never on the
// control-protocol stdout.
process.on('uncaughtException', (error) => {
  process.stderr.write(`[child-uncaught] ${String(error?.stack ?? error).slice(0, 400)}\n`)
})
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[child-unhandled] ${String(reason).slice(0, 400)}\n`)
})

function emit(event: WorkerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

function reply(id: number, ok: boolean, code?: string, message?: string): void {
  emit({ ev: 'reply', id, ok, ...(code !== undefined ? { code } : {}), ...(message !== undefined ? { message } : {}) })
}

function stepIdOf(turn: number, step: number): string {
  return `t${turn}s${step}`
}

async function main(): Promise<void> {
  // The launch snapshot is the scrubbed child environment the parent built —
  // one process layer, no project/user env files are ever read.
  const environment = launchEnvironmentFromLayers([
    {
      source: 'process',
      values: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    },
  ])

  const booted = await runProfile({
    environment,
    profile: BRIDGE_PROFILE,
    patchFiles: [],
    args: [],
  })
  const ctx = booted.ctx
  emit({ ev: 'ready', profile: BRIDGE_PROFILE, pid: process.pid })

  // --- Live worker state (one agent per worker child) -----------------------
  let handle: AgentHandle | null = null
  let currentSessionId: string | null = null
  let streamingAttemptId: string | null = null
  let streamingStepId: string | null = null
  let disposed = false

  /**
   * Agent-scoped diagnostics: agent-scoped listeners run BEFORE the root
   * llm-retry waterfall (which owns recovery and never calls next()), so
   * model failures stay visible to the parent as bounded types only.
   */
  function wireAgentDiagnostics(agent: AgentHandle['agent']): void {
    agent.ctx.on('agent/pre-step', (payload, next) => {
      emit({ ev: 'phase', sessionId: agent.id, phase: 'pre_step', turn: payload.turn, step: payload.step, detail: `messages=${payload.messages.length}` })
      return next()
    })
    agent.ctx.on('agent/request', (payload, next) => {
      emit({ ev: 'phase', sessionId: agent.id, phase: 'request', turn: payload.turn, step: payload.step, detail: 'prepared' })
      return next()
    })
    agent.ctx.on('agent/turn-stopping', (payload) => {
      emit({ ev: 'phase', sessionId: agent.id, phase: 'turn_stopping', turn: payload.turn, step: 0, detail: 'stopping' })
    })
    agent.ctx.on('agent/request-error', (payload, next) => {
      emit({
        ev: 'phase',
        sessionId: agent.id,
        phase: 'request_error',
        turn: payload.turn,
        step: payload.step,
        detail: `${payload.provider}:${typeof payload.failure?.code === 'string' ? payload.failure.code.slice(0, 64) : 'unknown'}`,
      })
      return next()
    })
    agent.ctx.on('agent/error', (payload) => {
      const raw = payload.error instanceof Error ? payload.error.message : String(payload.error)
      emit({
        ev: 'phase',
        sessionId: agent.id,
        phase: 'step_error',
        turn: payload.turn,
        step: payload.step,
        detail: raw.slice(0, 200),
      })
    })
  }

  function unbindAgent(): void {
    handle = null
    currentSessionId = null
    streamingAttemptId = null
    streamingStepId = null
  }

  // The REAL transient stream publication. Root-context listener filtered by
  // the worker's one live agent; chunk types map onto the bridge channels.
  ctx.on('agent/assistant-stream', (payload) => {
    if (currentSessionId === null || payload.agent.id !== currentSessionId) return
    const frame = payload.frame
    if (frame.type === 'start') {
      streamingAttemptId = frame.attemptId
      streamingStepId = stepIdOf(frame.turn, frame.step)
      emit({ ev: 'stream', sessionId: currentSessionId, frame: { kind: 'start', attemptId: frame.attemptId, stepId: streamingStepId } })
      return
    }
    if (streamingAttemptId === null || frame.attemptId !== streamingAttemptId || streamingStepId === null) return
    if (frame.type === 'chunk') {
      const chunk = frame.chunk
      let channel: 'text' | 'tool_call' | 'thinking'
      let textDelta: string
      if (chunk.type === 'text-delta') {
        channel = 'text'
        textDelta = chunk.text
      } else if (chunk.type === 'reasoning-delta') {
        channel = 'thinking'
        textDelta = chunk.text
      } else if (chunk.type === 'tool-call-delta') {
        channel = 'tool_call'
        textDelta = chunk.argumentsDelta
      } else {
        // Structural chunks (block-start/end, usage, finish) carry no live
        // delta text and are never forwarded.
        return
      }
      emit({
        ev: 'stream',
        sessionId: currentSessionId,
        frame: {
          kind: 'chunk',
          attemptId: frame.attemptId,
          stepId: streamingStepId,
          index: frame.index,
          channel,
          textDelta,
        },
      })
      return
    }
    // frame.type === 'end'
    emit({ ev: 'stream', sessionId: currentSessionId, frame: { kind: 'end', attemptId: frame.attemptId, stepId: streamingStepId } })
  })

  // Agent status transitions (structural evidence for the e2e assertions).
  ctx.on('agent/status', (payload) => {
    if (currentSessionId === null || payload.agent.id !== currentSessionId) return
    emit({ ev: 'status', sessionId: currentSessionId, status: payload.status })
  })

  // Durable settlement: the assistant/message record (message ID only, never
  // the body) attributed to the attempt that was streaming it.
  ctx.on('session/event', (session, event) => {
    if (currentSessionId === null || session.id !== currentSessionId) return
    if (event.type !== 'assistant/message') return
    if (streamingAttemptId === null) return
    emit({
      ev: 'durable',
      sessionId: currentSessionId,
      attemptId: streamingAttemptId,
      messageId: event.data.message.id,
      messageRef: `seq:${String(event.seq)}`,
    })
  })

  function fail(id: number, error: unknown): void {
    const message = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)
    reply(id, false, 'worker_error', message)
  }

  const lineReader = createInterface({ input: process.stdin, terminal: false })
  // Control requests are processed strictly in arrival order: a `followup`
  // that overtakes its `create` would be a self-inflicted session_unknown.
  let requestQueue: Promise<void> = Promise.resolve()
  lineReader.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    let request: WorkerRequest
    try {
      request = JSON.parse(trimmed) as WorkerRequest
    } catch {
      return
    }
    requestQueue = requestQueue.then(() => handleRequest(request)).catch(() => undefined)
  })

  async function handleRequest(request: WorkerRequest): Promise<void> {
    try {
      switch (request.op) {
        case 'create': {
          if (disposed) {
            reply(request.id, false, 'worker_disposed')
            return
          }
          if (handle !== null) {
            reply(request.id, false, 'bridge_ownership_conflict')
            return
          }
          const created = await ctx.agents.create({
            sessionId: asSessionId(request.sessionId),
            agentOptions: { provider: process.env.DSH_BRIDGE_PROVIDER ?? 'deepseek-official', model: process.env.DSH_BRIDGE_MODEL ?? 'deepseek-v4-flash' },
            meta: { cwd: process.cwd() },
          })
          handle = created
          currentSessionId = request.sessionId
          wireAgentDiagnostics(created.agent)
          reply(request.id, true)
          return
        }
        case 'resume': {
          if (disposed) {
            reply(request.id, false, 'worker_disposed')
            return
          }
          if (handle !== null && currentSessionId === request.sessionId) {
            reply(request.id, true)
            return
          }
          const resumed = await ctx.agents.resume({
            resumeSessionId: asSessionId(request.sessionId),
            agentOptions: { provider: process.env.DSH_BRIDGE_PROVIDER ?? 'deepseek-official', model: process.env.DSH_BRIDGE_MODEL ?? 'deepseek-v4-flash' },
          })
          handle = resumed
          currentSessionId = request.sessionId
          wireAgentDiagnostics(resumed.agent)
          reply(request.id, true)
          return
        }
        case 'followup': {
          if (disposed || handle === null || currentSessionId !== request.sessionId) {
            reply(request.id, false, 'session_unknown')
            return
          }
          // The authorized transient transcript enters the real Agent Loop as
          // one synthetic user message. It is never logged by this module.
          const message = syntheticUserMessage(request.text)
          handle.agent.followup(message)
          reply(request.id, true)
          return
        }
        case 'cancel': {
          if (disposed || handle === null || currentSessionId !== request.sessionId) {
            reply(request.id, false, 'session_unknown')
            return
          }
          // The real in-process cancellation — no keepInbox (docs/VOICE_RUNTIME.md §4 step 3).
          handle.agent.cancel({ kind: 'user' })
          reply(request.id, true)
          return
        }
        case 'whenIdle': {
          if (disposed || handle === null || currentSessionId !== request.sessionId) {
            reply(request.id, false, 'session_unknown')
            return
          }
          if (IDLE_HANG_INJECTION) {
            // Fault injection: accept and never answer. The parent's bounded
            // stop-verification timeout must quarantine this worker.
            return
          }
          await handle.agent.whenIdle()
          reply(request.id, true)
          return
        }
        case 'dispose': {
          if (handle !== null) {
            const target = handle
            unbindAgent()
            await target.dispose()
          }
          reply(request.id, true)
          return
        }
        case 'shutdown': {
          disposed = true
          try {
            if (handle !== null) {
              const target = handle
              unbindAgent()
              await target.dispose()
            }
          } catch {
            /* teardown containment: the parent's kill ladder is the backstop */
          }
          emit({ ev: 'stopped' })
          reply(request.id, true)
          const shutdown = booted.shutdown
          setTimeout(() => {
            void shutdown.shutdown(0)
          }, 50).unref()
          return
        }
        default:
          return
      }
    } catch (error) {
      fail(request.id, error)
    }
  }
}

main().catch((error) => {
  emit({ ev: 'reply', id: -1, ok: false, code: 'boot_failed', message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) })
  process.exitCode = 1
})
