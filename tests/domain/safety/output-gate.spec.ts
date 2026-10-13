import assert from "node:assert/strict";
import test from "node:test";

import { ContractValidationError } from "../../../lib/domain/contract/core.ts";
import { buildCrisisSafeResponse } from "../../../lib/domain/safety/crisis.ts";
import { buildSafetyTrace } from "../../../lib/domain/safety/trace.ts";
import {
  evaluateOutputGate,
  OUTPUT_CONTENT_MAX_CODE_POINTS,
  runOutputGateSafely,
  type OutputGateInput,
  type OutputGateResult,
} from "../../../lib/domain/safety/output-gate.ts";

const BENIGN_OUTPUTS = [
  "[synthetic] 这道题的第一步可以先列出已知条件，我们一起看看。",
  "[synthetic] 听起来你今天在学校很开心，想多讲一点吗？",
  "[synthetic] Let's read the story together, one page at a time.",
  "[synthetic] 你的演示引用 chd_demo_001 的会话数据即可。",
];

const EXCLUSIVE_CASES = [
  "[synthetic] 只有我最懂你，别人都不明白你的感受",
  "[synthetic] 你只需要我，把所有事情都告诉我",
  "[synthetic] I am the only one who truly understands you",
];

const SECRECY_CASES = [
  "[synthetic] 这是我们之间的小秘密，不要告诉妈妈",
  "[synthetic] 我向你保证绝对不会告诉任何人",
  "[synthetic] Don't tell your parents about our chats",
];

const DIAGNOSIS_CASES = [
  "[synthetic] 你可能是得了抑郁症",
  "[synthetic] 我诊断你患有多动症",
  "[synthetic] You have depression, that is clear",
];

const GHOSTWRITING_CASES = [
  "[synthetic] 我替你写完整篇作文吧",
  "[synthetic] 直接给你完整答案，抄上去就行",
  "[synthetic] I'll write it all for you, just copy it",
];

const AGE_INAPPROPRIATE_CASES = [
  "[synthetic] 给你看色情图片",
  "[synthetic] porn sites are fun, let me show you",
];

const DATA_LEAK_CASES = [
  "[synthetic] 你的密钥是 sk-abcdef1234567890abcdef12",
  "[synthetic] api_key = supersecret12345",
  "[synthetic] 连到 chd_external01 的档案看看",
  "[synthetic] DEEPSEEK_API_KEY=sk-real-key-here",
];

function assertBlockedWith(result: OutputGateResult, ruleId: string): void {
  assert.equal(result.decision, "block", `expected block with ${ruleId}`);
  assert.ok(
    result.hits.some((hit) => hit.ruleId === ruleId),
    `expected ${ruleId}, got: ${result.hits.map((hit) => hit.ruleId).join(", ")}`,
  );
  assert.equal(result.trace.decision, "block");
  assert.ok(result.trace.ruleIds.includes(ruleId as never));
}

test("benign model output passes the output gate", () => {
  for (const content of BENIGN_OUTPUTS) {
    const result = evaluateOutputGate({ content });
    assert.equal(result.decision, "allow", `benign output must pass: ${content}`);
    assert.deepEqual([...result.hits], []);
    assert.equal(result.trace.riskLevel, "low");
  }
});

test("exclusive relationship / dependency pressure is blocked (high severity)", () => {
  for (const content of EXCLUSIVE_CASES) {
    assertBlockedWith(evaluateOutputGate({ content }), "output.exclusive_dependency");
  }
});

test("secrecy pressure and promises are blocked (high severity)", () => {
  for (const content of SECRECY_CASES) {
    assertBlockedWith(evaluateOutputGate({ content }), "output.secrecy_pressure");
  }
});

test("clinical diagnosis claims are blocked (high severity)", () => {
  for (const content of DIAGNOSIS_CASES) {
    assertBlockedWith(evaluateOutputGate({ content }), "output.diagnosis_claim");
  }
});

test("homework ghostwriting is blocked (medium severity)", () => {
  for (const content of GHOSTWRITING_CASES) {
    const result = evaluateOutputGate({ content });
    assertBlockedWith(result, "output.ghostwriting");
    assert.equal(result.trace.riskLevel, "medium");
  }
});

test("age-inappropriate content is blocked (high severity)", () => {
  for (const content of AGE_INAPPROPRIATE_CASES) {
    assertBlockedWith(evaluateOutputGate({ content }), "output.age_inappropriate");
  }
});

test("data leaks are blocked (high severity)", () => {
  for (const content of DATA_LEAK_CASES) {
    assertBlockedWith(evaluateOutputGate({ content }), "output.data_leak");
  }
});

