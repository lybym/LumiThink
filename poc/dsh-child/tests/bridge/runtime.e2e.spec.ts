/**
 * E2E-02 (issue #52) real-runtime acceptance: the full voice bridge stack
 * (R1-V1 Orchestrator → Output Gate → private IPC → R1-V2 Bridge) driven by
 * the REAL locked-version DSH Cordis runtime process over the loopback
 * synthetic Messages mock.
 *
 * Every scenario below runs a genuine `dsh-v0.2.0-rc.2` worker process
 * (profile `lumi-dsh-runtime-bridge`) and asserts the issue's acceptance
 * criteria at the event level: live deltas from the real stream, real
 * source-level cancellation, worker crash isolation, bounded `whenIdle`
 * verification, and content-free audit evidence. Failure injections use the
 * explicitly named hooks (`crashNow`, `DSH_BRIDGE_INJECT_IDLE_HANG`) — a
 * genuinely unresponsive or dead process, never a stub.
 *
 * PRIVACY: all prompts and model texts are synthetic samples with explicit
 * `E2E02` markers; leak scans assert those markers never reach the audit
 * surface.
 */
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { canSpawnPipedChild } from '../../src/dump-config.ts'
import {
  PIPED_CHILD_UNAVAILABLE,
  canOpenLocalSocket,
  startBridgeFixture,
  submitAndAwaitCompletion,
  submitSynthetic,
  waitFor,
  waitForTerminalTurn,
  type BridgeFixture,
} from './helpers.ts'

const pipedOk = await canSpawnPipedChild()

