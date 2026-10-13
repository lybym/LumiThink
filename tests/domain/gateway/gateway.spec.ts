import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createModelGateway, type GatewayAuditEvent, type GatewayStreamItem } from "../../../lib/domain/gateway/gateway.ts";
import { createMockModelProvider } from "../../../lib/domain/gateway/mock-provider.ts";
import { createHttpMessagesProvider } from "../../../lib/domain/gateway/http-provider.ts";
import { parseModelGatewayConfig } from "../../../lib/domain/gateway/config.ts";
import { createInMemoryUsageLedger, type UsageLedger, type UsageSnapshot } from "../../../lib/domain/gateway/budget.ts";
import { GatewayError, GATEWAY_ERROR_REGISTRY } from "../../../lib/domain/gateway/errors.ts";

const T0 = 1_700_000_000_000; // fixed UTC instant for deterministic day keys

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gatewayVersion: "1.0",
    models: [
      { modelId: "mock-mini", providerId: "mock-a", maxOutputTokens: 1024, pricing: null },
    ],
    budget: { maxRequestsPerDay: 100, maxCostMicroUsdPerDay: 10_000_000, maxTotalTokensPerDay: 1_000_000 },
    retry: { maxAttempts: 3, backoffBaseMs: 1 },
    breaker: { failureThreshold: 5, cooldownMs: 60_000 },
    requestTimeoutMs: 1000,
    ...overrides,
  };
}

function baseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req_test0001_gatewayC1",
    traceId: "trc_test0001_gatewayC1",
    turnId: "trn_test0001_gatewayC1",
    modelId: "mock-mini",
    messages: [
      { role: "system", content: "[synthetic] system policy" },
      { role: "user", content: "[synthetic] hello" },
    ],
    timeoutMs: 500,
    ...overrides,
  };
}

interface RecordingLedger extends UsageLedger {
  recorded(): Array<{ dayKey: string; snapshot: UsageSnapshot }>;
}

function recordingLedger(): RecordingLedger {
  const inner = createInMemoryUsageLedger();
  const entries: Array<{ dayKey: string; snapshot: UsageSnapshot }> = [];
  return {
    snapshot: (dayKey: string) => inner.snapshot(dayKey),
    record: (dayKey: string, delta: { usage: { inputTokens: number; outputTokens: number }; costMicroUsd: number }) => {
      inner.record(dayKey, delta);
      entries.push({ dayKey, snapshot: inner.snapshot(dayKey) });
    },
    recorded: () => entries,
  };
}

function errorCodeOf(error: unknown): string {
  assert.ok(error instanceof GatewayError, `expected GatewayError, got ${String(error)}`);
  return error.code;
}

async function drain(stream: AsyncIterable<GatewayStreamItem>): Promise<{
  deltas: string[];
  result: Extract<GatewayStreamItem, { kind: "completed" }>["result"] | null;
}> {
  const deltas: string[] = [];
  let result: Extract<GatewayStreamItem, { kind: "completed" }>["result"] | null = null;
  for await (const item of stream) {
    if (item.kind === "delta") {
      deltas.push(item.text);
    } else {
      result = item.result;
    }
  }
  return { deltas, result };
}

function auditTypes(events: readonly GatewayAuditEvent[]): string[] {
  return events.map((event) => event.type);
}

