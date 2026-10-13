/**
 * R1-01 JSON Schema documents of the versioned interaction contract
 * (docs/API_CONTRACT.md; issue #13: "定义版本化 … JSON Schema 和
 * TypeScript 类型").
 *
 * The documents in this file are the publishable wire contracts. They are
 * JSON Schema draft 2020-12 documents expressed as data so they can be
 * serialized, versioned and published without new dependencies. The small
 * validator below supports exactly the keyword subset this contract uses;
 * tests/domain/contract/schemas.spec.ts fails loudly if a document ever
 * introduces an unsupported keyword (which would otherwise be silently
 * ignored).
 *
 * Division of labor:
 * - Schema documents: unconditional wire structure (fields, types, enums,
 *   patterns, limits). Used for publishing and cross-language clients.
 * - Parsers (parseInteractionRequest, parseAgentResponse, …): full semantic
 *   rules including conditional rules (content only when completed, payload
 *   per stream kind), value-privacy and role authorization. The two are
 *   cross-checked by tests on the same fixtures.
 *
 * This module must stay dependency-free (no prisma, no react, no next).
 */

import {
  CONTRACT_ID_PREFIXES,
  CONTRACT_TIMESTAMP_PATTERN,
  SUPPORTED_PROTOCOL_VERSIONS,
  type ContractIdKind,
} from "./core.ts";
import { INGRESS_KINDS, CLIENT_VERSION_PATTERN } from "./interaction.ts";
import { ACTOR_ROLES } from "./actor.ts";
import { TURN_STATUSES, STREAM_EVENT_KINDS, TURN_CANCEL_REASONS, TURN_CANCEL_RESULT_STATUSES, MAX_STREAM_DELTA_LENGTH } from "./response.ts";
import { MAX_ERROR_MESSAGE_LENGTH, CONTRACT_ERROR_REGISTRY } from "./errors.ts";
import { TEXT_LIMITS } from "./interaction.ts";

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema" as const;

/** Keyword subset supported by the bundled validator. */
export const SUPPORTED_SCHEMA_KEYWORDS: readonly string[] = [
  "$schema",
  "$id",
  "title",
  "description",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern",
  "enum",
  "const",
  "minimum",
  "maximum",
];

export type JsonSchemaType =
  | "object"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "null";

export interface JsonSchemaNode {
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchemaNode;
  readonly items?: JsonSchemaNode;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly description?: string;
}

export interface ContractJsonSchemaDocument extends JsonSchemaNode {
  readonly $schema: typeof JSON_SCHEMA_DIALECT;
  readonly $id: string;
  readonly title: string;
}

function idUrn(name: string): string {
  return `urn:lumithink:contract:1.0:${name}`;
}

function document(
  name: string,
  title: string,
  node: JsonSchemaNode,
): ContractJsonSchemaDocument {
  return { $schema: JSON_SCHEMA_DIALECT, $id: idUrn(name), title, ...node };
}

// ---------------------------------------------------------------------------
// Field builders shared across documents (kept in sync with core.ts)
// ---------------------------------------------------------------------------

function protocolVersionField(description: string): JsonSchemaNode {
  return {
    type: "string",
    enum: [...SUPPORTED_PROTOCOL_VERSIONS],
    description,
  };
}

function idField(kind: ContractIdKind, description: string): JsonSchemaNode {
  return {
    type: "string",
    pattern: `^${CONTRACT_ID_PREFIXES[kind]}[A-Za-z0-9][A-Za-z0-9_-]{7,63}$`,
    description,
  };
}

function timestampField(description: string): JsonSchemaNode {
  return {
    type: "string",
    pattern: CONTRACT_TIMESTAMP_PATTERN.source,
    description,
  };
}

// ---------------------------------------------------------------------------
// Schema documents
// ---------------------------------------------------------------------------

