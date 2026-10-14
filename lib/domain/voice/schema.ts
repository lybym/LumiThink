/**
 * R1-V1 Voice Turn Orchestrator — vocabulary and fail-closed parsers
 * (issue #28; docs/VOICE_RUNTIME.md §4/§5; docs/adr/0002-voice-runtime-bridge.md;
 * Roadmap R1-V1; PRD FR-016 stage 1).
 *
 * This module owns the state machine contract that the issue and the design
 * contract name verbatim: CREATED → QUEUED → RUNNING → COMPLETED;
 * QUEUED/RUNNING → CANCELLING → CANCELLED; any non-terminal state may enter
 * FAILED/TIMED_OUT. COMPLETED/CANCELLED/FAILED/TIMED_OUT are TERMINAL and
 * can never resume; the next input starts a NEW turn_id.
 *
 * PRIVACY (issue #28 统一阻断规则): no field of any audited or persisted
 * shape in this directory can carry child audio, transcript text, model
 * output text or any other free-form content. Everything is an enumerated
 * code, a grammar-checked contract id, or a bounded number — the content
 * never crosses this boundary, only a caller-computed content-free digest
 * (fingerprint) does. Enforced by tests/domain/voice/schema.spec.ts.
 *
 * The state names are uppercase to stay 1:1 with docs/VOICE_RUNTIME.md §4
 * (the design contract this code implements); every other enum follows the
 * repo's lowercase convention.
 *
 * This module must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import {
  ContractValidationError,
  problem,
  validateContractId,
  type ContractProblem,
} from "../contract/core.ts";
import { ingestDomainFact } from "../legacy-guard.ts";

// ---------------------------------------------------------------------------
// Turn state machine (docs/VOICE_RUNTIME.md §4)
// ---------------------------------------------------------------------------

export const VOICE_TURN_STATES = Object.freeze([
  "CREATED",
  "QUEUED",
  "RUNNING",
  "CANCELLING",
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "TIMED_OUT",
] as const);

export type VoiceTurnState = (typeof VOICE_TURN_STATES)[number];

/** Terminal states are irreversible: no outgoing transition exists. */
export const VOICE_TERMINAL_TURN_STATES = Object.freeze([
  "COMPLETED",
  "CANCELLED",
  "FAILED",
  "TIMED_OUT",
] as const);

export type VoiceTerminalTurnState = (typeof VOICE_TERMINAL_TURN_STATES)[number];

/** Settling outcomes the orchestrator may request (CANCELLED only from CANCELLING). */
export const VOICE_SETTLE_OUTCOMES = Object.freeze([
  "COMPLETED",
  "FAILED",
  "TIMED_OUT",
  "CANCELLED",
] as const);

export type VoiceSettleOutcome = (typeof VOICE_SETTLE_OUTCOMES)[number];

/**
 * The single source of truth for legal transitions. Everything not listed
 * is illegal and fails closed — including every transition OUT of a
 * terminal state (the empty arrays below are load-bearing).
 */
export const VOICE_TURN_TRANSITIONS: Readonly<
  Record<VoiceTurnState, readonly VoiceTurnState[]>
> = Object.freeze({
  CREATED: Object.freeze<VoiceTurnState[]>(["QUEUED", "CANCELLING", "FAILED", "TIMED_OUT"]),
  QUEUED: Object.freeze<VoiceTurnState[]>(["RUNNING", "CANCELLING", "FAILED", "TIMED_OUT"]),
  RUNNING: Object.freeze<VoiceTurnState[]>(["COMPLETED", "CANCELLING", "FAILED", "TIMED_OUT"]),
  CANCELLING: Object.freeze<VoiceTurnState[]>(["CANCELLED", "FAILED", "TIMED_OUT"]),
  COMPLETED: Object.freeze<VoiceTurnState[]>([]),
  CANCELLED: Object.freeze<VoiceTurnState[]>([]),
  FAILED: Object.freeze<VoiceTurnState[]>([]),
  TIMED_OUT: Object.freeze<VoiceTurnState[]>([]),
});

