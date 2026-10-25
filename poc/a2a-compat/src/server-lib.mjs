/**
 * Shared synthetic A2A server for the P0-02 isolated verification.
 * Used by wire-verify.mjs (JS official client loopback) and interop-server.mjs
 * (official Python client interop probe). All content is synthetic.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { DefaultRequestHandler, InMemoryTaskStore, DefaultExecutionEventBusManager } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { TaskState } from '@a2a-js/sdk';

const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const now = () => '2026-10-25T00:00:00.000Z'; // fixed synthetic timestamp

// NOTE (adaptation risk, recorded in the matrix): the @a2a-js/sdk 1.3.0 event
// bus requires RUNTIME-shaped objects (Part as oneof `{content:{$case:'text',
// value}}`, TaskState as the numeric enum). Publishing wire-shaped JSON
// silently re-serializes to `UNRECOGNIZED` states and empty parts instead of
// failing. The executor below therefore publishes runtime shapes.
export class ScriptedExecutor {
  constructor() {
    this.awaitingCancel = new Map();
    this.contexts = new Map();
    this.cancelInvocations = 0;
  }

  async execute(requestContext, eventBus) {
    const { taskId, contextId, userMessage } = requestContext;
    this.contexts.set(taskId, contextId);
    eventBus.publish({
      kind: 'task',
      data: { id: taskId, contextId, status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: now() }, history: [userMessage] },
    });
    // Scenario routing via application metadata (taskId is server-assigned).
    const scenario = requestContext.request?.message?.metadata?.lumithinkScenario;
    if (scenario === 'cancel-test') {
      await new Promise((resolve) => this.awaitingCancel.set(taskId, resolve));
      return; // cancelTask() publishes the terminal event
    }
    const textPart = (value) => ({ content: { $case: 'text', value } });
    const chunk1 = '你好。';
    const chunk2 = '我们开始吧。';
    const artifact = { artifactId: 'answer-example', name: 'Admitted answer', parts: [], metadata: { lumithinkContent: { version: 1, category: 'admitted-answer' } } };
    eventBus.publish({
      kind: 'artifactUpdate',
      data: { taskId, contextId, artifact: { ...artifact, parts: [textPart(chunk1)] }, append: false, lastChunk: false, metadata: { lumithinkOutput: { version: 1, chunkId: 'chunk-1', startByte: 0, endByte: 9, sha256: sha(chunk1) } } },
    });
    eventBus.publish({
      kind: 'artifactUpdate',
      data: { taskId, contextId, artifact: { ...artifact, parts: [textPart(chunk2)] }, append: true, lastChunk: true, metadata: { lumithinkOutput: { version: 1, chunkId: 'chunk-2', startByte: 9, endByte: 27, sha256: sha(chunk2) } } },
    });
    eventBus.publish({ kind: 'statusUpdate', data: { taskId, contextId, status: { state: TaskState.TASK_STATE_COMPLETED, timestamp: now() } } });
  }

  async cancelTask(taskId, eventBus) {
    this.cancelInvocations += 1;
    const resolve = this.awaitingCancel.get(taskId);
    this.awaitingCancel.delete(taskId);
    if (resolve) resolve();
    eventBus.publish({
      kind: 'statusUpdate',
      data: { taskId, contextId: this.contexts.get(taskId), status: { state: TaskState.TASK_STATE_CANCELED, timestamp: now() } },
    });
  }
}

export function buildAgentCard(base) {
  return {
    protocolVersion: '1.0',
    name: 'lumithink-p0-02-verify',
    description: 'Synthetic loopback agent for P0-02 compatibility verification (issue #80)',
    url: base,
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'chat', name: 'Synthetic chat', description: 'synthetic only', tags: ['synthetic'] }],
    supportedInterfaces: [{ url: base, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  };
}

export async function startVerifyServer({ port = 0 } = {}) {
  const executor = new ScriptedExecutor();
  const taskStore = new InMemoryTaskStore();
  // The handler keeps a reference to this card object; the URL fields are
  // finalized in place once the ephemeral port is known.
  const agentCard = buildAgentCard('http://127.0.0.1:0');
  const handler = new DefaultRequestHandler(agentCard, taskStore, executor, new DefaultExecutionEventBusManager());

  const app = express();
  app.use(express.json());
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler }));
  app.use('/', jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: bound } = server.address();
  const base = `http://127.0.0.1:${bound}`;
  agentCard.url = base;
  agentCard.supportedInterfaces[0].url = base;
  return { base, server, executor, taskStore, requestHandler: handler, agentCard };
}
