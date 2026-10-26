/**
 * P1-08 acceptance tests (issue #90): restart recovery, delete-first data
 * lifecycle and the minimal idempotent tombstone.
 *
 * AC 1  在事务提交、执行登记、Worker 启动、结果提交、Outbox 发布各切点重启，
 *       不重复执行未知副作用 — the startup scan re-decides every persisted
 *       non-terminal state from persisted facts ONLY:
 *         - submitted + no execution row (confirmed never started) →
 *           re-dispatched through the real lease path (事务提交 cut point);
 *         - active execution row (执行登记/Worker 启动/结果提交 cut points) →
 *           row 'abandoned' (ADR-0016 reserved state) + public FAILED, never
 *           re-dispatched, later callbacks rejected;
 *         - settled evidence with unsettled public state → re-derived
 *           terminal from the row (完成竞争如实结算);
 *         - un-published Outbox rows survive intact (Outbox 发布 cut point).
 *       The REAL crash-restart is exercised end-to-end with a child service
 *       process SIGKILLed mid-execution.
 * AC 2  删除优先于 7 天结果留存 — scope deletion purges inputs, artifacts,
 *       Outbox bodies, turn inputs and status/metadata through
 *       purgeTaskBody; only the tombstone + minimal state rows remain.
 * AC 3  仅留必要受限墓碑及版本化 HMAC（fpv1, P1-04）——重试返回
 *       RESULT_PURGED 且永不重跑；CancelTask-on-purged 标准语义（本 Issue
 *       收口的 deferred test gap）。
 * AC 4  撤销访问立即生效（P1-03 epoch，复验）+ 处理授权撤回按范围删除 +
 *       独立删除台账重放——已删数据不能复活（restore 模拟）。
 *
 * Carry-over closures anchored here:
 *   - #87 r1 P2-2: settleFromTaskState bookkeeping failures surface via
 *     onSettlementError (never silently swallowed, never masking);
 *   - #89 r1 P2-1: anomalous-fence completion settles explicit FAILED;
 *   - #89 r1 P2-2: forced-stop evidence records the OBSERVED signal;
 *   - #89 r1 P2-4: settlement.reason vs fencedReason separation;
 *   - #87 r1 P2-⑤ test anchoring: duplicate-session guard negative;
 *   - #86 r1 P2-3: purged body cannot resurrect through save()/replay.
 *
 * Everything is loopback + synthetic (P1 口径); no UDS switch, no real child
 * data, no publish. Crash tests use SIGKILL (never process.abort()).
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { startA2aService } from '../src/a2a-service.ts';
import { leaseDispatchExecutor } from '../src/acceptance/dispatch-lease-executor.ts';
import {
  SqliteTaskManager,
  type ExecutionSettlement,
} from '../src/task-manager/sqlite-task-manager.ts';
import { A2A_TASK_MANAGER_SCHEMA_VERSION } from '../src/task-manager/schema.ts';
import { DshWorkerRuntime } from '../src/runtime/dsh-worker-runtime.ts';
import { DeletionLedger } from '../src/recovery/deletion-ledger.ts';
import { purgeProcessingScope } from '../src/recovery/data-deletion.ts';
import { runStartupRecovery } from '../src/recovery/startup-recovery.ts';
import {
  IdentityStore,
  defaultValidationBootstrap,
  type IdentityBootstrap,
} from '../src/identity/identity-store.ts';
import type { AuthContext } from '../src/identity/model.ts';
import {
  TEST_TOKEN,
  officialClient,
  rpcHeaders,
  startTest,
  stopA2aService,
  testConfig,
  userMessage,
} from './helpers.ts';

const WORKER_ENTRY = fileURLToPath(new URL('../src/runtime/dsh-worker-entry.mjs', import.meta.url));
const RESTARTABLE_ENTRY = fileURLToPath(new URL('./fixtures/p1-08-restartable-service.ts', import.meta.url));

/** Aggressive-but-stable dsh-worker timers (same rationale as P1-07 spec). */
const TUNING = {
  entryPath: WORKER_ENTRY,
  executionTimeoutMs: 10_000,
  helloTimeoutMs: 500,
  lostContactMs: 5_000,
  cancelGraceMs: 800,
};

function tempDir(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `a2a-p1-08-${label}-`));
}

function removeTempDir(dir: string): void {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      return;
    } catch {
      // retry; the temp dir is disposable
    }
  }
}

function guardianAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    credentialId: 'cred-validation-harness',
    clientId: 'validation-harness',
    clientKind: 'dsh_profile',
    householdId: 'hh-synthetic-01',
    principal: {
      kind: 'bound_user',
      userId: 'user-guardian-synthetic',
      role: 'guardian',
      assurance: 'credential_bound',
    },
    revocationEpoch: 0,
    resolvedAtMs: 0,
    ...overrides,
  };
}

function bootstrapWithToken(token: string): IdentityBootstrap {
  return defaultValidationBootstrap(token);
}

/** Accepts one task through the raw repository (no identity binding). */
function seedTask(
  mgr: SqliteTaskManager,
  requestKey: string,
  text = '你好',
): { taskId: string; contextId: string } {
  const accepted = mgr.acceptInput({
    requestKey,
    fingerprint: `fp-${requestKey}`,
    messageId: `msg-${requestKey}`,
    inputMessage: userMessage(`msg-${requestKey}`, text),
  });
  assert.equal(accepted.outcome, 'created');
  return { taskId: accepted.taskId, contextId: accepted.contextId };
}

function soleExecution(mgr: SqliteTaskManager, taskId: string): {
  executionId: string;
  state: string;
  result: ExecutionSettlement | null;
} {
  const turns = mgr.getTaskDetail(taskId).turns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].executions.length, 1);
  return turns[0].executions[0];
}

