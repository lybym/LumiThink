/**
 * E2E-03 (issue #53) SCRIPTED fake bridge worker — a test-only stand-in for
 * `bridge-worker-child.ts` that speaks the exact same JSON-lines control
 * protocol while replaying scripted worker events per control op.
 *
 * Why it exists (issue #53 review r2): the composite cancel race —
 * `request_error` phase → user barge-in → the interrupted attempt's `end`
 * frame arriving BEFORE the `whenIdle` reply — depends on worker frame
 * ordering that a live runtime cannot produce deterministically. This fake
 * worker pins the ordering (`tests/bridge/real-agent-port-failure-guard.spec.ts`)
 * so the adapter's failure-settlement state machine is regression-tested
 * deterministically; the REAL runtime full-chain behavior stays covered by
 * the E2E-03 gateway-route suite (zero-skip gate, CI).
 *
 * Script (env `LUMI_FAKE_WORKER_PLAN`, JSON): per-op event lists emitted AFTER
 * the op's reply — `create`/`followup`/`cancel`/`whenIdle` → event specs
 * `phase:<name>`, `status:<idle|running>`, `stream:<start|chunk|end>`.
 *
 * PRIVACY: no runtime, no network, no prompt material — synthetic markers
 * only, and the parent's prompt text is never echoed by this process.
 */
import { createInterface } from 'node:readline'
import type { WorkerEvent, WorkerRequest, WorkerStreamFrame } from '../../src/bridge-worker-child.ts'

const PLAN_ENV = 'LUMI_FAKE_WORKER_PLAN'
/** One fixed upstream attempt id: the adapter re-maps unknown ids onto the live attempt. */
const UP_ATTEMPT_ID = 'up-attempt-e2e03fake'
const STEP_ID = 't1s1'

interface FakePlan {
  readonly bootDelayMs?: number
  readonly create?: readonly string[]
  readonly followup?: readonly string[]
  readonly cancel?: readonly string[]
  readonly whenIdle?: readonly string[]
}

function parsePlan(raw: string | undefined): FakePlan {
  if (raw === undefined || raw.trim().length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return {}
    return parsed as FakePlan
  } catch {
    return {}
  }
}

const plan = parsePlan(process.env[PLAN_ENV])
let sessionId: string | null = null
let ready = false

function emit(event: WorkerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

function emitSpec(raw: string): void {
  const colonAt = raw.indexOf(':')
  if (colonAt < 0 || sessionId === null) return
  const kind = raw.slice(0, colonAt)
  const arg = raw.slice(colonAt + 1)
  if (kind === 'phase') {
    emit({
      ev: 'phase',
      sessionId,
      phase: arg as 'pre_step' | 'request' | 'turn_stopping' | 'request_error' | 'step_error',
      turn: 1,
      step: 1,
      detail: 'fake-scripted',
    })
    return
  }
  if (kind === 'status') {
    emit({ ev: 'status', sessionId, status: arg as 'idle' | 'running' })
    return
  }
  if (kind === 'stream') {
    const frame: WorkerStreamFrame | null =
      arg === 'start'
        ? { kind: 'start', attemptId: UP_ATTEMPT_ID, stepId: STEP_ID }
        : arg === 'chunk'
          ? { kind: 'chunk', attemptId: UP_ATTEMPT_ID, stepId: STEP_ID, index: 0, channel: 'text', textDelta: 'E2E03 fake worker 合成增量。' }
          : arg === 'end'
            ? { kind: 'end', attemptId: UP_ATTEMPT_ID, stepId: STEP_ID }
            : null
    if (frame !== null) emit({ ev: 'stream', sessionId, frame })
    return
  }
}

function emitAll(specs: readonly string[] | undefined): void {
  if (specs === undefined) return
  for (const spec of specs) emitSpec(spec)
}

function reply(id: number, ok: boolean): void {
  emit({ ev: 'reply', id, ok })
}

function handleRequest(request: WorkerRequest): void {
  switch (request.op) {
    case 'create':
      sessionId = request.sessionId
      reply(request.id, true)
      emitAll(plan.create)
      return
    case 'resume':
      reply(request.id, true)
      return
    case 'followup':
      // The scripted events land AFTER the reply, so the parent has a live
      // attempt before the failure/stream evidence arrives — the real worker
      // ordering for a mid-turn error.
      reply(request.id, true)
      emitAll(plan.followup)
      return
    case 'cancel':
      // The interrupted attempt's trailing frames (the review-r2 race) are
      // written BEFORE the `whenIdle` request can be answered.
      reply(request.id, true)
      emitAll(plan.cancel)
      return
    case 'whenIdle':
      reply(request.id, true)
      emitAll(plan.whenIdle)
      return
    case 'dispose':
      reply(request.id, true)
      return
    case 'shutdown':
      reply(request.id, true)
      emit({ ev: 'stopped' })
      return
    default:
      return
  }
}

// Control requests are processed strictly in arrival order (mirrors the real
// worker): every scripted ordering the tests rely on is FIFO on this queue.
const lineReader = createInterface({ input: process.stdin, terminal: false })
let requestQueue: Promise<void> = Promise.resolve()
lineReader.on('line', (line) => {
  // A profile may have stdin consumers before its control reader is ready.
  // Deliberately discard early commands to exercise the parent's boot gate.
  if (!ready) return
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
setTimeout(() => {
  ready = true
  emit({ ev: 'ready', profile: 'fake-bridge-worker', pid: process.pid })
}, plan.bootDelayMs ?? 0)
