import assert from "node:assert/strict";
import test from "node:test";

/**
 * R1-V2 bridge service tests (issue #29 实现范围 1/2/5): exclusive
 * AgentHandle ownership, the five-command surface, transient-vs-durable
 * stream discipline, duplicate/stale cancel handling and worker
 * quarantine/recovery — against the synthetic mock runtime, in-process.
 */

import { createVoiceBridge, type VoiceBridgeService } from "../../../../lib/domain/voice/bridge/bridge.ts";
import { createMockCordisRuntime, type MockGenerationScript } from "../../../../lib/domain/voice/bridge/mock-cordis.ts";
import { canonicalBridgeProfile, validateBridgeProfile } from "../../../../lib/domain/voice/bridge/profile.ts";
import type { BridgeAgentHandle, BridgeAgentPort, BridgeDurableEvent, BridgeStreamEvent } from "../../../../lib/domain/voice/bridge/agent-port.ts";
import type { BridgeEventFrame } from "../../../../lib/domain/voice/bridge/ipc-contract.ts";
import { createVirtualClock } from "../helpers.ts";

const SESSION = "ses_bridge0001";
const CONVERSATION = "conv_bridge0001";
const OWNER = "act_owner0001";

/** Synthetic, child-safe generation script with interleaved tool/thinking. */
function scriptFor(_sessionKey: string, turnId: string): MockGenerationScript {
  const seq = turnId.endsWith("2") ? "二" : "一";
  return [
    { channel: "text", text: `我们${seq}起` },
    { channel: "tool_call", text: '{"tool":"evidence.search"}' },
    { channel: "text", text: "看这道题。" },
    { channel: "thinking", text: "内部推理，绝不可播放。" },
    { channel: "text", text: "答案思路是先找已知条件。" },
  ];
}

interface Fixture {
  readonly service: VoiceBridgeService;
  readonly runtime: ReturnType<typeof createMockCordisRuntime>;
  readonly clock: () => number;
  readonly events: BridgeEventFrame[];
}

function createFixture(): Fixture {
  const clockHandle = createVirtualClock();
  const runtime = createMockCordisRuntime({ scriptFor });
  const service = createVoiceBridge({
    profile: validateBridgeProfile(canonicalBridgeProfile()),
    agentPort: runtime,
    clock: clockHandle.now,
  });
  runtime.onFault((info) => service.handleAgentCrash(info.sessionKey));
  const events: BridgeEventFrame[] = [];
  service.onEvent((event) => events.push(event));
  return { service, runtime, clock: clockHandle.now, events };
}

async function openAndPrompt(fixture: Fixture, turnId: string): Promise<string> {
  const opened = await fixture.service.openSession({ sessionKey: SESSION, ownerActorId: OWNER, conversationId: CONVERSATION });
  assert.ok(opened.ok);
  const prompted = await fixture.service.turnPrompt({ sessionKey: SESSION, traceId: null, turnId, epoch: 1, fingerprint: "0123456789abcdef", idempotencyKey: "idem-bridge-0001", promptText: null });
  assert.ok(prompted.ok);
  const attemptId = prompted.value.attemptId;
  const streamed = await fixture.service.turnStream({ sessionKey: SESSION, turnId, epoch: 1 });
  assert.ok(streamed.ok);
  return attemptId;
}

function deltasOf(events: readonly BridgeEventFrame[]): { readonly index: number; readonly text: string; readonly epoch: number }[] {
  return events
    .filter((event) => event.kind === "event" && event.name === "assistant.delta")
    .map((event) => event.payload as { index: number; text: string; epoch: number });
}

// ---------------------------------------------------------------------------
// Exclusive ownership
// ---------------------------------------------------------------------------

test("session.open is idempotent-safe: a second open of a live session is refused", async () => {
  const fixture = createFixture();
  const first = await fixture.service.openSession({ sessionKey: SESSION, ownerActorId: OWNER, conversationId: CONVERSATION });
  assert.ok(first.ok);
  const second = await fixture.service.openSession({ sessionKey: SESSION, ownerActorId: OWNER, conversationId: CONVERSATION });
  assert.ok(!second.ok && second.code === "session_conflict");
  assert.equal(fixture.runtime.liveHandleCount(), 1, "exactly one live AgentHandle exists");
});

test("the mock agent port refuses side-channel creation for an owned session", async () => {
  const fixture = createFixture();
  await fixture.service.openSession({ sessionKey: SESSION, ownerActorId: OWNER, conversationId: CONVERSATION });
  const bypass = fixture.runtime.createAgent(SESSION);
  assert.ok(!bypass.ok && bypass.code === "bridge_ownership_conflict");
});

