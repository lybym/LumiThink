/**
 * R1-14 Child Memory v0 — minimal memory schema (issue #26; PRD §7.2
 * metadata list; Roadmap R1-14; FR-008).
 *
 * The schema is deliberately MINIMAL and separate from every other store:
 * DSH sessions (lib/domain/runtime/session-map.ts), the frozen legacy
 * prisma RawEvent/CognitiveProfile shapes (lib/domain/legacy-guard.ts) and
 * the runtime trace. A memory entry carries exactly the PRD §7.2 metadata:
 * subject, type, claim, source, observed_at, status, sensitivity,
 * review_at and supersedes — nothing else, and unknown fields are rejected
 * fail-closed (no silent schema drift).
 *
 * Core invariants (issue #26):
 * - Only TWO memory types exist: confirmed preferences and necessary
 *   facts. Psychological/personality/ability/diagnosis label types do not
 *   exist in the vocabulary, so an attempt to record one can only fail.
 * - Persisted facts always carry provenance (source) and a lifecycle
 *   status; a confirmed entry is never mutated in place — corrections
 *   create a new entry with `supersedes`, and the old version is marked
 *   superseded and excluded from retrieval (no replay / checkpoint
 *   re-injection of corrected claims).
 * - Deletion is a HARD removal of the whole supersedes lineage (retrieval
 *   returns 0 afterwards); only the structural audit fact survives.
 * - Old prisma CognitiveProfile quantified scores cannot enter this model:
 *   the schema has no score fields, and any entry-shaped object carrying
 *   them is rejected by the legacy intake guard (tested).
 *
 * This module must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import {
  ContractValidationError,
  problem,
  validateContractId,
  validateTimestamp,
  type ContractProblem,
} from "../contract/core.ts";
import { ACTOR_ROLES, type ActorRole } from "../contract/actor.ts";
import { ingestDomainFact } from "../legacy-guard.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Supported memory schema versions; unknown versions fail closed. */
export const MEMORY_SCHEMA_VERSIONS = Object.freeze(["1.0"] as const);
export type MemorySchemaVersion = (typeof MEMORY_SCHEMA_VERSIONS)[number];
export const MEMORY_SCHEMA_VERSION: MemorySchemaVersion =
  MEMORY_SCHEMA_VERSIONS[MEMORY_SCHEMA_VERSIONS.length - 1];

/**
 * The ONLY memory types (issue #26 交付范围 1: 经确认偏好/必要事实).
 * There is deliberately NO personality / ability / diagnosis / score type:
 * auto-recording such labels is impossible in this vocabulary, and any
 * submission claiming such a type is rejected (`memory.type_not_allowed`).
 */
export const MEMORY_TYPES = Object.freeze(["confirmed_preference", "necessary_fact"] as const);
export type MemoryType = (typeof MEMORY_TYPES)[number];

/**
 * Provenance of a memory (PRD §7.2: 来源). `agent_proposal` marks facts
 * surfaced by the agent runtime through the candidate-only `memory.propose`
 * tool — they remain candidates until a human confirms them; they are also
 * the only source screened by the deterministic label screen below.
 */
export const MEMORY_SOURCES = Object.freeze(["child_statement", "guardian_input", "agent_proposal"] as const);
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/**
 * Lifecycle status. Deletion has NO status: deleted entries are removed
 * from the store entirely (hard delete) and survive only as a structural
 * audit fact (issue #26: 永久删除; R1-09 owns the wider data lifecycle).
 */
export const MEMORY_STATUSES = Object.freeze(["candidate", "confirmed", "superseded", "expired"] as const);
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

/** Sensitivity levels (PRD §7.2). Sensitive entries stay out of the child
 * context by default and surface only to explicitly authorized views. */
export const MEMORY_SENSITIVITIES = Object.freeze(["normal", "sensitive"] as const);
export type MemorySensitivity = (typeof MEMORY_SENSITIVITIES)[number];

