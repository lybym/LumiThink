import assert from "node:assert/strict";
import test from "node:test";

/**
 * E2E-05 (issue #55) — real-ASR streaming-path behaviors on the REAL
 * composed runtime (Gateway Adapter → trusted Orchestrator → Bridge IPC →
 * synthetic Cordis runtime), in-process transport, pure-synthetic samples,
 * deterministic manual clock.
 *
 * DoD coverage here (issue #55 验收标准):
 *   - DoD 2 scenario families, on the real-ASR streaming path:
 *       迟到（fixtures late_asr + interruption duplicate here）、
 *       重复 final（dedup window suppression + window-boundary/expiry）、
 *       断线/重连（fixtures network_drop_reconnect + re-delivery here）、
 *       长静音（no finals → no turns, no epoch movement）、
 *       误端点注入（premature final + real final → ordered turns）。
 *   - DoD 1 (core segment): the final reaches the trusted agent VERBATIM and
 *     the run records content-independent latency/endpoint metrics; provider
 *     confidence is structurally not on the pinned wire and is recorded as
 *     such (never synthesized).
 *   - DoD 3: zero-leak scan on every content-free surface for each scenario.
 */

import { createVoiceGatewayStack, type VoiceGatewayStack } from "../../../../lib/server/voice-gateway-composition.ts";
import { createMockXiaozhiGateway, type MockXiaozhiGateway } from "../../../../lib/domain/voice/adapter/mock-xiaozhi.ts";
import { GATEWAY_ADAPTER_VERSION, GATEWAY_ASR_DUPLICATE_WINDOW_MS_DEFAULT } from "../../../../lib/domain/voice/adapter/gateway-adapter.ts";
import { buildRealAsrEvidenceRecord, parseRealAsrActivation } from "../../../../lib/server/real-asr-composition.ts";
import { createTurnIdFactory, mulberry32, pick } from "../helpers.ts";

const DEVICE = "aabbccddeeff0011";
const ACTOR = "act_owner0001";
const CONVERSATION = "conv_child0001";
const ACTIVATION = "0123456789abcdef0123456789abcdef";
/** The 伪私人 marker text injected as the synthetic transcript. */
const MARKER = "睡前暗号zebra-42（伪私人标记）";

function scriptFor(sessionKey: string, turnId: string) {
  const seedHex = sessionKey.slice(6, 14) + "00";
  const rng = mulberry32(parseInt(seedHex, 16) >>> 0);
  // Enough fragments that a freshly dispatched turn is still RUNNING after a
  // two-step pump — the interruption scenario needs a fenceable turn.
  return [
    { channel: "text" as const, text: pick(rng, ["我们分三步算。", "先读题，再列式。"]) },
    { channel: "text" as const, text: "先把已知条件写下来。" },
    { channel: "text" as const, text: "第一步是画线段图。" },
    { channel: "tool_call" as const, text: '{"tool":"memory.lookup"}' },
    { channel: "text" as const, text: "第二步列式计算。" },
    { channel: "text" as const, text: "你做得很好。" },
    { channel: "text" as const, text: "第三步验算一遍。" },
    { channel: "text" as const, text: "有不懂的随时问我。" },
  ];
}

/** Manual deterministic clock: each read advances 1 ms; tests can jump. */
function createManualClock(startMs = 10_000) {
  let nowMs = startMs;
  return {
    now: () => {
      nowMs += 1;
      return nowMs;
    },
    advanceMs: (delta: number) => {
      nowMs += delta;
    },
  };
}

