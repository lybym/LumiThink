import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  buildGatewayRegistry,
  describeGatewayConfig,
  lookupGatewayRegistry,
  parseModelGatewayConfig,
} from "../../../lib/domain/gateway/config.ts";
import { createHttpMessagesProvider } from "../../../lib/domain/gateway/http-provider.ts";
import { createMockModelProvider } from "../../../lib/domain/gateway/mock-provider.ts";
import { createModelGateway } from "../../../lib/domain/gateway/gateway.ts";

export function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayVersion: "1.0",
    models: [
      { modelId: "mock-mini", providerId: "mock-a", maxOutputTokens: 1024, pricing: null },
    ],
    budget: { maxRequestsPerDay: 100, maxCostMicroUsdPerDay: 10_000_000, maxTotalTokensPerDay: 1_000_000 },
    retry: { maxAttempts: 3, backoffBaseMs: 1 },
    breaker: { failureThreshold: 5, cooldownMs: 1000 },
    requestTimeoutMs: 1000,
    ...overrides,
  };
}

test("a valid gateway config parses and freezes", () => {
  const config = parseModelGatewayConfig(baseConfig());
  assert.equal(config.gatewayVersion, "1.0");
  assert.equal(config.models.length, 1);
  assert.equal(config.models[0].modelId, "mock-mini");
  assert.equal(config.budget.maxRequestsPerDay, 100);
  assert.ok(Object.isFrozen(config));
});

test("budget, retry and breaker are REQUIRED (no implicit unlimited)", () => {
  for (const key of ["budget", "retry", "breaker", "requestTimeoutMs"]) {
    const broken = baseConfig();
    delete broken[key];
    assert.throws(() => parseModelGatewayConfig(broken), (error: unknown) => {
      assert.ok(error instanceof Error);
      return true;
    }, `${key} must be required`);
  }
});

test("numeric fields are range-checked and unknown fields rejected", () => {
  assert.throws(() => parseModelGatewayConfig(baseConfig({
    budget: { maxRequestsPerDay: 0, maxCostMicroUsdPerDay: 100, maxTotalTokensPerDay: 100 },
  })));
  assert.throws(() => parseModelGatewayConfig(baseConfig({ retry: { maxAttempts: 6, backoffBaseMs: 1 } })));
  assert.throws(() => parseModelGatewayConfig(baseConfig({ requestTimeoutMs: 0 })));
  assert.throws(() => parseModelGatewayConfig(baseConfig({ requestTimeoutMs: 121_000 })));
  assert.throws(() => parseModelGatewayConfig(baseConfig({ somethingElse: true })));
  assert.throws(() => parseModelGatewayConfig(baseConfig({
    models: [{ modelId: "m", providerId: "p", maxOutputTokens: 8, pricing: null, hijack: 1 }],
  })));
  assert.throws(() => parseModelGatewayConfig(baseConfig({ gatewayVersion: "9.9" })));
});

test("duplicate model ids and bad ids are rejected", () => {
  assert.throws(() => parseModelGatewayConfig(baseConfig({
    models: [
      { modelId: "mock-mini", providerId: "mock-a", maxOutputTokens: 8, pricing: null },
      { modelId: "mock-mini", providerId: "mock-b", maxOutputTokens: 8, pricing: null },
    ],
  })));
  assert.throws(() => parseModelGatewayConfig(baseConfig({
    models: [{ modelId: "UPPER", providerId: "mock-a", maxOutputTokens: 8, pricing: null }],
  })));
});

test("the registry helpers use Object.hasOwn semantics on null-prototype maps", () => {
  const registry = buildGatewayRegistry(
    [{ key: "mock-mini", value: 1 }],
    "models",
  );
  assert.equal(lookupGatewayRegistry(registry, "mock-mini")?.value, 1);
  // Prototype-chain keys can never masquerade as registered entries.
  assert.equal(lookupGatewayRegistry(registry, "constructor"), null);
  assert.equal(lookupGatewayRegistry(registry, "toString"), null);
  assert.equal(lookupGatewayRegistry(registry, "__proto__"), null);
});

test("describeGatewayConfig exposes presence flags only — never key material", () => {
  const reviewed = {
    acknowledgeDataEgressReview: true as const,
    reviewer: "review-team",
    reason: "synthetic data egress drill (loopback only)",
  };
  const httpProvider = createHttpMessagesProvider({
    providerId: "http-a",
    baseURL: "https://api.example.test/v1",
    keySource: () => "sk-SUPER-SECRET-VALUE",
    dataEgressReview: reviewed,
  });
  const mockProvider = createMockModelProvider({ providerId: "mock-a" });
  const config = parseModelGatewayConfig(baseConfig());
  const view = describeGatewayConfig(config, [mockProvider.registrationView(), httpProvider.registrationView()]);

  const mockView = view.providers.find((provider) => provider.providerId === "mock-a");
  assert.equal(mockView?.kind, "mock");
  assert.equal(mockView?.baseURLOrigin, null);
  assert.equal(mockView?.hasKeySource, false);
  assert.equal(mockView?.dataEgressReview, "absent");

  const httpView = view.providers.find((provider) => provider.providerId === "http-a");
  assert.equal(httpView?.baseURLOrigin, "https://api.example.test");
  assert.equal(httpView?.hasKeySource, true);
  assert.deepEqual(httpView?.dataEgressReview, { reviewer: "review-team", reason: "synthetic data egress drill (loopback only)" });

  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes("sk-SUPER-SECRET-VALUE"), false, "key material must never appear in the config view");
});

