/**
 * R1-09 child data lifecycle — retention policy vocabulary + fail-closed
 * request/emit shapes (issue #21; PRD FR-006/FR-008; Roadmap R1-09;
 * docs/MEMORY_POLICY.md + docs/PRIVACY_DATA_FLOW.md;
 * docs/adr/0005-child-data-lifecycle-v0.md).
 *
 * This module is the CODE-SIDE SOURCE OF TRUTH for the data-flow/retention
 * matrix that AC 3 requires ("新数据种类进入系统前必须更新数据流/保留矩阵"):
 * every data kind the web MVP keeps is enumerated here with WHERE it lives,
 * whether it can carry child text, and WHICH lifecycle operation deletes it.
 * The lifecycle spec tests assert matrix integrity (every text-bearing kind
 * has a hard-delete path); docs mirror this table and any NEW data kind must
 * add a row here + a row in docs/PRIVACY_DATA_FLOW.md + review.
 *
 * Deletion semantics (issue #21 交付范围 3):
 * - erase is a subject-wide HARD delete across 领域记忆 (memory entries),
 *   会话历史 (conversation history), 临时工件 (turn event buffers) and the
 *   DSH session mapping (closed); retrieval of a deleted subject is 0.
 * - the deletion ledger records STRUCTURAL tombstones (ids + counts, never
 *   content) so deletions can be REPLAYED after a hypothetical backup
 *   restore (AC 2: 备份恢复后的删除重放). The current deployment has no
 *   offline backups (process-local memory) — the ledger + replay procedure
 *   is the provable policy that activates the moment backups exist.
 * - audit separation (交付范围 4): every operation lands as structural
 *   audit facts; deleted sensitive content has NO field to hide in — the
 *   audit/ledger shapes cannot carry claim or chat text (tested).
 *
 * Vendor honesty (AC 3): `vendor_side` is a data kind this system does NOT
 * control. Revoking the consent/egress switch stops all NEW vendor requests
 * (R1-06 pre-transport gate), but vendor-side deletion cannot be guaranteed
 * by this system and is never claimed — docs/MEMORY_POLICY.md states this.
 *
 * Parsers here are fail-closed and no-echo: unknown fields, unknown
 * versions and malformed values are rejected; submitted values that failed
 * validation are never repeated in problem messages.
 *
 * This module must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import {
  type ContractProblem,
  ContractValidationError,
  problem,
} from "../contract/core.ts";
import { ingestDomainFact } from "../legacy-guard.ts";
import type { MemoryEntry } from "../memory/schema.ts";
import { GUARDIAN_FAMILY_CHILD_REF } from "../guardian/authorizations.ts";
import type { ActorRole } from "../contract/actor.ts";

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

export const LIFECYCLE_PROTOCOL_VERSIONS = Object.freeze(["1.0"] as const);
export type LifecycleProtocolVersion = (typeof LIFECYCLE_PROTOCOL_VERSIONS)[number];

// ---------------------------------------------------------------------------
// Retention matrix vocabulary (AC 3: 数据流/保留矩阵的代码侧源头)
// ---------------------------------------------------------------------------

/** Where a data kind physically lives in the current deployment. */
export const DATA_STORAGE_LOCATIONS = Object.freeze([
  "process_memory", // in-memory, process-local (the entire current web MVP)
  "vendor_side", // outside this system (third-party provider, when enabled)
  "none", // no storage path exists at all today (audio)
] as const);
export type DataStorageLocation = (typeof DATA_STORAGE_LOCATIONS)[number];

/** Every data kind the system can hold, with its retention/delete contract. */
export interface DataKindPolicy {
  readonly dataKind: string;
  /** True when entries of this kind can carry child conversation text. */
  readonly carriesChildText: boolean;
  readonly storedIn: DataStorageLocation;
  /** Bounded human-readable retention rule (mirrors docs/MEMORY_POLICY.md). */
  readonly retention: string;
  /** The lifecycle operation that removes it (mirrors the erase scope). */
  readonly deletedBy: string;
}

/**
 * The v0 retention matrix (docs/MEMORY_POLICY.md §2 mirrors this table).
 * Hard rules the tests enforce:
 * - every kind with carriesChildText=true has a concrete delete path in the
 *   lifecycle erase (no text-bearing kind may lack a deletion path);
 * - `audio` is `none`: there is no audio collection path in this build.
 */
