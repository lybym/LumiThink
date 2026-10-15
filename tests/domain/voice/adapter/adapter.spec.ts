import assert from "node:assert/strict";
import test from "node:test";

/**
 * R1-V3 gateway adapter behavior tests (issue #30 实现范围 1: ASR
 * final/partial、client_abort、播放停止、TTS 队列清空、Opus 发送与
 * Session/turn/epoch 映射).
 *
 * The Adapter is exercised against a scripted in-memory core port so each
 * behavior is isolated; the FULL Adapter/Core/DSH integration (incl. fault
 * injection) runs in fault-injection.spec.ts over the real composition.
 */

import { createGatewayDeviceBindingRegistry } from "../../../../lib/domain/voice/adapter/binding.ts";
import { createVoiceGatewayAdapter, gatewayContentDigest, type GatewayCorePort } from "../../../../lib/domain/voice/adapter/gateway-adapter.ts";
import type { GatewayDeviceDirective } from "../../../../lib/domain/voice/adapter/protocol.ts";

const DEVICE = "aabbccddeeff0011";
const ACTOR = "act_owner0001";
const CONVERSATION = "conv_child0001";
const ACTIVATION = "0123456789abcdef0123456789abcdef";
const SESSION = "sessmock-000001-0001";
/** The session key the adapter derives for this (device, conversation) pair. */
const SESSION_KEY = `ses_gw${gatewayContentDigest(`${DEVICE}|${CONVERSATION}`)}`;

interface CoreCall {
  readonly op: string;
  readonly refs: unknown;
}

interface FakeCoreOptions {
  readonly submitResult?: { readonly ok: true; readonly turnId: string; readonly dispatched: boolean } | { readonly ok: false; readonly code: string };
  readonly bargeInResult?: { readonly ok: true } | { readonly ok: false; readonly code: string; readonly fenced: boolean };
  readonly fenceResult?: { readonly ok: true } | { readonly ok: false; readonly code: string };
  readonly queue?: readonly { readonly itemId: string; readonly turnId: string; readonly epoch: number }[];
  readonly droppedStale?: number;
}

function createFakeCore(options: FakeCoreOptions = {}) {
  const calls: CoreCall[] = [];
  let epoch = 1;
  const core: GatewayCorePort = {
    async openCoreSession(refs) {
      calls.push({ op: "openCoreSession", refs });
      return { ok: true, recovered: false, continued: false };
    },
    async submitPrompt(refs) {
      calls.push({ op: "submitPrompt", refs });
      return options.submitResult ?? { ok: true, turnId: "trn_fake000000001", dispatched: true };
    },
    async bargeIn(refs) {
      calls.push({ op: "bargeIn", refs });
      return options.bargeInResult ?? { ok: true };
    },
    currentEpoch: (sessionKey) => {
      calls.push({ op: "currentEpoch", refs: { sessionKey } });
      return epoch;
    },
    describeTurn: (sessionKey, turnId) => {
      calls.push({ op: "describeTurn", refs: { sessionKey, turnId } });
      return { state: "RUNNING", epoch };
    },
    fenceAudioSend(refs) {
      calls.push({ op: "fenceAudioSend", refs });
      return options.fenceResult ?? { ok: true };
    },
    drainTts(sessionKey) {
      calls.push({ op: "drainTts", refs: { sessionKey } });
      return {
        ok: true,
        deliverable: options.queue ?? [],
        droppedStale: options.droppedStale ?? 0,
      };
    },
    sweepTimeouts(refs) {
      calls.push({ op: "sweepTimeouts", refs });
      return { ok: true, timedOutTurnIds: ["trn_fake000000001"] };
    },
  };
  return {
    core,
    calls,
    bumpEpoch: () => {
      epoch += 1;
    },
  };
}

interface Harness {
  readonly adapter: ReturnType<typeof buildAdapter>;
  readonly core: ReturnType<typeof createFakeCore>["core"];
  readonly calls: CoreCall[];
  readonly directives: GatewayDeviceDirective[];
  readonly bumpEpoch: () => void;
}

function buildAdapter(fake: ReturnType<typeof createFakeCore>, clock: () => number, sink: (d: GatewayDeviceDirective) => void) {
  const binding = createGatewayDeviceBindingRegistry({ clock });
  const adapter = createVoiceGatewayAdapter({
    core: fake.core,
    binding,
    clock,
    framesPerSentence: 4,
    sink,
  });
  adapter.bindDevice({ deviceId: DEVICE, actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION });
  return adapter;
}