/** Memory ids are service-internal (`mem_`), never part of the HTTP contract. */
export const MEMORY_ID_PATTERN = /^mem_[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

/** Bounded claim length (code points). */
export const MEMORY_MAX_CLAIM_CODE_POINTS = 280;

/** Retrieval returns at most this many refs (minimal-necessary principle). */
export const MAX_RETRIEVAL_REFS = 8;

/** The bounded memory audit ring (separate from the runtime trace). */
export const MAX_MEMORY_AUDIT_ENTRIES = 256;

// ---------------------------------------------------------------------------
// Structured rejection codes (no submitted values are ever echoed)
// ---------------------------------------------------------------------------

export const MEMORY_REJECTION_CODES = Object.freeze([
  "memory.unauthorized",
  "memory.subject_mismatch",
  "memory.type_not_allowed",
  "memory.label_screen_block",
  "memory.duplicate",
  "memory.conflict",
  "memory.expired",
  "memory.not_found",
  "memory.wrong_state",
  "memory.claim_unchanged",
  "memory.parse_failed",
] as const);
export type MemoryRejectionCode = (typeof MEMORY_REJECTION_CODES)[number];

// ---------------------------------------------------------------------------
// Candidate input + entry shapes
// ---------------------------------------------------------------------------

/** Validated intake shape of one memory candidate. */
export interface MemoryCandidateInput {
  readonly schemaVersion: MemorySchemaVersion;
  /** Subject child (`chd_…` contract id); memories are per-child facts. */
  readonly subjectRef: string;
  readonly type: MemoryType;
  /** The fact itself, 1..280 code points, trimmed. */
  readonly claim: string;
  readonly source: MemorySource;
  /** When the fact was observed/stated (ISO-8601 UTC). */
  readonly observedAt: string;
  /** Optional hard expiry (ISO-8601 UTC); expired candidates never confirm. */
  readonly expiresAt: string | null;
  /** Optional review deadline (ISO-8601 UTC); review-due entries stop being
   * retrieved until a guardian re-reviews them (PRD §7.2 review_at). */
  readonly reviewAt: string | null;
  readonly sensitivity: MemorySensitivity;
}

/**
 * A stored memory entry. Entries are immutable once created (deep-frozen
 * through the domain intake guard); lifecycle changes REPLACE the entry.
 * `supersedes` is set only by the correction path (correctMemory) — intake
 * rejects the field so new facts can never masquerade as corrections.
 */
export interface MemoryEntry extends MemoryCandidateInput {
  readonly memoryId: string;
  /** Predecessor entry replaced by a correction (`null` for fresh facts). */
  readonly supersedes: string | null;
  readonly status: MemoryStatus;
  /** Server-verified role that submitted the candidate. */
  readonly proposedByRole: ActorRole;
  readonly createdAt: string;
  readonly confirmedAt: string | null;
  /** Role that explicitly confirmed the entry (child or guardian only). */
  readonly confirmedByRole: ActorRole | null;
  readonly supersededAt: string | null;
  /** Schema revision of this entry shape (stable "1" for v0 entries). */
  readonly revision: 1;
}

function isOneOf(value: unknown, list: readonly string[]): value is string {
  return typeof value === "string" && list.includes(value);
}

/**
 * Parse and validate one memory candidate intake. Fail-closed: missing or
 * unknown fields, unknown enum values and malformed ids/timestamps are all
 * rejected with structured problems that never echo submitted values.
 */
export function parseMemoryCandidateInput(value: unknown): Readonly<MemoryCandidateInput> {
  const problems: ContractProblem[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "candidate", "memory candidate must be an object."),
    ]);
  }
  const record = value as Record<string, unknown>;

  if (record.schemaVersion === undefined || record.schemaVersion === null) {
    problems.push(problem("CONTRACT_FIELD_MISSING", "candidate.schemaVersion", "schemaVersion is required."));
  } else if (record.schemaVersion !== MEMORY_SCHEMA_VERSION) {
    problems.push(
      problem(
        "CONTRACT_UNKNOWN_VERSION",
        "candidate.schemaVersion",
        `schemaVersion must be "${MEMORY_SCHEMA_VERSION}".`,
      ),
    );
  }

  validateContractId("childRef", record.subjectRef, "candidate.subjectRef", problems);

  if (record.type === undefined || record.type === null || record.type === "") {
    problems.push(problem("CONTRACT_FIELD_MISSING", "candidate.type", "type is required."));
  } else if (!isOneOf(record.type, MEMORY_TYPES)) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "candidate.type",
        `type must be one of: ${MEMORY_TYPES.join(" | ")}.`,
      ),
    );
  }

  if (typeof record.claim !== "string" || record.claim.trim().length === 0) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "candidate.claim", "claim must be a non-empty string."));
  } else if ([...record.claim.trim()].length > MEMORY_MAX_CLAIM_CODE_POINTS) {
    problems.push(
      problem(
        "CONTRACT_TEXT_TOO_LONG",
        "candidate.claim",
        `claim exceeds the ${MEMORY_MAX_CLAIM_CODE_POINTS} code-point limit.`,
        { limit: MEMORY_MAX_CLAIM_CODE_POINTS },
      ),
    );
  }

  if (!isOneOf(record.source, MEMORY_SOURCES)) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "candidate.source",
        `source must be one of: ${MEMORY_SOURCES.join(" | ")}.`,
      ),
    );
  }

  validateTimestamp(record.observedAt, "candidate.observedAt", problems);
  if (record.expiresAt !== undefined && record.expiresAt !== null) {
    validateTimestamp(record.expiresAt, "candidate.expiresAt", problems);
  }
  if (record.reviewAt !== undefined && record.reviewAt !== null) {
    validateTimestamp(record.reviewAt, "candidate.reviewAt", problems);
  }

  if (!isOneOf(record.sensitivity, MEMORY_SENSITIVITIES)) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "candidate.sensitivity",
        `sensitivity must be one of: ${MEMORY_SENSITIVITIES.join(" | ")}.`,
      ),
    );
  }

  for (const key of Object.keys(record)) {
    if (
      !["schemaVersion", "subjectRef", "type", "claim", "source", "observedAt", "expiresAt", "reviewAt", "sensitivity"].includes(key)
    ) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          `candidate.${key}`,
          "memory candidate carries an unknown field (supersession goes through the correction path, not intake).",
        ),
      );
    }
  }

  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return Object.freeze({
    schemaVersion: record.schemaVersion as MemorySchemaVersion,
    subjectRef: record.subjectRef as string,
    type: record.type as MemoryType,
    claim: (record.claim as string).trim(),
    source: record.source as MemorySource,
    observedAt: record.observedAt as string,
    expiresAt: (record.expiresAt ?? null) as string | null,
    reviewAt: (record.reviewAt ?? null) as string | null,
    sensitivity: record.sensitivity as MemorySensitivity,
  });
}

