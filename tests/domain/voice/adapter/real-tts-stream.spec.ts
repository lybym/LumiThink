import assert from "node:assert/strict";
import test from "node:test";

/**
 * E2E-06 (issue #56) — real-TTS-shape playback behaviors: the content-free
 * TTS metrics (first-audio latency, inter-sentence gaps, stop-effective
 * latency, stale-audio suppression, turns/sentences/frames, negotiated
 * downlink sample rate) and the evidence record contract.
 *
 * Two harnesses, mirroring the established test split:
 *   - the REAL composed runtime (Gateway Adapter → trusted Orchestrator →
 *     Bridge IPC → synthetic Cordis runtime), in-process transport,
 *     pure-synthetic samples, deterministic manual clock — for the
 *     end-to-end behaviors that do not depend on queue/admission interleaving
 *     (issue #56 DoD 2/4: stop-effective latency, 旧 epoch 音频 0 送出,
 *     打断后下一轮 TTS 继续可播);
 *   - a scripted in-memory core port (same idiom as adapter.spec.ts) — for
 *     the exact suppression-counter accounting (fenced batches + dropped
 *     queue items), which the real stack drains at event-flush boundaries.
 *
 * No audio bytes exist on this surface (frame counts + digests only); the
 * real vendor TTS runs inside the pinned xiaozhi server and its server-side
 * decode/play verification is operator opt-in, recorded as NOT performed by
 * the evidence record. The mock route never touches an external TTS.
 */

import { createVoiceGatewayStack, type VoiceGatewayStack } from "../../../../lib/server/voice-gateway-composition.ts";
import { createMockXiaozhiGateway, type MockXiaozhiGateway } from "../../../../lib/domain/voice/adapter/mock-xiaozhi.ts";
import { createVoiceGatewayAdapter, gatewayContentDigest, GATEWAY_ADAPTER_VERSION, type GatewayCorePort, type GatewayMetricsSnapshot } from "../../../../lib/domain/voice/adapter/gateway-adapter.ts";
import { createGatewayDeviceBindingRegistry } from "../../../../lib/domain/voice/adapter/binding.ts";
import type { GatewayDeviceDirective } from "../../../../lib/domain/voice/adapter/protocol.ts";
import { buildRealTtsEvidenceRecord, parseRealTtsActivation } from "../../../../lib/server/real-tts-composition.ts";
import { createTurnIdFactory, mulberry32, pick } from "../helpers.ts";
import type { VoiceTurnState } from "../../../../lib/domain/voice/schema.ts";

const DEVICE = "aabbccddeeff0011";
const ACTOR = "act_owner0001";
const CONVERSATION = "conv_child0001";
const ACTIVATION = "0123456789abcdef0123456789abcdef";
/** The 伪私人 marker text injected as the synthetic transcript. */
const MARKER = "睡前暗号zebra-42（伪私人标记）";