test("mock E2E happy path: streaming deltas, completed result, cost accounting and audit trail", async () => {
  const mock = createMockModelProvider({ providerId: "mock-a" });
  const ledger = recordingLedger();
  const config = parseModelGatewayConfig(baseConfig({
    models: [
      {
        modelId: "mock-mini",
        providerId: "mock-a",
        maxOutputTokens: 1024,
        // 1 micro-USD per million tokens on each side → deterministic cost.
        pricing: { inputMicroUsdPerMillionTokens: 1_000_000, outputMicroUsdPerMillionTokens: 1_000_000 },
      },
    ],
  }));
  const gateway = createModelGateway(config, [mock], { clock: () => T0, ledger });

  const { deltas, result } = await drain(gateway.stream(baseRequest()));
  assert.ok(result !== null);
  assert.equal(deltas.join(""), result.fullText);
  assert.match(result.fullText, /^MOCK-OK messages=2 model=mock-mini$/);
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 7 });
  // cost = ceil(3*1.0) + ceil(7*1.0) = 10 micro-USD.
  assert.equal(result.costMicroUsd, 10);
  assert.equal(result.attempts, 1);
  assert.equal(result.modelId, "mock-mini");
  assert.equal(result.providerId, "mock-a");
  assert.equal(result.protocolVersion, "1.0");

  assert.deepEqual(ledger.recorded(), [
    { dayKey: "2023-11-14", snapshot: { requests: 1, totalTokens: 10, costMicroUsd: 10 } },
  ]);

  const types = auditTypes(gateway.auditTrail());
  assert.deepEqual(types, ["request.accepted", "attempt.started", "turn.completed"]);
  const completed = gateway.auditTrail().find((event) => event.type === "turn.completed");
  assert.ok(completed && completed.type === "turn.completed");
  assert.equal(completed.costMicroUsd, 10);
  assert.equal(completed.attempts, 1);

  // The redacted config view integrates provider registration metadata.
  const view = gateway.describeConfig();
  assert.equal(view.providers.length, 1);
  assert.equal(view.providers[0].kind, "mock");
});

test("complete() returns the same terminal result without manual draining", async () => {
  const mock = createMockModelProvider({ providerId: "mock-a" });
  const gateway = createModelGateway(parseModelGatewayConfig(baseConfig()), [mock], { clock: () => T0 });
  const result = await gateway.complete(baseRequest());
  assert.match(result.fullText, /^MOCK-OK/);
  assert.equal(result.attempts, 1);
});

