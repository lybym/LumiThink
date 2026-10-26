/**
 * Real DSH worker subprocess runtime (P1-05, issue #87).
 *
 * Spawns REAL child processes (`node:child_process.spawn`), speaks the
 * line-JSON Runtime-Bridge contract over their stdin/stdout, and owns the
 * process lifecycle facts the Task Manager records:
 *
 *   - Worker REGISTRATION: the hello frame is validated (protocol version,
 *     kind='internal-executor', worker id) before anything else counts;
 *     external working-DSH kinds are refused (fail-closed) — the external
 *     working DSH is a CLIENT of LumiThink, never a dispatched executor.
 *   - LEASE/SESSION MAPPING: every session carries the dispatch claim keys
 *     (taskId/turnSeq/epoch/executionId/leaseId); the runtime session map is
 *     keyed by taskId so cancel dispatch reaches the right process.
 *   - Timeout & exit EVIDENCE: hello timeout (startup failure), heartbeat
 *     silence (失联), whole-execution deadline, cancel grace expiry and the
 *     raw exit code/signal are captured as body-free evidence and handed to
 *     the executor for the settlement path.
 *
 * In-memory session state is dispatch bookkeeping only — persistence stays
 * authoritative in the repository (restart recovery is P1-08/#90).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import {
  WORKER_PROTOCOL_VERSION,
  parseWorkerFrame,
  encodeRuntimeControl,
  type WorkerEvent,
  type WorkerExitEvidence,
} from './worker-protocol.ts';

/** Watchdog tick (ms): hello/lost-contact/deadline/cancel-grace checks. */
const WATCHDOG_TICK_MS = 50;
/** stderr tail cap (bytes) — diagnostics only, never body material. */
const STDERR_TAIL_BYTES = 8 * 1024;
/**
 * Bounded wait for a killed child's close event before forced-stop evidence
 * is delivered (P1-08/#90, review #106 r1 P2-2): upgrades the evidence from
 * "kill dispatched" to "death observed" (signal='SIGKILL' captured from the
 * close event) without ever making finalize unbounded.
 */
const KILL_EVIDENCE_CLOSE_WAIT_MS = 2000;

export interface DshWorkerRuntimeOptions {
  /** Worker entry script (bundled dsh-worker-entry.mjs). */
  workerEntryPath: string;
  /** Whole-execution deadline; exceeding it kills the worker (timeout). */
  executionTimeoutMs: number;
  /** Registration deadline; no valid hello in time = startup failure. */
  helloTimeoutMs: number;
  /** Heartbeat silence deadline = 失联 (lost contact). */
  lostContactMs: number;
  /** Cooperative-stop deadline after a cancel control. */
  cancelGraceMs: number;
  /** Extra env for the worker process (behavior profiles in tests). */
  workerEnv?: Record<string, string>;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface WorkerStartRequest {
  taskId: string;
  turnSeq: number;
  epoch: number;
  executionId: string;
  leaseId: string;
  /** Accepted user text (first text part of the message). */
  inputText: string;
}

export type SessionState = 'awaiting_hello' | 'running' | 'stopping' | 'closed';

/**
 * Why a session ended. 'worker_exit' = the process died on its own (clean
 * completion or crash — the exit code disambiguates); every other cause is
 * a runtime-enforced cleanup path with its own stable reason code.
 */
export type FinalizeCause =
  | 'worker_exit'
  | 'spawn_error'
  | 'hello_timeout'
  | 'bad_registration'
  | 'protocol_violation'
  | 'lost_contact'
  | 'execution_deadline'
  | 'cancel_grace_expired'
  | 'disposed';

export interface WorkerSessionHandlers {
  onWorkerEvent(event: WorkerEvent): void;
  onFinalized(evidence: WorkerExitEvidence, cause: FinalizeCause): void;
}

export interface WorkerSessionView {
  taskId: string;
  executionId: string;
  leaseId: string;
  state: SessionState;
  workerId: string | null;
  pid: number | null;
  startedAtMs: number;
  lastActivityAtMs: number;
}

interface Session {
  request: WorkerStartRequest;
  child: ChildProcess;
  state: SessionState;
  workerId: string | null;
  startedAtMs: number;
  lastActivityAtMs: number;
  canceledAtMs: number | null;
  finalized: boolean;
  watchdog: NodeJS.Timeout;
  stderrTail: string;
  handlers: WorkerSessionHandlers;
}

export class DshWorkerRuntime {
  private readonly options: DshWorkerRuntimeOptions;
  private readonly now: () => number;
  private readonly sessions = new Map<string, Session>();
  /** Pending forced-stop evidence deliveries (dispose waits for them). */
  private readonly pendingEvidence = new Set<Promise<void>>();
  private disposed = false;

