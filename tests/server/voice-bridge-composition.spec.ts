import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * R1-V2 full-stack composition tests (issue #29 验收): session.open →
 * turn.prompt → live deltas → turn.cancel → whenIdle → next turn →
 * session.close over the composed runtime (R1-V1 orchestrator + stream
 * gate + Bridge + mock Cordis runtime). On POSIX this runs over the REAL
 * local-socket IPC; where sockets cannot be opened (Windows dev sandbox)
 * the same frame protocol runs in-process.
 */

import { createVoiceBridgeStack, type VoiceBridgeStack } from "../../lib/server/voice-bridge-composition.ts";
import type { MockGenerationScript } from "../../lib/domain/voice/bridge/mock-cordis.ts";

const SESSION = "ses_stack0001";
const CONVERSATION = "conv_stack0001";
const OWNER = "act_owner0001";

const TRANSPORT = process.platform === "win32" ? "in_process" as const : "ipc" as const;

/** Child-safe synthetic script with a tool-call interlude. */
function scriptFor(_sessionKey: string, turnId: string): MockGenerationScript {
  const n = turnId.endsWith("2") ? "二" : "一";
  return [
    { channel: "text", text: `我们${n}起看这道题。` },
    { channel: "tool_call", text: '{"tool":"memory.lookup"}' },
    { channel: "text", text: "先找已知条件。" },
  ];
}

interface Fixture {
  readonly stack: VoiceBridgeStack;
  readonly cleanup: () => void;
}

async function createStack(): Promise<Fixture> {
  const socketDir = TRANSPORT === "ipc" ? mkdtempSync(join(tmpdir(), "lumithink-stack-")) : undefined;
  const stack = createVoiceBridgeStack({
    scriptFor,
    transport: TRANSPORT,
    endpointName: `lumithink-stack-${Math.floor(Math.random() * 0xffffff).toString(16)}`,
    ...(socketDir !== undefined ? { socketDir } : {}),
  });
  await stack.start();
  return {
    stack,
    cleanup: () => {
      if (socketDir !== undefined) {
        rmSync(socketDir, { recursive: true, force: true });
      }
    },
  };
}

test("a complete session flows open → prompt → live deltas → settle → close", async () => {
  const { stack, cleanup } = await createStack();
  try {
    const opened = await stack.openSession({ sessionKey: SESSION, conversationId: CONVERSATION, ownerActorId: OWNER });
    assert.ok(opened.ok && opened.recovered === false);
    assert.equal(stack.service.bridgeId, "lumi-dsh-runtime-bridge");

    const submitted = await stack.submitPrompt({
      sessionKey: SESSION,
      traceId: "trc_stack0001",
      idempotencyKey: "idem-stack-0001",
      fingerprint: "0123456789abcdef",
      transientText: "我们先找已知条件。",
    });
    assert.ok(submitted.ok && submitted.dispatched);
    const turnId = submitted.turnId;
    assert.equal(stack.orchestrator.describeTurn(SESSION, turnId)?.state, "RUNNING");

    // Drive the synthetic runtime: the deltas must stream in live. Event
    // delivery is asynchronous (real transport), so poll for the gate.
    stack.pumpRuntime(SESSION, 2);
    assert.equal(stack.orchestrator.describeTurn(SESSION, turnId)?.state, "RUNNING");
    assert.ok(
      await waitFor(() => stack.gate.metricsSnapshot().ttsAdmissions >= 1),
      "the first complete sentence was gated and admitted",
    );

    stack.pumpRuntime(SESSION, 20);
    assert.ok(
      await waitFor(() => stack.gate.metricsSnapshot().ttsAdmissions >= 2),
      "all sentences admitted through the output gate",
    );

    // Durable settlement arrives over IPC and settles the trusted turn.
    const settled = await waitFor(() => stack.orchestrator.describeTurn(SESSION, turnId)?.state === "COMPLETED");
    assert.ok(settled);

    // TTS queue belongs to the current epoch and delivers.
    const drain = stack.orchestrator.drainTts(SESSION);
    assert.ok(drain.ok && drain.deliverable.length >= 2 && drain.droppedStale === 0);

    const closed = await stack.client.command("session.close", { sessionKey: SESSION, reason: "orchestrator_close" });
    assert.ok(closed.ok);
  } finally {
    await stack.stop();
    cleanup();
  }
});

test("two barge-in rounds: fence first, in-process cancel, then the queued turn", async () => {
  const { stack, cleanup } = await createStack();
  try {
    assert.ok((await stack.openSession({ sessionKey: SESSION, conversationId: CONVERSATION, ownerActorId: OWNER })).ok);

    // Turn 1 runs; a barge-in interrupts it mid-stream.
    const t1 = await stack.submitPrompt({ sessionKey: SESSION, idempotencyKey: "idem-stack-0011", fingerprint: "0123456789abcdef", transientText: "第一轮的说法。" });
    assert.ok(t1.ok);
    stack.pumpRuntime(SESSION, 2);
    const epochBefore = stack.orchestrator.currentEpoch(SESSION);

    const cancel1 = await stack.bargeInCancel({ sessionKey: SESSION, turnId: t1.turnId, reason: "barge_in" });
    assert.ok(cancel1.ok);
    assert.ok((stack.orchestrator.currentEpoch(SESSION) ?? 0) > (epochBefore ?? 0), "the fence bumped the epoch");
    assert.equal(stack.orchestrator.describeTurn(SESSION, t1.turnId)?.state, "CANCELLED");
    assert.equal(stack.orchestrator.currentEpoch(SESSION), epochBefore! + 1);

    // Turn 2 (queued during the stop window) dispatches only after idle.
    const t2 = await stack.submitPrompt({ sessionKey: SESSION, idempotencyKey: "idem-stack-0012", fingerprint: "0123456789abcde0", transientText: "排队第二轮的说法。" });
    assert.ok(t2.ok);
    assert.equal(stack.orchestrator.describeTurn(SESSION, t2.turnId)?.state, "RUNNING", "the session is idle after confirmStop");
    stack.pumpRuntime(SESSION, 2);

    // Second barge-in mid-stream of turn 2.
    const cancel2 = await stack.bargeInCancel({ sessionKey: SESSION, turnId: t2.turnId, reason: "device_abort" });
    assert.ok(cancel2.ok);
    assert.equal(stack.orchestrator.describeTurn(SESSION, t2.turnId)?.state, "CANCELLED");

    // A third turn completes normally.
    const t3 = await stack.submitPrompt({ sessionKey: SESSION, idempotencyKey: "idem-stack-0013", fingerprint: "0123456789abcde1", transientText: "第三轮的说法。" });
    assert.ok(t3.ok);
    stack.pumpRuntime(SESSION, 20);
    assert.ok(
      await waitFor(() => stack.orchestrator.describeTurn(SESSION, t3.turnId)?.state === "COMPLETED"),
      "turn 3 completes",
    );

    // Candidate baseline metrics were collected (never claimed as SLAs).
    const metrics = stack.baselineMetrics();
    assert.ok(metrics.cancelAckMs.count >= 2);
    assert.ok(metrics.whenIdleMs.count >= 2);
    assert.ok(metrics.firstSafeTextMs.count >= 1);
    assert.ok(Number.isFinite(metrics.cancelAckMs.maxMs));
  } finally {
    await stack.stop();
    cleanup();
  }
});

test("a duplicate cancel is a no-op fence rejection and does not stop a newer turn", async () => {
  const { stack, cleanup } = await createStack();
  try {
    assert.ok((await stack.openSession({ sessionKey: SESSION, conversationId: CONVERSATION, ownerActorId: OWNER })).ok);
    const t1 = await stack.submitPrompt({ sessionKey: SESSION, idempotencyKey: "idem-stack-0021", fingerprint: "0123456789abcdef", transientText: "重复取消测试说法。" });
    assert.ok(t1.ok);
    stack.pumpRuntime(SESSION, 20);
    assert.ok(await waitFor(() => stack.orchestrator.describeTurn(SESSION, t1.turnId)?.state === "COMPLETED"));

    // Late cancel of a settled turn: fenced off without touching the agent.
    const late = await stack.bargeInCancel({ sessionKey: SESSION, turnId: t1.turnId, reason: "system_policy" });
    assert.ok(!late.ok && !late.fenced && late.code === "turn_terminal");
    assert.equal(stack.runtime.cancelCallCount(SESSION), 0);
  } finally {
    await stack.stop();
    cleanup();
  }
});

test("worker crash settles the turn FAILED and recovery is explicit", async () => {
  const { stack, cleanup } = await createStack();
  try {
    assert.ok((await stack.openSession({ sessionKey: SESSION, conversationId: CONVERSATION, ownerActorId: OWNER })).ok);
    const t1 = await stack.submitPrompt({ sessionKey: SESSION, idempotencyKey: "idem-stack-0031", fingerprint: "0123456789abcdef", transientText: "崩溃前的说法。" });
    assert.ok(t1.ok);
    stack.pumpRuntime(SESSION, 2);

    stack.runtime.crashNow(SESSION);
    assert.ok(
      await waitFor(() => stack.orchestrator.describeTurn(SESSION, t1.turnId)?.state === "FAILED"),
      "the crashed turn can never resume",
    );

    // While quarantined, a new prompt dispatches at the trusted store and
    // is refused by the Bridge; the refused turn is settled FAILED (liveness).
    const refused = await stack.submitPrompt({ sessionKey: SESSION, idempotencyKey: "idem-stack-0032", fingerprint: "0123456789abcde0", transientText: "隔离期的说法。" });
    assert.ok(!refused.ok && refused.code === "worker_recovering");

    // ...until an explicit reopen rebuilds the worker.
    const reopened = await stack.openSession({ sessionKey: SESSION, conversationId: CONVERSATION, ownerActorId: OWNER });
    assert.ok(reopened.ok && reopened.recovered);
    const t2 = await stack.submitPrompt({ sessionKey: SESSION, idempotencyKey: "idem-stack-0033", fingerprint: "0123456789abcde1", transientText: "恢复后的说法。" });
    assert.ok(t2.ok);
    stack.pumpRuntime(SESSION, 20);
    assert.ok(await waitFor(() => stack.orchestrator.describeTurn(SESSION, t2.turnId)?.state === "COMPLETED"));

    const metrics = stack.baselineMetrics();
    assert.ok(metrics.workerRecoveryMs.count >= 1, "recovery latency was captured as a candidate baseline");
  } finally {
    await stack.stop();
    cleanup();
  }
});

test("the transcript reaches the Fake Agent verbatim — and only there (issue #51)", async () => {
  const { stack, cleanup } = await createStack();
  try {
    assert.ok((await stack.openSession({ sessionKey: SESSION, conversationId: CONVERSATION, ownerActorId: OWNER })).ok);
    const marker = "睡前暗号zebra-42（伪私人标记）";
    const submitted = await stack.submitPrompt({
      sessionKey: SESSION,
      idempotencyKey: "idem-stack-0051",
      fingerprint: "0123456789abcdef",
      transientText: marker,
    });
    assert.ok(submitted.ok && submitted.dispatched);
    // 逐字到达受信 Fake Agent：recorded at dispatch, exact equality.
    const received = stack.runtime.receivedPromptsSnapshot(SESSION);
    const record = received.find((entry) => entry.turnId === submitted.turnId);
    assert.ok(record, "the dispatched turn's prompt was recorded by the agent");
    assert.equal(record.promptText, marker);

    stack.pumpRuntime(SESSION, 20);
    assert.ok(await waitFor(() => stack.orchestrator.describeTurn(SESSION, submitted.turnId)?.state === "COMPLETED"));

    // 零泄漏：审计/指标/快照/网关缓冲之外不存在该文本（唯一允许的位置是
    // 上面的 Fake Agent 收到的获批模型请求）。
    const surfaces = [
      ["orchestrator.audit", JSON.stringify(stack.orchestrator.auditSnapshot())],
      ["bridge.audit", JSON.stringify(stack.service.auditSnapshot())],
      ["bridge.metrics", JSON.stringify(stack.service.metricsSnapshot())],
      ["gate.metrics", JSON.stringify(stack.gate.metricsSnapshot())],
      ["orchestrator.snapshot", JSON.stringify(stack.orchestrator.exportState())],
      ["turn.records", JSON.stringify(stack.orchestrator.listTurns(SESSION))],
    ] as const;
    for (const [name, serialized] of surfaces) {
      assert.ok(!serialized.includes(marker), `${name} must not carry the transcript`);
    }
  } finally {
    await stack.stop();
    cleanup();
  }
});

test("a cancelled queued turn's held transcript is destroyed, never dispatched (issue #51)", async () => {
  const { stack, cleanup } = await createStack();
  try {
    assert.ok((await stack.openSession({ sessionKey: SESSION, conversationId: CONVERSATION, ownerActorId: OWNER })).ok);
    const t1 = await stack.submitPrompt({ sessionKey: SESSION, idempotencyKey: "idem-stack-0061", fingerprint: "0123456789abcdef", transientText: "正在播放的说法。" });
    assert.ok(t1.ok && t1.dispatched);
    stack.pumpRuntime(SESSION, 1);

    // t2 arrives while t1 runs: QUEUED, its transcript held in the vault.
    const queuedMarker = "排队时被打断的说法zebra-43";
    const t2 = await stack.submitPrompt({ sessionKey: SESSION, idempotencyKey: "idem-stack-0062", fingerprint: "0123456789abcde0", transientText: queuedMarker });
    assert.ok(t2.ok && !t2.dispatched, "the busy session keeps the turn queued");
    assert.equal(stack.orchestrator.describeTurn(SESSION, t2.turnId)?.state, "QUEUED");

    const cancel = await stack.bargeInCancel({ sessionKey: SESSION, turnId: t1.turnId, reason: "device_abort" });
    assert.ok(cancel.ok);
    assert.equal(stack.orchestrator.describeTurn(SESSION, t2.turnId)?.state, "CANCELLED", "the queued sibling is fenced with the target");

    // The queued turn never dispatched: its transcript must appear nowhere
    // on the agent side, and a later turn still dispatches normally.
    const received = stack.runtime.receivedPromptsSnapshot(SESSION);
    assert.ok(!JSON.stringify(received).includes(queuedMarker), "the cancelled turn's transcript was destroyed");
    const t3 = await stack.submitPrompt({ sessionKey: SESSION, idempotencyKey: "idem-stack-0063", fingerprint: "0123456789abcde1", transientText: "打断后的新说法。" });
    assert.ok(t3.ok && t3.dispatched);
    stack.pumpRuntime(SESSION, 20);
    assert.ok(await waitFor(() => stack.orchestrator.describeTurn(SESSION, t3.turnId)?.state === "COMPLETED"));
    const t3Record = stack.runtime.receivedPromptsSnapshot(SESSION).find((entry) => entry.turnId === t3.turnId);
    assert.equal(t3Record?.promptText, "打断后的新说法。");
  } finally {
    await stack.stop();
    cleanup();
  }
});

test("illegal IPC payloads are rejected enumerated, without executing", async () => {
  const { stack, cleanup } = await createStack();
  try {
    assert.ok((await stack.openSession({ sessionKey: SESSION, conversationId: CONVERSATION, ownerActorId: OWNER })).ok);
    // A malformed prompt payload (unregistered reason shape / bad grammar).
    const bad = await stack.client.command("turn.prompt", {
      sessionKey: SESSION,
      turnId: "trn_stack0001",
      epoch: 1,
      fingerprint: "not-hex",
      idempotencyKey: "idem-stack-0041",
    });
    assert.ok(!bad.ok && bad.code === "bridge.parse_failed");
    // An unknown session is refused on the wire too.
    const unknown = await stack.client.command("turn.stream", { sessionKey: "ses_unknown01", turnId: "trn_stack0001", epoch: 1 });
    assert.ok(!unknown.ok && unknown.code === "session_unknown");
    // The service audit carries no echo of the rejected payloads.
    const auditText = JSON.stringify(stack.service.auditSnapshot());
    assert.ok(!auditText.includes("not-hex"));
  } finally {
    await stack.stop();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Small polling helper (socket event delivery is asynchronous on POSIX).
// ---------------------------------------------------------------------------

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (predicate()) {
      return true;
    }
    if (Date.now() - start > timeoutMs) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
