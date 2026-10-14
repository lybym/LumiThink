/**
 * R1-09 child data lifecycle service (issue #21; PRD FR-006/FR-008;
 * Roadmap R1-09; docs/MEMORY_POLICY.md + docs/PRIVACY_DATA_FLOW.md;
 * docs/adr/0005-child-data-lifecycle-v0.md).
 *
 * Server-side composition service that implements the subject-wide data
 * lifecycle for the pinned family child across EVERY store that can carry
 * child content (issue #21 交付范围 3: 删除策略覆盖领域 DB、缓存/检索索引、
 * DSH 运行会话、临时工件与备份保留边界):
 *
 * - 领域记忆 (memory entries incl. candidates/superseded) — hard delete of
 *   every entry via the memory domain's own deleteMemory (lineage purge);
 * - 缓存/检索索引 — retrieval reads the same store, so the purge is
 *   immediately effective (cross-session retrieval of a deleted subject
 *   is 0 — no separate cache exists to orphan);
 * - 会话历史 + 临时工件 (conversation records/history, turn event buffers)
 *   — interaction-service erase (running turns aborted first);
 * - DSH 运行会话 (session mapping) — mapped sessions are closed so a purged
 *   conversation can never resume into its old DSH session;
 * - 备份保留边界 — the current deployment has NO offline backups (whole
 *   state is process-local memory, TECH_STACK §3). The DELETION LEDGER
 *   (bounded, content-free tombstones) + `replayDeletions` implement the
 *   provable policy for the day backups exist: after a restore, the replay
 *   re-deletes everything a prior erase covered (AC 2: 备份恢复后的删除重放).
 *
 * AUDIT SEPARATION (交付范围 4): this service records only STRUCTURAL
 * tombstones (ids + counts). Deleted claims and chat text have no field to
 * hide in — the ledger shapes are validated content-free. The guardian
 * security audit entries (data_view/data_export/data_erase/…) are pushed by
 * the guardian service that authorizes each HTTP surface.
 *
 * ACTOR SCOPING: every memory operation uses a server-constructed guardian
 * ActorContext pinned to the family childRef (identity never comes from
 * client input); the HTTP surfaces re-check the operator's role matrix in
 * the guardian service (data_read: guardian+admin; export/erase: guardian
 * only). No child text ever appears in a rejection or a ledger entry.
 *
 * This module stays framework-free (no next/react/prisma imports).
 */

import { parseActorContext, type ActorContext } from "../domain/contract/actor.ts";
import type { DshSessionMapper } from "../domain/runtime/session-map.ts";
import {
  GUARDIAN_FAMILY_CHILD_REF,
  type GuardianAuditEntry,
} from "../domain/guardian/authorizations.ts";
import {
  MAX_DELETION_LEDGER_RECORDS,
  validateChildDataDeletionRecord,
  validateChildDataEraseResult,
  validateChildDataExport,
  validateChildDataInventory,
  type ChildDataDeletionRecord,
  type ChildDataEraseResult,
  type ChildDataExport,
  type ChildDataInventory,
} from "../domain/lifecycle/index.ts";
import type { MemoryService } from "../domain/memory/index.ts";

/** Structural view of the interaction service the lifecycle composes. */
export interface LifecycleInteractionPort {
  childDataSnapshot(actorId: unknown): {
    readonly conversations: readonly {
      readonly conversationId: string;
      readonly sessionId: string;
      readonly history: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
    }[];
    readonly turnStreams: { readonly total: number; readonly running: number };
  };
  eraseChildData(actorId: unknown): Promise<{
    readonly conversations: number;
    readonly historyEntries: number;
    readonly turnStreams: number;
  }>;
}

export interface DataLifecycleServiceOptions {
  /** Server-pinned family child (never a client-supplied subject). */
  readonly childRef?: string;
  /** The child's server-verified actor id (interaction-service key). */
  readonly childActorId: string;
  readonly interaction: LifecycleInteractionPort;
  readonly memory: MemoryService;
  /**
   * The composed pipeline's DSH session mapper (optional: rigs without a
   * pipeline pass nothing; mapped sessions then report 0 and closing skips).
   */
  readonly sessionMapper?: DshSessionMapper;
  /** Live recording-switch state (guardian `conversation_recording`). */
  readonly isRecordingEnabled: () => boolean;
  /** ISO-8601 UTC timestamps. */
  readonly nowFactory?: () => string;
  /** `del_` tombstone id factory (tests inject deterministic ids). */
  readonly idFactory?: () => string;
}

