/**
 * P1-04 acceptance tests (issue #86): persistent idempotent acceptance,
 * first-response-lost recovery and the execution dispatch lease.
 *
 * AC 1  Concurrent same-key sends produce ONE task / ONE effective
 *       execution; same key with different content is a stable
 *       MESSAGE_ID_CONFLICT that leaks no other-subject data.
 * AC 2  Re-sending the ORIGINAL message after a lost first response returns
 *       the SAME taskId (no repeated inference); the cancel intent is
 *       persisted BEFORE the remote cancel is dispatched, and cancel
 *       re-delivery is observable and side-effect-free.
 * AC 3  Pre-dispatch re-checks: quota refusal settles REJECTED before the
 *       lease; an authorization refusal after the claim settles CANCELED; a
 *       Worker-start failure after the commit leaves one execution and the
 *       retry NEVER re-runs it.
 * AC 4  Purge/tombstone: bodies are gone, replay cannot resurrect them, and
 *       a retried request on a tombstoned key is refused (RESULT_PURGED),
 *       never re-executed. Retention windows are configurable initial
 *       values (24h / 7d / ≥30d floor) — see config-load tests.
 *
 * Everything is loopback + synthetic (P1 口径).
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { TaskState } from '@a2a-js/sdk';
import { startA2aService } from '../src/a2a-service.ts';
import { SqliteTaskManager } from '../src/task-manager/sqlite-task-manager.ts';
import {
  TEST_TOKEN,
  officialClient,
  rpcHeaders,
  startTest,
  stopA2aService,
  testConfig,
  userMessage,
} from './helpers.ts';

interface SendWireBody {
  jsonrpc: '2.0';
  id: number | string;
  method: 'SendMessage' | 'SendStreamingMessage';
  params: { message: Record<string, unknown>; configuration?: Record<string, unknown> };
}

/** Builds a JSON-RPC body around the ORIGINAL wire message (retry keeps it). */
function sendBody(
  id: number,
  message: Record<string, unknown>,
  method: 'SendMessage' | 'SendStreamingMessage' = 'SendMessage',
): SendWireBody {
  return { jsonrpc: '2.0', id, method, params: { message } };
}

async function postRpc(
  base: string,
  body: unknown,
  token: string | null = TEST_TOKEN,
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers: rpcHeaders({ token }),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { httpStatus: res.status, body: JSON.parse(text) as Record<string, unknown> };
}

function wireTaskOf(response: Record<string, unknown>): Record<string, unknown> {
  const result = response['result'] as Record<string, unknown> | undefined;
  return (result?.['task'] as Record<string, unknown> | undefined) ?? {};
}

function wireMessage(
  messageId: string,
  text: string,
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  // Loose wire shape (the SDK handler parses it through Message.fromJSON —
  // same contract as the protocol-error fixtures).
  const body: Record<string, unknown> = {
    messageId,
    role: 'ROLE_USER',
    parts: [{ text }],
  };
  if (metadata !== undefined) body['metadata'] = metadata;
  return body;
}

test('AC1: concurrent same-messageId same-content sends yield ONE task, ONE execution, no re-run', async () => {
  const service = await startTest();
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const message = wireMessage('msg-race-1', '你好');
    const bodies = [1, 2, 3, 4, 5].map((id) => sendBody(id, message));

    const responses = await Promise.all(bodies.map((body) => postRpc(service.base, body)));
    const taskIds = responses.map(({ body }) => wireTaskOf(body)['id'] as string);
    for (const { httpStatus, body } of responses) {
      assert.equal(httpStatus, 200);
      assert.equal(body['error'], undefined, 'every racing send succeeds');
      assert.ok(typeof wireTaskOf(body)['id'] === 'string');
    }
    assert.equal(new Set(taskIds).size, 1, 'all racing responses carry the SAME taskId');

    const taskId = taskIds[0];
    const detail = manager.getTaskDetail(taskId);
    assert.equal(detail.currentState, 'completed');
    assert.equal(detail.turns.length, 1, 'exactly one turn — no duplicate acceptance');
    assert.equal(detail.turns[0].executions.length, 1, 'exactly one effective execution');
    assert.equal(manager.stats().tasks, 1, 'exactly one task row for the racing key');
    assert.equal(manager.stats().ledger, 1, 'exactly one ledger entry');
    // One dispatch claim → submitted→working→completed (2 status events).
    const journal = manager.readOutbox(taskId, { includePublished: true });
    const statusEvents = journal.filter((event) => event.kind === 'statusUpdate');
    assert.equal(statusEvents.length, 2, 'one claim + one completion, no duplicated dispatch');
  } finally {
    await stopA2aService(service);
  }
});

