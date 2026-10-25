/**
 * P1-05 acceptance tests (issue #87): the Task Manager wiring for the REAL
 * DSH worker subprocess runtime and its execution lease.
 *
 * AC 1  Official A2A requests produce admission results through a REAL DSH
 *       subprocess (real spawn/hello/heartbeat/exit — synthetic provider
 *       content per the issue's 合成供应商 mechanism), not only a fake worker.
 * AC 2  Worker ownership/lease/session mapping is cross-checkable
 *       (registerExecutionWorker + execution row + runtime session map);
 *       crash, startup failure and 失联 each produce a real state and a
 *       cleanup path with body-free exit evidence.
 * AC 3  Execution results and public Task settlement stay separated: the
 *       execution row records the RAW result; public state moves only
 *       through the transition discipline; late output after a cancel is
 *       rejected by the admission state (epoch/lease/state guards).
 * AC 4  Minimal Task/Execution diagnostics (body-free) are queryable via
 *       getTaskDetail; no child body, working material or credentials.
 *
 * Also closes review #103 (P1-04) carry-overs: the live-path execution row
 * settlement (P2-2) with state assertions, and the gate-level
 * canceled_pre_dispatch verification (P1-04 had repository-level only).
 *
 * Everything is loopback + synthetic data (P1 口径); no UDS switch, no real
 * child data, no publish (B/D 收敛前约束).
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startA2aService, type StartedA2aService } from '../src/a2a-service.ts';
import { SqliteTaskManager } from '../src/task-manager/sqlite-task-manager.ts';
import { DshWorkerRuntime } from '../src/runtime/dsh-worker-runtime.ts';
import type { ExecutionSettlement } from '../src/task-manager/sqlite-task-manager.ts';
import { TEST_TOKEN, rpcHeaders, stopA2aService, testConfig } from './helpers.ts';

/** The bundled REAL worker entry (spawned as a separate OS process). */
const WORKER_ENTRY = fileURLToPath(new URL('../src/runtime/dsh-worker-entry.mjs', import.meta.url));

/** Aggressive-but-stable timers for the failure profiles. lostContact stays
 * well above process-exit delivery latency (slow CI runners) so a crash is
 * diagnosed by its exit evidence, not by the contact watchdog. */
const TUNING = {
  entryPath: WORKER_ENTRY,
  executionTimeoutMs: 2000,
  helloTimeoutMs: 500,
  lostContactMs: 900,
  cancelGraceMs: 800,
};

function dshTestConfig(
  workerEnv: Record<string, string>,
  overrides: Record<string, unknown> = {},
): ReturnType<typeof testConfig> {
  return testConfig({
    runtimeMode: 'dsh-worker',
    dshWorker: { ...TUNING, workerEnv },
    ...overrides,
  } as Parameters<typeof testConfig>[0]);
}

function wireMessage(messageId: string, text: string): Record<string, unknown> {
  return { messageId, role: 'ROLE_USER', parts: [{ text }] };
}

function sendBody(id: number, message: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'SendMessage', params: { message } };
}

