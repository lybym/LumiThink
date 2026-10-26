/**
 * Startup recovery scan (P1-08, issue #90; TASK_LIFECYCLE §9 重启恢复,
 * A2A_DESIGN §8.4/§11.3, ADR-0016 'abandoned' reservation).
 *
 * 首期优先保证状态真实和不重复执行，不承诺自动续跑所有中断任务。The scan
 * re-decides EVERY persisted non-terminal state from persisted facts only —
 * the previous process's in-memory session/lease/watchdog state is gone:
 *
 * | persisted state at startup                        | recovery (§9)                                      |
 * | ------------------------------------------------- | -------------------------------------------------- |
 * | submitted, no execution row, cancel intent        | CANCELED (取消且确认未派发, §7.1.4)                 |
 * | submitted, no execution row, no cancel intent     | confirmed never started → RE-DISPATCH (重新领取租约；|
 * |                                                   | the dispatch path re-checks cancel/auth/quota)      |
 * | active execution row (registered/running/         | outcome UNKNOWN → row 'abandoned', public FAILED,   |
 * | stop_requested), ± cancel intent                  | NEVER re-dispatched (不重复执行未知副作用)          |
 * | all execution rows settled, public still open     | re-derive the public terminal from the settled      |
 * |                                                   | evidence (完成竞争如实结算 — crash between the      |
 * |                                                   | public publish and the row close, or vice versa)    |
 * | input_required / auth_required, no execution row  | keep waiting (在有效期限内保留等待)                 |
 * | terminal                                          | untouched (保持不变)                                |
 * | un-published Outbox rows                          | reported; rows stay intact for replay with stable   |
 * |                                                   | ids (重发已提交且仍获准的事件；片段 ID 不改变)      |
 *
 * The execution rows the scan abandons carry body-free evidence
 * {outcome:'abandoned', reason}; 'abandoned' is the state ADR-0016 reserved
 * for exactly this scanner, and admitChunk/settleExecution reject later
 * callbacks against it (no late resurrection, no re-execution).
 *
 * Additional startup duties wired here (Issue #90):
 *   - deletion-ledger replay FIRST (独立删除台账：恢复时先重放删除，已删
 *     数据不能复活 — a restored old snapshot is cleaned before anything
 *     else runs);
 *   - crash-window orphan task bindings released (review #103 r1 P2-1
 *     convergence completion: bindings written before the task row
 *     committed — harmless by design, cleaned here once per start).
 *
 * The requeue hook is INJECTED: the recovery module never spawns workers
 * itself; the composition wires the real dispatch-lease executor so a
 * re-claimed task passes the SAME quota → claim → authorization → worker
 * sequence as any request-path dispatch (§9: 再次检查取消、授权和资源配额).
 *
 * SYNTHETIC data only (P1 口径).
 */
import { randomUUID } from 'node:crypto';
import { Role, type Message } from '@a2a-js/sdk';
import type { SqliteTaskManager, ExecutionSettlement, RecoveryScanView } from '../task-manager/sqlite-task-manager.ts';
import { isLegalTaskTransition, isTerminalTaskState, type A2aTaskState } from '../task-manager/state-machine.ts';
import type { IdentityStore } from '../identity/identity-store.ts';
import { DeletionLedger } from './deletion-ledger.ts';

export interface StartupRecoveryOptions {
  taskManager: SqliteTaskManager;
  /** When present: crash-window orphan task bindings are released. */
  identity?: IdentityStore;
  /** When present: recorded deletions are replayed BEFORE any recovery move. */
  ledger?: DeletionLedger;
  /**
   * Re-dispatch hook for CONFIRMED-never-started tasks (submitted, no
   * execution row, no cancel intent). The implementation MUST route through
   * the full dispatch-lease path. Sequential; awaited.
   */
  requeue?: (taskId: string, inputMessage: Message) => Promise<void>;
}