/** Inline structure of the server-verified actor inside an InteractionEvent. */
const actorSchemaNode: JsonSchemaNode = {
  type: "object",
  properties: {
    role: { type: "string", enum: [...ACTOR_ROLES] },
    actorId: idField("actorId", "Server-verified principal."),
    childRef: {
      type: ["string", "null"],
      pattern: `^${CONTRACT_ID_PREFIXES.childRef}[A-Za-z0-9][A-Za-z0-9_-]{7,63}$`,
    },
    verifiedBy: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$" },
    verifiedAt: timestampField("Verification timestamp (ISO-8601 UTC)."),
  },
  required: ["role", "actorId", "childRef", "verifiedBy", "verifiedAt"],
  additionalProperties: false,
  description: "Server-verified actor (see urn:lumithink:contract:1.0:actor-context).",
};

/** urn:lumithink:contract:1.0:interaction-request */
export const interactionRequestSchema: ContractJsonSchemaDocument = document(
  "interaction-request",
  "POST /api/v1/interactions request body",
  {
    type: "object",
    properties: {
      protocolVersion: protocolVersionField("Contract protocol version."),
      interaction: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["text"], description: "R1 text interactions only." },
          clientRequestId: idField(
            "requestId",
            "Client-generated idempotency key; retries reuse the same value.",
          ),
          conversationId: idField(
            "conversationId",
            "Absent = start a new conversation; present = must be bound to the verified actor.",
          ),
          text: {
            type: "object",
            properties: {
              content: {
                type: "string",
                minLength: 1,
                maxLength: TEXT_LIMITS.maxChars,
                description:
                  "Message content. Schema maxLength is a coarse wire guard (UTF-16 units); " +
                  "the parser enforces the exact Unicode code-point limit.",
              },
              format: { type: "string", enum: ["plain"] },
            },
            required: ["content"],
            additionalProperties: false,
          },
          clientContext: {
            type: "object",
            properties: {
              client: {
                type: "string",
                enum: [...INGRESS_KINDS],
                description: "Advisory client self-description; never trusted for authorization.",
              },
              clientVersion: {
                type: "string",
                pattern: CLIENT_VERSION_PATTERN.source,
                description:
                  "Advisory free-form client version. Unknown versions are tolerated (upgrade compatibility).",
              },
            },
            required: ["client"],
            additionalProperties: false,
          },
        },
        required: ["kind", "clientRequestId", "text"],
        additionalProperties: false,
        description:
          "Carries NO actor fields: identity is verified server-side and injected; any client-supplied " +
          "actor/childId/sessionId field is rejected (CONTRACT_UNTRUSTED_IDENTITY).",
      },
    },
    required: ["protocolVersion", "interaction"],
    additionalProperties: false,
  },
);

/** urn:lumithink:contract:1.0:interaction-ack */
export const interactionAckSchema: ContractJsonSchemaDocument = document(
  "interaction-ack",
  "POST /api/v1/interactions response (accepted or duplicate)",
  {
    type: "object",
    properties: {
      protocolVersion: protocolVersionField("Contract protocol version."),
      requestId: idField("requestId", "Echo of the client idempotency key."),
      conversationId: idField("conversationId", "Canonical conversation id."),
      turnId: idField("turnId", "Server-assigned turn id."),
      traceId: idField("traceId", "Server-assigned trace id for this request."),
      status: { type: "string", enum: ["accepted", "duplicate"] },
      streamUrl: { type: "string", pattern: "^/api/v1/interactions/trc_[A-Za-z0-9][A-Za-z0-9_-]{7,63}/events$" },
      cancelUrl: { type: "string", pattern: "^/api/v1/interactions/trn_[A-Za-z0-9][A-Za-z0-9_-]{7,63}/cancel$" },
      acceptedAt: timestampField("Server accept timestamp (ISO-8601 UTC)."),
    },
    required: [
      "protocolVersion",
      "requestId",
      "conversationId",
      "turnId",
      "traceId",
      "status",
      "streamUrl",
      "cancelUrl",
      "acceptedAt",
    ],
    additionalProperties: false,
  },
);

