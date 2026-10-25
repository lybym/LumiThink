/**
 * P1-04 request-key / fingerprint unit tests (issue #86; TASK_LIFECYCLE
 * §5.1): identity-scoped key composition, canonical-JSON stability under
 * re-serialization, transport-mode exclusion, and delimiter-collision
 * resistance of the key encoding.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import type { AuthContext } from '../src/identity/model.ts';
import { canonicalJson, fingerprintOf, requestKeyOf } from '../src/acceptance/request-key.ts';

function authFor(clientId: string, userId: string | null, householdId: string | null): AuthContext {
  return {
    credentialId: `cred-${clientId}`,
    clientId,
    clientKind: 'dsh_profile',
    householdId,
    principal:
      userId === null
        ? { kind: 'visitor', assurance: 'unverified_visitor' }
        : { kind: 'bound_user', userId, role: 'guardian', assurance: 'credential_bound' },
    revocationEpoch: 1,
    resolvedAtMs: 0,
  };
}

const KEY = 'unit-test-fingerprint-key';

test('the request key is scoped by the FULL authenticated binding — same messageId, different caller → different key', () => {
  const guardianA = requestKeyOf({ agentName: 'lumithink', auth: authFor('client-a', 'user-a', 'hh-1'), messageId: 'm-1' });
  const guardianB = requestKeyOf({ agentName: 'lumithink', auth: authFor('client-b', 'user-a', 'hh-1'), messageId: 'm-1' });
  const otherHousehold = requestKeyOf({ agentName: 'lumithink', auth: authFor('client-a', 'user-a', 'hh-2'), messageId: 'm-1' });
  const otherUser = requestKeyOf({ agentName: 'lumithink', auth: authFor('client-a', 'user-b', 'hh-1'), messageId: 'm-1' });
  assert.notEqual(guardianA, guardianB, 'different clients never share a key');
  assert.notEqual(guardianA, otherHousehold);
  assert.notEqual(guardianA, otherUser);

  // Visitors are scoped by their client binding (stable restricted subject).
  const visitor1 = requestKeyOf({ agentName: 'lumithink', auth: authFor('device-1', null, 'hh-1'), messageId: 'm-1' });
  const visitor2 = requestKeyOf({ agentName: 'lumithink', auth: authFor('device-2', null, 'hh-1'), messageId: 'm-1' });
  assert.notEqual(visitor1, visitor2, 'visitor keys never collide across devices');
});

test('delimiter-colliding messageIds cannot map two compositions onto one key', () => {
  const composed = requestKeyOf({
    agentName: 'lumithink',
    auth: authFor('client-a', 'user-a', 'hh-1'),
    messageId: 'x',
  });
  // A messageId crafted to look like a different tuple boundary is still a
  // DIFFERENT key (JSON encoding is injective on string tuples).
  const crafted = requestKeyOf({
    agentName: 'lumithink',
    auth: authFor('client-a', 'user-a', 'hh-1'),
    messageId: '","injected',
  });
  assert.notEqual(composed, crafted);
});

test('the fingerprint is transport-mode blind: blocking send and immediate/stream retry match', () => {
  const message = { messageId: 'm-1', role: 'ROLE_USER', parts: [{ text: '你好' }] };
  // The fingerprint covers ONLY the message — returnImmediately/blocking,
  // historyLength, JSON-RPC id and tokens never enter it (§5.1).
  const direct = fingerprintOf(message, KEY);
  const retried = fingerprintOf(message, KEY);
  assert.equal(direct, retried);
  assert.match(direct, /^fpv1:/, 'the normalization rule is pinned by a version prefix');
});

test('re-serialized (key-order-changed) retries fingerprint identically; content changes conflict', () => {
  const first = fingerprintOf(
    { messageId: 'm-1', role: 'ROLE_USER', metadata: { lumithinkScenario: 'cancel-test' }, parts: [{ text: '你好' }] },
    KEY,
  );
  const reordered = fingerprintOf(
    { parts: [{ text: '你好' }], metadata: { lumithinkScenario: 'cancel-test' }, role: 'ROLE_USER', messageId: 'm-1' },
    KEY,
  );
  assert.equal(first, reordered, 'canonical JSON is key-order independent');

  const changedContent = fingerprintOf(
    { messageId: 'm-1', role: 'ROLE_USER', parts: [{ text: '不同的内容' }] },
    KEY,
  );
  assert.notEqual(first, changedContent, 'same key, different content → fingerprint conflict');
});

test('the fingerprint is an HMAC: without the server key no enumerable body digest exists', () => {
  const message = { messageId: 'm-1', parts: [{ text: '短句' }] };
  const keyed = fingerprintOf(message, KEY);
  const keylessSha256 = createHmac('sha256', 'OTHER-KEY').update(canonicalJson({ v: 1, message })).digest('hex');
  assert.notEqual(keyed, `fpv1:${keylessSha256}`, 'a different key produces a different digest');
  assert.equal(fingerprintOf(message, KEY), keyed, 'same key reproduces the fingerprint (stable ledger)');
});

test('canonicalJson sorts keys recursively and preserves array order', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [3, 1, 2], c: null } }),
    '{"a":{"c":null,"d":[3,1,2]},"b":1}',
  );
  assert.equal(canonicalJson(undefined), 'null', 'undefined folds to null, never "undefined"');
});