export interface StartupRecoveryReport {
  ledgerReplay: {
    reapplied: number;
    alreadyPurged: number;
    missingTaskIds: string[];
  } | null;
  orphanBindingsReleased: string[];
  abandonedExecutions: {
    taskId: string;
    executionId: string;
    priorState: string;
  }[];
  settledTasks: {
    taskId: string;
    from: A2aTaskState;
    to: A2aTaskState;
    basis:
      | 'interrupted'
      | 'stop_unconfirmed'
      | 'undispatched_cancel'
      | 'execution_evidence'
      | 'fenced_anomaly';
    reason: string;
  }[];
  /** Confirmed-never-started tasks (always reported, re-dispatched or not). */
  reclaimableTaskIds: string[];
  requeuedTaskIds: string[];
  requeueFailures: { taskId: string; error: string }[];
  unpublishedOutboxTaskIds: string[];
}

/** Readable agent status message for a recovered settlement. */
function recoveredStatusMessage(
  contextId: string,
  taskId: string,
  text: string,
): Message {
  return {
    messageId: `recovery-${randomUUID()}`,
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [
      {
        content: { $case: 'text', value: text },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

const ACTIVE_EXECUTION_STATES = new Set(['registered', 'running', 'stop_requested']);

/**
 * Re-derives the public terminal settlement from ONE settled execution
 * row's body-free evidence (完成竞争如实结算; review #106 r1 P2-1/P2-4
 * semantics mirrored at recovery time: the fence reason lives in
 * `fencedReason` and an anomaly-fenced completion settles FAILED, while a
 * cancel-suppressed completion settles COMPLETED with the fixture-04 flags).
 */
function publicSettlementFromEvidence(
  task: RecoveryScanView['nonTerminalTasks'][number],
  evidence: ExecutionSettlement,
): {
  nextState: A2aTaskState;
  basis: 'execution_evidence' | 'fenced_anomaly' | 'interrupted';
  reason: string;
  statusMessage?: string;
  metadata?: Record<string, unknown>;
} {
  if (evidence.outcome === 'completed') {
    if (
      evidence.fencedReason !== undefined &&
      evidence.fencedReason !== 'output_admission_closed'
    ) {
      // Anomaly-fenced completion (P2-1 closure): the worker reported done,
      // but its output hit a protocol fence — the answer cannot be vouched
      // for, so the honest public terminal is FAILED (never a hanging
      // working task, never a fabricated full answer).
      return {
        nextState: 'failed',
        basis: 'fenced_anomaly',
        reason: `output_anomaly_fenced:${evidence.fencedReason}`,
        statusMessage: '执行已完成，但其输出因协议异常被拒绝，任务按失败结算。',
      };
    }
    const suppressed =
      task.cancelIntent && task.latestTurnAdmission === 'closed';
    return {
      nextState: 'completed',
      basis: 'execution_evidence',
      reason: 'recovered_from_execution_evidence',
      statusMessage: suppressed ? '执行已完成，后续输出因取消被抑制。' : undefined,
      metadata: {
        lumithinkResult: {
          version: 1,
          outputSuppressedAfterCancel: suppressed,
          answerComplete: !suppressed,
        },
      },
    };
  }
  if (evidence.outcome === 'canceled') {
    return {
      nextState: 'canceled',
      basis: 'execution_evidence',
      reason: evidence.reason ?? 'recovered_canceled_execution',
    };
  }
  // failed / crashed / lost_contact / timeout / startup_failed / stopped /
  // abandoned: the execution produced no usable result — the honest public
  // terminal is FAILED (§9: 已启动执行，Worker 已退出 → 记录中断失败).
  return {
    nextState: 'failed',
    basis: 'interrupted',
    reason:
      evidence.outcome === 'abandoned'
        ? 'restart_interrupted_unknown_outcome'
        : `recovered_${evidence.outcome}`,
  };
}

export async function runStartupRecovery(
  options: StartupRecoveryOptions,
): Promise<StartupRecoveryReport> {
  const { taskManager, identity, ledger, requeue } = options;
  const report: StartupRecoveryReport = {
    ledgerReplay: null,
    orphanBindingsReleased: [],
    abandonedExecutions: [],
    settledTasks: [],
    reclaimableTaskIds: [],
    requeuedTaskIds: [],
    requeueFailures: [],
    unpublishedOutboxTaskIds: [],
  };

  // 1. Deletion-ledger replay FIRST (§9: 恢复时先重放删除和撤权、清理缓存
  //    及待发事件，再开放服务) — a restored old snapshot is cleaned before
  //    any recovery move or requeue dispatch can touch it.
  if (ledger !== undefined) {
    report.ledgerReplay = ledger.replayAgainst(taskManager);
  }

  // 2. Crash-window orphan task bindings (review #103 r1 P2-1 convergence):
  //    bindings whose task row never committed (process died between the
  //    fail-closed bindTask() and acceptInput()). Harmless by design; the
  //    startup scan is the one bounded place they can be released safely
  //    (no in-flight acceptance exists before the service opens).
  if (identity !== undefined) {
    for (const binding of identity.allTaskBindings()) {
      if (!taskManager.taskExists(binding.taskId)) {
        identity.unbindTask(binding.taskId, 'startup_orphan_binding_cleanup');
        report.orphanBindingsReleased.push(binding.taskId);
      }
    }
  }

  // 3. The recovery decisions (read-only view → Task-Manager API writes).
  const view = taskManager.recoveryScanView();
  report.unpublishedOutboxTaskIds = [...view.unpublishedOutboxTaskIds];

  const reclaimable: { taskId: string; contextId: string }[] = [];

  for (const task of view.nonTerminalTasks) {
    const active = task.executions.filter((exec) => ACTIVE_EXECUTION_STATES.has(exec.state));
    const closed = task.executions.filter((exec) => !ACTIVE_EXECUTION_STATES.has(exec.state));

    // 3a. Active execution rows: outcome UNKNOWN → abandon + FAILED.
    if (active.length > 0) {
      for (const exec of active) {
        const reason = task.cancelIntent
          ? 'execution_stop_unconfirmed'
          : 'restart_interrupted_unknown_outcome';
        const abandoned = taskManager.abandonExecution({
          taskId: task.taskId,
          executionId: exec.executionId,
          reason,
        });
        if (abandoned.outcome === 'abandoned') {
          report.abandonedExecutions.push({
            taskId: task.taskId,
            executionId: exec.executionId,
            priorState: exec.state,
          });
        }
      }
      // Public settlement: cancel intent + unconfirmed stop → FAILED
      // execution_stop_unconfirmed (§7.2); plain interruption → FAILED
      // restart_interrupted_unknown_outcome (§9 已启动执行，Worker 已退出).
      const reason = task.cancelIntent
        ? 'execution_stop_unconfirmed'
        : 'restart_interrupted_unknown_outcome';
      const settled = taskManager.settleRecoveredTask({
        taskId: task.taskId,
        expectedState: task.currentState,
        expectedStateVersion: task.stateVersion,
        nextState: 'failed',
        reason,
        statusMessage: recoveredStatusMessage(
          task.contextId,
          task.taskId,
          task.cancelIntent
            ? '服务重启中断了取消流程，无法确认执行已停止，任务按失败结算。'
            : '服务重启中断了执行，结果未知，不会自动重跑。',
        ),
      });
      if (settled.outcome === 'committed') {
        report.settledTasks.push({
          taskId: task.taskId,
          from: task.currentState,
          to: 'failed',
          basis: task.cancelIntent ? 'stop_unconfirmed' : 'interrupted',
          reason,
        });
      }
      continue;
    }

    // 3b. All rows closed but the public state never settled (crash between
    //     the terminal publish and the store save, or between the row close
    //     and the publish): re-derive from the latest settled evidence.
    if (closed.length > 0 && !isTerminalTaskState(task.currentState)) {
      const withEvidence = closed
        .filter((exec) => exec.settledAtMs !== null || exec.state === 'abandoned')
        .sort((a, b) => (a.settledAtMs ?? 0) - (b.settledAtMs ?? 0));
      const latest = withEvidence[withEvidence.length - 1];
      if (latest !== undefined && latest.result !== null) {
        const derived = publicSettlementFromEvidence(task, latest.result);
        if (isLegalTaskTransition(task.currentState, derived.nextState)) {
          const settled = taskManager.settleRecoveredTask({
            taskId: task.taskId,
            expectedState: task.currentState,
            expectedStateVersion: task.stateVersion,
            nextState: derived.nextState,
            reason: derived.reason,
            statusMessage:
              derived.statusMessage !== undefined
                ? recoveredStatusMessage(task.contextId, task.taskId, derived.statusMessage)
                : undefined,
            metadata: derived.metadata,
          });
          if (settled.outcome === 'committed') {
            report.settledTasks.push({
              taskId: task.taskId,
              from: task.currentState,
              to: derived.nextState,
              basis: derived.basis,
              reason: derived.reason,
            });
          }
        }
      }
      continue;
    }

    // 3c. Confirmed-never-started: submitted with NO execution rows at all
    //     (claim + execution row commit atomically, so a started execution
    //     always leaves a row — absence is the proof, §9 row 1).
    if (task.currentState === 'submitted' && task.executions.length === 0) {
      if (task.cancelIntent) {
        // 取消意图已保存 → 优先恢复取消，不能正常续跑; confirmed
        // undispatched → CANCELED (§7.1.4 canceled_pre_dispatch semantics).
        const settled = taskManager.settleRecoveredTask({
          taskId: task.taskId,
          expectedState: task.currentState,
          expectedStateVersion: task.stateVersion,
          nextState: 'canceled',
          reason: 'canceled_pre_dispatch',
          statusMessage: recoveredStatusMessage(
            task.contextId,
            task.taskId,
            '取消已在派发前生效（服务重启恢复）。',
          ),
        });
        if (settled.outcome === 'committed') {
          report.settledTasks.push({
            taskId: task.taskId,
            from: task.currentState,
            to: 'canceled',
            basis: 'undispatched_cancel',
            reason: 'canceled_pre_dispatch',
          });
        }
        continue;
      }
      reclaimable.push({ taskId: task.taskId, contextId: task.contextId });
    }
    // input_required / auth_required without executions: keep waiting
    // (§9 在有效期限内保留等待); validity windows are P1-09/#91.
  }

  // 3d. Terminal tasks never lose their public state (§9 保持不变). A crash
  //     between execution-row registration and the public settlement still
  //     leaves an ACTIVE row behind on a TERMINAL task; the scan closes that
  //     stale row ('abandoned', evidence-only) and reports it — the public
  //     state itself is untouched.
  for (const stale of view.terminalTasksWithActiveExecutions) {
    const abandoned = taskManager.abandonExecution({
      taskId: stale.taskId,
      executionId: stale.executionId,
      reason: 'restart_interrupted_unknown_outcome',
    });
    if (abandoned.outcome === 'abandoned') {
      report.abandonedExecutions.push({
        taskId: stale.taskId,
        executionId: stale.executionId,
        priorState: stale.priorState,
      });
    }
  }

  // 4. Re-dispatch confirmed-never-started tasks through the injected hook
  //    (the composition routes it through quota → claim → authorization →
  //    worker, so cancel/auth/quota are re-checked exactly as §9 requires).
  report.reclaimableTaskIds = reclaimable.map((entry) => entry.taskId);
  if (requeue !== undefined) {
    for (const entry of reclaimable) {
      const detail = taskManager.getTaskDetail(entry.taskId);
      const firstTurn = detail.turns[0];
      if (firstTurn === undefined) {
        report.requeueFailures.push({
          taskId: entry.taskId,
          error: 'no turn input persisted for a reclaimable task',
        });
        continue;
      }
      try {
        await requeue(entry.taskId, firstTurn.inputMessage);
        report.requeuedTaskIds.push(entry.taskId);
      } catch (error) {
        report.requeueFailures.push({
          taskId: entry.taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return report;
}
