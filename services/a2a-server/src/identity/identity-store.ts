/**
 * SQLite-backed identity & authorization store (P1-03, issue #85).
 *
 * Owns: households / users / memberships / relationships / clients /
 * credentials (digest only) / short-term grants / task bindings / minimal
 * audit log, plus the global `revocation_epoch`.
 *
 * Revocation coherence (AC 3): every revocation-sensitive mutation bumps
 * `revocation_epoch`. The authorizer's decision cache is keyed by that
 * epoch, so a revoked credential/membership/grant invalidates cached
 * decisions IMMEDIATELY — there is no TTL window a revoked principal could
 * exploit. Seeding new credentials also bumps the epoch (fail-closed
 * default: an empty directory authorizes nobody).
 *
 * Module boundary: this store NEVER touches the Task Manager database or
 * schema (P1-02 stays frozen); task ownership lives in
 * a2a_identity_task_bindings, written only through bindTask() at acceptance
 * time by the authorizing Task Store decorator.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  AUTH_OPERATIONS,
  IdentityError,
  type AssuranceLevel,
  type AuditEntry,
  type AuthContext,
  type ClientKind,
  type GrantRecord,
  type MembershipRole,
  type Operation,
  type TaskBinding,
} from './model.ts';
import {
  IDENTITY_META_REVOCATION_EPOCH,
  openIdentityDatabase,
  sha256Hex,
} from './schema.ts';

// ---------------------------------------------------------------------------
// Bootstrap (synthetic provisioning for the validation service)
// ---------------------------------------------------------------------------

export interface BootstrapHousehold {
  householdId: string;
  displayName: string;
}
export interface BootstrapUser {
  userId: string;
  displayName: string;
}
export interface BootstrapMembership {
  householdId: string;
  userId: string;
  role: MembershipRole;
}
export interface BootstrapRelationship {
  householdId: string;
  guardianUserId: string;
  childUserId: string;
}
export interface BootstrapClient {
  clientId: string;
  kind: ClientKind;
  displayName: string;
  /** Only xiaozhi_device clients may bind a household (设备仅认证家庭). */
  householdId?: string;
}
export interface BootstrapCredential {
  credentialId: string;
  clientId: string;
  /** Plaintext ONLY in provisioning input; the store keeps the digest. */
  token: string;
  binding: 'bound_principal' | 'client_only';
  principalUserId?: string;
  householdId?: string;
  expiresAtMs?: number;
}
export interface BootstrapGrant {
  grantId: string;
  clientId: string;
  householdId: string;
  kind: 'session_verified' | 'voiceprint_candidate';
  userId?: string;
  candidateUserId?: string;
  sessionBinding: string;
  scope: readonly Operation[];
  expiresAtMs: number;
}
export interface IdentityBootstrap {
  households: readonly BootstrapHousehold[];
  users: readonly BootstrapUser[];
  memberships: readonly BootstrapMembership[];
  relationships: readonly BootstrapRelationship[];
  clients: readonly BootstrapClient[];
  credentials: readonly BootstrapCredential[];
  grants: readonly BootstrapGrant[];
}

const ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;

function assertId(field: string, value: string | undefined, required = true): void {
  if (value === undefined || value === '') {
    if (required) throw new IdentityError('invalid_input', `${field} is required`);
    return;
  }
  if (!ID_PATTERN.test(value)) {
    throw new IdentityError('invalid_input', `${field} must match ${ID_PATTERN}`);
  }
}

/**
 * Default synthetic directory for the standalone validation service: the
 * required bearer token becomes the single principal-bound credential of a
 * synthetic validation harness client acting as guardian of one synthetic
 * household. This keeps the P1-01/P1-02 single-token contract working while
 * every request resolves through the real two-tier path (client + principal).
 */