export function isVoiceTurnState(value: unknown): value is VoiceTurnState {
  return typeof value === "string" && (VOICE_TURN_STATES as readonly string[]).includes(value);
}

/** True exactly when `from → to` is a legal, non-reviving transition. */
export function isLegalVoiceTurnTransition(from: VoiceTurnState, to: VoiceTurnState): boolean {
  return (VOICE_TURN_TRANSITIONS[from] as readonly string[]).includes(to);
}

// ---------------------------------------------------------------------------
// Enumerated codes
// ---------------------------------------------------------------------------

/**
 * Structured rejection codes (issue #28: 迟到消息/重复取消/旧重试一律栅栏拒绝).
 * No submitted value is ever echoed — only these codes reach callers/audit.
 */
export const VOICE_REJECTION_CODES = Object.freeze([
  "session_unknown",
  "session_conflict",
  "turn_unknown",
  "cross_session_rejected",
  "epoch_forged",
  "stale_turn_rejected",
  "turn_terminal",
  "cancel_already_active",
  "turn_state_transition_illegal",
  "scheduler_busy",
  "idempotency_conflict",
  "voice.parse_failed",
] as const);

export type VoiceRejectionCode = (typeof VOICE_REJECTION_CODES)[number];

/**
 * Downstream output surfaces the fence protects (issue #28 实现范围 2 and
 * docs/VOICE_RUNTIME.md §4 step 1: epoch bump revokes the old turn's text,
 * TTS queue, audio send, candidate-memory and domain-write permissions).
 */
export const VOICE_OUTPUT_KINDS = Object.freeze(["text_delta", "tts_queue", "audio_send"] as const);

export type VoiceOutputKind = (typeof VOICE_OUTPUT_KINDS)[number];

/** Persisted downstream write kinds fenced by the atomic conditional commit. */
export const VOICE_WRITE_KINDS = Object.freeze(["candidate_memory", "domain_event"] as const);

export type VoiceWriteKind = (typeof VOICE_WRITE_KINDS)[number];

/** Cancellation reasons (enumerated; device semantics stay upstream). */
export const VOICE_CANCEL_REASONS = Object.freeze(["device_abort", "barge_in", "system_policy"] as const);

export type VoiceCancelReason = (typeof VOICE_CANCEL_REASONS)[number];

// ---------------------------------------------------------------------------
// Id grammars (reuse the R1-01 contract ids; epochs and digests bounded)
// ---------------------------------------------------------------------------

/**
 * Content-free digest of a prompt/write payload, computed by the caller.
 * The value itself is the ONLY content-shaped field allowed anywhere in
 * this directory, and it is a hex digest — never the content.
 */
export const VOICE_FINGERPRINT_PATTERN = /^[0-9a-f]{16,64}$/;

/** Caller-supplied idempotency key (bounded opaque token, no separators). */
export const VOICE_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;

export function isValidVoiceEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

export function isVoiceFingerprint(value: unknown): value is string {
  return typeof value === "string" && VOICE_FINGERPRINT_PATTERN.test(value);
}

export function isVoiceIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && VOICE_IDEMPOTENCY_KEY_PATTERN.test(value);
}

/**
 * Validate one set of voice-runtime ids through the shared contract grammar.
 * Session keys are contract `sessionId` ids (`ses_…`), turn ids `trn_…`,
 * trace ids `trc_…`. `null` and `undefined` both mean "not provided".
 */
export function validateVoiceRefs(
  refs: {
    readonly sessionKey?: unknown;
    readonly turnId?: unknown;
    readonly traceId?: unknown;
    readonly actorId?: unknown;
    readonly conversationId?: unknown;
  },
  problems: ContractProblem[],
): void {
  const provided = (value: unknown): boolean => value !== undefined && value !== null;
  if (provided(refs.sessionKey)) {
    validateContractId("sessionId", refs.sessionKey, "sessionKey", problems);
  }
  if (provided(refs.turnId)) {
    validateContractId("turnId", refs.turnId, "turnId", problems);
  }
  if (provided(refs.traceId)) {
    validateContractId("traceId", refs.traceId, "traceId", problems);
  }
  if (provided(refs.actorId)) {
    validateContractId("actorId", refs.actorId, "actorId", problems);
  }
  if (provided(refs.conversationId)) {
    validateContractId("conversationId", refs.conversationId, "conversationId", problems);
  }
}