async function waitFor(
  probe: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ---------------------------------------------------------------------------
// Startup recovery scan — persisted-state buckets (TASK_LIFECYCLE §9)
// ---------------------------------------------------------------------------

test('recovery: submitted without cancel intent is reclaimable and re-dispatched via the injected hook', async () => {
  const mgr = new SqliteTaskManager({ dbPath: ':memory:' });
  try {
    const { taskId, contextId } = seedTask(mgr, 'requeue-1');
    const requeued: { taskId: string; text: string }[] = [];
    const report = await runStartupRecovery({
      taskManager: mgr,
      requeue: async (id, input) => {
        requeued.push({
          taskId: id,
          text: input.parts?.[0]?.content?.$case === 'text' ? input.parts[0].content.value : '',
        });
      },
    });
    assert.deepEqual(report.reclaimableTaskIds, [taskId]);
    assert.deepEqual(report.requeuedTaskIds, [taskId]);
    assert.equal(requeued.length, 1);
    assert.equal(requeued[0].text, '你好');
    // The scan itself moved nothing: re-claim is the DISPATCH path's job
    // (conditional update under the lease, §9 再次检查取消、授权和资源配额).
    assert.equal(mgr.getTaskDetail(taskId).currentState, 'submitted');
    assert.equal(mgr.getTaskDetail(taskId).contextId, contextId);
    assert.equal(report.abandonedExecutions.length, 0);
  } finally {
    mgr.close();
  }
});

test('recovery: submitted with a persisted cancel intent settles CANCELED (确认未派发)', async () => {
  const mgr = new SqliteTaskManager({ dbPath: ':memory:' });
  try {
    const { taskId } = seedTask(mgr, 'requeue-cancel-1');
    assert.equal(mgr.recordCancelIntent({ taskId, reason: 'cancel_requested' }).outcome, 'recorded');
    const report = await runStartupRecovery({ taskManager: mgr });
    assert.deepEqual(report.reclaimableTaskIds, [], 'a canceled task is never re-dispatched');
    const settled = report.settledTasks[0];
    assert.ok(settled);
    assert.equal(settled.taskId, taskId);
    assert.equal(settled.to, 'canceled');
    assert.equal(settled.basis, 'undispatched_cancel');
    assert.equal(mgr.getTaskDetail(taskId).currentState, 'canceled');
  } finally {
    mgr.close();
  }
});

test('recovery: registered execution (执行登记 cut point) → abandoned row + FAILED, no re-dispatch', async () => {
  const mgr = new SqliteTaskManager({ dbPath: ':memory:' });
  try {
    const { taskId } = seedTask(mgr, 'crash-registered-1');
    assert.equal(
      mgr.claimExecution({ taskId, executionId: 'exec-crash-1', leaseId: 'lease-1' }).outcome,
      'claimed',
    );
    let requeueCalled = false;
    const report = await runStartupRecovery({
      taskManager: mgr,
      requeue: async () => {
        requeueCalled = true;
      },
    });
    assert.equal(requeueCalled, false, 'an execution of unknown outcome is NEVER re-dispatched');
    assert.deepEqual(report.reclaimableTaskIds, []);
    assert.deepEqual(report.abandonedExecutions, [
      { taskId, executionId: 'exec-crash-1', priorState: 'registered' },
    ]);
    assert.equal(mgr.getTaskDetail(taskId).currentState, 'failed');
    const exec = soleExecution(mgr, taskId);
    assert.equal(exec.state, 'abandoned');
    assert.equal(exec.result?.outcome, 'abandoned');
    assert.equal(exec.result?.reason, 'restart_interrupted_unknown_outcome');
    // Later callbacks against the abandoned row are rejected (no resurrection).
    assert.equal(
      mgr.admitChunk({
        taskId,
        executionId: 'exec-crash-1',
        turnSeq: 1,
        epoch: 1,
        leaseId: 'lease-1',
        artifactId: 'answer-1',
        text: '迟到正文',
      }).outcome,
      'rejected',
    );
  } finally {
    mgr.close();
  }
});

test('recovery: running execution (Worker 启动 cut point) with cancel intent → FAILED execution_stop_unconfirmed', async () => {
  const mgr = new SqliteTaskManager({ dbPath: ':memory:' });
  try {
    const { taskId } = seedTask(mgr, 'crash-running-1');
    assert.equal(
      mgr.claimExecution({ taskId, executionId: 'exec-crash-2', leaseId: 'lease-2' }).outcome,
      'claimed',
    );
    assert.equal(mgr.recordCancelIntent({ taskId, reason: 'cancel_requested' }).outcome, 'recorded');
    assert.equal(mgr.markExecutionStopRequested({ taskId }).outcome, 'marked');
    const report = await runStartupRecovery({ taskManager: mgr });
    assert.equal(report.settledTasks[0]?.basis, 'stop_unconfirmed');
    assert.equal(mgr.getTaskDetail(taskId).currentState, 'failed');
    const exec = soleExecution(mgr, taskId);
    assert.equal(exec.state, 'abandoned');
    assert.equal(exec.result?.reason, 'execution_stop_unconfirmed',
      '取消后无法确认停止 → §7.2 execution_stop_unconfirmed（不谎报 CANCELED）');
  } finally {
    mgr.close();
  }
});

test('recovery: settled completed evidence + cancel intent + closed admission → COMPLETED with suppressed flags (结果提交 cut point)', async () => {
  const mgr = new SqliteTaskManager({ dbPath: ':memory:' });
  try {
    const { taskId } = seedTask(mgr, 'crash-settled-1');
    assert.equal(
      mgr.claimExecution({ taskId, executionId: 'exec-crash-3', leaseId: 'lease-3' }).outcome,
      'claimed',
    );
    assert.equal(mgr.recordCancelIntent({ taskId, reason: 'cancel_requested' }).outcome, 'recorded');
    assert.equal(
      mgr.settleExecution({
        taskId,
        executionId: 'exec-crash-3',
        turnSeq: 1,
        epoch: 1,
        leaseId: 'lease-3',
        result: { outcome: 'completed' },
      }).outcome,
      'settled',
    );
    const report = await runStartupRecovery({ taskManager: mgr });
    assert.equal(report.settledTasks[0]?.basis, 'execution_evidence');
    assert.equal(mgr.getTaskDetail(taskId).currentState, 'completed');
    const detail = mgr.getTaskDetail(taskId);
    assert.equal(detail.currentState, 'completed');
    const task = await mgr.load(taskId);
    assert.deepEqual(task?.metadata?.['lumithinkResult'], {
      version: 1,
      outputSuppressedAfterCancel: true,
      answerComplete: false,
    }, '恢复的完成如实携带 fixture 04 抑制旗标');
    const statusMessage = task?.status?.message;
    const explanation = (statusMessage?.parts ?? [])
      .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
      .join('');
    assert.match(explanation, /执行已完成，后续输出因取消被抑制/);
  } finally {
    mgr.close();
  }
});

test('recovery: settled completed evidence without cancel → COMPLETED with full-answer flags', async () => {
  const mgr = new SqliteTaskManager({ dbPath: ':memory:' });
  try {
    const { taskId } = seedTask(mgr, 'crash-settled-2');
    assert.equal(
      mgr.claimExecution({ taskId, executionId: 'exec-crash-4', leaseId: 'lease-4' }).outcome,
      'claimed',
    );
    assert.equal(
      mgr.settleExecution({
        taskId,
        executionId: 'exec-crash-4',
        turnSeq: 1,
        epoch: 1,
        leaseId: 'lease-4',
        result: { outcome: 'completed' },
      }).outcome,
      'settled',
    );
    await runStartupRecovery({ taskManager: mgr });
    const task = await mgr.load(taskId);
    assert.equal(mgr.getTaskDetail(taskId).currentState, 'completed');
    assert.deepEqual(task?.metadata?.['lumithinkResult'], {
      version: 1,
      outputSuppressedAfterCancel: false,
      answerComplete: true,
    });
  } finally {
    mgr.close();
  }
});

test('recovery: settled completed evidence with an anomaly fencedReason → FAILED output_anomaly_fenced', async () => {
  const mgr = new SqliteTaskManager({ dbPath: ':memory:' });
  try {
    const { taskId } = seedTask(mgr, 'crash-settled-3');
    assert.equal(
      mgr.claimExecution({ taskId, executionId: 'exec-crash-5', leaseId: 'lease-5' }).outcome,
      'claimed',
    );
    assert.equal(
      mgr.settleExecution({
        taskId,
        executionId: 'exec-crash-5',
        turnSeq: 1,
        epoch: 1,
        leaseId: 'lease-5',
        result: { outcome: 'completed', fencedReason: 'chunk_content_mismatch' },
      }).outcome,
      'settled',
    );
    const report = await runStartupRecovery({ taskManager: mgr });
    assert.equal(report.settledTasks[0]?.basis, 'fenced_anomaly');
    assert.equal(mgr.getTaskDetail(taskId).currentState, 'failed');
  } finally {
    mgr.close();
  }
});

test('recovery: settled failed evidence → FAILED; settled canceled evidence → CANCELED', async () => {
  const mgr = new SqliteTaskManager({ dbPath: ':memory:' });
  try {
    const { taskId } = seedTask(mgr, 'crash-settled-4');
    assert.equal(
      mgr.claimExecution({ taskId, executionId: 'exec-crash-6', leaseId: 'lease-6' }).outcome,
      'claimed',
    );
    assert.equal(
      mgr.settleExecution({
        taskId,
        executionId: 'exec-crash-6',
        turnSeq: 1,
        epoch: 1,
        leaseId: 'lease-6',
        result: { outcome: 'canceled', reason: 'worker_profile_canceled' },
      }).outcome,
      'settled',
    );
    await runStartupRecovery({ taskManager: mgr });
    assert.equal(mgr.getTaskDetail(taskId).currentState, 'canceled');

    const second = seedTask(mgr, 'crash-settled-5');
    assert.equal(
      mgr.claimExecution({ taskId: second.taskId, executionId: 'exec-crash-7', leaseId: 'lease-7' }).outcome,
      'claimed',
    );
    assert.equal(
      mgr.settleExecution({
        taskId: second.taskId,
        executionId: 'exec-crash-7',
        turnSeq: 1,
        epoch: 1,
        leaseId: 'lease-7',
        result: { outcome: 'crashed', reason: 'worker_exit_abnormal' },
      }).outcome,
      'settled',
    );
    await runStartupRecovery({ taskManager: mgr });
    assert.equal(mgr.getTaskDetail(second.taskId).currentState, 'failed');
  } finally {
    mgr.close();
  }
});

test('recovery: terminal task keeps its state; only the stale active row is closed (已终态保持不变)', async () => {
  const mgr = new SqliteTaskManager({ dbPath: ':memory:' });
  try {
    const { taskId } = seedTask(mgr, 'terminal-stale-1');
    assert.equal(
      mgr.claimExecution({ taskId, executionId: 'exec-stale-1', leaseId: 'lease-8' }).outcome,
      'claimed',
    );
    const detail = mgr.getTaskDetail(taskId);
    const committed = mgr.transitionTask({
      taskId,
      expectedState: detail.currentState,
      expectedStateVersion: detail.stateVersion,
      nextState: 'failed',
      reason: 'test_terminal_before_restart',
    });
    assert.equal(committed.outcome, 'committed');
    const report = await runStartupRecovery({ taskManager: mgr });
    assert.deepEqual(report.settledTasks, [], 'terminal tasks are untouched');
    assert.deepEqual(report.abandonedExecutions, [
      { taskId, executionId: 'exec-stale-1', priorState: 'registered' },
    ]);
    assert.equal(mgr.getTaskDetail(taskId).currentState, 'failed');
  } finally {
    mgr.close();
  }
});

test('recovery: un-published Outbox rows are reported and left intact (Outbox 发布 cut point)', async () => {
  const mgr = new SqliteTaskManager({ dbPath: ':memory:' });
  try {
    const { taskId } = seedTask(mgr, 'outbox-restart-1');
    assert.equal(
      mgr.claimExecution({ taskId, executionId: 'exec-outbox-1', leaseId: 'lease-9' }).outcome,
      'claimed',
    );
    assert.equal(
      mgr.admitChunk({
        taskId,
        executionId: 'exec-outbox-1',
        turnSeq: 1,
        epoch: 1,
        leaseId: 'lease-9',
        artifactId: 'answer-1',
        text: '重启前已提交的片段',
      }).outcome,
      'admitted',
    );
    const detail = mgr.getTaskDetail(taskId);
    mgr.transitionTask({
      taskId,
      expectedState: detail.currentState,
      expectedStateVersion: detail.stateVersion,
      nextState: 'completed',
      reason: 'test_completed_before_restart',
    });
    const before = mgr.readOutbox(taskId, { includePublished: true });
    assert.ok(before.length > 0);
    const report = await runStartupRecovery({ taskManager: mgr });
    assert.deepEqual(report.unpublishedOutboxTaskIds, [taskId]);
    const after = mgr.readOutboxAfter(taskId, 0);
    assert.deepEqual(after, before, '重发保持片段 ID、位置与摘要（§9 Outbox 未发送）');
  } finally {
    mgr.close();
  }
});

test('recovery: crash-window orphan task bindings are released with audit; real bindings stay', async () => {
  const dir = tempDir('orphan');
  try {
    const identity = new IdentityStore({ dbPath: path.join(dir, 'identity.sqlite3') });
    identity.applyBootstrap(bootstrapWithToken(TEST_TOKEN));
    const mgr = new SqliteTaskManager({ dbPath: ':memory:' });
    try {
      const guardian = guardianAuth();
      // Real binding (task row EXISTS).
      const real = seedTask(mgr, 'orphan-real-1');
      identity.bindTask({ taskId: real.taskId, contextId: real.contextId, auth: guardian });
      // Crash-window orphan: binding written, task row never committed.
      identity.bindTask({ taskId: randomUUID(), contextId: randomUUID(), auth: guardian });
      assert.equal(identity.allTaskBindings().length, 2);

      const report = await runStartupRecovery({ taskManager: mgr, identity });
      assert.equal(report.orphanBindingsReleased.length, 1);
      assert.equal(identity.allTaskBindings().length, 1);
      assert.equal(identity.allTaskBindings()[0]?.taskId, real.taskId);
      const releaseAudit = identity
        .auditEntries(50)
        .filter((entry) => entry.action === 'task_binding_released' && entry.reason === 'startup_orphan_binding_cleanup');
      assert.equal(releaseAudit.length, 1, 'orphan release is audited');
    } finally {
      mgr.close();
      identity.close();
    }
  } finally {
    removeTempDir(dir);
  }
});

test('recovery: settleExecution against an abandoned row observes already_settled (first close wins)', async () => {
  const mgr = new SqliteTaskManager({ dbPath: ':memory:' });
  try {
    const { taskId } = seedTask(mgr, 'abandoned-anchor-1');
    assert.equal(
      mgr.claimExecution({ taskId, executionId: 'exec-abandon-1', leaseId: 'lease-10' }).outcome,
      'claimed',
    );
    await runStartupRecovery({ taskManager: mgr });
    assert.equal(soleExecution(mgr, taskId).state, 'abandoned');
    const late = mgr.settleExecution({
      taskId,
      executionId: 'exec-abandon-1',
      turnSeq: 1,
      epoch: 1,
      leaseId: 'lease-10',
      result: { outcome: 'completed' },
    });
    assert.deepEqual(late, { outcome: 'already_settled', state: 'abandoned' });
    assert.equal(soleExecution(mgr, taskId).result?.outcome, 'abandoned');
  } finally {
    mgr.close();
  }
});

// ---------------------------------------------------------------------------
// Deletion ledger + delete-first orchestration (AC 2 / AC 4)
// ---------------------------------------------------------------------------

test('deletion ledger: versioned schema, fail-closed future version, record + replay (已删数据不能复活)', () => {
  const dir = tempDir('ledger');
  try {
    const dbPath = path.join(dir, 'ledger.sqlite3');
    const ledger = new DeletionLedger({ dbPath });
    assert.equal(ledger.schemaVersion, 1);
    ledger.recordTaskDeletion({ taskId: 'task-ledger-1', scope: 'task:task-ledger-1', reason: 'processing_authorization_withdrawn' });
    ledger.recordTaskDeletion({ taskId: 'task-ledger-2', scope: 'household:hh-synthetic-01', reason: 'personal_data_deletion' });
    assert.equal(ledger.entries().length, 2);
    ledger.close();

    // A NEWER ledger version refuses to open (fail-closed, same contract as
    // the task/identity stores).
    const raw = new DatabaseSync(dbPath);
    raw
      .prepare(
        "INSERT INTO lumithink_a2a_deletion_ledger_meta (key, value) VALUES ('schema_version', '99') " +
          "ON CONFLICT(key) DO UPDATE SET value = '99'",
      )
      .run();
    raw.close();
    assert.throws(() => new DeletionLedger({ dbPath }), /NEWER than this build supports/);
  } finally {
    removeTempDir(dir);
  }
});

test('deletion ledger: replay purges a RESTORED old snapshot back to the tombstone (restore simulation)', async () => {
  const dir = tempDir('ledger-replay');
  try {
    const taskDbPath = path.join(dir, 'tasks.sqlite3');
    const ledgerPath = path.join(dir, 'ledger.sqlite3');
    // Phase 1 — the LIVE deployment: accept, admit body, journal the
    // deletion, purge. The service then goes DOWN (store closed).
    const mgr = new SqliteTaskManager({ dbPath: taskDbPath });
    const { taskId } = seedTask(mgr, 'ledger-replay-1');
    assert.equal(
      mgr.claimExecution({ taskId, executionId: 'exec-ledger-1', leaseId: 'lease-11' }).outcome,
      'claimed',
    );
    assert.equal(
      mgr.admitChunk({
        taskId,
        executionId: 'exec-ledger-1',
        turnSeq: 1,
        epoch: 1,
        leaseId: 'lease-11',
        artifactId: 'answer-1',
        text: '应当被删除的正文',
      }).outcome,
      'admitted',
    );
    const ledger = new DeletionLedger({ dbPath: ledgerPath });
    // Delete-first: the ledger entry is recorded, THEN the body is purged.
    ledger.recordTaskDeletion({ taskId, scope: 'task:x', reason: 'processing_authorization_withdrawn' });
    mgr.purgeTaskBody(taskId);
    assert.equal(mgr.stats().chunks, 0);
    mgr.close();

    // Phase 2 — RESTORE SIMULATION: while the service is down, an old
    // Task-DB snapshot is restored (raw re-insertion of the rows the backup
    // would contain). The restore happens on the CLOSED database — exactly
    // what a restore drill does before the service reopens.
    const restored = new DatabaseSync(taskDbPath);
    const now = Date.now();
    restored
      .prepare(
        "INSERT INTO a2a_artifacts (task_id, artifact_id, name, description, metadata_json, created_at_ms) VALUES (?, 'answer-1', 'Admitted answer', NULL, NULL, ?)",
      )
      .run(taskId, now);
    restored
      .prepare(
        "INSERT INTO a2a_artifact_chunks (task_id, artifact_id, chunk_seq, chunk_id, text, part_json, start_byte, end_byte, sha256, created_at_ms) VALUES (?, 'answer-1', 1, 'answer-1#chunk-1', '应当被删除的正文', NULL, 0, 27, ?, ?)",
      )
      .run(taskId, '0'.repeat(64), now);
    restored
      .prepare(
        "INSERT INTO a2a_task_history (task_id, seq, message_id, message_json, created_at_ms) VALUES (?, 1, 'msg-ledger-replay-1', ?, ?)",
      )
      .run(taskId, JSON.stringify(userMessage('msg-ledger-replay-1', '应当被删除的正文')), now);
    restored.close();

    // Phase 3 — REOPEN (the restored deployment): the resurrected rows are
    // there, then the deletion ledger replays BEFORE the service opens.
    const reopened = new SqliteTaskManager({ dbPath: taskDbPath });
    try {
      assert.equal(reopened.stats().chunks, 1, 'the restored snapshot resurrected rows (precondition)');

      const replay = ledger.replayAgainst(reopened);
      // The phase-1 purge already stamped the fail-closed marker, so the
      // replay of THIS entry reports alreadyPurged — the restored rows are
      // deleted again either way (asserted below).
      assert.deepEqual(replay, { reapplied: 0, alreadyPurged: 1, missingTaskIds: [] });
      assert.equal(reopened.stats().chunks, 0, 'restored body cannot survive the ledger replay');
      assert.equal(reopened.stats().history, 0);
      // Idempotent second replay observes alreadyPurged.
      const replay2 = ledger.replayAgainst(reopened);
      assert.deepEqual(replay2, { reapplied: 0, alreadyPurged: 1, missingTaskIds: [] });
      // A ledger entry for a task that does not exist in the current DB is
      // reported as missing (restore predating the task) — not an error.
      ledger.recordTaskDeletion({ taskId: 'task-never-existed', scope: 'task:y', reason: 'test' });
      const replay3 = ledger.replayAgainst(reopened);
      assert.deepEqual(replay3.missingTaskIds, ['task-never-existed']);

      // The tombstone retry contract still holds after the whole cycle.
      const retry = reopened.acceptInput({
        requestKey: 'ledger-replay-1',
        fingerprint: 'fp-ledger-replay-1',
        messageId: 'msg-ledger-replay-1',
        inputMessage: userMessage('msg-ledger-replay-1', '应当被删除的正文'),
      });
      assert.deepEqual(retry, { outcome: 'tombstoned', taskId });
    } finally {
      reopened.close();
    }
    ledger.close();
  } finally {
    removeTempDir(dir);
  }
});

test('purgeProcessingScope: household scope purges every scope task after revocation, ledger records each', () => {
  const identity = new IdentityStore({ dbPath: ':memory:' });
  identity.applyBootstrap(bootstrapWithToken(TEST_TOKEN));
  const mgr = new SqliteTaskManager({ dbPath: ':memory:' });
  const ledger = new DeletionLedger({ dbPath: ':memory:' });
  try {
    const guardian = guardianAuth();
    const first = seedTask(mgr, 'scope-1', '范围正文一');
    const second = seedTask(mgr, 'scope-2', '范围正文二');
    const third = seedTask(mgr, 'scope-3', '范围正文三');
    for (const task of [first, second, third]) {
      identity.bindTask({ taskId: task.taskId, contextId: task.contextId, auth: guardian });
      assert.equal(
        mgr.claimExecution({ taskId: task.taskId, executionId: `exec-${task.taskId}`, leaseId: `lease-${task.taskId}` }).outcome,
        'claimed',
      );
      assert.equal(
        mgr.admitChunk({
          taskId: task.taskId,
          executionId: `exec-${task.taskId}`,
          turnSeq: 1,
          epoch: 1,
          leaseId: `lease-${task.taskId}`,
          artifactId: 'answer-1',
          text: '范围正文',
        }).outcome,
        'admitted',
      );
      const detail = mgr.getTaskDetail(task.taskId);
      mgr.transitionTask({
        taskId: task.taskId,
        expectedState: detail.currentState,
        expectedStateVersion: detail.stateVersion,
        nextState: 'completed',
        reason: 'test_completed_for_scope_purge',
      });
    }
    // AC 4 first clause (P1-03 re-check): revocation takes effect IMMEDIATELY.
    assert.equal(identity.revokeMembership('hh-synthetic-01', 'user-guardian-synthetic'), true);
    assert.equal(identity.revocationEpoch > 1, true, 'epoch bumped');

    const result = purgeProcessingScope({
      taskManager: mgr,
      identity,
      ledger,
      scope: { kind: 'household', householdId: 'hh-synthetic-01' },
      reason: 'processing_authorization_withdrawn',
    });
    assert.equal(result.purgedTaskIds.length, 3);
    assert.deepEqual(result.alreadyPurgedTaskIds, []);
    assert.deepEqual(result.missingTaskIds, []);
    assert.equal(ledger.entries().length, 3, 'every deletion is journaled independently');
    // AC 2: 删除优先于 7 天结果留存 — nothing but the minimal tombstone remains.
    const scopeKeyByTask = new Map([
      [first.taskId, 'scope-1'],
      [second.taskId, 'scope-2'],
      [third.taskId, 'scope-3'],
    ]);
    for (const task of [first, second, third]) {
      const key = scopeKeyByTask.get(task.taskId);
      assert.ok(key);
      const retry = mgr.acceptInput({
        requestKey: key,
        fingerprint: `fp-${key}`,
        messageId: `msg-${key}`,
        inputMessage: userMessage(`msg-${key}`, '范围正文'),
      });
      assert.deepEqual(retry, { outcome: 'tombstoned', taskId: task.taskId });
      const detail = mgr.getTaskDetail(task.taskId);
      assert.equal(detail.currentState, 'completed', 'terminal state untouched by the purge');
    }
    assert.equal(mgr.stats().chunks, 0);
    assert.equal(mgr.stats().history, 0);
    assert.equal(mgr.stats().artifacts, 0);
    assert.equal(mgr.stats().outbox, 0);

    // Idempotent re-application (e.g. a second withdrawal sweep).
    const again = purgeProcessingScope({
      taskManager: mgr,
      identity,
      ledger,
      scope: { kind: 'household', householdId: 'hh-synthetic-01' },
      reason: 'processing_authorization_withdrawn',
    });
    assert.equal(again.purgedTaskIds.length, 0);
    assert.equal(again.alreadyPurgedTaskIds.length, 3);
  } finally {
    ledger.close();
    mgr.close();
    identity.close();
  }
});

// ---------------------------------------------------------------------------
// Service-level: startup wiring, real crash-restart, purged wire semantics,
// carry-over closures (#89 P2-1/P2-2, #87 P2-2/P2-⑤)
// ---------------------------------------------------------------------------

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

function wireErrorReason(error: unknown): string {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const reason = (candidate as { reason?: unknown } | null)?.reason;
    if (typeof reason === 'string') return reason;
  }
  return '';
}

