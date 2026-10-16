/**
 * E2E-03 (issue #53) adapter-level failure-settlement tests — the REAL agent
 * port (`src/real-agent-port.ts`) state machine driven by the scripted fake
 * worker (`fake-bridge-worker.ts`), so the exact frame ordering behind the
 * review findings is deterministic:
 *
 *  - review r2 P1-1 (the blocking finding): `request_error` phase → user
 *    barge-in → the interrupted attempt's `end` frame arrives BEFORE the
 *    `whenIdle` reply. The port MUST NOT fire `onFailure` for that attempt —
 *    the cancel path owns the settlement. Regression here would flip an
 *    audited user cancel into a `turn.settled(FAILED)` (the Bridge is still
 *    CANCELLING when the frame lands).
 *  - the SAME `end` frame still settles a failed attempt when NO user cancel
 *    is in flight (issue #53 DoD 2 — the guard must not over-suppress).
 *  - a chunk after a `request_error` proves the attempt recovered: the
 *    failure flag must be cleared (the mirror-image bug would settle
 *    self-healed turns FAILED) — review r2 test gap 2.
 *  - the `status:'idle'` fallback is pinned on BOTH branches (review r2 test
 *    gap 3): it fires exactly once for an uncancelled failed attempt, and it
 *    stays silent while a user cancel is in flight.
 *
 * The real-runtime full-chain behavior stays covered by the E2E-03
 * gateway-route suite; this file pins the adapter state machine itself.
 *
 * PRIVACY: synthetic markers only (`E2E03`); no runtime, no network, and the
 * prompt text never crosses the fake worker's stdout.
 */
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import {
  createRealCordisAgentPort,
  type RealBridgeHandle,
  type RealBridgeHandleState,
  type RealCordisAgentPort,
} from '../../src/real-agent-port.ts'
import { canSpawnPipedChild } from '../../src/dump-config.ts'
import { PIPED_CHILD_UNAVAILABLE } from './helpers.ts'

const pipedOk = await canSpawnPipedChild()

const FAKE_WORKER_PATH = fileURLToPath(new URL('./fake-bridge-worker.ts', import.meta.url))
const SESSION_KEY = 'ses_e2e03failureguard01'

interface FailureRecord {
  readonly attemptId: string
  readonly code: string
}

interface Harness {
  readonly port: RealCordisAgentPort
  readonly handle: RealBridgeHandle
  readonly state: RealBridgeHandleState
  readonly failures: FailureRecord[]
  readonly streamKinds: string[]
}

async function startHarness(plan: {
  create?: string[]
  followup?: string[]
  cancel?: string[]
  whenIdle?: string[]
}): Promise<Harness> {
  const port = createRealCordisAgentPort({
    dshHome: 'fake-home-e2e03-failure-guard',
    mockBaseUrl: 'http://127.0.0.1:9',
    workerScriptPath: FAKE_WORKER_PATH,
    workerEnv: { LUMI_FAKE_WORKER_PLAN: JSON.stringify(plan) },
    whenIdleTimeoutMs: 5_000,
  })
  const created = port.createAgent(SESSION_KEY)
  assert.equal(created.ok, true, `createAgent refused: ${JSON.stringify(created)}`)
  if (!created.ok) throw new Error('unreachable')
  // The runtime handle IS a RealBridgeHandle (createHandle adds the test
  // observation surface); the base port interface only types it as the
  // domain contract, so the test narrows it for state observation.
  const handle = created.handle as RealBridgeHandle
  const failures: FailureRecord[] = []
  const streamKinds: string[] = []
  handle.onStream((event) => {
    streamKinds.push(event.kind)
  })
  if (handle.onFailure === undefined) {
    throw new Error('the real port must expose the onFailure capability (issue #53)')
  }
  handle.onFailure((event) => {
    failures.push({ attemptId: event.attemptId, code: event.code })
  })
  return { port, handle, state: handle.state, failures, streamKinds }
}

/** Poll until `predicate` holds; fail with `what` after `timeoutMs`. */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - startedAt > timeoutMs) {
      assert.fail(`timed out after ${timeoutMs}ms waiting for ${what}`)
    }
    await sleep(10)
  }
}

/** Bounded settle window for "nothing more must happen" assertions. */
async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

