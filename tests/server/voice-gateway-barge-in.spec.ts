import assert from "node:assert/strict";
import test from "node:test";
import { connect } from "node:net";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * E2E-09 (issue #59) — barge-in MEASUREMENT + zero-leak regression suite
 * over the WIRED Voice Gateway stack (the same composition the pinned
 * xiaozhi server drives; the pinned-server protocol face itself is proven
 * by deploy/xiaozhi/probe_e2e09.py in e2e-07-gateway-wiring-gate.yml).
 *
 * Issue DoD coverage on the AUTOMATED surface (the physical device items
 * stay in deploy/xiaozhi/runbook.md §12 — this suite never claims them):
 *   - multi-trial barge-in: interrupt → device-stop directive (tts_end
 *     "interrupted") → ZERO stale sentences/epochs after the fence → the
 *     next turn still completes (playback-resume + next-round pickup);
 *   - trusted-epoch zero leak (DoD 2 automated proxy): the aborted turn
 *     settles CANCELLED and no sentence of the old turn/epoch crosses the
 *     transport after the abort (old TEXT/AUDIO = 0; old-turn MEMORY writes
 *     are structurally fenced by the R1-V1 orchestrator contract — a
 *     CANCELLED turn cannot fence writes — proven by tests/domain/voice/
 *     race.spec.ts, not re-proven here);
 *   - objective stop-latency measurement: per-trial abort → tts_end
 *     wall-clock is RECORDED and printed (candidate baseline, explicitly
 *     NOT an SLA gate — VOICE_RUNTIME §9 discipline), with an integrity
 *     regression assertion: every trial's abort is accounted exactly once
 *     (abortsFenced + abortsWithoutPlayback) and every measurement is a
 *     finite number;
 *   - no-playback abort (false-interrupt protocol proxy) is benign:
 *     enumerated accounting, no epoch bump, the connection survives and
 *     the next turn completes;
 *   - a LATE abort (after several delivered sentences — the delayed /
 *     network-jitter shape) still fences zero stale delivery.
 *
 * On the POSIX CI target the protected transport is a REAL socket (UDS);
 * on the Windows dev sandbox the same routing runs through the frame
 * entry point (the documented EPERM boundary, shared with
 * voice-gateway-wiring.spec.ts).
 */

import { createWiredVoiceGateway, type WiredVoiceGateway } from "../../lib/server/voice-gateway-wiring.ts";
import type { GatewayInternalInboundFrame, GatewayInternalOutboundFrame } from "../../lib/server/voice-gateway-internal-transport.ts";
import type { MockGenerationScript } from "../../lib/domain/voice/bridge/mock-cordis.ts";

const SOCKETS_AVAILABLE = process.platform !== "win32";

const DEVICE_ID = "aabbccddeeff";
const ACTOR = "act_parent0001";
const CONVERSATION = "conv_child0001";
const ACTIVATION_DIGEST = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const AUTH_KEY = "deployment-auth-key-0123456789abcdef";
const TRANSPORT_TOKEN = "internal-transport-token-0123456789";
const SESSION_ID = "sess-bargein01";

const BRIDGE_TRANSPORT = process.platform === "win32" ? ("in_process" as const) : ("ipc" as const);

const PROMPT_TEXT = "我们来玩个游戏好不好";
const RECOVERY_TEXT = "那我们读书吧";

function scriptFor(_sessionKey: string, _turnId: string): MockGenerationScript {
  return [
    { channel: "text", text: "好呀，我们一起看看这道题。" },
    { channel: "text", text: "先找已知条件，再一步一步算。" },
  ];
}

function mintDeviceToken(authKey: string, clientId: string | null, deviceId: string, tsSeconds: number): string {
  const content = `${clientId ?? "None"}|${deviceId}|${tsSeconds}`;
  const sig = createHmac("sha256", authKey).update(content, "utf8").digest("base64url").replace(/=+$/, "");
  return `Bearer ${sig}.${tsSeconds}`;
}

interface SettledTurn {
  readonly turnId: string;
  readonly finalState: string;
}

interface Fixture {
  readonly wired: WiredVoiceGateway;
  readonly outFrames: { readonly kind: string; readonly frame: Record<string, unknown> }[];
  readonly settledTurns: SettledTurn[];
  readonly cleanup: () => void;
}

async function createWired(): Promise<Fixture> {
  const socketDir = mkdtempSync(join(tmpdir(), "lumithink-bargein-"));
  const outFrames: { kind: string; frame: Record<string, unknown> }[] = [];
  const settledTurns: SettledTurn[] = [];
  let turnSeq = 0;
  const wired = createWiredVoiceGateway({
    bindings: [
      { deviceId: DEVICE_ID, actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION_DIGEST },
    ],
    deviceAuthKey: AUTH_KEY,
    transportAuthToken: TRANSPORT_TOKEN,
    socketDir,
    endpointName: `bargein-${Math.floor(Math.random() * 0xffffff).toString(16)}`,
    scriptFor,
    transport: BRIDGE_TRANSPORT,
    turnIdFactory: () => {
      turnSeq += 1;
      return `trn_bargein${turnSeq.toString().padStart(6, "0")}`;
    },
    onBridgeFrame: (frame) => {
      outFrames.push({ kind: frame.kind, frame: frame as unknown as Record<string, unknown> });
    },
  });
  wired.stack.stack.client.onEvent((frame) => {
    if (frame.kind !== "event" || frame.name !== "turn.settled") {
      return;
    }
    const payload = (frame.payload ?? {}) as Record<string, unknown>;
    if (typeof payload.turnId === "string" && typeof payload.finalState === "string") {
      settledTurns.push({ turnId: payload.turnId, finalState: payload.finalState });
    }
  });
  await wired.start();
  return {
    wired,
    outFrames,
    settledTurns,
    cleanup: () => {
      rmSync(socketDir, { recursive: true, force: true });
    },
  };
}

/** Bridge-side driver: REAL socket where available, frame injection otherwise. */
interface BridgeDriver {
  send(frame: GatewayInternalInboundFrame): Promise<void>;
  destroy(): Promise<void>;
}

async function connectBridge(fixture: Fixture): Promise<BridgeDriver> {
  if (SOCKETS_AVAILABLE) {
    const endpoint = fixture.wired.endpoint;
    const path = endpoint.kind === "uds" ? endpoint.path : `\\\\.\\pipe\\${endpoint.name}`;
    assert.ok(
      await waitFor(() => !fixture.wired.transport.isBridgeConnected(), 5_000),
      "the previous bridge connection must be closed before reconnecting",
    );
    const socket = connect(path);
    socket.on("error", () => undefined);
    socket.on("data", () => undefined); // outbound frames are asserted via the tap
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", resolve);
    });
    socket.write(frameBytes({ kind: "bridge_auth", v: 1, token: TRANSPORT_TOKEN }));
    return {
      async send(frame) {
        socket.write(frameBytes(frame));
      },
      async destroy() {
        socket.destroy();
      },
    };
  }
  fixture.wired.notifyBridgeLifecycleForTest("authenticated");
  return {
    async send(frame) {
      await fixture.wired.handleBridgeFrameForTest(frame);
    },
    async destroy() {
      fixture.wired.notifyBridgeLifecycleForTest("closed");
      await Promise.resolve();
    },
  };
}

