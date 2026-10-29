/**
 * P2-02 (issue #114) — config fail-closed contract (ADR-0018 constraint 1).
 * Missing credential/URL/ledger ⇒ refuse to start. No token ever appears in
 * an error message.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadDshA2aClientConfig, resolveDshA2aClientConfig, DshA2aClient } from '../src/index.ts';
import { DshA2aClientError } from '../src/errors.ts';

const TOKEN = 'synthetic-config-token-0123456789abcdef';

test('loadDshA2aClientConfig: missing URL refuses to start (fail-closed)', () => {
  assert.throws(
    () => loadDshA2aClientConfig({ LUMITHINK_A2A_CLIENT_TOKEN: TOKEN, LUMITHINK_A2A_CLIENT_LEDGER_PATH: 'x.json' } as NodeJS.ProcessEnv),
    (error: unknown) => error instanceof DshA2aClientError && error.code === 'credential_missing',
  );
});

test('loadDshA2aClientConfig: missing/short token refuses to start (fail-closed)', () => {
  assert.throws(
    () => loadDshA2aClientConfig({ LUMITHINK_A2A_CLIENT_URL: 'http://127.0.0.1:3312', LUMITHINK_A2A_CLIENT_LEDGER_PATH: 'x.json' } as NodeJS.ProcessEnv),
    (error: unknown) => error instanceof DshA2aClientError && error.code === 'credential_missing',
  );
  assert.throws(
    () =>
      loadDshA2aClientConfig({
        LUMITHINK_A2A_CLIENT_URL: 'http://127.0.0.1:3312',
        LUMITHINK_A2A_CLIENT_TOKEN: 'short',
        LUMITHINK_A2A_CLIENT_LEDGER_PATH: 'x.json',
      } as NodeJS.ProcessEnv),
    (error: unknown) => error instanceof DshA2aClientError && error.code === 'credential_missing',
  );
});

test('loadDshA2aClientConfig: missing ledger path refuses to start (fail-closed)', () => {
  assert.throws(
    () => loadDshA2aClientConfig({ LUMITHINK_A2A_CLIENT_URL: 'http://127.0.0.1:3312', LUMITHINK_A2A_CLIENT_TOKEN: TOKEN } as NodeJS.ProcessEnv),
    (error: unknown) => error instanceof DshA2aClientError && error.code === 'credential_missing',
  );
});

test('loadDshA2aClientConfig: full env resolves with §7.3 cancel default (2000ms)', () => {
  const config = loadDshA2aClientConfig({
    LUMITHINK_A2A_CLIENT_URL: 'http://127.0.0.1:3312',
    LUMITHINK_A2A_CLIENT_TOKEN: TOKEN,
    LUMITHINK_A2A_CLIENT_LEDGER_PATH: path.join(mkdtempSync(path.join(tmpdir(), 'dsh-client-cfg-')), 'ledger.json'),
  } as NodeJS.ProcessEnv);
  const resolved = resolveDshA2aClientConfig(config);
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:3312');
  assert.equal(resolved.cancelResponseTimeoutMs, 2000);
  assert.equal(resolved.pollIntervalMs, 250);
  assert.equal(resolved.maxSendRetries, 2);
});

test('explicit config: missing credential refuses client construction', () => {
  assert.throws(
    () =>
      new DshA2aClient({
        baseUrl: 'http://127.0.0.1:3312',
        credential: '',
        ledger: path.join(mkdtempSync(path.join(tmpdir(), 'dsh-client-cfg-')), 'ledger.json'),
      }),
    (error: unknown) => error instanceof DshA2aClientError && error.code === 'credential_missing',
  );
});

test('explicit config: missing durable ledger refuses client construction', () => {
  assert.throws(
    () => new DshA2aClient({ baseUrl: 'http://127.0.0.1:3312', credential: TOKEN, ledger: undefined as unknown as string }),
    (error: unknown) => error instanceof DshA2aClientError && error.code === 'invalid_config',
  );
});