// ---------------------------------------------------------------------------
// Deterministic label screen (issue #26 AC 2: 自动记心理标签拒绝)
// ---------------------------------------------------------------------------

/**
 * Deterministic deny-list used to screen AGENT-PROPOSED candidates for
 * clinical/psychological/personality label vocabulary (PRD §7.2 rule 6:
 * 禁止凭单轮聊天进行临床诊断、人格定性、永久能力打分). Matching is plain
 * substring comparison on the lowercased claim — no NLP, no guessing.
 *
 * Boundary (documented in ADR-0004): the screen exists to block AUTOMATED
 * label generation via the agent proposal path. Explicit human inputs
 * (child statements / guardian input) are auditable human confirmations and
 * are not text-screened; the type allowlist still applies to everyone.
 */
export const MEMORY_LABEL_SCREEN_TERMS: readonly string[] = Object.freeze([
  "多动症",
  "adhd",
  "自闭",
  "孤独症",
  "抑郁",
  "焦虑症",
  "人格",
  "智商",
  "iq",
  "智力测试",
  "智力分数",
  "心理诊断",
  "心理疾病",
  "精神疾病",
  "能力评分",
  "能力分数",
  "personality",
  "diagnosis",
  "psychological profile",
]);

/** True when the claim carries psychological-label vocabulary. */
export function claimCarriesPsychologicalLabel(claim: string): boolean {
  const haystack = claim.toLowerCase();
  return MEMORY_LABEL_SCREEN_TERMS.some((term) => haystack.includes(term));
}