async function postRpc(
  base: string,
  body: unknown,
  token: string | null = TEST_TOKEN,
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: rpcHeaders({ token }),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { httpStatus: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

async function waitForTerminal(
  manager: SqliteTaskManager,
  taskId: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = manager.getTaskDetail(taskId);
    if (['completed', 'failed', 'canceled', 'rejected'].includes(detail.currentState)) {
      return detail.currentState;
    }
    if (Date.now() > deadline) {
      assert.fail(`task ${taskId} did not reach a terminal state (state=${detail.currentState})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function soleExecution(
  manager: SqliteTaskManager,
  taskId: string,
): {
  executionId: string;
  state: string;
  leaseId: string | null;
  workerId: string | null;
  settledAtMs: number | null;
  result: ExecutionSettlement | null;
} {
  const turns = manager.getTaskDetail(taskId).turns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].executions.length, 1);
  return turns[0].executions[0];
}

/** Accepts one request on a fresh service and returns the accepted taskId. */
async function acceptOneTask(service: StartedA2aService, manager: SqliteTaskManager): Promise<string> {
  void postRpc(service.base, sendBody(1, wireMessage('msg-1', '你好'))).catch(() => undefined);
  const deadline = Date.now() + 5000;
  for (;;) {
    const listed = await manager.list({ pageSize: 10 } as unknown as Parameters<
      SqliteTaskManager['list']
    >[0]);
    if (listed.tasks.length === 1) return listed.tasks[0].id;
    if (Date.now() > deadline) assert.fail('the request was never accepted');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function startDshService(
  workerEnv: Record<string, string>,
  overrides: Record<string, unknown> = {},
): Promise<StartedA2aService> {
  return startA2aService({ config: dshTestConfig(workerEnv, overrides) });
}

// ---------------------------------------------------------------------------
// Execution-row lifecycle primitives (settlement path = review #103 P2-2)
// ---------------------------------------------------------------------------

const PLAIN_MESSAGE = {
  messageId: 'placeholder',
  role: 1,
  parts: [],
  contextId: '',
  taskId: '',
  metadata: undefined,
  extensions: [],
  referenceTaskIds: [],
} as unknown as Parameters<SqliteTaskManager['acceptInput']>[0]['inputMessage'];

test('execution rows settle through the settlement path with lease attribution (P2-2 closure)', () => {
  const manager = new SqliteTaskManager({ dbPath: ':memory:' });
  try {
    const accepted = manager.acceptInput({
      requestKey: 'rk-settle-1',
      fingerprint: 'fp-settle-1',
      messageId: 'msg-settle-1',
      inputMessage: { ...PLAIN_MESSAGE, messageId: 'msg-settle-1' },
    });
    assert.equal(accepted.outcome, 'created');
    const taskId = (accepted as { taskId: string }).taskId;
    const claim = manager.claimExecution({
      taskId,
      executionId: 'exec-settle-1',
      leaseId: 'lease-1',
      leaseExpiresAtMs: Date.now() + 60_000,
      workerId: 'runtime-pending',
    });
    if (claim.outcome !== 'claimed') assert.fail('claim must succeed');

    // Worker registration records the self-reported id (AC 2 归属可核对).
    assert.deepEqual(
      manager.registerExecutionWorker({
        taskId, executionId: 'exec-settle-1', leaseId: 'lease-1', workerId: 'dshw-42-abc',
      }),
      { outcome: 'registered' },
    );
    assert.equal(soleExecution(manager, taskId).workerId, 'dshw-42-abc');

    // Settlement with the lease presented: row closes with evidence.
    assert.deepEqual(
      manager.settleExecution({
        taskId,
        executionId: 'exec-settle-1',
        turnSeq: claim.turnSeq,
        epoch: claim.epoch,
        leaseId: 'lease-1',
        result: { outcome: 'completed', exitCode: 0, signal: null },
      }),
      { outcome: 'settled' },
    );
    const row = soleExecution(manager, taskId);
    assert.equal(row.state, 'settled', 'P2-2: the live path settles its execution row');
    assert.ok(row.settledAtMs !== null);
    assert.deepEqual(row.result, { outcome: 'completed', exitCode: 0, signal: null });

    // Idempotent close: the first settlement wins.
    assert.deepEqual(
      manager.settleExecution({
        taskId, executionId: 'exec-settle-1', turnSeq: 1, epoch: 1, leaseId: 'lease-1',
        result: { outcome: 'failed', reason: 'late_attempt' },
      }),
      { outcome: 'already_settled', state: 'settled' },
    );
    assert.deepEqual(row.result, { outcome: 'completed', exitCode: 0, signal: null });

    // Wrong lease holder is rejected (same rule as admitChunk).
    const accepted2 = manager.acceptInput({
      requestKey: 'rk-settle-2',
      fingerprint: 'fp-settle-2',
      messageId: 'msg-settle-2',
      inputMessage: { ...PLAIN_MESSAGE, messageId: 'msg-settle-2' },
    });
    assert.equal(accepted2.outcome, 'created');
    manager.claimExecution({
      taskId: (accepted2 as { taskId: string }).taskId,
      executionId: 'exec-settle-3', leaseId: 'lease-3', workerId: 'runtime-pending',
    });
    assert.deepEqual(
      manager.settleExecution({
        taskId: (accepted2 as { taskId: string }).taskId,
        executionId: 'exec-settle-3', turnSeq: 1, epoch: 1, leaseId: 'lease-WRONG',
        result: { outcome: 'failed' },
      }),
      { outcome: 'rejected', reason: 'lease_invalid' },
    );
    assert.equal(soleExecution(manager, (accepted2 as { taskId: string }).taskId).state, 'registered');
  } finally {
    manager.close();
  }
});

test('markExecutionStopRequested fences the active execution row exactly once', () => {
  const manager = new SqliteTaskManager({ dbPath: ':memory:' });
  try {
    const accepted = manager.acceptInput({
      requestKey: 'rk-stop-1', fingerprint: 'fp-stop-1', messageId: 'msg-stop-1',
      inputMessage: { ...PLAIN_MESSAGE, messageId: 'msg-stop-1' },
    });
    assert.equal(accepted.outcome, 'created');
    const taskId = (accepted as { taskId: string }).taskId;
    assert.deepEqual(
      manager.markExecutionStopRequested({ taskId }),
      { outcome: 'no_active_execution' },
    );
    manager.claimExecution({ taskId, executionId: 'exec-stop-1', leaseId: 'lease-s1', workerId: 'runtime-pending' });
    const marked = manager.markExecutionStopRequested({ taskId });
    assert.equal(marked.outcome, 'marked');
    assert.equal(soleExecution(manager, taskId).state, 'stop_requested');
    assert.deepEqual(
      manager.markExecutionStopRequested({ taskId }),
      { outcome: 'no_active_execution' },
      '重复取消不再重复标记（行已 stop_requested，非 registered/running）',
    );
  } finally {
    manager.close();
  }
});

// ---------------------------------------------------------------------------
// Service-level: real subprocess execution through official JSON-RPC (AC 1)
// ---------------------------------------------------------------------------

test('AC1: official request → real DSH subprocess → admitted chunks + settled execution row', async () => {
  const service = await startDshService({});
  try {
    assert.ok(service.runtime instanceof DshWorkerRuntime, 'dsh-worker mode exposes the runtime');
    const manager = service.taskStore as SqliteTaskManager;
    const res = await postRpc(service.base, sendBody(1, wireMessage('msg-dsh-1', '你好')));
    assert.equal(res.httpStatus, 200);
    assert.equal(res.body['error'], undefined);
    const taskId = ((res.body['result'] as Record<string, unknown>)?.['task'] as Record<string, unknown>)['id'] as string;

    const detail = manager.getTaskDetail(taskId);
    assert.equal(detail.currentState, 'completed');
    // The real subprocess produced the public result.
    const task = await manager.load(taskId);
    const text = (task?.artifacts?.[0]?.parts ?? [])
      .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
      .join('');
    assert.equal(text, '你好。我们开始吧。', 'both worker chunks were admitted in order');

    const exec = soleExecution(manager, taskId);
    assert.equal(exec.state, 'settled', 'P2-2: live execution row settles');
    assert.ok(exec.settledAtMs !== null);
    assert.ok(exec.workerId?.startsWith('dshw-'), 'worker registration recorded on the row');
    assert.ok(exec.leaseId !== null, 'lease recorded (AC 2 租约可核对)');
    assert.deepEqual(exec.result, {
      outcome: 'completed',
      exitCode: 0,
      signal: null,
      workerId: null,
      startedAtMs: null,
      endedAtMs: exec.result?.endedAtMs,
    });
    // AC 4: evidence is body-free — the settlement carries no message text.
    const evidenceJson = JSON.stringify(exec.result);
    assert.ok(!evidenceJson.includes('你好'), 'no message body in execution evidence');
    assert.ok(!evidenceJson.includes('我们开始吧'), 'no message body in execution evidence');

    // 会话映射: no live session remains after a settled run.
    assert.equal(service.runtime?.sessionByTask(taskId), undefined);
  } finally {
    await stopA2aService(service);
  }
});

test('AC2: worker crash → real FAILED state, crashed settlement with exit evidence', async () => {
  const service = await startDshService({ LUMITHINK_A2A_WORKER_BEHAVIOR: 'crash-after-ready' });
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const taskId = await acceptOneTask(service, manager);
    assert.equal(await waitForTerminal(manager, taskId), 'failed');

    const exec = soleExecution(manager, taskId);
    assert.equal(exec.state, 'settled');
    assert.equal(exec.result?.outcome, 'crashed');
    const abnormal = (exec.result?.exitCode ?? 0) !== 0 || exec.result?.signal !== null;
    assert.ok(
      abnormal,
      `crash carries abnormal exit evidence (exit=${exec.result?.exitCode}, signal=${exec.result?.signal})`,
    );
    assert.equal(service.runtime?.sessionByTask(taskId), undefined, 'crashed session cleaned up');
  } finally {
    await stopA2aService(service);
  }
});

test('AC2: worker-reported failure → failed settlement with the worker reason', async () => {
  const service = await startDshService({ LUMITHINK_A2A_WORKER_BEHAVIOR: 'exit-failed' });
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const taskId = await acceptOneTask(service, manager);
    assert.equal(await waitForTerminal(manager, taskId), 'failed');
    const exec = soleExecution(manager, taskId);
    assert.equal(exec.state, 'settled');
    assert.equal(exec.result?.outcome, 'failed');
    assert.equal(exec.result?.reason, 'worker_profile_exit_failed');
  } finally {
    await stopA2aService(service);
  }
});

test('AC2: startup failure (no hello) → startup_failed settlement, no worker ran', async () => {
  const service = await startDshService({ LUMITHINK_A2A_WORKER_BEHAVIOR: 'no-hello' });
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const taskId = await acceptOneTask(service, manager);
    assert.equal(await waitForTerminal(manager, taskId), 'failed');

    const exec = soleExecution(manager, taskId);
    assert.equal(exec.result?.outcome, 'startup_failed');
    assert.equal(exec.result?.reason, 'hello_timeout');
    assert.ok(
      exec.workerId === null || exec.workerId === 'runtime-pending',
      'an unregistered worker never owns the execution row',
    );
  } finally {
    await stopA2aService(service);
  }
});

test('AC2: external working-DSH kind is refused as a dispatched executor (内部/外部分离)', async () => {
  const service = await startDshService({ LUMITHINK_A2A_WORKER_BEHAVIOR: 'external-kind' });
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const taskId = await acceptOneTask(service, manager);
    assert.equal(await waitForTerminal(manager, taskId), 'failed');
    const exec = soleExecution(manager, taskId);
    assert.equal(exec.result?.outcome, 'startup_failed');
    assert.equal(
      exec.result?.reason,
      'bad_registration',
      'an external-companion hello never executes (fail-closed registration)',
    );
    assert.ok(exec.workerId === null || exec.workerId === 'runtime-pending');
  } finally {
    await stopA2aService(service);
  }
});

test('AC2: 失联 (heartbeat silence) → lost_contact settlement with cleanup', async () => {
  const service = await startDshService({ LUMITHINK_A2A_WORKER_BEHAVIOR: 'silent-after-ready' });
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const taskId = await acceptOneTask(service, manager);
    assert.equal(await waitForTerminal(manager, taskId), 'failed');
    const exec = soleExecution(manager, taskId);
    assert.equal(exec.state, 'settled');
    assert.equal(exec.result?.outcome, 'lost_contact');
    assert.equal(service.runtime?.sessionByTask(taskId), undefined);
  } finally {
    await stopA2aService(service);
  }
});

test('AC2: execution deadline (hang) → timeout settlement with cleanup', async () => {
  const service = await startDshService({ LUMITHINK_A2A_WORKER_BEHAVIOR: 'heartbeat-forever' });
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const taskId = await acceptOneTask(service, manager);
    assert.equal(await waitForTerminal(manager, taskId), 'failed');
    const exec = soleExecution(manager, taskId);
    assert.equal(exec.result?.outcome, 'timeout');
    assert.equal(service.runtime?.sessionByTask(taskId), undefined, 'hung worker killed and cleaned up');
  } finally {
    await stopA2aService(service);
  }
});

test('AC3: cancel mid-run → cooperative stop with evidence; late output rejected by admission state', async () => {
  const service = await startDshService({ LUMITHINK_A2A_WORKER_BEHAVIOR: 'flood-after-cancel' });
  try {
    const manager = service.taskStore as SqliteTaskManager;
    // The blocking send stays in flight until finalize — obtain the taskId
    // from the repository (acceptance commits before dispatch).
    const taskId = await acceptOneTask(service, manager);

    // Wait for the first admitted chunk, then cancel mid-run.
    const pollDeadline = Date.now() + 5000;
    for (;;) {
      const task = await manager.load(taskId);
      if ((task?.artifacts?.[0]?.parts?.length ?? 0) >= 1) break;
      if (Date.now() > pollDeadline) assert.fail('worker never produced its first chunk');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const cancelRes = await postRpc(service.base, {
      jsonrpc: '2.0', id: 2, method: 'CancelTask', params: { id: taskId },
    });
    assert.equal(cancelRes.httpStatus, 200);

    assert.equal(await waitForTerminal(manager, taskId), 'canceled');
    const task = await manager.load(taskId);
    const parts = task?.artifacts?.[0]?.parts ?? [];
    const text = parts.map((p) => (p.content?.$case === 'text' ? p.content.value : '')).join('');
    assert.equal(parts.length, 1, 'exactly the first chunk stays admitted (AC 3)');
    assert.equal(text, '你好。', 'late chunk after cancel was NOT admitted (AC 3)');
    assert.ok(!text.includes('迟到'), 'late output never enters the public artifact');
    const exec = soleExecution(manager, taskId);
    assert.equal(exec.state, 'settled');
    assert.equal(exec.result?.outcome, 'canceled', 'stop evidence settles the execution row');
    assert.equal(manager.getTaskDetail(taskId).cancelIntent, true, 'cancel intent persisted before dispatch');
    assert.ok(!JSON.stringify(exec.result).includes('迟到'), 'late output never enters evidence');
    assert.equal(service.runtime?.sessionByTask(taskId), undefined);
  } finally {
    await stopA2aService(service);
  }
});

test('AC3 gate-level: persisted cancel intent before dispatch → canceled_pre_dispatch, no worker', async () => {
  // P1-04 review carry-over: canceled_pre_dispatch verified at GATE level
  // (through the full service chain), not only at repository level.
  const manager = new SqliteTaskManager({ dbPath: ':memory:' });
  const canceledBeforeClaim = new Set<string>();
  const service = await startA2aService({
    config: dshTestConfig({}),
    taskStore: manager,
    quotaGate: (taskId) => {
      // Synchronously persist the cancel intent BEFORE the claim: the gate
      // then lets dispatch proceed into the refused claim.
      if (!canceledBeforeClaim.has(taskId)) {
        canceledBeforeClaim.add(taskId);
        manager.recordCancelIntent({ taskId, reason: 'cancel_requested' });
      }
      return { allowed: true };
    },
  });
  try {
    const res = await postRpc(service.base, sendBody(1, wireMessage('msg-pre-1', '你好')));
    assert.equal(res.httpStatus, 200);
    const taskId = ((res.body['result'] as Record<string, unknown>)?.['task'] as Record<string, unknown>)['id'] as string;

    assert.equal(manager.getTaskDetail(taskId).currentState, 'canceled');
    assert.equal(
      manager.getTaskDetail(taskId).turns[0].executions.length,
      0,
      'the lease was refused — no execution row, no worker start',
    );
    assert.equal(service.runtime?.sessionByTask(taskId), undefined, 'no worker process existed');
  } finally {
    await stopA2aService(service);
    manager.close();
  }
});

test('AC2: service shutdown disposes live workers and settles their execution rows', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a2a-p1-05-shutdown-'));
  const dbPath = path.join(dir, 'tasks.sqlite');
  const service = await startDshService(
    { LUMITHINK_A2A_WORKER_BEHAVIOR: 'heartbeat-forever' },
    { dbPath },
  );
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const taskId = await acceptOneTask(service, manager);

    // Shutdown while the worker is still hanging: dispose kills it, the
    // settlement path closes the row with 'stopped/service_shutdown' BEFORE
    // the store closes (ordering contract in stopA2aService).
    await stopA2aService(service);

    const reader = new SqliteTaskManager({ dbPath });
    try {
      const exec = soleExecution(reader, taskId);
      assert.equal(exec.state, 'settled', 'shutdown settles the live execution row');
      assert.equal(exec.result?.outcome, 'stopped');
      assert.equal(exec.result?.reason, 'service_shutdown');
      assert.equal(
        reader.getTaskDetail(taskId).currentState,
        'working',
        'restart recovery of interrupted executions is the P1-08 scan (documented boundary)',
      );
    } finally {
      reader.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
