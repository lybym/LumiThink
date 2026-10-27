/**
 * Bounded-resource limits, backpressure and content-minimized observability
 * tests (P1-09, issue #91; docs/A2A_DESIGN.md §13.4 frozen initial values,
 * docs/adr/0017-a2a-bounded-resource-limits.md). The scheduler is unit-tested
 * for determinism, plus one service-level check of the authenticated
 * operational surface. Everything is synthetic validation data (P1 口径).
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  A2A_LIMITS_DEFAULTS,
  type A2aLimitsConfig,
} from '../src/limits/config.ts';
import { AdmissionScheduler } from '../src/limits/scheduler.ts';
import {
  ObservabilityRecorder,
  memorySink,
} from '../src/limits/observability.ts';
import { buildLoadReport } from '../src/limits/load-report.ts';
import { SqliteTaskManager } from '../src/task-manager/sqlite-task-manager.ts';
import { startA2aService } from '../src/a2a-service.ts';
import {
  startTest,
  stopA2aService,
  testConfig,
  TEST_TOKEN,
  userMessage,
} from './helpers.ts';

/** §13.4 冻结初值未被悄悄改动（这些数字是容量语义的契约）。 */
test('frozen §13.4 defaults are intact', () => {
  assert.deepEqual(
    [A2A_LIMITS_DEFAULTS.concurrency.maxActiveWorkers,
     A2A_LIMITS_DEFAULTS.queue.maxQueuedGlobal,
     A2A_LIMITS_DEFAULTS.queue.maxQueuedPerHousehold,
     A2A_LIMITS_DEFAULTS.execution.maxExecutionMs,
     A2A_LIMITS_DEFAULTS.modelBudget.maxTokensPerTask,
     A2A_LIMITS_DEFAULTS.sqlite.busyTimeoutMs,
     A2A_LIMITS_DEFAULTS.sqlite.writeLockMaxWaitMs],
    [2, 8, 4, 120_000, 32_000, 2000, 5000],
  );
});

function baseLimits(overrides?: Partial<A2aLimitsConfig>): A2aLimitsConfig {
  return { ...structuredClone(A2A_LIMITS_DEFAULTS), ...(overrides ?? {}) };
}

const REQ = (over: Partial<Parameters<AdmissionScheduler['admit']>[0]> = {}) => ({
  taskId: over.taskId ?? `task-${Math.random()}`,
  contextId: over.contextId ?? `ctx-${over.taskId ?? Math.random()}`,
  householdId: over.householdId ?? 'hh-a',
  tokensToReserve: over.tokensToReserve ?? 100,
  maxWaitMs: over.maxWaitMs ?? 0,
});

async function admitOk(s: AdmissionScheduler, req: ReturnType<typeof REQ>) {
  const d = await s.admit(req);
  assert.equal(d.outcome, 'admitted');
  if (d.outcome !== 'admitted') throw new Error('unreachable');
  return d.ticket;
}

// ---------------------------------------------------------------------------
// AC 1: 容量满载 → 明确拒绝/排队；控制面有界。
// ---------------------------------------------------------------------------

test('capacity full: beyond the global worker cap, admission refuses explicitly and a release frees a slot', async () => {
  const s = new AdmissionScheduler({ limits: baseLimits() });
  const t1 = await admitOk(s, REQ({ taskId: 't1' }));
  await admitOk(s, REQ({ taskId: 't2' }));
  const t3 = await s.admit(REQ({ taskId: 't3', maxWaitMs: 0 }));
  assert.deepEqual(
    t3,
    { outcome: 'refused', reason: 'capacity_full', waitedMs: 0 },
    'beyond maxActiveWorkers=2 the refusal names capacity_full (明确拒绝)',
  );
  s.releaseExecution(t1.ticketId);
  const t4 = await admitOk(s, REQ({ taskId: 't4' }));
  const snap = s.snapshot();
  assert.equal(snap.heldTickets, 2);
  assert.ok(snap.counters.refusalsByReason.capacity_full >= 1);
  assert.equal(snap.liveModelGrants, 0);
  void t4;
});