test("retriable provider failures are retried with backoff until success", async () => {
  const mock = createMockModelProvider({
    providerId: "mock-a",
    script: { failure: { classification: "rate_limited", times: 1 } },
  });
  const sleeps: number[] = [];
  const gateway = createModelGateway(parseModelGatewayConfig(baseConfig()), [mock], {
    clock: () => T0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const result = await gateway.complete(baseRequest());
  assert.equal(result.attempts, 2);
  assert.equal(mock.stats().callCount, 2);
  assert.deepEqual(sleeps, [1]); // backoffBaseMs * 2^0
});

test("retry storm: an always-429 provider is attempted exactly maxAttempts times", async () => {
  const mock = createMockModelProvider({
    providerId: "mock-a",
    script: { failure: { classification: "rate_limited", times: "always" } },
  });
  const gateway = createModelGateway(
    parseModelGatewayConfig(baseConfig({ retry: { maxAttempts: 3, backoffBaseMs: 1 } })),
    [mock],
    { clock: () => T0, sleep: async () => undefined },
  );
  const error = await gateway.complete(baseRequest()).then(
    () => {
      throw new Error("expected failure");
    },
    (caught: unknown) => caught,
  );
  assert.equal(errorCodeOf(error), "GATEWAY_PROVIDER_RATE_LIMITED");
  assert.equal((error as GatewayError).retriable, true);
  assert.equal(mock.stats().callCount, 3, "exactly maxAttempts attempts, no retry storm beyond the cap");
  const failed = gateway.auditTrail().filter((event) => event.type === "attempt.failed");
  assert.equal(failed.length, 3);
  // Breaker threshold 5 > 3 failures: still closed.
  assert.equal(gateway.auditTrail().some((event) => event.type === "breaker.transition"), false);
});

test("timeout cancels the in-flight call and is classified distinctly from user stops", async () => {
  const mock = createMockModelProvider({
    providerId: "mock-a",
    script: { reply: { chunkCount: 4, delayMsPerChunk: 400 } },
  });
  const gateway = createModelGateway(
    parseModelGatewayConfig(baseConfig({
      breaker: { failureThreshold: 1, cooldownMs: 60_000 },
    })),
    [mock],
    { clock: () => T0 },
  );
  const started = Date.now();
  const error = await gateway.complete(baseRequest({ timeoutMs: 60 })).then(
    () => {
      throw new Error("expected failure");
    },
    (caught: unknown) => caught,
  );
  assert.ok(Date.now() - started < 2000, "the gateway must not wait out the full provider delay");
  assert.equal(errorCodeOf(error), "GATEWAY_PROVIDER_TIMEOUT");
  assert.equal((error as GatewayError).outcome, "timeout");
  assert.equal(mock.stats().observedCancels >= 1, true, "the in-flight provider call must have been aborted");
  assert.deepEqual(auditTypes(gateway.auditTrail()), [
    "request.accepted",
    "attempt.started",
    "attempt.cancelled",
    "breaker.transition", // closed → open (threshold 1, timeout = availability failure)
  ]);
  const cancelled = gateway.auditTrail().find((event) => event.type === "attempt.cancelled");
  assert.ok(cancelled && cancelled.type === "attempt.cancelled");
  assert.equal(cancelled.by, "timeout");
  // Timeout counts as an availability failure: threshold 1 → breaker open.
  const next = await gateway.complete(baseRequest({ timeoutMs: 60 })).then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.equal(errorCodeOf(next), "GATEWAY_CIRCUIT_OPEN");
  assert.equal(mock.stats().callCount, 1, "no provider contact while the breaker is open");
});

test("user cancellation is a first-class outcome; cancelled output never completes", async () => {
  const mock = createMockModelProvider({
    providerId: "mock-a",
    script: { reply: { chunkCount: 6, delayMsPerChunk: 40 } },
  });
  const gateway = createModelGateway(parseModelGatewayConfig(baseConfig()), [mock], { clock: () => T0 });
  const controller = new AbortController();
  const deltas: string[] = [];
  let completed = false;
  await assert.rejects(
    async () => {
      for await (const item of gateway.stream(baseRequest({ timeoutMs: 5000 }), { signal: controller.signal })) {
        if (item.kind === "delta") {
          deltas.push(item.text);
          if (deltas.length === 1) {
            controller.abort();
          }
        } else {
          completed = true;
        }
      }
    },
    (error: unknown) => {
      assert.equal(errorCodeOf(error), "GATEWAY_CANCELLED");
      assert.equal((error as GatewayError).outcome, "user_cancelled");
      return true;
    },
  );
  assert.equal(deltas.length, 1, "exactly the pre-abort delta was surfaced");
  assert.equal(completed, false, "a cancelled turn never reaches completed output");
  const cancelled = gateway.auditTrail().find((event) => event.type === "attempt.cancelled");
  assert.ok(cancelled && cancelled.type === "attempt.cancelled");
  assert.equal(cancelled.by, "caller");
  // A user stop says nothing about provider health: the breaker stays closed.
  assert.equal(gateway.auditTrail().some((event) => event.type === "breaker.transition"), false);
});

test("an already-aborted signal rejects before any provider contact", async () => {
  const mock = createMockModelProvider({ providerId: "mock-a" });
  const gateway = createModelGateway(parseModelGatewayConfig(baseConfig()), [mock], { clock: () => T0 });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => drain(gateway.stream(baseRequest(), { signal: controller.signal })),
    (error: unknown) => {
      assert.equal(errorCodeOf(error), "GATEWAY_CANCELLED");
      return true;
    },
  );
  assert.equal(mock.stats().callCount, 0);
});

test("auth failures are never retried and never open the breaker", async () => {
  const server = await new Promise<{ url: string; close: () => Promise<void>; hits: { count: number } }>((resolve, reject) => {
    const http = createServer((_req: IncomingMessage, res: ServerResponse) => {
      hits.count += 1;
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid key" }));
    });
    const hits = { count: 0 };
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      const address = http.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        hits,
        close: () => new Promise<void>((res2, rej2) => http.close((e) => (e === undefined ? res2() : rej2(e)))),
      });
    });
  });
  try {
    const httpProvider = createHttpMessagesProvider({
      providerId: "real-a",
      baseURL: server.url,
      keySource: () => "sk-synthetic-INVALID-KEY",
      dataEgressReview: {
        acknowledgeDataEgressReview: true,
        reviewer: "synthetic-review",
        reason: "loopback auth-failure drill",
      },
    });
    const config = parseModelGatewayConfig(baseConfig({
      models: [{ modelId: "real-mini", providerId: "real-a", maxOutputTokens: 64, pricing: null }],
      breaker: { failureThreshold: 1, cooldownMs: 60_000 },
    }));
    const gateway = createModelGateway(config, [httpProvider], { clock: () => T0, sleep: async () => undefined });
    const error = await gateway.complete(baseRequest({
      modelId: "real-mini",
      requestId: "req_test0001_gatewayC2",
      traceId: "trc_test0001_gatewayC2",
      turnId: "trn_test0001_gatewayC2",
    })).then(() => null, (caught: unknown) => caught);
    assert.equal(errorCodeOf(error), "GATEWAY_AUTH_FAILED");
    assert.equal((error as GatewayError).retriable, false);
    assert.equal(server.hits.count, 1, "auth failures must never be retried");
    assert.equal(gateway.auditTrail().some((event) => event.type === "breaker.transition"), false,
      "auth failures are misconfiguration, not availability");
    // A second request still reaches the provider (breaker not tripped).
    await gateway.complete(baseRequest({
      modelId: "real-mini",
      requestId: "req_test0001_gatewayC3",
      traceId: "trc_test0001_gatewayC3",
      turnId: "trn_test0001_gatewayC3",
    })).then(() => null, () => null);
    assert.equal(server.hits.count, 2);
  } finally {
    await server.close();
  }
});

