/**
 * R1-V1 SQLite adapter tests (issue #28 实现范围 3: "SQLite 实现以事务原子
 * 核验会话归属/epoch/身份；禁用不安全 SELECT→独立 INSERT 的竞态实现").
 *
 * Proves on the REAL transactional store: atomic conditional commits,
 * idempotency, forged/stale epoch rejection, cross-session rejection,
 * RESTART monotonicity (close → reopen → epoch continues; cancelled turns
 * stay cancelled) and the fail-closed schema-version migration gate.
 * Synthetic data only — every persisted column is an id, a code, a digest
 * or a bounded integer.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createVoiceTurnOrchestrator } from "../../lib/domain/voice/orchestrator.ts";
import { VOICE_FENCE_STORE_FORMAT } from "../../lib/domain/voice/store.ts";
import {
  createSqliteVoiceFenceStore,
  VoiceFenceStoreOpenError,
  VOICE_SQLITE_SCHEMA_VERSION,
} from "../../lib/server/voice-turn-sqlite-store.ts";
import {
  createTurnIdFactory,
  createVirtualClock,
  syntheticFingerprint,
  testActorId,
  testConversationId,
  testSessionKey,
  testTraceId,
} from "../domain/voice/helpers.ts";

const SESSION = testSessionKey(901);
const OWNER = testActorId(901);
const CONVERSATION = testConversationId(901);

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "lumithink-voice-fence-")), "voice-fence.db");
}

/** Remove the temp dir that hosts one database file (test hygiene). */
function cleanupDb(path: string): void {
  rmSync(join(path, ".."), { recursive: true, force: true });
}

test("the transactional store fences writes exactly like the in-memory port", () => {
  const path = tempDbPath();
  const store = createSqliteVoiceFenceStore({ path });
  try {
    assert.ok(store.openSession({ sessionKey: SESSION, conversationId: CONVERSATION, ownerActorId: OWNER, nowMs: 1000 }).ok);
    assert.ok(
      store.registerPrompt({
        sessionKey: SESSION,
        turnId: "trn_turn00000001",
        traceId: testTraceId(1),
        idempotencyKey: "idem-key-000001",
        fingerprint: syntheticFingerprint({ prompt: "synthetic" }),
        nowMs: 1001,
      }).ok,
    );
    const pumped = store.pumpScheduler({ sessionKey: SESSION, nowMs: 1002 });
    assert.ok(pumped.ok && pumped.dispatchedTurnId === "trn_turn00000001");

    // Commit inside one transaction.
    const committed = store.fenceWrite({
      sessionKey: SESSION,
      turnId: "trn_turn00000001",
      epoch: 1,
      kind: "candidate_memory",
      idempotencyKey: "idem-key-000002",
      fingerprint: syntheticFingerprint({ memory: "synthetic candidate" }),
      nowMs: 1003,
    });
    assert.ok(committed.ok && !committed.replayed && committed.epoch === 1);

    // Replay + conflict on the same key.
    const replay = store.fenceWrite({
      sessionKey: SESSION,
      turnId: "trn_turn00000001",
      epoch: 1,
      kind: "candidate_memory",
      idempotencyKey: "idem-key-000002",
      fingerprint: syntheticFingerprint({ memory: "synthetic candidate" }),
      nowMs: 1004,
    });
    assert.ok(replay.ok && replay.replayed);
    assert.deepEqual(
      store.fenceWrite({
        sessionKey: SESSION,
        turnId: "trn_turn00000001",
        epoch: 1,
        kind: "candidate_memory",
        idempotencyKey: "idem-key-000002",
        fingerprint: syntheticFingerprint({ memory: "different" }),
        nowMs: 1005,
      }),
      { ok: false, code: "idempotency_conflict" },
    );

    // Ownership + epoch + identity are validated in the SAME transaction.
    assert.deepEqual(
      store.fenceWrite({
        sessionKey: SESSION,
        turnId: "trn_turn00000001",
        epoch: 2,
        kind: "candidate_memory",
        idempotencyKey: "idem-key-000003",
        fingerprint: syntheticFingerprint({ memory: "forged" }),
        nowMs: 1006,
      }),
      { ok: false, code: "epoch_forged" },
    );

    // The effective interruption is one transaction: bump + fence.
    const cancelled = store.cancelTurn({ sessionKey: SESSION, turnId: "trn_turn00000001", nowMs: 1007 });
    assert.ok(cancelled.ok && cancelled.epoch === 2);
    assert.deepEqual(
      store.fenceWrite({
        sessionKey: SESSION,
        turnId: "trn_turn00000001",
        epoch: 1,
        kind: "candidate_memory",
        idempotencyKey: "idem-key-000004",
        fingerprint: syntheticFingerprint({ memory: "late" }),
        nowMs: 1008,
      }),
      { ok: false, code: "stale_turn_rejected" },
    );
  } finally {
    store.close();
  }
});

