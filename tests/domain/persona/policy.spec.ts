import assert from "node:assert/strict";
import test from "node:test";

import {
  PERSONA_CORE_TRAITS,
  PERSONA_IDENTITY_DISCLOSURES,
  PERSONA_RELATION_BOUNDARIES,
  PERSONA_STYLE_KNOBS,
  parsePersonaPolicyV0,
  personaIdentityDisclosureText,
  resolveActivePersona,
  validatePersonaPolicyV0,
  type PersonaPolicyV0,
} from "../../../lib/domain/persona/index.ts";
import { ContractValidationError, type ContractProblem } from "../../../lib/domain/contract/core.ts";

/**
 * R1-04 Persona Policy v0 schema semantics (issue #16 实现范围 1/2/3):
 * fail-closed parsing, non-representable boundary relaxations (complete
 * trait/boundary sets required), four registered style knobs, the
 * trusted-adult exit requirement, and the shared skill rule entry.
 */

/** A structurally valid v0 policy (mirrors the shipped one) for mutation. */
function basePolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    policyId: "lumithink_child_persona",
    version: "2.0.0",
    identityDisclosureId: "ai_companion_disclosed_v1",
    coreTraits: [
      "friendly",
      "honest",
      "curious",
      "autonomy_respecting",
      "ai_identity_disclosed",
      "age_appropriate",
    ],
    relationBoundaries: [
      "relation.no_exclusive_relationship",
      "relation.no_unconditional_secrecy",
      "relation.no_diagnosis_or_therapy",
      "relation.no_parent_teacher_replacement",
      "relation.no_attachment_pressure",
    ],
    adjustableKnobs: ["language_level", "answer_length", "humor", "question_density"],
    defaultStyle: {
      language_level: "simple",
      answer_length: "balanced",
      humor: "light",
      question_density: "medium",
    },
    exitPaths: ["pause_rest", "end_turn", "trusted_adult"],
    appliesToSkills: ["emotion_support", "homework_initiation"],
    language: "zh",
    updatedAt: "2026-10-14",
    review: { status: "approved", reviewedBy: "test-reviewer", reviewedAt: "2026-10-14" },
    ...overrides,
  };
}

/**
 * Assert parsing fails closed AND reports a structured problem matching the
 * given path/message fragments (the thrown error message itself is generic).
 */
function assertPolicyProblem(
  value: unknown,
  match: { path?: string; message?: string },
): void {
  assert.throws(
    () => parsePersonaPolicyV0(value),
    (error: unknown) => {
      assert.ok(error instanceof ContractValidationError);
      const problems = (error as ContractValidationError).problems;
      assert.ok(
        problems.some(
          (entry) =>
            (match.path === undefined || entry.path.includes(match.path)) &&
            (match.message === undefined || entry.message.includes(match.message)),
        ),
        `expected a problem matching ${JSON.stringify(match)}; got ${JSON.stringify(problems)}`,
      );
      return true;
    },
    `parsing must fail closed for ${JSON.stringify(match)}`,
  );
}

test("the shipped persona policy parses and carries the full invariant sets", () => {
  const policy = resolveActivePersona();
  assert.equal(policy.policyId, "lumithink_child_persona");
  assert.equal(policy.version, "1.0.0");
  assert.equal(policy.review.status, "approved");
  assert.deepEqual([...policy.coreTraits].sort(), [...PERSONA_CORE_TRAITS].sort());
  assert.deepEqual([...policy.relationBoundaries].sort(), [...PERSONA_RELATION_BOUNDARIES].sort());
  for (const knob of PERSONA_STYLE_KNOBS) {
    assert.ok(policy.adjustableKnobs.includes(knob), `knob ${knob} must be adjustable in v0`);
  }
  assert.ok(policy.exitPaths.includes("trusted_adult"), "trusted-adult help path is mandatory");
  assert.deepEqual([...policy.appliesToSkills].sort(), ["emotion_support", "homework_initiation"]);
});

test("parse accepts a structurally valid policy revision and freezes it", () => {
  const policy = parsePersonaPolicyV0(basePolicy());
  assert.equal(policy.version, "2.0.0");
  assert.equal(Object.isFrozen(policy), true);
});

test("parse rejects unknown schema versions and unknown fields (fail-closed)", () => {
  assert.throws(
    () => parsePersonaPolicyV0(basePolicy({ schemaVersion: "0.9" })),
    ContractValidationError,
  );
  assert.throws(
    () => parsePersonaPolicyV0(basePolicy({ runtimeTuned: true })),
    ContractValidationError,
  );
});

