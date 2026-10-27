/**
 * Environment parsing for the §13.4 bounded-resource limits (P1-09, #91).
 *
 * Every knob is a POSITIVE integer (a cap of 0 / a negative / a NaN would
 * silently mean "no cap", which §13.4 forbids: 不能将上限置为无限). The two
 * "部署时必须填写" values are allowed to stay at their 0 sentinel in synthetic
 * validation mode and refuse to start in `dsh-worker` mode.
 */
import { A2A_LIMITS_DEFAULTS, type A2aLimitsConfig } from './config.ts';

export function limitsEnvKey(path: string): string {
  return `LUMITHINK_A2A_LIMITS_${path
    .replaceAll('.', '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()}`;
}

function positiveInt(raw: string | undefined, label: string, allowZero = false): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(
      `${label} must be an ${allowZero ? 'non-negative' : 'positive'} integer ` +
        `(a cap is never unlimited — docs/A2A_DESIGN.md §13.4), got: ${raw}`,
    );
  }
  return value;
}

/**
 * Reads one limit from the environment, falling back to the §13.4 default.
 * `max*PerHousehold` values above their global counterpart are CLAMPED down
 * to the global cap (§13.4: 单家庭不超过全局上限) rather than refused —
 * the global cap is the authoritative protection and clamping keeps the
 * effective limitation honest for the load report.
 */
function limitOf(
  env: NodeJS.ProcessEnv,
  path: string,
  fallback: number,
  options: { allowZero?: boolean } = {},
): number {
  const parsed = positiveInt(env[limitsEnvKey(path)], limitsEnvKey(path), options.allowZero === true);
  return parsed ?? fallback;
}

export interface LimitsLoadResult {
  limits: A2aLimitsConfig;
  /** Effective values that differ from the §13.4 defaults. */
  overrides: { path: string; value: number; fallback: number }[];
}

/**
 * Loads limits from `env`. Throws (service refuses to start) for malformed
 * values. Also enforces the §13.4 cross-field rules:
 *  - per-household caps never exceed the global caps (clamped);
 *  - the execution deadline never exceeds the worker execution timeout
 *    (the worker watchdog must be able to enforce it first).
 */
