/**
 * E2E-03 (issue #53) gateway egress proxy tests.
 *
 * Proves the loopback proxy is a pure gateway front (issue #53 实施范围 2,
 * DoD 2/3): every accepted request becomes exactly one ModelGateway request
 * (budget/retry/breaker/timeout/cancel/audit preserved, single-provider
 * routing), every rejection is static and value-free (no key echo, no prompt
 * echo), client disconnects cancel auditably, and the proxy cannot bind
 * beyond loopback. All "vendor" endpoints in this suite are loopback
 * synthetic servers — CI stays all-mock (DoD 3).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";

import {
  createGatewayEgressProxy,
  GATEWAY_EGRESS_PROXY_DEFAULT_TOKEN,
  type GatewayEgressProxy,
} from "../../lib/server/gateway-egress-proxy.ts";
import {
  createModelGateway,
  createMockModelProvider,
  createHttpMessagesProvider,
  parseModelGatewayConfig,
} from "../../lib/domain/gateway/index.ts";
import { gateProviderEgress } from "../../lib/server/provider-egress-gate.ts";

const MODEL_ID = "deepseek-v4-flash";
const DIRTY_KEY = "sk-dirty-vendor-key-e2e03";
const DIRTY_PROMPT = "DIRTY-PROMPT-MARKER-e2e03";

function mockGatewayConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayVersion: "1.0",
    models: [{ modelId: MODEL_ID, providerId: "mock", maxOutputTokens: 512, pricing: { inputMicroUsdPerMillionTokens: 1000, outputMicroUsdPerMillionTokens: 2000 } }],
    budget: { maxRequestsPerDay: 1000, maxCostMicroUsdPerDay: 1_000_000_000, maxTotalTokensPerDay: 1_000_000_000 },
    retry: { maxAttempts: 1, backoffBaseMs: 1 },
    breaker: { failureThreshold: 50, cooldownMs: 1000 },
    requestTimeoutMs: 30_000,
    ...overrides,
  };
}

function mockBackedGateway(script?: Parameters<typeof createMockModelProvider>[0]["script"]) {
  const provider = createMockModelProvider({ providerId: "mock", ...(script !== undefined ? { script } : {}) });
  const gateway = createModelGateway(
    parseModelGatewayConfig(mockGatewayConfig()),
    [provider],
  );
  return { gateway, provider };
}

/** Gateway config whose single model is bound to the given provider id. */
function gatewayFor(provider: ModelProviderLike): ReturnType<typeof createModelGateway> {
  const providerId = provider.providerId;
  return createModelGateway(
    parseModelGatewayConfig(
      mockGatewayConfig({
        models: [{ modelId: MODEL_ID, providerId, maxOutputTokens: 512, pricing: { inputMicroUsdPerMillionTokens: 1000, outputMicroUsdPerMillionTokens: 2000 } }],
      }),
    ),
    [provider],
  );
}

type ModelProviderLike = Parameters<typeof createModelGateway>[1][number];

function turnPayload(model: string = MODEL_ID): Record<string, unknown> {
  return {
    model,
    stream: true,
    max_tokens: 256,
    system: `synthetic system prompt ${DIRTY_PROMPT}`,
    messages: [{ role: "user", content: [{ type: "text", text: `synthetic user turn ${DIRTY_PROMPT}` }] }],
  };
}

async function startProxy(gateway: Parameters<typeof createGatewayEgressProxy>[0]["gateway"], extra: Partial<Parameters<typeof createGatewayEgressProxy>[0]> = {}): Promise<{ proxy: GatewayEgressProxy; url: string }> {
  const proxy = createGatewayEgressProxy({ gateway, allowedModelIds: [MODEL_ID], ...extra });
  const started = await proxy.start();
  return { proxy, url: started.url };
}

/** Collect one full SSE response body (until the connection closes). */
async function readFullBody(url: string, init: RequestInit): Promise<{ status: number; text: string }> {
  const response = await fetch(`${url}/v1/messages`, init);
  const text = await response.text();
  return { status: response.status, text };
}

test("the proxy refuses to bind beyond loopback", () => {
  assert.throws(
    () => createGatewayEgressProxy({ gateway: mockBackedGateway().gateway, allowedModelIds: [MODEL_ID], host: "0.0.0.0" }),
    /loopback/,
  );
});

