import assert from "node:assert/strict";
import test from "node:test";

import { CONTRACT_ERROR_CODES, ContractValidationError } from "../../../lib/domain/contract/core.ts";

import {
  CONTRACT_ERROR_REGISTRY,
  MAX_ERROR_MESSAGE_LENGTH,
  parseErrorEnvelope,
  serializeErrorEnvelope,
  toSafeErrorEnvelope,
} from "../../../lib/domain/contract/errors.ts";

import { syntheticErrorEnvelopeTextTooLong } from "../../../lib/domain/contract/fixtures.ts";

const SECRET_MARKER = "sk-synthetic-credential-do-not-leak";
const PRIVATE_CONTEXT_MARKER = "私有上下文：孩子名字是小明";

function makeDirtyError(): Error {
  const error = new Error(`Internal failure near ${SECRET_MARKER}; ${PRIVATE_CONTEXT_MARKER}`);
  // Give the error a realistic multi-frame stack.
  const wrapped = new Error("wrapper", { cause: error });
  return wrapped;
}

function problemsOf(error: unknown): { code: string; path: string }[] {
  assert.ok(error instanceof ContractValidationError, "expected ContractValidationError");
  return error.problems.map((p) => ({ code: p.code, path: p.path }));
}

test("every unified error code has registry metadata with a sane HTTP mapping", () => {
  assert.deepEqual(
    [...CONTRACT_ERROR_CODES].sort(),
    Object.keys(CONTRACT_ERROR_REGISTRY).sort(),
  );
  for (const [code, meta] of Object.entries(CONTRACT_ERROR_REGISTRY)) {
    assert.ok(meta.httpStatus >= 400 && meta.httpStatus <= 599, `${code} httpStatus`);
    assert.equal(typeof meta.retriable, "boolean");
    assert.ok(meta.safeMessage.length > 0 && meta.safeMessage.length <= MAX_ERROR_MESSAGE_LENGTH);
  }
  // Internal failures are the only retriable code and map to 500.
  assert.equal(CONTRACT_ERROR_REGISTRY.CONTRACT_INTERNAL.httpStatus, 500);
  assert.equal(CONTRACT_ERROR_REGISTRY.CONTRACT_INTERNAL.retriable, true);
  assert.equal(CONTRACT_ERROR_REGISTRY.CONTRACT_TEXT_TOO_LONG.httpStatus, 413);
  assert.equal(CONTRACT_ERROR_REGISTRY.CONTRACT_UNTRUSTED_IDENTITY.httpStatus, 403);
  assert.equal(CONTRACT_ERROR_REGISTRY.CONTRACT_DUPLICATE_REQUEST.httpStatus, 409);
  assert.equal(CONTRACT_ERROR_REGISTRY.CONTRACT_CROSS_CONVERSATION.httpStatus, 403);
  assert.equal(CONTRACT_ERROR_REGISTRY.CONTRACT_UNKNOWN_VERSION.httpStatus, 400);
});

test("ContractValidationError maps to its first problem's code with structural details", () => {
  let thrown: unknown;
  try {
    // 4001 chars of text triggers CONTRACT_TEXT_TOO_LONG.
    throw new ContractValidationError([
      {
        code: "CONTRACT_TEXT_TOO_LONG",
        path: "interaction.text.content",
        message: "interaction.text.content exceeds the 4000 code-point limit.",
        detail: { limit: 4000, actual: 4001 },
      },
    ]);
  } catch (error) {
    thrown = error;
  }
  const envelope = toSafeErrorEnvelope(thrown, {
    safeContext: { requestId: "req_fixture_web_t1_0001" },
    now: "2026-10-13T10:00:02.000Z",
  });
  assert.equal(envelope.error.code, "CONTRACT_TEXT_TOO_LONG");
  assert.equal(envelope.error.retriable, false);
  assert.equal(envelope.error.details?.field, "interaction.text.content");
  assert.equal(envelope.error.details?.limit, 4000);
  assert.equal(envelope.error.requestId, "req_fixture_web_t1_0001");
  assert.equal(envelope.protocolVersion, "1.0");
  assert.equal(envelope.occurredAt, "2026-10-13T10:00:02.000Z");
});

