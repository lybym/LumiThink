/**
 * R1-08 runtime snapshot — capture + restore of the composed web MVP runtime
 * state (issue #20 交付范围 5: 加密备份/恢复演练; AC 1 重启后 Session 策略可
 * 恢复; AC 2 不得丢失已确认的领域事件或恢复被删除数据).
 *
 * WHAT IS INCLUDED (the confirmed fact source of the R1 deployment):
 * - guardian: authorizations (disclosure ack, consents, switches), persona
 *   style + provenance, the bounded security audit ring + sequence.
 * - childData: the lifecycle export (retained conversation history + full
 *   memory entries — the same guardian-authorized surface as
 *   GET /api/v1/guardian/data/export).
 * - tombstones: the content-free deletion ledger (ADR-0005 §2.3) with its
 *   sequence, so post-restore replays keep ledger continuity.
 * - interaction idempotency ledger (content-free: ids + payload digest), so
 *   pre-restart requestIds keep their replay protection.
 *
 * WHAT IS DELIBERATELY EXCLUDED (disclosed fail-closed boundaries):
 * - live guardian sessions + lockout counters: a restore always requires
 *   fresh logins (ADR-0003 bearer sessions are process-ephemeral) and resets
 *   brute-force pressure;
 * - memory/runtime audit rings of the observability layer (structural,
 *   value-free, operational — not confirmed facts);
 * - gateway budget counters (daily UTC window; a restart resets today's
 *   counters — disclosed with the mock-only default, real-provider
 *   activation re-examines this);
 * - DSH session mappings (a fresh process mints new mapped sessions on the
 *   next turn).
 *
 * RESTORE SEMANTICS (AC 2):
 * - Boot-time restore from the CURRENT snapshot file preserves confirmed
 *   events (the snapshot is internally consistent: an erase before its
 *   capture is already reflected by purged content + its tombstone).
 * - Restoring an OLDER archive (the drill path) requests the replay with a
 *   SELF-CLEARING MARKER FILE (deploy/restore.sh touches
 *   <snapshot-dir>/restore-replay.pending): the runtime replays the
 *   child-deletion ledger ONCE after the restore and deletes the marker in
 *   the same boot — but ONLY after the post-restore persist succeeded; a
 *   failed persist leaves the marker pending so the next boot retries the
 *   whole restore + replay (review round-2 P1-1). This is ADR-0005's
 *   designed answer that a restore may never resurrect deleted data
 *   (fail-safe direction: over-delete, never resurrect), without a
 *   persistent env flag that would turn every later restart into a purge
 *   of newly created data (review P1-1 round 1).
 *
 * This module stays framework-free (no next/react/prisma imports).
 */

import { createHash } from "node:crypto";

import type {
  GuardianConfirmedState,
  GuardianService,
} from "../guardian-service.ts";
import { parseGuardianConfirmedState } from "../guardian-service.ts";
import {
  validateChildDataRestorePayload,
  validateIdempotencyRestorePayload,
  type InteractionService,
} from "../interaction-service.ts";
import {
  validateDeletionLedgerRestorePayload,
  type DataLifecycleService,
} from "../data-lifecycle-service.ts";
import {
  validateMemoryRestoreEntries,
  type MemoryService,
} from "../../domain/memory/index.ts";
import type { ChildDataDeletionRecord, ChildDataExport } from "../../domain/lifecycle/index.ts";
import type { StoredInteraction } from "../../domain/contract/idempotency.ts";
import { ContractValidationError, problem } from "../../domain/contract/core.ts";

export const RUNTIME_SNAPSHOT_FORMAT = "lumithink.runtime-snapshot/v1" as const;

export const RUNTIME_SNAPSHOT_SOURCES = Object.freeze([
  "boot-restore",
  "confirmed-mutation",
  "interval",
  "shutdown",
  "manual",
] as const);

export type RuntimeSnapshotSource = (typeof RUNTIME_SNAPSHOT_SOURCES)[number];

/** Structural view of the composed runtime the snapshot composes over. */
export interface SnapshotCapableRuntime {
  readonly guardian: Pick<
    GuardianService,
    "exportConfirmedState" | "restoreConfirmedState" | "recordSnapshotRestored"
  >;
  readonly lifecycle: Pick<
    DataLifecycleService,
    "exportData" | "deletionRecords" | "restoreLedger" | "replayDeletions"
  >;
  readonly memory: Pick<MemoryService, "restoreEntries">;
  /** The interaction service is exposed as `service` on WebMvpRuntime. */
  readonly service: Pick<
    InteractionService,
    "restoreChildData" | "restoreIdempotencyLedger" | "idempotencySnapshot"
  >;
}

