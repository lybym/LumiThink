/**
 * Admission + execution-deadline enforcement for the LumiThink A2A validation
 * service (P1-09, issue #91; TASK_LIFECYCLE §4.1 步骤 3 / §7.3 / §10 容量耗尽;
 * docs/A2A_DESIGN.md §13.4).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ This module is the ONLY place the bounded generation slots are claimed  │
 * │ and released. Wrapping the inner executor means the                      │
 * │ claim -> execute -> release sequence happens on EVERY exit path         │
 * │ (success, thrown error, deadline, cancel fence). That is what makes     │
 * │ AC 2 "超时、断连、非协作 Worker 和模型失败不泄漏进程/租约/队列槽"        │
 * │ structural instead of a scattering of try/finally blocks.               │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Two independent bounds apply:
 *   1. SLOT admission: the §13.4 bounded worker pool. Capacity full -> the
 *      task settles REJECTED and no Worker starts (§3 SUBMITTED -> REJECTED:
 *      执行前业务拒绝，未启动业务执行). This is AC 1's "明确拒绝".
 *   2. EXECUTION DEADLINE (§13.4 执行时间, §7.3 初始截止时间): a per-execution
 *      timer that stops an over-long execution through the inner executor's
 *      OWN cancel path. It never fabricates CANCELED or COMPLETED — the real
 *      stop evidence owns the public settlement (§7.3 不能为达到耗时指标而提前
 *      报告成功).
 */
