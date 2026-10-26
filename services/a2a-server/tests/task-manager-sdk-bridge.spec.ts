/**
 * SDK TaskStore bridge tests (P1-02, issue #84).
 *
 * Proves the locked SDK request handler persists through EXACTLY ONE
 * authoritative store — the SQLite Task Manager over the unified repository
 * — with no second store and no double write (TASK_LIFECYCLE §4.1, ADR-0013):
 *   1. the composed service defaults to the SQLite Task Manager;
 *   2. an official-client protocol round-trip lands in the repository
 *      (task row, legal state transitions, turns, artifact chunks, Outbox
 *      journal, strict state machine all the way to COMPLETED);
 *   3. a file-backed database survives a full service restart (GetTask
 *      recovery reads the same task from the repository);
 *   4. stale snapshots never move the authoritative row and late body after
 *      a terminal state is rejected (AC 3);
 *   5. list() paginates from the same repository.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskState } from '@a2a-js/sdk';
import type { Task } from '@a2a-js/sdk';
import { startA2aService, type StartedA2aService } from '../src/a2a-service.ts';
import { SqliteTaskManager } from '../src/task-manager/sqlite-task-manager.ts';
import { officialClient, startTest, stopA2aService, testConfig, userMessage } from './helpers.ts';

test('the composed service defaults to the SQLite Task Manager as its single store', async () => {
  const service = await startTest();
  try {
    assert.ok(service.taskStore instanceof SqliteTaskManager,
      'the default store must be the SQLite Task Manager (no InMemory stand-in)');
    // P1-04 (#86): schema v2 adds the ledger tombstone timestamp
    // (a2a_request_ledger.tombstoned_at_ms) via an additive migration;
    // P1-08 (#90): schema v3 adds the task purge marker (a2a_tasks.purged_at_ms).
    assert.equal((service.taskStore as SqliteTaskManager).schemaVersion, 3);
    assert.equal(service.ownsTaskStore, true, 'the service owns and closes its default store');
  } finally {
    await stopA2aService(service);
  }
});

test('an explicitly provided store replaces the default entirely (single writer)', async () => {
  const custom = new SqliteTaskManager({ dbPath: ':memory:' });
  const service = await startA2aService({ config: testConfig(), taskStore: custom });
  try {
    assert.equal(service.taskStore, custom, 'exactly one store is wired into the handler');
    assert.equal(service.ownsTaskStore, false, 'caller-owned stores are not closed by the service');
  } finally {
    await stopA2aService(service);
    custom.close();
  }
});

test('official client round-trip persists through the repository (legal transitions, chunks, outbox)', async () => {
  const service = await startTest();
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const { client } = await officialClient(service.base);
    const sent = (await client.sendMessage({
      tenant: '',
      message: userMessage('msg-bridge-1', '你好'),
      configuration: undefined,
      metadata: undefined,
    })) as { id: string; contextId: string };

    // 1. The task row went through the strict state machine to COMPLETED.
    const detail = manager.getTaskDetail(sent.id);
    assert.equal(detail.currentState, 'completed');
    assert.ok(detail.stateVersion >= 3, 'submitted→working→completed bumps the version');
    assert.ok(detail.terminalAtMs !== null);
    assert.equal(detail.turns.length, 1, 'the accepted user message is turn 1 (epoch 1)');
    assert.equal(detail.turns[0].epoch, 1);

    // 2. Artifacts/chunks are the admitted public body; parts concatenate.
    const stored = await manager.load(sent.id);
    assert.ok(stored);
    assert.equal(stored.status?.state, TaskState.TASK_STATE_COMPLETED);
    const text = (stored.artifacts?.[0]?.parts ?? [])
      .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
      .join('');
    assert.equal(text, '你好。我们开始吧。');
    assert.equal(manager.stats().chunks, 2);

    // 3. The Outbox journal holds the committed events (task, status, chunks).
    const journal = manager.readOutbox(sent.id, { includePublished: true });
    const kinds = journal.map((event) => event.kind);
    assert.equal(kinds[0], 'task');
    assert.ok(kinds.includes('statusUpdate'));
    assert.equal(kinds.filter((kind) => kind === 'artifactUpdate').length, 2);
    for (let index = 1; index < journal.length; index += 1) {
      assert.ok(journal[index].seq > journal[index - 1].seq, 'task-scoped monotonic seq');
    }
    // Every persisted transition in the journal follows the legal chain
    // submitted → working → completed (strict state machine, TASK_LIFECYCLE §3).
    const statusEvents = journal
      .filter((event) => event.kind === 'statusUpdate')
      .map((event) => ({ from: event.payload['from'] as string, to: event.payload['to'] as string }));
    assert.equal(statusEvents.length, 2, 'submitted→working and working→completed');
    assert.deepEqual(statusEvents[0], { from: 'submitted', to: 'working' });
    assert.deepEqual(statusEvents[1], { from: 'working', to: 'completed' });
  } finally {
    await stopA2aService(service);
  }
});

test('a file-backed database survives a full service restart (GetTask recovery)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a2a-bridge-restart-'));
  const dbPath = path.join(dir, 'a2a-validation.sqlite3');
  let first: StartedA2aService | undefined;
  let second: StartedA2aService | undefined;
  try {
    first = await startA2aService({ config: testConfig({ dbPath }) });
    const { client } = await officialClient(first.base);
    const sent = (await client.sendMessage({
      tenant: '',
      message: userMessage('msg-restart-1', '你好'),
      configuration: undefined,
      metadata: undefined,
    })) as { id: string; contextId: string };
    await stopA2aService(first);
    first = undefined;

    // Restart on the SAME database file: the task is recovered from SQLite.
    second = await startA2aService({ config: testConfig({ dbPath }) });
    const recoveredManager = second.taskStore as SqliteTaskManager;
    const recovered = (await recoveredManager.load(sent.id)) as Task;
    assert.ok(recovered, 'the completed task must be loaded from the repository after restart');
    assert.equal(recovered.status?.state, TaskState.TASK_STATE_COMPLETED);
    const text = (recovered.artifacts?.[0]?.parts ?? [])
      .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
      .join('');
    assert.equal(text, '你好。我们开始吧。');
    assert.equal(recovered.history?.length, 1);
    assert.equal(recovered.history?.[0]?.messageId, 'msg-restart-1');

    // list() over the same repository finds the task by context.
    const listed = await recoveredManager.list({
      tenant: '',
      contextId: sent.contextId,
      status: TaskState.TASK_STATE_UNSPECIFIED,
      pageToken: '',
      statusTimestampAfter: undefined,
    });
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].id, sent.id);
    assert.equal(listed.totalSize, 1);
  } finally {
    if (first) await stopA2aService(first);
    if (second) await stopA2aService(second);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('stale snapshots never move the authoritative row; late body after terminal is rejected', async () => {
  const service = await startTest();
  try {
    const manager = service.taskStore as SqliteTaskManager;
    // Persist a submitted task through the bridge.
    const taskId = 'task-stale-probe';
    const baseTask: Task = {
      id: taskId,
      contextId: 'ctx-stale-probe',
      status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: undefined },
      artifacts: [],
      history: [userMessage('msg-stale-probe', '你好')],
      metadata: undefined,
    };
    await manager.save(baseTask);
    assert.equal(manager.getTaskDetail(taskId).currentState, 'submitted');

    // Legal progression works and bumps the version.
    await manager.save({ ...baseTask, status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined } });
    assert.equal(manager.getTaskDetail(taskId).currentState, 'working');

    // A STALE snapshot (old submitted state) is discarded: the authoritative
    // row wins and the version does not move.
    await manager.save(baseTask);
    const detail = manager.getTaskDetail(taskId);
    assert.equal(detail.currentState, 'working');

    // Terminal transition, then a late body part must fail loudly (AC 3).
    await manager.save({
      ...baseTask,
      status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: undefined },
    });
    assert.equal(manager.getTaskDetail(taskId).currentState, 'completed');
    const latePart = {
      content: { $case: 'text' as const, value: '迟到正文' },
      metadata: undefined,
      filename: '',
      mediaType: 'text/plain',
    };
    await assert.rejects(
      () =>
        manager.save({
          ...baseTask,
          status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: undefined },
          artifacts: [
            {
              artifactId: 'answer-late',
              name: 'Admitted answer',
              description: '',
              parts: [latePart],
              metadata: undefined,
              extensions: [],
            },
          ],
        }),
      /late body chunk|terminal/i,
    );
    assert.equal(manager.stats().chunks, 0, 'no body may be appended after the terminal state');
  } finally {
    await stopA2aService(service);
  }
});
