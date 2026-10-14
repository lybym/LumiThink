import assert from "node:assert/strict";
import test from "node:test";

import { ContractValidationError } from "../../../lib/domain/contract/core.ts";
import {
  EVAL_ASSERTION_IDS,
  EVAL_SKILL_IDS,
  EVAL_SKILL_BRANCHES,
  EVAL_SUITE_V1,
  parseEvalEvidenceRegistry,
  parseEvalScenario,
  parseEvalSuite,
} from "../../../lib/domain/eval/index.ts";

/**
 * R1-07 fixture integrity (issue #19 AC 1): the shipped suite must cover
 * both first-party skills across applicable / not-applicable / policy-invalid
 * / refusal / crisis branches plus tool privilege escalation, every scenario
 * carrying explicit deterministic assertions. Parsing itself must fail
 * closed on malformed scenarios.
 */

const SUITE = parseEvalSuite(EVAL_SUITE_V1);

function scenarioBranch(scenarioId: string): string {
  const segments = scenarioId.split(".");
  assert.ok(segments.length >= 3, `scenario id ${scenarioId} must be <skill>.<branch>.<name>`);
  return segments[1].replace(/-/g, "_");
}

test("the shipped suite parses and its scenario ids are unique", () => {
  assert.equal(SUITE.suiteId, "lumithink_eval_suite");
  assert.equal(SUITE.suiteVersion, "1.2.0");
  assert.ok(SUITE.scenarios.length >= 17, "the shipped matrix must not silently shrink");
  const ids = SUITE.scenarios.map((scenario) => scenario.scenarioId);
  assert.equal(new Set(ids).size, ids.length, "scenario ids must be unique");
});

test("AC 1: both skills cover all five required branches", () => {
  for (const skill of EVAL_SKILL_IDS) {
    const branches = new Set(
      SUITE.scenarios
        .filter((scenario) => scenario.skill === skill)
        .map((scenario) => scenarioBranch(scenario.scenarioId)),
    );
    for (const branch of EVAL_SKILL_BRANCHES) {
      assert.ok(
        branches.has(branch),
        `skill ${skill} must cover branch ${branch} (issue #19 AC 1)`,
      );
    }
  }
});

test("AC 1: tool privilege escalation scenarios exist with explicit assertions", () => {
  const toolScenarios = SUITE.scenarios.filter((scenario) => scenario.category === "tool_escalation");
  assert.ok(toolScenarios.length >= 3, "at least unregistered / permission / privacy escalations");
  for (const scenario of toolScenarios) {
    assert.equal(scenario.critical, true);
    assert.equal(scenario.safetyCritical, true);
    assert.ok(scenario.gateProbe, "tool escalation must run the real tool gate");
    assert.deepEqual(scenario.gateProbe?.expected.decision, "block");
    assert.ok(
      (scenario.expectations.forbiddenActions ?? []).includes("unauthorized_tool_run"),
      "each tool escalation asserts unauthorized_tool_run is never performed",
    );
  }
});

test("every scenario carries at least one explicit deterministic assertion", () => {
  for (const scenario of SUITE.scenarios) {
    const expectationKeys = Object.keys(scenario.expectations);
    assert.ok(expectationKeys.length >= 1, `${scenario.scenarioId} has no expectations`);
    assert.ok(
      expectationKeys.every((key) =>
        (["routedSkill", "forbiddenActions", "requiredEvidence", "forbiddenEvidence", "exitPaths", "gate"] as const).includes(
          key as "routedSkill",
        ),
      ),
    );
    const assertionIds = expectationKeys
      .map((key) =>
        key === "gate" ? "gate" : key === "routedSkill" ? "routing" :
        key === "forbiddenActions" ? "forbidden_actions" :
        key === "requiredEvidence" ? "required_evidence" :
        key === "forbiddenEvidence" ? "forbidden_evidence" : "exit_paths",
      )
      .filter((id): id is (typeof EVAL_ASSERTION_IDS)[number] =>
        (EVAL_ASSERTION_IDS as readonly string[]).includes(id));
    assert.ok(
      assertionIds.every((id) => (EVAL_ASSERTION_IDS as readonly string[]).includes(id)),
      `${scenario.scenarioId} maps every expectation onto a registered assertion`,
    );
  }
});

test("every synthetic text is clearly marked and gate probes reference registered rules", () => {
  for (const scenario of SUITE.scenarios) {
    if (scenario.input.text !== null) {
      assert.ok(
        scenario.input.text.startsWith("[synthetic]"),
        `${scenario.scenarioId} input text must be marked [synthetic]`,
      );
    }
    const probe = scenario.gateProbe;
    if (probe !== undefined) {
      if (probe.interactionText !== undefined && probe.interactionText !== null) {
        assert.ok(probe.interactionText.startsWith("[synthetic]"));
      }
      if (probe.draftOutput !== undefined && probe.draftOutput !== null) {
        assert.ok(probe.draftOutput.startsWith("[synthetic]"));
      }
    }
  }
});

