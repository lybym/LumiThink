/**
 * R1-V1 acceptance race harness — 100+ deterministic interruption races
 * (issue #28 验收: 合成 100 次以上乱序 ASR、重复 abort/cancel、迟到 Delta、
 * TTS 排队、记忆事务竞态：旧轮文本/TTS/失效写入 0、死锁 0；确定性竞态调度
 * 和随机种子重放，报告可审计).
 *
 * Every scenario is a PURE function of its seed:
 *  - seeded PRNG (mulberry32) drives the op schedule;
 *  - a virtual clock advances exactly 1 ms per call;
 *  - ids and fingerprints are deterministic;
 *  - synthetic payloads exist only as hex digests.
 *
 * Invariants checked after EVERY operation (per session):
 *  1. at most one RUNNING turn, and its epoch is the CURRENT trusted epoch;
 *  2. the trusted epoch is a positive integer and never decreases;
 *  3. every turn state is a registered state; settledAtMs iff terminal;
 *  4. an ALLOWED output fence / COMMITTED write happened only for a
 *     RUNNING turn at the then-current epoch (old text/TTS/memory = 0);
 *  5. TTS drains deliver only current-epoch items (stale audio = 0);
 *  6. cross-session forgeries are always rejected;
 *  7. liveness: every non-terminal turn can be driven to a terminal state
 *     in a bounded number of steps (no deadlock).
 *
 * The same seed MUST reproduce the exact audit timeline and final state
 * (随机种子重放) — asserted by a byte-stable canonical fingerprint.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createVoiceTurnOrchestrator, type VoiceTurnOrchestrator } from "../../../lib/domain/voice/orchestrator.ts";
import { createInMemoryVoiceFenceStore } from "../../../lib/domain/voice/store.ts";
import { VOICE_TERMINAL_TURN_STATES, VOICE_TURN_STATES } from "../../../lib/domain/voice/schema.ts";
import { canonicalJson } from "../../../lib/domain/contract/core.ts";
import {
  auditFingerprint,
  createTurnIdFactory,
  createVirtualClock,
  idempotencyKey,
  mulberry32,
  pick,
  randomInt,
  syntheticFingerprint,
  testActorId,
  testConversationId,
  testSessionKey,
  testTraceId,
} from "./helpers.ts";

const ITERATIONS = 120;
const OPS_PER_ITERATION = 40;

// ---------------------------------------------------------------------------
// Counters (the auditable report of what the fences actually blocked)
// ---------------------------------------------------------------------------

interface RaceCounters {
  prompts: number;
  cancels: number;
  cancelAccepted: number;
  cancelAlreadyActive: number;
  cancelTerminal: number;
  cancelStale: number;
  cancelCrossSession: number;
  outputFenceAttempts: number;
  outputFenceAllowed: number;
  outputFenceStale: number;
  outputFenceForged: number;
  outputFenceOtherRejected: number;
  writeAttempts: number;
  writeCommitted: number;
  writeReplayed: number;
  writeStale: number;
  writeForged: number;
  writeConflict: number;
  writeOtherRejected: number;
  crossSessionRejections: number;
  drains: number;
  droppedStaleTts: number;
  restarts: number;
}

function freshCounters(): RaceCounters {
  return {
    prompts: 0,
    cancels: 0,
    cancelAccepted: 0,
    cancelAlreadyActive: 0,
    cancelTerminal: 0,
    cancelStale: 0,
    cancelCrossSession: 0,
    outputFenceAttempts: 0,
    outputFenceAllowed: 0,
    outputFenceStale: 0,
    outputFenceForged: 0,
    outputFenceOtherRejected: 0,
    writeAttempts: 0,
    writeCommitted: 0,
    writeReplayed: 0,
    writeStale: 0,
    writeForged: 0,
    writeConflict: 0,
    writeOtherRejected: 0,
    crossSessionRejections: 0,
    drains: 0,
    droppedStaleTts: 0,
    restarts: 0,
  };
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

interface ScenarioState {
  readonly seed: number;
  orchestrator: VoiceTurnOrchestrator;
  readonly sessions: [string, string];
  currentSession: 0 | 1;
  readonly idemPool: { key: string; fingerprint: string; sessionKey: string }[];
  idemCounter: number;
  /** ONE turn-id factory for the whole scenario (ids stay globally unique across restarts). */
  readonly turnIds: () => string;
}