test("unknown errors collapse to a generic internal envelope — no stack, no message, no credentials", () => {
  const dirty = makeDirtyError();
  const envelope = toSafeErrorEnvelope(dirty, {
    safeContext: { requestId: "req_fixture_web_t1_0001" },
    now: "2026-10-13T10:00:02.000Z",
  });
  assert.equal(envelope.error.code, "CONTRACT_INTERNAL");
  assert.equal(envelope.error.message, "Internal contract error.");
  assert.equal(envelope.error.retriable, true);

  const serialized = serializeErrorEnvelope(envelope);
  assert.equal(serialized.includes(SECRET_MARKER), false, "credential must not leak");
  assert.equal(serialized.includes(PRIVATE_CONTEXT_MARKER), false, "private context must not leak");
  assert.equal(serialized.includes("Internal failure"), false, "original message must not leak");
  assert.equal(/\\n\s*at\s/.test(serialized), false, "stack frames must not leak");
  assert.equal(serialized.includes("stack"), false, "no stack field may exist");
  assert.equal("stack" in envelope, false);
  assert.equal("stack" in envelope.error, false);
});

test("correlation ids are echoed only when they re-validate against the ID grammar", () => {
  const envelope = toSafeErrorEnvelope(new Error("boom"), {
    safeContext: {
      requestId: `req_invalid ${SECRET_MARKER}`, // invalid grammar → must be dropped
      traceId: "trc_valid_trace_000001",
      conversationId: "conv_valid_conversatio",
      turnId: 42,
    },
    now: "2026-10-13T10:00:02.000Z",
  });
  assert.equal("requestId" in envelope.error, false, "invalid id must not be echoed");
  assert.equal(JSON.stringify(envelope).includes(SECRET_MARKER), false);
  assert.equal(envelope.error.traceId, "trc_valid_trace_000001");
  assert.equal(envelope.error.conversationId, "conv_valid_conversatio");
  assert.equal("turnId" in envelope.error, false);
});

test("non-Error throws are also handled fail-closed", () => {
  const envelope = toSafeErrorEnvelope(`string throw with ${SECRET_MARKER}`, {
    now: "2026-10-13T10:00:02.000Z",
  });
  assert.equal(envelope.error.code, "CONTRACT_INTERNAL");
  assert.equal(JSON.stringify(envelope).includes(SECRET_MARKER), false);
});

test("an invalid `now` option is refused instead of producing a malformed envelope", () => {
  assert.throws(
    () => toSafeErrorEnvelope(new Error("boom"), { now: "13/10/2026" }),
    ContractValidationError,
  );
});

test("parseErrorEnvelope accepts the fixture and rejects unknown codes/shapes", () => {
  assert.doesNotThrow(() => parseErrorEnvelope(syntheticErrorEnvelopeTextTooLong));

  assert.throws(
    () => parseErrorEnvelope({ ...syntheticErrorEnvelopeTextTooLong, error: { ...syntheticErrorEnvelopeTextTooLong.error, code: "TOTALLY_UNKNOWN" } }),
    (error: unknown) => problemsOf(error).some((p) => p.path === "error.code"),
  );
  assert.throws(
    () => parseErrorEnvelope({ ...syntheticErrorEnvelopeTextTooLong, protocolVersion: "2.0" }),
    (error: unknown) => problemsOf(error)[0].code === "CONTRACT_UNKNOWN_VERSION",
  );
  assert.throws(
    () =>
      parseErrorEnvelope({
        ...syntheticErrorEnvelopeTextTooLong,
        error: { ...syntheticErrorEnvelopeTextTooLong.error, message: "x".repeat(MAX_ERROR_MESSAGE_LENGTH + 1) },
      }),
    (error: unknown) => problemsOf(error).some((p) => p.path === "error.message"),
  );
  assert.throws(
    () =>
      parseErrorEnvelope({
        ...syntheticErrorEnvelopeTextTooLong,
        error: { ...syntheticErrorEnvelopeTextTooLong.error, retriable: "no" },
      }),
    (error: unknown) => problemsOf(error).some((p) => p.path === "error.retriable"),
  );
  assert.throws(
    () =>
      parseErrorEnvelope({
        ...syntheticErrorEnvelopeTextTooLong,
        error: { ...syntheticErrorEnvelopeTextTooLong.error, requestId: "not-valid-id" },
      }),
    (error: unknown) => problemsOf(error).some((p) => p.path === "error.requestId"),
  );
  // details values must be strings or numbers.
  assert.throws(
    () =>
      parseErrorEnvelope({
        ...syntheticErrorEnvelopeTextTooLong,
        error: { ...syntheticErrorEnvelopeTextTooLong.error, details: { nested: { deep: 1 } } },
      }),
    (error: unknown) => problemsOf(error).some((p) => p.path.startsWith("error.details.")),
  );
});

test("error envelopes never contain a stack field in the fixture either", () => {
  const parsed = parseErrorEnvelope(syntheticErrorEnvelopeTextTooLong);
  const serialized = serializeErrorEnvelope(parsed);
  assert.equal(serialized.includes("stack"), false);
  assert.equal(/at\s+\S+\s+\(/.test(serialized), false);
});