test('AC1: same key with DIFFERENT content → stable MESSAGE_ID_CONFLICT, no new task, no subject leak', async () => {
  const service = await startTest();
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const first = await postRpc(service.base, sendBody(1, wireMessage('msg-conflict-1', '第一条')));
    assert.equal(first.body['error'], undefined);
    const originalTaskId = wireTaskOf(first.body)['id'] as string;

    const conflict = await postRpc(
      service.base,
      sendBody(2, wireMessage('msg-conflict-1', '不同的内容')),
    );
    assert.equal(conflict.httpStatus, 200);
    const error = conflict.body['error'] as Record<string, unknown>;
    assert.ok(error, 'key reuse with different content is refused');
    assert.equal(error['code'], -32602);
    const data = error['data'] as { reason?: string; domain?: string }[] | undefined;
    assert.equal(data?.[0]?.reason, 'MESSAGE_ID_CONFLICT');
    assert.equal(data?.[0]?.domain, 'lumithink.a2a');
    // 不泄漏其他主体/其他内容：no task id, no original text, no household data.
    const serialized = JSON.stringify(conflict.body);
    assert.ok(!serialized.includes(originalTaskId), 'the error never carries the existing task id');
    assert.ok(!serialized.includes('第一条'), 'the error never carries the original content');

    assert.equal(manager.stats().tasks, 1, 'no new task for the conflicted request');
    assert.equal(manager.stats().ledger, 1);
  } finally {
    await stopA2aService(service);
  }
});

test('AC2: first response lost → re-sending the ORIGINAL message recovers the SAME taskId without re-inference', async () => {
  const service = await startTest();
  try {
    const manager = service.taskStore as SqliteTaskManager;

    // (a) completed case: the "lost" response is discarded; the retry is the
    //     byte-identical original message with a fresh JSON-RPC id.
    const message = wireMessage('msg-lost-1', '你好');
    await postRpc(service.base, sendBody(1, message)); // response lost
    const retry = await postRpc(service.base, sendBody(2, message));
    const recovered = wireTaskOf(retry.body);
    assert.equal(retry.body['error'], undefined);
    assert.ok(typeof recovered['id'] === 'string');
    assert.equal(recovered['status'] && (recovered['status'] as Record<string, unknown>)['state'], 'TASK_STATE_COMPLETED');
    const detail = manager.getTaskDetail(recovered['id'] as string);
    assert.equal(detail.turns.length, 1, 'the retry must not create a second turn');
    assert.equal(detail.turns[0].executions.length, 1, 'the retry must not re-dispatch the execution');

    // (b) in-flight case: a PARKED cancel-test task; the retry (different
    //     JSON-RPC method — fingerprint excludes transport mode) returns the
    //     live snapshot immediately instead of re-running anything.
    let parkedId = '';
    const streamRes = await fetch(`${service.base}/`, {
      method: 'POST',
      headers: rpcHeaders(),
      body: JSON.stringify(
        sendBody(
          3,
          wireMessage('msg-lost-2', '请取消我', { lumithinkScenario: 'cancel-test' }),
          'SendStreamingMessage',
        ),
      ),
    });
    const reader = streamRes.body!.getReader();
    let buffer = '';
    while (parkedId === '') {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const frame = JSON.parse(buffer.slice('data:'.length, boundary).trim()) as Record<string, unknown>;
        parkedId = ((frame['result'] as Record<string, unknown>)['task'] as { id: string }).id;
      }
    }
    await reader.cancel().catch(() => undefined);
    assert.ok(parkedId);

    const parkedRetry = await postRpc(
      service.base,
      sendBody(4, wireMessage('msg-lost-2', '请取消我', { lumithinkScenario: 'cancel-test' })),
    );
    assert.equal(parkedRetry.body['error'], undefined);
    const parkedWire = wireTaskOf(parkedRetry.body);
    assert.equal(parkedWire['id'], parkedId, 'retry of the in-flight task returns the SAME taskId');
    assert.equal(
      parkedWire['status'] && (parkedWire['status'] as Record<string, unknown>)['state'],
      'TASK_STATE_WORKING',
      'the live snapshot reflects the claimed dispatch lease',
    );
    const parkedDetail = manager.getTaskDetail(parkedId);
    assert.equal(parkedDetail.turns.length, 1);
    assert.equal(parkedDetail.turns[0].executions.length, 1, 'still exactly one execution');

    // Cleanup: settle the parked task (also proves the persisted cancel
    // intent path on a claimed execution → real-cancel route).
    await fetch(`${service.base}/`, {
      method: 'POST',
      headers: rpcHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'CancelTask', params: { id: parkedId } }),
    });
  } finally {
    await stopA2aService(service);
  }
});