test('service boot re-dispatches a confirmed-never-started task through the REAL lease path (事务提交 cut point)', async () => {
  const dir = tempDir('boot-requeue');
  try {
    const taskDbPath = path.join(dir, 'tasks.sqlite3');
    const mgr = new SqliteTaskManager({ dbPath: taskDbPath });
    const { taskId } = seedTask(mgr, 'boot-requeue-1', '重启前的受理');
    mgr.close();

    const service = await startTest({
      configOverrides: { dbPath: taskDbPath },
    });
    try {
      assert.ok(service.recovery, 'the service runs the startup recovery scan');
      assert.deepEqual(service.recovery.requeuedTaskIds, [taskId]);
      assert.deepEqual(service.recovery.reclaimableTaskIds, [taskId]);
      const manager = service.taskStore as SqliteTaskManager;
      // The re-dispatch went through quota → claim → authorization → worker;
      // the synthetic executor completes the task normally. (The row may
      // settle via the decorator's state-mirroring fallback slightly BEFORE
      // the async event persistence lands — the public state is authoritative
      // and is what the test awaits.)
      await waitFor(
        () => manager.getTaskDetail(taskId).currentState === 'completed',
        'the re-dispatched task never completed',
      );
      const exec = soleExecution(manager, taskId);
      assert.equal(exec.state, 'settled');
      // Exactly ONE execution: the re-dispatch is the FIRST execution ever.
      assert.equal(manager.stats().executions, 1);
      const retryScan = await runStartupRecovery({ taskManager: manager });
      assert.deepEqual(retryScan.reclaimableTaskIds, [], 'the completed task is not reclaimable');
    } finally {
      await stopA2aService(service);
    }
  } finally {
    removeTempDir(dir);
  }
});

