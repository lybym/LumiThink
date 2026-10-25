/**
 * SQLite unified repository + Task Manager (P1-02, issue #84).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SINGLE AUTHORITATIVE WRITE PATH (TASK_LIFECYCLE §4.1, ADR-0013)         │
 * │ The SDK request handler is wired to EXACTLY ONE Task Store: this class. │
 * │ Every persisted state/result/event write — from the SDK bridge          │
 * │ (save/load/list) AND from the Task-Manager API (acceptInput,            │
 * │ transitionTask, claimExecution, admitChunk, recordCancelIntent,         │
 * │ appendTurn) — flows through THE SAME SQLite database, THE SAME          │
 * │ transaction discipline and THE SAME tables. There is no second store    │
 * │ and no double write. The legacy Prisma schema stays frozen.             │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Contract highlights (issue #84 ACs):
 *  - AC 1  Task ↔ sequential Turns ↔ Execution(epoch/lease) traceability;
 *          standard states + terminal irreversibility (transition table in
 *          state-machine.ts + DB trigger in schema.ts).
 *  - AC 2  Input acceptance, task state/results and Outbox rows commit in
 *          ONE `BEGIN IMMEDIATE` transaction; injected failures at any
 *          write boundary roll back everything (no half writes).
 *  - AC 3  Conditional updates on (expected_state, state_version) let
 *          exactly one racing writer commit; losers re-read (outcome
 *          'stale'). Late callbacks cannot change terminal states nor
 *          append body (execution attribution + terminal guards).
 *  - AC 4  No model/network waits inside write transactions: all
 *          transaction bodies are synchronous by construction (a Promise
 *          result fails the transaction); the only bounded wait is the
 *          SQLite busy_timeout, proven by the write-lock contention test.
 *
 * Outbox publication happens OUTSIDE write transactions: rows are committed
 * transactionally with the state change, `readOutbox`/`markOutboxPublished`
 * are separate operations, and `readOutbox({ includePublished: true })`
 * replays with stable ids/positions/digests (P1-06/#88 builds the full
 * delivery contract on this).
 *
 * SYNTHETIC data only (P1 口径) — no real child audio/text/credentials.
 */
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  TaskState,
  Role,
  type Artifact,
  type ListTasksRequest,
  type ListTasksResponse,
  type Message,
  type Part,
  type Task,
} from '@a2a-js/sdk';
import type { ServerCallContext } from '@a2a-js/sdk/server';
import { type TaskStore } from '../task-manager-port.ts';
import { TaskManagerError } from './errors.ts';
import { openTaskManagerDatabase } from './schema.ts';
import {
  type A2aTaskState,
  fromSdkTaskState,
  isLegalTaskTransition,
  isTerminalTaskState,
  toSdkTaskState,
} from './state-machine.ts';

/** Test-only failure injection points (AC 2: 任何失败点无半写). */
export type TestFailurePoint =
  | 'afterLedgerWrite'
  | 'afterTaskWrite'
  | 'afterTurnWrite'
  | 'afterOutboxWrite'
  | 'beforeCommit';

export interface SqliteTaskManagerOptions {
  /** SQLite database path; ':memory:' keeps everything in process. */
  dbPath: string;
  /** Bounded write-lock wait (AC 4). Default 2000 ms. */
  busyTimeoutMs?: number;
  /** Injectable wall clock (ms epoch) for deterministic tests. */
  now?: () => number;
  /** Policy version recorded on every turn (design: Turn 策略版本). */
  policyVersion?: string;
}

// ---------------------------------------------------------------------------
// Params / results of the Task-Manager API
// ---------------------------------------------------------------------------

export interface AcceptInputParams {
  /** Canonical idempotency key (composition from identity binding is P1-04). */
  requestKey: string;
  /** Versioned fingerprint of the normalized business request. */
  fingerprint: string;
  messageId: string;
  /** Runtime-shaped SDK message (the accepted input). */
  inputMessage: Message;
  /** Empty/absent lets the server assign the context id. */
  contextId?: string;
  taskMetadata?: Record<string, unknown>;
}

export type AcceptInputResult =
  | { outcome: 'created'; taskId: string; contextId: string; stateVersion: number }
  | {
      outcome: 'duplicate';
      taskId: string;
      contextId: string;
      currentState: A2aTaskState;
      stateVersion: number;
    }
  | { outcome: 'tombstoned'; taskId: string }
  | { outcome: 'conflict'; reason: 'message_id_conflict'; existingTaskId: string };

export interface ExecutionRef {
  executionId: string;
  turnSeq: number;
  epoch: number;
  leaseId?: string;
}

export interface TransitionTaskParams {
  taskId: string;
  /** State the caller observed; conditional update anchor (§4.2). */
  expectedState: A2aTaskState;
  expectedStateVersion: number;
  nextState: A2aTaskState;
  reason?: string;
  /** When present, the callback's execution attribution is verified. */
  execution?: ExecutionRef;
}

export type TransitionTaskResult =
  | { outcome: 'committed'; currentState: A2aTaskState; stateVersion: number }
  /** Loser of the version race re-reads state and re-decides (§4.2). */
  | { outcome: 'stale'; currentState: A2aTaskState; stateVersion: number };

export interface ClaimExecutionParams {
  taskId: string;
  executionId: string;
  turnSeq?: number;
  epoch?: number;
  leaseId?: string;
  leaseExpiresAtMs?: number;
  workerId?: string;
}

export type ClaimExecutionResult =
  | {
      outcome: 'claimed';
      executionId: string;
      turnSeq: number;
      epoch: number;
      stateVersion: number;
    }
  | { outcome: 'stale'; currentState: A2aTaskState; stateVersion: number };

export interface AdmitChunkParams {
  taskId: string;
  executionId: string;
  turnSeq: number;
  epoch: number;
  leaseId?: string;
  artifactId: string;
  artifactName?: string;
  /** Stable chunk id for idempotent redelivery (重发保持片段 ID, §6.1). */
  chunkId?: string;
  /** Admitted chunk body — synthetic validation text only in P1. */
  text: string;
  lastChunk?: boolean;
}

export type AdmitChunkResult =
  | { outcome: 'admitted'; chunkSeq: number; chunkId: string }
  /** Redelivery of an already-admitted chunk keeps the original (§6.1). */
  | { outcome: 'duplicate'; chunkSeq: number; chunkId: string }
  | {
      outcome: 'rejected';
      reason:
        | 'execution_attribution'
        | 'execution_settled'
        | 'lease_invalid'
        /** 迟到回调不能追加正文 (AC 3). */
        | 'task_terminal'
        | 'output_admission_closed';
    };

export interface RecordCancelIntentParams {
  taskId: string;
  reason: string;
}

export type RecordCancelIntentResult =
  | { outcome: 'recorded'; currentState: A2aTaskState; stateVersion: number }
  /** 重复取消不重复副作用 (§7.1.2). */
  | { outcome: 'already-recorded'; currentState: A2aTaskState }
  | { outcome: 'already-terminal'; currentState: A2aTaskState };

