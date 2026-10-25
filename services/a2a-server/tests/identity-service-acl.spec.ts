/**
 * Service-level identity & authorization ACL tests (P1-03, issue #85).
 *
 * Two synthetic households (hh-alpha / hh-beta) with guardian/child
 * memberships, a guardian relationship, per-user DSH profile credentials, a
 * device adapter credential and short-term grants (session-verified +
 * voiceprint candidate). Official-shape raw JSON-RPC requests prove:
 *   AC1 — forged message metadata (userId/householdId/role) and the A2A
 *         tenant field can never switch the server-resolved authorization;
 *   AC2 — cross-household and cross-user Task/Get/Cancel/Subscribe and
 *         session continuation are rejected; ListTasks is scope-filtered;
 *   AC3 — credential/membership revocation closes live SSE streams, kills
 *         cached decisions and denies the next request immediately; the
 *         executor admission gate settles CANCELED mid-execution; audit rows
 *         record the denials;
 *   AC4 — the device credential authenticates the household only; session
 *         grants elevate with scope/expiry/revocation negatives; voiceprint
 *         candidates bind only device-level conversations.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { TaskState } from '@a2a-js/sdk';
import type { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { startA2aService, stopA2aService, type StartedA2aService } from '../src/a2a-service.ts';
import { SyntheticExecutor } from '../src/synthetic-executor.ts';
import { testConfig, userMessage, type StartedTest } from './helpers.ts';
import type { IdentityBootstrap } from '../src/identity/identity-store.ts';
import type { AgentExecutionEvent } from '@a2a-js/sdk/server';

const TOKEN_A = 'synthetic-guardian-a-token-0123456789';
const TOKEN_A_CHILD = 'synthetic-child-a-token-0123456789ab';
const TOKEN_B = 'synthetic-guardian-b-token-0123456789';
const DEVICE_TOKEN = 'synthetic-device-token-01234567890abc';

function aclBootstrap(): IdentityBootstrap {
  return {
    households: [
      { householdId: 'hh-alpha', displayName: 'Alpha family' },
      { householdId: 'hh-beta', displayName: 'Beta family' },
    ],
    users: [
      { userId: 'guardian-a', displayName: 'Guardian A' },
      { userId: 'child-a', displayName: 'Child A' },
      { userId: 'guardian-b', displayName: 'Guardian B' },
    ],
    memberships: [
      { householdId: 'hh-alpha', userId: 'guardian-a', role: 'guardian' },
      { householdId: 'hh-alpha', userId: 'child-a', role: 'child' },
      { householdId: 'hh-beta', userId: 'guardian-b', role: 'guardian' },
    ],
    relationships: [
      { householdId: 'hh-alpha', guardianUserId: 'guardian-a', childUserId: 'child-a' },
    ],
    clients: [
      { clientId: 'dsh-a', kind: 'dsh_profile', displayName: 'Guardian A DSH profile' },
      { clientId: 'dsh-a-child', kind: 'dsh_profile', displayName: 'Child A DSH profile' },
      { clientId: 'dsh-b', kind: 'dsh_profile', displayName: 'Guardian B DSH profile' },
      {
        clientId: 'xiaozhi-dev-1',
        kind: 'xiaozhi_device',
        displayName: 'Device adapter',
        householdId: 'hh-alpha',
      },
    ],
    credentials: [
      {
        credentialId: 'cred-a',
        clientId: 'dsh-a',
        token: TOKEN_A,
        binding: 'bound_principal',
        principalUserId: 'guardian-a',
        householdId: 'hh-alpha',
      },
      {
        credentialId: 'cred-a-child',
        clientId: 'dsh-a-child',
        token: TOKEN_A_CHILD,
        binding: 'bound_principal',
        principalUserId: 'child-a',
        householdId: 'hh-alpha',
      },
      {
        credentialId: 'cred-b',
        clientId: 'dsh-b',
        token: TOKEN_B,
        binding: 'bound_principal',
        principalUserId: 'guardian-b',
        householdId: 'hh-beta',
      },
      {
        credentialId: 'cred-device',
        clientId: 'xiaozhi-dev-1',
        token: DEVICE_TOKEN,
        binding: 'client_only',
      },
    ],
    grants: [
      {
        grantId: 'grant-session',
        clientId: 'xiaozhi-dev-1',
        householdId: 'hh-alpha',
        kind: 'session_verified',
        userId: 'guardian-a',
        sessionBinding: 'conn-gen-1',
        scope: ['chat.general', 'learning.fact.read'],
        expiresAtMs: Date.now() + 300_000,
      },
      {
        grantId: 'grant-candidate',
        clientId: 'xiaozhi-dev-1',
        householdId: 'hh-alpha',
        kind: 'voiceprint_candidate',
        candidateUserId: 'child-a',
        sessionBinding: 'conn-gen-1',
        scope: ['chat.general', 'personalization.low_sensitivity.read'],
        expiresAtMs: Date.now() + 300_000,
      },
    ],
  };
}

async function startAclService(): Promise<StartedTest> {
  const service = await startA2aService({
    config: testConfig(),
    executor: new SyntheticExecutor(),
    identityBootstrap: aclBootstrap(),
  });
  return service as StartedTest;
}

interface RpcOptions {
  token?: string | null;
  extraHeaders?: Record<string, string>;
}

async function rpc(
  base: string,
  id: number | string,
  method: string,
  params: unknown,
  options: RpcOptions = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'a2a-version': '1.0',
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.extraHeaders ?? {}),
  };
  const res = await fetch(`${base}/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function errorOf(body: Record<string, unknown>): Record<string, unknown> {
  return body['error'] as Record<string, unknown>;
}

function resultTaskId(body: Record<string, unknown>): string {
  const result = body['result'] as Record<string, unknown>;
  return ((result['task'] ?? result) as { id: string }).id;
}

async function createTask(
  service: StartedA2aService,
  token: string,
  messageId: string,
  metadata?: Record<string, unknown>,
  extraHeaders?: Record<string, string>,
): Promise<{ taskId: string; contextId: string }> {
  const { body } = await rpc(service.base, `create-${messageId}`, 'SendMessage', {
    message: { messageId, role: 'ROLE_USER', parts: [{ text: '你好' }], metadata },
    configuration: { returnImmediately: false },
  }, { token, extraHeaders });
  assert.ok(body['result'], `task creation must succeed for ${messageId}: ${JSON.stringify(body)}`);
  const result = body['result'] as Record<string, unknown>;
  const task = (result['task'] ?? result) as { id: string; contextId: string };
  return { taskId: task.id, contextId: task.contextId };
}

test('AC1: forged message metadata (userId/householdId/role/tenant) never changes server-resolved authorization', async () => {
  const service = await startAclService();
  try {
    // Guardian A sends a message FULL of forged identity claims.
    const { taskId } = await createTask(service, TOKEN_A, 'msg-forge-1', {
      userId: 'guardian-b',
      householdId: 'hh-beta',
      role: 'guardian',
      tenant: 'hh-beta',
    });
    // The server-side binding records the TRUE caller scope.
    const binding = service.identity.store.taskBinding(taskId);
    assert.ok(binding);
    assert.equal(binding?.householdId, 'hh-alpha', 'household comes from the credential binding');
    assert.equal(binding?.principalUserId, 'guardian-a', 'principal comes from the credential binding');
    assert.equal(binding?.clientId, 'dsh-a');

    // A lower-privileged sibling credential cannot elevate itself by forgery.
    const { taskId: guardianTask } = await createTask(service, TOKEN_A, 'msg-forge-2');
    const forgedGet = await rpc(service.base, 2, 'GetTask', { id: guardianTask }, { token: TOKEN_A_CHILD });
    // The child credential of the SAME household still cannot read the
    // guardian's task (cross-user): the claimed identity fields are ignored.
    assert.equal(forgedGet.status, 200);
    assert.equal(errorOf(forgedGet.body)?.['code'], -32001, 'forgery cannot cross the principal boundary');

    // Forged grant header on a dsh_profile credential: grants are client-bound
    // (and the binding header is absent anyway — fail-closed either way).
    const forgedGrant = await rpc(service.base, 5, 'SendMessage', {
      message: { messageId: 'msg-forge-grant', role: 'ROLE_USER', parts: [{ text: '你好' }] },
    }, {
      token: TOKEN_A_CHILD,
      extraHeaders: { 'x-lumithink-session-grant': 'grant-session' },
    });
    assert.equal(forgedGrant.status, 403, 'a device-session grant never elevates another client');
    assert.equal((errorOf(forgedGrant.body)?.['data'] as { reason?: string }[])?.[0]?.reason,
      'PERMISSION_DENIED');

    // Session-binding negative: right grant id, WRONG connection generation.
    const staleBinding = await rpc(service.base, 6, 'SendMessage', {
      message: { messageId: 'msg-forge-binding', role: 'ROLE_USER', parts: [{ text: '你好' }] },
    }, {
      token: DEVICE_TOKEN,
      extraHeaders: {
        'x-lumithink-session-grant': 'grant-session',
        'x-lumithink-session-binding': 'conn-gen-9',
      },
    });
    assert.equal(staleBinding.status, 403, 'a stale session binding never elevates');

    // Cross-HOUSEHOLD forgery: guardian-b claims householdId hh-alpha.
    const { taskId: bTask } = await createTask(service, TOKEN_B, 'msg-forge-3', {
      householdId: 'hh-alpha',
      userId: 'guardian-a',
    });
    const bBinding = service.identity.store.taskBinding(bTask);
    assert.equal(bBinding?.householdId, 'hh-beta', 'the forged household claim is ignored');
    const crossGet = await rpc(service.base, 3, 'GetTask', { id: guardianTask }, { token: TOKEN_B });
    assert.equal(errorOf(crossGet.body)?.['code'], -32001, 'cross-household Get is rejected');
    // ...and guardian-b's own task is readable by guardian-b only.
    const ownGet = await rpc(service.base, 4, 'GetTask', { id: bTask }, { token: TOKEN_B });
    assert.ok(ownGet.body['result'], 'the caller always sees its own task');
  } finally {
    await stopA2aService(service);
  }
});

test('AC2: cross-household Get/Cancel/Subscribe and session continuation are rejected', async () => {
  const service = await startAclService();
  try {
    const { taskId, contextId } = await createTask(service, TOKEN_A, 'msg-alpha-1');

    const get = await rpc(service.base, 1, 'GetTask', { id: taskId }, { token: TOKEN_B });
    assert.equal(errorOf(get.body)?.['code'], -32001, 'cross-household GetTask → TaskNotFound');
    const cancel = await rpc(service.base, 2, 'CancelTask', { id: taskId }, { token: TOKEN_B });
    assert.equal(errorOf(cancel.body)?.['code'], -32001, 'cross-household CancelTask → TaskNotFound');
    const subscribe = await rpc(service.base, 3, 'SubscribeToTask', { id: taskId }, { token: TOKEN_B });
    assert.equal(errorOf(subscribe.body)?.['code'], -32001, 'cross-household SubscribeToTask → TaskNotFound');

    // Session continuation with the foreign contextId → invalid params, no task.
    const continuation = await rpc(service.base, 4, 'SendStreamingMessage', {
      message: {
        messageId: 'msg-beta-continue',
        role: 'ROLE_USER',
        parts: [{ text: '续接' }],
        contextId,
      },
    }, { token: TOKEN_B });
    const continuationError = errorOf(continuation.body);
    assert.equal(continuationError?.['code'], -32602, 'foreign context continuation → -32602');
    const data = continuationError?.['data'] as { reason?: string }[] | undefined;
    assert.equal(data?.[0]?.reason, 'CONTEXT_ACCESS_DENIED');
    // No task was created for the forged continuation.
    const listed = await rpc(service.base, 5, 'ListTasks', {}, { token: TOKEN_B });
    assert.equal(((listed.body['result'] as { tasks: unknown[] }).tasks).length, 0,
      'the denied continuation must not have created a task');

    // The audit log records the real reasons.
    const denies = service.identity.auditEntries(100).filter(
      (entry) => entry.decision === 'deny' &&
        (entry.action === 'task_access' || entry.action === 'context_access'),
    );
    assert.ok(denies.length >= 4, 'Get/Cancel/Subscribe/continuation denials are audited');
    assert.ok(denies.every((entry) => entry.contextId !== null || entry.taskId !== null));
  } finally {
    await stopA2aService(service);
  }
});

test('AC2: same-household cross-user task access and continuation are rejected', async () => {
  const service = await startAclService();
  try {
    const { taskId, contextId } = await createTask(service, TOKEN_A, 'msg-alpha-2');
    const get = await rpc(service.base, 1, 'GetTask', { id: taskId }, { token: TOKEN_A_CHILD });
    assert.equal(errorOf(get.body)?.['code'], -32001, 'same-household sibling cannot Get the task');
    const cancel = await rpc(service.base, 2, 'CancelTask', { id: taskId }, { token: TOKEN_A_CHILD });
    assert.equal(errorOf(cancel.body)?.['code'], -32001, 'same-household sibling cannot Cancel');
    const continuation = await rpc(service.base, 3, 'SendMessage', {
      message: {
        messageId: 'msg-child-continue',
        role: 'ROLE_USER',
        parts: [{ text: '续接' }],
        contextId,
      },
    }, { token: TOKEN_A_CHILD });
    assert.equal(errorOf(continuation.body)?.['code'], -32602,
      'private conversation continuation is principal-bound');
  } finally {
    await stopA2aService(service);
  }
});

test('AC2: ListTasks is filtered to the caller\'s own authorized tasks', async () => {
  const service = await startAclService();
  try {
    await createTask(service, TOKEN_A, 'msg-list-1');
    await createTask(service, TOKEN_A, 'msg-list-2');
    const mine = await rpc(service.base, 1, 'ListTasks', {}, { token: TOKEN_A });
    const mineTasks = (mine.body['result'] as { tasks: { id: string }[] }).tasks;
    assert.equal(mineTasks.length, 2);

    const theirs = await rpc(service.base, 2, 'ListTasks', {}, { token: TOKEN_B });
    assert.equal(((theirs.body['result'] as { tasks: unknown[] }).tasks).length, 0,
      'another household never sees foreign tasks');
    const siblings = await rpc(service.base, 3, 'ListTasks', {}, { token: TOKEN_A_CHILD });
    assert.equal(((siblings.body['result'] as { tasks: unknown[] }).tasks).length, 0,
      'same-household siblings do not see private tasks either');
  } finally {
    await stopA2aService(service);
  }
});

test('AC3: revoking a credential closes its live SSE stream and denies the next request immediately', async () => {
  const service = await startAclService();
  try {
    // Parked streaming task: the SSE flow stays open until canceled.
    const stream = await fetch(`${service.base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0', authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendStreamingMessage',
        params: {
          message: {
            messageId: 'msg-stream-revoke',
            role: 'ROLE_USER',
            parts: [{ text: '请取消我' }],
            metadata: { lumithinkScenario: 'cancel-test' },
          },
        },
      }),
    });
    const reader = stream.body!.getReader();
    // First frame carries the Task; then the stream parks.
    await reader.read();

    assert.equal(service.identity.revokeCredential('cred-a'), true);
    // The live stream must terminate promptly (撤权对已有流及时生效).
    const tail = await reader.read().then(
      (result) => result,
      () => ({ done: true, value: undefined }),
    );
    assert.equal(tail.done, true, 'the revoked principal\'s SSE stream is closed');

    // The next request with the same token is denied immediately (cache killed).
    const next = await rpc(service.base, 2, 'GetTask', { id: 'anything' }, { token: TOKEN_A });
    assert.equal(next.status, 401);
    assert.equal((errorOf(next.body)?.['data'] as { reason?: string }[])?.[0]?.reason,
      'AUTHENTICATION_REQUIRED');
    // And the revocation itself is audited.
    assert.ok(
      service.identity.auditEntries(100).some(
        (entry) => entry.action === 'revoke_credential' && entry.credentialId === 'cred-a',
      ),
    );
  } finally {
    await stopA2aService(service);
  }
});

test('AC3: membership revocation ends the principal\'s stream and returns 403 PERMISSION_DENIED', async () => {
  const service = await startAclService();
  try {
    const stream = await fetch(`${service.base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0', authorization: `Bearer ${TOKEN_A_CHILD}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendStreamingMessage',
        params: {
          message: {
            messageId: 'msg-stream-member',
            role: 'ROLE_USER',
            parts: [{ text: '请取消我' }],
            metadata: { lumithinkScenario: 'cancel-test' },
          },
        },
      }),
    });
    const reader = stream.body!.getReader();
    await reader.read();

    assert.equal(service.identity.revokeMembership('hh-alpha', 'child-a'), true);
    const tail = await reader.read().then(
      (result) => result,
      () => ({ done: true, value: undefined }),
    );
    assert.equal(tail.done, true, 'membership revocation closes the principal\'s live stream');

    // The client credential still authenticates, but the principal is gone → 403.
    const next = await rpc(service.base, 2, 'GetTask', { id: 'anything' }, { token: TOKEN_A_CHILD });
    assert.equal(next.status, 403);
    assert.equal((errorOf(next.body)?.['data'] as { reason?: string }[])?.[0]?.reason,
      'PERMISSION_DENIED');
    assert.match(errorOf(next.body)?.['message'] as string, /membership/i);
  } finally {
    await stopA2aService(service);
  }
});

test('AC4: device credential authenticates the household only; grants elevate; candidates stay device-bound', async () => {
  const service = await startAclService();
  try {
    // 1. No grant → visitor task, household-scoped, principalless.
    const visitorTask = await createTask(service, DEVICE_TOKEN, 'msg-device-1');
    const visitorBinding = service.identity.store.taskBinding(visitorTask.taskId);
    assert.equal(visitorBinding?.householdId, 'hh-alpha', 'the device authenticates the household');
    assert.equal(visitorBinding?.principalUserId, null, 'no verified principal');

    // 2. Session-verified grant elevates to the confirmed user.
    const verifiedTask = await createTask(service, DEVICE_TOKEN, 'msg-device-2', undefined, { 'x-lumithink-session-grant': 'grant-session', 'x-lumithink-session-binding': 'conn-gen-1' });
    const verifiedBinding = service.identity.store.taskBinding(verifiedTask.taskId);
    assert.equal(verifiedBinding?.principalUserId, 'guardian-a');
    // The SAME verified user can read that device task from the DSH profile.
    const ownRead = await rpc(service.base, 1, 'GetTask', { id: verifiedTask.taskId }, { token: TOKEN_A });
    assert.ok(ownRead.body['result'], 'the confirmed user keeps access across their credentials');

    // 3. Voiceprint candidate: device-level conversation only; the verified
    //    guardian cannot take it over.
    const candidateTask = await createTask(service, DEVICE_TOKEN, 'msg-device-3', undefined, { 'x-lumithink-session-grant': 'grant-candidate', 'x-lumithink-session-binding': 'conn-gen-1' });
    const candidateBinding = service.identity.store.taskBinding(candidateTask.taskId);
    assert.equal(candidateBinding?.principalUserId, 'child-a', 'the candidate is recorded, never promoted');
    const guardianRead = await rpc(service.base, 2, 'GetTask', { id: candidateTask.taskId }, { token: TOKEN_A });
    assert.equal(errorOf(guardianRead.body)?.['code'], -32001,
      'candidate conversations are not readable by the verified guardian');

    // 4. Grant negatives: unknown grant id, revoked grant.
    const unknownGrant = await createTaskExpectDenied(service, DEVICE_TOKEN, 'msg-device-4', 'grant-ghost');
    assert.equal(unknownGrant, 403);
    assert.equal(service.identity.revokeGrant('grant-session'), true);
    const revokedGrant = await createTaskExpectDenied(service, DEVICE_TOKEN, 'msg-device-5', 'grant-session');
    assert.equal(revokedGrant, 403);
    assert.equal(
      (service.identity.auditEntries(100).find((e) => e.reason === 'grant_revoked')) !== undefined,
      true,
    );
  } finally {
    await stopA2aService(service);
  }
});

async function createTaskExpectDenied(
  service: StartedA2aService,
  token: string,
  messageId: string,
  grantId: string,
): Promise<number> {
  const { status } = await rpc(service.base, `denied-${messageId}`, 'SendMessage', {
    message: { messageId, role: 'ROLE_USER', parts: [{ text: '你好' }] },
  }, { token, extraHeaders: { 'x-lumithink-session-grant': grantId, 'x-lumithink-session-binding': 'conn-gen-1' } });
  return status;
}

test('expired session grants are rejected (AC 4 期限负例)', async () => {
  const bootstrap = aclBootstrap();
  bootstrap.grants = [
    ...bootstrap.grants,
    {
      grantId: 'grant-expiring',
      clientId: 'xiaozhi-dev-1',
      householdId: 'hh-alpha',
      kind: 'session_verified',
      userId: 'guardian-a',
      sessionBinding: 'conn-gen-1',
      scope: ['chat.general'],
      expiresAtMs: Date.now() + 60,
    },
  ];
  const service = await startA2aService({
    config: testConfig(),
    executor: new SyntheticExecutor(),
    identityBootstrap: bootstrap,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const { status } = await rpc(service.base, 1, 'SendMessage', {
      message: { messageId: 'msg-expired-grant', role: 'ROLE_USER', parts: [{ text: '你好' }] },
    }, { token: DEVICE_TOKEN, extraHeaders: { 'x-lumithink-session-grant': 'grant-expiring', 'x-lumithink-session-binding': 'conn-gen-1' } });
    assert.equal(status, 403, 'an expired grant never elevates');
  } finally {
    await stopA2aService(service);
  }
});

test('executor admission gate: mid-execution revocation settles CANCELED without further chunks (工具提交)', async () => {
  // Unit-level proof with a stub event bus: the identity gate is consulted
  // before the first output transition and before each further chunk; a
  // denial stops chunk emission and settles the task CANCELED
  // (working → canceled is a legal transition).
  const events: AgentExecutionEvent[] = [];
  const bus = { publish: (event: AgentExecutionEvent) => events.push(event) } as unknown as ExecutionEventBus;
  const requestContext = {
    taskId: 'task-gate',
    contextId: 'ctx-gate',
    userMessage: userMessage('msg-gate', '你好'),
  } as unknown as RequestContext;

  // Allow the FIRST admission (working + chunk-1 go out), deny the second
  // (revocation landed mid-execution).
  let calls = 0;
  const gate = (): { allowed: boolean; reason?: string } =>
    ++calls <= 1 ? { allowed: true } : { allowed: false, reason: 'principal_membership_revoked' };
  const executor = new SyntheticExecutor({ authorizationGate: gate });

  await executor.execute(requestContext, bus);
  const kinds = events.map((event) => event.kind);
  assert.equal(events.filter((event) => event.kind === 'artifactUpdate').length, 1,
    'exactly the first chunk was admitted before revocation');
  assert.ok(kinds.includes('statusUpdate'), 'status transitions published');
  const canceled = events.find(
    (event) => event.kind === 'statusUpdate' &&
      (event as { data?: { status?: { state?: TaskState } } }).data?.status?.state ===
        TaskState.TASK_STATE_CANCELED,
  );
  assert.ok(canceled, 'the task settles CANCELED when admission is denied');
  assert.equal(events.some((event) => event.kind === 'statusUpdate' &&
    (event as { data?: { status?: { state?: TaskState } } }).data?.status?.state ===
      TaskState.TASK_STATE_COMPLETED),
    false, 'no COMPLETED after revocation');
});

test('default bootstrap keeps the P1-01 single-token contract working (validation harness)', async () => {
  const service = await startA2aService({ config: testConfig(), executor: new SyntheticExecutor() });
  try {
    const { taskId } = await createTask(service, testConfig().bearerToken, 'msg-default-bootstrap');
    const binding = service.identity.store.taskBinding(taskId);
    assert.equal(binding?.householdId, 'hh-synthetic-01');
    assert.equal(binding?.principalUserId, 'user-guardian-synthetic');
    // Unknown tokens still fail with the P1-01 wire shape.
    const bad = await rpc(service.base, 1, 'GetTask', { id: taskId }, { token: 'wrong-token-0123456789abcdef' });
    assert.equal(bad.status, 401);
    assert.equal((errorOf(bad.body)?.['data'] as { reason?: string }[])?.[0]?.reason,
      'AUTHENTICATION_REQUIRED');
  } finally {
    await stopA2aService(service);
  }
});
