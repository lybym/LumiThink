/**
 * P2-02 (issue #114) — structured multi-turn handles (ADR-0018 constraint 5):
 * INPUT_REQUIRED / AUTH_REQUIRED return STRUCTURED handles (taskId +
 * contextId + status message + distinct flags), never plain text, and a
 * follow-up input re-points at the original task (new stable messageId +
 * same contextId + original taskId/referenceTaskIds — all observable on the
 * wire by the mock).
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DshA2aClient } from '../src/index.ts';
import { MOCK_TOKEN_A, startMockA2aServer, type MockServer } from './helpers.ts';

interface Fixture {
  mock: MockServer;
  client: DshA2aClient;
  dir: string;
  ledgerFile: string;
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  const mock = await startMockA2aServer();
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-multiturn-'));
  const ledgerFile = path.join(dir, 'task-ledger.json');
  const client = new DshA2aClient({
    baseUrl: mock.base,
    credential: MOCK_TOKEN_A,
    ledger: ledgerFile,
    pollIntervalMs: 20,
  });
  try {
    await fn({ mock, client, dir, ledgerFile });
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('INPUT_REQUIRED returns a structured handle (not downgraded text) and waits client-side', async () => {
  await withFixture(async ({ client, mock }) => {
    const handle = await client.sendAndConsume({
      text: '第一阶段',
      messageId: 'msg-ir-1',
      metadata: { lumithinkScenario: 'input-required' },
    });
    assert.equal(handle.state, 'input_required');
    assert.equal(handle.inputRequired, true);
    assert.equal(handle.authRequired, false);
    assert.ok(handle.taskId);
    assert.equal(handle.statusMessage, '请补充你的偏好设置。', 'the server status message is carried on the handle');

    // The mock resolved input_required WITHOUT a cancel; no cleanup noise.
    assert.equal(mock.cancelCalls.length, 0);
  });
});

test('AUTH_REQUIRED is distinguishable from INPUT_REQUIRED (no plain-text collapse)', async () => {
  await withFixture(async ({ client }) => {
    const handle = await client.sendAndConsume({
      text: '授权面',
      messageId: 'msg-ar-1',
      metadata: { lumithinkScenario: 'auth-required' },
    });
    assert.equal(handle.state, 'auth_required');
    assert.equal(handle.authRequired, true);
    assert.equal(handle.inputRequired, false, 'AUTH_REQUIRED must never be presented as a plain input request');
    assert.equal(handle.statusMessage, '需要重新授权后才能继续。');
  });
});

test('follow-up input: new messageId + same contextId + original taskId/referenceTaskIds on the wire', async () => {
  await withFixture(async ({ client, mock, ledgerFile }) => {
    const first = await client.sendAndConsume({
      text: '第一阶段',
      messageId: 'msg-mt-1',
      metadata: { lumithinkScenario: 'input-required' },
    });
    assert.ok(first.taskId && first.contextId);

    const follow = await client.sendFollowUp(
      { fromMessageId: 'msg-mt-1', text: '补充输入：偏好安静模式。' },
      { mode: 'returnImmediately' },
    );
    assert.notEqual(follow.messageId, first.messageId, 'the follow-up uses a NEW stable messageId');
    assert.ok(follow.taskId);

    // Wire-level evidence: the follow-up SendMessage re-points at the
    // original task exactly as ADR-0018 constraint 5 requires.
    const sends = mock.methodLog.filter((e) => e.method === 'SendMessage');
    assert.equal(sends.length, 2);
    assert.equal(sends[1].messageId, follow.messageId);
    assert.equal(sends[1].contextId, first.contextId, 'same contextId');
    assert.deepEqual(sends[1].referenceTaskIds, [first.taskId], 'referenceTaskIds point at the original task');

    // Ledger linkage: followUpOfTaskId is persisted.
    const ledgerDoc = JSON.parse(readFileSync(ledgerFile, 'utf8')) as {
      records: Record<string, { followUpOfTaskId?: string; contextId?: string }>;
    };
    assert.equal(ledgerDoc.records[follow.messageId].followUpOfTaskId, first.taskId);
    assert.equal(ledgerDoc.records[follow.messageId].contextId, first.contextId);
  });
});

test('conversation continuation: two messages share one contextId as two linked handles', async () => {
  await withFixture(async ({ client }) => {
    const first = await client.sendAndConsume({ text: '开启会话', messageId: 'msg-ctx-1' });
    const second = await client.sendFollowUp(
      { fromMessageId: 'msg-ctx-1', text: '继续同一会话。' },
      { mode: 'returnImmediately' },
    );
    assert.equal(second.contextId, first.contextId, 'the conversation continues under one context');
    assert.notEqual(second.taskId, first.taskId, 'each message settles its own task handle');
  });
});