test("three sequential turns stream complete Messages frames through the gateway (DoD 1 shape)", async () => {
  const { gateway, provider } = mockBackedGateway();
  const { proxy, url } = await startProxy(gateway);
  try {
    for (let turn = 1; turn <= 3; turn += 1) {
      const { status, text } = await readFullBody(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": GATEWAY_EGRESS_PROXY_DEFAULT_TOKEN },
        body: JSON.stringify(turnPayload()),
      });
      assert.equal(status, 200, `turn ${turn} must complete`);
      assert.match(text, /event: message_start/);
      assert.match(text, /event: content_block_start/);
      assert.match(text, /event: content_block_delta/);
      assert.match(text, /event: content_block_stop/);
      assert.match(text, /event: message_delta/);
      assert.match(text, /event: message_stop/);
      assert.match(text, /"output_tokens":7/);
    }
    assert.equal(provider.stats().callCount, 3);
    const stats = proxy.stats();
    assert.equal(stats.requests, 3);
    assert.equal(stats.completed, 3);
    assert.equal(stats.rejected, 0);
    // The gateway audit holds the accounting evidence (DoD 1: token/cost/model verifiable).
    const completed = gateway.auditTrail().filter((event) => event.type === "turn.completed");
    assert.equal(completed.length, 3);
    for (const event of completed) {
      assert.equal(event.modelId, MODEL_ID);
      assert.equal(event.inputTokens, 3);
      assert.equal(event.outputTokens, 7);
      assert.ok(event.costMicroUsd > 0);
      assert.ok(event.durationMs >= 0);
    }
  } finally {
    await proxy.stop();
  }
});

test("bearer mismatch rejects before any gateway contact and never echoes the submitted value", async () => {
  const { gateway } = mockBackedGateway();
  const { proxy, url } = await startProxy(gateway);
  try {
    const { status, text } = await readFullBody(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "WRONG-bearer-value" },
      body: JSON.stringify(turnPayload()),
    });
    assert.equal(status, 401);
    assert.match(text, /authentication_error/);
    assert.ok(!text.includes("WRONG-bearer-value"));
    assert.equal(proxy.stats().requests, 0);
    assert.equal(proxy.stats().rejected, 1);
  } finally {
    await proxy.stop();
  }
});

test("unregistered models, invalid JSON and oversize bodies fail closed statically", async () => {
  const { gateway } = mockBackedGateway();
  const { proxy, url } = await startProxy(gateway);
  try {
    const headers = { "content-type": "application/json", "x-api-key": GATEWAY_EGRESS_PROXY_DEFAULT_TOKEN };
    const dirtyModel = "unregistered-EVIL-model-should-not-echo";
    const unregistered = await readFullBody(url, {
      method: "POST",
      headers,
      body: JSON.stringify(turnPayload(dirtyModel)),
    });
    assert.equal(unregistered.status, 400);
    assert.ok(!unregistered.text.includes(dirtyModel), "the submitted model value is never echoed");

    const badJson = await readFullBody(url, { method: "POST", headers, body: "{not json" });
    assert.equal(badJson.status, 400);

    const oversize = await readFullBody(url, {
      method: "POST",
      headers,
      body: JSON.stringify(turnPayload()) + " ".repeat(1_100_000),
    });
    assert.equal(oversize.status, 413);

    const wrongPath = await fetch(`${url}/v1/other`, { method: "POST", headers });
    assert.equal(wrongPath.status, 404);
    assert.equal(proxy.stats().requests, 0);
  } finally {
    await proxy.stop();
  }
});

test("gateway failure classes map to static statuses (401/429/timeout) without vendor bodies or key echo", async () => {
  // The "vendor" is a loopback synthetic server whose error bodies carry the
  // key and prompt dirty markers — the proxy response must carry neither.
  const vendor: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      void body;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `bad key ${DIRTY_KEY} for prompt ${DIRTY_PROMPT}` } }));
    });
  });
  await new Promise<void>((resolve) => vendor.listen(0, "127.0.0.1", resolve));
  const vendorAddress = vendor.address();
  if (vendorAddress === null || typeof vendorAddress === "string") throw new Error("no port");

  try {
    const provider = createHttpMessagesProvider({
      providerId: "http-vendor",
      baseURL: `http://127.0.0.1:${vendorAddress.port}`,
      keySource: () => DIRTY_KEY,
      dataEgressReview: { acknowledgeDataEgressReview: true, reviewer: "e2e03-spec", reason: "loopback dirty-marker vendor" },
    });
    const gateway = gatewayFor(provider);
    const { proxy, url } = await startProxy(gateway);
    try {
      const { status, text } = await readFullBody(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": GATEWAY_EGRESS_PROXY_DEFAULT_TOKEN },
        body: JSON.stringify(turnPayload()),
      });
      assert.equal(status, 401, "GATEWAY_AUTH_FAILED maps to 401");
      assert.match(text, /authentication_error/);
      assert.ok(!text.includes(DIRTY_KEY), "zero key echo (DoD 2)");
      assert.ok(!text.includes(DIRTY_PROMPT), "no prompt echo");
      assert.ok(!text.includes("bad key"), "no vendor body echo");
    } finally {
      await proxy.stop();
    }
  } finally {
    await new Promise<void>((resolve) => vendor.close(() => resolve()));
  }
});

