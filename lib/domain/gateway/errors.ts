/**
 * R1-02 Model Gateway — structured error taxonomy (docs/MODEL_GATEWAY.md §4,
 * issue #14).
 *
 * Hard requirements encoded here:
 * - 用户中止、超时与服务器失败必须可区分 (issue #14): the outcome taxonomy
 *   and error codes separate user cancellation, attempt timeout, provider
 *   failure classes, budget policy and breaker state.
 * - 错误与审计不落原始儿童正文/密钥 (issue #14): GatewayError messages are
 *   FIXED strings from the registry; provider error bodies, request text and
 *   key material are structurally incapable of entering a GatewayError —
 *   only validated ids and numeric/enum facts may appear in `details`.
 * - Providers never talk to the contract layer directly: they throw
 *   ProviderFailure with a static classification, and the gateway maps it.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { type ContractErrorCode } from "../contract/core.ts";

// ---------------------------------------------------------------------------
// Outcome taxonomy (audit + endpoint mapping vocabulary)
// ---------------------------------------------------------------------------

/**
 * Terminal outcome of one gateway turn. `user_cancelled` is a NORMAL outcome
 * (mapped to turn.cancelled by the endpoint layer, never to an error
 * envelope); everything else is a structured failure.
 */
export const GATEWAY_OUTCOMES = [
  "completed",
  "user_cancelled",
  "timeout",
  "provider_failure",
  "budget_exhausted",
  "circuit_open",
  "rejected",
] as const;
export type GatewayOutcome = (typeof GATEWAY_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// Gateway error codes
// ---------------------------------------------------------------------------

export const GATEWAY_ERROR_CODES = [
  "GATEWAY_INVALID_REQUEST",
  "GATEWAY_NO_PROVIDER",
  "GATEWAY_BUDGET_EXHAUSTED",
  "GATEWAY_CIRCUIT_OPEN",
  "GATEWAY_CANCELLED",
  "GATEWAY_PROVIDER_TIMEOUT",
  "GATEWAY_PROVIDER_UNAVAILABLE",
  "GATEWAY_PROVIDER_RATE_LIMITED",
  "GATEWAY_PROVIDER_SERVER_ERROR",
  "GATEWAY_AUTH_FAILED",
  "GATEWAY_PROVIDER_PROTOCOL",
] as const;
export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];

export interface GatewayErrorMetadata {
  /** Fixed, request-independent human message. Never echoes payload content. */
  readonly safeMessage: string;
  /** Whether retrying the SAME request later may succeed. */
  readonly retriable: boolean;
  /** Coarse outcome this code belongs to. */
  readonly outcome: GatewayOutcome;
}

export const GATEWAY_ERROR_REGISTRY: Readonly<Record<GatewayErrorCode, GatewayErrorMetadata>> =
  Object.freeze({
    GATEWAY_INVALID_REQUEST: {
      safeMessage: "The model request failed gateway validation.",
      retriable: false,
      outcome: "rejected",
    },
    GATEWAY_NO_PROVIDER: {
      safeMessage: "No provider is configured for the requested model; the gateway fails closed.",
      retriable: false,
      outcome: "rejected",
    },
    GATEWAY_BUDGET_EXHAUSTED: {
      safeMessage: "The daily model budget is exhausted; the request was rejected before any provider call.",
      retriable: false,
      outcome: "budget_exhausted",
    },
    GATEWAY_CIRCUIT_OPEN: {
      safeMessage: "The provider circuit breaker is open; the request was rejected before any provider call.",
      retriable: true,
      outcome: "circuit_open",
    },
    GATEWAY_CANCELLED: {
      safeMessage: "The model request was cancelled by the caller.",
      retriable: false,
      outcome: "user_cancelled",
    },
    GATEWAY_PROVIDER_TIMEOUT: {
      safeMessage: "The provider call exceeded the configured timeout and was cancelled.",
      // Retriable in principle, but the gateway deliberately does NOT
      // auto-retry timeouts (a timed-out child turn must not double-bill);
      // see docs/MODEL_GATEWAY.md §5.
      retriable: true,
      outcome: "timeout",
    },
    GATEWAY_PROVIDER_UNAVAILABLE: {
      safeMessage: "The provider could not be reached.",
      retriable: true,
      outcome: "provider_failure",
    },
    GATEWAY_PROVIDER_RATE_LIMITED: {
      safeMessage: "The provider rate-limited the request.",
      retriable: true,
      outcome: "provider_failure",
    },
    GATEWAY_PROVIDER_SERVER_ERROR: {
      safeMessage: "The provider returned a server error.",
      retriable: true,
      outcome: "provider_failure",
    },
    GATEWAY_AUTH_FAILED: {
      safeMessage: "The provider rejected the credentials.",
      retriable: false,
      outcome: "provider_failure",
    },
    GATEWAY_PROVIDER_PROTOCOL: {
      safeMessage: "The provider response violated the agreed wire contract.",
      retriable: false,
      outcome: "provider_failure",
    },
  });

/**
 * Structural detail values a GatewayError may carry. Every value is either a
 * re-validated contract id, a gateway/model/provider id, or an enum/number —
 * never free text derived from a payload, provider body or key.
 */
export type GatewayErrorDetail = string | number;

/**
 * The gateway's own error type. `message` is always the fixed registry
 * string for `code` — constructing with a cause never leaks the cause's
 * message anywhere (there is no field carrying it).
 */
