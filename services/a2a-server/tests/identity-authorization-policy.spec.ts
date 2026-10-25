/**
 * Centralized authorization policy tests (P1-03, issue #85 AC 2/AC 4):
 * same-household shared facts are decided by relationship AND operation;
 * voiceprint candidates never reach private data; P1 freezes writes and raw
 * conversation reads to deny. The policy takes ONLY server-resolved inputs —
 * there is no parameter a caller could forge (AC 1 by construction).
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { authorizeOperation, authorizeGrantScopedOperation } from '../src/identity/authorization-policy.ts';
import type { AuthContext } from '../src/identity/model.ts';

function boundUser(userId: string, role: 'guardian' | 'child' | 'member'): AuthContext {
  return {
    credentialId: `cred-${userId}`,
    clientId: 'validation-harness',
    clientKind: 'dsh_profile',
    householdId: 'hh-alpha',
    principal: { kind: 'bound_user', userId, role, assurance: 'credential_bound' },
    revocationEpoch: 0,
    resolvedAtMs: 0,
  };
}

function sessionVerified(userId: string, role: 'guardian' | 'child' | 'member'): AuthContext {
  const base = boundUser(userId, role);
  return {
    ...base,
    principal: {
      kind: 'session_verified',
      userId,
      role,
      assurance: 'session_verified',
      grantId: 'g-1',
    },
  };
}

function candidate(candidateUserId: string): AuthContext {
  return {
    credentialId: 'cred-device',
    clientId: 'xiaozhi-device-1',
    clientKind: 'xiaozhi_device',
    householdId: 'hh-alpha',
    principal: {
      kind: 'voiceprint_candidate',
      candidateUserId,
      assurance: 'voiceprint_candidate',
      grantId: 'g-2',
    },
    revocationEpoch: 0,
    resolvedAtMs: 0,
  };
}

function visitor(): AuthContext {
  return {
    credentialId: 'cred-device',
    clientId: 'xiaozhi-device-1',
    clientKind: 'xiaozhi_device',
    householdId: 'hh-alpha',
    principal: { kind: 'visitor', assurance: 'unverified_visitor' },
    revocationEpoch: 0,
    resolvedAtMs: 0,
  };
}

test('tenant isolation: a target household differing from the authorized scope is always denied', () => {
  const guardian = boundUser('user-guardian', 'guardian');
  for (const operation of ['chat.general', 'learning.fact.read'] as const) {
    const decision = authorizeOperation({
      auth: guardian,
      operation,
      targetHouseholdId: 'hh-beta',
    });
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed ? '' : decision.reason, 'cross_household_denied');
  }
  // A context with NO authorized household scope denies everything.
  const scopeless = { ...visitor(), householdId: null };
  const decision = authorizeOperation({
    auth: scopeless,
    operation: 'chat.general',
    targetHouseholdId: 'hh-alpha',
  });
  assert.equal(decision.allowed, false);
});

test('guardian reads child learning facts ONLY with the active guardian relationship (AC 2)', () => {
  const guardian = boundUser('user-guardian', 'guardian');
  const withRelationship = authorizeOperation({
    auth: guardian,
    operation: 'learning.fact.read',
    targetHouseholdId: 'hh-alpha',
    targetSubjectUserId: 'user-child',
    callerHasGuardianRelationship: true,
  });
  assert.equal(withRelationship.allowed, true);

  const withoutRelationship = authorizeOperation({
    auth: guardian,
    operation: 'learning.fact.read',
    targetHouseholdId: 'hh-alpha',
    targetSubjectUserId: 'user-other-child',
    callerHasGuardianRelationship: false,
  });
  assert.equal(withoutRelationship.allowed, false);
  assert.equal(withoutRelationship.allowed ? '' : withoutRelationship.reason,
    'learning_read_requires_guardian_relationship');

  // “家长”角色 alone is not a relationship: role without the relationship row denies.
  const roleOnly = authorizeOperation({
    auth: guardian,
    operation: 'learning.fact.read',
    targetHouseholdId: 'hh-alpha',
    targetSubjectUserId: 'user-child',
  });
  assert.equal(roleOnly.allowed, false);
});

test('child self access is allowed; other members cannot read another child’s facts (AC 2)', () => {
  const child = boundUser('user-child', 'child');
  const own = authorizeOperation({
    auth: child,
    operation: 'learning.fact.read',
    targetHouseholdId: 'hh-alpha',
    targetSubjectUserId: 'user-child',
  });
  assert.equal(own.allowed, true, 'children read their own (age-appropriate) facts');

  const otherMember = boundUser('user-member', 'member');
  const foreign = authorizeOperation({
    auth: otherMember,
    operation: 'learning.fact.read',
    targetHouseholdId: 'hh-alpha',
    targetSubjectUserId: 'user-child',
  });
  assert.equal(foreign.allowed, false);
});

test('P1 freeze: learning/plan writes and raw conversation reads are denied for everyone', () => {
  const guardian = boundUser('user-guardian', 'guardian');
  const child = boundUser('user-child', 'child');
  for (const auth of [guardian, child]) {
    for (const operation of [
      'learning.fact.write',
      'plan.write',
      'conversation.raw.read',
    ] as const) {
      const decision = authorizeOperation({
        auth,
        operation,
        targetHouseholdId: 'hh-alpha',
        targetSubjectUserId: 'user-child',
      });
      assert.equal(decision.allowed, false, `${operation} must deny for ${auth.principal.kind}`);
    }
  }
});

test('household administration is guardian-only', () => {
  const guardian = boundUser('user-guardian', 'guardian');
  assert.equal(
    authorizeOperation({ auth: guardian, operation: 'household.admin', targetHouseholdId: 'hh-alpha' })
      .allowed,
    true,
  );
  const child = boundUser('user-child', 'child');
  const denied = authorizeOperation({ auth: child, operation: 'household.admin', targetHouseholdId: 'hh-alpha' });
  assert.equal(denied.allowed, false);
});

test('unverified visitors may only chat (AC 4)', () => {
  const v = visitor();
  assert.equal(
    authorizeOperation({ auth: v, operation: 'chat.general', targetHouseholdId: 'hh-alpha' }).allowed,
    true,
  );
  const privateRead = authorizeOperation({
    auth: v,
    operation: 'learning.fact.read',
    targetHouseholdId: 'hh-alpha',
    targetSubjectUserId: 'user-child',
  });
  assert.equal(privateRead.allowed, false);
  assert.equal(privateRead.allowed ? '' : privateRead.reason, 'unverified_visitor_private_denied');
});

test('voiceprint candidates stay on the shared-device allowlist and never reach private data (AC 4)', () => {
  const c = candidate('user-child');
  assert.equal(
    authorizeOperation({ auth: c, operation: 'chat.general', targetHouseholdId: 'hh-alpha' }).allowed,
    true,
  );
  const ownPersonalization = authorizeOperation({
    auth: c,
    operation: 'personalization.low_sensitivity.read',
    targetHouseholdId: 'hh-alpha',
    targetSubjectUserId: 'user-child',
  });
  assert.equal(ownPersonalization.allowed, true, 'low-sensitivity personalization for the candidate itself');

  const otherPersonalization = authorizeOperation({
    auth: c,
    operation: 'personalization.low_sensitivity.read',
    targetHouseholdId: 'hh-alpha',
    targetSubjectUserId: 'user-guardian',
  });
  assert.equal(otherPersonalization.allowed, false, 'never another member’s profile');

  const privateRead = authorizeOperation({
    auth: c,
    operation: 'learning.fact.read',
    targetHouseholdId: 'hh-alpha',
    targetSubjectUserId: 'user-child',
  });
  assert.equal(privateRead.allowed, false, 'a high-confidence candidate still has NO private data permission');
  assert.equal(privateRead.allowed ? '' : privateRead.reason, 'voiceprint_candidate_private_denied');

  // Even the candidate's own household admin/plan surface is closed.
  assert.equal(
    authorizeOperation({ auth: c, operation: 'household.admin', targetHouseholdId: 'hh-alpha' }).allowed,
    false,
  );
});

test('session_verified principals follow the same matrix as credential-bound ones', () => {
  const guardian = sessionVerified('user-guardian', 'guardian');
  const read = authorizeOperation({
    auth: guardian,
    operation: 'learning.fact.read',
    targetHouseholdId: 'hh-alpha',
    targetSubjectUserId: 'user-child',
    callerHasGuardianRelationship: true,
  });
  assert.equal(read.allowed, true);
});

test('grant-scoped operations must be inside the grant scope (AC 4 范围负例)', () => {
  const elevated = sessionVerified('user-guardian', 'guardian');
  const insideScope = authorizeGrantScopedOperation(
    {
      auth: elevated,
      operation: 'learning.fact.read',
      targetHouseholdId: 'hh-alpha',
      targetSubjectUserId: 'user-child',
      callerHasGuardianRelationship: true,
    },
    ['chat.general', 'learning.fact.read'],
  );
  assert.equal(insideScope.allowed, true);

  const outsideScope = authorizeGrantScopedOperation(
    {
      auth: elevated,
      operation: 'household.admin',
      targetHouseholdId: 'hh-alpha',
    },
    ['chat.general', 'learning.fact.read'],
  );
  assert.equal(outsideScope.allowed, false);
  assert.equal(outsideScope.allowed ? '' : outsideScope.reason, 'operation_outside_grant_scope');
});