function scriptFor(sessionKey: string, turnId: string) {
  const seedHex = sessionKey.slice(6, 14) + "00";
  const rng = mulberry32(parseInt(seedHex, 16) >>> 0);
  // Enough text fragments that the Gate admits several sentences and a
  // freshly dispatched turn is still RUNNING after a two-step pump — the
  // interruption scenario needs a fenceable turn.
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
  mock.connect({ connectionId: "conn_tts01", deviceId: DEVICE, clientDigest: ACTIVATION });
  mock.serverAccept("conn_tts01");
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

test("Gate-admitted sentences flow to the device sink with content-free TTS metrics (issue #56 DoD 1)", async () => {
  const h = await createHarness();
  try {
    h.mock.listenState("conn_tts01", "start", "auto");
    h.mock.speakFinal("conn_tts01", MARKER);
    await feedAll(h);
    const sessionKey = h.gw.findSessionKeyByDevice(DEVICE);
    assert.ok(sessionKey);
    await settleAll(h, sessionKey);

    const metrics = h.gw.adapterMetrics();
    // The sentences reached the device sink in order, as frame batches.
    assert.equal(metrics.ttsTurnsPlayed, 1, "one turn played");
    assert.ok(metrics.ttsSentencesSent >= 2, "several Gate-admitted sentences were delivered");
    assert.equal(metrics.ttsFramesSent, metrics.ttsSentencesSent * 4, "each sentence carries its synthetic frame batch");
    assert.equal(metrics.ttsFirstAudioMs.count, 1, "first-audio latency recorded once for the turn");
    assert.ok(Number.isFinite(metrics.ttsFirstAudioMs.maxMs), "first-audio latency is a measured number, never hardcoded");
    assert.equal(metrics.ttsInterSentenceGapMs.count, metrics.ttsSentencesSent - 1, "every sentence after the first measures an inter-sentence gap");
    assert.ok(Number.isFinite(metrics.ttsInterSentenceGapMs.maxMs));
    assert.equal(metrics.ttsStopEffectiveMs.count, 0, "no abort, no stop measure");
    assert.equal(metrics.ttsStaleAudioSuppressed, 0, "nothing stale in a clean run");
    // The downlink sample rate comes from the hello negotiation (content-free).
    const mapping = h.gw.mappingSnapshot().find((entry) => entry.deviceId === DEVICE);
    assert.ok(mapping && mapping.downlinkSampleRate === 16_000, "the hello-negotiated sample rate is recorded");

    const clean = leakScanClean(h, MARKER);
    assert.ok(clean, "the transcript appears on no content-free surface");

    // DoD 1 evidence record: content-independent, honest about the server-side
    // decode/play verification (operator opt-in, not performed here).
    const evidence = buildRealTtsEvidenceRecord({
      activation: parseRealTtsActivation({}),
      metrics,
      downlinkSampleRate: mapping?.downlinkSampleRate ?? null,
      leakageScanClean: clean,
    });
    assert.equal(evidence.evidence, "voice-tts-real/1");
    assert.equal(evidence.sanitized, true);
    assert.equal(evidence.route, "mock");
    assert.equal(evidence.provider, null);
    assert.equal(evidence.childDataEgressReviewStatus, "not_performed");
    assert.equal(evidence.serverPlaybackVerification.performed, false, "decode/play verification is never claimed by CI");
    assert.equal(evidence.leakageScanClean, true);
    assert.equal(evidence.metrics.ttsFirstAudioMs.count, 1);
    const evidenceJson = JSON.stringify(evidence);
    assert.ok(!evidenceJson.includes(MARKER), "the evidence record never carries the transcript");
  } finally {
    await h.stop();
  }
});

test("repeated cancel: stop-effective latency measured, no old-epoch audio after the stop, the next turn still plays (issue #56 DoD 2/4)", async () => {
  const h = await createHarness();
  try {
    // Turn 1: start playback so the abort can fence.
    h.mock.listenState("conn_tts01", "start", "auto");
    h.mock.speakFinal("conn_tts01", MARKER);
    await feedAll(h);
    const sessionKey = h.gw.findSessionKeyByDevice(DEVICE);
    assert.ok(sessionKey);
    h.gw.stack.pumpRuntime(sessionKey, 2); // the long script keeps the turn RUNNING
    await flushEventQueue();
    h.gw.pumpPlayback(sessionKey); // start device playback so the abort can fence
    const metricsBeforeAbort = h.gw.adapterMetrics();
    assert.ok(metricsBeforeAbort.ttsSentencesSent >= 1, "the first sentences were delivered before the interrupt");

    h.mock.abortSpeaking("conn_tts01", "manual"); // fence-first barge-in
    await feedAll(h);
    await flushEventQueue();
    h.gw.pumpPlayback(sessionKey); // any leftover queue items must be fenced here
    await flushEventQueue();

    const metricsAfterAbort = h.gw.adapterMetrics();
    assert.ok(metricsAfterAbort.ttsStopEffectiveMs.count >= 1, "the stop-effective latency was measured");
    assert.ok(Number.isFinite(metricsAfterAbort.ttsStopEffectiveMs.maxMs));
    const turns = h.gw.stack.orchestrator.listTurns(sessionKey);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.state, "CANCELLED", "the interrupted turn settled CANCELLED");
    const turn1Id = turns[0]?.turnId;
    assert.ok(turn1Id, "the interrupted turn id is known");

    // Old-epoch audio delivered = 0: the device log holds no ACCEPTED frames
    // batch for the cancelled turn after its stop directive (the mock device
    // itself rejects stale/after-stop batches — defense in depth).
    const appliedLog = h.mock.appliedLog();
    const stopIdx = appliedLog.findIndex(
      (entry) => entry.directive.kind === "tts.stop" && entry.directive.turnId === turn1Id,
    );
    assert.ok(stopIdx >= 0, "the interrupted turn's stop was issued");
    const staleFramesAfterStop = appliedLog
      .slice(stopIdx + 1)
      .filter((entry) => entry.directive.kind === "tts.frames" && entry.directive.turnId === turn1Id && entry.accepted);
    assert.equal(staleFramesAfterStop.length, 0, "no old-turn frame batch was accepted after the stop");

    // Turn 2 (打断后下一轮 TTS 继续可播): a new utterance window, a new final,
    // a new turn — its TTS must reach the device sink again.
    h.mock.listenState("conn_tts01", "start", "auto");
    h.mock.speakFinal("conn_tts01", MARKER);
    await feedAll(h);
    await settleAll(h, sessionKey);

    const finalMetrics = h.gw.adapterMetrics();
    assert.equal(finalMetrics.ttsTurnsPlayed, 2, "the NEXT turn played TTS again after the interrupt");
    assert.ok(finalMetrics.ttsSentencesSent > metricsBeforeAbort.ttsSentencesSent, "the next turn delivered new sentences");
    assert.equal(finalMetrics.ttsFirstAudioMs.count, 2, "first-audio latency measured for both turns");

    const clean = leakScanClean(h, MARKER);
    assert.ok(clean, "the transcript appears on no content-free surface after the interrupt");
  } finally {
    await h.stop();
  }
});

