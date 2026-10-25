/**
 * Dispatch-lease executor decorator (P1-04, issue #86; TASK_LIFECYCLE
 * §4.1.6, §7.1).
 *
 * Wraps the inner AgentExecutor (SYNTHETIC in P1; the real DSH Runtime
 * Bridge is P1-05/#87) and turns the repository's dispatch primitives into
 * the live dispatch path:
 *
 *   1. quota gate (BEFORE the claim — a refused request settles REJECTED
 *      and never consumes an execution slot; §3 SUBMITTED → REJECTED:
 *      执行前业务拒绝，未启动业务执行). Pluggable: real limits are P1-09;
 *      P1 runs with the default allow-all and the hook is proven by tests.
 *   2. claimExecution() — the transactional dispatch lease: conditional
 *      submitted→working + the execution/lease row commit atomically. A
 *      persisted cancel intent refuses the claim (canceled_pre_dispatch,
 *      §7.1.4: 取消先于派发无 Worker 启动); a lost race (already claimed /
 *      terminal) yields 'stale' and this executor emits NOTHING — the
 *      owning flow settles.
 *   3. authorization re-check (AFTER the claim — current server-side state
 *      of the FULL acceptance chain, P1-03 executor gate): revoked between
 *      acceptance and dispatch → settle CANCELED, no body (AC 3 派发前复查
 *      权限).
 *   4. inner.execute() — the actual Worker run.
 *
 * cancelTask(): the cancel intent is PERSISTED FIRST (recordCancelIntent in
 * its own transaction — AC 2 取消意图先本地持久化), THEN the remote cancel is
 * dispatched to the inner executor. Re-delivered cancels hit
 * already-recorded / already-terminal and never duplicate side effects
 * (§7.1.2), which makes the persisted-intent → remote-cancel re-delivery
 * contract observable (AC 2 补发远端取消可测).
 *
 * "事务提交与 Worker 启动之间故障不盲目重试副作用": a crash after the claim
 * commits leaves the task working with a REGISTERED execution and this
 * process holds no retry logic — restart recovery (P1-05/P1-08) re-decides
 * from persisted state; an executor error surfaces as the SDK's own FAILED
 * settlement (never a silent re-run).
 */
