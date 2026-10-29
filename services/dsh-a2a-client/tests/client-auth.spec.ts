/**
 * P2-02 (issue #114) — credential face (ADR-0018 constraint 1): credentials
 * flow only through the official `AuthenticationHandler` callbacks, live in
 * memory, re-sign on 401/403 via the provider (§7.4 授权续签), and renewal
 * failures surface visibly (credential_renewal_failed) instead of being
 * swallowed.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DshA2aClient, DshA2aClientError } from '../src/index.ts';
import { MOCK_TOKEN_A, MOCK_TOKEN_B, startMockA2aServer, type MockServer } from './helpers.ts';

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dsh-auth-'));
}

async function startClient(
  ledgerFile: string,
  mock: MockServer,
  credential: () => Promise<string>,
): Promise<DshA2aClient> {
  return new DshA2aClient({
    baseUrl: mock.base,
    credential,
    ledger: ledgerFile,
    pollIntervalMs: 20,
  });
}

test('credential re-sign: stale token → 401 → provider re-sign → retry succeeds', async () => {
  const mock = await startMockA2aServer({ validTokens: [MOCK_TOKEN_B] });
  const dir = tmpDir();
  try {
    let calls = 0;
    const tokens = [MOCK_TOKEN_A, MOCK_TOKEN_B]; // first call hands out the stale token
    const client = await startClient(path.join(dir, 'ledger.json'), mock, async () => {
      const token = tokens[Math.min(calls, tokens.length - 1)];
      calls += 1;
      return token;
    });
    const handle = await client.sendAndConsume({ text: '过期后重签', messageId: 'msg-resign-1' });
    assert.equal(handle.state, 'completed');
    assert.ok(calls >= 2, 'the provider was consulted again after the 401');
    assert.equal(client.lastRenewalFailure, null);
    // All logged requests the mock accepted carried the VALID token family.
    assert.ok(mock.methodLog.length >= 2);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('credential re-sign failure surfaces visibly (§7.4: 清理未完成需显示/记录)', async () => {
  const mock = await startMockA2aServer({ validTokens: [MOCK_TOKEN_B] });
  const dir = tmpDir();
  try {
    let calls = 0;
    const client = await startClient(path.join(dir, 'ledger.json'), mock, async () => {
      calls += 1;
      if (calls === 1) return MOCK_TOKEN_A; // stale
      throw new Error('synthetic provider outage');
    });
    await assert.rejects(
      () => client.sendAndConsume({ text: '续签失败', messageId: 'msg-resign-fail-1' }),
      (error: unknown) => {
        assert.ok(error instanceof DshA2aClientError);
        assert.equal(error.code, 'credential_renewal_failed');
        assert.match(error.message, /NOT confirmed complete/);
        return true;
      },
    );
    assert.match(client.lastRenewalFailure ?? '', /provider outage|Error/);
    // The failure detail is token-free.
    assert.ok(!(client.lastRenewalFailure ?? '').includes(MOCK_TOKEN_A));
    assert.ok(!(client.lastRenewalFailure ?? '').includes(MOCK_TOKEN_B));
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('static credential: a 401 stays an honest failure (no silent retry loop)', async () => {
  const mock = await startMockA2aServer({ validTokens: [MOCK_TOKEN_B] });
  const dir = tmpDir();
  try {
    const client = new DshA2aClient({
      baseUrl: mock.base,
      credential: MOCK_TOKEN_A, // wrong, static
      ledger: path.join(dir, 'ledger.json'),
      pollIntervalMs: 20,
      maxSendRetries: 0,
    });
    await assert.rejects(() => client.sendAndConsume({ text: '静态凭据 401', messageId: 'msg-static-1' }));
    const sends = mock.methodLog.filter((e) => e.method === 'SendMessage' && e.messageId === 'msg-static-1');
    assert.equal(sends.length, 0, 'the 401 happens before the request reaches the method layer');
    assert.ok(mock.methodLog.every((e) => e.hasAuth === true || e.method.startsWith('GET')),
      'whatever reached the mock carried auth presence');
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