test("rate-limited and unavailable providers map to 429/502 while the gateway keeps the audit", async () => {
  for (const [classification, expectedStatus] of [
    ["rate_limited", 429],
    ["unavailable", 502],
  ] as const) {
    const { gateway } = mockBackedGateway({ failure: { classification, times: "always" } });
    const { proxy, url } = await startProxy(gateway);
    try {
      const { status, text } = await readFullBody(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": GATEWAY_EGRESS_PROXY_DEFAULT_TOKEN },
        body: JSON.stringify(turnPayload()),
      });
      assert.equal(status, expectedStatus, `${classification} must map to ${expectedStatus}`);
      const failed = gateway.auditTrail().filter((event) => event.type === "attempt.failed");
      assert.ok(failed.length >= 1);
      assert.ok(text.includes("GATEWAY_"), "the static message names the gateway code class");
    } finally {
      await proxy.stop();
    }
  }
});

test("budget exhaustion rejects BEFORE the provider is contacted and maps to a non-retryable 400", async () => {
  const provider = createMockModelProvider({ providerId: "mock" });
  const egressGated = gateProviderEgress({
    provider,
    classification: "third_party_api",
    isThirdPartyEgressEnabled: () => true,
  });
  const gateway = createModelGateway(
    parseModelGatewayConfig(mockGatewayConfig({ budget: { maxRequestsPerDay: 1, maxCostMicroUsdPerDay: 1_000_000_000, maxTotalTokensPerDay: 1_000_000_000 } })),
    [egressGated],
  );
  const { proxy, url } = await startProxy(gateway);
  try {
    const headers = { "content-type": "application/json", "x-api-key": GATEWAY_EGRESS_PROXY_DEFAULT_TOKEN };
    const first = await readFullBody(url, { method: "POST", headers, body: JSON.stringify(turnPayload()) });
    assert.equal(first.status, 200);
    const second = await readFullBody(url, { method: "POST", headers, body: JSON.stringify(turnPayload()) });
    assert.equal(second.status, 400);
    assert.match(second.text, /GATEWAY_BUDGET_EXHAUSTED/);
    assert.equal(egressGated.requestCount(), 1, "the second request never reached the provider");
    assert.ok(gateway.auditTrail().some((event) => event.type === "budget.rejected"));
  } finally {
    await proxy.stop();
  }
});

test("a client disconnect mid-stream cancels the gateway attempt auditably and bills nothing", async () => {
  const { gateway, provider } = mockBackedGateway({
    reply: { prefix: "SLOW", chunkCount: 12, delayMsPerChunk: 120 },
  });
  const { proxy, url } = await startProxy(gateway);
  try {
    const abortController = new AbortController();
    const response = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": GATEWAY_EGRESS_PROXY_DEFAULT_TOKEN },
      body: JSON.stringify(turnPayload()),
      signal: abortController.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    assert.ok(reader !== undefined);
    // Read at least one delta, then abort the request (user stop).
    await reader.read();
    abortController.abort();
    // Poll until the proxy observes the cancellation (bounded).
    const deadline = Date.now() + 5_000;
    while (proxy.stats().cancelled === 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    const stats = proxy.stats();
    assert.equal(stats.cancelled, 1);
    assert.equal(stats.completed, 0);
    assert.ok(provider.stats().observedCancels >= 1, "the provider observed the abort");
    const audit = gateway.auditTrail();
    assert.ok(audit.some((event) => event.type === "attempt.cancelled" && event.by === "caller"));
    assert.ok(!audit.some((event) => event.type === "turn.completed"), "a cancelled turn is never billed");
  } finally {
    await proxy.stop();
  }
});

test("the registered per-attempt timeout bounds a hung provider and maps to 504", async () => {
  const provider = createMockModelProvider({
    providerId: "mock",
    script: { reply: { prefix: "HANG", chunkCount: 50, delayMsPerChunk: 5_000 } },
  });
  const gateway = createModelGateway(
    parseModelGatewayConfig(mockGatewayConfig({ requestTimeoutMs: 300 })),
    [provider],
  );
  const { proxy, url } = await startProxy(gateway);
  try {
    const { status, text } = await readFullBody(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": GATEWAY_EGRESS_PROXY_DEFAULT_TOKEN },
      body: JSON.stringify(turnPayload()),
    });
    assert.equal(status, 504);
    assert.match(text, /GATEWAY_PROVIDER_TIMEOUT/);
    assert.ok(gateway.auditTrail().some((event) => event.type === "attempt.cancelled" && event.by === "timeout"));
  } finally {
    await proxy.stop();
  }
});

test("the proxy default bearer equals the pinned child synthetic placeholder (no vendor key in the child)", () => {
  assert.equal(GATEWAY_EGRESS_PROXY_DEFAULT_TOKEN, "dsh-poc-synthetic-key");
});
