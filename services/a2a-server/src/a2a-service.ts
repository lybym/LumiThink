/**
 * Composition root of the LumiThink A2A validation service (P1-01, #83).
 *
 * Express chain, in order (loopback-only HTTP server):
 *   1. express.json                    — JSON body parsing;
 *   2. /.well-known/agent-card.json    — Agent Card discovery (unauthenticated);
 *   3. requireA2aVersion               — explicit A2A-Version guard (R7);
 *   4. requireBearerAuth               — synthetic validation bearer gate;
 *   5. jsonRpcHandler (locked SDK)     — JSON-RPC over HTTPS + SSE;
 *   6. jsonRpcParseErrorHandler        — malformed JSON → standard -32700.
 *
 * The SDK handler receives EXACTLY ONE Task Store (see task-manager-port.ts)
 * — since P1-02 (#84) the default is the SQLite Task Manager over the
 * unified repository (src/task-manager/), the single authoritative write
 * path. There is no second store and no double write.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  DefaultExecutionEventBusManager,
  DefaultRequestHandler,
  type AgentExecutor,
  type TaskStore,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import type { AgentCard } from '@a2a-js/sdk';
import { type A2aServiceConfig } from './config.ts';
import { buildLumithinkAgentCard } from './lumithink-agent-card.ts';
import { jsonRpcParseErrorHandler, requireA2aVersion, requireBearerAuth } from './error-map.ts';
import { SyntheticExecutor } from './synthetic-executor.ts';
import { SqliteTaskManager } from './task-manager/sqlite-task-manager.ts';

export interface StartA2aServiceOptions {
  config: A2aServiceConfig;
  /** Single authoritative Task Store. Defaults to the SDK in-memory stand-in. */
  taskStore?: TaskStore;
  /** Defaults to the SYNTHETIC executor (never a real DSH execution). */
  executor?: AgentExecutor;
  /** Override for tests that need a custom card (default: LumiThink card). */
  agentCard?: AgentCard;
}

export interface StartedA2aService {
  /** Loopback base URL, e.g. http://127.0.0.1:3312 */
  base: string;
  server: http.Server;
  agentCard: AgentCard;
  taskStore: TaskStore;
  /** True when the service created (and owns/closes) the task store. */
  ownsTaskStore: boolean;
  requestHandler: DefaultRequestHandler;
  executor: AgentExecutor;
  config: A2aServiceConfig;
  /** Resolves when the server has fully closed (after close()). */
  closed: Promise<void>;
}

export async function startA2aService(
  options: StartA2aServiceOptions,
): Promise<StartedA2aService> {
  const { config } = options;
  // P1-02 (#84): the default store is the SQLite Task Manager — the single
  // authoritative write path over the unified repository (task-manager/
  // sqlite-task-manager.ts). There is NO second store: when a caller passes
  // its own TaskStore, that store replaces the default entirely (never both).
  let ownsTaskStore = false;
  let taskStore: TaskStore;
  if (options.taskStore !== undefined) {
    taskStore = options.taskStore;
  } else {
    taskStore = new SqliteTaskManager({ dbPath: config.dbPath });
    ownsTaskStore = true;
  }
  const executor = options.executor ?? new SyntheticExecutor();
  // The handler keeps a reference to this card object; URL fields are
  // finalized in place once the loopback port is bound (P0-02 pattern).
  const agentCard = options.agentCard ?? buildLumithinkAgentCard(`http://${config.host}:0`);
  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    executor,
    new DefaultExecutionEventBusManager(),
  );

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: requestHandler }));
  app.use('/', requireA2aVersion({ supportedVersions: config.supportedVersions }));
  app.use('/', requireBearerAuth({ bearerToken: config.bearerToken }));
  app.use('/', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
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

  return { base, server, agentCard, taskStore, ownsTaskStore, requestHandler, executor, config, closed };
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
  // Close the store the service owns (SQLite Task Manager database) AFTER
  // the listener is down — the store must never be closed while the handler
  // can still reach it.
  if (service.ownsTaskStore && service.taskStore instanceof SqliteTaskManager) {
    service.taskStore.close();
  }
}