interface Harness {
  readonly gw: VoiceGatewayStack;
  readonly mock: MockXiaozhiGateway;
  readonly clock: ReturnType<typeof createManualClock>;
  stop(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const mock = createMockXiaozhiGateway();
  const clock = createManualClock();
  const gw = createVoiceGatewayStack({
    scriptFor,
    transport: "in_process",
    framesPerSentence: 4,
    turnIdFactory: createTurnIdFactory(5500),
    clock: clock.now,
    directiveSink: (directive) => {
      mock.applyDirective(directive);
    },
  });
  await gw.start();
  assert.ok(gw.bindDevice({ deviceId: DEVICE, actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION }).ok);
  mock.connect({ connectionId: "conn_asr01", deviceId: DEVICE, clientDigest: ACTIVATION });
  mock.serverAccept("conn_asr01");
  await feedAll({ gw, mock });
  return { gw, mock, clock, stop: () => gw.stop() };
}

async function feedAll(harness: { readonly gw: VoiceGatewayStack; readonly mock: MockXiaozhiGateway }): Promise<void> {
  for (;;) {
    const batch = harness.mock.flushAll();
    if (batch.length === 0) {
      break;
    }
    for (const { connectionId, event } of batch) {
      const outcome = await harness.gw.handleDeviceEvent(connectionId, event);
      if (outcome.ok && event.kind === "session_issued" && typeof outcome.sessionKey === "string") {
        harness.mock.bindSession(connectionId, outcome.sessionKey);
      }
    }
  }
}

function flushEventQueue(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isTerminal(state: string): boolean {
  return ["COMPLETED", "CANCELLED", "FAILED", "TIMED_OUT"].includes(state);
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not reached in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function settleAll(h: Harness, sessionKey: string): Promise<void> {
  for (let round = 0; round < 16; round += 1) {
    h.gw.stack.pumpRuntime(sessionKey, 200);
    await flushEventQueue();
    if (h.gw.stack.orchestrator.listTurns(sessionKey).every((turn) => isTerminal(turn.state))) {
      break;
    }
  }
  await flushEventQueue();
}

/** Every content-free surface the transcript must NOT appear in. */
function leakSurfaces(h: Harness): readonly (readonly [string, string])[] {
  const stack = h.gw.stack;
  return [
    ["adapter.audit", JSON.stringify(h.gw.adapter.auditSnapshot())],
    ["adapter.metrics", JSON.stringify(h.gw.adapterMetrics())],
    ["adapter.mapping", JSON.stringify(h.gw.mappingSnapshot())],
    ["orchestrator.audit", JSON.stringify(stack.orchestrator.auditSnapshot())],
    ["orchestrator.snapshot", JSON.stringify(stack.orchestrator.exportState())],
    ["bridge.audit", JSON.stringify(stack.service.auditSnapshot())],
    ["bridge.metrics", JSON.stringify(stack.service.metricsSnapshot())],
    ["gate.metrics", JSON.stringify(stack.gate.metricsSnapshot())],
    ["device.directives", JSON.stringify(h.mock.appliedLog())],
  ] as const;
}

function leakScanClean(h: Harness, marker: string): boolean {
  return leakSurfaces(h).every(([, serialized]) => !serialized.includes(marker));
}

function received(h: Harness, sessionKey: string): readonly string[] {
  return h.gw.stack.runtime.receivedPromptsSnapshot(sessionKey).map((entry) => entry.promptText as string);
}

test("a real-shaped streaming utterance reaches the trusted agent verbatim with content-independent metrics (issue #55 DoD 1)", async () => {
  const h = await createHarness();
  try {
    h.mock.listenState("conn_asr01", "start", "auto");
    h.mock.speakPartial("conn_asr01", "睡前暗号");
    h.mock.speakPartial("conn_asr01", "睡前暗号zebra");
    h.mock.speakFinal("conn_asr01", MARKER);
    await feedAll(h);
    const sessionKey = h.gw.findSessionKeyByDevice(DEVICE);
    assert.ok(sessionKey);
    await settleAll(h, sessionKey);

    // Verbatim arrival — the real-ASR final enters the controlled core as
    // text, never as a digest (the E2E-01 contract holds on this path).
    assert.deepEqual(received(h, sessionKey), [MARKER]);
    const metrics = h.gw.adapterMetrics();
    assert.equal(metrics.asrEndpointWindows, 1, "one listen start opened one utterance window");
    assert.equal(metrics.asrPartialsSeen, 2);
    assert.equal(metrics.asrFinalsAccepted, 1);
    assert.equal(metrics.asrDuplicateFinalsSuppressed, 0);
    assert.equal(metrics.asrFinalAcceptMs.count, 1, "content-independent accept latency recorded");
    assert.ok(Number.isFinite(metrics.asrFinalAcceptMs.maxMs), "latency is a measured number, never hardcoded");
    const accepted = h.gw.adapter.auditSnapshot().find((entry) => entry.action === "gateway.asr_final_accepted");
    assert.ok(accepted && accepted.detail !== null);
    assert.match(accepted.detail, /^[0-9a-f]{64}$/, "the only content-derived residue is the keyed HMAC digest");

    const clean = leakScanClean(h, MARKER);
    assert.ok(clean, "the transcript appears on no content-free surface");

    // DoD 1 evidence record: content-independent, honest about confidence.
    const evidence = buildRealAsrEvidenceRecord({
      activation: parseRealAsrActivation({}),
      metrics,
      leakageScanClean: clean,
    });
    assert.equal(evidence.evidence, "voice-asr-real/1");
    assert.equal(evidence.sanitized, true);
    assert.equal(evidence.route, "mock");
    assert.equal(evidence.provider, null);
    assert.equal(evidence.childDataEgressReviewStatus, "not_performed");
    assert.equal(evidence.confidence.onWire, false, "provider confidence is structurally not on the pinned wire");
    assert.equal(evidence.leakageScanClean, true);
    assert.equal(evidence.metrics.asrFinalAcceptMs.count, 1);
    const evidenceJson = JSON.stringify(evidence);
    assert.ok(!evidenceJson.includes(MARKER), "the evidence record never carries the transcript");
  } finally {
    await h.stop();
  }
});

test("a duplicate final inside the dedup window is a suppressed no-op (issue #55 去重)", async () => {
  const h = await createHarness();
  try {
    h.mock.listenState("conn_asr01", "start", "auto");
    h.mock.speakFinal("conn_asr01", MARKER);
    h.mock.speakFinal("conn_asr01", MARKER); // endpoint double-fire / replay
    await feedAll(h);
    const sessionKey = h.gw.findSessionKeyByDevice(DEVICE);
    assert.ok(sessionKey);
    await settleAll(h, sessionKey);

    assert.equal(h.gw.adapterMetrics().asrDuplicateFinalsSuppressed, 1, "the duplicate is enumerated, not silent");
    assert.equal(h.gw.adapterMetrics().asrFinalsAccepted, 1);
    assert.equal(h.gw.stack.orchestrator.listTurns(sessionKey).length, 1, "no error turn for the duplicate");
    assert.deepEqual(received(h, sessionKey), [MARKER], "the agent received the utterance exactly once");
    const suppressed = h.gw.adapter.auditSnapshot().find((entry) => entry.action === "gateway.asr_duplicate_suppressed");
    assert.ok(suppressed && suppressed.detail !== null);
    assert.match(suppressed.detail, /^[0-9a-f]{64}$/);
    for (const [name, serialized] of leakSurfaces(h)) {
      assert.ok(!serialized.includes(MARKER), `${name} must not carry the transcript`);
    }
  } finally {
    await h.stop();
  }
});

test("a new utterance window re-accepts the same text: listen start clears the dedup memory (归属边界)", async () => {
  const h = await createHarness();
  try {
    h.mock.listenState("conn_asr01", "start", "auto");
    h.mock.speakFinal("conn_asr01", MARKER);
    await feedAll(h);
    h.mock.listenState("conn_asr01", "start", "auto"); // the device signals a NEW utterance
    h.mock.speakFinal("conn_asr01", MARKER);
    await feedAll(h);
    const sessionKey = h.gw.findSessionKeyByDevice(DEVICE);
    assert.ok(sessionKey);
    await settleAll(h, sessionKey);

    const metrics = h.gw.adapterMetrics();
    assert.equal(metrics.asrEndpointWindows, 2);
    assert.equal(metrics.asrDuplicateFinalsSuppressed, 0, "a repeated utterance is not a duplicate");
    assert.equal(metrics.asrFinalsAccepted, 2);
    assert.equal(h.gw.stack.orchestrator.listTurns(sessionKey).length, 2, "two utterances, two turns");
    assert.deepEqual(received(h, sessionKey), [MARKER, MARKER], "each utterance reaches the agent exactly once");
    for (const turn of h.gw.stack.orchestrator.listTurns(sessionKey)) {
      assert.ok(isTerminal(turn.state));
    }
  } finally {
    await h.stop();
  }
});

test("after the dedup window expires the same text is a new utterance (bounded suppression)", async () => {
  const h = await createHarness();
  try {
    h.mock.listenState("conn_asr01", "start", "auto");
    h.mock.speakFinal("conn_asr01", MARKER);
    await feedAll(h);
    h.clock.advanceMs(GATEWAY_ASR_DUPLICATE_WINDOW_MS_DEFAULT + 1);
    h.mock.speakFinal("conn_asr01", MARKER);
    await feedAll(h);
    const sessionKey = h.gw.findSessionKeyByDevice(DEVICE);
    assert.ok(sessionKey);
    await settleAll(h, sessionKey);
    assert.equal(h.gw.adapterMetrics().asrDuplicateFinalsSuppressed, 0);
    assert.equal(h.gw.stack.orchestrator.listTurns(sessionKey).length, 2);
  } finally {
    await h.stop();
  }
});

test("interruption + immediate duplicate final: one cancelled turn, no error turn, no re-flow (issue #55 DoD 2)", async () => {
  const h = await createHarness();
  try {
    h.mock.listenState("conn_asr01", "start", "auto");
    h.mock.speakFinal("conn_asr01", MARKER);
    await feedAll(h);
    const sessionKey = h.gw.findSessionKeyByDevice(DEVICE);
    assert.ok(sessionKey);
    h.gw.stack.pumpRuntime(sessionKey, 2); // the long script keeps the turn RUNNING
    await flushEventQueue();
    h.gw.pumpPlayback(sessionKey); // start device playback so the abort can fence
    const turns = h.gw.stack.orchestrator.listTurns(sessionKey);
    assert.equal(turns.length, 1);

    h.mock.abortSpeaking("conn_asr01", "manual"); // fence-first barge-in
    await feedAll(h);
    await flushEventQueue();
    // A provider double-delivery of the SAME final right after the abort
    // (no new-utterance signal in between) must not mint an error turn.
    h.mock.speakFinal("conn_asr01", MARKER);
    await feedAll(h);
    await settleAll(h, sessionKey);

    assert.equal(h.gw.adapterMetrics().asrDuplicateFinalsSuppressed, 1);
    const finalTurns = h.gw.stack.orchestrator.listTurns(sessionKey);
    assert.equal(finalTurns.length, 1, "the duplicate created no second turn");
    assert.equal(finalTurns[0]?.state, "CANCELLED");
    assert.deepEqual(received(h, sessionKey), [MARKER], "the interrupted turn's text never re-flows");
    for (const [name, serialized] of leakSurfaces(h)) {
      assert.ok(!serialized.includes(MARKER), `${name} must not carry the transcript`);
    }
  } finally {
    await h.stop();
  }
});

test("long silence produces no turns, no epoch movement and no leakage; a later final works (长静音)", async () => {
  const h = await createHarness();
  try {
    h.mock.listenState("conn_asr01", "start", "auto");
    for (let i = 0; i < 5; i += 1) {
      h.clock.advanceMs(30_000); // 150 s of silence inside one window
      h.mock.speakPartial("conn_asr01", "……（静音段假设）");
    }
    await feedAll(h);
    const sessionKey = h.gw.findSessionKeyByDevice(DEVICE);
    assert.ok(sessionKey);
    const epochBefore = h.gw.stack.orchestrator.currentEpoch(sessionKey);
    assert.equal(h.gw.stack.orchestrator.listTurns(sessionKey).length, 0, "silence never creates a turn");
    assert.equal(received(h, sessionKey).length, 0);
    assert.equal(h.gw.adapterMetrics().asrFinalsAccepted, 0);
    assert.equal(h.gw.adapterMetrics().asrDuplicateFinalsSuppressed, 0);
    // The timeout sweep has nothing to sweep (no RUNNING turn existed).
    const swept = h.gw.sweep(sessionKey);
    assert.ok(swept.ok && swept.timedOutTurnIds.length === 0);
    assert.equal(h.gw.stack.orchestrator.currentEpoch(sessionKey), epochBefore, "silence never bumps the epoch");

    // A real final after the silence opens a normal turn.
    h.mock.speakFinal("conn_asr01", MARKER);
    await feedAll(h);
    await settleAll(h, sessionKey);
    assert.deepEqual(received(h, sessionKey), [MARKER]);
    for (const [name, serialized] of leakSurfaces(h)) {
      assert.ok(!serialized.includes("静音段假设"), `${name} must not carry partial hypotheses`);
    }
  } finally {
    await h.stop();
  }
});

test("false endpoint injection yields ordered turns without cross-talk (误端点注入)", async () => {
  const h = await createHarness();
  try {
    h.mock.listenState("conn_asr01", "start", "auto");
    h.mock.speakFinal("conn_asr01", "我们先找"); // premature endpoint
    h.mock.speakFinal("conn_asr01", "我们先找已知条件。"); // the real endpoint
    h.mock.speakFinal("conn_asr01", "我们先找已知条件。"); // provider duplicate of the real one
    await feedAll(h);
    const sessionKey = h.gw.findSessionKeyByDevice(DEVICE);
    assert.ok(sessionKey);
    await settleAll(h, sessionKey);

    const metrics = h.gw.adapterMetrics();
    assert.equal(metrics.asrFinalsAccepted, 2, "the premature and the real final each mint one turn");
    assert.equal(metrics.asrDuplicateFinalsSuppressed, 1, "the re-delivered real final is suppressed");
    assert.equal(h.gw.stack.orchestrator.listTurns(sessionKey).length, 2, "no error turn was created");
    assert.deepEqual(received(h, sessionKey), ["我们先找", "我们先找已知条件。"], "both utterances reach the agent exactly once, in order");
    for (const turn of h.gw.stack.orchestrator.listTurns(sessionKey)) {
      assert.ok(isTerminal(turn.state), `turn ${turn.turnId} must settle`);
    }
    for (const [name, serialized] of leakSurfaces(h)) {
      assert.ok(!serialized.includes("我们先找已知条件"), `${name} must not carry the transcript`);
    }
  } finally {
    await h.stop();
  }
});

test("reconnect re-delivery of the same final does not mint an error turn; the session continues (断线/重连)", async () => {
  const h = await createHarness();
  try {
    h.mock.listenState("conn_asr01", "start", "auto");
    h.mock.speakFinal("conn_asr01", MARKER);
    await feedAll(h);
    const sessionKey = h.gw.findSessionKeyByDevice(DEVICE);
    assert.ok(sessionKey);

    // Network drop, then trusted reconnect on the same device.
    h.mock.dropConnection("conn_asr01", "network");
    await feedAll(h);
    h.mock.connect({ connectionId: "conn_asr01_r2", deviceId: DEVICE, clientDigest: ACTIVATION });
    await feedAll(h);
    h.mock.serverAccept("conn_asr01_r2");
    await feedAll(h);
    const mapping = h.gw.mappingSnapshot().find((entry) => entry.deviceId === DEVICE);
    assert.ok(mapping && mapping.connected && mapping.sessionKey === sessionKey, "the trusted session continues");

    // The server re-delivers the pre-drop final on the new connection —
    // within the dedup window, same fingerprint: no error turn.
    h.mock.speakFinal("conn_asr01_r2", MARKER);
    await feedAll(h);
    await settleAll(h, sessionKey);
    assert.equal(h.gw.adapterMetrics().asrDuplicateFinalsSuppressed, 1, "the re-delivery is recognized across the reconnect");
    assert.equal(h.gw.stack.orchestrator.listTurns(sessionKey).length, 1, "no error turn after reconnect");
    assert.deepEqual(received(h, sessionKey), [MARKER], "the utterance reaches the agent exactly once");
    for (const [name, serialized] of leakSurfaces(h)) {
      assert.ok(!serialized.includes(MARKER), `${name} must not carry the transcript`);
    }
  } finally {
    await h.stop();
  }
});

test("the adapter version bump is observable for the E2E-05 dedup semantics", () => {
  // A cheap contract pin: dedup is a v1.2 adapter behavior; a future reader
  // comparing evidence across versions sees which semantics produced it.
  assert.equal(GATEWAY_ADAPTER_VERSION, "1.2");
});
