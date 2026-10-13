import assert from "node:assert/strict";
import test from "node:test";

import {
  EVAL_SKILL_IDS,
} from "../../../lib/domain/eval/index.ts";
import {
  PERSONA_MASKED_REJECTION_ID,
  PERSONA_REGISTRY_V0,
  PERSONA_REGISTRY_V0_VERSION,
  assertShippedPersonaRegistryAligned,
  personaRegistryStatesAreEquivalent,
  publishPersonaPolicy,
  resolveActivePersona,
  resolvePersonaPolicy,
  rollbackPersonaPolicy,
  validatePersonaRegistryAlignment,
  type PersonaPolicyV0,
  type PersonaRegistryV0,
} from "../../../lib/domain/persona/index.ts";
import { ContractValidationError } from "../../../lib/domain/contract/core.ts";

/**
 * R1-04 Persona Registry v0 semantics (issue #16 AC 2: 版本切换可复查且可
 * 回滚；没有未验收的自动自我更新):
 *
 * - resolve fails closed on unknown policy / version drift / unapproved
 *   review, with the no-echo masking contract for unresolved ids;
 * - publish requires the explicit human-review gate and a strictly
 *   increasing semver; rollback repoints the active pointer to a registered
 *   approved version and is reversible (pure functions, no in-place edits);
 * - the shipped registry is a frozen constant — there is no runtime or
 *   self-update path; content changes are code changes.
 */

