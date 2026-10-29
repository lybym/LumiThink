/**
 * P2-05 dual-channel reliability & permission regression (issue #117).
 *
 * JOINT harness — the issue's non-negotiable: 不得以两个渠道各自单独测试
 * 通过代替联合测试. ONE shared REAL a2a-server stack (dsh-worker runtime
 * with REAL worker subprocesses, FILE SQLite, combined identity bootstrap
 * injecting BOTH the working-DSH `dsh_profile` credential AND the
 * `xiaozhi_device` credential — all synthetic) is driven by TWO INDEPENDENT
 * clients under concurrency/interleaving:
 *
 *   - Channel A (工作 DSH): the REAL P2-02 `DshA2aClient`
 *     (services/dsh-a2a-client) running in this process, talking to the
 *     server over the HTTP wire with its own durable ledger file.
 *   - Channel B (小智): the REAL P2-03 `XiaozhiA2AProvider` (official
 *     a2a-sdk==1.2.3 client inside) driven through a JSON-lines runner
 *     subprocess (services/xiaozhi-a2a-provider/tests/p2_05_runner.py).
 *     No provider behavior code is changed; the runner exercises the public
 *     integration face exactly like the P2-03 suite does.
 *
 * The 9 issue groups map to the tests below (G1…G9); every test records its
 * channel combination and interleaving in its header comment and asserts
 * channel-attributed evidence (task ids, execution rows, delivery
 * watermarks, wire error codes) on BOTH channels.
 *
 * Harness shape (honest boundaries, all declared in the regression report):
 *   - Default service = in-process `startA2aService` (the REAL composed
 *     stack: real express+SDK HTTP, real SQLite files, real DshWorkerRuntime
 *     spawning real worker subprocesses). This is the P1-05/07/08 service-
 *     level precedent and the only way the in-process revocation/deletion
 *     authority (`service.identity`, `purgeProcessingScope`) can act — there
 *     is no wire API for those operations.
 *   - G4 server-restart uses a SPAWNED real service (the P1-08 restartable
 *     fixture) so the crash is a genuine SIGKILL of a separate process, then
 *     restarts in-process on the SAME SQLite files at the SAME loopback port
 *     (P1-08 real crash-restart precedent).
 *   - G6 injects REAL transport-level SSE loss: both channels' traffic rides
 *     a transparent loopback TCP proxy and cutAll() destroys every live
 *     connection at one instant.
 *
 * Wire semantics pinned by the locked SDK (verified in dist/server): a
 * non-streaming SendMessage with `configuration.returnImmediately=true`
 * returns the FIRST result (acceptance snapshot) — the DSH client's §7.4
 * handle; CancelTask responds only after the terminal event, so the
 * cancel×completion race result is part of the response (§7.2).
 *
 * Install-surface note (a2a-server gate runs `pnpm test` with ONLY this
 * package installed): the two isolated packages (docs/adr/0013) pin the same
 * `@a2a-js/sdk@1.3.0`. When the sibling `services/dsh-a2a-client` has no
 * node_modules (a2a-server gate job), the harness creates a junction from
 * the sibling's node_modules to THIS package's node_modules so the client's
 * single dependency resolves; `node_modules/` is gitignored and the junction
 * is removed at process exit. No install surface changes, nothing outside
 * tests/ is committed.
 *
 * Zero SKIP: a missing Python interpreter / official a2a-sdk / Node is an
 * explicit failure with a remedy message, never a skip. Everything is
 * loopback + synthetic; no real credentials, no real audio, no UDS, no
 * lumithink-data access.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, symlinkSync, writeSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { startA2aService, stopA2aService, type StartedA2aService } from '../src/a2a-service.ts';
import { SqliteTaskManager } from '../src/task-manager/sqlite-task-manager.ts';
import { purgeProcessingScope } from '../src/recovery/data-deletion.ts';
import { A2A_LIMITS_DEFAULTS } from '../src/limits/config.ts';
import type { IdentityBootstrap } from '../src/identity/identity-store.ts';
import { rpcResultOf, testConfig, userMessage } from './helpers.ts';

const WORKER_ENTRY = fileURLToPath(new URL('../src/runtime/dsh-worker-entry.mjs', import.meta.url));
const RESTARTABLE_ENTRY = fileURLToPath(new URL('./fixtures/p1-08-restartable-service.ts', import.meta.url));
const RUNNER_SCRIPT = fileURLToPath(new URL('../../xiaozhi-a2a-provider/tests/p2_05_runner.py', import.meta.url));

/** Synthetic credentials (never real; ≥16 chars, unique digests). */
const ALPHA_TOKEN = 'synthetic-p2-05-dsh-alpha-token-0123456789abcdef';
const DEVICE_TOKEN = 'synthetic-p2-05-xiaozhi-device-token-0123456789';
const FINGERPRINT_KEY = 'p2-05-dual-channel-synthetic-fingerprint-key';

/** Aggressive-but-stable dsh-worker tuning (P1-07/08 rationale; CI-safe). */
const TUNING = {
  entryPath: WORKER_ENTRY,
  executionTimeoutMs: 20_000,
  helloTimeoutMs: 2_000,
  lostContactMs: 5_000,
  cancelGraceMs: 800,
};

function dualChannelBootstrap(): IdentityBootstrap {
  return {
    households: [
      { householdId: 'hh-alpha-01', displayName: 'P2-05 synthetic alpha household' },
      { householdId: 'hh-xiaozhi-01', displayName: 'P2-05 synthetic xiaozhi household' },
    ],
    users: [
      { userId: 'user-alpha-guardian', displayName: 'Synthetic alpha guardian' },
      { userId: 'user-alpha-child', displayName: 'Synthetic alpha child' },
      { userId: 'user-xz-guardian', displayName: 'Synthetic xiaozhi guardian' },
      { userId: 'user-xz-child', displayName: 'Synthetic xiaozhi child' },
    ],
    memberships: [
      { householdId: 'hh-alpha-01', userId: 'user-alpha-guardian', role: 'guardian' },
      { householdId: 'hh-alpha-01', userId: 'user-alpha-child', role: 'child' },
      { householdId: 'hh-xiaozhi-01', userId: 'user-xz-guardian', role: 'guardian' },
      { householdId: 'hh-xiaozhi-01', userId: 'user-xz-child', role: 'child' },
    ],
    relationships: [
      { householdId: 'hh-alpha-01', guardianUserId: 'user-alpha-guardian', childUserId: 'user-alpha-child' },
      { householdId: 'hh-xiaozhi-01', guardianUserId: 'user-xz-guardian', childUserId: 'user-xz-child' },
    ],
    clients: [
      { clientId: 'dsh-alpha', kind: 'dsh_profile', displayName: 'Synthetic working DSH (alpha)' },
      {
        clientId: 'xiaozhi-dev-01',
        kind: 'xiaozhi_device',
        displayName: 'Synthetic xiaozhi device (household-bound)',
        householdId: 'hh-xiaozhi-01',
      },
    ],
    credentials: [
      {
        credentialId: 'cred-dsh-alpha',
        clientId: 'dsh-alpha',
        token: ALPHA_TOKEN,
        binding: 'bound_principal',
        principalUserId: 'user-alpha-guardian',
        householdId: 'hh-alpha-01',
      },
      {
        credentialId: 'cred-xiaozhi-device',
        clientId: 'xiaozhi-dev-01',
        token: DEVICE_TOKEN,
        binding: 'client_only',
        householdId: 'hh-xiaozhi-01',
      },
    ],
    grants: [],
  };
}

function tempDir(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `a2a-p2-05-${label}-`));
}

function removeTempDir(dir: string): void {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      return;
    } catch {
      // retry; the temp dir is disposable
    }
  }
}

async function waitFor(
  probe: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) return;
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function wireMessage(messageId: string, text: string): Record<string, unknown> {
  return { messageId, role: 'ROLE_USER', parts: [{ text }] };
}

function stateOf(body: Record<string, unknown>): string {
  const task = taskOf(body);
  const status = task?.['status'] as { state?: string } | undefined;
  return status?.state ?? '';
}

/** The wire Task of a response: SendMessage wraps it (`result.task`), GetTask
 * returns the Task as the result itself. */
function taskOf(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const result = body['result'] as Record<string, unknown> | undefined;
  if (result === undefined) return undefined;
  const task = result['task'] as Record<string, unknown> | undefined;
  if (task !== undefined && typeof task === 'object') return task;
  if (result['status'] !== undefined || result['id'] !== undefined) return result;
  return undefined;
}

function taskIdOf(body: Record<string, unknown>): string {
  return (taskOf(body)?.['id'] as string | undefined) ?? '';
}

function errorInfo(body: Record<string, unknown>): { code: number; reason: string } {
  const error = body['error'] as { code?: number; data?: { reason?: string }[] } | undefined;
  return { code: error?.code ?? 0, reason: error?.data?.[0]?.reason ?? '' };
}

