/**
 * Composition root of the LumiThink A2A validation service
 * (P1-01 #83, P1-02 #84, P1-03 #85).
 *
 * Express chain, in order (loopback-only HTTP server):
 *   1. express.json                    — JSON body parsing;
 *   2. /.well-known/agent-card.json    — Agent Card discovery (unauthenticated);
 *   3. requireA2aVersion               — explicit A2A-Version guard (R7);
 *   4. requireTwoTierAuth              — Client/Principal identity resolution
 *                                        against the identity store (P1-03):
 *                                        401/-32000 AUTHENTICATION_REQUIRED on
 *                                        credential failure, 403 PERMISSION_DENIED
 *                                        on principal/grant failure; live streams
 *                                        are registered for revocation teardown;
 *   5. requireContextAccess            — 会话续接 guard: a contextId already
 *                                        bound to another household/principal is
 *                                        rejected (-32602) before the handler;
 *   6. requireIdempotentAcceptance     — PERSISTENT idempotent acceptance
 *                                        (P1-04): scoped request key + versioned
 *                                        HMAC fingerprint through the repository's
 *                                        atomic ledger transaction; duplicates
 *                                        return the ORIGINAL task snapshot without
 *                                        re-running the executor; key reuse with
 *                                        different content → -32602
 *                                        MESSAGE_ID_CONFLICT; tombstoned →
 *                                        RESULT_PURGED;
 *   7. jsonRpcHandler (locked SDK)     — JSON-RPC over HTTPS + SSE; the user
 *                                        builder projects the resolved
 *                                        AuthContext into ServerCallContext.user;
 *                                        the executor is wrapped by the
 *                                        dispatch-lease decorator (quota →
 *                                        claimExecution → authorization
 *                                        re-check → Worker);
 *   8. jsonRpcParseErrorHandler        — malformed JSON → standard -32700.
 *
 * P1-08 (#90): BEFORE the listener opens, the independent deletion ledger is
 * opened and replayed (恢复时先重放删除——已删数据不能复活) and the startup
 * recovery scan settles every persisted non-terminal state from persisted
 * facts (interrupted executions → abandoned + FAILED; confirmed-never-started
 * → re-dispatch through the same lease path; settled evidence → re-derived
 * public settlement).
 *
 * The SDK handler receives EXACTLY ONE Task Store (see task-manager-port.ts):
 * the SQLite Task Manager (P1-02) wrapped in the authorizing decorator
 * (P1-03) that binds task ownership at acceptance time and re-checks access
 * on every load/list. There is no second store and no double write.
 *
 * Identity is a SEPARATE module/database from the Task Manager (ADR-0014);
 * the default directory seeds the required bearer token as the synthetic
 * validation-harness credential (principal-bound guardian of one synthetic
 * household) so the P1-01 single-token contract keeps working.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  RequestContext,
  ResultManager,
  ServerCallContext,
  type AgentExecutionEvent,
  type AgentExecutor,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { TaskState, type AgentCard, type Message, type SendMessageRequest } from '@a2a-js/sdk';
import { type A2aServiceConfig } from './config.ts';
import { buildLumithinkAgentCard, LUMITHINK_AGENT_NAME } from './lumithink-agent-card.ts';
import { jsonRpcParseErrorHandler, requireA2aVersion } from './error-map.ts';
import { SyntheticExecutor } from './synthetic-executor.ts';
import { SqliteTaskManager } from './task-manager/sqlite-task-manager.ts';
import { requireIdempotentAcceptance } from './acceptance/acceptance-gate.ts';
import { leaseDispatchExecutor, type QuotaGate } from './acceptance/dispatch-lease-executor.ts';
import { DshWorkerRuntime } from './runtime/dsh-worker-runtime.ts';
import { DshWorkerExecutor } from './runtime/dsh-worker-executor.ts';
import { DeletionLedger } from './recovery/deletion-ledger.ts';
import { runStartupRecovery, type StartupRecoveryReport } from './recovery/startup-recovery.ts';
import { AdmissionScheduler } from './limits/scheduler.ts';
import { limitsAwareExecutor, type LeaseAware } from './limits/admission.ts';
import {
  ObservabilityRecorder,
  jsonLineSink,
  type LoadReport,
  type ObservabilitySink,
} from './limits/observability.ts';
import { buildLoadReport } from './limits/load-report.ts';
import {
  IdentityController,
  StreamRegistry,
  authorizingTaskStore,
  lumithinkUserBuilder,
  requireContextAccess,
  requireTwoTierAuth,
} from './identity/express-auth.ts';
import { Authorizer } from './identity/authorizer.ts';
import {
  IdentityStore,
  defaultValidationBootstrap,
  parseIdentityBootstrap,
  type IdentityBootstrap,
} from './identity/identity-store.ts';

export interface StartA2aServiceOptions {
  config: A2aServiceConfig;
  /**
   * Single authoritative Task Store. Defaults to the SQLite Task Manager
   * wrapped in the P1-03 authorizing decorator.
   */
  taskStore?: import('@a2a-js/sdk/server').TaskStore;
  /** Defaults to the SYNTHETIC executor (never a real DSH execution). */
  executor?: AgentExecutor;
  /** Override for tests that need a custom card (default: LumiThink card). */
  agentCard?: AgentCard;
  /** Overrides the default synthetic identity directory (tests). */
  identityBootstrap?: IdentityBootstrap;
  /** Pre-built identity controller (tests that share one directory). */
  identity?: IdentityController;
  /**
   * Dispatch quota re-check consulted BEFORE the execution-lease claim
   * (P1-04 AC 3 派发前复查限额). Default: allow-all — the real resource
   * limits are P1-09/#91; tests inject denials here.
   */
  quotaGate?: QuotaGate;
  /**
   * Structured observability sink (P1-09 AC 3). Omitted = one JSON line per
   * event on stdout. Tests pass a capture sink. The recorder NEVER writes
   * message content or credentials — see src/limits/observability.ts.
   */
  observabilitySink?: ObservabilitySink;
  /** Injectable clock (tests; also drives `uptimeMs` in the load report). */
  now?: () => number;
}

