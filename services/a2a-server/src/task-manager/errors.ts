/**
 * Typed errors of the SQLite Task Manager repository (P1-02, issue #84).
 *
 * Error codes are STABLE application identifiers (TASK_LIFECYCLE §5.2:
 * 应用原因是错误说明中的业务标识，不是新增 A2A 方法或私有任务状态). They are
 * consumed by tests, diagnostics and — from P1-04/#86 on — the JSON-RPC
 * error mapping at the transport boundary. The repository NEVER invents
 * JSON-RPC codes itself; the locked SDK handler owns wire-level mapping.
 */

export type TaskManagerErrorCode =
  /** 同键不同指纹 — request dedupe conflict (TASK_LIFECYCLE §5.2). */
  | 'message_id_conflict'
  | 'task_not_found'
  | 'illegal_transition'
  | 'terminal_immutable'
  /** Conditional update lost the race; caller re-reads state (§4.2). */
  | 'state_version_conflict'
  /** Callback failed execution attribution: task/turn/epoch/lease mismatch. */
  | 'execution_attribution'
  /** SQLite write lock could not be acquired within busy_timeout. */
  | 'write_lock_busy'
  /** Store opened against an unknown future schema version (fail-closed). */
  | 'schema_version_not_supported'
  /** Input contract violation (bad ids, missing fields). */
  | 'invalid_input';

export class TaskManagerError extends Error {
  readonly code: TaskManagerErrorCode;
  /** Extra structured details (e.g. the conflicting request key). */
  readonly details?: Record<string, unknown>;

  constructor(code: TaskManagerErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TaskManagerError';
    this.code = code;
    this.details = details;
  }
}

export function isTaskManagerError(error: unknown): error is TaskManagerError {
  return error instanceof TaskManagerError;
}
