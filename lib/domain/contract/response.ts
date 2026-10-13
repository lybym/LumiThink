/**
 * R1-01 output side of the versioned interaction contract
 * (docs/API_CONTRACT.md §5/§6; issue #13).
 *
 * Covers the AgentResponse of a turn, the versioned SSE StreamEvent
 * envelope of GET /api/v1/interactions/{traceId}/events, the turn cancel
 * contract (POST /api/v1/interactions/{turnId}/cancel) for text R1, and the
 * cancel/ignore rule: a result that arrives after its turn was cancelled is
 * downgraded to status "ignored" and its content is dropped, so cancelled
 * output can never surface to a child.
 *
 * This module must stay dependency-free (no prisma, no react, no next)
 * except for the domain intake guard.
 */

import {
  assertSupportedProtocolVersion,
  type ContractProblem,
  ContractValidationError,
  problem,
  validateContractId,
  validateTimestamp,
} from "./core.ts";
import { type ActorContext, type ActorRole } from "./actor.ts";
import { ingestDomainFact } from "../legacy-guard.ts";
import { parseErrorEnvelope, type ErrorEnvelope } from "./errors.ts";

/** Terminal states of a turn's result. */
export const TURN_STATUSES = ["completed", "cancelled", "ignored", "failed"] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

/** Maximum code points of one streamed agent delta fragment. */
export const MAX_STREAM_DELTA_LENGTH = 1000;

/**
 * The versioned agent output for one turn. `content` is present only when
 * status is "completed" — cancelled/ignored/failed responses never carry
 * content (fail-closed privacy rule, tested in tests/domain/contract/response.spec.ts).
 */
export interface AgentResponse {
  readonly protocolVersion: "1.0";
  readonly agentResponseId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly traceId: string;
  readonly status: TurnStatus;
  readonly content: { readonly text: string; readonly format: "plain" } | null;
  readonly completedAt: string;
}

const AGENT_OUTPUT_MAX_CHARS = 4000;

function parseAgentContent(
  value: unknown,
  status: unknown,
  problems: ContractProblem[],
): { text: string; format: "plain" } | null {
  if (value === undefined || value === null) {
    if (status === "completed") {
      problems.push(
        problem("CONTRACT_FIELD_MISSING", "content", "content is required when status is completed."),
      );
    }
    return null;
  }
  if (status !== "completed") {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "content",
        `content must be absent (null) when status is "${String(status)}"; ` +
          "cancelled, ignored and failed responses never carry content.",
      ),
    );
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "content", "content must be an object."));
    return null;
  }
  const record = value as Record<string, unknown>;
  let text: string | null = null;
  if (typeof record.text !== "string") {
    problems.push(problem("CONTRACT_FIELD_MISSING", "content.text", "content.text is required."));
  } else {
    const codePoints = [...record.text];
    if (codePoints.length === 0 || record.text.trim().length === 0) {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", "content.text", "content.text must contain non-whitespace characters."),
      );
    } else if (codePoints.length > AGENT_OUTPUT_MAX_CHARS) {
      problems.push(
        problem(
          "CONTRACT_TEXT_TOO_LONG",
          "content.text",
          `content.text exceeds the ${AGENT_OUTPUT_MAX_CHARS} code-point limit.`,
          { limit: AGENT_OUTPUT_MAX_CHARS, actual: codePoints.length },
        ),
      );
    } else {
      text = record.text;
    }
  }
  if (record.format !== undefined && record.format !== "plain") {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "content.format", 'content.format must be "plain" in contract v1.0.'),
    );
  }
  for (const key of Object.keys(record)) {
    if (key !== "text" && key !== "format") {
      problems.push(problem("CONTRACT_FIELD_INVALID", `content.${key}`, "content carries an unknown field."));
    }
  }
  return text === null ? null : { text, format: "plain" };
}