describe('E2E-02 real DSH runtime over the voice bridge stack', { skip: pipedOk ? false : PIPED_CHILD_UNAVAILABLE }, () => {
  let fixture: BridgeFixture | undefined

  afterEach(async () => {
    await fixture?.dispose()
    fixture = undefined
  })

  it('completes three real rounds with streamed deltas, gate admission and terminal states', async () => {
    assert.equal(await canOpenLocalSocket(), true, 'local sockets must be available for the real-IPC evidence')
    fixture = await startBridgeFixture({
      script: {
        fixedTurnTexts: [
          'E2E02 第一轮开始。合成回复句一。合成回复句二。合成回复句三。合成回复句四。合成回复句五。合成回复句六！',
          'E2E02 第二轮开始。合成回复句七。合成回复句八。合成回复句九。合成回复句十。合成回复句十一。合成回复句十二？',
          'E2E02 第三轮开始。合成回复句十三。合成回复句十四。合成回复句十五。合成回复句十六。合成回复句十七。合成回复句十八；',
        ],
        streamChunkDelayMs: 50,
      },
    })
    const { stack, sessionKey, frames } = fixture
    const opened = await stack.openSession({
      sessionKey,
      conversationId: 'conv_e2e02real01',
      ownerActorId: 'act_e2e02parent01',
    })
    assert.equal(opened.ok, true, `session.open refused: ${JSON.stringify(opened)}`)

    for (const round of [1, 2, 3]) {
      const admissionsBefore = stack.gate.metricsSnapshot().ttsAdmissions
      const submitted = await submitSynthetic(stack, sessionKey, `E2E02-PROMPT-R${round} 合成转写。`)
      assert.equal(submitted.ok, true, `round ${round} submit refused: ${JSON.stringify(submitted)}`)
      if (!submitted.ok) throw new Error('unreachable')
      const turnId = submitted.turnId
      // LIVE-delta proof: a sentence is admitted to TTS while the turn is
      // still RUNNING — the deltas came from the open real stream, not from
      // splitting a settled final message.
      await waitFor(
        `round ${round}: first safe-text admission while the turn is RUNNING`,
        () =>
          stack.gate.metricsSnapshot().ttsAdmissions > admissionsBefore &&
          stack.orchestrator.describeTurn(sessionKey, turnId)?.state === 'RUNNING',
      )
      const state = await waitForTerminalTurn(stack, sessionKey, turnId)
      assert.equal(state, 'COMPLETED', `round ${round} settled ${state}`)
    }

    // Event-level evidence per round: deltas bound to the round's turn, in
    // order, arriving strictly before that round's settlement, with the
    // scripted text and no other round's text.
    for (const round of [1, 2, 3]) {
      const roundTurnIds = frames
        .filter((frame) => frame.name === 'turn.accepted' && String(frame.payload.sessionKey) === sessionKey)
        .map((frame) => String(frame.payload.turnId))
      const turnId = roundTurnIds[round - 1]
      assert.ok(turnId !== undefined, `round ${round} never produced a turn.accepted event`)
      const deltas = frames.filter((frame) => frame.name === 'assistant.delta' && frame.payload.turnId === turnId)
      assert.ok(deltas.length >= 2, `round ${round} must stream multiple live deltas (saw ${deltas.length})`)
      let lastIndex = -1
      let joined = ''
      for (const delta of deltas) {
        const index = Number(delta.payload.index)
        assert.ok(index > lastIndex, `round ${round} delta index must strictly increase (${index} after ${lastIndex})`)
        lastIndex = index
        joined += String(delta.payload.text)
      }
      assert.ok(
        joined.includes(`E2E02 第${['一', '二', '三'][round - 1]}轮`),
        `round ${round} deltas must carry that round's scripted stream text, got: ${joined.slice(0, 60)}`,
      )
      for (const other of [1, 2, 3]) {
        if (other === round) continue
        assert.ok(
          !joined.includes(`第${['一', '二', '三'][other - 1]}轮`),
          `round ${round} deltas leaked round ${other} text`,
        )
      }
      const lastDeltaAt = frames.findIndex((frame) => frame.name === 'assistant.delta' && frame.payload.turnId === turnId)
      const settledAt = frames.findIndex((frame) => frame.name === 'turn.settled' && frame.payload.turnId === turnId)
      assert.ok(settledAt > lastDeltaAt, `round ${round}: the settlement must follow the live deltas (event order)`)
      assert.equal(String(frames[settledAt]?.payload.finalState), 'COMPLETED')
    }

    const metrics = stack.service.metricsSnapshot()
    assert.ok(metrics.deltasForwarded > 0, 'the bridge must have forwarded live deltas')
    const turns = stack.orchestrator.listTurns(sessionKey)
    assert.equal(turns.length, 3)
    for (const turn of turns) {
      assert.equal(turn.state, 'COMPLETED')
    }
    const baseline = stack.baselineMetrics()
    assert.ok(baseline.whenIdleMs.count >= 0 && baseline.cancelAckMs.count === 0, 'no cancel ran in this scenario')
  })

  it('cancels mid-stream at the real source, refuses duplicate cancels and admits no old-round text afterwards', async () => {
    fixture = await startBridgeFixture({
      script: {
        fixedTurnTexts: [Array.from({ length: 20 }, (_, i) => `第${i + 1}句合成内容。`).join('')],
        streamChunkDelayMs: 60,
      },
    })
    const { stack, sessionKey } = fixture
    const opened = await stack.openSession({
      sessionKey,
      conversationId: 'conv_e2e02cancel01',
      ownerActorId: 'act_e2e02parent01',
    })
    assert.equal(opened.ok, true)
    const submitted = await submitSynthetic(stack, sessionKey, 'E2E02-CANCEL 合成转写，请开始播报。')
    assert.equal(submitted.ok, true)
    const turnId = submitted.ok ? submitted.turnId : ''
    await waitFor('the first safe-text admission of the streaming turn', () => stack.gate.metricsSnapshot().ttsAdmissions > 0)

    // The effective interruption: fence FIRST (epoch bump), then the real
    // in-process cancel + whenIdle, then CANCELLED settlement.
    const cancelledAt = Date.now()
    const barge = await stack.bargeInCancel({ sessionKey, turnId, reason: 'device_abort' })
    assert.equal(barge.ok, true, `bargeInCancel refused: ${JSON.stringify(barge)}`)
    assert.ok(Date.now() - cancelledAt < 10_000, 'the cancel flow must stay well-bounded')

    const turn = stack.orchestrator.describeTurn(sessionKey, turnId)
    assert.equal(turn?.state, 'CANCELLED', `the fenced turn must settle CANCELLED, got ${String(turn?.state)}`)

    // Duplicate cancel: rejected by the trusted store WITHOUT a second
    // in-process cancel (重复取消 evidence).
    const duplicate = await stack.bargeInCancel({ sessionKey, turnId, reason: 'device_abort' })
    assert.equal(duplicate.ok, false, 'a duplicate cancel of a terminal turn must be refused')
    const cancelAcked = stack.service
      .auditSnapshot()
      .filter((entry) => entry.action === 'bridge.cancel_acked' && entry.sessionKey === sessionKey)
    assert.equal(cancelAcked.length, 1, 'the real in-process cancel must happen exactly once for the turn')
    const stopConfirmed = stack.service
      .auditSnapshot()
      .filter((entry) => entry.action === 'bridge.stop_confirmed' && entry.sessionKey === sessionKey)
    assert.equal(stopConfirmed.length, 1, 'the stop must be verified through whenIdle exactly once')

    // No old-round admission after the fence: the gate re-checks the trusted
    // epoch on every delta, so the frozen admission count is the observable.
    const admissionsAtCancel = stack.gate.metricsSnapshot().ttsAdmissions
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 500)
      timer.unref?.()
    })
    assert.equal(
      stack.gate.metricsSnapshot().ttsAdmissions,
      admissionsAtCancel,
      'old-epoch deltas must never reach TTS admission after the cancel',
    )

    // Liveness: the very next round completes normally (no deadlock).
    const nextTurnId = await submitAndAwaitCompletion(stack, sessionKey, 'E2E02-AFTER-CANCEL 合成转写。', 30_000)
    assert.notEqual(nextTurnId, turnId)
    const nextTurn = stack.orchestrator.describeTurn(sessionKey, nextTurnId)
    assert.equal(nextTurn?.state, 'COMPLETED')
  })

  it('keeps thinking and tool-call deltas out of the playback path', async () => {
    // Phase 1 — the mock opens with a real thinking block; the runtime
    // streams reasoning deltas onto the `thinking` channel.
    const thinkingFixture = await startBridgeFixture({
      script: {
        fixedTurnTexts: ['E2E02 思考通道轮。合成回复句一。合成回复句二。'],
        reasoningDeltaCount: 4,
        streamChunkDelayMs: 30,
      },
    })
    try {
      const { stack, sessionKey } = thinkingFixture
      const opened = await stack.openSession({
        sessionKey,
        conversationId: 'conv_e2e02think01',
        ownerActorId: 'act_e2e02parent01',
      })
      assert.equal(opened.ok, true)
      const droppedBefore = stack.service.metricsSnapshot().deltasDroppedNonText
      await submitAndAwaitCompletion(stack, sessionKey, 'E2E02-THINK 合成转写。')
      const metrics = stack.service.metricsSnapshot()
      assert.ok(
        metrics.deltasDroppedNonText > droppedBefore,
        'upstream thinking deltas must be counted and dropped by the bridge',
      )
      const blocked = stack.gate.metricsSnapshot().ttsBlockedSentences
      const admitted = stack.gate.metricsSnapshot().ttsAdmissions
      assert.ok(admitted >= 1, 'the text channel must still reach the output gate')
      assert.equal(blocked, 0, 'no sentence may be blocked in this benign scenario')
    } finally {
      await thinkingFixture.dispose()
    }

    // Phase 2 — the model attempts the unmounted bash tool: the runtime
    // streams tool-call deltas onto the `tool_call` channel, which the bridge
    // drops before the playback path while the turn still settles.
    const toolFixture = await startBridgeFixture({
      script: {
        requestBashToolOnce: true,
        fixedTurnTexts: ['TOOL_ATTEMPTED'],
        streamChunkDelayMs: 20,
      },
    })
    try {
      const { stack, sessionKey } = toolFixture
      const opened = await stack.openSession({
        sessionKey,
        conversationId: 'conv_e2e02tool01',
        ownerActorId: 'act_e2e02parent01',
      })
      assert.equal(opened.ok, true)
      const droppedBefore = stack.service.metricsSnapshot().deltasDroppedNonText
      const admittedBefore = stack.gate.metricsSnapshot().ttsAdmissions
      await submitAndAwaitCompletion(stack, sessionKey, 'E2E02-TOOL 合成转写。')
      const metrics = stack.service.metricsSnapshot()
      assert.ok(
        metrics.deltasDroppedNonText > droppedBefore,
        'tool-call deltas must be counted and dropped by the bridge',
      )
      assert.ok(stack.gate.metricsSnapshot().ttsAdmissions >= admittedBefore)
    } finally {
      await toolFixture.dispose()
    }
  })

  it('quarantines a crashed worker, settles the turn FAILED and rebuilds only on reopen', async () => {
    fixture = await startBridgeFixture({
      script: {
        fixedTurnTexts: [Array.from({ length: 20 }, (_, i) => `崩溃前第${i + 1}句。`).join('')],
        streamChunkDelayMs: 60,
      },
    })
    const { stack, port, sessionKey, frames } = fixture
    const opened = await stack.openSession({
      sessionKey,
      conversationId: 'conv_e2e02crash01',
      ownerActorId: 'act_e2e02parent01',
    })
    assert.equal(opened.ok, true)
    const submitted = await submitSynthetic(stack, sessionKey, 'E2E02-CRASH 合成转写。')
    assert.equal(submitted.ok, true)
    const turnId = submitted.ok ? submitted.turnId : ''
    await waitFor('the worker to start streaming', () => stack.gate.metricsSnapshot().ttsAdmissions > 0)
    assert.equal(port.hasLiveWorker(sessionKey), true, 'the worker process must be live before the crash')

    // Real process kill (SIGKILL) — the crash is physical, not simulated.
    assert.equal(port.crashNow(sessionKey), true)
    const state = await waitForTerminalTurn(stack, sessionKey, turnId)
    assert.equal(state, 'FAILED', 'the quarantined worker turn must settle FAILED (never resume)')
    const crashed = frames.find((frame) => frame.name === 'runtime.error' && frame.payload.code === 'worker_crashed')
    assert.ok(crashed !== undefined, 'the bridge must emit the worker_crashed runtime error')
    await waitFor('the worker process to be reaped', () => !port.hasLiveWorker(sessionKey))

    const refused = await submitSynthetic(stack, sessionKey, 'E2E02-CRASH-REFUSED 合成转写。')
    assert.equal(refused.ok, false, 'a quarantined session must refuse new prompts')
    if (!refused.ok) {
      assert.equal(refused.code, 'worker_recovering')
    }

    // Recovery is explicit: a fresh session.open rebuilds the worker.
    const reopened = await stack.openSession({
      sessionKey,
      conversationId: 'conv_e2e02crash01',
      ownerActorId: 'act_e2e02parent01',
    })
    assert.equal(reopened.ok, true)
    assert.equal(reopened.ok && reopened.recovered, true, 'the reopen must report the recovery')
    const recoveredTurnId = await submitAndAwaitCompletion(stack, sessionKey, 'E2E02-AFTER-CRASH 合成转写。')
    assert.notEqual(recoveredTurnId, turnId)
    const metrics = stack.service.metricsSnapshot()
    assert.ok(metrics.workerRecovery.count >= 1, 'the worker recovery latency must be recorded')
    const auditActions = stack.service.auditSnapshot().map((entry) => entry.action)
    assert.ok(auditActions.includes('bridge.worker_quarantined'), 'the quarantine must be audited')
    assert.ok(auditActions.includes('bridge.worker_recovered'), 'the recovery must be audited')
  })

  it('bounds a hung whenIdle: the stop verification times out, the worker quarantines and no deadlock follows', async () => {
    fixture = await startBridgeFixture({
      script: {
        fixedTurnTexts: [Array.from({ length: 20 }, (_, i) => `卡死前第${i + 1}句。`).join('')],
        streamChunkDelayMs: 60,
      },
      workerEnv: { DSH_BRIDGE_INJECT_IDLE_HANG: '1' },
      whenIdleTimeoutMs: 700,
    })
    const { stack, sessionKey, frames } = fixture
    const opened = await stack.openSession({
      sessionKey,
      conversationId: 'conv_e2e02hang01',
      ownerActorId: 'act_e2e02parent01',
    })
    assert.equal(opened.ok, true)
    const submitted = await submitSynthetic(stack, sessionKey, 'E2E02-HANG 合成转写。')
    assert.equal(submitted.ok, true)
    const turnId = submitted.ok ? submitted.turnId : ''
    await waitFor('the first safe-text admission', () => stack.gate.metricsSnapshot().ttsAdmissions > 0)

    const startedAt = Date.now()
    const barge = await stack.bargeInCancel({ sessionKey, turnId, reason: 'device_abort' })
    const elapsed = Date.now() - startedAt
    assert.equal(barge.ok, false, 'the cancel must fail closed against the hung worker')
    if (!barge.ok) {
      assert.equal(barge.code, 'cancel_timeout', 'the bridge must report the bounded stop-verification timeout')
      assert.equal(barge.fenced, true, 'the fence already revoked the old epoch')
    }
    assert.ok(elapsed < 10_000, `the hung whenIdle must be bounded (took ${elapsed}ms)`)
    const state = await waitForTerminalTurn(stack, sessionKey, turnId)
    assert.equal(state, 'FAILED', 'the hung worker turn must settle FAILED')
    const quarantineEvents = frames.filter(
      (frame) => frame.name === 'runtime.error' && frame.payload.code === 'worker_crashed',
    )
    assert.ok(quarantineEvents.length >= 1, 'the cancel-timeout path must quarantine the worker')
    const cancelTimeoutAudit = stack.service
      .auditSnapshot()
      .find((entry) => entry.action === 'bridge.worker_quarantined' && entry.resultCode === 'cancel_timeout')
    assert.ok(cancelTimeoutAudit !== undefined, 'the cancel_timeout quarantine must be audited')

    // Recovery on the same hung port: dispose the hung worker and rebuild.
    const reopened = await stack.openSession({
      sessionKey,
      conversationId: 'conv_e2e02hang01',
      ownerActorId: 'act_e2e02parent01',
    })
    assert.equal(reopened.ok, true)
    assert.equal(reopened.ok && reopened.recovered, true)
    await submitAndAwaitCompletion(stack, sessionKey, 'E2E02-AFTER-HANG 合成转写。')
  })

  it('records content-free structured audit evidence only', async () => {
    fixture = await startBridgeFixture({
      script: { fixedTurnTexts: ['E2E02 审计轮。合成回复句一。合成回复句二。'] },
    })
    const { stack, sessionKey } = fixture
    const opened = await stack.openSession({
      sessionKey,
      conversationId: 'conv_e2e02audit01',
      ownerActorId: 'act_e2e02parent01',
    })
    assert.equal(opened.ok, true)
    const promptMarker = 'E2E02-AUDIT-MARKER 合成转写。'
    await submitAndAwaitCompletion(stack, sessionKey, promptMarker)

    const allowedKeys = new Set(['seq', 'atMs', 'action', 'sessionKey', 'turnId', 'epoch', 'resultCode', 'count'])
    const audit = stack.service.auditSnapshot()
    assert.ok(audit.length >= 3, 'the session must produce auditable actions')
    for (const entry of audit) {
      for (const key of Object.keys(entry)) {
        assert.ok(allowedKeys.has(key), `audit entry carries an unknown field: ${key}`)
      }
    }
    const serialized = JSON.stringify(audit)
    assert.ok(!serialized.includes('E2E02-AUDIT-MARKER'), 'the audit must never carry the prompt text')
    assert.ok(!serialized.includes('合成回复句'), 'the audit must never carry model output text')
    assert.ok(!serialized.includes('审计轮'), 'the audit must never carry scripted stream text')

    const metrics = stack.service.metricsSnapshot()
    for (const [key, value] of Object.entries(metrics)) {
      const numeric =
        typeof value === 'number' ||
        (typeof value === 'object' &&
          value !== null &&
          typeof (value as { count?: unknown }).count === 'number' &&
          typeof (value as { maxMs?: unknown }).maxMs === 'number')
      assert.ok(numeric, `metric ${key} must be structured and numeric`)
    }
  })
})
