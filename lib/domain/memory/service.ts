/**
 * R1-14 Child Memory v0 — the trusted memory service (issue #26; PRD §7.2;
 * Roadmap R1-14; FR-008).
 *
 * The minimal closed loop: candidate → confirm → write → context-relevant
 * retrieval → child correction (supersede) → permanent delete, with ALL
 * writes authorized server-side and audited (issue #26 交付范围 3):
 *
 * - INTAKE (`proposeCandidate`): creates a CANDIDATE only. Roles: the
 *   trusted system runtime (the `memory.propose` tool path — proposals are
 *   candidate-only by registry contract), the subject child and the family
 *   guardian; voice_device never. Every rejection path (invalid actor,
 *   wrong subject, non-allowlist type, label screen, duplicate, malformed
 *   shape) stores NOTHING — failure paths never silently write candidates
 *   (AC 3).
 * - CONFIRMATION (`confirmCandidate`): the explicit human moment. Only the
 *   subject child or a family guardian may confirm; the system role can
 *   propose but NEVER self-confirm. Duplicates and active conflicts are
 *   rejected (the correction path owns changes); expired candidates are
 *   rejected.
 * - CORRECTION (`correctMemory`): replaces a confirmed fact — a new entry
 *   is created with `supersedes`, the old one is marked superseded and is
 *   permanently excluded from retrieval (no replay / checkpoint re-injection
 *   of corrected claims).
 * - DELETION (`deleteMemory`): HARD removal of the entry plus its whole
 *   `supersedes` lineage (ancestors and descendants). Retrieval returns 0
 *   afterwards; only the structural audit fact remains. Cross-store
 *   deletion propagation (DSH session logs, checkpoints, backups) is
 *   R1-09's data-lifecycle scope and is NOT silently absorbed here.
 * - RETRIEVAL (`retrieveForContext`): minimal-by-need — confirmed entries
 *   of the subject only, excluding expired and review-due entries,
 *   sensitive entries only for explicitly authorized views, newest-first
 *   with a hard cap; ids + versions only.
 * - AUDIT: a bounded structural ring SEPARATE from the runtime/DSH trace
 *   (AC 3: DSH 暂存会话与 Memory DB 分开审计、清理), with an explicit
 *   purge operation. No claim text, no child text — ever.
 *
 * ROLE MATRIX (v0, single family):
 * | operation         | child            | guardian | system          | voice_device |
 * | proposeCandidate  | own subject only | yes      | yes (tool path) | no           |
 * | confirmCandidate  | own subject only | yes      | no (no self-confirm) | no      |
 * | correctMemory     | own subject only | yes      | no              | no           |
 * | deleteMemory      | own subject only | yes      | no              | no           |
 * | retrieveForContext| own subject only | yes      | yes             | no           |
 * | listEntries       | no               | yes      | yes             | no           |
 * | expirePastCandidates | no            | yes      | yes             | no           |
 *
 * LEGACY ISOLATION: no entry shape has score fields, so the old prisma
 * CognitiveProfile quantified scores cannot be inherited by the active
 * model (enforced by the legacy intake guard + schema tests).
 *
 * STATE BOUNDARY: the store is in-memory and process-local (single-process
 * web MVP, same disclosed discipline as #17/#18). Memories are keyed by
 * SUBJECT (childRef), never by session, so confirmed facts are visible
 * across sessions within the process lifetime. Durable persistence across
 * process restarts stays deferred to the TECH_STACK §3 data-modeling
 * decision — the prisma schema remains untouched (zero-diff), disclosed in
 * the PR and ADR-0004.
 *
 * This module must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { parseActorContext, type ActorContext } from "../contract/actor.ts";
import { ContractValidationError, isValidContractId, problem, type ContractProblem } from "../contract/core.ts";
import {
  admitMemoryEntry,
  MAX_MEMORY_AUDIT_ENTRIES,
  MAX_RETRIEVAL_REFS,
  MEMORY_ID_PATTERN,
  MEMORY_SCHEMA_VERSION,
  claimCarriesPsychologicalLabel,
  memoryFactKey,
  parseMemoryCandidateInput,
  parseMemoryEntry,
  type MemoryAuditAction,
  type MemoryAuditEntry,
  type MemoryEntry,
  type MemoryRejectionCode,
} from "./schema.ts";

/** R1-08: hard bound of one encrypted-snapshot memory restore batch. */
const MAX_RESTORE_ENTRIES = 1000;