test("restart monotonicity: epoch continues, cancelled turns stay cancelled, forged epochs rejected", () => {
  const path = tempDbPath();
  const turnIds = createTurnIdFactory();
  const clock = createVirtualClock();
  let firstTurnId = "";

  {
    const store = createSqliteVoiceFenceStore({ path });
    const orchestrator = createVoiceTurnOrchestrator({ store, clock: clock.now, turnIdFactory: turnIds });
    assert.ok(orchestrator.openSession({ sessionKey: SESSION, conversationId: CONVERSATION, ownerActorId: OWNER }).ok);
    const first = orchestrator.receivePrompt({
      sessionKey: SESSION,
      traceId: testTraceId(1),
      idempotencyKey: "idem-key-000001",
      fingerprint: syntheticFingerprint({ prompt: "synthetic" }),
    });
    assert.ok(first.ok);
    firstTurnId = first.turn.turnId;
    assert.ok(orchestrator.cancelTurn({ sessionKey: SESSION, turnId: first.turn.turnId, reason: "barge_in" }).ok);
    assert.ok(orchestrator.confirmStop({ sessionKey: SESSION, turnId: first.turn.turnId }).ok);
    assert.equal(orchestrator.currentEpoch(SESSION), 2);
    store.close();
  }

  {
    // "Process restart": a brand-new store instance over the same file.
    const store = createSqliteVoiceFenceStore({ path });
    const orchestrator = createVoiceTurnOrchestrator({ store, clock: clock.now, turnIdFactory: turnIds });
    assert.equal(orchestrator.currentEpoch(SESSION), 2, "the trusted epoch survives the restart");

    // The cancelled turn cannot resume.
    assert.deepEqual(
      orchestrator.cancelTurn({ sessionKey: SESSION, turnId: firstTurnId, reason: "barge_in" }),
      { ok: false, code: "turn_terminal" },
    );
    assert.deepEqual(
      orchestrator.settleTurn({ sessionKey: SESSION, turnId: firstTurnId, outcome: "COMPLETED" }),
      { ok: false, code: "stale_turn_rejected" },
    );

    // Cross-session and forged-epoch requests stay rejected after restart.
    assert.ok(
      store.openSession({
        sessionKey: testSessionKey(902),
        conversationId: testConversationId(902),
        ownerActorId: OWNER,
        nowMs: clock.now(),
      }).ok,
    );
    assert.deepEqual(store.cancelTurn({ sessionKey: testSessionKey(902), turnId: firstTurnId, nowMs: clock.now() }), {
      ok: false,
      code: "cross_session_rejected",
    });

    // New work continues FROM the restored epoch, monotonically.
    const next = orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(2) });
    assert.ok(next.ok && next.dispatchedTurnId === next.turn.turnId);
    assert.equal(next.turn.epoch, 2);
    const cancelled2 = orchestrator.cancelTurn({ sessionKey: SESSION, turnId: next.turn.turnId, reason: "barge_in" });
    assert.ok(cancelled2.ok && cancelled2.epoch === 3, "restart must not reset or fork the epoch");
    store.close();
  }
});