export function defaultValidationBootstrap(bearerToken: string): IdentityBootstrap {
  return {
    households: [{ householdId: 'hh-synthetic-01', displayName: 'Synthetic validation household' }],
    users: [
      { userId: 'user-guardian-synthetic', displayName: 'Synthetic guardian' },
      { userId: 'user-child-synthetic', displayName: 'Synthetic child' },
    ],
    memberships: [
      { householdId: 'hh-synthetic-01', userId: 'user-guardian-synthetic', role: 'guardian' },
      { householdId: 'hh-synthetic-01', userId: 'user-child-synthetic', role: 'child' },
    ],
    relationships: [
      {
        householdId: 'hh-synthetic-01',
        guardianUserId: 'user-guardian-synthetic',
        childUserId: 'user-child-synthetic',
      },
    ],
    clients: [
      {
        clientId: 'validation-harness',
        kind: 'dsh_profile',
        displayName: 'Synthetic validation harness (dsh_profile)',
      },
    ],
    credentials: [
      {
        credentialId: 'cred-validation-harness',
        clientId: 'validation-harness',
        token: bearerToken,
        binding: 'bound_principal',
        principalUserId: 'user-guardian-synthetic',
        householdId: 'hh-synthetic-01',
      },
    ],
    grants: [],
  };
}

/**
 * Strictly parses and validates the LUMITHINK_A2A_IDENTITY_BOOTSTRAP JSON.
 * Unknown fields, duplicate ids/tokens and dangling references all fail
 * closed (the service refuses to start rather than boot with a half-seeded
 * directory).
 */