test("abort without playback stays an enumerated no-op: queued sentences still play once (连续抢话语义)", async () => {
  const h = await createHarness();
  try {
    h.mock.listenState("conn_tts01", "start", "auto");
    h.mock.speakFinal("conn_tts01", MARKER);
    await feedAll(h);
    const sessionKey = h.gw.findSessionKeyByDevice(DEVICE);
    assert.ok(sessionKey);
    // Admit sentences into the trusted TTS queue WITHOUT flushing the core
    // event tap: nothing has been delivered, so the device has NO playback.
    h.gw.stack.pumpRuntime(sessionKey, 2);
    assert.equal(h.gw.adapterMetrics().ttsSentencesSent, 0, "nothing delivered yet (tap not flushed)");

    h.mock.abortSpeaking("conn_tts01", "vad_detected"); // no active playback → no-op
    await feedAll(h);
    await settleAll(h, sessionKey); // the tap now drains: the queued turn plays out

    const metrics = h.gw.adapterMetrics();
    assert.ok(metrics.abortsWithoutPlayback >= 1, "the abort was recorded as the no-playback no-op");
    assert.equal(metrics.ttsStopEffectiveMs.count, 0, "no playback stop was measured (no fence, no epoch bump)");
    assert.equal(metrics.ttsTurnsPlayed, 1, "the queued turn still played exactly once");
    assert.equal(metrics.ttsStaleAudioSuppressed, 0, "no queue items were dropped (the abort was a no-op)");
    const turns = h.gw.stack.orchestrator.listTurns(sessionKey);
    assert.ok(turns.every((turn) => isTerminal(turn.state)), "no deadlock: all turns terminal");
    assert.equal(turns[0]?.state, "COMPLETED", "the non-fenced turn settled COMPLETED");
    const clean = leakScanClean(h, MARKER);
    assert.ok(clean, "the transcript appears on no content-free surface");
  } finally {
    await h.stop();
  }
});

// ---------------------------------------------------------------------------
// Deterministic suppression accounting on a scripted core port (same idiom
// as adapter.spec.ts — the real stack drains the queue at event-flush
// boundaries, so the exact counter math is asserted here).
// ---------------------------------------------------------------------------

const SESSION = "sessmock-000001-0001";
/** Fresh per-connection xiaozhi session id for the reconnect episode test. */
const SESSION_RECONNECT = "sessmock-000001-0002";

function testAsrFingerprint(text: string): string {
  return gatewayContentDigest(`test-key\u0000${text}`);
}

interface ScriptedDrain {
  deliverable: readonly { readonly itemId: string; readonly turnId: string; readonly epoch: number }[];
  droppedStale: number;
}

