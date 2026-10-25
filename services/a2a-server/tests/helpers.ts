/**
 * Shared test helpers for the LumiThink A2A validation service specs
 * (P1-01, issue #83). Everything is loopback + synthetic.
 */
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { Role } from '@a2a-js/sdk';
import type { Message, Part } from '@a2a-js/sdk';
import { startA2aService, stopA2aService, type StartedA2aService } from '../src/a2a-service.ts';
import { type A2aServiceConfig } from '../src/config.ts';
import { SyntheticExecutor } from '../src/synthetic-executor.ts';
import type { TaskStore } from '../src/task-manager-port.ts';

export const TEST_TOKEN = 'synthetic-validation-token-0123456789abcdef';

export function testConfig(overrides: Partial<A2aServiceConfig> = {}): A2aServiceConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    bearerToken: TEST_TOKEN,
    supportedVersions: ['1.0'],
    dbPath: ':memory:',
    identityDbPath: ':memory:',
    ...overrides,
  };
}

export interface StartedTest extends StartedA2aService {
  executor: SyntheticExecutor;
}

/**
 * Starts a test service. Pass `taskStore` to observe the single-store wiring
 * (the SDK handler must be the ONLY writer through that instance).
 * Pass `identityBootstrap` to provision a custom synthetic directory
 * (P1-03): households/users/memberships/relationships/clients/credentials/
 * grants.
 */
export async function startTest(options: {
  taskStore?: TaskStore;
  configOverrides?: Partial<A2aServiceConfig>;
  identityBootstrap?: import('../src/identity/identity-store.ts').IdentityBootstrap;
} = {}): Promise<StartedTest> {
  const service = await startA2aService({
    config: testConfig(options.configOverrides),
    taskStore: options.taskStore,
    executor: new SyntheticExecutor(),
    identityBootstrap: options.identityBootstrap,
  });
  return service as StartedTest;
}

export { stopA2aService };

/**
 * Builds a fully-typed SDK runtime Message (proto-generated types require
 * every field). Role/Part use the SDK runtime shapes (numeric Role enum,
 * `$case` Part oneof) exactly like the production executor.
 */
export function userMessage(
  messageId: string,
  text: string,
  metadata?: Record<string, unknown>,
): Message {
  const part: Part = {
    content: { $case: 'text', value: text },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  };
  return {
    messageId,
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: [part],
    metadata: metadata ?? undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

export function rpcHeaders(options: { token?: string | null; version?: string | null } = {}): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== null) headers['authorization'] = `Bearer ${options.token ?? TEST_TOKEN}`;
  if (options.version !== null) headers['a2a-version'] = options.version ?? '1.0';
  return headers;
}

export async function rpcPost(
  base: string,
  body: unknown,
  options: { token?: string | null; version?: string | null } = {},
): Promise<Response> {
  return fetch(`${base}/`, { method: 'POST', headers: rpcHeaders(options), body: JSON.stringify(body) });
}

export async function rpcResultOf(
  base: string,
  id: number | string,
  method: string,
  params: unknown,
  options: { token?: string | null; version?: string | null } = {},
): Promise<{ httpStatus: number; body: Record<string, unknown> }> {
  const res = await rpcPost(base, { jsonrpc: '2.0', id, method, params }, options);
  return { httpStatus: res.status, body: (await res.json()) as Record<string, unknown> };
}

export async function rpcErrorOf(
  base: string,
  id: number | string,
  method: string,
  params: unknown,
  options: { token?: string | null; version?: string | null } = {},
): Promise<{ httpStatus: number; error: Record<string, unknown> | null }> {
  const { httpStatus, body } = await rpcResultOf(base, id, method, params, options);
  return { httpStatus, error: (body['error'] as Record<string, unknown> | undefined) ?? null };
}

/** Official SDK client with an auth-injecting recording fetch implementation. */
export async function officialClient(base: string, token: string | null = TEST_TOKEN): Promise<{
  client: Awaited<ReturnType<ClientFactory['createFromUrl']>>;
  requests: { method: string; url: string; headers: Record<string, string> }[];
}> {
  const requests: { method: string; url: string; headers: Record<string, string> }[] = [];
  const recordingFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    if (token !== null) headers.set('authorization', `Bearer ${token}`);
    requests.push({ method: init?.method ?? 'GET', url: String(input), headers: Object.fromEntries(headers.entries()) });
    return fetch(input, { ...init, headers });
  };
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl: recordingFetch })],
    cardResolver: new DefaultAgentCardResolver({ fetchImpl: recordingFetch }),
  });
  const client = await factory.createFromUrl(base);
  return { client, requests };
}

/** Reads SSE frames from a raw streaming response. */
export async function readSseFrames(res: Response): Promise<Record<string, unknown>[]> {
  const raw = await res.text();
  return raw
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data:'))
    .map((chunk) => JSON.parse(chunk.slice('data:'.length).trim()) as Record<string, unknown>);
}

export type { Message, Part };