  constructor(options: DshWorkerRuntimeOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** Live sessions keyed by taskId (会话映射 — one active execution per task). */
  sessionByTask(taskId: string): WorkerSessionView | undefined {
    const session = this.sessions.get(taskId);
    return session ? this.viewOf(session) : undefined;
  }

  viewOf(session: Session): WorkerSessionView {
    return {
      taskId: session.request.taskId,
      executionId: session.request.executionId,
      leaseId: session.request.leaseId,
      state: session.state,
      workerId: session.workerId,
      pid: session.child.pid ?? null,
      startedAtMs: session.startedAtMs,
      lastActivityAtMs: session.lastActivityAtMs,
    };
  }

  /**
   * Spawns the worker process and registers the session. The caller's
   * handlers receive worker events and exactly ONE finalize callback.
   *
   * Defensive duplicate-session guard (review #87 r1 P2-⑤, closed in
   * P1-07/#89): a taskId with a LIVE session must never spawn a second
   * process — one active execution per task is a repository invariant
   * (UNIQUE(task_id, epoch)) that this dispatch-side bookkeeping mirrors
   * fail-closed. The duplicate request finalizes immediately with
   * 'protocol_violation' instead of racing two children on one task id.
   */
  startExecution(request: WorkerStartRequest, handlers: WorkerSessionHandlers): void {
    if (this.disposed) {
      handlers.onFinalized(
        { exitCode: null, signal: null, killedByRuntime: false, stderrTail: '' },
        'disposed',
      );
      return;
    }
    const existing = this.sessions.get(request.taskId);
    if (existing !== undefined && !existing.finalized) {
      handlers.onFinalized(
        { exitCode: null, signal: null, killedByRuntime: false, stderrTail: '' },
        'protocol_violation',
      );
      return;
    }
    const startedAtMs = this.now();
    const child = spawn(process.execPath, [this.options.workerEntryPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.options.workerEnv },
    });
    const session: Session = {
      request,
      child,
      state: 'awaiting_hello',
      workerId: null,
      startedAtMs,
      lastActivityAtMs: startedAtMs,
      canceledAtMs: null,
      finalized: false,
      watchdog: setInterval(() => this.watchdogTick(session), WATCHDOG_TICK_MS),
      stderrTail: '',
      handlers,
    };
    this.sessions.set(request.taskId, session);

    child.on('error', (error) => {
      // Spawn failure (e.g. entry missing) = startup failure evidence.
      session.stderrTail = appendTail(session.stderrTail, String(error));
      this.finalize(session, 'spawn_error');
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      session.stderrTail = appendTail(session.stderrTail, chunk);
    });

    const rl = readline.createInterface({ input: child.stdout, terminal: false });
    rl.on('line', (line: string) => this.onWorkerLine(session, line));

    child.on('close', (exitCode, signal) => {
      if (session.finalized) return;
      // Natural exit: the exit code/signal IS the crash/completion evidence.
      this.finalize(session, 'worker_exit', { exitCode, signal });
    });

    // Start frame: the execution descriptor + input, before any worker event.
    this.writeControl(session, {
      type: 'start',
      execution: {
        taskId: request.taskId,
        turnSeq: request.turnSeq,
        epoch: request.epoch,
        executionId: request.executionId,
        leaseId: request.leaseId,
      },
      input: { text: request.inputText },
    });
  }

  /**
   * Dispatches a cancel control to the worker of ONE task. Returns false
   * when no live session exists (cancel intent is still persisted by the
   * caller — the persistence is the source of truth, not this dispatch).
   */
  cancelExecution(taskId: string, reason: string): boolean {
    const session = this.sessions.get(taskId);
    if (!session || session.finalized || session.state === 'closed') return false;
    session.state = 'stopping';
    session.canceledAtMs = this.now();
    this.writeControl(session, { type: 'cancel', reason });
    return true;
  }

