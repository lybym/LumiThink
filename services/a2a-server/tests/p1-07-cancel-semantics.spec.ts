/**
 * P1-07 acceptance tests (issue #89): real cancellation, completion races
 * and the suppressed-answer semantics.
 *
 * AC 1  取消窗口全覆盖且实际停止有证据 — 非协作 Worker 只能被取消宽限后的
 *       强停终止（watchdog kill，body-free 退出证据），会话表随之清理；
 *       取消先于派发在 #87 已有门级测试（canceled_pre_dispatch）。
 * AC 2  仅收到取消命令不直接认定停止（公开状态停在 working 直到真实停止
 *       证据）；限期未停止不能假成功（强停前绝不发布终态）；重复取消无新
 *       副作用；终态不可被迟到回调覆盖（仓储守卫由 #84/#87 测试锚定）。
 * AC 3  真实完成但正文被抑制时 COMPLETED + Task.metadata.lumithinkResult
 *       {version:1, outputSuppressedAfterCancel:true, answerComplete:false}
 *       + 可读状态说明（锁定 fixture 04）；正常完整完成携带 fixture 03 的
 *       {false, true} 旗标。部分结果不被补播。
 * AC 4  重复取消（CANCELED 幂等成功）、已完成（-32002）、未知任务（-32001）
 *       的标准语义经锁定官方客户端验证——不自创状态或错误码。
 *
 * 另含 review 移交项收口的仓储级测试：
 *   - claimExecution 显式 epoch 必须匹配 Turn 锚（review #84 r1 P2-②③）；
 *   - admitChunk UNIQUE 回退对"无同 chunkId 行"的约束冲突不再误报
 *     chunk_content_mismatch（review #105 r1 P2-3 原因码保真）；
 *   - WRITE_LOCK_BUSY 门级映射的直接负例（#86 关闭评论 test gap）。
 *
 * Everything is loopback + synthetic data (P1 口径); no UDS switch, no real
 * child data, no publish (B/D 收敛前约束).
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TaskState } from '@a2a-js/sdk';
import { startA2aService, type StartedA2aService } from '../src/a2a-service.ts';
import {
  SqliteTaskManager,
  type ExecutionSettlement,
} from '../src/task-manager/sqlite-task-manager.ts';
import { TaskManagerError } from '../src/task-manager/errors.ts';
import { TEST_TOKEN, officialClient, rpcHeaders, startTest, stopA2aService, testConfig } from './helpers.ts';

/** The bundled REAL worker entry (spawned as a separate OS process). */
const WORKER_ENTRY = fileURLToPath(new URL('../src/runtime/dsh-worker-entry.mjs', import.meta.url));

/** Aggressive-but-stable timers. lostContact stays far above the heartbeat
 * cadence so the never-stops profile is diagnosed by the cancel-grace
 * watchdog (its heartbeats keep flowing), never by contact silence. */
