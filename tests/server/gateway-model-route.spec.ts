/**
 * E2E-08 (issue #58) — gateway-host real-model route composition tests.
 *
 * Proves the operator opt-in REAL-model route (lib/server/gateway-model-route.ts):
 * - the default route is mock (no proxy, no workerEnv override) — CI behavior
 *   is unchanged;
 * - an incomplete LUMITHINK_REAL_PROVIDER_* record fails closed BEFORE any
 *   listener exists, naming variable NAMES only (no values echoed);
 * - a complete record composes the E2E-03 chain end-to-end OFFLINE:
 *   worker-shaped POST /v1/messages → loopback egress proxy (synthetic
 *   placeholder bearer) → Model Gateway → http_messages provider (REAL vendor
 *   credential from the request-time keySource) → a loopback FAKE vendor —
 *   and the two credential hops are provably distinct (the worker never sees
 *   the vendor key; the vendor never sees the synthetic placeholder);
 * - the proxy guards hold (wrong bearer → 401, unregistered model → 400).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";

import { createGatewayModelRoute } from "../../lib/server/gateway-model-route.ts";
import { RealProviderActivationError } from "../../lib/server/real-provider-composition.ts";
import { GATEWAY_EGRESS_PROXY_DEFAULT_TOKEN } from "../../lib/server/gateway-egress-proxy.ts";

/** Complete, valid activation env for a LOOPBACK fake vendor (tests only). */
function validRealEnv(vendorPort: number, overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    LUMITHINK_MODEL_ROUTE: "real",
    LUMITHINK_REAL_PROVIDER_BASEURL: `http://127.0.0.1:${vendorPort}`,
    LUMITHINK_REAL_PROVIDER_MODEL_ID: "qwen3.8-flash",
    LUMITHINK_REAL_PROVIDER_REVIEWER: "e2e08-test-reviewer",
    LUMITHINK_REAL_PROVIDER_REVIEW_REASON: "synthetic loopback activation for issue #58 tests",
    LUMITHINK_REAL_PROVIDER_MAX_OUTPUT_TOKENS: "4096",
    LUMITHINK_REAL_PROVIDER_INPUT_MICRO_USD_PER_MTOKEN: "1000",
    LUMITHINK_REAL_PROVIDER_OUTPUT_MICRO_USD_PER_MTOKEN: "2000",
    LUMITHINK_REAL_PROVIDER_MAX_REQUESTS_PER_DAY: "1000",
    LUMITHINK_REAL_PROVIDER_MAX_COST_MICRO_USD_PER_DAY: "5000000",
    LUMITHINK_REAL_PROVIDER_MAX_TOTAL_TOKENS_PER_DAY: "1000000",
    LUMITHINK_REAL_PROVIDER_REQUEST_TIMEOUT_MS: "30000",
    LUMITHINK_REAL_PROVIDER_RETRY_MAX_ATTEMPTS: "1",
    LUMITHINK_REAL_PROVIDER_RETRY_BACKOFF_BASE_MS: "10",
    LUMITHINK_REAL_PROVIDER_BREAKER_FAILURE_THRESHOLD: "3",
    LUMITHINK_REAL_PROVIDER_BREAKER_COOLDOWN_MS: "60000",
    LUMITHINK_MODEL_PROVIDER_KEY: "sk-test-vendor-key-do-not-leak",
    ...overrides,
  };
}

test("the default route is mock: no proxy, no workerEnv override, stop is a no-op", async () => {
  for (const env of [{}, { LUMITHINK_MODEL_ROUTE: "mock" }]) {
    const route = await createGatewayModelRoute(env);
    assert.equal(route.mode, "mock");
    assert.equal(route.modelBaseUrl, null);
    assert.equal(route.proxy, null);
    assert.deepEqual(route.workerEnv, {});
    await route.stop();
  }
});

