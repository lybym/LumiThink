import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_STREAM_DELTA_LENGTH,
  assertCoherentStream,
  formatStreamEventAsSse,
  parseAgentResponse,
  parseStreamEvent,
  parseTurnCancelRequest,
  parseTurnCancelResult,
  suppressLateAgentResponse,
} from "../../../lib/domain/contract/response.ts";
import { ContractValidationError } from "../../../lib/domain/contract/core.ts";

import {
  syntheticAgentResponseCompleted,
  syntheticChildActor,
  syntheticStreamEventsTurn1,
  syntheticSystemActor,
  syntheticTurnCancelRequest,
  syntheticTurnCancelResult,
  syntheticVoiceDeviceActor,
} from "../../../lib/domain/contract/fixtures.ts";

function problemsOf(error: unknown): {
  code: string;
  path: string;
  message: string;
  detail?: Readonly<Record<string, string | number>>;
}[] {
  assert.ok(error instanceof ContractValidationError, "expected ContractValidationError");
  return error.problems.map((p) => ({
    code: p.code,
    path: p.path,
    message: p.message,
    ...(p.detail !== undefined ? { detail: p.detail } : {}),
  }));
}

// ---------------------------------------------------------------------------
// AgentResponse
// ---------------------------------------------------------------------------

test("completed agent responses parse and are frozen", () => {
  const parsed = parseAgentResponse(syntheticAgentResponseCompleted);
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.content?.format, "plain");
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.content));
});

test("missing fields on an agent response are reported per path", () => {
  const stripped = {
    protocolVersion: "1.0",
    agentResponseId: "rsp_test_response_00001",
    conversationId: "conv_test_conversation_01",
    // turnId missing
    traceId: "trc_test_trace_0000001",
    status: "completed",
    content: { text: "hello", format: "plain" },
    completedAt: "2026-10-13T10:00:06.000Z",
  };
  assert.throws(() => parseAgentResponse(stripped), (error: unknown) => {
    const problems = problemsOf(error);
    return problems.some((p) => p.path === "turnId" && p.code === "CONTRACT_FIELD_MISSING");
  });
});

test("only completed responses may carry content; cancelled/ignored/failed never do", () => {
  for (const status of ["cancelled", "ignored", "failed"]) {
    assert.throws(
      () => parseAgentResponse({ ...syntheticAgentResponseCompleted, status }),
      (error: unknown) =>
        problemsOf(error).some(
          (p) => p.path === "content" && p.code === "CONTRACT_FIELD_INVALID",
        ),
      `expected rejection of content for status=${status}`,
    );
  }
  assert.throws(
    () => parseAgentResponse({ ...syntheticAgentResponseCompleted, content: undefined }),
    (error: unknown) =>
      problemsOf(error).some((p) => p.path === "content" && p.code === "CONTRACT_FIELD_MISSING"),
  );
});

test("unknown agent response status is rejected", () => {
  assert.throws(
    () => parseAgentResponse({ ...syntheticAgentResponseCompleted, status: "sent" }),
    (error: unknown) => problemsOf(error).some((p) => p.path === "status"),
  );
});

test("suppressLateAgentResponse drops content and marks the result ignored (cancel/ignore rule)", () => {
  const suppressed = suppressLateAgentResponse(syntheticAgentResponseCompleted);
  assert.equal(suppressed.status, "ignored");
  assert.equal(suppressed.content, null);
  // Correlation ids preserved for audit.
  assert.equal(suppressed.turnId, syntheticAgentResponseCompleted.turnId);
  assert.equal(suppressed.conversationId, syntheticAgentResponseCompleted.conversationId);
  assert.equal(suppressed.traceId, syntheticAgentResponseCompleted.traceId);
  assert.ok(Object.isFrozen(suppressed));
  // The suppressed form is itself a valid AgentResponse.
  assert.deepEqual(parseAgentResponse(suppressed), suppressed);
});

// ---------------------------------------------------------------------------
// Turn cancel contract
// ---------------------------------------------------------------------------

test("cancel requests parse for allowed roles and reject voice_device", () => {
  const parsed = parseTurnCancelRequest(syntheticTurnCancelRequest, syntheticChildActor);
  assert.equal(parsed.reason, "user_stop");
  assert.doesNotThrow(() => parseTurnCancelRequest(syntheticTurnCancelRequest, syntheticSystemActor));
  assert.throws(
    () => parseTurnCancelRequest(syntheticTurnCancelRequest, syntheticVoiceDeviceActor),
    (error: unknown) => problemsOf(error)[0].code === "CONTRACT_WRONG_ROLE",
  );
});

test("cancel requests reject unknown reasons and unknown fields", () => {
  assert.throws(
    () => parseTurnCancelRequest({ ...syntheticTurnCancelRequest, reason: "because" }, syntheticChildActor),
    (error: unknown) => problemsOf(error).some((p) => p.path === "reason"),
  );
  assert.throws(
    () => parseTurnCancelRequest({ ...syntheticTurnCancelRequest, force: true }, syntheticChildActor),
    (error: unknown) => problemsOf(error).some((p) => p.path === "force"),
  );
});

