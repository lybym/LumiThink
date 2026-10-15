import assert from "node:assert/strict";
import test from "node:test";

/**
 * R1-V3 fault-injection evidence — pure-synthetic, fully replayable
 * (issue #30 实现范围 3 + 验收 1/2; docs/VOICE_GATEWAY_PROTOCOL.md §6).
 *
 * Every family runs over the REAL composed runtime — Voice Gateway Adapter
 * (device edge) + R1-V1 trusted Orchestrator + R1-V2 Bridge + synthetic
 * Cordis runtime + synthetic xiaozhi device/server mock — with the
 * deterministic in-process transport (the real-socket path is exercised by
 * the R1-V2 suites on POSIX CI).
 *
 * Families (one per issue-required fault):
 *   late_asr / consecutive_abort / server_restart / out_of_order_output /
 *   network_drop_reconnect / duplicate_connection / forged_identity.
 *
 * Invariants asserted for EVERY scenario:
 *   - all trusted turns terminal (no deadlock, no resurrection);
 *   - NO accepted device frame batch occurs after the device-applied stop of
 *     its turn (旧响应泄漏 0: after an interruption nothing old ever plays;
 *     everything else was refused by the device epoch check or fenced at
 *     the audio_send gate);
 *   - the union of ALL audit rings is content-free (no transcript text);
 *   - in-process agent cancels happen at most once per cancelled turn.
 */

import { createVoiceGatewayStack, type VoiceGatewayStack } from "../../../../lib/server/voice-gateway-composition.ts";
import { createMockXiaozhiGateway, type MockXiaozhiGateway } from "../../../../lib/domain/voice/adapter/mock-xiaozhi.ts";
import { GATEWAY_SYNTHETIC_SENTENCES, buildSanitizedReport, findReportContentLeaks, type GatewayFixtureFamily } from "../../../../lib/domain/voice/adapter/fixtures.ts";
import { mulberry32, randomInt, pick, createTurnIdFactory, createVirtualClock } from "../helpers.ts";

const TERMINAL_STATES: readonly string[] = ["COMPLETED", "CANCELLED", "FAILED", "TIMED_OUT"];
const SCENARIOS_PER_FAMILY = 8;

// ---------------------------------------------------------------------------
// Deterministic generation script (child-safe synthetic samples only)
// ---------------------------------------------------------------------------

function scriptFor(sessionKey: string, turnId: string) {
  const seedHex = sessionKey.slice(6, 14) + "00";
  const rng = mulberry32(parseInt(seedHex, 16) >>> 0);
  const count = 2 + randomInt(rng, 2);
  const fragments = [];
  for (let i = 0; i < count; i += 1) {
    fragments.push({ channel: "text" as const, text: pick(rng, GATEWAY_SYNTHETIC_SENTENCES) });
    if (randomInt(rng, 3) === 0) {
      fragments.push({ channel: "tool_call" as const, text: '{"tool":"memory.lookup"}' });
    }
  }
  return fragments;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  readonly gw: VoiceGatewayStack;
  readonly mock: MockXiaozhiGateway;
  readonly seed: number;
  stop(): Promise<void>;
}

function createHarness(seed: number): Harness {
  const mock = createMockXiaozhiGateway();
  const gw = createVoiceGatewayStack({
    scriptFor,
    transport: "in_process",
    framesPerSentence: 4,
    turnIdFactory: createTurnIdFactory(seed),
    clock: createVirtualClock().now,
    directiveSink: (directive) => {
      mock.applyDirective(directive);
    },
  });
  return {
    gw,
    mock,
    seed,
    stop: () => gw.stop(),
  };
}

/** Flush the in-process event queue: Bridge events are delivered in
 * microtasks behind the client's ordered queue — a macrotask tick flushes
 * all of them deterministically (no wall-clock dependence). */
