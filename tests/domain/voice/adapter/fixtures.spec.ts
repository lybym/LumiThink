import assert from "node:assert/strict";
import test from "node:test";

/**
 * R1-V3 fixture replayability + sanitized report contract (issue #30 实现
 * 范围 5: 可重放 Mock 协议 fixture、脱敏测试报告、R5 验收基线).
 *
 * The replay proof runs the SAME deterministic fixture twice and asserts
 * identical fingerprints of (a) the mock source/applied logs and (b) the
 * union of all audit rings — same inputs, byte-identical evidence.
 */

import { createVoiceGatewayStack } from "../../../../lib/server/voice-gateway-composition.ts";
import { createMockXiaozhiGateway } from "../../../../lib/domain/voice/adapter/mock-xiaozhi.ts";
import {
  GATEWAY_FIXTURE_FAMILIES,
  GATEWAY_SYNTHETIC_SENTENCES,
  buildSanitizedReport,
  findReportContentLeaks,
  isGatewayFixtureFamily,
  type GatewayFixtureScenarioReport,
} from "../../../../lib/domain/voice/adapter/fixtures.ts";
import { gatewayContentDigest } from "../../../../lib/domain/voice/adapter/gateway-adapter.ts";
import { mulberry32, pick, randomInt, createTurnIdFactory, createVirtualClock } from "../helpers.ts";

const DEVICE = "abcdef123456";
const CONNECTION = "conn_replay01";
/** The guardian-issued activation digest = the hello possession proof. */
const ACTIVATION = "0123456789abcdef0123456789abcdef";

function scriptFor(sessionKey: string, turnId: string) {
  const seed = (gatewayContentDigest(`${sessionKey}|${turnId}`).slice(0, 8) + "0000").slice(0, 8);
  const rng = mulberry32(parseInt(seed, 16) >>> 0);
  const count = 2 + randomInt(rng, 2);
  const fragments = [];
  for (let i = 0; i < count; i += 1) {
    fragments.push({ channel: "text" as const, text: pick(rng, GATEWAY_SYNTHETIC_SENTENCES) });
  }
  return fragments;
}

interface ReplayRun {
  readonly mockFingerprint: string;
  readonly auditFingerprint: string;
  readonly turnStates: readonly string[];
  readonly abortsFenced: number;
  readonly staleFrameRefusals: number;
}

/** One deterministic run of the consecutive_abort fixture. */
async function runConsecutiveAbortFixture(): Promise<ReplayRun> {
  const mock = createMockXiaozhiGateway();
  const turnIdFactory = createTurnIdFactory();
  const gw = createVoiceGatewayStack({
    scriptFor,
    transport: "in_process",
    framesPerSentence: 4,
    turnIdFactory,
    clock: createVirtualClock().now,
    directiveSink: (directive) => {
      mock.applyDirective(directive);
    },
  });
  const rng = mulberry32(0x5eed_1234);
  await gw.start();
  try {
    gw.bindDevice({
      deviceId: DEVICE,
      actorId: "act_owner0001",
      conversationId: "conv_child0001",
      activationDigest: ACTIVATION,
    });
    mock.connect({ connectionId: CONNECTION, deviceId: DEVICE, clientDigest: ACTIVATION });
    await drain(gw, mock);
    const sessionKey = gw.findSessionKeyByDevice(DEVICE);
    assert.ok(sessionKey);
    mock.serverAccept(CONNECTION);
    await drain(gw, mock);
    for (let round = 0; round < 2; round += 1) {
      mock.speakFinal(CONNECTION, pick(rng, GATEWAY_SYNTHETIC_SENTENCES));
      await drain(gw, mock);
      gw.stack.pumpRuntime(sessionKey, 2 + randomInt(rng, 2));
      await flushEventQueue();
      gw.pumpPlayback(sessionKey);
      mock.abortSpeaking(CONNECTION, round === 0 ? "wake_word_detected" : "manual");
      await drain(gw, mock);
      mock.abortSpeaking(CONNECTION, "manual");
      await drain(gw, mock);
    }
    mock.speakFinal(CONNECTION, pick(rng, GATEWAY_SYNTHETIC_SENTENCES));
    await drain(gw, mock);
    for (let round = 0; round < 16; round += 1) {
      gw.stack.pumpRuntime(sessionKey, 200);
      await flushEventQueue();
      if (gw.stack.orchestrator.listTurns(sessionKey).every((turn) => isTerminal(turn.state))) {
        break;
      }
    }
    gw.pumpPlayback(sessionKey);
    await flushEventQueue();
    const audit = stableJson([
      ...gw.adapter.auditSnapshot(),
      ...gw.stack.orchestrator.auditSnapshot(),
      ...gw.stack.service.auditSnapshot(),
    ]);
    return {
      mockFingerprint: mock.fingerprint(),
      auditFingerprint: gatewayContentDigest(audit),
      turnStates: gw.stack.orchestrator.listTurns(sessionKey).map((turn) => turn.state),
      abortsFenced: gw.adapterMetrics().abortsFenced,
      staleFrameRefusals: mock.staleFrameRefusals(),
    };
  } finally {
    await gw.stop();
  }
}