// ---------------------------------------------------------------------------
// Full command cycle
// ---------------------------------------------------------------------------

test("prompt → stream → deltas → attempt end → durable settle completes the cycle", async () => {
  const fixture = createFixture();
  const attemptId = await openAndPrompt(fixture, "trn_bridge0001");

  const pumped = fixture.runtime.pumpAll(SESSION);
  assert.ok(pumped > 0);

  // Only text-channel deltas are forwarded, bound to the turn/epoch/attempt.
  const deltas = deltasOf(fixture.events);
  assert.deepEqual(deltas.map((d) => d.text), ["我们一起", "看这道题。", "答案思路是先找已知条件。"]);
  assert.ok(deltas.every((d) => d.epoch === 1));

  const settled = fixture.events.find((event) => event.kind === "event" && event.name === "turn.settled");
  assert.ok(settled);
  const settledPayload = settled.payload as { messageId: string; finalState: string; sessionKey: string; turnId: string };
  assert.equal(settledPayload.finalState, "COMPLETED");
  assert.ok(settledPayload.messageId.startsWith("msg_"));
  assert.ok(!JSON.stringify(settledPayload).includes("答案"), "no message body ever crosses");

  const accepted = fixture.events.find((event) => event.kind === "event" && event.name === "turn.accepted");
  assert.ok(accepted && (accepted.payload as { attemptId: string }).attemptId === attemptId);
  assert.equal(fixture.runtime.cancelCallCount(SESSION), 0);
});

test("tool_call and thinking channel content never reaches the delta stream", async () => {
  const fixture = createFixture();
  await openAndPrompt(fixture, "trn_bridge0001");
  fixture.runtime.pumpAll(SESSION);
  const all = JSON.stringify(fixture.events);
  assert.ok(!all.includes("evidence.search"), "tool call payload is not forwarded");
  assert.ok(!all.includes("内部推理"), "thinking content is not forwarded");
  const metrics = fixture.service.metricsSnapshot();
  assert.equal(metrics.deltasDroppedNonText, 2);
});

test("a promptText transcript reaches the agent verbatim and never the audit (issue #51)", async () => {
  const fixture = createFixture();
  const opened = await fixture.service.openSession({ sessionKey: SESSION, ownerActorId: OWNER, conversationId: CONVERSATION });
  assert.ok(opened.ok);
  const marker = "睡前暗号zebra-42（伪私人标记）";
  const prompted = await fixture.service.turnPrompt({
    sessionKey: SESSION,
    traceId: null,
    turnId: "trn_bridge0051",
    epoch: 1,
    fingerprint: "0123456789abcdef",
    idempotencyKey: "idem-bridge-0051",
    promptText: marker,
  });
  assert.ok(prompted.ok);
  // Verbatim arrival at the Fake Agent (the approved model request).
  const record = fixture.runtime.receivedPromptsSnapshot(SESSION).find((entry) => entry.turnId === "trn_bridge0051");
  assert.equal(record?.promptText, marker);
  // Zero leakage in audit/metrics/events; a prompt without text records none.
  const auditText = JSON.stringify(fixture.service.auditSnapshot());
  assert.ok(!auditText.includes(marker), "the bridge audit never carries the transcript");
  assert.ok(!JSON.stringify(fixture.events).includes(marker), "no event frame carries the transcript");
  assert.equal(fixture.service.metricsSnapshot().deltasForwarded, 0);
  // dispose destroys the agent-side record.
  await fixture.service.closeSession({ sessionKey: SESSION, reason: "orchestrator_close" });
  assert.equal(fixture.runtime.receivedPromptsSnapshot(SESSION).length, 0, "dispose destroys the received prompts");
});

test("deltas are dropped until turn.stream subscribes the turn", async () => {
  const fixture = createFixture();
  const opened = await fixture.service.openSession({ sessionKey: SESSION, ownerActorId: OWNER, conversationId: CONVERSATION });
  assert.ok(opened.ok);
  await fixture.service.turnPrompt({ sessionKey: SESSION, traceId: null, turnId: "trn_bridge0001", epoch: 1, fingerprint: "0123456789abcdef", idempotencyKey: "idem-bridge-0001", promptText: null });
  fixture.runtime.pumpAll(SESSION);
  assert.equal(deltasOf(fixture.events).length, 0, "unsubscribed stream is filtered");
  assert.equal(fixture.service.metricsSnapshot().deltasDroppedUnsubscribed, 3);

  // A second turn with an explicit subscription forwards.
  await fixture.service.turnPrompt({ sessionKey: SESSION, traceId: null, turnId: "trn_bridge0002", epoch: 1, fingerprint: "0123456789abcde0", idempotencyKey: "idem-bridge-0002", promptText: null });
  await fixture.service.turnStream({ sessionKey: SESSION, turnId: "trn_bridge0002", epoch: 1 });
  fixture.runtime.pumpAll(SESSION);
  assert.ok(deltasOf(fixture.events).length > 0);
});