import { randomUUID } from 'node:crypto';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { Role, TaskState } from '@a2a-js/sdk';
import type { TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { A2aLimitsConfig } from './config.ts';
import type { AdmissionScheduler, LimitsRejectionReason } from './scheduler.ts';
import type { ObservabilityRecorder } from './observability.ts';

/** Readable, content-free explanation for a capacity refusal (AC 1). */
export function capacityRejectionMessage(reason: LimitsRejectionReason): string {
  switch (reason) {
    case 'queue_full_global':
      return '服务当前排队任务已满（全局容量耗尽），本次请求未被派发，请稍后重试。';
    case 'queue_full_household':
      return '本家庭排队任务已满，本次请求未被派发，请等待已有任务完成。';
    case 'queue_wait_timeout':
      return '在排队等待上限内未能取得执行资源，本次请求未被派发，请稍后重试。';
    case 'capacity_full':
      return '执行容量已满，本次请求未被派发，请稍后重试。';
    case 'daily_budget_exhausted':
      return '本家庭今日模型用量预算已用尽，本次请求未被派发。';
    case 'task_budget_exhausted':
      return '本任务模型用量预算已用尽，本次请求未被派发。';
    case 'scheduler_closed':
      return '服务正在关闭，本次请求未被派发。';
    default:
      return '执行资源不足，本次请求未被派发。';
  }
}

/** Builds one statusUpdate event carrying an optional readable message. */
function statusUpdate(
  taskId: string,
  contextId: string,
  state: TaskState,
  messageText?: string,
): { kind: 'statusUpdate'; data: TaskStatusUpdateEvent } {
  const message =
    messageText === undefined
      ? undefined
      : {
          messageId: `limits-${randomUUID()}`,
          contextId,
          taskId,
          role: Role.ROLE_AGENT,
          parts: [
            {
              content: { $case: 'text' as const, value: messageText },
              metadata: undefined,
              filename: '',
              mediaType: 'text/plain',
            },
          ],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        };
  return {
    kind: 'statusUpdate',
    data: {
      taskId,
      contextId,
      status: { state, message, timestamp: new Date().toISOString() },
      metadata: undefined,
    },
  };
}

/** The dispatch-lease claim keys handed to a lease-aware inner executor. */
export interface LeaseKeys {
  taskId: string;
  contextId: string;
  executionId: string;
  turnSeq: number;
  epoch: number;
  leaseId: string;
}

/**
 * A lease-aware inner executor (the real DSH worker). The dispatch-lease
 * decorator calls `executeWithLease` instead of `execute`, so this wrapper
 * must bound THAT entry point too.
 */
export interface LeaseAware {
  executeWithLease(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
    lease: LeaseKeys,
  ): Promise<void>;
}

function isLeaseAware(inner: AgentExecutor): inner is AgentExecutor & LeaseAware {
  return typeof (inner as Partial<LeaseAware>).executeWithLease === 'function';
}

export interface LimitsAwareExecutorOptions {
  inner: AgentExecutor;
  scheduler: AdmissionScheduler;
  limits: LeaseLimitsConfig;
  recorder: ObservabilityRecorder;
  /** Household the task belongs to (capacity is household scoped). */
  householdOf: (taskId: string) => string;
  /** Tokens reserved up front: estimated input + maximum output (§13.4). */
  tokensToReserve?: (taskId: string, contextId: string) => number;
  /** Injectable clock (tests). */
  now?: () => number;
}

/** Re-uses the service limits type without importing the whole config module. */
export type LeaseLimitsConfig = A2aLimitsConfig;

/**
 * Wraps an executor with bounded admission, a per-execution deadline, and a
 * single leak-proof release point.
 */
export function limitsAwareExecutor(
  options: LimitsAwareExecutorOptions,
): AgentExecutor & Partial<LeaseAware> {
  const { inner, scheduler, recorder, limits } = options;
  const now = options.now ?? (() => Date.now());

  const bounded = async (input: {
    taskId: string;
    contextId: string;
    eventBus: ExecutionEventBus;
    run: () => Promise<void>;
  }): Promise<void> => {
    const { taskId, contextId, eventBus } = input;
    const startedAtMs = now();
    const householdId = options.householdOf(taskId);
    const tokensToReserve =
      options.tokensToReserve === undefined
        ? limits.modelBudget.maxTokensPerTask
        : options.tokensToReserve(taskId, contextId);

    const decision = await scheduler.admit({
      taskId,
      contextId,
      householdId,
      tokensToReserve,
      maxWaitMs: limits.admissionWaitMs,
    });

    if (decision.outcome === 'refused') {
      // AC 1: explicit rejection, NO worker starts. NOTE (review #108 r1 P0):
      // when this executor runs INSIDE the dispatch-lease decorator the task
      // has already been claimed → its public state is `working`, and
      // publishing REJECTED there would be an illegal snapshot that gets
      // discarded, stranding the task forever. The capacity pre-check in the
      // lease layer handles the common case BEFORE the claim; this fallback
      // settles honestly as FAILED (working → failed is legal) with the
      // capacity reason on the wire.
      recorder.emit({
        level: 'warn',
        event: 'admission.decided',
        taskId,
        contextId,
        householdId,
        decision: 'refused',
        reason: decision.reason,
        waitedMs: decision.waitedMs,
        tokensReserved: tokensToReserve,
      });
      eventBus.publish(
        statusUpdate(
          taskId,
          contextId,
          TaskState.TASK_STATE_FAILED,
          capacityRejectionMessage(decision.reason),
        ),
      );
      return;
    }

    const ticket = decision.ticket;
    recorder.emit({
      event: 'admission.decided',
      taskId,
      contextId,
      householdId,
      decision: 'admitted',
      waitedMs: ticket.waitedMs,
      tokensReserved: ticket.tokensReserved,
      queueDepth: scheduler.snapshot().queuedGlobal,
    });

    let deadlineExceeded = false;
    let timer: NodeJS.Timeout | null = null;
    try {
      const outcome = await Promise.race([
        input.run().then(() => 'finished' as const),
        new Promise<'deadline'>((resolve) => {
          timer = setTimeout(() => resolve('deadline'), limits.execution.maxExecutionMs);
        }),
      ]);
      if (outcome === 'deadline') {
        deadlineExceeded = true;
        recorder.emit({
          level: 'warn',
          event: 'execution.deadline_exceeded',
          taskId,
          contextId,
          householdId,
          reason: 'execution_deadline',
          durationMs: now() - startedAtMs,
        });
        try {
          await inner.cancelTask(taskId, eventBus);
        } catch {
          // The stop evidence owns the settlement; a failing cancel must not
          // mask the deadline observation just recorded.
        }
      }
    } finally {
      if (timer !== null) clearTimeout(timer);
      // AC 2: the slot is released on EVERY exit path, in exactly one place.
      scheduler.releaseExecution(ticket.ticketId);
      recorder.emit({
        event: 'execution.finished',
        taskId,
        contextId,
        householdId,
        durationMs: now() - startedAtMs,
        waitedMs: ticket.waitedMs,
        reason: deadlineExceeded ? 'execution_deadline' : 'executor_returned',
      });
    }
  };

  const wrapped: AgentExecutor & Partial<LeaseAware> = {
    async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
      await bounded({
        taskId: requestContext.taskId,
        contextId: requestContext.contextId,
        eventBus,
        run: () => inner.execute(requestContext, eventBus),
      });
    },
    async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
      // Cancel is NOT slot-limited: it must reach the running worker even
      // when every generation slot is taken (AC 1 取消有界).
      recorder.emit({
        event: 'cancel.decided',
        taskId,
        decision: 'allow',
        reason: 'cancel_dispatched',
      });
      await inner.cancelTask(taskId, eventBus);
    },
  };

  if (isLeaseAware(inner)) {
    const leaseInner = inner;
    wrapped.executeWithLease = async (
      requestContext: RequestContext,
      eventBus: ExecutionEventBus,
      lease: LeaseKeys,
    ): Promise<void> => {
      await bounded({
        taskId: lease.taskId,
        contextId: lease.contextId,
        eventBus,
        run: () => leaseInner.executeWithLease(requestContext, eventBus, lease),
      });
    };
  }
  return wrapped;
}