/** urn:lumithink:contract:1.0:interaction-event */
export const interactionEventSchema: ContractJsonSchemaDocument = document(
  "interaction-event",
  "Canonical InteractionEvent (Web and Voice Adapter converge here)",
  {
    type: "object",
    properties: {
      protocolVersion: protocolVersionField("Contract protocol version."),
      eventId: idField("eventId", "Server-assigned event id."),
      kind: { type: "string", enum: ["text"] },
      conversationId: idField("conversationId", "Unified conversation correlation id."),
      turnId: idField("turnId", "Unified turn correlation id."),
      requestId: idField("requestId", "Unified request correlation id (client idempotency key)."),
      traceId: idField("traceId", "Unified trace correlation id."),
      actor: actorSchemaNode,
      ingress: {
        type: "string",
        enum: [...INGRESS_KINDS],
        description: "Server-decided entry point; the client claim never decides this.",
      },
      text: {
        type: "object",
        properties: {
          content: { type: "string", minLength: 1 },
          format: { type: "string", enum: ["plain"] },
          charCount: { type: "integer", minimum: 1, description: "Unicode code-point count." },
        },
        required: ["content", "format", "charCount"],
        additionalProperties: false,
      },
      occurredAt: timestampField("Server receive timestamp (ISO-8601 UTC)."),
    },
    required: [
      "protocolVersion",
      "eventId",
      "kind",
      "conversationId",
      "turnId",
      "requestId",
      "traceId",
      "actor",
      "ingress",
      "text",
      "occurredAt",
    ],
    additionalProperties: false,
  },
);

/** urn:lumithink:contract:1.0:actor-context */
export const actorContextSchema: ContractJsonSchemaDocument = document(
  "actor-context",
  "Server-verified ActorContext (never accepted from clients)",
  {
    type: "object",
    properties: {
      role: {
        type: "string",
        enum: [...ACTOR_ROLES],
        description: "child | guardian | system | voice_device — server-verified, never client-claimed.",
      },
      actorId: idField("actorId", "Server-verified principal."),
      childRef: {
        type: ["string", "null"],
        pattern: `^${CONTRACT_ID_PREFIXES.childRef}[A-Za-z0-9][A-Za-z0-9_-]{7,63}$`,
        description: "Server-resolved child reference; null only for the system role.",
      },
      verifiedBy: {
        type: "string",
        pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$",
        description: "Server verification that injected this identity.",
      },
      verifiedAt: timestampField("Verification timestamp (ISO-8601 UTC)."),
    },
    required: ["role", "actorId", "childRef", "verifiedBy", "verifiedAt"],
    additionalProperties: false,
  },
);

/** urn:lumithink:contract:1.0:session-ref */
export const sessionRefSchema: ContractJsonSchemaDocument = document(
  "session-ref",
  "Server-owned session ↔ conversation ↔ actor binding",
  {
    type: "object",
    properties: {
      sessionId: idField("sessionId", "Server-assigned session id."),
      conversationId: idField("conversationId", "Bound conversation."),
      actorId: idField("actorId", "Bound verified principal."),
      role: { type: "string", enum: [...ACTOR_ROLES] },
      createdAt: timestampField("Binding creation timestamp (ISO-8601 UTC)."),
    },
    required: ["sessionId", "conversationId", "actorId", "role", "createdAt"],
    additionalProperties: false,
  },
);

/** urn:lumithink:contract:1.0:agent-response */
export const agentResponseSchema: ContractJsonSchemaDocument = document(
  "agent-response",
  "Versioned AgentResponse of one turn",
  {
    type: "object",
    properties: {
      protocolVersion: protocolVersionField("Contract protocol version."),
      agentResponseId: idField("agentResponseId", "Server-assigned response id."),
      conversationId: idField("conversationId", "Unified conversation correlation id."),
      turnId: idField("turnId", "Unified turn correlation id."),
      traceId: idField("traceId", "Unified trace correlation id."),
      status: {
        type: "string",
        enum: [...TURN_STATUSES],
        description:
          "completed | cancelled | ignored | failed. Only completed carries content; " +
          "cancelled/ignored results never expose content.",
      },
      content: {
        type: ["object", "null"],
        properties: {
          text: { type: "string", minLength: 1 },
          format: { type: "string", enum: ["plain"] },
        },
        required: ["text"],
        additionalProperties: false,
        description: "Present (object) only when status is completed, else null.",
      },
      completedAt: timestampField("Server completion timestamp (ISO-8601 UTC)."),
    },
    required: [
      "protocolVersion",
      "agentResponseId",
      "conversationId",
      "turnId",
      "traceId",
      "status",
      "content",
      "completedAt",
    ],
    additionalProperties: false,
  },
);