export const DATA_KIND_POLICIES: readonly Readonly<DataKindPolicy>[] = Object.freeze([
  Object.freeze({
    dataKind: "conversation_history",
    carriesChildText: true,
    storedIn: "process_memory",
    retention: "记录开关开启时：每会话最近 40 条；关闭时不保留正文",
    deletedBy: "lifecycle erase（主体级硬删除）",
  }),
  Object.freeze({
    dataKind: "turn_stream_events",
    carriesChildText: true,
    storedIn: "process_memory",
    retention: "轮次进行中必需；记录开关关闭时终态即清，开启时随进程生命周期",
    deletedBy: "lifecycle erase（含在途轮次取消）",
  }),
  Object.freeze({
    dataKind: "dsh_session_mapping",
    carriesChildText: false,
    storedIn: "process_memory",
    retention: "会话生命周期；仅映射 id 与状态，无正文",
    deletedBy: "lifecycle erase（映射关闭）",
  }),
  Object.freeze({
    dataKind: "memory_entries",
    carriesChildText: true,
    storedIn: "process_memory",
    retention: "候选/确认事实按记忆域规则（过期、复核、谱系）",
    deletedBy: "lifecycle erase + memory.delete（谱系硬删除）",
  }),
  Object.freeze({
    dataKind: "memory_audit",
    carriesChildText: false,
    storedIn: "process_memory",
    retention: "有界环 256 条；仅结构化事实，无正文（结构上无字段）",
    deletedBy: "purgeAudit（独立清理）",
  }),
  Object.freeze({
    dataKind: "guardian_audit",
    carriesChildText: false,
    storedIn: "process_memory",
    retention: "有界环 500 条；仅结构化事实，无正文（结构上无字段）",
    deletedBy: "随进程生命周期（无独立清空面，#18 设计）",
  }),
  Object.freeze({
    dataKind: "runtime_trace",
    carriesChildText: false,
    storedIn: "process_memory",
    retention: "value-free：仅规则/计数/id，无正文（#15 设计）",
    deletedBy: "随进程生命周期",
  }),
  Object.freeze({
    dataKind: "gateway_audit",
    carriesChildText: false,
    storedIn: "process_memory",
    retention: "value-free：供应商/预算/结果码，无正文（#14 设计）",
    deletedBy: "随进程生命周期",
  }),
  Object.freeze({
    dataKind: "deletion_ledger",
    carriesChildText: false,
    storedIn: "process_memory",
    retention: "有界台账 100 条 tombstone；仅 id 与计数，无正文",
    deletedBy: "随进程生命周期（用于恢复后重删；跨进程恢复需持久化台账——TECH_STACK §3 待定项）",
  }),
  Object.freeze({
    dataKind: "audio",
    carriesChildText: false,
    storedIn: "none",
    retention: "不采集、不存储（当前部署没有语音路径；R5 规则：不默认保存原始录音）",
    deletedBy: "不适用（无存储）",
  }),
  Object.freeze({
    dataKind: "vendor_side",
    carriesChildText: true,
    storedIn: "vendor_side",
    retention: "仅当第三方外发开启时产生；保留期限以供应商评审结论为准（待核实）",
    deletedBy: "不可由本系统担保——撤销授权后不再发起新请求；供应商侧删除承诺不可虚构",
  }),
]);

// ---------------------------------------------------------------------------
// Erase request parsing (POST /api/v1/guardian/data/erase, fail-closed)
// ---------------------------------------------------------------------------

export type ChildDataAction =
  | { readonly kind: "erase_child_data" }
  | { readonly kind: "replay_child_deletions" };

export const CHILD_DATA_ACTION_KINDS = Object.freeze([
  "erase_child_data",
  "replay_child_deletions",
] as const);

/**
 * Parse one POST /api/v1/guardian/data/erase body. The subject is NOT a
 * body field: the family child is pinned server-side, so no payload can
 * redirect an erase at another child. Unknown fields/versions fail closed.
 */
export function parseChildDataActionRequest(value: unknown): Readonly<ChildDataAction> {
  const problems: ContractProblem[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "body", "data action body must be an object."),
    ]);
  }
  const record = value as Record<string, unknown>;
  const version = record.protocolVersion;
  if (version === undefined || version === null || version === "") {
    problems.push(problem("CONTRACT_FIELD_MISSING", "protocolVersion", "protocolVersion is required."));
  } else if (!(LIFECYCLE_PROTOCOL_VERSIONS as readonly string[]).includes(version as string)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "protocolVersion", "protocolVersion is not a supported version."),
    );
  }
  const unknownCount = Object.keys(record).filter((key) => key !== "protocolVersion" && key !== "action").length;
  if (unknownCount > 0) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "body",
        `payload carries ${unknownCount} unknown field(s); unknown fields are rejected without echo.`,
      ),
    );
  }
  const action = record.action;
  if (action === undefined || action === null || action === "") {
    problems.push(problem("CONTRACT_FIELD_MISSING", "action", "action is required."));
  } else if (!(CHILD_DATA_ACTION_KINDS as readonly string[]).includes(action as string)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "action", "action is not a registered data action."),
    );
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return Object.freeze(
    action === "erase_child_data"
      ? { kind: "erase_child_data" }
      : { kind: "replay_child_deletions" },
  );
}