  /**
   * Stops every session (service shutdown): workers are killed and every
   * executor receives its finalize callback. Resolves when all children
   * closed — no orphan processes survive stopA2aService.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    const pending = [...this.sessions.values()];
    for (const session of pending) {
      this.killSession(session);
    }
    await Promise.all(
      pending.map(
        (session) =>
          new Promise<void>((resolve) => {
            if (!session.finalized) {
              this.finalize(session, 'disposed');
            }
            // finalize() already removed the close listener path; wait for
            // the child to be gone (it was killed) with a hard bound.
            const child = session.child;
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            const guard = setTimeout(resolve, 2000);
            child.once('close', () => {
              clearTimeout(guard);
              resolve();
            });
          }),
      ),
    );
    // P2-2 evidence deliveries settle the execution rows asynchronously
    // (bounded); await them so every settlement lands BEFORE the stores
    // close (stopA2aService disposes the runtime first).
    await Promise.all([...this.pendingEvidence]);
  }

  // -------------------------------------------------------------------------

  private writeControl(session: Session, control: Parameters<typeof encodeRuntimeControl>[0]): void {
    try {
      session.child.stdin?.write(encodeRuntimeControl(control));
    } catch {
      // A dead worker's stdin throws EPIPE — the close event finalizes.
    }
  }

  private onWorkerLine(session: Session, line: string): void {
    if (session.finalized) return;
    const event = parseWorkerFrame(line);
    if (event === undefined) {
      // Unparseable/oversized frame = protocol violation, fail-closed.
      this.finalize(session, 'protocol_violation');
      return;
    }
    session.lastActivityAtMs = this.now();
    if (session.state === 'awaiting_hello') {
      if (event.type !== 'hello') {
        this.finalize(session, 'protocol_violation');
        return;
      }
      if (
        event.proto !== WORKER_PROTOCOL_VERSION ||
        event.kind !== 'internal-executor' ||
        typeof event.workerId !== 'string' ||
        event.workerId.trim().length === 0
      ) {
        // Registration refused: wrong protocol or an external working-DSH
        // kind trying to execute (docs/A2A_DESIGN.md: 内部/外部 DSH 分离).
        this.finalize(session, 'bad_registration');
        return;
      }
      session.workerId = event.workerId;
      session.state = 'running';
      session.handlers.onWorkerEvent(event);
      return;
    }
    session.handlers.onWorkerEvent(event);
  }

  /** One watchdog pass: the four real cleanup triggers. */
  private watchdogTick(session: Session): void {
    if (session.finalized) return;
    const nowMs = this.now();
    if (session.state === 'awaiting_hello' && nowMs - session.startedAtMs > this.options.helloTimeoutMs) {
      // 启动失败: never registered within the deadline.
      this.finalize(session, 'hello_timeout');
      return;
    }
    if (session.state !== 'awaiting_hello' && nowMs - session.lastActivityAtMs > this.options.lostContactMs) {
      // 失联: no frames (incl. heartbeats) within the contact window.
      this.finalize(session, 'lost_contact');
      return;
    }
    if (nowMs - session.startedAtMs > this.options.executionTimeoutMs) {
      // Whole-execution deadline.
      this.finalize(session, 'execution_deadline');
      return;
    }
    if (
      session.state === 'stopping' &&
      session.canceledAtMs !== null &&
      nowMs - session.canceledAtMs > this.options.cancelGraceMs
    ) {
      // 限期强停: the worker did not stop within the cancel grace.
      this.finalize(session, 'cancel_grace_expired');
    }
  }

  private killSession(session: Session): void {
    if (session.child.exitCode === null && session.child.signalCode === null) {
      try {
        session.child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }

  /** Single finalization: kill, detach, evidence, exactly-once callback. */
  private finalize(session: Session, cause: FinalizeCause, exit?: { exitCode: number | null; signal: string | null }): void {
    if (session.finalized) return;
    session.finalized = true;
    clearInterval(session.watchdog);
    if (cause !== 'worker_exit') {
      this.killSession(session);
    }
    session.state = 'closed';
    if (this.sessions.get(session.request.taskId) === session) {
      this.sessions.delete(session.request.taskId);
    }
    const child = session.child;
    const evidence: WorkerExitEvidence = {
      exitCode: exit?.exitCode ?? child.exitCode ?? null,
      signal: exit?.signal ?? child.signalCode ?? null,
      killedByRuntime: cause !== 'worker_exit' && cause !== 'spawn_error',
      stderrTail: session.stderrTail,
    };
    const childAlreadyClosed = child.exitCode !== null || child.signalCode !== null;
    // P1-08/#90 (review #106 r1 P2-2): on every forced-stop path the SIGKILL
    // was JUST dispatched — the child has not closed yet, so the raw child
    // fields are still null and the evidence row would carry only
    // killedByRuntime=true. Wait (bounded) for the close event and refresh
    // the evidence, so the recorded stop proof becomes the OBSERVED death
    // (signal='SIGKILL', exit code) instead of the kill dispatch. The wait
    // is tracked so dispose() can await pending settlements before the
    // stores close. 'worker_exit' evidence arrives from the close event
    // itself; 'spawn_error' never had a child; already-closed children have
    // their final fields — all three deliver immediately.
    if (cause === 'worker_exit' || cause === 'spawn_error' || childAlreadyClosed) {
      session.handlers.onFinalized(evidence, cause);
      return;
    }
    const delivery = new Promise<void>((resolve) => {
      const guard = setTimeout(resolve, KILL_EVIDENCE_CLOSE_WAIT_MS);
      child.once('close', () => {
        clearTimeout(guard);
        resolve();
      });
    }).then(() => {
      evidence.exitCode = child.exitCode ?? evidence.exitCode;
      evidence.signal = child.signalCode ?? evidence.signal;
      session.handlers.onFinalized(evidence, cause);
    });
    this.pendingEvidence.add(delivery);
    void delivery.then(
      () => this.pendingEvidence.delete(delivery),
      () => this.pendingEvidence.delete(delivery),
    );
  }
}

function appendTail(current: string, chunk: string): string {
  const merged = current + chunk;
  return merged.length <= STDERR_TAIL_BYTES ? merged : merged.slice(merged.length - STDERR_TAIL_BYTES);
}
