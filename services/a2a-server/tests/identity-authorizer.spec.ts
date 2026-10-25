/**
 * Authorizer tests (P1-03, issue #85): two-tier resolution (client +
 * principal), assurance levels, short-term grant validation (scope/expiry/
 * revocation/session binding — AC 4 negatives), epoch-validated decision
 * cache (AC 3 缓存) and the executor admission gate (工具提交).
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  IdentityStore,
  defaultValidationBootstrap,
  type IdentityBootstrap,
} from '../src/identity/identity-store.ts';
import { Authorizer } from '../src/identity/authorizer.ts';

const TOKEN = 'synthetic-validation-token-0123456789abcdef';
const DEVICE_TOKEN = 'synthetic-device-token-0123456789abcdef';

function richBootstrap(nowMs: number): IdentityBootstrap {
  const base = defaultValidationBootstrap(TOKEN);
  return {
    ...base,
    clients: [
      ...base.clients,
      {
        clientId: 'xiaozhi-device-1',
        kind: 'xiaozhi_device',
        displayName: 'Synthetic device adapter',
        householdId: 'hh-synthetic-01',
      },
    ],
    credentials: [
      ...base.credentials,
      {
        credentialId: 'cred-device-1',
        clientId: 'xiaozhi-device-1',
        token: DEVICE_TOKEN,
        binding: 'client_only',
      },
    ],
    grants: [
      {
        grantId: 'grant-session-1',
        clientId: 'xiaozhi-device-1',
        householdId: 'hh-synthetic-01',
        kind: 'session_verified',
        userId: 'user-guardian-synthetic',
        sessionBinding: 'conn-gen-1',
        scope: ['chat.general', 'learning.fact.read'],
        expiresAtMs: nowMs + 300_000,
      },
      {
        grantId: 'grant-candidate-1',
        clientId: 'xiaozhi-device-1',
        householdId: 'hh-synthetic-01',
        kind: 'voiceprint_candidate',
        candidateUserId: 'user-child-synthetic',
        sessionBinding: 'conn-gen-1',
        scope: ['chat.general', 'personalization.low_sensitivity.read'],
        expiresAtMs: nowMs + 300_000,
      },
    ],
  };
}

function harness(options: { nowMs?: number } = {}): {
  store: IdentityStore;
  authorizer: Authorizer;
  now: () => number;
} {
  let nowMs = options.nowMs ?? 1_780_000_000_000;
  const store = new IdentityStore({ dbPath: ':memory:', now: () => nowMs });
  store.applyBootstrap(richBootstrap(nowMs));
  const authorizer = new Authorizer({ store, now: () => nowMs });
  return { store, authorizer, now: () => nowMs };
}

test('unknown credentials deny with a stable code; the default bootstrap token resolves the bound guardian', () => {
  const { store, authorizer } = harness();
  try {
    const unknown = authorizer.resolve('never-registered-token-0123456789');
    assert.equal(unknown.kind, 'denied');
    assert.equal(unknown.kind === 'denied' && unknown.code, 'unknown_credential');

    const outcome = authorizer.resolve(TOKEN);
    assert.equal(outcome.kind, 'authorized');
    if (outcome.kind !== 'authorized') return;
    assert.equal(outcome.auth.clientId, 'validation-harness');
    assert.equal(outcome.auth.clientKind, 'dsh_profile');
    assert.equal(outcome.auth.householdId, 'hh-synthetic-01');
    assert.equal(outcome.auth.principal.kind, 'bound_user');
    if (outcome.auth.principal.kind !== 'bound_user') return;
    assert.equal(outcome.auth.principal.userId, 'user-guardian-synthetic');
    assert.equal(outcome.auth.principal.role, 'guardian');
    assert.equal(outcome.auth.principal.assurance, 'credential_bound');
  } finally {
    store.close();
  }
});

test('decision cache serves repeated resolutions and ANY revocation invalidates it immediately (AC 3)', () => {
  const { store, authorizer } = harness();
  try {
    const first = authorizer.resolve(TOKEN);
    assert.equal(first.kind, 'authorized');
    assert.equal(authorizer.cacheSize, 1, 'the decision is cached');
    const second = authorizer.resolve(TOKEN);
    assert.equal(second.kind, 'authorized');
    assert.equal(authorizer.cacheSize, 1, 'the same entry is reused, not duplicated');

    // Revocation bumps the epoch; the cached decision must die instantly.
    assert.equal(store.revokeCredential('cred-validation-harness'), true);
    const after = authorizer.resolve(TOKEN);
    assert.equal(after.kind, 'denied');
    assert.equal(after.kind === 'denied' && after.code, 'credential_revoked');
  } finally {
    store.close();
  }
});

test('membership revocation invalidates cached decisions for the bound principal (AC 3)', () => {
  const { store, authorizer } = harness();
  try {
    assert.equal(authorizer.resolve(TOKEN).kind, 'authorized');
    assert.equal(store.revokeMembership('hh-synthetic-01', 'user-guardian-synthetic'), true);
    const outcome = authorizer.resolve(TOKEN);
    assert.equal(outcome.kind, 'denied');
    assert.equal(outcome.kind === 'denied' && outcome.code, 'principal_membership_revoked');
  } finally {
    store.close();
  }
});

test('expired credentials deny (deterministic wall clock)', () => {
  let nowMs = 1_780_000_000_000;
  const store = new IdentityStore({ dbPath: ':memory:', now: () => nowMs });
  try {
    store.applyBootstrap({
      ...defaultValidationBootstrap(TOKEN),
      credentials: [
        {
          credentialId: 'cred-expiring',
          clientId: 'validation-harness',
          token: TOKEN,
          binding: 'bound_principal',
          principalUserId: 'user-guardian-synthetic',
          householdId: 'hh-synthetic-01',
          expiresAtMs: nowMs + 1_000,
        },
      ],
    });
    const authorizer = new Authorizer({ store, now: () => nowMs });
    assert.equal(authorizer.resolve(TOKEN).kind, 'authorized');
    nowMs += 2_000;
    const outcome = authorizer.resolve(TOKEN);
    assert.equal(outcome.kind, 'denied');
    assert.equal(outcome.kind === 'denied' && outcome.code, 'credential_expired');
  } finally {
    store.close();
  }
});

test('device client_only credential: visitor by default; grants elevate with scope+expiry+session binding', () => {
  const { store, authorizer, now } = harness();
  try {
    // No grant → unverified visitor.
    const visitor = authorizer.resolve(DEVICE_TOKEN);
    assert.equal(visitor.kind, 'authorized');
    if (visitor.kind !== 'authorized') return;
    assert.equal(visitor.auth.principal.kind, 'visitor');
    assert.equal(visitor.auth.principal.assurance, 'unverified_visitor');
    assert.equal(visitor.auth.householdId, 'hh-synthetic-01', 'device authenticates the household');

    // Session-verified grant elevates to the confirmed user.
    const elevated = authorizer.resolve(DEVICE_TOKEN, 'grant-session-1', 'conn-gen-1');
    assert.equal(elevated.kind, 'authorized');
    if (elevated.kind !== 'authorized') return;
    assert.equal(elevated.auth.principal.kind, 'session_verified');
    if (elevated.auth.principal.kind !== 'session_verified') return;
    assert.equal(elevated.auth.principal.userId, 'user-guardian-synthetic');
    assert.equal(elevated.auth.principal.role, 'guardian');
    assert.equal(elevated.auth.principal.grantId, 'grant-session-1');

    // Voiceprint candidate grant: candidate principal, NEVER a verified user.
    const candidate = authorizer.resolve(DEVICE_TOKEN, 'grant-candidate-1', 'conn-gen-1');
    assert.equal(candidate.kind, 'authorized');
    if (candidate.kind !== 'authorized') return;
    assert.equal(candidate.auth.principal.kind, 'voiceprint_candidate');
    if (candidate.auth.principal.kind !== 'voiceprint_candidate') return;
    assert.equal(candidate.auth.principal.candidateUserId, 'user-child-synthetic');
    assert.equal(candidate.auth.principal.assurance, 'voiceprint_candidate');

    // Grant elevation is per-request state: it must NOT poison the cache.
    const afterElevation = authorizer.resolve(DEVICE_TOKEN);
    assert.equal(afterElevation.kind, 'authorized');
    if (afterElevation.kind !== 'authorized') return;
    assert.equal(afterElevation.auth.principal.kind, 'visitor', 'cache never keeps the elevation');

    // AC 4 negatives: expiry, revocation, client binding, session binding.
    assert.equal(store.revokeGrant('grant-session-1'), true);
    const revoked = authorizer.resolve(DEVICE_TOKEN, 'grant-session-1', 'conn-gen-1');
    assert.equal(revoked.kind, 'denied');
    assert.equal(revoked.kind === 'denied' && revoked.code, 'grant_revoked');

    const mismatched = authorizer.validateGrant('grant-candidate-1', 'validation-harness', now());
    assert.equal(mismatched, 'grant_client_mismatch', 'a grant never elevates another client');

    const unknownGrant = authorizer.validateGrant('grant-ghost', 'xiaozhi-device-1', now());
    assert.equal(unknownGrant, 'grant_unknown');

    // 会话绑定负例 (AC 4): referencing a grant WITHOUT its session binding, or
    // with a stale connection generation, denies fail-closed.
    const missingBinding = authorizer.resolve(DEVICE_TOKEN, 'grant-candidate-1');
    assert.equal(missingBinding.kind, 'denied');
    assert.equal(missingBinding.kind === 'denied' && missingBinding.code, 'grant_session_mismatch');
    const staleBinding = authorizer.resolve(DEVICE_TOKEN, 'grant-candidate-1', 'conn-gen-2');
    assert.equal(staleBinding.kind, 'denied');
    assert.equal(staleBinding.kind === 'denied' && staleBinding.code, 'grant_session_mismatch');
  } finally {
    store.close();
  }
});

test('expired grants deny even though the device credential itself is fine (AC 4)', () => {
  let nowMs = 1_780_000_000_000;
  const store = new IdentityStore({ dbPath: ':memory:', now: () => nowMs });
  try {
    store.applyBootstrap(richBootstrap(nowMs));
    const authorizer = new Authorizer({ store, now: () => nowMs });
    assert.equal(authorizer.resolve(DEVICE_TOKEN, 'grant-session-1', 'conn-gen-1').kind, 'authorized');
    nowMs += 301_000;
    const outcome = authorizer.resolve(DEVICE_TOKEN, 'grant-session-1', 'conn-gen-1');
    assert.equal(outcome.kind, 'denied');
    assert.equal(outcome.kind === 'denied' && outcome.code, 'grant_expired');
  } finally {
    store.close();
  }
});

test('executor admission gate re-checks CURRENT state and denies on membership revocation (工具提交, AC 3)', () => {
  const { store, authorizer } = harness();
  try {
    const auth = authorizer.resolve(TOKEN);
    assert.equal(auth.kind, 'authorized');
    if (auth.kind !== 'authorized') return;

    // Unbound task (in-flight acceptance window): allowed, no false cancel.
    assert.deepEqual(authorizer.assertTaskStillAuthorized('task-ghost'), {
      allowed: true,
      reason: 'task_not_bound_yet',
    });

    store.bindTask({ taskId: 'task-live', contextId: 'ctx-live', auth: auth.auth });
    assert.deepEqual(authorizer.assertTaskStillAuthorized('task-live'), { allowed: true });

    // Membership revoked AFTER acceptance → admission closes.
    store.revokeMembership('hh-synthetic-01', 'user-guardian-synthetic');
    const decision = authorizer.assertTaskStillAuthorized('task-live');
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'principal_membership_revoked');
  } finally {
    store.close();
  }
});
