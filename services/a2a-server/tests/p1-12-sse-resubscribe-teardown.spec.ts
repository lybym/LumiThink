/**
 * P1-12 (issue #121): SSE silent-disconnect teardown of the stream delivery
 * generator + well-formed pre-result refusal streams.
 *
 * Reproduction order (issue #121 / P1-11 review record §3.9, review id
 * 5692103052): stream A (parked active task) → abandoned; resubscribe B on
 * the active task → abandoned; a NEW stream C continuing the SAME
 * conversation.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ RED (pre-fix, verified on main c6cc32d): C answered with a non-SSE JSON │
 * │ error body: -32004 "Received statusUpdate before initial                │
 * │ 'Message'/'Task' event." — the locked SDK stream-pattern guard          │
 * │ (_advanceStreamPattern, UNDETERMINED) rejecting the bare pre-Task       │
 * │ statusUpdate that the capacity preflight published on C's own fresh     │
 * │ bus. The resubscribe generator itself does NOT hold any stream-order    │
 * │ slot (verified 4-way matrix with/without B in the investigation record  │
 * │ docs/reviews/2026-10-29-p1-12-sse-resubscribe-teardown.md §2); the      │
 * │ decisive variable is the conversation execution slot still held by the  │
 * │ parked A (断流≠取消, R8).                                                │
 * │ GREEN: C receives a protocol-valid task-lifecycle stream (task first,   │
 * │ then the explicit REJECTED capacity settlement) — the §13.4 refusal     │
 * │ semantics are preserved, only the opaque guard error is gone.           │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Also pinned here: the SSE silent-disconnect teardown itself (the abandoned
 * resubscribe generator is terminated on res 'close' — the SDK's express
 * handler drops writes on the destroyed socket and would otherwise keep the
 * generator + its ExecutionEventQueue subscribed until the task settles),
 * while 断流≠取消 (R8) and the slow-consumer delivery semantics stay intact.
 * The SEND path is deliberately NOT torn down on disconnect: in the locked
 * SDK the send delivery loop doubles as the task-state persistence pump
 * (ResultManager.processEvent runs inside the generator loop), so closing
 * the client-facing send stream early would starve the task's terminal
 * settlement (observed: the xiaozhi real-link gate failed exactly this way
 * before the passthrough correction). Resubscribe runs no ResultManager —
 * tearing it down never affects persistence.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { TaskState } from '@a2a-js/sdk';
import { rpcPost, rpcResultOf, startTest, stopA2aService, readSseFrames, type StartedTest } from './helpers.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads SSE frames from a live stream with a deadline (never hangs a suite). */
async function readFramesWithDeadline(
  res: Response,
  options: { atLeast?: number; deadlineMs?: number } = {},
): Promise<Record<string, unknown>[]> {
  const atLeast = options.atLeast ?? 1;
  const deadlineMs = options.deadlineMs ?? 10_000;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: Record<string, unknown>[] = [];
  const deadline = Date.now() + deadlineMs;
  while (frames.length < atLeast) {
    if (Date.now() > deadline) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`SSE frame deadline exceeded; got ${frames.length} frame(s)`);
    }
    const chunk = await Promise.race([
      reader.read(),
      sleep(deadlineMs).then(() => {
        throw new Error('SSE read timed out');
      }),
    ]);
    const { value, done } = chunk as { value?: Uint8Array; done?: boolean };
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (event.startsWith('data:')) {
        frames.push(JSON.parse(event.slice('data:'.length).trim()) as Record<string, unknown>);
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
  await reader.cancel().catch(() => undefined);
  return frames;
}

function taskFrameOf(frame: Record<string, unknown> | undefined): { id: string; contextId: string; state: string } {
  const task = (frame?.['result'] as Record<string, unknown> | undefined)?.['task'] as Record<string, unknown>;
  const status = task?.['status'] as { state?: string };
  return { id: task['id'] as string, contextId: task['contextId'] as string, state: status.state ?? '' };
}