function frameBytes(frame: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

async function helloDevice(driver: BridgeDriver, fixture: Fixture, connId: string): Promise<void> {
  await driver.send({
    kind: "device_hello",
    connId,
    deviceId: DEVICE_ID,
    deviceIdWire: null,
    clientId: "client-probe",
    authorization: mintDeviceToken(AUTH_KEY, "client-probe", DEVICE_ID, Math.floor(Date.now() / 1000)),
    audioParams: { format: "opus", sampleRate: 16000, channels: 1, frameDurationMs: 60 },
  });
  assert.ok(
    await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "device_hello_result" && entry.frame.connId === connId)),
    `hello result for ${connId} arrived`,
  );
}

function sessionKeyOf(fixture: Fixture): string {
  const sessionKey = fixture.wired.stack.findSessionKeyByDevice(DEVICE_ID);
  assert.ok(sessionKey, "the trusted session key is mapped");
  return sessionKey;
}

function percentiles(values: number[]): { p50: number; p95: number; max: number } {
  const ordered = [...values].sort((a, b) => a - b);
  const pick = (fraction: number): number => {
    const rank = Math.max(1, Math.min(ordered.length, Math.ceil(fraction * ordered.length)));
    return ordered[rank - 1] as number;
  };
  return { p50: pick(0.5), p95: pick(0.95), max: ordered[ordered.length - 1] as number };
}

