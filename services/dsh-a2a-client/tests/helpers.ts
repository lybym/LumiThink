/**
 * P2-02 (issue #114) — in-process mock A2A v1.0 server for client specs.
 *
 * Methodology per ADR-0018 Appendix A: a spec-shaped minimal server whose
 * WIRE shapes are produced by the LOCKED SDK's own codecs (`Task.toJSON`,
 * `Message.toJSON`) so the official client under test parses exactly what a
 * compliant server emits. Method-level logging records auth PRESENCE only —
 * never token values (A2A_DESIGN §13.1).
 *
 * Scenario routing (message.metadata.lumithinkScenario):
 *   'complete'       — working → one artifact chunk → COMPLETED
 *   'input-required' — working → INPUT_REQUIRED (structured status message)
 *   'auth-required'  — working → AUTH_REQUIRED (distinct from input)
 *   'never-terminal' — parks in WORKING forever (cancel tests)
 *   'stop-on-cancel' — parks in WORKING until CancelTask → CANCELED
 *   'complete-slow'  — COMPLETED after a delay (stream/recovery timing)
 *
 * Extras the ADR anchors need: messageId idempotency (duplicate → same
 * task), first-response drop (§5.3 recovery), CancelTask delay + terminal
 * cancel refusal (§7.2/§7.3), 401 until a rotated token arrives
 * (credential re-sign).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Message as MessageCodec, Task as TaskCodec, TaskState, Role } from '@a2a-js/sdk';
import type { Message, Part, Task, TaskStatus } from '@a2a-js/sdk';

export const MOCK_TOKEN_A = 'synthetic-mock-token-alpha-0123456789';
export const MOCK_TOKEN_B = 'synthetic-mock-token-beta-abcdef0123456789';

type Scenario =
  | 'complete'
  | 'input-required'
  | 'auth-required'
  | 'never-terminal'
  | 'stop-on-cancel'
  | 'complete-slow';

interface WireTaskRecord {
  task: Task;
  scenario: Scenario;
  messageId: string;
  /** Resolved when the terminal state is reached (for blocking sends). */
  waiters: Array<() => void>;
}

export interface MockMethodLogEntry {
  method: string;
  messageId?: string;
  taskId?: string;
  returnImmediately?: boolean;
  hasAuth: boolean;
  contextId?: string;
  referenceTaskIds?: string[];
}

export interface MockServerOptions {
  /** Valid bearer tokens; requests without one of these get HTTP 401. */
  validTokens?: string[];
  /** Drop (destroy) the FIRST response for these messageIds (§5.3 recovery). */
  dropFirstResponseFor?: string[];
  /** Artificial delay before CancelTask responses (§7.3 timeout tests). */
  cancelDelayMs?: number;
  /** CancelTask on a terminal task answers the standard -32002. */
  cancelTerminalRefusal?: boolean;
  /** Delay before 'complete' settles (default 40ms). */
  completionDelayMs?: number;
  /** Delay before SendMessage responses are written (abort-timing tests). */
  sendResponseDelayMs?: number;
}

export interface MockServer {
  base: string;
  close: () => Promise<void>;
  /** All observed JSON-RPC methods (auth recorded as presence, never values). */
  methodLog: MockMethodLogEntry[];
  /** Distinct CancelTask invocations in arrival order. */
  cancelCalls: string[];
  /** Tasks created by messageId (idempotency observable). */
  tasksByMessageId: Map<string, string>;
  /** Promotes a token (credential rotation tests). */
  addValidToken: (token: string) => void;
  /** Internal state access for assertions. */
  taskState: (taskId: string) => string | undefined;
}

const SYNTHETIC_NOW = '2026-10-29T00:00:00.000Z';

function statusOf(state: TaskState): TaskStatus {
  return { state, message: undefined, timestamp: SYNTHETIC_NOW };
}

function textPart(value: string): Part {
  return {
    content: { $case: 'text', value },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  };
}