/** urn:lumithink:contract:1.0:error-envelope */
export const errorEnvelopeSchema: ContractJsonSchemaDocument = document(
  "error-envelope",
  "Versioned ErrorEnvelope — never carries stack traces, credentials or raw private context",
  {
    type: "object",
    properties: {
      protocolVersion: protocolVersionField("Contract protocol version."),
      error: {
        type: "object",
        properties: {
          code: {
            type: "string",
            enum: Object.keys(CONTRACT_ERROR_REGISTRY),
          },
          message: {
            type: "string",
            minLength: 1,
            maxLength: MAX_ERROR_MESSAGE_LENGTH,
            description: "Safe, fixed human message from the error registry.",
          },
          retriable: { type: "boolean" },
          details: {
            type: "object",
            additionalProperties: { type: ["string", "number"] },
            description: "Structural context only (field paths, limits, counts).",
          },
          requestId: idField("requestId", "Echoed only when it re-validates against the ID grammar."),
          traceId: idField("traceId", "Echoed only when it re-validates against the ID grammar."),
          conversationId: idField("conversationId", "Echoed only when it re-validates against the ID grammar."),
          turnId: idField("turnId", "Echoed only when it re-validates against the ID grammar."),
        },
        required: ["code", "message", "retriable"],
        additionalProperties: false,
      },
      occurredAt: timestampField("Server error timestamp (ISO-8601 UTC)."),
    },
    required: ["protocolVersion", "error", "occurredAt"],
    additionalProperties: false,
  },
);

/** urn:lumithink:contract:1.0:stream-event */
export const streamEventSchema: ContractJsonSchemaDocument = document(
  "stream-event",
  "Versioned SSE StreamEvent envelope",
  {
    type: "object",
    properties: {
      protocolVersion: protocolVersionField("Contract protocol version."),
      kind: { type: "string", enum: [...STREAM_EVENT_KINDS] },
      seq: { type: "integer", minimum: 0, description: "0-based, strictly monotonic per stream." },
      conversationId: idField("conversationId", "Unified conversation correlation id."),
      turnId: idField("turnId", "Unified turn correlation id."),
      traceId: idField("traceId", "Unified trace correlation id."),
      occurredAt: timestampField("Server event timestamp (ISO-8601 UTC)."),
      payload: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["started", "delta", "completed", "cancelled", "error", "end"],
          },
        },
        required: ["type"],
        description:
          "Per-kind payload structure is published in streamEventPayloadSchemas and enforced by parseStreamEvent.",
      },
    },
    required: [
      "protocolVersion",
      "kind",
      "seq",
      "conversationId",
      "turnId",
      "traceId",
      "occurredAt",
      "payload",
    ],
    additionalProperties: false,
  },
);

/** Per-kind payload schemas, keyed by stream event kind. */
export const streamEventPayloadSchemas: Readonly<
  Record<(typeof STREAM_EVENT_KINDS)[number], ContractJsonSchemaDocument>