function createScriptedCore(
  opts: { readonly bargeInRefusesWith?: "cancel_unknown_turn" | "stale_turn_rejected" | "turn_terminal" } = {},
) {
  const epochBox = { epoch: 1 };
  const drain: ScriptedDrain = { deliverable: [], droppedStale: 0 };
  const core: GatewayCorePort = {
    async openCoreSession() {
      return { ok: true, recovered: false, continued: false };
    },
    async submitPrompt() {
      return { ok: true, turnId: "trn_tts000000001", dispatched: true };
    },
    async bargeIn() {
      if (opts.bargeInRefusesWith !== undefined) {
        // Fence-unknown abort (review R1 test gap): the trusted core refuses
        // the barge-in; the adapter must resolve the device stop from the
        // turn's terminal state WITHOUT a second epoch bump or a drain.
        return { ok: false as const, code: opts.bargeInRefusesWith, fenced: false };
      }
      epochBox.epoch += 1; // the fence bumps the trusted epoch
      return { ok: true };
    },
    currentEpoch: () => epochBox.epoch,
    describeTurn: (_sessionKey, _turnId): { readonly state: VoiceTurnState; readonly epoch: number } => {
      return { state: "CANCELLED", epoch: epochBox.epoch };
    },
    fenceAudioSend(refs) {
      return refs.epoch === epochBox.epoch ? { ok: true } : { ok: false, code: "stale_turn_rejected" };
    },
    drainTts() {
      return { ok: true, deliverable: drain.deliverable, droppedStale: drain.droppedStale };
    },
    sweepTimeouts() {
      return { ok: true, timedOutTurnIds: [] };
    },
  };
  return { core, epochBox, drain };
}

test("the stale-audio suppression counter accounts fenced batches AND dropped queue items (deterministic)", async () => {
  const scripted = createScriptedCore();
  const directives: GatewayDeviceDirective[] = [];
  let nowMs = 1_000;
  const clock = () => {
    nowMs += 1;
    return nowMs;
  };
  const binding = createGatewayDeviceBindingRegistry({ clock });
  const adapter = createVoiceGatewayAdapter({
    core: scripted.core,
    binding,
    asrFingerprint: testAsrFingerprint,
    clock,
    framesPerSentence: 4,
    sink: (directive) => directives.push(directive),
  });
  adapter.bindDevice({ deviceId: DEVICE, actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION });
  await adapter.handleDeviceEvent("conn1", { kind: "hello", deviceId: DEVICE, clientDigest: ACTIVATION, audioParams: { format: "opus", sampleRate: 24_000, channels: 1, frameDurationMs: 60 } });
  await adapter.handleDeviceEvent("conn1", { kind: "session_issued", xiaozhiSessionId: SESSION });

  // Phase A — a final is accepted and its first sentences are delivered.
  const finalOutcome = await adapter.handleDeviceEvent("conn1", { kind: "asr_final", xiaozhiSessionId: SESSION, text: "第一句。" });
  assert.ok(finalOutcome.ok);
  scripted.drain.deliverable = [{ itemId: "item-s1", turnId: "trn_tts000000001", epoch: 1 }];
  scripted.drain.droppedStale = 0;
  const pumped = adapter.pumpPlayback(`ses_gw${gatewayContentDigest(`${DEVICE}|${CONVERSATION}`)}`);
  assert.ok(pumped.ok && pumped.sent === 1);
  const metricsA: Readonly<GatewayMetricsSnapshot> = adapter.metricsSnapshot();
  assert.equal(metricsA.ttsTurnsPlayed, 1);
  assert.equal(metricsA.ttsFirstAudioMs.count, 1, "first-audio measured against the accepted final");

  // Phase B — abort fences (epoch bump); the core reports 3 dropped queue items.
  scripted.drain.deliverable = [];
  scripted.drain.droppedStale = 3;
  const abortOutcome = await adapter.handleDeviceEvent("conn1", { kind: "abort", xiaozhiSessionId: SESSION, reason: "manual" });
  assert.ok(abortOutcome.ok);
  const metricsB = adapter.metricsSnapshot();
  assert.equal(metricsB.ttsStaleAudioSuppressed, 3, "dropped-stale queue items are counted");
  assert.equal(metricsB.ttsStopEffectiveMs.count, 1, "the stop-effective latency was measured");

  // Phase C — a late old-epoch batch reaches the send path and is fenced.
  scripted.drain.deliverable = [{ itemId: "item-stale", turnId: "trn_tts000000001", epoch: 1 }];
  scripted.drain.droppedStale = 0;
  const pumpedLate = adapter.pumpPlayback(`ses_gw${gatewayContentDigest(`${DEVICE}|${CONVERSATION}`)}`);
  assert.ok(pumpedLate.ok && pumpedLate.staleRejected === 1);
  const metricsC = adapter.metricsSnapshot();
  assert.equal(metricsC.ttsStaleAudioSuppressed, 4, "fenced batches are counted too (3 dropped + 1 fenced)");
  assert.equal(metricsC.staleFramesRejected, 1);
  // Nothing was delivered after the stop: the directive log ends with the stop.
  const lastFramesIdx = directives.map((d) => d.kind).lastIndexOf("tts.frames");
  const stopIdx = directives.findIndex((d) => d.kind === "tts.stop");
  assert.ok(stopIdx > lastFramesIdx, "no frame batch was emitted after the stop directive");
  // The hello-negotiated downlink sample rate (24 kHz here) is recorded.
  const mapping = adapter.mappingSnapshot().find((entry) => entry.deviceId === DEVICE);
  assert.ok(mapping && mapping.downlinkSampleRate === 24_000);
});