async function createHarness(fakeOptions: FakeCoreOptions = {}): Promise<Harness> {
  const fake = createFakeCore(fakeOptions);
  const directives: GatewayDeviceDirective[] = [];
  let nowMs = 1_000;
  const adapter = buildAdapter(fake, () => nowMs, (directive) => directives.push(directive));
  // Connect + issue session (the standard entry).
  await adapter.handleDeviceEvent("conn1", { kind: "hello", deviceId: DEVICE, clientDigest: null, audioParams: null });
  await adapter.handleDeviceEvent("conn1", { kind: "session_issued", xiaozhiSessionId: SESSION });
  return {
    adapter,
    core: fake.core,
    calls: fake.calls,
    directives,
    bumpEpoch: fake.bumpEpoch,
  };
}

test("ASR final is digested: the transcript never reaches the core, audit or directives", async () => {
  const h = await createHarness();
  const text = "我们先找已知条件。";
  const outcome = await h.adapter.handleDeviceEvent("conn1", { kind: "asr_final", xiaozhiSessionId: SESSION, text });
  assert.ok(outcome.ok);
  const submit = h.calls.find((call) => call.op === "submitPrompt");
  assert.ok(submit);
  const refs = submit.refs as { readonly fingerprint: string; readonly idempotencyKey: string; readonly sessionKey: string };
  assert.equal(refs.fingerprint, gatewayContentDigest(text));
  assert.equal(refs.sessionKey, SESSION_KEY);
  assert.match(refs.idempotencyKey, /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/);
  // The transcript text appears NOWHERE outside the call frame.
  const auditJson = JSON.stringify(h.adapter.auditSnapshot());
  const directiveJson = JSON.stringify(h.directives);
  assert.ok(!auditJson.includes(text));
  assert.ok(!directiveJson.includes(text));
  assert.ok(auditJson.includes(gatewayContentDigest(text)), "the digest is the only trace");
});

test("ASR partial never submits a prompt but counts as an interrupt candidate during playback", async () => {
  const h = await createHarness();
  await h.adapter.handleDeviceEvent("conn1", { kind: "asr_partial", xiaozhiSessionId: SESSION, text: "我们先找" });
  assert.equal(h.calls.filter((call) => call.op === "submitPrompt").length, 0);
  assert.equal(h.adapter.metricsSnapshot().asrPartialsSeen, 1);
  assert.equal(h.adapter.metricsSnapshot().interruptCandidates, 0);
  // With playback active, the partial is a candidate — and STILL not a fence.
  await h.adapter.pumpPlayback(SESSION_KEY); // no queue → no playback binding
  const outcome = await h.adapter.handleDeviceEvent("conn1", { kind: "asr_final", xiaozhiSessionId: SESSION, text: "完整的话。" });
  assert.ok(outcome.ok);
  // Simulate playback bound via a drained queue.
  const h2 = await createHarness({ queue: [{ itemId: "tts_item000001", turnId: "trn_fake000000001", epoch: 1 }] });
  await h2.adapter.pumpPlayback(SESSION_KEY);
  await h2.adapter.handleDeviceEvent("conn1", { kind: "asr_partial", xiaozhiSessionId: SESSION, text: "打断候选" });
  assert.equal(h2.adapter.metricsSnapshot().interruptCandidates, 1);
  assert.equal(h2.calls.filter((call) => call.op === "bargeIn").length, 0);
});

test("client_abort with no active playback is an enumerated no-op (no epoch bump, no stop)", async () => {
  const h = await createHarness();
  const outcome = await h.adapter.handleDeviceEvent("conn1", { kind: "abort", xiaozhiSessionId: SESSION, reason: "wake_word_detected" });
  assert.ok(outcome.ok);
  assert.equal(h.calls.filter((call) => call.op === "bargeIn").length, 0);
  assert.equal(h.adapter.metricsSnapshot().abortsWithoutPlayback, 1);
  assert.equal(h.adapter.metricsSnapshot().playbackStopsIssued, 0);
  assert.equal(h.directives.filter((d) => d.kind === "tts.stop").length, 0);
});

