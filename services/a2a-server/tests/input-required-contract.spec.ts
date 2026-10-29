/**
 * INPUT_REQUIRED / AUTH_REQUIRED server-level contract tests (P1-13, issue #124).
 *
 * Authority: docs/TASK_LIFECYCLE.md §3 (A2A 状态机 — waiting states and their
 * transitions), §5.2 (同一未完成 Task 的补充输入：新 messageId 独立去重后关联
 * 原 Task) and §9 (重启恢复：INPUT_REQUIRED / AUTH_REQUIRED 在有效期限内保留
 * 等待；到期/无效则失败).
 *
 * Issue #124 decision (docs/reviews/2026-10-30-p1-13-input-required-decision.md):
 * the P1/P2 phase has NO request-path producer for INPUT_REQUIRED/AUTH_REQUIRED
 * (`appendTurn` has zero callers outside its definition and its repository-level
 * tests; no executor emits the states), so the admission-gate wiring is DEFERRED
 * until the first real production scenario. 无生产者 ≠ 无契约: this spec pins
 * the SERVER-LEVEL composition contract of both waiting states on the single
 * authoritative write path (SqliteTaskManager, ADR-0013) — construction with
 * execution attribution, supplementary input / authorization verification,
 * waiting-expiry failure (runtime transition AND startup-recovery settlement),
 * cancellation, conditional-update discipline, terminal irreversibility and the
 * SDK-snapshot-bridge guards. The unit-level transition table is already pinned
 * by task-manager-state-machine.spec.ts; this file adds the composed, persisted
 * evidence.
 *
 * All data is synthetic; every database is ':memory:'. Zero skips by design.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { TaskState, type Task } from '@a2a-js/sdk';
import { TaskManagerError } from '../src/task-manager/errors.ts';
import {
  SqliteTaskManager,
  type ExecutionRef,
} from '../src/task-manager/sqlite-task-manager.ts';
import { userMessage } from './helpers.ts';

/**
 * Rebuilds a loaded snapshot with a new wire state. TaskStatus carries
 * required-but-nullable keys (message/timestamp), so the status object is
 * reconstructed explicitly instead of spread (a spread would demote them to
 * optional keys and fail the SDK's Task typing).
 */
function withWireState(task: Task, state: TaskState): Task {
  assert.ok(task.status, 'loaded snapshots always carry a status');
  return {
    ...task,
    status: {
      state,
      message: task.status.message,
      timestamp: task.status.timestamp,
    },
  };
}

function newManager(options: { dbPath?: string; now?: () => number } = {}): SqliteTaskManager {
  return new SqliteTaskManager({
    dbPath: options.dbPath ?? ':memory:',
    now: options.now,
  });
}

function accept(
  mgr: SqliteTaskManager,
  key: string,
  text = '查一下这周的练习完成情况',
): { taskId: string; contextId: string } {
  const result = mgr.acceptInput({
    requestKey: key,
    fingerprint: `fp-${key}`,
    messageId: `msg-${key}`,
    inputMessage: userMessage(`msg-${key}`, text),
  });
  assert.equal(result.outcome, 'created');
  if (result.outcome !== 'created') throw new Error('unreachable');
  return { taskId: result.taskId, contextId: result.contextId };
}

/**
 * Drives a fresh task through the authoritative path to a WAITING state
 * (submitted → working → input_required|auth_required) with full execution
 * attribution. Returns the observed state version so tests compose further
 * conditional updates from exact facts.
 */
