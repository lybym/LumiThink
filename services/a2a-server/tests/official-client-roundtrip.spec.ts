/**
 * AC 1 (issue #83): official independent JS client protocol round-trip.
 *
 * The official client from the LOCKED @a2a-js/sdk@1.3.0 performs, against
 * the composed service:
 *   1. Agent Card discovery (/.well-known/agent-card.json);
 *   2. blocking SendMessage → Task (Task-only policy), terminal COMPLETED;
 *   3. streaming sendMessageStream → task frame first, append-only artifact
 *      updates (append/lastChunk on the events, never on the artifact),
 *      final COMPLETED status;
 *   4. GetTask snapshot recovery (parts concatenate to the full answer);
 *   5. CancelTask on a parked (cancel-test) task → CANCELED.
 *
 * Content is synthetic; the artifact chunks mirror the frozen fixture
 * payload (docs/fixtures/a2a-v1.0) for cross-checkability.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { TaskState } from '@a2a-js/sdk';
import { officialClient, startTest, stopA2aService, userMessage } from './helpers.ts';

test('official client: agent card discovery + blocking SendMessage returns a COMPLETED Task', async () => {
  const service = await startTest();
  try {
    const { client, requests } = await officialClient(service.base);

    // The client resolved the card through discovery.
    const card = await client.getAgentCard();
    assert.equal(card.name, 'lumithink');
    assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
    assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
    assert.equal(card.capabilities?.streaming, true);
    assert.equal(card.supportedInterfaces[0].url, service.base,
      'the discovered card must point back at the bound loopback URL');
    const cardFetch = requests.find((r) => r.url.includes('/.well-known/agent-card.json'));
    assert.ok(cardFetch, 'official client must discover the agent card over HTTP');

    const sent = await client.sendMessage({
      tenant: '',
      message: userMessage('msg-blocking-1', '你好'),
      configuration: undefined,
      metadata: undefined,
    });
    assert.ok(sent && typeof (sent as { id?: unknown }).id === 'string',
      'blocking SendMessage must resolve to a Task (Task-only policy)');
    const task = sent as { id: string; status?: { state?: number }; artifacts?: unknown[] };
    assert.equal(task.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.ok(Array.isArray(task.artifacts) && task.artifacts.length >= 1);
  } finally {
    await stopA2aService(service);
  }
});

test('official client: streaming round-trip (task first, append-only chunks, completed)', async () => {
  const service = await startTest();
  try {
    const { client } = await officialClient(service.base);
    const cases: { $case: string }[] = [];
    const artifactUpdates: { append?: boolean; lastChunk?: boolean; artifact?: { parts?: unknown[] } }[] = [];
    let lastState: number | undefined;
    for await (const event of client.sendMessageStream({
      tenant: '',
      message: userMessage('msg-stream-1', '你好'),
      configuration: undefined,
      metadata: undefined,
    })) {
      cases.push({ $case: event.payload?.$case ?? 'none' });
      if (event.payload?.$case === 'artifactUpdate') {
        const value = event.payload.value as {
          append?: boolean;
          lastChunk?: boolean;
          artifact?: { parts?: unknown[] };
        };
        artifactUpdates.push(value);
      }
      if (event.payload?.$case === 'statusUpdate') {
        lastState = (event.payload.value as { status?: { state?: number } }).status?.state;
      }
    }
    assert.ok(cases.length >= 4, `expected >= 4 stream events, got ${cases.length}`);
    assert.equal(cases[0].$case, 'task', 'first stream event must be the Task');

    assert.equal(artifactUpdates.length, 2);
    assert.equal(artifactUpdates[0].append ?? false, false, 'first chunk: append false (may be omitted)');
    assert.equal(artifactUpdates[1].append, true, 'second chunk appends');
    assert.equal(artifactUpdates[1].lastChunk, true, 'second chunk closes the artifact');
    const artifactOne = artifactUpdates[0].artifact as Record<string, unknown>;
    assert.ok(!('append' in artifactOne), 'artifact never carries append');
    assert.ok(!('lastChunk' in artifactOne), 'artifact never carries lastChunk');

    assert.equal(lastState, TaskState.TASK_STATE_COMPLETED, 'final status is COMPLETED');
  } finally {
    await stopA2aService(service);
  }
});

test('official client: GetTask snapshot — parts concatenate to the full answer', async () => {
  const service = await startTest();
  try {
    const { client } = await officialClient(service.base);
    const sent = (await client.sendMessage({
      tenant: '',
      message: userMessage('msg-get-1', '你好'),
      configuration: undefined,
      metadata: undefined,
    })) as { id: string };

    const snapshot = await client.getTask({ tenant: '', id: sent.id });
    assert.equal(snapshot.status?.state, TaskState.TASK_STATE_COMPLETED);
    const parts = (snapshot.artifacts?.[0]?.parts ?? []) as { content?: { $case?: string; value?: string } }[];
    const text = parts
      .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
      .join('');
    assert.equal(text, '你好。我们开始吧。',
      'artifact parts in order must concatenate to the full answer');
    const artifact = snapshot.artifacts?.[0] as unknown as Record<string, unknown>;
    assert.ok(!('append' in artifact) && !('lastChunk' in artifact),
      'snapshot artifact carries no append/lastChunk');
    assert.equal(snapshot.metadata?.lumithinkResult, undefined,
      'the SDK store does not auto-create lumithinkResult (application contract, P1-02+)');
  } finally {
    await stopA2aService(service);
  }
});

test('official client: CancelTask on a parked task → CANCELED; GetTask confirms', async () => {
  const service = await startTest();
  try {
    const { client } = await officialClient(service.base);
    let parkedId = '';
    for await (const event of client.sendMessageStream({
      tenant: '',
      message: userMessage('msg-cancel-1', '请取消我', { lumithinkScenario: 'cancel-test' }),
      configuration: undefined,
      metadata: undefined,
    })) {
      if (event.payload?.$case === 'task') {
        parkedId = event.payload.value.id;
        break; // drop the connection; the task keeps running
      }
    }
    assert.ok(parkedId, 'stream must yield the Task first');

    const before = await client.getTask({ tenant: '', id: parkedId });
    // P1-04 (#86): the dispatch lease is claimed at executor start, so the
    // parked task is WORKING; the invariant is "non-terminal before cancel".
    assert.equal(before.status?.state, TaskState.TASK_STATE_WORKING,
      'parked task is non-terminal before cancel (dispatch lease claimed)');

    const canceled = await client.cancelTask({ tenant: '', id: parkedId, metadata: undefined });
    assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED,
      'official client CancelTask returns the CANCELED task');

    await new Promise((resolve) => setTimeout(resolve, 120));
    const confirmed = await client.getTask({ tenant: '', id: parkedId });
    assert.equal(confirmed.status?.state, TaskState.TASK_STATE_CANCELED);
  } finally {
    await stopA2aService(service);
  }
});