test("client_abort during playback fences first, then stops playback and clears the queue exactly once", async () => {
  const h = await createHarness({
    queue: [{ itemId: "tts_item000001", turnId: "trn_fake000000001", epoch: 1 }],
    droppedStale: 2,
  });
  // Bind playback.
  const pumped = await h.adapter.pumpPlayback(SESSION_KEY);
  assert.ok(pumped.ok && pumped.sent === 1);
  assert.equal(h.directives.filter((d) => d.kind === "tts.start").length, 1);
  const frames = h.directives.filter((d) => d.kind === "tts.frames");
  assert.equal(frames.length, 1);
  if (frames[0].kind === "tts.frames") {
    assert.equal(frames[0].frameCount, 4);
    assert.equal(frames[0].epoch, 1);
    assert.equal(frames[0].audioDigest, gatewayContentDigest("tts_item000001"));
  }
  // The device aborts.
  const outcome = await h.adapter.handleDeviceEvent("conn1", { kind: "abort", xiaozhiSessionId: SESSION, reason: "manual" });
  assert.ok(outcome.ok);
  const bargeIns = h.calls.filter((call) => call.op === "bargeIn");
  assert.equal(bargeIns.length, 1, "the fence happens through the core, exactly once");
  const stop = h.directives.find((d) => d.kind === "tts.stop");
  assert.ok(stop && stop.kind === "tts.stop");
  assert.equal(stop.reason, "interrupted");
  assert.equal(stop.turnId, "trn_fake000000001");
  assert.equal(h.adapter.metricsSnapshot().playbackStopsIssued, 1);
  assert.equal(h.adapter.metricsSnapshot().abortsFenced, 1);
  // A SECOND consecutive abort without new playback is a no-op.
  const second = await h.adapter.handleDeviceEvent("conn1", { kind: "abort", xiaozhiSessionId: SESSION, reason: "manual" });
  assert.ok(second.ok);
  assert.equal(h.calls.filter((call) => call.op === "bargeIn").length, 1);
  assert.equal(h.adapter.metricsSnapshot().playbackStopsIssued, 1, "no duplicate stop");
});

test("every outbound frame batch is re-fenced; stale batches never leave", async () => {
  const h = await createHarness({
    queue: [
      { itemId: "tts_item000001", turnId: "trn_old000000001", epoch: 1 },
      { itemId: "tts_item000002", turnId: "trn_cur000000002", epoch: 2 },
    ],
  });
  h.bumpEpoch(); // trusted epoch moved on: epoch-1 batches are stale now
  const pumped = await h.adapter.pumpPlayback(SESSION_KEY);
  assert.ok(pumped.ok);
  assert.equal(pumped.sent, 1, "only the current-epoch batch is sent");
  assert.equal(pumped.staleRejected, 1, "the stale batch is fenced");
  const frames = h.directives.filter((d) => d.kind === "tts.frames");
  assert.equal(frames.length, 1);
  if (frames[0].kind === "tts.frames") {
    assert.equal(frames[0].epoch, 2);
  }
  assert.ok(h.directives.every((d) => d.kind !== "tts.start" || d.epoch === 2));
  assert.equal(h.adapter.metricsSnapshot().staleFramesRejected, 1);
});

test("an audio fence refusal at the core drops the batch even at the current epoch", async () => {
  const h = await createHarness({
    queue: [{ itemId: "tts_item000001", turnId: "trn_fake000000001", epoch: 1 }],
    fenceResult: { ok: false, code: "turn_terminal" },
  });
  const pumped = await h.adapter.pumpPlayback(SESSION_KEY);
  assert.ok(pumped.ok && pumped.sent === 0 && pumped.staleRejected === 1);
  assert.equal(h.directives.filter((d) => d.kind === "tts.frames").length, 0);
});

test("turn settlement emits exactly one playback stop with the mapped reason", async () => {
  const h = await createHarness({ queue: [{ itemId: "tts_item000001", turnId: "trn_fake000000001", epoch: 1 }] });
  await h.adapter.pumpPlayback(SESSION_KEY);
  h.adapter.noteTurnSettled(SESSION_KEY, "trn_fake000000001", "COMPLETED");
  h.adapter.noteTurnSettled(SESSION_KEY, "trn_fake000000001", "COMPLETED"); // duplicate event
  const stops = h.directives.filter((d) => d.kind === "tts.stop");
  assert.equal(stops.length, 1);
  if (stops[0].kind === "tts.stop") {
    assert.equal(stops[0].reason, "completed");
  }
  // Worker fault stop for a bound playback.
  const h2 = await createHarness({ queue: [{ itemId: "tts_item000002", turnId: "trn_fake000000002", epoch: 1 }] });
  await h2.adapter.pumpPlayback(SESSION_KEY);
  h2.adapter.noteWorkerFault(SESSION_KEY);
  const failed = h2.directives.filter((d) => d.kind === "tts.stop");
  assert.equal(failed.length, 1);
  assert.ok(failed[0].kind === "tts.stop" && failed[0].reason === "failed");
});

test("sweep settles timed-out turns and stops their playback", async () => {
  const h = await createHarness({ queue: [{ itemId: "tts_item000001", turnId: "trn_fake000000001", epoch: 1 }] });
  await h.adapter.pumpPlayback(SESSION_KEY);
  const swept = await h.adapter.sweep(SESSION_KEY);
  assert.ok(swept.ok && swept.timedOutTurnIds.length === 1);
  const stops = h.directives.filter((d) => d.kind === "tts.stop");
  assert.equal(stops.length, 1);
  assert.ok(stops[0].kind === "tts.stop" && stops[0].reason === "failed");
});

