import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MODEL_MESSAGE_CHARS,
  parseModelRequest,
  validateProviderDelta,
} from "../../../lib/domain/gateway/types.ts";
import { MAX_STREAM_DELTA_LENGTH } from "../../../lib/domain/contract/response.ts";

function baseRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: "req_test0001_gatewayA1",
    traceId: "trc_test0001_gatewayA1",
    turnId: "trn_test0001_gatewayA1",
    modelId: "mock-mini",
    messages: [
      { role: "system", content: "[synthetic] system policy" },
      { role: "user", content: "[synthetic] hello" },
    ],
    timeoutMs: 500,
    ...overrides,
  };
}

test("a valid gateway request parses and is deeply frozen", () => {
  const request = parseModelRequest(baseRequest());
  assert.equal(request.modelId, "mock-mini");
  assert.equal(request.messages.length, 2);
  assert.equal(request.tools.length, 0);
  assert.equal(request.timeoutMs, 500);
  assert.equal(request.maxOutputTokens, null);
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.messages));
  assert.ok(Object.isFrozen(request.messages[0]));
});

test("request fields are required and grammar-checked", () => {
  for (const key of ["requestId", "traceId", "turnId", "modelId"]) {
    const broken = baseRequest();
    delete broken[key];
    assert.throws(() => parseModelRequest(broken), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /problems/);
      return true;
    });
  }
  assert.throws(() => parseModelRequest(baseRequest({ requestId: "not-a-contract-id" })));
  assert.throws(() => parseModelRequest(baseRequest({ modelId: "Bad_Model_ID" })));
});

test("identity fields never ride along to a provider (issue #14 最小必要上下文)", () => {
  for (const smuggled of ["actor", "actorContext", "childRef", "childId", "sessionId", "role", "userId"]) {
    assert.throws(
      () => parseModelRequest(baseRequest({ [smuggled]: "spoofed" })),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        return true;
      },
      `field ${smuggled} must be rejected`,
    );
  }
  // Same rule inside a message object.
  assert.throws(() =>
    parseModelRequest(
      baseRequest({
        messages: [{ role: "user", content: "[synthetic]", childRef: "chd_demo_001" }],
      }),
    ),
  );
});

test("message roles are whitelisted and content is code-point capped", () => {
  assert.throws(() => parseModelRequest(baseRequest({
    messages: [{ role: "tool", content: "[synthetic]" }],
  })));
  assert.throws(() => parseModelRequest(baseRequest({
    messages: [{ role: "user", content: "" }],
  })));

  const astral = "🎓".repeat(4000); // 4000 code points, 8000 UTF-16 units
  assert.equal(astral.length, MAX_MODEL_MESSAGE_CHARS);
  assert.doesNotThrow(() =>
    parseModelRequest(baseRequest({ messages: [{ role: "user", content: astral }] })),
  );

  // 8001 code points carried in 12002 UTF-16 units: exceeds the cap via the
  // precise code-point count, NOT the UTF-16 short-circuit.
  const overCodePoints = "🎓".repeat(4000) + "x".repeat(4001);
  assert.throws(() => parseModelRequest(baseRequest({ messages: [{ role: "user", content: overCodePoints }] })));

  // UTF-16 short-circuit: definitely over the cap in UTF-16 units already.
  assert.throws(() => parseModelRequest(baseRequest({
    messages: [{ role: "user", content: "x".repeat(MAX_MODEL_MESSAGE_CHARS * 2 + 1) }],
  })));
});

test("message count and tools are bounded", () => {
  const tooMany = Array.from({ length: 33 }, () => ({ role: "user", content: "[synthetic]" }));
  assert.throws(() => parseModelRequest(baseRequest({ messages: tooMany })));
  assert.throws(() => parseModelRequest(baseRequest({ tools: [{ name: "BAD NAME", description: "x" }] })));
  assert.doesNotThrow(() =>
    parseModelRequest(baseRequest({ tools: [{ name: "evidence_search", description: "read-only search" }] })),
  );
});

test("timeoutMs and maxOutputTokens are range-checked", () => {
  for (const bad of [0, -1, 1.5, 121_000, "500"]) {
    assert.throws(() => parseModelRequest(baseRequest({ timeoutMs: bad })));
  }
  for (const bad of [0, -5, 8193, "x"]) {
    assert.throws(() => parseModelRequest(baseRequest({ maxOutputTokens: bad })));
  }
  const parsed = parseModelRequest(baseRequest({ maxOutputTokens: 512 }));
  assert.equal(parsed.maxOutputTokens, 512);
});

test("problem messages never echo submitted values", () => {
  try {
    parseModelRequest(baseRequest({ modelId: "SECRET-MODEL-NAME" }));
    assert.fail("expected rejection");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes("SECRET-MODEL-NAME"), false);
  }
});

test("provider deltas are validated against the contract per-delta cap", () => {
  assert.throws(() => validateProviderDelta(""));
  assert.throws(() => validateProviderDelta(undefined));
  assert.equal(validateProviderDelta("🎓".repeat(MAX_STREAM_DELTA_LENGTH)), "🎓".repeat(MAX_STREAM_DELTA_LENGTH));
  assert.throws(() => validateProviderDelta("x".repeat(MAX_STREAM_DELTA_LENGTH + 1)));
  assert.throws(() => validateProviderDelta("🎓".repeat(MAX_STREAM_DELTA_LENGTH + 1)));
});