test('service boot replays the deletion ledger BEFORE opening (恢复时先重放删除)', async () => {
  const dir = tempDir('boot-ledger');
  try {
    const taskDbPath = path.join(dir, 'tasks.sqlite3');
    const ledgerPath = path.join(dir, 'ledger.sqlite3');
    const mgr = new SqliteTaskManager({ dbPath: taskDbPath });
    const { taskId } = seedTask(mgr, 'boot-ledger-1', '台账正文');
    assert.equal(
      mgr.claimExecution({ taskId, executionId: 'exec-boot-ledger', leaseId: 'lease-boot' }).outcome,
      'claimed',
    );
    assert.equal(
      mgr.admitChunk({
        taskId,
        executionId: 'exec-boot-ledger',
        turnSeq: 1,
        epoch: 1,
        leaseId: 'lease-boot',
        artifactId: 'answer-1',
        text: '台账正文',
      }).outcome,
      'admitted',
    );
    const detail = mgr.getTaskDetail(taskId);
    mgr.transitionTask({
      taskId,
      expectedState: detail.currentState,
      expectedStateVersion: detail.stateVersion,
      nextState: 'completed',
      reason: 'test_completed_before_ledger_replay',
    });
    const ledger = new DeletionLedger({ dbPath: ledgerPath });
    ledger.recordTaskDeletion({ taskId, scope: 'task:x', reason: 'processing_authorization_withdrawn' });
    mgr.purgeTaskBody(taskId);
    mgr.close();
    // Release this test-scoped ledger connection before the service boot
    // opens its OWN DeletionLedger on the same file — an open WAL/-shm
    // handle pins the temp dir and stalls rmSync cleanup for minutes on
    // Windows (observed: +579s).
    ledger.close();
    // RESTORE SIMULATION (service down, store closed): old snapshot rows
    // come back before the service reopens.
    const restored = new DatabaseSync(taskDbPath);
    const now = Date.now();
    restored
      .prepare(
        "INSERT INTO a2a_artifacts (task_id, artifact_id, name, description, metadata_json, created_at_ms) VALUES (?, 'answer-1', 'Admitted answer', NULL, NULL, ?)",
      )
      .run(taskId, now);
    restored
      .prepare(
        "INSERT INTO a2a_artifact_chunks (task_id, artifact_id, chunk_seq, chunk_id, text, part_json, start_byte, end_byte, sha256, created_at_ms) VALUES (?, 'answer-1', 1, 'answer-1#chunk-1', '台账正文', NULL, 0, 12, ?, ?)",
      )
      .run(taskId, '0'.repeat(64), now);
    restored.close();
    const service = await startTest({
      configOverrides: { dbPath: taskDbPath, deletionLedgerDbPath: ledgerPath },
    });
    try {
      assert.ok(service.recovery?.ledgerReplay);
      // The phase-1 purge already stamped the fail-closed marker, so the
      // replay of THIS entry reports alreadyPurged (unit-test authority:
      // "deletion ledger: replay purges a RESTORED old snapshot"). What this
      // boot-level assertion pins is that the resurrection did NOT survive:
      // chunks/artifacts must be zero again before the service opened.
      assert.deepEqual(service.recovery.ledgerReplay, {
        reapplied: 0,
        alreadyPurged: 1,
        missingTaskIds: [],
      });
      const manager = service.taskStore as SqliteTaskManager;
      assert.equal(manager.stats().chunks, 0, 'restored body was purged again before the service opened');
      assert.equal(manager.stats().artifacts, 0);
      assert.equal(manager.getTaskDetail(taskId).currentState, 'completed');
    } finally {
      await stopA2aService(service);
    }
  } finally {
    removeTempDir(dir);
  }
});

