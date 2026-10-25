/**
 * AC 2 (issue #83): standard error mapping; auth/param failures never create
 * a Task; Task-only wire policy; skill declaration is not an authorization
 * basis. Error anchors are the frozen fixtures (docs/fixtures/a2a-v1.0):
 *   - 08: CancelTask on COMPLETED → -32002 TaskNotCancelable (ErrorInfo);
 *   - 09: duplicate CancelTask on CANCELED → idempotent success result;
 *   - 10: SubscribeToTask on a terminal task → -32004 UnsupportedOperation;
 *   - 11: GetTask unknown → -32001 TaskNotFound;
 *   - 12: A2A-Version missing/unsupported → -32009 VersionNotSupported.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  rpcErrorOf,
  rpcPost,
  rpcResultOf,
  startTest,
  stopA2aService,
  TEST_TOKEN,
} from './helpers.ts';
import type { TaskStore } from '../src/task-manager-port.ts';
import type { ListTasksRequest, ListTasksResponse, Task } from '@a2a-js/sdk';
import type { ServerCallContext } from '@a2a-js/sdk/server';

/**
 * Minimal recording TaskStore — a second proof of the single-store boundary:
 * the service runs entirely through THIS instance, so its map size is the
 * authoritative task count.
 */
class RecordingTaskStore implements TaskStore {
  readonly tasks = new Map<string, Task>();
  async save(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
  }
  async load(taskId: string): Promise<Task | undefined> {
    return this.tasks.get(taskId);
  }
  async list(_params: ListTasksRequest, _context: ServerCallContext): Promise<ListTasksResponse> {
    return { tasks: [...this.tasks.values()] } as unknown as ListTasksResponse;
  }
}

test('GetTask unknown → -32001 TaskNotFound (fixture 11)', async () => {
  const service = await startTest();
  try {
    const { error } = await rpcErrorOf(service.base, 11, 'GetTask', { id: 'task-does-not-exist' });
    assert.ok(error);
    assert.equal(error['code'], -32001);
  } finally {
    await stopA2aService(service);
  }
});

test('CancelTask on COMPLETED → -32002; duplicate CancelTask on CANCELED → idempotent (fixtures 08/09)', async () => {
  const store = new RecordingTaskStore();
  const service = await startTest({ taskStore: store });
  try {
    // Completed task for the -32002 path.
    const { body: sentBody } = await rpcResultOf(service.base, 1, 'SendMessage', {
      message: { messageId: 'msg-err-1', role: 'ROLE_USER', parts: [{ text: '你好' }] },
      configuration: { returnImmediately: false },
    });
    const completedId = ((sentBody['result'] as Record<string, unknown>)['task'] as { id: string }).id;

    const onCompleted = await rpcErrorOf(service.base, 2, 'CancelTask', { id: completedId });
    assert.ok(onCompleted.error);
    assert.equal(onCompleted.error['code'], -32002);
    const data = onCompleted.error['data'] as { reason?: string }[];
    assert.equal(data?.[0]?.reason, 'TASK_NOT_CANCELABLE');

    // Parked task for the CANCELED / duplicate-cancel path. Read only the
    // first frame (the Task) and drop the connection: the stream of a parked
    // task never ends until the explicit CancelTask settles it.
    const stream = await rpcPost(service.base, {
      jsonrpc: '2.0', id: 3, method: 'SendStreamingMessage',
      params: { message: { messageId: 'msg-err-2', role: 'ROLE_USER', parts: [{ text: '请取消我' }], metadata: { lumithinkScenario: 'cancel-test' } } },
    });
    const reader = stream.body!.getReader();
    let buffer = '';
    let parkedId = '';
    while (parkedId === '') {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0 && buffer.slice(0, boundary).startsWith('data:')) {
        const frame = JSON.parse(buffer.slice('data:'.length, boundary).trim()) as Record<string, unknown>;
        parkedId = ((frame['result'] as Record<string, unknown>)['task'] as { id: string }).id;
      }
    }
    await reader.cancel().catch(() => undefined);
    assert.ok(parkedId, 'first SSE frame must carry the Task');

    const firstCancel = await rpcResultOf(service.base, 4, 'CancelTask', { id: parkedId });
    assert.ok(firstCancel.body['result'], 'first CancelTask succeeds');
    const canceled = (firstCancel.body['result'] as { status?: { state?: string } });
    assert.equal(canceled.status?.state, 'TASK_STATE_CANCELED');

    const duplicate = await rpcResultOf(service.base, 5, 'CancelTask', { id: parkedId });
    assert.ok(duplicate.body['result'], 'duplicate CancelTask on CANCELED is idempotent (fixture 09)');
    assert.equal((duplicate.body['result'] as { status?: { state?: string } }).status?.state, 'TASK_STATE_CANCELED');
  } finally {
    await stopA2aService(service);
  }
});

test('SubscribeToTask on a terminal task → -32004 UnsupportedOperation (fixture 10)', async () => {
  const service = await startTest();
  try {
    const { body: sentBody } = await rpcResultOf(service.base, 1, 'SendMessage', {
      message: { messageId: 'msg-sub-1', role: 'ROLE_USER', parts: [{ text: '你好' }] },
      configuration: { returnImmediately: false },
    });
    const completedId = ((sentBody['result'] as Record<string, unknown>)['task'] as { id: string }).id;
    const sub = await rpcErrorOf(service.base, 2, 'SubscribeToTask', { id: completedId });
    assert.ok(sub.error);
    assert.equal(sub.error['code'], -32004, 'terminal subscription must be the standard -32004 error');
  } finally {
    await stopA2aService(service);
  }
});