export interface StartedA2aService {
  /** Loopback base URL, e.g. http://127.0.0.1:3312 */
  base: string;
  server: http.Server;
  agentCard: AgentCard;
  /** The AUTHORITATIVE store inside the decorator (the object callers passed in). */
  taskStore: import('@a2a-js/sdk/server').TaskStore;
  /** True when the service created (and owns/closes) the task store. */
  ownsTaskStore: boolean;
  requestHandler: DefaultRequestHandler;
  executor: AgentExecutor;
  config: A2aServiceConfig;
  /** Identity & authorization controller (P1-03): revocation, gates, audit. */
  identity: IdentityController;
  /** True when the service created (and owns/closes) the identity store. */
  ownsIdentity: boolean;
  /**
   * Real DSH worker runtime (P1-05) — present only in dsh-worker mode.
   * stopA2aService disposes it (kills every live worker process).
   */
  runtime?: DshWorkerRuntime;
  /** Independent deletion ledger (P1-08) — owned + closed by the service. */
  deletionLedger?: DeletionLedger;
  /**
   * Startup recovery report (P1-08): what the scan settled/abandoned/
   * re-dispatched before the listener opened. Undefined with a custom
   * Task Store (recovery semantics are repository-owned).
   */
  recovery?: StartupRecoveryReport;
  /** True when the service created (and owns/closes) the deletion ledger. */
  ownsDeletionLedger: boolean;
  /** Resolves when the server has fully closed (after close()). */
  closed: Promise<void>;
  /**
   * AC 1/AC 2 bounded-resource state (P1-09): the admission scheduler holds
   * every capacity fact. Exposed for the load report and for tests that need
   * to prove no slot/lease leaked.
   */
  admission: {
    scheduler: AdmissionScheduler;
    recorder: ObservabilityRecorder;
    /** AC 4: measured load report (SQLite lock, Outbox backlog, worker memory). */
    loadReport(): LoadReport;
  };
}

