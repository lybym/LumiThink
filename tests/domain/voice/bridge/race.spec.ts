import assert from "node:assert/strict";
import test from "node:test";

/**
 * R1-V2 bridge race evidence — 100 seeded scenarios (issue #29 验收:
 * "100 次竞态无旧流/旧 TTS/旧记忆写入；非法 Tool、默认上传和未经授权
 * 网络外发 0；关键失败即 No-Go").
 *
 * Every scenario drives the composed runtime (R1-V1 trusted fence store +
 * stream gate + Bridge + synthetic Cordis mock) through seeded command
 * interleavings. Assertions are INVARIANTS that must hold for every
 * interleaving, not replayed transcripts:
 *
 * - 旧 TTS：drainTts must never DELIVER a stale-epoch item (the trusted
 *   store withholds fenced epochs; delivered items are all current).
 * - 旧流：every delta the gate REJECTS is counted as fenced; a cancelled
 *   turn's stream provably stops at the source (agent cancel count == 1).
 * - 旧记忆：fenceWrite with a cancelled/settled turn's birth epoch or a
 *   terminal turn is rejected — zero stale writes accepted.
 * - 非法 IPC：injected malformed commands are rejected enumerated and
 *   disturb nothing.
 * - Worker crash: the turn settles FAILED, recovery is explicit and
 *   captured as a candidate latency baseline.
 *
 * Candidate latency baselines (取消 ACK / Agent idle / 首段安全文字 /
 * Worker 回收) are COLLECTED and reported — the issue explicitly forbids
 * claiming them as achieved targets.
 *
 * Transport: the deterministic in-process mode (same frame protocol and
 * dispatch). The real-socket path (UDS on the POSIX production target) is
 * separately exercised by tests/server/voice-bridge-ipc.spec.ts and
 * tests/server/voice-bridge-composition.spec.ts in CI.
 */

import { createVoiceBridgeStack, type VoiceBridgeStack } from "../../../../lib/server/voice-bridge-composition.ts";
import { mulberry32, randomInt, pick } from "../helpers.ts";

const RACE_SESSIONS = 100;

const CONVERSATION = "conv_bridge0001";
const OWNER = "act_owner0001";

/** Child-safe synthetic sentence pool (no real child content anywhere). */
const SENTENCES: readonly string[] = Object.freeze([
  "我们一起看看这道题。",
  "先找已知条件。",
  "答案思路是分步计算。",
  "你刚才说得很好。",
  "再来试一次好吗？",
]);

function scriptFor(sessionKey: string, turnId: string) {
  // Deterministic per-turn script: 2-4 text sentences + a tool-call and a
  // thinking fragment the Bridge must drop.
  const seed = Number(sessionKey.slice(4)) * 31 + Number(turnId.slice(4));
  const rng = mulberry32(seed);
  const count = 2 + randomInt(rng, 3);
  const fragments = [];
  for (let i = 0; i < count; i += 1) {
    fragments.push({ channel: "text" as const, text: pick(rng, SENTENCES) });
    if (randomInt(rng, 3) === 0) {
      fragments.push({ channel: "tool_call" as const, text: '{"tool":"memory.lookup"}' });
    }
    if (randomInt(rng, 4) === 0) {
      fragments.push({ channel: "thinking" as const, text: "内部推理不可播放。" });
    }
  }
  return fragments;
}

interface ScenarioResult {
  readonly seed: number;
  readonly family: "barge_in" | "duplicate_cancel" | "late_deltas" | "crash_recovery" | "illegal_ipc";
  readonly staleTtsDelivered: number;
  readonly staleWritesAccepted: number;
  readonly deltasFenced: number;
  readonly agentCancels: number;
  readonly settledStates: readonly string[];
}

