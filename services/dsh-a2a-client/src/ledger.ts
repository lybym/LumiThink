/**
 * P2-02 (issue #114) — persistent task ledger (ADR-0018 Appendix B
 * component 2; TASK_LIFECYCLE §7.4 first paragraph).
 *
 * Contract (ADR-0018 hard constraint 2):
 *   - `saveBeforeSend` runs BEFORE the wire request: stable messageId +
 *     original request + local mapping are durable first, so a crash after
 *     send never leaves an unrecoverable "which request was this?" hole.
 *   - `saveTaskId` runs the moment a Task id arrives (取得即落盘), before
 *     any polling/streaming continues.
 *   - The ledger is the ONLY local durable copy — no in-process Map may act
 *     as the source of truth; every write goes through the store.
 *   - Credentials/tokens are structurally excluded: records carry protocol
 *     payloads only, and the store refuses records containing bearer-like
 *     material (fail-closed; A2A_DESIGN §13.1 credential discipline).
 *
 * Storage decision (dispatch + ADR-0018 Appendix B): a single JSON document
 * written ATOMICALLY (tmp file + rename in the same directory). The client
 * is an EXTERNAL working-DSH component (A2A_DESIGN §3.2: no household
 * database access, no internal runtime), so sharing the server's SQLite
 * Task Manager store is not available to it; the atomic JSON file keeps the
 * ledger dependency-free and crash-safe. ADR-0018 Appendix B's "与 ADR-0013
 * 权威 Task Store 同库" line is consciously adapted for the external client
 * boundary — raised explicitly in the P2-02 PR/review record, not silently
 * deviated (the server-side store stays untouched and authoritative for
 * server state).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

import { DshA2aClientError } from './errors.ts';

/** Ledger document schema version (fail-closed on unknown future versions). */
export const LEDGER_SCHEMA_VERSION = 1;

/** Persistent cancel intent lifecycle (TASK_LIFECYCLE §7.3/§7.4/§9). */
export type LedgerCancelStatus =
  | 'requested'
  | 'confirmed_canceled'
  | 'already_terminal'
  | 'unconfirmed_timeout'
  | 'not_found'
  | 'failed';

export interface LedgerCancelIntent {
  requestedAtMs: number;
  reason: string;
  status: LedgerCancelStatus;
  /** Normalized task state observed at cancel resolution, when any. */
  settledTaskState?: string;
  /** Token-free detail (what the caller saw; kept for restart recovery). */
  detail?: string;
}

/** The original wire request, persisted verbatim BEFORE the first send. */
export interface LedgerOriginalRequest {
  method: 'message/send';
  /** The runtime Message object exactly as handed to the SDK client. */
  message: unknown;
  /** SendMessageConfiguration (returnImmediately mode metadata). */
  configuration?: unknown;
  tenant?: string;
}

export interface LedgerRecord {
  /** Stable client messageId (the idempotency anchor). */
  messageId: string;
  /** Agent base URL this request targets (maps records to one agent). */
  agentBaseUrl: string;
  createdAtMs: number;
  updatedAtMs: number;
  originalRequest: LedgerOriginalRequest;
  /** Whether the wire request used returnImmediately mode. */
  returnImmediately: boolean;
  /** Server task id — persisted the moment it is received (may stay absent). */
  taskId?: string;
  contextId?: string;
  /** Last observed normalized state name. */
  lastKnownState?: string;
  /** Number of §5.3 recovery resends performed for this record. */
  recoveryResends?: number;
  /** Pending or resolved cancel intent (durable across restarts). */
  cancelIntent?: LedgerCancelIntent;
  /** Set when this record is a follow-up pointing at an earlier task. */
  followUpOfTaskId?: string;
}

export interface LedgerDocument {
  version: number;
  updatedAtMs: number;
  records: Record<string, LedgerRecord>;
}

/**
 * Pluggable persistence face. The default implementation is FileTaskLedger;
 * an embedding host (the real working DSH) may back this interface with its
 * own profile storage — but an in-process Map must never be the only copy.
 */
export interface TaskLedger {
  saveBeforeSend(record: LedgerRecord): Promise<void>;
  saveTaskId(messageId: string, taskId: string, contextId: string): Promise<void>;
  recordState(messageId: string, state: string): Promise<void>;
  recordCancelIntent(messageId: string, intent: LedgerCancelIntent): Promise<void>;
  recordRecoveryResend(messageId: string): Promise<void>;
  recordFollowUp(messageId: string, followUpOfTaskId: string): Promise<void>;
  load(messageId: string): Promise<LedgerRecord | undefined>;
  loadByTaskId(taskId: string): Promise<LedgerRecord | undefined>;
  loadAll(): Promise<Record<string, LedgerRecord>>;
}

