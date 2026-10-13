/**
 * R1-01 unified error envelope of the versioned interaction contract
 * (docs/API_CONTRACT.md §7; issue #13 acceptance criterion: "任何错误不得
 * 输出堆栈、凭据或原始私人上下文" / no error may leak stack traces,
 * credentials or raw private context).
 *
 * toSafeErrorEnvelope() is the ONLY sanctioned way to turn a thrown value
 * into a wire-visible error. It fail-closes: unknown errors collapse to
 * CONTRACT_INTERNAL with a generic message; safe-context IDs are echoed
 * only after re-validation against the ID grammar, so an unvalidated or
 * malicious client-supplied value can never be reflected back.
 *
 * This module must stay dependency-free (no prisma, no react, no next).
 */

import {
  CONTRACT_ERROR_CODES,
  type ContractErrorCode,
  ContractValidationError,
  LATEST_PROTOCOL_VERSION,
  canonicalJson,
  isSupportedProtocolVersion,
  isValidContractId,
  isValidContractTimestamp,
  problem,
  validateTimestamp,
  type ContractProblem,
} from "./core.ts";

/** Per-code wire metadata owned by the contract (not per-endpoint). */
export interface ContractErrorMetadata {
  /** HTTP status the endpoint should map this code to. */
  readonly httpStatus: number;
  /** Whether retrying the same request may succeed later. */
  readonly retriable: boolean;
  /** Safe, fixed human message. Contains no request-derived content. */
  readonly safeMessage: string;
}

/** Registry of every unified contract error code. */
export const CONTRACT_ERROR_REGISTRY: Readonly<
  Record<ContractErrorCode, ContractErrorMetadata>
> = Object.freeze({
  CONTRACT_FIELD_MISSING: {
    httpStatus: 400,
    retriable: false,
    safeMessage: "A required contract field is missing.",
  },
  CONTRACT_FIELD_INVALID: {
    httpStatus: 400,
    retriable: false,
    safeMessage: "A contract field failed validation.",
  },
  CONTRACT_UNKNOWN_VERSION: {
    httpStatus: 400,
    retriable: false,
    safeMessage: "The submitted protocol version is not supported.",
  },
  CONTRACT_UNTRUSTED_IDENTITY: {
    httpStatus: 403,
    retriable: false,
    safeMessage: "Client-supplied identity fields are not trusted and were rejected.",
  },
  CONTRACT_WRONG_ROLE: {
    httpStatus: 403,
    retriable: false,
    safeMessage: "The verified role is not allowed to perform this operation.",
  },
  CONTRACT_DUPLICATE_REQUEST: {
    httpStatus: 409,
    retriable: false,
    safeMessage: "The request id was reused with a different payload.",
  },
  CONTRACT_CROSS_CONVERSATION: {
    httpStatus: 403,
    retriable: false,
    safeMessage: "The referenced conversation is not bound to the verified actor.",
  },
  CONTRACT_TEXT_TOO_LONG: {
    httpStatus: 413,
    retriable: false,
    safeMessage: "The submitted text exceeds the contract length limit.",
  },
  CONTRACT_INTERNAL: {
    httpStatus: 500,
    retriable: true,
    safeMessage: "Internal contract error.",
  },
});

/** The versioned error envelope emitted by every contract endpoint. */
export interface ErrorEnvelope {
  readonly protocolVersion: typeof LATEST_PROTOCOL_VERSION;
  readonly error: {
    readonly code: ContractErrorCode;
    readonly message: string;
    readonly retriable: boolean;
    /** Structural, value-free context only (field paths, limits, counts). */
    readonly details?: Readonly<Record<string, string | number>>;
    /** Echoed correlation ids — only after ID-grammar re-validation. */
    readonly requestId?: string;
    readonly traceId?: string;
    readonly conversationId?: string;
    readonly turnId?: string;
  };
  readonly occurredAt: string;
}

const SAFE_ID_FIELDS: ReadonlyArray<{ key: string; kind: Parameters<typeof isValidContractId>[0] }> = [
  { key: "requestId", kind: "requestId" },
  { key: "traceId", kind: "traceId" },
  { key: "conversationId", kind: "conversationId" },
  { key: "turnId", kind: "turnId" },
];

/**
 * Server-supplied correlation context for the serializer. Every value is
 * re-validated before being echoed; invalid values are dropped, never
 * reflected (an unvalidated client id may contain private content).
 */
export interface SafeErrorContext {
  readonly requestId?: unknown;
  readonly traceId?: unknown;
  readonly conversationId?: unknown;
  readonly turnId?: unknown;
}

function envelopeFromProblems(
  cause: ContractValidationError,
  context: SafeErrorContext,
  now: string,
): ErrorEnvelope {
  const first = cause.problems[0];
  const metadata = CONTRACT_ERROR_REGISTRY[first.code];
  const details: Record<string, string | number> = { problemCount: cause.problems.length };
  if (first.path) {
    details.field = first.path;
  }
  if (first.detail) {
    for (const [key, value] of Object.entries(first.detail)) {
      details[key] = value;
    }
  }
  const error: ErrorEnvelope["error"] = {
    code: first.code,
    message: metadata.safeMessage,
    retriable: metadata.retriable,
    details,
  };
  for (const { key, kind } of SAFE_ID_FIELDS) {
    const value = context[key as keyof SafeErrorContext];
    if (isValidContractId(kind, value)) {
      (error as Record<string, unknown>)[key] = value;
    }
  }
  return { protocolVersion: LATEST_PROTOCOL_VERSION, error, occurredAt: now };
}

