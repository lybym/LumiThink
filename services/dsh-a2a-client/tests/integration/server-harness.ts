/**
 * P2-02 (issue #114) — REAL a2a-server integration harness.
 *
 * Spawns the standalone entry (`services/a2a-server/src/main.ts`) as a real
 * subprocess with:
 *   - dsh-worker runtime mode (REAL DSH worker subprocesses; synthetic
 *     provider content per the P1 口径 — real-model verification is P1-10/#92);
 *   - FILE SQLite databases (task + identity) so client-side specs can read
 *     cross-process execution evidence (worker stop evidence);
 *   - a synthetic two-credential identity bootstrap (alpha + beta) for the
 *     cross-principal denial group;
 *   - loopback ephemeral port, synthetic fingerprint key, aggressive-but-
 *     stable worker watchdog tuning.
 *
 * The worker behavior profile (LUMITHINK_A2A_WORKER_BEHAVIOR) is set on the
 * SERVER process env and inherited by worker children
 * (dsh-worker-runtime spawns with `{...process.env, ...workerEnv}`).
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const SERVER_DIR = path.resolve(fileURLToPath(new URL('../../../a2a-server/', import.meta.url)));

/** Synthetic credentials (never real ones; ≥16 chars, unique digests). */
export const ALPHA_TOKEN = 'synthetic-dsh-alpha-token-0123456789abcdef';
export const BETA_TOKEN = 'synthetic-dsh-beta-token-fedcba9876543210';

export interface TwoPrincipalBootstrap {
  alphaToken: string;
  betaToken: string;
}

export function twoPrincipalBootstrapJson(options: TwoPrincipalBootstrap): string {
  return JSON.stringify({
    households: [
      { householdId: 'hh-alpha-01', displayName: 'Synthetic alpha household' },
      { householdId: 'hh-beta-02', displayName: 'Synthetic beta household' },
    ],
    users: [
      { userId: 'user-alpha-guardian', displayName: 'Synthetic alpha guardian' },
      { userId: 'user-alpha-child', displayName: 'Synthetic alpha child' },
      { userId: 'user-beta-guardian', displayName: 'Synthetic beta guardian' },
      { userId: 'user-beta-child', displayName: 'Synthetic beta child' },
    ],
    memberships: [
      { householdId: 'hh-alpha-01', userId: 'user-alpha-guardian', role: 'guardian' },
      { householdId: 'hh-alpha-01', userId: 'user-alpha-child', role: 'child' },
      { householdId: 'hh-beta-02', userId: 'user-beta-guardian', role: 'guardian' },
      { householdId: 'hh-beta-02', userId: 'user-beta-child', role: 'child' },
    ],
    relationships: [
      { householdId: 'hh-alpha-01', guardianUserId: 'user-alpha-guardian', childUserId: 'user-alpha-child' },
      { householdId: 'hh-beta-02', guardianUserId: 'user-beta-guardian', childUserId: 'user-beta-child' },
    ],
    clients: [
      { clientId: 'dsh-alpha', kind: 'dsh_profile', displayName: 'Synthetic working DSH (alpha)' },
      { clientId: 'dsh-beta', kind: 'dsh_profile', displayName: 'Synthetic working DSH (beta)' },
    ],
    credentials: [
      {
        credentialId: 'cred-dsh-alpha',
        clientId: 'dsh-alpha',
        token: options.alphaToken,
        binding: 'bound_principal',
        principalUserId: 'user-alpha-guardian',
        householdId: 'hh-alpha-01',
      },
      {
        credentialId: 'cred-dsh-beta',
        clientId: 'dsh-beta',
        token: options.betaToken,
        binding: 'bound_principal',
        principalUserId: 'user-beta-guardian',
        householdId: 'hh-beta-02',
      },
    ],
    grants: [],
  });
}

export interface StartedServer {
  base: string;
  taskDbPath: string;
  identityDbPath: string;
  dir: string;
  /** Graceful stop (SIGTERM/terminate); `crash: true` = SIGKILL hard kill. */
  stop: (options?: { crash?: boolean }) => Promise<void>;
  /** Wait for the process to exit (restart tests). */
  waitExit: () => Promise<void>;
}

export interface StartServerOptions {
  workerBehavior?: 'complete' | 'stop-on-cancel' | 'never-stops' | 'heartbeat-forever';
  workerCancelGraceMs?: number;
  workerExecutionTimeoutMs?: number;
  /** Restart scenario: reuse an existing server directory + DB files. */
  reuse?: { dir: string; taskDbPath: string; identityDbPath: string };
  /** Restart scenario: the bearer token / bootstrap of the reused directory. */
  overrideEnv?: Record<string, string>;
}