function buildIdentityController(options: StartA2aServiceOptions): {
  controller: IdentityController;
  owned: boolean;
} {
  const { config } = options;
  if (options.identity) return { controller: options.identity, owned: false };
  const store = new IdentityStore({ dbPath: config.identityDbPath });
  let bootstrap: IdentityBootstrap;
  if (options.identityBootstrap) {
    bootstrap = options.identityBootstrap;
  } else if (config.identityBootstrapJson !== undefined) {
    bootstrap = parseIdentityBootstrap(config.identityBootstrapJson);
  } else {
    bootstrap = defaultValidationBootstrap(config.bearerToken);
  }
  store.applyBootstrap(bootstrap);
  const authorizer = new Authorizer({ store });
  const registry = new StreamRegistry();
  return { controller: new IdentityController({ store, authorizer, registry }), owned: true };
}

export async function startA2aService(
  options: StartA2aServiceOptions,
): Promise<StartedA2aService> {
  const { config } = options;
  const nowMs = options.now ?? (() => Date.now());
  const startedAtMs = nowMs();
  // P1-09 (issue #91): structured, content-minimized observability (AC 3).
  // The recorder drops any non allow-listed field, so a caller passing a body
  // string can never leak it into the log stream.
  const recorder = new ObservabilityRecorder({
    sinks: [
      options.observabilitySink ??
        jsonLineSink((line) => {
          console.log(line);
        }),
    ],
    now: nowMs,
  });
  // P1-09 (issue #91): the bounded admission scheduler (AC 1/AC 2). Limits
  // come from config (defaults = frozen §13.4 initial protection values).
  const scheduler = new AdmissionScheduler({ limits: config.limits, now: nowMs });
  // P1-02 (#84): the default store is the SQLite Task Manager — the single
  // authoritative write path over the unified repository. There is NO second
  // store: when a caller passes its own TaskStore, that store replaces the
  // default entirely (never both). P1-03 (#85): the store handed to the SDK
  // handler is wrapped in the authorizing decorator (binds ownership,
  // enforces task/context ACL); `started.taskStore` keeps pointing at the
  // authoritative inner store.
  const built = buildIdentityController(options);
  const identity = built.controller;
  const ownsIdentity = built.owned;
  let ownsTaskStore = false;
  let authoritativeStore: import('@a2a-js/sdk/server').TaskStore;
  if (options.taskStore !== undefined) {
    authoritativeStore = options.taskStore;
  } else {
    // P1-09 (AC 4): the store's bounded write-lock wait is the SAME value
    // the load report publishes (limits.sqlite.busyTimeoutMs), so the two can
    // never drift apart.
    authoritativeStore = new SqliteTaskManager({
      dbPath: config.dbPath,
      busyTimeoutMs: config.limits.sqlite.busyTimeoutMs,
    });
    ownsTaskStore = true;
  }
  // P1-04 (#86): the idempotency gate and the dispatch lease are
  // REPOSITORY-owned semantics — they wire only when the authoritative store
  // is the SQLite Task Manager; a caller-supplied custom TaskStore passes
  // through unchanged (no second store, no partial semantics).
  const sqliteTaskManager =
    authoritativeStore instanceof SqliteTaskManager ? authoritativeStore : undefined;
  const guardedTaskStore = authorizingTaskStore(authoritativeStore, { store: identity.store });
  // P1-05 (#87): dsh-worker mode wires the REAL DSH worker subprocess
  // runtime as the inner executor. The runtime-lease semantics are
  // repository-owned (attribution/settlement), so this mode REQUIRES the
  // SQLite Task Manager (fail-closed with a custom Task Store) and cannot
  // be combined with an explicit executor override.
  let runtime: DshWorkerRuntime | undefined;
  let innerExecutor: AgentExecutor;
  if (config.runtimeMode === 'dsh-worker') {
    if (sqliteTaskManager === undefined) {
      throw new Error(
        'runtime mode dsh-worker requires the SQLite Task Manager (runtime lease, ' +
          'execution attribution and settlement are repository semantics); ' +
          'a custom Task Store cannot dispatch real workers',
      );
    }
    if (options.executor !== undefined) {
      throw new Error(
        'runtime mode dsh-worker builds its own executor; do not pass executor explicitly',
      );
    }
    // P1-09 (§13.4 row "Worker 内存"): the declared ceiling becomes the
    // worker's V8 heap cap. It is reported as 'v8_heap_flag' + hardLimit:false
    // — never pretended to be an OS-level limit (see memoryEnforcement()).
    // §13.4 also requires the § execution deadline to be enforceable by the
    // runtime watchdog, so the watchdog timeout is the smaller of both.
    const watchdogTimeoutMs = Math.min(
      config.dshWorker.executionTimeoutMs,
      config.limits.execution.maxExecutionMs,
    );
    runtime = new DshWorkerRuntime({
      workerEntryPath: config.dshWorker.entryPath,
      executionTimeoutMs: watchdogTimeoutMs,
      helloTimeoutMs: config.dshWorker.helloTimeoutMs,
      lostContactMs: config.dshWorker.lostContactMs,
      cancelGraceMs: config.dshWorker.cancelGraceMs,
      workerEnv: config.dshWorker.workerEnv,
      workerMemoryLimitBytes: config.limits.worker.memoryLimitBytes,
    });
    innerExecutor = new DshWorkerExecutor({ runtime, taskManager: sqliteTaskManager });
  } else {
    innerExecutor =
      options.executor ??
      new SyntheticExecutor({ authorizationGate: (taskId) => identity.executorGate(taskId) });
  }
  /**
   * Household attribution for admission (P1-09). The authoritative binding
   * lives in the identity store; a task with no resolvable binding is
   * attributed to its own task scope, which keeps per-household caps from
   * silently merging unrelated tasks into one bucket.
   */
  const householdOf = (taskId: string): string => {
    try {
      const binding = identity.store.taskBinding(taskId);
      if (binding !== undefined && binding.householdId !== null) return binding.householdId;
    } catch {
      // fall through to the per-task scope
    }
    return 'task-scope:' + taskId;
  };
  // P1-09 (issue #91): bound the ACTUAL execution — slot admission, the
  // §13.4 execution deadline, and the single leak-proof release point. It
  // sits ABOVE the concrete executor and BELOW the dispatch-lease decorator,
  // so the lease/settlement semantics stay repository-owned.
  const boundedExecutor = limitsAwareExecutor({
    inner: innerExecutor,
    scheduler,
    limits: config.limits,
    recorder,
    householdOf,
    now: nowMs,
  }) as AgentExecutor & Partial<LeaseAware>;

  const executor = leaseDispatchExecutor({
    inner: boundedExecutor,
    taskManager: sqliteTaskManager,
    authorizationGate: (taskId) => identity.executorGate(taskId),
    quotaGate: options.quotaGate,
    leaseTtlMs: config.dispatchLeaseTtlMs,
  });

  // P1-08 (#90): the deletion ledger + startup recovery scan run BEFORE the
  // listener opens (TASK_LIFECYCLE §9: 恢复时先重放删除和撤权、清理缓存及待
  // 发事件，再开放服务). Both are repository-owned semantics — with a
  // caller-supplied custom Task Store neither wires (no partial recovery).
  let deletionLedger: DeletionLedger | undefined;
  let recovery: StartupRecoveryReport | undefined;
  if (sqliteTaskManager !== undefined) {
    deletionLedger = new DeletionLedger({ dbPath: config.deletionLedgerDbPath });
    const recoveryBusManager = new DefaultExecutionEventBusManager();
    /**
     * Re-dispatch of a CONFIRMED-never-started task (submitted, no execution
     * row): the real executor through its quota → claim → authorization →
     * worker sequence; events persist through the SDK's own ResultManager
     * wired to the SAME authoritative repository — the recovery path and
     * the request path share one write face (§9: 再次检查取消、授权和资源配额).
     */
    const recoveryDispatch = async (taskId: string, inputMessage: Message): Promise<void> => {
      const contextId = sqliteTaskManager.getTaskDetail(taskId).contextId;
      const context = new ServerCallContext({ requestedVersion: '1.0' });
      const bus = recoveryBusManager.createOrGetByTaskId(taskId, context);
      const resultManager = new ResultManager(sqliteTaskManager, context);
      resultManager.setContext(inputMessage);
      bus.on('event', (event: AgentExecutionEvent) => {
        void resultManager.processEvent(event).catch((error: unknown) => {
          console.error(
            `[lumithink-a2a] recovery event persistence failed for task ${taskId}:`,
            error,
          );
        });
      });
      try {
        // The proto-generated SendMessageRequest carries required (nullable)
        // envelope fields; the recovery path only needs the original message.
        const request: SendMessageRequest = {
          message: inputMessage,
          configuration: undefined,
          metadata: undefined,
          tenant: '',
        };
        await executor.execute(new RequestContext(request, taskId, contextId, context), bus);
      } catch {
        // Mirror the SDK handler's rejection settlement: a synthetic FAILED
        // status so persisted state converges (the lease decorator already
        // closed the execution row; ResultManager re-loads from the store
        // and enforces terminal irreversibility itself).
        bus.publish({
          kind: 'statusUpdate',
          data: {
            taskId,
            contextId,
            status: {
              state: TaskState.TASK_STATE_FAILED,
              message: undefined,
              timestamp: new Date().toISOString(),
            },
            metadata: undefined,
          },
        });
      } finally {
        // Drain the queued event-persistence microtasks before settling the
        // bus (events were dispatched synchronously into processEvent).
        await new Promise((resolve) => setImmediate(resolve));
        bus.finished();
        recoveryBusManager.cleanupByTaskId(taskId, context);
      }
    };
    recovery = await runStartupRecovery({
      taskManager: sqliteTaskManager,
      identity: identity.store,
      ledger: deletionLedger,
      requeue: recoveryDispatch,
    });
  }
  // The handler keeps a reference to this card object; URL fields are
  // finalized in place once the loopback port is bound (P0-02 pattern).
  const agentCard = options.agentCard ?? buildLumithinkAgentCard(`http://${config.host}:0`);
  const requestHandler = new DefaultRequestHandler(
    agentCard,
    guardedTaskStore,
    executor,
    new DefaultExecutionEventBusManager(),
  );

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: requestHandler }));
  app.use('/', requireA2aVersion({ supportedVersions: config.supportedVersions }));
  app.use(
    '/',
    requireTwoTierAuth({
      authorizer: identity.authorizer,
      store: identity.store,
      registry: identity.registry,
    }),
  );
  app.use('/', requireContextAccess({ store: identity.store }));
  // P1-04 (#86): persistent idempotent acceptance — runs BEFORE the SDK
  // handler so the ledger/Task/Turn/Outbox acceptance transaction commits
  // first and the SDK handler dispatches the ACCEPTED task id; duplicates
  // return the original snapshot without re-running the executor.
  app.use(
    '/',
    requireIdempotentAcceptance({
      taskManager: sqliteTaskManager,
      identity: identity.store,
      fingerprintKey: config.fingerprintKey,
      agentName: LUMITHINK_AGENT_NAME,
    }),
  );
  // P1-09 (#91, AC 4): the load report is an OPERATIONAL surface, not an
  // A2A method — it lives on its own authenticated path so it never widens
  // the locked protocol surface. It is mounted AFTER two-tier auth (so it
  // needs a real credential) and answers from the CONTROL lane, which keeps
  // it responsive while generation slots are saturated (AC 1).
  app.get('/ops/load-report', async (req, res) => {
    if (req.lumithinkAuth === undefined) {
      res.status(401).json({ error: 'authentication required' });
      return;
    }
    const permit = await scheduler.acquireControl(config.limits.control.controlHandlingDeadlineMs);
    if (permit === null) {
      // Bounded control handling: never hang behind a saturated control lane.
      recorder.emit({
        level: 'warn',
        event: 'control.handled',
        decision: 'deny',
        reason: 'control_lane_deadline',
        durationMs: config.limits.control.controlHandlingDeadlineMs,
      });
      res.status(503).json({
        error: 'control_lane_busy',
        detail: 'the reserved control lane did not free up within controlHandlingDeadlineMs',
      });
      return;
    }
    try {
      const report = loadReportNow();
      recorder.emit({ event: 'load.report', decision: 'allow', reason: 'served' });
      res.status(200).json(report);
    } finally {
      permit.release();
    }
    return;
  });
  app.use('/', jsonRpcHandler({ requestHandler, userBuilder: lumithinkUserBuilder }));
  app.use('/', jsonRpcParseErrorHandler());

  /**
   * AC 4 load report. Built on demand from live measurement surfaces; the
   * operational route and StartedA2aService.admission.loadReport() share it.
   */
  const loadReportNow = (): LoadReport =>
    buildLoadReport({
      runtimeMode: config.runtimeMode,
      limits: config.limits,
      scheduler: scheduler.snapshot(),
      taskManager: sqliteTaskManager,
      runtime,
      startedAtMs,
      now: nowMs,
    });

  const server = http.createServer(app);
  const closed = new Promise<void>((resolve, reject) => {
    server.once('close', resolve);
    server.once('error', reject);
  });
  // HARD LOOPBACK BIND: config.host is '127.0.0.1' by construction; the
  // validation service must never listen on a public interface.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  const boundPort = (server.address() as AddressInfo).port;
  const base = `http://${config.host}:${boundPort}`;
  agentCard.supportedInterfaces = agentCard.supportedInterfaces.map((entry) => ({
    ...entry,
    url: base,
  }));

  return {
    base,
    server,
    agentCard,
    taskStore: authoritativeStore,
    ownsTaskStore,
    requestHandler,
    executor,
    config,
    identity,
    ownsIdentity,
    runtime,
    deletionLedger,
    recovery,
    ownsDeletionLedger: deletionLedger !== undefined,
    closed,
    admission: {
      scheduler,
      recorder,
      // AC 4: every number is read from a live measurement surface at call
      // time (never cached at startup).
      loadReport: loadReportNow,
    },
  };
}