export interface RuntimeSnapshot {
  readonly format: typeof RUNTIME_SNAPSHOT_FORMAT;
  readonly createdAt: string;
  readonly source: RuntimeSnapshotSource;
  readonly guardian: {
    readonly authorizations: Readonly<GuardianConfirmedState["authorizations"]>;
    readonly style: Readonly<GuardianConfirmedState["style"]>;
    readonly auditEntries: readonly Readonly<GuardianConfirmedState["auditEntries"][number]>[];
    readonly auditNextSeq: number;
  };
  readonly childData: Readonly<ChildDataExport>;
  readonly tombstones: readonly Readonly<ChildDataDeletionRecord>[];
  readonly interaction: {
    readonly idempotency: readonly Readonly<StoredInteraction>[];
  };
  readonly counts: {
    readonly conversations: number;
    readonly historyEntries: number;
    readonly memories: number;
    readonly tombstones: number;
    readonly auditEntries: number;
  };
}

/** Short content fingerprint of a snapshot (for runbook drill evidence). */
export function snapshotFingerprint(snapshot: Readonly<RuntimeSnapshot>): string {
  return createHash("sha256")
    .update(JSON.stringify({ counts: snapshot.counts, createdAt: snapshot.createdAt }), "utf8")
    .digest("hex")
    .slice(0, 12);
}

/** Capture one snapshot of the current runtime state (caller encrypts/writes). */
export function captureRuntimeSnapshot(
  runtime: Readonly<SnapshotCapableRuntime>,
  meta: {
    readonly source: RuntimeSnapshotSource;
    /** Server-pinned child actor id (the idempotency ledger key prefix). */
    readonly childActorId: string;
    readonly nowFactory?: () => string;
  },
): Readonly<RuntimeSnapshot> {
  const nowFactory = meta.nowFactory ?? (() => new Date().toISOString());
  const confirmed = runtime.guardian.exportConfirmedState();
  const childData = runtime.lifecycle.exportData();
  const tombstones = runtime.lifecycle.deletionRecords();
  const idempotency = runtime.service.idempotencySnapshot(meta.childActorId);

  let historyEntries = 0;
  for (const conversation of childData.conversations) {
    historyEntries += conversation.history.length;
  }

  return Object.freeze({
    format: RUNTIME_SNAPSHOT_FORMAT,
    createdAt: nowFactory(),
    source: meta.source,
    guardian: Object.freeze({
      authorizations: confirmed.authorizations,
      style: confirmed.style,
      auditEntries: Object.freeze([...confirmed.auditEntries]),
      auditNextSeq: confirmed.auditNextSeq,
    }),
    childData,
    tombstones: Object.freeze([...tombstones]),
    interaction: Object.freeze({
      idempotency: Object.freeze([...idempotency]),
    }),
    counts: Object.freeze({
      conversations: childData.conversations.length,
      historyEntries,
      memories: childData.memories.length,
      tombstones: tombstones.length,
      auditEntries: confirmed.auditEntries.length,
    }),
  });
}

/**
 * Strict envelope validation of a parsed snapshot (fail-closed). Deep
 * re-validation of the guarded payloads happens in the restore ports
 * (guardian.parseRestored*, memory.parseMemoryEntry, lifecycle record
 * validation, contract grammars) — this pass fixes the envelope shape so a
 * malformed file can never reach the ports half-structured.
 */
export function validateRuntimeSnapshot(value: unknown): Readonly<RuntimeSnapshot> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "snapshot", "the snapshot payload must be an object."),
    ]);
  }
  const record = value as Record<string, unknown>;
  const expectedFields = ["format", "createdAt", "source", "guardian", "childData", "tombstones", "interaction", "counts"];
  for (const field of expectedFields) {
    if (!(field in record)) {
      throw new ContractValidationError([
        problem("CONTRACT_FIELD_MISSING", `snapshot.${field}`, "the snapshot payload is missing a required field."),
      ]);
    }
  }
  for (const key of Object.keys(record)) {
    if (!expectedFields.includes(key)) {
      throw new ContractValidationError([
        problem("CONTRACT_FIELD_INVALID", `snapshot.${key}`, "the snapshot payload carries an unknown field."),
      ]);
    }
  }
  if (record.format !== RUNTIME_SNAPSHOT_FORMAT) {
    throw new ContractValidationError([
      problem("CONTRACT_UNKNOWN_VERSION", "snapshot.format", "the snapshot format is not supported by this runtime."),
    ]);
  }
  if (
    typeof record.createdAt !== "string" ||
    record.createdAt.length === 0 ||
    record.createdAt.length > 40 ||
    Number.isNaN(Date.parse(record.createdAt))
  ) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "snapshot.createdAt", "the snapshot createdAt must be a bounded ISO timestamp."),
    ]);
  }
  if (
    typeof record.source !== "string" ||
    !(RUNTIME_SNAPSHOT_SOURCES as readonly string[]).includes(record.source)
  ) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "snapshot.source", "the snapshot source is not registered."),
    ]);
  }
  if (record.guardian === null || typeof record.guardian !== "object" || Array.isArray(record.guardian)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "snapshot.guardian", "the snapshot guardian section must be an object."),
    ]);
  }
  if (record.childData === null || typeof record.childData !== "object" || Array.isArray(record.childData)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "snapshot.childData", "the snapshot childData section must be an object."),
    ]);
  }
  if (!Array.isArray(record.tombstones)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "snapshot.tombstones", "the snapshot tombstones must be an array."),
    ]);
  }
  if (
    record.interaction === null ||
    typeof record.interaction !== "object" ||
    Array.isArray(record.interaction) ||
    !Array.isArray((record.interaction as Record<string, unknown>).idempotency)
  ) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "snapshot.interaction", "the snapshot interaction section must carry an idempotency array."),
    ]);
  }
  return record as unknown as Readonly<RuntimeSnapshot>;
}