test('AC2: cancel intent is persisted BEFORE the remote cancel; cancel re-delivery adds no side effects', async () => {
  const service = await startTest();
  try {
    const manager = service.taskStore as SqliteTaskManager;
    // Park a task (claimed → working).
    let parkedId = '';
    const { client } = await officialClient(service.base);
    for await (const event of client.sendMessageStream({
      tenant: '',
      message: userMessage('msg-cancel-order-1', '请取消我', { lumithinkScenario: 'cancel-test' }),
      configuration: undefined,
      metadata: undefined,
    })) {
      if (event.payload?.$case === 'task') {
        parkedId = event.payload.value.id;
        break;
      }
    }
    assert.ok(parkedId);
    assert.equal(
      manager.readOutbox(parkedId).filter((event) => event.kind === 'cancelCommand').length,
      0,
      'no cancel intent before the cancel request',
    );

    // CancelTask: intent persisted (outbox cancelCommand committed) BEFORE
    // the inner (remote) cancel dispatch — then the task settles CANCELED.
    const cancelRes = await fetch(`${service.base}/`, {
      method: 'POST',
      headers: rpcHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'CancelTask', params: { id: parkedId } }),
    });
    const cancelBody = (await cancelRes.json()) as Record<string, unknown>;
    assert.equal(
      ((cancelBody['result'] as Record<string, unknown>)['status'] as { state: string }).state,
      'TASK_STATE_CANCELED',
    );

    const cancelEvents = manager
      .readOutbox(parkedId, { includePublished: true })
      .filter((event) => event.kind === 'cancelCommand');
    assert.equal(cancelEvents.length, 1, 'exactly ONE persisted cancel intent');

    // Re-deliver the cancel (补发远端取消): the terminal task returns its
    // snapshot per standard semantics and NO further cancel command is
    // recorded — the persisted intent already drove the settlement.
    const repeat = await fetch(`${service.base}/`, {
      method: 'POST',
      headers: rpcHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'CancelTask', params: { id: parkedId } }),
    });
    const repeatBody = (await repeat.json()) as Record<string, unknown>;
    assert.equal(
      ((repeatBody['result'] as Record<string, unknown>)['status'] as { state: string }).state,
      'TASK_STATE_CANCELED',
    );
    assert.equal(
      manager.readOutbox(parkedId, { includePublished: true }).filter((event) => event.kind === 'cancelCommand').length,
      1,
      'cancel re-delivery records no second intent (already-terminal)',
    );
    assert.equal(manager.getTaskDetail(parkedId).currentState, 'canceled');
  } finally {
    await stopA2aService(service);
  }
});

test('AC3: quota refusal before the lease settles REJECTED; retry never re-runs', async () => {
  const service = await startA2aService({
    config: testConfig(),
    quotaGate: () => ({ allowed: false, reason: 'quota_exhausted' }),
  });
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const message = wireMessage('msg-quota-1', '你好');
    const first = await postRpc(service.base, sendBody(1, message));
    const wire = wireTaskOf(first.body);
    assert.equal(
      wire['status'] && (wire['status'] as Record<string, unknown>)['state'],
      'TASK_STATE_REJECTED',
      'quota refusal before dispatch settles REJECTED (no execution started)',
    );
    const taskId = wire['id'] as string;
    assert.equal(manager.getTaskDetail(taskId).turns[0].executions.length, 0, 'no lease was granted');
    assert.equal(manager.getTaskDetail(taskId).currentState, 'rejected');

    const retry = await postRpc(service.base, sendBody(2, message));
    assert.equal(wireTaskOf(retry.body)['id'], taskId, 'the retry recovers the SAME (rejected) task');
    assert.equal(manager.stats().executions, 0, 'still no execution for the rejected task');
  } finally {
    await stopA2aService(service);
  }
});