test("an incomplete real record fails closed before any listener exists, naming variables only", async () => {
  const dirtyBaseURL = "http://value-must-never-echo.example.invalid";
  await assert.rejects(
    createGatewayModelRoute({ LUMITHINK_MODEL_ROUTE: "real", LUMITHINK_REAL_PROVIDER_BASEURL: dirtyBaseURL }),
    (error: unknown) => {
      assert.ok(error instanceof RealProviderActivationError);
      const joined = error.problems.join("\n");
      assert.ok(joined.includes("LUMITHINK_REAL_PROVIDER_MODEL_ID"));
      assert.ok(joined.includes("LUMITHINK_REAL_PROVIDER_REVIEWER"));
      assert.ok(!joined.includes(dirtyBaseURL), "submitted values are never echoed");
      return true;
    },
  );
});

test("the real route composes worker→proxy→gateway→provider→vendor end-to-end with split credentials", async () => {
  // The FAKE vendor speaks the Anthropic-Messages SSE wire shape the pinned
  // http_messages provider consumes, and records the credential it saw.
  let vendorSawApiKey = "";
  let vendorModel = "";
  const vendor: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      vendorSawApiKey = String(req.headers["x-api-key"] ?? "");
      const parsed = JSON.parse(body) as { model?: string };
      vendorModel = parsed.model ?? "";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_v", type: "message", role: "assistant", model: vendorModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 0 } } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "合成回答" } })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((resolve) => vendor.listen(0, "127.0.0.1", resolve));
  const vendorAddress = vendor.address();
  if (vendorAddress === null || typeof vendorAddress === "string") throw new Error("no vendor port");

  let route: Awaited<ReturnType<typeof createGatewayModelRoute>> | null = null;
  try {
    route = await createGatewayModelRoute(validRealEnv(vendorAddress.port));
    assert.equal(route.mode, "real");
    assert.equal(route.providerId, "deepseek-official");
    assert.equal(route.modelId, "qwen3.8-flash");
    assert.ok(route.modelBaseUrl !== null && route.modelBaseUrl.startsWith("http://127.0.0.1:"));
    assert.deepEqual(route.workerEnv, { DSH_BRIDGE_MODEL_BASE_URL: route.modelBaseUrl });

    // Worker-shaped request: the pinned synthetic placeholder bearer + the
    // registered model id (exactly what the real worker child sends).
    const response = await fetch(`${route.modelBaseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": GATEWAY_EGRESS_PROXY_DEFAULT_TOKEN },
      body: JSON.stringify({
        model: "qwen3.8-flash",
        stream: true,
        max_tokens: 64,
        messages: [{ role: "user", content: "E2E08 路由探针（合成）" }],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes("合成回答"), "the vendor's streamed text crosses the whole route");
    assert.ok(body.includes("message_stop"), "the route terminates the Messages stream cleanly");

    // Credential split proof: the worker's placeholder reached the PROXY, the
    // vendor key reached the VENDOR — and never the other way around.
    assert.equal(vendorSawApiKey, "sk-test-vendor-key-do-not-leak");
    assert.equal(vendorModel, "qwen3.8-flash");

    // Proxy guards: wrong bearer → 401, unregistered model → 400.
    const wrongBearer = await fetch(`${route.modelBaseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "not-the-route-token" },
      body: JSON.stringify({ model: "qwen3.8-flash", messages: [{ role: "user", content: "x" }] }),
    });
    assert.equal(wrongBearer.status, 401);
    const wrongModel = await fetch(`${route.modelBaseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": GATEWAY_EGRESS_PROXY_DEFAULT_TOKEN },
      body: JSON.stringify({ model: "unregistered-model", messages: [{ role: "user", content: "x" }] }),
    });
    assert.equal(wrongModel.status, 400);

    // The workerEnv override is the ONLY child-visible change: no vendor key
    // material ever appears in it.
    assert.ok(!JSON.stringify(route.workerEnv).includes("sk-test-vendor-key-do-not-leak"));
  } finally {
    await route?.stop();
    await new Promise<void>((resolve) => vendor.close(() => resolve()));
  }
});