function flushEventQueue(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function feedAll(harness: Harness): Promise<{ readonly accepted: number; readonly rejected: number }> {
  let accepted = 0;
  let rejected = 0;
  for (;;) {
    const batch = harness.mock.flushAll();
    if (batch.length === 0) {
      break;
    }
    for (const { connectionId, event } of batch) {
      const outcome = await harness.gw.handleDeviceEvent(connectionId, event);
      if (outcome.ok) {
        accepted += 1;
        if (event.kind === "session_issued" && typeof outcome.sessionKey === "string") {
          harness.mock.bindSession(connectionId, outcome.sessionKey);
        }
      } else {
        rejected += 1;
      }
    }
  }
  return { accepted, rejected };
}

async function connectDevice(
  harness: Harness,
  deviceId: string,
  connectionId: string,
): Promise<{ readonly sessionKey: string; readonly handle: string }> {
  // Guardian-issued binding (activation digest only — the secret never appears).
  const bound = harness.gw.bindDevice({
    deviceId,
    actorId: "act_owner0001",
    conversationId: "conv_child0001",
    activationDigest: "0123456789abcdef0123456789abcdef",
  });
  assert.ok(bound.ok, `seed ${harness.seed}: guardian binding must succeed`);
  harness.mock.connect({ connectionId, deviceId });
  await feedAll(harness);
  const sessionKey = harness.gw.findSessionKeyByDevice(deviceId);
  assert.ok(sessionKey, `seed ${harness.seed}: device binding must yield a trusted session`);
  const handle = harness.mock.serverAccept(connectionId);
  await feedAll(harness);
  return { sessionKey, handle };
}

/** Dispatch synthetic runtime output and let every Bridge event settle. */
async function pumpAndFlush(harness: Harness, sessionKey: string, max = 200): Promise<void> {
  harness.gw.stack.pumpRuntime(sessionKey, max);
  await flushEventQueue();
}

/** Drive the session to a terminal state: each round dispatches the running
 * turn's remaining output; the settled event dispatches the next queued
 * turn. BOUNDED rounds — a stuck turn is a real deadlock and fails the
 * non-terminal invariant instead of hanging. */
async function settleAll(harness: Harness, sessionKey: string): Promise<void> {
  for (let round = 0; round < 16; round += 1) {
    await pumpAndFlush(harness, sessionKey);
    const nonTerminal = harness.gw.stack.orchestrator
      .listTurns(sessionKey)
      .filter((turn) => !TERMINAL_STATES.includes(turn.state));
    if (nonTerminal.length === 0) {
      break;
    }
  }
  harness.gw.pumpPlayback(sessionKey);
  await flushEventQueue();
}

// ---------------------------------------------------------------------------
// Per-family scenario runners
// ---------------------------------------------------------------------------

async function runLateAsr(harness: Harness, deviceId: string, connectionId: string, rng: () => number): Promise<string[]> {
  const { sessionKey } = await connectDevice(harness, deviceId, connectionId);
  harness.mock.speakFinal(connectionId, pick(rng, GATEWAY_SYNTHETIC_SENTENCES));
  await feedAll(harness);
  await pumpAndFlush(harness, sessionKey, 2 + randomInt(rng, 2));
  harness.gw.pumpPlayback(sessionKey);
  if (rng() < 0.5) {
    // Pre-fence late ASR: the new final is registered at the OLD epoch and
    // must be fenced together with the interrupted turn — never dispatched.
    harness.mock.speakFinal(connectionId, pick(rng, GATEWAY_SYNTHETIC_SENTENCES));
    harness.mock.abortSpeaking(connectionId, "wake_word_detected");
  } else {
    // Post-fence late ASR: the final arrives after the fence and completes.
    harness.mock.abortSpeaking(connectionId, "wake_word_detected");
  }
  await feedAll(harness);
  await settleAll(harness, sessionKey);
  harness.mock.speakFinal(connectionId, pick(rng, GATEWAY_SYNTHETIC_SENTENCES));
  await feedAll(harness);
  await settleAll(harness, sessionKey);
  return [sessionKey];
}

async function runConsecutiveAbort(harness: Harness, deviceId: string, connectionId: string, rng: () => number): Promise<string[]> {
  const { sessionKey } = await connectDevice(harness, deviceId, connectionId);
  for (let round = 0; round < 2; round += 1) {
    harness.mock.speakFinal(connectionId, pick(rng, GATEWAY_SYNTHETIC_SENTENCES));
    await feedAll(harness);
    await pumpAndFlush(harness, sessionKey, 2 + randomInt(rng, 2));
    harness.gw.pumpPlayback(sessionKey);
    harness.mock.abortSpeaking(connectionId, round === 0 ? "wake_word_detected" : "manual");
    await feedAll(harness);
    // Consecutive abort with nothing playing: enumerated no-op.
    harness.mock.abortSpeaking(connectionId, "manual");
    await feedAll(harness);
  }
  const metrics = harness.gw.adapterMetrics();
  assert.equal(metrics.abortsFenced, 2, `seed ${harness.seed}: exactly one fence per playback turn`);
  assert.ok(metrics.abortsWithoutPlayback >= 2, `seed ${harness.seed}: no-playback aborts are no-ops`);
  assert.ok(metrics.playbackStopsIssued <= 2, `seed ${harness.seed}: no duplicate stop directives`);
  harness.mock.speakFinal(connectionId, pick(rng, GATEWAY_SYNTHETIC_SENTENCES));
  await feedAll(harness);
  await settleAll(harness, sessionKey);
  return [sessionKey];
}

async function runServerRestart(harness: Harness, deviceId: string, connectionId: string, rng: () => number): Promise<string[]> {
  const { sessionKey, handle } = await connectDevice(harness, deviceId, connectionId);
  harness.mock.speakFinal(connectionId, pick(rng, GATEWAY_SYNTHETIC_SENTENCES));
  await feedAll(harness);
  await pumpAndFlush(harness, sessionKey, 2 + randomInt(rng, 2));
  harness.gw.pumpPlayback(sessionKey);
  // The self-hosted server restarts: every session id is invalidated.
  harness.mock.restartServer();
  await feedAll(harness);
  assert.ok(harness.gw.adapterMetrics().suspensions >= 1, `seed ${harness.seed}: playback suspended`);
  // The stale handle must not authorize anything anymore.
  const stale = await harness.gw.handleDeviceEvent(connectionId, {
    kind: "asr_final",
    xiaozhiSessionId: handle,
    text: pick(rng, GATEWAY_SYNTHETIC_SENTENCES),
  });
  assert.ok(!stale.ok, `seed ${harness.seed}: the pre-restart session id must be refused`);
  // Reconnect on a NEW connection: trusted session and identity continue.
  const reconnectId = `${connectionId}_r2`;
  harness.mock.connect({ connectionId: reconnectId, deviceId });
  await feedAll(harness);
  const newHandle = harness.mock.serverAccept(reconnectId);
  assert.notEqual(newHandle, handle, `seed ${harness.seed}: a fresh session id is minted`);
  await feedAll(harness);
  const mapping = harness.gw.mappingSnapshot().find((entry) => entry.deviceId === deviceId);
  assert.ok(mapping);
  assert.equal(mapping.sessionKey, sessionKey, `seed ${harness.seed}: the trusted session continues`);
  assert.equal(mapping.xiaozhiSessionId, newHandle);
  harness.mock.speakFinal(reconnectId, pick(rng, GATEWAY_SYNTHETIC_SENTENCES));
  await feedAll(harness);
  await settleAll(harness, sessionKey);
  return [sessionKey];
}

async function runOutOfOrderOutput(harness: Harness, deviceId: string, connectionId: string, rng: () => number): Promise<string[]> {
  const { sessionKey } = await connectDevice(harness, deviceId, connectionId);
  harness.mock.speakFinal(connectionId, pick(rng, GATEWAY_SYNTHETIC_SENTENCES));
  await feedAll(harness);
  await pumpAndFlush(harness, sessionKey, 2 + randomInt(rng, 2));
  // Hold the frame batches: the device applies them late / out of order.
  harness.mock.holdFrames(connectionId);
  harness.gw.pumpPlayback(sessionKey);
  if (rng() < 0.5) {
    harness.mock.abortSpeaking(connectionId, "manual");
    await feedAll(harness);
  } else {
    await settleAll(harness, sessionKey);
  }
  harness.gw.pumpPlayback(sessionKey);
  harness.mock.flushDevice(connectionId);
  harness.gw.pumpPlayback(sessionKey);
  await settleAll(harness, sessionKey);
  assert.ok(
    harness.mock.staleFrameRefusals() >= 1,
    `seed ${harness.seed}: the device must refuse held frames after stop/settle`,
  );
  return [sessionKey];
}

async function runNetworkDropReconnect(harness: Harness, deviceId: string, connectionId: string, rng: () => number): Promise<string[]> {
  const { sessionKey } = await connectDevice(harness, deviceId, connectionId);
  harness.mock.speakFinal(connectionId, pick(rng, GATEWAY_SYNTHETIC_SENTENCES));
  await feedAll(harness);
  harness.mock.speakFinal(connectionId, pick(rng, GATEWAY_SYNTHETIC_SENTENCES));
  await feedAll(harness); // the second utterance queues behind the running turn
  await pumpAndFlush(harness, sessionKey, 2 + randomInt(rng, 2));
  // Network drop mid-turn.
  harness.mock.dropConnection(connectionId, "network");
  await feedAll(harness);
  const refused = harness.gw.pumpPlayback(sessionKey);
  assert.ok(!refused.ok && refused.code === "connection_closed", `seed ${harness.seed}: no frames to a dead connection`);
  // The core keeps running independently of the device.
  await settleAll(harness, sessionKey);
  // Trusted rebind on the same device.
  const reconnectId = `${connectionId}_r2`;
  harness.mock.connect({ connectionId: reconnectId, deviceId });
  await feedAll(harness);
  harness.mock.serverAccept(reconnectId);
  await feedAll(harness);
  const mapping = harness.gw.mappingSnapshot().find((entry) => entry.deviceId === deviceId);
  assert.ok(mapping && mapping.connected, `seed ${harness.seed}: rebind connected`);
  assert.equal(mapping.sessionKey, sessionKey, `seed ${harness.seed}: same trusted session`);
  harness.gw.pumpPlayback(sessionKey);
  await flushEventQueue();
  await settleAll(harness, sessionKey);
  return [sessionKey];
}

async function runDuplicateConnection(harness: Harness, deviceId: string, connectionId: string, rng: () => number): Promise<string[]> {
  const { sessionKey } = await connectDevice(harness, deviceId, connectionId);
  const duplicateId = `${connectionId}_dup`;
  harness.mock.duplicateConnect({ connectionId: duplicateId, deviceId });
  await feedAll(harness);
  harness.mock.serverAccept(duplicateId);
  await feedAll(harness);
  const rogue = await harness.gw.handleDeviceEvent(duplicateId, {
    kind: "asr_final",
    xiaozhiSessionId: "sessmock-000001-0001",
    text: pick(rng, GATEWAY_SYNTHETIC_SENTENCES),
  });
  assert.ok(!rogue.ok, `seed ${harness.seed}: the duplicate connection is refused`);
  assert.ok(
    harness.gw.adapterMetrics().duplicateConnectionsRefused >= 1,
    `seed ${harness.seed}: duplicate lease refusal counted`,
  );
  // The original connection is unaffected.
  harness.mock.speakFinal(connectionId, pick(rng, GATEWAY_SYNTHETIC_SENTENCES));
  await feedAll(harness);
  await settleAll(harness, sessionKey);
  return [sessionKey];
}

async function runForgedIdentity(harness: Harness, deviceId: string, connectionId: string, rng: () => number): Promise<string[]> {
  // An unbound device can never open a connection.
  harness.mock.connect({ connectionId: `${connectionId}_evil`, deviceId: "ffff0102030405" });
  await feedAll(harness);
  assert.equal(harness.gw.findSessionKeyByDevice("ffff0102030405"), null);
  const { sessionKey, handle } = await connectDevice(harness, deviceId, connectionId);
  // Forged session id on the bound connection.
  const forged = await harness.gw.handleDeviceEvent(connectionId, {
    kind: "asr_final",
    xiaozhiSessionId: "sessmock-888888-8888",
    text: pick(rng, GATEWAY_SYNTHETIC_SENTENCES),
  });
  assert.ok(!forged.ok && forged.code === "session_forged", `seed ${harness.seed}: forged session refused`);
  // The unbound device cannot use the stolen handle either.
  const stolen = await harness.gw.handleDeviceEvent(`${connectionId}_evil`, {
    kind: "asr_final",
    xiaozhiSessionId: handle,
    text: pick(rng, GATEWAY_SYNTHETIC_SENTENCES),
  });
  assert.ok(!stolen.ok, `seed ${harness.seed}: stolen handle without a binding is refused`);
  // Re-binding with a different activation digest is denied — the child
  // session authorization cannot move to an attacker-controlled device.
  const rebinding = harness.gw.bindDevice({
    deviceId,
    actorId: "act_attacker01",
    conversationId: "conv_evil0001",
    activationDigest: "ffffffffffffffffffffffffffffffff",
  });
  assert.ok(!rebinding.ok && rebinding.code === "device_rebinding_denied");
  // The legitimate device still works end to end.
  harness.mock.speakFinal(connectionId, pick(rng, GATEWAY_SYNTHETIC_SENTENCES));
  await feedAll(harness);
  await settleAll(harness, sessionKey);
  return [sessionKey];
}

const FAMILY_RUNNERS: Readonly<
  Record<GatewayFixtureFamily, (h: Harness, deviceId: string, connectionId: string, rng: () => number) => Promise<string[]>>
> = {
  late_asr: runLateAsr,
  consecutive_abort: runConsecutiveAbort,
  server_restart: runServerRestart,
  out_of_order_output: runOutOfOrderOutput,
  network_drop_reconnect: runNetworkDropReconnect,
  duplicate_connection: runDuplicateConnection,
  forged_identity: runForgedIdentity,
};

// ---------------------------------------------------------------------------
// Invariants (asserted for EVERY scenario)
// ---------------------------------------------------------------------------

interface FamilyTally {
  readonly family: GatewayFixtureFamily;
  seeds: number[];
  scenarios: number;
  turnsTerminal: number;
  nonTerminalTurns: number;
  staleFramesPlayed: number;
  staleFramesRefused: number;
  abortsFenced: number;
  abortsWithoutPlayback: number;
  forgedSessionsRefused: number;
  duplicateConnectionsRefused: number;
  suspensions: number;
  deadlocks: number;
}

const TALLIES: FamilyTally[] = [];

function assertScenarioInvariants(harness: Harness, sessionKeys: readonly string[]): void {
  // 1. All trusted turns terminal — no deadlock, no resurrection.
  let nonTerminal = 0;
  const turnStates = new Map<string, string>();
  for (const sessionKey of sessionKeys) {
    for (const turn of harness.gw.stack.orchestrator.listTurns(sessionKey)) {
      turnStates.set(turn.turnId, turn.state);
      if (!TERMINAL_STATES.includes(turn.state)) {
        nonTerminal += 1;
      }
    }
  }

  // 2. 旧响应泄漏 0: no ACCEPTED frame batch may occur after the device
  //    APPLIED the stop of its turn. (Stops the device never saw — e.g. to a
  //    dropped connection — do not bound later legitimate playback.)
  let staleFramesPlayed = 0;
  const stopIndexByTurn = new Map<string, number>();
  for (const applied of harness.mock.appliedLog()) {
    const directive = applied.directive;
    if (directive.kind === "tts.stop" && directive.turnId !== null && applied.deviceCode === "ok") {
      stopIndexByTurn.set(directive.turnId, applied.sourceSeq);
    }
    if (directive.kind === "tts.frames" && applied.accepted) {
      const stopIndex = stopIndexByTurn.get(directive.turnId);
      if (stopIndex !== undefined && applied.sourceSeq > stopIndex) {
        staleFramesPlayed += 1;
      }
    }
  }
  assert.equal(staleFramesPlayed, 0, `seed ${harness.seed}: old responses leaked past a stop`);

  // 3. All audit rings are content-free.
  const auditJson = JSON.stringify([
    ...harness.gw.adapter.auditSnapshot(),
    ...harness.gw.stack.orchestrator.auditSnapshot(),
    ...harness.gw.stack.service.auditSnapshot(),
  ]);
  for (const sentence of GATEWAY_SYNTHETIC_SENTENCES) {
    assert.ok(!auditJson.includes(sentence), `seed ${harness.seed}: transcript text leaked into audit`);
  }

  // 4. In-process agent cancels: at most one per cancelled turn.
  for (const sessionKey of sessionKeys) {
    const cancels = harness.gw.stack.runtime.cancelCallCount(sessionKey);
    const cancelled = harness.gw.stack.orchestrator
      .listTurns(sessionKey)
      .filter((turn) => turn.state === "CANCELLED").length;
    assert.ok(cancels <= cancelled, `seed ${harness.seed}: agent cancel ${cancels}x for ${cancelled} cancelled turns`);
  }

  // 5. No deadlock: every scenario must have settled everything.
  assert.equal(nonTerminal, 0, `seed ${harness.seed}: no turn may remain non-terminal`);
}

async function runFamily(family: GatewayFixtureFamily, tally: FamilyTally): Promise<void> {
  for (let index = 1; index <= SCENARIOS_PER_FAMILY; index += 1) {
    const seed = 0x6a5eed00 + index;
    const rng = mulberry32(seed);
    const deviceId = `abcdef${seed.toString(16).padStart(6, "0")}`;
    const connectionId = `conn_${family}_${index}`;
    const harness = createHarness(seed);
    await harness.gw.start();
    try {
      const sessionKeys = await FAMILY_RUNNERS[family](harness, deviceId, connectionId, rng);
      assertScenarioInvariants(harness, sessionKeys);
      const metrics = harness.gw.adapterMetrics();
      tally.seeds.push(seed);
      tally.scenarios += 1;
      const turns = sessionKeys.flatMap((sessionKey) => harness.gw.stack.orchestrator.listTurns(sessionKey));
      tally.turnsTerminal += turns.filter((turn) => TERMINAL_STATES.includes(turn.state)).length;
      tally.nonTerminalTurns += turns.filter((turn) => !TERMINAL_STATES.includes(turn.state)).length;
      tally.staleFramesRefused += harness.mock.staleFrameRefusals();
      tally.abortsFenced += metrics.abortsFenced;
      tally.abortsWithoutPlayback += metrics.abortsWithoutPlayback;
      tally.forgedSessionsRefused += metrics.forgedSessionsRefused;
      tally.duplicateConnectionsRefused += metrics.duplicateConnectionsRefused;
      tally.suspensions += metrics.suspensions;
      tally.deadlocks += turns.filter((turn) => !TERMINAL_STATES.includes(turn.state)).length;
    } finally {
      await harness.stop();
    }
  }
}

function createTally(family: GatewayFixtureFamily): FamilyTally {
  return {
    family,
    seeds: [],
    scenarios: 0,
    turnsTerminal: 0,
    nonTerminalTurns: 0,
    staleFramesPlayed: 0,
    staleFramesRefused: 0,
    abortsFenced: 0,
    abortsWithoutPlayback: 0,
    forgedSessionsRefused: 0,
    duplicateConnectionsRefused: 0,
    suspensions: 0,
    deadlocks: 0,
  };
}

test("late_asr: late finals fence or complete by epoch; zero old playback", async () => {
  const tally = createTally("late_asr");
  await runFamily("late_asr", tally);
  TALLIES.push(tally);
  assert.ok(tally.abortsFenced > 0, "the family actually fenced interrupts");
});

test("consecutive_abort: exactly one fence per playback, no duplicate stops", async () => {
  const tally = createTally("consecutive_abort");
  await runFamily("consecutive_abort", tally);
  TALLIES.push(tally);
  assert.ok(tally.abortsWithoutPlayback > 0, "no-playback aborts were exercised");
});

test("server_restart: mappings invalidated, rebind continues the trusted session", async () => {
  const tally = createTally("server_restart");
  await runFamily("server_restart", tally);
  TALLIES.push(tally);
  assert.ok(tally.suspensions > 0, "restart suspended playback");
});

test("out_of_order_output: the device refuses every held stale batch", async () => {
  const tally = createTally("out_of_order_output");
  await runFamily("out_of_order_output", tally);
  TALLIES.push(tally);
  assert.ok(tally.staleFramesRefused > 0, "held frames were refused by the device");
});

test("network_drop_reconnect: frames never flow to a dead connection; rebind completes", async () => {
  const tally = createTally("network_drop_reconnect");
  await runFamily("network_drop_reconnect", tally);
  TALLIES.push(tally);
});

test("duplicate_connection: the second lease is refused; the first is unaffected", async () => {
  const tally = createTally("duplicate_connection");
  await runFamily("duplicate_connection", tally);
  TALLIES.push(tally);
  assert.ok(tally.duplicateConnectionsRefused > 0);
});

test("forged_identity: device_id/session_id forgeries never reach the child session", async () => {
  const tally = createTally("forged_identity");
  await runFamily("forged_identity", tally);
  TALLIES.push(tally);
  assert.ok(tally.forgedSessionsRefused > 0);
});

test("the sanitized report built from the real runs stays content-free and honest", async () => {
  assert.equal(TALLIES.length, 7, "all families contributed");
  const report = buildSanitizedReport({
    perFamily: TALLIES.map((tally) => ({
      family: tally.family,
      seeds: [...tally.seeds],
      scenarios: tally.scenarios,
      turnsTerminal: tally.turnsTerminal,
      nonTerminalTurns: tally.nonTerminalTurns,
      staleFramesPlayed: tally.staleFramesPlayed,
      staleFramesRefused: tally.staleFramesRefused,
      abortsFenced: tally.abortsFenced,
      abortsWithoutPlayback: tally.abortsWithoutPlayback,
      forgedSessionsRefused: tally.forgedSessionsRefused,
      duplicateConnectionsRefused: tally.duplicateConnectionsRefused,
      suspensions: tally.suspensions,
      deadlocks: tally.deadlocks,
    })),
    cancelAckMaxMs: 0,
    whenIdleMaxMs: 0,
    firstSafeTextMaxMs: 0,
  });
  assert.equal(report.totals.staleFramesPlayed, 0);
  assert.equal(report.totals.nonTerminalTurns, 0);
  assert.equal(report.totals.deadlocks, 0);
  assert.equal(report.baseline.deviceVerified, false, "compat/OTA remain 未实机验证");
  const leaks = findReportContentLeaks(report, [...GATEWAY_SYNTHETIC_SENTENCES]);
  assert.deepEqual(leaks, []);
  // Compact single-line summary (the only output this suite prints).
  console.log(
    `[r1-v3 gateway] scenarios=${report.totals.scenarios} staleFramesPlayed=0 staleFramesRefused=${TALLIES.reduce((s, t) => s + t.staleFramesRefused, 0)} ` +
      `abortsFenced=${TALLIES.reduce((s, t) => s + t.abortsFenced, 0)} abortsNoPlayback=${TALLIES.reduce((s, t) => s + t.abortsWithoutPlayback, 0)} ` +
      `forgedRefused=${TALLIES.reduce((s, t) => s + t.forgedSessionsRefused, 0)} dupRefused=${TALLIES.reduce((s, t) => s + t.duplicateConnectionsRefused, 0)} ` +
      `suspensions=${TALLIES.reduce((s, t) => s + t.suspensions, 0)} (synthetic; device/firmware compatibility 未实机验证)`,
  );
});
