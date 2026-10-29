/**
 * P2-02 (issue #114) — task ledger persistence contract (ADR-0018
 * constraint 2; TASK_LIFECYCLE §7.4 first paragraph):
 *   - saveBeforeSend is durable BEFORE the wire send;
 *   - saveTaskId persists the mapping on arrival (取得即落盘);
 *   - a NEW ledger instance over the same file restores every record
 *     (cross-restart recovery);
 *   - credentials never reach the file (§13.1);
 *   - corrupt files refuse to run (fail-closed).
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FileTaskLedger, LEDGER_SCHEMA_VERSION } from '../src/ledger.ts';
import { DshA2aClientError } from '../src/errors.ts';

const TOKEN = 'synthetic-ledger-token-0123456789abcdef';

function tmpLedgerPath(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-ledger-'));
  return { dir, file: path.join(dir, 'task-ledger.json') };
}

function sampleRecord(messageId: string) {
  return {
    messageId,
    agentBaseUrl: 'http://127.0.0.1:3312',
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    originalRequest: {
      method: 'message/send' as const,
      message: { messageId, contextId: '', taskId: '', role: 'ROLE_USER', parts: [{ text: '合成内容' }] },
      configuration: { returnImmediately: true },
    },
    returnImmediately: true,
  };
}

test('ledger: saveBeforeSend is durable on disk immediately (§7.4 发送前落盘)', async () => {
  const { file, dir } = tmpLedgerPath();
  try {
    const ledger = new FileTaskLedger(file);
    await ledger.saveBeforeSend(sampleRecord('msg-before-1'));
    assert.ok(existsSync(file), 'the ledger file must exist right after saveBeforeSend');
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { records: Record<string, unknown> };
    assert.ok(onDisk.records['msg-before-1'], 'the record is on disk before any wire activity');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger: saveTaskId persists the mapping on arrival; reload restores it', async () => {
  const { file, dir } = tmpLedgerPath();
  try {
    const ledger = new FileTaskLedger(file);
    await ledger.saveBeforeSend(sampleRecord('msg-map-1'));
    await ledger.saveTaskId('msg-map-1', 'task-abc', 'ctx-123');
    await ledger.recordState('msg-map-1', 'working');

    const fresh = new FileTaskLedger(file); // simulated restart
    const restored = await fresh.load('msg-map-1');
    assert.ok(restored);
    assert.equal(restored.taskId, 'task-abc');
    assert.equal(restored.contextId, 'ctx-123');
    assert.equal(restored.lastKnownState, 'working');
    assert.equal(restored.originalRequest.method, 'message/send');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger: cancel intent lifecycle persists across restarts (§7.3/§9)', async () => {
  const { file, dir } = tmpLedgerPath();
  try {
    const ledger = new FileTaskLedger(file);
    await ledger.saveBeforeSend(sampleRecord('msg-cancel-1'));
    await ledger.saveTaskId('msg-cancel-1', 'task-cancel', 'ctx-cancel');
    await ledger.recordCancelIntent('msg-cancel-1', {
      requestedAtMs: Date.now(),
      reason: 'tool abort',
      status: 'requested',
      detail: 'cancel intent recorded before the CancelTask request',
    });
    const fresh = new FileTaskLedger(file);
    const restored = await fresh.load('msg-cancel-1');
    assert.equal(restored?.cancelIntent?.status, 'requested');

    await fresh.recordCancelIntent('msg-cancel-1', {
      requestedAtMs: Date.now(),
      reason: 'tool abort',
      status: 'unconfirmed_timeout',
      detail: 'CancelTask response missed the §7.3 deadline. 取消结果未确认，可查询任务；持久取消意图已保存。',
    });
    const after = await new FileTaskLedger(file).load('msg-cancel-1');
    assert.equal(after?.cancelIntent?.status, 'unconfirmed_timeout');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger: loadByTaskId resolves the reverse mapping', async () => {
  const { file, dir } = tmpLedgerPath();
  try {
    const ledger = new FileTaskLedger(file);
    await ledger.saveBeforeSend(sampleRecord('msg-rev-1'));
    await ledger.saveTaskId('msg-rev-1', 'task-rev', 'ctx-rev');
    const found = await ledger.loadByTaskId('task-rev');
    assert.equal(found?.messageId, 'msg-rev-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger: credential material never reaches the durable file (fail-closed)', async () => {
  const { file, dir } = tmpLedgerPath();
  try {
    const ledger = new FileTaskLedger(file);
    const poisoned = sampleRecord('msg-token-1');
    (poisoned.originalRequest.message as { metadata?: Record<string, unknown> }).metadata = {
      injected: `Bearer ${TOKEN}`,
    };
    await assert.rejects(
      () => ledger.saveBeforeSend(poisoned),
      (error: unknown) => error instanceof DshA2aClientError && error.code === 'invalid_config',
    );
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8');
      assert.ok(!raw.includes(TOKEN), 'the token must never appear in the ledger file');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger: corrupt file refuses to run fail-closed', async () => {
  const { file, dir } = tmpLedgerPath();
  try {
    writeFileSync(file, '{not-json', 'utf8');
    const ledger = new FileTaskLedger(file);
    await assert.rejects(
      () => ledger.loadAll(),
      (error: unknown) => error instanceof DshA2aClientError && error.code === 'ledger_corrupt',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger: unknown future schema version refuses to open (fail-closed)', async () => {
  const { file, dir } = tmpLedgerPath();
  try {
    writeFileSync(
      file,
      JSON.stringify({ version: LEDGER_SCHEMA_VERSION + 1, updatedAtMs: 0, records: {} }),
      'utf8',
    );
    const ledger = new FileTaskLedger(file);
    await assert.rejects(
      () => ledger.loadAll(),
      (error: unknown) => error instanceof DshA2aClientError && error.code === 'ledger_corrupt',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger: atomic replace leaves no tmp files behind', async () => {
  const { file, dir } = tmpLedgerPath();
  try {
    const ledger = new FileTaskLedger(file);
    await ledger.saveBeforeSend(sampleRecord('msg-atomic-1'));
    await ledger.saveTaskId('msg-atomic-1', 'task-atomic', 'ctx-atomic');
    const leftovers = (await import('node:fs')).readdirSync(dir).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, [], 'tmp files are renamed away atomically');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