/** Opens stream A (parked active task), reads the first frame, drops the stream. */
async function openParkAndDrop(service: StartedTest, messageId: string): Promise<{ taskId: string; contextId: string }> {
  const res = await rpcPost(service.base, {
    jsonrpc: '2.0', id: 1, method: 'SendStreamingMessage',
    params: {
      message: { messageId, role: 'ROLE_USER', parts: [{ text: '请取消我' }], metadata: { lumithinkScenario: 'cancel-test' } },
    },
  });
  assert.equal(res.headers.get('content-type')?.includes('text/event-stream'), true,
    'streaming send must answer with an SSE stream');
  const [first] = await readFramesWithDeadline(res);
  const task = taskFrameOf(first);
  assert.equal(task.state, 'TASK_STATE_WORKING', 'the parked task is dispatched (lease claimed) before the drop');
  await res.body!.cancel().catch(() => undefined); // silent client disconnect
  // taskFrameOf yields the { id, contextId, state } triple — re-shape it to
  // the declared { taskId, contextId } contract (a wrong `return task` here
  // makes every caller build `params: { id: undefined }` → `{}` on the wire).
  return { taskId: task.id, contextId: task.contextId };
}

test('P1-12 red→green: after A→resubscribe B→abandon both, a same-conversation stream C gets a protocol-valid stream (pre-fix: opaque -32004 guard error)', async () => {
  const service = await startTest();
  try {
    const a = await openParkAndDrop(service, 'p1-12-msg-a');
    await sleep(100);

    // Resubscribe B on the ACTIVE task, read its first (task) frame, drop it.
    const resB = await rpcPost(service.base, { jsonrpc: '2.0', id: 2, method: 'SubscribeToTask', params: { id: a.taskId } });
    const [frameB] = await readFramesWithDeadline(resB);
    const subTask = taskFrameOf(frameB);
    assert.equal(subTask.id, a.taskId, 'resubscribe on the active task delivers the task snapshot');
    await resB.body!.cancel().catch(() => undefined); // abandoned resubscribe stream
    await sleep(100);

    // New stream C continuing the SAME conversation (new messageId, same contextId).
    const resC = await rpcPost(service.base, {
      jsonrpc: '2.0', id: 3, method: 'SendStreamingMessage',
      params: { message: { messageId: 'p1-12-msg-c', role: 'ROLE_USER', parts: [{ text: '同一会话续接' }], contextId: a.contextId } },
    });
    // RED pivot (pre-fix behavior on main c6cc32d): content-type was
    // `application/json` with body {"error":{"code":-32004,"message":
    // "Received statusUpdate before initial 'Message'/'Task' event."}} —
    // the capacity refusal published a bare statusUpdate as the FIRST event
    // of C's own fresh bus and the locked SDK stream-pattern guard rejected
    // it as an ordering violation.
    assert.equal(resC.headers.get('content-type')?.includes('text/event-stream'), true,
      'C must be answered with a protocol-valid SSE stream, not the opaque -32004 guard error');
    const frames = await readSseFrames(resC);
    assert.ok(frames.length >= 2, `C stream carries the task + settlement frames (got ${frames.length})`);
    const cTask = taskFrameOf(frames[0]);
    assert.equal(cTask.contextId, a.contextId, 'C continues the same conversation');
    assert.ok(!frames.some((frame) => frame['error'] !== undefined), 'no JSON-RPC error frame on C');
    // The refusal is now an explicit, well-formed capacity settlement
    // (§13.4 conversation limit: the parked A still holds the conversation's
    // single active-execution slot — 断流≠取消 means the slot stays held).
    const rejected = frames[1]?.['result'] as Record<string, unknown> | undefined;
    const statusUpdate = rejected?.['statusUpdate'] as Record<string, unknown> | undefined;
    assert.ok(statusUpdate, 'the second frame is the explicit statusUpdate settlement');
    assert.equal((statusUpdate!['status'] as { state: string }).state, 'TASK_STATE_REJECTED',
      'the capacity refusal settles REJECTED explicitly instead of the opaque -32004');
    assert.equal(statusUpdate!['taskId'], cTask.id);

    // The explicit settlement persists (GetTask recovery reads REJECTED).
    // rpcResultOf (not rpcPost): the raw fetch Response's `.body` is a
    // ReadableStream, not the parsed JSON-RPC envelope.
    const snapshot = await rpcResultOf(service.base, 4, 'GetTask', { id: cTask.id });
    const snapshotTask = snapshot.body['result'] as Record<string, unknown>;
    assert.equal(((snapshotTask['status'] as { state: string }).state), 'TASK_STATE_REJECTED');

    // Cleanup: settle the parked A (the only reason the conversation was busy).
    await rpcPost(service.base, { jsonrpc: '2.0', id: 5, method: 'CancelTask', params: { id: a.taskId } });
  } finally {
    await stopA2aService(service);
  }
});