> = Object.freeze({
  "stream.started": document("stream-payload-started", "payload of stream.started", {
    type: "object",
    properties: {
      type: { type: "string", enum: ["started"] },
      acceptedAt: timestampField("Accept timestamp (ISO-8601 UTC)."),
    },
    required: ["type", "acceptedAt"],
    additionalProperties: false,
  }),
  "agent.delta": document("stream-payload-delta", "payload of agent.delta", {
    type: "object",
    properties: {
      type: { type: "string", enum: ["delta"] },
      text: {
        type: "string",
        minLength: 1,
        maxLength: MAX_STREAM_DELTA_LENGTH,
        description: "One safe short fragment; never a raw model token.",
      },
    },
    required: ["type", "text"],
    additionalProperties: false,
  }),
  "agent.completed": document("stream-payload-completed", "payload of agent.completed", {
    type: "object",
    properties: {
      type: { type: "string", enum: ["completed"] },
      response: {
        type: "object",
        properties: agentResponseSchema.properties,
        required: agentResponseSchema.required,
        additionalProperties: false,
      },
    },
    required: ["type", "response"],
    additionalProperties: false,
  }),
  "turn.cancelled": document("stream-payload-cancelled", "payload of turn.cancelled", {
    type: "object",
    properties: {
      type: { type: "string", enum: ["cancelled"] },
      by: { type: "string", enum: ["child", "guardian", "system"] },
    },
    required: ["type", "by"],
    additionalProperties: false,
  }),
  "stream.error": document("stream-payload-error", "payload of stream.error", {
    type: "object",
    properties: {
      type: { type: "string", enum: ["error"] },
      error: {
        type: "object",
        properties: errorEnvelopeSchema.properties,
        required: errorEnvelopeSchema.required,
        additionalProperties: false,
      },
    },
    required: ["type", "error"],
    additionalProperties: false,
  }),
  "stream.end": document("stream-payload-end", "payload of stream.end", {
    type: "object",
    properties: { type: { type: "string", enum: ["end"] } },
    required: ["type"],
    additionalProperties: false,
  }),
});

/** urn:lumithink:contract:1.0:turn-cancel-request */
export const turnCancelRequestSchema: ContractJsonSchemaDocument = document(
  "turn-cancel-request",
  "POST /api/v1/interactions/{turnId}/cancel request body",
  {
    type: "object",
    properties: {
      protocolVersion: protocolVersionField("Contract protocol version."),
      turnId: idField("turnId", "Turn to cancel."),
      conversationId: idField("conversationId", "Conversation the turn belongs to."),
      reason: { type: "string", enum: [...TURN_CANCEL_REASONS] },
    },
    required: ["protocolVersion", "turnId", "conversationId", "reason"],
    additionalProperties: false,
  },
);

/** urn:lumithink:contract:1.0:turn-cancel-result */
export const turnCancelResultSchema: ContractJsonSchemaDocument = document(
  "turn-cancel-result",
  "Cancel result — already_final and unknown_turn are safe no-ops",
  {
    type: "object",
    properties: {
      protocolVersion: protocolVersionField("Contract protocol version."),
      turnId: idField("turnId", "Cancelled turn."),
      conversationId: idField("conversationId", "Conversation of the turn."),
      status: { type: "string", enum: [...TURN_CANCEL_RESULT_STATUSES] },
      resolvedAt: timestampField("Resolution timestamp (ISO-8601 UTC)."),
    },
    required: ["protocolVersion", "turnId", "conversationId", "status", "resolvedAt"],
    additionalProperties: false,
  },
);

/** All published schema documents of contract v1.0. */
export const CONTRACT_SCHEMA_DOCUMENTS: Readonly<Record<string, ContractJsonSchemaDocument>> =
  Object.freeze({
    "interaction-request": interactionRequestSchema,
    "interaction-ack": interactionAckSchema,
    "interaction-event": interactionEventSchema,
    "actor-context": actorContextSchema,
    "session-ref": sessionRefSchema,
    "agent-response": agentResponseSchema,
    "stream-event": streamEventSchema,
    "stream-payload-started": streamEventPayloadSchemas["stream.started"],
    "stream-payload-delta": streamEventPayloadSchemas["agent.delta"],
    "stream-payload-completed": streamEventPayloadSchemas["agent.completed"],
    "stream-payload-cancelled": streamEventPayloadSchemas["turn.cancelled"],
    "stream-payload-error": streamEventPayloadSchemas["stream.error"],
    "stream-payload-end": streamEventPayloadSchemas["stream.end"],
    "error-envelope": errorEnvelopeSchema,
    "turn-cancel-request": turnCancelRequestSchema,
    "turn-cancel-result": turnCancelResultSchema,
  });

// ---------------------------------------------------------------------------
// Machine-readable API descriptor
// ---------------------------------------------------------------------------

