/**
 * Versioned SQLite schema + migration for the identity & authorization
 * store (P1-03, issue #85). Driver: Node 24 built-in `node:sqlite`
 * (zero new dependencies — same precedent as the P1-02 Task Manager).
 *
 * SEPARATE STORE RATIONALE (ADR-0014): the identity layer is a distinct
 * module from the Task Manager repository (P1-02). It owns its own SQLite
 * database (default ':memory:' for standalone/CI runs) with an independent
 * version counter in `lumithink_a2a_identity_meta`. The Task Manager schema
 * (v1, issue #84) stays byte-identical — no coupling, no cross-module
 * migration ordering. Design §2.3 requires storage boundaries that support
 * later splitting; per-module databases are the strictest form of that.
 *
 * MIGRATION POLICY (mirrors task-manager/schema.ts, AC 4):
 *   - Each version applies ADDITIVE DDL inside ONE transaction and records
 *     the reached version in lumithink_a2a_identity_meta.
 *   - A database written by an unknown FUTURE version refuses to open
 *     (fail-closed). Application-level downgrades are not supported; the
 *     only supported rollback is restoring a DB file backup.
 *   - v1 contains no destructive statements.
 *
 * SYNTHETIC data only (P1 口径): household/user/membership/relationship/
 * client/credential/grant rows are synthetic validation data. Tokens are
 * stored ONLY as SHA-256 digests (design §5.2: 服务端只保存令牌摘要) and
 * audit rows never contain token material or message content (最小审计).
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash, timingSafeEqual } from 'node:crypto';
import { IdentityError } from './model.ts';

export const A2A_IDENTITY_SCHEMA_VERSION = 2;

/** Meta keys. */
export const IDENTITY_META_SCHEMA_VERSION = 'schema_version';
export const IDENTITY_META_REVOCATION_EPOCH = 'revocation_epoch';

interface IdentityMigration {
  readonly version: number;
  readonly ddl: string;
}

/**
 * v1 (issue #85): households / users / memberships / relationships /
 * clients / credentials (digest only) / short-term grants / task bindings /
 * minimal audit log. All revocation-sensitive mutations bump the global
 * `revocation_epoch` so cached authorization decisions invalidate (AC 3).
 */
const IDENTITY_MIGRATION_V1: IdentityMigration = {
  version: 1,
  ddl: `
    CREATE TABLE IF NOT EXISTS a2a_identity_households (
      household_id  TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      created_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS a2a_identity_users (
      user_id       TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      created_at_ms INTEGER NOT NULL
    );

    -- 角色在家庭内生效 (design §5.1): NOT a global user role.
    CREATE TABLE IF NOT EXISTS a2a_identity_memberships (
      household_id  TEXT NOT NULL REFERENCES a2a_identity_households(household_id),
      user_id       TEXT NOT NULL REFERENCES a2a_identity_users(user_id),
      role          TEXT NOT NULL CHECK (role IN ('guardian','child','member')),
      status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
      created_at_ms INTEGER NOT NULL,
      revoked_at_ms INTEGER,
      PRIMARY KEY (household_id, user_id)
    );

    -- 监护关系: 不能仅凭“家长”角色访问任意儿童 (design §5.1).
    CREATE TABLE IF NOT EXISTS a2a_identity_relationships (
      household_id    TEXT NOT NULL,
      guardian_user_id TEXT NOT NULL REFERENCES a2a_identity_users(user_id),
      child_user_id   TEXT NOT NULL REFERENCES a2a_identity_users(user_id),
      status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
      created_at_ms   INTEGER NOT NULL,
      revoked_at_ms   INTEGER,
      PRIMARY KEY (household_id, guardian_user_id, child_user_id)
    );

    CREATE TABLE IF NOT EXISTS a2a_identity_clients (
      client_id     TEXT PRIMARY KEY,
      kind          TEXT NOT NULL CHECK (kind IN ('dsh_profile','feishu_adapter','xiaozhi_device')),
      display_name  TEXT NOT NULL,
      -- xiaozhi_device REQUIRES a bound household (设备仅认证家庭);
      -- dsh_profile / feishu_adapter resolve the household per credential.
      household_id  TEXT REFERENCES a2a_identity_households(household_id),
      status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      created_at_ms INTEGER NOT NULL
    );

    -- Bearer credentials bind BOTH tiers server-side (design §5.2).
    -- token_sha256: raw tokens are never persisted.
    CREATE TABLE IF NOT EXISTS a2a_identity_credentials (
      credential_id   TEXT PRIMARY KEY,
      client_id       TEXT NOT NULL REFERENCES a2a_identity_clients(client_id),
      token_sha256    TEXT NOT NULL UNIQUE,
      binding         TEXT NOT NULL CHECK (binding IN ('bound_principal','client_only')),
      principal_user_id TEXT REFERENCES a2a_identity_users(user_id),
      household_id    TEXT REFERENCES a2a_identity_households(household_id),
      scope_json      TEXT,
      issued_at_ms    INTEGER NOT NULL,
      expires_at_ms   INTEGER,
      revoked_at_ms   INTEGER,
      status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired'))
    );

    -- Short-term grants (设备会话确认 / 声纹候选): 范围 + 期限 + 会话绑定 +
    -- 撤销 (design §5.2/§6.2). Voiceprint candidates NEVER carry a verified user.
    CREATE TABLE IF NOT EXISTS a2a_identity_grants (
      grant_id       TEXT PRIMARY KEY,
      client_id      TEXT NOT NULL REFERENCES a2a_identity_clients(client_id),
      household_id   TEXT NOT NULL REFERENCES a2a_identity_households(household_id),
      kind           TEXT NOT NULL CHECK (kind IN ('session_verified','voiceprint_candidate')),
      user_id        TEXT REFERENCES a2a_identity_users(user_id),
      candidate_user_id TEXT REFERENCES a2a_identity_users(user_id),
      session_binding TEXT NOT NULL,
      scope_json     TEXT NOT NULL,
      issued_at_ms   INTEGER NOT NULL,
      expires_at_ms  INTEGER NOT NULL,
      revoked_at_ms  INTEGER,
      status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','expired')),
      CHECK ((kind = 'session_verified' AND user_id IS NOT NULL AND candidate_user_id IS NULL)
          OR (kind = 'voiceprint_candidate' AND user_id IS NULL AND candidate_user_id IS NOT NULL))
    );

    -- Task/Conversation ownership recorded at acceptance time (design §5.1
    -- task_binding). Identity DB is authoritative for ACL; the Task Manager
    -- row stays untouched (no cross-module schema change).
    CREATE TABLE IF NOT EXISTS a2a_identity_task_bindings (
      task_id          TEXT PRIMARY KEY,
      context_id       TEXT NOT NULL,
      household_id     TEXT NOT NULL,
      principal_user_id TEXT,
      client_id        TEXT NOT NULL,
      client_kind      TEXT NOT NULL CHECK (client_kind IN ('dsh_profile','feishu_adapter','xiaozhi_device')),
      created_at_ms    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_a2a_identity_task_bindings_context
      ON a2a_identity_task_bindings(context_id);

    -- Minimal audit log: decision facts only (AC 3). No tokens, no message
    -- content, no child data — ever.
    CREATE TABLE IF NOT EXISTS a2a_identity_audit (
      audit_id        INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms           INTEGER NOT NULL,
      action          TEXT NOT NULL,
      decision        TEXT NOT NULL CHECK (decision IN ('allow','deny')),
      reason          TEXT NOT NULL,
      credential_id   TEXT,
      client_id       TEXT,
      principal_user_id TEXT,
      household_id    TEXT,
      task_id         TEXT,
      context_id      TEXT
    );
  `,
};

