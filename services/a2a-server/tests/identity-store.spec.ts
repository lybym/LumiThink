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

test('identity migration creates schema v1, records the version, and reopens idempotently', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a2a-identity-store-'));
  try {
    const dbPath = path.join(dir, 'identity.sqlite3');
    const store = new IdentityStore({ dbPath });
    store.applyBootstrap(bootstrapWithToken(TOKEN));
    store.close();

    // Reopen on the same file: migration is a no-op, version stays 1.
    const reopened = new IdentityStore({ dbPath });
    assert.equal(reopened.revocationEpoch >= 1, true, 'seeding bumped the epoch');
    reopened.close();

    const raw = new DatabaseSync(dbPath);
    const version = raw
      .prepare("SELECT value FROM lumithink_a2a_identity_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    assert.equal(Number(version.value), A2A_IDENTITY_SCHEMA_VERSION);
    raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
