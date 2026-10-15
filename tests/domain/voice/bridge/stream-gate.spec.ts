import assert from "node:assert/strict";
import test from "node:test";

/**
 * R1-V2 stream gate tests (issue #29 实现范围 4; VOICE_RUNTIME §6):
 * live deltas are re-fenced against the trusted epoch, strictly
 * order-checked per attempt, buffered into short sentences, and only
 * sentences that pass the REAL R1-15 children Output Gate reach the TTS
 * fence. Late deltas of a fenced epoch never produce TTS.
 */

import { createVoiceTurnOrchestrator } from "../../../../lib/domain/voice/orchestrator.ts";
import {
  BRIDGE_MAX_SENTENCE_CHARS,
  createBridgeStreamGate,
  type StreamGateDeltaResult,
} from "../../../../lib/domain/voice/bridge/stream-gate.ts";
import type { BridgeAssistantDeltaPayload } from "../../../../lib/domain/voice/bridge/ipc-contract.ts";
import { createVirtualClock } from "../helpers.ts";
const SESSION = "ses_gate0001";
const CONVERSATION = "conv_gate0001";
const OWNER = "act_owner0001";

interface Fixture {
  readonly orchestrator: ReturnType<typeof createVoiceTurnOrchestrator>;
  readonly clock: () => number;
  readonly turnIds: string[];
}

function createFixture(): Fixture {
  const clockHandle = createVirtualClock();
  const turnIds: string[] = [];
  let turnSeq = 0;
  const orchestrator = createVoiceTurnOrchestrator({
    clock: clockHandle.now,
    turnIdFactory: () => {
      turnSeq += 1;
      const id = `trn_gate${turnSeq.toString().padStart(7, "0")}`;
      turnIds.push(id);
      return id;
    },
  });
  return { orchestrator, clock: clockHandle.now, turnIds };
}

function startRunningTurn(fixture: Fixture, fingerprint = "0123456789abcdef"): string {
  const opened = fixture.orchestrator.openSession({
    sessionKey: SESSION,
    conversationId: CONVERSATION,
    ownerActorId: OWNER,
  });
  assert.ok(opened.ok);
  const received = fixture.orchestrator.receivePrompt({
    sessionKey: SESSION,
    traceId: "trc_gate0001",
    idempotencyKey: `idem-${fixture.turnIds.length.toString().padStart(6, "0")}-k`,
    fingerprint,
  });
  assert.ok(received.ok);
  const turnId = received.turn.turnId;
  assert.equal(received.dispatchedTurnId, turnId, "an idle session dispatches immediately");
  return turnId;
}

function delta(fixture: Fixture, turnId: string, overrides: Partial<BridgeAssistantDeltaPayload> = {}): BridgeAssistantDeltaPayload {
  const epoch = fixture.orchestrator.currentEpoch(SESSION) ?? 1;
  const attemptId = overrides.attemptId ?? "att_gate0001_0001";
  return {
    sessionKey: SESSION,
    turnId,
    epoch,
    attemptId,
    stepId: `step_${attemptId.slice(4)}`,
    index: 0,
    text: "好的。",
    ...overrides,
  };
}

test("a running turn's text deltas assemble sentences and admit TTS through the real gate", () => {
  const fixture = createFixture();
  const turnId = startRunningTurn(fixture);
  const gate = createBridgeStreamGate({ orchestrator: fixture.orchestrator, clock: fixture.clock });

  const r1 = gate.handleDelta(delta(fixture, turnId, { index: 0, text: "我们一起" }));
  assert.ok(r1.ok && r1.ttsAdmitted === 0, "partial text stays buffered");
  const r2 = gate.handleDelta(delta(fixture, turnId, { index: 1, text: "看看这道题。" }));
  assert.ok(r2.ok && r2.ttsAdmitted === 1, "a complete sentence is gated and admitted");

  const queue = fixture.orchestrator.drainTts(SESSION);
  assert.ok(queue.ok && queue.deliverable.length === 1);
  assert.equal(queue.deliverable[0]?.turnId, turnId);
  assert.equal(queue.deliverable[0]?.epoch, fixture.orchestrator.currentEpoch(SESSION));

  const metrics = gate.metricsSnapshot();
  assert.equal(metrics.ttsAdmissions, 1);
  assert.equal(metrics.firstSafeText.count, 1);
  assert.ok(Number.isFinite(metrics.firstSafeText.maxMs));
});