function constructWaiting(
  mgr: SqliteTaskManager,
  key: string,
  waiting: 'input_required' | 'auth_required',
  ids: { executionId: string; leaseId: string; leaseExpiresAtMs?: number },
): { taskId: string; stateVersion: number } {
  const { taskId } = accept(mgr, key);
  const claim = mgr.claimExecution({
    taskId,
    executionId: ids.executionId,
    leaseId: ids.leaseId,
    leaseExpiresAtMs: ids.leaseExpiresAtMs,
  });
  assert.equal(claim.outcome, 'claimed');
  if (claim.outcome !== 'claimed') throw new Error('unreachable');
  const ref: ExecutionRef = {
    executionId: ids.executionId,
    turnSeq: 1,
    epoch: 1,
    leaseId: ids.leaseId,
  };
  const moved = mgr.transitionTask({
    taskId,
    expectedState: 'working',
    expectedStateVersion: claim.stateVersion,
    nextState: waiting,
    reason: 'awaiting_structured_followup',
    execution: ref,
  });
  assert.equal(moved.outcome, 'committed');
  if (moved.outcome !== 'committed') throw new Error('unreachable');
  assert.equal(moved.currentState, waiting);
  return { taskId, stateVersion: moved.stateVersion };
}

// ---------------------------------------------------------------------------
// Construction of the waiting states (§3: WORKING → INPUT_REQUIRED / AUTH_REQUIRED)
// ---------------------------------------------------------------------------

test('working → input_required commits with execution attribution and exposes TASK_STATE_INPUT_REQUIRED on load()', async () => {
  const mgr = newManager();
  try {
    const { taskId } = accept(mgr, 'ir-construct');
    const claim = mgr.claimExecution({
      taskId,
      executionId: 'exec-ir-1',
      leaseId: 'lease-ir-1',
    });
    assert.equal(claim.outcome, 'claimed');
    if (claim.outcome !== 'claimed') throw new Error('unreachable');
    assert.equal(claim.stateVersion, 2, 'accept=1, dispatch claim=2');

    const moved = mgr.transitionTask({
      taskId,
      expectedState: 'working',
      expectedStateVersion: claim.stateVersion,
      nextState: 'input_required',
      reason: 'awaiting_structured_followup',
      execution: { executionId: 'exec-ir-1', turnSeq: 1, epoch: 1, leaseId: 'lease-ir-1' },
    });
    assert.equal(moved.outcome, 'committed');
    if (moved.outcome !== 'committed') throw new Error('unreachable');
    assert.equal(moved.currentState, 'input_required');
    assert.equal(moved.stateVersion, 3);

    // Wire format: the persisted row surfaces as the standard A2A state.
    const snapshot = await mgr.load(taskId);
    assert.equal(snapshot?.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);

    // The transition is an Outbox statusUpdate carrying from/to/reason and the
    // verified execution attribution (§4.2: 状态转换事务).
    const outbox = mgr.readOutbox(taskId);
    const last = outbox[outbox.length - 1];
    assert.equal(last.kind, 'statusUpdate');
    assert.equal(last.payload['from'], 'working');
    assert.equal(last.payload['to'], 'input_required');
    assert.equal(last.payload['reason'], 'awaiting_structured_followup');
    assert.equal(last.payload['executionId'], 'exec-ir-1');
    assert.equal(last.payload['turnSeq'], 1);
    assert.equal(last.payload['epoch'], 1);
  } finally {
    mgr.close();
  }
});