test("required evidence is always known and reviewed; the unreviewed card is never required", () => {
  for (const scenario of SUITE.scenarios) {
    for (const id of scenario.expectations.requiredEvidence ?? []) {
      const card = SUITE.evidence[id];
      assert.ok(card !== undefined, `${scenario.scenarioId} requires unknown evidence ${id}`);
      assert.equal(card.reviewed, true, `${scenario.scenarioId} requires unreviewed evidence ${id}`);
    }
  }
  const unreviewed = Object.values(SUITE.evidence).filter((card) => !card.reviewed);
  assert.equal(unreviewed.length, 1, "exactly one unreviewed card exists for negative controls");
  const unreviewedRequired = SUITE.scenarios.some((scenario) =>
    (scenario.expectations.requiredEvidence ?? []).includes(unreviewed[0].evidenceId),
  );
  assert.equal(unreviewedRequired, false);
});

test("parseEvalScenario rejects unknown fields fail-closed", () => {
  assert.throws(
    () => parseEvalScenario({ ...structuredClone(EVAL_SUITE_V1.scenarios[0]), surprise: true }),
    ContractValidationError,
  );
});

test("parseEvalScenario rejects unregistered enums and malformed ids", () => {
  const base = structuredClone(EVAL_SUITE_V1.scenarios[0]) as Record<string, unknown>;
  assert.throws(() => parseEvalScenario({ ...base, category: "not_a_family" }), ContractValidationError);
  assert.throws(() => parseEvalScenario({ ...base, input: { ...(base.input as object), entrance: "pigeon" } }), ContractValidationError);
  assert.throws(() => parseEvalScenario({ ...base, scenarioId: "Bad Id!" }), ContractValidationError);
  assert.throws(() => parseEvalScenario({ ...base, critical: "yes" }), ContractValidationError);
  assert.throws(
    () =>
      parseEvalScenario({
        ...base,
        expectations: { ...(base.expectations as object), forbiddenActions: ["not_an_action"] },
      }),
    ContractValidationError,
  );
  assert.throws(
    () =>
      parseEvalScenario({
        ...base,
        expectations: { ...(base.expectations as object), exitPaths: ["narnia"] },
      }),
    ContractValidationError,
  );
});

test("parseEvalScenario rejects incomplete or forged gate probes", () => {
  const base = structuredClone(EVAL_SUITE_V1.scenarios[0]) as Record<string, unknown>;
  // A gate probe without its expectation cannot be evaluated.
  assert.throws(
    () => parseEvalScenario({ ...base, gateProbe: { interactionText: "[synthetic] x" } }),
    ContractValidationError,
  );
  // Unknown rule id inside a probe expectation.
  assert.throws(
    () =>
      parseEvalScenario({
        ...base,
        gateProbe: {
          ...(base.gateProbe as object),
          expected: { decision: "allow", expectedRuleIds: ["not.a.rule"] },
        },
      }),
    ContractValidationError,
  );
  // Unknown probe field (would smuggle unvalidated turn inputs).
  assert.throws(
    () =>
      parseEvalScenario({
        ...base,
        gateProbe: { ...(base.gateProbe as object), smuggled: "payload" },
      }),
    ContractValidationError,
  );
  // Unknown probe entrance override.
  assert.throws(
    () =>
      parseEvalScenario({
        ...base,
        gateProbe: { ...(base.gateProbe as object), entrance: "carrier_pigeon" },
      }),
    ContractValidationError,
  );
});

test("parseEvalSuite rejects duplicate scenario ids and broken evidence registries", () => {
  const duplicated = {
    ...structuredClone(SUITE),
    scenarios: [...SUITE.scenarios, SUITE.scenarios[0]],
  };
  assert.throws(() => parseEvalSuite(duplicated), ContractValidationError);

  const brokenEvidence = {
    ...structuredClone(SUITE),
    evidence: { "not a valid id": { evidenceId: "not a valid id", reviewed: true, summary: "x" } },
  };
  assert.throws(() => parseEvalSuite(brokenEvidence), ContractValidationError);
  assert.throws(() => parseEvalEvidenceRegistry(brokenEvidence.evidence), ContractValidationError);
});

test("an empty scenario list is structurally valid so the runner can fail closed on it", () => {
  const empty = parseEvalSuite({ ...structuredClone(SUITE), scenarios: [] });
  assert.equal(empty.scenarios.length, 0);
});
