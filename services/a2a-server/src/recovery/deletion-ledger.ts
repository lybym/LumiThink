/**
 * Independent deletion ledger (P1-08, issue #90; TASK_LIFECYCLE §9,
 * A2A_DESIGN §11.2).
 *
 * 处理授权撤回/删除优先于常规留存。The ledger records EVERY orchestrated
 * body deletion (taskId + scope + reason + time) in ITS OWN SQLite database
 * — deliberately separate from the Task Manager database, because the Task
 * Manager DB is exactly what a backup/restore rolls back. The contract
 * (TASK_LIFECYCLE §9): 删除台账及当前撤权记录独立于可回滚快照保存；恢复时
 * 先重放删除和撤权、清理缓存及待发事件，再开放服务 — a restored old
 * snapshot must never resurrect deleted body, so before the service opens
 * (or as the first startup-recovery step) every recorded deletion is
 * REPLAYED against the current database (idempotent `purgeTaskBody`).
 *
 * Fail-closed schema contract (same policy as the task/identity stores):
 * versioned additive DDL, unknown future versions refuse to open. Entries
 * are append-only — deletions are facts, never rewritten.
 *
 * SYNTHETIC data only (P1 口径) — ids, scope labels, reason codes,
 * timestamps. No body, no digests, no credentials.
 */
import { DatabaseSync } from 'node:sqlite';
import type { SqliteTaskManager } from '../task-manager/sqlite-task-manager.ts';

export const DELETION_LEDGER_SCHEMA_VERSION = 1;

export interface DeletionLedgerEntry {
  ledgerSeq: number;
  taskId: string;
  /** Scope label, e.g. 'household:hh-1' / 'principal:hh-1:u-1' / 'task:<id>'. */
  scope: string;
  /** Stable reason code, e.g. 'processing_authorization_withdrawn'. */
  reason: string;
  deletedAtMs: number;
}

export interface DeletionLedgerOptions {
  /**
   * Dedicated SQLite file for the ledger. ':memory:' keeps standalone/CI
   * runs stateless; durable deployments MUST set a real path — an in-memory
   * ledger cannot survive a process crash, which would leave a restored old
   * snapshot unguarded.
   */
  dbPath: string;
  /** Injectable wall clock (ms epoch) for deterministic tests. */
  now?: () => number;
}

export class DeletionLedger {
  readonly dbPath: string;
  readonly schemaVersion: number;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private closed = false;

  constructor(options: DeletionLedgerOptions) {
    if (typeof options.dbPath !== 'string' || options.dbPath.length === 0) {
      throw new Error('deletion ledger dbPath must be a non-empty string');
    }
    this.dbPath = options.dbPath;
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(options.dbPath);
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS lumithink_a2a_deletion_ledger_meta (
           key   TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );`,
      );
      this.schemaVersion = this.migrate();
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // ignore close failures on the error path
      }
      throw error;
    }
  }

  private migrate(): number {
    const read = (): number => {
      const row = this.db
        .prepare(
          "SELECT value FROM lumithink_a2a_deletion_ledger_meta WHERE key = 'schema_version'",
        )
        .get() as { value: string } | undefined;
      if (row === undefined) return 0;
      const version = Number(row.value);
      if (!Number.isInteger(version) || version < 0) {
        throw new Error(
          `deletion ledger schema_version is not a valid integer: ${row.value}`,
        );
      }
      return version;
    };
    const current = read();
    if (current > DELETION_LEDGER_SCHEMA_VERSION) {
      throw new Error(
        `Deletion ledger schema version ${current} is NEWER than this build supports ` +
          `(${DELETION_LEDGER_SCHEMA_VERSION}). Refusing to open (fail-closed).`,
      );
    }
    if (current < 1) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS lumithink_a2a_deletion_ledger (
            ledger_seq    INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id       TEXT NOT NULL,
            scope         TEXT NOT NULL,
            reason        TEXT NOT NULL,
            deleted_at_ms INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_deletion_ledger_task
            ON lumithink_a2a_deletion_ledger(task_id);
        `);
        this.db
          .prepare(
            'INSERT INTO lumithink_a2a_deletion_ledger_meta (key, value) VALUES (?, ?) ' +
              'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          )
          .run('schema_version', String(DELETION_LEDGER_SCHEMA_VERSION));
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    return read();
  }

  /**
   * Records a deletion fact BEFORE the body purge runs (record-then-purge:
   * a crash between the two leaves a ledger entry whose replay re-applies
   * the purge — the safe direction is always deletion-wins). Append-only.
   */
  recordTaskDeletion(params: { taskId: string; scope: string; reason: string }): void {
    this.assertOpen();
    if (params.taskId.trim() === '' || params.scope.trim() === '' || params.reason.trim() === '') {
      throw new Error('deletion ledger entries require taskId, scope and reason');
    }
    this.db
      .prepare(
        'INSERT INTO lumithink_a2a_deletion_ledger (task_id, scope, reason, deleted_at_ms) VALUES (?, ?, ?, ?)',
      )
      .run(params.taskId, params.scope, params.reason, this.now());
  }

  entries(): DeletionLedgerEntry[] {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT * FROM lumithink_a2a_deletion_ledger ORDER BY ledger_seq')
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      ledgerSeq: row['ledger_seq'] as number,
      taskId: row['task_id'] as string,
      scope: row['scope'] as string,
      reason: row['reason'] as string,
      deletedAtMs: row['deleted_at_ms'] as number,
    }));
  }

  /**
   * Replays every recorded deletion against the CURRENT Task Manager
   * database (restore drill: any body an old snapshot brought back is
   * purged again — 已删数据不能复活). Idempotent: `purgeTaskBody` is
   * deletion-idempotent (alreadyPurged). Tasks that do not exist in the
   * current database are reported (nothing to purge — the restore predates
   * the task or the ledger covered a deleted row) and NOT treated as errors.
   */
  replayAgainst(
    taskManager: SqliteTaskManager,
  ): { reapplied: number; alreadyPurged: number; missingTaskIds: string[] } {
    this.assertOpen();
    let reapplied = 0;
    let alreadyPurged = 0;
    const missingTaskIds: string[] = [];
    for (const entry of this.entries()) {
      if (!taskManager.taskExists(entry.taskId)) {
        missingTaskIds.push(entry.taskId);
        continue;
      }
      const result = taskManager.purgeTaskBody(entry.taskId);
      if (result.alreadyPurged) alreadyPurged += 1;
      else reapplied += 1;
    }
    return { reapplied, alreadyPurged, missingTaskIds };
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('deletion ledger is closed');
  }
}