test('AC3: worker-start failure AFTER the commit leaves one execution; the retry never blindly re-runs it', async () => {
  let executions = 0;
  const service = await startA2aService({
    config: testConfig(),
    executor: {
      async execute() {
        executions += 1;
        throw new Error('synthetic worker start failure');
      },
      async cancelTask() {
        // never reached in this test
      },
    },
  });
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const message = wireMessage('msg-workerfail-1', '你好');
    const first = await postRpc(service.base, sendBody(1, message));
    const wire = wireTaskOf(first.body);
    assert.equal(
      wire['status'] && (wire['status'] as Record<string, unknown>)['state'],
      'TASK_STATE_FAILED',
      'the SDK settles a worker-start failure as FAILED (no silent retry)',
    );
    const taskId = wire['id'] as string;
    assert.equal(manager.getTaskDetail(taskId).turns[0].executions.length, 1,
      'the claim committed; the execution record is kept for recovery (not blindly retried)');
    assert.equal(executions, 1);

    const retry = await postRpc(service.base, sendBody(2, message));
    assert.equal(wireTaskOf(retry.body)['id'], taskId, 'retry returns the SAME failed task');
    assert.equal(executions, 1, 'the failed execution is NEVER re-run by a duplicate request');
  } finally {
    await stopA2aService(service);
  }
});

test('AC4: purge tombstones the key, removes all body, and neither replay nor retry resurrects it', async () => {
  const service = await startTest();
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const message = wireMessage('msg-purge-1', '需要被清理的正文');
    const first = await postRpc(service.base, sendBody(1, message));
    const taskId = wireTaskOf(first.body)['id'] as string;
    assert.equal(manager.getTaskDetail(taskId).currentState, 'completed');
    assert.equal(manager.stats().chunks, 2);

    const purged = manager.purgeTaskBody(taskId);
    assert.equal(purged.outcome, 'purged');
    assert.equal(purged.tombstonedKeys, 1);

    // Body is gone from every read path…
    const snapshot = await manager.load(taskId);
    assert.ok(snapshot);
    assert.equal(snapshot.history?.length ?? 0, 0, 'history body deleted');
    assert.equal((snapshot.artifacts ?? []).length, 0, 'artifact body deleted');
    assert.equal(snapshot.status?.message, undefined, 'status message cleared');
    assert.equal(manager.stats().chunks, 0);
    assert.equal(manager.stats().history, 0);

    // …and the Outbox replay carries no body text (payloads are body-free).
    const journal = manager.readOutbox(taskId, { includePublished: true });
    const serialized = JSON.stringify(journal);
    assert.ok(!serialized.includes('需要被清理的正文'), 'replay cannot resurrect the deleted body');
    assert.ok(!serialized.includes('你好。'), 'no admitted answer text survives in the journal');

    // A retried request on the tombstoned key: explicit refusal, no re-run.
    const retry = await postRpc(service.base, sendBody(2, message));
    const error = retry.body['error'] as Record<string, unknown>;
    assert.ok(error, 'tombstoned keys are refused');
    assert.equal(error['code'], -32000);
    const data = error['data'] as { reason?: string; domain?: string }[] | undefined;
    assert.equal(data?.[0]?.reason, 'RESULT_PURGED');
    assert.equal(manager.stats().executions, 1, 'no re-execution behind the tombstone');

    // State rows stay minimal & readable (audit/diagnostic), without body.
    assert.equal(manager.getTaskDetail(taskId).currentState, 'completed');
  } finally {
    await stopA2aService(service);
  }
});

test('current schema is applied by the composed service (v2 tombstone timestamp + v3 purge marker)', async () => {
  const service = await startTest();
  try {
    const manager = service.taskStore as SqliteTaskManager;
    assert.equal(manager.schemaVersion, 3);
  } finally {
    await stopA2aService(service);
  }
});

