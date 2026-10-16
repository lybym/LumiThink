/**
 * E2E-03 (issue #53) — the REAL DSH runtime's model route goes through the
 * Model Gateway egress proxy.
 *
 * Every scenario boots a genuine `dsh-v0.2.0-rc.2` worker (profile
 * `lumi-dsh-runtime-bridge`) whose llm adapter is pointed at the host-side
 * loopback `GatewayEgressProxy`; the proxy serves every request through the
 * Model Gateway, whose `http_messages` provider talks to a LOOPBACK synthetic
 * vendor (never a public endpoint — CI stays all-mock, issue #53 DoD 3).
 *
 * Proven here, end to end with the real runtime:
 *  - three completed rounds with streamed deltas, real gateway accounting
 *    (tokens/cost/model/duration in the gateway audit, DoD 1 shape);
 *  - the child keeps ONLY its synthetic placeholder credential — the vendor
 *    credential is injected host-side by the gateway keySource and never
 *    enters the worker (issue #53 实施范围 1);
 *  - provider auth failure degrades the turn FAILED with an auditable
 *    GATEWAY_AUTH_FAILED and no key material anywhere (DoD 2);
 *  - budget exhaustion refuses BEFORE the vendor and fails the turn (DoD 2);
 *  - a mid-stream barge-in cancel propagates to the gateway as an auditable
 *    caller cancellation (DoD 2).
 *
 * PRIVACY: every prompt is a synthetic sample with explicit `E2E03` markers.
 */
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'

import { canSpawnPipedChild } from '../../src/dump-config.ts'
import { MockMessagesServer, SYNTHETIC_API_KEY } from '../../src/mock-model.ts'
import {
  PIPED_CHILD_UNAVAILABLE,
  startBridgeFixture,
  submitAndAwaitCompletion,
  submitSynthetic,
  waitFor,
  waitForTerminalTurn,
  type BridgeFixture,
} from './helpers.ts'
import { createGatewayEgressProxy, type GatewayEgressProxy } from '../../../../lib/server/gateway-egress-proxy.ts'
import {
  createHttpMessagesProvider,
  createModelGateway,
  parseModelGatewayConfig,
  type ModelGateway,
} from '../../../../lib/domain/gateway/index.ts'

const pipedOk = await canSpawnPipedChild()

/** The host-side vendor credential of the test gateway (never in the child). */
const TEST_VENDOR_KEY = 'e2e03-host-injected-vendor-key'

const MODEL_ID = 'deepseek-v4-flash'

interface GatewayFixture {
  readonly fixture: BridgeFixture
  readonly gateway: ModelGateway
  readonly proxy: GatewayEgressProxy
  readonly vendorRequests: () => number
  dispose(): Promise<void>
}

async function startGatewayFixture(options: {
  vendor: { readonly baseUrl: string; readonly requestCount: () => number }
  budget?: { maxRequestsPerDay: number; maxCostMicroUsdPerDay: number; maxTotalTokensPerDay: number }
  fixtureScript?: Parameters<typeof startBridgeFixture>[0]['script']
}): Promise<GatewayFixture> {
  const provider = createHttpMessagesProvider({
    providerId: 'gateway-vendor',
    baseURL: options.vendor.baseUrl,
    keySource: () => TEST_VENDOR_KEY,
    dataEgressReview: {
      acknowledgeDataEgressReview: true,
      reviewer: 'e2e03-loopback-suite',
      reason: 'loopback synthetic vendor for the E2E-03 acceptance suite (issue #53)',
    },
  })
  const gateway = createModelGateway(
    parseModelGatewayConfig({
      gatewayVersion: '1.0',
      models: [
        {
          modelId: MODEL_ID,
          providerId: 'gateway-vendor',
          maxOutputTokens: 2048,
          pricing: { inputMicroUsdPerMillionTokens: 1000, outputMicroUsdPerMillionTokens: 2000 },
        },
      ],
      budget: options.budget ?? { maxRequestsPerDay: 10_000, maxCostMicroUsdPerDay: 1_000_000_000, maxTotalTokensPerDay: 1_000_000_000 },
      retry: { maxAttempts: 1, backoffBaseMs: 1 },
      breaker: { failureThreshold: 50, cooldownMs: 1000 },
      requestTimeoutMs: 60_000,
    }),
    [provider],
  )
  const proxy = createGatewayEgressProxy({ gateway, allowedModelIds: [MODEL_ID] })
  const started = await proxy.start()
  const fixture = await startBridgeFixture({
    script: options.fixtureScript ?? {},
    workerEnv: { DSH_BRIDGE_MODEL_BASE_URL: started.url },
  })
  return {
    fixture,
    gateway,
    proxy,
    vendorRequests: options.vendor.requestCount,
    async dispose() {
      await fixture.dispose()
      await proxy.stop().catch(() => undefined)
    },
  }
}

/** A loopback vendor that always answers 401 (credential rejection stand-in). */
async function startAuthRejectingVendor(): Promise<{ server: Server; baseUrl: string; requestCount: () => number }> {
  let requests = 0
  const server: Server = createServer((req, res) => {
    void req
    requests += 1
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'synthetic vendor rejects the credential' } }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no vendor port')
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, requestCount: () => requests }
}

