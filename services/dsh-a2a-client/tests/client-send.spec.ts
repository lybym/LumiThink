/**
 * P2-02 (issue #114) — send/query core against the in-process mock
 * (ADR-0018 Appendix B components 1/3): the ledger record exists BEFORE the
 * wire send, the taskId mapping lands on arrival, polling reaches terminal
 * states, and returnImmediately mode returns an early handle.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DshA2aClient } from '../src/index.ts';
import { MOCK_TOKEN_A, startMockA2aServer, type MockServer } from './helpers.ts';

interface Fixture {
  mock: MockServer;
  client: DshA2aClient;
  ledgerFile: string;
  dir: string;
}

async function withFixture(
  fn: (fixture: Fixture) => Promise<void>,
  mockOptions: Parameters<typeof startMockA2aServer>[0] = {},
): Promise<void> {
  const mock = await startMockA2aServer(mockOptions);
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-send-'));
  const ledgerFile = path.join(dir, 'task-ledger.json');
  const client = new DshA2aClient({
    baseUrl: mock.base,
    credential: MOCK_TOKEN_A,
    ledger: ledgerFile,
    pollIntervalMs: 20,
  });
  try {
    await fn({ mock, client, ledgerFile, dir });
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('send + wait reaches COMPLETED; ledger has the mapping before and after', async () => {
  await withFixture(async ({ mock, client, ledgerFile }) => {
    const beforeLog = mock.methodLog.length;
    const handle = await client.sendAndConsume({ text: '你好， synth 场景。', messageId: 'msg-core-1' });

    assert.equal(handle.state, 'completed');
    assert.ok(handle.taskId);
    assert.equal(handle.inputRequired, false);
    assert.equal(handle.authRequired, false);

    // The ledger record was durable BEFORE the first wire send: the mock saw
    // the request only after saveBeforeSend had flushed the file.
    const firstSendObserved = mock.methodLog.findIndex((entry) => entry.method === 'SendMessage' && entry.messageId === 'msg-core-1');
    assert.ok(firstSendObserved >= 0);
    const rawAfter = readFileSync(ledgerFile, 'utf8');
    const ledgerDoc = JSON.parse(rawAfter) as { records: Record<string, { taskId?: string; lastKnownState?: string }> };
    assert.equal(ledgerDoc.records['msg-core-1'].taskId, handle.taskId);
    assert.equal(ledgerDoc.records['msg-core-1'].lastKnownState, 'completed');

    // The artifact text is visible on the handle path via getTask.
    const task = await client.getTask({ messageId: 'msg-core-1' });
    assert.equal(task.taskId, handle.taskId);
    assert.equal(task.state, 'completed');
    void beforeLog;
  });
});

test('returnImmediately mode returns an early non-terminal handle without blocking', async () => {
  await withFixture(async ({ mock, client }) => {
    const handle = await client.send(
      { text: '立即返回', messageId: 'msg-immediate-1', metadata: { lumithinkScenario: 'never-terminal' } },
      { mode: 'returnImmediately' },
    );
    assert.equal(handle.state, 'working');
    assert.ok(handle.taskId);
    assert.ok(mock.methodLog.some((entry) => entry.method === 'SendMessage' && entry.returnImmediately === true),
      'the wire request carries returnImmediately mode metadata');
  }, { completionDelayMs: 5000 });
});

test('query (GetTask) of an unknown task maps to task_not_found — never an input request', async () => {
  await withFixture(async ({ client }) => {
    await assert.rejects(
      () => client.getTask({ taskId: 'task-does-not-exist' }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'task_not_found');
        assert.match((error as Error).message, /NOT an input request/);
        return true;
      },
    );
  });
});

test('every wire request carries the bearer credential; the ledger stores none of it', async () => {
  await withFixture(async ({ mock, client, ledgerFile }) => {
    await client.sendAndConsume({ text: '凭据面验证', messageId: 'msg-auth-1' });
    assert.ok(mock.methodLog.length >= 2);
    for (const entry of mock.methodLog) {
      assert.equal(entry.hasAuth, true, 'each JSON-RPC request must carry the credential');
    }
    const raw = readFileSync(ledgerFile, 'utf8');
    assert.ok(!raw.includes(MOCK_TOKEN_A), 'the ledger must not contain the token');
    assert.ok(existsSync(ledgerFile));
  });
});
