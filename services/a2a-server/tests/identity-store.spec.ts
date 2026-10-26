/**
 * Identity store tests (P1-03, issue #85): versioned migration (additive,
 * fail-closed on future versions), digest-only credential storage, strict
 * bootstrap validation, revocation-epoch coherence and the task-binding ACL
 * primitives. Everything is synthetic validation data (P1 口径).
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  IdentityStore,
  defaultValidationBootstrap,
  parseIdentityBootstrap,
  type IdentityBootstrap,
} from '../src/identity/identity-store.ts';
import { A2A_IDENTITY_SCHEMA_VERSION, sha256Hex } from '../src/identity/schema.ts';
import { DatabaseSync } from 'node:sqlite';
import type { AuthContext } from '../src/identity/model.ts';

const TOKEN = 'synthetic-validation-token-0123456789abcdef';

/**
 * Removes a temp dir holding closed SQLite file DBs. On Windows the -wal/
 * -shm handles can stay briefly locked by the OS indexer right after close()
 * and rmSync throws EPERM even past its internal retries; a temp dir is
 * disposable, so the last-resort failure is tolerated instead of flaking CI.
 */
function removeTempDir(dir: string): void {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      return;
    } catch {
      // retry after a short wait; tolerate the final failure (temp dir only)
    }
  }
}

function bootstrapWithToken(token: string): IdentityBootstrap {
  const bootstrap = defaultValidationBootstrap(token);
  return bootstrap;
}

function guardianAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    credentialId: 'cred-validation-harness',
    clientId: 'validation-harness',
    clientKind: 'dsh_profile',
    householdId: 'hh-synthetic-01',
    principal: {
      kind: 'bound_user',
      userId: 'user-guardian-synthetic',
      role: 'guardian',
      assurance: 'credential_bound',
    },
    revocationEpoch: 0,
    resolvedAtMs: 0,
    ...overrides,
  };
}

test('identity migration creates schema v2, records the version, and reopens idempotently', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a2a-identity-store-'));
  try {
    const dbPath = path.join(dir, 'identity.sqlite3');
    const store = new IdentityStore({ dbPath });
    store.applyBootstrap(bootstrapWithToken(TOKEN));
    store.close();

    // Reopen on the same file: migration is a no-op, version stays 2.
    const reopened = new IdentityStore({ dbPath });
    assert.equal(reopened.revocationEpoch >= 1, true, 'seeding bumped the epoch');
    reopened.close();

    const raw = new DatabaseSync(dbPath);
    const version = raw
      .prepare("SELECT value FROM lumithink_a2a_identity_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    assert.equal(Number(version.value), A2A_IDENTITY_SCHEMA_VERSION);
    const columns = (
      raw.prepare("PRAGMA table_info(a2a_identity_task_bindings)").all() as { name: string }[]
    ).map((column) => column.name);
    for (const column of ['credential_id', 'grant_id', 'principal_kind']) {
      assert.ok(columns.includes(column), `v2 column ${column} must exist`);
    }
    raw.close();
  } finally {
    removeTempDir(dir);
  }
});

test('v1 → v2 upgrade path: pre-v2 rows re-migrate additively and are gated fail-closed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a2a-identity-store-'));
  try {
    const dbPath = path.join(dir, 'identity.sqlite3');
    const store = new IdentityStore({ dbPath });
    store.applyBootstrap(bootstrapWithToken(TOKEN));
    const guardian = guardianAuth();
    store.bindTask({ taskId: 'task-v1-legacy', contextId: 'ctx-v1-legacy', auth: guardian });
    store.close();

    // Simulate a v1 store: drop the v2 indexes and columns, rewind the marker.
    // (The columns are referenced by the v2 indexes — drop those first.)
    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP INDEX IF EXISTS idx_a2a_identity_task_bindings_credential');
    raw.exec('DROP INDEX IF EXISTS idx_a2a_identity_task_bindings_grant');
    raw.exec('ALTER TABLE a2a_identity_task_bindings DROP COLUMN credential_id');
    raw.exec('ALTER TABLE a2a_identity_task_bindings DROP COLUMN grant_id');
    raw.exec('ALTER TABLE a2a_identity_task_bindings DROP COLUMN principal_kind');
    raw
      .prepare(
        "UPDATE lumithink_a2a_identity_meta SET value = '1' WHERE key = 'schema_version'",
      )
      .run();
    raw.close();

    // Reopen: additive v2 migration runs again; the legacy row has NULL attribution.
    const reopened = new IdentityStore({ dbPath });
    const legacy = reopened.taskBinding('task-v1-legacy');
    assert.ok(legacy);
    assert.equal(legacy?.credentialId, null);
    assert.equal(legacy?.principalKind, 'user', 'NOT NULL DEFAULT applies the user kind');
    reopened.close();
  } finally {
    removeTempDir(dir);
  }
});

