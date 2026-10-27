/**
 * Content-minimized structured observability + load report for the LumiThink
 * A2A validation service (P1-09, issue #91; docs/A2A_DESIGN.md §13.2 可观测性,
 * §13.4 容量与执行隔离; ADR-0017).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ AC 3: records Task / Turn / Execution / epoch / version / duration /    │
 * │ error — and NEVER the private body (message text, artifact chunks,     │
 * │ history) or a credential (bearer token, HMAC key, credential id hash). │
 * │ AC 4: the load report carries SQLite write-lock pressure, Outbox       │
 * │ backlog, Worker memory and the MEASURED limits (never an estimate).    │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Design rules encoded here:
 *  1. The event schema is a CLOSED allow-list of scalar/identifier fields.
 *     `emit()` copies field by field, so a caller that accidentally passes a
 *     body string cannot leak it — an unknown key is DROPPED, not serialized.
 *  2. Every event carries the correlation chain (taskId/contextId/householdId),
 *     so the chain 渠道消息 -> Conversation -> Task -> Turn -> Runtime 执行 can
 *     be reconstructed (design §13.2).
 *  3. The sink is pluggable: production writes one JSON line per event to
 *     stdout; tests capture into an array. stdout is never used as IPC here.
 *  4. Memory readings are MEASURED (process.memoryUsage) and clearly marked
 *     with their source; a declared-but-unenforced ceiling is reported as
 *     `enforcement: 'declared_only'` instead of pretending to be enforced.
 */

/** Event severity. 'info' is the normal path, 'warn'/'error' are anomalies. */
export type ObservabilityLevel = 'info' | 'warn' | 'error';

/**
 * The closed set of structured event names. Each name is a stable contract
 * that the tests and docs pin; adding one is an additive change.
 */
export type ObservabilityEventName =
  | 'admission.decided'
  | 'execution.started'
  | 'execution.finished'
  | 'execution.deadline_exceeded'
  | 'task.turn_appended'
  | 'task.settled'
  | 'cancel.decided'
  | 'control.handled'
  | 'limits.snapshot'
  | 'load.report';

/**
 * The allow-listed field set of a structured event. Everything is an
 * identifier, an enum-ish code, a count, a duration or a byte size — there
 * is deliberately NO field that can carry private text.
 */
export interface ObservabilityEvent {
  /** Monotonic per-process sequence (ordering evidence). */
  seq: number;
  /** Wall-clock time of the record (ms epoch). */
  atMs: number;
  level: ObservabilityLevel;
  event: ObservabilityEventName;
  /** Correlation chain (design §13.2). */
  taskId?: string;
  contextId?: string;
  householdId?: string;
  principalKind?: string;
  clientKind?: string;
  /** Turn/execution attribution (AC 3). */
  turnSeq?: number;
  executionId?: string;
  epoch?: number;
  /** Persisted state version at decision time (AC 3 版本). */
  stateVersion?: number;
  /** Stable application reason/decision code (never free text). */
  reason?: string;
  decision?: 'allow' | 'deny' | 'queued' | 'refused' | 'admitted';
  /** Measured durations (AC 3 耗时). */
  durationMs?: number;
  waitedMs?: number;
  queueDepth?: number;
  activeWorkers?: number;
  /** Reserved-token accounting (budget evidence, never content). */
  tokensReserved?: number;
  /** Error class name only — never error.message (may embed user text). */
  errorKind?: string;
}

/** Writes ONE emitted event. Must never throw into the caller's path. */
export type ObservabilitySink = (event: ObservabilityEvent) => void;

/** JSON-line sink (one object per line, stable key order). */
export function jsonLineSink(write: (line: string) => void): ObservabilitySink {
  return (event) => {
    try {
      write(JSON.stringify(event));
    } catch {
      // Observability must never break a request path.
    }
  };
}

/** In-memory sink for tests and the load report's recent-slice. */
export function memorySink(limit = 200): {
  sink: ObservabilitySink;
  events: ObservabilityEvent[];
} {
  const events: ObservabilityEvent[] = [];
  const sink: ObservabilitySink = (event) => {
    events.push(event);
    if (events.length > limit) events.splice(0, events.length - limit);
  };
  return { sink, events };
}

/**
 * Fields the recorder is willing to persist. A key absent here is DROPPED:
 * this is the structural half of "不落正文与凭据" (fixing the leak class beats
 * trying to redact every possible string).
 */
const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'taskId',
  'contextId',
  'householdId',
  'principalKind',
  'clientKind',
  'turnSeq',
  'executionId',
  'epoch',
  'stateVersion',
  'reason',
  'decision',
  'durationMs',
  'waitedMs',
  'queueDepth',
  'activeWorkers',
  'tokensReserved',
  'errorKind',
]);

export interface EmitInput {
  level?: ObservabilityLevel;
  event: ObservabilityEventName;
  [key: string]: unknown;
}

export class ObservabilityRecorder {
  private readonly sinks: ObservabilitySink[];
  private readonly now: () => number;
  private seq = 0;
  /** Counters of dropped fields, so a (test-only) misuse stays visible. */
  private droppedFields = 0;

  constructor(options: { sinks?: ObservabilitySink[]; now?: () => number } = {}) {
    this.sinks = options.sinks ?? [];
    this.now = options.now ?? (() => Date.now());
  }

  /** Emits ONE structured event. Unknown keys are dropped, never written. */
  emit(input: EmitInput): ObservabilityEvent {
    this.seq += 1;
    const event: ObservabilityEvent = {
      seq: this.seq,
      atMs: this.now(),
      level: input.level ?? 'info',
      event: input.event,
    };
    for (const [key, value] of Object.entries(input)) {
      if (key === 'level' || key === 'event') continue;
      if (!ALLOWED_FIELDS.has(key)) {
        this.droppedFields += 1;
        continue;
      }
      if (value === undefined) continue;
      (event as unknown as Record<string, unknown>)[key] = value;
    }
    for (const sink of this.sinks) {
      try {
        sink(event);
      } catch {
        // A failing sink never breaks the request path.
      }
    }
    return event;
  }