test("barge-in trials: interrupt → stop effective → zero stale delivery → recovery turn completes; stop latency measured every trial", async () => {
  const TRIALS = 6;
  const fixture = await createWired();
  try {
    const driver = await connectBridge(fixture);
    await helloDevice(driver, fixture, "conn-bi-main");
    await driver.send({ kind: "session_issued", connId: "conn-bi-main", xiaozhiSessionId: SESSION_ID });
    const sessionKey = sessionKeyOf(fixture);

    const interruptedLatencies: number[] = [];
    const perTrialAccounting: { fenced: number; withoutPlayback: number }[] = [];

    for (let trial = 1; trial <= TRIALS; trial += 1) {
      const metricsBefore = fixture.wired.adapterMetrics();
      const epochBeforeAbort = fixture.wired.stack.stack.orchestrator.currentEpoch(sessionKey) ?? 0;

      // 1. The turn starts and its first sentence reaches the bridge.
      await driver.send({ kind: "turn_prompt", connId: "conn-bi-main", xiaozhiSessionId: SESSION_ID, text: PROMPT_TEXT });
      assert.ok(await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "turn_started")), `trial ${trial}: the turn was minted`);
      const turnId = [...fixture.outFrames].reverse().find((entry) => entry.frame.kind === "turn_started")?.frame.turnId as string;
      assert.ok(typeof turnId === "string" && turnId.length > 0, `trial ${trial}: the turn id is observable`);
      // The synthetic runtime dispatches ONE stream event per pump unit:
      // start + first chunk = the first admitted sentence, with the stream
      // still RUNNING (chunk 2 / end pending) — exactly the mid-playback
      // shape the barge-in needs.
      fixture.wired.stack.stack.pumpRuntime(sessionKey, 2);
      assert.ok(
        await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "tts_sentence" && entry.frame.turnId === turnId)),
        `trial ${trial}: the first sentence crossed before the interruption`,
      );

      // 2. The barge-in: fence first (trusted epoch bump), then the stop.
      // NO pump between the abort and the stop signal: on the REAL IPC
      // transport the abort's routing (cancel + CANCELLED settlement) is
      // asynchronous, and pumping the mock runtime before the cancel lands
      // would complete the still-live attempt as COMPLETED instead. Both
      // stop paths (the Adapter's playback-bound directive and the
      // settlement tap on the CANCELLED event) are pump-independent.
      const abortIndex = fixture.outFrames.length;
      const abortSentAt = Date.now();
      await driver.send({ kind: "abort", connId: "conn-bi-main", xiaozhiSessionId: SESSION_ID, reason: "vad_detected" });
      assert.ok(
        await waitFor(() => (fixture.wired.stack.stack.orchestrator.currentEpoch(sessionKey) ?? 0) > epochBeforeAbort),
        `trial ${trial}: the abort fenced (trusted epoch bump)`,
      );
      assert.ok(
        await waitFor(() =>
          fixture.outFrames.some(
            (entry) =>
              entry.frame.kind === "tts_end" &&
              entry.frame.turnId === turnId &&
              entry.frame.reason === "interrupted",
          ),
        ),
        `trial ${trial}: the device-stop directive (tts_end interrupted) arrived — DIAG turn=${JSON.stringify(fixture.wired.stack.stack.orchestrator.describeTurn(sessionKey, turnId))} epoch=${String(fixture.wired.stack.stack.orchestrator.currentEpoch(sessionKey))} frames=${JSON.stringify(fixture.outFrames.map((entry) => ({ k: entry.kind, t: entry.frame.turnId, e: entry.frame.epoch, r: entry.frame.reason })))} settled=${JSON.stringify(fixture.settledTurns)} audit=${JSON.stringify(fixture.wired.stack.adapter.auditSnapshot().filter((entry) => entry.action.includes("abort") || entry.action.includes("cancel") || entry.action.includes("rejected")))} gate=${JSON.stringify(fixture.wired.stack.stack.gate.metricsSnapshot())}`,
      );
      interruptedLatencies.push(Date.now() - abortSentAt);

      // 3. Trusted-epoch zero leak: NOTHING of the old turn/epoch crosses
      // the transport after the abort (DoD 2 automated proxy — old text
      // and old audio are structurally unreachable; the CANCELLED
      // settlement fences old-turn writes per the R1-V1 orchestrator
      // contract, proven by tests/domain/voice/race.spec.ts).
      const after = fixture.outFrames.slice(abortIndex);
      assert.ok(
        !after.some((entry) => entry.frame.kind === "tts_sentence" && entry.frame.turnId === turnId),
        `trial ${trial}: no sentence of the aborted turn crosses after the abort`,
      );
      const postAbortSentences = after.filter((entry) => entry.frame.kind === "tts_sentence");
      assert.ok(
        postAbortSentences.every((entry) => (entry.frame.epoch as number) > epochBeforeAbort),
        `trial ${trial}: every post-abort sentence carries the NEW epoch`,
      );
      assert.ok(
        !after.some((entry) => entry.frame.kind === "device_drop"),
        `trial ${trial}: the interruption is an outcome, not a transport fault`,
      );
      assert.ok(
        await waitFor(() =>
          fixture.settledTurns.some((entry) => entry.turnId === turnId && entry.finalState === "CANCELLED"),
        ),
        `trial ${trial}: the aborted turn settled CANCELLED`,
      );

      // 4. Playback resume / next-round pickup: the recovery turn works.
      // `turn_started` is the dispatch-complete signal (sent once
      // turn.prompt + turn.stream both succeeded) — pumping before it on
      // the REAL IPC transport races the still-in-flight dispatch and
      // feeds an attempt that does not exist yet (no deltas would ever
      // follow).
      await driver.send({ kind: "turn_prompt", connId: "conn-bi-main", xiaozhiSessionId: SESSION_ID, text: RECOVERY_TEXT });
      assert.ok(await waitFor(() => fixture.wired.adapterMetrics().asrFinalsAccepted >= 2 * trial), `trial ${trial}: the recovery prompt was accepted`);
      assert.ok(
        await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "turn_started" && (entry.frame.epoch as number) > epochBeforeAbort)),
        `trial ${trial}: the recovery turn was dispatched`,
      );
      fixture.wired.stack.stack.pumpRuntime(sessionKey, 20);
      assert.ok(
        await waitFor(() =>
          fixture.outFrames.some(
            (entry) =>
              entry.frame.kind === "tts_sentence" &&
              entry.frame.text === "好呀，我们一起看看这道题。" &&
              (entry.frame.epoch as number) > epochBeforeAbort,
          ),
        ),
        `trial ${trial}: the recovery turn's sentence crossed`,
      );
      assert.ok(
        await waitFor(() =>
          fixture.outFrames.some(
            (entry) =>
              entry.frame.kind === "tts_end" &&
              entry.frame.reason === "completed" &&
              (entry.frame.epoch as number) > epochBeforeAbort,
          ),
        ),
        `trial ${trial}: the recovery turn completed`,
      );

      // 5. Objective accounting: every abort is accounted exactly once by
      // the Adapter (fenced when playback was bound, enumerated
      // no-playback otherwise — the wired composition's belt-and-braces
      // fence covers the latter).
      const metricsAfter = fixture.wired.adapterMetrics();
      const fenced = metricsAfter.abortsFenced - metricsBefore.abortsFenced;
      const withoutPlayback = metricsAfter.abortsWithoutPlayback - metricsBefore.abortsWithoutPlayback;
      assert.equal(fenced + withoutPlayback, 1, `trial ${trial}: the abort is accounted exactly once`);
      perTrialAccounting.push({ fenced, withoutPlayback });
    }

    // Objective stop-latency measurement (candidate baseline, NOT an SLA
    // gate — the frozen product thresholds belong to runbook §12.3): the
    // summary is printed for the CI evidence surface, and the measurement
    // integrity itself is asserted (finite, non-negative, present).
    assert.equal(interruptedLatencies.length, TRIALS, "every trial produced a stop-latency measurement");
    assert.ok(interruptedLatencies.every((ms) => Number.isFinite(ms) && ms >= 0), "every stop-latency measurement is finite and non-negative");
    const latency = percentiles(interruptedLatencies);
    const stopEffective = fixture.wired.adapterMetrics().ttsStopEffectiveMs;
    const gate = fixture.wired.stack.stack.gate.metricsSnapshot();
    console.log(
      `barge-in wiring summary: trials=${TRIALS} interrupted_ms[p50=${latency.p50},p95=${latency.p95},max=${latency.max}] ` +
        `adapterTtsStopEffective={count:${stopEffective.count},maxMs:${stopEffective.maxMs}} ` +
        `accounting=${JSON.stringify(perTrialAccounting)} deltasFenced=${gate.deltasFenced} ` +
        `staleAudioSuppressed=${fixture.wired.adapterMetrics().ttsStaleAudioSuppressed}`,
    );
    assert.ok(
      stopEffective.count === 0 || (Number.isFinite(stopEffective.maxMs) && stopEffective.maxMs >= 0),
      "the adapter-anchored stop-effective measurement stays finite",
    );
    // All turns across all trials are terminal; none is left RUNNING.
    for (const entry of fixture.settledTurns) {
      assert.ok(["COMPLETED", "CANCELLED", "FAILED"].includes(entry.finalState), `turn ${entry.turnId} is terminal (${entry.finalState})`);
    }
    await driver.destroy();
  } finally {
    await fixture.wired.stop();
    fixture.cleanup();
  }
});