function artifactTextOf(task: unknown): string {
  const artifacts = (task as { artifacts?: { parts?: unknown[] }[] | null } | null | undefined)?.artifacts;
  return (artifacts?.[0]?.parts ?? [])
    .map((part) => {
      const content = (part as { content?: { $case?: string; value?: string } }).content;
      return content?.$case === 'text' ? (content.value ?? '') : '';
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Channel A: the REAL dsh-a2a-client, loaded across the package boundary
// ---------------------------------------------------------------------------

/** Minimal structural surface of the P2-02 client used by this spec. */
interface TaskHandleLike {
  messageId: string;
  taskId?: string;
  contextId?: string;
  state?: string;
  statusMessage?: string;
  artifactChunks?: number;
}
interface StreamEventLike {
  kind: string;
  taskId?: string;
  contextId?: string;
  state?: string;
  statusMessage?: string;
}
interface CancelOutcomeLike {
  status: string;
  taskId?: string;
  taskState?: string;
  detail: string;
}
interface PendingOperationLike {
  messageId: string;
  taskId?: string;
  lastKnownState?: string;
  suggestedAction: string;
}
interface DshClientLike {
  send(
    input: { text: string; messageId?: string; metadata?: Record<string, unknown> },
    options?: { mode?: string; pollTimeoutMs?: number; pollIntervalMs?: number },
  ): Promise<TaskHandleLike>;
  waitUntilTerminal(
    handle: TaskHandleLike,
    options?: { pollTimeoutMs?: number; pollIntervalMs?: number },
  ): Promise<TaskHandleLike>;
  sendAndConsume(
    input: { text: string; messageId?: string; metadata?: Record<string, unknown> },
    options?: { mode?: string; pollTimeoutMs?: number; pollIntervalMs?: number },
  ): Promise<TaskHandleLike>;
  getTask(input: { messageId?: string; taskId?: string }): Promise<TaskHandleLike>;
  cancel(input: { messageId?: string; taskId?: string }, reason: string): Promise<CancelOutcomeLike>;
  consumeStream(
    input: { text: string; messageId?: string },
    options?: { onEvent?: (event: StreamEventLike) => void },
  ): AsyncGenerator<StreamEventLike, void, unknown>;
  resubscribe(
    input: { taskId?: string; messageId?: string },
    options?: { onEvent?: (event: StreamEventLike) => void },
  ): AsyncGenerator<StreamEventLike, void, unknown>;
  resumePending(): Promise<PendingOperationLike[]>;
}
interface DshClientModule {
  DshA2aClient: new (config: {
    baseUrl: string;
    credential: string;
    ledger: string;
    pollIntervalMs?: number;
    pollTimeoutMs?: number;
    cancelResponseTimeoutMs?: number;
    maxSendRetries?: number;
    fetchImpl?: typeof fetch;
  }) => DshClientLike;
}

let dshClientModulePromise: Promise<DshClientModule> | null = null;

/**
 * Loads the REAL P2-02 client. The a2a-server gate installs ONLY this
 * package (isolated-package discipline, docs/adr/0013), while the client's
 * sources live in the sibling package and import `@a2a-js/sdk` themselves.
 * Both packages pin @a2a-js/sdk@1.3.0, so when the sibling has no
 * node_modules yet a junction to THIS package's node_modules makes it
 * resolvable without touching any install surface. The import is dynamic +
 * suppression-commented because the static typecheck surface (tsc on this
 * package) does not resolve the sibling when it is not installed; the
 * runtime resolution after the junction is the actual guarantee under test.
 */
function loadDshClientModule(): Promise<DshClientModule> {
  dshClientModulePromise ??= (async () => {
    const clientDir = fileURLToPath(new URL('../../dsh-a2a-client/', import.meta.url));
    const siblingModules = path.join(clientDir, 'node_modules');
    if (!existsSync(siblingModules)) {
      symlinkSync(
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../node_modules'),
        siblingModules,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      process.on('exit', () => {
        try {
          rmSync(siblingModules, { recursive: true, force: true, maxRetries: 5 });
        } catch {
          // best-effort cleanup of a gitignored junction
        }
      });
    }
    // @ts-ignore -- cross-package import resolved at RUNTIME (junction above);
    // the a2a-server typecheck surface does not install the sibling package.
    const mod = (await import('../../dsh-a2a-client/src/index.ts')) as unknown as DshClientModule;
    assert.equal(typeof mod.DshA2aClient, 'function', 'dsh-a2a-client exports DshA2aClient');
    return mod;
  })();
  return dshClientModulePromise;
}

function makeDshClient(
  module: DshClientModule,
  base: string,
  ledgerFile: string,
  cut?: CutController,
): DshClientLike {
  return new module.DshA2aClient({
    baseUrl: base,
    credential: ALPHA_TOKEN,
    ledger: ledgerFile,
    pollIntervalMs: 100,
    pollTimeoutMs: 40_000,
    cancelResponseTimeoutMs: 4_000,
    ...(cut !== undefined ? { fetchImpl: cuttingFetch(cut) } : {}),
  });
}

// ---------------------------------------------------------------------------
// Channel B: the REAL XiaozhiA2AProvider via a JSON-lines runner subprocess
// ---------------------------------------------------------------------------

interface TurnSnapshot {
  session_id: string;
  alive: boolean;
  done: boolean;
  text: string;
  fragments: number;
  error: { reason: string; detail: string } | null;
}
interface OutcomeSnapshot extends Record<string, unknown> {
  task_id?: string;
  context_id?: string;
  state?: string;
  presentation?: string;
  cancel_requested?: boolean;
  cancel_confirmed?: boolean | null;
  resubscribed?: boolean;
  disconnected?: boolean;
  delivered_fragments?: number;
  duplicate_fragments?: number;
  error_reason?: string | null;
  message_id?: string;
}

class XiaozhiRunner {
  private child: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  private readonly readyPromise: Promise<void>;
  private exited = false;
  readonly stderrTail: string[] = [];
  private readonly stderrTee: number | null;

  private constructor(child: ChildProcess, ledgerDir: string) {
    this.child = child;
    // Content-free diagnostics: tee the provider's stderr (the provider
    // contract keeps answer text out of logs) into the test temp dir so a
    // failure can be attributed after the run.
    this.stderrTee = (() => {
      try {
        // Fixed OS-temp location: the per-test temp dir is removed on cleanup,
        // and post-mortem attribution needs the log to survive the run.
        return openSync(path.join(tmpdir(), 'p2-05-runner-stderr.log'), 'a');
      } catch {
        return null;
      }
    })();
    this.readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const guard = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(this.startupFailure('ready timeout (30s)')));
      }, 30_000);
      let buffer = '';
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        buffer += chunk;
        let boundary = buffer.indexOf('\n');
        while (boundary >= 0) {
          const line = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 1);
          boundary = buffer.indexOf('\n');
          if (line === '') continue;
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(line) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (message['event'] === 'ready') {
            if (!settled) {
              settled = true;
              clearTimeout(guard);
              resolve();
            }
            continue;
          }
          const id = message['id'] as number | undefined;
          if (typeof id === 'number' && this.pending.has(id)) {
            const entry = this.pending.get(id)!;
            this.pending.delete(id);
            clearTimeout(entry.timer);
            entry.resolve(message);
          }
        }
      });
      child.stderr!.setEncoding('utf8');
      child.stderr!.on('data', (chunk: string) => {
        this.stderrTail.push(chunk);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
        if (this.stderrTee !== null) {
          try {
            writeSync(this.stderrTee, chunk);
          } catch {
            // diagnostics only
          }
        }
      });
      child.once('exit', () => {
        this.exited = true;
        if (!settled) {
          settled = true;
          clearTimeout(guard);
          reject(new Error(this.startupFailure('runner exited before READY')));
        }
        for (const [, entry] of this.pending) entry.reject(new Error('runner exited'));
        this.pending.clear();
      });
      // Fail fast on a spawn failure (missing interpreter etc.) instead of a
      // silent 30s ready timeout — the zero-SKIP contract wants the remedy.
      child.on('error', (error: Error) => {
        this.exited = true;
        if (!settled) {
          settled = true;
          clearTimeout(guard);
          reject(new Error(this.startupFailure(`spawn failed: ${error.message}`)));
        }
        for (const [, entry] of this.pending) entry.reject(new Error(`runner spawn failed: ${error.message}`));
        this.pending.clear();
      });
    });
  }

  private startupFailure(detail: string): string {
    return (
      `P2-05 xiaozhi runner failed to start (${detail}). ZERO-SKIP remedy: install the ` +
      'official a2a-sdk==1.2.3 for the interpreter (CI: setup-python + pip; local: set ' +
      'LUMITHINK_P2_05_PYTHON_BIN and PYTHONPATH) — this is a failure, never a skip. ' +
      `stderr tail: ${this.stderrTail.join('').slice(-800)}`
    );
  }

  static async start(base: string, ledgerDir: string): Promise<XiaozhiRunner> {
    const override = process.env['LUMITHINK_P2_05_PYTHON_BIN']?.trim();
    const python = override || (process.platform === 'win32' ? 'python' : 'python3');
    // Loopback traffic must never ride an ambient HTTP(S) proxy.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
      delete env[key];
    }
    env['NO_PROXY'] = '127.0.0.1,localhost';
    // The runner speaks UTF-8 JSON-L on stdio (Windows pipes would otherwise
    // decode with the ANSI codepage and poison the provider's request body).
    env['PYTHONUTF8'] = '1';
    env['PYTHONIOENCODING'] = 'utf-8';
    const child = spawn(
      python,
      ['-u', RUNNER_SCRIPT, '--base-url', base, '--token', DEVICE_TOKEN, '--ledger-dir', ledgerDir],
      { cwd: path.dirname(RUNNER_SCRIPT), env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const runner = new XiaozhiRunner(child, ledgerDir);
    await runner.readyPromise;
    return runner;
  }

  async cmd(op: string, params: Record<string, unknown> = {}, timeoutMs = 25_000): Promise<Record<string, unknown>> {
    if (this.exited) throw new Error('runner has exited');
    const id = this.nextId++;
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`runner command ${op} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(`${JSON.stringify({ id, op, ...params })}\n`);
    });
    if (response['ok'] !== true) {
      throw new Error(`runner command ${op} failed: ${JSON.stringify(response)}`);
    }
    return response;
  }

  async hello(sessionId: string): Promise<void> {
    await this.cmd('hello', { session_id: sessionId });
  }

  async turnStart(sessionId: string, prompt: string): Promise<string> {
    const response = await this.cmd('turn_start', { session_id: sessionId, prompt });
    return response['turn_id'] as string;
  }

  async turnState(turnId: string): Promise<TurnSnapshot> {
    const response = await this.cmd('turn_state', { turn_id: turnId });
    return response['turn'] as TurnSnapshot;
  }

  async turnWait(turnId: string, timeoutS = 25): Promise<TurnSnapshot> {
    const response = await this.cmd('turn_wait', { turn_id: turnId, timeout_s: timeoutS }, timeoutS * 1000 + 15_000);
    return response['turn'] as TurnSnapshot;
  }

  async turnTaskId(turnId: string, timeoutMs = 15_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const outcome = await this.lastOutcome((await this.turnState(turnId)).session_id);
      if (outcome?.task_id) return outcome.task_id;
      if (Date.now() > deadline) assert.fail(`provider turn ${turnId} never reported a task id`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async lastOutcome(sessionId: string): Promise<OutcomeSnapshot | null> {
    const response = await this.cmd('last_outcome', { session_id: sessionId });
    return (response['outcome'] as OutcomeSnapshot | null) ?? null;
  }

  async deliverySummary(sessionId: string): Promise<Record<string, unknown> | null> {
    const response = await this.cmd('delivery_summary', { session_id: sessionId });
    return (response['summary'] as Record<string, unknown> | null) ?? null;
  }

  async abort(sessionId: string): Promise<void> {
    await this.cmd('abort', { session_id: sessionId });
  }

  async rawRpc(
    method: string,
    params: Record<string, unknown>,
    token?: string,
  ): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
    const response = await this.cmd('raw_rpc', { method, params, ...(token !== undefined ? { token } : {}) });
    return { httpStatus: response['http_status'] as number, body: response['body'] as Record<string, unknown> };
  }

  async close(): Promise<void> {
    if (this.exited) return;
    try {
      this.child.stdin!.end(`${JSON.stringify({ id: 0, op: 'quit' })}\n`);
    } catch {
      // stdin may already be gone
    }
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    const killer = setTimeout(() => {
      if (!this.exited) this.child.kill('SIGKILL');
    }, 3_000);
    await exited;
    clearTimeout(killer);
    if (this.stderrTee !== null) {
      try {
        closeSync(this.stderrTee);
      } catch {
        // diagnostics only
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared service harness (in-process REAL stack; per-test isolation)
// ---------------------------------------------------------------------------

interface DualLimitsOverride {
  maxActiveWorkers?: number;
  maxActiveWorkersPerHousehold?: number;
  maxQueuedGlobal?: number;
  maxQueuedPerHousehold?: number;
  admissionWaitMs?: number;
}

async function startDualService(
  dir: string,
  options: { workerBehavior?: string; limits?: DualLimitsOverride } = {},
): Promise<StartedA2aService> {
  const limits = options.limits === undefined
    ? undefined
    : {
        ...structuredClone(A2A_LIMITS_DEFAULTS),
        concurrency: {
          ...A2A_LIMITS_DEFAULTS.concurrency,
          maxActiveWorkers: options.limits.maxActiveWorkers ?? A2A_LIMITS_DEFAULTS.concurrency.maxActiveWorkers,
          maxActiveWorkersPerHousehold:
            options.limits.maxActiveWorkersPerHousehold ?? A2A_LIMITS_DEFAULTS.concurrency.maxActiveWorkersPerHousehold,
        },
        queue: {
          maxQueuedGlobal: options.limits.maxQueuedGlobal ?? A2A_LIMITS_DEFAULTS.queue.maxQueuedGlobal,
          maxQueuedPerHousehold:
            options.limits.maxQueuedPerHousehold ?? A2A_LIMITS_DEFAULTS.queue.maxQueuedPerHousehold,
        },
        admissionWaitMs: options.limits.admissionWaitMs ?? A2A_LIMITS_DEFAULTS.admissionWaitMs,
      };
  return startA2aService({
    config: testConfig({
      runtimeMode: 'dsh-worker',
      dbPath: path.join(dir, 'task.sqlite3'),
      identityDbPath: path.join(dir, 'identity.sqlite3'),
      deletionLedgerDbPath: path.join(dir, 'deletion-ledger.sqlite3'),
      fingerprintKey: FINGERPRINT_KEY,
      dshWorker: {
        ...TUNING,
        workerEnv: options.workerBehavior ? { LUMITHINK_A2A_WORKER_BEHAVIOR: options.workerBehavior } : {},
      },
      ...(limits ? { limits } : {}),
    }),
    identityBootstrap: dualChannelBootstrap(),
  });
}

function managerOf(service: StartedA2aService): SqliteTaskManager {
  return service.taskStore as SqliteTaskManager;
}

function soleExecution(
  manager: SqliteTaskManager,
  taskId: string,
): {
  executionId: string;
  state: string;
  workerId: string | null;
  settledAtMs: number | null;
  result: Record<string, unknown> | null;
} {
  const turns = manager.getTaskDetail(taskId).turns;
  assert.ok(turns.length >= 1, `task ${taskId} has at least one turn`);
  assert.ok(turns[0].executions.length >= 1, `task ${taskId} has at least one execution row`);
  const row = turns[0].executions[0];
  return {
    executionId: row.executionId,
    state: row.state,
    workerId: row.workerId,
    settledAtMs: row.settledAtMs,
    result: row.result as unknown as Record<string, unknown> | null,
  };
}

function chunkCount(taskDbPath: string, taskId: string): number {
  const db = new DatabaseSync(taskDbPath, { readOnly: true });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM a2a_artifact_chunks WHERE task_id = ?').get(taskId) as { n: number }).n;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// G1 权限隔离 — 双 Principal 并发 + 跨主体拒绝 + 撤权即时生效（含 SSE 长流关闭）
// Channel mix / interleaving: A=DSH client (alpha) ∥ B=xiaozhi provider;
// (1) concurrent admission in the same window, (2) mutual cross-principal
// probes on the wire, (3) BOTH channels hold live parked SSE streams while
// EACH credential is revoked in turn — only the revoked principal's stream
// closes, the other channel stays live until its own revocation.
// ---------------------------------------------------------------------------

test('G1 权限隔离: 双 Principal 并发受理、跨主体拒绝、撤权即时生效（双渠道 SSE 长流仅撤权方关闭）', { timeout: 180_000 }, async () => {
  const module = await loadDshClientModule();
  const dir = tempDir('g1');
  let service: StartedA2aService | null = null;
  let runner: XiaozhiRunner | null = null;
  try {
    service = await startDualService(dir, { workerBehavior: 'never-stops' });
    runner = await XiaozhiRunner.start(service.base, dir);
    const manager = managerOf(service);
    const client = makeDshClient(module, service.base, path.join(dir, 'ledger-alpha-g1.json'));

    // --- 并发受理 + 双长流: the two concurrently admitted tasks ARE the two
    // live SSE streams (never-stops workers park after their first chunk, so
    // both streams stay open with admitted content). Global capacity is
    // exactly 2 — every later task in this group is refused by design.
    const alphaEvents: StreamEventLike[] = [];
    let alphaTaskId = '';
    let alphaStreamSettled = false;
    const alphaStream = (async () => {
      try {
        for await (const event of client.consumeStream({ text: 'G1 并发长流', messageId: 'p2-05-g1-a1' })) {
          alphaEvents.push(event);
          if (event.kind === 'task' && event.taskId) alphaTaskId = event.taskId;
        }
      } catch {
        // a revoked stream may end with a mapped transport error — either way
        // the LOCAL stream is over, which is what this group asserts.
      } finally {
        alphaStreamSettled = true;
      }
    })();
    await runner.hello('g1-b');
    const xzTurnId = await runner.turnStart('g1-b', 'G1 并发长流（小智）');
    const xzRunnerG1 = runner;
    await waitFor(
      async () => (await xzRunnerG1.turnState(xzTurnId)).fragments >= 1,
      'xiaozhi long stream never delivered its first fragment',
    );
    await waitFor(
      () => alphaEvents.some((event) => event.kind === 'artifactUpdate'),
      'alpha long stream never delivered its first artifact frame',
    );
    assert.ok(alphaTaskId, 'alpha stream observed its task frame');
    const xzTaskId = await runner.turnTaskId(xzTurnId);
    await waitFor(() => {
      const alphaRows = manager.getTaskDetail(alphaTaskId).turns[0]?.executions.length ?? 0;
      const xzRows = manager.getTaskDetail(xzTaskId).turns[0]?.executions.length ?? 0;
      return alphaRows >= 1 && xzRows >= 1;
    }, 'both concurrently admitted tasks never started their real workers');
    const alphaBinding = service.identity.store.taskBinding(alphaTaskId);
    const xzBinding = service.identity.store.taskBinding(xzTaskId);
    assert.equal(alphaBinding?.householdId, 'hh-alpha-01');
    assert.equal(alphaBinding?.principalUserId, 'user-alpha-guardian');
    assert.equal(xzBinding?.householdId, 'hh-xiaozhi-01', 'the device credential authenticates its household');
    assert.equal(xzBinding?.principalUserId ?? null, null, 'client_only device binding is principalless');

    // --- 跨主体拒绝: mutual, both directions, both wire faces ---------------
    await assert.rejects(
      () => client.getTask({ taskId: xzTaskId }),
      (error: unknown) => (error as { code?: string }).code === 'task_not_found',
      'alpha GetTask on the xiaozhi task → -32001 face',
    );
    const deviceRead = await runner.rawRpc('GetTask', { id: alphaTaskId });
    assert.equal(errorInfo(deviceRead.body).code, -32001, 'device GetTask on the alpha task → -32001');
    const alphaCancelForeign = await client.cancel({ taskId: xzTaskId }, 'cross-principal probe');
    assert.equal(alphaCancelForeign.status, 'not_found', 'alpha CancelTask on the device task → not_found');
    const deviceCancelForeign = await runner.rawRpc('CancelTask', { id: alphaTaskId });
    assert.equal(errorInfo(deviceCancelForeign.body).code, -32001, 'device CancelTask on the alpha task → -32001');
    // Forged identity metadata never elevates (identity rides the credential).
    // The global capacity is saturated, so this third task is refused at
    // dispatch — but the TASK ROW and its binding are created at acceptance.
    const forged = await client.send(
      {
        text: '伪造身份字段',
        messageId: 'p2-05-g1-forged',
        metadata: { userId: 'user-xz-guardian', householdId: 'hh-xiaozhi-01', tenant: 'forged-tenant' },
      },
      { mode: 'returnImmediately' },
    );
    await waitFor(
      () => manager.getTaskDetail(forged.taskId!).currentState === 'rejected',
      'the forged third task never settled REJECTED (expected: capacity refusal)',
      10_000,
    );
    const forgedBinding = service.identity.store.taskBinding(forged.taskId!);
    assert.equal(forgedBinding?.householdId, 'hh-alpha-01', 'forged metadata does not move the binding');
    assert.equal(forgedBinding?.principalUserId, 'user-alpha-guardian');

    // --- 撤权即时生效: BOTH channels hold live SSE streams -----------------
    // Revoke the DSH credential: ONLY alpha's stream must close.
    assert.equal(service.identity.revokeCredential('cred-dsh-alpha'), true);
    await waitFor(() => alphaStreamSettled, 'the revoked alpha SSE stream did not close promptly', 10_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await runner.turnState(xzTurnId)).alive, true, 'the xiaozhi stream must NOT be affected by the alpha revocation');
    const denied = await rpcResultOf(service.base, 1, 'GetTask', { id: alphaTaskId }, { token: ALPHA_TOKEN });
    assert.equal(denied.httpStatus, 401, 'the revoked credential is denied immediately');
    assert.equal(errorInfo(denied.body).reason, 'AUTHENTICATION_REQUIRED');

    // Revoke the device credential: now the xiaozhi stream closes too.
    assert.equal(service.identity.revokeCredential('cred-xiaozhi-device'), true);
    await runner.turnWait(xzTurnId, 25);
    const xzOutcome = await runner.lastOutcome('g1-b');
    assert.equal(xzOutcome?.disconnected, true, 'the provider observed the stream loss');
    assert.ok(xzOutcome?.error_reason, 'the provider turn ended with an explicit content-free error');
    const deviceDenied = await runner.rawRpc('GetTask', { id: xzTaskId });
    assert.equal(deviceDenied.httpStatus, 401, 'the revoked device credential is denied immediately');
    assert.ok(alphaEvents.length >= 1, 'alpha observed frames before its revocation');
    await alphaStream;
  } finally {
    if (runner) await runner.close();
    if (service) await stopA2aService(service);
    removeTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// G2 并发 Task — 双渠道同刻受理执行 + 家庭/全局限额与背压语义
// Channel mix / interleaving: A=DSH ∥ B=provider admitted in the SAME tick
// (two households, two generation slots); then BOTH sides probe the saturated
// surface. Pinned dispatch semantics (verified against the shipped scheduler):
// the capacity preflight refuses a pressured request IMMEDIATELY — the task
// settles REJECTED on `submitted` with zero executions (P1-09 review-P0
// discipline) — the bounded admission queue only catches transient races.
// ---------------------------------------------------------------------------

const SHRUNKEN_LIMITS: DualLimitsOverride = {
  maxActiveWorkers: 2,
  maxActiveWorkersPerHousehold: 1,
  maxQueuedGlobal: 2,
  maxQueuedPerHousehold: 1,
  admissionWaitMs: 600,
};

test('G2 并发 Task: 双渠道同刻受理执行；家庭与全局容量压力下双渠道一致获得显式即时拒绝（不搁置、不执行）', { timeout: 240_000 }, async () => {
  const module = await loadDshClientModule();
  const dir = tempDir('g2');
  let service: StartedA2aService | null = null;
  let runner: XiaozhiRunner | null = null;
  try {
    service = await startDualService(dir, { workerBehavior: 'never-stops', limits: SHRUNKEN_LIMITS });
    runner = await XiaozhiRunner.start(service.base, dir);
    const manager = managerOf(service);
    const client = makeDshClient(module, service.base, path.join(dir, 'ledger-alpha-g2.json'));

    // Phase A: both channels admitted in the SAME tick (two households, two
    // generation slots; each household's own cap is 1).
    await runner.hello('g2-b');
    const [alphaHandle, b1Turn] = await Promise.all([
      client.send({ text: 'G2 双渠道同刻受理', messageId: 'p2-05-g2-a1' }, { mode: 'returnImmediately' }),
      runner.turnStart('g2-b', 'G2 双渠道同刻受理（小智）'),
    ]);
    assert.ok(alphaHandle.taskId, 'alpha concurrently admitted');
    const b1TaskId = await runner.turnTaskId(b1Turn);
    await waitFor(
      () =>
        (manager.getTaskDetail(alphaHandle.taskId!).turns[0]?.executions.length ?? 0) >= 1 &&
        (manager.getTaskDetail(b1TaskId).turns[0]?.executions.length ?? 0) >= 1,
      'concurrently admitted tasks never both started real workers',
    );
    assert.equal(manager.getTaskDetail(alphaHandle.taskId!).currentState, 'working');
    assert.equal(manager.getTaskDetail(b1TaskId).currentState, 'working');

    // Phase B: alpha is saturated (household cap 1, global 2/2) → the next
    // alpha request is refused IMMEDIATELY: REJECTED on submitted, no worker.
    const a2 = await client.send({ text: 'G2 家庭容量拒绝', messageId: 'p2-05-g2-a2' }, { mode: 'returnImmediately' });
    await waitFor(
      () => manager.getTaskDetail(a2.taskId!).currentState === 'rejected',
      'the saturated-household next task never settled REJECTED',
      8_000,
    );
    assert.equal(
      manager.getTaskDetail(a2.taskId!).turns[0]?.executions.length ?? 0,
      0,
      'no worker ever started for the refused task',
    );

    // Phase C: the DEVICE channel hits the same saturated surface → the SAME
    // explicit refusal semantics, observed through the device's own stream
    // (背压语义跨渠道一致, never a hang, never a fabricated admission).
    await runner.hello('g2-b2');
    const b2Turn = await runner.turnStart('g2-b2', 'G2 全局背压探针（小智）');
    const b2Done = await runner.turnWait(b2Turn, 25);
    assert.equal(b2Done.error, null, 'the capacity refusal is a settlement, not a transport error');
    assert.equal((await runner.lastOutcome('g2-b2'))?.state, 'TASK_STATE_REJECTED');
    // The refusal is explicit and terminal on the wire for both channels.
    const a3 = await client.send({ text: 'G2 第二次压力探针', messageId: 'p2-05-g2-a3' }, { mode: 'returnImmediately' });
    await waitFor(
      () => manager.getTaskDetail(a3.taskId!).currentState === 'rejected',
      'the second pressured request never settled REJECTED',
      8_000,
    );
    // The simultaneous-admission tasks are UNAFFECTED by the refusals.
    assert.equal(manager.getTaskDetail(alphaHandle.taskId!).currentState, 'working');
    assert.equal(manager.getTaskDetail(b1TaskId).currentState, 'working');
    assert.equal(manager.stats().executions, 2, 'exactly the two admitted tasks ever ran a worker');
  } finally {
    if (runner) await runner.close();
    if (service) await stopA2aService(service);
    removeTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// G3 取消×完成竞争
// G3a (complete-after-cancel): the cancel lands while the worker has already
//      finished → CancelTask responds with the POST-RACE terminal state
//      (already_terminal/COMPLETED + suppressed flags on BOTH channels,
//      never a fabricated CANCELED); late cancels return -32002.
// G3b (flood-after-cancel): the cancel wins → real stop evidence + late
//      output never enters the public artifact on either channel.
// Channel mix: A=DSH and B=provider run the SAME race concurrently.
// ---------------------------------------------------------------------------

test('G3a 取消×完成竞争: 双渠道并发 cancel-after-work 交错 → COMPLETED+抑制旗标，终态不可被迟到回调改写', { timeout: 180_000 }, async () => {
  const module = await loadDshClientModule();
  const dir = tempDir('g3a');
  let service: StartedA2aService | null = null;
  let runner: XiaozhiRunner | null = null;
  try {
    service = await startDualService(dir, { workerBehavior: 'complete-after-cancel' });
    runner = await XiaozhiRunner.start(service.base, dir);
    const xzRunnerG3a = runner;
    const manager = managerOf(service);
    const client = makeDshClient(module, service.base, path.join(dir, 'ledger-alpha-g3a.json'));

    await runner.hello('g3a-b');
    const [alphaHandle, b1Turn] = await Promise.all([
      client.send({ text: 'G3a 竞争', messageId: 'p2-05-g3a-a1' }, { mode: 'returnImmediately' }),
      runner.turnStart('g3a-b', 'G3a 竞争（小智）'),
    ]);
    const alphaTaskId = alphaHandle.taskId!;
    const b1TaskId = await runner.turnTaskId(b1Turn);
    // Both workers delivered chunk-1 (their pre-cancel work) on both channels.
    await waitFor(
      async () =>
        ((await manager.load(alphaTaskId))?.artifacts?.[0]?.parts?.length ?? 0) >= 1 &&
        (await xzRunnerG3a.turnState(b1Turn)).fragments >= 1,
      'neither channel delivered its first chunk before the cancel',
    );

    // INTERLEAVED: A-channel cancel and B-channel device abort in one window.
    const alphaCancel = client.cancel({ taskId: alphaTaskId }, 'G3a 取消×完成竞争');
    await runner.abort('g3a-b');
    const cancelOutcome = await alphaCancel;
    // The worker had ALREADY finished: the §7.2 race keeps the original
    // terminal truth — the CancelTask response carries the completed state.
    assert.equal(cancelOutcome.status, 'already_terminal', 'completion won the race → already_terminal, never a fabricated CANCELED');
    assert.equal(cancelOutcome.taskState, 'completed');

    // A settles COMPLETED with suppressed flags; the late chunk stays out.
    const alphaDone = await client.waitUntilTerminal(alphaHandle);
    assert.equal(alphaDone.state, 'completed');
    const alphaTask = await manager.load(alphaTaskId);
    assert.deepEqual(alphaTask?.metadata?.['lumithinkResult'], {
      version: 1,
      outputSuppressedAfterCancel: true,
      answerComplete: false,
    }, 'the raced completion honestly carries the suppressed-answer flags (A channel)');
    assert.equal(artifactTextOf(alphaTask), '你好。', 'the late completion chunk (迟到的收尾) never entered the artifact');
    const alphaExec = soleExecution(manager, alphaTaskId);
    assert.equal(alphaExec.state, 'settled');
    assert.equal(alphaExec.result?.['outcome'], 'completed');

    // B settles through its own channel; the wire truth is the same shape.
    await runner.turnWait(b1Turn, 25);
    await waitFor(async () => {
      const snapshot = await xzRunnerG3a.rawRpc('GetTask', { id: b1TaskId });
      return stateOf(snapshot.body) === 'TASK_STATE_COMPLETED';
    }, 'the device-channel raced task never settled COMPLETED', 15_000);
    const bSnapshot = await runner.rawRpc('GetTask', { id: b1TaskId });
    const bMetadata = taskOf(bSnapshot.body)?.['metadata'] as Record<string, unknown> | undefined;
    assert.equal(
      (bMetadata?.['lumithinkResult'] as Record<string, unknown> | undefined)?.['outputSuppressedAfterCancel'],
      true,
      `B 渠道竞争完成同样携带抑制旗标 (wire metadata: ${JSON.stringify(bMetadata)})`,
    );

    // Terminal immutability: LATE cancels from each channel are refused.
    const lateA = await rpcResultOf(service.base, 2, 'CancelTask', { id: alphaTaskId }, { token: ALPHA_TOKEN });
    assert.equal(errorInfo(lateA.body).code, -32002, 'late cancel on the completed alpha task → TaskNotCancelable');
    const lateB = await runner.rawRpc('CancelTask', { id: b1TaskId });
    assert.equal(errorInfo(lateB.body).code, -32002, 'late cancel on the completed device task → TaskNotCancelable');
    assert.equal(manager.getTaskDetail(alphaTaskId).currentState, 'completed', 'terminal state unchanged by late cancels');
    assert.equal(
      stateOf((await runner.rawRpc('GetTask', { id: b1TaskId })).body),
      'TASK_STATE_COMPLETED',
      'terminal state unchanged by late cancels (device view)',
    );
  } finally {
    if (runner) await runner.close();
    if (service) await stopA2aService(service);
    removeTempDir(dir);
  }
});

test('G3b 取消×完成竞争: 取消获胜 → 双渠道真实停止证据 + 迟到输出不进入公开正文', { timeout: 180_000 }, async () => {
  const module = await loadDshClientModule();
  const dir = tempDir('g3b');
  let service: StartedA2aService | null = null;
  let runner: XiaozhiRunner | null = null;
  try {
    service = await startDualService(dir, { workerBehavior: 'flood-after-cancel' });
    runner = await XiaozhiRunner.start(service.base, dir);
    const xzRunnerG3b = runner;
    const manager = managerOf(service);
    const client = makeDshClient(module, service.base, path.join(dir, 'ledger-alpha-g3b.json'));

    await runner.hello('g3b-b');
    const [alphaHandle, b1Turn] = await Promise.all([
      client.send({ text: 'G3b 停止证据', messageId: 'p2-05-g3b-a1' }, { mode: 'returnImmediately' }),
      runner.turnStart('g3b-b', 'G3b 停止证据（小智）'),
    ]);
    const alphaTaskId = alphaHandle.taskId!;
    const b1TaskId = await runner.turnTaskId(b1Turn);
    await waitFor(
      async () =>
        ((await manager.load(alphaTaskId))?.artifacts?.[0]?.parts?.length ?? 0) >= 1 &&
        (await xzRunnerG3b.turnState(b1Turn)).fragments >= 1,
      'neither channel delivered its first chunk before the cancel',
    );

    // A-channel cancel + B-channel device abort, interleaved.
    const alphaCancel = client.cancel({ taskId: alphaTaskId }, 'G3b 取消获胜');
    await runner.abort('g3b-b');
    const cancelOutcome = await alphaCancel;
    assert.equal(cancelOutcome.status, 'confirmed_canceled', 'the DSH channel sees the real stop confirmed');

    const alphaDone = await client.waitUntilTerminal(alphaHandle);
    assert.equal(alphaDone.state, 'canceled');
    const alphaTask = await manager.load(alphaTaskId);
    assert.equal(artifactTextOf(alphaTask), '你好。', 'the flooded late chunk never entered the public artifact');
    const alphaExec = soleExecution(manager, alphaTaskId);
    assert.equal(alphaExec.state, 'settled');
    assert.equal(alphaExec.result?.['outcome'], 'canceled', 'stop evidence settles the execution row');
    assert.equal(manager.getTaskDetail(alphaTaskId).cancelIntent, true, 'the cancel intent persisted');

    // B-channel: the provider's independent cancel client confirmed the stop;
    // the device task settles CANCELED with the same late-output discipline.
    const bDone = await runner.turnWait(b1Turn, 25);
    assert.equal(bDone.error, null, `the provider turn settles cleanly (${bDone.error?.reason ?? ''})`);
    const bOutcome = await runner.lastOutcome('g3b-b');
    assert.equal(bOutcome?.presentation, 'canceled');
    assert.equal(bOutcome?.cancel_requested, true);
    const bWire = await runner.rawRpc('GetTask', { id: b1TaskId });
    assert.equal(stateOf(bWire.body), 'TASK_STATE_CANCELED');
    const bWireTask = taskOf(bWire.body) as {
      artifacts?: { parts?: { text?: string }[] }[];
    };
    const bText = (bWireTask?.artifacts?.[0]?.parts ?? []).map((part) => (typeof part.text === 'string' ? part.text : '')).join('');
    assert.equal(bText, '你好。', `the device task artifact keeps only the pre-cancel chunk (got ${JSON.stringify(bWireTask?.artifacts)})`);

    // Late callbacks cannot rewrite either terminal state.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(manager.getTaskDetail(alphaTaskId).currentState, 'canceled');
    assert.equal(stateOf((await runner.rawRpc('GetTask', { id: b1TaskId })).body), 'TASK_STATE_CANCELED');
  } finally {
    if (runner) await runner.close();
    if (service) await stopA2aService(service);
    removeTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// G4 服务端重启 — 受理/执行/交付切点；不重复执行、无孤儿正文；恢复后双渠道行为
// Channel mix / interleaving: A=DSH ∥ B=provider both mid-execution (workers
// parked, first chunks admitted = 交付切点) on a SPAWNED real service →
// genuine SIGKILL → in-process restart on the SAME files/port → both
// channels recover; then the 受理切点 (confirmed-never-started requeue) via a
// store-level seed (P1-08 precedent; no wire view — declared boundary).
// ---------------------------------------------------------------------------

async function freeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('G4 服务端重启: 执行/交付切点真实 SIGKILL → abandoned+FAILED 不重复执行无孤儿正文；受理切点重派；双渠道恢复', { timeout: 300_000 }, async () => {
  const module = await loadDshClientModule();
  const dir = tempDir('g4');
  let fixture: ChildProcess | null = null;
  let service: StartedA2aService | null = null;
  let runner: XiaozhiRunner | null = null;
  const reapedWorkerPids: number[] = [];
  try {
    // --- spawn the REAL service on a pinned loopback port ------------------
    let base = '';
    for (let attempt = 0; attempt < 3 && base === ''; attempt += 1) {
      const port = await freeLoopbackPort();
      const child = spawn(process.execPath, [RESTARTABLE_ENTRY], {
        env: {
          ...process.env,
          LUMITHINK_A2A_VALIDATION_TOKEN: ALPHA_TOKEN,
          LUMITHINK_A2A_VALIDATION_PORT: String(port),
          LUMITHINK_A2A_VALIDATION_DB: path.join(dir, 'task.sqlite3'),
          LUMITHINK_A2A_IDENTITY_DB: path.join(dir, 'identity.sqlite3'),
          LUMITHINK_A2A_DELETION_LEDGER_DB: path.join(dir, 'deletion-ledger.sqlite3'),
          LUMITHINK_A2A_FINGERPRINT_KEY: FINGERPRINT_KEY,
          LUMITHINK_A2A_RUNTIME_MODE: 'dsh-worker',
          LUMITHINK_A2A_DSH_WORKER_TIMEOUT_MS: '20000',
          LUMITHINK_A2A_DSH_WORKER_HELLO_TIMEOUT_MS: '2000',
          LUMITHINK_A2A_DSH_WORKER_LOST_CONTACT_MS: '5000',
          LUMITHINK_A2A_DSH_WORKER_CANCEL_GRACE_MS: '800',
          LUMITHINK_A2A_WORKER_BEHAVIOR: 'never-stops',
          LUMITHINK_A2A_IDENTITY_BOOTSTRAP: JSON.stringify(dualChannelBootstrap()),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const readyBase = await new Promise<string | null>((resolve) => {
        let settled = false;
        const guard = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve(null);
          }
        }, 25_000);
        let buffered = '';
        child.stdout!.setEncoding('utf8');
        child.stdout!.on('data', (chunk: string) => {
          buffered += chunk;
          const match = /READY (http:\/\/\S+)/.exec(buffered);
          if (match && !settled) {
            settled = true;
            clearTimeout(guard);
            resolve(match[1]);
          }
        });
        child.stderr!.setEncoding('utf8');
        child.stderr!.on('data', (chunk: string) => {
          buffered += chunk;
        });
        child.once('exit', () => {
          if (!settled) {
            settled = true;
            clearTimeout(guard);
            resolve(null);
          }
        });
      });
      if (readyBase !== null) {
        base = readyBase;
        fixture = child;
      } else {
        child.kill('SIGKILL');
      }
    }
    assert.ok(base, 'the spawned a2a-server fixture never reported READY');

    runner = await XiaozhiRunner.start(base, dir);
    const client = makeDshClient(module, base, path.join(dir, 'ledger-alpha-g4.json'));
    await runner.hello('g4-b');
    const [alphaHandle, b1Turn] = await Promise.all([
      client.send({ text: 'G4 重启前受理', messageId: 'p2-05-g4-a1' }, { mode: 'returnImmediately' }),
      runner.turnStart('g4-b', 'G4 重启前受理（小智）'),
    ]);
    const alphaTaskId = alphaHandle.taskId!;
    const b1TaskId = await runner.turnTaskId(b1Turn);

    const taskDbPath = path.join(dir, 'task.sqlite3');
    // 执行 + 交付切点: both execution rows ACTIVE and each task admitted its
    // first chunk BEFORE the crash.
    await waitFor(() => {
      const db = new DatabaseSync(taskDbPath, { readOnly: true });
      try {
        const rows = db
          .prepare("SELECT task_id FROM a2a_executions WHERE state IN ('registered','running')")
          .all() as unknown as { task_id: string }[];
        const active = new Set(rows.map((row) => row.task_id));
        return active.has(alphaTaskId) && active.has(b1TaskId);
      } finally {
        db.close();
      }
    }, 'both dual-channel executions never became active before the crash', 20_000);
    await waitFor(
      () => chunkCount(taskDbPath, alphaTaskId) >= 1 && chunkCount(taskDbPath, b1TaskId) >= 1,
      'neither task admitted its first chunk before the crash (delivery cut point not reached)',
      20_000,
    );
    const preKillChunks = { alpha: chunkCount(taskDbPath, alphaTaskId), xiaozhi: chunkCount(taskDbPath, b1TaskId) };
    const workerPidOf = (taskId: string): number => {
      const db = new DatabaseSync(taskDbPath, { readOnly: true });
      try {
        const row = db.prepare('SELECT worker_id FROM a2a_executions WHERE task_id = ?').get(taskId) as
          | { worker_id: string | null }
          | undefined;
        const match = /^dshw-(\d+)-/.exec(row?.worker_id ?? '');
        assert.ok(match, `no worker pid recorded for ${taskId}`);
        return Number(match![1]);
      } finally {
        db.close();
      }
    };
    reapedWorkerPids.push(workerPidOf(alphaTaskId), workerPidOf(b1TaskId));

    // THE CRASH: SIGKILL the service mid-execution (no dispose, no clean close).
    fixture!.kill('SIGKILL');
    await new Promise<void>((resolve) => fixture!.once('exit', () => resolve()));
    fixture = null;
    for (const pid of reapedWorkerPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 400));

    // RESTART in-process on the SAME databases at the SAME port. The
    // restarted service pins the 'complete' worker profile: the parked
    // pre-crash tasks stay abandoned/failed (recovery is behavior-
    // independent) while the post-restart health probes can run to real
    // completions on both channels.
    const restartConfig = () =>
      testConfig({
        port: Number(new URL(base).port),
        runtimeMode: 'dsh-worker',
        dbPath: path.join(dir, 'task.sqlite3'),
        identityDbPath: path.join(dir, 'identity.sqlite3'),
        deletionLedgerDbPath: path.join(dir, 'deletion-ledger.sqlite3'),
        fingerprintKey: FINGERPRINT_KEY,
        dshWorker: { ...TUNING, workerEnv: { LUMITHINK_A2A_WORKER_BEHAVIOR: 'complete' } },
      });
    const boot = () => startA2aService({ config: restartConfig(), identityBootstrap: dualChannelBootstrap() });
    service = await boot().catch(async () => {
      // Windows may need one beat to release the killed listener's port.
      await new Promise((resolve) => setTimeout(resolve, 600));
      return boot();
    });
    assert.equal(service.base, base, 'the restart re-binds the SAME loopback URL');
    const manager = managerOf(service);
    assert.ok(service.recovery, 'the restarted service ran the recovery scan');
    assert.equal(service.recovery!.abandonedExecutions.length, 2, 'both interrupted executions are abandoned');
    assert.deepEqual(service.recovery!.requeuedTaskIds, [], 'unknown-outcome executions are never re-queued');
    for (const taskId of [alphaTaskId, b1TaskId]) {
      await waitFor(
        () => manager.getTaskDetail(taskId).currentState === 'failed',
        `the interrupted task ${taskId} never settled FAILED on restart`,
      );
      const exec = soleExecution(manager, taskId);
      assert.equal(exec.state, 'abandoned');
      assert.equal(exec.result?.['outcome'], 'abandoned');
      assert.equal(exec.result?.['reason'], 'restart_interrupted_unknown_outcome');
    }
    // 不重复执行: exactly the two pre-crash executions exist.
    assert.equal(manager.stats().executions, 2);
    // 无孤儿正文 + 交付证据保留: chunk counts unchanged, outbox rows intact.
    assert.equal(chunkCount(taskDbPath, alphaTaskId), preKillChunks.alpha, 'no orphan/duplicated body after restart (alpha)');
    assert.equal(chunkCount(taskDbPath, b1TaskId), preKillChunks.xiaozhi, 'no orphan/duplicated body after restart (xiaozhi)');
    assert.ok(manager.readOutboxAfter(alphaTaskId, 0).length >= 1, 'un-published outbox rows survive the crash (交付切点)');

    // Channel A recovery: the durable ledger points at the interrupted task.
    const resumed = await client.resumePending();
    const alphaPending = resumed.find((item) => item.messageId === 'p2-05-g4-a1');
    assert.ok(alphaPending, 'the DSH ledger reports the interrupted operation');
    assert.equal(alphaPending!.suggestedAction, 'query_or_reattach');
    const alphaRecovered = await client.getTask({ messageId: 'p2-05-g4-a1' });
    assert.equal(alphaRecovered.state, 'failed');
    const retry = await client.send({ text: 'G4 重启前受理', messageId: 'p2-05-g4-a1' }, { mode: 'returnImmediately' });
    assert.equal(retry.taskId, alphaTaskId, 'the retry hits the SAME task (idempotent, no re-execution)');
    assert.equal(manager.stats().executions, 2, 'the retry never re-executed anything');

    // Channel B recovery: the device credential reads the true FAILED state.
    const bRecovered = await runner.rawRpc('GetTask', { id: b1TaskId });
    assert.equal(stateOf(bRecovered.body), 'TASK_STATE_FAILED');
    // Both channels work again on the restarted server.
    const postRestart = await client.sendAndConsume({ text: 'G4 重启后新任务', messageId: 'p2-05-g4-a2' });
    assert.equal(postRestart.state, 'completed');
    await runner.hello('g4-b3');
    const postTurn = await runner.turnStart('g4-b3', 'G4 重启后新任务（小智）');
    const postDone = await runner.turnWait(postTurn, 25);
    assert.equal(postDone.error, null);
    assert.equal((await runner.lastOutcome('g4-b3'))?.presentation, 'complete');

    // --- 受理切点 (confirmed-never-started → requeue): graceful stop, seed,
    // boot again. The seeded task is store-level evidence (no identity
    // binding → no wire view; declared boundary in the regression report).
    await stopA2aService(service);
    service = null;
    const seeder = new SqliteTaskManager({ dbPath: taskDbPath });
    let seededTaskId = '';
    try {
      const accepted = seeder.acceptInput({
        requestKey: 'p2-05-g4-acc-cut',
        fingerprint: 'fp-p2-05-g4-acc-cut',
        messageId: 'msg-p2-05-g4-acc-cut',
        inputMessage: userMessage('msg-p2-05-g4-acc-cut', '受理切点重启探针'),
      });
      assert.equal(accepted.outcome, 'created');
      seededTaskId = (accepted as { taskId: string }).taskId;
    } finally {
      seeder.close();
    }
    service = await boot();
    const requeuedTaskIds: string[] = service.recovery!.requeuedTaskIds;
    assert.ok(requeuedTaskIds.includes(seededTaskId), 'the confirmed-never-started task is requeued');
    await waitFor(
      () => managerOf(service!).getTaskDetail(seededTaskId).currentState === 'completed',
      'the requeued task never re-dispatched through the real lease path',
    );
    // 2 abandoned (pre-crash dual-channel) + 2 post-restart health probes
    // (a2 + b3) + exactly ONE new execution for the requeued task.
    assert.equal(managerOf(service!).stats().executions, 5, 'exactly ONE new execution for the requeued task');
  } finally {
    if (runner) await runner.close();
    if (fixture !== null && fixture.exitCode === null && fixture.signalCode === null) fixture.kill('SIGKILL');
    if (service) await stopA2aService(service);
    for (const pid of reapedWorkerPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    removeTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// G5 Worker 崩溃 — 真实子进程 SIGKILL → 结算正确，另一渠道不受影响
// G5a: both channels' workers self-SIGKILL (crash-after-ready profile — a
//      REAL process.kill(pid,'SIGKILL') inside the worker entry).
// G5b: an EXTERNAL SIGKILL on exactly ONE worker subprocess (by the pid
//      recorded on its execution row); the other channel's worker stays
//      healthy and its task cancels cleanly afterwards.
// ---------------------------------------------------------------------------

test('G5a Worker 崩溃: 真实 worker 子进程自 SIGKILL（crash-after-ready）→ 双渠道 FAILED 结算各自成立', { timeout: 180_000 }, async () => {
  const module = await loadDshClientModule();
  const dir = tempDir('g5a');
  let service: StartedA2aService | null = null;
  let runner: XiaozhiRunner | null = null;
  try {
    service = await startDualService(dir, { workerBehavior: 'crash-after-ready' });
    runner = await XiaozhiRunner.start(service.base, dir);
    const manager = managerOf(service);
    const client = makeDshClient(module, service.base, path.join(dir, 'ledger-alpha-g5a.json'));

    await runner.hello('g5a-b');
    const [alphaHandle, b1Turn] = await Promise.all([
      client.send({ text: 'G5a 崩溃', messageId: 'p2-05-g5a-a1' }, { mode: 'returnImmediately' }),
      runner.turnStart('g5a-b', 'G5a 崩溃（小智）'),
    ]);

    const alphaDone = await client.waitUntilTerminal(alphaHandle);
    assert.equal(alphaDone.state, 'failed');
    const bDone = await runner.turnWait(b1Turn, 25);
    assert.equal(bDone.error, null);
    const bOutcome = await runner.lastOutcome('g5a-b');
    assert.equal(bOutcome?.presentation, 'failed');
    assert.equal(bOutcome?.state, 'TASK_STATE_FAILED');
    const b1TaskId = bOutcome?.task_id ?? '';
    assert.ok(b1TaskId, 'the provider recorded its task id');

    // Both execution rows settled 'crashed' with REAL abnormal exit evidence,
    // each from a DISTINCT worker subprocess.
    const alphaExec = soleExecution(manager, alphaHandle.taskId!);
    assert.equal(alphaExec.state, 'settled');
    assert.equal(alphaExec.result?.['outcome'], 'crashed');
    const alphaAbnormal = (alphaExec.result?.['exitCode'] ?? 0) !== 0 || alphaExec.result?.['signal'] !== null;
    assert.ok(alphaAbnormal, `crash carries abnormal exit evidence (${JSON.stringify(alphaExec.result)})`);
    assert.ok(alphaExec.workerId?.startsWith('dshw-'));
    const bExec = soleExecution(manager, b1TaskId);
    assert.equal(bExec.state, 'settled');
    assert.equal(bExec.result?.['outcome'], 'crashed');
    const bAbnormal = (bExec.result?.['exitCode'] ?? 0) !== 0 || bExec.result?.['signal'] !== null;
    assert.ok(bAbnormal, `device-channel crash evidence recorded (${JSON.stringify(bExec.result)})`);
    assert.notEqual(bExec.workerId, alphaExec.workerId, 'two real workers crashed independently');
    assert.equal(manager.stats().executions, 2, 'each channel had exactly one real worker');
  } finally {
    if (runner) await runner.close();
    if (service) await stopA2aService(service);
    removeTempDir(dir);
  }
});

test('G5b Worker 崩溃: 外部 SIGKILL 单个 worker → 结算正确，另一渠道 worker 与任务不受影响', { timeout: 180_000 }, async () => {
  const module = await loadDshClientModule();
  const dir = tempDir('g5b');
  let service: StartedA2aService | null = null;
  let runner: XiaozhiRunner | null = null;
  try {
    service = await startDualService(dir, { workerBehavior: 'never-stops' });
    runner = await XiaozhiRunner.start(service.base, dir);
    const manager = managerOf(service);
    const client = makeDshClient(module, service.base, path.join(dir, 'ledger-alpha-g5b.json'));

    await runner.hello('g5b-b');
    const [alphaHandle, b1Turn] = await Promise.all([
      client.send({ text: 'G5b 定点清除', messageId: 'p2-05-g5b-a1' }, { mode: 'returnImmediately' }),
      runner.turnStart('g5b-b', 'G5b 定点清除（小智）'),
    ]);
    const alphaTaskId = alphaHandle.taskId!;
    const b1TaskId = await runner.turnTaskId(b1Turn);
    await waitFor(
      () =>
        (manager.getTaskDetail(alphaTaskId).turns[0]?.executions.length ?? 0) >= 1 &&
        (manager.getTaskDetail(b1TaskId).turns[0]?.executions.length ?? 0) >= 1,
      'both workers never started',
    );

    // THE INJECTION: external SIGKILL of ONLY the alpha worker subprocess.
    const alphaExecBefore = soleExecution(manager, alphaTaskId);
    const match = /^dshw-(\d+)-/.exec(alphaExecBefore.workerId ?? '');
    assert.ok(match, `alpha worker id carries a pid (${alphaExecBefore.workerId})`);
    process.kill(Number(match![1]), 'SIGKILL');

    await waitFor(
      () => manager.getTaskDetail(alphaTaskId).currentState === 'failed',
      'the externally killed worker task never settled FAILED',
    );
    const alphaExec = soleExecution(manager, alphaTaskId);
    assert.equal(alphaExec.state, 'settled');
    assert.equal(alphaExec.result?.['outcome'], 'crashed');
    const abnormal = (alphaExec.result?.['exitCode'] ?? 0) !== 0 || alphaExec.result?.['signal'] !== null;
    assert.ok(abnormal, `external SIGKILL evidence recorded (${JSON.stringify(alphaExec.result)})`);

    // The OTHER channel's worker is unaffected: still working, row still open.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(manager.getTaskDetail(b1TaskId).currentState, 'working', 'the device task must not be affected');
    const bExec = soleExecution(manager, b1TaskId);
    assert.ok(bExec.state !== 'settled' && bExec.state !== 'abandoned', 'the device execution row stays open');
    // The device channel cancels its own task mid-run: real stop evidence.
    await runner.abort('g5b-b');
    await waitFor(
      () => manager.getTaskDetail(b1TaskId).currentState === 'canceled',
      'the device-cancel of the surviving task never settled CANCELED',
    );
    const bExecAfter = soleExecution(manager, b1TaskId);
    assert.equal(bExecAfter.state, 'settled', 'the surviving task settles its own execution row');
    await runner.turnWait(b1Turn, 25);
    const bOutcome = await runner.lastOutcome('g5b-b');
    assert.equal(bOutcome?.cancel_requested, true);
    assert.equal(bOutcome?.presentation, 'canceled');
  } finally {
    if (runner) await runner.close();
    if (service) await stopA2aService(service);
    removeTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// G6 SSE 断流 — 双渠道同刻断流重连（含重订阅路径）；水位独立恢复互不串流
// Fault injection: a COORDINATED TRANSPORT-LEVEL CUT at both clients' own
// seams. The DSH client is built with a fetch seam that wraps every SSE
// response body — flipping the cut errors the open stream. The provider is
// built through its client_factory seam: the runner's stream wrapper raises
// the same transport loss on the open generator. (A transparent TCP proxy
// was tried first and is DEFEATED by agent-card routing: both official SDK
// clients re-target the card's advertised bound URL, bypassing any local
// proxy — recorded as a harness finding in the regression report. The seam
// cut reproduces the identical failure mode the §9.3/#121 recovery paths
// own: an open SSE stream that dies without a terminal status.)
// ---------------------------------------------------------------------------

interface CutController {
  readonly listeners: Set<() => void>;
}

function makeCutController(): CutController {
  return { listeners: new Set() };
}

/** Time-point semantics: firing the cut errors exactly the streams that
 * EXIST at that instant (their registered listeners); streams opened AFTER
 * the cut — both channels' recovery re-attachments — ride healthy
 * transports, which makes the whole G6 sequence deterministic. */
function fireCut(cut: CutController): void {
  for (const listener of [...cut.listeners]) listener();
}

/** SSE-body-cutting fetch: non-SSE traffic passes through untouched; an OPEN
 * SSE body errors the moment its cut listener fires — even with no incoming
 * bytes — so a silent parked stream dies exactly like a severed socket. */
function cuttingFetch(cut: CutController): typeof fetch {
  return (async (input, init) => {
    const response = await fetch(input, init);
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream') || !response.body) return response;
    const source = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const onCut = () => {
          try {
            controller.error(new Error('p2-05 transport cut'));
          } catch {
            // already errored/closed
          }
        };
        cut.listeners.add(onCut);
        void (async () => {
          try {
            for (;;) {
              const result = await source.read();
              if (result.done) {
                cut.listeners.delete(onCut);
                controller.close();
                return;
              }
              controller.enqueue(result.value);
            }
          } catch (error) {
            cut.listeners.delete(onCut);
            try {
              controller.error(error);
            } catch {
              // already errored/closed
            }
          }
        })();
      },
      cancel() {
        void source.cancel();
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}

test('G6 SSE 断流: 双渠道同刻断流（传输接缝切断）→ 各自重订阅恢复；水位独立、互不串流', { timeout: 240_000 }, async () => {
  const module = await loadDshClientModule();
  const dir = tempDir('g6');
  let service: StartedA2aService | null = null;
  let runner: XiaozhiRunner | null = null;
  try {
    service = await startDualService(dir, { workerBehavior: 'stop-on-cancel' });
    runner = await XiaozhiRunner.start(service.base, dir);
    const xzRunnerG6 = runner;
    const manager = managerOf(service);
    const cut = makeCutController();
    const client = makeDshClient(module, service.base, path.join(dir, 'ledger-alpha-g6.json'), cut);

    // Both channels stream; each parks after chunk-1.
    const alphaEvents: StreamEventLike[] = [];
    let alphaTaskId = '';
    let alphaStreamSettled = false;
    const alphaStream = (async () => {
      try {
        for await (const event of client.consumeStream(
          { text: 'G6 双渠道断流', messageId: 'p2-05-g6-a1' },
          { onEvent: (event) => alphaEvents.push(event) },
        )) {
          alphaEvents.push(event);
          if (event.kind === 'task' && event.taskId) alphaTaskId = event.taskId;
        }
      } catch {
        // the cut surfaces as a mapped transport error — expected
      } finally {
        alphaStreamSettled = true;
      }
    })();
    await runner.hello('g6-b');
    const b1Turn = await runner.turnStart('g6-b', 'G6 双渠道断流（小智）');
    await waitFor(
      async () => (await xzRunnerG6.turnState(b1Turn)).fragments >= 1,
      'the device stream never delivered its first fragment',
    );
    await waitFor(
      () => alphaEvents.some((event) => event.kind === 'artifactUpdate'),
      'the alpha stream never delivered its first artifact frame',
    );
    assert.ok(alphaTaskId, 'the alpha stream observed its task frame');
    const b1TaskId = (await runner.lastOutcome('g6-b'))?.task_id ?? '';
    assert.ok(b1TaskId, 'the device turn observed its task frame');

    // THE CUT: both open SSE streams die in the same orchestrated instant —
    // actively, even though neither stream is emitting bytes while parked.
    // Time-point semantics: only the streams alive at this instant are
    // severed; each channel's recovery re-attachment afterwards rides a
    // healthy transport.
    fireCut(cut);
    await runner.cmd('cut_streams', { mode: 'on' });

    // Channel A: the stream fails at transport level.
    await waitFor(() => alphaStreamSettled, 'the alpha stream never settled after the cut', 10_000);
    // Channel B: the provider detects the loss and runs its recovery.
    await waitFor(
      async () => (await xzRunnerG6.lastOutcome('g6-b'))?.disconnected === true,
      'the provider never observed the simultaneous cut',
      15_000,
    );

    // Channel A re-attaches via resubscribe (the #121-safe path).
    const resubEvents: StreamEventLike[] = [];
    let resubSettled = false;
    const resubscribe = (async () => {
      try {
        for await (const event of client.resubscribe({ taskId: alphaTaskId })) {
          resubEvents.push(event);
        }
      } finally {
        resubSettled = true;
      }
    })();
    // Channel B recovers AUTOMATICALLY (snapshot rebuild + SubscribeToTask).
    await waitFor(
      async () => (await xzRunnerG6.lastOutcome('g6-b'))?.resubscribed === true,
      'the provider never resubscribed after the simultaneous cut',
      30_000,
    );

    // Both channels cancel their own tasks → the resubscribed streams deliver
    // the terminal settlements (the recovery path really carries live frames).
    await client.cancel({ taskId: alphaTaskId }, 'G6 断流恢复后取消');
    await runner.rawRpc('CancelTask', { id: b1TaskId });
    await Promise.race([
      resubscribe.then(
        () => undefined,
        () => undefined,
      ),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]);
    const alphaStates = [...alphaEvents, ...resubEvents]
      .map((event) => event.state)
      .filter((state): state is string => typeof state === 'string');
    assert.ok(
      alphaStates.includes('canceled'),
      `the resubscribed alpha stream delivered its terminal settlement (${alphaStates.join(',')})`,
    );
    const alphaTaskIds = new Set(
      [...alphaEvents, ...resubEvents].map((event) => event.taskId).filter((id): id is string => typeof id === 'string'),
    );
    assert.deepEqual([...alphaTaskIds], [alphaTaskId], 'every alpha stream frame belongs to the alpha task (互不串流)');

    // Channel B settles as canceled through its resubscribed stream.
    await runner.turnWait(b1Turn, 25);
    const bOutcome = await runner.lastOutcome('g6-b');
    assert.equal(bOutcome?.presentation, 'canceled');
    assert.equal(bOutcome?.resubscribed, true);
    assert.equal(bOutcome?.disconnected, true, 'the provider honestly recorded the transport cut');
    assert.ok((bOutcome?.delivered_fragments ?? 0) >= 1, 'the provider delivered its own fragment');
    assert.equal(bOutcome?.duplicate_fragments, 0, 'no replay of the delivered prefix (水位恢复不重放)');
    assert.notEqual(bOutcome?.task_id, alphaTaskId, 'the provider turn never crossed to the alpha task');
    const bSummary = await runner.deliverySummary('g6-b');
    assert.ok(bSummary, 'the device delivery watermark was recorded');
    assert.ok(((bSummary?.['deliveredFragments'] as number | undefined) ?? 0) >= 1);
    assert.equal(bSummary?.['duplicateFragments'], 0);
    // A never-used session has NO watermark — the ledgers are independent.
    assert.equal(await runner.deliverySummary('g6-never-used'), null, 'watermarks are session-scoped (独立恢复)');
    // The alpha task's public artifact keeps exactly the pre-cut chunk.
    assert.equal(artifactTextOf(await manager.load(alphaTaskId)), '你好。');
    await resubscribe;
  } finally {
    if (runner) await runner.close();
    if (service) await stopA2aService(service);
    removeTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// G7 重复提交 — 同键同指纹→原 Task；同键异指纹→-32602；跨渠道不混淆
// Channel mix / interleaving: A=DSH idempotent re-send while the device
// channel (raw wire face of the same credential the provider uses) submits
// the IDENTICAL messageId+content — the scoped request key must NOT collide.
// ---------------------------------------------------------------------------

test('G7 重复提交: 同键同指纹→原 Task；同键异指纹→-32602；跨渠道请求键作用域不混淆', { timeout: 180_000 }, async () => {
  const module = await loadDshClientModule();
  const dir = tempDir('g7');
  let service: StartedA2aService | null = null;
  let runner: XiaozhiRunner | null = null;
  try {
    service = await startDualService(dir, { workerBehavior: 'complete' });
    runner = await XiaozhiRunner.start(service.base, dir);
    const manager = managerOf(service);
    const client = makeDshClient(module, service.base, path.join(dir, 'ledger-alpha-g7.json'));

    // Same key (messageId), same fingerprint (identical content) → original task.
    const first = await client.sendAndConsume({ text: 'G7 重复提交探针', messageId: 'p2-05-g7-dup' });
    assert.equal(first.state, 'completed');
    const originalTaskId = first.taskId!;
    const duplicate = await client.send({ text: 'G7 重复提交探针', messageId: 'p2-05-g7-dup' }, { mode: 'returnImmediately' });
    assert.equal(duplicate.taskId, originalTaskId, 'same key + same fingerprint returns the ORIGINAL task');
    assert.equal(soleExecution(manager, originalTaskId).result?.['outcome'], 'completed');
    assert.equal(manager.stats().executions, 1, 'no second execution for the duplicate');

    // Same key, DIFFERENT fingerprint → -32602.
    const conflict = await rpcResultOf(
      service.base,
      1,
      'SendMessage',
      { message: wireMessage('p2-05-g7-dup', 'G7 同键异指纹的内容') },
      { token: ALPHA_TOKEN },
    );
    assert.equal(errorInfo(conflict.body).code, -32602, 'same key + different fingerprint → -32602');
    assert.equal(manager.stats().executions, 1);

    // Cross-channel scope: the DEVICE credential reusing the EXACT same
    // messageId AND content gets a DIFFERENT task — the request key is scoped
    // by the full authenticated binding (跨渠道不混淆).
    const deviceSend = await runner.rawRpc('SendMessage', {
      message: { messageId: 'p2-05-g7-dup', role: 'ROLE_USER', parts: [{ text: 'G7 重复提交探针' }] },
    });
    assert.equal(deviceSend.httpStatus, 200);
    assert.notEqual(taskIdOf(deviceSend.body), originalTaskId, 'the device credential never lands on the alpha task');
    assert.equal(manager.stats().executions, 2, 'the device duplicate created its own scoped task');

    // The provider channel's own idempotency face: message ids are generated
    // per turn (xz-*) — structurally unique across channels.
    await runner.hello('g7-b');
    const turn = await runner.turnStart('g7-b', 'G7 provider 渠道任务');
    await runner.turnWait(turn, 25);
    const outcome = await runner.lastOutcome('g7-b');
    assert.ok((outcome?.message_id ?? '').startsWith('xz-'), 'provider message ids are channel-unique');
    assert.notEqual(outcome?.task_id, originalTaskId);
  } finally {
    if (runner) await runner.close();
    if (service) await stopA2aService(service);
    removeTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// G8 限额与背压（G10） — 单渠道耗尽资源不阻断另一渠道的查询与取消
// Channel mix / interleaving: B0 (device) and A1 (alpha) hold BOTH global
// generation slots; alpha's next request (A2) is refused immediately — the
// saturated surface. Throughout that window the device channel keeps
// querying (own + refused + foreign tasks) and cancels its own active task
// with real stop evidence; after the release the capacity flow resumes.
// ---------------------------------------------------------------------------

const G8_LIMITS: DualLimitsOverride = {
  maxActiveWorkers: 2,
  maxActiveWorkersPerHousehold: 2,
  maxQueuedGlobal: 2,
  maxQueuedPerHousehold: 2,
  admissionWaitMs: 0,
};

test('G8 限额与背压(G10): 容量饱和窗口内 xiaozhi 渠道的查询与取消全程可用；alpha 施压被显式即时拒绝', { timeout: 240_000 }, async () => {
  const module = await loadDshClientModule();
  const dir = tempDir('g8');
  let service: StartedA2aService | null = null;
  let runner: XiaozhiRunner | null = null;
  try {
    service = await startDualService(dir, { workerBehavior: 'never-stops', limits: G8_LIMITS });
    runner = await XiaozhiRunner.start(service.base, dir);
    const manager = managerOf(service);
    const client = makeDshClient(module, service.base, path.join(dir, 'ledger-alpha-g8.json'));

    // B0 (device) parks with slot 1; A1 (alpha) parks with slot 2 → surface
    // saturated.
    await runner.hello('g8-b1');
    const b0Turn = await runner.turnStart('g8-b1', 'G8 并存任务（小智）');
    const b0TaskId = await runner.turnTaskId(b0Turn);
    const a1 = await client.send({ text: 'G8 饱和占用', messageId: 'p2-05-g8-a1' }, { mode: 'returnImmediately' });
    await waitFor(
      () =>
        manager.getTaskDetail(b0TaskId).currentState === 'working' &&
        manager.getTaskDetail(a1.taskId!).currentState === 'working',
      'saturation setup never reached two active workers',
    );

    // alpha's pressure hits the ceiling: A2 refused immediately (no worker).
    const a2 = await client.send({ text: 'G8 施压被拒', messageId: 'p2-05-g8-a2' }, { mode: 'returnImmediately' });
    await waitFor(
      () => manager.getTaskDetail(a2.taskId!).currentState === 'rejected',
      'the over-capacity alpha request never settled REJECTED',
      8_000,
    );
    assert.equal(manager.getTaskDetail(a2.taskId!).turns[0]?.executions.length ?? 0, 0);

    // B's QUERY works while the surface is saturated.
    const bQuery = await runner.rawRpc('GetTask', { id: b0TaskId });
    assert.equal(stateOf(bQuery.body), 'TASK_STATE_WORKING', 'device query unblocked under saturation');
    const bForeign = await runner.rawRpc('GetTask', { id: a1.taskId! });
    assert.equal(errorInfo(bForeign.body).code, -32001, 'isolation holds under saturation');

    // B's next admission is honestly refused while the surface is still
    // saturated, and the refusal is itself queryable — backpressure without
    // blackouts.
    await runner.hello('g8-b2');
    const b2Turn = await runner.turnStart('g8-b2', 'G8 背压拒绝探针（小智）');
    await runner.turnWait(b2Turn, 25);
    const b2Outcome = await runner.lastOutcome('g8-b2');
    assert.equal(b2Outcome?.state, 'TASK_STATE_REJECTED', 'the saturated-global admission settles REJECTED');
    const b2Query = await runner.rawRpc('GetTask', { id: b2Outcome?.task_id ?? '' });
    assert.equal(stateOf(b2Query.body), 'TASK_STATE_REJECTED', 'the refused task stays queryable by its own channel');

    // B's CANCEL works while the surface is saturated: real stop evidence.
    await runner.rawRpc('CancelTask', { id: b0TaskId });
    await waitFor(
      () => manager.getTaskDetail(b0TaskId).currentState === 'canceled',
      'the device cancel never settled',
    );
    const bExec = soleExecution(manager, b0TaskId);
    assert.equal(bExec.state, 'settled', 'the device cancel settled its execution row (real stop)');
    await runner.turnWait(b0Turn, 25);
    assert.equal((await runner.lastOutcome('g8-b1'))?.presentation, 'canceled');

    // Release: B0's freed global slot admits alpha's next task again.
    const a3 = await client.send({ text: 'G8 释放后再受理', messageId: 'p2-05-g8-a3' }, { mode: 'returnImmediately' });
    await waitFor(
      () => manager.getTaskDetail(a3.taskId!).currentState === 'working',
      'the alpha task after the device release was never admitted',
      15_000,
    );
    // The device channel's control lane stayed honest end-to-end.
    const bQueryAfter = await runner.rawRpc('GetTask', { id: b0TaskId });
    assert.equal(stateOf(bQueryAfter.body), 'TASK_STATE_CANCELED');
  } finally {
    if (runner) await runner.close();
    if (service) await stopA2aService(service);
    removeTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// G9 数据删除及撤权 — purge 后双渠道不可访问仅墓碑；另一渠道按授权正确收敛
// Channel mix / interleaving: both channels complete tasks; the DSH channel's
// task is purged (single-task delete-first, then household scope) while the
// device channel observes by authorization; membership revocation lands on
// the alpha principal only.
// ---------------------------------------------------------------------------

test('G9 数据删除及撤权: 删除后仅墓碑、另一渠道可见性按授权收敛；撤权后 403 而设备渠道不受影响', { timeout: 180_000 }, async () => {
  const module = await loadDshClientModule();
  const dir = tempDir('g9');
  let service: StartedA2aService | null = null;
  let runner: XiaozhiRunner | null = null;
  try {
    service = await startDualService(dir, { workerBehavior: 'complete' });
    runner = await XiaozhiRunner.start(service.base, dir);
    const manager = managerOf(service);
    const client = makeDshClient(module, service.base, path.join(dir, 'ledger-alpha-g9.json'));

    // The alpha tasks are created on the RAW wire face so the tombstone
    // retries below reuse the EXACT same canonical content (the request-key
    // fingerprint is content-derived — mixing faces would mint a new key).
    // The DSH client face still owns the task-level evidence via getTask.
    const a1Sent = await rpcResultOf(
      service.base,
      1,
      'SendMessage',
      { message: wireMessage('p2-05-g9-a1', 'G9 将被删除的正文') },
      { token: ALPHA_TOKEN },
    );
    const a1TaskId = taskIdOf(a1Sent.body);
    assert.ok(a1TaskId, 'the alpha deletion target was accepted');
    const a2Sent = await rpcResultOf(
      service.base,
      2,
      'SendMessage',
      { message: wireMessage('p2-05-g9-a2', 'G9 范围删除探针') },
      { token: ALPHA_TOKEN },
    );
    const a2TaskId = taskIdOf(a2Sent.body);
    assert.ok(a2TaskId);
    await runner.hello('g9-b');
    const b1Turn = await runner.turnStart('g9-b', 'G9 保留观察任务（小智）');
    await runner.turnWait(b1Turn, 25);
    const bOutcome = await runner.lastOutcome('g9-b');
    assert.equal(bOutcome?.presentation, 'complete');
    const b1TaskId = bOutcome!.task_id!;
    await waitFor(() => manager.getTaskDetail(a1TaskId).currentState === 'completed', 'a1 never completed');
    await waitFor(() => manager.getTaskDetail(a2TaskId).currentState === 'completed', 'a2 never completed');

    // Cross-principal visibility BEFORE deletion (authorization baseline).
    assert.equal(errorInfo((await runner.rawRpc('GetTask', { id: a1TaskId })).body).code, -32001);
    await assert.rejects(
      () => client.getTask({ taskId: b1TaskId }),
      (error: unknown) => (error as { code?: string }).code === 'task_not_found',
    );

    // Delete-first: journal the deletion, THEN purge the body (single task).
    service.deletionLedger!.recordTaskDeletion({
      taskId: a1TaskId,
      scope: `task:${a1TaskId}`,
      reason: 'processing_authorization_withdrawn',
    });
    manager.purgeTaskBody(a1TaskId);

    // The purged task is a cleaned shell for its OWN principal...
    const shell = await client.getTask({ taskId: a1TaskId });
    assert.equal(shell.state, 'completed', 'the tombstone keeps the terminal state');
    assert.equal(shell.artifactChunks ?? 0, 0, 'no artifact body survives the purge');
    const retry = await rpcResultOf(
      service.base,
      3,
      'SendMessage',
      { message: wireMessage('p2-05-g9-a1', 'G9 将被删除的正文') },
      { token: ALPHA_TOKEN },
    );
    const retryError = errorInfo(retry.body);
    assert.equal(retryError.code, -32000, 'the tombstoned key retry is refused');
    assert.equal(retryError.reason, 'RESULT_PURGED', '…with the RESULT_PURGED reason, never a re-run');
    assert.equal(manager.stats().executions, 3, 'the tombstone retry never re-executed');

    // …and the foreign channel's view converges by AUTHORIZATION both ways.
    assert.equal(
      errorInfo((await runner.rawRpc('GetTask', { id: a1TaskId })).body).code,
      -32001,
      'the device channel still cannot see the alpha task (purged or not)',
    );
    const deviceOwn = await runner.rawRpc('GetTask', { id: b1TaskId });
    assert.equal(stateOf(deviceOwn.body), 'TASK_STATE_COMPLETED', 'the device channel keeps its own task');
    const deviceOwnArtifacts = taskOf(deviceOwn.body)?.['artifacts'];
    assert.ok(Array.isArray(deviceOwnArtifacts) && deviceOwnArtifacts.length >= 1, 'the non-deleted channel task keeps its body');

    // Scope deletion: the whole alpha household is purged; the device
    // household is untouched (可见性按授权正确收敛).
    const scope = purgeProcessingScope({
      taskManager: manager,
      identity: service.identity.store,
      ledger: service.deletionLedger!,
      scope: { kind: 'household', householdId: 'hh-alpha-01' },
      reason: 'processing_authorization_withdrawn',
    });
    assert.ok(scope.purgedTaskIds.includes(a2TaskId), 'the household sweep purges the second alpha task');
    assert.ok(scope.alreadyPurgedTaskIds.includes(a1TaskId), 'the earlier purge is observed as already done');
    const retryA2 = await rpcResultOf(
      service.base,
      4,
      'SendMessage',
      { message: wireMessage('p2-05-g9-a2', 'G9 范围删除探针') },
      { token: ALPHA_TOKEN },
    );
    assert.equal(errorInfo(retryA2.body).reason, 'RESULT_PURGED');
    assert.equal(manager.stats().chunks, 2, 'only the xiaozhi task body remains (2 chunks)');

    // 撤权 (membership): the alpha principal loses everything immediately,
    // while the device channel converges to exactly its authorized view.
    assert.equal(service.identity.revokeMembership('hh-alpha-01', 'user-alpha-guardian'), true);
    const revoked = await rpcResultOf(service.base, 3, 'GetTask', { id: b1TaskId }, { token: ALPHA_TOKEN });
    assert.equal(revoked.httpStatus, 403, 'the revoked principal is denied immediately');
    assert.equal(errorInfo(revoked.body).reason, 'PERMISSION_DENIED');
    const deviceAfter = await runner.rawRpc('GetTask', { id: b1TaskId });
    assert.equal(deviceAfter.httpStatus, 200, 'the device channel is unaffected by the alpha revocation');
  } finally {
    if (runner) await runner.close();
    if (service) await stopA2aService(service);
    removeTempDir(dir);
  }
});