// ---------------------------------------------------------------------------
// Emit shapes (inventory / export / erase result / deletion record)
// ---------------------------------------------------------------------------

export interface ChildDataConversationView {
  readonly conversationId: string;
  readonly sessionId: string;
  /** Number of retained history entries (0 when recording is off). */
  readonly historyEntries: number;
}

/** GET /api/v1/guardian/data — structural inventory, NO content. */
export interface ChildDataInventory {
  readonly protocolVersion: LifecycleProtocolVersion;
  readonly childRef: string;
  readonly recordingEnabled: boolean;
  readonly conversations: readonly ChildDataConversationView[];
  readonly turnStreams: { readonly total: number; readonly running: number };
  readonly dshSessions: { readonly mapped: number };
  readonly memories: {
    readonly total: number;
    readonly candidates: number;
    readonly confirmed: number;
    readonly superseded: number;
    readonly expired: number;
  };
  readonly deletionLedger: { readonly records: number; readonly lastErasedAt: string | null };
  readonly generatedAt: string;
}

/** GET /api/v1/guardian/data/export — authorized export of SAVED content. */
export interface ChildDataExport {
  readonly protocolVersion: LifecycleProtocolVersion;
  readonly childRef: string;
  readonly exportedAt: string;
  readonly recordingEnabled: boolean;
  readonly conversations: readonly {
    readonly conversationId: string;
    readonly sessionId: string;
    readonly history: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  }[];
  readonly memories: readonly Readonly<MemoryEntry>[];
  /** What this export deliberately does NOT contain (honest boundary). */
  readonly exclusions: readonly string[];
}

/** Structural result of one erase/replay run (no deleted content, ever). */
export interface ChildDataEraseResult {
  readonly protocolVersion: LifecycleProtocolVersion;
  readonly childRef: string;
  readonly action: "erase_child_data" | "replay_child_deletions";
  readonly erasedAt: string;
  readonly operatorRole: string;
  readonly purged: {
    readonly conversations: number;
    readonly historyEntries: number;
    readonly turnStreams: number;
    readonly memories: number;
    readonly dshSessions: number;
  };
  readonly deletionRecordId: string;
}

/** One tombstone in the deletion ledger (content-free by construction). */
export interface ChildDataDeletionRecord {
  readonly recordId: string;
  readonly seq: number;
  readonly at: string;
  readonly subjectRef: string;
  readonly action: "erase_child_data" | "replay_child_deletions";
  readonly operatorRole: string;
  readonly purged: {
    readonly conversations: number;
    readonly historyEntries: number;
    readonly turnStreams: number;
    readonly memories: number;
    readonly dshSessions: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[], path: string, problems: ContractProblem[]): void {
  const unknownCount = Object.keys(record).filter((key) => !allowed.includes(key)).length;
  if (unknownCount > 0) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        path,
        `payload carries ${unknownCount} unknown field(s); unknown fields are rejected without echo.`,
      ),
    );
  }
}

function requireBoundedString(
  value: unknown,
  path: string,
  maxLen: number,
  problems: ContractProblem[],
): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLen) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", path, `${path} must be a bounded string.`),
    );
  }
}

function requireCount(value: unknown, path: string, problems: ContractProblem[]): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", path, `${path} must be a non-negative integer.`),
    );
  }
}

/**
 * Re-validate the inventory at emit time (fail-closed out, like every
 * contract payload). Guards: bounded ids, counts, no unknown fields.
 */