/**
 * v2 (issue #85 Step 05 review fix): task bindings record the ACCEPTING
 * credential, the elevating grant (when any) and the principal kind, so the
 * executor output-admission gate can re-validate the FULL acceptance chain
 * (credential → client → user/membership → grant → policy) against CURRENT
 * state — credential/grant revocation now closes tool submission, not only
 * the transport stream. Purely additive ALTER TABLE; pre-v2 rows (which can
 * only exist in throwaway pre-release stores) get NULL attribution and are
 * denied fail-closed by the gate.
 */
const IDENTITY_MIGRATION_V2: IdentityMigration = {
  version: 2,
  ddl: `
    ALTER TABLE a2a_identity_task_bindings ADD COLUMN credential_id TEXT;
    ALTER TABLE a2a_identity_task_bindings ADD COLUMN grant_id TEXT;
    ALTER TABLE a2a_identity_task_bindings ADD COLUMN principal_kind TEXT NOT NULL DEFAULT 'user'
      CHECK (principal_kind IN ('user','candidate','visitor'));
    CREATE INDEX IF NOT EXISTS idx_a2a_identity_task_bindings_credential
      ON a2a_identity_task_bindings(credential_id);
    CREATE INDEX IF NOT EXISTS idx_a2a_identity_task_bindings_grant
      ON a2a_identity_task_bindings(grant_id);
  `,
};

const IDENTITY_MIGRATIONS: readonly IdentityMigration[] = [IDENTITY_MIGRATION_V1, IDENTITY_MIGRATION_V2];

const IDENTITY_META_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS lumithink_a2a_identity_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

function readIdentitySchemaVersion(db: DatabaseSync): number {
  const row = db
    .prepare('SELECT value FROM lumithink_a2a_identity_meta WHERE key = ?')
    .get(IDENTITY_META_SCHEMA_VERSION) as { value: string } | undefined;
  if (!row) return 0;
  const version = Number(row.value);
  if (!Number.isInteger(version) || version < 0) {
    throw new IdentityError(
      'invalid_input',
      `lumithink_a2a_identity_meta.schema_version is not a valid integer: ${row.value}`,
    );
  }
  return version;
}

/**
 * Applies pending migrations inside single transactions. Fail-closed when
 * the database was written by a NEWER schema version than this build knows.
 */
export function migrateIdentitySchema(db: DatabaseSync): number {
  db.exec(IDENTITY_META_TABLE_DDL);
  const current = readIdentitySchemaVersion(db);
  if (current > A2A_IDENTITY_SCHEMA_VERSION) {
    throw new IdentityError(
      'invalid_input',
      `Identity database schema version ${current} is NEWER than this build supports ` +
        `(${A2A_IDENTITY_SCHEMA_VERSION}). Refusing to open (fail-closed; ` +
        'roll back by restoring a database file backup, never by editing rows).',
    );
  }
  for (const migration of IDENTITY_MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.ddl);
      db.prepare(
        'INSERT INTO lumithink_a2a_identity_meta (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(IDENTITY_META_SCHEMA_VERSION, String(migration.version));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return readIdentitySchemaVersion(db);
}

/** Opens the identity database, applies pragmas, runs the versioned migration. */
export function openIdentityDatabase(options: {
  dbPath: string;
  busyTimeoutMs: number;
}): { db: DatabaseSync; schemaVersion: number } {
  const db = new DatabaseSync(options.dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs))}`);
    const schemaVersion = migrateIdentitySchema(db);
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

/** SHA-256 hex digest of a presented token — the ONLY stored credential form. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Constant-time string comparison via digests (length-independent). */
export function timingSafeHexEquals(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