/** Catches bearer material before it can reach the durable store. */
function assertNoCredentialMaterial(record: LedgerRecord): void {
  const serialized = JSON.stringify(record);
  if (/bearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(serialized)) {
    throw new DshA2aClientError(
      'invalid_config',
      'Refusing to persist a ledger record containing bearer material ' +
        '(A2A_DESIGN §13.1: credentials never reach durable client records).',
    );
  }
}

export class FileTaskLedger implements TaskLedger {
  private readonly filePath: string;
  private cache: LedgerDocument | null = null;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    const dir = path.dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
  }

  /** Loads (or initializes) the document; unknown future versions refuse. */
  private read(): LedgerDocument {
    if (this.cache !== null) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = { version: LEDGER_SCHEMA_VERSION, updatedAtMs: Date.now(), records: {} };
      return this.cache;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new DshA2aClientError(
        'ledger_corrupt',
        `Task ledger file is not valid JSON: ${this.filePath}. Refusing to run ` +
          'fail-closed (the ledger is the only durable copy of pending operations).',
        { cause: error },
      );
    }
    const doc = parsed as { version?: unknown; records?: unknown };
    if (
      typeof doc !== 'object' ||
      doc === null ||
      typeof doc.version !== 'number' ||
      typeof doc.records !== 'object' ||
      doc.records === null
    ) {
      throw new DshA2aClientError(
        'ledger_corrupt',
        `Task ledger file has an unrecognized shape: ${this.filePath}. Refusing to run fail-closed.`,
      );
    }
    if (doc.version > LEDGER_SCHEMA_VERSION) {
      throw new DshA2aClientError(
        'ledger_corrupt',
        `Task ledger schema version ${doc.version} is NEWER than this build supports ` +
          `(${LEDGER_SCHEMA_VERSION}). Refusing to open (fail-closed).`,
      );
    }
    this.cache = doc as unknown as LedgerDocument;
    return this.cache;
  }

  /** Atomic replace: write tmp in the same directory, then rename over. */
  private flush(): void {
    const doc = this.read();
    doc.updatedAtMs = Date.now();
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
      renameSync(tmp, this.filePath);
    } catch (error) {
      try {
        if (existsSync(tmp)) rmSync(tmp);
      } catch {
        // cleanup failure must not mask the original error
      }
      throw new DshA2aClientError(
        'send_failed',
        `Failed to persist the task ledger at ${this.filePath}: the client refuses to ` +
          'continue without durable records (§7.4: 发送前落盘).',
        { cause: error },
      );
    }
  }

  private mutate(messageId: string, mutateFn: (record: LedgerRecord) => void): void {
    const doc = this.read();
    const record = doc.records[messageId];
    if (record === undefined) {
      throw new DshA2aClientError('invalid_config', `Ledger record missing for messageId ${messageId}`);
    }
    mutateFn(record);
    record.updatedAtMs = Date.now();
    this.flush();
  }

  async saveBeforeSend(record: LedgerRecord): Promise<void> {
    assertNoCredentialMaterial(record);
    const doc = this.read();
    doc.records[record.messageId] = structuredClone(record);
    this.flush();
  }

  async saveTaskId(messageId: string, taskId: string, contextId: string): Promise<void> {
    this.mutate(messageId, (record) => {
      record.taskId = taskId;
      if (contextId !== '') record.contextId = contextId;
    });
  }

  async recordState(messageId: string, state: string): Promise<void> {
    this.mutate(messageId, (record) => {
      record.lastKnownState = state;
    });
  }

  async recordCancelIntent(messageId: string, intent: LedgerCancelIntent): Promise<void> {
    this.mutate(messageId, (record) => {
      record.cancelIntent = intent;
    });
  }

  async recordRecoveryResend(messageId: string): Promise<void> {
    this.mutate(messageId, (record) => {
      record.recoveryResends = (record.recoveryResends ?? 0) + 1;
    });
  }

  async recordFollowUp(messageId: string, followUpOfTaskId: string): Promise<void> {
    this.mutate(messageId, (record) => {
      record.followUpOfTaskId = followUpOfTaskId;
    });
  }

  async load(messageId: string): Promise<LedgerRecord | undefined> {
    const doc = this.read();
    const record = doc.records[messageId];
    return record === undefined ? undefined : structuredClone(record);
  }

  async loadByTaskId(taskId: string): Promise<LedgerRecord | undefined> {
    const doc = this.read();
    for (const record of Object.values(doc.records)) {
      if (record.taskId === taskId) return structuredClone(record);
    }
    return undefined;
  }

  async loadAll(): Promise<Record<string, LedgerRecord>> {
    const doc = this.read();
    return structuredClone(doc.records);
  }
}