export function validateChildDataInventory(value: unknown): Readonly<ChildDataInventory> {
  const problems: ContractProblem[] = [];
  if (!isRecord(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "inventory", "inventory must be an object."),
    ]);
  }
  rejectUnknown(
    value,
    ["protocolVersion", "childRef", "recordingEnabled", "conversations", "turnStreams", "dshSessions", "memories", "deletionLedger", "generatedAt"],
    "inventory",
    problems,
  );
  requireBoundedString(value.childRef, "inventory.childRef", 80, problems);
  requireBoundedString(value.generatedAt, "inventory.generatedAt", 40, problems);
  if (typeof value.recordingEnabled !== "boolean") {
    problems.push(problem("CONTRACT_FIELD_INVALID", "inventory.recordingEnabled", "recordingEnabled must be a boolean."));
  }
  if (!Array.isArray(value.conversations)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "inventory.conversations", "conversations must be an array."));
  } else {
    for (const entry of value.conversations) {
      if (!isRecord(entry)) {
        problems.push(problem("CONTRACT_FIELD_INVALID", "inventory.conversations[]", "each conversation must be an object."));
        continue;
      }
      rejectUnknown(entry, ["conversationId", "sessionId", "historyEntries"], "inventory.conversations[]", problems);
      requireBoundedString(entry.conversationId, "inventory.conversations[].conversationId", 80, problems);
      requireBoundedString(entry.sessionId, "inventory.conversations[].sessionId", 80, problems);
      requireCount(entry.historyEntries, "inventory.conversations[].historyEntries", problems);
    }
  }
  if (!isRecord(value.turnStreams) || !isRecord(value.dshSessions) || !isRecord(value.memories) || !isRecord(value.deletionLedger)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "inventory", "structural counters must be objects."));
  } else {
    requireCount(value.turnStreams.total, "inventory.turnStreams.total", problems);
    requireCount(value.turnStreams.running, "inventory.turnStreams.running", problems);
    requireCount(value.dshSessions.mapped, "inventory.dshSessions.mapped", problems);
    requireCount(value.memories.total, "inventory.memories.total", problems);
    requireCount(value.memories.candidates, "inventory.memories.candidates", problems);
    requireCount(value.memories.confirmed, "inventory.memories.confirmed", problems);
    requireCount(value.memories.superseded, "inventory.memories.superseded", problems);
    requireCount(value.memories.expired, "inventory.memories.expired", problems);
    requireCount(value.deletionLedger.records, "inventory.deletionLedger.records", problems);
    if (value.deletionLedger.lastErasedAt !== null) {
      requireBoundedString(value.deletionLedger.lastErasedAt, "inventory.deletionLedger.lastErasedAt", 40, problems);
    }
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return ingestDomainFact(value) as Readonly<ChildDataInventory>;
}

const EXPORT_HISTORY_ROLES = Object.freeze(["user", "assistant"] as const);

/**
 * Re-validate the export payload at emit time. This is the one lifecycle
 * shape that DOES carry content (authorized guardian view) — the validator
 * bounds every string so the shape cannot smuggle unbounded text.
 */
export function validateChildDataExport(value: unknown): Readonly<ChildDataExport> {
  const problems: ContractProblem[] = [];
  if (!isRecord(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "export", "export must be an object."),
    ]);
  }
  rejectUnknown(
    value,
    ["protocolVersion", "childRef", "exportedAt", "recordingEnabled", "conversations", "memories", "exclusions"],
    "export",
    problems,
  );
  requireBoundedString(value.childRef, "export.childRef", 80, problems);
  requireBoundedString(value.exportedAt, "export.exportedAt", 40, problems);
  if (typeof value.recordingEnabled !== "boolean") {
    problems.push(problem("CONTRACT_FIELD_INVALID", "export.recordingEnabled", "recordingEnabled must be a boolean."));
  }
  if (!Array.isArray(value.exclusions)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "export.exclusions", "exclusions must be an array."));
  }
  if (!Array.isArray(value.conversations)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "export.conversations", "conversations must be an array."));
  } else {
    for (const conversation of value.conversations) {
      if (!isRecord(conversation)) {
        problems.push(problem("CONTRACT_FIELD_INVALID", "export.conversations[]", "each conversation must be an object."));
        continue;
      }
      rejectUnknown(conversation, ["conversationId", "sessionId", "history"], "export.conversations[]", problems);
      requireBoundedString(conversation.conversationId, "export.conversations[].conversationId", 80, problems);
      requireBoundedString(conversation.sessionId, "export.conversations[].sessionId", 80, problems);
      if (!Array.isArray(conversation.history)) {
        problems.push(problem("CONTRACT_FIELD_INVALID", "export.conversations[].history", "history must be an array."));
        continue;
      }
      for (const item of conversation.history) {
        if (!isRecord(item)) {
          problems.push(problem("CONTRACT_FIELD_INVALID", "export.history[]", "each history entry must be an object."));
          continue;
        }
        rejectUnknown(item, ["role", "content"], "export.history[]", problems);
        if (typeof item.role !== "string" || !(EXPORT_HISTORY_ROLES as readonly string[]).includes(item.role)) {
          problems.push(problem("CONTRACT_FIELD_INVALID", "export.history[].role", "role must be user or assistant."));
        }
        if (typeof item.content !== "string" || [...item.content].length > 4000) {
          problems.push(problem("CONTRACT_FIELD_INVALID", "export.history[].content", "content must be a bounded string."));
        }
      }
    }
  }
  if (!Array.isArray(value.memories)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "export.memories", "memories must be an array."));
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return ingestDomainFact(value) as Readonly<ChildDataExport>;
}