export interface AppendTurnParams {
  taskId: string;
  /** New unique request key for the supplementary input (§5.2). */
  requestKey: string;
  fingerprint: string;
  inputMessage: Message;
}

export type AppendTurnResult =
  | { outcome: 'created'; turnSeq: number; epoch: number }
  | { outcome: 'rejected'; reason: 'task_terminal' | 'message_id_conflict' };

export interface OutboxEvent {
  seq: number;
  kind: 'task' | 'statusUpdate' | 'artifactUpdate' | 'cancelCommand' | 'turnAccepted';
  payload: Record<string, unknown>;
  artifactId: string | null;
  chunkId: string | null;
  createdAtMs: number;
  publishedAtMs: number | null;
}

export interface TaskDetail {
  taskId: string;
  contextId: string;
  currentState: A2aTaskState;
  stateVersion: number;
  cancelIntent: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  terminalAtMs: number | null;
  turns: {
    turnSeq: number;
    epoch: number;
    outputAdmission: 'open' | 'closed';
    cancelIntent: boolean;
    createdAtMs: number;
    inputMessage: Message;
    executions: {
      executionId: string;
      state: string;
      leaseId: string | null;
      leaseExpiresAtMs: number | null;
      workerId: string | null;
      createdAtMs: number;
      settledAtMs: number | null;
    }[];
  }[];
}

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

interface TaskRow {
  task_id: string;
  context_id: string;
  current_state: string;
  state_version: number;
  created_at_ms: number;
  updated_at_ms: number;
  terminal_at_ms: number | null;
  status_message_json: string | null;
  metadata_json: string | null;
  cancel_intent: number;
  cancel_requested_at_ms: number | null;
  cancel_reason: string | null;
}

const DEFAULT_BUSY_TIMEOUT_MS = 2000;

