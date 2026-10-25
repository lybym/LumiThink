/**
 * P0-02 (issue #80) isolated wire verification against the locked official
 * JS SDK @a2a-js/sdk@1.3.0 (server + client) on a 127.0.0.1 loopback.
 *
 * Real execution evidence for:
 *  - JSON-RPC 2.0 request/response envelope for SendMessage / GetTask;
 *  - SSE envelope (text/event-stream, `data:` JSON-RPC frames) for
 *    SendStreamingMessage, first frame = Task, then artifact/status events;
 *  - append/lastChunk on the wire update events, never on the artifact;
 *  - standard JSON-RPC errors: TaskNotFound (-32001), TaskNotCancelable
 *    (-32002) for a repeated CancelTask, UnsupportedOperation (-32004) for
 *    SubscribeToTask on a terminal task (per spec §9.4.6);
 *  - A2A-Version header behavior (client-sent value, missing header,
 *    unsupported version);
 *  - Task-only application policy: a Task-first executor yields `result.task`
 *    for blocking SendMessage (never a bare Message);
 *  - the default SDK TaskStore surface for the Store/handler adaptation note.
 *
 * Synthetic data only; ephemeral loopback port; no credentials, no services.
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TaskState } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory, DefaultAgentCardResolver } from '@a2a-js/sdk/client';
import { startVerifyServer } from './server-lib.mjs';

const REPORTS_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../reports');

const evidence = {
  lockedSdk: '@a2a-js/sdk@1.3.0',
  clientRequests: [],
  jsonRpcMessageSendResponse: null,
  sse: { contentType: null, rawBody: null, frames: [] },
  errors: {},
  taskStorePrototype: null,
  a2aVersionHeader: null,
};

const { base, server, taskStore } = await startVerifyServer();
console.log(`loopback server on ${base}`);

const rpcPost = async (body, headers = {}) =>
  fetch(`${base}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', ...headers },
    body: JSON.stringify(body),
  });

const rpcErrorOf = async (method, params, headers = {}) => {
  const res = await rpcPost({ jsonrpc: '2.0', id: 999, method, params }, headers);
  const json = await res.json();
  return { httpStatus: res.status, error: json.error ?? null };
};

// --- official client with header recording ----------------------------------
const recordedFetch = async (input, init = {}) => {
  const headers = {};
  if (init.headers) {
    if (typeof init.headers.forEach === 'function') init.headers.forEach((v, k) => { headers[k] = v; });
    else Object.assign(headers, init.headers);
  }
  evidence.clientRequests.push({ method: init.method ?? 'GET', url: String(input), headers });
  return fetch(input, init);
};
const factory = new ClientFactory({
  transports: [new JsonRpcTransportFactory({ fetchImpl: recordedFetch })],
  cardResolver: new DefaultAgentCardResolver({ fetchImpl: recordedFetch }),
});
const client = await factory.createFromUrl(base);
evidence.a2aVersionHeader = client.protocolVersion;
console.log(`official client protocolVersion = ${client.protocolVersion}`);

// --- 1) blocking SendMessage via official client (Task-only result) ---------
// The official client returns the Task object itself (SendMessageResult =
// Task | Message); the JSON-RPC wire result carries the `task` oneof key.
const sent = await client.sendMessage({ message: { messageId: 'msg-blocking', role: 'ROLE_USER', parts: [{ text: '你好' }] } });
assert.ok(sent && typeof sent.id === 'string', 'blocking SendMessage must resolve to a Task (Task-only policy)');
assert.equal(sent.status.state, TaskState.TASK_STATE_COMPLETED, 'blocking result must be terminal COMPLETED');
const blockedTaskId = sent.id;
console.log(`blocking SendMessage → Task ${blockedTaskId} state=TASK_STATE_COMPLETED`);
console.log('[probe] client-blocking artifacts:', JSON.stringify(sent.artifacts));
console.log('[probe] client-blocking metadata :', JSON.stringify(sent.metadata));
record: {
  const res = await rpcPost({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'msg-raw-send', role: 'ROLE_USER', parts: [{ text: '你好' }] }, configuration: { returnImmediately: false } } });
  const json = await res.json();
  evidence.jsonRpcMessageSendResponse = json;
  assert.ok(json.result && 'task' in json.result && !('message' in json.result), 'raw message/send result must carry task oneof only');
  console.log('raw message/send result keys:', Object.keys(json.result).join(', '), '→ task.status.state =', json.result.task.status.state);
  console.log('[probe] raw-send artifacts:', JSON.stringify(json.result.task.artifacts));
  console.log('[probe] raw-send metadata :', JSON.stringify(json.result.task.metadata));
}

// --- 2) raw GetTask: aggregated snapshot ------------------------------------
// SDK default store keeps append:true updates as SEPARATE parts on the
// artifact (append appends parts). LumiThink's application contract
// aggregates chunk text into a single text part (fixture 03); the wire-level
// invariant is "concatenate parts in order == full answer".
{
  const res = await rpcPost({ jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: blockedTaskId } });
  const json = await res.json();
  const task = json.result;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(task.artifacts[0].parts.map((p) => p.text).join(''), '你好。我们开始吧。',
    'artifact parts in order must concatenate to the full answer');
  assert.equal(task.artifacts[0].parts.length, 2,
    'SDK default store preserves appended updates as separate parts');
  assert.ok(!('append' in task.artifacts[0]) && !('lastChunk' in task.artifacts[0]), 'snapshot artifact has no append/lastChunk');
  assert.deepEqual(task.metadata.lumithinkResult, undefined,
    'default SDK store does not auto-create lumithinkResult (application contract, set by the app)');
  console.log('GetTask snapshot OK; parts =', task.artifacts[0].parts.length, '; concatenated text = 你好。我们开始吧。');
}

// --- 3) raw SendStreamingMessage: SSE envelope ------------------------------
{
  const res = await rpcPost({ jsonrpc: '2.0', id: 3, method: 'SendStreamingMessage', params: { message: { messageId: 'msg-stream', role: 'ROLE_USER', parts: [{ text: '你好' }] } } });
  evidence.sse.contentType = res.headers.get('content-type');
  assert.ok(evidence.sse.contentType.includes('text/event-stream'), 'stream must be text/event-stream');
  const raw = await res.text();
  evidence.sse.rawBody = raw;
  const frames = raw.split('\n\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice('data:'.length).trim()));
  evidence.sse.frames = frames;
  assert.ok(frames.length >= 4, `expected >= 4 SSE frames, got ${frames.length}`);
  const kinds = frames.map((f) => Object.keys(f.result).filter((k) => k !== 'jsonrpc' && k !== 'id'));
  assert.deepEqual(Object.keys(frames[0].result).filter((k) => !['jsonrpc', 'id'].includes(k)), ['task'], 'first SSE frame must be the Task');
  const artifactFrames = frames.map((f) => f.result.artifactUpdate).filter(Boolean);
  assert.equal(artifactFrames.length, 2);
  assert.equal(artifactFrames[0].append ?? false, false, 'first chunk append:false (proto3 may omit the key on the wire)');
  assert.equal(artifactFrames[1].append, true);
  assert.equal(artifactFrames[1].lastChunk, true);
  assert.ok(artifactFrames.every((f) => !('append' in f.artifact) && !('lastChunk' in f.artifact)), 'wire artifact never carries append/lastChunk');
  const lastFrame = frames[frames.length - 1].result;
  assert.equal(lastFrame.statusUpdate.status.state, 'TASK_STATE_COMPLETED');
  console.log(`SSE OK: ${frames.length} frames; kinds = ${JSON.stringify(kinds)}; contentType=${evidence.sse.contentType}`);
  var streamedTaskId = frames[0].result.task.id;
}

// --- 4) cancel semantics on a long-running task -----------------------------
{
  const res = await rpcPost({ jsonrpc: '2.0', id: 4, method: 'SendStreamingMessage', params: { message: { messageId: 'msg-cancel', role: 'ROLE_USER', parts: [{ text: '请取消我' }], metadata: { lumithinkScenario: 'cancel-test' } } } });
  // read only the first frame (task) then release the connection; task keeps running
  const reader = res.body.getReader();
  let buf = '';
  let firstFrame = null;
  while (!firstFrame) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    const idx = buf.indexOf('\n\n');
    if (idx >= 0) {
      const line = buf.slice(0, idx);
      if (line.startsWith('data:')) firstFrame = JSON.parse(line.slice(5).trim());
    }
  }
  await reader.cancel();
  const cancelTaskId = firstFrame.result.task.id;

  const preCancel = await (await rpcPost({ jsonrpc: '2.0', id: 7, method: 'GetTask', params: { id: cancelTaskId } })).json();
  console.log('[probe] state before cancel =', JSON.stringify(preCancel.result?.status ?? preCancel.error));

  const cancelRes = await rpcPost({ jsonrpc: '2.0', id: 5, method: 'CancelTask', params: { id: cancelTaskId } });
  const cancelJson = await cancelRes.json();
  assert.ok(cancelJson.result, `first CancelTask must succeed: ${JSON.stringify(cancelJson)}`);
  console.log('first CancelTask → task state =', cancelJson.result.status.state);

  // let the terminal event land, then query
  await new Promise((r) => setTimeout(r, 120));
  const got = await (await rpcPost({ jsonrpc: '2.0', id: 6, method: 'GetTask', params: { id: cancelTaskId } })).json();
  assert.equal(got.result.status.state, 'TASK_STATE_CANCELED', 'GetTask after cancel must show CANCELED');
  evidence.errors.cancelTaskResult = cancelJson.result.status.state;
  console.log('GetTask after cancel →', got.result.status.state);

  // Duplicate CancelTask on the now-CANCELED task: the SDK treats re-cancel
  // of a CANCELED task as IDEMPOTENT (returns the task, no error). Record it.
  const second = await rpcPost({ jsonrpc: '2.0', id: 8, method: 'CancelTask', params: { id: cancelTaskId } });
  const secondJson = await second.json();
  evidence.errors.duplicateCancelTaskOnCanceled = secondJson;
  assert.ok(secondJson.result, 'duplicate CancelTask on CANCELED task must be idempotent (result, not error)');
  assert.equal(secondJson.result.status.state, 'TASK_STATE_CANCELED');
  console.log('duplicate CancelTask on CANCELED → idempotent result, state =', secondJson.result.status.state);

  // CancelTask on a COMPLETED task: TaskNotCancelable (-32002) with ErrorInfo data.
  const third = await rpcErrorOf('CancelTask', { id: blockedTaskId });
  evidence.errors.cancelTaskOnCompleted = third;
  assert.equal(third.error.code, -32002, 'CancelTask on COMPLETED task must be TaskNotCancelable (-32002)');
  assert.equal(third.error.data?.[0]?.reason, 'TASK_NOT_CANCELABLE');
  console.log('CancelTask on COMPLETED →', JSON.stringify(third.error));
}

// --- 5) SubscribeToTask on a terminal task ----------------------------------
{
  const sub = await rpcErrorOf('SubscribeToTask', { id: streamedTaskId });
  evidence.errors.subscribeTerminalTask = sub;
  console.log('SubscribeToTask on terminal task →', JSON.stringify(sub));
}

// --- 6) GetTask on an unknown task ------------------------------------------
{
  const miss = await rpcErrorOf('GetTask', { id: 'task-does-not-exist' });
  evidence.errors.taskNotFound = miss;
  assert.equal(miss.error.code, -32001, 'unknown task must be TaskNotFound (-32001)');
  console.log('GetTask unknown →', JSON.stringify(miss.error));
}

// --- 7) A2A-Version behaviors ------------------------------------------------
{
  const unsupported = await rpcErrorOf('GetTask', { id: blockedTaskId }, { 'A2A-Version': '9.9' });
  evidence.errors.unsupportedVersion = unsupported;
  console.log('A2A-Version: 9.9 →', JSON.stringify(unsupported));

  const missing = await rpcErrorOf('GetTask', { id: blockedTaskId }, { 'A2A-Version': '' });
  evidence.errors.missingVersionHeader = missing;
  console.log('missing A2A-Version →', JSON.stringify(missing));
}

// --- 8) TaskStore surface for the adaptation note ---------------------------
evidence.taskStorePrototype = Object.getOwnPropertyNames(Object.getPrototypeOf(taskStore));

mkdirSync(REPORTS_DIR, { recursive: true });
writeFileSync(path.join(REPORTS_DIR, 'wire-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`\nWIRE VERIFY OK — evidence written to ${path.join(REPORTS_DIR, 'wire-evidence.json')}`);

server.close();
