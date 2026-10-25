/**
 * Versioned SQLite schema + migration for the unified Task Manager
 * repository (P1-02, issue #84). Driver: Node 24 built-in `node:sqlite`
 * (zero new dependencies — the repo precedent is
 * lib/server/voice-turn-sqlite-store.ts).
 *
 * MIGRATION POLICY (AC 4: 迁移/回滚风险有说明):
 *   - Schema lives entirely inside the isolated validation service; the
 *     frozen legacy Prisma schema is NOT touched (issue boundary: 旧 Prisma
 *     schema 保持冻结).
 *   - Each version applies ADDITIVE DDL inside ONE transaction and records
 *     the reached version in lumithink_a2a_meta.
 *   - A database written by an unknown FUTURE version refuses to open
 *     (fail-closed, same contract as the voice fence store).
 *   - Rollback risk: SQLite DDL is transactional, but application-level
 *     DOWNGRADES are not supported — rolling a newer database back to an
 *     older service build fails closed with schema_version_not_supported.
 *     The only supported rollback is restoring a DB file backup taken
 *     before the upgrade (deploy/validation owns backup/restore drills;
 *     P0 Gate dimension C = GO). v1 contains no destructive statements.
 *
 * SYNTHETIC data only (P1 口径): ids, states, counters, hex digests and
 * synthetic validation text. No real child audio/text/credentials may be
 * stored here (P1-10/#92 gates real execution).
 */

import { DatabaseSync } from 'node:sqlite';
import { TaskManagerError } from './errors.ts';

export const A2A_TASK_MANAGER_SCHEMA_VERSION = 1;

interface SchemaMigration {
  readonly version: number;
  readonly ddl: string;
}

/**
 * v1 (issue #84): Task / Conversation / Turn / Execution / Request Ledger /
 * Outbox / Artifacts(+chunks) / Task history. Terminal irreversibility is a
 * DATABASE constraint (trigger), not only application logic.
 */
const MIGRATION_V1: SchemaMigration = {
  version: 1,
  ddl: `
    CREATE TABLE IF NOT EXISTS a2a_conversations (
      context_id    TEXT PRIMARY KEY,
      created_at_ms INTEGER NOT NULL,
      metadata_json TEXT
    );

    -- Authoritative task state row. ONLY the repository writes it.
    CREATE TABLE IF NOT EXISTS a2a_tasks (
      task_id            TEXT PRIMARY KEY,
      context_id         TEXT NOT NULL REFERENCES a2a_conversations(context_id),
      current_state      TEXT NOT NULL CHECK (current_state IN (
        'submitted','working','input_required','auth_required',
        'completed','failed','canceled','rejected')),
      state_version      INTEGER NOT NULL CHECK (state_version >= 1),
      created_at_ms      INTEGER NOT NULL,
      updated_at_ms      INTEGER NOT NULL,
      terminal_at_ms     INTEGER,
      status_message_json TEXT,
      metadata_json      TEXT,
      cancel_intent      INTEGER NOT NULL DEFAULT 0 CHECK (cancel_intent IN (0,1)),
      cancel_requested_at_ms INTEGER,
      cancel_reason      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_a2a_tasks_context ON a2a_tasks(context_id);
    CREATE INDEX IF NOT EXISTS idx_a2a_tasks_state ON a2a_tasks(current_state);

    -- Turn: one task MAY have multiple sequential turns (补充输入 → next turn);
    -- epoch is the per-turn execution generation used by conditional updates
    -- and callback attribution. UNIQUE(task_id, epoch): at most one execution
    -- generation per epoch, so a stale-epoch callback maps to NO execution.
    CREATE TABLE IF NOT EXISTS a2a_turns (
      task_id        TEXT NOT NULL REFERENCES a2a_tasks(task_id),
      turn_seq       INTEGER NOT NULL CHECK (turn_seq >= 1),
      epoch          INTEGER NOT NULL CHECK (epoch >= 1),
      input_message_json TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      output_admission TEXT NOT NULL DEFAULT 'open' CHECK (output_admission IN ('open','closed')),
      cancel_intent  INTEGER NOT NULL DEFAULT 0 CHECK (cancel_intent IN (0,1)),
      created_at_ms  INTEGER NOT NULL,
      closed_at_ms   INTEGER,
      PRIMARY KEY (task_id, turn_seq),
      UNIQUE (task_id, epoch)
    );

    -- Execution: dispatch/lease record; epoch + lease are the callback
    -- attribution keys (TASK_LIFECYCLE §2: 每个回调必须关联 task/turn/
    -- execution/epoch/worker_lease).
    CREATE TABLE IF NOT EXISTS a2a_executions (
      execution_id    TEXT PRIMARY KEY,
      task_id         TEXT NOT NULL,
      turn_seq        INTEGER NOT NULL,
      epoch           INTEGER NOT NULL CHECK (epoch >= 1),
      lease_id        TEXT,
      lease_expires_at_ms INTEGER,
      state           TEXT NOT NULL CHECK (state IN (
        'registered','running','stop_requested','settled','abandoned')),
      worker_id       TEXT,
      created_at_ms   INTEGER NOT NULL,
      settled_at_ms   INTEGER,
      result_json     TEXT,
      UNIQUE (task_id, epoch),
      FOREIGN KEY (task_id, turn_seq) REFERENCES a2a_turns(task_id, turn_seq)
    );
    CREATE INDEX IF NOT EXISTS idx_a2a_executions_task ON a2a_executions(task_id);

    -- Request Ledger: idempotency key (canonical request key) → task mapping
    -- with a versioned request fingerprint and tombstones (§5).
    CREATE TABLE IF NOT EXISTS a2a_request_ledger (
      request_key   TEXT PRIMARY KEY,
      fingerprint   TEXT NOT NULL,
      task_id       TEXT NOT NULL REFERENCES a2a_tasks(task_id),
      created_at_ms INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','tombstoned'))
    );

    -- Transactional Outbox: committed-pending events with task-scoped
    -- monotonic seq; publication happens OUTSIDE write transactions.
    CREATE TABLE IF NOT EXISTS a2a_outbox (
      task_id       TEXT NOT NULL REFERENCES a2a_tasks(task_id),
      seq           INTEGER NOT NULL CHECK (seq >= 1),
      kind          TEXT NOT NULL CHECK (kind IN (
        'task','statusUpdate','artifactUpdate','cancelCommand','turnAccepted')),
      payload_json  TEXT NOT NULL,
      artifact_id   TEXT,
      chunk_id      TEXT,
      created_at_ms INTEGER NOT NULL,
      published_at_ms INTEGER,
      PRIMARY KEY (task_id, seq)
    );

    -- Admitted public artifacts (Task Manager is the ONLY writer, §6).
    CREATE TABLE IF NOT EXISTS a2a_artifacts (
      task_id       TEXT NOT NULL REFERENCES a2a_tasks(task_id),
      artifact_id   TEXT NOT NULL,
      name          TEXT,
      description   TEXT,
      metadata_json TEXT,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (task_id, artifact_id)
    );

    -- Append-only admitted chunks: stable chunk id/position/digest; redelivery
    -- never rewrites an admitted chunk (公开后不改写前缀, §6.1).
    CREATE TABLE IF NOT EXISTS a2a_artifact_chunks (
      task_id       TEXT NOT NULL,
      artifact_id   TEXT NOT NULL,
      chunk_seq     INTEGER NOT NULL CHECK (chunk_seq >= 1),
      chunk_id      TEXT NOT NULL,
      text          TEXT NOT NULL DEFAULT '',
      part_json     TEXT,
      start_byte    INTEGER NOT NULL CHECK (start_byte >= 0),
      end_byte      INTEGER NOT NULL CHECK (end_byte >= start_byte),
      sha256        TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (task_id, artifact_id, chunk_seq),
      UNIQUE (task_id, artifact_id, chunk_id),
      FOREIGN KEY (task_id, artifact_id) REFERENCES a2a_artifacts(task_id, artifact_id)
    );

    -- Task history (conversation messages bound to the task aggregate).
    CREATE TABLE IF NOT EXISTS a2a_task_history (
      task_id       TEXT NOT NULL REFERENCES a2a_tasks(task_id),
      seq           INTEGER NOT NULL CHECK (seq >= 1),
      message_id    TEXT NOT NULL,
      message_json  TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (task_id, seq),
      UNIQUE (task_id, message_id)
    );

    -- DB-level terminal irreversibility: no UPDATE may move a terminal task
    -- row to a different state (TASK_LIFECYCLE §3: 终态不可逆有约束).
    CREATE TRIGGER IF NOT EXISTS trg_a2a_tasks_terminal_immutable
    BEFORE UPDATE ON a2a_tasks
    WHEN OLD.current_state IN ('completed','failed','canceled','rejected')
      AND NEW.current_state <> OLD.current_state
    BEGIN
      SELECT RAISE(ABORT, 'a2a terminal task state is irreversible');
    END;
  `,
};