test("budget exhaustion rejects BEFORE the provider is contacted, with an audit trail", async () => {
  const mock = createMockModelProvider({ providerId: "mock-a" });
  const gateway = createModelGateway(
    parseModelGatewayConfig(baseConfig({ budget: { maxRequestsPerDay: 1, maxCostMicroUsdPerDay: 10_000_000, maxTotalTokensPerDay: 1_000_000 } })),
    [mock],
    { clock: () => T0 },
  );
  const first = await gateway.complete(baseRequest());
  assert.ok(first !== null);
  const second = await gateway.complete(baseRequest({
    requestId: "req_test0001_gatewayC4",
    traceId: "trc_test0001_gatewayC4",
    turnId: "trn_test0001_gatewayC4",
  })).then(() => null, (caught: unknown) => caught);
  assert.equal(errorCodeOf(second), "GATEWAY_BUDGET_EXHAUSTED");
  assert.equal((second as GatewayError).outcome, "budget_exhausted");
  assert.equal(mock.stats().callCount, 1, "the exhausted budget must reject before provider contact");
  const rejected = gateway.auditTrail().find((event) => event.type === "budget.rejected");
  assert.ok(rejected && rejected.type === "budget.rejected");
  assert.equal(rejected.reason, "requests");
  assert.deepEqual(rejected.snapshot, { requests: 1, totalTokens: 10, costMicroUsd: 0 });
});

test("the daily budget rolls over at UTC midnight (injected clock)", async () => {
  const mock = createMockModelProvider({ providerId: "mock-a" });
  let now = T0;
  const gateway = createModelGateway(
    parseModelGatewayConfig(baseConfig({ budget: { maxRequestsPerDay: 1, maxCostMicroUsdPerDay: 10_000_000, maxTotalTokensPerDay: 1_000_000 } })),
    [mock],
    { clock: () => now },
  );
  await gateway.complete(baseRequest());
  const blocked = await gateway.complete(baseRequest({
    requestId: "req_test0001_gatewayC5",
    traceId: "trc_test0001_gatewayC5",
    turnId: "trn_test0001_gatewayC5",
  })).then(() => null, (caught: unknown) => caught);
  assert.equal(errorCodeOf(blocked), "GATEWAY_BUDGET_EXHAUSTED");
  now += 24 * 60 * 60 * 1000; // next UTC day
  const afterRoll = await gateway.complete(baseRequest({
    requestId: "req_test0001_gatewayC6",
    traceId: "trc_test0001_gatewayC6",
    turnId: "trn_test0001_gatewayC6",
  }));
  assert.match(afterRoll.fullText, /^MOCK-OK/);
});