export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly retriable: boolean;
  readonly outcome: GatewayOutcome;
  /** Structural, value-free context only. */
  readonly details: Readonly<Record<string, GatewayErrorDetail>>;

  constructor(code: GatewayErrorCode, details: Readonly<Record<string, GatewayErrorDetail>> = {}) {
    super(GATEWAY_ERROR_REGISTRY[code].safeMessage);
    this.name = "GatewayError";
    this.code = code;
    this.retriable = GATEWAY_ERROR_REGISTRY[code].retriable;
    this.outcome = GATEWAY_ERROR_REGISTRY[code].outcome;
    this.details = Object.freeze({ ...details });
  }
}

/** Plain, wire-safe description of a GatewayError (no stack, no cause text). */
export function describeGatewayError(error: unknown): {
  code: GatewayErrorCode;
  retriable: boolean;
  outcome: GatewayOutcome;
  details: Readonly<Record<string, GatewayErrorDetail>>;
} | null {
  if (!(error instanceof GatewayError)) {
    return null;
  }
  return {
    code: error.code,
    retriable: error.retriable,
    outcome: error.outcome,
    details: error.details,
  };
}

// ---------------------------------------------------------------------------
// Mapping to the R1-01 contract error registry (docs/MODEL_GATEWAY.md §6)
// ---------------------------------------------------------------------------

/**
 * How a gateway failure maps onto the unified contract ErrorEnvelope when an
 * endpoint (R1-05) surfaces it. Everything that is not a request-shape
 * problem collapses to CONTRACT_INTERNAL with the gateway code preserved as
 * a structural detail — the contract envelope never carries gateway internals
 * beyond this enum value.
 */
export const GATEWAY_TO_CONTRACT_ERROR_CODE: Readonly<Record<GatewayErrorCode, ContractErrorCode>> =
  Object.freeze({
    GATEWAY_INVALID_REQUEST: "CONTRACT_FIELD_INVALID",
    GATEWAY_NO_PROVIDER: "CONTRACT_INTERNAL",
    GATEWAY_BUDGET_EXHAUSTED: "CONTRACT_INTERNAL",
    GATEWAY_CIRCUIT_OPEN: "CONTRACT_INTERNAL",
    GATEWAY_CANCELLED: "CONTRACT_INTERNAL",
    GATEWAY_PROVIDER_TIMEOUT: "CONTRACT_INTERNAL",
    GATEWAY_PROVIDER_UNAVAILABLE: "CONTRACT_INTERNAL",
    GATEWAY_PROVIDER_RATE_LIMITED: "CONTRACT_INTERNAL",
    GATEWAY_PROVIDER_SERVER_ERROR: "CONTRACT_INTERNAL",
    GATEWAY_AUTH_FAILED: "CONTRACT_INTERNAL",
    GATEWAY_PROVIDER_PROTOCOL: "CONTRACT_INTERNAL",
  });

// ---------------------------------------------------------------------------
// Provider failure classification
// ---------------------------------------------------------------------------

/**
 * Static classification of a provider-level failure. Providers throw ONLY
 * this (or propagate a caller/timeout abort); arbitrary provider exceptions
 * must be caught and converted by the provider adapter itself, so no provider
 * error body can ever travel further than this enum.
 */
export type ProviderFailureClassification =
  | "cancelled"
  | "timeout"
  | "auth"
  | "rate_limited"
  | "server_error"
  | "unavailable"
  | "protocol"
  | "bad_request";

export class ProviderFailure extends Error {
  readonly classification: ProviderFailureClassification;
  /** Coarse HTTP status class when the failure came from a status code. */
  readonly statusClass: number | null;

  constructor(classification: ProviderFailureClassification, statusClass: number | null = null) {
    super(`provider failure: ${classification}`);
    this.name = "ProviderFailure";
    this.classification = classification;
    this.statusClass = statusClass;
  }
}

const CLASSIFICATION_TO_GATEWAY_CODE: Readonly<
  Record<Exclude<ProviderFailureClassification, "cancelled" | "timeout">, GatewayErrorCode>
> = Object.freeze({
  auth: "GATEWAY_AUTH_FAILED",
  rate_limited: "GATEWAY_PROVIDER_RATE_LIMITED",
  server_error: "GATEWAY_PROVIDER_SERVER_ERROR",
  unavailable: "GATEWAY_PROVIDER_UNAVAILABLE",
  protocol: "GATEWAY_PROVIDER_PROTOCOL",
  bad_request: "GATEWAY_PROVIDER_PROTOCOL",
});

export function gatewayCodeForClassification(
  classification: ProviderFailureClassification,
): GatewayErrorCode | null {
  if (classification === "cancelled") {
    return null; // handled as GATEWAY_CANCELLED by the gateway
  }
  if (classification === "timeout") {
    return "GATEWAY_PROVIDER_TIMEOUT";
  }
  return CLASSIFICATION_TO_GATEWAY_CODE[classification];
}

/**
 * Availability classes that feed the circuit breaker. Auth/protocol/
 * bad_request failures are provider MISCONFIGURATION or contract drift, not
 * availability, so they never open the breaker (documented + tested).
 */
export function isAvailabilityFailure(code: GatewayErrorCode): boolean {
  return (
    code === "GATEWAY_PROVIDER_TIMEOUT" ||
    code === "GATEWAY_PROVIDER_UNAVAILABLE" ||
    code === "GATEWAY_PROVIDER_RATE_LIMITED" ||
    code === "GATEWAY_PROVIDER_SERVER_ERROR"
  );
}