test("cancel results cover the three safe outcomes", () => {
  for (const status of ["cancelled", "already_final", "unknown_turn"]) {
    assert.doesNotThrow(() =>
      parseTurnCancelResult({ ...syntheticTurnCancelResult, status }),
    );
  }
  assert.throws(
    () => parseTurnCancelResult({ ...syntheticTurnCancelResult, status: "denied" }),
    (error: unknown) => problemsOf(error).some((p) => p.path === "status"),
  );
});

// ---------------------------------------------------------------------------
// StreamEvent
// ---------------------------------------------------------------------------

test("the fixture stream is coherent and every event parses", () => {
  for (const event of syntheticStreamEventsTurn1) {
    assert.deepEqual(parseStreamEvent(event), event);
  }
  assert.doesNotThrow(() =>
    assertCoherentStream(syntheticStreamEventsTurn1, {
      conversationId: "conv_demo_conversation_0001",
      turnId: "trn_fixture_turn_t1_0001",
      traceId: "trc_fixture_trace_t1_001",
    }),
  );
});

test("stream seq must be 0-based and strictly monotonic", () => {
  const broken = syntheticStreamEventsTurn1.map((event, index) =>
    index === 2 ? { ...event, seq: 5 } : event,
  );
  assert.throws(
    () =>
      assertCoherentStream(broken, {
        conversationId: "conv_demo_conversation_0001",
        turnId: "trn_fixture_turn_t1_0001",
        traceId: "trc_fixture_trace_t1_001",
      }),
    (error: unknown) =>
      problemsOf(error).some((p) => p.path === "events[2].seq" && p.detail?.expected === 2),
  );
});

test("stream events with mismatched correlation ids are rejected", () => {
  const foreign = { ...syntheticStreamEventsTurn1[0], conversationId: "conv_other_conversation_1" };
  assert.throws(
    () =>
      assertCoherentStream([foreign], {
        conversationId: "conv_demo_conversation_0001",
        turnId: "trn_fixture_turn_t1_0001",
        traceId: "trc_fixture_trace_t1_001",
      }),
    (error: unknown) => problemsOf(error)[0].code === "CONTRACT_CROSS_CONVERSATION",
  );
});

test("unknown stream kind, bad seq and kind/payload mismatch are rejected", () => {
  const base = syntheticStreamEventsTurn1[1]; // agent.delta
  assert.throws(
    () => parseStreamEvent({ ...base, kind: "vendor.custom" }),
    (error: unknown) => problemsOf(error).some((p) => p.path === "kind"),
  );
  assert.throws(
    () => parseStreamEvent({ ...base, seq: -1 }),
    (error: unknown) => problemsOf(error).some((p) => p.path === "seq"),
  );
  assert.throws(
    () => parseStreamEvent({ ...base, seq: 1.5 }),
    (error: unknown) => problemsOf(error).some((p) => p.path === "seq"),
  );
  assert.throws(
    () => parseStreamEvent({ ...base, payload: { type: "started", acceptedAt: base.occurredAt } }),
    (error: unknown) =>
      problemsOf(error).some(
        (p) => p.path === "payload.type" && p.message.includes("delta"),
      ),
  );
  assert.throws(
    () => parseStreamEvent({ ...base, payload: undefined }),
    (error: unknown) => problemsOf(error).some((p) => p.path === "payload"),
  );
});

test("delta fragments are capped", () => {
  const delta = syntheticStreamEventsTurn1[1];
  assert.throws(
    () => parseStreamEvent({ ...delta, payload: { type: "delta", text: "a".repeat(MAX_STREAM_DELTA_LENGTH + 1) } }),
    (error: unknown) => problemsOf(error)[0].code === "CONTRACT_TEXT_TOO_LONG",
  );
  assert.doesNotThrow(() =>
    parseStreamEvent({ ...delta, payload: { type: "delta", text: "a".repeat(MAX_STREAM_DELTA_LENGTH) } }),
  );
});

test("turn.cancelled payload only allows child/guardian/system as the actor", () => {
  const cancelled = {
    protocolVersion: "1.0",
    kind: "turn.cancelled",
    seq: 0,
    conversationId: "conv_demo_conversation_0001",
    turnId: "trn_fixture_turn_t1_0001",
    traceId: "trc_fixture_trace_t1_001",
    occurredAt: "2026-10-13T10:00:07.000Z",
    payload: { type: "cancelled", by: "child" },
  };
  for (const by of ["child", "guardian", "system"]) {
    assert.doesNotThrow(() => parseStreamEvent({ ...cancelled, payload: { type: "cancelled", by } }));
  }
  assert.throws(
    () => parseStreamEvent({ ...cancelled, payload: { type: "cancelled", by: "voice_device" } }),
    (error: unknown) => problemsOf(error).some((p) => p.path === "payload.by"),
  );
});

test("SSE formatting emits a parseable versioned frame", () => {
  const frame = formatStreamEventAsSse(syntheticStreamEventsTurn1[1]);
  assert.ok(frame.startsWith("event: agent.delta\n"));
  assert.ok(frame.endsWith("\n\n"));
  const dataLine = frame.split("\n")[1];
  assert.ok(dataLine.startsWith("data: "));
  const parsedJson = JSON.parse(dataLine.slice("data: ".length));
  assert.equal(parsedJson.kind, "agent.delta");
  assert.equal(parsedJson.protocolVersion, "1.0");
  assert.equal(parsedJson.seq, 1);
});
