/**
 * P2-02 (issue #114) — client error taxonomy and SDK error mapping
 * (ADR-0018 Appendix B component 6; TASK_LIFECYCLE §7.2/§7.3/§7.4).
 *
 * Rules encoded here (each one is an ADR-0018 hard constraint):
 *   - `TaskNotFoundError` ≠ "需要输入" (constraint 4): a -32001 mapping is
 *     surfaced as task_not_found, never as an input request.
 *   - `TaskNotCancelableError` → task_not_cancelable: the §7.2 race row
 *     "完成事务已提交，随后收到取消 → 保持原终态；取消返回不可取消".
 *   - Cancel response timeout → cancel_unconfirmed with the §7.3 wording
 *     "取消结果未确认，可查询任务" — the persistent cancel intent REMAINS
 *     valid; callers must not read this as a lost cancel intent.
 *   - Credential renewal failure → credential_renewal_failed: §7.4 requires
 *     cleanup-not-completed to be VISIBLE, never silently swallowed.
 *
 * No token/credential value ever travels through an error message.
 */
import { TaskNotCancelableError, TaskNotFoundError } from '@a2a-js/sdk/errors';

export type DshA2aClientErrorCode =
  | 'invalid_config'
  | 'credential_missing'
  | 'credential_renewal_failed'
  | 'send_failed'
  | 'task_wait_aborted'
  | 'poll_timeout'
  | 'task_not_found'
  | 'task_not_cancelable'
  | 'cancel_unconfirmed'
  | 'cancel_recovery_failed'
  | 'ledger_corrupt'
  | 'unexpected_response';

export class DshA2aClientError extends Error {
  readonly code: DshA2aClientErrorCode;
  /** Stable client messageId involved, when known. */
  readonly messageId?: string;
  /** Server taskId involved, when known. */
  readonly taskId?: string;

  constructor(
    code: DshA2aClientErrorCode,
    message: string,
    options: { messageId?: string; taskId?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DshA2aClientError';
    this.code = code;
    this.messageId = options.messageId;
    this.taskId = options.taskId;
  }
}

/**
 * Local presentation stop (§7.4 step 1: 工具 Abort 时先停止本地呈现).
 * Carries the handle so the tool/caller can drive `cancel()` next; the
 * client's convenience wait loop performs that cancel itself and reports
 * the outcome on this error.
 */
export class TaskWaitAbortedError extends DshA2aClientError {
  /** What the automatic §7.4 cleanup achieved, when the loop drove it. */
  readonly cancelOutcome?: CancelOutcomeStatus;
  readonly cancelDetail?: string;

  constructor(
    message: string,
    options: {
      messageId?: string;
      taskId?: string;
      cause?: unknown;
      cancelOutcome?: CancelOutcomeStatus;
      cancelDetail?: string;
    } = {},
  ) {
    super('task_wait_aborted', message, options);
    this.name = 'TaskWaitAbortedError';
    this.cancelOutcome = options.cancelOutcome;
    this.cancelDetail = options.cancelDetail;
  }
}

/** Terminal outcome of one `cancel()` attempt (ledger-recorded verbatim). */
export type CancelOutcomeStatus =
  | 'confirmed_canceled'
  | 'already_terminal'
  | 'unconfirmed_timeout'
  | 'not_found'
  | 'failed';

export interface CancelOutcome {
  status: CancelOutcomeStatus;
  /** Server task id the cleanup targeted. */
  taskId?: string;
  /** Normalized task state observed after the cancel attempt, when any. */
  taskState?: string;
  /** True when the taskId was recovered via the §5.3 original-message resend. */
  recoveredViaResend?: boolean;
  /** Human-readable, token-free detail (goes to tool output and ledger). */
  detail: string;
}

/** Maps any thrown value onto the client taxonomy (ADR-0018 constraint 4). */
export function mapClientError(error: unknown, context: { messageId?: string; taskId?: string } = {}): unknown {
  if (error instanceof DshA2aClientError) return error;
  if (error instanceof TaskNotFoundError) {
    return new DshA2aClientError(
      'task_not_found',
      `Task not found on the server (standard -32001). This is NOT an input request; ` +
        'the task id is unknown or inaccessible to this credential.',
      { ...context, cause: error },
    );
  }
  if (error instanceof TaskNotCancelableError) {
    return new DshA2aClientError(
      'task_not_cancelable',
      'The server refused the cancel because the task is already terminal or in a ' +
        'non-cancelable stage (standard -32002; TASK_LIFECYCLE §7.2). Query the task for its real state.',
      { ...context, cause: error },
    );
  }
  return error;
}
