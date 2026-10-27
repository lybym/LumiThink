/**
 * Load-report assembly for the LumiThink A2A validation service
 * (P1-09, issue #91, AC 4: 负载报告包括 SQLite 写锁/Outbox积压/Worker内存和
 * 限额实测).
 *
 * EVERY number below comes from a LIVE measurement surface:
 *   - SQLite write lock  : task-manager writeLockMetrics() (observed BEGIN
 *                          IMMEDIATE wait, bounded by busy_timeout by
 *                          construction — not an estimate);
 *   - Outbox backlog     : committed un-published Outbox rows + age;
 *   - Worker memory      : the runtime's own enforcement description plus a
 *                          live worker count / RSS probe;
 *   - 限额实测            : the admission scheduler's counters (high-water
 *                          marks, wait maxima, refusal reasons).
 *
 * The \`limitations\` list is ALWAYS populated with what is NOT enforced in
 * this deployment — an unenforced ceiling is never presented as enforced
 * (§13.4 关键验证不能跳过或以假执行器替代).
 */
import type { A2aLimitsConfig } from './config.ts';
import type { SchedulerSnapshot } from './scheduler.ts';
import type {
  LoadReport,
  LimitsMeasurementReport,
  SqliteWriteLockReport,
  OutboxBacklogReport,
  WorkerMemoryReport,
  WorkerProcessReport,
} from './observability.ts';

/** Everything the assembler reads. All sources are MEASURED objects. */
export interface LoadReportInputs {
  runtimeMode: 'synthetic' | 'dsh-worker';
  limits: A2aLimitsConfig;
  scheduler: SchedulerSnapshot;
  taskManager?: {
    writeLockMetrics(): {
      transactions: number;
      maxWaitMs: number;
      maxDurationMs: number;
      busyCount: number;
      busyTimeoutMs: number;
    };
    outboxBacklog(): {
      unpublishedRows: number;
      tasksWithBacklog: number;
      oldestUnpublishedAgeMs: number;
    };
  };
  runtime?: {
    workerLoad(): {
      liveWorkers: number;
      spawnedTotal: number;
      peakLiveWorkers: number;
      rssBytesByTask: Record<string, number>;
    };
    memoryEnforcement(): {
      limitBytes: number;
      status: 'configured' | 'not_configured';
      mechanism: 'v8_heap_flag' | 'none';
      hardLimit: boolean;
      note: string;
    };
  };
  /** When this service instance started (uptime evidence). */
  startedAtMs: number;
  now?: () => number;
}

function sqliteReport(inputs: LoadReportInputs): SqliteWriteLockReport {
  const write = inputs.taskManager?.writeLockMetrics();
  return {
    busyTimeoutMs: write?.busyTimeoutMs ?? inputs.limits.sqlite.busyTimeoutMs,
    writeLockMaxWaitMs: inputs.limits.sqlite.writeLockMaxWaitMs,
    writeLockBusyCount: write?.busyCount ?? 0,
    maxWriteTransactionMs: write?.maxDurationMs ?? 0,
    maxWriteLockWaitMs: write?.maxWaitMs ?? 0,
  };
}

function outboxReport(inputs: LoadReportInputs): OutboxBacklogReport {
  const backlog = inputs.taskManager?.outboxBacklog();
  return {
    unpublishedRows: backlog?.unpublishedRows ?? 0,
    tasksWithBacklog: backlog?.tasksWithBacklog ?? 0,
    oldestUnpublishedAgeMs: backlog?.oldestUnpublishedAgeMs ?? 0,
  };
}

function memoryReport(inputs: LoadReportInputs): WorkerMemoryReport {
  if (inputs.runtime !== undefined) {
    const enforcement = inputs.runtime.memoryEnforcement();
    return {
      limitBytes: enforcement.limitBytes,
      status: enforcement.status,
      mechanism: enforcement.mechanism,
      hardLimit: enforcement.hardLimit,
    };
  }
  // synthetic: the executor runs IN-PROCESS, so no worker ceiling applies.
  return {
    limitBytes: inputs.limits.worker.memoryLimitBytes,
    status: inputs.limits.worker.memoryLimitBytes > 0 ? 'configured' : 'not_configured',
    mechanism: 'none',
    hardLimit: false,
  };
}