test("a fence-unknown abort resolves the device stop from the terminal turn state (describeTurn path, deterministic)", async () => {
  const scripted = createScriptedCore({ bargeInRefusesWith: "turn_terminal" });
  const directives: GatewayDeviceDirective[] = [];
  let nowMs = 1_000;
  const clock = () => {
    nowMs += 1;
    return nowMs;
  };
  const binding = createGatewayDeviceBindingRegistry({ clock });
  const adapter = createVoiceGatewayAdapter({
    core: scripted.core,
    binding,
    asrFingerprint: testAsrFingerprint,
    clock,
    framesPerSentence: 4,
    sink: (directive) => directives.push(directive),
  });
  adapter.bindDevice({ deviceId: DEVICE, actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION });
  await adapter.handleDeviceEvent("conn1", { kind: "hello", deviceId: DEVICE, clientDigest: ACTIVATION, audioParams: { format: "opus", sampleRate: 24_000, channels: 1, frameDurationMs: 60 } });
  await adapter.handleDeviceEvent("conn1", { kind: "session_issued", xiaozhiSessionId: SESSION });

  // The playback binding is live (the delivery below sets state.playback),
  // but the trusted core REFUSES the barge-in (fence unknown: the turn
  // already settled CANCELLED in the trusted store — the scripted
  // describeTurn returns CANCELLED while the device still tracks playback).
  const finalOutcome = await adapter.handleDeviceEvent("conn1", { kind: "asr_final", xiaozhiSessionId: SESSION, text: "第一句。" });
  assert.ok(finalOutcome.ok);
  scripted.drain.deliverable = [{ itemId: "item-s1", turnId: "trn_tts000000001", epoch: 1 }];
  const sessionKey = `ses_gw${gatewayContentDigest(`${DEVICE}|${CONVERSATION}`)}`;
  const pumped = adapter.pumpPlayback(sessionKey);
  assert.ok(pumped.ok && pumped.sent === 1);
  assert.equal(adapter.metricsSnapshot().ttsStopEffectiveMs.count, 0, "no measure before the abort");

  const abortOutcome = await adapter.handleDeviceEvent("conn1", { kind: "abort", xiaozhiSessionId: SESSION, reason: "manual" });
  assert.ok(abortOutcome.ok);

  // The SECOND stop-measure count point (the fence-unknown branch resolving
  // the stop from describeTurn's terminal state) measured the latency.
  const metrics = adapter.metricsSnapshot();
  assert.equal(metrics.ttsStopEffectiveMs.count, 1, "the stop-effective latency was measured on the describeTurn path too");
  assert.ok(Number.isFinite(metrics.ttsStopEffectiveMs.maxMs), "the measure is a real number, never hardcoded");
  assert.equal(metrics.playbackStopsIssued, 1, "the device stop was issued exactly once");
  assert.equal(metrics.abortsWithoutPlayback, 1, "the fence-unknown abort is recorded as the no-fence abort kind");
  assert.equal(scripted.epochBox.epoch, 1, "a refused barge-in does NOT bump the trusted epoch (no second fence)");
  assert.equal(metrics.ttsStaleAudioSuppressed, 0, "no drain ran on this path");
  assert.ok(!directives.some((directive) => directive.kind === "tts.clear"), "no tts.clear was emitted");
  const stopIdx = directives.findIndex((directive) => directive.kind === "tts.stop" && directive.turnId === "trn_tts000000001");
  assert.ok(stopIdx >= 0, "the device stop names the interrupted turn");
  assert.equal(
    directives.slice(stopIdx + 1).filter((directive) => directive.kind === "tts.stop" && directive.turnId === "trn_tts000000001").length,
    0,
    "the stop stays exactly-once",
  );
});