/**
 * Convert any thrown value into a safe, versioned ErrorEnvelope.
 *
 * Guarantees (tested in tests/domain/contract/errors.spec.ts):
 * - ContractValidationError → its first problem's code + structural details.
 * - Anything else → CONTRACT_INTERNAL; the original message, stack and any
 *   derived strings are never included.
 * - Correlation IDs are echoed only when they re-validate against the ID
 *   grammar.
 */
export function toSafeErrorEnvelope(
  cause: unknown,
  options: { safeContext?: SafeErrorContext; now?: string } = {},
): ErrorEnvelope {
  const now = options.now ?? new Date().toISOString();
  const nowProblems: ContractProblem[] = [];
  validateTimestamp(now, "occurredAt", nowProblems);
  if (nowProblems.length > 0) {
    throw new ContractValidationError(nowProblems);
  }
  const context = options.safeContext ?? {};

  if (cause instanceof ContractValidationError) {
    return envelopeFromProblems(cause, context, now);
  }

  // Unknown failure: emit the generic internal envelope. The original
  // error object (message/stack/whatever it carries) is deliberately not
  // serialized anywhere.
  const error: ErrorEnvelope["error"] = {
    code: "CONTRACT_INTERNAL",
    message: CONTRACT_ERROR_REGISTRY.CONTRACT_INTERNAL.safeMessage,
    retriable: CONTRACT_ERROR_REGISTRY.CONTRACT_INTERNAL.retriable,
    details: {},
  };
  for (const { key, kind } of SAFE_ID_FIELDS) {
    const value = context[key as keyof SafeErrorContext];
    if (isValidContractId(kind, value)) {
      (error as Record<string, unknown>)[key] = value;
    }
  }
  return { protocolVersion: LATEST_PROTOCOL_VERSION, error, occurredAt: now };
}

/** Maximum serialized length of `error.message` on the wire. */
export const MAX_ERROR_MESSAGE_LENGTH = 512;

/** Parse a received ErrorEnvelope (e.g. inside a stream.error payload). */
export function parseErrorEnvelope(value: unknown): Readonly<ErrorEnvelope> {
  const problems: ContractProblem[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "errorEnvelope", "errorEnvelope must be an object."),
    ]);
  }
  const record = value as Record<string, unknown>;
  if (!isSupportedProtocolVersion(record.protocolVersion)) {
    problems.push(
      problem("CONTRACT_UNKNOWN_VERSION", "protocolVersion", "protocolVersion is not supported."),
    );
  }
  const occurredAt = record.occurredAt;
  validateTimestamp(occurredAt, "occurredAt", problems);

  const error = record.error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) {
    problems.push(problem("CONTRACT_FIELD_MISSING", "error", "error envelope is required."));
  } else {
    const errRecord = error as Record<string, unknown>;
    if (
      typeof errRecord.code !== "string" ||
      !(CONTRACT_ERROR_CODES as readonly string[]).includes(errRecord.code)
    ) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          "error.code",
          `error.code must be one of the contract codes: ${CONTRACT_ERROR_CODES.join(", ")}.`,
        ),
      );
    }
    if (
      typeof errRecord.message !== "string" ||
      errRecord.message.length === 0 ||
      errRecord.message.length > MAX_ERROR_MESSAGE_LENGTH
    ) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          "error.message",
          `error.message must be a non-empty string of at most ${MAX_ERROR_MESSAGE_LENGTH} characters.`,
        ),
      );
    }
    if (typeof errRecord.retriable !== "boolean") {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", "error.retriable", "error.retriable must be a boolean."),
      );
    }
    if (errRecord.details !== undefined) {
      if (errRecord.details === null || typeof errRecord.details !== "object" || Array.isArray(errRecord.details)) {
        problems.push(
          problem("CONTRACT_FIELD_INVALID", "error.details", "error.details must be an object when present."),
        );
      } else {
        for (const [key, item] of Object.entries(errRecord.details as Record<string, unknown>)) {
          if (typeof item !== "string" && typeof item !== "number") {
            problems.push(
              problem(
                "CONTRACT_FIELD_INVALID",
                `error.details.${key}`,
                "error.details values must be strings or numbers (structural context only).",
              ),
            );
          }
        }
      }
    }
    for (const { key, kind } of SAFE_ID_FIELDS) {
      const idValue = errRecord[key];
      if (idValue !== undefined && !isValidContractId(kind, idValue)) {
        problems.push(
          problem("CONTRACT_FIELD_INVALID", `error.${key}`, `error.${key} is not a valid ${kind}.`),
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return Object.freeze(record as unknown as ErrorEnvelope);
}

/** Stable JSON serialization of an error envelope (for tests/audit). */
export function serializeErrorEnvelope(envelope: Readonly<ErrorEnvelope>): string {
  return canonicalJson(envelope);
}