/**
 * Re-validate an erase/replay result at emit time. Structural facts only —
 * the shape has no field that could carry the deleted content (tested).
 */
export function validateChildDataEraseResult(value: unknown): Readonly<ChildDataEraseResult> {
  const problems: ContractProblem[] = [];
  if (!isRecord(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "eraseResult", "erase result must be an object."),
    ]);
  }
  rejectUnknown(
    value,
    ["protocolVersion", "childRef", "action", "erasedAt", "operatorRole", "purged", "deletionRecordId"],
    "eraseResult",
    problems,
  );
  requireBoundedString(value.childRef, "eraseResult.childRef", 80, problems);
  requireBoundedString(value.erasedAt, "eraseResult.erasedAt", 40, problems);
  requireBoundedString(value.deletionRecordId, "eraseResult.deletionRecordId", 80, problems);
  if (typeof value.operatorRole !== "string" || value.operatorRole.length === 0 || value.operatorRole.length > 40) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "eraseResult.operatorRole", "operatorRole must be a bounded string."));
  }
  if (
    value.action !== "erase_child_data" &&
    value.action !== "replay_child_deletions"
  ) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "eraseResult.action", "action must be a registered data action."));
  }
  if (!isRecord(value.purged)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "eraseResult.purged", "purged must be an object."));
  } else {
    for (const key of ["conversations", "historyEntries", "turnStreams", "memories", "dshSessions"] as const) {
      requireCount(value.purged[key], `eraseResult.purged.${key}`, problems);
    }
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return ingestDomainFact(value) as Readonly<ChildDataEraseResult>;
}

/**
 * Re-validate a deletion-ledger tombstone. Content-free by construction:
 * the shape carries ids + counts only (issue #21 交付范围 4: 审计中不暗存
 * 被删除的敏感正文 — there is no field for it).
 */
export function validateChildDataDeletionRecord(value: unknown): Readonly<ChildDataDeletionRecord> {
  const problems: ContractProblem[] = [];
  if (!isRecord(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "deletionRecord", "deletion record must be an object."),
    ]);
  }
  rejectUnknown(
    value,
    ["recordId", "seq", "at", "subjectRef", "action", "operatorRole", "purged"],
    "deletionRecord",
    problems,
  );
  requireBoundedString(value.recordId, "deletionRecord.recordId", 80, problems);
  requireBoundedString(value.subjectRef, "deletionRecord.subjectRef", 80, problems);
  requireBoundedString(value.at, "deletionRecord.at", 40, problems);
  if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 0) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "deletionRecord.seq", "seq must be a non-negative integer."));
  }
  if (typeof value.operatorRole !== "string" || value.operatorRole.length === 0 || value.operatorRole.length > 40) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "deletionRecord.operatorRole", "operatorRole must be a bounded string."));
  }
  if (value.action !== "erase_child_data" && value.action !== "replay_child_deletions") {
    problems.push(problem("CONTRACT_FIELD_INVALID", "deletionRecord.action", "action must be a registered data action."));
  }
  if (!isRecord(value.purged)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "deletionRecord.purged", "purged must be an object."));
  } else {
    for (const key of ["conversations", "historyEntries", "turnStreams", "memories", "dshSessions"] as const) {
      requireCount(value.purged[key], `deletionRecord.purged.${key}`, problems);
    }
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return ingestDomainFact(value) as Readonly<ChildDataDeletionRecord>;
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Bounded deletion ledger (tombstones only; content-free). */
export const MAX_DELETION_LEDGER_RECORDS = 100;

/** The single family child the lifecycle surface operates on (pinned). */
export const LIFECYCLE_FAMILY_CHILD_REF = GUARDIAN_FAMILY_CHILD_REF;

/** Operator role projection for ledger/audit facts (bounded vocabulary). */
export function lifecycleOperatorRole(role: ActorRole): string {
  return role;
}
