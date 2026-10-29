/**
 * P2-02 (issue #114) — cancellation contract (ADR-0018 Appendix B component
 * 4 + the ADR's mandatory acceptance anchors, mock-reused per Appendix A):
 *   1. tool abort during the wait → the mock OBSERVES CancelTask (the
 *      official SDK's plain abort never sends one — probe-02 scenario A);
 *   2. abort before any taskId → §5.3 original-message resend recovers the
 *      SAME task → CancelTask; both steps recorded;
 *   3. cancel on a terminal task → standard not-cancelable mapping (§7.2);
 *   4. CancelTask response past the §7.3 deadline → unconfirmed outcome,
 *      intent stays persisted, wording "取消结果未确认，可查询任务";
 *   5. the cleanup request NEVER carries the aborted tool signal
 *      (independent AbortController).
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DshA2aClient, TaskWaitAbortedError } from '../src/index.ts';
import { MOCK_TOKEN_A, startMockA2aServer, type MockServer } from './helpers.ts';

interface Fixture {
  mock: MockServer;
  client: DshA2aClient;
  dir: string;
  ledgerFile: string;
}

async function withFixture(
  fn: (fixture: Fixture) => Promise<void>,
  mockOptions: Parameters<typeof startMockA2aServer>[0] = {},
  clientOverrides: { cancelResponseTimeoutMs?: number } = {},
): Promise<void> {
  const mock = await startMockA2aServer(mockOptions);
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-cancel-'));
  const ledgerFile = path.join(dir, 'task-ledger.json');
  const client = new DshA2aClient({
    baseUrl: mock.base,
    credential: MOCK_TOKEN_A,
    ledger: ledgerFile,
    pollIntervalMs: 20,
    ...clientOverrides,
  });
  try {
    await fn({ mock, client, dir, ledgerFile });
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('ADR anchor: tool abort during wait → mock observes CancelTask, task settles CANCELED', async () => {
  await withFixture(async ({ mock, client, ledgerFile }) => {
    const controller = new AbortController();
    const waitPromise = client.sendAndConsume(
      { text: '取消传播', messageId: 'msg-abort-wait-1', metadata: { lumithinkScenario: 'stop-on-cancel' } },
      { signal: controller.signal, pollIntervalMs: 20 },
    );
    // Wait until the send landed, then abort like a DSH tool would.
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (mock.methodLog.some((e) => e.method === 'SendMessage' && e.messageId === 'msg-abort-wait-1')) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });
    await new Promise((resolve) => setTimeout(resolve, 60)); // taskId mapping has landed
    controller.abort();

    await assert.rejects(
      () => waitPromise,
      (error: unknown) => {
        assert.ok(error instanceof TaskWaitAbortedError);
        assert.equal(error.cancelOutcome, 'confirmed_canceled');
        return true;
      },
    );

    // THE anchor: the official-SDK plain abort sends 0 CancelTasks; this
    // adapter's independent cleanup must be observable on the wire.
    assert.equal(mock.cancelCalls.length, 1);
    assert.equal(mock.taskState(mock.cancelCalls[0]), 'TASK_STATE_CANCELED');

    const ledgerDoc = JSON.parse(readFileSync(ledgerFile, 'utf8')) as {
      records: Record<string, { cancelIntent?: { status: string }; taskId?: string }>;
    };
    assert.equal(ledgerDoc.records['msg-abort-wait-1'].cancelIntent?.status, 'confirmed_canceled');
    assert.equal(ledgerDoc.records['msg-abort-wait-1'].taskId, mock.cancelCalls[0]);
  }, { completionDelayMs: 30_000 });
});

test('ADR anchor: abort before any taskId → §5.3 resend recovers the same task → CancelTask', async () => {
  await withFixture(async ({ mock, client, ledgerFile }) => {
    const controller = new AbortController();
    const waitPromise = client.sendAndConsume(
      { text: '首响应前中止', messageId: 'msg-abort-early-1', metadata: { lumithinkScenario: 'stop-on-cancel' } },
      { signal: controller.signal, pollIntervalMs: 20 },
    );
    // Abort while the FIRST response is still delayed on the mock: the task
    // exists server-side but no taskId has reached the client yet.
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (mock.methodLog.some((e) => e.method === 'SendMessage' && e.messageId === 'msg-abort-early-1')) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });
    controller.abort();

    await assert.rejects(
      () => waitPromise,
      (error: unknown) => {
        assert.ok(error instanceof TaskWaitAbortedError);
        assert.equal(error.cancelOutcome, 'confirmed_canceled');
        assert.match(error.message, /§5\.3 recovery resent the original message/);
        return true;
      },
    );

    // Exactly one cleanup CancelTask, targeting the SAME server task the
    // first (response-lost) send created.
    assert.equal(mock.cancelCalls.length, 1);
    const recoveredTaskId = mock.cancelCalls[0];
    assert.ok(mock.tasksByMessageId.get('msg-abort-early-1') === recoveredTaskId,
      'the recovered task is the one created by the original messageId (idempotent resend)');

    // Both recovery steps are ledger-recorded (resend counter + taskId + intent).
    const ledgerDoc = JSON.parse(readFileSync(ledgerFile, 'utf8')) as {
      records: Record<string, { recoveryResends?: number; taskId?: string; cancelIntent?: { status: string } }>;
    };
    const record = ledgerDoc.records['msg-abort-early-1'];
    assert.equal(record.recoveryResends, 1, 'the §5.3 resend is recorded');
    assert.equal(record.taskId, recoveredTaskId);
    assert.equal(record.cancelIntent?.status, 'confirmed_canceled');
  }, { sendResponseDelayMs: 400, completionDelayMs: 30_000 });
});

test('§7.2: cancel of an already-terminal task maps to already_terminal (not a fake success)', async () => {
  await withFixture(async ({ client, mock }) => {
    const handle = await client.sendAndConsume({ text: '先完成', messageId: 'msg-term-1' });
    assert.equal(handle.state, 'completed');
    const beforeCancels = mock.cancelCalls.length;
    const outcome = await client.cancel({ messageId: 'msg-term-1' }, 'late cancel');
    void beforeCancels;
    assert.equal(outcome.status, 'already_terminal');
    assert.match(outcome.detail, /§7\.2|already terminal|TaskNotCancelable|already settled/i);
    assert.equal(outcome.taskState, 'completed');
  });
});

test('§7.3: CancelTask response past the deadline → unconfirmed, intent stays persisted', async () => {
  await withFixture(async ({ client, mock, ledgerFile }) => {
    const handle = await client.send(
      { text: '取消超时', messageId: 'msg-slow-cancel-1', metadata: { lumithinkScenario: 'stop-on-cancel' } },
      { mode: 'returnImmediately' },
    );
    assert.ok(handle.taskId);
    const outcome = await client.cancel({ messageId: 'msg-slow-cancel-1' }, 'timeout probe');
    assert.equal(outcome.status, 'unconfirmed_timeout');
    assert.match(outcome.detail, /取消结果未确认，可查询任务/);
    assert.equal(mock.cancelCalls.length, 1, 'exactly one cleanup request went out');

    const ledgerDoc = JSON.parse(readFileSync(ledgerFile, 'utf8')) as {
      records: Record<string, { cancelIntent?: { status: string } }>;
    };
    assert.equal(ledgerDoc.records['msg-slow-cancel-1'].cancelIntent?.status, 'unconfirmed_timeout',
      'the pending-cancel record must remain for restart recovery');
    // The mock settles the task late (the control DID land server-side);
    // the client-side contract is the honest unconfirmed outcome above.
  }, { cancelDelayMs: 1200, completionDelayMs: 30_000 }, { cancelResponseTimeoutMs: 300 });
});

test('cleanup uses an independent AbortController (never the aborted tool signal)', async () => {
  await withFixture(async ({ client, mock }) => {
    const controller = new AbortController();
    const waitPromise = client.sendAndConsume(
      { text: '独立清理', messageId: 'msg-independent-1', metadata: { lumithinkScenario: 'stop-on-cancel' } },
      { signal: controller.signal, pollIntervalMs: 20 },
    );
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (mock.methodLog.some((e) => e.method === 'SendMessage' && e.messageId === 'msg-independent-1')) {
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    controller.abort();
    await assert.rejects(() => waitPromise, TaskWaitAbortedError);
    // If the cleanup had carried the already-aborted signal, the CancelTask
    // request could never have gone out; observing it proves independence.
    assert.equal(mock.cancelCalls.length, 1);
  }, { completionDelayMs: 30_000 });
});

test('cancel by raw taskId without a ledger record still resolves through the server', async () => {
  await withFixture(async ({ client }) => {
    const handle = await client.send(
      { text: '裸 taskId 取消', messageId: 'msg-raw-1', metadata: { lumithinkScenario: 'stop-on-cancel' } },
      { mode: 'returnImmediately' },
    );
    const outcome = await client.cancel({ taskId: handle.taskId as string }, 'external handle');
    assert.equal(outcome.status, 'confirmed_canceled');
  }, { completionDelayMs: 30_000 });
});