describe('E2E-03 real DSH runtime through the Model Gateway egress proxy', { skip: pipedOk ? false : PIPED_CHILD_UNAVAILABLE }, () => {
  let fixture: GatewayFixture | undefined
  let vendor: MockMessagesServer | Server | undefined

  afterEach(async () => {
    await fixture?.dispose()
    fixture = undefined
    const closingVendor = vendor
    vendor = undefined
    if (closingVendor !== undefined) {
      if (closingVendor instanceof MockMessagesServer) {
        await closingVendor.close().catch(() => undefined)
      } else {
        await new Promise<void>((resolve) => closingVendor.close(() => resolve()))
      }
    }
  })

  it('completes three real rounds with streamed deltas and verifiable gateway accounting', async () => {
    const mock = new MockMessagesServer({
      fixedTurnTexts: [
        'E2E03 第一轮。经网关的合成回复一。经网关的合成回复二！',
        'E2E03 第二轮。经网关的合成回复三。经网关的合成回复四？',
        'E2E03 第三轮。经网关的合成回复五。经网关的合成回复六；',
      ],
      streamChunkDelayMs: 20,
    })
    vendor = mock
    const vendorBaseUrl = await mock.listen()
    fixture = await startGatewayFixture({
      vendor: { baseUrl: vendorBaseUrl, requestCount: () => mock.requestRecords.length },
      fixtureScript: { streamChunkDelayMs: 10 },
    })
    const { fixture: stack, gateway, proxy } = fixture
    const sessionKey = stack.sessionKey
    const opened = await stack.stack.openSession({
      sessionKey,
      conversationId: 'conv_e2e03gateway01',
      ownerActorId: 'act_e2e03parent01',
    })
    assert.equal(opened.ok, true, `session.open refused: ${JSON.stringify(opened)}`)

    for (const round of [1, 2, 3]) {
      await submitAndAwaitCompletion(
        stack.stack,
        sessionKey,
        `E2E03-PROMPT-R${round} 合成转写（经模型网关）。`,
        60_000,
        stack.forensics,
      )
    }
    // Live-delta proof on the last round's frames: text deltas crossed the
    // proxy while the turn streamed.
    const deltaFrames = stack.frames.filter((frame) => frame.name === 'assistant.delta')
    assert.ok(deltaFrames.length >= 3, `expected streamed deltas through the proxy, got ${deltaFrames.length}`)

    // Gateway accounting (DoD 1 shape): real request count, tokens, cost,
    // model and duration — all from the gateway audit, not the child.
    const completed = gateway.auditTrail().filter((event) => event.type === 'turn.completed')
    assert.ok(completed.length >= 3, `expected >=3 turn.completed audit events, got ${completed.length}`)
    for (const event of completed) {
      assert.equal(event.modelId, MODEL_ID)
      assert.equal(event.providerId, 'gateway-vendor')
      assert.ok(event.inputTokens >= 0 && event.outputTokens >= 0)
      assert.ok(event.durationMs >= 0)
    }
    assert.ok(proxy.stats().completed >= 3, `proxy completed ${JSON.stringify(proxy.stats())}`)

    // Credential boundary: the worker keeps ONLY the synthetic placeholder;
    // the vendor credential was injected host-side and reached the vendor —
    // never the child.
    assert.equal(stack.childEnv.DEEPSEEK_API_KEY, SYNTHETIC_API_KEY)
    assert.ok(mock.requestRecords.length >= 3, `vendor saw ${mock.requestRecords.length} requests`)
    for (const record of mock.requestRecords) {
      assert.equal(record.path.endsWith('/v1/messages'), true)
      assert.equal(record.apiKeyHeader, 'present (non-synthetic)', 'the vendor must see the host-injected credential, not the child placeholder')
    }
  })

  it('degrades a vendor auth failure FAILED with an auditable GATEWAY_AUTH_FAILED and no key echo', async () => {
    const rejecting = await startAuthRejectingVendor()
    vendor = rejecting.server
    fixture = await startGatewayFixture({
      vendor: { baseUrl: rejecting.baseUrl, requestCount: rejecting.requestCount },
    })
    const { fixture: stack, gateway, proxy } = fixture
    const sessionKey = stack.sessionKey
    const opened = await stack.stack.openSession({
      sessionKey,
      conversationId: 'conv_e2e03auth01',
      ownerActorId: 'act_e2e03parent01',
    })
    assert.equal(opened.ok, true)

    const submitted = await submitSynthetic(stack.stack, sessionKey, 'E2E03-PROMPT-AUTH 合成转写。')
    assert.equal(submitted.ok, true)
    if (!submitted.ok) throw new Error('unreachable')
    const state = await waitForTerminalTurn(stack.stack, sessionKey, submitted.turnId, 60_000, stack.forensics)
    assert.equal(state, 'FAILED', `a vendor 401 must fail the turn closed, got ${state}`)

    const failed = gateway.auditTrail().filter((event) => event.type === 'attempt.failed')
    assert.ok(failed.length >= 1, 'the gateway must audit the failed attempt')
    for (const event of failed) {
      assert.equal(event.code, 'GATEWAY_AUTH_FAILED')
    }
    assert.ok(proxy.stats().failed >= 1)
    assert.ok(rejecting.requestCount() >= 1, 'the vendor was contacted once with the host credential')
    // Zero key echo in the only diagnostic surface the worker exposes.
    const stderrTail = stack.port.stderrTailSnapshot(sessionKey)
    assert.ok(!stderrTail.includes(TEST_VENDOR_KEY), 'the vendor key must never appear in worker diagnostics')
    assert.ok(!stderrTail.includes(SYNTHETIC_API_KEY), 'the child placeholder must never echo into diagnostics')
  })

  it('refuses turns beyond the daily budget BEFORE the vendor and fails them closed', async () => {
    const mock = new MockMessagesServer({ fixedTurnTexts: ['E2E03 预算内回合。合成回复。'] })
    vendor = mock
    const vendorBaseUrl = await mock.listen()
    fixture = await startGatewayFixture({
      vendor: { baseUrl: vendorBaseUrl, requestCount: () => mock.requestRecords.length },
      budget: { maxRequestsPerDay: 1, maxCostMicroUsdPerDay: 1_000_000_000, maxTotalTokensPerDay: 1_000_000_000 },
    })
    const { fixture: stack, gateway, proxy } = fixture
    const sessionKey = stack.sessionKey
    const opened = await stack.stack.openSession({
      sessionKey,
      conversationId: 'conv_e2e03budget01',
      ownerActorId: 'act_e2e03parent01',
    })
    assert.equal(opened.ok, true)

    const first = await submitSynthetic(stack.stack, sessionKey, 'E2E03-PROMPT-B1 合成转写。')
    assert.equal(first.ok, true)
    if (!first.ok) throw new Error('unreachable')
    await waitForTerminalTurn(stack.stack, sessionKey, first.turnId, 60_000, stack.forensics)

    const vendorCountBefore = mock.requestRecords.length
    const second = await submitSynthetic(stack.stack, sessionKey, 'E2E03-PROMPT-B2 合成转写。')
    assert.equal(second.ok, true)
    if (!second.ok) throw new Error('unreachable')
    const secondState = await waitForTerminalTurn(stack.stack, sessionKey, second.turnId, 60_000, stack.forensics)
    assert.equal(secondState, 'FAILED', 'a budget-exhausted turn must fail closed')
    assert.equal(mock.requestRecords.length, vendorCountBefore, 'the vendor must NOT be contacted once the budget is exhausted')
    assert.ok(gateway.auditTrail().some((event) => event.type === 'budget.rejected'), 'the pre-contact rejection must be audited')
    assert.ok(proxy.stats().rejected >= 1, `proxy stats: ${JSON.stringify(proxy.stats())}`)
  })

  it('propagates a mid-stream barge-in cancel to the gateway as an auditable caller cancellation', async () => {
    const mock = new MockMessagesServer({
      fixedTurnTexts: ['E2E03 取消回合。合成回复句一。合成回复句二。合成回复句三。合成回复句四。合成回复句五。合成回复句六。合成回复句七。合成回复句八！'],
      streamChunkDelayMs: 60,
    })
    vendor = mock
    const vendorBaseUrl = await mock.listen()
    fixture = await startGatewayFixture({
      vendor: { baseUrl: vendorBaseUrl, requestCount: () => mock.requestRecords.length },
      fixtureScript: { streamChunkDelayMs: 30 },
    })
    const { fixture: stack, gateway, proxy } = fixture
    const sessionKey = stack.sessionKey
    const opened = await stack.stack.openSession({
      sessionKey,
      conversationId: 'conv_e2e03cancel01',
      ownerActorId: 'act_e2e03parent01',
    })
    assert.equal(opened.ok, true)

    const submitted = await submitSynthetic(stack.stack, sessionKey, 'E2E03-PROMPT-C1 合成转写。')
    assert.equal(submitted.ok, true)
    if (!submitted.ok) throw new Error('unreachable')
    await waitFor(
      'first streamed delta through the proxy',
      () => stack.frames.some((frame) => frame.name === 'assistant.delta'),
      60_000,
      25,
      stack.forensics,
    )
    const cancelled = await stack.stack.bargeInCancel({
      sessionKey,
      turnId: submitted.turnId,
      reason: 'barge_in',
    })
    assert.equal(cancelled.ok, true, `barge-in refused: ${JSON.stringify(cancelled)}`)
    const state = await waitForTerminalTurn(stack.stack, sessionKey, submitted.turnId, 60_000, stack.forensics)
    assert.equal(state, 'CANCELLED', `the interrupted turn must settle CANCELLED, got ${state}`)
    await waitFor(
      'the gateway to record the caller cancellation',
      () => gateway.auditTrail().some((event) => event.type === 'attempt.cancelled' && event.by === 'caller'),
      30_000,
      25,
    )
    assert.ok(proxy.stats().cancelled >= 1, `proxy stats: ${JSON.stringify(proxy.stats())}`)
  })
})