// ---------------------------------------------------------------------------
// Cancel discipline
// ---------------------------------------------------------------------------

test("cancel stops the attempt at the source; duplicate cancel never re-cancels", async () => {
  const fixture = createFixture();
  await openAndPrompt(fixture, "trn_bridge0001");

  fixture.runtime.pump(SESSION, 2); // start + first chunk
  assert.equal(deltasOf(fixture.events).length, 1);

  const cancelled = await fixture.service.turnCancel({ sessionKey: SESSION, turnId: "trn_bridge0001", epoch: 2, reason: "barge_in" });
  assert.ok(cancelled.ok && cancelled.value.cancelAcked && cancelled.value.idleConfirmed);
  assert.equal(fixture.runtime.cancelCallCount(SESSION), 1);

  // Duplicate cancel: rejected WITHOUT touching the agent again.
  const duplicate = await fixture.service.turnCancel({ sessionKey: SESSION, turnId: "trn_bridge0001", epoch: 2, reason: "barge_in" });
  assert.ok(!duplicate.ok && duplicate.code === "cancel_unknown_turn");
  assert.equal(fixture.runtime.cancelCallCount(SESSION), 1, "the agent cancel happened exactly once");

  // Source stop: no further deltas ever arrive.
  const before = deltasOf(fixture.events).length;
  fixture.runtime.pumpAll(SESSION);
  assert.equal(deltasOf(fixture.events).length, before);

  const idleEvent = fixture.events.find((event) => event.kind === "event" && event.name === "session.idle");
  assert.ok(idleEvent);
});

test("a cancel carrying an epoch older than the dispatched turn is stale-rejected", async () => {
  const fixture = createFixture();
  await openAndPrompt(fixture, "trn_bridge0001"); // dispatched at epoch 1
  const stale = await fixture.service.turnCancel({ sessionKey: SESSION, turnId: "trn_bridge0001", epoch: 1, reason: "device_abort" });
  // The orchestrator fences first: the cancel must carry the POST-fence
  // epoch (> 1). An epoch equal to the turn's birth epoch means the fence
  // was skipped, and the bridge refuses to stop the agent for it.
  assert.ok(!stale.ok && stale.code === "stale_turn_rejected");
  assert.equal(fixture.runtime.cancelCallCount(SESSION), 0, "no agent cancel for a stale request");
});

// ---------------------------------------------------------------------------
// Worker isolation & recovery
// ---------------------------------------------------------------------------

test("a worker crash quarantines the session; recovery rebuilds on reopen only", async () => {
  const fixture = createFixture();
  await openAndPrompt(fixture, "trn_bridge0001");
  fixture.runtime.pump(SESSION, 2);

  fixture.runtime.crashNow(SESSION);
  const crashEvent = fixture.events.find((event) => event.kind === "event" && event.name === "runtime.error");
  assert.ok(crashEvent && (crashEvent.payload as { code: string }).code === "worker_crashed");

  // While quarantined, every mutating command is refused.
  const prompted = await fixture.service.turnPrompt({ sessionKey: SESSION, traceId: null, turnId: "trn_bridge0002", epoch: 1, fingerprint: "0123456789abcde0", idempotencyKey: "idem-bridge-0002", promptText: null });
  assert.ok(!prompted.ok && prompted.code === "worker_recovering");
  const cancelled = await fixture.service.turnCancel({ sessionKey: SESSION, turnId: "trn_bridge0001", epoch: 2, reason: "barge_in" });
  assert.ok(!cancelled.ok && cancelled.code === "worker_recovering");

  // Recovery happens ONLY through an explicit reopen.
  const reopened = await fixture.service.openSession({ sessionKey: SESSION, ownerActorId: OWNER, conversationId: CONVERSATION });
  assert.ok(reopened.ok && reopened.value.recovered);
  const recoveredEvent = fixture.events.find((event) => event.kind === "event" && event.name === "runtime.error" && (event.payload as { code: string }).code === "recovered");
  assert.ok(recoveredEvent);

  const metrics = fixture.service.metricsSnapshot();
  assert.equal(metrics.workerRecovery.count, 1);
  assert.ok(Number.isFinite(metrics.workerRecovery.maxMs));

  // The fresh worker serves a new turn normally.
  const nextPrompt = await fixture.service.turnPrompt({ sessionKey: SESSION, traceId: null, turnId: "trn_bridge0002", epoch: 1, fingerprint: "0123456789abcde0", idempotencyKey: "idem-bridge-0002", promptText: null });
  assert.ok(nextPrompt.ok);
});