/**
 * R1-08: pure validation of one snapshot memory-restore batch (no commit).
 * Used by restoreEntries AND the composition root's all-or-nothing
 * pre-validation pass. Fails closed on unknown fields, duplicate ids and
 * incomplete supersedes lineages.
 */
export function validateMemoryRestoreEntries(rawEntries: unknown): readonly Readonly<MemoryEntry>[] {
  if (!Array.isArray(rawEntries)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "entries", "restored memory entries must be an array."),
    ]);
  }
  if (rawEntries.length > MAX_RESTORE_ENTRIES) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "entries", `restored memory entries exceed the ${MAX_RESTORE_ENTRIES}-entry bound.`),
    ]);
  }
  const prepared = rawEntries.map((raw) => parseMemoryEntry(raw));
  const seen = new Set<string>();
  for (const entry of prepared) {
    if (seen.has(entry.memoryId)) {
      throw new ContractValidationError([
        problem("CONTRACT_FIELD_INVALID", "entries", "restored memory ids must be unique."),
      ]);
    }
    seen.add(entry.memoryId);
  }
  for (const entry of prepared) {
    if (entry.supersedes !== null && !seen.has(entry.supersedes)) {
      throw new ContractValidationError([
        problem(
          "CONTRACT_FIELD_INVALID",
          "entries",
          "restored supersedes lineage must be complete: every predecessor must be part of the same batch.",
        ),
      ]);
    }
  }
  return Object.freeze(prepared);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MemoryWriteResult =
  | { readonly ok: true; readonly entry: Readonly<MemoryEntry> }
  | {
      readonly ok: false;
      readonly code: MemoryRejectionCode;
      /** Structured rule ids (memory.* codes / contract problem codes). */
      readonly ruleIds: readonly string[];
    };

export type MemoryDeleteResult =
  | { readonly ok: true; readonly purgedIds: readonly string[] }
  | {
      readonly ok: false;
      readonly code: MemoryRejectionCode;
      readonly ruleIds: readonly string[];
    };

export type MemoryRetrievalResult =
  | {
      readonly ok: true;
      /** Context refs (ids + versions only), newest-first, capped. */
      readonly refs: readonly { readonly kind: "memory"; readonly refId: string; readonly version: string }[];
    }
  | {
      readonly ok: false;
      readonly code: MemoryRejectionCode;
      readonly ruleIds: readonly string[];
    };

export interface MemoryServiceOptions {
  /** ISO-8601 UTC timestamp factory (contract grammar). */
  readonly nowFactory?: () => string;
  /** `mem_` id factory (overridable for deterministic tests). */
  readonly idFactory?: () => string;
  /** Audit ring capacity (default MAX_MEMORY_AUDIT_ENTRIES). */
  readonly auditCapacity?: number;
}

