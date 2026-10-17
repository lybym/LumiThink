import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * E2E-11 (issue #61) — reliability regression on the REAL composed voice
 * gateway stack (Voice Gateway Adapter + R1-V1 trusted Orchestrator + R1-V2
 * Bridge + synthetic Cordis runtime; deterministic in-process transport —
 * the real-socket path is exercised by the E2E-07 wiring gate).
 *
 * The issue's fault-injection matrix at the composed-core level (the wired
 * device-transport faults live in deploy/xiaozhi/probe_e2e11.py + the
 * e2e-07 gate; the physical matrix lives in runbook §14):
 *
 *   1. model hang / DSH unresponsive  → the gateway timeout sweep settles
 *      the stuck turn TIMED_OUT, the device gets exactly ONE stop, the
 *      device received ZERO frames for the hung turn, and the LATE runtime
 *      stream after the sweep is fully benign: no late frames past the
 *      stop (fence re-checks turn state at every audio_send), no
 *      resurrection (the turn stays TIMED_OUT), and the next turn
 *      completes in full — no deadlock (#48's whenIdle/timeout risk class,
 *      composed-stack face; the bounded-whenIdle face is proven by the
 *      E2E-02 runtime gate).
 *   2. cancel flood (取消洪泛) → exactly ONE fence per playback turn, the
 *      burst and the idle burst are enumerated no-ops, zero stale frames
 *      past the stop, the recovery turn completes (#49/#59 regression
 *      shape, sustained).
 *   3. persistence/recovery consistency under a cancel flood → the REAL
 *      transactional SQLite fence store: repeated cancels, post-fence
 *      writes rejected, stale TTS queue dropped, process restart keeps the
 *      epoch monotonic, cancelled turns stay cancelled, nothing is
 *      resurrected, and new work continues from the restored epoch.
 *
 * Every assertion is deterministic and value-free (ids/codes/counts only);
 * the audit rings must stay content-free.
 */

import { createVoiceGatewayStack, type VoiceGatewayStack } from "../../lib/server/voice-gateway-composition.ts";
import { createMockXiaozhiGateway, type MockXiaozhiGateway } from "../../lib/domain/voice/adapter/mock-xiaozhi.ts";
import { GATEWAY_SYNTHETIC_SENTENCES } from "../../lib/domain/voice/adapter/fixtures.ts";
import { createSqliteVoiceFenceStore } from "../../lib/server/voice-turn-sqlite-store.ts";
import { createVoiceTurnOrchestrator } from "../../lib/domain/voice/orchestrator.ts";
import {
  createTtsItemIdFactory,
  createTurnIdFactory,
  createVirtualClock,
  mulberry32,
  pick,
  syntheticFingerprint,
  testActorId,
  testConversationId,
  testSessionKey,
  testTraceId,
} from "../domain/voice/helpers.ts";

const TERMINAL_STATES: readonly string[] = ["COMPLETED", "CANCELLED", "FAILED", "TIMED_OUT"];
/** The guardian-issued activation digest used for the fixture device. */
const ACTIVATION = "0123456789abcdef0123456789abcdef";
/** The hello possession proof: the device-held activation digest itself. */
const HELLO_PROOF = ACTIVATION;
/** Well above the gateway sweep budget default (30s) on the virtual clock. */
const HANG_BUDGET_MS = 60_000;

// ---------------------------------------------------------------------------
// Composed-stack harness (deterministic clock, seeded synthetic samples)
// ---------------------------------------------------------------------------

interface Harness {
  readonly gw: VoiceGatewayStack;
  readonly mock: MockXiaozhiGateway;
  readonly seed: number;
  advanceClock(ms: number): void;
  stop(): Promise<void>;
}

function createHarness(seed: number): Harness {
  const mock = createMockXiaozhiGateway();
  let nowMs = 1_000;
  const clock = (): number => {
    nowMs += 1;
    return nowMs;
  };
  const gw = createVoiceGatewayStack({
    scriptFor: (sessionKey) => {
      const seedHex = sessionKey.slice(6, 14) + "00";
      const scriptRng = mulberry32(parseInt(seedHex, 16) >>> 0);
      const count = 2 + Math.floor(scriptRng() * 2);
      const fragments = [];
      for (let i = 0; i < count; i += 1) {
        fragments.push({ channel: "text" as const, text: pick(scriptRng, GATEWAY_SYNTHETIC_SENTENCES) });
        if (scriptRng() < 0.34) {
          fragments.push({ channel: "tool_call" as const, text: '{"tool":"memory.lookup"}' });
        }
      }
      return fragments;
    },
    transport: "in_process",
    framesPerSentence: 4,
    turnIdFactory: createTurnIdFactory(seed),
    clock,
    directiveSink: (directive) => {
      mock.applyDirective(directive);
    },
  });
  return {
    gw,
    mock,
    seed,
    advanceClock: (ms: number) => {
      nowMs += ms;
    },
    stop: () => gw.stop(),
  };
}