test('P1-12: after A→resubscribe B→abandon both, a NEW-task stream C (fresh contextId) is admitted normally', async () => {
  const service = await startTest();
  try {
    const a = await openParkAndDrop(service, 'p1-12-fresh-a');
    await sleep(100);
    const resB = await rpcPost(service.base, { jsonrpc: '2.0', id: 2, method: 'SubscribeToTask', params: { id: a.taskId } });
    await readFramesWithDeadline(resB);
    await resB.body!.cancel().catch(() => undefined);
    await sleep(100);

    // The P1-11 review repro wording "全新 messageId/新任务": a new task in a
    // fresh conversation is admitted (only ONE slot is held by parked A).
    const resC = await rpcPost(service.base, {
      jsonrpc: '2.0', id: 3, method: 'SendStreamingMessage',
      params: { message: { messageId: 'p1-12-fresh-c', role: 'ROLE_USER', parts: [{ text: '新会话' }] } },
    });
    assert.equal(resC.headers.get('content-type')?.includes('text/event-stream'), true);
    const frames = await readSseFrames(resC);
    const cTask = taskFrameOf(frames[0]);
    assert.equal(cTask.state, 'TASK_STATE_WORKING', 'the new-task stream is dispatched normally');
    assert.ok(frames.some((frame) => {
      const update = (frame['result'] as Record<string, unknown> | undefined)?.['statusUpdate'] as Record<string, unknown> | undefined;
      return update !== undefined && (update['status'] as { state: string }).state === 'TASK_STATE_COMPLETED';
    }), 'the fresh stream runs to completion');

    await rpcPost(service.base, { jsonrpc: '2.0', id: 4, method: 'CancelTask', params: { id: a.taskId } });
  } finally {
    await stopA2aService(service);
  }
});