test('working → auth_required commits the same way; attribution guards are fail-closed (§4.2)', async () => {
  // Injectable clock so the lease-expiry guard is exercised deterministically.
  const clock = { nowMs: 1_000_000 };
  const mgr = newManager({ now: () => clock.nowMs });
  try {
    const { taskId, stateVersion } = constructWaiting(mgr, 'ar-construct', 'auth_required', {
      executionId: 'exec-ar-1',
      leaseId: 'lease-ar-1',
      leaseExpiresAtMs: 1_000_000 + 1_000,
    });
    assert.equal(stateVersion, 3);
    const snapshot = await mgr.load(taskId);
    assert.equal(snapshot?.status?.state, TaskState.TASK_STATE_AUTH_REQUIRED);

    // A wrong lease is an attribution failure, not a pass (lease-holder rule).
    assert.throws(
      () =>
        mgr.transitionTask({
          taskId,
          expectedState: 'auth_required',
          expectedStateVersion: stateVersion,
          nextState: 'working',
          reason: 'supplementary_input_accepted',
          execution: { executionId: 'exec-ar-1', turnSeq: 1, epoch: 1, leaseId: 'WRONG' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof TaskManagerError);
        assert.equal(error.code, 'execution_attribution');
        return true;
      },
    );

    // A fabricated execution id cannot drive the transition either.
    assert.throws(
      () =>
        mgr.transitionTask({
          taskId,
          expectedState: 'auth_required',
          expectedStateVersion: stateVersion,
          nextState: 'working',
          reason: 'supplementary_input_accepted',
          execution: { executionId: 'exec-fabricated', turnSeq: 1, epoch: 1, leaseId: 'lease-ar-1' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof TaskManagerError);
        assert.equal(error.code, 'execution_attribution');
        return true;
      },
    );

    // An expired lease cannot drive the transition (等待时间有上限 — the same
    // bounded-lease rule guards callbacks into/out of the waiting states).
    clock.nowMs += 5_000;
    assert.throws(
      () =>
        mgr.transitionTask({
          taskId,
          expectedState: 'auth_required',
          expectedStateVersion: stateVersion,
          nextState: 'working',
          reason: 'supplementary_input_accepted',
          execution: { executionId: 'exec-ar-1', turnSeq: 1, epoch: 1, leaseId: 'lease-ar-1' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof TaskManagerError);
        assert.equal(error.code, 'execution_attribution');
        return true;
      },
    );

    // All three failures left the authoritative row untouched.
    const detail = mgr.getTaskDetail(taskId);
    assert.equal(detail.currentState, 'auth_required');
    assert.equal(detail.stateVersion, stateVersion);
  } finally {
    mgr.close();
  }
});

// ---------------------------------------------------------------------------
// Supplementary input on a waiting task (§5.2: 新 messageId 独立去重后关联原 Task)
// ---------------------------------------------------------------------------

test('supplementary input on an input_required task appends the next turn, then INPUT_REQUIRED → WORKING commits (合法补充输入)', async () => {
  const mgr = newManager();
  try {
    const { taskId } = constructWaiting(mgr, 'ir-supplement', 'input_required', {
      executionId: 'exec-ir-2',
      leaseId: 'lease-ir-2',
    });
    const before = mgr.getTaskDetail(taskId);
    assert.equal(before.stateVersion, 3);

    // New messageId/requestKey → independent dedupe bound to the SAME task.
    const appended = mgr.appendTurn({
      taskId,
      requestKey: 'ir-supplement-followup',
      fingerprint: 'fp-ir-supplement-followup',
      inputMessage: userMessage('msg-ir-followup', '补充：只要数学的'),
    });
    assert.equal(appended.outcome, 'created');
    if (appended.outcome !== 'created') throw new Error('unreachable');
    assert.equal(appended.turnSeq, 2);
    assert.equal(appended.epoch, 2);
    assert.equal(mgr.getTaskDetail(taskId).turns.length, 2);
    assert.equal(mgr.stats().ledger, 2, 'supplementary input gets its own ledger row');
    assert.equal(
      before.stateVersion,
      mgr.getTaskDetail(taskId).stateVersion,
      'appendTurn creates a turn, it does not bump the state version',
    );
    const outbox = mgr.readOutbox(taskId);
    const turnAccepted = outbox.find((event) => event.kind === 'turnAccepted');
    assert.ok(turnAccepted, 'turnAccepted event is committed with the turn');
    assert.equal(turnAccepted.payload['messageId'], 'msg-ir-followup');
    assert.equal(turnAccepted.payload['turnSeq'], 2);

    // 合法补充输入: INPUT_REQUIRED → WORKING through the conditional update.
    // (The follow-up dispatch lease wiring is the deferred #124 "接线" scope;
    // the repository-level state contract is what is pinned here.)
    const resumed = mgr.transitionTask({
      taskId,
      expectedState: 'input_required',
      expectedStateVersion: 3,
      nextState: 'working',
      reason: 'supplementary_input_accepted',
    });
    assert.equal(resumed.outcome, 'committed');
    if (resumed.outcome !== 'committed') throw new Error('unreachable');
    assert.equal(resumed.currentState, 'working');
    assert.equal(resumed.stateVersion, 4);
    const snapshot = await mgr.load(taskId);
    assert.equal(snapshot?.status?.state, TaskState.TASK_STATE_WORKING);

    // Independent dedupe: the SAME supplementary key with the SAME fingerprint
    // resolves to the original task (duplicate), never a second task.
    const redelivery = mgr.acceptInput({
      requestKey: 'ir-supplement-followup',
      fingerprint: 'fp-ir-supplement-followup',
      messageId: 'msg-ir-followup',
      inputMessage: userMessage('msg-ir-followup', '补充：只要数学的'),
    });
    assert.equal(redelivery.outcome, 'duplicate');
    if (redelivery.outcome !== 'duplicate') throw new Error('unreachable');
    assert.equal(redelivery.taskId, taskId);
    assert.equal(redelivery.currentState, 'working');

    // Same key with a DIFFERENT fingerprint is the stable conflict error.
    assert.throws(
      () =>
        mgr.acceptInput({
          requestKey: 'ir-supplement-followup',
          fingerprint: 'fp-different',
          messageId: 'msg-ir-followup',
          inputMessage: userMessage('msg-ir-followup', '不同的请求'),
        }),
      (error: unknown) => {
        assert.ok(error instanceof TaskManagerError);
        assert.equal(error.code, 'message_id_conflict');
        return true;
      },
    );

    // Reusing the supplementary requestKey in appendTurn is rejected.
    const replay = mgr.appendTurn({
      taskId,
      requestKey: 'ir-supplement-followup',
      fingerprint: 'fp-ir-supplement-followup',
      inputMessage: userMessage('msg-ir-followup', '重复的补充输入'),
    });
    assert.equal(replay.outcome, 'rejected');
    if (replay.outcome !== 'rejected') throw new Error('unreachable');
    assert.equal(replay.reason, 'message_id_conflict');
  } finally {
    mgr.close();
  }
});

// ---------------------------------------------------------------------------
// Conditional-update discipline on the waiting states (§4.2)
// ---------------------------------------------------------------------------

test('waiting-state transitions are conditional updates: stale observations never commit, races have exactly one winner', async () => {
  const mgr = newManager();
  try {
    const { taskId } = constructWaiting(mgr, 'ir-casu', 'input_required', {
      executionId: 'exec-ir-3',
      leaseId: 'lease-ir-3',
    });

    // Wrong expected state → stale with fresh facts, no version bump.
    const wrongState = mgr.transitionTask({
      taskId,
      expectedState: 'working',
      expectedStateVersion: 3,
      nextState: 'failed',
      reason: 'input_wait_expired',
    });
    assert.equal(wrongState.outcome, 'stale');
    if (wrongState.outcome !== 'stale') throw new Error('unreachable');
    assert.equal(wrongState.currentState, 'input_required');
    assert.equal(wrongState.stateVersion, 3);

    // Wrong expected version → stale too.
    const wrongVersion = mgr.transitionTask({
      taskId,
      expectedState: 'input_required',
      expectedStateVersion: 2,
      nextState: 'failed',
      reason: 'input_wait_expired',
    });
    assert.equal(wrongVersion.outcome, 'stale');

    // Race from the same (state, version): the first writer commits, the
    // loser observes fresh state and must re-decide (§4.2).
    const winner = mgr.transitionTask({
      taskId,
      expectedState: 'input_required',
      expectedStateVersion: 3,
      nextState: 'working',
      reason: 'supplementary_input_accepted',
    });
    const loser = mgr.transitionTask({
      taskId,
      expectedState: 'input_required',
      expectedStateVersion: 3,
      nextState: 'failed',
      reason: 'input_wait_expired',
    });
    assert.equal(winner.outcome, 'committed');
    assert.equal(loser.outcome, 'stale');
    if (loser.outcome !== 'stale') throw new Error('unreachable');
    assert.equal(loser.currentState, 'working');
    assert.equal(loser.stateVersion, 4);
  } finally {
    mgr.close();
  }
});

// ---------------------------------------------------------------------------
// Waiting-expiry failure (§3: INPUT_REQUIRED / AUTH_REQUIRED → FAILED 等待到期)
// ---------------------------------------------------------------------------

test('waiting-expiry failure settles INPUT_REQUIRED → FAILED through the runtime transition and AUTH_REQUIRED → FAILED through the recovery settlement (§9)', async () => {
  const mgr = newManager();
  try {
    // Runtime path: the Task-Manager decision layer submits the expiry as a
    // conditional transition with a stable reason code.
    const ir = constructWaiting(mgr, 'ir-expiry', 'input_required', {
      executionId: 'exec-ir-4',
      leaseId: 'lease-ir-4',
    });
    const expired = mgr.transitionTask({
      taskId: ir.taskId,
      expectedState: 'input_required',
      expectedStateVersion: ir.stateVersion,
      nextState: 'failed',
      reason: 'input_wait_expired',
    });
    assert.equal(expired.outcome, 'committed');
    if (expired.outcome !== 'committed') throw new Error('unreachable');
    assert.equal(expired.currentState, 'failed');
    const irDetail = mgr.getTaskDetail(ir.taskId);
    assert.equal(irDetail.currentState, 'failed');
    assert.ok(irDetail.terminalAtMs !== null, 'terminal settlement is stamped');
    const irSnapshot = await mgr.load(ir.taskId);
    assert.equal(irSnapshot?.status?.state, TaskState.TASK_STATE_FAILED);

    // Recovery path (§9: 主体、权限或上下文无效则失败 / 等待到期): the startup
    // scanner settles through the SAME conditional-update discipline.
    const ar = constructWaiting(mgr, 'ar-expiry', 'auth_required', {
      executionId: 'exec-ar-4',
      leaseId: 'lease-ar-4',
    });
    const recovered = mgr.settleRecoveredTask({
      taskId: ar.taskId,
      expectedState: 'auth_required',
      expectedStateVersion: ar.stateVersion,
      nextState: 'failed',
      reason: 'auth_wait_expired',
    });
    assert.equal(recovered.outcome, 'committed');
    if (recovered.outcome !== 'committed') throw new Error('unreachable');
    assert.equal(recovered.currentState, 'failed');
    const arOutbox = mgr.readOutbox(ar.taskId);
    const recoveryEvent = arOutbox[arOutbox.length - 1];
    assert.equal(recoveryEvent.kind, 'statusUpdate');
    assert.equal(recoveryEvent.payload['source'], 'startup-recovery');
    assert.equal(recoveryEvent.payload['to'], 'failed');
    const arSnapshot = await mgr.load(ar.taskId);
    assert.equal(arSnapshot?.status?.state, TaskState.TASK_STATE_FAILED);

    // Waiting states may NOT shortcut to COMPLETED or morph into each other.
    const shortcut = constructWaiting(mgr, 'ir-shortcut', 'input_required', {
      executionId: 'exec-ir-5',
      leaseId: 'lease-ir-5',
    });
    for (const illegal of ['completed', 'auth_required', 'submitted'] as const) {
      assert.throws(
        () =>
          mgr.transitionTask({
            taskId: shortcut.taskId,
            expectedState: 'input_required',
            expectedStateVersion: shortcut.stateVersion,
            nextState: illegal,
            reason: 'contract-negative',
          }),
        (error: unknown) => {
          assert.ok(error instanceof TaskManagerError);
          assert.equal(error.code, 'illegal_transition');
          return true;
        },
        `input_required → ${illegal} must be illegal`,
      );
    }
  } finally {
    mgr.close();
  }
});

test('after waiting-expiry failure the task is irreversible: no late turn, no late body, no re-open (§1.4/§3)', async () => {
  const mgr = newManager();
  try {
    const { taskId, stateVersion } = constructWaiting(mgr, 'ir-irreversible', 'input_required', {
      executionId: 'exec-ir-6',
      leaseId: 'lease-ir-6',
    });
    assert.equal(
      mgr.transitionTask({
        taskId,
        expectedState: 'input_required',
        expectedStateVersion: stateVersion,
        nextState: 'failed',
        reason: 'input_wait_expired',
      }).outcome,
      'committed',
    );

    // Terminal state has NO outgoing transitions — even the most tempting
    // "the user finally answered" move is rejected loudly.
    assert.throws(
      () =>
        mgr.transitionTask({
          taskId,
          expectedState: 'failed',
          expectedStateVersion: stateVersion + 1,
          nextState: 'working',
          reason: 'late_answer',
        }),
      (error: unknown) => {
        assert.ok(error instanceof TaskManagerError);
        assert.equal(error.code, 'illegal_transition');
        return true;
      },
    );

    // Late supplementary input is rejected, not absorbed.
    const lateTurn = mgr.appendTurn({
      taskId,
      requestKey: 'ir-irreversible-late',
      fingerprint: 'fp-irreversible-late',
      inputMessage: userMessage('msg-ir-late', '太迟的补充'),
    });
    assert.equal(lateTurn.outcome, 'rejected');
    if (lateTurn.outcome !== 'rejected') throw new Error('unreachable');
    assert.equal(lateTurn.reason, 'task_terminal');

    // Late body admission on the original execution is rejected.
    const lateBody = mgr.admitChunk({
      taskId,
      executionId: 'exec-ir-6',
      turnSeq: 1,
      epoch: 1,
      leaseId: 'lease-ir-6',
      artifactId: 'answer-ir',
      text: '迟到的正文',
    });
    assert.equal(lateBody.outcome, 'rejected');
    if (lateBody.outcome !== 'rejected') throw new Error('unreachable');
    assert.equal(lateBody.reason, 'task_terminal');

    // The original request's idempotent redelivery reads the FAILED snapshot
    // and never re-opens the run (§5.2: 任务已终结 → 返回原任务快照，不重开).
    const redelivery = mgr.acceptInput({
      requestKey: 'ir-irreversible',
      fingerprint: 'fp-ir-irreversible',
      messageId: 'msg-ir-irreversible',
      inputMessage: userMessage('msg-ir-irreversible', '原请求重试'),
    });
    assert.equal(redelivery.outcome, 'duplicate');
    if (redelivery.outcome !== 'duplicate') throw new Error('unreachable');
    assert.equal(redelivery.taskId, taskId);
    assert.equal(redelivery.currentState, 'failed');

    // Cancelling a terminal task is a no-op observation (重复取消无新副作用).
    assert.equal(mgr.recordCancelIntent({ taskId, reason: 'late_cancel' }).outcome, 'already-terminal');
  } finally {
    mgr.close();
  }
});

// ---------------------------------------------------------------------------
// Cancellation from the waiting states (§3: → CANCELED 确认取消; §7.1)
// ---------------------------------------------------------------------------

test('cancellation from a waiting state closes output admission first, then settles CANCELED; duplicate cancels stay no-ops', async () => {
  const mgr = newManager();
  try {
    const { taskId, stateVersion } = constructWaiting(mgr, 'ir-cancel', 'input_required', {
      executionId: 'exec-ir-7',
      leaseId: 'lease-ir-7',
    });

    // Cancel intent (§7.1 step 3) closes the open turns' body admission and
    // emits the cancel command — BEFORE the state settles.
    const intent = mgr.recordCancelIntent({ taskId, reason: 'user_cancelled_waiting' });
    assert.equal(intent.outcome, 'recorded');
    assert.equal(intent.currentState, 'input_required');
    assert.equal(mgr.getTaskDetail(taskId).cancelIntent, true);
    assert.equal(mgr.getTaskDetail(taskId).turns[0].outputAdmission, 'closed');
    const outbox = mgr.readOutbox(taskId);
    assert.equal(outbox[outbox.length - 1].kind, 'cancelCommand');

    // Body admission is closed while the task still waits (non-terminal).
    const blockedBody = mgr.admitChunk({
      taskId,
      executionId: 'exec-ir-7',
      turnSeq: 1,
      epoch: 1,
      leaseId: 'lease-ir-7',
      artifactId: 'answer-ir-cancel',
      text: '取消后的正文',
    });
    assert.equal(blockedBody.outcome, 'rejected');
    if (blockedBody.outcome !== 'rejected') throw new Error('unreachable');
    assert.equal(blockedBody.reason, 'output_admission_closed');

    // The conditional update settles CANCELED from the waiting state.
    const settled = mgr.transitionTask({
      taskId,
      expectedState: 'input_required',
      expectedStateVersion: stateVersion,
      nextState: 'canceled',
      reason: 'cancel_confirmed_waiting',
    });
    assert.equal(settled.outcome, 'committed');
    if (settled.outcome !== 'committed') throw new Error('unreachable');
    const snapshot = await mgr.load(taskId);
    assert.equal(snapshot?.status?.state, TaskState.TASK_STATE_CANCELED);

    // Duplicate cancel intent after the terminal settlement: no new side effect.
    assert.equal(mgr.recordCancelIntent({ taskId, reason: 'duplicate' }).outcome, 'already-terminal');

    // AUTH_REQUIRED → CANCELED is the same confirmed-cancel contract.
    const ar = constructWaiting(mgr, 'ar-cancel', 'auth_required', {
      executionId: 'exec-ar-7',
      leaseId: 'lease-ar-7',
    });
    assert.equal(
      mgr.transitionTask({
        taskId: ar.taskId,
        expectedState: 'auth_required',
        expectedStateVersion: ar.stateVersion,
        nextState: 'canceled',
        reason: 'cancel_confirmed_waiting',
      }).outcome,
      'committed',
    );
    const arSnapshot = await mgr.load(ar.taskId);
    assert.equal(arSnapshot?.status?.state, TaskState.TASK_STATE_CANCELED);
  } finally {
    mgr.close();
  }
});

// ---------------------------------------------------------------------------
// Restart recovery (§9: INPUT_REQUIRED / AUTH_REQUIRED 在有效期限内保留等待)
// ---------------------------------------------------------------------------

test('recovery scan keeps waiting tasks non-terminal within their validity; they are never mistaken for interrupted executions', async () => {
  const mgr = newManager();
  try {
    const ir = constructWaiting(mgr, 'ir-recovery', 'input_required', {
      executionId: 'exec-ir-8',
      leaseId: 'lease-ir-8',
    });
    const ar = constructWaiting(mgr, 'ar-recovery', 'auth_required', {
      executionId: 'exec-ar-8',
      leaseId: 'lease-ar-8',
    });

    const view = mgr.recoveryScanView();
    const waiting = view.nonTerminalTasks.filter(
      (task) => task.taskId === ir.taskId || task.taskId === ar.taskId,
    );
    assert.equal(waiting.length, 2, 'both waiting tasks appear in the non-terminal scan');
    for (const task of waiting) {
      assert.ok(
        task.currentState === 'input_required' || task.currentState === 'auth_required',
        'the scan preserves the exact waiting state',
      );
      assert.equal(task.cancelIntent, false);
      assert.equal(task.latestTurnAdmission, 'open');
    }
    assert.equal(
      view.terminalTasksWithActiveExecutions.length,
      0,
      'waiting tasks are not misread as terminal-with-active-execution',
    );

    // A terminal task disappears from the non-terminal scan after expiry.
    assert.equal(
      mgr.transitionTask({
        taskId: ir.taskId,
        expectedState: 'input_required',
        expectedStateVersion: ir.stateVersion,
        nextState: 'failed',
        reason: 'input_wait_expired',
      }).outcome,
      'committed',
    );
    const after = mgr.recoveryScanView();
    assert.equal(
      after.nonTerminalTasks.some((task) => task.taskId === ir.taskId),
      false,
      'expired waiting task left the non-terminal scan',
    );
    assert.ok(
      after.nonTerminalTasks.some((task) => task.taskId === ar.taskId),
      'still-valid waiting task keeps waiting',
    );
  } finally {
    mgr.close();
  }
});

// ---------------------------------------------------------------------------
// SDK-snapshot bridge (the only producer-shaped entry that exists today)
// ---------------------------------------------------------------------------

test('snapshot bridge: a legal working→input_required snapshot commits; an illegal terminal jump is discarded and the authoritative row wins', async () => {
  const mgr = newManager();
  try {
    // The LEGAL producer shape: the SDK handler's executor could report
    // INPUT_REQUIRED through its snapshot; the bridge applies exactly the
    // frozen transition table. (No request-path executor does so today —
    // that producer is the deferred #124 wiring.)
    const legal = accept(mgr, 'ir-bridge-legal');
    const legalClaim = mgr.claimExecution({
      taskId: legal.taskId,
      executionId: 'exec-ir-9',
      leaseId: 'lease-ir-9',
    });
    assert.equal(legalClaim.outcome, 'claimed');
    const workingSnapshot = await mgr.load(legal.taskId);
    assert.ok(workingSnapshot);
    const promoted = withWireState(workingSnapshot, TaskState.TASK_STATE_INPUT_REQUIRED);
    await mgr.save(promoted);
    const promotedDetail = mgr.getTaskDetail(legal.taskId);
    assert.equal(promotedDetail.currentState, 'input_required');
    assert.equal(
      promotedDetail.stateVersion,
      (legalClaim.outcome === 'claimed' ? legalClaim.stateVersion : 0) + 1,
      'the legal snapshot move bumps the version exactly once',
    );
    const promotedSnapshot = await mgr.load(legal.taskId);
    assert.equal(promotedSnapshot?.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);

    // The ILLEGAL shape: from the waiting state, a snapshot claiming COMPLETED
    // is discarded — the authoritative row wins, no version bump (§1.4/§3).
    const { taskId } = constructWaiting(mgr, 'ir-bridge-illegal', 'input_required', {
      executionId: 'exec-ir-10',
      leaseId: 'lease-ir-10',
    });
    const before = mgr.getTaskDetail(taskId);
    const stale = await mgr.load(taskId);
    assert.ok(stale);
    await mgr.save(withWireState(stale, TaskState.TASK_STATE_COMPLETED));
    const after = mgr.getTaskDetail(taskId);
    assert.equal(after.currentState, 'input_required', 'illegal snapshot move is discarded');
    assert.equal(after.stateVersion, before.stateVersion, 'no version bump on a discarded snapshot');

    // And a terminal row ignores snapshots entirely (终态不可逆, bridge-level).
    assert.equal(
      mgr.transitionTask({
        taskId,
        expectedState: 'input_required',
        expectedStateVersion: after.stateVersion,
        nextState: 'failed',
        reason: 'input_wait_expired',
      }).outcome,
      'committed',
    );
    const failedSnapshot = await mgr.load(taskId);
    assert.ok(failedSnapshot);
    await mgr.save(withWireState(failedSnapshot, TaskState.TASK_STATE_WORKING));
    const finalDetail = mgr.getTaskDetail(taskId);
    assert.equal(finalDetail.currentState, 'failed', 'terminal row never re-opens from a snapshot');
  } finally {
    mgr.close();
  }
});