test('queue overflow: bounded queue rejects by stable reason, first waiter admitted on release', async () => {
  const s = new AdmissionScheduler({
    limits: baseLimits({ queue: { maxQueuedGlobal: 1, maxQueuedPerHousehold: 1 }, admissionWaitMs: 60 }),
  });
  // Saturate BOTH generation slots so the third request must QUEUE.
  const h1 = await admitOk(s, REQ({ taskId: 'hold-1' }));
  const h2 = await admitOk(s, REQ({ taskId: 'hold-2' }));
  const queued = s.admit(REQ({ taskId: 'q-1', maxWaitMs: 60 }));
  await new Promise((r) => setTimeout(r, 10));
  const snapWhileWaiting = s.snapshot();
  assert.equal(snapWhileWaiting.queuedGlobal, 1, 'the waiter occupies the single queue slot');
  const third = await s.admit(REQ({ taskId: 'q-2', householdId: 'hh-b', maxWaitMs: 0 }));
  assert.deepEqual(third, { outcome: 'refused', reason: 'queue_full_global', waitedMs: 0 });
  s.releaseExecution(h1.ticketId);
  const resolved = await queued;
  assert.equal(resolved.outcome, 'admitted', 'first waiter is admitted once a slot frees');
  s.releaseExecution(h2.ticketId);
  if (resolved.outcome === 'admitted') s.releaseExecution(resolved.ticket.ticketId);
});

test('per-household queue isolation: one saturated household cannot consume another household’s slots', async () => {
  const s = new AdmissionScheduler({
    limits: baseLimits({
      concurrency: { maxActiveWorkers: 4, maxActiveWorkersPerHousehold: 1, maxActiveModelRequests: 4, maxActiveModelRequestsPerHousehold: 4 },
      queue: { maxQueuedGlobal: 8, maxQueuedPerHousehold: 1 },
      admissionWaitMs: 90,
    }),
  });
  const holdA = await admitOk(s, REQ({ taskId: 'a-hold', householdId: 'hh-a' }));
  const aQueued = s.admit(REQ({ taskId: 'a-q', householdId: 'hh-a', maxWaitMs: 90 }));
  await new Promise((r) => setTimeout(r, 5));
  const bLive = await admitOk(s, REQ({ taskId: 'b-live', householdId: 'hh-b' }));
  assert.ok(bLive.ticketId > 0, 'household hh-b is not starved by hh-a’s occupancy');
  const aSecondQueue = await s.admit(REQ({ taskId: 'a-q2', householdId: 'hh-a', maxWaitMs: 0 }));
  assert.deepEqual(aSecondQueue, { outcome: 'refused', reason: 'queue_full_household', waitedMs: 0 });
  s.releaseExecution(holdA.ticketId);
  const aResolved = await aQueued;
  assert.equal(aResolved.outcome, 'admitted');
  if (aResolved.outcome === 'admitted') s.releaseExecution(aResolved.ticket.ticketId);
  s.releaseExecution(bLive.ticketId);
});

test('queued wait is bounded: a waiter that never gets a slot refuses after its deadline', async () => {
  const s = new AdmissionScheduler({ limits: baseLimits({ admissionWaitMs: 100 }) });
  await admitOk(s, REQ({ taskId: 'hold-1' }));
  await admitOk(s, REQ({ taskId: 'hold-2' }));
  const started = Date.now();
  const refused = await s.admit(REQ({ taskId: 'starver', maxWaitMs: 60 }));
  const elapsed = Date.now() - started;
  assert.equal(refused.outcome, 'refused');
  assert.equal((refused as { reason: string }).reason, 'queue_wait_timeout');
  assert.ok(
    (refused as { waitedMs: number }).waitedMs >= 55 && (refused as { waitedMs: number }).waitedMs <= 300,
    `measured waitedMs reflects the deadline (${JSON.stringify(refused)})`,
  );
  assert.ok(elapsed >= 40 && elapsed < 3000, `bounded wait observed (${elapsed}ms)`);
});

test('control lane: reserved permit exists while generation is saturated, and the second control request returns null within its deadline', async () => {
  const s = new AdmissionScheduler({ limits: baseLimits() });
  await admitOk(s, REQ({ taskId: 'g1' }));
  await admitOk(s, REQ({ taskId: 'g2' }));
  const permit = await s.acquireControl(500);
  assert.notEqual(permit, null, 'generation saturation does not consume the control lane');
  const started = Date.now();
  const denied = await s.acquireControl(80);
  assert.equal(denied, null, 'no second reserved slot → bounded denial');
  const waited = Date.now() - started;
  assert.ok(waited >= 60 && waited < 3000, `control deadline bounded (${waited}ms)`);
  permit?.release();
  const recovered = await s.acquireControl(100);
  assert.notEqual(recovered, null, 'released permit is reusable');
  recovered?.release();
  const snap = s.snapshot();
  assert.equal(snap.controlInFlight, 0);
  assert.equal(snap.counters.doubleControlReleases, 0);
});

