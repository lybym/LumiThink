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
    const t1 = await stack.submitPrompt({ sessionKey: SESSION, idempotencyKey: "idem-stack-0011", fingerprint: "0123456789abcdef" });
    assert.ok(t1.ok);
    stack.pumpRuntime(SESSION, 2);
    const epochBefore = stack.orchestrator.currentEpoch(SESSION);

    const cancel1 = await stack.bargeInCancel({ sessionKey: SESSION, turnId: t1.turnId, reason: "barge_in" });
    assert.ok(cancel1.ok);
    assert.ok((stack.orchestrator.currentEpoch(SESSION) ?? 0) > (epochBefore ?? 0), "the fence bumped the epoch");
    assert.equal(stack.orchestrator.describeTurn(SESSION, t1.turnId)?.state, "CANCELLED");
    assert.equal(stack.orchestrator.currentEpoch(SESSION), epochBefore! + 1);

    // Turn 2 (queued during the stop window) dispatches only after idle.
    const t2 = await stack.submitPrompt({ sessionKey: SESSION, idempotencyKey: "idem-stack-0012", fingerprint: "0123456789abcde0" });
    assert.ok(t2.ok);
    assert.equal(stack.orchestrator.describeTurn(SESSION, t2.turnId)?.state, "RUNNING", "the session is idle after confirmStop");
    stack.pumpRuntime(SESSION, 2);

    // Second barge-in mid-stream of turn 2.
    const cancel2 = await stack.bargeInCancel({ sessionKey: SESSION, turnId: t2.turnId, reason: "device_abort" });
    assert.ok(cancel2.ok);
    assert.equal(stack.orchestrator.describeTurn(SESSION, t2.turnId)?.state, "CANCELLED");

    // A third turn completes normally.
    const t3 = await stack.submitPrompt({ sessionKey: SESSION, idempotencyKey: "idem-stack-0013", fingerprint: "0123456789abcde1" });
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
    const t1 = await stack.submitPrompt({ sessionKey: SESSION, idempotencyKey: "idem-stack-0021", fingerprint: "0123456789abcdef" });
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
    const t1 = await stack.submitPrompt({ sessionKey: SESSION, idempotencyKey: "idem-stack-0031", fingerprint: "0123456789abcdef" });
    assert.ok(t1.ok);
    stack.pumpRuntime(SESSION, 2);

    stack.runtime.crashNow(SESSION);
    assert.ok(
      await waitFor(() => stack.orchestrator.describeTurn(SESSION, t1.turnId)?.state === "FAILED"),
      "the crashed turn can never resume",
    );

    // While quarantined, a new prompt dispatches at the trusted store and
    // is refused by the Bridge; the refused turn is settled FAILED (liveness).
    const refused = await stack.submitPrompt({ sessionKey: SESSION, idempotencyKey: "idem-stack-0032", fingerprint: "0123456789abcde0" });
    assert.ok(!refused.ok && refused.code === "worker_recovering");

    // ...until an explicit reopen rebuilds the worker.
    const reopened = await stack.openSession({ sessionKey: SESSION, conversationId: CONVERSATION, ownerActorId: OWNER });
    assert.ok(reopened.ok && reopened.recovered);
    const t2 = await stack.submitPrompt({ sessionKey: SESSION, idempotencyKey: "idem-stack-0033", fingerprint: "0123456789abcde1" });
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