/** Parse and validate an AgentResponse (e.g. before emitting agent.completed). */
export function parseAgentResponse(value: unknown): Readonly<AgentResponse> {
  const problems: ContractProblem[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "agentResponse", "agentResponse must be an object."),
    ]);
  }
  const record = value as Record<string, unknown>;
  assertSupportedProtocolVersion(record.protocolVersion, "protocolVersion");
  validateContractId("agentResponseId", record.agentResponseId, "agentResponseId", problems);
  validateContractId("conversationId", record.conversationId, "conversationId", problems);
  validateContractId("turnId", record.turnId, "turnId", problems);
  validateContractId("traceId", record.traceId, "traceId", problems);
  validateTimestamp(record.completedAt, "completedAt", problems);
  if (
    typeof record.status !== "string" ||
    !(TURN_STATUSES as readonly string[]).includes(record.status)
  ) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "status",
        `status must be one of: ${TURN_STATUSES.join(" | ")}.`,
      ),
    );
  }
  const content = parseAgentContent(record.content, record.status, problems);
  const allowedKeys = [
    "protocolVersion",
    "agentResponseId",
    "conversationId",
    "turnId",
    "traceId",
    "status",
    "content",
    "completedAt",
  ];
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      problems.push(problem("CONTRACT_FIELD_INVALID", key, "agentResponse carries an unknown field."));
    }
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  const response: AgentResponse = {
    protocolVersion: "1.0",
    agentResponseId: record.agentResponseId as string,
    conversationId: record.conversationId as string,
    turnId: record.turnId as string,
    traceId: record.traceId as string,
    status: record.status as TurnStatus,
    content,
    completedAt: record.completedAt as string,
  };
  // Admit through the domain intake guard (freeze + legacy scan).
  return ingestDomainFact(response) as Readonly<AgentResponse>;
}

/**
 * Cancel/ignore rule (text R1): when a result arrives for an already
 * cancelled turn, it must be marked "ignored" and its content dropped —
 * the child never sees cancelled output. Correlation ids are preserved for
 * audit. This is the text-level primitive the R1-V epoch fencing (issue #28)
 * generalizes.
 */
export function suppressLateAgentResponse(
  response: Readonly<AgentResponse>,
): Readonly<AgentResponse> {
  return ingestDomainFact({
    ...response,
    status: "ignored",
    content: null,
  }) as Readonly<AgentResponse>;
}

// ---------------------------------------------------------------------------
// Turn cancel contract (text R1)
// ---------------------------------------------------------------------------

export const TURN_CANCEL_REASONS = [
  "user_stop",
  "client_disconnect",
  "guardian_stop",
  "system_policy",
] as const;
export type TurnCancelReason = (typeof TURN_CANCEL_REASONS)[number];

export const TURN_CANCEL_RESULT_STATUSES = ["cancelled", "already_final", "unknown_turn"] as const;
export type TurnCancelResultStatus = (typeof TURN_CANCEL_RESULT_STATUSES)[number];

/** Request body of POST /api/v1/interactions/{turnId}/cancel. */
export interface TurnCancelRequest {
  readonly protocolVersion: string;
  readonly turnId: string;
  readonly conversationId: string;
  readonly reason: TurnCancelReason;
}

/** Who may cancel a turn: the child themself, guardians, or the system. */
const TURN_CANCEL_ALLOWED_ROLES: readonly ActorRole[] = ["child", "guardian", "system"];

/** Validate a cancel request against a verified actor (role matrix applied). */
export function parseTurnCancelRequest(
  value: unknown,
  actor: Readonly<ActorContext>,
): Readonly<TurnCancelRequest> {
  const problems: ContractProblem[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "cancelRequest", "cancelRequest must be an object."),
    ]);
  }
  const record = value as Record<string, unknown>;
  assertSupportedProtocolVersion(record.protocolVersion, "protocolVersion");
  validateContractId("turnId", record.turnId, "turnId", problems);
  validateContractId("conversationId", record.conversationId, "conversationId", problems);
  if (
    typeof record.reason !== "string" ||
    !(TURN_CANCEL_REASONS as readonly string[]).includes(record.reason)
  ) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "reason",
        `reason must be one of: ${TURN_CANCEL_REASONS.join(" | ")}.`,
      ),
    );
  }
  for (const key of Object.keys(record)) {
    if (!["protocolVersion", "turnId", "conversationId", "reason"].includes(key)) {
      problems.push(problem("CONTRACT_FIELD_INVALID", key, "cancelRequest carries an unknown field."));
    }
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  // Role authorization: a voice_device principal cannot cancel text turns.
  if (!TURN_CANCEL_ALLOWED_ROLES.includes(actor.role)) {
    throw new ContractValidationError([
      problem(
        "CONTRACT_WRONG_ROLE",
        "actor.role",
        `role "${actor.role}" may not cancel text turns; allowed roles: ${TURN_CANCEL_ALLOWED_ROLES.join(", ")}.`,
      ),
    ]);
  }
  return Object.freeze({
    protocolVersion: record.protocolVersion as string,
    turnId: record.turnId as string,
    conversationId: record.conversationId as string,
    reason: record.reason as TurnCancelReason,
  });
}

/** Server answer to a cancel request (already-final and unknown are safe no-ops). */
export interface TurnCancelResult {
  readonly protocolVersion: "1.0";
  readonly turnId: string;
  readonly conversationId: string;
  readonly status: TurnCancelResultStatus;
  readonly resolvedAt: string;
}

