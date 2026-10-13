import assert from "node:assert/strict";
import test from "node:test";

import { ContractValidationError } from "../../../lib/domain/contract/core.ts";

import {
  buildSafetyTrace,
  parseSafetyTraceRecord,
  SAFETY_TRACE_REASONS,
  type SafetyTraceRecord,
  type SafetyTraceReason,
} from "../../../lib/domain/safety/trace.ts";
import type { SafetyRuleId } from "../../../lib/domain/safety/policy.ts";

const FIXED_AT = "2026-10-13T12:00:00.000Z";
const REFS = { requestId: "req_abcd1234efgh", traceId: "trc_abcd1234efgh", turnId: "trn_abcd1234efgh" };

test("buildSafetyTrace computes risk level from matched rules and never accepts it", () => {
  const allow = buildSafetyTrace({
    layer: "input",
    decision: "allow",
    ruleIds: [],
    reason: "rule_hit",
    refs: REFS,
    decidedAt: FIXED_AT,
  });
  assert.deepEqual(allow.ruleIds, []);
  assert.equal(allow.riskLevel, "low");
  assert.equal(allow.decision, "allow");
  assert.equal(allow.policyVersion, "1.0");

  const block = buildSafetyTrace({
    layer: "output",
    decision: "block",
    ruleIds: ["output.ghostwriting", "output.data_leak"],
    reason: "rule_hit",
    decidedAt: FIXED_AT,
  });
  assert.equal(block.riskLevel, "high", "risk level is the max severity, not the first rule");
  assert.deepEqual([...block.ruleIds], ["output.ghostwriting", "output.data_leak"]);
});

test("buildSafetyTrace enforces decision/rule consistency fail-closed", () => {
  assert.throws(
    () =>
      buildSafetyTrace({
        layer: "input",
        decision: "allow",
        ruleIds: ["input.prompt_injection"],
        reason: "rule_hit",
      }),
    ContractValidationError,
    "allow must not carry rule ids",
  );
  assert.throws(
    () =>
      buildSafetyTrace({
        layer: "input",
        decision: "block",
        ruleIds: [],
        reason: "rule_hit",
      }),
    ContractValidationError,
    "block must carry at least one rule id",
  );
  assert.throws(
    () =>
      buildSafetyTrace({
        layer: "tool",
        decision: "escalate_crisis",
        ruleIds: ["input.crisis_signals"],
        reason: "crisis_escalation",
      }),
    ContractValidationError,
    "escalate_crisis is input-layer only",
  );
  assert.throws(
    () =>
      buildSafetyTrace({
        layer: "input",
        decision: "block",
        ruleIds: ["invented.rule" as SafetyRuleId],
        reason: "rule_hit",
      }),
    ContractValidationError,
    "unknown rule ids are rejected",
  );
  assert.throws(
    () =>
      buildSafetyTrace({
        layer: "input",
        decision: "block",
        ruleIds: ["input.prompt_injection"],
        reason: "made_up_reason" as SafetyTraceReason,
      }),
    ContractValidationError,
    "reasons come from the reason registry",
  );
});

test("trace refs are re-validated against the contract ID vocabulary", () => {
  assert.throws(
    () =>
      buildSafetyTrace({
        layer: "input",
        decision: "allow",
        ruleIds: [],
        reason: "rule_hit",
        refs: { requestId: "not-a-contract-id" },
      }),
    ContractValidationError,
  );
  const ok = buildSafetyTrace({
    layer: "input",
    decision: "allow",
    ruleIds: [],
    reason: "rule_hit",
    refs: REFS,
    decidedAt: FIXED_AT,
  });
  assert.deepEqual({ ...ok.refs }, REFS);
});

test("refs are allow-listed in build and parse: unknown ref fields fail closed", () => {
  // A leaky caller trying to smuggle raw content through a refs side channel.
  assert.throws(
    () =>
      buildSafetyTrace({
        layer: "input",
        decision: "allow",
        ruleIds: [],
        reason: "rule_hit",
        refs: { smuggled: "raw sensitive content" } as unknown as { requestId?: string },
      }),
    ContractValidationError,
    "unknown refs fields must be rejected when building a trace",
  );

  const smuggled = {
    policyVersion: "1.0",
    layer: "input",
    decision: "block",
    ruleIds: ["input.prompt_injection"],
    riskLevel: "high",
    reason: "rule_hit",
    refs: { smuggled: "原始敏感内容" },
    decidedAt: FIXED_AT,
  };
  let message = "";
  try {
    parseSafetyTraceRecord(smuggled);
    assert.fail("unknown refs fields must be rejected when parsing a trace");
  } catch (error) {
    assert.ok(error instanceof ContractValidationError);
    message = (error as ContractValidationError).problems.map((p) => p.message).join(" ");
  }
  assert.ok(/unknown field/.test(message), "the unknown refs field must be named structurally");
  assert.ok(!message.includes("原始敏感内容"), "smuggled refs content must not be echoed");

  // Known refs keep working in both directions.
  const built = buildSafetyTrace({
    layer: "input",
    decision: "block",
    ruleIds: ["input.prompt_injection"],
    reason: "rule_hit",
    refs: { traceId: "trc_abcd1234efgh" },
    decidedAt: FIXED_AT,
  });
  assert.doesNotThrow(() => parseSafetyTraceRecord(JSON.parse(JSON.stringify(built))));
});

