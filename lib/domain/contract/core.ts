/**
 * R1-01 core primitives of the versioned interaction contract
 * (docs/API_CONTRACT.md, PRD FR-001, Roadmap R1-01).
 *
 * Everything shared by all contract payloads lives here: the protocol
 * version registry, the unified ID vocabulary (request_id / trace_id /
 * conversation_id / turn_id and friends), timestamp validation, a canonical
 * JSON serializer for stable fingerprints, and the structured validation
 * error type used by every contract parser.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

/**
 * Supported contract protocol versions. The first released version of the
 * unified interaction contract. Adding an entry is the ONLY way to accept a
 * new version; unknown versions are rejected fail-closed (issue #13).
 */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(["1.0"] as const);

export type SupportedProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];

/** Latest supported version, for server-side response stamping. */
export const LATEST_PROTOCOL_VERSION: SupportedProtocolVersion =
  SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

/**
 * Structured problem found while validating a contract payload.
 * `message` and `detail` must never contain submitted payload values —
 * only structural facts (field paths, limits, allowed values).
 */
export interface ContractProblem {
  readonly code: ContractErrorCode;
  readonly path: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, string | number>>;
}

/** Unified error codes of the contract (docs/API_CONTRACT.md §7). */
export const CONTRACT_ERROR_CODES = [
  "CONTRACT_FIELD_MISSING",
  "CONTRACT_FIELD_INVALID",
  "CONTRACT_UNKNOWN_VERSION",
  "CONTRACT_UNTRUSTED_IDENTITY",
  "CONTRACT_WRONG_ROLE",
  "CONTRACT_DUPLICATE_REQUEST",
  "CONTRACT_CROSS_CONVERSATION",
  "CONTRACT_TEXT_TOO_LONG",
  "CONTRACT_INTERNAL",
] as const;

export type ContractErrorCode = (typeof CONTRACT_ERROR_CODES)[number];

export class ContractValidationError extends Error {
  readonly problems: readonly ContractProblem[];

  constructor(problems: readonly ContractProblem[]) {
    super(
      `Contract validation failed with ${problems.length} problem(s); ` +
        "details are carried in the structured problems list, never in raw payload form.",
    );
    this.name = "ContractValidationError";
    this.problems = problems;
  }
}

/** Throw a ContractValidationError when `problems` is non-empty. */
export function failOnProblems(problems: ContractProblem[]): void {
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
}

/** Helper to build one problem with a consistent message shape. */
export function problem(
  code: ContractErrorCode,
  path: string,
  message: string,
  detail?: Record<string, string | number>,
): ContractProblem {
  return detail === undefined ? { code, path, message } : { code, path, message, detail };
}

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

export function isSupportedProtocolVersion(
  value: unknown,
): value is SupportedProtocolVersion {
  return (
    typeof value === "string" &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(value)
  );
}

/** Validate a client-submitted protocol version; unknown versions fail. */
export function assertSupportedProtocolVersion(value: unknown, path: string): void {
  if (isSupportedProtocolVersion(value)) {
    return;
  }
  // The offending value is intentionally not echoed.
  throw new ContractValidationError([
    problem(
      "CONTRACT_UNKNOWN_VERSION",
      path,
      "protocolVersion is not a supported contract version; " +
        `supported versions are: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`,
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Unified ID vocabulary
// ---------------------------------------------------------------------------

/**
 * Shared shape of every contract ID: `<kind-prefix>_<opaque body>`.
 * The charset is deliberately narrow (no whitespace, no separators beyond
 * `.` `_` `-`) so IDs are safe to echo in error envelopes, URLs and logs.
 */
export const CONTRACT_ID_PATTERN = /^[a-z][a-z0-9]{2,15}_[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

export const CONTRACT_ID_KINDS = [
  "requestId",
  "traceId",
  "conversationId",
  "turnId",
  "sessionId",
  "agentResponseId",
  "eventId",
  "actorId",
  "childRef",
] as const;

export type ContractIdKind = (typeof CONTRACT_ID_KINDS)[number];

/** Required prefix per ID kind. Server generators must honor these. */
export const CONTRACT_ID_PREFIXES: Readonly<Record<ContractIdKind, string>> = {
  requestId: "req_",
  traceId: "trc_",
  conversationId: "conv_",
  turnId: "trn_",
  sessionId: "ses_",
  agentResponseId: "rsp_",
  eventId: "evt_",
  actorId: "act_",
  childRef: "chd_",
};

/**
 * Validate one contract ID of the given kind (prefix + shared charset).
 * Fails closed without echoing the submitted value.
 */
export function validateContractId(
  kind: ContractIdKind,
  value: unknown,
  path: string,
  problems: ContractProblem[],
): void {
  const expected = CONTRACT_ID_PREFIXES[kind];
  if (value === undefined || value === null || value === "") {
    problems.push(
      problem("CONTRACT_FIELD_MISSING", path, `${path} is required and must be a ${kind}.`),
    );
    return;
  }
  if (typeof value !== "string" || !CONTRACT_ID_PATTERN.test(value) || !value.startsWith(expected)) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        path,
        `${path} must be a ${kind} id matching ${expected}<opaque body> ` +
          `(charset [A-Za-z0-9._-], body length 8-64); the submitted value is not echoed.`,
      ),
    );
  }
}

/** True when `value` is a valid ID of the given kind (non-throwing form). */
export function isValidContractId(kind: ContractIdKind, value: unknown): boolean {
  const problems: ContractProblem[] = [];
  validateContractId(kind, value, "id", problems);
  return problems.length === 0;
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

export const CONTRACT_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

export function isValidContractTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CONTRACT_TIMESTAMP_PATTERN.test(value)) {
    return false;
  }
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed);
}

export function validateTimestamp(value: unknown, path: string, problems: ContractProblem[]): void {
  if (!isValidContractTimestamp(value)) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        path,
        `${path} must be an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:MM:SS[.fraction]Z).`,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Canonical JSON (stable fingerprints for idempotency)
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization: object keys sorted recursively so that
 * two semantically identical payloads always produce the same string.
 * Used for idempotency fingerprints and SSE payload serialization.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(",")}}`;
}