export function parseIdentityBootstrap(json: string): IdentityBootstrap {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const requiredLists = [
    'households',
    'users',
    'memberships',
    'relationships',
    'clients',
    'credentials',
    'grants',
  ] as const;
  for (const key of Object.keys(raw)) {
    if (!requiredLists.includes(key as (typeof requiredLists)[number])) {
      throw new IdentityError('invalid_input', `Unknown bootstrap field: ${key}`);
    }
  }
  const bootstrap = raw as unknown as IdentityBootstrap;
  for (const key of requiredLists) {
    if (!Array.isArray(bootstrap[key])) {
      throw new IdentityError('invalid_input', `Bootstrap field ${key} must be an array`);
    }
  }
  return bootstrap;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export interface CredentialRow {
  credentialId: string;
  clientId: string;
  tokenSha256: string;
  binding: 'bound_principal' | 'client_only';
  principalUserId: string | null;
  householdId: string | null;
  issuedAtMs: number;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  status: 'active' | 'revoked' | 'expired';
}

export interface MembershipRow {
  householdId: string;
  userId: string;
  role: MembershipRole;
  status: 'active' | 'revoked';
}

export interface ClientRow {
  clientId: string;
  kind: ClientKind;
  displayName: string;
  householdId: string | null;
  status: 'active' | 'disabled';
}

export interface AuditActor {
  credentialId?: string | null;
  clientId?: string | null;
  principalUserId?: string | null;
  householdId?: string | null;
  taskId?: string | null;
  contextId?: string | null;
}

export interface IdentityStoreOptions {
  dbPath: string;
  busyTimeoutMs?: number;
  /** Injectable wall clock for deterministic expiry tests. */
  now?: () => number;
}

export class IdentityStore {
  private readonly db: DatabaseSync;
  private readonly nowFn: () => number;
  private closed = false;

  constructor(options: IdentityStoreOptions) {
    const opened = openIdentityDatabase({
      dbPath: options.dbPath,
      busyTimeoutMs: options.busyTimeoutMs ?? 5000,
    });
    this.db = opened.db;
    this.nowFn = options.now ?? (() => Date.now());
    // Ensure the epoch counter exists before any decision can be cached.
    this.db
      .prepare(
        'INSERT INTO lumithink_a2a_identity_meta (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO NOTHING',
      )
      .run(IDENTITY_META_REVOCATION_EPOCH, '0');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new IdentityError('invalid_input', 'Identity store is closed');
  }

  private now(): number {
    return this.nowFn();
  }

  // -------------------------------------------------------------------------
  // Revocation epoch
  // -------------------------------------------------------------------------

  get revocationEpoch(): number {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT value FROM lumithink_a2a_identity_meta WHERE key = ?')
      .get(IDENTITY_META_REVOCATION_EPOCH) as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  /** Bumps the epoch inside the CURRENT open transaction (or standalone). */
  private bumpEpochLocked(): void {
    this.db
      .prepare(
        'INSERT INTO lumithink_a2a_identity_meta (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)',
      )
      .run(IDENTITY_META_REVOCATION_EPOCH, '0');
  }

  private withWriteTransaction<T>(body: () => T): T {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      this.bumpEpochLocked();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Like withWriteTransaction, but bumps the epoch ONLY when the body
   * reports an actual mutation — a no-op revocation must not invalidate
   * cached decisions (the epoch counts real revocation events).
   */
  private withConditionalBumpTransaction(body: () => boolean): boolean {
    this.assertOpen();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = body();
      if (changed) this.bumpEpochLocked();
      this.db.exec('COMMIT');
      return changed;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Provisioning
  // -------------------------------------------------------------------------

  /**
   * Applies a full bootstrap in ONE transaction. Duplicate rows or dangling
   * references throw and roll back the whole directory. Bumps the epoch so
   * caches never serve decisions from before the seed.
   */
  applyBootstrap(bootstrap: IdentityBootstrap): void {
    this.withWriteTransaction(() => {
      const nowMs = this.now();
      const seenHouseholds = new Set<string>();
      const seenUsers = new Set<string>();
      const seenClients = new Set<string>();
      const seenCredentials = new Set<string>();
      const seenTokens = new Set<string>();
      const seenGrants = new Set<string>();

      const insertHousehold = (h: BootstrapHousehold): void => {
        assertId('householdId', h.householdId);
        if (typeof h.displayName !== 'string' || h.displayName.length === 0) {
          throw new IdentityError('invalid_input', 'household displayName is required');
        }
        if (seenHouseholds.has(h.householdId)) {
          throw new IdentityError('invalid_input', `Duplicate household: ${h.householdId}`);
        }
        seenHouseholds.add(h.householdId);
        this.db
          .prepare(
            'INSERT INTO a2a_identity_households (household_id, display_name, status, created_at_ms) VALUES (?, ?, ?, ?)',
          )
          .run(h.householdId, h.displayName, 'active', nowMs);
      };

      const insertUser = (u: BootstrapUser): void => {
        assertId('userId', u.userId);
        if (typeof u.displayName !== 'string' || u.displayName.length === 0) {
          throw new IdentityError('invalid_input', 'user displayName is required');
        }
        if (seenUsers.has(u.userId)) {
          throw new IdentityError('invalid_input', `Duplicate user: ${u.userId}`);
        }
        seenUsers.add(u.userId);
        this.db
          .prepare(
            'INSERT INTO a2a_identity_users (user_id, display_name, status, created_at_ms) VALUES (?, ?, ?, ?)',
          )
          .run(u.userId, u.displayName, 'active', nowMs);
      };

      for (const household of bootstrap.households) insertHousehold(household);
      for (const user of bootstrap.users) insertUser(user);

      for (const membership of bootstrap.memberships) {
        assertId('membership.householdId', membership.householdId);
        assertId('membership.userId', membership.userId);
        if (!seenHouseholds.has(membership.householdId)) {
          throw new IdentityError('invalid_input', `Unknown household: ${membership.householdId}`);
        }
        if (!seenUsers.has(membership.userId)) {
          throw new IdentityError('invalid_input', `Unknown user: ${membership.userId}`);
        }
        this.db
          .prepare(
            'INSERT INTO a2a_identity_memberships (household_id, user_id, role, status, created_at_ms) VALUES (?, ?, ?, ?, ?)',
          )
          .run(membership.householdId, membership.userId, membership.role, 'active', nowMs);
      }

      for (const relationship of bootstrap.relationships) {
        assertId('relationship.householdId', relationship.householdId);
        assertId('relationship.guardianUserId', relationship.guardianUserId);
        assertId('relationship.childUserId', relationship.childUserId);
        if (!seenUsers.has(relationship.guardianUserId)) {
          throw new IdentityError('invalid_input', `Unknown guardian: ${relationship.guardianUserId}`);
        }
        if (!seenUsers.has(relationship.childUserId)) {
          throw new IdentityError('invalid_input', `Unknown child: ${relationship.childUserId}`);
        }
        if (relationship.guardianUserId === relationship.childUserId) {
          throw new IdentityError('invalid_input', 'guardian and child must differ');
        }
        this.db
          .prepare(
            'INSERT INTO a2a_identity_relationships (household_id, guardian_user_id, child_user_id, status, created_at_ms) VALUES (?, ?, ?, ?, ?)',
          )
          .run(
            relationship.householdId,
            relationship.guardianUserId,
            relationship.childUserId,
            'active',
            nowMs,
          );
      }

      for (const client of bootstrap.clients) {
        assertId('clientId', client.clientId);
        if (typeof client.displayName !== 'string' || client.displayName.length === 0) {
          throw new IdentityError('invalid_input', 'client displayName is required');
        }
        if (seenClients.has(client.clientId)) {
          throw new IdentityError('invalid_input', `Duplicate client: ${client.clientId}`);
        }
        seenClients.add(client.clientId);
        if (client.householdId !== undefined) {
          if (client.kind !== 'xiaozhi_device') {
            throw new IdentityError(
              'invalid_input',
              `Only xiaozhi_device clients bind a household (got ${client.kind}: ${client.clientId})`,
            );
          }
          if (!seenHouseholds.has(client.householdId)) {
            throw new IdentityError('invalid_input', `Unknown client household: ${client.householdId}`);
          }
        }
        if (client.kind === 'xiaozhi_device' && client.householdId === undefined) {
          throw new IdentityError(
            'invalid_input',
            `xiaozhi_device client ${client.clientId} requires a bound household (设备仅认证家庭)`,
          );
        }
        this.db
          .prepare(
            'INSERT INTO a2a_identity_clients (client_id, kind, display_name, household_id, status, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(client.clientId, client.kind, client.displayName, client.householdId ?? null, 'active', nowMs);
      }

      for (const credential of bootstrap.credentials) {
        assertId('credentialId', credential.credentialId);
        assertId('credential.clientId', credential.clientId);
        if (typeof credential.token !== 'string' || credential.token.length < 16) {
          throw new IdentityError('invalid_input', `credential ${credential.credentialId} token must be >= 16 chars`);
        }
        if (seenCredentials.has(credential.credentialId)) {
          throw new IdentityError('invalid_input', `Duplicate credential: ${credential.credentialId}`);
        }
        seenCredentials.add(credential.credentialId);
        const digest = sha256Hex(credential.token);
        if (seenTokens.has(digest)) {
          throw new IdentityError('invalid_input', `Duplicate credential token: ${credential.credentialId}`);
        }
        seenTokens.add(digest);
        if (!seenClients.has(credential.clientId)) {
          throw new IdentityError('invalid_input', `Unknown client: ${credential.clientId}`);
        }
        if (credential.binding === 'bound_principal') {
          if (credential.principalUserId === undefined || credential.householdId === undefined) {
            throw new IdentityError(
              'invalid_input',
              `credential ${credential.credentialId} bound_principal requires principalUserId + householdId`,
            );
          }
          if (!seenUsers.has(credential.principalUserId)) {
            throw new IdentityError('invalid_input', `Unknown principal user: ${credential.principalUserId}`);
          }
          if (!seenHouseholds.has(credential.householdId)) {
            throw new IdentityError('invalid_input', `Unknown credential household: ${credential.householdId}`);
          }
        } else if (credential.principalUserId !== undefined) {
          throw new IdentityError(
            'invalid_input',
            `credential ${credential.credentialId} client_only must not carry a principal user`,
          );
        }
        this.db
          .prepare(
            'INSERT INTO a2a_identity_credentials (credential_id, client_id, token_sha256, binding, principal_user_id, household_id, scope_json, issued_at_ms, expires_at_ms, status) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)',
          )
          .run(
            credential.credentialId,
            credential.clientId,
            digest,
            credential.binding,
            credential.principalUserId ?? null,
            credential.householdId ?? null,
            nowMs,
            credential.expiresAtMs ?? null,
            'active',
          );
      }

      for (const grant of bootstrap.grants) {
        assertId('grantId', grant.grantId);
        assertId('grant.clientId', grant.clientId);
        assertId('grant.householdId', grant.householdId);
        assertId('grant.sessionBinding', grant.sessionBinding);
        if (seenGrants.has(grant.grantId)) {
          throw new IdentityError('invalid_input', `Duplicate grant: ${grant.grantId}`);
        }
        seenGrants.add(grant.grantId);
        if (!seenClients.has(grant.clientId)) {
          throw new IdentityError('invalid_input', `Unknown grant client: ${grant.clientId}`);
        }
        if (!seenHouseholds.has(grant.householdId)) {
          throw new IdentityError('invalid_input', `Unknown grant household: ${grant.householdId}`);
        }
        if (!Number.isFinite(grant.expiresAtMs) || grant.expiresAtMs <= nowMs) {
          throw new IdentityError('invalid_input', `grant ${grant.grantId} expiresAtMs must be in the future`);
        }
        if (grant.scope.length === 0 || grant.scope.some((op) => !AUTH_OPERATIONS.includes(op))) {
          throw new IdentityError('invalid_input', `grant ${grant.grantId} scope must be a non-empty AUTH_OPERATIONS subset`);
        }
        if (grant.kind === 'session_verified') {
          if (grant.userId === undefined || grant.candidateUserId !== undefined) {
            throw new IdentityError('invalid_input', `grant ${grant.grantId} session_verified requires userId only`);
          }
          if (!seenUsers.has(grant.userId)) {
            throw new IdentityError('invalid_input', `Unknown grant user: ${grant.userId}`);
          }
        } else {
          if (grant.candidateUserId === undefined || grant.userId !== undefined) {
            throw new IdentityError('invalid_input', `grant ${grant.grantId} voiceprint_candidate requires candidateUserId only`);
          }
          if (!seenUsers.has(grant.candidateUserId)) {
            throw new IdentityError('invalid_input', `Unknown candidate user: ${grant.candidateUserId}`);
          }
        }
        this.db
          .prepare(
            'INSERT INTO a2a_identity_grants (grant_id, client_id, household_id, kind, user_id, candidate_user_id, session_binding, scope_json, issued_at_ms, expires_at_ms, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            grant.grantId,
            grant.clientId,
            grant.householdId,
            grant.kind,
            grant.userId ?? null,
            grant.candidateUserId ?? null,
            grant.sessionBinding,
            JSON.stringify(grant.scope),
            nowMs,
            grant.expiresAtMs,
            'active',
          );
      }
      return undefined;
    });
  }

  // -------------------------------------------------------------------------
  // Lookups (authorizer input)
  // -------------------------------------------------------------------------

  /** Maps a raw snake_case row to CredentialRow (no blind casts — revoked_at_ms etc.). */
  private credentialRowOf(row: Record<string, unknown> | undefined): CredentialRow | undefined {
    if (!row) return undefined;
    return {
      credentialId: row['credential_id'] as string,
      clientId: row['client_id'] as string,
      tokenSha256: row['token_sha256'] as string,
      binding: row['binding'] as CredentialRow['binding'],
      principalUserId: row['principal_user_id'] as string | null,
      householdId: row['household_id'] as string | null,
      issuedAtMs: row['issued_at_ms'] as number,
      expiresAtMs: row['expires_at_ms'] as number | null,
      revokedAtMs: row['revoked_at_ms'] as number | null,
      status: row['status'] as CredentialRow['status'],
    };
  }

  findCredentialByDigest(digest: string): CredentialRow | undefined {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM a2a_identity_credentials WHERE token_sha256 = ?')
      .get(digest) as Record<string, unknown> | undefined;
    return this.credentialRowOf(row);
  }

  findCredentialById(credentialId: string): CredentialRow | undefined {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM a2a_identity_credentials WHERE credential_id = ?')
      .get(credentialId) as Record<string, unknown> | undefined;
    return this.credentialRowOf(row);
  }

  findClient(clientId: string): ClientRow | undefined {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM a2a_identity_clients WHERE client_id = ?')
      .get(clientId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      clientId: row['client_id'] as string,
      kind: row['kind'] as ClientKind,
      displayName: row['display_name'] as string,
      householdId: row['household_id'] as string | null,
      status: row['status'] as ClientRow['status'],
    };
  }

  /** Active membership only; revoked/missing memberships resolve to undefined. */
  activeMembership(householdId: string, userId: string): MembershipRow | undefined {
    this.assertOpen();
    const row = this.db
      .prepare(
        "SELECT household_id, user_id, role, status FROM a2a_identity_memberships " +
          'WHERE household_id = ? AND user_id = ? AND status = ?',
      )
      .get(householdId, userId, 'active') as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      householdId: row['household_id'] as string,
      userId: row['user_id'] as string,
      role: row['role'] as MembershipRole,
      status: 'active',
    };
  }

  /** Active guardian→child relationship inside one household. */
  hasActiveRelationship(householdId: string, guardianUserId: string, childUserId: string): boolean {
    this.assertOpen();
    const row = this.db
      .prepare(
        "SELECT 1 AS one FROM a2a_identity_relationships WHERE household_id = ? " +
          'AND guardian_user_id = ? AND child_user_id = ? AND status = ?',
      )
      .get(householdId, guardianUserId, childUserId, 'active');
    return row !== undefined;
  }

  userDisabled(userId: string): boolean {
    this.assertOpen();
    const row = this.db
      .prepare("SELECT status FROM a2a_identity_users WHERE user_id = ?")
      .get(userId) as { status: string } | undefined;
    return row === undefined || row.status !== 'active';
  }

  findGrant(grantId: string): GrantRecord | undefined {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM a2a_identity_grants WHERE grant_id = ?')
      .get(grantId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      grantId: row['grant_id'] as string,
      clientId: row['client_id'] as string,
      householdId: row['household_id'] as string,
      kind: row['kind'] as GrantRecord['kind'],
      userId: row['user_id'] as string | null,
      candidateUserId: row['candidate_user_id'] as string | null,
      sessionBinding: row['session_binding'] as string,
      scope: JSON.parse(row['scope_json'] as string) as Operation[],
      issuedAtMs: row['issued_at_ms'] as number,
      expiresAtMs: row['expires_at_ms'] as number,
      revokedAtMs: row['revoked_at_ms'] as number | null,
      status: row['status'] as GrantRecord['status'],
    };
  }

  // -------------------------------------------------------------------------
  // Task bindings & ACL
  // -------------------------------------------------------------------------

  taskBinding(taskId: string): TaskBinding | undefined {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM a2a_identity_task_bindings WHERE task_id = ?')
      .get(taskId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      taskId: row['task_id'] as string,
      contextId: row['context_id'] as string,
      householdId: row['household_id'] as string,
      principalUserId: row['principal_user_id'] as string | null,
      clientId: row['client_id'] as string,
      clientKind: row['client_kind'] as ClientKind,
      createdAtMs: row['created_at_ms'] as number,
    };
  }

  taskBindingsForContext(contextId: string): TaskBinding[] {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT * FROM a2a_identity_task_bindings WHERE context_id = ? ORDER BY created_at_ms')
      .all(contextId) as Record<string, unknown>[];
    return rows.map((row) => ({
      taskId: row['task_id'] as string,
      contextId: row['context_id'] as string,
      householdId: row['household_id'] as string,
      principalUserId: row['principal_user_id'] as string | null,
      clientId: row['client_id'] as string,
      clientKind: row['client_kind'] as ClientKind,
      createdAtMs: row['created_at_ms'] as number,
    }));
  }

  /**
   * Owner identity of an AuthContext for binding-match purposes: verified
   * users match by (household, userId); device visitors/candidates match by
   * (household, client) — a voiceprint candidate NEVER matches a task owned
   * by a verified user (候选不提升私有数据权限).
   */
  private bindingOwnerMatches(binding: TaskBinding, auth: AuthContext): boolean {
    if (binding.householdId !== auth.householdId) return false;
    const verifiedUserId =
      auth.principal.kind === 'bound_user' || auth.principal.kind === 'session_verified'
        ? auth.principal.userId
        : null;
    const candidateUserId =
      auth.principal.kind === 'voiceprint_candidate' ? auth.principal.candidateUserId : null;
    if (binding.principalUserId !== null) {
      if (verifiedUserId !== null && verifiedUserId === binding.principalUserId) return true;
      // Same-device re-identification of the same candidate may continue the
      // device-level conversation (design §6.2 low-sensitivity tier).
      if (
        candidateUserId !== null &&
        candidateUserId === binding.principalUserId &&
        binding.clientKind === 'xiaozhi_device' &&
        binding.clientId === auth.clientId
      ) {
        return true;
      }
      return false;
    }
    // Visitor-owned task: continued only by the same device client.
    return binding.clientId === auth.clientId;
  }

  /**
   * Records the ownership binding for a task at acceptance time — BEFORE the
   * task row is persisted by the Task Manager (fail-closed ordering). One
   * transaction covers the foreign-context check and the insert.
   */
  bindTask(params: { taskId: string; contextId: string; auth: AuthContext }): void {
    this.assertOpen();
    const { taskId, contextId, auth } = params;
    if (auth.householdId === null) {
      throw new IdentityError(
        'task_access_denied',
        'request has no authorized household scope; refusing to bind a task',
      );
    }
    const principalUserId =
      auth.principal.kind === 'bound_user' || auth.principal.kind === 'session_verified'
        ? auth.principal.userId
        : auth.principal.kind === 'voiceprint_candidate'
          ? auth.principal.candidateUserId
          : null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.taskBinding(taskId);
      if (existing && !this.bindingOwnerMatches(existing, auth)) {
        throw new IdentityError('task_access_denied', `task ${taskId} is owned by another principal`);
      }
      for (const bound of this.taskBindingsForContext(contextId)) {
        if (bound.taskId === taskId) continue;
        if (!this.bindingOwnerMatches(bound, auth)) {
          throw new IdentityError(
            'context_access_denied',
            `context ${contextId} belongs to another household/principal; continuation refused`,
          );
        }
      }
      this.db
        .prepare(
          'INSERT OR IGNORE INTO a2a_identity_task_bindings (task_id, context_id, household_id, principal_user_id, client_id, client_kind, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(taskId, contextId, auth.householdId, principalUserId, auth.clientId, auth.clientKind, this.now());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** ACL decision for reading/canceling/subscribing to an existing task. */
  checkTaskAccess(
    taskId: string,
    auth: AuthContext,
  ): { allowed: boolean; reason: string; binding?: TaskBinding } {
    this.assertOpen();
    const binding = this.taskBinding(taskId);
    if (!binding) {
      return { allowed: false, reason: 'task_not_bound' };
    }
    if (binding.householdId !== auth.householdId) {
      return { allowed: false, reason: 'household_mismatch', binding };
    }
    if (!this.bindingOwnerMatches(binding, auth)) {
      return { allowed: false, reason: 'principal_mismatch', binding };
    }
    return { allowed: true, reason: 'owner_match', binding };
  }

  /**
   * Continuation (会话续接) decision for a client-supplied contextId:
   * unbound contexts adopt the CALLER as owner (new conversation); bound
   * contexts continue only for the owning principal/household.
   */
  checkContextAccess(
    contextId: string,
    auth: AuthContext,
  ): { bound: boolean; allowed: boolean; reason?: string } {
    this.assertOpen();
    const bindings = this.taskBindingsForContext(contextId);
    if (bindings.length === 0) return { bound: false, allowed: true };
    for (const binding of bindings) {
      if (!this.bindingOwnerMatches(binding, auth)) {
        return { bound: true, allowed: false, reason: 'context_owned_by_other' };
      }
    }
    return { bound: true, allowed: true };
  }

  // -------------------------------------------------------------------------
  // Revocations (each bumps the epoch — AC 3: 及时生效)
  // -------------------------------------------------------------------------

  revokeCredential(credentialId: string, actor: AuditActor = {}): boolean {
    return this.withConditionalBumpTransaction(() => {
      const result = this.db
        .prepare(
          "UPDATE a2a_identity_credentials SET status = 'revoked', revoked_at_ms = ? " +
            'WHERE credential_id = ? AND status = ?',
        )
        .run(this.now(), credentialId, 'active');
      if (result.changes === 0) return false;
      this.auditInTransaction({
        ...actor,
        action: 'revoke_credential',
        decision: 'allow',
        reason: 'credential_revoked',
        credentialId,
      });
      return true;
    });
  }

  revokeMembership(householdId: string, userId: string, actor: AuditActor = {}): boolean {
    return this.withConditionalBumpTransaction(() => {
      const result = this.db
        .prepare(
          "UPDATE a2a_identity_memberships SET status = 'revoked', revoked_at_ms = ? " +
            'WHERE household_id = ? AND user_id = ? AND status = ?',
        )
        .run(this.now(), householdId, userId, 'active');
      if (result.changes === 0) return false;
      this.auditInTransaction({
        ...actor,
        action: 'revoke_membership',
        decision: 'allow',
        reason: 'membership_revoked',
        householdId,
        principalUserId: userId,
      });
      return true;
    });
  }

  revokeGrant(grantId: string, actor: AuditActor = {}): boolean {
    return this.withConditionalBumpTransaction(() => {
      const result = this.db
        .prepare(
          "UPDATE a2a_identity_grants SET status = 'revoked', revoked_at_ms = ? " +
            'WHERE grant_id = ? AND status = ?',
        )
        .run(this.now(), grantId, 'active');
      if (result.changes === 0) return false;
      this.auditInTransaction({
        ...actor,
        action: 'revoke_grant',
        decision: 'allow',
        reason: 'grant_revoked',
      });
      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  auditInTransaction(entry: {
    action: string;
    decision: 'allow' | 'deny';
    reason: string;
    credentialId?: string | null;
    clientId?: string | null;
    principalUserId?: string | null;
    householdId?: string | null;
    taskId?: string | null;
    contextId?: string | null;
  }): void {
    this.db
      .prepare(
        'INSERT INTO a2a_identity_audit (at_ms, action, decision, reason, credential_id, client_id, principal_user_id, household_id, task_id, context_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        this.now(),
        entry.action,
        entry.decision,
        entry.reason,
        entry.credentialId ?? null,
        entry.clientId ?? null,
        entry.principalUserId ?? null,
        entry.householdId ?? null,
        entry.taskId ?? null,
        entry.contextId ?? null,
      );
  }

  audit(entry: Parameters<IdentityStore['auditInTransaction']>[0]): void {
    this.assertOpen();
    this.auditInTransaction(entry);
  }

  auditEntries(limit = 100): AuditEntry[] {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT * FROM a2a_identity_audit ORDER BY audit_id LIMIT ?')
      .all(Math.max(1, Math.floor(limit))) as Record<string, unknown>[];
    return rows.map((row) => ({
      auditId: row['audit_id'] as number,
      atMs: row['at_ms'] as number,
      action: row['action'] as string,
      decision: row['decision'] as 'allow' | 'deny',
      reason: row['reason'] as string,
      credentialId: row['credential_id'] as string | null,
      clientId: row['client_id'] as string | null,
      principalUserId: row['principal_user_id'] as string | null,
      householdId: row['household_id'] as string | null,
      taskId: row['task_id'] as string | null,
      contextId: row['context_id'] as string | null,
    }));
  }
}

export type { AssuranceLevel };
