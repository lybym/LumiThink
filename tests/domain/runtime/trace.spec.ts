import assert from "node:assert/strict";
import test from "node:test";

import {
  createRuntimeTraceRecorder,
  maskedTraceIds,
  RUNTIME_RESULT_CODES,
  type RuntimeTraceEvent,
} from "../../../lib/domain/runtime/trace.ts";

test("runtime trace recorder buffers events and caps at the ring size", () => {
  const recorder = createRuntimeTraceRecorder();
  const base: RuntimeTraceEvent = {
    type: "turn.started",
    component: "input_gate",
    atMs: 1,
    traceId: "trc_r1t3tr000001",
    turnId: "trn_r1t3tr000001",
    sessionId: "ses_r1t3aaaa01",
    entrance: "ui_web",
    protocolVersion: "1.0",
  };
  for (let index = 0; index < 1005; index += 1) {
    recorder.push({ ...base, atMs: index });
  }
  const events = recorder.events();
  assert.equal(events.length, 1000);
  assert.equal(events[0]?.atMs, 5, "oldest events are dropped first");
  assert.equal(events[999]?.atMs, 1004);
  // Frozen snapshot: external mutation attempts fail.
  assert.throws(() => {
    (events as unknown as { push: (...args: unknown[]) => unknown }).push(undefined);
  });
});

test("maskedTraceIds masks values that fail the contract id grammar", () => {
  const masked = maskedTraceIds({
    traceId: "not-a-contract-id",
    turnId: "trn_r1t3tr000002",
    sessionId: 42,
  });
  assert.equal(masked.traceId, "[unverified]");
  assert.equal(masked.turnId, "trn_r1t3tr000002");
  assert.equal(masked.sessionId, "[unverified]");
});

test("runtime result codes are frozen and include failure/rejection observability", () => {
  for (const expected of ["ok", "tool_rejected", "tool_failed", "model_failed", "session_unavailable", "output_blocked"]) {
    assert.ok((RUNTIME_RESULT_CODES as readonly string[]).includes(expected), `${expected} registered`);
  }
  assert.throws(() => {
    (RUNTIME_RESULT_CODES as unknown as string[]).push("intrusion");
  });
});