export interface MemoryService {
  /** Intake: create a CANDIDATE (never a persisted fact). */
  proposeCandidate(input: unknown, actor: unknown): MemoryWriteResult;
  /** Explicit human confirmation of one candidate. */
  confirmCandidate(input: unknown, actor: unknown): MemoryWriteResult;
  /** Correct a confirmed fact (supersede old version with a new entry). */
  correctMemory(input: unknown, actor: unknown): MemoryWriteResult;
  /** Hard-delete one entry and its whole supersedes lineage. */
  deleteMemory(input: unknown, actor: unknown): MemoryDeleteResult;
  /** Minimal-by-need retrieval of context refs for one subject. */
  retrieveForContext(
    input: { readonly subjectRef: unknown; readonly includeSensitive?: unknown },
    actor: unknown,
  ): MemoryRetrievalResult;
  /** Full entry list of one subject (guardian/system audit views). */
  listEntries(subjectRef: unknown, actor: unknown): readonly Readonly<MemoryEntry>[];
  /** Cleanup: transition past-expiry candidates to expired; returns count. */
  expirePastCandidates(actor: unknown): number;
  /** Snapshot of the structural audit ring (oldest first). */
  auditSnapshot(): readonly Readonly<MemoryAuditEntry>[];
  /** Cleanup: clear the audit ring (separate from any data deletion). */
  purgeAudit(): void;
  /**
   * R1-08 (issue #20) encrypted-snapshot restore port: re-materialize
   * validated full entries (candidate/confirmed/superseded/expired) into the
   * store. Called ONCE at composition by the server runtime — never from an
   * HTTP path. Every entry is re-validated through the schema's full-entry
   * parser; duplicate ids and incomplete supersedes lineages fail closed.
   */
  restoreEntries(rawEntries: unknown): { readonly restored: number };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function defaultMemoryIdFactory(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `mem_${Date.now().toString(36)}${random}`.slice(0, 68);
}

/** Validate a `{memoryId}` style single-id input shape. */
function parseMemoryIdInput(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "memoryId" || typeof record.memoryId !== "string") {
    return null;
  }
  return MEMORY_ID_PATTERN.test(record.memoryId) ? (record.memoryId as string) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejection(
  code: MemoryRejectionCode,
  ruleIds: readonly string[] = [],
): { ok: false; code: MemoryRejectionCode; ruleIds: readonly string[] } {
  return { ok: false, code, ruleIds: Object.freeze([...ruleIds]) };
}

/** Rule ids from a failed contract parse (structural problem codes only). */
function parseFailureRuleIds(error: unknown): readonly string[] {
  const problems = (error as { problems?: readonly ContractProblem[] } | null)?.problems;
  if (!Array.isArray(problems)) {
    return ["memory.parse_failed"];
  }
  return problems.map((entry) => entry.code);
}

function isExpiredAt(expiresAt: string | null, nowIso: string): boolean {
  return expiresAt !== null && Date.parse(expiresAt) < Date.parse(nowIso);
}

function isReviewDue(reviewAt: string | null, nowIso: string): boolean {
  return reviewAt !== null && Date.parse(reviewAt) < Date.parse(nowIso);
}

/**
 * Create the memory service. One instance owns one process-local store and
 * one audit ring (AC 3: the memory DB and the DSH session/trace audit are
 * separate structures with separate lifecycles).
 */
export function createMemoryService(options: MemoryServiceOptions = {}): MemoryService {
  const nowFactory = options.nowFactory ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? defaultMemoryIdFactory;
  const auditCapacity = Math.max(1, Math.min(options.auditCapacity ?? MAX_MEMORY_AUDIT_ENTRIES, 10_000));

  /** memoryId → entry (process-local; facts are keyed by subject). */
  const store = new Map<string, Readonly<MemoryEntry>>();
  const audit: MemoryAuditEntry[] = [];
  let auditSeq = 0;

  function pushAudit(entry: {
    readonly action: MemoryAuditAction;
    readonly actorRole: string | null;
    readonly subjectRef: string | null;
    readonly memoryId: string | null;
    readonly outcome: MemoryAuditEntry["outcome"];
    readonly ruleIds?: readonly string[];
    readonly count?: number | null;
  }): void {
    auditSeq += 1;
    audit.push({
      seq: auditSeq,
      at: nowFactory(),
      action: entry.action,
      actorRole: (entry.actorRole ?? null) as MemoryAuditEntry["actorRole"],
      // subjectRef/memoryId are recorded only from GRAMMAR-VALIDATED values;
      // unvalidated submission content is never echoed into the audit.
      subjectRef: entry.subjectRef,
      memoryId: entry.memoryId,
      outcome: entry.outcome,
      ruleIds: Object.freeze([...(entry.ruleIds ?? [])]),
      count: entry.count ?? null,
    });
    if (audit.length > auditCapacity) {
      audit.shift();
    }
  }

  /**
   * Resolve the server-verified actor. Returns null when the actor shape is
   * invalid — identity can never be trusted into an operation.
   */
  function resolveActor(actor: unknown): Readonly<ActorContext> | null {
    try {
      return parseActorContext(actor);
    } catch {
      return null;
    }
  }

  /**
   * Write-path subject binding: a child acts only on own-subject memories;
   * voice_device never acts. guardian/system operate on the family subject.
   */
  function subjectBindingError(actor: Readonly<ActorContext>, subjectRef: string): MemoryRejectionCode | null {
    if (actor.role === "voice_device") {
      return "memory.unauthorized";
    }
    if (actor.role === "child" && actor.childRef !== subjectRef) {
      return "memory.subject_mismatch";
    }
    return null;
  }

  function hasActiveFactKey(key: string, exceptMemoryId: string | null = null): boolean {
    for (const entry of store.values()) {
      if (entry.memoryId === exceptMemoryId) {
        continue;
      }
      if (entry.status !== "candidate" && entry.status !== "confirmed") {
        continue;
      }
      if (memoryFactKey(entry.subjectRef, entry.type, entry.claim) === key) {
        return true;
      }
    }
    return false;
  }

  /** True when ANOTHER confirmed fact of the same subject+type exists. */
  function hasActiveConfirmedConflict(
    subjectRef: string,
    type: MemoryEntry["type"],
    claim: string,
  ): boolean {
    const key = memoryFactKey(subjectRef, type, claim);
    for (const entry of store.values()) {
      if (
        entry.status === "confirmed" &&
        entry.subjectRef === subjectRef &&
        entry.type === type &&
        memoryFactKey(entry.subjectRef, entry.type, entry.claim) !== key
      ) {
        return true;
      }
    }
    return false;
  }

  /** Collect the full supersedes lineage (ancestors + descendants). */
  function lineageOf(memoryId: string): Set<string> {
    const lineage = new Set<string>([memoryId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const entry of store.values()) {
        if (lineage.has(entry.memoryId)) {
          continue;
        }
        const memberSupersedes = [...lineage]
          .map((id) => store.get(id)?.supersedes ?? null)
          .filter((value): value is string => value !== null);
        if (
          (entry.supersedes !== null && lineage.has(entry.supersedes)) ||
          memberSupersedes.includes(entry.memoryId)
        ) {
          lineage.add(entry.memoryId);
          grew = true;
        }
      }
    }
    return lineage;
  }

  return Object.freeze({
    proposeCandidate(rawInput: unknown, rawActor: unknown): MemoryWriteResult {
      const now = nowFactory();
      const actor = resolveActor(rawActor);
      if (actor === null) {
        pushAudit({
          action: "memory.propose",
          actorRole: null,
          subjectRef: null,
          memoryId: null,
          outcome: "rejected",
          ruleIds: ["memory.unauthorized"],
        });
        return rejection("memory.unauthorized", ["memory.unauthorized"]);
      }
      const fail = (code: MemoryRejectionCode, ruleIds: readonly string[]): MemoryWriteResult => {
        // Rejected intakes never contribute audit payload facts: the
        // submission is unvalidated, so only the structured rule ids land.
        pushAudit({
          action: "memory.propose",
          actorRole: actor.role,
          subjectRef: null,
          memoryId: null,
          outcome: "rejected",
          ruleIds,
        });
        return rejection(code, ruleIds);
      };

      // Explicit pre-parse type check keeps the psychological-label attempt
      // a DISTINGUISHED rejection (issue #26 AC 2) instead of a generic
      // parse failure.
      if (
        isRecord(rawInput) &&
        rawInput.type !== undefined &&
        rawInput.type !== "confirmed_preference" &&
        rawInput.type !== "necessary_fact"
      ) {
        return fail("memory.type_not_allowed", ["memory.type_not_allowed"]);
      }

      let input: ReturnType<typeof parseMemoryCandidateInput>;
      try {
        input = parseMemoryCandidateInput(rawInput);
      } catch (error) {
        return fail("memory.parse_failed", parseFailureRuleIds(error));
      }

      const roleError = subjectBindingError(actor, input.subjectRef);
      if (roleError !== null) {
        return fail(roleError, [roleError]);
      }

      // The label screen guards the AUTOMATED path only (see schema docs):
      // agent proposals carrying clinical/personality label vocabulary are
      // rejected and never even become candidates.
      if (input.source === "agent_proposal" && claimCarriesPsychologicalLabel(input.claim)) {
        return fail("memory.label_screen_block", ["memory.label_screen_block"]);
      }

      if (hasActiveFactKey(memoryFactKey(input.subjectRef, input.type, input.claim))) {
        return fail("memory.duplicate", ["memory.duplicate"]);
      }

      const memoryId = idFactory();
      const entry = admitMemoryEntry({
        ...input,
        memoryId,
        supersedes: null,
        status: "candidate",
        proposedByRole: actor.role,
        createdAt: now,
        confirmedAt: null,
        confirmedByRole: null,
        supersededAt: null,
        revision: 1,
      });
      store.set(memoryId, entry);
      pushAudit({
        action: "memory.propose",
        actorRole: actor.role,
        subjectRef: input.subjectRef,
        memoryId,
        outcome: "ok",
      });
      return { ok: true, entry };
    },

    confirmCandidate(rawInput: unknown, rawActor: unknown): MemoryWriteResult {
      const now = nowFactory();
      const actor = resolveActor(rawActor);
      if (actor === null) {
        pushAudit({
          action: "memory.confirm",
          actorRole: null,
          subjectRef: null,
          memoryId: null,
          outcome: "rejected",
          ruleIds: ["memory.unauthorized"],
        });
        return rejection("memory.unauthorized", ["memory.unauthorized"]);
      }
      const memoryId = parseMemoryIdInput(rawInput);
      const fail = (code: MemoryRejectionCode, ruleIds: readonly string[]): MemoryWriteResult => {
        pushAudit({
          action: "memory.confirm",
          actorRole: actor.role,
          subjectRef: memoryId !== null ? (store.get(memoryId)?.subjectRef ?? null) : null,
          memoryId,
          outcome: "rejected",
          ruleIds,
        });
        return rejection(code, ruleIds);
      };

      // Confirmation is the explicit HUMAN moment: child or guardian only.
      // The system role can propose but can never self-confirm.
      if (actor.role !== "child" && actor.role !== "guardian") {
        return fail("memory.unauthorized", ["memory.unauthorized"]);
      }
      if (memoryId === null) {
        return fail("memory.parse_failed", ["memory.parse_failed"]);
      }
      const candidate = store.get(memoryId);
      if (candidate === undefined) {
        return fail("memory.not_found", ["memory.not_found"]);
      }
      const roleError = subjectBindingError(actor, candidate.subjectRef);
      if (roleError !== null) {
        return fail(roleError, [roleError]);
      }
      if (candidate.status !== "candidate") {
        return fail("memory.wrong_state", ["memory.wrong_state"]);
      }
      if (isExpiredAt(candidate.expiresAt, now)) {
        return fail("memory.expired", ["memory.expired"]);
      }
      if (hasActiveFactKey(memoryFactKey(candidate.subjectRef, candidate.type, candidate.claim), memoryId)) {
        return fail("memory.duplicate", ["memory.duplicate"]);
      }
      if (hasActiveConfirmedConflict(candidate.subjectRef, candidate.type, candidate.claim)) {
        return fail("memory.conflict", ["memory.conflict"]);
      }

      const confirmed = admitMemoryEntry({
        ...candidate,
        status: "confirmed",
        confirmedAt: now,
        confirmedByRole: actor.role,
      });
      store.set(memoryId, confirmed);
      pushAudit({
        action: "memory.confirm",
        actorRole: actor.role,
        subjectRef: confirmed.subjectRef,
        memoryId,
        outcome: "ok",
      });
      return { ok: true, entry: confirmed };
    },

    correctMemory(rawInput: unknown, rawActor: unknown): MemoryWriteResult {
      const now = nowFactory();
      const actor = resolveActor(rawActor);
      if (actor === null) {
        pushAudit({
          action: "memory.correct",
          actorRole: null,
          subjectRef: null,
          memoryId: null,
          outcome: "rejected",
          ruleIds: ["memory.unauthorized"],
        });
        return rejection("memory.unauthorized", ["memory.unauthorized"]);
      }
      const fail = (code: MemoryRejectionCode, ruleIds: readonly string[]): MemoryWriteResult => {
        pushAudit({
          action: "memory.correct",
          actorRole: actor.role,
          subjectRef: null,
          memoryId: null,
          outcome: "rejected",
          ruleIds,
        });
        return rejection(code, ruleIds);
      };

      if (actor.role !== "child" && actor.role !== "guardian") {
        return fail("memory.unauthorized", ["memory.unauthorized"]);
      }
      if (
        !isRecord(rawInput) ||
        Object.keys(rawInput).some((key) => key !== "memoryId" && key !== "claim")
      ) {
        return fail("memory.parse_failed", ["memory.parse_failed"]);
      }
      const memoryId = parseMemoryIdInput({ memoryId: rawInput.memoryId });
      if (
        memoryId === null ||
        typeof rawInput.claim !== "string" ||
        rawInput.claim.trim().length === 0
      ) {
        return fail("memory.parse_failed", ["memory.parse_failed"]);
      }
      const newClaim = rawInput.claim.trim();
      if ([...newClaim].length > 280) {
        return fail("memory.parse_failed", ["CONTRACT_TEXT_TOO_LONG"]);
      }
      const target = store.get(memoryId);
      if (target === undefined) {
        return fail("memory.not_found", ["memory.not_found"]);
      }
      const roleError = subjectBindingError(actor, target.subjectRef);
      if (roleError !== null) {
        return fail(roleError, [roleError]);
      }
      if (target.status !== "confirmed") {
        return fail("memory.wrong_state", ["memory.wrong_state"]);
      }
      if (memoryFactKey(target.subjectRef, target.type, newClaim) === memoryFactKey(target.subjectRef, target.type, target.claim)) {
        return fail("memory.claim_unchanged", ["memory.claim_unchanged"]);
      }
      if (hasActiveFactKey(memoryFactKey(target.subjectRef, target.type, newClaim), memoryId)) {
        return fail("memory.duplicate", ["memory.duplicate"]);
      }

      // ATOMICITY (carried #26 review P2-1, fixed in R1-09): BOTH entries are
      // admitted through the guarded intake BEFORE either store mutation, so
      // a throw in the intake can never leave a superseded fact orphaned
      // without its correction — the two Map writes that follow cannot fail.
      const superseded = admitMemoryEntry({ ...target, status: "superseded", supersededAt: now });
      const correction = admitMemoryEntry({
        schemaVersion: MEMORY_SCHEMA_VERSION,
        subjectRef: target.subjectRef,
        type: target.type,
        claim: newClaim,
        // Provenance reflects WHO corrected: an explicit human statement.
        source: actor.role === "child" ? "child_statement" : "guardian_input",
        observedAt: now,
        expiresAt: target.expiresAt,
        reviewAt: target.reviewAt,
        sensitivity: target.sensitivity,
        memoryId: idFactory(),
        supersedes: memoryId,
        status: "confirmed",
        proposedByRole: actor.role,
        createdAt: now,
        confirmedAt: now,
        confirmedByRole: actor.role,
        supersededAt: null,
        revision: 1,
      });
      store.set(memoryId, superseded);
      store.set(correction.memoryId, correction);
      pushAudit({
        action: "memory.correct",
        actorRole: actor.role,
        subjectRef: correction.subjectRef,
        memoryId: correction.memoryId,
        outcome: "ok",
      });
      return { ok: true, entry: correction };
    },

    deleteMemory(rawInput: unknown, rawActor: unknown): MemoryDeleteResult {
      const actor = resolveActor(rawActor);
      if (actor === null) {
        pushAudit({
          action: "memory.delete",
          actorRole: null,
          subjectRef: null,
          memoryId: null,
          outcome: "rejected",
          ruleIds: ["memory.unauthorized"],
        });
        return rejection("memory.unauthorized", ["memory.unauthorized"]);
      }
      const memoryId = parseMemoryIdInput(rawInput);
      const fail = (code: MemoryRejectionCode, ruleIds: readonly string[]): MemoryDeleteResult => {
        pushAudit({
          action: "memory.delete",
          actorRole: actor.role,
          subjectRef: memoryId !== null ? (store.get(memoryId)?.subjectRef ?? null) : null,
          memoryId,
          outcome: "rejected",
          ruleIds,
        });
        return rejection(code, ruleIds);
      };

      if (actor.role !== "child" && actor.role !== "guardian") {
        return fail("memory.unauthorized", ["memory.unauthorized"]);
      }
      if (memoryId === null) {
        return fail("memory.parse_failed", ["memory.parse_failed"]);
      }
      const target = store.get(memoryId);
      if (target === undefined) {
        return fail("memory.not_found", ["memory.not_found"]);
      }
      const roleError = subjectBindingError(actor, target.subjectRef);
      if (roleError !== null) {
        return fail(roleError, [roleError]);
      }

      const lineage = lineageOf(memoryId);
      for (const id of lineage) {
        store.delete(id);
      }
      pushAudit({
        action: "memory.delete",
        actorRole: actor.role,
        subjectRef: target.subjectRef,
        memoryId,
        outcome: "purged",
        count: lineage.size,
      });
      return { ok: true, purgedIds: Object.freeze([...lineage].sort()) };
    },

    retrieveForContext(
      input: { readonly subjectRef: unknown; readonly includeSensitive?: unknown },
      rawActor: unknown,
    ): MemoryRetrievalResult {
      const now = nowFactory();
      const actor = resolveActor(rawActor);
      if (actor === null) {
        return rejection("memory.unauthorized", ["memory.unauthorized"]);
      }
      if (actor.role === "voice_device") {
        return rejection("memory.unauthorized", ["memory.unauthorized"]);
      }
      if (!isRecord(input) || !isValidContractId("childRef", input.subjectRef)) {
        return rejection("memory.parse_failed", ["memory.parse_failed"]);
      }
      const subjectRef = input.subjectRef as string;
      if (actor.role === "child" && actor.childRef !== subjectRef) {
        return rejection("memory.subject_mismatch", ["memory.subject_mismatch"]);
      }
      const includeSensitive = input.includeSensitive === true;
      if (includeSensitive && actor.role === "child") {
        // A child context never carries sensitive entries (minimization).
        return rejection("memory.unauthorized", ["memory.unauthorized"]);
      }

      const refs: { kind: "memory"; refId: string; version: string }[] = [];
      const entries = [...store.values()]
        .filter(
          (entry) =>
            entry.status === "confirmed" &&
            entry.subjectRef === subjectRef &&
            !isExpiredAt(entry.expiresAt, now) &&
            !isReviewDue(entry.reviewAt, now),
        )
        .sort((a, b) => {
          const byTime = Date.parse(b.confirmedAt ?? "") - Date.parse(a.confirmedAt ?? "");
          if (byTime !== 0) {
            return byTime;
          }
          return a.memoryId < b.memoryId ? 1 : a.memoryId > b.memoryId ? -1 : 0;
        });
      for (const entry of entries) {
        if (refs.length >= MAX_RETRIEVAL_REFS) {
          break;
        }
        if (entry.sensitivity === "sensitive" && !includeSensitive) {
          continue;
        }
        refs.push({ kind: "memory", refId: entry.memoryId, version: String(entry.revision) });
      }
      return { ok: true, refs: Object.freeze(refs) };
    },

    listEntries(subjectRef: unknown, rawActor: unknown): readonly Readonly<MemoryEntry>[] {
      const actor = resolveActor(rawActor);
      if (actor === null || (actor.role !== "guardian" && actor.role !== "system")) {
        return Object.freeze([]);
      }
      if (!isValidContractId("childRef", subjectRef)) {
        return Object.freeze([]);
      }
      return Object.freeze([...store.values()].filter((entry) => entry.subjectRef === subjectRef));
    },

    expirePastCandidates(rawActor: unknown): number {
      const now = nowFactory();
      const actor = resolveActor(rawActor);
      if (actor === null || (actor.role !== "guardian" && actor.role !== "system")) {
        // Observable rejection (carried #26 review P2-4, fixed in R1-09):
        // an unauthorized cleanup attempt lands as a rejected audit fact —
        // cleanup denial is part of the data-lifecycle audit surface, and
        // the attempt is no longer silently unobservable.
        pushAudit({
          action: "memory.expire_cleanup",
          actorRole: actor?.role ?? null,
          subjectRef: null,
          memoryId: null,
          outcome: "rejected",
          ruleIds: ["memory.unauthorized"],
        });
        return 0;
      }
      let count = 0;
      for (const entry of store.values()) {
        if (entry.status === "candidate" && isExpiredAt(entry.expiresAt, now)) {
          store.set(entry.memoryId, admitMemoryEntry({ ...entry, status: "expired" }));
          count += 1;
        }
      }
      if (count > 0) {
        pushAudit({
          action: "memory.expire_cleanup",
          actorRole: actor.role,
          subjectRef: null,
          memoryId: null,
          outcome: "ok",
          count,
        });
      }
      return count;
    },

    auditSnapshot(): readonly Readonly<MemoryAuditEntry>[] {
      return Object.freeze([...audit]);
    },

    purgeAudit(): void {
      audit.length = 0;
    },

    restoreEntries(rawEntries: unknown): { readonly restored: number } {
      const prepared = validateMemoryRestoreEntries(rawEntries);
      for (const entry of prepared) {
        store.set(entry.memoryId, entry);
      }
      return { restored: prepared.length };
    },
  });
}