/** Post-op invariants; throws on ANY violation (fail the run loudly). */
function checkInvariants(
  orchestrator: VoiceTurnOrchestrator,
  state: ScenarioState,
): void {
  for (const sessionKey of state.sessions) {
    const epoch = orchestrator.currentEpoch(sessionKey);
    assert.ok(epoch !== null && Number.isInteger(epoch) && epoch >= 1);
    let running = 0;
    for (const turn of orchestrator.listTurns(sessionKey)) {
      assert.ok((VOICE_TURN_STATES as readonly string[]).includes(turn.state), `illegal state ${turn.state}`);
      const isTerminal = (VOICE_TERMINAL_TURN_STATES as readonly string[]).includes(turn.state);
      assert.equal(turn.settledAtMs !== null, isTerminal, `settledAtMs/state mismatch for ${turn.turnId}`);
      if (turn.state === "RUNNING") {
        running += 1;
        assert.equal(
          turn.epoch,
          epoch,
          `RUNNING turn ${turn.turnId} survives at a non-current epoch (stale turn running!)`,
        );
      }
    }
    assert.ok(running <= 1, "at most one RUNNING turn per session (single Agent Loop)");
  }
}

/** Drive every remaining non-terminal turn into a terminal state (liveness). */
function assertDrainableToTerminal(orchestrator: VoiceTurnOrchestrator, state: ScenarioState): void {
  for (let step = 0; step < 200; step += 1) {
    let pending = 0;
    for (const sessionKey of state.sessions) {
      orchestrator.pump(sessionKey);
      orchestrator.sweepTimeouts({ sessionKey, budgetMs: 0 });
      for (const turn of orchestrator.listTurns(sessionKey)) {
        if ((VOICE_TERMINAL_TURN_STATES as readonly string[]).includes(turn.state)) {
          continue;
        }
        pending += 1;
        const cancelled = orchestrator.cancelTurn({ sessionKey, turnId: turn.turnId, reason: "system_policy" });
        if (cancelled.ok) {
          continue;
        }
        if (cancelled.code === "cancel_already_active") {
          assert.ok(orchestrator.confirmStop({ sessionKey, turnId: turn.turnId }).ok);
        }
      }
      orchestrator.sweepTimeouts({ sessionKey, budgetMs: 0 });
    }
    if (pending === 0) {
      return;
    }
  }
  assert.fail("deadlock: non-terminal turns could not be drained to a terminal state");
}