test('fail-closed: a NEWER identity schema version refuses to open', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a2a-identity-store-'));
  try {
    const dbPath = path.join(dir, 'identity.sqlite3');
    const store = new IdentityStore({ dbPath });
    store.close();
    const raw = new DatabaseSync(dbPath);
    raw
      .prepare(
        "INSERT INTO lumithink_a2a_identity_meta (key, value) VALUES ('schema_version', '99') " +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run();
    raw.close();
    assert.throws(() => new IdentityStore({ dbPath }), /NEWER than this build supports/);
  } finally {
    removeTempDir(dir);
  }
});

test('credentials are stored ONLY as SHA-256 digests — plaintext never on disk', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a2a-identity-store-'));
  try {
    const dbPath = path.join(dir, 'identity.sqlite3');
    const store = new IdentityStore({ dbPath });
    store.applyBootstrap(bootstrapWithToken(TOKEN));
    const raw = new DatabaseSync(dbPath);
    const row = raw
      .prepare('SELECT token_sha256, credential_id FROM a2a_identity_credentials')
      .get() as { token_sha256: string; credential_id: string };
    assert.equal(row.credential_id, 'cred-validation-harness');
    assert.equal(row.token_sha256, sha256Hex(TOKEN));
    raw.close();
    const fileBytes = readFileSync(dbPath);
    assert.equal(
      fileBytes.includes(Buffer.from(TOKEN, 'utf8')),
      false,
      'the plaintext token must never appear in the database file',
    );
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

test('bootstrap validation fails closed on invalid directories', () => {
  const store = new IdentityStore({ dbPath: ':memory:' });
  try {
    const base = bootstrapWithToken(TOKEN);

    // Duplicate token across credentials.
    const dupToken: IdentityBootstrap = {
      ...base,
      clients: [...base.clients, { clientId: 'c2', kind: 'dsh_profile', displayName: 'c2' }],
      credentials: [
        ...base.credentials,
        {
          credentialId: 'cred-2',
          clientId: 'c2',
          token: TOKEN,
          binding: 'bound_principal',
          principalUserId: 'user-child-synthetic',
          householdId: 'hh-synthetic-01',
        },
      ],
    };
    assert.throws(() => store.applyBootstrap(dupToken), /Duplicate credential token/);

    // Dangling principal reference.
    const dangling: IdentityBootstrap = {
      ...bootstrapWithToken(TOKEN),
      credentials: [
        {
          credentialId: 'cred-x',
          clientId: 'validation-harness',
          token: 'another-synthetic-token-0123456789',
          binding: 'bound_principal',
          principalUserId: 'user-unknown',
          householdId: 'hh-synthetic-01',
        },
      ],
    };
    assert.throws(() => store.applyBootstrap(dangling), /Unknown principal user/);

    // xiaozhi_device without a household (设备仅认证家庭).
    const deviceNoHousehold: IdentityBootstrap = {
      ...base,
      clients: [
        ...base.clients,
        { clientId: 'dev-1', kind: 'xiaozhi_device', displayName: 'dev' },
      ],
    };
    assert.throws(() => store.applyBootstrap(deviceNoHousehold), /requires a bound household/);

    // client_only credential carrying a principal user.
    const clientOnlyWithUser: IdentityBootstrap = {
      ...base,
      credentials: [
        {
          credentialId: 'cred-y',
          clientId: 'validation-harness',
          token: 'another-synthetic-token-0123456789',
          binding: 'client_only',
          principalUserId: 'user-guardian-synthetic',
        },
      ],
    };
    assert.throws(() => store.applyBootstrap(clientOnlyWithUser), /client_only must not carry/);

    // Grant expiring in the past.
    const pastGrant: IdentityBootstrap = {
      ...base,
      grants: [
        {
          grantId: 'g-past',
          clientId: 'validation-harness',
          householdId: 'hh-synthetic-01',
          kind: 'session_verified',
          userId: 'user-guardian-synthetic',
          sessionBinding: 'conn-1',
          scope: ['chat.general'],
          expiresAtMs: 1,
        },
      ],
    };
    assert.throws(() => store.applyBootstrap(pastGrant), /expiresAtMs must be in the future/);

    // Scope outside the frozen AUTH_OPERATIONS set.
    const badScope: IdentityBootstrap = {
      ...base,
      grants: [
        {
          grantId: 'g-scope',
          clientId: 'validation-harness',
          householdId: 'hh-synthetic-01',
          kind: 'session_verified',
          userId: 'user-guardian-synthetic',
          sessionBinding: 'conn-1',
          scope: ['chat.everything' as never],
          expiresAtMs: Date.now() + 60_000,
        },
      ],
    };
    assert.throws(() => store.applyBootstrap(badScope), /non-empty AUTH_OPERATIONS subset/);

    // Cross-household device grant (P2-2): a household-bound xiaozhi_device
    // client can never carry a grant for ANOTHER household (设备仅认证家庭).
    const crossHouseholdGrant: IdentityBootstrap = {
      ...base,
      households: [...base.households, { householdId: 'hh-other', displayName: 'Other' }],
      clients: [
        ...base.clients,
        {
          clientId: 'dev-1',
          kind: 'xiaozhi_device',
          displayName: 'Device',
          householdId: 'hh-synthetic-01',
        },
      ],
      grants: [
        {
          grantId: 'g-cross',
          clientId: 'dev-1',
          householdId: 'hh-other',
          kind: 'session_verified',
          userId: 'user-guardian-synthetic',
          sessionBinding: 'conn-1',
          scope: ['chat.general'],
          expiresAtMs: Date.now() + 60_000,
        },
      ],
    };
    assert.throws(
      () => store.applyBootstrap(crossHouseholdGrant),
      /does not match the device client's bound household/,
    );

    // parseIdentityBootstrap rejects unknown fields.
    assert.throws(
      () => parseIdentityBootstrap(JSON.stringify({ households: [], sneaky: [] })),
      /Unknown bootstrap field/,
    );
  } finally {
    store.close();
  }
});

test('every revocation bumps the epoch exactly once; repeats are no-ops', () => {
  const store = new IdentityStore({ dbPath: ':memory:' });
  try {
    // Seeding itself bumps 0 → 1 (caches must not outlive a directory change).
    assert.equal(store.revocationEpoch, 0);
    store.applyBootstrap(bootstrapWithToken(TOKEN));
    assert.equal(store.revocationEpoch, 1, 'seeding bumps exactly once');

    let before = store.revocationEpoch;
    assert.equal(store.revokeCredential('cred-validation-harness'), true);
    assert.equal(store.revocationEpoch, before + 1, 'credential revocation bumps exactly once');
    assert.equal(store.revokeCredential('cred-validation-harness'), false, 'second revoke is a no-op');
    assert.equal(store.revocationEpoch, before + 1, 'the no-op does not bump again');

    before = store.revocationEpoch;
    assert.equal(store.revokeMembership('hh-synthetic-01', 'user-guardian-synthetic'), true);
    assert.equal(store.revocationEpoch, before + 1, 'membership revocation bumps exactly once');
    assert.equal(store.revokeMembership('hh-synthetic-01', 'user-guardian-synthetic'), false);
    assert.equal(store.revocationEpoch, before + 1, 'the no-op does not bump again');

    const membershipRevokes = store.auditEntries(100).filter((e) => e.action === 'revoke_membership');
    assert.equal(membershipRevokes.length, 1, 'no audit row for the no-op repeat');
  } finally {
    store.close();
  }
});

test('task binding ACL: household isolation, principal isolation, candidate ceiling', () => {
  const store = new IdentityStore({ dbPath: ':memory:' });
  try {
    store.applyBootstrap(bootstrapWithToken(TOKEN));
    const guardian = guardianAuth();

    // Binding a task under the guardian identity succeeds.
    store.bindTask({ taskId: 'task-1', contextId: 'ctx-1', auth: guardian });
    assert.equal(store.checkTaskAccess('task-1', guardian).allowed, true);

    // Same household, DIFFERENT principal (the child) is denied.
    const child = guardianAuth({
      credentialId: 'cred-child',
      clientId: 'validation-harness',
      principal: {
        kind: 'bound_user',
        userId: 'user-child-synthetic',
        role: 'child',
        assurance: 'credential_bound',
      },
    });
    const childDecision = store.checkTaskAccess('task-1', child);
    assert.equal(childDecision.allowed, false);
    assert.equal(childDecision.reason, 'principal_mismatch');

    // Cross-household principal is denied with household_mismatch.
    const outsider = guardianAuth({
      credentialId: 'cred-out',
      clientId: 'validation-harness',
      householdId: 'hh-other',
      principal: {
        kind: 'bound_user',
        userId: 'user-guardian-synthetic',
        role: 'guardian',
        assurance: 'credential_bound',
      },
    });
    const outsiderDecision = store.checkTaskAccess('task-1', outsider);
    assert.equal(outsiderDecision.allowed, false);
    assert.equal(outsiderDecision.reason, 'household_mismatch');

    // Continuation on a bound context: same owner allowed, foreign denied.
    assert.equal(store.checkContextAccess('ctx-1', guardian).allowed, true);
    const foreignContext = store.checkContextAccess('ctx-1', child);
    assert.equal(foreignContext.bound, true);
    assert.equal(foreignContext.allowed, false);
    // An UNBOUND context adopts the caller (new conversation).
    assert.deepEqual(store.checkContextAccess('ctx-fresh', child), { bound: false, allowed: true });

    // Binding a NEW task into a foreign context is refused (defense in depth).
    assert.throws(
      () => store.bindTask({ taskId: 'task-2', contextId: 'ctx-1', auth: child }),
      /belongs to another household\/principal/,
    );

    // A voiceprint candidate cannot continue a verified user's conversation.
    const candidate = guardianAuth({
      credentialId: 'cred-cand',
      clientId: 'dev-1',
      clientKind: 'xiaozhi_device',
      principal: {
        kind: 'voiceprint_candidate',
        candidateUserId: 'user-child-synthetic',
        assurance: 'voiceprint_candidate',
        grantId: 'g-1',
      },
    });
    assert.throws(
      () => store.bindTask({ taskId: 'task-3', contextId: 'ctx-1', auth: candidate }),
      /belongs to another household\/principal/,
    );

    // A device visitor task is household-scoped and continued by the same device client.
    const visitor = guardianAuth({
      credentialId: 'cred-dev',
      clientId: 'dev-1',
      clientKind: 'xiaozhi_device',
      principal: { kind: 'visitor', assurance: 'unverified_visitor' },
    });
    store.bindTask({ taskId: 'task-visitor', contextId: 'ctx-visitor', auth: visitor });
    assert.equal(store.checkTaskAccess('task-visitor', visitor).allowed, true);
    assert.equal(store.checkTaskAccess('task-visitor', guardian).allowed, false,
      'a verified user must not silently take over a visitor task');
    const sameDeviceCandidate = guardianAuth({
      credentialId: 'cred-cand',
      clientId: 'dev-1',
      clientKind: 'xiaozhi_device',
      principal: {
        kind: 'voiceprint_candidate',
        candidateUserId: 'user-child-synthetic',
        assurance: 'voiceprint_candidate',
        grantId: 'g-1',
      },
    });
    assert.equal(
      store.checkTaskAccess('task-visitor', sameDeviceCandidate).allowed,
      true,
      'same-device candidate continues the device conversation',
    );
  } finally {
    store.close();
  }
});

test('candidate continuation tiers pinned: own device conversations yes, verified-user bindings never (P2-3)', () => {
  const store = new IdentityStore({ dbPath: ':memory:' });
  try {
    store.applyBootstrap(bootstrapWithToken(TOKEN));

    // Candidate-bound task on device dev-1.
    const candidate = guardianAuth({
      credentialId: 'cred-dev-1',
      clientId: 'dev-1',
      clientKind: 'xiaozhi_device',
      principal: {
        kind: 'voiceprint_candidate',
        candidateUserId: 'user-child-synthetic',
        assurance: 'voiceprint_candidate',
        grantId: 'g-1',
      },
    });
    store.bindTask({ taskId: 'task-cand', contextId: 'ctx-cand', auth: candidate });
    assert.equal(store.taskBinding('task-cand')?.principalKind, 'candidate');
    assert.equal(
      store.checkTaskAccess('task-cand', candidate).allowed,
      true,
      'same device + same candidate continues the candidate conversation',
    );
    const otherDeviceCandidate = guardianAuth({
      credentialId: 'cred-dev-2',
      clientId: 'dev-2',
      clientKind: 'xiaozhi_device',
      principal: {
        kind: 'voiceprint_candidate',
        candidateUserId: 'user-child-synthetic',
        assurance: 'voiceprint_candidate',
        grantId: 'g-1',
      },
    });
    assert.equal(
      store.checkTaskAccess('task-cand', otherDeviceCandidate).allowed,
      false,
      'another device never continues the conversation',
    );
    const verifiedChild = guardianAuth({
      clientId: 'validation-harness',
      principal: {
        kind: 'session_verified',
        userId: 'user-child-synthetic',
        role: 'child',
        assurance: 'session_verified',
        grantId: 'g-2',
      },
    });
    assert.equal(
      store.checkTaskAccess('task-cand', verifiedChild).allowed,
      true,
      'the verified user may take over their own candidate conversation',
    );

    // session_verified-bound task (principalKind 'user'): a candidate whose
    // candidateUserId EQUALS the verified user, on the SAME device, can never
    // continue it — 匹配不是已验证身份 (design §6.2/§6.3, Step 05 P2-3).
    const sessionVerified = guardianAuth({
      credentialId: 'cred-dev-1',
      clientId: 'dev-1',
      clientKind: 'xiaozhi_device',
      principal: {
        kind: 'session_verified',
        userId: 'user-guardian-synthetic',
        role: 'guardian',
        assurance: 'session_verified',
        grantId: 'g-2',
      },
    });
    store.bindTask({ taskId: 'task-verified', contextId: 'ctx-verified', auth: sessionVerified });
    const guardianCandidate = guardianAuth({
      credentialId: 'cred-dev-1',
      clientId: 'dev-1',
      clientKind: 'xiaozhi_device',
      principal: {
        kind: 'voiceprint_candidate',
        candidateUserId: 'user-guardian-synthetic',
        assurance: 'voiceprint_candidate',
        grantId: 'g-3',
      },
    });
    const decision = store.checkTaskAccess('task-verified', guardianCandidate);
    assert.equal(decision.allowed, false, 'a candidate never continues a verified-user binding');
    assert.equal(decision.reason, 'principal_mismatch');
  } finally {
    store.close();
  }
});

test('audit entries record decisions without token or content material', () => {
  const store = new IdentityStore({ dbPath: ':memory:' });
  try {
    store.applyBootstrap(bootstrapWithToken(TOKEN));
    store.revokeCredential('cred-validation-harness');
    const entries = store.auditEntries(10);
    const revoke = entries.find((entry) => entry.action === 'revoke_credential');
    assert.ok(revoke, 'revocation is audited');
    assert.equal(revoke?.decision, 'allow');
    assert.equal(revoke?.reason, 'credential_revoked');
    const serialized = JSON.stringify(entries);
    assert.equal(serialized.includes(TOKEN), false, 'no plaintext token in audit');
    assert.equal(serialized.includes(sha256Hex(TOKEN)), false, 'no digest in audit either');
  } finally {
    store.close();
  }
});

test('upgrade migration: a pre-marker directory adopts the current bootstrap instead of refusing to start (review-90-r1 P1)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'identity-legacy-'));
  const dbPath = path.join(dir, 'identity.sqlite3');
  try {
    // Phase 1 — a PRE-P1-08 build seeds the directory: content exists but the
    // bootstrap_sha256 marker was never written.
    const legacy = new IdentityStore({ dbPath });
    legacy.applyBootstrap(bootstrapWithToken(TOKEN));
    legacy.close();
    const raw = new DatabaseSync(dbPath);
    raw.prepare("DELETE FROM lumithink_a2a_identity_meta WHERE key = 'bootstrap_sha256'").run();
    const metaRows = raw
      .prepare("SELECT COUNT(*) AS n FROM lumithink_a2a_identity_meta WHERE key = 'bootstrap_sha256'")
      .get() as { n: number };
    assert.equal(metaRows.n, 0, 'precondition: the legacy directory has no marker');
    raw.close();

    // Phase 2 — the upgraded build starts on the SAME bootstrap: it adopts the
    // legacy directory instead of failing with 'refusing to start'.
    const upgraded = new IdentityStore({ dbPath });
    try {
      assert.equal(upgraded.applyBootstrap(bootstrapWithToken(TOKEN)), false, 'no reseed on adoption');
      const adopted = new DatabaseSync(dbPath);
      try {
        const row = adopted
          .prepare("SELECT value FROM lumithink_a2a_identity_meta WHERE key = 'bootstrap_sha256'")
          .get() as { value: string } | undefined;
        assert.ok(row !== undefined && row.value.length === 64, 'the marker was adopted (sha256)');
      } finally {
        adopted.close();
      }
      // A SECOND restart with the identical bootstrap is now the plain no-op.
      assert.equal(upgraded.applyBootstrap(bootstrapWithToken(TOKEN)), false);
    } finally {
      upgraded.close();
    }

    // Phase 3 — once the marker exists, a DIFFERENT bootstrap still fails closed.
    const different = new IdentityStore({ dbPath });
    try {
      assert.throws(
        () => different.applyBootstrap(bootstrapWithToken('another-synthetic-token-0123456789')),
        /refusing to start/,
        'different bootstrap on an adopted directory stays fail-closed',
      );
    } finally {
      different.close();
    }
  } finally {
    removeTempDir(dir);
  }
});