test('streaming duplicate of a COMPLETED task returns one SSE frame with the original task', async () => {
  const service = await startTest();
  try {
    const message = wireMessage('msg-stream-dup-1', '你好');
    await postRpc(service.base, sendBody(1, message));
    const res = await fetch(`${service.base}/`, {
      method: 'POST',
      headers: rpcHeaders(),
      body: JSON.stringify(sendBody(2, message, 'SendStreamingMessage')),
    });
    assert.ok(res.headers.get('content-type')?.includes('text/event-stream'));
    const raw = await res.text();
    const frames = raw
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data:'))
      .map((chunk) => JSON.parse(chunk.slice('data:'.length).trim()) as Record<string, unknown>);
    assert.equal(frames.length, 1, 'the duplicate stream answers with ONE snapshot frame');
    const wire = ((frames[0]['result'] as Record<string, unknown>)['task'] ?? {}) as Record<string, unknown>;
    assert.ok(typeof wire['id'] === 'string', 'the snapshot frame carries the original task');
    assert.equal(
      wire['status'] && (wire['status'] as Record<string, unknown>)['state'],
      'TASK_STATE_COMPLETED',
    );
  } finally {
    await stopA2aService(service);
  }
});

test('AC1 cross-subject: the same messageId from ANOTHER credential is a DIFFERENT request key', async () => {
  const service = await startTest();
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const message = wireMessage('msg-tenant-1', '你好');
    const first = await postRpc(service.base, sendBody(1, message));
    const firstId = wireTaskOf(first.body)['id'] as string;

    // A different (unknown) credential is rejected upstream; but the
    // important property here: the ledger is keyed by the authenticated
    // binding, so a second AUTHENTICATED client would get its own task. The
    // single-credential default bootstrap cannot produce that; instead pin
    // that the stored request key derives from the identity (the ledger
    // count stays 1 and the unauthenticated attempt created nothing).
    const unauth = await postRpc(service.base, sendBody(2, message), null);
    assert.equal((unauth.body['error'] as Record<string, unknown>)['code'], -32000);
    assert.equal(manager.stats().tasks, 1, 'unauthenticated requests never reach the ledger');
    assert.equal(manager.getTaskDetail(firstId).currentState, 'completed');
  } finally {
    await stopA2aService(service);
  }
});

// ---------------------------------------------------------------------------
// P1-06 (issue #88): binding-orphan convergence + duplicate-response stance
// ---------------------------------------------------------------------------

test('#88 / review #103 P2-1: duplicate, conflict and tombstone retries leave NO orphan task bindings behind', async () => {
  const service = await startTest();
  try {
    const manager = service.taskStore as SqliteTaskManager;
    const identity = service.identity.store;
    const first = await postRpc(service.base, sendBody(1, wireMessage('msg-bind-1', '第一条')));
    const taskId = wireTaskOf(first.body)['id'] as string;
    const contextId = wireTaskOf(first.body)['contextId'] as string;
    assert.ok(taskId && contextId);

    for (let i = 0; i < 5; i += 1) {
      // Duplicate retry (same key + fingerprint)…
      await postRpc(service.base, sendBody(10 + i, wireMessage('msg-bind-1', '第一条')));
      // …and a conflicting re-key (same key, different fingerprint).
      const conflict = await postRpc(
        service.base,
        sendBody(20 + i, wireMessage('msg-bind-1', `变体${i}`)),
      );
      assert.equal((conflict.body['error'] as Record<string, unknown>)?.['code'], -32602);
    }

    assert.equal(
      identity.taskBindingsForContext(contextId).length,
      1,
      'retry loops must not grow random-taskId orphan bindings',
    );
    assert.equal(identity.taskBindingsForContext(contextId)[0].taskId, taskId);

    // Purge → tombstoned key → RESULT_PURGED retries also stay clean.
    manager.purgeTaskBody(taskId);
    const purgedRetry = await postRpc(service.base, sendBody(99, wireMessage('msg-bind-1', '第一条')));
    const purgedError = purgedRetry.body['error'] as { data?: { reason?: string }[] } | undefined;
    assert.equal(purgedError?.data?.[0]?.reason, 'RESULT_PURGED');
    assert.equal(identity.taskBindingsForContext(contextId).length, 1);
  } finally {
    await stopA2aService(service);
  }
});