test("mid-turn disconnect then reconnect: the resumed delivery of the same turn is a new episode (ttsTurnsPlayed counts delivery episodes, 断线/重连)", async () => {
  const scripted = createScriptedCore();
  const directives: GatewayDeviceDirective[] = [];
  let nowMs = 1_000;
  const clock = () => {
    nowMs += 1;
    return nowMs;
  };
  const binding = createGatewayDeviceBindingRegistry({ clock });
  const adapter = createVoiceGatewayAdapter({
    core: scripted.core,
    binding,
    asrFingerprint: testAsrFingerprint,
    clock,
    framesPerSentence: 4,
    sink: (directive) => directives.push(directive),
  });
  adapter.bindDevice({ deviceId: DEVICE, actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION });
  await adapter.handleDeviceEvent("conn1", { kind: "hello", deviceId: DEVICE, clientDigest: ACTIVATION, audioParams: { format: "opus", sampleRate: 24_000, channels: 1, frameDurationMs: 60 } });
  await adapter.handleDeviceEvent("conn1", { kind: "session_issued", xiaozhiSessionId: SESSION });

  // Episode 1: the turn's first sentence batch reaches the device sink.
  const finalOutcome = await adapter.handleDeviceEvent("conn1", { kind: "asr_final", xiaozhiSessionId: SESSION, text: "第一句。" });
  assert.ok(finalOutcome.ok);
  scripted.drain.deliverable = [{ itemId: "item-s1", turnId: "trn_tts000000001", epoch: 1 }];
  const sessionKey = `ses_gw${gatewayContentDigest(`${DEVICE}|${CONVERSATION}`)}`;
  const pumpedA = adapter.pumpPlayback(sessionKey);
  assert.ok(pumpedA.ok && pumpedA.sent === 1);
  const metricsA = adapter.metricsSnapshot();
  assert.equal(metricsA.ttsTurnsPlayed, 1);
  assert.equal(metricsA.ttsFirstAudioMs.count, 1);

  // Mid-turn disconnect: the transport fault suspends the playback binding
  // (gateway.playback_suspended) while the trusted turn is still alive.
  const dropped = await adapter.handleDeviceEvent("conn1", { kind: "connection_dropped", reason: "network" });
  assert.ok(dropped.ok);
  assert.equal(adapter.metricsSnapshot().suspensions, 1, "the disconnect suspended the playback binding");
  const blocked = adapter.pumpPlayback(sessionKey);
  assert.ok(!blocked.ok && blocked.code === "connection_closed", "the closed connection cannot deliver");

  // Reconnect: the SAME trusted session continues on the new connection
  // (fresh per-connection xiaozhi session id, renegotiated audio shape).
  await adapter.handleDeviceEvent("conn2", { kind: "hello", deviceId: DEVICE, clientDigest: ACTIVATION, audioParams: { format: "opus", sampleRate: 24_000, channels: 1, frameDurationMs: 60 } });
  await adapter.handleDeviceEvent("conn2", { kind: "session_issued", xiaozhiSessionId: SESSION_RECONNECT });
  scripted.drain.deliverable = [{ itemId: "item-s2", turnId: "trn_tts000000001", epoch: 1 }];
  const pumpedB = adapter.pumpPlayback(sessionKey);
  assert.ok(pumpedB.ok && pumpedB.sent === 1, "the resumed delivery reaches the device sink again");

  // The documented episode semantics (review R1 P2-3): the SAME turnId's
  // resumed delivery counts as a NEW ttsTurnsPlayed episode and re-issues
  // tts.start, while first-audio stays single-shot per accepted final.
  // Candidate baseline metric: audit the count as delivery episodes, not
  // unique turns.
  const metricsB = adapter.metricsSnapshot();
  assert.equal(metricsB.ttsTurnsPlayed, 2, "resumed delivery of the same turnId = a new delivery episode");
  assert.equal(metricsB.ttsSentencesSent, 2);
  assert.equal(metricsB.ttsFramesSent, 8);
  assert.equal(metricsB.ttsFirstAudioMs.count, 1, "first-audio is single-shot per accepted final");
  const starts = directives.filter((directive) => directive.kind === "tts.start" && directive.turnId === "trn_tts000000001");
  assert.equal(starts.length, 2, "each delivery episode re-issues tts.start for the same turnId");
});

test("the adapter version bump is observable for the E2E-06 TTS metrics semantics", () => {
  // A cheap contract pin: TTS metrics are v1.3 adapter behavior (dedup
  // semantics originated in v1.2 and are unchanged); a future reader
  // comparing evidence across versions sees which semantics produced it.
  assert.equal(GATEWAY_ADAPTER_VERSION, "1.3");
});
