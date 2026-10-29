/**
 * P2-02 (issue #114) — REAL-LINK integration suite.
 *
 * Six acceptance groups from the issue, executed against the REAL
 * a2a-server standalone subprocess (dsh-worker runtime, file SQLite,
 * synthetic two-credential bootstrap, loopback only, synthetic content):
 *
 *   G1  Task 创建、查询（GetTask）、多轮（conversation continuation via
 *       new messageId + same contextId + referenceTaskIds; the INPUT_REQUIRED
 *       structured-handle contract is proven at mock level — see the honest
 *       capability-gap note in the P2-02 review record).
 *   G2  真实 Worker 执行：受理门 → 派发租约 → 真实 worker 子进程产出准入正文
 *       （跨进程 DB 执行证据 + 公开 artifact）。
 *   G3  取消真实传播：工具 Abort → 独立 CancelTask → 服务端停止 worker
 *       （CANCELED + 执行行 settled/outcome=canceled + worker_id 证据）。
 *   G4  响应丢失幂等恢复：首响应在服务器受理后丢失（注入 fetch 丢失）→
 *       原 messageId 重试取得同一 Task，不重复推理（唯一执行行）。
 *   G5  认证与跨主体：伪造 metadata/tenant/userId 不提权；跨主体 GetTask/
 *       CancelTask 拒绝（-32001 → task_not_found）；凭据过期重签。
 *   G6  失败与重连：服务端重启后 GetTask 恢复真实状态（不重复推理）；
 *       SSE 断流后 GetTask/重订阅恢复。
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ALPHA_TOKEN,
  BETA_TOKEN,
  countTasksForMessageId,
  killOrphanWorkers,
  parseSettlement,
  readExecutions,
  readTaskBinding,
  readTaskRow,
  startServer,
} from './server-harness.ts';
import { DshA2aClient, TaskWaitAbortedError } from '../../src/index.ts';

const POLL = 100;

function makeClient(baseUrl: string, ledgerFile: string, token: string, overrides: Record<string, unknown> = {}): DshA2aClient {
  return new DshA2aClient({
    baseUrl,
    credential: token,
    ledger: ledgerFile,
    pollIntervalMs: POLL,
    ...overrides,
  });
}

async function waitUntilServerSettles(
  client: DshA2aClient,
  messageId: string,
  states: string[],
  timeoutMs = 30_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const handle = await client.getTask({ messageId });
    if (handle.state !== undefined && states.includes(handle.state)) return handle.state;
    if (Date.now() > deadline) {
      assert.fail(`task for ${messageId} did not reach ${states.join('/')} in time (state=${handle.state})`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL));
  }
}

// ---------------------------------------------------------------------------
// G1 + G2 + G5 share a 'complete'-behavior server.
// ---------------------------------------------------------------------------
test('G1/G2/G5: real worker execution, query, multi-turn, auth & cross-principal', { timeout: 180_000 }, async () => {
  const server = await startServer({ workerBehavior: 'complete' });
  const clientDir = mkdtempSync(path.join(tmpdir(), 'dsh-a2a-client-alpha-'));
  const ledgerFile = path.join(clientDir, 'ledger.json');
  try {
    const client = makeClient(server.base, ledgerFile, ALPHA_TOKEN);

    // --- G2: real worker execution ----------------------------------------
    const done = await client.sendAndConsume({ text: '你好', messageId: 'msg-g2-1' });
    assert.equal(done.state, 'completed');
    assert.ok(done.taskId);
    const executionRows = readExecutions(server.taskDbPath, done.taskId as string);
    assert.equal(executionRows.length, 1);
    assert.equal(executionRows[0].state, 'settled', 'the dispatch-lease execution row is settled');
    assert.ok(executionRows[0].worker_id, 'a REAL worker subprocess registered on the execution row');
    const settlement = parseSettlement(executionRows[0]);
    assert.equal(settlement['outcome'], 'completed');
    const taskRow = readTaskRow(server.taskDbPath, done.taskId as string);
    assert.equal(taskRow?.['current_state'], 'completed');

    // --- G1: create/query/multi-turn --------------------------------------
    const queried = await client.getTask({ messageId: 'msg-g2-1' });
    assert.equal(queried.state, 'completed');

    const first = await client.sendAndConsume({ text: '开启会话', messageId: 'msg-g1-1' });
    const follow = await client.sendFollowUp(
      { fromMessageId: 'msg-g1-1', text: '继续同一会话的补充输入。' },
      { mode: 'returnImmediately' },
    );
    assert.ok(follow.taskId && follow.contextId);
    assert.notEqual(follow.taskId, first.taskId);
    const followDone = await waitUntilServerSettles(client, follow.messageId, ['completed']);
    assert.equal(followDone, 'completed');
    const followTask = await client.getTask({ messageId: follow.messageId });
    assert.equal(followTask.contextId, (await client.getTask({ messageId: 'msg-g1-1' })).contextId,
      'the follow-up continues the SAME conversation context');

    // --- G5: forged metadata does not escalate ----------------------------
    const forged = await client.sendAndConsume({
      text: '伪造身份字段',
      messageId: 'msg-g5-forged-1',
      metadata: {
        lumithinkScenario: 'complete',
        userId: 'user-beta-guardian',
        householdId: 'hh-beta-02',
        tenant: 'forged-tenant',
      },
    });
    assert.equal(forged.state, 'completed', 'the request itself succeeds; forged fields are ignored');
    const forgedBinding = readTaskBinding(server.identityDbPath, forged.taskId as string);
    assert.ok(forgedBinding, 'the task attribution binding exists');
    assert.equal(forgedBinding?.['principal_user_id'], 'user-alpha-guardian',
      'attribution stays on the AUTHENTICATED principal, not the forged metadata');

    // --- G5: cross-principal denial (second credential negative case) -----
    const betaDir = mkdtempSync(path.join(tmpdir(), 'dsh-a2a-client-beta-'));
    try {
      const betaClient = makeClient(server.base, path.join(betaDir, 'ledger.json'), BETA_TOKEN);
      await assert.rejects(
        () => betaClient.getTask({ taskId: done.taskId as string }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, 'task_not_found',
            'cross-principal task access is denied with the standard -32001 shape');
          return true;
        },
        'beta must NOT read alpha\'s task',
      );
      const cancelOutcome = await betaClient.cancel({ taskId: done.taskId as string }, 'cross-principal cancel attempt');
      assert.equal(cancelOutcome.status, 'not_found', 'cross-principal cancel is denied the same way');
      assert.equal(readTaskRow(server.taskDbPath, done.taskId as string)?.['current_state'], 'completed',
        'the denied cancel did not touch alpha\'s task');
    } finally {
      rmSync(betaDir, { recursive: true, force: true });
    }

    // --- G5: credential expiry re-sign against the REAL 401 line ----------
    const resignDir = mkdtempSync(path.join(tmpdir(), 'dsh-a2a-client-resign-'));
    try {
      let providerCalls = 0;
      const tokens = [BETA_TOKEN + '-stale-padding', BETA_TOKEN]; // first: invalid
      const resignClient = new DshA2aClient({
        baseUrl: server.base,
        credential: async () => {
          const token = tokens[Math.min(providerCalls, tokens.length - 1)];
          providerCalls += 1;
          return token;
        },
        ledger: path.join(resignDir, 'ledger.json'),
        pollIntervalMs: POLL,
      });
      const handle = await resignClient.sendAndConsume({ text: '过期重签后执行', messageId: 'msg-g5-resign-1' });
      assert.equal(handle.state, 'completed', 'after the 401 the re-signed credential completed the task');
      assert.ok(providerCalls >= 2, 'the provider was consulted for the re-sign');
      assert.equal(resignClient.lastRenewalFailure, null);
    } finally {
      rmSync(resignDir, { recursive: true, force: true });
    }
  } finally {
    await server.stop();
    rmSync(clientDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G4: response-loss idempotent recovery on the REAL server.
// ---------------------------------------------------------------------------
test('G4: lost first response → original messageId retry → same task, no duplicate inference', { timeout: 180_000 }, async () => {
  const server = await startServer({ workerBehavior: 'complete' });
  const clientDir = mkdtempSync(path.join(tmpdir(), 'dsh-a2a-client-loss-'));
  const ledgerFile = path.join(clientDir, 'ledger.json');
  try {
    let droppedFirst = false;
    const lossyFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      const isSend =
        init?.method === 'POST' &&
        typeof init?.body === 'string' &&
        init.body.includes('"messageId":"msg-g4-loss-1"') &&
        init.body.includes('SendMessage');
      if (isSend && !droppedFirst) {
        // §5.3: the response is lost AFTER the server processed the request.
        droppedFirst = true;
        throw new TypeError('simulated response loss after server acceptance');
      }
      return response;
    };
    const client = new DshA2aClient({
      baseUrl: server.base,
      credential: ALPHA_TOKEN,
      ledger: ledgerFile,
      pollIntervalMs: POLL,
      fetchImpl: lossyFetch,
    });

    const handle = await client.sendAndConsume({ text: '响应丢失恢复', messageId: 'msg-g4-loss-1' });
    assert.equal(handle.state, 'completed');
    assert.ok(droppedFirst, 'the injected loss actually fired');

    // The ORIGINAL messageId resolved to exactly ONE task with ONE execution.
    assert.equal(countTasksForMessageId(server.taskDbPath, 'msg-g4-loss-1'), 1,
      'the same messageId maps to exactly one task');
    const executions = readExecutions(server.taskDbPath, handle.taskId as string);
    assert.equal(executions.length, 1, 'no duplicate inference — one execution row only');
    assert.equal(parseSettlement(executions[0])['outcome'], 'completed');

    // The retry IS the same original message (finite client retry with the
    // same stable messageId — server idempotency returns the same task).
  } finally {
    await server.stop();
    rmSync(clientDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G3: real cancel propagation with WORKER STOP EVIDENCE.
// ---------------------------------------------------------------------------
test('G3: tool abort → independent CancelTask → worker really stops (server-side evidence)', { timeout: 180_000 }, async () => {
  const server = await startServer({ workerBehavior: 'stop-on-cancel' });
  const clientDir = mkdtempSync(path.join(tmpdir(), 'dsh-a2a-client-cancel-'));
  const ledgerFile = path.join(clientDir, 'ledger.json');
  try {
    const client = makeClient(server.base, ledgerFile, ALPHA_TOKEN);
    const controller = new AbortController();
    const waitPromise = client.sendAndConsume(
      { text: '取消传播验证', messageId: 'msg-g3-1' },
      { signal: controller.signal },
    );

    // Wait until the real worker has produced its first admitted chunk, so
    // the cancel demonstrably hits a LIVE execution (not pre-dispatch).
    const deadline = Date.now() + 20_000;
    for (;;) {
      let handle: Awaited<ReturnType<DshA2aClient['getTask']>>;
      try {
        handle = await client.getTask({ messageId: 'msg-g3-1' });
      } catch {
        // The ledger record may not carry a taskId for the first instants.
        if (Date.now() > deadline) assert.fail('worker chunk wait timed out during unmapped phase');
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      if ((handle.artifactChunks ?? 0) >= 1 && handle.state === 'working') break;
      if (Date.now() > deadline) assert.fail(`worker never produced its first chunk (state=${handle.state})`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // §7.4: abort stops the local presentation FIRST, then the client sends
    // the independent CancelTask (never the aborted signal).
    controller.abort();
    await assert.rejects(
      () => waitPromise,
      (error: unknown) => {
        assert.ok(error instanceof TaskWaitAbortedError);
        assert.equal(error.cancelOutcome, 'confirmed_canceled');
        return true;
      },
    );

    const taskId = (await client.getTask({ messageId: 'msg-g3-1' })).taskId as string;

    // WORKER STOP EVIDENCE (server-side, cross-process):
    //  1. the public task settles CANCELED — published only after real stop
    //     evidence per P1-07 (never on "client stopped waiting");
    //  2. the execution row is SETTLED with outcome=canceled, a REAL
    //     worker_id, and the worker's exit evidence (exitCode 0, self-reported).
    const taskRow = readTaskRow(server.taskDbPath, taskId);
    assert.equal(taskRow?.['current_state'], 'canceled');
    assert.equal(taskRow?.['cancel_intent'], 1);

    const executions = readExecutions(server.taskDbPath, taskId);
    assert.equal(executions.length, 1);
    const execution = executions[0];
    assert.equal(execution.state, 'settled');
    assert.ok(execution.worker_id, 'the real worker registered before the cancel');
    const settlement = parseSettlement(execution);
    assert.equal(settlement['outcome'], 'canceled', 'the worker itself reported the cancel');
    assert.equal(settlement['exitCode'], 0, 'the worker process exited cleanly after stopping');
    assert.equal(settlement['killedByRuntime'], undefined, 'cooperative stop — no forced kill needed');

    // The client's ledger carries the confirmed intent for audit.
    const { FileTaskLedger } = await import('../../src/ledger.ts');
    const ledger = new FileTaskLedger(ledgerFile);
    const record = await ledger.load('msg-g3-1');
    assert.equal(record?.cancelIntent?.status, 'confirmed_canceled');
    assert.equal(record?.taskId, taskId);
  } finally {
    await server.stop();
    rmSync(clientDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// G6: failure & reconnect recovery (server restart + SSE interruption).
// ---------------------------------------------------------------------------
test('G6a: server restart → GetTask recovers true state, no duplicate inference', { timeout: 180_000 }, async () => {
  // The shared directory + DB files are created HERE so the first server's
  // stop() cannot delete them before the restarted instance reuses them.
  const sharedDir = mkdtempSync(path.join(tmpdir(), 'dsh-a2a-restart-shared-'));
  const dbPaths = {
    dir: sharedDir,
    taskDbPath: path.join(sharedDir, 'task.sqlite'),
    identityDbPath: path.join(sharedDir, 'identity.sqlite'),
  };
  const server = await startServer({ workerBehavior: 'stop-on-cancel', reuse: dbPaths });
  const clientDir = mkdtempSync(path.join(tmpdir(), 'dsh-a2a-client-restart-'));
  const ledgerFile = path.join(clientDir, 'ledger.json');
  try {
    const client = makeClient(server.base, ledgerFile, ALPHA_TOKEN);
    // Parked task (worker keeps running until canceled)…
    const parked = await client.send(
      { text: '跨重启恢复', messageId: 'msg-g6-parked-1' },
      { mode: 'returnImmediately' },
    );
    assert.ok(parked.taskId);
    // …and a TERMINAL task whose result must be retained across the restart.
    // (The server's worker behavior profile is per-instance, so the terminal
    // case here is an honestly canceled parked task, not a completed one.)
    const doneHandle = await client.send(
      { text: '重启前取消', messageId: 'msg-g6-done-1' },
      { mode: 'returnImmediately' },
    );
    const doneOutcome = await client.cancel({ messageId: 'msg-g6-done-1' }, 'terminal retention fixture');
    assert.equal(doneOutcome.status, 'confirmed_canceled');
    assert.ok(doneHandle.taskId);

    const restartInfo = { dir: server.dir, taskDbPath: server.taskDbPath, identityDbPath: server.identityDbPath };
    await server.stop(); // simulated crash of the server process
    killOrphanWorkers(); // the crashed server's parked worker would linger otherwise

    const restarted = await startServer({ workerBehavior: 'stop-on-cancel', reuse: restartInfo });
    try {
      const afterRestart = makeClient(restarted.base, ledgerFile, ALPHA_TOKEN);

      // Ledger + server persistence: the SAME taskId is still queryable.
      const doneAfter = await afterRestart.getTask({ messageId: 'msg-g6-done-1' });
      assert.equal(doneAfter.taskId, doneHandle.taskId);
      assert.equal(doneAfter.state, 'canceled', 'terminal results survive the restart');

      const parkedAfter = await afterRestart.getTask({ messageId: 'msg-g6-parked-1' });
      assert.equal(parkedAfter.taskId, parked.taskId);
      assert.ok(
        parkedAfter.state === 'failed' || parkedAfter.state === 'working',
        `the interrupted task reports a truthful server-side state (got ${parkedAfter.state})`,
      );

      // No duplicate inference across the restart: still exactly ONE
      // execution row for the parked task, now settled/abandoned honestly.
      const executions = readExecutions(restarted.taskDbPath, parked.taskId as string);
      assert.equal(executions.length, 1);
      assert.ok(
        ['abandoned', 'settled'].includes(executions[0].state),
        `the interrupted execution is closed by the startup recovery scan (got ${executions[0].state})`,
      );
      if (executions[0].state === 'settled') {
        assert.equal(parseSettlement(executions[0])['outcome'], 'abandoned',
          'an unknown-outcome execution is settled abandoned — never re-run');
      }

      // The client's restart scan classifies the pending record correctly.
      const pending = await afterRestart.resumePending();
      const parkedItem = pending.find((p) => p.messageId === 'msg-g6-parked-1');
      assert.ok(parkedItem);
      assert.ok(['query_or_reattach', 'nothing_pending'].includes(parkedItem.suggestedAction),
        `the scan reflects the recovered state (got ${parkedItem.suggestedAction})`);
    } finally {
      await restarted.stop();
    }
  } finally {
    await server.stop().catch(() => undefined);
    killOrphanWorkers();
    rmSync(clientDir, { recursive: true, force: true });
    rmSync(sharedDir, { recursive: true, force: true });
  }
});

test('G6b: SSE interruption → local abort does not cancel; GetTask + resubscribe recover', { timeout: 180_000 }, async () => {
  const server = await startServer({ workerBehavior: 'stop-on-cancel' });
  const clientDir = mkdtempSync(path.join(tmpdir(), 'dsh-a2a-client-sse-'));
  const ledgerFile = path.join(clientDir, 'ledger.json');
  try {
    const client = makeClient(server.base, ledgerFile, ALPHA_TOKEN);
    const controller = new AbortController();
    const consumption = (async () => {
      for await (const _event of client.consumeStream(
        { text: 'SSE 断流恢复', messageId: 'msg-g6-sse-1' },
        { signal: controller.signal },
      )) {
        // consume the initial frames
      }
    })();
    const deadline = Date.now() + 20_000;
    for (;;) {
      let handle: Awaited<ReturnType<DshA2aClient['getTask']>>;
      try {
        handle = await client.getTask({ messageId: 'msg-g6-sse-1' });
      } catch {
        if (Date.now() > deadline) assert.fail('chunk wait timed out during unmapped phase');
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      if ((handle.artifactChunks ?? 0) >= 1) break;
      if (Date.now() > deadline) assert.fail('the stream task never produced a chunk');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    controller.abort(); // drop the SSE connection locally
    await assert.rejects(() => consumption, TaskWaitAbortedError);

    // Stream-resilience: the task keeps running server-side.
    const snapshot = await client.getTask({ messageId: 'msg-g6-sse-1' });
    assert.equal(snapshot.state, 'working', 'the dropped stream did not cancel the task');

    // Re-attach to the live stream.
    const states: string[] = [];
    const resubscribeSignal = new AbortController();
    const resubscribed = (async () => {
      for await (const event of client.resubscribe(
        { messageId: 'msg-g6-sse-1' },
        { signal: resubscribeSignal.signal },
      )) {
        if (event.kind === 'statusUpdate' && event.state !== undefined) states.push(event.state);
        if (event.state === 'canceled') break;
      }
    })();

    // Then finish the task through the explicit cancel path.
    const outcome = await client.cancel({ messageId: 'msg-g6-sse-1' }, 'post-reconnect cleanup');
    assert.equal(outcome.status, 'confirmed_canceled');
    await resubscribed;
    // The REAL server's SubscribeToTask is a CUT-POINT stream: it delivers
    // events AFTER the re-attach cursor (no historical state replay), so the
    // recovered stream must observe the terminal CANCELED — the recovery
    // contract this group verifies. (The mock-level replay of the current
    // state is covered in tests/client-stream.spec.ts.)
    assert.ok(states.includes('canceled'), 'the resubscribed stream observed the terminal CANCELED');
  } finally {
    await server.stop();
    rmSync(clientDir, { recursive: true, force: true });
  }
});
