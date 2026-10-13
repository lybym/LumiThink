import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../../../lib/domain/contract/core.ts";

import {
  API_CONTRACT_DESCRIPTOR,
  CONTRACT_SCHEMA_DOCUMENTS,
  SUPPORTED_SCHEMA_KEYWORDS,
  validateJsonSchema,
  interactionRequestSchema,
  interactionAckSchema,
  interactionEventSchema,
  actorContextSchema,
  sessionRefSchema,
  agentResponseSchema,
  streamEventSchema,
  streamEventPayloadSchemas,
  errorEnvelopeSchema,
  turnCancelRequestSchema,
  turnCancelResultSchema,
} from "../../../lib/domain/contract/schemas.ts";

import { parseInteractionEvent } from "../../../lib/domain/contract/interaction.ts";

import {
  syntheticAgentResponseCompleted,
  syntheticAgentResponseIgnored,
  syntheticChildActor,
  syntheticDuplicateAckTurn1,
  syntheticErrorEnvelopeTextTooLong,
  syntheticErrorEnvelopeUnknownVersion,
  syntheticGuardianActor,
  syntheticInteractionAckTurn1,
  syntheticInteractionEventTurn1,
  syntheticInteractionEventTurn2,
  syntheticSessionRef,
  syntheticSystemActor,
  syntheticTurnCancelRequest,
  syntheticTurnCancelResult,
  syntheticVoiceDeviceActor,
  webTextInteractionRequestTurn1,
  webTextInteractionRequestTurn2,
  voiceAdapterTextInteractionRequestTurn1,
} from "../../../lib/domain/contract/fixtures.ts";

// ---------------------------------------------------------------------------
// Document hygiene
// ---------------------------------------------------------------------------

test("every schema document is a draft-2020-12 object schema with a urn id", () => {
  for (const [name, doc] of Object.entries(CONTRACT_SCHEMA_DOCUMENTS)) {
    assert.equal(doc.$schema, "https://json-schema.org/draft/2020-12/schema", name);
    assert.equal(doc.type, "object", name);
    assert.match(doc.$id, /^urn:lumithink:contract:1\.0:[a-z-]+$/, name);
    assert.ok(doc.title.length > 0, name);
  }
});