test("parseSafetyTraceRecord round-trips a built record", () => {
  const built = buildSafetyTrace({
    layer: "output",
    decision: "block",
    ruleIds: ["output.secrecy_pressure"],
    reason: "rule_hit",
    entrance: "api_text",
    refs: REFS,
    decidedAt: FIXED_AT,
  });
  const round = parseSafetyTraceRecord(JSON.parse(JSON.stringify(built)));
  assert.deepEqual(round, built);
});

test("parseSafetyTraceRecord rejects unknown fields so raw content cannot be smuggled in", () => {
  const base: Record<string, unknown> = {
    policyVersion: "1.0",
    layer: "input",
    decision: "block",
    ruleIds: ["input.prompt_injection"],
    riskLevel: "high",
    reason: "rule_hit",
    refs: {},
    decidedAt: FIXED_AT,
  };
  let message = "";
  try {
    parseSafetyTraceRecord({
      ...base,
      // A leaky caller trying to record raw submitted content.
      text: "孩子姓名与原话…",
      content: { secret: true },
    });
    assert.fail("smuggled fields must be rejected");
  } catch (error) {
    assert.ok(error instanceof ContractValidationError);
    message = (error as ContractValidationError).problems.map((p) => p.message).join(" ");
  }
  assert.ok(/unknown field/.test(message), "raw content fields must be rejected");
  // The rejection message must not echo the smuggled content.
  assert.ok(!message.includes("canary"), "smuggled content must not be echoed");
  assert.ok(!message.includes("原话"), "smuggled content must not be echoed");
});

test("parseSafetyTraceRecord fails closed on registry, timestamp and consistency violations", () => {
  const base = (): Record<string, unknown> => ({
    policyVersion: "1.0",
    layer: "input",
    decision: "block",
    ruleIds: ["input.prompt_injection"],
    riskLevel: "high",
    reason: "rule_hit",
    refs: {},
    decidedAt: FIXED_AT,
  });

  assert.throws(() => parseSafetyTraceRecord({ ...base(), policyVersion: "9.9" }), ContractValidationError);
  assert.throws(() => parseSafetyTraceRecord({ ...base(), ruleIds: ["nope.rule"] }), ContractValidationError);
  assert.throws(() => parseSafetyTraceRecord({ ...base(), riskLevel: "low" }), ContractValidationError);
  assert.throws(() => parseSafetyTraceRecord({ ...base(), decidedAt: "13/10/2026" }), ContractValidationError);
  const allowRecord = { ...base(), decision: "allow", ruleIds: [], riskLevel: "low" } as Record<string, unknown>;
  assert.doesNotThrow(() => parseSafetyTraceRecord(allowRecord), "a consistent allow record parses");
  assert.throws(
    () => parseSafetyTraceRecord({ ...base(), decision: "block", ruleIds: [], riskLevel: "low" }),
    ContractValidationError,
    "block without rules is inconsistent",
  );
  assert.throws(() => parseSafetyTraceRecord(null), ContractValidationError);
  assert.throws(() => parseSafetyTraceRecord("block"), ContractValidationError);
  assert.throws(() => parseSafetyTraceRecord([base()]), ContractValidationError);
});

test("records expose a fixed field set (audit contract, issue #27 AC 3)", () => {
  const built: Readonly<SafetyTraceRecord> = buildSafetyTrace({
    layer: "tool",
    decision: "block",
    ruleIds: ["tool.dangerous_category"],
    reason: "rule_hit",
    entrance: "dsh_tool",
    refs: { traceId: "trc_abcd1234efgh" },
    decidedAt: FIXED_AT,
  });
  assert.deepEqual(
    Object.keys(built).sort(),
    ["decidedAt", "decision", "entrance", "layer", "policyVersion", "reason", "refs", "riskLevel", "ruleIds"].sort(),
  );
  assert.equal(built.entrance, "dsh_tool");
});
