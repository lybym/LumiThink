import assert from "node:assert/strict";
import test from "node:test";

import { ContractValidationError } from "../../../lib/domain/contract/core.ts";
import { SKILL_REGISTRY_V0, parseSkillManifestV0 } from "../../../lib/domain/evidence/index.ts";

/**
 * R1-13 Skill Manifest v0 schema tests (issue #25 交付范围 1/2): every
 * manifest carries skill_id/version, goal, entrance signals, 适用/禁忌,
 * pinned evidence bindings, strategy steps, tool capabilities, child exit
 * paths and the fixed no-AI-efficacy statement — all fail-closed. There is
 * no self-reported outcome field a subject could abuse.
 */

/** A structurally valid v0 manifest; overrides build negative controls. */
function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    skillId: "emotion_support",
    version: "2.0.0",
    goal: "Test skill goal.",
    entranceSignals: ["child_reports_daily_emotion_distress"],
    applicableConditions: ["Test applicable condition."],
    disabledConditions: ["Test disabled condition."],
    evidenceBindings: [{ cardId: "evd_eef_sel_primary_001", cardVersion: "1.0.0" }],
    strategySteps: ["Test step one.", "Test step two."],
    toolCapabilities: [],
    exitPaths: ["pause_rest"],
    efficacyStatement: "no_ai_efficacy_claim",
    evaluationRefs: ["emotion.applicable.daily-emotion-001"],
    updatedAt: "2026-10-14",
    review: { status: "approved", reviewedBy: "test-reviewer", reviewedAt: "2026-10-14" },
    ...overrides,
  };
}

test("every shipped skill manifest parses fail-closed", () => {
  for (const skillId of Object.keys(SKILL_REGISTRY_V0.skills)) {
    const entry = SKILL_REGISTRY_V0.skills[skillId];
    for (const version of Object.keys(entry.versions)) {
      const manifest = parseSkillManifestV0(entry.versions[version]);
      assert.equal(manifest.skillId, skillId);
      assert.equal(manifest.version, version);
      assert.ok(Object.isFrozen(manifest));
    }
  }
});

test("a structurally valid manifest parses and is frozen", () => {
  const manifest = parseSkillManifestV0(baseManifest());
  assert.equal(manifest.skillId, "emotion_support");
  assert.equal(manifest.efficacyStatement, "no_ai_efficacy_claim");
  assert.ok(Object.isFrozen(manifest));
});

test("unknown fields and unregistered enums fail closed", () => {
  assert.throws(() => parseSkillManifestV0(baseManifest({ sneaky: 1 })), ContractValidationError);
  assert.throws(() => parseSkillManifestV0(baseManifest({ schemaVersion: "2.0" })), ContractValidationError);
  assert.throws(() => parseSkillManifestV0(baseManifest({ skillId: "reading_coach" })), ContractValidationError);
  assert.throws(() => parseSkillManifestV0(baseManifest({ version: "2" })), ContractValidationError);
  assert.throws(() => parseSkillManifestV0(baseManifest({ updatedAt: "not-a-date" })), ContractValidationError);
});

test("the efficacy statement can never register a proven-AI-efficacy claim", () => {
  assert.throws(
    () => parseSkillManifestV0(baseManifest({ efficacyStatement: "ai_efficacy_proven" })),
    ContractValidationError,
  );
});

test("at least one pinned evidence binding and one disabled condition are mandatory", () => {
  assert.throws(() => parseSkillManifestV0(baseManifest({ evidenceBindings: [] })), ContractValidationError);
  assert.throws(
    () => parseSkillManifestV0(baseManifest({ evidenceBindings: [{ cardId: "evd_eef_sel_primary_001" }] })),
    ContractValidationError,
  );
  assert.throws(
    () => parseSkillManifestV0(baseManifest({ evidenceBindings: [{ cardId: "bad id", cardVersion: "1.0.0" }] })),
    ContractValidationError,
  );
  assert.throws(() => parseSkillManifestV0(baseManifest({ disabledConditions: [] })), ContractValidationError);
  assert.throws(() => parseSkillManifestV0(baseManifest({ applicableConditions: [] })), ContractValidationError);
  assert.throws(() => parseSkillManifestV0(baseManifest({ strategySteps: [] })), ContractValidationError);
  assert.throws(() => parseSkillManifestV0(baseManifest({ entranceSignals: [] })), ContractValidationError);
});

test("tool capability ids must match the safety tool-id shape", () => {
  assert.throws(
    () => parseSkillManifestV0(baseManifest({ toolCapabilities: ["Not A Tool"] })),
    ContractValidationError,
  );
  assert.throws(
    () => parseSkillManifestV0(baseManifest({ toolCapabilities: ["x".repeat(100)] })),
    ContractValidationError,
  );
  // Shape-valid ids parse here; membership against SAFE_TOOL_REGISTRY is
  // enforced at registry level (publish + alignment), not schema level.
  const manifest = parseSkillManifestV0(baseManifest({ toolCapabilities: ["evidence.search"] }));
  assert.deepEqual([...manifest.toolCapabilities], ["evidence.search"]);
});

test("exit paths reuse the eval vocabulary and are mandatory", () => {
  assert.throws(() => parseSkillManifestV0(baseManifest({ exitPaths: [] })), ContractValidationError);
  assert.throws(
    () => parseSkillManifestV0(baseManifest({ exitPaths: ["run_away"] })),
    ContractValidationError,
  );
  const manifest = parseSkillManifestV0(baseManifest({ exitPaths: ["pause_rest", "trusted_adult"] }));
  assert.deepEqual([...manifest.exitPaths], ["pause_rest", "trusted_adult"]);
});

test("evaluation refs must be scenario-id shaped and non-empty", () => {
  assert.throws(() => parseSkillManifestV0(baseManifest({ evaluationRefs: [] })), ContractValidationError);
  assert.throws(
    () => parseSkillManifestV0(baseManifest({ evaluationRefs: ["not a scenario id"] })),
    ContractValidationError,
  );
});

test("the human-review gate applies to manifests too", () => {
  assert.throws(
    () => parseSkillManifestV0(baseManifest({ review: { status: "approved" } })),
    ContractValidationError,
  );
});