test("a failing provider is never bypassed via another provider (no unauthorized failover)", async () => {
  const failing = createMockModelProvider({
    providerId: "provider-a",
    script: { failure: { classification: "server_error", times: "always" } },
  });
  const healthy = createMockModelProvider({ providerId: "provider-b" });
  const gateway = createModelGateway(
    parseModelGatewayConfig(baseConfig({
      models: [
        { modelId: "model-a", providerId: "provider-a", maxOutputTokens: 64, pricing: null },
        { modelId: "model-b", providerId: "provider-b", maxOutputTokens: 64, pricing: null },
      ],
      retry: { maxAttempts: 2, backoffBaseMs: 1 },
    })),
    [failing, healthy],
    { clock: () => T0, sleep: async () => undefined },
  );
  const error = await gateway.complete(baseRequest({
    modelId: "model-a",
    requestId: "req_test0001_gatewayC7",
    traceId: "trc_test0001_gatewayC7",
    turnId: "trn_test0001_gatewayC7",
  })).then(() => null, (caught: unknown) => caught);
  assert.equal(errorCodeOf(error), "GATEWAY_PROVIDER_SERVER_ERROR");
  assert.equal(failing.stats().callCount, 2);
  assert.equal(healthy.stats().callCount, 0, "the gateway must NEVER fail over to another provider");
});

test("no retry happens once a delta is visible to the consumer", async () => {
  const mock = createMockModelProvider({
    providerId: "mock-a",
    script: { failure: { classification: "server_error", times: "always", afterChunks: 1 } },
  });
  const gateway = createModelGateway(parseModelGatewayConfig(baseConfig()), [mock], {
    clock: () => T0,
    sleep: async () => undefined,
  });
  const deltas: string[] = [];
  await assert.rejects(
    async () => {
      for await (const item of gateway.stream(baseRequest())) {
        if (item.kind === "delta") {
          deltas.push(item.text);
        }
      }
    },
    (error: unknown) => {
      assert.equal(errorCodeOf(error), "GATEWAY_PROVIDER_SERVER_ERROR");
      return true;
    },
  );
  assert.equal(deltas.length, 1);
  assert.equal(mock.stats().callCount, 1, "a partially consumed output stream must never be retried");
});

test("provider protocol violations fail closed without emitting bad deltas", async () => {
  // Oversized delta: rejected before it reaches the consumer.
  const oversized = createMockModelProvider({ providerId: "mock-a", script: { oversizedDelta: true } });
  const oversizedGateway = createModelGateway(parseModelGatewayConfig(baseConfig()), [oversized], { clock: () => T0 });
  const oversizedDeltas: string[] = [];
  await assert.rejects(
    async () => {
      for await (const item of oversizedGateway.stream(baseRequest())) {
        if (item.kind === "delta") {
          oversizedDeltas.push(item.text);
        }
      }
    },
    (error: unknown) => {
      assert.equal(errorCodeOf(error), "GATEWAY_PROVIDER_PROTOCOL");
      return true;
    },
  );
  assert.deepEqual(oversizedDeltas, [], "an oversized delta must never reach the consumer");

  const empty = createMockModelProvider({ providerId: "mock-a", script: { completeEmpty: true } });
  const emptyGateway = createModelGateway(parseModelGatewayConfig(baseConfig()), [empty], { clock: () => T0 });
  await assert.rejects(
    () => emptyGateway.complete(baseRequest()),
    (error: unknown) => {
      assert.equal(errorCodeOf(error), "GATEWAY_PROVIDER_PROTOCOL");
      assert.equal((error as GatewayError).details.reason, "empty_output");
      return true;
    },
  );

  const noTerminal = createMockModelProvider({ providerId: "mock-a", script: { omitCompleted: true } });
  const noTerminalGateway = createModelGateway(parseModelGatewayConfig(baseConfig()), [noTerminal], { clock: () => T0 });
  await assert.rejects(
    () => noTerminalGateway.complete(baseRequest()),
    (error: unknown) => {
      assert.equal(errorCodeOf(error), "GATEWAY_PROVIDER_PROTOCOL");
      assert.equal((error as GatewayError).details.reason, "missing_completed");
      return true;
    },
  );
});