/** Throw a single structured parse failure for malformed voice input. */
export function failVoiceParse(path: string, message: string): never {
  throw new ContractValidationError([problem("CONTRACT_FIELD_INVALID", path, message)]);
}

// ---------------------------------------------------------------------------
// Trusted store records (content-free by construction)
// ---------------------------------------------------------------------------

/** One trusted voice session. The store is the single owner of `epoch`. */
export interface VoiceSessionRecord {
  readonly sessionKey: string;
  readonly conversationId: string;
  readonly ownerActorId: string;
  readonly createdAtMs: number;
  /** Current trusted epoch (monotonic, >= 1). Clients can never set it. */
  readonly epoch: number;
}

/** One turn. `epoch` is the epoch the turn was born into and is bound to. */
export interface VoiceTurnRecord {
  readonly turnId: string;
  readonly sessionKey: string;
  readonly traceId: string | null;
  readonly epoch: number;
  readonly state: VoiceTurnState;
  readonly idempotencyKey: string | null;
  readonly fingerprint: string | null;
  readonly createdAtMs: number;
  readonly startedAtMs: number | null;
  readonly settledAtMs: number | null;
}

/** One queued TTS sentence slot (identity + epoch only; never the text). */
export interface VoiceTtsQueueItem {
  readonly itemId: string;
  readonly sessionKey: string;
  readonly turnId: string;
  readonly epoch: number;
  readonly queuedAtMs: number;
}

// ---------------------------------------------------------------------------
// Structured audit (issue #28: 只记 trace_id/turn_id/epoch/结果码)
// ---------------------------------------------------------------------------

export const VOICE_AUDIT_ACTIONS = Object.freeze([
  "session.opened",
  "asr.received",
  "turn.dispatched",
  "turn.settled",
  "cancel.requested",
  "cancel.stop_confirmed",
  "output.fenced",
  "tts.drained",
  "write.fenced",
  "timeout.swept",
] as const);

export type VoiceAuditAction = (typeof VOICE_AUDIT_ACTIONS)[number];

/** Enumerated audit outcome codes (rejections + positive outcomes + states). */
export type VoiceAuditResultCode =
  | VoiceRejectionCode
  | "ok"
  | "allowed"
  | VoiceTurnState;

/** The EXACT field set of an audit entry — the schema has no field that
 * could carry content, so content can never be audited (schema-tested). */
export const VOICE_AUDIT_FIELDS = Object.freeze([
  "seq",
  "atMs",
  "action",
  "sessionKey",
  "turnId",
  "traceId",
  "epoch",
  "resultCode",
  "finalState",
  "count",
] as const);

export interface VoiceAuditEntry {
  readonly seq: number;
  readonly atMs: number;
  readonly action: VoiceAuditAction;
  /** Grammar-validated ids only; unvalidated values are never echoed. */
  readonly sessionKey: string | null;
  readonly turnId: string | null;
  readonly traceId: string | null;
  readonly epoch: number | null;
  readonly resultCode: VoiceAuditResultCode;
  /** Final state for "turn.settled"; null otherwise. */
  readonly finalState: VoiceTurnState | null;
  /** Count for fan-out facts (e.g. turns fenced by one interruption). */
  readonly count: number | null;
}

/**
 * Admit one audit entry through the guarded domain intake (legacy scan +
 * deep freeze). Internal; the shape is produced only from validated parts.
 */
export function admitVoiceAuditEntry(entry: VoiceAuditEntry): Readonly<VoiceAuditEntry> {
  return ingestDomainFact(entry) as Readonly<VoiceAuditEntry>;
}
