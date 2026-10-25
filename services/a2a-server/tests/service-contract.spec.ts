/**
 * Service contract checks (P1-01, issue #83): fail-closed config, loopback
 * lock, Agent Card contract (single agent, bearer scheme declared), and the
 * A2A-Version middleware unit behavior (R7).
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  A2A_LOOPBACK_HOST,
  A2A_VALIDATION_DEFAULT_PORT,
  loadA2aServiceConfig,
} from '../src/config.ts';
import { buildLumithinkAgentCard, LUMITHINK_A2A_VERSION } from '../src/lumithink-agent-card.ts';
import { requireA2aVersion } from '../src/error-map.ts';

function fakeRes() {
  const payload = { status: 0, body: null as unknown };
  return {
    payload,
    status(code: number) {
      payload.status = code;
      return this;
    },
    json(body: unknown) {
      payload.body = body;
      return this;
    },
  };
}

test('config: default validation port is the reserved 3312, loopback-locked, fail-closed token', () => {
  assert.equal(A2A_VALIDATION_DEFAULT_PORT, 3312,
    'deploy/validation reserves 127.0.0.1:3312 for the A2A validation service (#81)');
  assert.equal(A2A_LOOPBACK_HOST, '127.0.0.1');

  const config = loadA2aServiceConfig({ LUMITHINK_A2A_VALIDATION_TOKEN: 'a-synthetic-token-0123456789' });
  assert.equal(config.port, 3312, 'defaults to the reserved validation port');
  assert.equal(config.host, '127.0.0.1', 'host is hard-locked to loopback');
  assert.deepEqual(config.supportedVersions, ['1.0']);
});

test('config: refuses to start without a bearer token (fail-closed)', () => {
  assert.throws(() => loadA2aServiceConfig({}), /LUMITHINK_A2A_VALIDATION_TOKEN/);
  assert.throws(() => loadA2aServiceConfig({ LUMITHINK_A2A_VALIDATION_TOKEN: 'short' }), /at least 16/);
});

test('config: rejects non-integer or out-of-range ports', () => {
  assert.throws(
    () => loadA2aServiceConfig({ LUMITHINK_A2A_VALIDATION_PORT: 'not-a-port', LUMITHINK_A2A_VALIDATION_TOKEN: 'a-synthetic-token-0123456789' }),
    /LUMITHINK_A2A_VALIDATION_PORT/,
  );
});

test('agent card: ONE lumithink agent, bearer scheme declared, no Companion/Learning split', () => {
  const card = buildLumithinkAgentCard('http://127.0.0.1:3312');
  assert.equal(card.name, 'lumithink');
  assert.equal(card.skills.length, 1, 'a single skill list on the single agent');
  assert.equal(card.supportedInterfaces.length, 1);
  assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
  assert.equal(card.supportedInterfaces[0].protocolVersion, LUMITHINK_A2A_VERSION);
  assert.equal(card.capabilities?.streaming, true);
  assert.ok('bearerAuth' in card.securitySchemes, 'the card declares the bearer scheme');
  assert.ok(card.skills.every((skill) => skill.tags.includes('synthetic')),
    'every advertised skill is explicitly synthetic');
});

test('A2A-Version middleware: explicit guard rejects missing and unsupported versions (R7)', () => {
  const middleware = requireA2aVersion({ supportedVersions: ['1.0'] });
  const run = (version?: string) => {
    const res = fakeRes();
    let passed = false;
    middleware(
      { method: 'POST', headers: version === undefined ? {} : { 'a2a-version': version }, body: { id: 7 } } as never,
      res as never,
      () => {
        passed = true;
      },
    );
    return { passed, payload: res.payload };
  };

  const ok = run('1.0');
  assert.ok(ok.passed, '1.0 passes through');
  assert.equal(ok.payload.status, 0, 'no response written for supported version');

  for (const version of [undefined, '', '9.9', '0.3']) {
    const bad = run(version);
    assert.ok(!bad.passed, `version ${String(version)} must not pass`);
    assert.equal(bad.payload.status, 200, 'version errors are HTTP 200 + JSON-RPC error body');
    const error = (bad.payload.body as { error?: { code?: number; message?: string } }).error;
    assert.equal(error?.code, -32009);
    assert.match(error?.message ?? '', /Supported versions: 1\.0/);
  }
});