/** Structurally valid approved v2 policy (publish candidate). */
function approvedV2(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

/** Registry fixture with a pending-review policy version (load gate test). */
function registryWithPendingPolicy(): Readonly<PersonaRegistryV0> {
  const pending = approvedV2({
    version: "2.0.0",
    review: { status: "pending" },
  }) as unknown as PersonaPolicyV0;
  return Object.freeze({
    ...PERSONA_REGISTRY_V0,
    policies: Object.freeze({
      ...PERSONA_REGISTRY_V0.policies,
      lumithink_child_persona: Object.freeze({
        activeVersion: "2.0.0",
        versions: Object.freeze({
          "1.0.0": PERSONA_REGISTRY_V0.policies.lumithink_child_persona.versions["1.0.0"],
          "2.0.0": Object.freeze(pending),
        }),
      }),
    }),
  });
}

test("the shipped persona registry is valid, approved and aligned with the first-party skills", () => {
  assert.equal(PERSONA_REGISTRY_V0.registryId, "lumithink_persona_registry");
  assert.equal(PERSONA_REGISTRY_V0.registryVersion, PERSONA_REGISTRY_V0_VERSION);
  const policy = resolveActivePersona();
  assert.equal(policy.version, "1.0.0");
  assert.equal(policy.review.status, "approved");
  assert.deepEqual([...policy.appliesToSkills].sort(), [...EVAL_SKILL_IDS].sort());
  assertShippedPersonaRegistryAligned();
});

test("the shipped registry is a frozen constant — no runtime self-update path", () => {
  assert.equal(Object.isFrozen(PERSONA_REGISTRY_V0), true);
  assert.throws(() => {
    (PERSONA_REGISTRY_V0 as { policies: unknown }).policies = {};
  }, TypeError);
});

test("resolve fails closed: unknown policy (masked), version drift, unapproved review", () => {
  const masked = resolvePersonaPolicy(PERSONA_REGISTRY_V0, "attacker_controlled_id");
  assert.deepEqual(masked, {
    status: "rejected",
    reason: "unknown_policy",
    policyId: PERSONA_MASKED_REJECTION_ID,
  });

  const drifted = resolvePersonaPolicy(PERSONA_REGISTRY_V0, "lumithink_child_persona", "9.9.9");
  assert.equal(drifted.status, "rejected");
  if (drifted.status === "rejected") {
    assert.equal(drifted.reason, "unknown_version");
    assert.equal(drifted.policyId, "lumithink_child_persona");
  }

  const unapproved = resolvePersonaPolicy(registryWithPendingPolicy(), "lumithink_child_persona");
  assert.equal(unapproved.status, "rejected");
  if (unapproved.status === "rejected") {
    assert.equal(unapproved.reason, "not_approved");
  }

  // Explicit-version load of the still-approved 1.0.0 keeps working while a
  // newer version is pending — version switching is reviewable per version.
  const pinned = resolvePersonaPolicy(registryWithPendingPolicy(), "lumithink_child_persona", "1.0.0");
  assert.equal(pinned.status, "loaded");
});

test("prototype-chain ids can never masquerade as registered policies (hasOwn)", () => {
  for (const id of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    const resolution = resolvePersonaPolicy(PERSONA_REGISTRY_V0, id);
    assert.equal(resolution.status, "rejected");
    if (resolution.status === "rejected") {
      assert.equal(resolution.reason, "unknown_policy");
      assert.equal(resolution.policyId, PERSONA_MASKED_REJECTION_ID);
    }
    const rolled = rollbackPersonaPolicy(PERSONA_REGISTRY_V0, id, "1.0.0");
    assert.equal(rolled.ok, false);
  }
});

test("publish requires approval and a strictly increasing version (pure)", () => {
  const unapproved = publishPersonaPolicy(
    PERSONA_REGISTRY_V0,
    approvedV2({ review: { status: "pending" } }),
  );
  assert.deepEqual(unapproved, { ok: false, reason: "review_not_approved" });

  const invalid = publishPersonaPolicy(PERSONA_REGISTRY_V0, approvedV2({ schemaVersion: "2.0" }));
  if (invalid.ok) {
    assert.fail("invalid policy must not publish");
  } else if (invalid.reason === "invalid_policy") {
    assert.ok(invalid.problems.length > 0);
  } else {
    assert.fail(`unexpected reason: ${invalid.reason}`);
  }

  const notIncreasing = publishPersonaPolicy(
    PERSONA_REGISTRY_V0,
    approvedV2({ version: "1.0.0" }),
  );
  assert.deepEqual(notIncreasing, { ok: false, reason: "already_registered" });

  const backwards = publishPersonaPolicy(
    PERSONA_REGISTRY_V0,
    approvedV2({ version: "0.9.0" }),
  );
  assert.deepEqual(backwards, { ok: false, reason: "version_not_increasing" });

  const unknownPolicy = publishPersonaPolicy(
    PERSONA_REGISTRY_V0,
    approvedV2({ policyId: "rogue_persona" }),
  );
  // The schema gate rejects the unregistered policy id before publish runs.
  if (unknownPolicy.ok) {
    assert.fail("a rogue policy id must not publish");
  }
  assert.equal(unknownPolicy.reason, "invalid_policy");

  // Happy path: publishing switches the active version (reviewable switch).
  const published = publishPersonaPolicy(PERSONA_REGISTRY_V0, approvedV2());
  assert.ok(published.ok);
  if (published.ok) {
    assert.equal(published.publishedVersion, "2.0.0");
    const active = resolveActivePersona(published.registry);
    assert.equal(active.version, "2.0.0");
    // The input registry is never mutated in place.
    assert.equal(resolveActivePersona(PERSONA_REGISTRY_V0).version, "1.0.0");
  }
});

test("rollback repoints to a registered version and is reversible (pure)", () => {
  const published = publishPersonaPolicy(PERSONA_REGISTRY_V0, approvedV2());
  assert.ok(published.ok);
  if (!published.ok) {
    return;
  }

  const rolled = rollbackPersonaPolicy(published.registry, "lumithink_child_persona", "1.0.0");
  assert.ok(rolled.ok);
  if (rolled.ok) {
    assert.equal(rolled.activeVersion, "1.0.0");
    assert.equal(resolveActivePersona(rolled.registry).version, "1.0.0");
    // Rollback of the rollback reproduces the published state byte-for-byte.
    const rolledAgain = rollbackPersonaPolicy(rolled.registry, "lumithink_child_persona", "2.0.0");
    assert.ok(rolledAgain.ok);
    if (rolledAgain.ok) {
      assert.equal(
        personaRegistryStatesAreEquivalent(rolledAgain.registry, published.registry),
        true,
      );
    }
  }

  const unknownVersion = rollbackPersonaPolicy(published.registry, "lumithink_child_persona", "7.7.7");
  assert.deepEqual(unknownVersion, {
    ok: false,
    reason: "unknown_version",
    policyId: "lumithink_child_persona",
  });

  const unknownPolicy = rollbackPersonaPolicy(published.registry, "does_not_exist", "1.0.0");
  assert.deepEqual(unknownPolicy, {
    ok: false,
    reason: "unknown_policy",
    policyId: PERSONA_MASKED_REJECTION_ID,
  });
});

test("the publish → rollback → re-publish cycle is reproducible (registry purity)", () => {
  const first = publishPersonaPolicy(PERSONA_REGISTRY_V0, approvedV2());
  assert.ok(first.ok);
  if (!first.ok) return;
  const rolledBack = rollbackPersonaPolicy(first.registry, "lumithink_child_persona", "1.0.0");
  assert.ok(rolledBack.ok);
  if (!rolledBack.ok) return;
  // Re-publishing the SAME version is rejected: versions are append-only.
  const republished = publishPersonaPolicy(rolledBack.registry, approvedV2());
  assert.ok(!republished.ok);
  assert.equal(
    resolveActivePersona(PERSONA_REGISTRY_V0).version,
    "1.0.0",
    "the shipped registry is untouched by pure publish/rollback operations",
  );
});

test("alignment validation reports coverage drift and corruption fail-closed", () => {
  // A registry whose active policy covers only one skill: the schema rejects
  // the policy at parse time, so alignment reports it as invalid content.
  const broken = JSON.parse(JSON.stringify(PERSONA_REGISTRY_V0)) as {
    policies: Record<string, { versions: Record<string, { appliesToSkills: string[] }> }>;
  };
  broken.policies.lumithink_child_persona.versions["1.0.0"].appliesToSkills = ["emotion_support"];
  const problems = validatePersonaRegistryAlignment(
    broken as unknown as Parameters<typeof validatePersonaRegistryAlignment>[0],
  );
  assert.ok(problems.length > 0);
  assert.ok(
    problems.some(
      (entryProblem) =>
        entryProblem.code === "persona_registry_content_invalid" &&
        entryProblem.message.includes("first-party skill ids"),
    ),
  );

  // Corrupt registry content must be reported, not thrown over.
  const corrupt = JSON.parse(JSON.stringify(PERSONA_REGISTRY_V0)) as {
    policies: Record<string, { versions: Record<string, Record<string, unknown>> }>;
  };
  corrupt.policies.lumithink_child_persona.versions["1.0.0"].version = "not-semver";
  const corruptProblems = validatePersonaRegistryAlignment(
    corrupt as unknown as Parameters<typeof validatePersonaRegistryAlignment>[0],
  );
  assert.ok(
    corruptProblems.some((entryProblem) => entryProblem.code === "persona_registry_content_invalid"),
  );

  // A registry missing the child persona policy entirely is a coverage
  // mismatch (the dedicated alignment code).
  const missing = JSON.parse(JSON.stringify(PERSONA_REGISTRY_V0)) as {
    policies: Record<string, unknown>;
  };
  delete missing.policies.lumithink_child_persona;
  const missingProblems = validatePersonaRegistryAlignment(
    missing as unknown as Parameters<typeof validatePersonaRegistryAlignment>[0],
  );
  assert.ok(
    missingProblems.some((entryProblem) => entryProblem.code === "persona_skill_coverage_mismatch"),
  );
});

test("resolve throws loudly on a corrupted registered policy (defense in depth)", () => {
  const corrupt = JSON.parse(JSON.stringify(PERSONA_REGISTRY_V0)) as {
    policies: Record<string, { versions: Record<string, Record<string, unknown>> }>;
  };
  corrupt.policies.lumithink_child_persona.versions["1.0.0"].relationBoundaries = [
    "relation.no_exclusive_relationship",
  ];
  assert.throws(
    () =>
      resolvePersonaPolicy(
        corrupt as unknown as PersonaRegistryV0,
        "lumithink_child_persona",
      ),
    ContractValidationError,
  );
});
