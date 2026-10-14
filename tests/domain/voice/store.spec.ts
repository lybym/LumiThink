/**
 * R1-V1 trusted fence store (in-memory) tests (issue #28 实现范围 2/3).
 *
 * Proves the atomic fencing semantics the issue demands: epoch bump first
 * and atomically, session ownership, forged/stale epoch rejection,
 * cross-session rejection, idempotent conditional commits, and the
 * fail-closed restart port.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createInMemoryVoiceFenceStore, VOICE_FENCE_STORE_FORMAT } from "../../../lib/domain/voice/store.ts";
import {
  testActorId,
  testConversationId,
  testSessionKey,
} from "./helpers.ts";

const NOW = 5_000;

const REFS = {
  sessionKey: testSessionKey(1),
  conversationId: testConversationId(1),
  ownerActorId: testActorId(1),
};

function newStore() {
  return createInMemoryVoiceFenceStore();
}

function openA(store: ReturnType<typeof newStore>): void {
  const opened = store.openSession({ ...REFS, nowMs: NOW });
  assert.ok(opened.ok);
}

function prompt(
  store: ReturnType<typeof newStore>,
  turnId: string,
  overrides: Partial<Parameters<ReturnType<typeof newStore>["registerPrompt"]>[0]> = {},
) {
  return store.registerPrompt({
    sessionKey: REFS.sessionKey,
    turnId,
    traceId: null,
    idempotencyKey: null,
    fingerprint: null,
    nowMs: NOW,
    ...overrides,
  });
}

function dispatch(store: ReturnType<typeof newStore>, turnId: string): void {
  const pumped = store.pumpScheduler({ sessionKey: REFS.sessionKey, nowMs: NOW });
  assert.ok(pumped.ok);
  assert.equal(pumped.dispatchedTurnId, turnId);
}

// ---------------------------------------------------------------------------
// Session ownership
// ---------------------------------------------------------------------------

test("a session starts at trusted epoch 1 and reopens idempotently for the same owner", () => {
  const store = newStore();
  const opened = store.openSession({ ...REFS, nowMs: NOW });
  assert.deepEqual(opened, { ok: true, created: true, epoch: 1 });
  const reopened = store.openSession({ ...REFS, nowMs: NOW + 1 });
  assert.deepEqual(reopened, { ok: true, created: false, epoch: 1 });
});

test("the same session key with a different owner or conversation is a conflict", () => {
  const store = newStore();
  openA(store);
  const otherOwner = store.openSession({
    ...REFS,
    ownerActorId: testActorId(2),
    nowMs: NOW,
  });
  assert.deepEqual(otherOwner, { ok: false, code: "session_conflict" });
  const otherConversation = store.openSession({
    ...REFS,
    conversationId: testConversationId(2),
    nowMs: NOW,
  });
  assert.deepEqual(otherConversation, { ok: false, code: "session_conflict" });
  // Nothing was rebound.
  assert.equal(store.describeSession(REFS.sessionKey)?.ownerActorId, REFS.ownerActorId);
});

// ---------------------------------------------------------------------------
// Prompt intake + idempotency
// ---------------------------------------------------------------------------

test("a prompt is born CREATED at the CURRENT trusted epoch (clients never name it)", () => {
  const store = newStore();
  openA(store);
  const registered = prompt(store, "trn_turn00000001");
  assert.ok(registered.ok && !registered.replayed);
  assert.equal(registered.turn.epoch, 1);
  assert.equal(registered.turn.state, "CREATED");
});

test("same idempotency key + fingerprint replays the ORIGINAL turn; different fingerprint conflicts", () => {
  const store = newStore();
  openA(store);
  const first = prompt(store, "trn_turn00000001", {
    idempotencyKey: "idem-key-000001",
    fingerprint: "0123456789abcdef",
  });
  assert.ok(first.ok && !first.replayed);

  const retry = prompt(store, "trn_turn00000002", {
    idempotencyKey: "idem-key-000001",
    fingerprint: "0123456789abcdef",
  });
  assert.ok(retry.ok && retry.replayed);
  assert.equal(retry.turn.turnId, "trn_turn00000001");

  const conflicting = prompt(store, "trn_turn00000003", {
    idempotencyKey: "idem-key-000001",
    fingerprint: "ffffffffffffffff",
  });
  assert.deepEqual(conflicting, { ok: false, code: "idempotency_conflict" });
  // No third turn was created for the conflicting call.
  assert.equal(store.listTurns(REFS.sessionKey).length, 1);
});

test("malformed prompt input fails closed as a parse error and stores nothing", () => {
  const store = newStore();
  openA(store);
  assert.throws(() =>
    prompt(store, "trn_turn00000001", { idempotencyKey: "idem-key-000001", fingerprint: null }),
  );
  assert.throws(() =>
    prompt(store, "trn_turn00000001", { idempotencyKey: "abc", fingerprint: "0123456789abcdef" }),
  );
  assert.throws(() => prompt(store, "bad-turn-id"));
  // An unknown session is an enumerated rejection, not a parse error.
  assert.deepEqual(prompt(store, "trn_turn00000001", { sessionKey: testSessionKey(99) }), {
    ok: false,
    code: "session_unknown",
  });
  assert.equal(store.listTurns(REFS.sessionKey).length, 0);
});

// ---------------------------------------------------------------------------
// Effective interruption: atomic epoch bump
// ---------------------------------------------------------------------------

test("a valid interruption bumps the epoch and flips EVERY non-terminal old-epoch turn to CANCELLING", () => {
  const store = newStore();
  openA(store);
  prompt(store, "trn_turn00000001");
  prompt(store, "trn_turn00000002");
  dispatch(store, "trn_turn00000001");

  const cancelled = store.cancelTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", nowMs: NOW + 10 });
  assert.ok(cancelled.ok);
  assert.equal(cancelled.epoch, 2);
  assert.equal(cancelled.previousEpoch, 1);
  assert.deepEqual([...cancelled.fencedTurnIds], ["trn_turn00000001", "trn_turn00000002"]);
  assert.equal(store.currentEpoch(REFS.sessionKey), 2);
  for (const turn of store.listTurns(REFS.sessionKey)) {
    assert.equal(turn.state, "CANCELLING");
  }
});

test("duplicate cancel, terminal cancel and stale-epoch cancel are fence-rejected WITHOUT a second bump", () => {
  const store = newStore();
  openA(store);
  prompt(store, "trn_turn00000001");
  dispatch(store, "trn_turn00000001");

  assert.ok(store.cancelTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", nowMs: NOW }).ok);
  const duplicate = store.cancelTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", nowMs: NOW });
  assert.deepEqual(duplicate, { ok: false, code: "cancel_already_active" });
  assert.equal(store.currentEpoch(REFS.sessionKey), 2, "a duplicate cancel must not bump again");

  // Confirm the stop; a third cancel on the terminal turn is rejected.
  const stopped = store.settleTurn({
    sessionKey: REFS.sessionKey,
    turnId: "trn_turn00000001",
    outcome: "CANCELLED",
    nowMs: NOW,
  });
  assert.ok(stopped.ok);
  assert.deepEqual(store.cancelTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", nowMs: NOW }), {
    ok: false,
    code: "turn_terminal",
  });

  // A new turn at the new epoch, then a LATE cancel for the old turn …
  prompt(store, "trn_turn00000002");
  const lateForOldTurn = store.cancelTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", nowMs: NOW });
  assert.deepEqual(lateForOldTurn, { ok: false, code: "turn_terminal" });
  // … and the epoch stays at 2 (no bump for fenced requests).
  assert.equal(store.currentEpoch(REFS.sessionKey), 2);
});

test("an unknown or cross-session turn reference is rejected without leaking the other session", () => {
  const store = newStore();
  openA(store);
  prompt(store, "trn_turn00000001");

  assert.deepEqual(store.cancelTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000042", nowMs: NOW }), {
    ok: false,
    code: "turn_unknown",
  });

  const other = store.openSession({
    sessionKey: testSessionKey(2),
    conversationId: testConversationId(2),
    ownerActorId: testActorId(1),
    nowMs: NOW,
  });
  assert.ok(other.ok);
  assert.deepEqual(store.cancelTurn({ sessionKey: testSessionKey(2), turnId: "trn_turn00000001", nowMs: NOW }), {
    ok: false,
    code: "cross_session_rejected",
  });
  assert.equal(store.describeTurn(testSessionKey(2), "trn_turn00000001"), null);
  assert.equal(store.currentEpoch(REFS.sessionKey), 1, "a rejected cancel must not bump");
});

// ---------------------------------------------------------------------------
// Scheduler: parallel ASR intake, dispatch gate
// ---------------------------------------------------------------------------

test("a new prompt may arrive while the old task runs, but only dispatches after it stopped", () => {
  const store = newStore();
  openA(store);
  prompt(store, "trn_turn00000001");
  dispatch(store, "trn_turn00000001");

  // New ASR during a RUNNING turn: accepted, queued, NOT dispatched.
  const second = prompt(store, "trn_turn00000002");
  assert.ok(second.ok && !second.replayed);
  const pumped = store.pumpScheduler({ sessionKey: REFS.sessionKey, nowMs: NOW });
  assert.ok(pumped.ok);
  assert.equal(pumped.dispatchedTurnId, null);
  assert.equal(pumped.busyTurnId, "trn_turn00000001");
  assert.equal(store.describeTurn(REFS.sessionKey, "trn_turn00000002")?.state, "QUEUED");

  // Old task completes → the queued turn dispatches on the next pump.
  const settled = store.settleTurn({
    sessionKey: REFS.sessionKey,
    turnId: "trn_turn00000001",
    outcome: "COMPLETED",
    nowMs: NOW,
  });
  assert.ok(settled.ok);
  const after = store.pumpScheduler({ sessionKey: REFS.sessionKey, nowMs: NOW });
  assert.ok(after.ok);
  assert.equal(after.dispatchedTurnId, "trn_turn00000002");
});

test("the dispatcher serves turns in creation order and never revives a fenced turn", () => {
  const store = newStore();
  openA(store);
  prompt(store, "trn_turn00000001");
  prompt(store, "trn_turn00000002");
  dispatch(store, "trn_turn00000001");

  // Interrupt: both old-epoch turns are fenced; the pump must not dispatch.
  assert.ok(store.cancelTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", nowMs: NOW }).ok);
  const fencedPump = store.pumpScheduler({ sessionKey: REFS.sessionKey, nowMs: NOW });
  assert.ok(fencedPump.ok);
  assert.equal(fencedPump.dispatchedTurnId, null, "CANCELLING turns keep the session busy");

  // After the stop, nothing old may dispatch.
  assert.ok(
    store.settleTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", outcome: "CANCELLED", nowMs: NOW }).ok,
  );
  assert.ok(
    store.settleTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000002", outcome: "CANCELLED", nowMs: NOW }).ok,
  );
  const drained = store.pumpScheduler({ sessionKey: REFS.sessionKey, nowMs: NOW });
  assert.ok(drained.ok);
  assert.equal(drained.dispatchedTurnId, null);
});

// ---------------------------------------------------------------------------
// Output fence (text delta / TTS queue / audio send)
// ---------------------------------------------------------------------------

test("the output fence allows only the CURRENT epoch of a RUNNING turn", () => {
  const store = newStore();
  openA(store);
  prompt(store, "trn_turn00000001");
  dispatch(store, "trn_turn00000001");

  assert.deepEqual(store.fenceOutput({
    sessionKey: REFS.sessionKey,
    turnId: "trn_turn00000001",
    epoch: 1,
    kind: "text_delta",
    ttsItemId: "tts_item0000001",
    nowMs: NOW,
  }), { ok: true, allowed: true, ttsItemId: null });

  // Forged future epoch.
  assert.deepEqual(store.fenceOutput({
    sessionKey: REFS.sessionKey,
    turnId: "trn_turn00000001",
    epoch: 2,
    kind: "text_delta",
    ttsItemId: "tts_item0000002",
    nowMs: NOW,
  }), { ok: false, code: "epoch_forged" });

  // Queue a TTS sentence, then interrupt: the old-epoch emission is stale.
  assert.ok(store.fenceOutput({
    sessionKey: REFS.sessionKey,
    turnId: "trn_turn00000001",
    epoch: 1,
    kind: "tts_queue",
    ttsItemId: "tts_item0000003",
    nowMs: NOW,
  }).ok);
  assert.equal(store.ttsQueueDepth(REFS.sessionKey), 1);

  assert.ok(store.cancelTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", nowMs: NOW }).ok);
  assert.deepEqual(store.fenceOutput({
    sessionKey: REFS.sessionKey,
    turnId: "trn_turn00000001",
    epoch: 1,
    kind: "text_delta",
    ttsItemId: "tts_item0000004",
    nowMs: NOW,
  }), { ok: false, code: "stale_turn_rejected" }, "a late delta for the fenced epoch is rejected, not dropped downstream");
  assert.deepEqual(store.fenceOutput({
    sessionKey: REFS.sessionKey,
    turnId: "trn_turn00000001",
    epoch: 1,
    kind: "tts_queue",
    ttsItemId: "tts_item0000005",
    nowMs: NOW,
  }), { ok: false, code: "stale_turn_rejected" }, "old audio can no longer be queued");
});

test("the TTS drain delivers only current-epoch items and permanently drops stale ones", () => {
  const store = newStore();
  openA(store);
  prompt(store, "trn_turn00000001");
  dispatch(store, "trn_turn00000001");
  for (const itemId of ["tts_item0000001", "tts_item0000002"]) {
    assert.ok(
      store.fenceOutput({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", epoch: 1, kind: "tts_queue", ttsItemId: itemId, nowMs: NOW }).ok,
    );
  }
  // Interrupt → old items become undeliverable; new turn queues one item.
  assert.ok(store.cancelTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", nowMs: NOW }).ok);
  assert.ok(
    store.settleTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", outcome: "CANCELLED", nowMs: NOW }).ok,
  );
  prompt(store, "trn_turn00000002");
  dispatch(store, "trn_turn00000002");
  assert.ok(
    store.fenceOutput({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000002", epoch: 2, kind: "tts_queue", ttsItemId: "tts_item0000003", nowMs: NOW }).ok,
  );

  const drained = store.drainTtsQueue({ sessionKey: REFS.sessionKey, nowMs: NOW });
  assert.ok(drained.ok);
  assert.equal(drained.droppedStale, 2, "old audio never reaches the device");
  assert.deepEqual([...drained.deliverable], [{ itemId: "tts_item0000003", turnId: "trn_turn00000002", epoch: 2 }]);
  assert.equal(store.ttsQueueDepth(REFS.sessionKey), 0);
});

test("the TTS queue is bounded (backpressure drops the oldest)", () => {
  const store = createInMemoryVoiceFenceStore({ ttsQueueCapacity: 3 });
  store.openSession({ ...REFS, nowMs: NOW });
  store.registerPrompt({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", traceId: null, idempotencyKey: null, fingerprint: null, nowMs: NOW });
  dispatch(store, "trn_turn00000001");
  for (let i = 1; i <= 5; i += 1) {
    const fenced = store.fenceOutput({
      sessionKey: REFS.sessionKey,
      turnId: "trn_turn00000001",
      epoch: 1,
      kind: "tts_queue",
      ttsItemId: `tts_item000000${i}`,
      nowMs: NOW,
    });
    assert.ok(fenced.ok);
  }
  assert.equal(store.ttsQueueDepth(REFS.sessionKey), 3);
  const drained = store.drainTtsQueue({ sessionKey: REFS.sessionKey, nowMs: NOW });
  assert.ok(drained.ok);
  assert.deepEqual(drained.deliverable.map((item) => item.itemId), ["tts_item0000003", "tts_item0000004", "tts_item0000005"]);
});

// ---------------------------------------------------------------------------
// Atomic conditional commit + idempotency (memory transaction races)
// ---------------------------------------------------------------------------

test("fenceWrite commits once, replays the same key+fingerprint and conflicts on a different fingerprint", () => {
  const store = newStore();
  openA(store);
  store.registerPrompt({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", traceId: null, idempotencyKey: null, fingerprint: null, nowMs: NOW });
  dispatch(store, "trn_turn00000001");

  const first = store.fenceWrite({
    sessionKey: REFS.sessionKey,
    turnId: "trn_turn00000001",
    epoch: 1,
    kind: "candidate_memory",
    idempotencyKey: "idem-key-000001",
    fingerprint: "0123456789abcdef",
    nowMs: NOW,
  });
  assert.ok(first.ok && !first.replayed);

  const retry = store.fenceWrite({
    sessionKey: REFS.sessionKey,
    turnId: "trn_turn00000001",
    epoch: 1,
    kind: "candidate_memory",
    idempotencyKey: "idem-key-000001",
    fingerprint: "0123456789abcdef",
    nowMs: NOW,
  });
  assert.ok(retry.ok && retry.replayed, "the retry replays — nothing re-commits");

  const conflicting = store.fenceWrite({
    sessionKey: REFS.sessionKey,
    turnId: "trn_turn00000001",
    epoch: 1,
    kind: "candidate_memory",
    idempotencyKey: "idem-key-000001",
    fingerprint: "ffffffffffffffff",
    nowMs: NOW,
  });
  assert.deepEqual(conflicting, { ok: false, code: "idempotency_conflict" });
});

test("a fenced (old-epoch) write is rejected even when the turn is still CANCELLING", () => {
  const store = newStore();
  openA(store);
  store.registerPrompt({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", traceId: null, idempotencyKey: null, fingerprint: null, nowMs: NOW });
  dispatch(store, "trn_turn00000001");
  assert.ok(store.cancelTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", nowMs: NOW }).ok);

  // The losing writer still believes epoch 1 is current.
  assert.deepEqual(store.fenceWrite({
    sessionKey: REFS.sessionKey,
    turnId: "trn_turn00000001",
    epoch: 1,
    kind: "candidate_memory",
    idempotencyKey: "idem-key-000001",
    fingerprint: "0123456789abcdef",
    nowMs: NOW,
  }), { ok: false, code: "stale_turn_rejected" });

  // Claiming a future epoch is forgery, not scheduling.
  assert.deepEqual(store.fenceWrite({
    sessionKey: REFS.sessionKey,
    turnId: "trn_turn00000001",
    epoch: 3,
    kind: "candidate_memory",
    idempotencyKey: "idem-key-000002",
    fingerprint: "0123456789abcdef",
    nowMs: NOW,
  }), { ok: false, code: "epoch_forged" });

  // A terminal turn can never write again — for a turn that settled at the
  // CURRENT epoch (no bump since), the terminal fence is what fires.
  assert.ok(store.settleTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", outcome: "CANCELLED", nowMs: NOW }).ok);
  assert.ok(
    store.registerPrompt({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000002", traceId: null, idempotencyKey: null, fingerprint: null, nowMs: NOW }).ok,
  );
  dispatch(store, "trn_turn00000002");
  assert.ok(store.settleTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000002", outcome: "COMPLETED", nowMs: NOW }).ok);
  assert.deepEqual(store.fenceWrite({
    sessionKey: REFS.sessionKey,
    turnId: "trn_turn00000002",
    epoch: 2,
    kind: "candidate_memory",
    idempotencyKey: "idem-key-000003",
    fingerprint: "0123456789abcdef",
    nowMs: NOW,
  }), { ok: false, code: "turn_terminal" });
});

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

test("RUNNING and CANCELLING turns older than the budget become TIMED_OUT (fenced)", () => {
  const store = newStore();
  openA(store);
  store.registerPrompt({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", traceId: null, idempotencyKey: null, fingerprint: null, nowMs: NOW });
  dispatch(store, "trn_turn00000001");
  // Turn 1 completes normally (it must NOT be swept).
  assert.ok(store.settleTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", outcome: "COMPLETED", nowMs: NOW }).ok);
  // Turn 2 is cancelled but the stop never confirms → stuck in CANCELLING.
  prompt(store, "trn_turn00000002");
  dispatch(store, "trn_turn00000002");
  assert.ok(store.cancelTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000002", nowMs: NOW }).ok);

  const swept = store.sweepTimeouts({ sessionKey: REFS.sessionKey, budgetMs: 100, nowMs: NOW + 200 });
  assert.ok(swept.ok);
  assert.deepEqual([...swept.timedOutTurnIds], ["trn_turn00000002"]);
  assert.equal(store.describeTurn(REFS.sessionKey, "trn_turn00000001")?.state, "COMPLETED");
  assert.equal(store.describeTurn(REFS.sessionKey, "trn_turn00000002")?.state, "TIMED_OUT");
  assert.ok(store.describeTurn(REFS.sessionKey, "trn_turn00000002")?.settledAtMs !== null);
  // Terminal turns never sweep again.
  const again = store.sweepTimeouts({ sessionKey: REFS.sessionKey, budgetMs: 100, nowMs: NOW + 300 });
  assert.ok(again.ok);
  assert.equal(again.timedOutTurnIds.length, 0);
});

// ---------------------------------------------------------------------------
// Restart port: export / fail-closed restore
// ---------------------------------------------------------------------------

test("export → restore keeps the epoch monotonic and cancelled turns cancelled", () => {
  const store = newStore();
  openA(store);
  store.registerPrompt({
    sessionKey: REFS.sessionKey,
    turnId: "trn_turn00000001",
    traceId: null,
    idempotencyKey: "idem-key-000001",
    fingerprint: "0123456789abcdef",
    nowMs: NOW,
  });
  dispatch(store, "trn_turn00000001");
  assert.ok(store.cancelTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", nowMs: NOW }).ok);
  assert.ok(store.settleTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", outcome: "CANCELLED", nowMs: NOW }).ok);

  const snapshot = store.exportState();
  assert.equal(snapshot.format, VOICE_FENCE_STORE_FORMAT);

  const restarted = newStore();
  const restored = restarted.restoreState(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored, { restoredSessions: 1, restoredTurns: 1 });
  assert.equal(restarted.currentEpoch(REFS.sessionKey), 2, "the epoch survives the restart");

  // The cancelled turn cannot resume: no dispatch, no write, no completion.
  assert.deepEqual(restarted.cancelTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", nowMs: NOW }), {
    ok: false,
    code: "turn_terminal",
  });
  // The restored turn belongs to the PREVIOUS epoch: completion would
  // resurrect fenced output, so the stale fence rejects it first.
  assert.deepEqual(restarted.settleTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", outcome: "COMPLETED", nowMs: NOW }), {
    ok: false,
    code: "stale_turn_rejected",
  });
  const pumped = restarted.pumpScheduler({ sessionKey: REFS.sessionKey, nowMs: NOW });
  assert.ok(pumped.ok && pumped.dispatchedTurnId === null);

  // Monotonicity continues from the restored value.
  restarted.registerPrompt({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000002", traceId: null, idempotencyKey: null, fingerprint: null, nowMs: NOW });
  const pumpedNew = restarted.pumpScheduler({ sessionKey: REFS.sessionKey, nowMs: NOW });
  assert.ok(pumpedNew.ok && pumpedNew.dispatchedTurnId === "trn_turn00000002");
  assert.deepEqual(restarted.fenceWrite({
    sessionKey: REFS.sessionKey,
    turnId: "trn_turn00000002",
    epoch: 2,
    kind: "domain_event",
    idempotencyKey: "idem-key-000009",
    fingerprint: "ffffffffffffffff",
    nowMs: NOW,
  }).ok, true);
  assert.ok(restarted.cancelTurn({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000002", nowMs: NOW }).ok);
  assert.equal(restarted.currentEpoch(REFS.sessionKey), 3, "restored epoch + 1");
});

test("restore is fail-closed: forged snapshots change nothing", () => {
  const store = newStore();
  openA(store);
  store.registerPrompt({ sessionKey: REFS.sessionKey, turnId: "trn_turn00000001", traceId: null, idempotencyKey: null, fingerprint: null, nowMs: NOW });

  const snapshot = store.exportState();
  const forgedFutureEpoch = JSON.parse(JSON.stringify(snapshot));
  forgedFutureEpoch.sessions[0].epoch = 5;
  forgedFutureEpoch.turns[0].epoch = 7;
  assert.throws(() => store.restoreState(forgedFutureEpoch));

  const unknownFormat = { format: "someone-else/v9", sessions: [], turns: [] };
  assert.throws(() => store.restoreState(unknownFormat));

  const unknownField = JSON.parse(JSON.stringify(snapshot));
  unknownField.turns[0].transcript = "should never exist";
  assert.throws(() => store.restoreState(unknownField));

  // The failed restores changed nothing (the store still runs at epoch 1).
  assert.equal(store.currentEpoch(REFS.sessionKey), 1);
  assert.equal(store.listTurns(REFS.sessionKey).length, 1);
});