// ---------------------------------------------------------------------------
// Claim normalization (dedupe / conflict / unchanged detection)
// ---------------------------------------------------------------------------

/**
 * Deterministic v0 claim normalization for dedupe and conflict decisions:
 * Unicode NFC + trimmed + whitespace runs collapsed + lowercased. Two
 * claims normalize equal exactly when they are the same fact for the
 * purpose of `memory.duplicate` / `memory.conflict` / `memory.claim_unchanged`.
 */
export function normalizeClaim(claim: string): string {
  return claim.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Dedupe key of one memory fact (subject + type + normalized claim). */
export function memoryFactKey(subjectRef: string, type: MemoryType, claim: string): string {
  return `${subjectRef}\u0000${type}\u0000${normalizeClaim(claim)}`;
}

// ---------------------------------------------------------------------------
// Audit facts (structural only — no claim text, no child text)
// ---------------------------------------------------------------------------

export const MEMORY_AUDIT_ACTIONS = Object.freeze([
  "memory.propose",
  "memory.confirm",
  "memory.correct",
  "memory.delete",
  "memory.expire_cleanup",
] as const);
export type MemoryAuditAction = (typeof MEMORY_AUDIT_ACTIONS)[number];

/**
 * One structural audit fact. `ruleIds` carries rejection code vocabularies
 * (memory.* / contract problem codes) and `count` is used by cleanup
 * actions. Claim text and child text can never appear: the shape has no
 * field for them (enforced by a schema test).
 */
export interface MemoryAuditEntry {
  readonly seq: number;
  readonly at: string;
  readonly action: MemoryAuditAction;
  readonly actorRole: ActorRole | null;
  readonly subjectRef: string | null;
  readonly memoryId: string | null;
  readonly outcome: "ok" | "rejected" | "purged";
  readonly ruleIds: readonly string[];
  readonly count: number | null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Validate a stored/derived ActorRole value. */
export function isActorRole(value: unknown): value is ActorRole {
  return typeof value === "string" && (ACTOR_ROLES as readonly string[]).includes(value);
}

/**
 * Admit a fully constructed memory entry through the guarded domain intake
 * (legacy-shape scan + deep freeze). Internal to the memory service; the
 * entry shape is produced only from validated parts.
 */
export function admitMemoryEntry(entry: MemoryEntry): Readonly<MemoryEntry> {
  return ingestDomainFact(entry) as Readonly<MemoryEntry>;
}

const MEMORY_ENTRY_FIELDS = Object.freeze([
  // Candidate half (validated through parseMemoryCandidateInput).
  "schemaVersion",
  "subjectRef",
  "type",
  "claim",
  "source",
  "observedAt",
  "expiresAt",
  "reviewAt",
  "sensitivity",
  // Entry-only fields.
  "memoryId",
  "supersedes",
  "status",
  "proposedByRole",
  "createdAt",
  "confirmedAt",
  "confirmedByRole",
  "supersededAt",
  "revision",
]);

/**
 * R1-08 (issue #20): parse + re-validate one FULL stored memory entry for
 * the encrypted-snapshot restore path. Fail-closed: unknown fields,
 * unregistered enums, malformed ids/timestamps and status-inconsistent
 * confirmation facts are all rejected. This is the restore-side twin of the
 * service's own construction paths — a snapshot cannot inject an entry
 * shape the live service could never have produced.
 */
export function parseMemoryEntry(value: unknown): Readonly<MemoryEntry> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "entry", "memory entry must be an object."),
    ]);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!MEMORY_ENTRY_FIELDS.includes(key)) {
      throw new ContractValidationError([
        problem("CONTRACT_FIELD_INVALID", `entry.${key}`, "memory entry carries an unknown field."),
      ]);
    }
  }
  for (const field of ["schemaVersion", "subjectRef", "type", "claim", "source", "observedAt", "expiresAt", "reviewAt", "sensitivity"]) {
    if (!(field in record)) {
      throw new ContractValidationError([
        problem("CONTRACT_FIELD_MISSING", `entry.${field}`, "memory entry is missing a required candidate field."),
      ]);
    }
  }
  // The candidate half is validated by the exact intake parser (bounded
  // claim, registered type/source/sensitivity, timestamp grammars).
  parseMemoryCandidateInput({
    schemaVersion: record.schemaVersion,
    subjectRef: record.subjectRef,
    type: record.type,
    claim: record.claim,
    source: record.source,
    observedAt: record.observedAt,
    expiresAt: record.expiresAt,
    reviewAt: record.reviewAt,
    sensitivity: record.sensitivity,
  });

  const problems: ContractProblem[] = [];
  if (typeof record.memoryId !== "string" || !MEMORY_ID_PATTERN.test(record.memoryId)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "entry.memoryId", "memoryId must match the memory id grammar."));
  }
  if (record.supersedes !== null && (typeof record.supersedes !== "string" || !MEMORY_ID_PATTERN.test(record.supersedes))) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "entry.supersedes", "supersedes must be null or a memory id."));
  }
  if (!isOneOf(record.status, MEMORY_STATUSES)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "entry.status", `status must be one of: ${MEMORY_STATUSES.join(" | ")}.`),
    );
  }
  if (!isActorRole(record.proposedByRole)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "entry.proposedByRole", "proposedByRole must be a registered actor role."));
  }
  validateTimestamp(record.createdAt, "entry.createdAt", problems);
  if (record.confirmedAt !== null && record.confirmedAt !== undefined) {
    validateTimestamp(record.confirmedAt, "entry.confirmedAt", problems);
  }
  if (record.confirmedByRole !== null && record.confirmedByRole !== undefined && !isActorRole(record.confirmedByRole)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "entry.confirmedByRole", "confirmedByRole must be null or a registered actor role."));
  }
  if (record.supersededAt !== null && record.supersededAt !== undefined) {
    validateTimestamp(record.supersededAt, "entry.supersededAt", problems);
  }
  if (record.revision !== 1) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "entry.revision", "revision must be 1."));
  }
  // Status consistency (the shapes the service itself can produce).
  if (record.status === "confirmed" || record.status === "superseded") {
    if (record.confirmedAt === null || record.confirmedAt === undefined || record.confirmedByRole === null || record.confirmedByRole === undefined) {
      problems.push(problem("CONTRACT_FIELD_INVALID", "entry.confirmedAt", "a confirmed/superseded entry must carry its confirmation facts."));
    }
  }
  if (record.status === "candidate" || record.status === "expired") {
    if (record.confirmedAt !== null && record.confirmedAt !== undefined) {
      problems.push(problem("CONTRACT_FIELD_INVALID", "entry.confirmedAt", "a candidate/expired entry must not carry confirmation facts."));
    }
  }
  if (record.status === "superseded" && (record.supersededAt === null || record.supersededAt === undefined)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "entry.supersededAt", "a superseded entry must carry supersededAt."));
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return ingestDomainFact({
    schemaVersion: record.schemaVersion,
    subjectRef: record.subjectRef,
    type: record.type,
    claim: record.claim,
    source: record.source,
    observedAt: record.observedAt,
    expiresAt: record.expiresAt ?? null,
    reviewAt: record.reviewAt ?? null,
    sensitivity: record.sensitivity,
    memoryId: record.memoryId,
    supersedes: record.supersedes ?? null,
    status: record.status,
    proposedByRole: record.proposedByRole,
    createdAt: record.createdAt,
    confirmedAt: record.confirmedAt ?? null,
    confirmedByRole: record.confirmedByRole ?? null,
    supersededAt: record.supersededAt ?? null,
    revision: 1,
  }) as Readonly<MemoryEntry>;
}