export interface DataLifecycleService {
  /** Structural inventory for GET /api/v1/guardian/data (NO content). */
  inventory(): Readonly<ChildDataInventory>;
  /** Authorized export for GET /api/v1/guardian/data/export. */
  exportData(): Readonly<ChildDataExport>;
  /** Subject-wide hard delete (erase_child_data action). */
  erase(operatorRole: string): Promise<Readonly<ChildDataEraseResult>>;
  /** Re-apply prior deletions (replay_child_deletions — backup restore). */
  replayDeletions(operatorRole: string): Promise<Readonly<ChildDataEraseResult>>;
  /** Tombstone ledger snapshot (content-free; audit surface). */
  deletionRecords(): readonly Readonly<ChildDataDeletionRecord>[];
}

/** Default tombstone id factory (`del_` + bounded random body). */
function defaultDeletionIdFactory(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `del_${Date.now().toString(36)}${random}`.slice(0, 68);
}

export function createDataLifecycleService(
  options: DataLifecycleServiceOptions,
): DataLifecycleService {
  const childRef = options.childRef ?? GUARDIAN_FAMILY_CHILD_REF;
  const childActorId = options.childActorId;
  const interaction = options.interaction;
  const memory = options.memory;
  const sessionMapper = options.sessionMapper;
  const isRecordingEnabled = options.isRecordingEnabled;
  const nowFactory = options.nowFactory ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? defaultDeletionIdFactory;

  /** Bounded tombstone ledger (content-free; insertion-ordered). */
  const ledger: ChildDataDeletionRecord[] = [];
  let ledgerSeq = 0;

  /**
   * Server-constructed guardian actor for the memory operations performed
   * on behalf of the verified operator (memory listEntries/deleteMemory
   * admit guardian for the family subject). Identity is never client data.
   */
  function memoryOperatorActor(): Readonly<ActorContext> {
    return parseActorContext({
      role: "guardian",
      actorId: "act_guardian_data_lifecycle",
      childRef,
      verifiedBy: "data-lifecycle-v1",
      verifiedAt: nowFactory(),
    });
  }

  /** Core purge shared by erase + replay (subject-pinned, hard delete). */
  async function purgeSubject(operatorRole: string): Promise<{
    readonly purged: ChildDataEraseResult["purged"];
  }> {
    // Snapshot BEFORE the interaction erase so the erased sessions' DSH
    // mappings can be closed afterwards (the snapshot is the only place the
    // sessionId ↔ conversationId pairing is still observable).
    const snapshot = interaction.childDataSnapshot(childActorId);
    const sessionIds = [...new Set(snapshot.conversations.map((c) => c.sessionId))];

    const interactionResult = await interaction.eraseChildData(childActorId);

    // 领域记忆: per-entry hard delete through the memory domain's own
    // authorized path (each delete purges the full supersedes lineage).
    // deleteMemory already records its own audit facts; already-purged
    // lineage members report not_found and are skipped.
    let memoryPurged = 0;
    const memoryActor = memoryOperatorActor();
    const entries = memory.listEntries(childRef, memoryActor);
    for (const entry of entries) {
      const deleted = memory.deleteMemory({ memoryId: entry.memoryId }, memoryActor);
      if (deleted.ok) {
        memoryPurged += 1;
      }
    }

    // DSH 运行会话: close every mapped session of the erased conversations
    // so a purged conversation cannot resume into its old DSH session.
    let dshClosed = 0;
    if (sessionMapper !== undefined) {
      for (const sessionId of sessionIds) {
        const descriptor = sessionMapper.describe(sessionId);
        if (descriptor !== null && descriptor.state !== "closed") {
          await sessionMapper.close(sessionId, "explicit_close");
          dshClosed += 1;
        }
      }
    }

    return {
      purged: {
        conversations: interactionResult.conversations,
        historyEntries: interactionResult.historyEntries,
        turnStreams: interactionResult.turnStreams,
        memories: memoryPurged,
        dshSessions: dshClosed,
      },
    };
  }

  function recordTombstone(
    action: ChildDataEraseResult["action"],
    operatorRole: string,
    purged: ChildDataEraseResult["purged"],
  ): Readonly<ChildDataDeletionRecord> {
    ledgerSeq += 1;
    const record = validateChildDataDeletionRecord({
      recordId: idFactory(),
      seq: ledgerSeq,
      at: nowFactory(),
      subjectRef: childRef,
      action,
      operatorRole,
      purged,
    });
    ledger.push(record);
    if (ledger.length > MAX_DELETION_LEDGER_RECORDS) {
      ledger.shift();
    }
    return record;
  }

  return Object.freeze({
    inventory(): Readonly<ChildDataInventory> {
      const snapshot = interaction.childDataSnapshot(childActorId);
      const memoryActor = memoryOperatorActor();
      const entries = memory.listEntries(childRef, memoryActor);
      const memories = { total: entries.length, candidates: 0, confirmed: 0, superseded: 0, expired: 0 };
      for (const entry of entries) {
        if (entry.status === "candidate") {
          memories.candidates += 1;
        } else if (entry.status === "confirmed") {
          memories.confirmed += 1;
        } else if (entry.status === "superseded") {
          memories.superseded += 1;
        } else {
          memories.expired += 1;
        }
      }
      let mapped = 0;
      if (sessionMapper !== undefined) {
        for (const sessionId of new Set(snapshot.conversations.map((c) => c.sessionId))) {
          const descriptor = sessionMapper.describe(sessionId);
          // Only live mappings count; a closed mapping is the erase's own
          // doing (terminal state, kept for defect history only).
          if (descriptor !== null && descriptor.state !== "closed") {
            mapped += 1;
          }
        }
      }
      const last = ledger.length > 0 ? ledger[ledger.length - 1] : undefined;
      return validateChildDataInventory({
        protocolVersion: "1.0",
        childRef,
        recordingEnabled: isRecordingEnabled(),
        conversations: snapshot.conversations.map((conversation) => ({
          conversationId: conversation.conversationId,
          sessionId: conversation.sessionId,
          historyEntries: conversation.history.length,
        })),
        turnStreams: snapshot.turnStreams,
        dshSessions: { mapped },
        memories,
        deletionLedger: {
          records: ledger.length,
          lastErasedAt: last?.at ?? null,
        },
        generatedAt: nowFactory(),
      });
    },

    exportData(): Readonly<ChildDataExport> {
      const snapshot = interaction.childDataSnapshot(childActorId);
      const memoryActor = memoryOperatorActor();
      return validateChildDataExport({
        protocolVersion: "1.0",
        childRef,
        exportedAt: nowFactory(),
        recordingEnabled: isRecordingEnabled(),
        conversations: snapshot.conversations.map((conversation) => ({
          conversationId: conversation.conversationId,
          sessionId: conversation.sessionId,
          history: conversation.history.map((entry) => ({ role: entry.role, content: entry.content })),
        })),
        memories: memory.listEntries(childRef, memoryActor),
        exclusions: Object.freeze([
          "运行时 Trace 与模型网关审计：value-free 设计，不含正文，无需导出",
          "供应商侧数据：仅当第三方外发开启时产生；本系统不可导出，供应商侧删除承诺不可虚构",
          "音频：本系统不采集、不存储",
        ]),
      });
    },

    async erase(operatorRole: string): Promise<Readonly<ChildDataEraseResult>> {
      const { purged } = await purgeSubject(operatorRole);
      const record = recordTombstone("erase_child_data", operatorRole, purged);
      return validateChildDataEraseResult({
        protocolVersion: "1.0",
        childRef,
        action: "erase_child_data",
        erasedAt: record.at,
        operatorRole,
        purged,
        deletionRecordId: record.recordId,
      });
    },

    async replayDeletions(operatorRole: string): Promise<Readonly<ChildDataEraseResult>> {
      // Replay = re-apply the subject-pinned purge against whatever exists
      // NOW. After a hypothetical backup restore re-created data of a prior
      // erased subject, this run deletes it again (AC 2). With nothing to
      // delete the run is a no-op that still lands a tombstone (provable).
      const { purged } = await purgeSubject(operatorRole);
      const record = recordTombstone("replay_child_deletions", operatorRole, purged);
      return validateChildDataEraseResult({
        protocolVersion: "1.0",
        childRef,
        action: "replay_child_deletions",
        erasedAt: record.at,
        operatorRole,
        purged,
        deletionRecordId: record.recordId,
      });
    },

    deletionRecords(): readonly Readonly<ChildDataDeletionRecord>[] {
      return Object.freeze([...ledger]);
    },
  });
}

/**
 * Guardian audit pusher type shared with the guardian service wiring: the
 * lifecycle surfaces land their structured facts in the guardian security
 * audit (kinds data_view / data_export / data_erase / data_erase_replay).
 */
export type LifecycleAuditPusher = (
  kind: Extract<GuardianAuditEntry["kind"], "data_view" | "data_export" | "data_erase" | "data_erase_replay">,
  fields: { readonly actorRole: string | null; readonly actorId: string | null; readonly target: string | null; readonly detail: string | null },
) => void;