export function parseTurnCancelResult(value: unknown): Readonly<TurnCancelResult> {
  const problems: ContractProblem[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "cancelResult", "cancelResult must be an object."),
    ]);
  }
  const record = value as Record<string, unknown>;
  assertSupportedProtocolVersion(record.protocolVersion, "protocolVersion");
  validateContractId("turnId", record.turnId, "turnId", problems);
  validateContractId("conversationId", record.conversationId, "conversationId", problems);
  validateTimestamp(record.resolvedAt, "resolvedAt", problems);
  if (
    typeof record.status !== "string" ||
    !(TURN_CANCEL_RESULT_STATUSES as readonly string[]).includes(record.status)
  ) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "status",
        `status must be one of: ${TURN_CANCEL_RESULT_STATUSES.join(" | ")}.`,
      ),
    );
  }
  for (const key of Object.keys(record)) {
    if (!["protocolVersion", "turnId", "conversationId", "status", "resolvedAt"].includes(key)) {
      problems.push(problem("CONTRACT_FIELD_INVALID", key, "cancelResult carries an unknown field."));
    }
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return Object.freeze(record as unknown as TurnCancelResult);
}

// ---------------------------------------------------------------------------
// SSE StreamEvent envelope
// ---------------------------------------------------------------------------

export const STREAM_EVENT_KINDS = [
  "stream.started",
  "agent.delta",
  "agent.completed",
  "turn.cancelled",
  "stream.error",
  "stream.end",
] as const;
export type StreamEventKind = (typeof STREAM_EVENT_KINDS)[number];

/** Payloads discriminated by `type`, one per stream event kind. */
export type StreamEventPayload =
  | { readonly type: "started"; readonly acceptedAt: string }
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "completed"; readonly response: Readonly<AgentResponse> }
  | { readonly type: "cancelled"; readonly by: Exclude<ActorRole, "voice_device"> }
  | { readonly type: "error"; readonly error: Readonly<ErrorEnvelope> }
  | { readonly type: "end" };

/** Versioned SSE event envelope. `seq` is 0-based and monotonic per stream. */
export interface StreamEvent {
  readonly protocolVersion: "1.0";
  readonly kind: StreamEventKind;
  readonly seq: number;
  readonly conversationId: string;
  readonly turnId: string;
  readonly traceId: string;
  readonly occurredAt: string;
  readonly payload: StreamEventPayload;
}

const EXPECTED_PAYLOAD_TYPE: Readonly<Record<StreamEventKind, string>> = {
  "stream.started": "started",
  "agent.delta": "delta",
  "agent.completed": "completed",
  "turn.cancelled": "cancelled",
  "stream.error": "error",
  "stream.end": "end",
};

function parseStreamPayload(
  kind: StreamEventKind,
  value: unknown,
  problems: ContractProblem[],
): StreamEventPayload | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    problems.push(problem("CONTRACT_FIELD_MISSING", "payload", "payload is required."));
    return null;
  }
  const record = value as Record<string, unknown>;
  const expected = EXPECTED_PAYLOAD_TYPE[kind];
  if (record.type !== expected) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "payload.type",
        `payload.type must be "${expected}" for stream kind "${kind}".`,
      ),
    );
    return null;
  }
  switch (expected) {
    case "started": {
      validateTimestamp(record.acceptedAt, "payload.acceptedAt", problems);
      break;
    }
    case "delta": {
      if (typeof record.text !== "string") {
        problems.push(problem("CONTRACT_FIELD_MISSING", "payload.text", "payload.text is required."));
      } else {
        const codePoints = [...record.text];
        if (codePoints.length === 0) {
          problems.push(
            problem("CONTRACT_FIELD_INVALID", "payload.text", "payload.text must be non-empty."),
          );
        } else if (codePoints.length > MAX_STREAM_DELTA_LENGTH) {
          problems.push(
            problem(
              "CONTRACT_TEXT_TOO_LONG",
              "payload.text",
              `payload.text exceeds the ${MAX_STREAM_DELTA_LENGTH} code-point per-delta limit.`,
              { limit: MAX_STREAM_DELTA_LENGTH, actual: codePoints.length },
            ),
          );
        }
      }
      break;
    }
    case "completed": {
      try {
        parseAgentResponse(record.response);
      } catch (error) {
        if (error instanceof ContractValidationError) {
          for (const p of error.problems) {
            problems.push(problem(p.code, `payload.response.${p.path}`, p.message, p.detail));
          }
        } else {
          throw error;
        }
      }
      break;
    }
    case "cancelled": {
      if (
        typeof record.by !== "string" ||
        !["child", "guardian", "system"].includes(record.by)
      ) {
        problems.push(
          problem(
            "CONTRACT_FIELD_INVALID",
            "payload.by",
            'payload.by must be "child", "guardian" or "system".',
          ),
        );
      }
      break;
    }
    case "error": {
      try {
        parseErrorEnvelope(record.error);
      } catch (error) {
        if (error instanceof ContractValidationError) {
          for (const p of error.problems) {
            problems.push(problem(p.code, `payload.error.${p.path}`, p.message, p.detail));
          }
        } else {
          throw error;
        }
      }
      break;
    }
    case "end": {
      break; // end has no fields
    }
  }
  for (const key of Object.keys(record)) {
    const expectedKeys: Record<string, readonly string[]> = {
      started: ["type", "acceptedAt"],
      delta: ["type", "text"],
      completed: ["type", "response"],
      cancelled: ["type", "by"],
      error: ["type", "error"],
      end: ["type"],
    };
    if (!expectedKeys[expected].includes(key)) {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", `payload.${key}`, "payload carries an unknown field for this kind."),
      );
    }
  }
  return record as unknown as StreamEventPayload;
}

