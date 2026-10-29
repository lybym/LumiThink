/**
 * P2-02 (issue #114) — streaming consumption (ADR-0018 constraint: 流式消费
 * SSE) and the stream-resilience contract: a locally aborted stream stops
 * LOCAL consumption only — the remote task keeps running (the mock mirrors
 * the real server's "SSE 断开不默认取消" semantics) — and the client
 * re-attaches via GetTask / resubscribe.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DshA2aClient, TaskWaitAbortedError } from '../src/index.ts';
import { MOCK_TOKEN_A, startMockA2aServer, type MockServer } from './helpers.ts';

interface Fixture {
  mock: MockServer;
  client: DshA2aClient;
  dir: string;
}

async function withFixture(
  fn: (fixture: Fixture) => Promise<void>,
  mockOptions: Parameters<typeof startMockA2aServer>[0] = {},
): Promise<void> {
  const mock = await startMockA2aServer(mockOptions);
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-stream-'));
  const client = new DshA2aClient({
    baseUrl: mock.base,
    credential: MOCK_TOKEN_A,
    ledger: path.join(dir, 'ledger.json'),
    pollIntervalMs: 20,
  });
  try {
    await fn({ mock, client, dir });
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('stream consumption: task frame first, terminal status last, ledger tracks state', async () => {
  await withFixture(async ({ client }) => {
    const events: string[] = [];
    let taskId = '';
    for await (const event of client.consumeStream({
      text: '流式到完成',
      messageId: 'msg-stream-1',
      metadata: { lumithinkScenario: 'complete' },
    })) {
      events.push(event.kind);
      if (event.kind === 'task') taskId = event.taskId ?? '';
      if (event.kind === 'statusUpdate') {
        assert.ok(event.state !== undefined);
      }
    }
    assert.equal(events[0], 'task', 'first SSE frame is the Task');
    assert.ok(taskId !== '');
    assert.equal(events[events.length - 1], 'statusUpdate', 'final frame is the terminal status');
    const handle = await client.getTask({ messageId: 'msg-stream-1' });
    assert.equal(handle.state, 'completed');
    assert.equal(handle.taskId, taskId);
  });
});

test('local stream abort does NOT cancel the remote task; GetTask recovers the state', async () => {
  await withFixture(async ({ client, mock }) => {
    const controller = new AbortController();
    const consumption = (async () => {
      for await (const _event of client.consumeStream(
        { text: '断流恢复', messageId: 'msg-stream-drop-1', metadata: { lumithinkScenario: 'stop-on-cancel' } },
        { signal: controller.signal },
      )) {
        // consume only the first frame(s)
      }
    })();
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (mock.methodLog.some((e) => e.method === 'SendStreamingMessage' && e.messageId === 'msg-stream-drop-1')) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    await assert.rejects(() => consumption, TaskWaitAbortedError);

    // Stream-resilience contract: the task keeps running server-side.
    const snapshot = await client.getTask({ messageId: 'msg-stream-drop-1' });
    assert.equal(snapshot.state, 'working');
    assert.equal(mock.cancelCalls.length, 0, 'a local stream abort is not a remote cancel');

    // Explicit cleanup: independent CancelTask → CANCELED.
    const outcome = await client.cancel({ messageId: 'msg-stream-drop-1' }, 'explicit cleanup after stream abort');
    assert.equal(outcome.status, 'confirmed_canceled');
  }, { completionDelayMs: 30_000 });
});

test('resubscribe re-attaches to an active task and observes its terminal status', async () => {
  await withFixture(async ({ client }) => {
    const first = await client.send(
      { text: '重订阅附着', messageId: 'msg-resub-1', metadata: { lumithinkScenario: 'complete-slow' } },
      { mode: 'returnImmediately' },
    );
    assert.ok(first.taskId);
    const states: string[] = [];
    for await (const event of client.resubscribe({ taskId: first.taskId })) {
      if (event.kind === 'statusUpdate' && event.state !== undefined) states.push(event.state);
    }
    assert.ok(states.includes('working'), 'the current state is replayed on attach');
    assert.equal(states[states.length - 1], 'completed', 'the resubscribed stream reaches the terminal state');
  }, { completionDelayMs: 400 });
});
