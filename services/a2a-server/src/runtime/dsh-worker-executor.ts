/**
 * Real DSH Worker executor (P1-05, issue #87) — the Task Manager wiring for
 * the runtime-lease execution path.
 *
 * Replaces the SYNTHETIC executor as the inner executor when the service
 * runs in dsh-worker mode. It bridges ONE dispatch-lease claim to ONE real
 * worker subprocess:
 *
 *   claim keys (taskId/turnSeq/epoch/executionId/leaseId)
 *     → runtime.startExecution (real child process)
 *     → worker events: hello → registerExecutionWorker (AC 2 归属核对)
 *                      ready → WORKING status update
 *                      output → taskManager.admitChunk (attribution + lease
 *                               + admission enforced) → artifactUpdate event
 *                      result → raw execution result (kept off the public
 *                               Task settlement path, AC 3)
 *     → process close/kill → exit evidence (AC 2 崩溃/启动失败/失联)
 *     → taskManager.settleExecution (P2-2 settlement path, body-free evidence)
 *     → public Task settlement via the normal bus/bridge discipline.
 *
 * Late/invalid callbacks are REJECTED by the repository (epoch/lease/state
 * guards); this executor never publishes over a terminal task (AC 3).
 */
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { Role, TaskState } from '@a2a-js/sdk';
import type { Part, Task, TaskStatus, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { randomUUID } from 'node:crypto';
import { isTerminalTaskState, type A2aTaskState } from '../task-manager/state-machine.ts';
import type {
  SqliteTaskManager,
  ExecutionSettlement,
} from '../task-manager/sqlite-task-manager.ts';
import {
  DshWorkerRuntime,
  type FinalizeCause,
  type WorkerStartRequest,
} from './dsh-worker-runtime.ts';
import type { WorkerEvent, WorkerExitEvidence, WorkerResult } from './worker-protocol.ts';

/** Default public artifact id for admitted answer chunks. */
const ANSWER_ARTIFACT_ID = 'answer';

function statusOf(state: TaskState): TaskStatus {
  return { state, message: undefined, timestamp: new Date().toISOString() };
}

function textPart(value: string, metadata?: Record<string, unknown>): Part {
  return {
    content: { $case: 'text', value },
    metadata,
    filename: '',
    mediaType: 'text/plain',
  };
}

function statusUpdate(
  taskId: string,
  contextId: string,
  state: TaskState,
  options: { message?: Part[]; metadata?: Record<string, unknown> } = {},
): { kind: 'statusUpdate'; data: TaskStatusUpdateEvent } {
  const message =
    options.message === undefined
      ? undefined
      : {
          messageId: `status-${randomUUID()}`,
          contextId,
          taskId,
          role: Role.ROLE_AGENT,
          parts: options.message,
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
      // Event-level metadata: the locked SDK handler merges event metadata
      // into the current Task and persists it through the authoritative
      // store save (dist applyStatusUpdate → task.metadata merge).
      metadata: options.metadata as TaskStatusUpdateEvent['metadata'],
    },
  };
}

export interface DshWorkerExecutorOptions {
  runtime: DshWorkerRuntime;
  /** Authoritative repository (execution attribution + settlement path). */
  taskManager: SqliteTaskManager;
  /** Injectable clock (tests). */
  now?: () => number;
}

export class DshWorkerExecutor implements AgentExecutor {
  private readonly runtime: DshWorkerRuntime;
  private readonly taskManager: SqliteTaskManager;
  private readonly now: () => number;

  constructor(options: DshWorkerExecutorOptions) {
    this.runtime = options.runtime;
    this.taskManager = options.taskManager;
    this.now = options.now ?? Date.now;
  }

  /** Plain execute() is meaningless without a dispatch lease: fail-closed. */
  async execute(_requestContext: RequestContext, _eventBus: ExecutionEventBus): Promise<void> {
    throw new Error(
      'dsh_worker_requires_lease: the DSH worker executor runs only through the dispatch-lease decorator',
    );
  }