/** Flush the in-process event queue: Bridge events are delivered in
 * microtasks behind the client's ordered queue — a macrotask tick flushes
 * all of them deterministically (no wall-clock dependence). */
function flushEventQueue(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function feedAll(harness: Harness): Promise<void> {
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

async function connectDevice(
  harness: Harness,
  deviceId: string,
  connectionId: string,
): Promise<string> {
  const bound = harness.gw.bindDevice({
    deviceId,
    actorId: "act_owner0001",
    conversationId: "conv_child0001",
    activationDigest: ACTIVATION,
  });
  assert.ok(bound.ok, `seed ${harness.seed}: guardian binding must succeed`);
  harness.mock.connect({ connectionId, deviceId, clientDigest: HELLO_PROOF });
  await feedAll(harness);
  const sessionKey = harness.gw.findSessionKeyByDevice(deviceId);
  assert.ok(sessionKey, `seed ${harness.seed}: device binding must yield a trusted session`);
  harness.mock.serverAccept(connectionId);
  await feedAll(harness);
  return sessionKey as string;
}

/** Dispatch synthetic runtime output and let every Bridge event settle. */
async function pumpAndFlush(harness: Harness, sessionKey: string, max = 200): Promise<void> {
  harness.gw.stack.pumpRuntime(sessionKey, max);
  await flushEventQueue();
}

/** Drive the session to a terminal state (bounded rounds — a stuck turn is
 * a real deadlock and must fail the test, never hang). */
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

/** 旧响应泄漏 0: no accepted frame batch may occur after the device APPLIED
 * the stop of its turn (same invariant discipline as fault-injection.spec). */
function countStaleFramesPlayed(harness: Harness): number {
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
  return staleFramesPlayed;
}

function assertCommonInvariants(harness: Harness, sessionKeys: readonly string[]): void {
  // 1. All trusted turns terminal — no deadlock, no resurrection.
  for (const sessionKey of sessionKeys) {
    for (const turn of harness.gw.stack.orchestrator.listTurns(sessionKey)) {
      assert.ok(
        TERMINAL_STATES.includes(turn.state),
        `seed ${harness.seed}: turn ${turn.turnId} stayed ${turn.state}`,
      );
    }
    // 2. In-process agent cancels: at most one per cancelled turn.
    const cancels = harness.gw.stack.runtime.cancelCallCount(sessionKey);
    const cancelled = harness.gw.stack.orchestrator
      .listTurns(sessionKey)
      .filter((turn) => turn.state === "CANCELLED").length;
    assert.ok(cancels <= cancelled, `seed ${harness.seed}: agent cancel ${cancels}x for ${cancelled} cancelled turns`);
  }
  // 3. 旧响应泄漏 0 past an applied stop.
  assert.equal(countStaleFramesPlayed(harness), 0, `seed ${harness.seed}: old responses leaked past a stop`);
  // 4. All audit rings are content-free.
  const auditJson = JSON.stringify([
    ...harness.gw.adapter.auditSnapshot(),
    ...harness.gw.stack.orchestrator.auditSnapshot(),
    ...harness.gw.stack.service.auditSnapshot(),
  ]);
  for (const sentence of GATEWAY_SYNTHETIC_SENTENCES) {
    assert.ok(!auditJson.includes(sentence), `seed ${harness.seed}: transcript text leaked into audit`);
  }
}

// ---------------------------------------------------------------------------
// 1. Model hang / DSH unresponsive → sweep → benign late stream
// ---------------------------------------------------------------------------

test("model hang: the sweep settles the stuck turn TIMED_OUT, the device gets one stop and zero frames after it, and the late stream stays fully benign", async () => {
  const seed = 0xe11_0001;
  const harness = createHarness(seed);
  await harness.gw.start();
  try {
    const deviceId = "aabbcc0000e1";
    const sessionKey = await connectDevice(harness, deviceId, "conn_e2e11_hang");
    const rng = mulberry32(seed);

    // Dispatch a turn, stream a little (playback starts), then never pump
    // again: the model hangs MID-PLAYBACK (the DSH-hang proxy at the
    // composed-core level).
    harness.mock.speakFinal("conn_e2e11_hang", pick(rng, GATEWAY_SYNTHETIC_SENTENCES));
    await feedAll(harness);
    const dispatched = harness.gw.stack.orchestrator
      .listTurns(sessionKey)
      .find((turn) => turn.state === "RUNNING");
    assert.ok(dispatched, "the turn must be dispatched before the sweep");
    const hungTurnId = dispatched.turnId;
    await pumpAndFlush(harness, sessionKey, 2);
    harness.gw.pumpPlayback(sessionKey);
    const framesWhileHanging = harness.mock
      .appliedLog()
      .filter(
        (applied) =>
          applied.directive.kind === "tts.frames" &&
          applied.directive.turnId === hungTurnId &&
          applied.accepted,
      );
    assert.ok(framesWhileHanging.length >= 1, "playback must have started before the hang");

    // Advance past the sweep budget and sweep.
    harness.advanceClock(HANG_BUDGET_MS);
    const swept = harness.gw.sweep(sessionKey);
    assert.ok(swept.ok && swept.timedOutTurnIds.includes(hungTurnId), "the hung turn must be swept");
    assert.equal(
      harness.gw.stack.orchestrator.describeTurn(sessionKey, hungTurnId)?.state,
      "TIMED_OUT",
      "the hung turn must be terminal TIMED_OUT",
    );

    // The device got exactly ONE stop for the hung turn, accepted.
    const stops = harness.mock
      .appliedLog()
      .filter(
        (applied) =>
          applied.directive.kind === "tts.stop" &&
          applied.directive.turnId === hungTurnId &&
          applied.deviceCode === "ok",
      );
    assert.equal(stops.length, 1, "exactly one accepted stop for the hung turn");

    // The LATE runtime stream arrives after the sweep: every delta is
    // fenced (turn terminal), nothing resurrects, nothing leaks.
    await pumpAndFlush(harness, sessionKey);
    assert.equal(
      harness.gw.stack.orchestrator.describeTurn(sessionKey, hungTurnId)?.state,
      "TIMED_OUT",
      "the late stream must not resurrect the swept turn",
    );
    assert.equal(
      countStaleFramesPlayed(harness),
      0,
      "no device frame may cross after the hung turn's stop",
    );

    // The next turn completes in full — no deadlock after the hang.
    harness.mock.speakFinal("conn_e2e11_hang", pick(rng, GATEWAY_SYNTHETIC_SENTENCES));
    await feedAll(harness);
    await settleAll(harness, sessionKey);
    const recoveryTurn = harness.gw.stack.orchestrator
      .listTurns(sessionKey)
      .find((turn) => turn.turnId !== hungTurnId);
    assert.ok(recoveryTurn && recoveryTurn.state === "COMPLETED", "the recovery turn must complete");
    const recoveryFrames = harness.mock
      .appliedLog()
      .filter(
        (applied) =>
          applied.directive.kind === "tts.frames" &&
          applied.directive.turnId === recoveryTurn.turnId &&
          applied.accepted,
      );
    assert.ok(recoveryFrames.length >= 1, "the recovery turn must deliver audio");

    assertCommonInvariants(harness, [sessionKey]);
  } finally {
    await harness.stop();
  }
});

// ---------------------------------------------------------------------------
// 2. Cancel flood (取消洪泛)
// ---------------------------------------------------------------------------

test("cancel flood: exactly one fence per playback turn, the burst and idle burst are no-ops, zero stale frames, recovery completes", async () => {
  const seed = 0xe11_0002;
  const harness = createHarness(seed);
  await harness.gw.start();
  try {
    const deviceId = "aabbcc0000e2";
    const connectionId = "conn_e2e11_flood";
    const sessionKey = await connectDevice(harness, deviceId, connectionId);
    const rng = mulberry32(seed);

    // Turn 1: get it playing, then flood aborts in ONE batch (the first
    // fences; the rest land while playback is already stopping/stopped).
    harness.mock.speakFinal(connectionId, pick(rng, GATEWAY_SYNTHETIC_SENTENCES));
    await feedAll(harness);
    await pumpAndFlush(harness, sessionKey, 2);
    harness.gw.pumpPlayback(sessionKey);
    const playingTurn = harness.gw.stack.orchestrator
      .listTurns(sessionKey)
      .find((turn) => turn.state === "RUNNING");
    assert.ok(playingTurn, "turn 1 must be running before the flood");
    for (let i = 0; i < 10; i += 1) {
      harness.mock.abortSpeaking(connectionId, i === 0 ? "wake_word_detected" : "manual");
    }
    await feedAll(harness);

    const metricsAfterFlood = harness.gw.adapterMetrics();
    assert.equal(metricsAfterFlood.abortsFenced, 1, "exactly one fence for the playing turn");
    assert.ok(metricsAfterFlood.abortsWithoutPlayback >= 9, "the flood tail must be enumerated no-ops");
    assert.ok(metricsAfterFlood.playbackStopsIssued <= 1, "no duplicate stop directives");
    assert.equal(
      harness.gw.stack.orchestrator.describeTurn(sessionKey, playingTurn.turnId)?.state,
      "CANCELLED",
      "the flooded turn must be CANCELLED",
    );

    // Idle burst with nothing playing: still no-ops, still one fence/stop.
    for (let i = 0; i < 5; i += 1) {
      harness.mock.abortSpeaking(connectionId, "manual");
    }
    await feedAll(harness);
    const metricsAfterIdle = harness.gw.adapterMetrics();
    assert.equal(metricsAfterIdle.abortsFenced, 1, "no fence without playback");
    assert.ok(metricsAfterIdle.abortsWithoutPlayback >= 14, "the idle burst must be no-ops");
    assert.ok(metricsAfterIdle.playbackStopsIssued <= 1, "no stop without playback");

    // Turn 2 completes in full after the flood.
    harness.mock.speakFinal(connectionId, pick(rng, GATEWAY_SYNTHETIC_SENTENCES));
    await feedAll(harness);
    await settleAll(harness, sessionKey);
    const turn2 = harness.gw.stack.orchestrator
      .listTurns(sessionKey)
      .find((turn) => turn.turnId !== playingTurn.turnId);
    assert.ok(turn2 && turn2.state === "COMPLETED", "the post-flood turn must complete");
    const turn2Frames = harness.mock
      .appliedLog()
      .filter(
        (applied) =>
          applied.directive.kind === "tts.frames" &&
          applied.directive.turnId === turn2.turnId &&
          applied.accepted,
      );
    assert.ok(turn2Frames.length >= 1, "the post-flood turn must deliver audio");

    assertCommonInvariants(harness, [sessionKey]);
  } finally {
    await harness.stop();
  }
});

// ---------------------------------------------------------------------------
// 3. Persistence/recovery consistency under a cancel flood (real SQLite)
// ---------------------------------------------------------------------------

test("sqlite persistence under a cancel flood: post-fence writes rejected, stale TTS dropped, restart keeps epoch monotonic and nothing resurrects", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "lumithink-e2e11-")), "voice-fence.db");
  const SESSION = testSessionKey(311);
  const OWNER = testActorId(311);
  const CONVERSATION = testConversationId(311);
  const ttsItemId = createTtsItemIdFactory();
  const turnIds = createTurnIdFactory();
  let firstTurnId = "";
  let secondTurnId = "";

  {
    const store = createSqliteVoiceFenceStore({ path: dir });
    const clock = createVirtualClock();
    const orchestrator = createVoiceTurnOrchestrator({ store, clock: clock.now, turnIdFactory: turnIds });
    assert.ok(orchestrator.openSession({ sessionKey: SESSION, conversationId: CONVERSATION, ownerActorId: OWNER }).ok);

    // Turn 1 playing with one queued TTS item, then cancelled (epoch 2).
    const first = orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(1) });
    assert.ok(first.ok && first.dispatchedTurnId === first.turn.turnId);
    firstTurnId = first.turn.turnId;
    assert.ok(
      orchestrator.fenceOutput({ sessionKey: SESSION, turnId: firstTurnId, epoch: 1, kind: "tts_queue", ttsItemId: ttsItemId() }).ok,
    );
    const cancel1 = orchestrator.cancelTurn({ sessionKey: SESSION, turnId: firstTurnId, reason: "barge_in" });
    assert.ok(cancel1.ok && cancel1.epoch === 2);
    assert.ok(orchestrator.confirmStop({ sessionKey: SESSION, turnId: firstTurnId }).ok);

    // Turn 2 dispatched at epoch 2 with a queued item, then flooded:
    // repeated cancels, post-fence writes and forged epochs all rejected.
    const second = orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(2) });
    assert.ok(second.ok && second.turn.epoch === 2 && second.dispatchedTurnId === second.turn.turnId);
    secondTurnId = second.turn.turnId;
    assert.ok(
      orchestrator.fenceOutput({ sessionKey: SESSION, turnId: secondTurnId, epoch: 2, kind: "tts_queue", ttsItemId: ttsItemId() }).ok,
    );
    const cancel2 = orchestrator.cancelTurn({ sessionKey: SESSION, turnId: secondTurnId, reason: "barge_in" });
    assert.ok(cancel2.ok && cancel2.epoch === 3);
    assert.deepEqual(
      orchestrator.cancelTurn({ sessionKey: SESSION, turnId: secondTurnId, reason: "barge_in" }),
      { ok: false, code: "cancel_already_active" },
      "a repeated flood cancel while CANCELLING must be enumerated",
    );
    assert.ok(orchestrator.confirmStop({ sessionKey: SESSION, turnId: secondTurnId }).ok);
    assert.deepEqual(
      orchestrator.cancelTurn({ sessionKey: SESSION, turnId: secondTurnId, reason: "barge_in" }),
      { ok: false, code: "turn_terminal" },
      "a flood cancel after the terminal stop must be a terminal rejection",
    );
    assert.deepEqual(
      orchestrator.fenceOutput({ sessionKey: SESSION, turnId: secondTurnId, epoch: 3, kind: "tts_queue", ttsItemId: ttsItemId() }),
      { ok: false, code: "stale_turn_rejected" },
      "a post-fence queue admission must be fenced",
    );
    assert.deepEqual(
      store.fenceWrite({
        sessionKey: SESSION,
        turnId: secondTurnId,
        epoch: 3,
        kind: "candidate_memory",
        idempotencyKey: "idem-e2e11-000001",
        fingerprint: syntheticFingerprint({ memory: "synthetic candidate" }),
        nowMs: clock.now(),
      }),
      { ok: false, code: "stale_turn_rejected" },
      "a post-fence memory write must be fenced",
    );
    assert.deepEqual(
      store.fenceWrite({
        sessionKey: SESSION,
        turnId: secondTurnId,
        epoch: 9,
        kind: "candidate_memory",
        idempotencyKey: "idem-e2e11-000002",
        fingerprint: syntheticFingerprint({ memory: "forged epoch" }),
        nowMs: clock.now(),
      }),
      { ok: false, code: "epoch_forged" },
    );

    // The whole flood's TTS is stale: everything drops, nothing delivers.
    const drained = orchestrator.drainTts(SESSION);
    assert.ok(drained.ok && drained.droppedStale === 2 && drained.deliverable.length === 0);
    store.close();
  }

  {
    // "Process restart": a brand-new store over the same file.
    const store = createSqliteVoiceFenceStore({ path: dir });
    try {
      const clock = createVirtualClock();
      const orchestrator = createVoiceTurnOrchestrator({ store, clock: clock.now, turnIdFactory: turnIds });
      assert.equal(orchestrator.currentEpoch(SESSION), 3, "the trusted epoch survives the restart");

      // Flooded turns stay cancelled — no resurrection after recovery.
      assert.equal(orchestrator.describeTurn(SESSION, firstTurnId)?.state, "CANCELLED");
      assert.equal(orchestrator.describeTurn(SESSION, secondTurnId)?.state, "CANCELLED");
      assert.deepEqual(
        orchestrator.cancelTurn({ sessionKey: SESSION, turnId: firstTurnId, reason: "barge_in" }),
        { ok: false, code: "turn_terminal" },
      );

      // The dropped stale TTS stays gone after the restart.
      const drained = orchestrator.drainTts(SESSION);
      assert.ok(drained.ok && drained.deliverable.length === 0 && drained.droppedStale === 0);

      // New work continues FROM the restored epoch, monotonically.
      const third = orchestrator.receivePrompt({ sessionKey: SESSION, traceId: testTraceId(3) });
      assert.ok(third.ok && third.turn.epoch === 3 && third.dispatchedTurnId === third.turn.turnId);
      const cancel3 = orchestrator.cancelTurn({ sessionKey: SESSION, turnId: third.turn.turnId, reason: "barge_in" });
      assert.ok(cancel3.ok && cancel3.epoch === 4, "restart must not reset or fork the epoch");
      assert.deepEqual(
        store.fenceWrite({
          sessionKey: SESSION,
          turnId: third.turn.turnId,
          epoch: 3,
          kind: "candidate_memory",
          idempotencyKey: "idem-e2e11-000003",
          fingerprint: syntheticFingerprint({ memory: "late after restore" }),
          nowMs: clock.now(),
        }),
        { ok: false, code: "stale_turn_rejected" },
      );
      for (const entry of orchestrator.auditSnapshot()) {
        assert.ok(
          ["seq", "atMs", "action", "sessionKey", "turnId", "traceId", "epoch", "resultCode", "finalState", "count"].every(
            (key) => key in entry,
          ),
          "the audit ring stays structural through the SQLite-backed path",
        );
      }
    } finally {
      store.close();
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  }
});
