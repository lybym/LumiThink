/**
 * Service configuration for the LumiThink A2A validation service
 * (P1-01/P1-02/P1-03).
 *
 * Port 3312 is the loopback port reserved by deploy/validation for the A2A
 * validation service (issue #81 §P0-03; ownership assigned to #83 by the
 * P0-04 acceptance index §7). The host is HARD-LOCKED to 127.0.0.1: the
 * validation service must never bind a public interface.
 *
 * Fail-closed: without a bearer token the service refuses to start. Since
 * P1-03 (issue #85) that token is the synthetic credential of the default
 * validation-harness client in the identity store (two-tier Client/
 * Principal resolution); additional synthetic clients/credentials/grants
 * are provisioned through LUMITHINK_A2A_IDENTITY_BOOTSTRAP (JSON) and are
 * optional.
 */
import { fileURLToPath } from 'node:url';

export const A2A_VALIDATION_DEFAULT_PORT = 3312;
export const A2A_LOOPBACK_HOST = '127.0.0.1';
export const A2A_SUPPORTED_VERSIONS: readonly string[] = ['1.0'];
/**
 * Default SQLite Task Manager database (P1-02, issue #84). ':memory:' keeps
 * the standalone validation run stateless and CI-clean (no file writes);
 * durable validation deployments set LUMITHINK_A2A_VALIDATION_DB to a file
 * path. This is NOT DATABASE_URL — the A2A server gate keeps that variable
 * (and every provider credential) unset by contract.
 */
export const A2A_VALIDATION_DEFAULT_DB_PATH = ':memory:';
/**
 * Identity & authorization database (P1-03, issue #85). Separate store from
 * the Task Manager (ADR-0014); ':memory:' default keeps standalone runs
 * CI-clean. Durable deployments set LUMITHINK_A2A_IDENTITY_DB.
 */
export const A2A_IDENTITY_DEFAULT_DB_PATH = ':memory:';
/**
 * Independent deletion-ledger database (P1-08, issue #90; TASK_LIFECYCLE §9:
 * 删除台账独立于可回滚快照保存). ':memory:' keeps standalone/CI runs
 * stateless; durable deployments MUST set LUMITHINK_A2A_DELETION_LEDGER_DB
 * to a real file — an in-memory ledger cannot survive a crash, which would
 * leave a restored old Task-DB snapshot unguarded against resurrection.
 */
export const A2A_DELETION_LEDGER_DEFAULT_DB_PATH = ':memory:';

/**
 * HMAC key for versioned request fingerprints (P1-04, issue #86;
 * TASK_LIFECYCLE §5.4: 指纹使用服务端持久密钥的版本化 HMAC). The fixed
 * synthetic default keeps standalone/CI runs deterministic and is NOT a
 * credential (fingerprints cover ids + synthetic validation text only);
 * durable deployments MUST set LUMITHINK_A2A_FINGERPRINT_KEY so stored
 * fingerprints are not enumerable across deployments. Since #88 the "MUST"
 * is ENFORCED: falling back to this default logs a warning, and dsh-worker
 * mode refuses to start on it (review #103 r1 P2-4).
 */
export const A2A_FINGERPRINT_SYNTHETIC_DEFAULT_KEY = 'p1-04-synthetic-fingerprint-hmac-key';

/** Retention windows (P1-04 AC 4; TASK_LIFECYCLE §5.4 initial values). */
export interface A2aRetentionConfig {
  /** Auto-retry window for the ORIGINAL message (default 24h). */
  retryWindowMs: number;
  /** Full task-result retention (default 7d). */
  resultRetentionMs: number;
  /** Minimum idempotency-tombstone retention (default AND floor: 30d). */
  tombstoneRetentionMs: number;
}

/** The TASK_LIFECYCLE §5.4 initial values: 24h / 7d / 30d. */
export const A2A_RETENTION_DEFAULTS: A2aRetentionConfig = {
  retryWindowMs: 24 * 60 * 60 * 1000,
  resultRetentionMs: 7 * 24 * 60 * 60 * 1000,
  tombstoneRetentionMs: 30 * 24 * 60 * 60 * 1000,
};

