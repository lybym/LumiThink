import assert from "node:assert/strict";
import test from "node:test";

import {
  assertKnownSafetyRuleId,
  assertSupportedSafetyPolicyVersion,
  isSupportedSafetyPolicyVersion,
  maxSeverityOf,
  SAFETY_LAYERS,
  SAFETY_POLICY_VERSION,
  SAFETY_POLICY_VERSIONS,
  SAFETY_RULES,
  SAFETY_RULE_IDS,
  safetyRuleIdsForLayer,
  severityRank,
  type SafetyRuleId,
} from "../../../lib/domain/safety/policy.ts";
import { ContractValidationError } from "../../../lib/domain/contract/core.ts";

test("the safety rule registry is complete and structurally sound", () => {
  assert.deepEqual(
    [...SAFETY_RULE_IDS].sort(),
    Object.keys(SAFETY_RULES).sort(),
    "SAFETY_RULES must cover exactly SAFETY_RULE_IDS",
  );
  assert.ok(SAFETY_RULE_IDS.length >= 15, "v1.0 registers the issue #27 rule set");
  for (const [id, rule] of Object.entries(SAFETY_RULES)) {
    assert.equal(rule.id, id as SafetyRuleId, "registry key must equal rule id");
    assert.ok((SAFETY_LAYERS as readonly string[]).includes(rule.layer), `${id} layer`);
    assert.ok(["low", "medium", "high"].includes(rule.severity), `${id} severity`);
    assert.ok(rule.summary.length > 10, `${id} has a structural summary`);
    // Summaries describe structure, never embed payloads or credentials.
    assert.ok(!rule.summary.includes("sk-"), `${id} summary must not embed credentials`);
    assert.ok(!rule.summary.includes("不要告诉"), `${id} summary must not embed payloads`);
  }
});

test("each layer carries its expected v1.0 rules", () => {
  assert.deepEqual([...safetyRuleIdsForLayer("input")].sort(), [
    "input.crisis_signals",
    "input.privacy_overreach",
    "input.prompt_injection",
    "input.role_forgery",
  ]);
  assert.deepEqual([...safetyRuleIdsForLayer("tool")].sort(), [
    "tool.dangerous_category",
    "tool.memory_write_unauthorized",
    "tool.permission_overreach",
    "tool.privacy_overreach",
    "tool.schema_forgery",
    "tool.unregistered",
  ]);
  const outputIds = safetyRuleIdsForLayer("output");
  assert.ok(outputIds.includes("output.exclusive_dependency"));
  assert.ok(outputIds.includes("output.secrecy_pressure"));
  assert.ok(outputIds.includes("output.diagnosis_claim"));
  assert.ok(outputIds.includes("output.ghostwriting"));
  assert.ok(outputIds.includes("output.age_inappropriate"));
  assert.ok(outputIds.includes("output.data_leak"));
  assert.ok(outputIds.includes("output.crisis_referral_missing"));
  assert.ok(outputIds.includes("output.gate_unavailable"));
  assert.equal(outputIds.length, 8);
});

test("policy versions are versioned and unknown versions fail closed", () => {
  assert.deepEqual([...SAFETY_POLICY_VERSIONS], ["1.0"]);
  assert.equal(SAFETY_POLICY_VERSION, "1.0");
  assert.equal(isSupportedSafetyPolicyVersion("1.0"), true);
  assert.equal(isSupportedSafetyPolicyVersion("0.9"), false);
  assert.equal(isSupportedSafetyPolicyVersion("2.0"), false);
  assert.equal(isSupportedSafetyPolicyVersion(null), false);
  assert.equal(isSupportedSafetyPolicyVersion(undefined), false);
  assert.equal(isSupportedSafetyPolicyVersion(["1.0"]), false);

  let thrown: unknown;
  try {
    assertSupportedSafetyPolicyVersion("attacker-version-2.0", "policyVersion");
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ContractValidationError, "unknown policy version must throw");
  const problem = (thrown as ContractValidationError).problems[0];
  assert.equal(problem.code, "CONTRACT_UNKNOWN_VERSION");
  assert.ok(problem.message.includes("not a supported version"));
  // The offending value is not echoed.
  assert.ok(!problem.message.includes("attacker-version"), "unknown version value must not be echoed");
});

test("unknown rule ids fail closed without echoing the value", () => {
  assert.throws(() => assertKnownSafetyRuleId("input.nonexistent_rule", "ruleIds[0]"));
  let message = "";
  try {
    assertKnownSafetyRuleId("invented.rule_id", "ruleIds[0]");
  } catch (error) {
    assert.ok(error instanceof ContractValidationError);
    message = (error as ContractValidationError).problems.map((p) => p.message).join(" ");
  }
  assert.ok(!message.includes("invented.rule_id"), "unknown rule id must not be echoed");
  assert.ok(message.includes("not registered"));
});

test("severity helpers rank rules deterministically", () => {
  assert.deepEqual([severityRank("low"), severityRank("medium"), severityRank("high")], [0, 1, 2]);
  assert.equal(maxSeverityOf([]), "low");
  assert.equal(maxSeverityOf(["output.ghostwriting"]), "medium");
  assert.equal(maxSeverityOf(["output.ghostwriting", "output.data_leak"]), "high");
  assert.equal(maxSeverityOf(["input.prompt_injection"]), "high");
  assert.throws(() => maxSeverityOf(["unknown.rule" as SafetyRuleId]));
});
