/**
 * P1-11 (issue #111): official Python SDK (a2a-sdk==1.2.3) × REAL a2a-server
 * interop suite.
 *
 * This harness is the driver demanded by the issue's acceptance criteria:
 *   1. it spawns the REAL standalone service entry (src/main.ts) as a child
 *      process — file-based SQLite task/identity/ledger databases, synthetic
 *      bearer credentials, LUMITHINK_A2A_FINGERPRINT_KEY explicitly set
 *      (dsh-worker mode refuses the public default) and a two-credential
 *      LUMITHINK_A2A_IDENTITY_BOOTSTRAP directory (guardian-a / guardian-b);
 *   2. it runs services/a2a-server/py/python_sdk_interop_probe.py — the
 *      official Python client probe covering the seven issue #111 scenario
 *      groups — and requires exit code 0 (any failed check fails the test;
 *      a missing interpreter or SDK is an explicit FAILURE, never a SKIP);
 *   3. it spot-checks the machine-readable evidence JSON (version record +
 *      per-check pass/fail + key anchors);
 *   4. it cross-checks the server-authoritative SQLite facts behind the
 *      probe's black-box observations (first-response-loss retry → exactly
 *      ONE turn / ONE execution; duplicate cancel → exactly ONE persisted
 *      cancel command), mirroring tests/acceptance-idempotency.spec.ts.
 *
 * Two rounds run (evidence grading is honest, see
 * docs/reviews/2026-10-29-p1-11-python-sdk-interop-verification.md):
 *   - synthetic runtime, probe profile `full` (parkable executor, strict
 *     WORKING assertions) — the direct JS-baseline comparison round;
 *   - dsh-worker runtime (real worker subprocesses), probe profile
 *     `worker-completion` — workers complete on their own, so the probe
 *     asserts the executor-invariant "disconnect never cancels" plus the
 *     settled-state resubscribe branch.
 *
 * Environment contract:
 *   - The Python interpreter is resolved from LUMITHINK_A2A_PYTHON, else
 *     `python`/`python3` on PATH. NONE found → the test FAILS (zero-SKIP is
 *     an explicit #111 exit condition).
 *   - The official SDK must be importable by that interpreter (CI:
 *     `pip install a2a-sdk==1.2.3` via setup-python; local sandbox runs use
 *     the P0-02 verified tree via PYTHONPATH, see
 *     docs/reviews/2026-10-25-p0-02-a2a-sdk-compat-matrix.md §1/§6). A
 *     missing SDK makes the probe exit 3 with a clear message → FAILURE.
 *   - Everything is loopback + synthetic (P1 口径); no real credentials, no
 *     real child data, no UDS switch, no DATABASE_URL.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const PROBE_PATH = path.join(SERVICE_DIR, 'py', 'python_sdk_interop_probe.py');
const FINGERPRINT_KEY = 'p1-11-python-interop-fingerprint-hmac-key';

const PROBE_TIMEOUT_MS = 240_000;
const SERVER_BANNER_TIMEOUT_MS = 30_000;

interface ProbeCheck {
  id: string;
  group: string;
  pass: boolean;
  detail: unknown;
}

interface ProbeEvidence {
  probe: string;
  issue: string;
  runtimeLabel: string;
  versions: Record<string, unknown>;
  checks: ProbeCheck[];
  artifacts: Record<string, string>;
  summary: { total: number; passed: number; failed: number };
}

function resolvePythonInterpreter(): string {
  const candidates = process.env.LUMITHINK_A2A_PYTHON
    ? [process.env.LUMITHINK_A2A_PYTHON]
    : process.platform === 'win32'
      ? ['python', 'python3']
      : ['python3', 'python'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 15_000 });
    if (probe.status === 0 && !probe.error) {
      return candidate;
    }
  }
  // ZERO-SKIP contract (#111): a missing interpreter is a failure with the
  // exact remediation, never a silent skip.
  throw new Error(
    'No Python interpreter found for the official a2a-sdk interop probe. ' +
      'Set LUMITHINK_A2A_PYTHON to a Python >= 3.10 executable, or put python3 ' +
      'on PATH. CI installs Python 3.12 via actions/setup-python. ' +
      `Tried: ${candidates.join(', ')}`,
  );
}

function twoCredentialBootstrap(tokenA: string, tokenB: string): string {
  return JSON.stringify({
    households: [
      { householdId: 'hh-alpha', displayName: 'Alpha family' },
      { householdId: 'hh-beta', displayName: 'Beta family' },
    ],
    users: [
      { userId: 'guardian-a', displayName: 'Guardian A' },
      { userId: 'guardian-b', displayName: 'Guardian B' },
    ],
    memberships: [
      { householdId: 'hh-alpha', userId: 'guardian-a', role: 'guardian' },
      { householdId: 'hh-beta', userId: 'guardian-b', role: 'guardian' },
    ],
    relationships: [],
    clients: [
      { clientId: 'dsh-a', kind: 'dsh_profile', displayName: 'Guardian A DSH profile' },
      { clientId: 'dsh-b', kind: 'dsh_profile', displayName: 'Guardian B DSH profile' },
    ],
    credentials: [
      {
        credentialId: 'cred-a',
        clientId: 'dsh-a',
        token: tokenA,
        binding: 'bound_principal',
        principalUserId: 'guardian-a',
        householdId: 'hh-alpha',
      },
      {
        credentialId: 'cred-b',
        clientId: 'dsh-b',
        token: tokenB,
        binding: 'bound_principal',
        principalUserId: 'guardian-b',
        householdId: 'hh-beta',
      },
    ],
    grants: [],
  });
}

interface StartedServer {
  base: string;
  child: ChildProcess;
  stdout: string;
  stderr: string;
}

async function startServer(env: Record<string, string>): Promise<StartedServer> {
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/main.ts'], {
    cwd: SERVICE_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const base = await new Promise<string>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const match = stdout.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearInterval(timer);
        resolve(match[1]);
      } else if (Date.now() - started > SERVER_BANNER_TIMEOUT_MS) {
        clearInterval(timer);
        reject(
          new Error(
            `a2a-server did not report listening in ${SERVER_BANNER_TIMEOUT_MS}ms; ` +
              `stdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
      }
    }, 100);
  });
  return { base, child, stdout, stderr };
}

async function stopServer(server: StartedServer): Promise<void> {
  const child = server.child;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
  await exited;
}

interface ProbeRun {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runProbe(options: {
  python: string;
  base: string;
  tokenA: string;
  tokenB: string;
  evidencePath: string;
  runtimeLabel: string;
  profile: string;
}): Promise<ProbeRun> {
  const child = spawn(
    options.python,
    [
      PROBE_PATH,
      '--base-url',
      options.base,
      '--token',
      options.tokenA,
      '--token-b',
      options.tokenB,
      '--evidence-out',
      options.evidencePath,
      '--runtime-label',
      options.runtimeLabel,
      '--profile',
      options.profile,
    ],
    {
      cwd: SERVICE_DIR,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const timedOut = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(true);
    }, PROBE_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  return { status: child.exitCode, stdout, stderr, timedOut };
}

function tail(text: string, lines = 40): string {
  const parts = text.split('\n');
  return parts.slice(Math.max(0, parts.length - lines)).join('\n');
}

function requireCheck(evidence: ProbeEvidence, checkId: string): void {
  const check = evidence.checks.find((entry) => entry.id === checkId);
  assert.ok(check, `evidence must contain check ${checkId}`);
  assert.equal(
    check.pass,
    true,
    `check ${checkId} must pass: ${JSON.stringify(check.detail)}`,
  );
}

interface DbRoundAssertions {
  evidence: ProbeEvidence;
  taskDbPath: string;
}

function assertServerSideFacts({ evidence, taskDbPath }: DbRoundAssertions): void {
  // The probe is a black-box client; the server-authoritative "no re-run /
  // no extra side effects" facts live in the SQLite repository (same
  // assertions the in-process acceptance-idempotency spec pins).
  assert.ok(evidence.artifacts.firstResponseLossTaskId, 'evidence records the recovery taskId');
  assert.ok(evidence.artifacts.duplicateCancelTaskId, 'evidence records the duplicate-cancel taskId');
  const db = new DatabaseSync(taskDbPath);
  try {
    const scalar = (sql: string, ...params: (string | number)[]): number => {
      const row = db.prepare(sql).get(...params) as { n: number };
      return Number(row.n);
    };
    const recoveredTaskId = evidence.artifacts.firstResponseLossTaskId;
    assert.equal(
      scalar('SELECT COUNT(*) AS n FROM a2a_turns WHERE task_id = ?', recoveredTaskId),
      1,
      'the first-response-loss retry must NOT create a second turn (acceptance AC2)',
    );
    assert.equal(
      scalar('SELECT COUNT(*) AS n FROM a2a_executions WHERE task_id = ?', recoveredTaskId),
      1,
      'the first-response-loss retry must NOT re-dispatch the execution (acceptance AC2)',
    );
    assert.equal(
      scalar('SELECT COUNT(*) AS n FROM a2a_request_ledger WHERE task_id = ?', recoveredTaskId),
      1,
      'exactly one request-key ledger row backs the recovered task',
    );
    const duplicateCancelTaskId = evidence.artifacts.duplicateCancelTaskId;
    assert.equal(
      scalar(
        "SELECT COUNT(*) AS n FROM a2a_outbox WHERE task_id = ? AND kind = 'cancelCommand'",
        duplicateCancelTaskId,
      ),
      1,
      'duplicate cancel must record exactly ONE persisted cancel intent (fixture 09 semantics)',
    );
    assert.equal(
      scalar('SELECT COUNT(*) AS n FROM a2a_executions WHERE task_id = ?', duplicateCancelTaskId),
      1,
      'the cancel path must not grow extra executions',
    );
  } finally {
    db.close();
  }
}

async function runInteropRound(testContext: {
  runtimeMode: 'synthetic' | 'dsh-worker';
  runtimeLabel: string;
  profile: string;
  python: string;
}): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'a2a-p1-11-pyinterop-'));
  const tokenA = `py-interop-a-${randomBytes(16).toString('hex')}`;
  const tokenB = `py-interop-b-${randomBytes(16).toString('hex')}`;
  const taskDbPath = path.join(dir, 'tasks.sqlite');
  const evidencePath = path.join(dir, 'py-interop-evidence.json');
  let server: StartedServer | null = null;
  try {
    assert.ok(existsSync(PROBE_PATH), `probe missing: ${PROBE_PATH}`);
    server = await startServer({
      LUMITHINK_A2A_VALIDATION_TOKEN: tokenA,
      LUMITHINK_A2A_VALIDATION_PORT: '0',
      LUMITHINK_A2A_VALIDATION_DB: taskDbPath,
      LUMITHINK_A2A_IDENTITY_DB: path.join(dir, 'identity.sqlite'),
      LUMITHINK_A2A_DELETION_LEDGER_DB: path.join(dir, 'deletion-ledger.sqlite'),
      LUMITHINK_A2A_FINGERPRINT_KEY: FINGERPRINT_KEY,
      LUMITHINK_A2A_IDENTITY_BOOTSTRAP: twoCredentialBootstrap(tokenA, tokenB),
      LUMITHINK_A2A_RUNTIME_MODE: testContext.runtimeMode,
    });

    const run = await runProbe({
      python: testContext.python,
      base: server.base,
      tokenA,
      tokenB,
      evidencePath,
      runtimeLabel: testContext.runtimeLabel,
      profile: testContext.profile,
    });
    assert.equal(
      run.timedOut,
      false,
      `probe timed out after ${PROBE_TIMEOUT_MS}ms\nstdout tail:\n${tail(run.stdout)}`,
    );
    assert.equal(
      run.status,
      0,
      `probe must exit 0 (any failed check is a hard failure). ` +
        `exit=${run.status}\nstdout tail:\n${tail(run.stdout)}\nstderr tail:\n${tail(run.stderr)}`,
    );

    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as ProbeEvidence;
    assert.equal(evidence.probe, 'python_sdk_interop_probe');
    assert.equal(evidence.issue, 'https://github.com/lybym/LumiThink/issues/111');
    assert.equal(evidence.runtimeLabel, testContext.runtimeLabel);
    assert.equal(evidence.summary.failed, 0, 'evidence summary must record zero failed checks');
    assert.ok(evidence.summary.total >= 20, `expected >= 20 checks, got ${evidence.summary.total}`);
    const pythonSdk = String(evidence.versions.pythonSdk ?? '');
    assert.match(pythonSdk, /a2a-sdk==1\.2\.3/, `evidence must pin the locked SDK, got: ${pythonSdk}`);
    assert.equal(
      evidence.versions.a2aVersionHeader,
      '1.0',
      'every probe request must carry A2A-Version: 1.0',
    );
    assert.equal(
      evidence.checks.some((check) => !check.pass),
      false,
      'every recorded check must pass',
    );

    // Spot-check the anchor checks of each scenario group.
    for (const checkId of [
      'card.discovery',
      'a2aVersion.perRequest',
      'version.missingHeaderRefused',
      'version.unsupported9_9Refused',
      'auth.unauthenticated401',
      'blocking.taskOnlyCompleted',
      'streaming.taskFirstAndChunkOwnership',
      'getTask.snapshotAggregation',
      'multiTurn.contextContinuation',
      'firstResponseLoss.sameTaskIdRetry',
      'firstResponseLoss.streamingDuplicateSingleFrame',
      'conflict.sameKeyDifferentContent',
      'conflict.wireReasonAndNoLeak',
      'disconnect.officialClientEarlyBreakNotCanceled',
      'disconnect.explicitCloseNotCanceled',
      'identity.crossGetDenied',
      'identity.crossCancelDenied',
      'identity.crossSubscribeDenied',
      'identity.forgedMetadataIgnored',
      'identity.crossPrincipalSameMessageIdDistinctKey',
      'identity.listTasksFiltered',
      'cancel.activeTaskToCanceled',
      'cancel.duplicateIdempotentSuccess',
      'cancel.onCompletedTaskNotCancelable',
      'cancel.onCompletedWireShape',
      'cancel.unknownTaskNotFound',
      'getTask.unknownTaskNotFound',
      'subscribe.terminalTaskUnsupported',
      'subscribe.terminalWireShape',
    ]) {
      requireCheck(evidence, checkId);
    }
    if (testContext.profile === 'full') {
      requireCheck(evidence, 'resubscribe.activeTaskDeliversTask');
    } else {
      // The dsh-worker round branches the resubscribe/terminal checks on the
      // settled state; exactly one of the two anchors must have run and passed.
      const resubscribeChecks = evidence.checks.filter((check) =>
        check.id.startsWith('resubscribe.'),
      );
      assert.ok(
        resubscribeChecks.length >= 1 && resubscribeChecks.every((check) => check.pass),
        'the dsh-worker round must pass its reachable resubscribe anchor',
      );
      const terminalChecks = evidence.checks.filter((check) => check.id.startsWith('subscribe.'));
      assert.ok(
        terminalChecks.length >= 1 && terminalChecks.every((check) => check.pass),
        'the dsh-worker round must pass its reachable terminal-subscription anchor',
      );
    }

    await stopServer(server);
    server = null;
    assertServerSideFacts({ evidence, taskDbPath });
  } finally {
    if (server !== null) await stopServer(server);
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

test('python official SDK (a2a-sdk==1.2.3) interop: full probe passes against the real subprocess server (synthetic runtime)', async () => {
  const python = resolvePythonInterpreter();
  await runInteropRound({
    runtimeMode: 'synthetic',
    runtimeLabel: 'synthetic',
    profile: 'full',
    python,
  });
});

test('python official SDK (a2a-sdk==1.2.3) interop: probe passes against the real dsh-worker subprocess runtime', async () => {
  const python = resolvePythonInterpreter();
  await runInteropRound({
    runtimeMode: 'dsh-worker',
    runtimeLabel: 'dsh-worker',
    profile: 'worker-completion',
    python,
  });
});
