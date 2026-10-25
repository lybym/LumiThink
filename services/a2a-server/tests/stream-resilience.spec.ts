/**
 * AC 3 (issue #83): SSE disconnect does NOT default-cancel; terminal-state
 * subscription returns the standard error; the client recovers through
 * GetTask (R8, design §9.2/§10.3, fixtures 10/11).
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { TaskState } from '@a2a-js/sdk';
import { officialClient, rpcErrorOf, rpcPost, rpcResultOf, startTest, stopA2aService, userMessage } from './helpers.ts';

test('SSE disconnect does not default-cancel; explicit CancelTask then settles the task', async () => {
  const service = await startTest();
  try {
    // 1. Open a streaming request for a parked (cancel-test) task.
    const res = await rpcPost(service.base, {
      jsonrpc: '2.0', id: 1, method: 'SendStreamingMessage',
      params: {
        message: { messageId: 'msg-drop-1', role: 'ROLE_USER', parts: [{ text: '请取消我' }], metadata: { lumithinkScenario: 'cancel-test' } },
      },
    });
    assert.ok(res.headers.get('content-type')?.includes('text/event-stream'),
      'streaming method must answer with an SSE stream');

    // 2. Read ONLY the first frame (the Task), then abort the connection.
    const reader = res.body!.getReader();
    let buffer = '';
    let firstFrame: Record<string, unknown> | null = null;
    while (firstFrame === null) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0 && buffer.slice(0, boundary).startsWith('data:')) {
        firstFrame = JSON.parse(buffer.slice('data:'.length, boundary).trim()) as Record<string, unknown>;
      }
    }
    await reader.cancel().catch(() => undefined); // SSE disconnect
    assert.ok(firstFrame, 'first SSE frame must arrive before disconnect');
    const taskId =
      ((firstFrame!['result'] as Record<string, unknown>)['task'] as { id: string }).id;

    // 3. Give the server time to notice the dropped connection. The task
    //    must REMAIN non-terminal: SSE disconnect never cancels (R8).
    await new Promise((resolve) => setTimeout(resolve, 250));
    const stillRunning = await rpcResultOf(service.base, 2, 'GetTask', { id: taskId });
    const state = ((stillRunning.body['result'] as Record<string, unknown>)['status'] as { state: string }).state;
    assert.equal(state, 'TASK_STATE_SUBMITTED',
      'SSE disconnect must NOT cancel the task (still non-terminal)');

    // 4. GetTask recovery: the disconnected client can read the snapshot.
    assert.ok((stillRunning.body['result'] as Record<string, unknown>)['id'] === taskId);

    // 5. The explicit CancelTask is what actually settles the task.
    const cancel = await rpcResultOf(service.base, 3, 'CancelTask', { id: taskId });
    assert.equal(
      ((cancel.body['result'] as Record<string, unknown>)['status'] as { state: string }).state,
      'TASK_STATE_CANCELED',
    );
  } finally {
    await stopA2aService(service);
  }
});

test('terminal-state subscription returns the standard -32004 error; GetTask recovery reads the snapshot', async () => {
  const service = await startTest();
  try {
    const { client } = await officialClient(service.base);
    const sent = (await client.sendMessage({
      tenant: '',
      message: userMessage('msg-recover-1', '你好'),
      configuration: undefined,
      metadata: undefined,
    })) as { id: string };

    // Raw SubscribeToTask on the terminal task → -32004 (fixture 10).
    const sub = await rpcErrorOf(service.base, 10, 'SubscribeToTask', { id: sent.id });
    assert.ok(sub.error);
    assert.equal(sub.error['code'], -32004);

    // Recovery path: authorized GetTask returns the full snapshot.
    const snapshot = await client.getTask({ tenant: '', id: sent.id });
    assert.equal(snapshot.status?.state, TaskState.TASK_STATE_COMPLETED);
  } finally {
    await stopA2aService(service);
  }
});

test('resubscribe on an ACTIVE task delivers the stream (subscription works while running)', async () => {
  const service = await startTest();
  try {
    const { client } = await officialClient(service.base);
    let parkedId = '';
    for await (const event of client.sendMessageStream({
      tenant: '',
      message: userMessage('msg-resub-1', '请继续', { lumithinkScenario: 'cancel-test' }),
      configuration: undefined,
      metadata: undefined,
    })) {
      if (event.payload?.$case === 'task') {
        parkedId = event.payload.value.id;
        break;
      }
    }
    assert.ok(parkedId);

    // resubscribeTask is the official-client form of SubscribeToTask.
    let sawTask = false;
    for await (const event of client.resubscribeTask({ tenant: '', id: parkedId })) {
      if (event.payload?.$case === 'task') sawTask = true;
      break; // one event is enough to prove the subscription attaches
    }
    assert.ok(sawTask, 'resubscribe on a live task must deliver events');

    // Cleanup: settle the parked task.
    await client.cancelTask({ tenant: '', id: parkedId, metadata: undefined });
  } finally {
    await stopA2aService(service);
  }
});