test("the gateway source tree contains NO default provider endpoint (fail-closed egress)", () => {
  // Issue #14: 未配置 Provider/密钥时 fail-closed，不意外外发至默认 DeepSeek API
  // 或日志上传服务。The whole gateway source must not embed any concrete
  // provider endpoint or telemetry host that could act as a default route.
  const gatewayDir = fileURLToPath(new URL("../../../lib/domain/gateway/", import.meta.url));
  const sources = [
    "gateway.ts",
    "config.ts",
    "types.ts",
    "errors.ts",
    "provider.ts",
    "mock-provider.ts",
    "http-provider.ts",
    "budget.ts",
    "index.ts",
  ].map((name) => readFileSync(join(gatewayDir, name), "utf8")).join("\n");

  for (const forbidden of [
    "api.deepseek.com",
    "deepseek.com",
    "openai.com",
    "anthropic.com",
    "sentry.io",
    "ingest.sentry",
    "telemetry",
  ]) {
    assert.equal(
      sources.toLowerCase().includes(forbidden),
      false,
      `gateway sources must not embed the host/token "${forbidden}"`,
    );
  }
  // The only https URL in sources is the documented EXAMPLE inside a comment.
  const httpsMatches = sources.match(/["'`]https?:\/\/[^"'`\s]+["'`]/g) ?? [];
  assert.deepEqual(httpsMatches, [], "no string-literal provider URL may exist in gateway sources");
});

test("an empty config yields a gateway that fails closed with GATEWAY_NO_PROVIDER", async () => {
  const config = parseModelGatewayConfig(baseConfig({ models: [] }));
  const gateway = createModelGateway(config, [], {
    clock: () => 1_700_000_000_000,
  });
  await assert.rejects(
    () => gateway.complete({
      requestId: "req_test0001_gatewayA1",
      traceId: "trc_test0001_gatewayA1",
      turnId: "trn_test0001_gatewayA1",
      modelId: "mock-mini",
      messages: [{ role: "user", content: "[synthetic] hi" }],
      timeoutMs: 100,
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "GATEWAY_NO_PROVIDER");
      return true;
    },
  );
  // The structurally valid request is audited as accepted, then the routing
  // failure happens with zero provider contact.
  assert.deepEqual(
    gateway.auditTrail().map((event) => event.type),
    ["request.accepted"],
  );
});

test("a model pointing at an unregistered provider fails closed", async () => {
  const config = parseModelGatewayConfig(baseConfig({
    models: [{ modelId: "ghost-model", providerId: "ghost-provider", maxOutputTokens: 8, pricing: null }],
  }));
  const mock = createMockModelProvider({ providerId: "mock-a" });
  const gateway = createModelGateway(config, [mock], { clock: () => 1_700_000_000_000 });
  await assert.rejects(
    () => gateway.complete({
      requestId: "req_test0001_gatewayA2",
      traceId: "trc_test0001_gatewayA2",
      turnId: "trn_test0001_gatewayA2",
      modelId: "ghost-model",
      messages: [{ role: "user", content: "[synthetic] hi" }],
      timeoutMs: 100,
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "GATEWAY_NO_PROVIDER");
      return true;
    },
  );
  assert.equal(mock.stats().callCount, 0);
});

test("a provider without an authorization record is treated as missing", async () => {
  const config = parseModelGatewayConfig(baseConfig());
  const unauthorized = {
    ...createMockModelProvider({ providerId: "mock-a" }),
    dataEgressAuthorized: false,
  } as ReturnType<typeof createMockModelProvider>;
  const gateway = createModelGateway(config, [unauthorized], { clock: () => 1_700_000_000_000 });
  await assert.rejects(
    () => gateway.complete({
      requestId: "req_test0001_gatewayA3",
      traceId: "trc_test0001_gatewayA3",
      turnId: "trn_test0001_gatewayA3",
      modelId: "mock-mini",
      messages: [{ role: "user", content: "[synthetic] hi" }],
      timeoutMs: 100,
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "GATEWAY_NO_PROVIDER");
      return true;
    },
  );
  assert.equal(unauthorized.stats().callCount, 0);
});