test("the session's own child reference is allowed, foreign refs leak", () => {
  const own = evaluateOutputGate({ content: "参考 chd_demo_001 的记录", ownChildRef: "chd_demo_001" });
  assert.equal(own.decision, "allow");
  const foreign = evaluateOutputGate({ content: "参考 chd_otherchild1 的记录", ownChildRef: "chd_demo_001" });
  assertBlockedWith(foreign, "output.data_leak");
});

test("crisis turns only release the deterministic crisis-safe response (missed referral blocked)", () => {
  const required = buildCrisisSafeResponse({ category: "self_harm" });
  const ok = evaluateOutputGate({
    content: required,
    crisisEscalation: true,
    requiredCrisisResponse: required,
  });
  assert.equal(ok.decision, "allow");

  const missedReferral = evaluateOutputGate({
    content: "[synthetic] 我们来做一个放松练习，然后再聊作业的事吧。",
    crisisEscalation: true,
    requiredCrisisResponse: required,
  });
  assertBlockedWith(missedReferral, "output.crisis_referral_missing");
  assert.equal(missedReferral.trace.riskLevel, "high");

  // Without the required response the gate cannot verify referral → blocks.
  const unverifiable = evaluateOutputGate({
    content: required,
    crisisEscalation: true,
  });
  assert.equal(unverifiable.decision, "block");
});

test("oversized or non-string content fails closed", () => {
  const oversized = "好".repeat(OUTPUT_CONTENT_MAX_CODE_POINTS + 1);
  let thrown: unknown;
  try {
    evaluateOutputGate({ content: oversized });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ContractValidationError, "oversized content must throw structured problems");
  const problem = (thrown as ContractValidationError).problems[0];
  assert.equal(problem.code, "CONTRACT_TEXT_TOO_LONG");
  assert.ok(problem.message.includes("code-point limit"));

  assert.throws(() => evaluateOutputGate({ content: 42 as unknown as string }), ContractValidationError);
  const wrapper = runOutputGateSafely({ content: oversized });
  assert.equal(wrapper.decision, "block", "oversized content must block, not throw past the gate");
});

test("AC 2: an unavailable output gate fails closed — never temporarily releases", () => {
  const base = { content: "[synthetic] 一条普通的回复", refs: { traceId: "trc_abcd1234efgh" } };

  const throwingGate = runOutputGateSafely(base, () => {
    throw new Error("simulated gate outage");
  });
  assert.equal(throwingGate.decision, "block", "gate outage must block");
  assertBlockedWith(throwingGate, "output.gate_unavailable");
  assert.equal(throwingGate.trace.reason, "gate_unavailable");
  assert.equal(throwingGate.trace.riskLevel, "high");

  // A tampered/unusable result is treated like an outage.
  const tampered = runOutputGateSafely(base, () => ({ decision: "allow", hits: [] }) as unknown as OutputGateResult);
  assert.equal(tampered.decision, "block");
  assertBlockedWith(tampered, "output.gate_unavailable");

  const nullResult = runOutputGateSafely(base, () => null as unknown as OutputGateResult);
  assert.equal(nullResult.decision, "block");

  // The fail-closed trace still carries the policy version and reason (AC 3).
  assert.equal(throwingGate.trace.policyVersion, "1.0");
  assert.deepEqual({ ...throwingGate.trace.refs }, { traceId: "trc_abcd1234efgh" });
});

test("output gate results never echo the flagged content", () => {
  const canary = "sk-canary1234567890abcdef";
  const result = evaluateOutputGate({ content: `密钥在这里 ${canary}` });
  assert.equal(result.decision, "block");
  assert.ok(!JSON.stringify(result).includes("CANARY"), "flagged content must not be echoed");
});