// ---------------------------------------------------------------------------
// AC 2: 超时/断连/失败不泄漏进程、租约与队列槽（leak-proof by shape）。
// ---------------------------------------------------------------------------

test('double release is counted but never corrupts the accounting (lease leak diagnostics)', async () => {
  const s = new AdmissionScheduler({ limits: baseLimits() });
  const ticket = await admitOk(s, REQ({ taskId: 'd1' }));
  s.releaseExecution(ticket.ticketId);
  assert.equal(s.snapshot().heldTickets, 0);
  s.releaseExecution(ticket.ticketId); // duplicate
  assert.equal(s.snapshot().heldTickets, 0);
  assert.equal(s.snapshot().counters.doubleReleases, 1, 'the double release stays visible');
});

test('model budget is CUMULATIVE: releasing a grant does not refund tokens; call counts never reset', async () => {
  const s = new AdmissionScheduler({
    limits: baseLimits({
      modelBudget: {
        maxModelRequestsPerTask: 2,
        maxTokensPerTask: 32_000,
        maxDailyTokensPerHousehold: 10_000,
      },
    }),
  });
  const ticket = await admitOk(s, REQ({ taskId: 'm1', tokensToReserve: 400 }));
  // Calls 1 and 2 are granted (maxModelRequestsPerTask=2)…
  const g1 = await s.acquireModelCall({ householdId: 'hh-a', taskId: 'm1', tokens: 700, maxWaitMs: 0 });
  assert.equal(g1.outcome === 'granted' && g1.grant.tokensReserved, 700);
  if (g1.outcome === 'granted') g1.grant.release('completed');
  const g2 = await s.acquireModelCall({ householdId: 'hh-a', taskId: 'm1', tokens: 300, maxWaitMs: 0 });
  assert.equal(g2.outcome === 'granted' && g2.grant.tokensReserved, 300);
  if (g2.outcome === 'granted') g2.grant.release('completed');
  // …the call ledger is cumulative — release did NOT reset it.
  let snap = s.snapshot();
  assert.equal(snap.taskCallsByTask['m1'], 2, 'per-task calls accumulate across releases');
  assert.equal(snap.dailyTokensByHousehold['hh-a'], 1000, 'token reservations stay spent (§13.4 重试也计入)');
  // …so the THIRD call is refused by the stable reason (review #108 r1 P1-2).
  const g3 = await s.acquireModelCall({ householdId: 'hh-a', taskId: 'm1', tokens: 200, maxWaitMs: 0 });
  assert.deepEqual(g3, { outcome: 'refused', reason: 'model_task_call_limit', waitedMs: 0 });
  s.releaseExecution(ticket.ticketId);
});

test('un-released grants stay visible as leak diagnostics', async () => {
  const s = new AdmissionScheduler({
    limits: baseLimits({
      modelBudget: {
        maxModelRequestsPerTask: 8,
        maxTokensPerTask: 32_000,
        maxDailyTokensPerHousehold: 10_000,
      },
    }),
  });
  const ticket = await admitOk(s, REQ({ taskId: 'm1', tokensToReserve: 400 }));
  const g = await s.acquireModelCall({ householdId: 'hh-a', taskId: 'm1', tokens: 700, maxWaitMs: 0 });
  assert.equal(g.outcome, 'granted');
  if (g.outcome !== 'granted') return;
  let snap = s.snapshot();
  assert.equal(snap.liveModelGrants, 1, 'an un-released grant is a visible leak diagnostic');
  assert.equal(snap.dailyTokensByHousehold['hh-a'], 700, 'reservation recorded up front');
  assert.equal(snap.taskTokensByTask['m1'], 700);
  g.grant.release('completed');
  snap = s.snapshot();
  assert.equal(snap.liveModelGrants, 0, 'release settles the grant slot');
  s.releaseExecution(ticket.ticketId);
});
/**
 * P0 regression (review #108 r1): with BOTH generation slots occupied, the
 * third request must settle REJECTED on `submitted` — NEVER stranded in
 * `working` because the capacity refusal fired after the dispatch lease had
 * already been claimed.
 */