/** Dispatch-lease TTL default (P1-04): 5 minutes for in-process execution. */
export const A2A_DISPATCH_LEASE_DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Executor runtime mode (P1-05, issue #87). 'synthetic' (default) keeps the
 * P1-01 protocol-only executor; 'dsh-worker' wires the REAL DSH worker
 * subprocess runtime (real spawn/hello/heartbeat/exit process mechanism,
 * synthetic provider content — real-model verification stays P1-10/#92).
 */
export type A2aRuntimeMode = 'synthetic' | 'dsh-worker';

/** Real DSH worker runtime tuning (P1-05). */
export interface A2aDshWorkerConfig {
  /** Worker entry script; default: the bundled dsh-worker-entry.mjs. */
  entryPath: string;
  /** Whole-execution deadline (kill + timeout evidence). Default 120s. */
  executionTimeoutMs: number;
  /** Worker registration deadline (startup failure). Default 10s. */
  helloTimeoutMs: number;
  /** Heartbeat silence deadline (失联). Default 15s. */
  lostContactMs: number;
  /** Cooperative-stop deadline after a cancel control. Default 5s. */
  cancelGraceMs: number;
  /** Extra env for the worker process (validation profiles). */
  workerEnv?: Record<string, string>;
}

export const A2A_DSH_WORKER_DEFAULTS: Omit<A2aDshWorkerConfig, 'entryPath'> = {
  executionTimeoutMs: 120 * 1000,
  helloTimeoutMs: 10 * 1000,
  lostContactMs: 15 * 1000,
  cancelGraceMs: 5 * 1000,
};

/** Absolute path of the bundled worker entry (lazy: import.meta context). */
export function defaultDshWorkerEntryPath(): string {
  return fileURLToPath(new URL('./runtime/dsh-worker-entry.mjs', import.meta.url));
}

export interface A2aServiceConfig {
  /** Loopback bind port; 0 lets the OS pick an ephemeral port (tests). */
  port: number;
  /** Always '127.0.0.1' — see A2A_LOOPBACK_HOST; never configurable. */
  host: typeof A2A_LOOPBACK_HOST;
  /** Synthetic validation bearer token; required, fail-closed. */
  bearerToken: string;
  /** Declared A2A protocol versions; only '1.0' (R7: never accept 0.3). */
  supportedVersions: readonly string[];
  /** SQLite Task Manager database path (issue #84); ':memory:' default. */
  dbPath: string;
  /** Identity store database path (issue #85); ':memory:' default. */
  identityDbPath: string;
  /**
   * Independent deletion-ledger database path (issue #90); ':memory:'
   * default. Durable deployments set a file path so recorded deletions
   * replay against restored snapshots before the service opens.
   */
  deletionLedgerDbPath: string;
  /** Optional JSON bootstrap for additional synthetic clients/credentials/grants. */
  identityBootstrapJson?: string;
  /** HMAC key for versioned request fingerprints (P1-04, issue #86). */
  fingerprintKey: string;
  /** Dispatch-lease TTL for the transactional claim (P1-04). */
  dispatchLeaseTtlMs: number;
  /** Retention windows: 24h retry / 7d result / ≥30d tombstone (AC 4). */
  retention: A2aRetentionConfig;
  /** Executor runtime mode (P1-05): 'synthetic' (default) | 'dsh-worker'. */
  runtimeMode: A2aRuntimeMode;
  /** Real DSH worker runtime tuning (P1-05; used in dsh-worker mode). */
  dshWorker: A2aDshWorkerConfig;
}

export function loadA2aServiceConfig(env: NodeJS.ProcessEnv = process.env): A2aServiceConfig {
  const rawPort = env.LUMITHINK_A2A_VALIDATION_PORT;
  let port = A2A_VALIDATION_DEFAULT_PORT;
  if (rawPort !== undefined && rawPort !== '') {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(
        `LUMITHINK_A2A_VALIDATION_PORT must be an integer in [0, 65535], got: ${rawPort}`,
      );
    }
  }
  const bearerToken = env.LUMITHINK_A2A_VALIDATION_TOKEN;
  if (bearerToken === undefined || bearerToken.length < 16) {
    throw new Error(
      'LUMITHINK_A2A_VALIDATION_TOKEN must be set to at least 16 characters — ' +
        'the A2A validation service refuses to start unauthenticated (fail-closed).',
    );
  }
  const rawDbPath = env.LUMITHINK_A2A_VALIDATION_DB;
  const dbPath = rawDbPath !== undefined && rawDbPath.trim() !== ''
    ? rawDbPath.trim()
    : A2A_VALIDATION_DEFAULT_DB_PATH;
  const rawIdentityDbPath = env.LUMITHINK_A2A_IDENTITY_DB;
  const identityDbPath =
    rawIdentityDbPath !== undefined && rawIdentityDbPath.trim() !== ''
      ? rawIdentityDbPath.trim()
      : A2A_IDENTITY_DEFAULT_DB_PATH;
  const rawLedgerDbPath = env.LUMITHINK_A2A_DELETION_LEDGER_DB;
  const deletionLedgerDbPath =
    rawLedgerDbPath !== undefined && rawLedgerDbPath.trim() !== ''
      ? rawLedgerDbPath.trim()
      : A2A_DELETION_LEDGER_DEFAULT_DB_PATH;
  const rawBootstrap = env.LUMITHINK_A2A_IDENTITY_BOOTSTRAP;
  const identityBootstrapJson =
    rawBootstrap !== undefined && rawBootstrap.trim() !== '' ? rawBootstrap : undefined;

  const rawFingerprintKey = env.LUMITHINK_A2A_FINGERPRINT_KEY;
  const fingerprintKeyIsDefault =
    rawFingerprintKey === undefined || rawFingerprintKey.trim() === '';
  if (fingerprintKeyIsDefault) {
    // #88 scope (review #103 r1 P2-4): running on the PUBLIC synthetic
    // default must never happen silently — warn in synthetic validation
    // mode; dsh-worker mode REFUSES to start (check below, after the mode
    // is parsed). Fingerprints persist ≥30 days and a shared public key
    // would make them enumerable across deployments (TASK_LIFECYCLE §5.4).
    console.warn(
      '[lumithink-a2a] LUMITHINK_A2A_FINGERPRINT_KEY is NOT set — using the PUBLIC ' +
        'synthetic default request-fingerprint HMAC key (P1 synthetic validation only). ' +
        'Durable deployments MUST set their own key; dsh-worker mode refuses to start without one.',
    );
  }
  const fingerprintKey = fingerprintKeyIsDefault
    ? A2A_FINGERPRINT_SYNTHETIC_DEFAULT_KEY
    : rawFingerprintKey!.trim();

  const rawLeaseTtl = env.LUMITHINK_A2A_DISPATCH_LEASE_TTL_MS;
  let dispatchLeaseTtlMs = A2A_DISPATCH_LEASE_DEFAULT_TTL_MS;
  if (rawLeaseTtl !== undefined && rawLeaseTtl !== '') {
    dispatchLeaseTtlMs = Number(rawLeaseTtl);
    if (!Number.isFinite(dispatchLeaseTtlMs) || dispatchLeaseTtlMs <= 0) {
      throw new Error(
        `LUMITHINK_A2A_DISPATCH_LEASE_TTL_MS must be a positive number, got: ${rawLeaseTtl}`,
      );
    }
  }

  // Retention windows (AC 4): 24h retry / 7d result / ≥30d tombstone. The
  // tombstone window has a HARD floor of 30 days — a configuration below it
  // refuses to start (最小墓碑至少保留 30 天, §5.4).
  const retention = { ...A2A_RETENTION_DEFAULTS };
  const rawRetryHours = env.LUMITHINK_A2A_RETENTION_RETRY_HOURS;
  if (rawRetryHours !== undefined && rawRetryHours !== '') {
    const hours = Number(rawRetryHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      throw new Error(
        `LUMITHINK_A2A_RETENTION_RETRY_HOURS must be a positive number, got: ${rawRetryHours}`,
      );
    }
    retention.retryWindowMs = hours * 60 * 60 * 1000;
  }
  const rawResultDays = env.LUMITHINK_A2A_RETENTION_RESULT_DAYS;
  if (rawResultDays !== undefined && rawResultDays !== '') {
    const days = Number(rawResultDays);
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error(
        `LUMITHINK_A2A_RETENTION_RESULT_DAYS must be a positive number, got: ${rawResultDays}`,
      );
    }
    retention.resultRetentionMs = days * 24 * 60 * 60 * 1000;
  }
  const rawTombstoneDays = env.LUMITHINK_A2A_RETENTION_TOMBSTONE_DAYS;
  if (rawTombstoneDays !== undefined && rawTombstoneDays !== '') {
    const days = Number(rawTombstoneDays);
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error(
        `LUMITHINK_A2A_RETENTION_TOMBSTONE_DAYS must be a positive number, got: ${rawTombstoneDays}`,
      );
    }
    retention.tombstoneRetentionMs = days * 24 * 60 * 60 * 1000;
  }
  if (retention.tombstoneRetentionMs < A2A_RETENTION_DEFAULTS.tombstoneRetentionMs) {
    throw new Error(
      `LUMITHINK_A2A_RETENTION_TOMBSTONE_DAYS is below the 30-day minimum tombstone ` +
        `(got ${(retention.tombstoneRetentionMs / (24 * 60 * 60 * 1000)).toString()} days); ` +
        'the service refuses to start with a weaker retention contract (TASK_LIFECYCLE §5.4).',
    );
  }

  // Runtime mode (P1-05): 'synthetic' (default) | 'dsh-worker'. Anything
  // else refuses to start (fail-closed).
  const rawRuntimeMode = env.LUMITHINK_A2A_RUNTIME_MODE;
  let runtimeMode: A2aRuntimeMode = 'synthetic';
  if (rawRuntimeMode !== undefined && rawRuntimeMode !== '') {
    if (rawRuntimeMode !== 'synthetic' && rawRuntimeMode !== 'dsh-worker') {
      throw new Error(
        `LUMITHINK_A2A_RUNTIME_MODE must be 'synthetic' or 'dsh-worker', got: ${rawRuntimeMode}`,
      );
    }
    runtimeMode = rawRuntimeMode;
  }
  // #88 scope (review #103 r1 P2-4): fail-closed fingerprint key in the
  // REAL worker mode. The synthetic default is public knowledge; persisted
  // fingerprints made with it are dictionary-enumerable, which violates
  // TASK_LIFECYCLE §5.4 for anything beyond the synthetic validation text.
  if (fingerprintKeyIsDefault && runtimeMode === 'dsh-worker') {
    throw new Error(
      'LUMITHINK_A2A_FINGERPRINT_KEY must be set when LUMITHINK_A2A_RUNTIME_MODE=dsh-worker: ' +
        'request fingerprints are versioned HMAC digests persisted for at least 30 days, and ' +
        'running on the public synthetic default key would make them enumerable across ' +
        'deployments (review #103 r1 P2-4; TASK_LIFECYCLE §5.4).',
    );
  }
  const positiveInt = (raw: string | undefined, fallback: number, label: string): number => {
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${label} must be a positive number, got: ${raw}`);
    }
    return value;
  };
  const dshWorker: A2aDshWorkerConfig = {
    entryPath:
      env.LUMITHINK_A2A_DSH_WORKER_ENTRY !== undefined && env.LUMITHINK_A2A_DSH_WORKER_ENTRY.trim() !== ''
        ? env.LUMITHINK_A2A_DSH_WORKER_ENTRY.trim()
        : defaultDshWorkerEntryPath(),
    executionTimeoutMs: positiveInt(
      env.LUMITHINK_A2A_DSH_WORKER_TIMEOUT_MS,
      A2A_DSH_WORKER_DEFAULTS.executionTimeoutMs,
      'LUMITHINK_A2A_DSH_WORKER_TIMEOUT_MS',
    ),
    helloTimeoutMs: positiveInt(
      env.LUMITHINK_A2A_DSH_WORKER_HELLO_TIMEOUT_MS,
      A2A_DSH_WORKER_DEFAULTS.helloTimeoutMs,
      'LUMITHINK_A2A_DSH_WORKER_HELLO_TIMEOUT_MS',
    ),
    lostContactMs: positiveInt(
      env.LUMITHINK_A2A_DSH_WORKER_LOST_CONTACT_MS,
      A2A_DSH_WORKER_DEFAULTS.lostContactMs,
      'LUMITHINK_A2A_DSH_WORKER_LOST_CONTACT_MS',
    ),
    cancelGraceMs: positiveInt(
      env.LUMITHINK_A2A_DSH_WORKER_CANCEL_GRACE_MS,
      A2A_DSH_WORKER_DEFAULTS.cancelGraceMs,
      'LUMITHINK_A2A_DSH_WORKER_CANCEL_GRACE_MS',
    ),
  };

  return {
    port,
    host: A2A_LOOPBACK_HOST,
    bearerToken,
    supportedVersions: A2A_SUPPORTED_VERSIONS,
    dbPath,
    identityDbPath,
    deletionLedgerDbPath,
    identityBootstrapJson,
    fingerprintKey,
    dispatchLeaseTtlMs,
    retention,
    runtimeMode,
    dshWorker,
  };
}