export async function stopA2aService(service: StartedA2aService): Promise<void> {
  // P1-09 (AC 1): stop admitting BEFORE the listener drops. Queued waiters
  // receive an explicit scheduler_closed refusal (settled REJECTED by the
  // admission wrapper) instead of a timeout; held tickets are released by
  // their own execution paths, never by the shutdown.
  service.admission?.scheduler.close();
  if (service.server.listening) {
    // Force-close lingering sockets (e.g. SSE streams whose client generator
    // was abandoned mid-stream) before close(): the validation service is an
    // ephemeral loopback process, in-flight streams are never resumed after
    // shutdown, and server.close() alone would wait on them forever.
    service.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      service.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  await service.closed;
  // Real worker processes (P1-05) are torn down BEFORE the stores close —
  // no orphan process survives service shutdown.
  if (service.runtime !== undefined) {
    await service.runtime.dispose();
  }
  // Close the stores the service owns AFTER the listener is down — a store
  // must never be closed while the handler can still reach it.
  if (service.ownsTaskStore && service.taskStore instanceof SqliteTaskManager) {
    service.taskStore.close();
  }
  if (service.ownsIdentity) {
    service.identity.store.close();
  }
  // The independent deletion ledger outlives the task store by contract
  // (P1-08): closed LAST, after every writer is gone.
  if (service.ownsDeletionLedger && service.deletionLedger !== undefined) {
    service.deletionLedger.close();
  }
}