function wireMsg(messageId: string, text: string): Record<string, unknown> {
  return { messageId, role: 'ROLE_USER', parts: [{ text }] };
}
function sendBody(id: number, message: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', id, method: 'SendMessage', params: { message } };
}
async function postWire(base: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TEST_TOKEN}`, 'a2a-version': '1.0' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

test('capacity refusal never strands a task in working (review #108 r1 P0)', async () => {
  const blockedResolvers: (() => void)[] = [];
  let blockingExecutor: import('@a2a-js/sdk/server').AgentExecutor;
  let service!: Awaited<ReturnType<typeof startA2aService>>;

  try {
    // Bounded blocking: each execution holds its slot for 5 s and then
    // finishes (deadline-free, deterministic teardown without resolvers).
    let executed = 0;
    blockingExecutor = {
      execute(): Promise<void> {
        executed += 1;
        return new Promise<void>((resolve) => setTimeout(resolve, 5000));
      },
      cancelTask(): Promise<void> { return Promise.resolve(); },
    } as unknown as import('@a2a-js/sdk/server').AgentExecutor;
    service = await startA2aService({
      config: testConfig({} as Partial<import('../src/config.ts').A2aServiceConfig>),
      executor: blockingExecutor,
    });
    const manager = service.taskStore as SqliteTaskManager;
    const controllers: AbortController[] = [];
    const postMessage = (id: number, text: string): Promise<Response> => {
      const ac = new AbortController();
      controllers.push(ac);
      return postWire(service.base, sendBody(id, wireMsg(`msg-${id}`, text)), ac.signal);
    };
    void postMessage(1, 'occupy one');
    void postMessage(2, 'occupy two');

    // Phase A: wait until TWO executions exist with public state `working`.
    let firstId: string | null = null;
    let secondId: string | null = null;
    for (let attempt = 0; attempt < 60 && (firstId === null || secondId === null); attempt += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const listed = await manager.list({ pageSize: 20 } as Parameters<typeof manager.list>[0]);
      const ids = listed.tasks.map((t) => t.id);
      if (ids.length >= 1 && firstId === null) firstId = ids[0];
      if (ids.length >= 2 && secondId === null) secondId = ids.find((v) => v !== firstId) ?? null;
    }
    assert.ok(firstId !== null && secondId !== null, `two admitted tasks appeared (${JSON.stringify([firstId, secondId])})`);
    assert.equal(manager.getTaskDetail(firstId as string).currentState, 'working');
    assert.equal(manager.getTaskDetail(secondId as string).currentState, 'working');

    // Phase B: the THIRD request hits full capacity → settled rejected, no strand.
    let thirdRejected: string | null = null;
    const p3 = postMessage(999, 'the refused request');
    for (let attempt = 0; attempt < 60 && thirdRejected === null; attempt += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const listed = await manager.list({ pageSize: 20 } as Parameters<typeof manager.list>[0]);
      for (const task of listed.tasks) {
        if (
          task.id !== firstId &&
          task.id !== secondId &&
          manager.getTaskDetail(task.id).currentState === 'rejected'
        ) {
          thirdRejected = task.id;
        }
      }
    }
    const snapCount = manager.stats().executions;
    assert.ok(thirdRejected !== null, `third task was SETTLED to rejected (observed: ${thirdRejected})`);
    assert.ok(snapCount <= 2, `no worker ever started for the refused task (executions=${snapCount})`);

    // Phase C: release the blockers so nothing outlives the test.
    for (const pending of [firstId, secondId]) {
      try {
        manager.transitionTask({
          taskId: pending as string,
          expectedState: manager.getTaskDetail(pending as string).currentState,
          expectedStateVersion: manager.getTaskDetail(pending as string).stateVersion,
          nextState: 'failed',
          reason: 'test_teardown_release',
        });
      } catch {
        // best effort teardown only
      }
    }
    void p3;
  } finally {
    await stopA2aService(service);
  }
});
test('scheduler close() settles every queued waiter with an explicit refusal (never a hang)', async () => {
  const s = new AdmissionScheduler({
    limits: baseLimits({ queue: { maxQueuedGlobal: 4, maxQueuedPerHousehold: 4 }, admissionWaitMs: 30_000 }),
  });
  const h1 = await admitOk(s, REQ({ taskId: 'hc-1' }));
  const h2 = await admitOk(s, REQ({ taskId: 'hc-2' }));
  const waiter = s.admit(REQ({ taskId: 'w1', maxWaitMs: 29_000 }));
  await new Promise((r) => setTimeout(r, 5));
  s.close();
  const settled = await waiter;
  assert.deepEqual(settled, { outcome: 'refused', reason: 'scheduler_closed', waitedMs: 0 });
  s.releaseExecution(h1.ticketId);
  s.releaseExecution(h2.ticketId);
});

// ---------------------------------------------------------------------------
// AC 3: 记录 Task/Turn/Execution/epoch/版本/耗时/错误 —— 不记录正文或凭据。
// ---------------------------------------------------------------------------

test('observability events carry identifiers only; private material is structurally dropped', () => {
  const SECRET = 'synthetic-private-body-应当被删除';
  const TOKEN_LIKE = 'synthetic-validation-token-0123456789abcdef';
  const { sink, events } = memorySink();
  const recorder = new ObservabilityRecorder({ sinks: [sink] });
  const emitted = recorder.emit({
    event: 'admission.decided',
    decision: 'admitted',
    taskId: 'task-obs-1',
    contextId: 'ctx-obs-1',
    householdId: 'hh-obs',
    // 私人材料通过未知字段注入 —— 结构上必须被丢弃：
    message: SECRET,
    bodyText: SECRET,
    authorizationHeader: `Bearer ${TOKEN_LIKE}`,
  } as never);
  assert.equal(events.length, 1);
  const serialized = JSON.stringify(events[0]);
  assert.equal(serialized.includes(SECRET), false, 'no private body text survives');
  assert.equal(serialized.includes(TOKEN_LIKE), false, 'no credential material survives');
  assert.equal(emitted.taskId, 'task-obs-1');
  assert.equal(typeof emitted.seq, 'number');
  assert.ok(recorder.droppedFieldCount >= 3, 'dropped fields stay counted (misuse visible)');
});

test('emitError records only the error CLASS name, never the error message', () => {
  const SECRET = 'boom-synthetic-private-detail';
  const { sink, events } = memorySink();
  const recorder = new ObservabilityRecorder({ sinks: [sink] });
  class SyntheticBoom extends Error {}
  recorder.emitError('execution.finished', new SyntheticBoom(SECRET), { event: 'execution.finished', taskId: 't' });
  const line = JSON.stringify(events[0]);
  assert.equal(line.includes(SyntheticBoom.name), true, 'error KIND is recorded');
  assert.equal(line.includes(SECRET), false, 'error MESSAGE (may embed user text) is never recorded');
});

// ---------------------------------------------------------------------------
// AC 4: 负载报告来自实测表面（SQLite 写锁 / Outbox 积压 / Worker 内存 / 限额）。
// ---------------------------------------------------------------------------

test('load report assembles measured surfaces with honest memory-enforcement status', () => {
  const s = new AdmissionScheduler({ limits: baseLimits() });
  const mgr = new SqliteTaskManager({ dbPath: ':memory:' });
  try {
    const startedAtMs = Date.now() - 1234;
    const report = buildLoadReport({
      runtimeMode: 'synthetic',
      limits: baseLimits(),
      scheduler: s.snapshot(),
      taskManager: mgr,
      startedAtMs,
    });
    assert.equal(report.version, 1);
    assert.equal(report.runtimeMode, 'synthetic');
    assert.equal(report.sqlite.busyTimeoutMs, 2000);
    assert.equal(report.outbox.unpublishedRows, 0);
    assert.equal(report.worker.memory.status, 'not_configured', '§13.4 部署必填项未填时保持诚实标记');
    assert.equal(report.worker.memory.mechanism, 'none', 'SYNTHETIC mode has no subprocess ceiling');
    assert.equal(report.limits.concurrency.observedMaxActiveWorkers, 0);
    assert.equal(report.uptimeMs >= 1000, true, 'uptime is evidence, not a constant');
    assert.ok(Array.isArray(report.limitations) && report.limitations.length >= 2,
      'limitations section states un-measured/honest boundaries');
  } finally {
    mgr.close();
  }
});

test('/ops/load-report rejects requests without a credential (service level, composition exposes admission facade)', async () => {
  const service = await startTest({});
  try {
    const unauth = await fetch(`${service.base}/ops/load-report`);
    assert.equal(unauth.status, 401, 'no credential → rejected (two-tier identity required)');
    // The wired composition exposes the same measured report object to
    // operations tooling; verify it answers live from measurement surfaces.
    const report = service.admission.loadReport();
    assert.equal(report.version, 1);
    assert.equal(typeof report.sqlite.busyTimeoutMs, 'number');
    assert.equal(typeof report.outbox.unpublishedRows, 'number');
    assert.ok(Array.isArray(report.limitations));
  } finally {
    await stopA2aService(service);
  }
});
