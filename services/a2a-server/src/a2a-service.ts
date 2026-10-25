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
 *   6. jsonRpcHandler (locked SDK)     — JSON-RPC over HTTPS + SSE; the user
 *                                        builder projects the resolved
 *                                        AuthContext into ServerCallContext.user;
 *   7. jsonRpcParseErrorHandler        — malformed JSON → standard -32700.
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
  type AgentExecutor,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import type { AgentCard } from '@a2a-js/sdk';
import { type A2aServiceConfig } from './config.ts';
import { buildLumithinkAgentCard } from './lumithink-agent-card.ts';
import { jsonRpcParseErrorHandler, requireA2aVersion } from './error-map.ts';
import { SyntheticExecutor } from './synthetic-executor.ts';
import { SqliteTaskManager } from './task-manager/sqlite-task-manager.ts';
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
  /** Resolves when the server has fully closed (after close()). */
  closed: Promise<void>;
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
    authoritativeStore = new SqliteTaskManager({ dbPath: config.dbPath });
    ownsTaskStore = true;
  }
  const guardedTaskStore = authorizingTaskStore(authoritativeStore, { store: identity.store });
  const executor =
    options.executor ??
    new SyntheticExecutor({ authorizationGate: (taskId) => identity.executorGate(taskId) });
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
  app.use('/', jsonRpcHandler({ requestHandler, userBuilder: lumithinkUserBuilder }));
  app.use('/', jsonRpcParseErrorHandler());

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
    closed,
  };
}

export async function stopA2aService(service: StartedA2aService): Promise<void> {
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
  // Close the stores the service owns AFTER the listener is down — a store
  // must never be closed while the handler can still reach it.
  if (service.ownsTaskStore && service.taskStore instanceof SqliteTaskManager) {
    service.taskStore.close();
  }
  if (service.ownsIdentity) {
    service.identity.store.close();
  }
}