const MIGRATIONS: readonly SchemaMigration[] = [MIGRATION_V1];

const META_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS lumithink_a2a_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const VERSION_KEY = 'schema_version';

function readSchemaVersion(db: DatabaseSync): number {
  const row = db
    .prepare('SELECT value FROM lumithink_a2a_meta WHERE key = ?')
    .get(VERSION_KEY) as { value: string } | undefined;
  if (!row) return 0;
  const version = Number(row.value);
  if (!Number.isInteger(version) || version < 0) {
    throw new TaskManagerError(
      'schema_version_not_supported',
      `lumithink_a2a_meta.schema_version is not a valid integer: ${row.value}`,
    );
  }
  return version;
}

/**
 * Applies pending migrations inside single transactions. Fail-closed when
 * the database was written by a NEWER schema version than this build knows
 * (no guessing, no destructive downgrade).
 */
export function migrateTaskManagerSchema(db: DatabaseSync): number {
  db.exec(META_TABLE_DDL);
  const current = readSchemaVersion(db);
  if (current > A2A_TASK_MANAGER_SCHEMA_VERSION) {
    throw new TaskManagerError(
      'schema_version_not_supported',
      `Database schema version ${current} is NEWER than this build supports ` +
        `(${A2A_TASK_MANAGER_SCHEMA_VERSION}). Refusing to open (fail-closed; ` +
        'roll back by restoring a database file backup, never by editing rows).',
    );
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.ddl);
      db.prepare(
        'INSERT INTO lumithink_a2a_meta (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(VERSION_KEY, String(migration.version));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return readSchemaVersion(db);
}

/** Opens the database, applies pragmas, and runs the versioned migration. */
export function openTaskManagerDatabase(options: {
  dbPath: string;
  busyTimeoutMs: number;
}): { db: DatabaseSync; schemaVersion: number } {
  const db = new DatabaseSync(options.dbPath);
  try {
    // WAL lets readers proceed while a writer holds the write lock; the
    // bounded busy_timeout is the ONLY allowed in-transaction wait (no
    // model/network waits ever happen inside repository transactions).
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs))}`);
    const schemaVersion = migrateTaskManagerSchema(db);
    return { db, schemaVersion };
  } catch (error) {
    try {
      db.close();
    } catch {
      // ignore close failures on the error path
    }
    throw error;
  }
}