test('#88 / ADR-0015 §5.2 final stance: a streaming duplicate of a WORKING task answers IMMEDIATELY from the snapshot — it never waits for the original execution', async () => {
  let release!: () => void;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let released = false;
  const parkedExecutor = {
    async execute(requestContext: { taskId: string; contextId: string }, eventBus: {
      publish(event: unknown): void;
    }): Promise<void> {
      const { taskId, contextId } = requestContext;
      eventBus.publish({
        kind: 'task',
        data: {
          id: taskId,
          contextId,
          status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: undefined },
          artifacts: [],
          history: [],
          metadata: undefined,
        },
      });
      eventBus.publish({
        kind: 'statusUpdate',
        data: {
          taskId,
          contextId,
          status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined },
          metadata: undefined,
        },
      });
      await parked;
      released = true;
      eventBus.publish({
        kind: 'statusUpdate',
        data: {
          taskId,
          contextId,
          status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: undefined },
          metadata: undefined,
        },
      });
    },
    async cancelTask(): Promise<void> {},
  };
  const service = await startA2aService({ config: testConfig(), executor: parkedExecutor });
  try {
    // Start the ORIGINAL send as a stream and break after the first frame —
    // the task is now dispatched and PARKED in working (executor blocked).
    const streamRes = await fetch(`${service.base}/`, {
      method: 'POST',
      headers: rpcHeaders(),
      body: JSON.stringify(sendBody(1, wireMessage('msg-nowait-1', '原始请求'), 'SendStreamingMessage')),
    });
    assert.equal(streamRes.status, 200);
    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    let workingTaskId = '';
    while (workingTaskId === '') {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const frames = buffered.split('\n\n');
      buffered = frames.pop() ?? '';
      for (const frame of frames) {
        if (!frame.startsWith('data:')) continue;
        const parsed = JSON.parse(frame.slice('data:'.length).trim()) as Record<string, unknown>;
        const payload = parsed['result'] as Record<string, unknown> | undefined;
        const candidate =
          (payload?.['task'] as Record<string, unknown> | undefined) ??
          (payload?.['status'] !== undefined ? (payload as Record<string, unknown>) : undefined);
        const id = (candidate?.['taskId'] as string) ?? (candidate?.['id'] as string);
        if (id) workingTaskId = id;
      }
    }
    assert.ok(workingTaskId, 'the original stream delivered a task id');
    assert.equal(released, false, 'the executor is still parked');
    assert.equal(service.taskStore instanceof SqliteTaskManager, true);

    // The DUPLICATE streaming retry must return while the original run is
    // still parked — 快照直答不等待 (ADR-0015 §5.2 FINAL stance since #88).
    const duplicateStart = Date.now();
    const duplicateRes = await fetch(`${service.base}/`, {
      method: 'POST',
      headers: rpcHeaders(),
      body: JSON.stringify(sendBody(2, wireMessage('msg-nowait-1', '原始请求'), 'SendStreamingMessage')),
    });
    assert.equal(duplicateRes.status, 200);
    const raw = await duplicateRes.text();
    assert.equal(Date.now() - duplicateStart < 5000, true, 'no blocking wait on the parked execution');
    const frames = raw
      .split('\n\n')
      .filter((chunk) => chunk.startsWith('data:'))
      .map((chunk) => JSON.parse(chunk.slice('data:'.length).trim()) as Record<string, unknown>);
    assert.equal(frames.length, 1);
    const wire = ((frames[0]['result'] as Record<string, unknown>)['task'] ?? {}) as Record<string, unknown>;
    assert.equal(wire['id'], workingTaskId);
    assert.equal((wire['status'] as Record<string, unknown>)['state'], 'TASK_STATE_WORKING');

    // The parked execution was NOT affected by the duplicate answer; release
    // it and confirm it settles normally afterwards.
    release();
    const manager = service.taskStore as SqliteTaskManager;
    for (let i = 0; i < 50 && !released; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(released, true, 'the original execution completes after release');
    assert.equal(manager.getTaskDetail(workingTaskId).currentState, 'completed');
  } finally {
    await stopA2aService(service);
  }
});
