/**
 * P2-02 (issue #114) — first-response-loss recovery (TASK_LIFECYCLE §5.3)
 * and restart recovery scanning:
 *   - a lost first response is recovered by RESENDING THE ORIGINAL MESSAGE
 *     (same stable messageId) — the mock's idempotency returns the SAME
 *     task; no second task is created (no duplicate inference);
 *   - a "crashed" client (ledger record without taskId) is recovered by a
 *     NEW client instance over the SAME ledger file via recover()/resumePending();
 *   - resumePending classifies pending cancel intents for reconfirmation.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DshA2aClient } from '../src/index.ts';
import { FileTaskLedger } from '../src/ledger.ts';
import { MOCK_TOKEN_A, startMockA2aServer, type MockServer } from './helpers.ts';

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'dsh-recovery-'));
}

async function startClient(ledgerFile: string, mock: MockServer): Promise<DshA2aClient> {
  return new DshA2aClient({
    baseUrl: mock.base,
    credential: MOCK_TOKEN_A,
    ledger: ledgerFile,
    pollIntervalMs: 20,
  });
}

test('§5.3: dropped first response → automatic retry with the SAME messageId → same task, no duplicate', async () => {
  const mock = await startMockA2aServer({ dropFirstResponseFor: ['msg-drop-1'], completionDelayMs: 5000 });
  const dir = tmpDir();
  try {
    const client = await startClient(path.join(dir, 'ledger.json'), mock);
    const handle = await client.send(
      {
        text: '响应会丢',
        messageId: 'msg-drop-1',
        metadata: { lumithinkScenario: 'never-terminal' },
      },
      { mode: 'returnImmediately' },
    );
    assert.ok(handle.taskId);

    // The mock destroyed the first response AFTER logging it; the client's
    // finite network retry re-sent the ORIGINAL message. The mock's
    // message-idempotency created exactly ONE task for that messageId.
    const sends = mock.methodLog.filter((e) => e.method === 'SendMessage' && e.messageId === 'msg-drop-1');
    assert.ok(sends.length >= 2, `the original messageId was retried (got ${sends.length} sends)`);
    const created = mock.tasksByMessageId.get('msg-drop-1');
    assert.ok(created);
    assert.equal(created, handle.taskId, 'the retry binds to the SAME task — no duplicate inference');
    // exactly one server-side task for this messageId
    let count = 0;
    for (const id of mock.tasksByMessageId.values()) {
      if (id === created) count += 1;
    }
    assert.equal(count, 1);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('§5.3 cross-restart: ledger record without taskId → recover() resends the original message', async () => {
  const mock = await startMockA2aServer({ completionDelayMs: 30_000 });
  const dir = tmpDir();
  const ledgerFile = path.join(dir, 'ledger.json');
  try {
    // "Crash" simulation: the record is durable, but the process died
    // before any taskId arrived (only saveBeforeSend ran).
    const ledger = new FileTaskLedger(ledgerFile);
    await ledger.saveBeforeSend({
      messageId: 'msg-crash-1',
      agentBaseUrl: mock.base,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      originalRequest: {
        method: 'message/send',
        message: {
          messageId: 'msg-crash-1',
          contextId: '',
          taskId: '',
          role: 'ROLE_USER',
          parts: [{ content: { $case: 'text', value: '崩溃前已落盘' }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
          metadata: { lumithinkScenario: 'stop-on-cancel' },
          extensions: [],
          referenceTaskIds: [],
        },
        configuration: { returnImmediately: true },
      },
      returnImmediately: true,
    });

    const firstScan = await ledger.loadAll();
    assert.equal(firstScan['msg-crash-1'].taskId, undefined);

    // A NEW client over the SAME ledger file (restart).
    const restarted = await startClient(ledgerFile, mock);
    const pending = await restarted.resumePending();
    const item = pending.find((p) => p.messageId === 'msg-crash-1');
    assert.ok(item);
    assert.equal(item.suggestedAction, 'recover_via_resend');

    const handle = await restarted.recover({ messageId: 'msg-crash-1' });
    assert.ok(handle.taskId);
    // The resend hit the SAME mock idempotency namespace — one task only.
    assert.equal(mock.tasksByMessageId.get('msg-crash-1'), handle.taskId);
    const sends = mock.methodLog.filter((e) => e.method === 'SendMessage' && e.messageId === 'msg-crash-1');
    assert.equal(sends.length, 1, 'the original request never reached the mock; the recovery resend created the task');
    assert.equal(sends[0].returnImmediately, true, 'the recovery resend is returnImmediately (§5.3)');
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart scan: non-terminal mapped record → query_or_reattach; terminal → nothing pending', async () => {
  const mock = await startMockA2aServer({ completionDelayMs: 30_000 });
  const dir = tmpDir();
  const ledgerFile = path.join(dir, 'ledger.json');
  try {
    const client = await startClient(ledgerFile, mock);
    const active = await client.send(
      { text: '跨重启仍可查询', messageId: 'msg-restart-1', metadata: { lumithinkScenario: 'stop-on-cancel' } },
      { mode: 'returnImmediately' },
    );
    const done = await client.sendAndConsume({ text: '已完成', messageId: 'msg-restart-2' });

    const restarted = await startClient(ledgerFile, mock); // simulated restart
    const pending = await restarted.resumePending();
    const activeItem = pending.find((p) => p.messageId === 'msg-restart-1');
    const doneItem = pending.find((p) => p.messageId === 'msg-restart-2');
    assert.equal(activeItem?.suggestedAction, 'query_or_reattach');
    assert.equal(activeItem?.taskId, active.taskId);
    assert.equal(activeItem?.lastKnownState, 'working');
    assert.equal(doneItem?.suggestedAction, 'nothing_pending');
    assert.equal(doneItem?.lastKnownState, 'completed');

    // The restarted client can still query the live task via the ledger mapping.
    const query = await restarted.getTask({ messageId: 'msg-restart-1' });
    assert.equal(query.taskId, active.taskId);
    assert.equal(query.state, 'working');
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart scan: unconfirmed cancel intent → reconfirm_cancel suggested', async () => {
  const mock = await startMockA2aServer({ cancelDelayMs: 1200, completionDelayMs: 30_000 });
  const dir = tmpDir();
  const ledgerFile = path.join(dir, 'ledger.json');
  try {
    const client = new DshA2aClient({
      baseUrl: mock.base,
      credential: MOCK_TOKEN_A,
      ledger: ledgerFile,
      pollIntervalMs: 20,
      cancelResponseTimeoutMs: 250,
    });
    await client.send(
      { text: '取消后崩溃', messageId: 'msg-intent-1', metadata: { lumithinkScenario: 'stop-on-cancel' } },
      { mode: 'returnImmediately' },
    );
    const outcome = await client.cancel({ messageId: 'msg-intent-1' }, 'timeout probe');
    assert.equal(outcome.status, 'unconfirmed_timeout');

    const restarted = await startClient(ledgerFile, mock);
    const pending = await restarted.resumePending();
    const item = pending.find((p) => p.messageId === 'msg-intent-1');
    assert.equal(item?.suggestedAction, 'reconfirm_cancel');
    assert.equal(item?.cancelIntentStatus, 'unconfirmed_timeout');

    // Reconfirmation through a FRESH cancel (independent context) settles it.
    const reconfirmed = await restarted.cancel({ messageId: 'msg-intent-1' }, 'restart reconfirm');
    assert.equal(reconfirmed.status, 'confirmed_canceled');
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger on disk stays the single durable copy: no in-process-only state survives', async () => {
  const mock = await startMockA2aServer({ completionDelayMs: 30_000 });
  const dir = tmpDir();
  const ledgerFile = path.join(dir, 'ledger.json');
  try {
    const client = await startClient(ledgerFile, mock);
    await client.send(
      { text: '持久唯一副本', messageId: 'msg-durable-1', metadata: { lumithinkScenario: 'stop-on-cancel' } },
      { mode: 'returnImmediately' },
    );
    const raw = readFileSync(ledgerFile, 'utf8');
    const doc = JSON.parse(raw) as { records: Record<string, unknown> };
    assert.ok(doc.records['msg-durable-1'], 'the mapping lives in the file, not only in memory');
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