describe('E2E-03 real agent port failure settlement (scripted fake worker)', { skip: pipedOk ? false : PIPED_CHILD_UNAVAILABLE }, () => {
  let harness: Harness | undefined

  afterEach(async () => {
    const closing = harness
    harness = undefined
    if (closing !== undefined) {
      await closing.port.disposeAll().catch(() => undefined)
    }
  })

  it('never fires onFailure when a cancelled attempt end frame arrives before the whenIdle reply (review r2 P1-1)', async () => {
    // The composite race: the attempt failed (request_error), the user
    // barges in, and the worker emits the interrupted attempt's `end` frame
    // before answering `whenIdle`. The cancel path owns the settlement —
    // this end frame must stay silent.
    const h = await startHarness({
      followup: ['phase:request_error'],
      cancel: ['stream:end'],
    })
    harness = h
    const { handle, state, failures, streamKinds } = h

    const run = handle.runPrompt({ turnId: 'trn_e2e03r2c1', nonceFingerprint: 'fp-r2-cancel-race', promptText: 'E2E03 合成取消竞态转写。' })
    assert.equal(run.ok, true)
    await waitFor('request_error to mark the attempt failed', () => state.attemptFailed)

    const cancelled = handle.cancel({ kind: 'user' })
    assert.equal(cancelled.ok, true)
    const idle = await handle.whenIdle()
    assert.equal(idle.ok, true)

    // Ordering proof: the interrupted attempt's end frame really crossed the
    // stream before the whenIdle reply resolved (the fake worker writes it
    // first, and the parent processes stdout lines in order).
    assert.ok(streamKinds.includes('end'), `the end frame must have crossed the stream, kinds=${JSON.stringify(streamKinds)}`)
    assert.equal(failures.length, 0, `a user-cancelled attempt must never fire onFailure, got ${JSON.stringify(failures)}`)
    assert.equal(state.attemptSettled, false, 'the failure settlement must never have run')
    // The cancel path's own cleanup stays intact: verified stop released the attempt.
    assert.equal(idle.attemptId, null)
    assert.equal(state.idleConfirmed, true)
    assert.equal(state.adapterAttemptId, null)
  })

  it('still settles a failed attempt through the end frame when no user cancel is in flight (DoD 2 pin)', async () => {
    // Guard liveness: centralizing the cancel guard must not over-suppress
    // the genuine failure settlement (issue #53 DoD 2, r1 P1-1 chain).
    const h = await startHarness({ followup: ['phase:request_error', 'stream:end'] })
    harness = h
    const { handle, state, failures, streamKinds } = h

    const run = handle.runPrompt({ turnId: 'trn_e2e03r2c2', nonceFingerprint: 'fp-r2-nofail-guard', promptText: 'E2E03 合成失败结算转写。' })
    assert.equal(run.ok, true)
    await waitFor('the end frame to be forwarded', () => streamKinds.includes('end'))
    await waitFor('the failure to be settled exactly once', () => failures.length === 1)
    await sleep(50)

    assert.equal(failures.length, 1, `exactly one failure, got ${JSON.stringify(failures)}`)
    assert.equal(failures[0].attemptId, run.attemptId)
    assert.equal(failures[0].code, 'model_request_failed')
    assert.equal(state.attemptSettled, true)
    // The failed attempt releases the binding so the next turn can schedule
    // without a rebuild (issue #53 review r1 P1-1 liveness).
    assert.equal(state.adapterAttemptId, null)
    assert.equal(state.idleConfirmed, true)
  })

  it('clears the failure flag when a later chunk proves the attempt recovered (self-heal pin)', async () => {
    // Review r2 test gap 2: a chunk after a request_error means the runtime
    // retried and recovered — the failure flag must not survive to the end
    // frame, or self-healed turns would be settled FAILED.
    const h = await startHarness({ followup: ['phase:request_error', 'stream:chunk', 'stream:end'] })
    harness = h
    const { handle, state, failures, streamKinds } = h

    const run = handle.runPrompt({ turnId: 'trn_e2e03r2c3', nonceFingerprint: 'fp-r2-recovery', promptText: 'E2E03 合成自愈恢复转写。' })
    assert.equal(run.ok, true)
    await waitFor('the recovered chunk to be forwarded', () => streamKinds.includes('chunk'))
    await waitFor('the end frame to be forwarded', () => streamKinds.includes('end'))
    // Settle window: any (buggy) fire would already have happened.
    await sleep(100)

    assert.equal(failures.length, 0, `a recovered attempt must never settle FAILED, got ${JSON.stringify(failures)}`)
    assert.equal(state.attemptFailed, false, 'the chunk must have cleared the failure flag')
    assert.equal(state.attemptSettled, false)
    assert.equal(state.adapterAttemptId, run.attemptId, 'the recovered attempt stays bound until the idle path releases it')
  })

  it('fires the status-idle fallback exactly once for an uncancelled failed attempt', async () => {
    // Review r2 test gap 3 (firing branch): the idle fallback is a real fire
    // path; pin it so a regression there cannot silently pass while the end
    // frame path stays green.
    const h = await startHarness({ followup: ['phase:request_error', 'status:idle', 'status:idle'] })
    harness = h
    const { handle, state, failures } = h

    const run = handle.runPrompt({ turnId: 'trn_e2e03r2c4', nonceFingerprint: 'fp-r2-idle-fire', promptText: 'E2E03 合成 idle 兜底转写。' })
    assert.equal(run.ok, true)
    await waitFor('the idle fallback failure to fire', () => failures.length === 1)
    await sleep(100)

    assert.equal(failures.length, 1, `the second status:idle must not double-fire, got ${JSON.stringify(failures)}`)
    assert.equal(failures[0].attemptId, run.attemptId)
    assert.equal(failures[0].code, 'model_request_failed')
    assert.equal(state.attemptSettled, true)
    assert.equal(state.adapterAttemptId, null)
    assert.equal(state.idleConfirmed, true)
  })

  it('keeps the status-idle fallback silent while a user cancel is in flight', async () => {
    // Review r2 test gap 3 (guarded branch): a status:idle emitted inside the
    // cancel window (agent gone idle before the whenIdle reply) must stay
    // silent — same cancel-owns-the-settlement rule as the end frame path.
    const h = await startHarness({
      followup: ['phase:request_error'],
      cancel: ['status:idle'],
    })
    harness = h
    const { handle, state, failures } = h

    const run = handle.runPrompt({ turnId: 'trn_e2e03r2c5', nonceFingerprint: 'fp-r2-idle-cancel', promptText: 'E2E03 合成 idle 取消窗口转写。' })
    assert.equal(run.ok, true)
    await waitFor('request_error to mark the attempt failed', () => state.attemptFailed)

    const cancelled = handle.cancel({ kind: 'user' })
    assert.equal(cancelled.ok, true)
    const idle = await handle.whenIdle()
    assert.equal(idle.ok, true)
    await sleep(50)

    assert.equal(failures.length, 0, `the cancel window must suppress the idle fallback, got ${JSON.stringify(failures)}`)
    assert.equal(state.attemptSettled, false)
    assert.equal(state.adapterAttemptId, null)
  })
})