test('P1-12 teardown: silent disconnect terminates the resubscribe generator (no dangling consumer) while the task stays non-terminal', async () => {
  const service = await startTest();
  try {
    assert.equal(service.streamLifecycle.registered, 0);
    assert.equal(service.streamLifecycle.tornDown, 0);

    const a = await openParkAndDrop(service, 'p1-12-teardown-a');
    const resB = await rpcPost(service.base, { jsonrpc: '2.0', id: 2, method: 'SubscribeToTask', params: { id: a.taskId } });
    await readFramesWithDeadline(resB);
    await resB.body!.cancel().catch(() => undefined);

    // The disconnect hook fires on res 'close' — BEFORE any task settlement
    // (A is still parked, so settlement cannot explain the teardown).
    // Counters cover the RESUBSCRIBE surface only: the send path is a
    // deliberate passthrough (the locked SDK's send delivery loop doubles as
    // the task-state persistence pump — see the file header).
    await sleep(250);
    assert.equal(service.streamLifecycle.registered, 1, 'the resubscribe generator registered a teardown');
    assert.equal(service.streamLifecycle.tornDown, 1,
      `the abandoned resubscribe generator was terminated by the disconnect hook (got ${service.streamLifecycle.tornDown})`);
    assert.equal(service.streamLifecycle.completed, 0, 'no natural completion was misattributed');

    // 断流≠取消 (R8): the teardown releases the DELIVERY side only — the
    // parked execution keeps the task non-terminal. (rpcResultOf, not
    // rpcPost: the raw Response's `.body` is a ReadableStream.)
    const stillRunning = await rpcResultOf(service.base, 3, 'GetTask', { id: a.taskId });
    const task = stillRunning.body['result'] as Record<string, unknown>;
    assert.equal((task['status'] as { state: string }).state, 'TASK_STATE_WORKING',
      'silent disconnect must NOT cancel the execution');

    // The resubscribe slot is free again: a fresh resubscribe on the same
    // active task still delivers (no leftover stream-order state).
    const resubscribeAgain = await rpcPost(service.base, { jsonrpc: '2.0', id: 4, method: 'SubscribeToTask', params: { id: a.taskId } });
    const [againFrame] = await readFramesWithDeadline(resubscribeAgain);
    assert.equal(taskFrameOf(againFrame).id, a.taskId);

    await rpcPost(service.base, { jsonrpc: '2.0', id: 5, method: 'CancelTask', params: { id: a.taskId } });
  } finally {
    await stopA2aService(service);
  }
});

test('P1-12: a slow but attached resubscribe consumer keeps receiving every frame (teardown fires on disconnect, never on slowness)', async () => {
  const service = await startTest();
  try {
    const tornDownBefore = service.streamLifecycle.tornDown;
    const completedBefore = service.streamLifecycle.completed;
    const a = await openParkAndDrop(service, 'p1-12-slow-a');
    await sleep(100);
    const res = await rpcPost(service.base, { jsonrpc: '2.0', id: 2, method: 'SubscribeToTask', params: { id: a.taskId } });
    assert.equal(res.headers.get('content-type')?.includes('text/event-stream'), true);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const frames: Record<string, unknown>[] = [];
    const parseInto = (chunk: string): void => {
      buffer += chunk;
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (event.startsWith('data:')) {
          frames.push(JSON.parse(event.slice('data:'.length).trim()) as Record<string, unknown>);
        }
        boundary = buffer.indexOf('\n\n');
      }
    };
    const readSome = async (): Promise<void> => {
      const { value, done } = await reader.read();
      if (done) return;
      parseInto(decoder.decode(value, { stream: true }));
    };
    await readSome();
    assert.ok(frames.length >= 1, 'first frame (task snapshot) arrived');
    // Deliberately slow consumption while the task stays parked, then settle
    // the task UNDER the slow consumer: every frame (through the terminal
    // settlement) must still reach the attached consumer.
    await sleep(300);
    await rpcPost(service.base, { jsonrpc: '2.0', id: 3, method: 'CancelTask', params: { id: a.taskId } });
    while (true) {
      const chunk = (await reader.read().then(
        (result) => result,
        () => ({ done: true }),
      )) as { value?: Uint8Array; done?: boolean };
      if (chunk.done) break;
      if (chunk.value !== undefined) parseInto(decoder.decode(chunk.value, { stream: true }));
    }
    const states = frames.map((frame) => {
      const result = frame['result'] as Record<string, unknown> | undefined;
      if (result?.['statusUpdate'] !== undefined) {
        return ((result['statusUpdate'] as Record<string, unknown>)['status'] as { state: string }).state;
      }
      return undefined;
    }).filter((state) => state !== undefined);
    assert.ok(states.includes('TASK_STATE_CANCELED'), `the slow consumer still saw the terminal settlement (states: ${states.join(',')})`);
    assert.equal(service.streamLifecycle.tornDown, tornDownBefore,
      'a healthy (even slow) resubscribe is never torn down by slowness');
    assert.equal(service.streamLifecycle.completed, completedBefore + 1,
      'the resubscribe counted as naturally completed');
  } finally {
    await stopA2aService(service);
  }
});