export function startMockA2aServer(options: MockServerOptions = {}): Promise<MockServer> {
  const validTokens = new Set<string>(options.validTokens ?? [MOCK_TOKEN_A]);
  const tasks = new Map<string, WireTaskRecord>();
  const tasksByMessageId = new Map<string, string>();
  const methodLog: MockMethodLogEntry[] = [];
  const cancelCalls: string[] = [];
  const droppedOnce = new Set<string>();

  const server = http.createServer((req, res) => {
    // Destroyed sockets (abort tests / dropped responses) must not crash the
    // mock with unhandled 'error' events.
    res.on('error', () => undefined);
    req.on('error', () => undefined);
    void handle(req, res).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(error) } }));
    });
  });
  server.on('clientError', (_err, socket) => {
    socket.destroy();
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === 'GET' && (req.url ?? '').includes('/.well-known/agent-card.json')) {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const body = {
        name: 'mock-dsh-target',
        description: 'In-process mock A2A v1.0 server for P2-02 client specs (synthetic only).',
        version: '0.1.0',
        provider: undefined,
        capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
        securitySchemes: {},
        securityRequirements: [],
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [
          { id: 'chat', name: 'Chat (mock)', description: '', tags: [], examples: [], inputModes: [], outputModes: [], securityRequirements: [] },
        ],
        signatures: [],
        supportedInterfaces: [{ url: base, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'not found' } }));
      return;
    }

    const auth = req.headers['authorization'];
    const hasAuth = typeof auth === 'string' && auth.startsWith('Bearer ');
    const token = hasAuth ? auth.slice('Bearer '.length) : '';

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      id: number | string;
      method: string;
      params: Record<string, unknown>;
    };
    const rpcId = body.id;

    // Bearer gate mirroring the real service's line semantics (401 surface
    // for the credential re-sign path).
    if (!hasAuth || !validTokens.has(token)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpcId,
          error: { code: -32000, message: 'Authentication required.', data: {} },
        }),
      );
      return;
    }

    const params = body.params ?? {};
    const message = params['message'] as Record<string, unknown> | undefined;
    const configuration = (params['configuration'] ?? {}) as { returnImmediately?: boolean };
    const returnImmediately = configuration['returnImmediately'] === true;

    switch (body.method) {
      case 'SendMessage': {
        const messageId = String(message?.['messageId'] ?? '');
        methodLog.push({
          method: 'SendMessage',
          messageId,
          returnImmediately,
          hasAuth,
          contextId: message?.['contextId'] !== undefined && message['contextId'] !== '' ? String(message['contextId']) : undefined,
          referenceTaskIds: Array.isArray(message?.['referenceTaskIds']) ? (message['referenceTaskIds'] as string[]) : undefined,
        });
        if (messageId !== '' && (options.dropFirstResponseFor ?? []).includes(messageId) && !droppedOnce.has(messageId)) {
          // §5.3 simulation: the FIRST response for this id is lost.
          droppedOnce.add(messageId);
          res.destroy();
          return;
        }
        const record = acceptMessage(messageId, message ?? {});
        if ((options.sendResponseDelayMs ?? 0) > 0) {
          await sleep(options.sendResponseDelayMs as number);
        }
        if (returnImmediately) {
          respond(res, rpcId, { task: TaskCodec.toJSON(snapshot(record)) });
          return;
        }
        await waitForTerminal(record);
        respond(res, rpcId, { task: TaskCodec.toJSON(snapshot(record)) });
        return;
      }
      case 'GetTask': {
        const taskId = String(params['id'] ?? '');
        methodLog.push({ method: 'GetTask', taskId, hasAuth });
        const record = findTask(taskId);
        if (record === undefined) {
          respondError(res, rpcId, -32001, 'Task not found');
          return;
        }
        respond(res, rpcId, TaskCodec.toJSON(snapshot(record)));
        return;
      }
      case 'CancelTask': {
        const taskId = String(params['id'] ?? '');
        methodLog.push({ method: 'CancelTask', taskId, hasAuth });
        cancelCalls.push(taskId);
        const record = findTask(taskId);
        if (record === undefined) {
          respondError(res, rpcId, -32001, 'Task not found');
          return;
        }
        const state = snapshot(record).status?.state;
        if (state === TaskState.TASK_STATE_COMPLETED || options.cancelTerminalRefusal === true) {
          respondError(res, rpcId, -32002, 'Task cannot be canceled');
          return;
        }
        if ((options.cancelDelayMs ?? 0) > 0) {
          await sleep(options.cancelDelayMs as number);
        }
        settle(record, TaskState.TASK_STATE_CANCELED, 'mock canceled');
        respond(res, rpcId, TaskCodec.toJSON(snapshot(record)));
        return;
      }
      case 'SendStreamingMessage':
      case 'SubscribeToTask': {
        const taskId = String(params['id'] ?? '');
        methodLog.push({
          method: body.method,
          messageId: message !== undefined ? String(message['messageId'] ?? '') : undefined,
          taskId: taskId !== '' ? taskId : undefined,
          hasAuth,
        });
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        if (body.method === 'SendStreamingMessage') {
          const messageId = String(message?.['messageId'] ?? '');
          const record = acceptMessage(messageId, message ?? {});
          emitFrame(res, rpcId, { task: TaskCodec.toJSON(snapshot(record)) });
          if (record.scenario === 'input-required' || record.scenario === 'auth-required' || isTerminalStateValue(record.task.status?.state)) {
            emitTerminalFrame(res, rpcId, record);
            res.end();
            return;
          }
          record.waiters.push(() => {
            emitTerminalFrame(res, rpcId, record);
            res.end();
          });
          return;
        }
        // SubscribeToTask: replay the CURRENT state then hold until terminal.
        const record = findTask(taskId);
        if (record === undefined) {
          res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpcId, error: { code: -32001, message: 'Task not found' } })}\n\n`);
          return;
        }
        emitFrame(res, rpcId, {
          statusUpdate: {
            taskId: record.task.id,
            contextId: record.task.contextId,
            status: { state: stateNameOf(record.task.status?.state), message: undefined, timestamp: SYNTHETIC_NOW },
          },
        });
        if (isTerminalStateValue(record.task.status?.state)) {
          res.end();
          return;
        }
        record.waiters.push(() => {
          emitTerminalFrame(res, rpcId, record);
          res.end();
        });
        return;
      }
      default:
        respondError(res, rpcId, -32601, 'Method not found');
        return;
    }
  }

  function acceptMessage(messageId: string, message: Record<string, unknown>): WireTaskRecord {
    const existingId = tasksByMessageId.get(messageId);
    if (existingId !== undefined) {
      const existing = tasks.get(existingId);
      if (existing !== undefined) return existing; // idempotent duplicate
    }
    const scenarioRaw = (message['metadata'] as Record<string, unknown> | undefined)?.['lumithinkScenario'];
    const scenario: Scenario = typeof scenarioRaw === 'string' && SCENARIOS.includes(scenarioRaw as Scenario)
      ? (scenarioRaw as Scenario)
      : 'complete';
    const contextId = typeof message['contextId'] === 'string' && message['contextId'] !== ''
      ? message['contextId']
      : `ctx-${randomUUID().slice(0, 8)}`;
    const runtimeMessage = MessageCodec.fromJSON(message) as Message;
    const task: Task = {
      id: `task-${randomUUID().slice(0, 12)}`,
      contextId,
      status: statusOf(TaskState.TASK_STATE_SUBMITTED),
      artifacts: [],
      history: [runtimeMessage],
      metadata: undefined,
    };
    const record: WireTaskRecord = { task, scenario, messageId, waiters: [] };
    tasks.set(task.id, record);
    tasksByMessageId.set(messageId, task.id);
    drive(record);
    return record;
  }

  function drive(record: WireTaskRecord): void {
    // WORKING lands synchronously (deterministic for returnImmediately
    // snapshots); the terminal transition keeps the configured delay.
    record.task.status = { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: SYNTHETIC_NOW };
    const delay = record.scenario === 'complete-slow' ? (options.completionDelayMs ?? 300) : (options.completionDelayMs ?? 40);
    if (record.scenario === 'complete' || record.scenario === 'complete-slow') {
      setTimeout(() => {
        record.task.artifacts = [
          {
            artifactId: 'answer',
            name: 'Admitted answer',
            description: '',
            parts: [textPart('你好。我们开始吧。')],
            metadata: { lumithinkContent: { version: 1, category: 'admitted-answer' } },
            extensions: [],
          },
        ];
        settle(record, TaskState.TASK_STATE_COMPLETED);
      }, delay);
      return;
    }
    if (record.scenario === 'input-required') {
      record.task.status = {
        state: TaskState.TASK_STATE_INPUT_REQUIRED,
        message: {
          messageId: `status-${randomUUID().slice(0, 8)}`,
          contextId: record.task.contextId,
          taskId: record.task.id,
          role: Role.ROLE_AGENT,
          parts: [textPart('请补充你的偏好设置。')],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        },
        timestamp: SYNTHETIC_NOW,
      };
      release(record);
      return;
    }
    if (record.scenario === 'auth-required') {
      record.task.status = {
        state: TaskState.TASK_STATE_AUTH_REQUIRED,
        message: {
          messageId: `status-${randomUUID().slice(0, 8)}`,
          contextId: record.task.contextId,
          taskId: record.task.id,
          role: Role.ROLE_AGENT,
          parts: [textPart('需要重新授权后才能继续。')],
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        },
        timestamp: SYNTHETIC_NOW,
      };
      release(record);
      return;
    }
    // 'never-terminal' / 'stop-on-cancel' park in WORKING.
  }

  function settle(record: WireTaskRecord, state: TaskState, _reason?: string): void {
    record.task.status = { state, message: undefined, timestamp: SYNTHETIC_NOW };
    release(record);
  }

  function release(record: WireTaskRecord): void {
    const waiters = record.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  function waitForTerminal(record: WireTaskRecord): Promise<void> {
    if (isTerminalStateValue(record.task.status?.state) || record.scenario === 'input-required' || record.scenario === 'auth-required') {
      return Promise.resolve();
    }
    return new Promise((resolve) => record.waiters.push(resolve));
  }

  function snapshot(record: WireTaskRecord): Task {
    return structuredClone(record.task);
  }

  function findTask(taskId: string): WireTaskRecord | undefined {
    return tasks.get(taskId);
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({
        base,
        methodLog,
        cancelCalls,
        tasksByMessageId,
        addValidToken: (token: string) => validTokens.add(token),
        taskState: (taskId: string) => stateNameOf(tasks.get(taskId)?.task.status?.state),
        close: () =>
          new Promise<void>((resolveClose) => {
            for (const record of tasks.values()) release(record);
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

const SCENARIOS: readonly Scenario[] = [
  'complete',
  'input-required',
  'auth-required',
  'never-terminal',
  'stop-on-cancel',
  'complete-slow',
];

function respond(res: http.ServerResponse, id: number | string, result: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

function respondError(res: http.ServerResponse, id: number | string, code: number, message: string): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data: {} } }));
}

function emitFrame(res: http.ServerResponse, id: number | string, result: unknown): void {
  res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`);
}