test("deltas of a fenced epoch are rejected and never reach TTS (late-delta fence)", () => {
  const fixture = createFixture();
  const turnId = startRunningTurn(fixture);
  const gate = createBridgeStreamGate({ orchestrator: fixture.orchestrator, clock: fixture.clock });

  // One delta in flight before the interruption.
  const pre = gate.handleDelta(delta(fixture, turnId, { index: 0, text: "我们先" }));
  assert.ok(pre.ok);

  // The wire epoch is the one bound at dispatch (the turn's birth epoch).
  const boundEpoch = fixture.orchestrator.describeTurn(SESSION, turnId)?.epoch ?? 1;

  // Barge-in: the trusted epoch bumps atomically.
  const cancelled = fixture.orchestrator.cancelTurn({ sessionKey: SESSION, turnId, reason: "barge_in" });
  assert.ok(cancelled.ok);
  assert.ok((fixture.orchestrator.currentEpoch(SESSION) ?? 0) > boundEpoch, "the fence bumped the epoch");

  const late = gate.handleDelta(delta(fixture, turnId, { epoch: boundEpoch, index: 1, text: "来玩游戏。" }));
  assert.equal(late.ok, false);
  assert.equal(late.code, "stale_turn_rejected");
  assert.equal(gate.metricsSnapshot().deltasFenced, 1);

  // A late emitter presenting the NEW epoch is a forge attempt.
  const forged = gate.handleDelta(
    delta(fixture, turnId, { epoch: fixture.orchestrator.currentEpoch(SESSION) ?? 2, index: 2, text: "来玩游戏。" }),
  );
  assert.equal(forged.code, "epoch_forged");

  const queue = fixture.orchestrator.drainTts(SESSION);
  assert.ok(queue.ok);
  assert.equal(queue.deliverable.length, 0, "nothing may be delivered for the fenced turn");
});

test("index ordering is strictly monotonic; attempt mismatches rejected", () => {
  const fixture = createFixture();
  const turnId = startRunningTurn(fixture);
  const gate = createBridgeStreamGate({ orchestrator: fixture.orchestrator, clock: fixture.clock });

  // First text delta binds the attempt; the index may start above 0
  // because the Bridge drops non-text chunks upstream (gaps tolerated).
  assert.ok(gate.handleDelta(delta(fixture, turnId, { index: 2, text: "一" })).ok);
  // Replays and backwards reordering are rejected.
  assert.equal(gate.handleDelta(delta(fixture, turnId, { index: 2, text: "重放" })).ok, false);
  assert.equal(gate.handleDelta(delta(fixture, turnId, { index: 1, text: "倒序" })).ok, false);
  // A forward jump (gap from a dropped non-text chunk) is tolerated.
  assert.ok(gate.handleDelta(delta(fixture, turnId, { index: 5, text: "二。" })).ok);

  assert.equal(
    gate.handleDelta(delta(fixture, turnId, { index: 6, attemptId: "att_other" })).ok,
    false,
    "a different attempt id cannot hijack the buffer",
  );
});

test("unknown turns and forged epochs fail closed", () => {
  const fixture = createFixture();
  const turnId = startRunningTurn(fixture);
  const gate = createBridgeStreamGate({ orchestrator: fixture.orchestrator, clock: fixture.clock });

  const unknownTurn = gate.handleDelta(delta(fixture, turnId, { turnId: "trn_unknown01", index: 0 }));
  assert.equal(unknownTurn.ok, false);

  const forged = gate.handleDelta(delta(fixture, turnId, { epoch: (fixture.orchestrator.currentEpoch(SESSION) ?? 1) + 5 }));
  assert.equal(forged.ok, false);
});