export interface RestoreRuntimeSnapshotResult {
  readonly conversations: number;
  readonly historyEntries: number;
  readonly memories: number;
  readonly tombstones: number;
  readonly idempotency: number;
  readonly replayed: boolean;
  readonly replayPurged: { readonly conversations: number; readonly historyEntries: number; readonly memories: number };
}

/**
 * Restore a validated snapshot into a FRESH runtime (composition-time only)
 * and optionally replay the deletion ledger (AC 2: a restore must never
 * resurrect deleted data).
 *
 * ALL-OR-NOTHING: every section is pre-validated (pure validators, no state
 * touched) before the first commit — an invalid section aborts the restore
 * with NO partial state installed. The composition root additionally
 * validates the envelope SYNCHRONOUSLY before composing (review round-2
 * P2-1): an undecryptable/non-JSON/envelope-invalid file refuses to boot
 * outright, while an envelope-valid file with an invalid SECTION aborts
 * this async restore (loud stderr line, no state installed).
 */
export async function restoreRuntimeSnapshot(
  runtime: Readonly<SnapshotCapableRuntime>,
  snapshotValue: unknown,
  options: {
    readonly childActorId: string;
    readonly replayAfterRestore: boolean;
    readonly replayOperatorRole?: string;
  },
): Promise<RestoreRuntimeSnapshotResult> {
  const snapshot = validateRuntimeSnapshot(snapshotValue);

  // ---- Pre-validation pass (pure; no state mutation) ----------------------
  const confirmed = parseGuardianConfirmedState(snapshot.guardian);
  const restoredChild = validateChildDataRestorePayload(snapshot.childData.conversations, null);
  const restoredMemory = validateMemoryRestoreEntries(snapshot.childData.memories);
  const restoredLedger = validateDeletionLedgerRestorePayload(snapshot.tombstones);
  const restoredIdempotency = validateIdempotencyRestorePayload(snapshot.interaction.idempotency);
  let historyEntries = 0;
  for (const conversation of restoredChild) {
    historyEntries += conversation.history.length;
  }

  // ---- Commit pass (ports are themselves atomic; already validated) -------
  runtime.guardian.restoreConfirmedState(confirmed);
  runtime.service.restoreChildData(snapshot.childData.conversations, options.childActorId);
  runtime.memory.restoreEntries(snapshot.childData.memories);
  runtime.lifecycle.restoreLedger(snapshot.tombstones);
  runtime.service.restoreIdempotencyLedger(snapshot.interaction.idempotency, options.childActorId);

  // ---- Optional ADR-0005 replay + disclosure ------------------------------
  let replayed = false;
  let replayPurged = { conversations: 0, historyEntries: 0, memories: 0 };
  if (options.replayAfterRestore) {
    const replay = await runtime.lifecycle.replayDeletions(options.replayOperatorRole ?? "system");
    replayed = true;
    replayPurged = {
      conversations: replay.purged.conversations,
      historyEntries: replay.purged.historyEntries,
      memories: replay.purged.memories,
    };
  }

  runtime.guardian.recordSnapshotRestored(
    `src=${snapshot.source},conv=${restoredChild.length},hist=${historyEntries},mem=${restoredMemory.length},tomb=${restoredLedger.length},replay=${replayed ? "1" : "0"}`,
  );

  return {
    conversations: restoredChild.length,
    historyEntries,
    memories: restoredMemory.length,
    tombstones: restoredLedger.length,
    idempotency: restoredIdempotency.length,
    replayed,
    replayPurged,
  };
}
