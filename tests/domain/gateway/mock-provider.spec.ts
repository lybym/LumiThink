import assert from "node:assert/strict";
import test from "node:test";

import { createMockModelProvider } from "../../../lib/domain/gateway/mock-provider.ts";
import { parseModelRequest } from "../../../lib/domain/gateway/types.ts";
import { ProviderFailure } from "../../../lib/domain/gateway/errors.ts";

function baseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req_test0001_gatewayA1",
    traceId: "trc_test0001_gatewayA1",
    turnId: "trn_test0001_gatewayA1",
    modelId: "mock-mini",
    messages: [
      { role: "system", content: "[synthetic] system policy" },
      { role: "user", content: "[synthetic] SECRET-CHILD-TEXT-123" },
    ],
    timeoutMs: 500,
    ...overrides,
  };
}

async function collect(provider: ReturnType<typeof createMockModelProvider>, request: unknown): Promise<{
  deltas: string[];
  usage: { inputTokens: number; outputTokens: number } | null;
}> {
  const deltas: string[] = [];
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  const parsed = parseModelRequest(request);
  for await (const event of provider.stream(parsed, { signal: new AbortController().signal })) {
    if (event.type === "delta") {
      deltas.push(event.text);
    } else {
      usage = event.usage;
    }
  }
  return { deltas, usage };
}

test("the mock streams deterministic structural text and never echoes submitted content", async () => {
  const provider = createMockModelProvider({ providerId: "mock-a" });
  const { deltas, usage } = await collect(provider, baseRequest());
  const fullText = deltas.join("");
  assert.match(fullText, /^MOCK-OK messages=2 model=mock-mini$/);
  // The dirty marker in the user message must never appear in mock output.
  assert.equal(fullText.includes("SECRET-CHILD-TEXT-123"), false);
  assert.deepEqual(usage, { inputTokens: 3, outputTokens: 7 });
  assert.equal(provider.registrationView().dataEgressReview, null);
  assert.equal(provider.registrationView().baseURL, null);
});

test("the mock honors the abort signal between chunks (observed cancels)", async () => {
  const provider = createMockModelProvider({
    providerId: "mock-a",
    script: { reply: { chunkCount: 4, delayMsPerChunk: 20 } },
  });
  const controller = new AbortController();
  const parsed = parseModelRequest(baseRequest());
  const iterator = provider.stream(parsed, { signal: controller.signal })[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  controller.abort();
  await assert.rejects(() => iterator.next(), (error: unknown) => {
    assert.ok(error instanceof ProviderFailure);
    assert.equal(error.classification, "cancelled");
    return true;
  });
  assert.equal(provider.stats().observedCancels >= 1, true);
});

test("the mock failure script injects 429/5xx/timeout/auth classes", async () => {
  for (const classification of ["rate_limited", "server_error", "unavailable", "auth", "protocol", "timeout", "bad_request"] as const) {
    const provider = createMockModelProvider({
      providerId: "mock-a",
      script: { failure: { classification, times: "always" } },
    });
    await assert.rejects(() => collect(provider, baseRequest()), (error: unknown) => {
      assert.ok(error instanceof ProviderFailure);
      assert.equal(error.classification, classification);
      return true;
    }, `classification ${classification} must be injectable`);
  }
});

test("the mock failure script supports exact failure counts then recovery", async () => {
  const provider = createMockModelProvider({
    providerId: "mock-a",
    script: { failure: { classification: "rate_limited", times: 2 } },
  });
  await assert.rejects(() => collect(provider, baseRequest()));
  await assert.rejects(() => collect(provider, baseRequest()));
  const { deltas } = await collect(provider, baseRequest());
  assert.equal(deltas.length > 0, true);
  assert.equal(provider.stats().callCount, 3);
});

test("the mock can emit protocol violations for gateway enforcement tests", async () => {
  const oversized = createMockModelProvider({
    providerId: "mock-a",
    script: { oversizedDelta: true },
  });
  const collected = await collect(oversized, baseRequest());
  assert.equal(collected.deltas.join("").length >= 2000, true);

  const empty = createMockModelProvider({ providerId: "mock-a", script: { completeEmpty: true } });
  const emptyResult = await collect(empty, baseRequest());
  assert.deepEqual(emptyResult.usage, { inputTokens: 3, outputTokens: 7 });

  const noTerminal = createMockModelProvider({ providerId: "mock-a", script: { omitCompleted: true } });
  const noTerminalResult = await collect(noTerminal, baseRequest());
  assert.equal(noTerminalResult.usage, null);
});

test("the mock can fail after visible chunks (no-retry-after-output rule input)", async () => {
  const provider = createMockModelProvider({
    providerId: "mock-a",
    script: { failure: { classification: "server_error", times: "always", afterChunks: 1 } },
  });
  const parsed = parseModelRequest(baseRequest());
  const deltas: string[] = [];
  await assert.rejects(
    async () => {
      for await (const event of provider.stream(parsed, { signal: new AbortController().signal })) {
        if (event.type === "delta") {
          deltas.push(event.text);
        }
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof ProviderFailure);
      assert.equal(error.classification, "server_error");
      return true;
    },
  );
  assert.equal(deltas.length, 1, "the failure must come after exactly one visible delta");
});