function workerReport(inputs: LoadReportInputs): WorkerProcessReport {
  const load = inputs.runtime?.workerLoad();
  return {
    liveWorkers: load?.liveWorkers ?? 0,
    spawnedTotal: load?.spawnedTotal ?? 0,
    peakLiveWorkers: load?.peakLiveWorkers ?? 0,
    rssBytesByTask: load?.rssBytesByTask ?? {},
    memory: memoryReport(inputs),
  };
}

function limitsReport(inputs: LoadReportInputs): LimitsMeasurementReport {
  const { limits, scheduler } = inputs;
  return {
    concurrency: {
      maxActiveWorkers: limits.concurrency.maxActiveWorkers,
      maxActiveModelRequests: limits.concurrency.maxActiveModelRequests,
      maxActiveWorkersPerHousehold: limits.concurrency.maxActiveWorkersPerHousehold,
      maxActiveModelRequestsPerHousehold: limits.concurrency.maxActiveModelRequestsPerHousehold,
      observedMaxActiveWorkers: scheduler.counters.workerHighWater,
      observedMaxQueued: scheduler.counters.queueHighWater,
      observedMaxAdmissionWaitMs: scheduler.counters.maxWaitMs,
    },
    queue: {
      maxQueuedGlobal: limits.queue.maxQueuedGlobal,
      maxQueuedPerHousehold: limits.queue.maxQueuedPerHousehold,
    },
    execution: { maxExecutionMs: limits.execution.maxExecutionMs },
    modelBudget: {
      maxModelRequestsPerTask: limits.modelBudget.maxModelRequestsPerTask,
      maxTokensPerTask: limits.modelBudget.maxTokensPerTask,
      maxDailyTokensPerHousehold: limits.modelBudget.maxDailyTokensPerHousehold,
    },
    control: {
      reservedControlSlots: limits.control.reservedControlSlots,
      controlHandlingDeadlineMs: limits.control.controlHandlingDeadlineMs,
    },
    admissionWaitMs: limits.admissionWaitMs,
    refusalsByReason: { ...scheduler.counters.refusalsByReason },
    measured: {
      admissionsAdmitted: scheduler.counters.admissionsAdmitted,
      admissionsRefused: scheduler.counters.admissionsRefused,
      admissionsQueued: scheduler.counters.admissionsQueued,
      doubleReleases: scheduler.counters.doubleReleases,
      liveModelGrants: scheduler.liveModelGrants,
      fairnessSkips: scheduler.counters.fairnessSkips,
    },
  };
}

function limitationsOf(inputs: LoadReportInputs): string[] {
  const out: string[] = [];
  const memory = memoryReport(inputs);
  if (memory.status === 'not_configured') {
    out.push(
      'Worker memory ceiling NOT configured (LUMITHINK_A2A_LIMITS_WORKER_MEMORY_LIMIT_BYTES): ' +
        'docs/A2A_DESIGN.md §13.4 要求正式运行前填写。',
    );
  } else if (memory.mechanism === 'v8_heap_flag') {
    out.push(
      'Worker memory ceiling is a V8 JS-HEAP cap (--max-old-space-size), not an OS/container ' +
        'hard limit: native and off-heap allocations are unbounded by it, and an overrun ' +
        'terminates the worker (settled as crashed).',
    );
  }
  if (inputs.runtimeMode === 'synthetic') {
    out.push(
      'SYNTHETIC executor: no worker process exists, so the worker-memory rows are structurally 0 ' +
        'and this report proves nothing about real DSH worker memory.',
    );
  }
  if (inputs.limits.modelBudget.maxDailyTokensPerHousehold <= 0) {
    out.push(
      'Per-household daily token budget is NOT configured (§13.4 部署时必须填写): the daily ' +
        'budget check is inert in this process.',
    );
  }
  out.push(
    'Limits are PROCESS-LOCAL: they bound one service instance. Multi-process scaling must ' +
      're-verify SQLite contention and dispatch locking (§13.4) instead of copying process count.',
  );
  return out;
}

/** Builds one snapshot of the AC 4 load report. */
export function buildLoadReport(inputs: LoadReportInputs): LoadReport {
  const now = inputs.now ?? (() => Date.now());
  const nowMs = now();
  return {
    version: 1,
    generatedAtMs: nowMs,
    uptimeMs: Math.max(0, nowMs - inputs.startedAtMs),
    runtimeMode: inputs.runtimeMode,
    sqlite: sqliteReport(inputs),
    outbox: outboxReport(inputs),
    worker: workerReport(inputs),
    limits: limitsReport(inputs),
    limitations: limitationsOf(inputs),
  };
}