test("a policy cannot drop a core trait or a relation boundary (non-weakening)", () => {
  const traits = basePolicy();
  traits.coreTraits = [...(traits.coreTraits as string[]).slice(1)];
  assertPolicyProblem(traits, { path: "coreTraits", message: "COMPLETE core-trait registry set" });

  const boundaries = basePolicy();
  boundaries.relationBoundaries = [
    "relation.no_exclusive_relationship",
    "relation.no_unconditional_secrecy",
    "relation.no_diagnosis_or_therapy",
    "relation.no_parent_teacher_replacement",
    // relation.no_attachment_pressure dropped — the schema rejects the policy.
  ];
  assertPolicyProblem(boundaries, {
    path: "relationBoundaries",
    message: "COMPLETE relation-boundary registry set",
  });
});

test("unknown enum values fail closed on every registered field", () => {
  assertPolicyProblem(basePolicy({ identityDisclosureId: "claim_to_be_human" }), {
    path: "identityDisclosureId",
  });
  assertPolicyProblem(basePolicy({ language: "en" }), { path: "language" });
  assertPolicyProblem(basePolicy({ policyId: "attacker_persona" }), { path: "policyId" });
});

test("style defaults must cover every registered knob with registered values only", () => {
  const missing = basePolicy();
  missing.defaultStyle = {
    language_level: "simple",
    answer_length: "balanced",
    humor: "light",
    // question_density missing
  };
  assertPolicyProblem(missing, { path: "defaultStyle.question_density" });

  const extra = basePolicy();
  extra.defaultStyle = {
    language_level: "simple",
    answer_length: "balanced",
    humor: "light",
    question_density: "medium",
    story_degree: "high",
  };
  assertPolicyProblem(extra, { path: "defaultStyle.story_degree" });

  const badValue = basePolicy();
  badValue.defaultStyle = {
    language_level: "simple",
    answer_length: "balanced",
    humor: "sarcastic",
    question_density: "medium",
  };
  assertPolicyProblem(badValue, { path: "defaultStyle.humor" });
});

test("exit paths require the trusted-adult help path (issue #16: 求助现实成年人)", () => {
  const withoutAdult = basePolicy();
  withoutAdult.exitPaths = ["pause_rest", "end_turn"];
  assertPolicyProblem(withoutAdult, { path: "exitPaths", message: "trusted-adult" });

  const empty = basePolicy();
  empty.exitPaths = [];
  assertPolicyProblem(empty, { path: "exitPaths", message: "at least one exit path" });
});

test("the skill rule entry must cover exactly the first-party skills", () => {
  const partial = basePolicy();
  partial.appliesToSkills = ["emotion_support"];
  assertPolicyProblem(partial, {
    path: "appliesToSkills",
    message: "exactly the first-party skill ids",
  });

  const unknown = basePolicy();
  unknown.appliesToSkills = ["emotion_support", "homework_initiation", "reading_coach"];
  assertPolicyProblem(unknown, { path: "appliesToSkills" });
});

test("review records validate; the version must be a semver string", () => {
  const pending = basePolicy();
  pending.review = { status: "pending" };
  const problems: ContractProblem[] = [];
  validatePersonaPolicyV0(pending, problems);
  assert.equal(problems.length, 0, "a pending draft is structurally expressible (approval gates at publish/load)");

  const approvedWithoutReviewer = basePolicy();
  approvedWithoutReviewer.review = { status: "approved" };
  assertPolicyProblem(approvedWithoutReviewer, {
    path: "review",
    message: "reviewer handle",
  });

  assertPolicyProblem(basePolicy({ version: "not-semver" }), { path: "version" });
});

test("identity disclosure text resolves from the registered template only", () => {
  const policy = resolveActivePersona() as Readonly<PersonaPolicyV0>;
  const text = personaIdentityDisclosureText(policy);
  assert.equal(text, PERSONA_IDENTITY_DISCLOSURES.ai_companion_disclosed_v1);
  assert.match(text, /AI/);
  assert.match(text, /不是真人/);

  assert.throws(
    () =>
      personaIdentityDisclosureText({
        identityDisclosureId: "human_impersonation_v9" as never,
      }),
    ContractValidationError,
  );
});
