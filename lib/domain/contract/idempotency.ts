/**
 * R1-01 idempotency and API surface of the versioned interaction contract
 * (docs/API_CONTRACT.md §4/§8; issue #13: "约定可幂等重试、重复请求拒绝/合并").
 *
 * Pure, storage-free semantics: the endpoint owns the requestId →
 * { fingerprint, ack } ledger; this module decides what a submitted request
 * means given the stored entry, and builds the versioned ack payloads.
 *
 * - Same requestId + same semantic fingerprint  → replay (idempotent retry,
 *   the original turn is returned, nothing re-executes).
 * - Same requestId + different fingerprint      → CONTRACT_DUPLICATE_REQUEST
 *   (409): the id was reused for a different payload, including the same
 *   payload aimed at a different conversation (cross-conversation reuse).
 * - New requestId                               → accept.
 *
 * The fingerprint intentionally excludes clientContext (an upgraded client
 * may retry with a new clientVersion; the semantic payload is unchanged).
 *
 * This module must stay dependency-free (no prisma, no react, no next).
 */

import {
  type ContractProblem,
  ContractValidationError,
  LATEST_PROTOCOL_VERSION,
  problem,
  validateContractId,
  validateTimestamp,
} from "./core.ts";
import { fingerprintInteractionRequest, type InteractionRequest } from "./interaction.ts";

export { fingerprintInteractionRequest };

/** The server-stored record of one accepted interaction request. */
export interface StoredInteraction {
  readonly requestId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly traceId: string;
  readonly acceptedAt: string;
  /** canonicalJson fingerprint of the accepted semantic payload. */
  readonly fingerprint: string;
}

export type IdempotentRetryDecision =
  | { readonly action: "accept" }
  | { readonly action: "replay"; readonly stored: Readonly<StoredInteraction> }
  | {
      readonly action: "conflict";
      readonly reason: "request-id-reused-with-different-payload";
    };

/**
 * Decide what the endpoint does with a request whose clientRequestId maps
 * to `stored` (or nothing). Pure function; no I/O.
 */
export function resolveIdempotentRetry(params: {
  stored: Readonly<StoredInteraction> | null;
  incomingRequest: Readonly<InteractionRequest>;
}): IdempotentRetryDecision {
  const { stored, incomingRequest } = params;
  if (stored === null) {
    return { action: "accept" };
  }
  const incomingFingerprint = fingerprintInteractionRequest(incomingRequest);
  if (incomingFingerprint === stored.fingerprint) {
    return { action: "replay", stored };
  }
  return {
    action: "conflict",
    reason: "request-id-reused-with-different-payload",
  };
}