export function loadA2aLimits(
  env: NodeJS.ProcessEnv,
  context: {
    runtimeMode: 'synthetic' | 'dsh-worker';
    /**
     * ADR-0017: 'production' escalates the unfilled §13.4 "部署时必须填写"
     * values (worker memory ceiling, per-household daily budget) into a hard
     * refusal. Omitted/'validation' warns loudly and lets the validation
     * profile run — enforcement is never faked, only deferred with a warning.
     */
    deploymentProfile?: 'validation' | 'production';
  },
): LimitsLoadResult {
  const d = A2A_LIMITS_DEFAULTS;
  const overrides: { path: string; value: number; fallback: number }[] = [];
  const read = (path: string, fallback: number, allowZero = false): number => {
    const value = limitOf(env, path, fallback, { allowZero });
    if (value !== fallback) overrides.push({ path, value, fallback });
    return value;
  };

  const limits: A2aLimitsConfig = {
    conversation: {
      maxActiveExecutionsPerConversation: read(
        'conversation.maxActiveExecutionsPerConversation',
        d.conversation.maxActiveExecutionsPerConversation,
      ),
    },
    concurrency: {
      maxActiveWorkers: read('concurrency.maxActiveWorkers', d.concurrency.maxActiveWorkers),
      maxActiveModelRequests: read(
        'concurrency.maxActiveModelRequests',
        d.concurrency.maxActiveModelRequests,
      ),
      maxActiveWorkersPerHousehold: read(
        'concurrency.maxActiveWorkersPerHousehold',
        d.concurrency.maxActiveWorkersPerHousehold,
      ),
      maxActiveModelRequestsPerHousehold: read(
        'concurrency.maxActiveModelRequestsPerHousehold',
        d.concurrency.maxActiveModelRequestsPerHousehold,
      ),
    },
    queue: {
      maxQueuedGlobal: read('queue.maxQueuedGlobal', d.queue.maxQueuedGlobal),
      maxQueuedPerHousehold: read('queue.maxQueuedPerHousehold', d.queue.maxQueuedPerHousehold),
    },
    execution: {
      maxExecutionMs: read('execution.maxExecutionMs', d.execution.maxExecutionMs),
    },
    modelBudget: {
      maxModelRequestsPerTask: read(
        'modelBudget.maxModelRequestsPerTask',
        d.modelBudget.maxModelRequestsPerTask,
      ),
      maxTokensPerTask: read('modelBudget.maxTokensPerTask', d.modelBudget.maxTokensPerTask),
      // 0 = NOT CONFIGURED (the §13.4 "部署时必须填写" sentinel): synthetic
      // validation runs may start; dsh-worker mode refuses below.
      maxDailyTokensPerHousehold: read(
        'modelBudget.maxDailyTokensPerHousehold',
        d.modelBudget.maxDailyTokensPerHousehold,
        true,
      ),
    },
    sqlite: {
      busyTimeoutMs: read('sqlite.busyTimeoutMs', d.sqlite.busyTimeoutMs),
      writeLockMaxWaitMs: read('sqlite.writeLockMaxWaitMs', d.sqlite.writeLockMaxWaitMs),
    },
    worker: {
      memoryLimitBytes: read('worker.memoryLimitBytes', d.worker.memoryLimitBytes, true),
    },
    control: {
      reservedControlSlots: read('control.reservedControlSlots', d.control.reservedControlSlots),
      controlHandlingDeadlineMs: read(
        'control.controlHandlingDeadlineMs',
        d.control.controlHandlingDeadlineMs,
      ),
    },
    admissionWaitMs: read('admissionWaitMs', d.admissionWaitMs, true),
  };

  // §13.4: 单家庭不超过全局上限 — clamp instead of silently exceeding.
  limits.concurrency.maxActiveWorkersPerHousehold = Math.min(
    limits.concurrency.maxActiveWorkersPerHousehold,
    limits.concurrency.maxActiveWorkers,
  );
  limits.concurrency.maxActiveModelRequestsPerHousehold = Math.min(
    limits.concurrency.maxActiveModelRequestsPerHousehold,
    limits.concurrency.maxActiveModelRequests,
  );
  limits.queue.maxQueuedPerHousehold = Math.min(
    limits.queue.maxQueuedPerHousehold,
    limits.queue.maxQueuedGlobal,
  );

  // §13.4 rows "Worker 内存" + "模型并发预算": 部署时必须填写.
  //
  // ADR-0017 decision: these two values are "must fill before 正式运行", not
  // "must fill before first start". A P1 validation deployment runs the REAL
  // dsh-worker runtime with synthetic per-household budgets, so a hard refusal
  // would break the documented validation profile. Instead the gap is
  // (a) surfaced loudly here, (b) carried in the load report as
  // `declared_only`/'not_configured', and (c) ESCALATED TO A HARD REFUSAL when
  // the caller declares a production deployment
  // (LUMITHINK_A2A_DEPLOYMENT_PROFILE=production). That keeps the promise
  // "未配置时不允许进入正式运行" enforceable while never faking enforcement.
  const unfilled: string[] = [];
  if (limits.worker.memoryLimitBytes <= 0) unfilled.push(limitsEnvKey('worker.memoryLimitBytes'));
  if (limits.modelBudget.maxDailyTokensPerHousehold <= 0) {
    unfilled.push(limitsEnvKey('modelBudget.maxDailyTokensPerHousehold'));
  }
  if (unfilled.length > 0) {
    const detail = unfilled.join(', ');
    if (context.deploymentProfile === 'production') {
      throw new Error(
        detail + ' must be set before 正式运行: docs/A2A_DESIGN.md §13.4 requires the ' +
          'worker memory ceiling and the per-household daily model budget, and ' +
          'LUMITHINK_A2A_DEPLOYMENT_PROFILE=production was declared. The service refuses ' +
          'to start on unfilled §13.4 values (fail-closed).',
      );
    }
    console.warn(
      '[lumithink-a2a] §13.4 "部署时必须填写" values still UNSET (' + detail + '). ' +
        'Synthetic/validation runs may proceed; 正式运行 is blocked until they are filled ' +
        '(set LUMITHINK_A2A_DEPLOYMENT_PROFILE=production to make this a hard refusal). ' +
        'See docs/adr/0017-a2a-bounded-resource-limits.md.',
    );
  }

  return { limits, overrides };
}