test('A2A-Version missing/9.9 → -32009 with fixture-12 shape; never silently accepted (R7)', async () => {
  const service = await startTest();
  try {
    for (const version of [null, '9.9']) {
      const { error } = await rpcErrorOf(service.base, 12, 'GetTask', { id: 'whatever' }, { version });
      assert.ok(error, `variant ${String(version)} must produce an error`);
      assert.equal(error['code'], -32009);
      const message = error['message'] as string;
      assert.match(message, /'0\.3'|'9\.9'/, 'error message names the requested version');
      const data = error['data'] as { '@type'?: string; reason?: string; domain?: string }[];
      assert.equal(data?.[0]?.reason, 'VERSION_NOT_SUPPORTED');
      assert.equal(data?.[0]?.domain, 'a2a-protocol.org');
    }
  } finally {
    await stopA2aService(service);
  }
});

test('auth failure → HTTP 401 standard JSON-RPC error, and NO task is created', async () => {
  const store = new RecordingTaskStore();
  const service = await startTest({ taskStore: store });
  try {
    for (const token of [null, 'wrong-token-value-aaaaaaaaaaa']) {
      const res = await rpcPost(service.base, {
        jsonrpc: '2.0', id: 40, method: 'SendMessage',
        params: { message: { messageId: 'msg-auth-1', role: 'ROLE_USER', parts: [{ text: '你好' }] } },
      }, { token });
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error?: { code?: number; data?: { reason?: string }[] } };
      assert.ok(body.error, 'auth failure returns a JSON-RPC error body');
      assert.equal(body.error.code, -32000);
      assert.equal(body.error.data?.[0]?.reason, 'AUTHENTICATION_REQUIRED');
    }
    assert.equal(store.tasks.size, 0, 'authentication failures must not create tasks');
  } finally {
    await stopA2aService(service);
  }
});

test('invalid params → standard JSON-RPC error, and NO task is created', async () => {
  const store = new RecordingTaskStore();
  const service = await startTest({ taskStore: store });
  try {
    const { error } = await rpcErrorOf(service.base, 50, 'SendMessage', {});
    assert.ok(error, 'SendMessage without message params must fail');
    assert.equal(error['code'], -32602, 'invalid params map to the standard -32602');
    assert.equal(store.tasks.size, 0, 'parameter failures must not create tasks');
  } finally {
    await stopA2aService(service);
  }
});

test('Task-only wire policy: blocking SendMessage result carries the task oneof only', async () => {
  const service = await startTest();
  try {
    const { body } = await rpcResultOf(service.base, 60, 'SendMessage', {
      message: { messageId: 'msg-only-1', role: 'ROLE_USER', parts: [{ text: '你好' }] },
      configuration: { returnImmediately: false },
    });
    const result = body['result'] as Record<string, unknown>;
    assert.ok(result, 'blocking send succeeds');
    assert.ok('task' in result, 'result carries the task oneof');
    assert.ok(!('message' in result), 'result never carries a bare message (Task-only policy)');
  } finally {
    await stopA2aService(service);
  }
});

test('skill declaration is NOT an authorization basis', async () => {
  const store = new RecordingTaskStore();
  const service = await startTest({ taskStore: store });
  try {
    // Unknown / arbitrary skill metadata is accepted exactly like the known
    // one — acceptance never consults skill data (design §4: skills are
    // discovery only).
    for (const skill of ['chat', 'definitely-not-a-grant', undefined]) {
      const metadata = skill === undefined ? undefined : { lumithinkSkill: skill };
      const { body } = await rpcResultOf(service.base, 70, 'SendMessage', {
        message: { messageId: `msg-skill-${String(skill)}`, role: 'ROLE_USER', parts: [{ text: '你好' }], metadata },
        configuration: { returnImmediately: false },
      });
      assert.ok(body['result'], `skill '${String(skill)}' must not change acceptance`);
    }
    // And a valid token check ignores skill entirely: without a token the
    // request is rejected even though the skill matches the card's 'chat'.
    const res = await rpcPost(service.base, {
      jsonrpc: '2.0', id: 71, method: 'SendMessage',
      params: { message: { messageId: 'msg-skill-anon', role: 'ROLE_USER', parts: [{ text: '你好' }], metadata: { lumithinkSkill: 'chat' } } },
    }, { token: null });
    assert.equal(res.status, 401, 'the declared skill grants nothing without a credential');
    assert.equal(store.tasks.size, 3, 'exactly the three authorized sends created tasks');
  } finally {
    await stopA2aService(service);
  }
});

test('single authoritative store: RPC-created tasks are visible in the one wired store instance', async () => {
  const store = new RecordingTaskStore();
  const service = await startTest({ taskStore: store });
  try {
    await rpcResultOf(service.base, 80, 'SendMessage', {
      message: { messageId: 'msg-wire-1', role: 'ROLE_USER', parts: [{ text: '你好' }] },
      configuration: { returnImmediately: false },
    });
    assert.equal(store.tasks.size, 1, 'the handler must write through the one wired store');
    const task = [...store.tasks.values()][0];
    assert.ok(task.id, 'the recorded task carries the server-assigned id');
  } finally {
    await stopA2aService(service);
  }
});

test('malformed JSON body → standard -32700 parse error', async () => {
  const service = await startTest();
  try {
    const res = await fetch(`${service.base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0', 'authorization': `Bearer ${TEST_TOKEN}` },
      body: '{"jsonrpc": "2.0", "id": 90, "method": ', // truncated JSON
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: { code?: number } };
    assert.equal(body.error?.code, -32700, 'parse failures map to the standard -32700');
  } finally {
    await stopA2aService(service);
  }
});

test('unauthenticated token constant sanity (test-only credential shape)', () => {
  assert.ok(TEST_TOKEN.length >= 16);
});