/** Flush the in-process event queue (Bridge events are delivered in
 * microtasks; one macrotask tick flushes the ordered queue deterministically). */
function flushEventQueue(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function drain(
  gw: ReturnType<typeof createVoiceGatewayStack>,
  mock: ReturnType<typeof createMockXiaozhiGateway>,
): Promise<void> {
  for (;;) {
    const batch = mock.flushAll();
    if (batch.length === 0) {
      break;
    }
    for (const { connectionId, event } of batch) {
      const outcome = await gw.handleDeviceEvent(connectionId, event);
      if (outcome.ok && event.kind === "session_issued" && typeof outcome.sessionKey === "string") {
        mock.bindSession(connectionId, outcome.sessionKey);
      }
    }
  }
}

function isTerminal(state: string): boolean {
  return ["COMPLETED", "CANCELLED", "FAILED", "TIMED_OUT"].includes(state);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

test("the fixture catalog covers every required fault family with expectations", () => {
  const names = GATEWAY_FIXTURE_FAMILIES.map((entry) => entry.name);
  for (const required of [
    "late_asr",
    "consecutive_abort",
    "server_restart",
    "out_of_order_output",
    "network_drop_reconnect",
    "duplicate_connection",
  ]) {
    assert.ok(names.includes(required as never), `missing fixture family ${required}`);
  }
  assert.ok(names.includes("forged_identity"));
  for (const entry of GATEWAY_FIXTURE_FAMILIES) {
    assert.ok(entry.fault.length > 10);
    assert.ok(entry.expect.length > 10);
    assert.ok(isGatewayFixtureFamily(entry.name));
  }
  assert.ok(!isGatewayFixtureFamily("not_a_family"));
});

test("the same fixture replays to byte-identical evidence", async () => {
  const first = await runConsecutiveAbortFixture();
  const second = await runConsecutiveAbortFixture();
  assert.equal(first.mockFingerprint, second.mockFingerprint, "mock schedule + device applications must replay identically");
  assert.equal(first.auditFingerprint, second.auditFingerprint, "audit rings must replay identically");
  assert.deepEqual(first.turnStates, second.turnStates);
  assert.equal(first.abortsFenced, second.abortsFenced);
  assert.equal(first.staleFrameRefusals, second.staleFrameRefusals);
  assert.equal(first.abortsFenced, 2);
  assert.equal(
    first.turnStates.filter((state) => state === "CANCELLED").length,
    2,
    "each playback turn was interrupted exactly once",
  );
});

test("the sanitized report carries counts and digests only — no synthetic text", () => {
  const perFamily: GatewayFixtureScenarioReport[] = [
    {
      family: "late_asr",
      seeds: [1, 2],
      scenarios: 2,
      turnsTerminal: 6,
      nonTerminalTurns: 0,
      staleFramesPlayed: 0,
      staleFramesRefused: 4,
      abortsFenced: 2,
      abortsWithoutPlayback: 2,
      forgedSessionsRefused: 0,
      possessionRefused: 0,
      duplicateConnectionsRefused: 0,
      suspensions: 0,
      deadlocks: 0,
    },
    {
      family: "forged_identity",
      seeds: [3],
      scenarios: 1,
      turnsTerminal: 1,
      nonTerminalTurns: 0,
      staleFramesPlayed: 0,
      staleFramesRefused: 0,
      abortsFenced: 0,
      abortsWithoutPlayback: 0,
      forgedSessionsRefused: 2,
      possessionRefused: 2,
      duplicateConnectionsRefused: 1,
      suspensions: 0,
      deadlocks: 0,
    },
  ];
  const report = buildSanitizedReport({
    perFamily,
    cancelAckMaxMs: 3,
    whenIdleMaxMs: 7,
    firstSafeTextMaxMs: 11,
  });
  assert.equal(report.report, "voice-gateway-adapter/1");
  assert.equal(report.sanitized, true);
  assert.equal(report.baseline.deviceVerified, false, "compat/OTA remain 未实机验证 in the report");
  assert.equal(report.totals.scenarios, 3);
  assert.equal(report.totals.staleFramesPlayed, 0);
  assert.equal(report.totals.deadlocks, 0);
  const leaks = findReportContentLeaks(report, [...GATEWAY_SYNTHETIC_SENTENCES]);
  assert.deepEqual(leaks, [], "no synthetic sentence may appear in a sanitized report");
});

test("candidate latency buckets are reported but never claimed as achieved SLAs", () => {
  const report = buildSanitizedReport({ perFamily: [], cancelAckMaxMs: 5, whenIdleMaxMs: 9, firstSafeTextMaxMs: 13 });
  assert.equal(typeof report.candidateLatency.cancelAckMaxMs, "number");
  assert.equal(typeof report.candidateLatency.whenIdleMaxMs, "number");
  assert.equal(typeof report.candidateLatency.firstSafeTextMaxMs, "number");
  assert.ok(!JSON.stringify(report).includes("PASS"), "a sanitized report never claims PASS for untested items");
});