test('REAL crash-restart: SIGKILLed service mid-execution → abandoned + FAILED on restart, no re-dispatch, no orphan adoption (AC1)', async () => {
  const dir = tempDir('crash-restart');
  let orphanPid: number | null = null;
  let childService: ReturnType<typeof spawn> | null = null;
  try {
    const taskDbPath = path.join(dir, 'tasks.sqlite3');
    const identityDbPath = path.join(dir, 'identity.sqlite3');
    const ledgerPath = path.join(dir, 'ledger.sqlite3');
    const port = 0;
    childService = spawn(
      process.execPath,
      [RESTARTABLE_ENTRY],
      {
        env: {
          ...process.env,
          LUMITHINK_A2A_VALIDATION_TOKEN: TEST_TOKEN,
          LUMITHINK_A2A_VALIDATION_PORT: String(port),
          LUMITHINK_A2A_VALIDATION_DB: taskDbPath,
          LUMITHINK_A2A_IDENTITY_DB: identityDbPath,
          LUMITHINK_A2A_DELETION_LEDGER_DB: ledgerPath,
          LUMITHINK_A2A_FINGERPRINT_KEY: 'p1-08-restart-test-fingerprint-key',
          LUMITHINK_A2A_RUNTIME_MODE: 'dsh-worker',
          LUMITHINK_A2A_DSH_WORKER_TIMEOUT_MS: '30000',
          LUMITHINK_A2A_DSH_WORKER_HELLO_TIMEOUT_MS: '2000',
          LUMITHINK_A2A_DSH_WORKER_LOST_CONTACT_MS: '5000',
          LUMITHINK_A2A_DSH_WORKER_CANCEL_GRACE_MS: '800',
          LUMITHINK_A2A_WORKER_BEHAVIOR: 'never-stops',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const readyBase = await new Promise<string>((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('restartable service never became READY')), 20000);
      let buffered = '';
      childService!.stdout!.setEncoding('utf8');
      childService!.stdout!.on('data', (chunk: string) => {
        buffered += chunk;
        const match = /READY (http:\/\/\S+)/.exec(buffered);
        if (match) {
          clearTimeout(guard);
          resolve(match[1]);
        }
      });
      childService!.stderr!.setEncoding('utf8');
      childService!.stderr!.on('data', (chunk: string) => {
        buffered += chunk;
      });
    });

    // Drive ONE real worker execution through the HTTP wire. The blocking
    // request will not resolve while the never-stops worker runs — the
    // database is the truth; fire it and poll.
    void postRpc(readyBase, sendBody(1, wireMessage('msg-crash-1', '你好'))).catch(() => undefined);

    // Wait for the execution row to exist AND still be ACTIVE (执行登记 +
    // Worker 启动 happened), reading the DB the dying service will leave
    // behind. A settled row here would mean the worker died prematurely.
    let preKillRow: { state: string; worker_id: string | null } | null = null;
    await waitFor(
      () => {
        const db = new DatabaseSync(taskDbPath, { readOnly: true });
        try {
          const row = db
            .prepare('SELECT state, worker_id FROM a2a_executions ORDER BY created_at_ms DESC LIMIT 1')
            .get() as { state: string; worker_id: string | null } | undefined;
          if (row !== undefined) preKillRow = row;
          return row !== undefined && (row.state === 'registered' || row.state === 'running');
        } finally {
          db.close();
        }
      },
      `the execution row never appeared active (last observed: ${JSON.stringify(preKillRow)})`,
      15000,
    );
    // Record the worker pid (workerId 'dshw-<pid>-<rand>') so the orphaned
    // never-stops worker can be reaped after the service dies.
    const activeRow = preKillRow as { state: string; worker_id: string | null } | null;
    const pidMatch = /^dshw-(\d+)-/.exec(activeRow?.worker_id ?? '');
    if (pidMatch) orphanPid = Number(pidMatch[1]);

    // THE CRASH: SIGKILL the service process mid-execution (real cut point —
    // no dispose, no clean close; the never-stops worker becomes an orphan).
    const dying = childService;
    dying.kill('SIGKILL');
    await waitFor(
      () => dying.exitCode !== null || dying.signalCode !== null,
      'the child service process never confirmed its death',
      10_000,
    );
    // Brief settle: on Windows the OS releases the killed process's SQLite
    // WAL/-shm handles a beat after the exit event; the restart must not
    // race that release (disk I/O error on open otherwise).
    await new Promise((resolve) => setTimeout(resolve, 300));

    // RESTART on the same databases, in-process.
    const restarted = await startA2aService({
      config: testConfig({
        dbPath: taskDbPath,
        identityDbPath,
        deletionLedgerDbPath: ledgerPath,
        runtimeMode: 'dsh-worker',
        // Same fpv1 HMAC key as the SIGKILLed child service (env
        // LUMITHINK_A2A_FINGERPRINT_KEY): request-key scope must be stable
        // across restarts or a retry of a pre-crash message is not
        // recognised as a duplicate.
        fingerprintKey: 'p1-08-restart-test-fingerprint-key',
        dshWorker: { ...TUNING, workerEnv: {} },
      } as Parameters<typeof testConfig>[0]),
    });
    try {
      const manager = restarted.taskStore as SqliteTaskManager;
      assert.ok(restarted.recovery, 'the restarted service ran the recovery scan');
      assert.equal(restarted.recovery.abandonedExecutions.length, 1);
      assert.equal(restarted.recovery.settledTasks[0]?.basis, 'interrupted');
      assert.deepEqual(restarted.recovery.reclaimableTaskIds, [], 'unknown-outcome executions are never re-queued');
      assert.deepEqual(restarted.recovery.requeuedTaskIds, []);

      const listed = await manager.list({ pageSize: 10 } as unknown as Parameters<SqliteTaskManager['list']>[0]);
      assert.equal(listed.tasks.length, 1);
      const taskId = listed.tasks[0].id;
      await waitFor(
        () => manager.getTaskDetail(taskId).currentState === 'failed',
        'the interrupted task never settled on restart',
      );
      assert.equal(manager.getTaskDetail(taskId).currentState, 'failed');
      const exec = soleExecution(manager, taskId);
      assert.equal(exec.state, 'abandoned');
      assert.equal(exec.result?.outcome, 'abandoned');

      // 不重复执行未知副作用: exactly ONE execution row exists — nothing was
      // re-claimed, no worker was re-spawned for the interrupted task.
      assert.equal(manager.stats().executions, 1);
      assert.equal(restarted.runtime?.sessionByTask(taskId), undefined);

      // A retry of the original message is a duplicate: the FAILED snapshot
      // is answered, no new execution, no re-run.
      const retry = await postRpc(restarted.base, sendBody(2, wireMessage('msg-crash-1', '你好')));
      assert.equal(retry.httpStatus, 200);
      const retryTask = (retry.body['result'] as { task?: { id?: string; status?: { state?: string } } } | undefined)?.task;
      assert.equal(retryTask?.id, taskId);
      assert.equal(retryTask?.status?.state, 'TASK_STATE_FAILED');
      assert.equal(manager.stats().executions, 1, 'the retry never re-executed anything');
    } finally {
      await stopA2aService(restarted);
    }
  } finally {
    if (childService !== null && childService.exitCode === null) {
      childService.kill('SIGKILL');
    }
    // The SIGKILLed service's never-stops worker may survive as an orphan —
    // the scan must NOT adopt it; the test reaps it by its recorded pid.
    if (orphanPid !== null) {
      try {
        process.kill(orphanPid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    removeTempDir(dir);
  }
});

test('purged task wire semantics (deferred P1-07 test gap): CancelTask → standard not-cancelable; GetTask → cleaned shell; retry → RESULT_PURGED', async () => {
  const service = await startTest();
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const message = wireMessage('msg-purge-wire-1', '将被清理的回答');
    const sent = await postRpc(service.base, sendBody(1, message));
    assert.equal(sent.httpStatus, 200);
    const taskId = ((sent.body['result'] as { task?: { id?: string } } | undefined)?.task?.id) ?? '';
    assert.ok(taskId);
    await waitFor(
      () => manager.getTaskDetail(taskId).currentState === 'completed',
      'the task never completed',
    );

    manager.purgeTaskBody(taskId);

    // CancelTask on the purged (terminal) task: the STANDARD not-cancelable
    // error — no custom states, no resurrection (fixture 08 family).
    const { client } = await officialClient(service.base);
    await assert.rejects(
      () => client.cancelTask({ id: taskId, tenant: '', metadata: undefined } as Parameters<typeof client.cancelTask>[0]),
      (error: unknown) => wireErrorReason(error) === 'TASK_NOT_CANCELABLE',
    );
    // GetTask returns the cleaned shell: terminal, no artifacts, no history.
    const shell = await client.getTask({ id: taskId, tenant: '' } as Parameters<typeof client.getTask>[0]);
    assert.equal(shell.id, taskId);
    assert.equal(shell.artifacts?.length ?? 0, 0);
    assert.equal(shell.history?.length ?? 0, 0);
    // A retried original message hits the tombstone: RESULT_PURGED, no re-run.
    const retry = await postRpc(service.base, sendBody(3, message));
    const retryError = retry.body['error'] as { code?: number; data?: { reason?: string }[] } | undefined;
    assert.equal(retryError?.code, -32000);
    assert.equal(retryError?.data?.[0]?.reason, 'RESULT_PURGED');
    assert.equal(manager.stats().executions, 1, 'the tombstone retry never re-executed');
  } finally {
    await stopA2aService(service);
  }
});

test('P2-1 (#89 r1): conflicting chunk redelivery + completion settles explicit FAILED — never a hang', async () => {
  const service = await startA2aService({
    config: testConfig({
      runtimeMode: 'dsh-worker',
      dshWorker: { ...TUNING, workerEnv: { LUMITHINK_A2A_WORKER_BEHAVIOR: 'conflict-output-then-complete' } },
    } as Parameters<typeof testConfig>[0]),
  });
  try {
    const manager = service.taskStore as SqliteTaskManager;
    void postRpc(service.base, sendBody(1, wireMessage('msg-conflict-1', '你好'))).catch(() => undefined);
    await waitFor(async () => {
      const listed = await manager.list({ pageSize: 10 } as unknown as Parameters<SqliteTaskManager['list']>[0]);
      return listed.tasks.length === 1;
    }, 'request never accepted');
    const listed = await manager.list({ pageSize: 10 } as unknown as Parameters<SqliteTaskManager['list']>[0]);
    const taskId = listed.tasks[0].id;
    await waitFor(
      () => ['failed', 'completed', 'canceled'].includes(manager.getTaskDetail(taskId).currentState),
      'the anomalous-fence completion hung instead of settling (P2-1 residual)',
    );
    assert.equal(manager.getTaskDetail(taskId).currentState, 'failed',
      'a completed-but-fenced task settles FAILED (review #106 r1 P2-1 closure)');
    const exec = soleExecution(manager, taskId);
    assert.equal(exec.result?.outcome, 'completed', 'the row records the TRUE worker outcome');
    assert.equal(exec.result?.fencedReason, 'chunk_content_mismatch');
    assert.equal(exec.result?.reason, undefined, 'P2-4: settle reason and fence reason stay separate');
    const snapshot = await manager.load(taskId);
    const text = (snapshot?.artifacts?.[0]?.parts ?? [])
      .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
      .join('');
    assert.ok(!text.includes('被篡改的重放'), 'the conflicting redelivery never became public body');
    const statusMessage = snapshot?.status?.message;
    const explanation = (statusMessage?.parts ?? [])
      .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
      .join('');
    assert.match(explanation, /协议异常被拒绝/);
  } finally {
    await stopA2aService(service);
  }
});

test('P2-2 (#89 r1): forced-stop evidence records the OBSERVED signal (SIGKILL), not just the kill dispatch', async () => {
  const runtime = new DshWorkerRuntime({
    ...TUNING,
    workerEntryPath: WORKER_ENTRY,
    workerEnv: { LUMITHINK_A2A_WORKER_BEHAVIOR: 'never-stops' },
  });
  try {
    const finalized = new Promise<{ signal: string | null; exitCode: number | null; killedByRuntime: boolean }>((resolve) => {
      runtime.startExecution(
        { taskId: 'task-kill-evidence', turnSeq: 1, epoch: 1, executionId: 'exec-kill-1', leaseId: 'lease-kill-1', inputText: 'x' },
        {
          onWorkerEvent: () => undefined,
          onFinalized: (evidence) => resolve({
            signal: evidence.signal,
            exitCode: evidence.exitCode,
            killedByRuntime: evidence.killedByRuntime,
          }),
        },
      );
    });
    // Wait for the session to be live, then cancel; the grace watchdog kills.
    await waitFor(() => runtime.sessionByTask('task-kill-evidence') !== undefined, 'session never started');
    await waitFor(() => runtime.sessionByTask('task-kill-evidence')?.state === 'running', 'worker never registered');
    runtime.cancelExecution('task-kill-evidence', 'cancel_requested');
    const evidence = await finalized;
    assert.equal(evidence.killedByRuntime, true);
    assert.equal(evidence.signal, 'SIGKILL', 'the death was OBSERVED, not merely dispatched');
    assert.equal(evidence.exitCode, null);
    assert.equal(runtime.sessionByTask('task-kill-evidence'), undefined, 'the session table is cleaned');
  } finally {
    await runtime.dispose();
  }
});

test('repeat-session guard negative (#87 P2-⑤ test anchoring): a second startExecution for a live taskId never spawns', async () => {
  const runtime = new DshWorkerRuntime({
    ...TUNING,
    workerEntryPath: WORKER_ENTRY,
    workerEnv: { LUMITHINK_A2A_WORKER_BEHAVIOR: 'never-stops' },
  });
  try {
    const firstFinalized = new Promise<string>((resolve) => {
      runtime.startExecution(
        { taskId: 'task-dup-session', turnSeq: 1, epoch: 1, executionId: 'exec-dup-1', leaseId: 'lease-dup-1', inputText: 'x' },
        {
          onWorkerEvent: () => undefined,
          onFinalized: (evidence, cause) => resolve(`${cause}:${evidence.killedByRuntime}`),
        },
      );
    });
    await waitFor(() => runtime.sessionByTask('task-dup-session') !== undefined, 'first session never started');
    // The DUPLICATE start: the guard must finalize it immediately (no second
    // spawn) while the FIRST session keeps owning the task.
    let secondSpawned: string | null = null;
    runtime.startExecution(
      { taskId: 'task-dup-session', turnSeq: 1, epoch: 1, executionId: 'exec-dup-2', leaseId: 'lease-dup-2', inputText: 'x' },
      {
        onWorkerEvent: () => undefined,
        onFinalized: (evidence, cause) => {
          secondSpawned = `${cause}:${evidence.killedByRuntime}`;
        },
      },
    );
    assert.equal(secondSpawned, 'protocol_violation:false',
      'the duplicate session finalizes immediately without spawning');
    const live = runtime.sessionByTask('task-dup-session');
    assert.ok(live, 'the FIRST session stays alive and owns the task');
    assert.equal(live.executionId, 'exec-dup-1');
    // The first session is never finalized by the duplicate attempt — its
    // finalize promise is still pending here (dispose owns its termination).
    assert.equal(
      await Promise.race([firstFinalized.then(() => 'settled'), new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 200))]),
      'pending',
      'the first session outlives the rejected duplicate start',
    );
  } finally {
    await runtime.dispose();
  }
});

test('#87 r1 P2-2: settleFromTaskState bookkeeping failures surface via onSettlementError and never mask the executor error', async () => {
  const mgr = new SqliteTaskManager({ dbPath: ':memory:' });
  try {
    const { taskId } = seedTask(mgr, 'settle-err-1');
    const reported: { phase: string; message: string }[] = [];
    const decorator = leaseDispatchExecutor({
      inner: {
        execute: async () => {
          mgr.close(); // the bookkeeping write below will fail loudly
          throw new Error('inner executor boom');
        },
        cancelTask: async () => undefined,
      },
      taskManager: mgr,
      leaseTtlMs: 60_000,
      onSettlementError: (error, context) => {
        reported.push({
          phase: context.phase,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });
    const { RequestContext, ServerCallContext } = await import('@a2a-js/sdk/server');
    const context = new ServerCallContext({ requestedVersion: '1.0' });
    const request = {
      message: userMessage('msg-settle-err-1', 'x'),
      configuration: undefined,
      metadata: undefined,
      tenant: '',
    };
    const bus = {
      publish: () => undefined,
      on: () => bus,
      off: () => bus,
      once: () => bus,
      removeAllListeners: () => bus,
      finished: () => undefined,
    };
    await assert.rejects(
      () => decorator.execute(new RequestContext(request as never, taskId, 'ctx-settle-err', context), bus as never),
      /inner executor boom/,
      'the executor error still propagates (never masked)',
    );
    assert.equal(reported.length, 1);
    assert.equal(reported[0]?.phase, 'executor_error');
    assert.ok(reported[0]?.message.length > 0, 'the bookkeeping failure text is carried');
  } finally {
    try {
      mgr.close();
    } catch {
      // already closed by the stub inner executor
    }
  }
});

test('schema v3: v2 databases re-migrate additively (purged_at_ms appears, data survives)', () => {
  const dir = tempDir('v2-to-v3');
  try {
    const dbPath = path.join(dir, 'tasks.sqlite3');
    const first = new SqliteTaskManager({ dbPath });
    const { taskId } = seedTask(first, 'v2-v3-1');
    first.close();

    // Rewind to a v2 shape: drop the v3 column, rewind the marker.
    const raw = new DatabaseSync(dbPath);
    raw.exec('ALTER TABLE a2a_tasks DROP COLUMN purged_at_ms');
    raw.prepare("UPDATE lumithink_a2a_meta SET value = '2' WHERE key = 'schema_version'").run();
    raw.close();

    const reopened = new SqliteTaskManager({ dbPath });
    try {
      assert.equal(reopened.schemaVersion, A2A_TASK_MANAGER_SCHEMA_VERSION);
      const probe = new DatabaseSync(dbPath);
      const columns = probe.prepare("PRAGMA table_info('a2a_tasks')").all() as { name: string }[];
      assert.ok(columns.some((column) => column.name === 'purged_at_ms'), 'v3 column restored');
      probe.close();
      assert.equal(reopened.getTaskDetail(taskId).currentState, 'submitted');
      // The migrated marker works: purge stamps it and the result is honest.
      const purged = reopened.purgeTaskBody(taskId);
      assert.equal(purged.outcome, 'purged');
      assert.equal(purged.alreadyPurged, false);
      const afterPurge = reopened.load(taskId);
      assert.ok(afterPurge, 'the purged shell is still readable');
    } finally {
      reopened.close();
    }
  } finally {
    removeTempDir(dir);
  }
});