  /** Records a thrown error by CLASS NAME only (message may carry content). */
  emitError(event: ObservabilityEventName, error: unknown, input: EmitInput): ObservabilityEvent {
    const errorKind =
      error instanceof Error ? error.constructor.name : typeof error === 'string' ? 'string' : 'unknown';
    return this.emit({ ...input, event, level: 'error', errorKind });
  }

  get droppedFieldCount(): number {
    return this.droppedFields;
  }
}

// ---------------------------------------------------------------------------
// Load report (AC 4)
// ---------------------------------------------------------------------------

/**
 * Worker memory limit as DECLARED, while its enforcement status stays
 * honest. A memory ceiling is applied to real worker subprocesses through
 * the V8 heap flag (`--max-old-space-size`), which caps the JS heap — it
 * does NOT cap native/off-heap allocations or RSS, so the report says
 * exactly which mechanism ran and what it can fail to catch.
 */
export interface WorkerMemoryReport {
  /** Declared per-worker memory limit in bytes (0 = NOT configured). */
  limitBytes: number;
  /** 'configured' | 'not_configured'. */
  status: 'configured' | 'not_configured';
  /**
   * How the ceiling is applied to a worker process:
   *  - 'v8_heap_flag': `--max-old-space-size` passed to the worker.
   *  - 'none': no mechanism ran (synthetic in-process executor).
   */
  mechanism: 'v8_heap_flag' | 'none';
  /**
   * Whether the ceiling is a hard OS-level cap. V8 heap flag = false (heap
   * only): native buffers / RSS can exceed it, and an OOM kill surfaces as a
   * worker crash (settled as crashed) instead of a clean enforcement.
   */
  hardLimit: boolean;
}

export interface SqliteWriteLockReport {
  /** Configured busy_timeout for every write transaction (ms). */
  busyTimeoutMs: number;
  /** Configured overall write-lock wait budget (ms; §13.4 锁等待与重试最多 5 秒). */
  writeLockMaxWaitMs: number;
  /** Observed write-lock busy failures (bounded, mapped to WRITE_LOCK_BUSY). */
  writeLockBusyCount: number;
  /** Longest measured single write-transaction duration (ms). NOT a lock wait
   *  estimate: it is directly observed around the BEGIN IMMEDIATE/COMMIT pair. */
  maxWriteTransactionMs: number;
  /** Longest observed wait for the write lock in this process (ms) — the
   *  busiest single transaction, which is the bounded unit (§13.4). */
  maxWriteLockWaitMs: number;
}

export interface OutboxBacklogReport {
  /** Outbox rows not yet published (aggregate across tasks). */
  unpublishedRows: number;
  /** Distinct tasks holding at least one unpublished row. */
  tasksWithBacklog: number;
  /** Oldest unpublished row age (ms); 0 when the backlog is empty. */
  oldestUnpublishedAgeMs: number;
}

export interface WorkerProcessReport {
  /** Live worker subprocesses right now. */
  liveWorkers: number;
  /** Worker processes spawned since start. */
  spawnedTotal: number;
  /** Highest simultaneous worker count (workerHighWater). */
  peakLiveWorkers: number;
  /** Worker RSS readings, when the runtime can read them. */
  rssBytesByTask: Record<string, number>;
  /** Independent handler-wiring diagnostics (nothing else). */
  memory: WorkerMemoryReport;
}

/** The §13.4 limit values as actually CONFIGURED in this process. */
export interface LimitsMeasurementReport {
  concurrency: {
    maxActiveWorkers: number;
    maxActiveModelRequests: number;
    maxActiveWorkersPerHousehold: number;
    maxActiveModelRequestsPerHousehold: number;
    /** Measured high-water of active workers. */
    observedMaxActiveWorkers: number;
    /** Measured high-water of queued admissions. */
    observedMaxQueued: number;
    /** Measured longest granted queue wait (ms). */
    observedMaxAdmissionWaitMs: number;
  };
  queue: { maxQueuedGlobal: number; maxQueuedPerHousehold: number };
  execution: { maxExecutionMs: number };
  modelBudget: {
    maxModelRequestsPerTask: number;
    maxTokensPerTask: number;
    maxDailyTokensPerHousehold: number;
  };
  control: { reservedControlSlots: number; controlHandlingDeadlineMs: number };
  admissionWaitMs: number;
  /** Refusals observed by stable reason (MEASURED, not configured). */
  refusalsByReason: Record<string, number>;
  /** Counters the limits layer measured. */
  measured: {
    admissionsAdmitted: number;
    admissionsRefused: number;
    admissionsQueued: number;
    doubleReleases: number;
    liveModelGrants: number;
    fairnessSkips: number;
  };
}

export interface LoadReport {
  version: 1;
  generatedAtMs: number;
  uptimeMs: number;
  runtimeMode: 'synthetic' | 'dsh-worker';
  /** Every number below is MEASURED in this process (AC 4). */
  sqlite: SqliteWriteLockReport;
  outbox: OutboxBacklogReport;
  worker: WorkerProcessReport;
  limits: LimitsMeasurementReport;
  /**
   * Explicit honesty block: what this report does NOT cover. Reviewed at
   * every gate — an unenforced ceiling is never silently presented as
   * enforced (§13.4 关键验证不能跳过或以假执行器替代).
   */
  limitations: string[];
}