export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const dir = options.reuse?.dir ?? mkdtempSync(path.join(tmpdir(), 'dsh-a2a-int-'));
  const taskDbPath = options.reuse?.taskDbPath ?? path.join(dir, 'task.sqlite');
  const identityDbPath = options.reuse?.identityDbPath ?? path.join(dir, 'identity.sqlite');
  const ownsDir = options.reuse === undefined;
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', 'src/main.ts'],
    {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        ...options.overrideEnv,
        LUMITHINK_A2A_VALIDATION_TOKEN: ALPHA_TOKEN,
        LUMITHINK_A2A_VALIDATION_PORT: '0',
        LUMITHINK_A2A_VALIDATION_DB: taskDbPath,
        LUMITHINK_A2A_IDENTITY_DB: identityDbPath,
        LUMITHINK_A2A_FINGERPRINT_KEY: 'p2-02-integration-synthetic-fingerprint-key',
        LUMITHINK_A2A_RUNTIME_MODE: 'dsh-worker',
        LUMITHINK_A2A_IDENTITY_BOOTSTRAP: twoPrincipalBootstrapJson({ alphaToken: ALPHA_TOKEN, betaToken: BETA_TOKEN }),
        LUMITHINK_A2A_DSH_WORKER_TIMEOUT_MS: String(options.workerExecutionTimeoutMs ?? 20_000),
        LUMITHINK_A2A_DSH_WORKER_HELLO_TIMEOUT_MS: '4000',
        LUMITHINK_A2A_DSH_WORKER_LOST_CONTACT_MS: '6000',
        LUMITHINK_A2A_DSH_WORKER_CANCEL_GRACE_MS: String(options.workerCancelGraceMs ?? 1500),
        LUMITHINK_A2A_WORKER_BEHAVIOR: options.workerBehavior ?? 'complete',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk: string) => stderrChunks.push(chunk));

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  const base = await new Promise<string>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const text = stdoutChunks.join('');
      const match = text.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearInterval(timer);
        resolve(match[1]);
      } else if (Date.now() - started > 30_000) {
        clearInterval(timer);
        reject(new Error(`a2a-server did not report listening in 30s.\nstdout: ${text}\nstderr: ${stderrChunks.join('')}`));
      }
    }, 100);
  });

  return {
    base,
    taskDbPath,
    identityDbPath,
    dir,
    waitExit: () => exited,
    stop: async (options: { crash?: boolean } = {}) => {
      if (child.exitCode === null && child.signalCode === null) {
        if (options.crash) {
          // TRUE crash semantics: SIGKILL on POSIX (no graceful shutdown,
          // no runtime dispose), TerminateProcess on Windows. Used by the
          // restart-recovery test so the startup scan really sees an
          // interrupted execution (a SIGTERM would settle sessions
          // 'service_shutdown' first).
          child.kill('SIGKILL');
        } else {
          child.kill();
        }
      }
      const killer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 5000);
      await exited;
      clearTimeout(killer);
      if (ownsDir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Kills lingering worker subprocesses whose parent server already died
 * (the crash-restart test orphans one parked worker by design). Scoped to
 * the bundled worker entry path — nothing else is touched.
 */
export function killOrphanWorkers(): void {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -match 'dsh-worker-entry' } | Select-Object -ExpandProperty ProcessId"],
      { encoding: 'utf8', timeout: 10_000 },
    );
    for (const line of out.split(/\r?\n/)) {
      const pid = Number(line.trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid);
        } catch {
          // already gone
        }
      }
    }
  } catch {
    // enumeration failure is not a test failure
  }
}

// ---------------------------------------------------------------------------
// Cross-process evidence readers (read-only; the server owns all writes)
// ---------------------------------------------------------------------------

export interface ExecutionRow {
  execution_id: string;
  task_id: string;
  state: string;
  worker_id: string | null;
  settled_at_ms: number | null;
  result_json: string | null;
}

function openReadonly(dbPath: string): DatabaseSync {
  return new DatabaseSync(dbPath, { readOnly: true });
}

export function readExecutions(dbPath: string, taskId: string): ExecutionRow[] {
  const db = openReadonly(dbPath);
  try {
    return db
      .prepare('SELECT execution_id, task_id, state, worker_id, settled_at_ms, result_json FROM a2a_executions WHERE task_id = ?')
      .all(taskId) as unknown as ExecutionRow[];
  } finally {
    db.close();
  }
}

export function readTaskRow(dbPath: string, taskId: string): Record<string, unknown> | undefined {
  const db = openReadonly(dbPath);
  try {
    return db.prepare('SELECT * FROM a2a_tasks WHERE task_id = ?').get(taskId) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

export function countTasksForMessageId(dbPath: string, messageId: string): number {
  const db = openReadonly(dbPath);
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM a2a_task_history WHERE message_id = ?')
      .get(messageId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

export function readTaskBinding(identityDbPath: string, taskId: string): Record<string, unknown> | undefined {
  const db = openReadonly(identityDbPath);
  try {
    return db.prepare('SELECT * FROM a2a_identity_task_bindings WHERE task_id = ?').get(taskId) as
      | Record<string, unknown>
      | undefined;
  } finally {
    db.close();
  }
}

export function parseSettlement(execution: ExecutionRow): Record<string, unknown> {
  return JSON.parse(execution.result_json ?? '{}') as Record<string, unknown>;
}

/** Polls a predicate against the DB until it holds (bounded). */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  stepMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) assertFail('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

function assertFail(message: string): never {
  throw new Error(message);
}