test("forged session ids and closed connections are rejected before any core call", async () => {
  const h = await createHarness();
  const turnsBefore = h.calls.filter((call) => call.op === "submitPrompt").length;
  const forged = await h.adapter.handleDeviceEvent("conn1", {
    kind: "asr_final",
    xiaozhiSessionId: "sessmock-999999-9999",
    text: "冒用会话。",
  });
  assert.ok(!forged.ok && forged.code === "session_forged");
  assert.equal(h.calls.filter((call) => call.op === "submitPrompt").length, turnsBefore);
  assert.equal(h.adapter.metricsSnapshot().forgedSessionsRefused, 1);
  // After the connection drops, events on it are refused enumerated.
  await h.adapter.handleDeviceEvent("conn1", { kind: "connection_dropped", reason: "network" });
  const dropped = await h.adapter.handleDeviceEvent("conn1", {
    kind: "asr_final",
    xiaozhiSessionId: SESSION,
    text: "掉线之后。",
  });
  assert.ok(!dropped.ok && dropped.code === "connection_unknown", "a closed connection is not an open lease anymore");
  // pumpPlayback without a connection refuses (frames never flow to nowhere).
  const pump = await h.adapter.pumpPlayback(SESSION_KEY);
  assert.ok(!pump.ok && pump.code === "connection_closed");
});

test("reconnect keeps the SAME trusted session and identity, with a fresh session handle", async () => {
  const h = await createHarness();
  // Disconnect, then reconnect on a new connection id.
  await h.adapter.handleDeviceEvent("conn1", { kind: "connection_dropped", reason: "network" });
  await h.adapter.handleDeviceEvent("conn2", { kind: "hello", deviceId: DEVICE, clientDigest: null, audioParams: null });
  await h.adapter.handleDeviceEvent("conn2", { kind: "session_issued", xiaozhiSessionId: "sessmock-000002-0002" });
  const mappings = h.adapter.mappingSnapshot();
  assert.equal(mappings.length, 1);
  const mapping = mappings[0];
  assert.equal(mapping.sessionKey, SESSION_KEY, "the trusted session continues across reconnects");
  assert.equal(mapping.actorId, ACTOR);
  assert.equal(mapping.conversationId, CONVERSATION);
  assert.equal(mapping.xiaozhiSessionId, "sessmock-000002-0002", "a fresh ephemeral handle");
  assert.equal(mapping.connected, true);
  // The final ASR now flows through the new connection.
  const outcome = await h.adapter.handleDeviceEvent("conn2", {
    kind: "asr_final",
    xiaozhiSessionId: "sessmock-000002-0002",
    text: "重连之后的话。",
  });
  assert.ok(outcome.ok);
});

test("server restart suspends playback and invalidates mappings without killing the trusted session", async () => {
  const h = await createHarness({ queue: [{ itemId: "tts_item000001", turnId: "trn_fake000000001", epoch: 1 }] });
  await h.adapter.pumpPlayback(SESSION_KEY);
  const restart = await h.adapter.handleDeviceEvent("conn1", { kind: "server_restart" });
  assert.ok(restart.ok);
  assert.equal(h.adapter.metricsSnapshot().suspensions, 1);
  assert.equal(h.directives.filter((d) => d.kind === "tts.stop").length, 0, "no stop to a dead connection");
  const mapping = h.adapter.mappingSnapshot()[0];
  assert.equal(mapping.connected, false);
  assert.equal(mapping.xiaozhiSessionId, null);
  assert.equal(mapping.sessionKey, SESSION_KEY, "the trusted session survives the server restart");
  // The old session id can no longer authorize anything.
  await h.adapter.handleDeviceEvent("conn2", { kind: "hello", deviceId: DEVICE, clientDigest: null, audioParams: null });
  const stale = await h.adapter.handleDeviceEvent("conn2", {
    kind: "asr_final",
    xiaozhiSessionId: SESSION,
    text: "重启前的话。",
  });
  assert.ok(!stale.ok, "the stale handle is not authorized");
});

test("malformed events fail closed without touching the core", async () => {
  const h = await createHarness();
  const callsBefore = h.calls.length;
  const bad = await h.adapter.handleDeviceEvent("conn1", { kind: "explode" });
  assert.ok(!bad.ok && bad.code === "gateway.parse_failed");
  const badConn = await h.adapter.handleDeviceEvent("bad connection!", { kind: "server_restart" });
  assert.ok(!badConn.ok && badConn.code === "gateway.parse_failed");
  assert.equal(h.calls.length, callsBefore, "the core was never consulted for malformed input");
});