function jsonRef(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseJsonOrNull<T>(raw: string | null): T | undefined {
  if (raw === null) return undefined;
  return JSON.parse(raw) as T;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function utf8Len(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function encodePageToken(createdAtMs: number, taskId: string): string {
  return Buffer.from(JSON.stringify({ c: createdAtMs, t: taskId }), 'utf8').toString('base64url');
}

function decodePageToken(token: string): { createdAtMs: number; taskId: string } {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as {
      c?: unknown;
      t?: unknown;
    };
    if (typeof parsed.c === 'number' && typeof parsed.t === 'string') {
      return { createdAtMs: parsed.c, taskId: parsed.t };
    }
  } catch {
    // fall through to the typed error
  }
  throw new TaskManagerError('invalid_input', `Malformed list page token: ${token}`);
}

// ---------------------------------------------------------------------------
// The repository
// ---------------------------------------------------------------------------

export class SqliteTaskManager implements TaskStore {
  readonly dbPath: string;
  readonly schemaVersion: number;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly policyVersion: string;
  private readonly busyTimeoutMs: number;
  private inWriteTransaction = false;
  private closed = false;
  private testFailurePoint: TestFailurePoint | null = null;

  constructor(options: SqliteTaskManagerOptions) {
    if (typeof options.dbPath !== 'string' || options.dbPath.length === 0) {
      throw new TaskManagerError('invalid_input', 'dbPath must be a non-empty string');
    }
    this.dbPath = options.dbPath;
    this.busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.policyVersion = options.policyVersion ?? 'p1-02-v1';
    const opened = openTaskManagerDatabase({
      dbPath: this.dbPath,
      busyTimeoutMs: this.busyTimeoutMs,
    });
    this.db = opened.db;
    this.schemaVersion = opened.schemaVersion;
  }

  // -------------------------------------------------------------------------
  // Transaction core (AC 2 / AC 4)
  // -------------------------------------------------------------------------

  /**
   * Runs `fn` inside ONE `BEGIN IMMEDIATE` transaction. The body MUST be
   * synchronous — this is what makes "no model/network waits inside the
   * write transaction" a structural property instead of a convention: an
   * async body fails the transaction loudly instead of half-committing.
   */
  private withWriteTransaction<T>(fn: () => T): T {
    this.assertOpen();
    if (this.inWriteTransaction) {
      throw new TaskManagerError('invalid_input', 'nested write transaction');
    }
    this.inWriteTransaction = true;
    try {
      // BEGIN IMMEDIATE is the first lock acquisition point: a busy write
      // lock surfaces HERE (bounded by busy_timeout) and is wrapped into the
      // typed write_lock_busy error below.
      this.db.exec('BEGIN IMMEDIATE');
      const result = fn();
      if (result instanceof Promise) {
        throw new TaskManagerError(
          'invalid_input',
          'write transactions must stay synchronous — no model/network waits inside the DB transaction (AC 4)',
        );
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // No active transaction (e.g. BEGIN itself failed) — nothing to roll back.
      }
      throw this.wrapSqliteError(error);
    } finally {
      this.inWriteTransaction = false;
    }
  }

  /**
   * Maps raw SQLite busy/locked failures onto the typed busy error (AC 4).
   * node:sqlite reports them as Error with code ERR_SQLITE_ERROR and the
   * SQLite result code in `errcode` (5 = SQLITE_BUSY, 6 = SQLITE_LOCKED).
   */
  private wrapSqliteError(error: unknown): unknown {
    if (error instanceof TaskManagerError) return error;
    const err = error as
      | { code?: string; errcode?: number; errstr?: string; message?: string }
      | null;
    const isBusyLock =
      err?.errcode === 5 ||
      err?.errcode === 6 ||
      /database is locked|database table is locked/i.test(err?.message ?? '');
    if (isBusyLock) {
      return new TaskManagerError(
        'write_lock_busy',
        `SQLite write lock not acquired within busyTimeoutMs=${this.busyTimeoutMs} ` +
          `(errcode=${String(err?.errcode)}: ${String(err?.errstr ?? err?.message)}). Write ` +
          'transactions stay bounded; no in-transaction waits on model/network are permitted.',
        { sqliteErrcode: err?.errcode },
      );
    }
    return error;
  }

  private checkFailurePoint(point: TestFailurePoint): void {
    if (this.testFailurePoint === point) {
      throw new TaskManagerError('invalid_input', `injected test failure at ${point}`);
    }
  }

  /** Test-only: inject a failure at a write boundary (AC 2 evidence). */
  setTestFailurePoint(point: TestFailurePoint | null): void {
    this.testFailurePoint = point;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new TaskManagerError('invalid_input', 'repository is closed');
    }
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }

  // -------------------------------------------------------------------------
  // Input acceptance (AC 2: 受理事务)
  // -------------------------------------------------------------------------

  /**
   * Atomic acceptance per TASK_LIFECYCLE §4.1/§5: request ledger + Task +
   * Turn + history + Outbox rows commit in ONE transaction. Duplicate keys
   * return the original task without creating a Turn; key reuse with a
   * different fingerprint is the stable `message_id_conflict` error.
   */
  acceptInput(params: AcceptInputParams): AcceptInputResult {
    this.assertValidText(params.requestKey, 'requestKey');
    this.assertValidText(params.fingerprint, 'fingerprint');
    this.assertValidText(params.messageId, 'messageId');
    return this.withWriteTransaction(() => {
      const nowMs = this.now();
      const ledger = this.selectLedgerLocked(params.requestKey);
      if (ledger) {
        if (ledger.fingerprint !== params.fingerprint) {
          throw new TaskManagerError(
            'message_id_conflict',
            'Same request key with a different fingerprint (TASK_LIFECYCLE §5.2)',
            { requestKey: params.requestKey, existingTaskId: ledger.task_id },
          );
        }
        if (ledger.status === 'tombstoned') {
          return { outcome: 'tombstoned', taskId: ledger.task_id };
        }
        const task = this.selectTaskLocked(ledger.task_id);
        if (!task) {
          throw new TaskManagerError(
            'task_not_found',
            `Ledger references missing task ${ledger.task_id}`,
          );
        }
        return {
          outcome: 'duplicate',
          taskId: task.task_id,
          contextId: task.context_id,
          currentState: task.current_state as A2aTaskState,
          stateVersion: task.state_version,
        };
      }
      this.checkFailurePoint('afterLedgerWrite');

      const contextId =
        params.contextId !== undefined && params.contextId !== ''
          ? params.contextId
          : randomUUID();
      this.ensureConversationLocked(contextId, nowMs);
      const taskId = randomUUID();
      this.insertTaskLocked({
        taskId,
        contextId,
        state: 'submitted',
        nowMs,
        metadata: params.taskMetadata,
      });
      this.checkFailurePoint('afterTaskWrite');

      this.insertTurnLocked(taskId, 1, 1, params.inputMessage, nowMs);
      this.checkFailurePoint('afterTurnWrite');

      this.db
        .prepare(
          'INSERT INTO a2a_request_ledger (request_key, fingerprint, task_id, created_at_ms, status) ' +
            "VALUES (?, ?, ?, ?, 'active')",
        )
        .run(params.requestKey, params.fingerprint, taskId, nowMs);
      this.insertHistoryLocked(taskId, 1, params.inputMessage, nowMs);
      this.appendOutboxLocked(taskId, 'task', {
        taskId,
        contextId,
        state: 'submitted',
        messageId: params.messageId,
        turnSeq: 1,
        epoch: 1,
      });
      this.checkFailurePoint('afterOutboxWrite');
      this.checkFailurePoint('beforeCommit');
      return { outcome: 'created', taskId, contextId, stateVersion: 1 };
    });
  }

  /** Supplementary input on a non-terminal task → next sequential Turn (§5.2). */
  appendTurn(params: AppendTurnParams): AppendTurnResult {
    this.assertValidText(params.requestKey, 'requestKey');
    this.assertValidText(params.fingerprint, 'fingerprint');
    return this.withWriteTransaction(() => {
      const nowMs = this.now();
      const task = this.selectTaskLocked(params.taskId);
      if (!task) {
        throw new TaskManagerError('task_not_found', `Task not found: ${params.taskId}`);
      }
      if (isTerminalTaskState(task.current_state as A2aTaskState)) {
        return { outcome: 'rejected', reason: 'task_terminal' };
      }
      const ledger = this.selectLedgerLocked(params.requestKey);
      if (ledger) {
        return { outcome: 'rejected', reason: 'message_id_conflict' };
      }
      const nextSeqRow = this.db
        .prepare('SELECT COALESCE(MAX(turn_seq), 0) AS maxSeq FROM a2a_turns WHERE task_id = ?')
        .get(params.taskId) as { maxSeq: number };
      const nextEpochRow = this.db
        .prepare('SELECT COALESCE(MAX(epoch), 0) AS maxEpoch FROM a2a_turns WHERE task_id = ?')
        .get(params.taskId) as { maxEpoch: number };
      const turnSeq = nextSeqRow.maxSeq + 1;
      const epoch = nextEpochRow.maxEpoch + 1;
      this.insertTurnLocked(params.taskId, turnSeq, epoch, params.inputMessage, nowMs);
      this.db
        .prepare(
          'INSERT INTO a2a_request_ledger (request_key, fingerprint, task_id, created_at_ms, status) ' +
            "VALUES (?, ?, ?, ?, 'active')",
        )
        .run(params.requestKey, params.fingerprint, params.taskId, nowMs);
      this.insertHistoryLocked(
        params.taskId,
        this.nextHistorySeqLocked(params.taskId),
        params.inputMessage,
        nowMs,
      );
      this.appendOutboxLocked(params.taskId, 'turnAccepted', {
        taskId: params.taskId,
        turnSeq,
        epoch,
        messageId: params.inputMessage.messageId,
      });
      this.checkFailurePoint('afterOutboxWrite');
      this.checkFailurePoint('beforeCommit');
      return { outcome: 'created', turnSeq, epoch };
    });
  }

  // -------------------------------------------------------------------------
  // Conditional state transitions (AC 1 / AC 3)
  // -------------------------------------------------------------------------

  /**
   * State transition guarded by (expected_state, state_version) and the
   * strict transition table. Exactly one racing writer commits; the loser
   * receives outcome 'stale' with fresh state to re-decide (§4.2). When
   * `execution` is provided, the callback's task/turn/epoch/lease
   * attribution is verified INSIDE the transaction.
   */
  transitionTask(params: TransitionTaskParams): TransitionTaskResult {
    return this.withWriteTransaction(() => {
      const row = this.selectTaskLocked(params.taskId);
      if (!row) {
        throw new TaskManagerError('task_not_found', `Task not found: ${params.taskId}`);
      }
      if (
        row.current_state !== params.expectedState ||
        row.state_version !== params.expectedStateVersion
      ) {
        return { outcome: 'stale', currentState: row.current_state as A2aTaskState, stateVersion: row.state_version };
      }
      if (!isLegalTaskTransition(params.expectedState, params.nextState)) {
        throw new TaskManagerError(
          'illegal_transition',
          `Illegal task transition ${params.expectedState} → ${params.nextState} ` +
            '(TASK_LIFECYCLE §3; terminal states are irreversible)',
          { taskId: params.taskId, from: params.expectedState, to: params.nextState },
        );
      }
      if (params.execution) {
        this.assertExecutionAttributionLocked(params.taskId, params.execution);
      }
      const nowMs = this.now();
      const nextVersion = row.state_version + 1;
      const terminalAt = isTerminalTaskState(params.nextState) ? nowMs : row.terminal_at_ms;
      const changes = this.db
        .prepare(
          'UPDATE a2a_tasks SET current_state = ?, state_version = ?, updated_at_ms = ?, terminal_at_ms = ? ' +
            'WHERE task_id = ? AND current_state = ? AND state_version = ?',
        )
        .run(
          params.nextState,
          nextVersion,
          nowMs,
          terminalAt,
          params.taskId,
          params.expectedState,
          params.expectedStateVersion,
        ).changes;
      if (Number(changes) !== 1) {
        // The conditional UPDATE is the durable race guard; reaching this
        // branch is paranoia (single writer inside BEGIN IMMEDIATE).
        const fresh = this.selectTaskLocked(params.taskId)!;
        return { outcome: 'stale', currentState: fresh.current_state as A2aTaskState, stateVersion: fresh.state_version };
      }
      this.checkFailurePoint('afterTaskWrite');
      this.appendOutboxLocked(params.taskId, 'statusUpdate', {
        taskId: params.taskId,
        contextId: row.context_id,
        from: params.expectedState,
        to: params.nextState,
        reason: params.reason ?? null,
        executionId: params.execution?.executionId ?? null,
        turnSeq: params.execution?.turnSeq ?? null,
        epoch: params.execution?.epoch ?? null,
      });
      this.checkFailurePoint('afterOutboxWrite');
      this.checkFailurePoint('beforeCommit');
      return { outcome: 'committed', currentState: params.nextState, stateVersion: nextVersion };
    });
  }

  /**
   * Claims the dispatch lease from the UNDISPATCHED submitted state
   * (§4.1.6, §7.1.4): conditional update submitted→working plus the
   * execution/lease row commit atomically. Cancel-vs-dispatch races resolve
   * through the same conditional update — only one side wins.
   */
  claimExecution(params: ClaimExecutionParams): ClaimExecutionResult {
    return this.withWriteTransaction(() => {
      const row = this.selectTaskLocked(params.taskId);
      if (!row) {
        throw new TaskManagerError('task_not_found', `Task not found: ${params.taskId}`);
      }
      if (row.current_state !== 'submitted') {
        return { outcome: 'stale', currentState: row.current_state as A2aTaskState, stateVersion: row.state_version };
      }
      const turnSeq = params.turnSeq ?? 1;
      const turn = this.db
        .prepare('SELECT epoch FROM a2a_turns WHERE task_id = ? AND turn_seq = ?')
        .get(params.taskId, turnSeq) as { epoch: number } | undefined;
      if (!turn) {
        throw new TaskManagerError(
          'invalid_input',
          `Turn ${turnSeq} does not exist on task ${params.taskId}`,
        );
      }
      const epoch = params.epoch ?? turn.epoch;
      const nowMs = this.now();
      this.db
        .prepare(
          "INSERT INTO a2a_executions (execution_id, task_id, turn_seq, epoch, lease_id, " +
            "lease_expires_at_ms, state, worker_id, created_at_ms) " +
            "VALUES (?, ?, ?, ?, ?, ?, 'registered', ?, ?)",
        )
        .run(
          params.executionId,
          params.taskId,
          turnSeq,
          epoch,
          params.leaseId ?? null,
          params.leaseExpiresAtMs ?? null,
          params.workerId ?? null,
          nowMs,
        );
      const nextVersion = row.state_version + 1;
      const changes = this.db
        .prepare(
          "UPDATE a2a_tasks SET current_state = 'working', state_version = ?, updated_at_ms = ? " +
            'WHERE task_id = ? AND current_state = ? AND state_version = ?',
        )
        .run(nextVersion, nowMs, params.taskId, 'submitted', row.state_version).changes;
      if (Number(changes) !== 1) {
        throw new TaskManagerError('state_version_conflict', 'Dispatch claim lost the version race');
      }
      this.appendOutboxLocked(params.taskId, 'statusUpdate', {
        taskId: params.taskId,
        contextId: row.context_id,
        from: 'submitted',
        to: 'working',
        executionId: params.executionId,
        turnSeq,
        epoch,
        leaseId: params.leaseId ?? null,
      });
      this.checkFailurePoint('afterOutboxWrite');
      this.checkFailurePoint('beforeCommit');
      return { outcome: 'claimed', executionId: params.executionId, turnSeq, epoch, stateVersion: nextVersion };
    });
  }

  // -------------------------------------------------------------------------
  // Result admission (Task Manager is the ONLY public-result writer, §6)
  // -------------------------------------------------------------------------

  /**
   * Admits one body chunk from a Runtime callback: verifies execution
   * attribution (task/turn/epoch/lease), task non-terminal state and the
   * turn's output admission, then commits artifact + append-only chunk +
   * Outbox event in ONE transaction. Late callbacks (terminal task, settled
   * execution, stale epoch/lease) are REJECTED with the original state
   * untouched (AC 3).
   */
  admitChunk(params: AdmitChunkParams): AdmitChunkResult {
    return this.withWriteTransaction(() => {
      const task = this.selectTaskLocked(params.taskId);
      if (!task) {
        throw new TaskManagerError('task_not_found', `Task not found: ${params.taskId}`);
      }
      const exec = this.db
        .prepare('SELECT * FROM a2a_executions WHERE execution_id = ? AND task_id = ?')
        .get(params.executionId, params.taskId) as
        | {
            execution_id: string;
            turn_seq: number;
            epoch: number;
            lease_id: string | null;
            lease_expires_at_ms: number | null;
            state: string;
          }
        | undefined;
      if (
        !exec ||
        exec.turn_seq !== params.turnSeq ||
        exec.epoch !== params.epoch
      ) {
        return { outcome: 'rejected', reason: 'execution_attribution' };
      }
      if (exec.state === 'settled' || exec.state === 'abandoned') {
        return { outcome: 'rejected', reason: 'execution_settled' };
      }
      if (
        (exec.lease_id !== null && params.leaseId !== undefined && exec.lease_id !== params.leaseId) ||
        (exec.lease_expires_at_ms !== null && this.now() > exec.lease_expires_at_ms)
      ) {
        return { outcome: 'rejected', reason: 'lease_invalid' };
      }
      if (isTerminalTaskState(task.current_state as A2aTaskState)) {
        return { outcome: 'rejected', reason: 'task_terminal' };
      }
      const turn = this.db
        .prepare('SELECT output_admission FROM a2a_turns WHERE task_id = ? AND turn_seq = ?')
        .get(params.taskId, params.turnSeq) as { output_admission: string } | undefined;
      if (!turn || turn.output_admission !== 'open') {
        return { outcome: 'rejected', reason: 'output_admission_closed' };
      }

      this.ensureArtifactLocked(params.taskId, params.artifactId, params.artifactName, this.now());
      // Idempotent redelivery: a caller-supplied stable chunkId that already
      // exists keeps the original chunk (no rewrite, no new outbox row, §6.1).
      if (params.chunkId !== undefined) {
        const existing = this.db
          .prepare(
            'SELECT chunk_seq FROM a2a_artifact_chunks WHERE task_id = ? AND artifact_id = ? AND chunk_id = ?',
          )
          .get(params.taskId, params.artifactId, params.chunkId) as
          | { chunk_seq: number }
          | undefined;
        if (existing) {
          return { outcome: 'duplicate', chunkSeq: existing.chunk_seq, chunkId: params.chunkId };
        }
      }
      const countRow = this.db
        .prepare(
          'SELECT COUNT(*) AS n FROM a2a_artifact_chunks WHERE task_id = ? AND artifact_id = ?',
        )
        .get(params.taskId, params.artifactId) as { n: number };
      const startRow = this.db
        .prepare(
          'SELECT COALESCE(MAX(end_byte), 0) AS maxEnd FROM a2a_artifact_chunks ' +
            'WHERE task_id = ? AND artifact_id = ?',
        )
        .get(params.taskId, params.artifactId) as { maxEnd: number };
      const chunkSeq = countRow.n + 1;
      const chunkId = params.chunkId ?? `${params.artifactId}#chunk-${chunkSeq}`;
      const startByte = startRow.maxEnd;
      const endByte = startByte + utf8Len(params.text);
      const digest = sha256Hex(params.text);
      const changes = this.db
        .prepare(
          'INSERT INTO a2a_artifact_chunks (task_id, artifact_id, chunk_seq, chunk_id, text, part_json, ' +
            'start_byte, end_byte, sha256, created_at_ms) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)',
        )
        .run(
          params.taskId,
          params.artifactId,
          chunkSeq,
          chunkId,
          params.text,
          startByte,
          endByte,
          digest,
          this.now(),
        ).changes;
      if (Number(changes) !== 1) {
        // chunk_id UNIQUE hit → idempotent redelivery; keep the original.
        const existing = this.db
          .prepare(
            'SELECT chunk_seq FROM a2a_artifact_chunks WHERE task_id = ? AND artifact_id = ? AND chunk_id = ?',
          )
          .get(params.taskId, params.artifactId, chunkId) as { chunk_seq: number } | undefined;
        return { outcome: 'duplicate', chunkSeq: existing?.chunk_seq ?? chunkSeq, chunkId };
      }
      if (exec.state === 'registered') {
        this.db
          .prepare("UPDATE a2a_executions SET state = 'running' WHERE execution_id = ?")
          .run(params.executionId);
      }
      this.appendOutboxLocked(
        params.taskId,
        'artifactUpdate',
        {
          taskId: params.taskId,
          contextId: task.context_id,
          artifactId: params.artifactId,
          chunk: {
            seq: chunkSeq,
            chunkId,
            startByte,
            endByte,
            sha256: digest,
            lastChunk: params.lastChunk ?? false,
          },
          append: chunkSeq > 1,
        },
        { artifactId: params.artifactId, chunkId },
      );
      this.checkFailurePoint('afterOutboxWrite');
      this.checkFailurePoint('beforeCommit');
      return { outcome: 'admitted', chunkSeq, chunkId };
    });
  }

  // -------------------------------------------------------------------------
  // Cancel intent (§7.1 step 3, P1-02 persistence scope)
  // -------------------------------------------------------------------------

  recordCancelIntent(params: RecordCancelIntentParams): RecordCancelIntentResult {
    return this.withWriteTransaction(() => {
      const row = this.selectTaskLocked(params.taskId);
      if (!row) {
        throw new TaskManagerError('task_not_found', `Task not found: ${params.taskId}`);
      }
      const state = row.current_state as A2aTaskState;
      if (isTerminalTaskState(state)) {
        return { outcome: 'already-terminal', currentState: state };
      }
      if (row.cancel_intent === 1) {
        return { outcome: 'already-recorded', currentState: state };
      }
      const nowMs = this.now();
      this.db
        .prepare(
          'UPDATE a2a_tasks SET cancel_intent = 1, cancel_requested_at_ms = ?, cancel_reason = ?, ' +
            'updated_at_ms = ? WHERE task_id = ?',
        )
        .run(nowMs, params.reason, nowMs, params.taskId);
      this.db
        .prepare(
          "UPDATE a2a_turns SET output_admission = 'closed', cancel_intent = 1 " +
            "WHERE task_id = ? AND output_admission = 'open'",
        )
        .run(params.taskId);
      this.appendOutboxLocked(params.taskId, 'cancelCommand', {
        taskId: params.taskId,
        reason: params.reason,
        requestedAtMs: nowMs,
      });
      this.checkFailurePoint('afterOutboxWrite');
      this.checkFailurePoint('beforeCommit');
      return { outcome: 'recorded', currentState: state, stateVersion: row.state_version };
    });
  }

  // -------------------------------------------------------------------------
  // Outbox (transactional write, publication outside, replay with stable ids)
  // -------------------------------------------------------------------------

  readOutbox(taskId: string, options: { includePublished?: boolean } = {}): OutboxEvent[] {
    this.assertOpen();
    const rows = (
      options.includePublished
        ? this.db.prepare('SELECT * FROM a2a_outbox WHERE task_id = ? ORDER BY seq').all(taskId)
        : this.db
            .prepare('SELECT * FROM a2a_outbox WHERE task_id = ? AND published_at_ms IS NULL ORDER BY seq')
            .all(taskId)
    ) as Record<string, unknown>[];
    return rows.map((row) => this.outboxEventOf(row));
  }

  /** Marks events published in their OWN transaction (publication ≠ admission). */
  markOutboxPublished(taskId: string, throughSeq: number): number {
    return this.withWriteTransaction(() => {
      const changes = this.db
        .prepare(
          'UPDATE a2a_outbox SET published_at_ms = ? ' +
            'WHERE task_id = ? AND seq <= ? AND published_at_ms IS NULL',
        )
        .run(this.now(), taskId, throughSeq).changes;
      return Number(changes);
    });
  }

  // -------------------------------------------------------------------------
  // SDK TaskStore bridge (save/load/list) — same repository, same transactions
  // -------------------------------------------------------------------------

  /**
   * Persists the SDK handler's task snapshot through the repository's write
   * path: conversation/task upsert (strict transition table; the
   * authoritative row wins over stale snapshots), turns derived from USER
   * history messages, append-only artifact chunks + Outbox events, history
   * rows and status metadata — all in ONE transaction.
   */
  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    this.withWriteTransaction(() => {
      const nowMs = this.now();
      this.ensureConversationLocked(task.contextId, nowMs);
      const incomingState = fromSdkTaskState(task.status?.state ?? TaskState.TASK_STATE_SUBMITTED);
      const row = this.selectTaskLocked(task.id);
      if (!row) {
        this.insertTaskLocked({
          taskId: task.id,
          contextId: task.contextId,
          state: incomingState,
          nowMs,
          statusMessage: task.status?.message,
          metadata: task.metadata,
        });
        this.appendOutboxLocked(task.id, 'task', {
          taskId: task.id,
          contextId: task.contextId,
          state: incomingState,
          source: 'sdk-bridge',
        });
      } else {
        this.applySnapshotStateLocked(row, incomingState);
      }
      this.syncTurnsFromHistoryLocked(task, nowMs);
      this.syncHistoryLocked(task, nowMs);
      this.syncArtifactsLocked(task, nowMs);
      this.db
        .prepare('UPDATE a2a_tasks SET status_message_json = ?, metadata_json = ?, updated_at_ms = ? WHERE task_id = ?')
        .run(
          jsonRef(task.status?.message),
          jsonRef(task.metadata),
          this.now(),
          task.id,
        );
      return undefined;
    });
  }

  async load(taskId: string, _context?: ServerCallContext): Promise<Task | undefined> {
    this.assertOpen();
    const row = this.selectTaskLocked(taskId);
    if (!row) return undefined;
    return this.assembleTaskFromRow(row);
  }

  async list(params: ListTasksRequest, _context?: ServerCallContext): Promise<ListTasksResponse> {
    this.assertOpen();
    const pageSize = Math.min(100, Math.max(1, Math.floor(params.pageSize ?? 50)));
    const conditions: string[] = [];
    const args: (string | number)[] = [];
    if (params.contextId !== undefined && params.contextId !== '') {
      conditions.push('context_id = ?');
      args.push(params.contextId);
    }
    if (
      params.status !== undefined &&
      params.status !== TaskState.TASK_STATE_UNSPECIFIED &&
      params.status !== TaskState.UNRECOGNIZED
    ) {
      conditions.push('current_state = ?');
      args.push(fromSdkTaskState(params.status));
    }
    if (params.statusTimestampAfter !== undefined && params.statusTimestampAfter !== '') {
      const ms = Date.parse(params.statusTimestampAfter);
      if (!Number.isNaN(ms)) {
        conditions.push('updated_at_ms >= ?');
        args.push(ms);
      }
    }
    if (params.pageToken !== undefined && params.pageToken !== '') {
      const token = decodePageToken(params.pageToken);
      conditions.push('(created_at_ms > ? OR (created_at_ms = ? AND task_id > ?))');
      args.push(token.createdAtMs, token.createdAtMs, token.taskId);
    }
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM a2a_tasks ${whereSql}`).get(...args) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT * FROM a2a_tasks ${whereSql} ORDER BY created_at_ms, task_id LIMIT ?`,
      )
      .all(...args, pageSize + 1) as unknown as TaskRow[];
    const hasMore = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    const tasks = page.map((row) =>
      this.assembleTaskFromRow(row, {
        includeArtifacts: params.includeArtifacts ?? false,
        historyLength: params.historyLength,
      }),
    );
    const last = page[page.length - 1];
    return {
      tasks,
      nextPageToken: hasMore && last ? encodePageToken(last.created_at_ms, last.task_id) : '',
      pageSize,
      totalSize: total,
    };
  }

  // -------------------------------------------------------------------------
  // Read/diagnostics helpers (traceability evidence, AC 1)
  // -------------------------------------------------------------------------

  getTaskDetail(taskId: string): TaskDetail {
    this.assertOpen();
    const row = this.selectTaskLocked(taskId);
    if (!row) {
      throw new TaskManagerError('task_not_found', `Task not found: ${taskId}`);
    }
    const turns = (
      this.db
        .prepare('SELECT * FROM a2a_turns WHERE task_id = ? ORDER BY turn_seq')
        .all(taskId) as Record<string, unknown>[]
    ).map((turn) => ({
      turnSeq: turn['turn_seq'] as number,
      epoch: turn['epoch'] as number,
      outputAdmission: turn['output_admission'] as 'open' | 'closed',
      cancelIntent: turn['cancel_intent'] === 1,
      createdAtMs: turn['created_at_ms'] as number,
      inputMessage: JSON.parse(turn['input_message_json'] as string) as Message,
      executions: (
        this.db
          .prepare(
            'SELECT * FROM a2a_executions WHERE task_id = ? AND turn_seq = ? ORDER BY created_at_ms',
          )
          .all(taskId, turn['turn_seq'] as number) as Record<string, unknown>[]
      ).map((exec) => ({
        executionId: exec['execution_id'] as string,
        state: exec['state'] as string,
        leaseId: (exec['lease_id'] as string | null) ?? null,
        leaseExpiresAtMs: (exec['lease_expires_at_ms'] as number | null) ?? null,
        workerId: (exec['worker_id'] as string | null) ?? null,
        createdAtMs: exec['created_at_ms'] as number,
        settledAtMs: (exec['settled_at_ms'] as number | null) ?? null,
      })),
    }));
    return {
      taskId: row.task_id,
      contextId: row.context_id,
      currentState: row.current_state as A2aTaskState,
      stateVersion: row.state_version,
      cancelIntent: row.cancel_intent === 1,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
      terminalAtMs: row.terminal_at_ms,
      turns,
    };
  }

  /** Table counts — failure-injection tests assert zero after rollbacks. */
  stats(): {
    conversations: number;
    tasks: number;
    turns: number;
    executions: number;
    ledger: number;
    outbox: number;
    artifacts: number;
    chunks: number;
    history: number;
  } {
    this.assertOpen();
    const count = (table: string): number =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return {
      conversations: count('a2a_conversations'),
      tasks: count('a2a_tasks'),
      turns: count('a2a_turns'),
      executions: count('a2a_executions'),
      ledger: count('a2a_request_ledger'),
      outbox: count('a2a_outbox'),
      artifacts: count('a2a_artifacts'),
      chunks: count('a2a_artifact_chunks'),
      history: count('a2a_task_history'),
    };
  }

  // -------------------------------------------------------------------------
  // Locked (in-transaction) helpers
  // -------------------------------------------------------------------------

  private selectTaskLocked(taskId: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM a2a_tasks WHERE task_id = ?').get(taskId) as
      | TaskRow
      | undefined;
  }

  private selectLedgerLocked(
    requestKey: string,
  ): { fingerprint: string; task_id: string; status: string } | undefined {
    return this.db
      .prepare('SELECT fingerprint, task_id, status FROM a2a_request_ledger WHERE request_key = ?')
      .get(requestKey) as { fingerprint: string; task_id: string; status: string } | undefined;
  }

  private ensureConversationLocked(contextId: string, nowMs: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO a2a_conversations (context_id, created_at_ms) VALUES (?, ?)')
      .run(contextId, nowMs);
  }

  private insertTaskLocked(params: {
    taskId: string;
    contextId: string;
    state: A2aTaskState;
    nowMs: number;
    statusMessage?: Message;
    metadata?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        'INSERT INTO a2a_tasks (task_id, context_id, current_state, state_version, created_at_ms, ' +
          'updated_at_ms, terminal_at_ms, status_message_json, metadata_json, cancel_intent) ' +
          'VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 0)',
      )
      .run(
        params.taskId,
        params.contextId,
        params.state,
        params.nowMs,
        params.nowMs,
        isTerminalTaskState(params.state) ? params.nowMs : null,
        jsonRef(params.statusMessage),
        jsonRef(params.metadata),
      );
  }

  private insertTurnLocked(
    taskId: string,
    turnSeq: number,
    epoch: number,
    inputMessage: Message,
    nowMs: number,
  ): void {
    this.db
      .prepare(
        "INSERT INTO a2a_turns (task_id, turn_seq, epoch, input_message_json, policy_version, " +
          "output_admission, cancel_intent, created_at_ms) VALUES (?, ?, ?, ?, ?, 'open', 0, ?)",
      )
      .run(taskId, turnSeq, epoch, JSON.stringify(inputMessage), this.policyVersion, nowMs);
  }

  private nextHistorySeqLocked(taskId: string): number {
    return (
      this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM a2a_task_history WHERE task_id = ?')
        .get(taskId) as { maxSeq: number }
    ).maxSeq + 1;
  }

  private insertHistoryLocked(taskId: string, seq: number, message: Message, nowMs: number): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO a2a_task_history (task_id, seq, message_id, message_json, created_at_ms) ' +
          'VALUES (?, ?, ?, ?, ?)',
      )
      .run(taskId, seq, message.messageId, JSON.stringify(message), nowMs);
  }

  private appendOutboxLocked(
    taskId: string,
    kind: OutboxEvent['kind'],
    payload: Record<string, unknown>,
    refs: { artifactId?: string; chunkId?: string } = {},
  ): number {
    const seq = (
      this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM a2a_outbox WHERE task_id = ?')
        .get(taskId) as { maxSeq: number }
    ).maxSeq + 1;
    this.db
      .prepare(
        'INSERT INTO a2a_outbox (task_id, seq, kind, payload_json, artifact_id, chunk_id, created_at_ms) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        taskId,
        seq,
        kind,
        JSON.stringify(payload),
        refs.artifactId ?? null,
        refs.chunkId ?? null,
        this.now(),
      );
    return seq;
  }

  private outboxEventOf(row: Record<string, unknown>): OutboxEvent {
    return {
      seq: row['seq'] as number,
      kind: row['kind'] as OutboxEvent['kind'],
      payload: JSON.parse(row['payload_json'] as string) as Record<string, unknown>,
      artifactId: (row['artifact_id'] as string | null) ?? null,
      chunkId: (row['chunk_id'] as string | null) ?? null,
      createdAtMs: row['created_at_ms'] as number,
      publishedAtMs: (row['published_at_ms'] as number | null) ?? null,
    };
  }

  /**
   * Snapshot-state sync for the SDK bridge: the STRICT transition table
   * governs every persisted state change. A stale snapshot (illegal move or
   * terminal row) never wins — the authoritative row is kept, no version
   * bump. Terminal irreversibility is additionally enforced by the DB
   * trigger (schema.ts).
   */
  private applySnapshotStateLocked(row: TaskRow, incoming: A2aTaskState): void {
    if (row.current_state === incoming) return;
    const from = row.current_state as A2aTaskState;
    if (!isLegalTaskTransition(from, incoming)) {
      return; // authoritative row wins; stale snapshot discarded
    }
    const nowMs = this.now();
    const nextVersion = row.state_version + 1;
    const changes = this.db
      .prepare(
        'UPDATE a2a_tasks SET current_state = ?, state_version = ?, updated_at_ms = ?, terminal_at_ms = ? ' +
          'WHERE task_id = ? AND current_state = ? AND state_version = ?',
      )
      .run(
        incoming,
        nextVersion,
        nowMs,
        isTerminalTaskState(incoming) ? nowMs : row.terminal_at_ms,
        row.task_id,
        row.current_state,
        row.state_version,
      ).changes;
    if (Number(changes) !== 1) {
      throw new TaskManagerError(
        'state_version_conflict',
        `Snapshot state sync lost the version race on task ${row.task_id}`,
      );
    }
    this.appendOutboxLocked(row.task_id, 'statusUpdate', {
      taskId: row.task_id,
      contextId: row.context_id,
      from,
      to: incoming,
      reason: 'sdk-bridge-snapshot',
    });
  }

  /**
   * Turns derive from USER-role history messages (agent status messages also
   * land in the SDK history but belong to the current turn's output, not to
   * a new turn). Every missing user message creates the next sequential turn
   * with epoch = turn seq.
   */
  private syncTurnsFromHistoryLocked(task: Task, nowMs: number): void {
    const userMessages = (task.history ?? []).filter((message) => message.role === Role.ROLE_USER);
    if (userMessages.length === 0) return;
    const existing = (
      this.db
        .prepare('SELECT COUNT(*) AS n FROM a2a_turns WHERE task_id = ?')
        .get(task.id) as { n: number }
    ).n;
    for (let index = existing; index < userMessages.length; index += 1) {
      const turnSeq = index + 1;
      this.insertTurnLocked(task.id, turnSeq, turnSeq, userMessages[index], nowMs);
      if (turnSeq > 1) {
        this.appendOutboxLocked(task.id, 'turnAccepted', {
          taskId: task.id,
          turnSeq,
          epoch: turnSeq,
          messageId: userMessages[index].messageId,
          source: 'sdk-bridge',
        });
      }
    }
  }

  private syncHistoryLocked(task: Task, nowMs: number): void {
    const history = task.history ?? [];
    for (let index = 0; index < history.length; index += 1) {
      this.insertHistoryLocked(task.id, index + 1, history[index], nowMs);
    }
  }

  /**
   * Append-only artifact chunk sync from the snapshot's artifact parts.
   * Admitted chunks are NEVER rewritten (公开后不改写前缀, §6.1); new parts
   * append with computed stable chunk id/position/digest and emit an Outbox
   * event in the same transaction. Body parts arriving AFTER the task is
   * terminal are a contract violation and fail the transaction (AC 3).
   */
  private syncArtifactsLocked(task: Task, nowMs: number): void {
    const artifacts = task.artifacts ?? [];
    if (artifacts.length === 0) return;
    const current = this.selectTaskLocked(task.id)!;
    const terminal = isTerminalTaskState(current.current_state as A2aTaskState);
    for (const artifact of artifacts) {
      this.ensureArtifactLocked(task.id, artifact.artifactId, artifact.name, nowMs);
      const metaRow = this.db
        .prepare('SELECT metadata_json FROM a2a_artifacts WHERE task_id = ? AND artifact_id = ?')
        .get(task.id, artifact.artifactId) as { metadata_json: string | null };
      if (artifact.metadata !== undefined && metaRow.metadata_json === null) {
        this.db
          .prepare('UPDATE a2a_artifacts SET metadata_json = ? WHERE task_id = ? AND artifact_id = ?')
          .run(JSON.stringify(artifact.metadata), task.id, artifact.artifactId);
      }
      this.db
        .prepare('UPDATE a2a_artifacts SET description = ? WHERE task_id = ? AND artifact_id = ? AND description IS NULL')
        .run(artifact.description ?? null, task.id, artifact.artifactId);
      const countRow = this.db
        .prepare('SELECT COUNT(*) AS n FROM a2a_artifact_chunks WHERE task_id = ? AND artifact_id = ?')
        .get(task.id, artifact.artifactId) as { n: number };
      const startRow = this.db
        .prepare(
          'SELECT COALESCE(MAX(end_byte), 0) AS maxEnd FROM a2a_artifact_chunks WHERE task_id = ? AND artifact_id = ?',
        )
        .get(task.id, artifact.artifactId) as { maxEnd: number };
      const parts = artifact.parts ?? [];
      if (terminal && parts.length > countRow.n) {
        throw new TaskManagerError(
          'terminal_immutable',
          `Late body chunk for terminal task ${task.id} (artifact ${artifact.artifactId}) — ` +
            'late callbacks must not append public body (TASK_LIFECYCLE §1.4/§6.2, AC 3)',
        );
      }
      let startByte = startRow.maxEnd;
      for (let index = countRow.n; index < parts.length; index += 1) {
        const part = parts[index];
        const isText = part.content?.$case === 'text';
        const text = isText ? (part.content as { $case: 'text'; value: string }).value : '';
        const partJson = isText ? null : JSON.stringify(part);
        const digest = isText ? sha256Hex(text) : sha256Hex(partJson ?? '');
        const endByte = isText ? startByte + utf8Len(text) : startByte;
        const chunkSeq = index + 1;
        const chunkId =
          (part.metadata?.['lumithinkOutput'] as { chunkId?: string } | undefined)?.chunkId ??
          `${artifact.artifactId}#chunk-${chunkSeq}`;
        const inserted = this.db
          .prepare(
            'INSERT OR IGNORE INTO a2a_artifact_chunks (task_id, artifact_id, chunk_seq, chunk_id, text, part_json, ' +
              'start_byte, end_byte, sha256, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            task.id,
            artifact.artifactId,
            chunkSeq,
            chunkId,
            text,
            partJson,
            startByte,
            endByte,
            digest,
            this.now(),
          ).changes;
        if (Number(inserted) === 1) {
          this.appendOutboxLocked(
            task.id,
            'artifactUpdate',
            {
              taskId: task.id,
              contextId: task.contextId,
              artifactId: artifact.artifactId,
              chunk: { seq: chunkSeq, chunkId, startByte, endByte, sha256: digest },
              append: chunkSeq > 1,
              source: 'sdk-bridge',
            },
            { artifactId: artifact.artifactId, chunkId },
          );
        }
        startByte = endByte;
      }
    }
  }

  private ensureArtifactLocked(
    taskId: string,
    artifactId: string,
    name: string | undefined,
    nowMs: number,
  ): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO a2a_artifacts (task_id, artifact_id, name, description, metadata_json, created_at_ms) ' +
          'VALUES (?, ?, ?, NULL, NULL, ?)',
      )
      .run(taskId, artifactId, name ?? null, nowMs);
  }

  private assertExecutionAttributionLocked(taskId: string, ref: ExecutionRef): void {
    const exec = this.db
      .prepare('SELECT * FROM a2a_executions WHERE execution_id = ? AND task_id = ?')
      .get(ref.executionId, taskId) as
      | {
          turn_seq: number;
          epoch: number;
          lease_id: string | null;
          lease_expires_at_ms: number | null;
          state: string;
        }
      | undefined;
    if (!exec || exec.turn_seq !== ref.turnSeq || exec.epoch !== ref.epoch) {
      throw new TaskManagerError(
        'execution_attribution',
        `Execution ${ref.executionId} does not match task ${taskId} / turn ${ref.turnSeq} / epoch ${ref.epoch}`,
      );
    }
    if (exec.state === 'settled' || exec.state === 'abandoned') {
      throw new TaskManagerError(
        'execution_attribution',
        `Execution ${ref.executionId} is already ${exec.state} — late callback rejected`,
      );
    }
    if (
      (exec.lease_id !== null && ref.leaseId !== undefined && exec.lease_id !== ref.leaseId) ||
      (exec.lease_expires_at_ms !== null && this.now() > exec.lease_expires_at_ms)
    ) {
      throw new TaskManagerError(
        'execution_attribution',
        `Lease for execution ${ref.executionId} is invalid or expired`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Task assembly (runtime shapes — never wire shapes, R4 guard)
  // -------------------------------------------------------------------------

  private assembleTaskFromRow(
    row: TaskRow,
    options: { includeArtifacts?: boolean; historyLength?: number } = {},
  ): Task {
    const historyAll = (
      this.db
        .prepare('SELECT message_json FROM a2a_task_history WHERE task_id = ? ORDER BY seq')
        .all(row.task_id) as { message_json: string }[]
    ).map((entry) => JSON.parse(entry.message_json) as Message);
    const history =
      options.historyLength === undefined
        ? historyAll
        : options.historyLength <= 0
          ? []
          : historyAll.slice(-options.historyLength);
    const artifacts = options.includeArtifacts === false ? [] : this.loadArtifacts(row.task_id);
    return {
      id: row.task_id,
      contextId: row.context_id,
      status: {
        state: toSdkTaskState(row.current_state as A2aTaskState),
        message: parseJsonOrNull<Message>(row.status_message_json),
        timestamp: new Date(row.updated_at_ms).toISOString(),
      },
      artifacts,
      history,
      metadata: parseJsonOrNull<Record<string, unknown>>(row.metadata_json),
    };
  }

  private loadArtifacts(taskId: string): Artifact[] {
    const artifactRows = this.db
      .prepare('SELECT * FROM a2a_artifacts WHERE task_id = ? ORDER BY created_at_ms, artifact_id')
      .all(taskId) as Record<string, unknown>[];
    return artifactRows.map((artifactRow) => {
      const artifactId = artifactRow['artifact_id'] as string;
      const chunks = this.db
        .prepare(
          'SELECT * FROM a2a_artifact_chunks WHERE task_id = ? AND artifact_id = ? ORDER BY chunk_seq',
        )
        .all(taskId, artifactId) as Record<string, unknown>[];
      const parts: Part[] = chunks.map((chunk) => {
        const partJson = chunk['part_json'] as string | null;
        if (partJson !== null) return JSON.parse(partJson) as Part;
        const part: Part = {
          content: { $case: 'text', value: chunk['text'] as string },
          metadata: undefined,
          filename: '',
          mediaType: 'text/plain',
        };
        return part;
      });
      return {
        artifactId,
        name: (artifactRow['name'] as string | null) ?? '',
        description: (artifactRow['description'] as string | null) ?? '',
        parts,
        metadata: parseJsonOrNull<Record<string, unknown>>(
          artifactRow['metadata_json'] as string | null,
        ),
        extensions: [],
      };
    });
  }

  private assertValidText(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TaskManagerError('invalid_input', `${field} must be a non-empty string`);
    }
  }
}