const TUNING = {
  entryPath: WORKER_ENTRY,
  executionTimeoutMs: 10_000,
  helloTimeoutMs: 500,
  lostContactMs: 5_000,
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

async function cancelTask(
  service: StartedA2aService,
  id: number,
  taskId: string,
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  return postRpc(service.base, { jsonrpc: '2.0', id, method: 'CancelTask', params: { id: taskId } });
}

async function waitForTerminal(
  manager: SqliteTaskManager,
  taskId: string,
  expected?: string,
  timeoutMs = 8000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = manager.getTaskDetail(taskId);
    if (['completed', 'failed', 'canceled', 'rejected'].includes(detail.currentState)) {
      if (expected !== undefined) assert.equal(detail.currentState, expected);
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

async function acceptOneTask(
  service: StartedA2aService,
  manager: SqliteTaskManager,
): Promise<string> {
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

async function waitFirstChunk(
  manager: SqliteTaskManager,
  taskId: string,
  minParts = 1,
): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const task = await manager.load(taskId);
    if ((task?.artifacts?.[0]?.parts?.length ?? 0) >= minParts) return;
    if (Date.now() > deadline) assert.fail('worker never produced its first chunk');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function cancelCommandCount(manager: SqliteTaskManager, taskId: string): number {
  return manager
    .readOutbox(taskId, { includePublished: true })
    .filter((event) => event.kind === 'cancelCommand').length;
}

/** Reads the google.rpc.ErrorInfo reason from a thrown official-client
 * error (the SDK wraps JSON-RPC codes into semantic errors carrying the
 * UPPER_SNAKE_CASE reason; the numeric -3200x mapping stays server-side). */
function wireErrorReason(error: unknown): string {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const reason = (candidate as { reason?: unknown } | null)?.reason;
    if (typeof reason === 'string') return reason;
  }
  return '';
}

function startDshService(
  workerEnv: Record<string, string>,
  overrides: Record<string, unknown> = {},
): Promise<StartedA2aService> {
  return startA2aService({ config: dshTestConfig(workerEnv, overrides) });
}

// ---------------------------------------------------------------------------
// AC 1 / AC 2: 非协作 Worker、限期强停、仅凭取消命令不认定停止
// ---------------------------------------------------------------------------

test('AC2/AC1: 非协作 Worker — 取消命令不认定停止、限期强停有真实证据、重复取消无新副作用', async () => {
  const service = await startDshService({ LUMITHINK_A2A_WORKER_BEHAVIOR: 'never-stops' });
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const taskId = await acceptOneTask(service, manager);
    await waitFirstChunk(manager, taskId);

    // First cancel: intent persisted BEFORE the remote control goes out
    // (§7.1 step 3) and the ACTIVE execution row is fenced stop_requested.
    // The worker IGNORES the cancel control, so during the whole
    // cooperative-stop window (well before the grace deadline) the public
    // task must stay non-terminal — 仅收到取消命令不直接认定停止 (AC 2).
    const firstCancel = cancelTask(service, 2, taskId);
    let sawWorkingInWindow = false;
    let sawStopRequestedFence = false;
    const windowEnd = Date.now() + TUNING.cancelGraceMs - 120;
    while (Date.now() < windowEnd) {
      const detail = manager.getTaskDetail(taskId);
      if (detail.currentState === 'working') sawWorkingInWindow = true;
      if (soleExecution(manager, taskId).state === 'stop_requested') sawStopRequestedFence = true;
      assert.ok(
        !['completed', 'failed', 'canceled', 'rejected'].includes(detail.currentState),
        '强停宽限窗口内不得出现任何终态（限期未停止不能假成功）',
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const first = await firstCancel;
    assert.equal(first.httpStatus, 200);
    const detailAfterFirst = manager.getTaskDetail(taskId);
    assert.equal(detailAfterFirst.cancelIntent, true, '取消意图已持久化');
    assert.ok(sawWorkingInWindow, '仅收到取消命令不直接认定停止（TASK_LIFECYCLE §7.1/AC2）');
    assert.ok(sawStopRequestedFence, '活动执行行已被围栏为 stop_requested');
    assert.equal(cancelCommandCount(manager, taskId), 1, '恰好一条持久化取消意图');

    // Deadline reached: the runtime force-stops the non-cooperative worker.
    // Only THEN does the public task settle CANCELED — never before real
    // stop evidence (限期未停止不能假成功, AC2).
    assert.equal(await waitForTerminal(manager, taskId, 'canceled'), 'canceled');
    const exec = soleExecution(manager, taskId);
    assert.equal(exec.state, 'settled');
    assert.equal(exec.result?.outcome, 'canceled');
    assert.equal(exec.result?.reason, 'cancel_grace_expired',
      '执行行记录限期强停原因（真实停止证据）');
    assert.equal(exec.result?.killedByRuntime, true,
      '运行时强停标记为真实停止证据（body-free 退出证据）');
    assert.equal(service.runtime?.sessionByTask(taskId), undefined,
      '会话表随强停清理');

    // Re-delivered cancels AFTER settlement (重复取消): standard handling,
    // NO further persisted side effects (§7.1.2 already-terminal).
    const second = await cancelTask(service, 3, taskId);
    assert.equal(second.httpStatus, 200);
    const third = await cancelTask(service, 4, taskId);
    assert.equal(third.httpStatus, 200);
    assert.equal(cancelCommandCount(manager, taskId), 1,
      '重复取消不产生第二条取消意图（§7.1.2）');
    assert.equal(manager.getTaskDetail(taskId).turns[0].executions.length, 1,
      '重复取消不新建执行');

    // Public shape stays honest: canceled tasks carry NO lumithinkResult
    // flags (fixture contract only defines them on COMPLETED settlements)
    // and the pre-cancel admitted chunk is all that was ever published.
    const snapshot = await manager.load(taskId);
    assert.equal(snapshot?.metadata?.['lumithinkResult'], undefined,
      'canceled 结算不带完成旗标（fixtures 03/04 只定义于完成分支）');
    const text = (snapshot?.artifacts?.[0]?.parts ?? [])
      .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
      .join('');
    assert.equal(text, '你好。', '强停后不追加任何新公开正文');
  } finally {
    await stopA2aService(service);
  }
});

// ---------------------------------------------------------------------------
// AC 3: 完成竞争 — 真实完成但正文被抑制 → COMPLETED + 抑制旗标 + 不补播
// ---------------------------------------------------------------------------

test('AC3: 完成竞争 — 取消后真实完成 → COMPLETED + lumithinkResult 抑制旗标 + 可读说明 + 不补播', async () => {
  const service = await startDshService({ LUMITHINK_A2A_WORKER_BEHAVIOR: 'complete-after-cancel' });
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const taskId = await acceptOneTask(service, manager);
    await waitFirstChunk(manager, taskId);

    // Cancel mid-run: admission closes; the worker had already finished its
    // work and reports TRUE completion after one late (fenced) candidate
    // chunk — TASK_LIFECYCLE §7.2 "已记录取消意图，但 Bridge 报告执行实际
    // 成功完成且取消未生效" branch.
    const cancelRes = await cancelTask(service, 2, taskId);
    assert.equal(cancelRes.httpStatus, 200);

    assert.equal(await waitForTerminal(manager, taskId, 'completed'), 'completed',
      '真实完成结算 COMPLETED，不谎报 CANCELED（§7.2 完成竞争分支）');

    const snapshot = await manager.load(taskId);
    assert.deepEqual(snapshot?.metadata?.['lumithinkResult'],
      { version: 1, outputSuppressedAfterCancel: true, answerComplete: false },
      'Task.metadata.lumithinkResult 携带锁定 fixture 04 旗标');
    const statusMessage = snapshot?.status?.message;
    assert.ok(statusMessage, '终态附带可读状态说明（§7.2）');
    const explanation = (statusMessage.parts ?? [])
      .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
      .join('');
    assert.match(explanation, /执行已完成，后续输出因取消被抑制/,
      '可读说明与 fixture 04 口径一致');

    // Only the PRE-cancel chunk stays public — the fenced late chunk is
    // never admitted, never replayed (客户端明确部分结果且不补播).
    const parts = snapshot?.artifacts?.[0]?.parts ?? [];
    const text = parts.map((p) => (p.content?.$case === 'text' ? p.content.value : '')).join('');
    assert.equal(parts.length, 1);
    assert.equal(text, '你好。');
    assert.ok(!JSON.stringify(snapshot).includes('迟到的收尾'),
      '被抑制的候选正文不出现在公开快照中');

    // The suppression is visible in the delivery stream too: exactly ONE
    // artifactUpdate event (the pre-cancel chunk) was ever committed.
    const artifactEvents = manager
      .readOutbox(taskId, { includePublished: true })
      .filter((event) => event.kind === 'artifactUpdate');
    assert.equal(artifactEvents.length, 1, '被抑制分片没有落任何投递事件');

    const exec = soleExecution(manager, taskId);
    assert.equal(exec.state, 'settled');
    assert.equal(exec.result?.outcome, 'completed', '执行行如实记录真实完成');
    assert.equal(exec.result?.reason, 'output_admission_closed',
      '执行行同时记录正文被抑制的原因（审计分离, §7.2）');

    // 重复取消 on the completed-suppressed task repeats the standard
    // semantics without inventing states (covered with fixtures in AC4 run).
  } finally {
    await stopA2aService(service);
  }
});

test('AC3: 正常完整完成 → lumithinkResult {false,true}（fixture 03 应用契约）', async () => {
  const service = await startDshService({});
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const taskId = await acceptOneTask(service, manager);
    assert.equal(await waitForTerminal(manager, taskId, 'completed'), 'completed');
    const snapshot = await manager.load(taskId);
    assert.deepEqual(snapshot?.metadata?.['lumithinkResult'],
      { version: 1, outputSuppressedAfterCancel: false, answerComplete: true },
      '完整回答携带 fixture 03 旗标（应用契约，非自定义状态）');
    assert.equal(snapshot?.status?.message, undefined,
      '完整完成无可读异常说明');
  } finally {
    await stopA2aService(service);
  }
});

// ---------------------------------------------------------------------------
// AC 4: 标准成功/错误语义（锁定官方客户端；不自创状态或错误码）
// ---------------------------------------------------------------------------

test('AC4: 标准取消语义族 — 已取消幂等成功(fixture 09)、未找到 -32001(fixture 11)、已完成 -32002(fixture 08)', async () => {
  // quotaGate trick (#87 pattern): synchronously persist the cancel intent
  // BEFORE the claim so this service hands us a pre-dispatch CANCELED task
  // deterministically; the default completion profile yields COMPLETED tasks.
  const manager = new SqliteTaskManager({ dbPath: ':memory:' });
  const canceledBeforeClaim = new Set<string>();
  let fixtureCanceledDone = false;
  const service = await startA2aService({
    config: dshTestConfig({}),
    taskStore: manager,
    quotaGate: (taskId) => {
      // ONLY the first task gets the pre-dispatch cancel intent; later tasks
      // (the COMPLETED fixture subject) must run to completion untouched.
      if (!fixtureCanceledDone && !canceledBeforeClaim.has(taskId)) {
        canceledBeforeClaim.add(taskId);
        fixtureCanceledDone = true;
        manager.recordCancelIntent({ taskId, reason: 'pre-dispatch-fixture-task' });
      }
      return { allowed: true };
    },
  });
  try {
    const { client } = await officialClient(service.base);

    // (a) 已取消任务的重复取消 → 标准 idempotent SUCCESS returning the
    //     canceled snapshot (locked fixture 09); no second persisted intent.
    const canceledRes = await postRpc(service.base, sendBody(1, wireMessage('msg-fix-a', '你好')));
    assert.equal(canceledRes.httpStatus, 200);
    const canceledId =
      ((canceledRes.body['result'] as Record<string, unknown>)?.['task'] as Record<string, unknown>)
        ?.['id'] as string;
    assert.ok(canceledId);
    assert.equal(manager.getTaskDetail(canceledId).currentState, 'canceled');
    const intentsBefore = cancelCommandCount(manager, canceledId);
    const repeatViaClient = await client.cancelTask({ tenant: '', id: canceledId, metadata: undefined });
    assert.ok(repeatViaClient.status, '重复取消返回当前任务快照');
    assert.equal(repeatViaClient.status.state, TaskState.TASK_STATE_CANCELED,
      '重复取消按 fixture 09 幂等返回当前任务（标准成功形态）');
    assert.equal(cancelCommandCount(manager, canceledId), intentsBefore,
      '重复取消没有新增持久化取消命令');

    // (b) 已完成任务的取消 → 标准 -32002 TaskNotCancelable（fixture 08，
    //     ErrorInfo 线形），不重放结果也不改状态。
    let completedId = '';
    {
      const res = await postRpc(service.base, sendBody(2, wireMessage('msg-fix-b', '你好')));
      const wire = (res.body['result'] as Record<string, unknown>)?.['task'] as
        | Record<string, unknown>
        | undefined;
      assert.ok(wire);
      completedId = wire['id'] as string;
    }
    await waitForTerminal(manager, completedId, 'completed');
    const completedSnapshot = await manager.load(completedId);
    assert.deepEqual(completedSnapshot?.metadata?.['lumithinkResult'],
      { version: 1, outputSuppressedAfterCancel: false, answerComplete: true });

    const completedFailure = await client
      .cancelTask({ tenant: '', id: completedId, metadata: undefined })
      .then(() => null, (error: unknown) => error);
    assert.ok(completedFailure, '已完成任务的取消必须以标准错误失败');
    const completedErrorReason = wireErrorReason(completedFailure);
    assert.equal(completedErrorReason, 'TASK_NOT_CANCELABLE',
      '已完成任务的取消是标准 TaskNotCancelable（fixture 08，JSON-RPC -32002）');
    assert.equal(manager.getTaskDetail(completedId).currentState, 'completed',
      '终态不可被迟到取消覆盖');

    // (c) 未找到的任务 → 标准 TaskNotFound（fixture 11，JSON-RPC -32001）。
    const missingFailure = await client
      .cancelTask({ tenant: '', id: 'task-does-not-exist', metadata: undefined })
      .then(() => null, (error: unknown) => error);
    assert.ok(missingFailure, '未知任务的取消必须以标准错误失败');
    assert.equal(wireErrorReason(missingFailure), 'TASK_NOT_FOUND',
      '未知任务的取消是标准 TaskNotFound（fixture 11，JSON-RPC -32001）');
  } finally {
    await stopA2aService(service);
    manager.close();
  }
});

// ---------------------------------------------------------------------------
// Repository-level closures carried over from earlier reviews
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

function acceptRepoTask(manager: SqliteTaskManager, key: string): string {
  const accepted = manager.acceptInput({
    requestKey: `rk-${key}`,
    fingerprint: `fp-${key}`,
    messageId: `msg-${key}`,
    inputMessage: { ...PLAIN_MESSAGE, messageId: `msg-${key}` },
  });
  assert.equal(accepted.outcome, 'created');
  return (accepted as { taskId: string }).taskId;
}

test('repo: claimExecution 校验显式 epoch 与 Turn 锚（review #84 r1 P2-③ 收口）', () => {
  const manager = new SqliteTaskManager({ dbPath: ':memory:' });
  try {
    const taskId = acceptRepoTask(manager, 'anchor-1');
    // Mismatched explicit epoch: anchor integrity verified AT CLAIM TIME.
    assert.throws(
      () =>
        manager.claimExecution({
          taskId,
          executionId: 'exec-anchor-x',
          turnSeq: 1,
          epoch: 99,
          leaseId: 'lease-anchor-x',
        }),
      (error: unknown) => error instanceof TaskManagerError && error.code === 'execution_attribution',
    );
    // Matching explicit epoch claims fine and lands with the turn's epoch.
    const claim = manager.claimExecution({
      taskId,
      executionId: 'exec-anchor-ok',
      turnSeq: 1,
      epoch: 1,
      leaseId: 'lease-anchor-ok',
    });
    if (claim.outcome !== 'claimed') assert.fail('matching epoch must claim');
    assert.equal(claim.epoch, 1);
  } finally {
    manager.close();
  }
});

// The admitChunk defensive fallback (INSERT constraint collision WITHOUT a
// matching chunkId row) is intentionally NOT constructible through the public
// API: within one BEGIN IMMEDIATE single-writer transaction every collision
// path either hits the pre-check by chunkId (duplicate/chunk_content_mismatch,
// covered in tests/task-manager-repository.spec.ts) or is unreachable under
// the single-writer discipline. The fix's discriminator fidelity
// (chunk_write_conflict vs misreported chunk_content_mismatch, review #105
// carry-over) is therefore verified at code level and documented in the PR;
// no fabricated storage-level test seam was added for it.

// ---------------------------------------------------------------------------
// Gate-level WRITE_LOCK_BUSY mapping — the #86 closing-comment test gap
// ---------------------------------------------------------------------------

test('gate: 写锁竞争 → -32000 WRITE_LOCK_BUSY（可安全重试同一消息）直接负例', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'a2a-p1-07-lockbusy-'));
  const dbPath = path.join(dir, 'tasks.sqlite');
  const service = await startTest({ configOverrides: { dbPath } });
  let blocker: DatabaseSync | null = null;
  try {
    // Hold an exclusive write lock on the TASK database longer than the
    // repository's bounded busy_timeout: the acceptance transaction must
    // fail its BEGIN IMMEDIATE, map to the typed write_lock_busy error and
    // surface the stable gate-level JSON-RPC shape.
    blocker = new DatabaseSync(dbPath);
    blocker.exec('BEGIN EXCLUSIVE');
    const res = await postRpc(service.base, sendBody(1, wireMessage('msg-lock-1', '你好')));
    assert.equal(res.httpStatus, 200);
    const error = res.body['error'] as Record<string, unknown> | undefined;
    assert.ok(error, 'the blocked acceptance surfaces a standard JSON-RPC error');
    assert.equal(error['code'], -32000);
    const data = error['data'] as { reason?: string; domain?: string }[];
    assert.equal(data?.[0]?.reason, 'WRITE_LOCK_BUSY');
    assert.equal(data?.[0]?.domain, 'lumithink.a2a');

    // Release the lock and retry the SAME message: safe by the idempotency
    // key — exactly one task exists across the whole busy/retry cycle.
    blocker.exec('ROLLBACK');
    blocker.close();
    blocker = null;
    const retry = await postRpc(service.base, sendBody(2, wireMessage('msg-lock-1', '你好')));
    assert.equal(retry.body['error'], undefined);
    const manager = service.taskStore as SqliteTaskManager;
    assert.equal(manager.stats().tasks, 1,
      '写锁忙/重试全程恰好一个任务（受理幂等使重试安全）');
  } finally {
    blocker?.close();
    await stopA2aService(service);
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});