/** Raise the unified duplicate error (endpoint maps it to HTTP 409). */
export function rejectDuplicateRequest(): never {
  throw new ContractValidationError([
    problem(
      "CONTRACT_DUPLICATE_REQUEST",
      "interaction.clientRequestId",
      "This request id was already used with a different payload.",
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Versioned API surface
// ---------------------------------------------------------------------------

/** Fixed, versioned routes of the R1 text contract. */
export const API_ROUTES = Object.freeze({
  /** POST — submit a text interaction. */
  interactions: "/api/v1/interactions",
  /** GET (SSE) — event stream of one accepted request. */
  streamTemplate: "/api/v1/interactions/{traceId}/events",
  /** POST — cancel/ignore one turn (text R1). */
  cancelTemplate: "/api/v1/interactions/{turnId}/cancel",
} as const);

/** Build the SSE stream URL for an accepted request (validated id only). */
export function buildStreamUrl(traceId: string): string {
  // Never build a URL from an unvalidated id (path-injection guard).
  const problems: ContractProblem[] = [];
  validateContractId("traceId", traceId, "traceId", problems);
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return API_ROUTES.streamTemplate.replace("{traceId}", traceId);
}

/** Build the cancel URL for a turn (validated id only). */
export function buildCancelUrl(turnId: string): string {
  const problems: ContractProblem[] = [];
  validateContractId("turnId", turnId, "turnId", problems);
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return API_ROUTES.cancelTemplate.replace("{turnId}", turnId);
}

/** The versioned response to POST /api/v1/interactions. */
export interface InteractionAck {
  readonly protocolVersion: typeof LATEST_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly traceId: string;
  readonly status: "accepted" | "duplicate";
  readonly streamUrl: string;
  readonly cancelUrl: string;
  readonly acceptedAt: string;
}

/**
 * Build the ack for a newly accepted request. All ids must already be
 * validated server-side; they are re-validated here so a malformed id can
 * never reach the wire.
 */
export function buildInteractionAck(stored: {
  requestId: string;
  conversationId: string;
  turnId: string;
  traceId: string;
  acceptedAt: string;
}): Readonly<InteractionAck> {
  const problems: ContractProblem[] = [];
  validateContractId("requestId", stored.requestId, "requestId", problems);
  validateContractId("conversationId", stored.conversationId, "conversationId", problems);
  validateContractId("turnId", stored.turnId, "turnId", problems);
  validateContractId("traceId", stored.traceId, "traceId", problems);
  validateTimestamp(stored.acceptedAt, "acceptedAt", problems);
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return Object.freeze({
    protocolVersion: LATEST_PROTOCOL_VERSION,
    requestId: stored.requestId,
    conversationId: stored.conversationId,
    turnId: stored.turnId,
    traceId: stored.traceId,
    status: "accepted" as const,
    streamUrl: buildStreamUrl(stored.traceId),
    cancelUrl: buildCancelUrl(stored.turnId),
    acceptedAt: stored.acceptedAt,
  });
}

/**
 * Build the ack for an idempotent REPLAY: same turn/trace/conversation as
 * the original, status "duplicate", fresh timestamp. Nothing re-executes.
 */
export function buildDuplicateAck(
  stored: Readonly<StoredInteraction>,
  options: { now: string },
): Readonly<InteractionAck> {
  const problems: ContractProblem[] = [];
  validateTimestamp(options.now, "now", problems);
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return {
    ...buildInteractionAck({
      requestId: stored.requestId,
      conversationId: stored.conversationId,
      turnId: stored.turnId,
      traceId: stored.traceId,
      acceptedAt: stored.acceptedAt,
    }),
    status: "duplicate",
    acceptedAt: options.now,
  };
}

/** Parse an InteractionAck received from the wire (client-side validation). */
export function parseInteractionAck(value: unknown): Readonly<InteractionAck> {
  const problems: ContractProblem[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "ack", "ack must be an object."),
    ]);
  }
  const record = value as Record<string, unknown>;
  if (record.protocolVersion !== LATEST_PROTOCOL_VERSION) {
    problems.push(
      problem("CONTRACT_UNKNOWN_VERSION", "protocolVersion", "protocolVersion is not supported."),
    );
  }
  validateContractId("requestId", record.requestId, "requestId", problems);
  validateContractId("conversationId", record.conversationId, "conversationId", problems);
  validateContractId("turnId", record.turnId, "turnId", problems);
  validateContractId("traceId", record.traceId, "traceId", problems);
  validateTimestamp(record.acceptedAt, "acceptedAt", problems);
  if (record.status !== "accepted" && record.status !== "duplicate") {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "status", 'status must be "accepted" or "duplicate".'),
    );
  }
  if (typeof record.streamUrl !== "string" || record.streamUrl !== buildStreamUrl(record.traceId as string)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "streamUrl", "streamUrl must match the contract stream route."),
    );
  }
  if (typeof record.cancelUrl !== "string" || record.cancelUrl !== buildCancelUrl(record.turnId as string)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "cancelUrl", "cancelUrl must match the contract cancel route."),
    );
  }
  for (const key of Object.keys(record)) {
    if (
      ![
        "protocolVersion",
        "requestId",
        "conversationId",
        "turnId",
        "traceId",
        "status",
        "streamUrl",
        "cancelUrl",
        "acceptedAt",
      ].includes(key)
    ) {
      problems.push(problem("CONTRACT_FIELD_INVALID", key, "ack carries an unknown field."));
    }
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return Object.freeze(record as unknown as InteractionAck);
}
