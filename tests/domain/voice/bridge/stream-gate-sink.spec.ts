import assert from "node:assert/strict";
import test from "node:test";

/**
 * E2E-07 (issue #57) — stream-gate sentence delivery sink: the wired
 * bridge transport receives ONLY Output-Gate-admitted, tts_queue-fenced
 * sentences, keyed by the exact TTS item id queued in the trusted store.
 * Without the sink the v1.2 synthetic contract is byte-identical.
 */

import { createVoiceTurnOrchestrator } from "../../../../lib/domain/voice/orchestrator.ts";
import {
  createBridgeStreamGate,
  type AdmittedSentenceEntry,
} from "../../../../lib/domain/voice/bridge/stream-gate.ts";
import type { BridgeAssistantDeltaPayload } from "../../../../lib/domain/voice/bridge/ipc-contract.ts";
import { createVirtualClock } from "../helpers.ts";

const SESSION = "ses_gwsink01";
const CONVERSATION = "conv_gwsink01";
const OWNER = "act_owner0001";

interface Fixture {
  readonly orchestrator: ReturnType<typeof createVoiceTurnOrchestrator>;
  readonly clock: () => number;
}

function createFixture(): Fixture {
  const clockHandle = createVirtualClock();
  let turnSeq = 0;
  const orchestrator = createVoiceTurnOrchestrator({
    clock: clockHandle.now,
    turnIdFactory: () => {
      turnSeq += 1;
      return `trn_gwsink${turnSeq.toString().padStart(7, "0")}`;
    },
  });
  return { orchestrator, clock: clockHandle.now };
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
    traceId: "trc_gwsink0001",
    idempotencyKey: `idem-gwsink-${fixture.orchestrator.listTurns(SESSION).length.toString().padStart(6, "0")}`,
    fingerprint,
  });
  assert.ok(received.ok);
  return received.turn.turnId;
}

function delta(fixture: Fixture, turnId: string, overrides: Partial<BridgeAssistantDeltaPayload> = {}): BridgeAssistantDeltaPayload {
  const epoch = fixture.orchestrator.currentEpoch(SESSION) ?? 1;
  return {
    sessionKey: SESSION,
    turnId,
    epoch,
    attemptId: "att_gwsink01_0001",
    stepId: "step_gwsink01_0001",
    index: 0,
    text: "好的。",
    ...overrides,
  };
}

test("admitted sentences reach the sink with the exact queued item id (wired mode)", () => {
  const fixture = createFixture();
  const turnId = startRunningTurn(fixture);
  const delivered: AdmittedSentenceEntry[] = [];
  const gate = createBridgeStreamGate({
    orchestrator: fixture.orchestrator,
    clock: fixture.clock,
    onAdmittedSentence: (entry) => delivered.push(entry),
  });

  const r1 = gate.handleDelta(delta(fixture, turnId, { index: 0, text: "我们一起看看这道题。" }));
  assert.ok(r1.ok && r1.ttsAdmitted === 1);

  const queue = fixture.orchestrator.drainTts(SESSION);
  assert.ok(queue.ok && queue.deliverable.length === 1);

  assert.equal(delivered.length, 1);
  const entry = delivered[0] as AdmittedSentenceEntry;
  assert.equal(entry.sessionKey, SESSION);
  assert.equal(entry.turnId, turnId);
  assert.equal(entry.epoch, queue.deliverable[0]?.epoch);
  // The sink's itemId IS the trusted store's queued item id — the wired
  // audio accounting correlates on it.
  assert.equal(entry.itemId, queue.deliverable[0]?.itemId);
  assert.equal(entry.text, "我们一起看看这道题。");
});

test("output-gate-blocked and fenced sentences never reach the sink", () => {
  const fixture = createFixture();
  const turnId = startRunningTurn(fixture);
  const delivered: AdmittedSentenceEntry[] = [];
  const gate = createBridgeStreamGate({
    orchestrator: fixture.orchestrator,
    clock: fixture.clock,
    onAdmittedSentence: (entry) => delivered.push(entry),
  });

  // A blocked sentence (the default R1-15 gate blocks secrecy pressure):
  const blocked = gate.handleDelta(delta(fixture, turnId, { index: 0, text: "这是我们之间的小秘密，不要告诉妈妈。" }));
  assert.ok(blocked.ok && blocked.ttsAdmitted === 0 && blocked.ttsBlocked === 1);

  // A stale-epoch sentence after a barge-in:
  const boundEpoch = fixture.orchestrator.describeTurn(SESSION, turnId)?.epoch ?? 1;
  const cancelled = fixture.orchestrator.cancelTurn({ sessionKey: SESSION, turnId, reason: "barge_in" });
  assert.ok(cancelled.ok);
  const stale = gate.handleDelta(delta(fixture, turnId, { epoch: boundEpoch, index: 1, text: "迟到的句子。" }));
  assert.equal(stale.ok, false);

  assert.equal(delivered.length, 0, "neither a blocked nor a fenced sentence crosses the sink");
});

test("a throwing sink is counted, never raised, and the stream continues", () => {
  const fixture = createFixture();
  const turnId = startRunningTurn(fixture);
  let calls = 0;
  const gate = createBridgeStreamGate({
    orchestrator: fixture.orchestrator,
    clock: fixture.clock,
    onAdmittedSentence: () => {
      calls += 1;
      throw new Error("wiring fault");
    },
  });

  const r1 = gate.handleDelta(delta(fixture, turnId, { index: 0, text: "第一句。" }));
  assert.ok(r1.ok && r1.ttsAdmitted === 1, "the admission itself still succeeded");
  const r2 = gate.handleDelta(delta(fixture, turnId, { index: 1, text: "第二句。" }));
  assert.ok(r2.ok && r2.ttsAdmitted === 1, "the stream survives the sink fault");

  assert.equal(calls, 2);
  assert.equal(gate.metricsSnapshot().sentenceDeliveryFailures, 2);
  // The content-free TTS slots stay queued (the turn still settles).
  const queue = fixture.orchestrator.drainTts(SESSION);
  assert.ok(queue.ok && queue.deliverable.length === 2);
});

test("without the sink the synthetic contract is unchanged (text dropped after gating)", () => {
  const fixture = createFixture();
  const turnId = startRunningTurn(fixture);
  const gate = createBridgeStreamGate({ orchestrator: fixture.orchestrator, clock: fixture.clock });

  const r1 = gate.handleDelta(delta(fixture, turnId, { index: 0, text: "我们开始吧。" }));
  assert.ok(r1.ok && r1.ttsAdmitted === 1);
  const metrics = gate.metricsSnapshot();
  assert.equal(metrics.sentenceDeliveryFailures, 0);
  // Pre-existing behavior: admission counts, no delivery surface exists.
  const queue = fixture.orchestrator.drainTts(SESSION);
  assert.ok(queue.ok && queue.deliverable.length === 1);
});