test("restoreState validates the snapshot with the SAME parsers as the domain store", () => {
  const path = tempDbPath();
  const store = createSqliteVoiceFenceStore({ path });
  try {
    store.openSession({ sessionKey: SESSION, conversationId: CONVERSATION, ownerActorId: OWNER, nowMs: 1000 });
    store.registerPrompt({
      sessionKey: SESSION,
      turnId: "trn_turn00000001",
      traceId: null,
      idempotencyKey: "idem-key-000001",
      fingerprint: syntheticFingerprint({ prompt: "synthetic" }),
      nowMs: 1001,
    });
    const snapshot = store.exportState();
    assert.equal(snapshot.format, VOICE_FENCE_STORE_FORMAT);

    const otherPath = tempDbPath();
    const other = createSqliteVoiceFenceStore({ path: otherPath });
    try {
      const restored = other.restoreState(JSON.parse(JSON.stringify(snapshot)));
      assert.deepEqual(restored, { restoredSessions: 1, restoredTurns: 1 });
      assert.equal(other.currentEpoch(SESSION), 1);
      assert.equal(other.describeTurn(SESSION, "trn_turn00000001")?.state, "CREATED");

      // A forged snapshot (turn epoch above the session epoch) is rejected.
      const forged = JSON.parse(JSON.stringify(snapshot));
      forged.turns[0].epoch = 9;
      assert.throws(() => other.restoreState(forged));
    } finally {
      other.close();
      cleanupDb(otherPath);
    }
  } finally {
    store.close();
  }
});

test("opening a store written by an unknown schema/format version fails closed", () => {
  const path = tempDbPath();
  {
    const store = createSqliteVoiceFenceStore({ path });
    store.close();
  }
  // Tamper with the version marker to simulate a future schema.
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE voice_fence_meta SET value = ? WHERE key = 'schema_version'").run("999");
  raw.close();
  assert.throws(() => createSqliteVoiceFenceStore({ path }), (error: unknown) => {
    assert.ok(error instanceof VoiceFenceStoreOpenError);
    assert.equal(error.reason, "schema_version_mismatch");
    return true;
  });

  // A foreign format is likewise refused.
  const path2 = tempDbPath();
  {
    const store = createSqliteVoiceFenceStore({ path: path2 });
    store.close();
  }
  const raw2 = new DatabaseSync(path2);
  raw2.prepare("UPDATE voice_fence_meta SET value = ? WHERE key = 'format'").run("future-store/v2");
  raw2.close();
  assert.throws(() => createSqliteVoiceFenceStore({ path: path2 }), (error: unknown) => {
    assert.ok(error instanceof VoiceFenceStoreOpenError);
    assert.equal(error.reason, "format_mismatch");
    return true;
  });
  assert.equal(VOICE_SQLITE_SCHEMA_VERSION, "1");
});

test("the adapter drives the full interruption lifecycle through the orchestrator", () => {
  const path = tempDbPath();
  const store = createSqliteVoiceFenceStore({ path });
  try {
    const clock = createVirtualClock();
    const orchestrator = createVoiceTurnOrchestrator({ store, clock: clock.now, turnIdFactory: createTurnIdFactory() });
    assert.ok(orchestrator.openSession({ sessionKey: SESSION, conversationId: CONVERSATION, ownerActorId: OWNER }).ok);

    const first = orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(1) });
    assert.ok(first.ok && first.dispatchedTurnId === first.turn.turnId);
    const second = orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(2) });
    assert.ok(second.ok && second.dispatchedTurnId === null, "queued behind the running turn");

    assert.ok(
      orchestrator.fenceOutput({ sessionKey: SESSION, turnId: first.turn.turnId, epoch: 1, kind: "tts_queue", ttsItemId: "tts_item0000001" }).ok,
    );
    assert.ok(orchestrator.cancelTurn({ sessionKey: SESSION, turnId: first.turn.turnId, reason: "barge_in" }).ok);
    assert.equal(orchestrator.currentEpoch(SESSION), 2);
    assert.ok(orchestrator.confirmStop({ sessionKey: SESSION, turnId: first.turn.turnId }).ok);
    assert.ok(orchestrator.confirmStop({ sessionKey: SESSION, turnId: second.turn.turnId }).ok);

    const drained = orchestrator.drainTts(SESSION);
    assert.ok(drained.ok && drained.droppedStale === 1 && drained.deliverable.length === 0);

    // The audit ring stays structural through the SQLite-backed path.
    for (const entry of orchestrator.auditSnapshot()) {
      assert.ok(["seq", "atMs", "action", "sessionKey", "turnId", "traceId", "epoch", "resultCode", "finalState", "count"].every((key) => key in entry));
    }
  } finally {
    store.close();
  }
});