test("a sentence failing the REAL children output gate is never queued for TTS", () => {
  const fixture = createFixture();
  const turnId = startRunningTurn(fixture);
  const gate = createBridgeStreamGate({ orchestrator: fixture.orchestrator, clock: fixture.clock });

  // Synthetic secrecy-pressure sample (the R1-15 output.gate rule corpus).
  const blocked = gate.handleDelta(
    delta(fixture, turnId, { index: 0, text: "这是我们之间的小秘密，不要告诉爸爸妈妈。" }),
  );
  assert.ok(blocked.ok, "the delta itself was in-epoch and buffered");
  assert.equal(blocked.ttsBlocked, 1, "the sentence was blocked by the output gate");
  assert.equal(blocked.ttsAdmitted, 0, "nothing reached TTS");

  const queue = fixture.orchestrator.drainTts(SESSION);
  assert.ok(queue.ok && queue.deliverable.length === 0);

  // The next safe sentence still flows: blocking is per sentence, not per stream.
  const safe = gate.handleDelta(delta(fixture, turnId, { index: 1, text: "我们继续看下一题。" }));
  assert.ok(safe.ok && safe.ttsAdmitted === 1);
});

test("oversized partial buffers hit backpressure and drop the volatile buffer", () => {
  const fixture = createFixture();
  const turnId = startRunningTurn(fixture);
  const gate = createBridgeStreamGate({
    orchestrator: fixture.orchestrator,
    clock: fixture.clock,
    maxSentenceChars: 8,
    maxBufferedChars: 16,
  });

  const first = gate.handleDelta(delta(fixture, turnId, { index: 0, text: "没有标点的很长片段一" }));
  assert.ok(first.ok, "a delta at/below the cap is force-split and buffered");
  // One forced 8-char sentence admitted by the first delta; tail stays.
  assert.equal(first.ttsAdmitted, 1);
  // A single delta large enough to blow the whole cap is rejected.
  const second = gate.handleDelta(delta(fixture, turnId, { index: 1, text: "很".repeat(30) }));
  assert.equal(second.ok, false);
  assert.equal(second.code, "buffer_overflow");
});

test("flushSession releases trailing partial text through the same gate", () => {
  const fixture = createFixture();
  const turnId = startRunningTurn(fixture);
  const gate = createBridgeStreamGate({ orchestrator: fixture.orchestrator, clock: fixture.clock });

  assert.ok(gate.handleDelta(delta(fixture, turnId, { index: 0, text: "最后一句" })).ok);
  const flushed = gate.flushSession(SESSION);
  assert.equal(flushed.ttsAdmitted, 1);
  assert.equal(gate.flushSession(SESSION).ttsAdmitted, 0, "flush is idempotent once empty");
});

test("long fragments are force-split at the sentence-char cap", () => {
  const fixture = createFixture();
  const turnId = startRunningTurn(fixture);
  const gate = createBridgeStreamGate({ orchestrator: fixture.orchestrator, clock: fixture.clock });
  assert.ok(gate.handleDelta(delta(fixture, turnId, { index: 0, text: "a".repeat(BRIDGE_MAX_SENTENCE_CHARS + 4) })).ok);
  // One forced sentence (cap) admitted; the 4-char tail stays buffered.
  const metrics = gate.metricsSnapshot();
  assert.equal(metrics.ttsAdmissions, 1);
});

test("clearTurn drops the volatile buffer for a settled turn", () => {
  const fixture = createFixture();
  const turnId = startRunningTurn(fixture);
  const gate = createBridgeStreamGate({ orchestrator: fixture.orchestrator, clock: fixture.clock });
  assert.ok(gate.handleDelta(delta(fixture, turnId, { index: 0, text: "未完的片段" })).ok);
  gate.clearTurn(SESSION, turnId);
  assert.equal(gate.flushSession(SESSION).ttsAdmitted, 0);
});
