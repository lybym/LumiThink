/**
 * R1-V1 Voice Turn Orchestrator tests (issue #28 实现范围 1/2/4/5).
 *
 * Proves the sequencing contract of docs/VOICE_RUNTIME.md §4 through the
 * public orchestrator surface — fence FIRST, dispatch only after the old
 * task stopped, late/duplicate/old-epoch operations fence-rejected — and
 * the structural-only audit ring.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createVoiceTurnOrchestrator } from "../../../lib/domain/voice/orchestrator.ts";
import { createInMemoryVoiceFenceStore } from "../../../lib/domain/voice/store.ts";
import {
  createTurnIdFactory,
  createVirtualClock,
  syntheticFingerprint,
  testActorId,
  testConversationId,
  testSessionKey,
  testTraceId,
} from "./helpers.ts";

const SESSION = testSessionKey(7);
const OWNER = testActorId(7);
const CONVERSATION = testConversationId(7);

function newOrchestrator() {
  const turnIds = createTurnIdFactory();
  const clock = createVirtualClock();
  const orchestrator = createVoiceTurnOrchestrator({
    clock: clock.now,
    turnIdFactory: turnIds,
  });
  const opened = orchestrator.openSession({
    sessionKey: SESSION,
    conversationId: CONVERSATION,
    ownerActorId: OWNER,
  });
  assert.ok(opened.ok);
  return { orchestrator, turnIds, clock };
}

test("an idle session dispatches a new prompt immediately (CREATED → QUEUED → RUNNING)", () => {
  const { orchestrator } = newOrchestrator();
  const received = orchestrator.receivePrompt({
    sessionKey: SESSION,
    traceId: testTraceId(1),
    idempotencyKey: "idem-key-000001",
    fingerprint: syntheticFingerprint({ text: "synthetic utterance #1" }),
  });
  assert.ok(received.ok && !received.replayed);
  assert.equal(received.turn.state, "CREATED");
  assert.equal(received.dispatchedTurnId, received.turn.turnId);
  assert.equal(received.busyTurnId, null);
  assert.equal(orchestrator.describeTurn(SESSION, received.turn.turnId)?.state, "RUNNING");
});

test("a new prompt during a RUNNING turn is queued (never dispatched onto the old task)", () => {
  const { orchestrator } = newOrchestrator();
  const first = orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(1) });
  assert.ok(first.ok);
  const second = orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(2) });
  assert.ok(second.ok);
  assert.equal(second.dispatchedTurnId, null);
  assert.equal(second.busyTurnId, first.turn.turnId);
  assert.equal(orchestrator.describeTurn(SESSION, second.turn.turnId)?.state, "QUEUED");

  // Interruption + stop → the queued turn still waits for an explicit pump.
  assert.ok(
    orchestrator.cancelTurn({ sessionKey: SESSION, turnId: first.turn.turnId, reason: "barge_in" }).ok,
  );
  assert.ok(orchestrator.confirmStop({ sessionKey: SESSION, turnId: first.turn.turnId }).ok);
  // The queued old-epoch turn was fenced into CANCELLING by the bump and
  // settles as CANCELLED — it must NEVER run.
  assert.ok(orchestrator.confirmStop({ sessionKey: SESSION, turnId: second.turn.turnId }).ok);
  const fresh = orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(3) });
  assert.ok(fresh.ok);
  assert.equal(fresh.dispatchedTurnId, fresh.turn.turnId, "the new epoch's turn dispatches after the old stopped");
  assert.equal(orchestrator.currentEpoch(SESSION), 2);
});

test("the effective interruption bumps the epoch exactly once per interruption", () => {
  const { orchestrator } = newOrchestrator();
  const first = orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(1) });
  assert.ok(first.ok);
  assert.equal(orchestrator.currentEpoch(SESSION), 1);

  const cancelled = orchestrator.cancelTurn({ sessionKey: SESSION, turnId: first.turn.turnId, reason: "device_abort" });
  assert.ok(cancelled.ok);
  assert.equal(cancelled.epoch, 2);

  const duplicate = orchestrator.cancelTurn({ sessionKey: SESSION, turnId: first.turn.turnId, reason: "device_abort" });
  assert.deepEqual(duplicate, { ok: false, code: "cancel_already_active" });
  assert.equal(orchestrator.currentEpoch(SESSION), 2, "no double bump");

  assert.ok(orchestrator.confirmStop({ sessionKey: SESSION, turnId: first.turn.turnId }).ok);
  const afterStop = orchestrator.cancelTurn({ sessionKey: SESSION, turnId: first.turn.turnId, reason: "device_abort" });
  assert.deepEqual(afterStop, { ok: false, code: "turn_terminal" });
  assert.equal(orchestrator.currentEpoch(SESSION), 2);
});

test("fenceOutput and fenceWrite reject old epochs AFTER the interruption (late delta / stale write = 0)", () => {
  const { orchestrator } = newOrchestrator();
  const first = orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(1) });
  assert.ok(first.ok);
  const turnId = first.turn.turnId;
  assert.equal(orchestrator.currentEpoch(SESSION), 1);

  // Live output at epoch 1 flows while RUNNING.
  assert.ok(
    orchestrator.fenceOutput({ sessionKey: SESSION, turnId, epoch: 1, kind: "text_delta" }).ok,
  );
  assert.ok(
    orchestrator.fenceOutput({ sessionKey: SESSION, turnId, epoch: 1, kind: "tts_queue", ttsItemId: "tts_item0000001" }).ok,
  );
  assert.ok(
    orchestrator
      .fenceWrite({
        sessionKey: SESSION,
        turnId,
        epoch: 1,
        kind: "candidate_memory",
        idempotencyKey: "idem-key-000001",
        fingerprint: syntheticFingerprint({ memory: "synthetic candidate" }),
      })
      .ok,
  );

  // Interruption: everything old loses its write/emission permission.
  assert.ok(orchestrator.cancelTurn({ sessionKey: SESSION, turnId, reason: "barge_in" }).ok);
  assert.deepEqual(orchestrator.fenceOutput({ sessionKey: SESSION, turnId, epoch: 1, kind: "text_delta" }), { ok: false, code: "stale_turn_rejected" });
  assert.deepEqual(orchestrator.fenceOutput({ sessionKey: SESSION, turnId, epoch: 1, kind: "audio_send" }), { ok: false, code: "stale_turn_rejected" });
  assert.deepEqual(
    orchestrator.fenceWrite({
      sessionKey: SESSION,
      turnId,
      epoch: 1,
      kind: "candidate_memory",
      idempotencyKey: "idem-key-000002",
      fingerprint: syntheticFingerprint({ memory: "late candidate" }),
    }),
    { ok: false, code: "stale_turn_rejected" },
  );

  // The stale TTS item is dropped by the send-side second fence.
  const drained = orchestrator.drainTts(SESSION);
  assert.ok(drained.ok);
  assert.equal(drained.droppedStale, 1);
  assert.equal(drained.deliverable.length, 0);
});

test("confirmStop is the only path from CANCELLING to CANCELLED; illegal settles fail closed", () => {
  const { orchestrator } = newOrchestrator();
  const first = orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(1) });
  assert.ok(first.ok);
  const turnId = first.turn.turnId;

  // RUNNING → CANCELLED directly is illegal.
  assert.deepEqual(orchestrator.settleTurn({ sessionKey: SESSION, turnId, outcome: "CANCELLED" }), {
    ok: false,
    code: "turn_state_transition_illegal",
  });

  assert.ok(orchestrator.cancelTurn({ sessionKey: SESSION, turnId, reason: "system_policy" }).ok);
  // CANCELLING → COMPLETED is illegal twice over: the turn was fenced to
  // the previous epoch (stale) AND a cancelling turn never completes.
  assert.deepEqual(orchestrator.settleTurn({ sessionKey: SESSION, turnId, outcome: "COMPLETED" }), {
    ok: false,
    code: "stale_turn_rejected",
  });
  assert.ok(orchestrator.confirmStop({ sessionKey: SESSION, turnId }).ok);
  assert.equal(orchestrator.describeTurn(SESSION, turnId)?.state, "CANCELLED");
  // Terminal: nothing settles twice.
  assert.deepEqual(orchestrator.settleTurn({ sessionKey: SESSION, turnId, outcome: "FAILED" }), {
    ok: false,
    code: "turn_state_transition_illegal",
  });
});

test("timed-out turns fence the session and release the dispatcher", () => {
  const { orchestrator, clock } = newOrchestrator();
  const first = orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(1) });
  assert.ok(first.ok);
  clock.now(); // advance time
  const swept = orchestrator.sweepTimeouts({ sessionKey: SESSION, budgetMs: 0 });
  assert.ok(swept.ok);
  assert.equal(swept.timedOutTurnIds.length, 1);
  assert.equal(orchestrator.describeTurn(SESSION, first.turn.turnId)?.state, "TIMED_OUT");
  // The dispatcher is free again.
  const next = orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(2) });
  assert.ok(next.ok);
  assert.equal(next.dispatchedTurnId, next.turn.turnId);
});

test("the audit ring records ONLY structural facts about every operation", () => {
  const clock = createVirtualClock();
  const orchestrator = createVoiceTurnOrchestrator({
    clock: clock.now,
    turnIdFactory: createTurnIdFactory(),
  });
  orchestrator.openSession({ sessionKey: SESSION, conversationId: CONVERSATION, ownerActorId: OWNER });
  const first = orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(1) });
  assert.ok(first.ok);
  orchestrator.cancelTurn({ sessionKey: SESSION, turnId: first.turn.turnId, reason: "barge_in" });
  orchestrator.confirmStop({ sessionKey: SESSION, turnId: first.turn.turnId });
  orchestrator.fenceOutput({ sessionKey: SESSION, turnId: first.turn.turnId, epoch: 2, kind: "text_delta" });
  orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(2) });

  const audit = orchestrator.auditSnapshot();
  for (const entry of audit) {
    // Structural fields only; every id is a grammar-valid contract id; no
    // content field exists to echo anything into.
    for (const key of Object.keys(entry)) {
      assert.ok(
        ["seq", "atMs", "action", "sessionKey", "turnId", "traceId", "epoch", "resultCode", "finalState", "count"].includes(key),
        `unexpected audit field ${key}`,
      );
    }
    if (entry.sessionKey !== null) {
      assert.match(entry.sessionKey, /^ses_[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/);
    }
    if (entry.turnId !== null) {
      assert.match(entry.turnId, /^trn_[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/);
    }
    if (entry.traceId !== null) {
      assert.match(entry.traceId, /^trc_[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/);
    }
    if (entry.epoch !== null) {
      assert.ok(Number.isInteger(entry.epoch) && entry.epoch >= 1);
    }
    assert.match(entry.action, /^[a-z._]+$/);
    assert.equal(typeof entry.resultCode, "string");
  }
  // The cancellation is observable with its fan-out count; the late delta
  // is observable as a fence rejection; the settled turn is observable.
  const cancelEntries = audit.filter((entry) => entry.action === "cancel.requested");
  assert.equal(cancelEntries.length, 1);
  assert.equal(cancelEntries[0]?.resultCode, "ok");
  assert.equal(cancelEntries[0]?.epoch, 2);
  assert.equal(cancelEntries[0]?.count, 1);
  const fenceEntries = audit.filter((entry) => entry.action === "output.fenced");
  assert.equal(fenceEntries.length, 1);
  assert.equal(fenceEntries[0]?.resultCode, "stale_turn_rejected");
  assert.equal(fenceEntries[0]?.epoch, 2);
  const stopEntries = audit.filter((entry) => entry.action === "cancel.stop_confirmed");
  assert.equal(stopEntries.length, 1);
  assert.equal(stopEntries[0]?.finalState, "CANCELLED");

  orchestrator.purgeAudit();
  assert.equal(orchestrator.auditSnapshot().length, 0);
});

test("the audit ring is bounded and drops the oldest entries", () => {
  const clock = createVirtualClock();
  const orchestrator = createVoiceTurnOrchestrator({
    clock: clock.now,
    turnIdFactory: createTurnIdFactory(),
    auditCapacity: 4,
  });
  orchestrator.openSession({ sessionKey: SESSION, conversationId: CONVERSATION, ownerActorId: OWNER });
  const first = orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(1) });
  assert.ok(first.ok);
  orchestrator.cancelTurn({ sessionKey: SESSION, turnId: first.turn.turnId, reason: "barge_in" });
  orchestrator.confirmStop({ sessionKey: SESSION, turnId: first.turn.turnId });
  orchestrator.fenceOutput({ sessionKey: SESSION, turnId: first.turn.turnId, epoch: 2, kind: "text_delta" });
  orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(2) });

  const audit = orchestrator.auditSnapshot();
  assert.equal(audit.length, 4, "the ring drops the oldest beyond the capacity");
  assert.equal(audit[0]?.action, "cancel.stop_confirmed", "session.opened/asr/dispatch were dropped first");
});

test("cancel reasons and malformed epochs fail closed as parse errors", () => {
  const { orchestrator } = newOrchestrator();
  const first = orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(1) });
  assert.ok(first.ok);
  assert.throws(() =>
    orchestrator.cancelTurn({ sessionKey: SESSION, turnId: first.turn.turnId, reason: "because_i_said_so" }),
  );
  assert.throws(() =>
    orchestrator.fenceOutput({ sessionKey: SESSION, turnId: first.turn.turnId, epoch: 0, kind: "text_delta" }),
  );
  assert.throws(() =>
    orchestrator.fenceWrite({
      sessionKey: SESSION,
      turnId: first.turn.turnId,
      epoch: 1,
      kind: "candidate_memory",
      idempotencyKey: "idem-key-000001",
      fingerprint: "not-a-digest",
    }),
  );
});

test("the orchestrator exposes the restart port and keeps the epoch monotonic across restarts", () => {
  const { orchestrator } = newOrchestrator();
  const first = orchestrator.receivePrompt({
    sessionKey: SESSION,
    traceId: testTraceId(1),
    idempotencyKey: "idem-key-000001",
    fingerprint: syntheticFingerprint({ text: "synthetic" }),
  });
  assert.ok(first.ok);
  assert.ok(orchestrator.cancelTurn({ sessionKey: SESSION, turnId: first.turn.turnId, reason: "barge_in" }).ok);
  assert.ok(orchestrator.confirmStop({ sessionKey: SESSION, turnId: first.turn.turnId }).ok);

  const snapshot = orchestrator.exportState();
  const restarted = createVoiceTurnOrchestrator({
    clock: createVirtualClock().now,
    // Continue the turn-id sequence after the restart (ids stay globally
    // unique across the restore).
    turnIdFactory: createTurnIdFactory(1),
    store: createInMemoryVoiceFenceStore(),
  });
  const restored = restarted.restoreState(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored, { restoredSessions: 1, restoredTurns: 1 });
  assert.equal(restarted.currentEpoch(SESSION), 2);

  // The cancelled turn is not resurrected by the restart.
  assert.deepEqual(restarted.cancelTurn({ sessionKey: SESSION, turnId: first.turn.turnId, reason: "barge_in" }), {
    ok: false,
    code: "turn_terminal",
  });
  const next = restarted.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(2) });
  assert.ok(next.ok && next.dispatchedTurnId === next.turn.turnId);
  assert.ok(restarted.cancelTurn({ sessionKey: SESSION, turnId: next.turn.turnId, reason: "barge_in" }).ok);
  assert.equal(restarted.currentEpoch(SESSION), 3);
});