import { randomUUID } from 'node:crypto';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { TaskState, type TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { SqliteTaskManager } from '../task-manager/sqlite-task-manager.ts';

export type QuotaGate = (taskId: string) => { allowed: boolean; reason?: string };

/**
 * The dispatch-lease claim keys, handed to lease-aware inner executors
 * (P1-05, issue #87): the real DSH worker runtime needs the exact
 * attribution keys to register the worker, admit output and settle the
 * execution row.
 */
export interface DispatchLeaseInfo {
  taskId: string;
  contextId: string;
  executionId: string;
  turnSeq: number;
  epoch: number;
  leaseId: string;
  leaseExpiresAtMs: number;
}

/**
 * Inner executors that want the dispatch-lease claim keys implement this
 * (P1-05): the decorator calls executeWithLease instead of execute after a
 * successful claim. Executors without it (SYNTHETIC) keep the plain path.
 */
export interface LeaseAwareExecutor extends AgentExecutor {
  executeWithLease(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
    lease: DispatchLeaseInfo,
  ): Promise<void>;
}

export interface LeaseDispatchExecutorOptions {
  inner: AgentExecutor;
  /**
   * Authoritative repository. When undefined (custom Task Store), the
   * decorator passes straight through to the inner executor.
   */
  taskManager?: SqliteTaskManager;
  /** Current-state authorization re-check (P1-03 executor gate). */
  authorizationGate?: (taskId: string) => { allowed: boolean; reason?: string };
  /** Dispatch quota re-check (real limits P1-09; default: allow). */
  quotaGate?: QuotaGate;
  /** Dispatch lease TTL; expired leases fail callback attribution. */
  leaseTtlMs: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

function statusUpdate(
  taskId: string,
  contextId: string,
  state: TaskState,
): { kind: 'statusUpdate'; data: TaskStatusUpdateEvent } {
  return {
    kind: 'statusUpdate',
    data: {
      taskId,
      contextId,
      status: { state, message: undefined, timestamp: new Date().toISOString() },
      metadata: undefined,
    },
  };
}

export function leaseDispatchExecutor(options: LeaseDispatchExecutorOptions): AgentExecutor {
  const { inner, taskManager } = options;
  const now = options.now ?? (() => Date.now());

  return {
    async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
      if (taskManager === undefined) {
        await inner.execute(requestContext, eventBus);
        return;
      }
      const { taskId, contextId } = requestContext;
      let claimed: DispatchLeaseInfo | null = null;

      try {
        // 1. Quota re-check BEFORE the claim (rejected tasks never take a slot).
        if (options.quotaGate) {
          const quota = options.quotaGate(taskId);
          if (!quota.allowed) {
            eventBus.publish(statusUpdate(taskId, contextId, TaskState.TASK_STATE_REJECTED));
            return;
          }
        }

        // 2. Transactional dispatch lease (cancel-vs-dispatch race resolves
        //    here: only one side wins the conditional update).
        const executionId = randomUUID();
        const leaseId = randomUUID();
        const leaseExpiresAtMs = now() + options.leaseTtlMs;
        const claim = taskManager.claimExecution({
          taskId,
          executionId,
          leaseId,
          leaseExpiresAtMs,
          workerId: 'runtime-pending',
        });
        if (claim.outcome === 'stale') {
          // Claimed elsewhere / already past submitted: the owning flow (the
          // winning dispatch or the cancel settlement) owns the outcome; this
          // execution emits nothing (AC 1: 一个 Task 只有一个有效执行).
          return;
        }
        if (claim.outcome === 'canceled_pre_dispatch') {
          // Cancel intent persisted before dispatch: settle CANCELED here —
          // submitted → canceled is legal (§3) — and never start the Worker.
          eventBus.publish(statusUpdate(taskId, contextId, TaskState.TASK_STATE_CANCELED));
          return;
        }
        claimed = { taskId, contextId, executionId, turnSeq: claim.turnSeq, epoch: claim.epoch, leaseId, leaseExpiresAtMs };

        // 3. Authorization re-check on CURRENT state after the claim.
        if (options.authorizationGate) {
          const decision = options.authorizationGate(taskId);
          if (!decision.allowed) {
            // working → canceled is legal (§3); P1-03 semantic: revocation
            // settles CANCELED with no body.
            eventBus.publish(statusUpdate(taskId, contextId, TaskState.TASK_STATE_CANCELED));
            return;
          }
        }

        // 4. Actual Worker run — lease-aware executors (real DSH runtime,
        //    P1-05) receive the claim keys; plain executors keep execute().
        const leaseAware = inner as Partial<LeaseAwareExecutor>;
        if (typeof leaseAware.executeWithLease === 'function') {
          await leaseAware.executeWithLease(requestContext, eventBus, claimed);
        } else {
          await inner.execute(requestContext, eventBus);
        }
      } catch (error) {
        // Executor error → the SDK settles FAILED; the execution row must
        // not stay open behind it (settlement path, review #103 P2-2).
        if (claimed !== null) {
          settleFromTaskState(taskManager, claimed, 'executor_error');
        }
        throw error;
      }

      // Settlement FALLBACK for inner executors without their own settlement
      // path (SYNTHETIC): the live dispatch path ALWAYS closes its execution
      // row now (review #103 P2-2: 执行行永不结算 → 补执行行结算路径). Lease-
      // aware executors settle themselves with process evidence; this call
      // then observes already_settled (idempotent, first wins).
      settleFromTaskState(taskManager, claimed);
    },

    async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
      if (taskManager !== undefined) {
        // AC 2: 取消意图先本地持久化 — the intent + outbox cancelCommand
        // commit BEFORE any remote cancel dispatch. Repeated cancels are
        // already-recorded / already-terminal without new side effects.
        taskManager.recordCancelIntent({ taskId, reason: 'cancel_requested' });
        // P1-05: fence the ACTIVE execution row (stop_requested) so the
        // real stop evidence settles against a recorded stop request.
        taskManager.markExecutionStopRequested({ taskId, reason: 'cancel_requested' });
      }
      await inner.cancelTask(taskId, eventBus);
    },
  };
}

/**
 * Closes the claimed execution row from the DISPATCH side, mirroring the
 * authoritative task state after the inner executor returned. No-op when
 * the row is already settled (lease-aware executors settle themselves).
 */
function settleFromTaskState(
  taskManager: SqliteTaskManager,
  claimed: DispatchLeaseInfo,
  errorReason?: string,
): void {
  try {
    const detail = taskManager.getTaskDetail(claimed.taskId);
    const state = detail.currentState;
    const outcome =
      errorReason === 'executor_error'
        ? ({ outcome: 'failed', reason: 'executor_error' } as const)
        : state === 'completed'
          ? ({ outcome: 'completed' } as const)
          : state === 'canceled'
            ? ({ outcome: 'canceled' } as const)
            : state === 'failed'
              ? ({ outcome: 'failed' } as const)
              : ({ outcome: 'stopped', reason: `executor_finished_${state}` } as const);
    taskManager.settleExecution({
      taskId: claimed.taskId,
      executionId: claimed.executionId,
      turnSeq: claimed.turnSeq,
      epoch: claimed.epoch,
      leaseId: claimed.leaseId,
      result: outcome,
    });
  } catch {
    // Diagnostics-only bookkeeping must never mask the executor result.
  }
}
