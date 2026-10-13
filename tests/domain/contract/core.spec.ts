import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_ID_PREFIXES,
  ContractValidationError,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  canonicalJson,
  isValidContractId,
  isValidContractTimestamp,
  assertSupportedProtocolVersion,
  validateContractId,
} from "../../../lib/domain/contract/core.ts";

const SECRET_MARKER = "secret-child-token-xyz";

test("protocol version registry contains exactly contract v1.0 and is frozen", () => {
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], ["1.0"]);
  assert.equal(LATEST_PROTOCOL_VERSION, "1.0");
  assert.ok(Object.isFrozen(SUPPORTED_PROTOCOL_VERSIONS));
});

test("supported protocol versions are accepted", () => {
  assert.doesNotThrow(() => assertSupportedProtocolVersion("1.0", "protocolVersion"));
});

test("unknown, empty and non-string protocol versions are rejected (fail-closed)", () => {
  for (const bad of ["2.0", "0.9", "1.1", "", " 1.0", null, undefined, 1, true, ["1.0"]]) {
    assert.throws(
      () => assertSupportedProtocolVersion(bad, "protocolVersion"),
      (error: unknown) => {
        assert.ok(error instanceof ContractValidationError);
        assert.equal(error.problems[0].code, "CONTRACT_UNKNOWN_VERSION");
        assert.equal(error.problems[0].path, "protocolVersion");
        return true;
      },
      `expected rejection for ${JSON.stringify(bad)}`,
    );
  }
});

test("unknown version errors never echo the submitted value", () => {
  try {
    assertSupportedProtocolVersion(`9.9-${SECRET_MARKER}`, "protocolVersion");
    assert.fail("must throw");
  } catch (error) {
    assert.ok(error instanceof ContractValidationError);
    const serialized = JSON.stringify(error.problems);
    assert.equal(serialized.includes(SECRET_MARKER), false);
    assert.equal(serialized.includes("9.9"), false);
  }
});

test("every contract id kind has a unique prefix", () => {
  const prefixes = Object.values(CONTRACT_ID_PREFIXES);
  assert.equal(new Set(prefixes).size, prefixes.length);
  for (const prefix of prefixes) {
    assert.match(prefix, /_$/);
  }
});

test("valid ids of every kind pass validation", () => {
  const samples: Record<string, string> = {
    requestId: "req_fixture_web_t1_0001",
    traceId: "trc_fixture_trace_t1_001",
    conversationId: "conv_demo_conversation_0001",
    turnId: "trn_fixture_turn_t1_0001",
    sessionId: "ses_demo_session_0001",
    agentResponseId: "rsp_fixture_resp_t1_001",
    eventId: "evt_fixture_event_t1_001",
    actorId: "act_demo_child_0001",
    childRef: "chd_demo_001",
  };
  for (const [kind, value] of Object.entries(samples)) {
    assert.equal(
      isValidContractId(kind as never, value),
      true,
      `${kind} sample must be valid`,
    );
  }
});

test("missing ids are invalid", () => {
  for (const bad of [undefined, null, ""]) {
    assert.equal(isValidContractId("turnId", bad), false, `expected invalid for ${String(bad)}`);
  }
});

test("wrong prefix, bad charset and oversized ids are invalid", () => {
  // prefix misuse: a turnId wearing a requestId prefix
  assert.equal(isValidContractId("turnId", "req_fixture_web_t1_0001"), false);
  // injection / separators
  assert.equal(isValidContractId("conversationId", "conv_abc; drop table"), false);
  assert.equal(isValidContractId("conversationId", "conv_../../etc/passwd"), false);
  assert.equal(isValidContractId("conversationId", "conv_abc def"), false);
  // too short body (needs >= 8 chars)
  assert.equal(isValidContractId("conversationId", "conv_abc"), false);
  // too long (body > 64)
  assert.equal(isValidContractId("conversationId", `conv_${"a".repeat(65)}`), false);
  // wrong types
  assert.equal(isValidContractId("conversationId", 12345), false);
  assert.equal(isValidContractId("conversationId", ["conv_demo_0001"]), false);
});

test("id validation problems never echo the submitted value", () => {
  const problems: Parameters<typeof validateContractId>[3] = [];
  // A value that fails the ID grammar (space breaks the charset) and must be
  // rejected without echoing the submitted content.
  validateContractId(
    "conversationId",
    `conv_invalid ${SECRET_MARKER}`,
    "interaction.conversationId",
    problems,
  );
  assert.equal(problems.length, 1);
  const serialized = JSON.stringify(problems);
  assert.equal(serialized.includes(SECRET_MARKER), false);
});

test("timestamps must be ISO-8601 UTC", () => {
  assert.equal(isValidContractTimestamp("2026-10-13T10:00:00.000Z"), true);
  assert.equal(isValidContractTimestamp("2026-10-13T10:00:00Z"), true);
  assert.equal(isValidContractTimestamp("2026-10-13T10:00:00.123456Z"), true);
  assert.equal(isValidContractTimestamp("2026-10-13 10:00:00Z"), false);
  assert.equal(isValidContractTimestamp("2026-10-13T10:00:00+08:00"), false);
  assert.equal(isValidContractTimestamp("not-a-date"), false);
  assert.equal(isValidContractTimestamp(1731398400000), false);
  assert.equal(isValidContractTimestamp(null), false);
});

test("canonicalJson is order-independent and nested-stable", () => {
  const a = { b: 1, a: { y: [3, 1], x: 2 } };
  const b = { a: { x: 2, y: [3, 1] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson({ a: 1 }), '{"a":1}');
  assert.equal(canonicalJson(null), "null");
  assert.equal(canonicalJson(undefined), "null");
  assert.equal(canonicalJson([1, { z: 2, a: 3 }]), '[1,{"a":3,"z":2}]');
});