/** Terminal statusUpdate frame carrying the FINAL task state. */
function emitTerminalFrame(res: http.ServerResponse, id: number | string, record: WireTaskRecord): void {
  const finalStatus = structuredClone(record.task).status;
  emitFrame(res, id, {
    statusUpdate: {
      taskId: record.task.id,
      contextId: record.task.contextId,
      status: {
        state: stateNameOf(finalStatus?.state),
        message:
          finalStatus?.message === undefined
            ? undefined
            : JSON.parse(JSON.stringify(finalStatus.message)),
        timestamp: SYNTHETIC_NOW,
      },
    },
  });
}

function stateNameOf(state: TaskState | number | undefined): string {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED: return 'TASK_STATE_SUBMITTED';
    case TaskState.TASK_STATE_WORKING: return 'TASK_STATE_WORKING';
    case TaskState.TASK_STATE_INPUT_REQUIRED: return 'TASK_STATE_INPUT_REQUIRED';
    case TaskState.TASK_STATE_AUTH_REQUIRED: return 'TASK_STATE_AUTH_REQUIRED';
    case TaskState.TASK_STATE_COMPLETED: return 'TASK_STATE_COMPLETED';
    case TaskState.TASK_STATE_FAILED: return 'TASK_STATE_FAILED';
    case TaskState.TASK_STATE_CANCELED: return 'TASK_STATE_CANCELED';
    case TaskState.TASK_STATE_REJECTED: return 'TASK_STATE_REJECTED';
    default: return 'TASK_STATE_UNSPECIFIED';
  }
}

function isTerminalStateValue(state: TaskState | number | undefined): boolean {
  return (
    state === TaskState.TASK_STATE_COMPLETED ||
    state === TaskState.TASK_STATE_FAILED ||
    state === TaskState.TASK_STATE_CANCELED ||
    state === TaskState.TASK_STATE_REJECTED
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