test("errors and audit never carry child text or key material", async () => {
  const DIRTY_CHILD_TEXT = "SECRET-CHILD-TEXT-123";
  const DIRTY_KEY = "sk-SUPER-DIRTY-KEY-456";
  const mock = createMockModelProvider({
    providerId: "mock-a",
    script: { failure: { classification: "server_error", times: "always" } },
  });
  const gateway = createModelGateway(parseModelGatewayConfig(baseConfig()), [mock], {
    clock: () => T0,
    sleep: async () => undefined,
  });
  const error = await gateway.complete(baseRequest({
    messages: [
      { role: "system", content: `[synthetic] policy ${DIRTY_CHILD_TEXT}` },
      { role: "user", content: DIRTY_CHILD_TEXT },
    ],
  })).then(() => null, (caught: unknown) => caught);
  assert.ok(error instanceof GatewayError);
  const auditSerialized = JSON.stringify(gateway.auditTrail());
  const errorSerialized = JSON.stringify({
    message: error.message,
    code: error.code,
    retriable: error.retriable,
    outcome: error.outcome,
    details: error.details,
  });
  for (const serialized of [auditSerialized, errorSerialized]) {
    assert.equal(serialized.includes(DIRTY_CHILD_TEXT), false, "child text must never enter audit/errors");
    assert.equal(serialized.includes(DIRTY_KEY), false, "key material must never enter audit/errors");
  }
  // The error message is a fixed registry string.
  assert.equal(error.message, GATEWAY_ERROR_REGISTRY[error.code].safeMessage);
});

test("invalid requests are rejected before any model lookup or provider contact", async () => {
  const mock = createMockModelProvider({ providerId: "mock-a" });
  const gateway = createModelGateway(parseModelGatewayConfig(baseConfig()), [mock], { clock: () => T0 });
  await assert.rejects(
    () => gateway.complete(baseRequest({ requestId: "BROKEN", childRef: "chd_demo_001" })),
    (error: unknown) => {
      assert.equal(errorCodeOf(error), "GATEWAY_INVALID_REQUEST");
      assert.equal(Number((error as GatewayError).details.problemCount) >= 1, true);
      return true;
    },
  );
  assert.equal(mock.stats().callCount, 0);
  const rejected = gateway.auditTrail().find((event) => event.type === "request.rejected");
  assert.ok(rejected && rejected.type === "request.rejected");
  // The unvalidated id is masked, never echoed.
  assert.equal(rejected.requestId, "[unverified]");
});

test("mock E2E: token/cost overshoot is recorded and visible in the ledger", async () => {
  const mock = createMockModelProvider({
    providerId: "mock-a",
    script: { reply: { usage: { inputTokens: 900, outputTokens: 900 } } },
  });
  const gateway = createModelGateway(
    parseModelGatewayConfig(baseConfig({
      budget: { maxRequestsPerDay: 100, maxCostMicroUsdPerDay: 10_000_000, maxTotalTokensPerDay: 1000 },
      models: [
        {
          modelId: "mock-mini",
          providerId: "mock-a",
          maxOutputTokens: 1024,
          pricing: { inputMicroUsdPerMillionTokens: 1_000_000, outputMicroUsdPerMillionTokens: 1_000_000 },
        },
      ],
    })),
    [mock],
    { clock: () => T0 },
  );
  const result = await gateway.complete(baseRequest());
  assert.ok(result);
  const overshoot = gateway.auditTrail().find((event) => event.type === "budget.overshoot");
  assert.ok(overshoot && overshoot.type === "budget.overshoot", "the overshoot must be audited");
  assert.equal(overshoot.dayKey, "2023-11-14");
});