test("no-playback abort is benign: enumerated accounting, no epoch bump, the connection survives", async () => {
  const fixture = await createWired();
  try {
    const driver = await connectBridge(fixture);
    await helloDevice(driver, fixture, "conn-bi-idle");
    await driver.send({ kind: "session_issued", connId: "conn-bi-idle", xiaozhiSessionId: SESSION_ID });
    const sessionKey = sessionKeyOf(fixture);
    const metricsBefore = fixture.wired.adapterMetrics();
    const epochBefore = fixture.wired.stack.stack.orchestrator.currentEpoch(sessionKey) ?? 0;

    // The false-interrupt protocol proxy: abort with NOTHING playing.
    await driver.send({ kind: "abort", connId: "conn-bi-idle", xiaozhiSessionId: SESSION_ID, reason: "manual" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const metricsAfter = fixture.wired.adapterMetrics();
    assert.equal(metricsAfter.abortsWithoutPlayback - metricsBefore.abortsWithoutPlayback, 1, "the playback-less abort is enumerated (no epoch bump, no stop)");
    assert.equal((fixture.wired.stack.stack.orchestrator.currentEpoch(sessionKey) ?? 0), epochBefore, "no epoch bump without playback");
    assert.ok(!fixture.outFrames.some((entry) => entry.frame.kind === "tts_end"), "no device-stop directive for a playback-less abort");
    assert.ok(!fixture.outFrames.some((entry) => entry.frame.kind === "device_drop"), "the connection survives");

    // The next turn completes in full (protocol face intact).
    await driver.send({ kind: "turn_prompt", connId: "conn-bi-idle", xiaozhiSessionId: SESSION_ID, text: PROMPT_TEXT });
    assert.ok(await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "turn_started")), "the next turn was minted");
    fixture.wired.stack.stack.pumpRuntime(sessionKey, 20);
    assert.ok(await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "tts_end" && entry.frame.reason === "completed")), "the next turn completed");
    await driver.destroy();
  } finally {
    await fixture.wired.stop();
    fixture.cleanup();
  }
});