/** Parse and validate a versioned SSE StreamEvent. */
export function parseStreamEvent(value: unknown): Readonly<StreamEvent> {
  const problems: ContractProblem[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "streamEvent", "streamEvent must be an object."),
    ]);
  }
  const record = value as Record<string, unknown>;
  assertSupportedProtocolVersion(record.protocolVersion, "protocolVersion");
  if (
    typeof record.kind !== "string" ||
    !(STREAM_EVENT_KINDS as readonly string[]).includes(record.kind)
  ) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "kind",
        `kind must be one of: ${STREAM_EVENT_KINDS.join(" | ")}.`,
      ),
    );
  }
  if (typeof record.seq !== "number" || !Number.isInteger(record.seq) || record.seq < 0) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "seq", "seq must be a non-negative integer (0-based, monotonic)."),
    );
  }
  validateContractId("conversationId", record.conversationId, "conversationId", problems);
  validateContractId("turnId", record.turnId, "turnId", problems);
  validateContractId("traceId", record.traceId, "traceId", problems);
  validateTimestamp(record.occurredAt, "occurredAt", problems);
  let payload: StreamEventPayload | null = null;
  if (typeof record.kind === "string" && (STREAM_EVENT_KINDS as readonly string[]).includes(record.kind)) {
    payload = parseStreamPayload(record.kind as StreamEventKind, record.payload, problems);
  } else if (record.payload === undefined) {
    problems.push(problem("CONTRACT_FIELD_MISSING", "payload", "payload is required."));
  }
  const allowedKeys = [
    "protocolVersion",
    "kind",
    "seq",
    "conversationId",
    "turnId",
    "traceId",
    "occurredAt",
    "payload",
  ];
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      problems.push(problem("CONTRACT_FIELD_INVALID", key, "streamEvent carries an unknown field."));
    }
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return Object.freeze({
    protocolVersion: "1.0",
    kind: record.kind as StreamEventKind,
    seq: record.seq as number,
    conversationId: record.conversationId as string,
    turnId: record.turnId as string,
    traceId: record.traceId as string,
    occurredAt: record.occurredAt as string,
    payload: Object.freeze(payload as unknown as StreamEventPayload),
  });
}

/**
 * Serialize one StreamEvent as an SSE frame:
 * `event: <kind>\ndata: <canonical json>\n\n` (SSE spec: LF line endings).
 */
export function formatStreamEventAsSse(event: Readonly<StreamEvent>): string {
  // Validate on the way out so a malformed event can never reach the wire.
  parseStreamEvent(event);
  return `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Assert that `events` form a coherent stream: seq starts at 0 and is
 * strictly monotonic, and all correlation ids match the turn.
 */
export function assertCoherentStream(
  events: readonly Readonly<StreamEvent>[],
  ids: { conversationId: string; turnId: string; traceId: string },
): void {
  const problems: ContractProblem[] = [];
  events.forEach((event, index) => {
    if (event.seq !== index) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          `events[${index}].seq`,
          `stream seq must be ${index} (0-based, strictly monotonic).`,
          { expected: index, actual: event.seq },
        ),
      );
    }
    if (
      event.conversationId !== ids.conversationId ||
      event.turnId !== ids.turnId ||
      event.traceId !== ids.traceId
    ) {
      problems.push(
        problem(
          "CONTRACT_CROSS_CONVERSATION",
          `events[${index}]`,
          "stream event correlation ids must match the turn's conversation/turn/trace.",
        ),
      );
    }
  });
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
}