test("schema documents only use keywords the bundled validator supports", () => {
  const unsupported: string[] = [];
  // `insideProperties` skips property NAMES (they are not schema keywords);
  // every other object key must be a keyword the bundled validator supports,
  // so an unsupported keyword can never be silently ignored.
  const walk = (node: unknown, where: string, insideProperties: boolean): void => {
    if (node === null || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${where}[${index}]`, false));
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (!insideProperties && !SUPPORTED_SCHEMA_KEYWORDS.includes(key)) {
        unsupported.push(`${where}.${key}`);
      }
      walk(value, `${where}.${key}`, key === "properties");
    }
  };
  for (const [name, doc] of Object.entries(CONTRACT_SCHEMA_DOCUMENTS)) {
    walk(doc, name, false);
  }
  assert.deepEqual(
    unsupported,
    [],
    "unsupported JSON Schema keywords would be silently ignored by the bundled validator",
  );
});

test("schema documents serialize deterministically (publishable as versioned JSON)", () => {
  for (const [name, doc] of Object.entries(CONTRACT_SCHEMA_DOCUMENTS)) {
    const once = canonicalJson(doc);
    const twice = canonicalJson(JSON.parse(once));
    assert.equal(once, twice, name);
  }
});

// ---------------------------------------------------------------------------
// Positive coverage — fixtures validate against their schemas
// ---------------------------------------------------------------------------

test("web and voice interaction request fixtures validate against the request schema", () => {
  for (const fixture of [
    webTextInteractionRequestTurn1,
    voiceAdapterTextInteractionRequestTurn1,
    webTextInteractionRequestTurn2,
  ]) {
    const result = validateJsonSchema(interactionRequestSchema, fixture);
    assert.equal(result.valid, true, result.problems.join("; "));
  }
});

test("ack, event, actor, session, response and cancel fixtures validate against their schemas", () => {
  for (const [name, doc] of Object.entries(CONTRACT_SCHEMA_DOCUMENTS)) {
    const fixturesFor: Record<string, unknown[]> = {
      "interaction-request": [webTextInteractionRequestTurn1, voiceAdapterTextInteractionRequestTurn1],
      "interaction-ack": [syntheticInteractionAckTurn1, syntheticDuplicateAckTurn1],
      "interaction-event": [syntheticInteractionEventTurn1, syntheticInteractionEventTurn2],
      "actor-context": [
        syntheticChildActor,
        syntheticGuardianActor,
        syntheticSystemActor,
        syntheticVoiceDeviceActor,
      ],
      "session-ref": [syntheticSessionRef],
      "agent-response": [syntheticAgentResponseCompleted, syntheticAgentResponseIgnored],
      "stream-event": [], // covered per-kind below
      "turn-cancel-request": [syntheticTurnCancelRequest],
      "turn-cancel-result": [syntheticTurnCancelResult],
      "error-envelope": [syntheticErrorEnvelopeTextTooLong, syntheticErrorEnvelopeUnknownVersion],
    };
    if (!(name in fixturesFor) || fixturesFor[name].length === 0) {
      continue;
    }
    for (const fixture of fixturesFor[name]) {
      const result = validateJsonSchema(doc, fixture);
      assert.equal(result.valid, true, `${name}: ${result.problems.join("; ")}`);
    }
  }
});

test("stream events validate against the envelope and their per-kind payload schema", () => {
  const payloadByKind: Record<string, unknown> = {};
  const fromFixtures: [string, unknown][] = [
    ["stream.started", { type: "started", acceptedAt: "2026-10-13T10:00:02.000Z" }],
    ["agent.delta", { type: "delta", text: "[synthetic] 你好" }],
    ["agent.completed", { type: "completed", response: syntheticAgentResponseCompleted }],
    ["turn.cancelled", { type: "cancelled", by: "child" }],
    ["stream.error", { type: "error", error: syntheticErrorEnvelopeTextTooLong }],
    ["stream.end", { type: "end" }],
  ];
  for (const [kind, payload] of fromFixtures) {
    payloadByKind[kind] = payload;
    const envelope = {
      protocolVersion: "1.0",
      kind,
      seq: 0,
      conversationId: "conv_demo_conversation_0001",
      turnId: "trn_fixture_turn_t1_0001",
      traceId: "trc_fixture_trace_t1_001",
      occurredAt: "2026-10-13T10:00:02.000Z",
      payload,
    };
    const envelopeResult = validateJsonSchema(streamEventSchema, envelope);
    assert.equal(envelopeResult.valid, true, `${kind}: ${envelopeResult.problems.join("; ")}`);
    const payloadResult = validateJsonSchema(
      streamEventPayloadSchemas[kind as keyof typeof streamEventPayloadSchemas],
      payload,
    );
    assert.equal(payloadResult.valid, true, `${kind} payload: ${payloadResult.problems.join("; ")}`);
  }
  assert.equal(Object.keys(payloadByKind).length, 6);
});

// ---------------------------------------------------------------------------
// Negative coverage — the acceptance criteria
// ---------------------------------------------------------------------------

test("schema rejects a request with a missing required field", () => {
  const { clientRequestId, ...withoutRequestId } = webTextInteractionRequestTurn1.interaction;
  const result = validateJsonSchema(interactionRequestSchema, {
    protocolVersion: "1.0",
    interaction: withoutRequestId,
  });
  assert.equal(result.valid, false);
  assert.ok(
    result.problems.some((p) => p.includes("clientRequestId") && p.includes("required")),
    result.problems.join("; "),
  );
});

test("schema rejects an unknown protocol version", () => {
  const result = validateJsonSchema(interactionRequestSchema, {
    ...webTextInteractionRequestTurn1,
    protocolVersion: "9.9",
  });
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((p) => p.includes("protocolVersion") && p.includes("enum")));
});

test("schema rejects a wrong role on the actor-context document", () => {
  for (const badRole of ["parent", "admin", "voice", ""]) {
    const result = validateJsonSchema(actorContextSchema, {
      ...syntheticChildActor,
      role: badRole,
    });
    assert.equal(result.valid, false, `role ${badRole} must be rejected`);
    assert.ok(result.problems.some((p) => p.includes("role") && p.includes("enum")));
  }
});

test("schema rejects a request id that does not match the id grammar", () => {
  const result = validateJsonSchema(interactionRequestSchema, {
    ...webTextInteractionRequestTurn1,
    interaction: {
      ...webTextInteractionRequestTurn1.interaction,
      clientRequestId: "request-without-prefix-1",
    },
  });
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((p) => p.includes("clientRequestId") && p.includes("pattern")));
});

test("schema rejects over-long text (malicious long text)", () => {
  const marker = "OVERFLOW_MARKER_NOT_ECHOED";
  const result = validateJsonSchema(interactionRequestSchema, {
    ...webTextInteractionRequestTurn1,
    interaction: {
      ...webTextInteractionRequestTurn1.interaction,
      text: { content: "a".repeat(4001) + marker, format: "plain" },
    },
  });
  assert.equal(result.valid, false);
  assert.ok(
    result.problems.some((p) => p.includes("content") && p.includes("maxLength")),
    result.problems.join("; "),
  );
  // Schema problems are structural — the submitted text is never echoed.
  assert.equal(JSON.stringify(result.problems).includes(marker), false);
});

test("schema rejects unknown fields (additionalProperties=false) everywhere", () => {
  const result = validateJsonSchema(interactionRequestSchema, {
    ...webTextInteractionRequestTurn1,
    actor: { role: "child", actorId: "act_client_claim_0001" },
  });
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((p) => p.includes("actor") && p.includes("unknown field")));
});

test("schema rejects wrong types on key fields", () => {
  const result = validateJsonSchema(sessionRefSchema, {
    ...syntheticSessionRef,
    createdAt: 1731398400000,
  });
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((p) => p.includes("createdAt")));
});

test("cross-conversation structure is caught at the id-grammar level (binding is runtime)", () => {
  const result = validateJsonSchema(turnCancelRequestSchema, {
    ...syntheticTurnCancelRequest,
    turnId: "conv_wrong_namespace_1", // a conversation id posing as a turn id
  });
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((p) => p.includes("turnId") && p.includes("pattern")));
});

test("cross-check: parsers and schema agree on the same fixtures", () => {
  // The canonical event fixture must satisfy both the schema and the parser.
  const schemaResult = validateJsonSchema(interactionEventSchema, syntheticInteractionEventTurn1);
  assert.equal(schemaResult.valid, true, schemaResult.problems.join("; "));
  assert.doesNotThrow(() => parseInteractionEvent(syntheticInteractionEventTurn1));

  const ackSchemaResult = validateJsonSchema(interactionAckSchema, syntheticInteractionAckTurn1);
  assert.equal(ackSchemaResult.valid, true, ackSchemaResult.problems.join("; "));
});

test("ack schema rejects a duplicate-status ack with a tampered url", () => {
  const result = validateJsonSchema(interactionAckSchema, {
    ...syntheticDuplicateAckTurn1,
    streamUrl: "https://evil.example/steal",
  });
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((p) => p.includes("streamUrl") && p.includes("pattern")));
});

test("agent response schema accepts completed-with-content and ignored-without-content", () => {
  assert.equal(validateJsonSchema(agentResponseSchema, syntheticAgentResponseCompleted).valid, true);
  assert.equal(validateJsonSchema(agentResponseSchema, syntheticAgentResponseIgnored).valid, true);
});

test("error envelope schema rejects an unknown error code", () => {
  const result = validateJsonSchema(errorEnvelopeSchema, {
    ...syntheticErrorEnvelopeUnknownVersion,
    error: { ...syntheticErrorEnvelopeUnknownVersion.error, code: "MADE_UP_CODE" },
  });
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((p) => p.includes("code") && p.includes("enum")));
});

test("cancel result schema rejects an unknown status", () => {
  const result = validateJsonSchema(turnCancelResultSchema, {
    ...syntheticTurnCancelResult,
    status: "detonated",
  });
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((p) => p.includes("status") && p.includes("enum")));
});

test("the API descriptor matches the published routes and limits", () => {
  assert.equal(API_CONTRACT_DESCRIPTOR.protocolVersion, "1.0");
  assert.match(API_CONTRACT_DESCRIPTOR.routes.interactions, /^POST \/api\/v1\/interactions$/);
  assert.match(API_CONTRACT_DESCRIPTOR.routes.stream, /^GET \/api\/v1\/interactions\/\{traceId\}\/events/);
  assert.match(API_CONTRACT_DESCRIPTOR.routes.cancel, /^POST \/api\/v1\/interactions\/\{turnId\}\/cancel$/);
  assert.equal(API_CONTRACT_DESCRIPTOR.limits.textMaxChars, 4000);
  assert.ok(API_CONTRACT_DESCRIPTOR.errorCodes["CONTRACT_TEXT_TOO_LONG"]);
  assert.ok(API_CONTRACT_DESCRIPTOR.errorCodes["CONTRACT_UNTRUSTED_IDENTITY"]);
});