  /** Cancel dispatch: the decorator persists the intent + stop marker first. */
  async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    this.runtime.cancelExecution(taskId, 'cancel_requested');
  }

  /**
   * Lease-aware execution entry (dispatch-lease decorator P1-05 extension).
   * Resolves exactly once — when the worker session finalized and the
   * execution row is settled.
   */
  async executeWithLease(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
    lease: {
      taskId: string;
      contextId: string;
      executionId: string;
      turnSeq: number;
      epoch: number;
      leaseId: string;
    },
  ): Promise<void> {
    const { taskId, contextId, executionId, turnSeq, epoch, leaseId } = lease;
    const inputText = firstText(requestContext.userMessage);

    // Task-first publication (SDK ordering rule), then the process runs.
    const task: Task = {
      id: taskId,
      contextId,
      status: statusOf(TaskState.TASK_STATE_SUBMITTED),
      artifacts: [],
      history: requestContext.userMessage ? [requestContext.userMessage] : [],
      metadata: undefined,
    };
    eventBus.publish({ kind: 'task', data: task });

    let workerResult: WorkerResult | null = null;
    let admissionBlocked = false;
    let admissionBlockReason: string | null = null;

    const settled = new Promise<void>((resolve) => {
      const onFinalized = (evidence: WorkerExitEvidence, cause: FinalizeCause): void => {
        try {
          this.finalizeExecution({
            taskId,
            contextId,
            executionId,
            turnSeq,
            epoch,
            leaseId,
            eventBus,
            evidence,
            cause,
            workerResult,
            admissionBlocked,
            admissionBlockReason,
            taskStillWorking: () => this.currentTaskState(taskId) === 'working',
          });
        } finally {
          resolve();
        }
      };

      this.runtime.startExecution(
        {
          taskId,
          turnSeq,
          epoch,
          executionId,
          leaseId,
          inputText,
        } satisfies WorkerStartRequest,
        {
          onWorkerEvent: (event: WorkerEvent) => {
            switch (event.type) {
              case 'hello': {
                // Worker registration on the execution row (AC 2: 归属可核对).
                this.taskManager.registerExecutionWorker({
                  taskId,
                  executionId,
                  leaseId,
                  workerId: event.workerId,
                });
                break;
              }
              case 'ready': {
                eventBus.publish(statusUpdate(taskId, contextId, TaskState.TASK_STATE_WORKING));
                break;
              }
              case 'output': {
                if (admissionBlocked) break; // already fenced; ignore late output
                const admitted = this.taskManager.admitChunk({
                  taskId,
                  executionId,
                  turnSeq,
                  epoch,
                  leaseId,
                  artifactId: ANSWER_ARTIFACT_ID,
                  chunkId: event.chunkId,
                  text: event.text,
                  lastChunk: event.lastChunk,
                });
                if (admitted.outcome === 'admitted') {
                  eventBus.publish({
                    kind: 'artifactUpdate',
                    data: {
                      taskId,
                      contextId,
                      artifact: {
                        artifactId: ANSWER_ARTIFACT_ID,
                        name: 'Admitted answer',
                        description: '',
                        parts: [
                          textPart(event.text, {
                            lumithinkOutput: {
                              version: 1,
                              chunkId: admitted.chunkId,
                              startByte: admitted.startByte,
                              endByte: admitted.endByte,
                              sha256: admitted.sha256,
                            },
                          }),
                        ],
                        metadata: { lumithinkContent: { version: 1, category: 'admitted-answer' } },
                        extensions: [],
                      },
                      append: admitted.chunkSeq > 1,
                      lastChunk: event.lastChunk,
                      metadata: {
                        lumithinkOutput: {
                          version: 1,
                          chunkId: admitted.chunkId,
                          startByte: admitted.startByte,
                          endByte: admitted.endByte,
                          sha256: admitted.sha256,
                        },
                      },
                    },
                  });
                } else if (admitted.outcome === 'rejected') {
                  // Late/invalid callback: the repository refused — fence the
                  // run (no public output, worker stopped, state untouched
                  // when terminal). AC 3 + TASK_LIFECYCLE §6.2/§1.4.
                  admissionBlocked = true;
                  admissionBlockReason = admitted.reason;
                  this.runtime.cancelExecution(taskId, `output_rejected_${admitted.reason}`);
                }
                break;
              }
              case 'result': {
                workerResult = event;
                break;
              }
              case 'heartbeat':
              case undefined:
              default:
                break; // liveness only
            }
          },
          onFinalized,
        },
      );
    });

    await settled;
  }

  // -------------------------------------------------------------------------

  /**
   * Maps the finalized session (cause + exit evidence + raw worker result)
   * to (1) the execution-row settlement and (2) the public Task settlement.
   * The two stay SEPARATE (AC 3): the row records raw evidence; the public
   * state moves only when the task is still non-terminal and the desired
   * terminal state is justified.
   */
  private finalizeExecution(input: {
    taskId: string;
    contextId: string;
    executionId: string;
    turnSeq: number;
    epoch: number;
    leaseId: string;
    eventBus: ExecutionEventBus;
    evidence: WorkerExitEvidence;
    cause: FinalizeCause;
    workerResult: WorkerResult | null;
    admissionBlocked: boolean;
    admissionBlockReason: string | null;
    taskStillWorking: () => boolean;
  }): void {
    const { evidence, cause, workerResult } = input;
    const endedAtMs = this.now();

    // --- execution-row settlement (raw, body-free evidence) ---------------
    let outcome: ExecutionSettlement['outcome'];
    let reason: string | undefined;
    if (cause === 'worker_exit') {
      if (workerResult?.outcome === 'completed') {
        outcome = 'completed';
      } else if (workerResult?.outcome === 'canceled') {
        outcome = 'canceled';
        reason = workerResult.reason;
      } else if (workerResult?.outcome === 'failed') {
        outcome = 'failed';
        reason = workerResult.reason;
      } else if ((evidence.exitCode ?? 0) !== 0 || evidence.signal !== null) {
        outcome = 'crashed';
        reason = 'worker_exit_abnormal';
      } else {
        outcome = 'failed';
        reason = 'worker_exit_without_result';
      }
    } else if (cause === 'spawn_error' || cause === 'hello_timeout' || cause === 'bad_registration') {
      outcome = 'startup_failed';
      reason = cause;
    } else if (cause === 'lost_contact') {
      outcome = 'lost_contact';
    } else if (cause === 'execution_deadline') {
      outcome = 'timeout';
    } else if (cause === 'cancel_grace_expired') {
      outcome = 'canceled';
      reason = 'cancel_grace_expired';
    } else if (cause === 'disposed') {
      outcome = 'stopped';
      reason = 'service_shutdown';
    } else {
      outcome = 'failed';
      reason = cause; // protocol_violation
    }
    const settlement: ExecutionSettlement = {
      outcome,
      reason,
      exitCode: evidence.exitCode,
      signal: evidence.signal,
      killedByRuntime: evidence.killedByRuntime === true ? true : undefined,
      workerId: null,
      startedAtMs: null,
      endedAtMs,
    };
    if (input.admissionBlocked) {
      settlement.reason = input.admissionBlockReason ?? 'output_admission_blocked';
    }

    // --- public Task settlement (only when justified) ---------------------
    const detail = this.currentTaskDetail(input.taskId);
    if (
      detail !== null &&
      !isTerminalTaskState(detail.currentState) &&
      cause !== 'disposed'
    ) {
      const desired = this.desiredPublicState(input, outcome);
      if (desired === TaskState.TASK_STATE_COMPLETED) {
        // Completion semantics (P1-07, issue #89 — TASK_LIFECYCLE §7.2,
        // fixtures 03/04): EVERY real completion carries the versioned
        // lumithinkResult flags on the terminal event — the locked SDK
        // handler merges event-level metadata into the persisted Task and
        // saves it through the authoritative repository (GetTask/SSE and
        // the snapshot agree). A completion that raced a cancel intent and
        // lost its remaining body to the admission fence settles COMPLETED
        // with outputSuppressedAfterCancel=true / answerComplete=false plus
        // the readable status message — never a fabricated CANCELED (the
        // execution really finished; "不能谎报已停止推理").
        const suppressed =
          input.admissionBlocked && input.admissionBlockReason === 'output_admission_closed';
        input.eventBus.publish(
          statusUpdate(input.taskId, input.contextId, TaskState.TASK_STATE_COMPLETED, {
            message: suppressed ? [textPart('执行已完成，后续输出因取消被抑制。')] : undefined,
            metadata: {
              lumithinkResult: {
                version: 1,
                outputSuppressedAfterCancel: suppressed,
                answerComplete: !suppressed,
              },
            },
          }),
        );
      } else if (desired === TaskState.TASK_STATE_CANCELED) {
        input.eventBus.publish(statusUpdate(input.taskId, input.contextId, TaskState.TASK_STATE_CANCELED));
      } else if (desired === TaskState.TASK_STATE_FAILED) {
        input.eventBus.publish(statusUpdate(input.taskId, input.contextId, TaskState.TASK_STATE_FAILED));
      }
      // desired === null → a fenced anomaly owned elsewhere: the executor
      // publishes NOTHING over it (admission/cancel path owns the outcome).
    }

    this.taskManager.settleExecution({
      taskId: input.taskId,
      executionId: input.executionId,
      turnSeq: input.turnSeq,
      epoch: input.epoch,
      leaseId: input.leaseId,
      result: settlement,
    });
  }

  private currentTaskState(taskId: string): A2aTaskState | null {
    const detail = this.currentTaskDetail(taskId);
    return detail?.currentState ?? null;
  }

  private currentTaskDetail(taskId: string): { currentState: A2aTaskState } | null {
    try {
      return { currentState: this.taskManager.getTaskDetail(taskId).currentState };
    } catch {
      return null;
    }
  }

  private desiredPublicState(
    input: {
      workerResult: WorkerResult | null;
      admissionBlocked: boolean;
      admissionBlockReason: string | null;
      taskStillWorking: () => boolean;
    },
    outcome: ExecutionSettlement['outcome'],
  ): TaskState | null {
    if (outcome === 'completed') {
      if (!input.admissionBlocked) {
        return TaskState.TASK_STATE_COMPLETED;
      }
      // Completion racing a cancel intent (P1-07, §7.2): the body remaining
      // after the cancel was fenced by the admission state — the execution
      // itself REALLY finished, so the task settles COMPLETED with the
      // suppressed-answer flags (executor publishes them), never CANCELED.
      if (input.admissionBlockReason === 'output_admission_closed') {
        return TaskState.TASK_STATE_COMPLETED;
      }
      // Any OTHER fence reason (protocol anomaly) stays unpublished here.
      return null;
    }
    if (outcome === 'canceled') {
      return TaskState.TASK_STATE_CANCELED;
    }
    if (outcome === 'failed' || outcome === 'crashed' || outcome === 'lost_contact' || outcome === 'timeout' || outcome === 'startup_failed') {
      return TaskState.TASK_STATE_FAILED;
    }
    // 'stopped': the service-shutdown/cancel path owns the settlement — do
    // not publish over it here.
    return null;
  }
}

function firstText(message: RequestContext['userMessage']): string {
  if (!message) return '';
  for (const part of message.parts ?? []) {
    if (part.content?.$case === 'text') return part.content.value;
  }
  return '';
}