test("a whenIdle that returns without a stopped agent triggers cancel_timeout quarantine", async () => {
  const clockHandle = createVirtualClock();
  const events: BridgeEventFrame[] = [];
  // Pathological port: cancel "succeeds" but the handle keeps running.
  const fakeHandle: BridgeAgentHandle = {
    sessionKey: SESSION,
    runPrompt() {
      return { ok: true, attemptId: "att_fake_0001" };
    },
    cancel() {
      return { ok: true, attemptId: "att_fake_0001" };
    },
    async whenIdle() {
      return { ok: true, attemptId: "att_fake_0001" };
    },
    async dispose() {
      return { ok: true };
    },
    onStream(_listener: (event: BridgeStreamEvent) => void) {
      return { ok: true };
    },
    onDurable(_listener: (event: BridgeDurableEvent) => void) {
      return { ok: true };
    },
    isRunning() {
      return true;
    },
  };
  const fakePort: BridgeAgentPort = {
    createAgent() {
      return { ok: true, handle: fakeHandle };
    },
    resumeAgent() {
      return { ok: true, handle: fakeHandle };
    },
  };
  const service = createVoiceBridge({
    profile: validateBridgeProfile(canonicalBridgeProfile()),
    agentPort: fakePort,
    clock: clockHandle.now,
  });
  service.onEvent((event) => events.push(event));

  assert.ok((await service.openSession({ sessionKey: SESSION, ownerActorId: OWNER, conversationId: CONVERSATION })).ok);
  assert.ok((await service.turnPrompt({ sessionKey: SESSION, traceId: null, turnId: "trn_bridge0001", epoch: 1, fingerprint: "0123456789abcdef", idempotencyKey: "idem-bridge-0001", promptText: null })).ok);
  const cancelled = await service.turnCancel({ sessionKey: SESSION, turnId: "trn_bridge0001", epoch: 2, reason: "barge_in" });
  assert.ok(!cancelled.ok && cancelled.code === "cancel_timeout");
  const crashEvent = events.find((event) => event.kind === "event" && event.name === "runtime.error");
  assert.ok(crashEvent && (crashEvent.payload as { code: string }).code === "worker_crashed");
});

// ---------------------------------------------------------------------------
// Close + metrics
// ---------------------------------------------------------------------------

test("session.close disposes the handle and emits session.closed; reopen starts fresh", async () => {
  const fixture = createFixture();
  await openAndPrompt(fixture, "trn_bridge0001");
  const closed = await fixture.service.closeSession({ sessionKey: SESSION, reason: "orchestrator_close" });
  assert.ok(closed.ok);
  assert.equal(fixture.runtime.liveHandleCount(), 0, "the AgentHandle was disposed with the session");
  const closedEvent = fixture.events.find((event) => event.kind === "event" && event.name === "session.closed");
  assert.ok(closedEvent);
  const reopened = await fixture.service.openSession({ sessionKey: SESSION, ownerActorId: OWNER, conversationId: CONVERSATION });
  assert.ok(reopened.ok && reopened.value.recovered === false);
});

test("unknown sessions are rejected on every command without echoing input", async () => {
  const fixture = createFixture();
  assert.ok(!(await fixture.service.turnPrompt({ sessionKey: SESSION, traceId: null, turnId: "trn_bridge0001", epoch: 1, fingerprint: "0123456789abcdef", idempotencyKey: "idem-bridge-0001", promptText: null })).ok);
  assert.ok(!(await fixture.service.turnCancel({ sessionKey: SESSION, turnId: "trn_bridge0001", epoch: 1, reason: "barge_in" })).ok);
  assert.ok(!(await fixture.service.turnStream({ sessionKey: SESSION, turnId: "trn_bridge0001", epoch: 1 })).ok);
  assert.ok(!(await fixture.service.closeSession({ sessionKey: SESSION, reason: "orchestrator_close" })).ok);
  const audit = JSON.stringify(fixture.service.auditSnapshot());
  assert.ok(!audit.includes("trn_bridge0001"), "rejections never echo the submitted ids");
});