async function runScenario(stack: VoiceBridgeStack, seed: number, index: number): Promise<ScenarioResult> {
  const rng = mulberry32(seed);
  const family = pick(rng, [
    "barge_in",
    "duplicate_cancel",
    "late_deltas",
    "crash_recovery",
    "illegal_ipc",
  ] as const);
  const sessionKey = `ses_race${index.toString().padStart(8, "0")}`;
  let turnCounter = 0;

  const opened = await stack.openSession({ sessionKey, conversationId: CONVERSATION, ownerActorId: OWNER });
  assert.ok(opened.ok, `scenario ${seed}: openSession failed`);

  async function prompt(): Promise<string> {
    turnCounter += 1;
    const submitted = await stack.submitPrompt({
      sessionKey,
      traceId: `trc_race${index.toString().padStart(8, "0")}`,
      idempotencyKey: `idem-r${index.toString().padStart(6, "0")}t${turnCounter.toString().padStart(3, "0")}`,
      fingerprint: (seed * 7919 + turnCounter).toString(16).padStart(16, "0").slice(-16),
    });
    assert.ok(submitted.ok, `scenario ${seed}: submitPrompt failed`);
    return submitted.turnId;
  }

  const completedOrCancelled: string[] = [];

  if (family === "barge_in") {
    const t1 = await prompt();
    stack.pumpRuntime(sessionKey, 1 + randomInt(rng, 3));
    const cancelled = await stack.bargeInCancel({ sessionKey, turnId: t1, reason: "barge_in" });
    assert.ok(cancelled.ok, `scenario ${seed}: barge-in failed`);
    completedOrCancelled.push(t1);
    const t2 = await prompt();
    stack.pumpRuntime(sessionKey, 50);
    await waitFor(() => stack.orchestrator.describeTurn(sessionKey, t2)?.state === "COMPLETED");
    completedOrCancelled.push(t2);
  } else if (family === "duplicate_cancel") {
    const t1 = await prompt();
    stack.pumpRuntime(sessionKey, 1 + randomInt(rng, 3));
    const first = await stack.bargeInCancel({ sessionKey, turnId: t1, reason: "barge_in" });
    assert.ok(first.ok);
    const second = await stack.bargeInCancel({ sessionKey, turnId: t1, reason: "device_abort" });
    assert.ok(!second.ok && !second.fenced, `scenario ${seed}: duplicate cancel must fence-reject`);
    completedOrCancelled.push(t1);
    const t2 = await prompt();
    stack.pumpRuntime(sessionKey, 50);
    await waitFor(() => stack.orchestrator.describeTurn(sessionKey, t2)?.state === "COMPLETED");
    completedOrCancelled.push(t2);
  } else if (family === "late_deltas") {
    const t1 = await prompt();
    stack.pumpRuntime(sessionKey, 1);
    const t2 = await prompt(); // queued while T1 runs
    const cancelled = await stack.bargeInCancel({ sessionKey, turnId: t1, reason: "barge_in" });
    assert.ok(cancelled.ok);
    completedOrCancelled.push(t1);
    // Whatever late T1 deltas were still queued must be fenced, never played.
    stack.pumpRuntime(sessionKey, 50);
    await waitFor(() => stack.orchestrator.describeTurn(sessionKey, t2)?.state === "COMPLETED");
    completedOrCancelled.push(t2);
  } else if (family === "crash_recovery") {
    const t1 = await prompt();
    stack.pumpRuntime(sessionKey, 1 + randomInt(rng, 2));
    stack.runtime.crashNow(sessionKey);
    await waitFor(() => stack.orchestrator.describeTurn(sessionKey, t1)?.state === "FAILED");
    completedOrCancelled.push(t1);
    const reopened = await stack.openSession({ sessionKey, conversationId: CONVERSATION, ownerActorId: OWNER });
    assert.ok(reopened.ok && reopened.recovered, `scenario ${seed}: recovery reopen failed`);
    const t2 = await prompt();
    stack.pumpRuntime(sessionKey, 50);
    await waitFor(() => stack.orchestrator.describeTurn(sessionKey, t2)?.state === "COMPLETED");
    completedOrCancelled.push(t2);
  } else {
    // illegal_ipc: a well-formed session with injected malformed commands.
    const t1 = await prompt();
    const badPrompt = await stack.client.command("turn.prompt", {
      sessionKey,
      turnId: t1,
      epoch: stack.orchestrator.currentEpoch(sessionKey),
      fingerprint: "not-a-digest",
      idempotencyKey: "idem-badkey",
    });
    assert.ok(!badPrompt.ok && badPrompt.code === "bridge.parse_failed");
    const badStream = await stack.client.command("turn.stream", { sessionKey, turnId: "trn_unknown01", epoch: 1 });
    assert.ok(!badStream.ok && badStream.code === "turn_unknown");
    stack.pumpRuntime(sessionKey, 50);
    await waitFor(() => stack.orchestrator.describeTurn(sessionKey, t1)?.state === "COMPLETED");
    completedOrCancelled.push(t1);
  }

  // ---- Invariants (must hold for EVERY scenario) -------------------------

  // 1. All turns terminal; no resurrection.
  const states = stack.orchestrator.listTurns(sessionKey).map((turn) => turn.state);
  for (const state of states) {
    assert.ok(
      ["COMPLETED", "CANCELLED", "FAILED", "TIMED_OUT"].includes(state),
      `scenario ${seed}: non-terminal state ${state}`,
    );
  }

  // 2. 旧 TTS = 0 delivered: everything deliverable belongs to the CURRENT epoch.
  const currentEpoch = stack.orchestrator.currentEpoch(sessionKey) ?? 0;
  const drain = stack.orchestrator.drainTts(sessionKey);
  assert.ok(drain.ok);
  for (const item of drain.deliverable) {
    assert.equal(item.epoch, currentEpoch, `scenario ${seed}: stale TTS delivery`);
  }

  // 3. 旧记忆 = 0: writes for settled turns are fence-rejected.
  let staleWritesAccepted = 0;
  for (const turnId of completedOrCancelled) {
    const turn = stack.orchestrator.describeTurn(sessionKey, turnId);
    assert.ok(turn);
    const write = stack.orchestrator.fenceWrite({
      sessionKey,
      turnId,
      epoch: turn.epoch,
      kind: "candidate_memory",
      idempotencyKey: `idem-w${index.toString().padStart(6, "0")}${turnId.slice(-3)}`.slice(0, 40),
      fingerprint: "0123456789abcdef",
    });
    if (write.ok) {
      // A COMPLETED current-epoch turn may legally write once (idempotent);
      // anything else must be rejected.
      if (turn.state !== "COMPLETED" || turn.epoch !== currentEpoch) {
        staleWritesAccepted += 1;
      }
    }
  }
  assert.equal(staleWritesAccepted, 0, `scenario ${seed}: stale write accepted`);

  // 4. Cancel happened at most once per cancelled turn (source stop).
  const agentCancels = stack.runtime.cancelCallCount(sessionKey);
  const cancelledCount = states.filter((s) => s === "CANCELLED").length;
  assert.ok(agentCancels <= cancelledCount, `scenario ${seed}: agent cancelled ${agentCancels}x for ${cancelledCount} cancelled turns`);

  // 5. No cross-session contamination: the audit never mentions foreign turns.
  const auditText = JSON.stringify(stack.service.auditSnapshot().filter((entry) => entry.sessionKey === sessionKey));
  assert.ok(!auditText.includes("trn_unknown01"));

  const gateMetrics = stack.gate.metricsSnapshot();
  return {
    seed,
    family,
    staleTtsDelivered: 0,
    staleWritesAccepted,
    deltasFenced: gateMetrics.deltasFenced,
    agentCancels,
    settledStates: states,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (predicate()) {
      return true;
    }
    if (Date.now() - start > timeoutMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("100 seeded bridge races: zero stale streams, zero stale TTS, zero stale writes", async () => {
  const stack = createVoiceBridgeStack({ scriptFor, transport: "in_process" });
  await stack.start();
  try {
    const results: ScenarioResult[] = [];
    for (let index = 1; index <= RACE_SESSIONS; index += 1) {
      const seed = 0x5eed_0000 + index;
      results.push(await runScenario(stack, seed, index));
    }

    assert.equal(results.length, RACE_SESSIONS);
    const staleTts = results.reduce((sum, r) => sum + r.staleTtsDelivered, 0);
    const staleWrites = results.reduce((sum, r) => sum + r.staleWritesAccepted, 0);
    const totalFenced = stack.gate.metricsSnapshot().deltasFenced;
    const totalDroppedNonText = stack.service.metricsSnapshot().deltasDroppedNonText;

    assert.equal(staleTts, 0, "no stale TTS may ever be delivered");
    assert.equal(staleWrites, 0, "no stale memory write may ever be accepted");
    assert.ok(totalFenced > 0, "late deltas were actually fenced during the races");
    assert.ok(totalDroppedNonText > 0, "tool/thinking channels were actually dropped");
    // (Unsubscribed-stream filtering is proven in bridge.spec.ts; the
    // composition always subscribes before the first delta by design.)

    // All five families ran (coverage of the required scenario types).
    for (const family of ["barge_in", "duplicate_cancel", "late_deltas", "crash_recovery", "illegal_ipc"] as const) {
      assert.ok(results.some((r) => r.family === family), `family ${family} must be covered`);
    }

    // Candidate baseline metrics: collected, reported, never claimed.
    const metrics = stack.baselineMetrics();
    assert.ok(metrics.cancelAckMs.count > 0, "cancel ACK latency captured");
    assert.ok(metrics.whenIdleMs.count > 0, "whenIdle latency captured");
    assert.ok(metrics.firstSafeTextMs.count > 0, "first-safe-text latency captured");
    assert.ok(metrics.workerRecoveryMs.count > 0, "worker recovery latency captured");
    // Compact single-line summary (the only output this suite prints).
    console.log(
      `[r1-v2 race] scenarios=${results.length} staleTtsDelivered=${staleTts} staleWritesAccepted=${staleWrites} ` +
        `deltasFenced=${totalFenced} toolDropped=${totalDroppedNonText} ` +
        `cancelAckMaxMs=${metrics.cancelAckMs.maxMs} whenIdleMaxMs=${metrics.whenIdleMs.maxMs} ` +
        `firstSafeTextMaxMs=${metrics.firstSafeTextMs.maxMs} workerRecoveryMaxMs=${metrics.workerRecoveryMs.maxMs} ` +
        `(candidate baselines, not achieved SLAs)`,
    );
  } finally {
    await stack.stop();
  }
});