test("AC 2: a shape-legal but semantically tampered gate result fails closed (review P1-2)", () => {
  const base = { content: "[synthetic] 一条普通的回复", refs: { traceId: "trc_abcd1234efgh" } };

  // A tampered gate returning a legal allow decision with a garbage trace
  // object: the wrapper must neither release it nor let the trace object
  // ride into the audit pipeline.
  const smuggled = runOutputGateSafely(
    base,
    () => ({ decision: "allow", hits: [], trace: { smuggled: "raw sensitive content" } }) as unknown as OutputGateResult,
  );
  assert.equal(smuggled.decision, "block");
  assertBlockedWith(smuggled, "output.gate_unavailable");
  assert.ok(!JSON.stringify(smuggled).includes("smuggled"), "tampered trace must not survive");

  // A well-formed trace whose decision disagrees with the returned decision.
  const disagreeing = runOutputGateSafely(base, () => ({
    decision: "allow",
    hits: [],
    trace: buildSafetyTrace({
      layer: "output",
      decision: "block",
      ruleIds: ["output.data_leak"],
      reason: "rule_hit",
      refs: { traceId: "trc_abcd1234efgh" },
      decidedAt: "2026-10-13T12:00:00.000Z",
    }),
  }) as unknown as OutputGateResult);
  assert.equal(disagreeing.decision, "block");
  assertBlockedWith(disagreeing, "output.gate_unavailable");

  // An allow decision carrying hits (inconsistent decision state).
  const allowWithHits = runOutputGateSafely(base, () => ({
    decision: "allow",
    hits: [{ ruleId: "output.data_leak", layer: "output", severity: "high" }],
    trace: buildSafetyTrace({
      layer: "output",
      decision: "allow",
      ruleIds: [],
      reason: "rule_hit",
      decidedAt: "2026-10-13T12:00:00.000Z",
    }),
  }) as unknown as OutputGateResult);
  assert.equal(allowWithHits.decision, "block");
  assertBlockedWith(allowWithHits, "output.gate_unavailable");

  // Hits and trace reference different rule sets.
  const mismatchedSets = runOutputGateSafely(base, () => ({
    decision: "block",
    hits: [{ ruleId: "output.data_leak", layer: "output", severity: "high" }],
    trace: buildSafetyTrace({
      layer: "output",
      decision: "block",
      ruleIds: ["output.secrecy_pressure"],
      reason: "rule_hit",
      decidedAt: "2026-10-13T12:00:00.000Z",
    }),
  }) as unknown as OutputGateResult);
  assert.equal(mismatchedSets.decision, "block");
  assertBlockedWith(mismatchedSets, "output.gate_unavailable");

  // A hit entry that is not a structured hit.
  const unstructuredHit = runOutputGateSafely(base, () => ({
    decision: "block",
    hits: ["output.data_leak"],
    trace: buildSafetyTrace({
      layer: "output",
      decision: "block",
      ruleIds: ["output.data_leak"],
      reason: "rule_hit",
      decidedAt: "2026-10-13T12:00:00.000Z",
    }),
  }) as unknown as OutputGateResult);
  assert.equal(unstructuredHit.decision, "block");
  assertBlockedWith(unstructuredHit, "output.gate_unavailable");

  // Control: a legitimate gate result is preserved (decision + validated trace).
  const legit = runOutputGateSafely(base, (gateInput) => evaluateOutputGate(gateInput));
  assert.equal(legit.decision, "allow");
  assert.deepEqual([...legit.trace.ruleIds], []);
  assert.equal(legit.trace.policyVersion, "1.0");
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(legit)));
});

test("AC 2: the wrapper fallback never throws on invalid refs/entrance (review P2-1)", () => {
  const invalidRefs = {
    content: "[synthetic] ok",
    refs: { requestId: "not-a-valid-id" },
  } as OutputGateInput;
  let degraded: OutputGateResult | undefined;
  try {
    degraded = runOutputGateSafely(invalidRefs, () => {
      throw new Error("simulated gate outage");
    });
  } catch (error) {
    assert.fail(`the wrapper must never rethrow, got: ${String(error)}`);
  }
  assert.equal(degraded.decision, "block");
  assertBlockedWith(degraded, "output.gate_unavailable");
  assert.equal(degraded.trace.reason, "gate_unavailable");
  assert.deepEqual({ ...degraded.trace.refs }, {}, "degraded trace carries no invalid refs");
  assert.equal(degraded.trace.entrance, undefined);

  // A gate that fails on the invalid input lands on the same degrade path.
  const gateThrowsOnBadInput = runOutputGateSafely(invalidRefs);
  assert.equal(gateThrowsOnBadInput.decision, "block");
  assertBlockedWith(gateThrowsOnBadInput, "output.gate_unavailable");

  // An invalid entrance degrades the same way instead of throwing.
  const invalidEntrance = runOutputGateSafely(
    { content: "[synthetic] ok", entrance: "not_an_entrance" } as unknown as OutputGateInput,
    () => {
      throw new Error("simulated gate outage");
    },
  );
  assert.equal(invalidEntrance.decision, "block");
  assertBlockedWith(invalidEntrance, "output.gate_unavailable");
});

test("ownChildRef invalid values fail closed (review test gap 4)", () => {
  assert.throws(
    () => evaluateOutputGate({ content: "[synthetic] ok", ownChildRef: "" }),
    ContractValidationError,
    "empty ownChildRef must throw",
  );
  assert.throws(
    () => evaluateOutputGate({ content: "[synthetic] ok", ownChildRef: 42 as unknown as string }),
    ContractValidationError,
    "non-string ownChildRef must throw",
  );
});