/** Machine-readable summary of routes, limits and error codes (v1.0). */
export const API_CONTRACT_DESCRIPTOR = Object.freeze({
  name: "lumithink-interaction-contract",
  protocolVersion: "1.0",
  routes: {
    interactions: "POST /api/v1/interactions",
    stream: "GET /api/v1/interactions/{traceId}/events (text/event-stream)",
    cancel: "POST /api/v1/interactions/{turnId}/cancel",
  },
  limits: {
    textMinChars: TEXT_LIMITS.minChars,
    textMaxChars: TEXT_LIMITS.maxChars,
    streamDeltaMaxChars: MAX_STREAM_DELTA_LENGTH,
    errorMessageMaxChars: MAX_ERROR_MESSAGE_LENGTH,
    clientVersionMaxChars: 64,
  },
  errorCodes: Object.fromEntries(
    Object.entries(CONTRACT_ERROR_REGISTRY).map(([code, meta]) => [
      code,
      { httpStatus: meta.httpStatus, retriable: meta.retriable },
    ]),
  ),
});

// ---------------------------------------------------------------------------
// Minimal JSON Schema validator (supported subset only)
// ---------------------------------------------------------------------------

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly problems: readonly string[];
}

function typeMatches(node: JsonSchemaNode, value: unknown): boolean {
  const type = node.type;
  if (type === undefined) {
    return true;
  }
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => {
    switch (candidate) {
      case "object":
        return typeof value === "object" && value !== null && !Array.isArray(value);
      case "array":
        return Array.isArray(value);
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
      case "null":
        return value === null;
    }
  });
}

/**
 * Validate `value` against one JSON Schema node of the supported subset.
 * Collects ALL problems; problem strings are structural (paths + limits),
 * never echoed values.
 */
export function validateJsonSchema(
  schema: JsonSchemaNode,
  value: unknown,
  rootPath = "",
): SchemaValidationResult {
  const problems: string[] = [];
  collectSchemaProblems(schema, value, rootPath, problems);
  return { valid: problems.length === 0, problems };
}

function collectSchemaProblems(
  schema: JsonSchemaNode,
  value: unknown,
  path: string,
  problems: string[],
): void {
  if (schema.type !== undefined && !typeMatches(schema, value)) {
    const expected = Array.isArray(schema.type) ? schema.type.join(" | ") : schema.type;
    problems.push(`${path || "value"}: expected type ${expected}`);
    return; // further checks depend on the type
  }
  if (schema.const !== undefined) {
    if (JSON.stringify(value) !== JSON.stringify(schema.const)) {
      problems.push(`${path || "value"}: must equal the const value`);
    }
  }
  if (schema.enum !== undefined) {
    const matched = schema.enum.some(
      (option) => JSON.stringify(option) === JSON.stringify(value),
    );
    if (!matched) {
      problems.push(`${path || "value"}: value is not in the allowed enum`);
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      problems.push(`${path || "value"}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      problems.push(`${path || "value"}: longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      problems.push(`${path || "value"}: does not match the required pattern`);
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      problems.push(`${path || "value"}: below minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      problems.push(`${path || "value"}: above maximum ${schema.maximum}`);
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      problems.push(`${path || "value"}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      problems.push(`${path || "value"}: more than maxItems ${schema.maxItems}`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        collectSchemaProblems(schema.items as JsonSchemaNode, item, `${path}[${index}]`, problems);
      });
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in record)) {
        problems.push(`${path ? `${path}.${key}` : key}: required field is missing`);
      }
    }
    for (const [key, item] of Object.entries(record)) {
      const propertySchema = properties[key];
      if (propertySchema !== undefined) {
        collectSchemaProblems(propertySchema, item, path ? `${path}.${key}` : key, problems);
      } else if (schema.additionalProperties === false) {
        problems.push(`${path ? `${path}.${key}` : key}: unknown field (additionalProperties=false)`);
      } else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        collectSchemaProblems(
          schema.additionalProperties as JsonSchemaNode,
          item,
          path ? `${path}.${key}` : key,
          problems,
        );
      }
    }
  }
}