/** One deterministic seeded scenario: ops + invariants + restart + drain. */
function runScenario(seed: number): { counters: RaceCounters; audit: string; finalState: string } {
  const rng = mulberry32(seed);
  const clock = createVirtualClock(1_000 + seed);
  const turnIds = createTurnIdFactory();
  const state: ScenarioState = {
    seed,
    orchestrator: createVoiceTurnOrchestrator({
      store: createInMemoryVoiceFenceStore(),
      clock: clock.now,
      turnIdFactory: turnIds,
    }),
    sessions: [testSessionKey(seed * 10 + 1), testSessionKey(seed * 10 + 2)],
    currentSession: 0,
    idemPool: [],
    idemCounter: 0,
    turnIds,
  };
  const counters = freshCounters();

  const open = (index: 0 | 1): void => {
    assert.ok(
      state.orchestrator
        .openSession({
          sessionKey: state.sessions[index],
          conversationId: testConversationId(seed * 10 + index + 1),
          ownerActorId: testActorId(seed * 10 + index + 1),
        })
        .ok,
    );
  };
  open(0);
  open(1);

  const turnsOf = (sessionIndex: 0 | 1): string[] =>
    state.orchestrator.listTurns(state.sessions[sessionIndex]).map((turn) => turn.turnId);

  const claimedEpoch = (sessionIndex: 0 | 1): number => {
    const current = state.orchestrator.currentEpoch(state.sessions[sessionIndex]) ?? 1;
    const roll = randomInt(rng, 10);
    if (roll < 6) {
      return current;
    }
    if (roll < 8) {
      return current + 1; // forged future
    }
    return Math.max(1, current - 1); // stale
  };

  const nextIdempotency = (sessionKey: string): { key: string; fingerprint: string; mode: "fresh" | "replay" | "conflict" } => {
    const roll = randomInt(rng, 4);
    const sameSessionEntries = state.idemPool.filter((entry) => entry.sessionKey === sessionKey);
    if (sameSessionEntries.length > 0 && roll < 2) {
      const stored = pick(rng, sameSessionEntries);
      if (roll === 0) {
        return { key: stored.key, fingerprint: stored.fingerprint, mode: "replay" };
      }
      return {
        key: stored.key,
        fingerprint: syntheticFingerprint({ variant: rng() }),
        mode: "conflict",
      };
    }
    state.idemCounter += 1;
    // NOTE: a fresh key only ENTERS the pool once its operation actually
    // landed in THIS session (the caller pushes it) — a rejected op leaves
    // no ledger entry, so reusing its key must not be asserted as a
    // replay/conflict.
    return {
      key: idempotencyKey(state.idemCounter),
      fingerprint: syntheticFingerprint({ payload: rng(), seed }),
      mode: "fresh",
    };
  };

  const rememberIdempotency = (
    idem: { key: string; fingerprint: string; mode: string } | null,
    landed: boolean,
    sessionKey: string,
  ): void => {
    if (idem !== null && idem.mode === "fresh" && landed) {
      state.idemPool.push({ key: idem.key, fingerprint: idem.fingerprint, sessionKey });
    }
  };

  for (let op = 0; op < OPS_PER_ITERATION; op += 1) {
    state.currentSession = randomInt(rng, 2) as 0 | 1;
    const sessionKey = state.sessions[state.currentSession];
    const otherSession = state.sessions[state.currentSession === 0 ? 1 : 0];
    const roll = randomInt(rng, 100);
    const turnIds = turnsOf(state.currentSession);
    const turnId = turnIds.length > 0 ? pick(rng, turnIds) : null;

    if (roll < 18) {
      // --- New ASR arrives (possibly while the old task still runs). ---
      counters.prompts += 1;
      const idem = roll % 2 === 0 ? nextIdempotency(sessionKey) : null;
      const received = state.orchestrator.receivePrompt({
        sessionKey,
        traceId: testTraceId(op),
        idempotencyKey: idem?.key ?? undefined,
        fingerprint: idem?.fingerprint ?? undefined,
      });
      if (idem === null) {
        assert.ok(received.ok);
      } else if (idem.mode === "replay") {
        // Same session + same key + same fingerprint: the ORIGINAL turn
        // comes back and NOTHING re-executes.
        assert.ok(received.ok && received.replayed);
        rememberIdempotency(idem, false, sessionKey);
      } else if (idem.mode === "conflict") {
        assert.deepEqual(received, { ok: false, code: "idempotency_conflict" }, `conflict prompt produced ${JSON.stringify(received)}`);
        rememberIdempotency(idem, false, sessionKey);
      } else {
        assert.ok(received.ok && !received.replayed);
        rememberIdempotency(idem, received.ok && !received.replayed, sessionKey);
      }
    } else if (roll < 30) {
      // --- Effective interruption on a possibly-random turn. ---
      counters.cancels += 1;
      if (turnId === null) {
        continue;
      }
      const cancelSession = roll % 11 === 0 ? otherSession : sessionKey;
      const result = state.orchestrator.cancelTurn({
        sessionKey: cancelSession,
        turnId,
        reason: pick(rng, ["barge_in", "device_abort", "system_policy"] as const),
      });
      if (result.ok) {
        counters.cancelAccepted += 1;
      } else if (result.code === "cancel_already_active") {
        counters.cancelAlreadyActive += 1;
      } else if (result.code === "turn_terminal") {
        counters.cancelTerminal += 1;
      } else if (result.code === "stale_turn_rejected") {
        counters.cancelStale += 1;
      } else if (result.code === "cross_session_rejected") {
        counters.cancelCrossSession += 1;
        counters.crossSessionRejections += 1;
      } else {
        assert.equal(result.code, "turn_unknown");
      }
    } else if (roll < 38) {
      // --- Stop confirmation (Bridge whenIdle analog). ---
      if (turnId !== null) {
        state.orchestrator.confirmStop({ sessionKey, turnId });
      }
    } else if (roll < 42) {
      // --- Settle attempts (mostly rejections; never a state corruption). ---
      if (turnId !== null) {
        state.orchestrator.settleTurn({
          sessionKey,
          turnId,
          outcome: pick(rng, ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELLED"] as const),
        });
      }
    } else if (roll < 54) {
      // --- Output fences: text delta / TTS queue / audio send. ---
      counters.outputFenceAttempts += 1;
      if (turnId === null) {
        continue;
      }
      const fenceSession = roll % 13 === 0 ? otherSession : sessionKey;
      const fenced = state.orchestrator.fenceOutput({
        sessionKey: fenceSession,
        turnId,
        epoch: claimedEpoch(state.currentSession),
        kind: pick(rng, ["text_delta", "tts_queue", "audio_send"] as const),
        ttsItemId: `tts_item${(seed * 1000 + op).toString().padStart(8, "0")}`,
      });
      if (fenced.ok) {
        counters.outputFenceAllowed += 1;
        // INVARIANT 4: an allowed emission happened only for a RUNNING
        // turn at the CURRENT epoch — old text/TTS/audio = 0.
        const turn = state.orchestrator.describeTurn(fenceSession, turnId);
        assert.ok(turn !== null);
        assert.equal(turn.state, "RUNNING");
        assert.equal(turn.epoch, state.orchestrator.currentEpoch(fenceSession));
        assert.equal(
          fenced.ttsItemId === null ? true : state.orchestrator.ttsQueueDepth(fenceSession) >= 1,
          true,
        );
      } else if (fenced.code === "stale_turn_rejected") {
        counters.outputFenceStale += 1;
      } else if (fenced.code === "epoch_forged") {
        counters.outputFenceForged += 1;
      } else if (fenced.code === "cross_session_rejected") {
        counters.crossSessionRejections += 1;
      } else {
        counters.outputFenceOtherRejected += 1;
        assert.ok(
          ["turn_terminal", "turn_state_transition_illegal", "turn_unknown"].includes(fenced.code),
          `unexpected fence code ${fenced.code}`,
        );
      }
    } else if (roll < 70) {
      // --- Memory / domain-write transaction races. ---
      counters.writeAttempts += 1;
      if (turnId === null) {
        continue;
      }
      const writeSession = roll % 17 === 0 ? otherSession : sessionKey;
      const idem = nextIdempotency(writeSession);
      const written = state.orchestrator.fenceWrite({
        sessionKey: writeSession,
        turnId,
        epoch: claimedEpoch(state.currentSession),
        kind: pick(rng, ["candidate_memory", "domain_event"] as const),
        idempotencyKey: idem.key,
        fingerprint: idem.fingerprint,
      });
      if (written.ok) {
        if (written.replayed) {
          counters.writeReplayed += 1;
          rememberIdempotency(idem, false, sessionKey);
        } else {
          counters.writeCommitted += 1;
          rememberIdempotency(idem, true, writeSession);
          // INVARIANT 4: a committed write happened only for a RUNNING
          // turn at the CURRENT epoch — stale domain writes = 0.
          const turn = state.orchestrator.describeTurn(writeSession, turnId);
          assert.ok(turn !== null);
          assert.equal(turn.state, "RUNNING");
          assert.equal(turn.epoch, state.orchestrator.currentEpoch(writeSession));
          assert.equal(written.epoch, state.orchestrator.currentEpoch(writeSession));
        }
      } else if (written.code === "stale_turn_rejected") {
        counters.writeStale += 1;
        rememberIdempotency(idem, false, sessionKey);
      } else if (written.code === "epoch_forged") {
        counters.writeForged += 1;
        rememberIdempotency(idem, false, sessionKey);
      } else if (written.code === "idempotency_conflict") {
        counters.writeConflict += 1;
        rememberIdempotency(idem, false, sessionKey);
      } else if (written.code === "cross_session_rejected") {
        counters.crossSessionRejections += 1;
        rememberIdempotency(idem, false, sessionKey);
      } else {
        counters.writeOtherRejected += 1;
        assert.ok(
          ["turn_terminal", "turn_state_transition_illegal", "turn_unknown"].includes(written.code),
          `unexpected write code ${written.code}`,
        );
      }
    } else if (roll < 76) {
      // --- TTS send-side second fence. ---
      counters.drains += 1;
      const drained = state.orchestrator.drainTts(sessionKey);
      assert.ok(drained.ok);
      counters.droppedStaleTts += drained.droppedStale;
      // INVARIANT 5: every delivered item is at the CURRENT epoch.
      for (const item of drained.deliverable) {
        assert.equal(item.epoch, state.orchestrator.currentEpoch(sessionKey));
      }
      assert.equal(state.orchestrator.ttsQueueDepth(sessionKey), 0);
    } else if (roll < 82) {
      // --- Timeout sweeps. ---
      state.orchestrator.sweepTimeouts({ sessionKey, budgetMs: randomInt(rng, 4) });
    } else if (roll < 88) {
      // --- Manual pump. ---
      state.orchestrator.pump(sessionKey);
    } else if (roll < 92) {
      // --- Process restart: export → restore → epoch stays monotonic. ---
      counters.restarts += 1;
      const beforeEpochs = state.sessions.map((key) => state.orchestrator.currentEpoch(key));
      const beforeTurns = state.sessions.map((key) =>
        state.orchestrator.listTurns(key).map((turn) => ({ id: turn.turnId, state: turn.state })),
      );
      const snapshot = JSON.parse(JSON.stringify(state.orchestrator.exportState()));
      const restoredStore = createInMemoryVoiceFenceStore();
      const restored = restoredStore.restoreState(snapshot);
      assert.ok(restored.restoredSessions >= 2, "the restart must preserve every session");
      state.orchestrator = createVoiceTurnOrchestrator({
        store: restoredStore,
        clock: clock.now,
        turnIdFactory: state.turnIds,
      });
      for (let i = 0; i < state.sessions.length; i += 1) {
        const sessionKey2 = state.sessions[i] as string;
        assert.equal(state.orchestrator.currentEpoch(sessionKey2), beforeEpochs[i], "restart must preserve the trusted epoch");
        const afterTurns = state.orchestrator.listTurns(sessionKey2);
        assert.equal(afterTurns.length, (beforeTurns[i] as { id: string; state: string }[]).length);
        for (const after of afterTurns) {
          const before = (beforeTurns[i] as { id: string; state: string }[]).find((t) => t.id === after.turnId);
          assert.equal(after.state, before?.state, "restart must not resurrect or mutate turn states");
        }
      }
    } else if (roll < 96) {
      // --- Ownership conflict: same key, different owner. ---
      const conflict = state.orchestrator.openSession({
        sessionKey,
        conversationId: testConversationId(999_999),
        ownerActorId: testActorId(999_999),
      });
      assert.deepEqual(conflict, { ok: false, code: "session_conflict" });
    } else {
      // --- Open a NEW bounded session (exercises cross-session isolation). ---
      const extraIndex = 100 + seed * 10 + randomInt(rng, 5);
      assert.ok(
        state.orchestrator
          .openSession({
            sessionKey: testSessionKey(extraIndex),
            conversationId: testConversationId(extraIndex),
            ownerActorId: testActorId(extraIndex),
          })
          .ok,
      );
    }

    checkInvariants(state.orchestrator, state);
  }

  assertDrainableToTerminal(state.orchestrator, state);
  checkInvariants(state.orchestrator, state);

  return {
    counters,
    audit: auditFingerprint(state.orchestrator.auditSnapshot()),
    finalState: canonicalJson(state.orchestrator.exportState()),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("100+ seeded interruption races: zero stale output, zero stale writes, zero deadlock", () => {
  const totals = freshCounters();
  for (let seed = 1; seed <= ITERATIONS; seed += 1) {
    const { counters } = runScenario(seed);
    totals.prompts += counters.prompts;
    totals.cancels += counters.cancels;
    totals.cancelAccepted += counters.cancelAccepted;
    totals.cancelAlreadyActive += counters.cancelAlreadyActive;
    totals.cancelTerminal += counters.cancelTerminal;
    totals.cancelStale += counters.cancelStale;
    totals.cancelCrossSession += counters.cancelCrossSession;
    totals.outputFenceAttempts += counters.outputFenceAttempts;
    totals.outputFenceAllowed += counters.outputFenceAllowed;
    totals.outputFenceStale += counters.outputFenceStale;
    totals.outputFenceForged += counters.outputFenceForged;
    totals.outputFenceOtherRejected += counters.outputFenceOtherRejected;
    totals.writeAttempts += counters.writeAttempts;
    totals.writeCommitted += counters.writeCommitted;
    totals.writeReplayed += counters.writeReplayed;
    totals.writeStale += counters.writeStale;
    totals.writeForged += counters.writeForged;
    totals.writeConflict += counters.writeConflict;
    totals.writeOtherRejected += counters.writeOtherRejected;
    totals.crossSessionRejections += counters.crossSessionRejections;
    totals.drains += counters.drains;
    totals.droppedStaleTts += counters.droppedStaleTts;
    totals.restarts += counters.restarts;
  }

  // The auditable report: what actually raced and what the fences blocked.
  const report = {
    iterations: ITERATIONS,
    opsPerIteration: OPS_PER_ITERATION,
    prompts: totals.prompts,
    cancelAttempts: totals.cancels,
    effectiveInterruptions: totals.cancelAccepted,
    duplicateCancelsBlocked: totals.cancelAlreadyActive,
    terminalCancelsBlocked: totals.cancelTerminal,
    staleCancelsBlocked: totals.cancelStale,
    crossSessionCancelsBlocked: totals.cancelCrossSession,
    outputFenceAttempts: totals.outputFenceAttempts,
    outputFenceAllowed: totals.outputFenceAllowed,
    lateOutputBlocked: totals.outputFenceStale + totals.outputFenceForged,
    writeAttempts: totals.writeAttempts,
    writesCommitted: totals.writeCommitted,
    writesReplayed: totals.writeReplayed,
    staleWritesBlocked: totals.writeStale,
    forgedWritesBlocked: totals.writeForged,
    idempotencyConflicts: totals.writeConflict,
    crossSessionRejections: totals.crossSessionRejections,
    ttsDrains: totals.drains,
    staleTtsDropped: totals.droppedStaleTts,
    restarts: totals.restarts,
  };
  console.log(`r1-v1 race report: ${JSON.stringify(report)}`);

  // The issue's bar: 100+ competitive interruptions, and the fences must
  // have actually FIRED during those races (never a vacuous pass).
  assert.ok(totals.cancels >= 100, `expected 100+ cancel attempts, got ${totals.cancels}`);
  assert.ok(totals.cancelAccepted >= 50, `expected 50+ effective interruptions, got ${totals.cancelAccepted}`);
  assert.ok(totals.outputFenceAttempts >= 100, `expected 100+ output fence attempts, got ${totals.outputFenceAttempts}`);
  assert.ok(totals.writeAttempts >= 100, `expected 100+ write attempts, got ${totals.writeAttempts}`);
  const blockedTotal =
    totals.cancelAlreadyActive +
    totals.cancelTerminal +
    totals.cancelStale +
    totals.cancelCrossSession +
    totals.outputFenceStale +
    totals.outputFenceForged +
    totals.writeStale +
    totals.writeForged +
    totals.writeConflict +
    totals.crossSessionRejections;
  assert.ok(blockedTotal >= 100, `expected 100+ fence rejections during races, got ${blockedTotal}`);
  assert.ok(totals.restarts >= 10, `expected 10+ restart cycles, got ${totals.restarts}`);
  assert.ok(totals.droppedStaleTts >= 1, "the TTS second fence must have dropped stale audio at least once");
});

test("the same seed replays the exact audit timeline and final state (随机种子重放)", () => {
  for (const seed of [1, 42, 77, 120]) {
    const first = runScenario(seed);
    const second = runScenario(seed);
    assert.equal(first.audit, second.audit, `seed ${seed}: the audit timeline must replay exactly`);
    assert.equal(first.finalState, second.finalState, `seed ${seed}: the final state must replay exactly`);
  }
});

test("distinct seeds produce distinct race histories (no accidental vacuity)", () => {
  const seedA = runScenario(11);
  const seedB = runScenario(12);
  assert.notEqual(seedA.audit, seedB.audit);
});

test("late-delta / duplicate-cancel / memory-race families each behave exactly as specified", () => {
  // Fixed micro-scenarios that pin the four failure families the issue
  // names, independent of the random schedule above.
  const clock = createVirtualClock();
  const orchestrator = createVoiceTurnOrchestrator({
    clock: clock.now,
    turnIdFactory: createTurnIdFactory(),
  });
  const sessionKey = testSessionKey(555_001);
  assert.ok(
    orchestrator.openSession({
      sessionKey,
      conversationId: testConversationId(555_001),
      ownerActorId: testActorId(555_001),
    }).ok,
  );

  // Out-of-order ASR: two prompts arrive while the first is RUNNING.
  const first = orchestrator.receivePrompt({ sessionKey, traceId: testTraceId(1) });
  const second = orchestrator.receivePrompt({ sessionKey, traceId: testTraceId(2) });
  const third = orchestrator.receivePrompt({ sessionKey, traceId: testTraceId(3) });
  assert.ok(first.ok && second.ok && third.ok);
  assert.equal(second.dispatchedTurnId, null);
  assert.equal(third.dispatchedTurnId, null);

  // Duplicate cancel + late cancel on the interrupted turn.
  const cancelled = orchestrator.cancelTurn({ sessionKey, turnId: first.turn.turnId, reason: "barge_in" });
  assert.ok(cancelled.ok && cancelled.epoch === 2);
  const duplicate = orchestrator.cancelTurn({ sessionKey, turnId: first.turn.turnId, reason: "barge_in" });
  assert.ok(!duplicate.ok && duplicate.code === "cancel_already_active");
  assert.ok(orchestrator.confirmStop({ sessionKey, turnId: first.turn.turnId }).ok);
  const afterStop = orchestrator.cancelTurn({ sessionKey, turnId: first.turn.turnId, reason: "barge_in" });
  assert.ok(!afterStop.ok && afterStop.code === "turn_terminal");

  // Late delta + stale write for the fenced epoch = rejected, never applied.
  const lateDelta = orchestrator.fenceOutput({ sessionKey, turnId: first.turn.turnId, epoch: 1, kind: "text_delta" });
  assert.ok(!lateDelta.ok && lateDelta.code === "stale_turn_rejected");
  const lateWrite = orchestrator.fenceWrite({
    sessionKey,
    turnId: first.turn.turnId,
    epoch: 1,
    kind: "candidate_memory",
    idempotencyKey: "idem-key-000001",
    fingerprint: syntheticFingerprint({ late: true }),
  });
  assert.ok(!lateWrite.ok && lateWrite.code === "stale_turn_rejected");

  // The queued old-epoch turns were fenced too; neither may run.
  assert.ok(orchestrator.confirmStop({ sessionKey, turnId: second.turn.turnId }).ok);
  assert.ok(orchestrator.confirmStop({ sessionKey, turnId: third.turn.turnId }).ok);

  // Memory transaction race at the NEW epoch: commit once, replay once,
  // conflict on a different fingerprint — exactly one commit lands.
  const fourth = orchestrator.receivePrompt({ sessionKey, traceId: testTraceId(4) });
  assert.ok(fourth.ok && fourth.dispatchedTurnId !== null);
  const fp = syntheticFingerprint({ memory: "synthetic candidate fact" });
  const commit = orchestrator.fenceWrite({
    sessionKey,
    turnId: fourth.turn.turnId,
    epoch: 2,
    kind: "candidate_memory",
    idempotencyKey: "idem-key-555001",
    fingerprint: fp,
  });
  assert.ok(commit.ok && !commit.replayed);
  const retry = orchestrator.fenceWrite({
    sessionKey,
    turnId: fourth.turn.turnId,
    epoch: 2,
    kind: "candidate_memory",
    idempotencyKey: "idem-key-555001",
    fingerprint: fp,
  });
  assert.ok(retry.ok && retry.replayed);
  const conflict = orchestrator.fenceWrite({
    sessionKey,
    turnId: fourth.turn.turnId,
    epoch: 2,
    kind: "candidate_memory",
    idempotencyKey: "idem-key-555001",
    fingerprint: syntheticFingerprint({ memory: "different fact" }),
  });
  assert.ok(!conflict.ok && conflict.code === "idempotency_conflict");

  // TTS queue race: queue at epoch 2, interrupt, drain → old audio = 0.
  assert.ok(
    orchestrator.fenceOutput({ sessionKey, turnId: fourth.turn.turnId, epoch: 2, kind: "tts_queue", ttsItemId: "tts_item5550001" }).ok,
  );
  assert.ok(orchestrator.cancelTurn({ sessionKey, turnId: fourth.turn.turnId, reason: "barge_in" }).ok);
  assert.ok(orchestrator.confirmStop({ sessionKey, turnId: fourth.turn.turnId }).ok);
  const drained = orchestrator.drainTts(sessionKey);
  assert.ok(drained.ok);
  assert.equal(drained.droppedStale, 1);
  assert.equal(drained.deliverable.length, 0);
});