test("a LATE abort (after several delivered sentences) still fences zero stale delivery and recovers", async () => {
  const fixture = await createWired();
  try {
    const driver = await connectBridge(fixture);
    await helloDevice(driver, fixture, "conn-bi-late");
    await driver.send({ kind: "session_issued", connId: "conn-bi-late", xiaozhiSessionId: SESSION_ID });
    const sessionKey = sessionKeyOf(fixture);

    await driver.send({ kind: "turn_prompt", connId: "conn-bi-late", xiaozhiSessionId: SESSION_ID, text: PROMPT_TEXT });
    assert.ok(await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "turn_started")));
    const turnId = [...fixture.outFrames].reverse().find((entry) => entry.frame.kind === "turn_started")?.frame.turnId as string;
    const epochBeforeAbort = fixture.wired.stack.stack.orchestrator.currentEpoch(sessionKey) ?? 0;
    // Let the stream run several pump batches before the interrupt lands
    // (the network-jitter proxy: the barge-in arrives deep mid-playback).
    // Three pump units = start + BOTH sentence chunks, with `end` still
    // pending — the turn stays RUNNING and fenceable.
    fixture.wired.stack.stack.pumpRuntime(sessionKey, 3);
    assert.ok(
      await waitFor(() => fixture.outFrames.filter((entry) => entry.frame.kind === "tts_sentence" && entry.frame.turnId === turnId).length >= 2),
      "both sentences were already delivered before the late abort",
    );

    const abortIndex = fixture.outFrames.length;
    await driver.send({ kind: "abort", connId: "conn-bi-late", xiaozhiSessionId: SESSION_ID, reason: "wake_word_detected" });
    assert.ok(
      await waitFor(() => (fixture.wired.stack.stack.orchestrator.currentEpoch(sessionKey) ?? 0) > epochBeforeAbort),
      "the late abort still fenced",
    );
    // NO pump before the stop signal (the same IPC-transport race as the
    // trial loop: pumping before the cancel lands would complete the
    // still-live attempt as COMPLETED).
    assert.ok(
      await waitFor(() =>
        fixture.outFrames.some(
          (entry) =>
            entry.frame.kind === "tts_end" &&
            entry.frame.turnId === turnId &&
            entry.frame.reason === "interrupted",
        ),
      ),
      "the LATE abort's device-stop directive (tts_end interrupted) arrived",
    );
    const after = fixture.outFrames.slice(abortIndex);
    assert.ok(
      !after.some((entry) => entry.frame.kind === "tts_sentence" && entry.frame.turnId === turnId),
      "no sentence of the aborted turn crosses after the LATE abort",
    );
    assert.ok(
      await waitFor(() => fixture.settledTurns.some((entry) => entry.turnId === turnId && entry.finalState === "CANCELLED")),
      "the late-aborted turn settled CANCELLED",
    );
    // Recovery on the new epoch (turn_started = the dispatch-complete
    // signal; pumping earlier races the in-flight dispatch on the REAL
    // IPC transport).
    await driver.send({ kind: "turn_prompt", connId: "conn-bi-late", xiaozhiSessionId: SESSION_ID, text: RECOVERY_TEXT });
    assert.ok(
      await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "turn_started" && (entry.frame.epoch as number) > epochBeforeAbort)),
      "the recovery turn was dispatched",
    );
    fixture.wired.stack.stack.pumpRuntime(sessionKey, 20);
    assert.ok(
      await waitFor(() =>
        fixture.outFrames.some(
          (entry) =>
            entry.frame.kind === "tts_sentence" &&
            entry.frame.text === "好呀，我们一起看看这道题。" &&
            (entry.frame.epoch as number) > epochBeforeAbort,
        ),
      ),
      "the recovery turn's sentence crossed on the new epoch",
    );
    await driver.destroy();
  } finally {
    await fixture.wired.stop();
    fixture.cleanup();
  }
});
