import assert from "node:assert/strict";
import test from "node:test";

import {
  API_ROUTES,
  buildCancelUrl,
  buildDuplicateAck,
  buildInteractionAck,
  buildStreamUrl,
  parseInteractionAck,
  rejectDuplicateRequest,
  resolveIdempotentRetry,
  type StoredInteraction,
} from "../../../lib/domain/contract/idempotency.ts";
import { ContractValidationError } from "../../../lib/domain/contract/core.ts";

import { parseInteractionRequest, fingerprintInteractionRequest } from "../../../lib/domain/contract/interaction.ts";

import { webTextInteractionRequestTurn1 } from "../../../lib/domain/contract/fixtures.ts";

const STORED: StoredInteraction = {
  requestId: "req_fixture_web_t1_0001",
  conversationId: "conv_demo_conversation_0001",
  turnId: "trn_fixture_turn_t1_0001",
  traceId: "trc_fixture_trace_t1_001",
  acceptedAt: "2026-10-13T10:00:02.000Z",
  fingerprint: fingerprintInteractionRequest(parseInteractionRequest(webTextInteractionRequestTurn1)),
};

test("a fresh request id is accepted", () => {
  const decision = resolveIdempotentRetry({
    stored: null,
    incomingRequest: parseInteractionRequest(webTextInteractionRequestTurn1),
  });
  assert.deepEqual(decision, { action: "accept" });
});

test("same request id + same semantic payload is an idempotent replay (retry is safe)", () => {
  const retry = parseInteractionRequest({
    ...webTextInteractionRequestTurn1,
    interaction: {
      ...webTextInteractionRequestTurn1.interaction,
      clientContext: { client: "web", clientVersion: "2.1.0-web-upgraded" },
    },
  });
  const decision = resolveIdempotentRetry({ stored: STORED, incomingRequest: retry });
  assert.equal(decision.action, "replay");
  if (decision.action === "replay") {
    assert.equal(decision.stored.turnId, STORED.turnId);
    assert.equal(decision.stored.traceId, STORED.traceId);
  }
});

test("same request id + different payload conflicts (CONTRACT_DUPLICATE_REQUEST)", () => {
  const differentPayload = parseInteractionRequest({
    protocolVersion: "1.0",
    interaction: {
      kind: "text",
      clientRequestId: "req_fixture_web_t1_0001", // reused id
      text: { content: "[synthetic] 不同的内容。", format: "plain" },
    },
  });
  const decision = resolveIdempotentRetry({ stored: STORED, incomingRequest: differentPayload });
  assert.deepEqual(decision, {
    action: "conflict",
    reason: "request-id-reused-with-different-payload",
  });
  assert.throws(() => rejectDuplicateRequest(), (error: unknown) => {
    assert.ok(error instanceof ContractValidationError);
    assert.equal(error.problems[0].code, "CONTRACT_DUPLICATE_REQUEST");
    return true;
  });
});

test("reusing a request id across conversations is a conflict (cross-conversation reuse)", () => {
  const otherConversation = parseInteractionRequest({
    protocolVersion: "1.0",
    interaction: {
      kind: "text",
      clientRequestId: "req_fixture_web_t1_0001", // same id
      conversationId: "conv_other_conversation_1",
      text: { content: webTextInteractionRequestTurn1.interaction.text.content, format: "plain" },
    },
  });
  const decision = resolveIdempotentRetry({ stored: STORED, incomingRequest: otherConversation });
  assert.equal(decision.action, "conflict");
});

test("acks carry versioned urls and duplicate acks point at the original turn", () => {
  const ack = buildInteractionAck({
    requestId: STORED.requestId,
    conversationId: STORED.conversationId,
    turnId: STORED.turnId,
    traceId: STORED.traceId,
    acceptedAt: STORED.acceptedAt,
  });
  assert.equal(ack.status, "accepted");
  assert.equal(ack.streamUrl, `/api/v1/interactions/${STORED.traceId}/events`);
  assert.equal(ack.cancelUrl, `/api/v1/interactions/${STORED.turnId}/cancel`);
  assert.equal(ack.protocolVersion, "1.0");

  const duplicate = buildDuplicateAck(STORED, { now: "2026-10-13T10:00:05.000Z" });
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.turnId, ack.turnId);
  assert.equal(duplicate.traceId, ack.traceId);
  assert.equal(duplicate.conversationId, ack.conversationId);
  assert.equal(duplicate.acceptedAt, "2026-10-13T10:00:05.000Z");

  // Both forms round-trip through the ack parser.
  assert.deepEqual(parseInteractionAck(ack), ack);
  assert.deepEqual(parseInteractionAck(duplicate), duplicate);
});

test("urls are never built from unvalidated ids (path-injection guard)", () => {
  for (const bad of ["../../admin", "trc_../../etc", "not-an-id", ""]) {
    assert.throws(() => buildStreamUrl(bad), ContractValidationError);
    assert.throws(() => buildCancelUrl(bad), ContractValidationError);
  }
  assert.equal(buildStreamUrl("trc_ok_trace_000001"), "/api/v1/interactions/trc_ok_trace_000001/events");
  assert.equal(buildCancelUrl("trn_ok_turn_00000001"), "/api/v1/interactions/trn_ok_turn_00000001/cancel");
});

test("routes are versioned and stable", () => {
  assert.equal(API_ROUTES.interactions, "/api/v1/interactions");
  assert.match(API_ROUTES.streamTemplate, /^\/api\/v1\//);
  assert.match(API_ROUTES.cancelTemplate, /^\/api\/v1\//);
});

test("parseInteractionAck rejects tampered urls and unknown fields", () => {
  const ack = buildInteractionAck({
    requestId: STORED.requestId,
    conversationId: STORED.conversationId,
    turnId: STORED.turnId,
    traceId: STORED.traceId,
    acceptedAt: STORED.acceptedAt,
  });
  assert.throws(
    () => parseInteractionAck({ ...ack, streamUrl: "/api/v1/interactions/other-trace/events" }),
    (error: unknown) => {
      assert.ok(error instanceof ContractValidationError);
      return error.problems.some((p) => p.path === "streamUrl");
    },
  );
  assert.throws(
    () => parseInteractionAck({ ...ack, status: "pending" }),
    (error: unknown) => {
      assert.ok(error instanceof ContractValidationError);
      return error.problems.some((p) => p.path === "status");
    },
  );
  assert.throws(
    () => parseInteractionAck({ ...ack, adminToken: "should-not-be-here" }),
    (error: unknown) => {
      assert.ok(error instanceof ContractValidationError);
      return error.problems.some((p) => p.path === "adminToken");
    },
  );
});
