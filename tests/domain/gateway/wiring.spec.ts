import assert from "node:assert/strict";
import test from "node:test";

import { createModelGateway, GatewayError, type ModelGateway, type ModelProvider } from "../../../lib/domain/gateway/index.ts";
import { parseModelGatewayConfig } from "../../../lib/domain/gateway/config.ts";
import {
  createRecordingProvider,
  createTestGateway,
  mockProvider,
} from "../runtime/helpers.ts";

function createModelGatewayWithPendingSleep(
  provider: ModelProvider,
  controller: AbortController,
): ModelGateway {
  const config = parseModelGatewayConfig({
    gatewayVersion: "1.0",
    models: [
      {
        modelId: "mock-model",
        providerId: provider.providerId,
        maxOutputTokens: 256,
        pricing: null,
      },
    ],
    budget: {
      maxRequestsPerDay: 100,
      maxCostMicroUsdPerDay: 1_000_000,
      maxTotalTokensPerDay: 1_000_000,
    },
    retry: { maxAttempts: 3, backoffBaseMs: 60_000 },
    breaker: { failureThreshold: 10, cooldownMs: 1000 },
    requestTimeoutMs: 30_000,
  });
  return createModelGateway(config, [provider], {
    // Backoff sleep that only resolves when the caller aborts.
    sleep: () =>
      new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      }),
  });
}

test("wiring: config.requestTimeoutMs is the default per-attempt timeout", async () => {
  const provider = mockProvider();
  const gateway = createTestGateway({ provider, requestTimeoutMs: 5000 });
  await gateway.complete({
    requestId: "req_gwrout0001",
    traceId: "trc_gwrout0001",
    turnId: "trn_gwrout0001",
    modelId: "mock-model",
    messages: [{ role: "user", content: "synthetic" }],
  });
  const started = gateway
    .auditTrail()
    .filter((event) => event.type === "attempt.started");
  assert.equal(started.length, 1);
  assert.equal(started[0]?.type === "attempt.started" ? started[0].timeoutMs : null, 5000);
});

test("wiring: an explicit request timeout may tighten but never exceed the configured default", async () => {
  const provider = mockProvider();
  const gateway = createTestGateway({ provider, requestTimeoutMs: 5000 });
  await gateway.complete({
    requestId: "req_gwrout0002",
    traceId: "trc_gwrout0002",
    turnId: "trn_gwrout0002",
    modelId: "mock-model",
    messages: [{ role: "user", content: "synthetic" }],
    timeoutMs: 1000,
  });
  await gateway.complete({
    requestId: "req_gwrout0003",
    traceId: "trc_gwrout0003",
    turnId: "trn_gwrout0003",
    modelId: "mock-model",
    messages: [{ role: "user", content: "synthetic" }],
    timeoutMs: 60_000,
  });
  const timeouts = gateway
    .auditTrail()
    .filter((event) => event.type === "attempt.started")
    .map((event) => (event.type === "attempt.started" ? event.timeoutMs : null));
  assert.deepEqual(timeouts, [1000, 5000]);
});

test("wiring: ModelRegistration.maxOutputTokens is the provider-visible default and ceiling", async () => {
  const recording = createRecordingProvider({ providerId: "mock", replyText: "MOCK-OK" });
  const gateway = createTestGateway({ provider: recording, maxOutputTokens: 77 });
  // No explicit request value → the registration ceiling is the default.
  await gateway.complete({
    requestId: "req_gwrout0004",
    traceId: "trc_gwrout0004",
    turnId: "trn_gwrout0004",
    modelId: "mock-model",
    messages: [{ role: "user", content: "synthetic" }],
  });
  // Explicit request value above the ceiling → clamped to the registration.
  await gateway.complete({
    requestId: "req_gwrout0005",
    traceId: "trc_gwrout0005",
    turnId: "trn_gwrout0005",
    modelId: "mock-model",
    messages: [{ role: "user", content: "synthetic" }],
    maxOutputTokens: 100,
  });
  // Explicit request value below the ceiling → honored.
  await gateway.complete({
    requestId: "req_gwrout0006",
    traceId: "trc_gwrout0006",
    turnId: "trn_gwrout0006",
    modelId: "mock-model",
    messages: [{ role: "user", content: "synthetic" }],
    maxOutputTokens: 50,
  });
  const observed = recording.requests().map((request) => request.maxOutputTokens);
  assert.deepEqual(observed, [77, 77, 50]);
});

test("wiring: GATEWAY_NO_PROVIDER leaves a request.rejected audit event (carried #37 note)", async () => {
  const gateway = createTestGateway({ provider: mockProvider(), modelIds: [] });
  await assert.rejects(
    () =>
      gateway.complete({
        requestId: "req_gwrout0007",
        traceId: "trc_gwrout0007",
        turnId: "trn_gwrout0007",
        modelId: "mock-model",
        messages: [{ role: "user", content: "synthetic" }],
      }),
    (error: unknown) => error instanceof GatewayError && error.code === "GATEWAY_NO_PROVIDER",
  );
  const rejected = gateway
    .auditTrail()
    .filter((event) => event.type === "request.rejected");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]?.type === "request.rejected" ? rejected[0].code : null, "GATEWAY_NO_PROVIDER");
  assert.equal(
    rejected[0]?.type === "request.rejected" ? rejected[0].requestId : null,
    "req_gwrout0007",
  );
});

test("wiring: a pre-attempt caller stop is audited as an attempt.cancelled event", async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = mockProvider();
  const gateway = createTestGateway({ provider });
  await assert.rejects(
    () =>
      gateway.complete(
        {
          requestId: "req_gwrout0008",
          traceId: "trc_gwrout0008",
          turnId: "trn_gwrout0008",
          modelId: "mock-model",
          messages: [{ role: "user", content: "synthetic" }],
        },
        { signal: controller.signal },
      ),
    (error: unknown) => error instanceof GatewayError && error.code === "GATEWAY_CANCELLED",
  );
  const cancelled = gateway
    .auditTrail()
    .filter((event) => event.type === "attempt.cancelled");
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0]?.type === "attempt.cancelled" ? cancelled[0].by : null, "caller");
  assert.equal("stats" in provider ? provider.stats().callCount : -1, 0);
});

test("wiring: a caller stop DURING retry backoff is honored promptly (abort-aware sleep)", async () => {
  const controller = new AbortController();
  const provider = mockProvider({
    failure: { classification: "unavailable", times: 1 },
  });
  // The injected sleep only resolves on abort; schedule the caller stop so
  // it fires DURING the (60s nominal) backoff after the first failure.
  setTimeout(() => controller.abort(), 20);
  const gateway = createModelGatewayWithPendingSleep(provider, controller);
  const startedAt = Date.now();
  await assert.rejects(
    () =>
      gateway.complete(
        {
          requestId: "req_gwrout0009",
          traceId: "trc_gwrout0009",
          turnId: "trn_gwrout0009",
          modelId: "mock-model",
          messages: [{ role: "user", content: "synthetic" }],
        },
        { signal: controller.signal },
      ),
    (error: unknown) => error instanceof GatewayError && error.code === "GATEWAY_CANCELLED",
  );
  // If the sleep were not abort-aware this await would hang forever; the
  // rejection itself is the proof. Assert we did not wait for a real timer.
  assert.ok(Date.now() - startedAt < 5000);
  const failed = gateway
    .auditTrail()
    .filter((event) => event.type === "attempt.failed");
  assert.equal(failed.length, 1, "the first attempt failed, then the backoff was aborted");
});
