import assert from "node:assert/strict";
import test from "node:test";

import { ContractValidationError } from "../../../lib/domain/contract/core.ts";
import {
  EVAL_SKILL_IDS,
  EVAL_SUITE_V1,
  parseEvalEvidenceRegistry,
} from "../../../lib/domain/eval/index.ts";
import {
  EVIDENCE_REGISTRY_V0,
  SKILL_REGISTRY_V0,
  assertShippedRegistriesAlignedWithEvalSuite,
  loadSkillForChild,
  publishEvidenceCardVersion,
  publishSkillManifest,
  resolveEvidenceCard,
  resolveSkillManifest,
  rollbackEvidenceCard,
  rollbackSkillManifest,
  registryStatesAreEquivalent,
  toEvalEvidenceCardView,
  validateRegistriesAgainstEvalSuite,
  type EvidenceCardV0,
  type EvidenceRegistryV0,
  type SkillLoadResult,
  type SkillManifestV0,
  type SkillRegistryV0,
} from "../../../lib/domain/evidence/index.ts";

/**
 * R1-13 Skill Registry v0 semantics (issue #25):
 *
 * - AC 1: unknown evidence id, unapproved evidence, version drift, citation
 *   invalidation and age/scenario inapplicability each produce load
 *   rejection or controlled degradation — never a silent serve;
 * - AC 2: a served strategy carries its source version and 适用/限制; a
 *   human revision flows into eval regression via the alignment checks that
 *   run in the same CI test pass as the eval suite itself;
 * - prototype-chain ids ("constructor"/"toString"/...) can never masquerade
 *   as registered entries (hasOwn lookups only).
 */

/** A structurally valid v0 card for publish/rollback scenarios. */
function baseCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    cardId: "evd_eef_sel_primary_001",
    version: "2.0.0",
    citation: {
      sourceUrl:
        "https://educationendowmentfoundation.org.uk/education-evidence/guidance-reports/primary-sel",
      title: "Test guidance title",
      publisher: "Test publisher",
      year: 2025,
    },
    researchDesign: "guidance_synthesis",
    evidenceLevel: "moderate",
    targetAges: { minAgeYears: 4, maxAgeYears: 11 },
    subjectsAndContext: "Test subjects and context description.",
    claimedEffects: "Test guidance-level effect summary; no AI-efficacy claim.",
    limitations: ["Revised test limitation."],
    applicableConditions: ["Test applicable condition."],
    exclusionConditions: ["Test exclusion condition."],
    aiTransferBoundary: "school_practice_only",
    appliesToSkills: ["emotion_support"],
    sourceStatus: "live",
    updatedAt: "2026-10-14",
    review: { status: "approved", reviewedBy: "test-reviewer", reviewedAt: "2026-10-14" },
    summary: "Revised card summary for the eval view.",
    ...overrides,
  };
}

/** A structurally valid v0 manifest for publish scenarios. */
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

// ---------------------------------------------------------------------------
// Shipped registries (issue #25: 双 Skill 均绑定已核验证据卡)
// ---------------------------------------------------------------------------

test("shipped registries align with the eval suite (human revision ⇒ CI regression)", () => {
  assert.doesNotThrow(() => assertShippedRegistriesAlignedWithEvalSuite());
  assert.deepEqual(validateRegistriesAgainstEvalSuite(EVAL_SUITE_V1), []);
});

test("the skill registry covers exactly the first-party skill ids", () => {
  assert.deepEqual(Object.keys(SKILL_REGISTRY_V0.skills).sort(), [...EVAL_SKILL_IDS].sort());
});

test("both skills bind exactly one approved, live card and pin its version", () => {
  for (const skillId of Object.keys(SKILL_REGISTRY_V0.skills)) {
    const entry = SKILL_REGISTRY_V0.skills[skillId];
    const manifest = entry.versions[entry.activeVersion];
    assert.equal(manifest.review.status, "approved");
    assert.equal(manifest.toolCapabilities.length, 0, "v0 skills advertise no tools (least privilege)");
    assert.ok(manifest.disabledConditions.length > 0, "禁忌 conditions are mandatory");
    assert.ok(manifest.exitPaths.length > 0, "child exit paths are mandatory");
    for (const binding of manifest.evidenceBindings) {
      const resolution = resolveEvidenceCard(EVIDENCE_REGISTRY_V0, binding.cardId, binding.cardVersion);
      assert.equal(resolution.status, "loaded");
      if (resolution.status === "loaded") {
        assert.equal(resolution.card.version, binding.cardVersion);
        assert.equal(resolution.card.review.status, "approved");
        assert.equal(resolution.card.sourceStatus, "live");
        assert.ok(resolution.card.appliesToSkills.includes(manifest.skillId));
      }
    }
  }
});

test("the eval card view of a shipped card projects into the eval registry contract", () => {
  const entry = EVIDENCE_REGISTRY_V0.cards["evd_eef_sel_primary_001"];
  const view = toEvalEvidenceCardView(entry.versions[entry.activeVersion]);
  assert.equal(view.evidenceId, "evd_eef_sel_primary_001");
  assert.equal(view.reviewed, true);
  assert.deepEqual([...view.appliesToSkills], ["emotion_support"]);
  // The projection must satisfy the R1-07 eval evidence registry parser.
  assert.doesNotThrow(() => parseEvalEvidenceRegistry({ [view.evidenceId]: view }));
});

// ---------------------------------------------------------------------------
// Loader: served / degraded / rejected (issue #25 AC 1)
// ---------------------------------------------------------------------------

test("a served skill carries its source version and 适用/限制 (issue #25 AC 2)", () => {
  const served = loadSkillForChild("emotion_support", 8);
  assert.equal(served.status, "served");
  if (served.status === "served") {
    assert.equal(served.skillId, "emotion_support");
    assert.equal(served.skillVersion, "1.0.0");
    assert.equal(served.evidence.length, 1);
    assert.equal(served.evidence[0].cardId, "evd_eef_sel_primary_001");
    assert.equal(served.evidence[0].cardVersion, "1.0.0");
    assert.equal(served.evidence[0].card.citation.title, "Improving Social and Emotional Learning in Primary Schools");
    assert.equal(served.evidence[0].card.aiTransferBoundary, "school_practice_only");
    assert.ok(served.limitations.length > 0);
    assert.ok(
      served.limitations.every((limitation) => limitation.includes("AI agent") || limitation.length > 0),
    );
  }

  const homework = loadSkillForChild("homework_initiation", 10);
  assert.equal(homework.status, "served");
  if (homework.status === "served") {
    assert.equal(homework.evidence[0].cardId, "evd_eef_meta_srl_001");
    assert.equal(homework.evidence[0].cardVersion, "1.0.0");
  }
});

test("age bounds of the bound card are inclusive (served) or degrade in a controlled way", () => {
  // SEL card covers 4..11 inclusive.
  for (const age of [4, 11]) {
    assert.equal(loadSkillForChild("emotion_support", age).status, "served");
  }
  const tooOld = loadSkillForChild("emotion_support", 15);
  assert.equal(tooOld.status, "degraded");
  if (tooOld.status === "degraded") {
    assert.equal(tooOld.reason, "age_not_applicable");
    assert.deepEqual([...tooOld.detail], [
      { cardId: "evd_eef_sel_primary_001", cardVersion: "1.0.0", minAgeYears: 4, maxAgeYears: 11 },
    ]);
  }
  const tooYoung = loadSkillForChild("emotion_support", 3);
  assert.equal(tooYoung.status, "degraded");
  // The homework card covers 5..16: age 15 stays served for homework.
  assert.equal(loadSkillForChild("homework_initiation", 15).status, "served");
  assert.equal(loadSkillForChild("homework_initiation", 4).status, "degraded");
});

test("unknown skills and malformed ages fail closed", () => {
  const unknown = loadSkillForChild("nonexistent_skill", 8);
  assert.equal(unknown.status, "rejected");
  if (unknown.status === "rejected") {
    assert.equal(unknown.reason, "unknown_skill");
  }
  assert.equal(loadSkillForChild(null, 8).status, "rejected");
  assert.equal(loadSkillForChild(undefined, 8).status, "rejected");
  assert.equal(loadSkillForChild({}, 8).status, "rejected");
  for (const badAge of ["8", 8.5, -1, 30, null, Number.NaN]) {
    assert.throws(() => loadSkillForChild("emotion_support", badAge), ContractValidationError);
  }
});

test("prototype-chain ids can never masquerade as registered entries", () => {
  for (const crafted of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
    const resolution = resolveEvidenceCard(EVIDENCE_REGISTRY_V0, crafted);
    assert.equal(resolution.status, "rejected", `evidence id ${crafted} must not resolve`);
    assert.equal(loadSkillForChild(crafted, 8).status, "rejected");
  }
  assert.equal(resolveSkillManifest(SKILL_REGISTRY_V0, "constructor").status, "rejected");
});

test("unapproved skills are rejected by the publish-gate check at load time", () => {
  const entry = SKILL_REGISTRY_V0.skills["emotion_support"];
  const pendingManifest = {
    ...entry.versions["1.0.0"],
    review: { status: "pending" as const },
  };
  const skills: SkillRegistryV0 = {
    ...SKILL_REGISTRY_V0,
    skills: {
      ...SKILL_REGISTRY_V0.skills,
      emotion_support: { activeVersion: "1.0.0", versions: { "1.0.0": pendingManifest } },
    },
  };
  const result = loadSkillForChild("emotion_support", 8, { skills, evidence: EVIDENCE_REGISTRY_V0 });
  assert.equal(result.status, "rejected");
  if (result.status === "rejected") {
    assert.equal(result.reason, "skill_not_approved");
  }
});

test("unknown evidence id / version drift / unapproved / retracted each reject distinctly", () => {
  // unknown card
  const noCardRegistry: EvidenceRegistryV0 = {
    ...EVIDENCE_REGISTRY_V0,
    cards: Object.fromEntries(Object.entries(EVIDENCE_REGISTRY_V0.cards).filter(([id]) => id !== "evd_eef_sel_primary_001")),
  };
  const unknownCard = loadSkillForChild("emotion_support", 8, { skills: SKILL_REGISTRY_V0, evidence: noCardRegistry });
  assert.equal(unknownCard.status, "rejected");
  if (unknownCard.status === "rejected") assert.equal(unknownCard.reason, "evidence_unknown_card");

  // version drift: the manifest pins a version the registry does not have
  const driftedEntry = SKILL_REGISTRY_V0.skills["emotion_support"];
  const driftedManifest = {
    ...driftedEntry.versions["1.0.0"],
    evidenceBindings: [{ cardId: "evd_eef_sel_primary_001", cardVersion: "9.9.9" }],
  };
  const driftedSkills: SkillRegistryV0 = {
    ...SKILL_REGISTRY_V0,
    skills: {
      ...SKILL_REGISTRY_V0.skills,
      emotion_support: { activeVersion: "1.0.0", versions: { "1.0.0": driftedManifest } },
    },
  };
  const drifted = loadSkillForChild("emotion_support", 8, { skills: driftedSkills, evidence: EVIDENCE_REGISTRY_V0 });
  assert.equal(drifted.status, "rejected");
  if (drifted.status === "rejected") assert.equal(drifted.reason, "evidence_version_drift");

  // unapproved card version registered directly in the registry
  const pendingCard = { ...baseCard({ version: "1.0.0" }), review: { status: "pending" } } as unknown as Readonly<EvidenceCardV0>;
  const pendingSkills = SKILL_REGISTRY_V0;
  const pendingEvidence: EvidenceRegistryV0 = {
    ...EVIDENCE_REGISTRY_V0,
    cards: {
      ...EVIDENCE_REGISTRY_V0.cards,
      evd_eef_sel_primary_001: { activeVersion: "1.0.0", versions: { "1.0.0": pendingCard } },
    },
  };
  const unapproved = loadSkillForChild("emotion_support", 8, { skills: pendingSkills, evidence: pendingEvidence });
  assert.equal(unapproved.status, "rejected");
  if (unapproved.status === "rejected") assert.equal(unapproved.reason, "evidence_not_approved");

  // retracted citation (引用失效)
  const retractedCard = baseCard({ version: "1.0.0", sourceStatus: "retracted" }) as unknown as Readonly<EvidenceCardV0>;
  const retractedEvidence: EvidenceRegistryV0 = {
    ...EVIDENCE_REGISTRY_V0,
    cards: {
      ...EVIDENCE_REGISTRY_V0.cards,
      evd_eef_sel_primary_001: { activeVersion: "1.0.0", versions: { "1.0.0": retractedCard } },
    },
  };
  const retracted = loadSkillForChild("emotion_support", 8, { skills: SKILL_REGISTRY_V0, evidence: retractedEvidence });
  assert.equal(retracted.status, "rejected");
  if (retracted.status === "rejected") assert.equal(retracted.reason, "evidence_source_retracted");
});

// ---------------------------------------------------------------------------
// Publish gate (explicit human review) and reproducible rollback
// ---------------------------------------------------------------------------

test("publish requires the explicit human-review gate and a strictly increasing version", () => {
  const pending = publishEvidenceCardVersion(EVIDENCE_REGISTRY_V0, baseCard({ review: { status: "pending" } }));
  assert.equal(pending.ok, false);
  if (!pending.ok) assert.equal(pending.reason, "review_not_approved");

  const same = publishEvidenceCardVersion(EVIDENCE_REGISTRY_V0, baseCard({ version: "1.0.0", cardId: "evd_eef_meta_srl_001" }));
  assert.equal(same.ok, false);
  if (!same.ok) assert.equal(same.reason, "already_registered");

  const backwards = publishEvidenceCardVersion(EVIDENCE_REGISTRY_V0, baseCard({ version: "0.9.0", cardId: "evd_eef_meta_srl_001" }));
  assert.equal(backwards.ok, false);
  if (!backwards.ok) assert.equal(backwards.reason, "version_not_increasing");

  const invalid = publishEvidenceCardVersion(EVIDENCE_REGISTRY_V0, baseCard({ version: "not-semver" }));
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.reason, "invalid_card");
});

test("an approved revision publishes immutably and loads (human revision path)", () => {
  const revised = baseCard({ version: "2.0.0", summary: "Revised after human re-review." });
  const result = publishEvidenceCardVersion(EVIDENCE_REGISTRY_V0, revised);
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.publishedVersion, "2.0.0");
  // The original registry is untouched; the new one carries both versions.
  assert.equal(Object.keys(EVIDENCE_REGISTRY_V0.cards["evd_eef_sel_primary_001"].versions).length, 1);
  assert.equal(Object.keys(result.registry.cards["evd_eef_sel_primary_001"].versions).length, 2);
  assert.equal(result.registry.cards["evd_eef_sel_primary_001"].activeVersion, "2.0.0");
  assert.ok(Object.isFrozen(result.registry));
  // Loaders resolve the new active version.
  const resolution = resolveEvidenceCard(result.registry, "evd_eef_sel_primary_001");
  assert.equal(resolution.status, "loaded");
  if (resolution.status === "loaded") {
    assert.equal(resolution.card.version, "2.0.0");
    assert.equal(resolution.card.summary, "Revised after human re-review.");
  }
});

test("rollback restores a previous approved version deterministically and reversibly", () => {
  const revised = publishEvidenceCardVersion(EVIDENCE_REGISTRY_V0, baseCard({ version: "2.0.0" }));
  assert.ok(revised.ok);
  if (!revised.ok) return;
  const rolled = rollbackEvidenceCard(revised.registry, "evd_eef_sel_primary_001", "1.0.0");
  assert.ok(rolled.ok);
  if (!rolled.ok) return;
  assert.equal(rolled.activeVersion, "1.0.0");
  assert.equal(rolled.registry.cards["evd_eef_sel_primary_001"].activeVersion, "1.0.0");
  // Versions are never deleted: both stay registered.
  assert.equal(Object.keys(rolled.registry.cards["evd_eef_sel_primary_001"].versions).length, 2);
  // Resolution is restored: loaders resolve the rolled-back version again.
  const resolution = resolveEvidenceCard(rolled.registry, "evd_eef_sel_primary_001");
  assert.equal(resolution.status, "loaded");
  if (resolution.status === "loaded") {
    assert.equal(resolution.card.version, "1.0.0");
  }
  // Re-publishing the SAME version is rejected (no duplicate versions
  // accumulate), while a further strictly-increasing revision still publishes.
  assert.equal(publishEvidenceCardVersion(rolled.registry, baseCard({ version: "2.0.0" })).ok, false);
  const further = publishEvidenceCardVersion(rolled.registry, baseCard({ version: "3.0.0" }));
  assert.ok(further.ok);
  if (further.ok) {
    assert.equal(further.registry.cards["evd_eef_sel_primary_001"].activeVersion, "3.0.0");
  }
  // Rollback rejects unknown cards/versions and non-approved targets.
  assert.equal(rollbackEvidenceCard(revised.registry, "evd_unknown_card", "1.0.0").ok, false);
  assert.equal(rollbackEvidenceCard(revised.registry, "evd_eef_sel_primary_001", "7.7.7").ok, false);
});

test("citation invalidation fail-closes loading and rollback recovers service", () => {
  const retracted = publishEvidenceCardVersion(
    EVIDENCE_REGISTRY_V0,
    baseCard({ version: "2.0.0", sourceStatus: "retracted" }),
  );
  assert.ok(retracted.ok);
  if (!retracted.ok) return;
  const blocked = loadSkillForChild("emotion_support", 8, { skills: SKILL_REGISTRY_V0, evidence: retracted.registry });
  assert.equal(blocked.status, "rejected");
  if (blocked.status === "rejected") {
    assert.equal(blocked.reason, "evidence_source_retracted");
    assert.deepEqual([...blocked.detail], ["evd_eef_sel_primary_001"]);
  }
  const recovered = rollbackEvidenceCard(retracted.registry, "evd_eef_sel_primary_001", "1.0.0");
  assert.ok(recovered.ok);
  if (recovered.ok) {
    const served = loadSkillForChild("emotion_support", 8, { skills: SKILL_REGISTRY_V0, evidence: recovered.registry });
    assert.equal(served.status, "served");
  }
  // A retracted version itself can never become a rollback target.
  assert.equal(rollbackEvidenceCard(EVIDENCE_REGISTRY_V0, "evd_eef_sel_primary_001", "2.0.0").ok, false);
});

test("skill publish verifies tools, bindings and the human-review gate", () => {
  const unapproved = publishSkillManifest(SKILL_REGISTRY_V0, EVIDENCE_REGISTRY_V0, baseManifest({ review: { status: "pending" } }));
  assert.equal(unapproved.ok, false);
  if (!unapproved.ok) assert.equal(unapproved.reason, "review_not_approved");

  const same = publishSkillManifest(SKILL_REGISTRY_V0, EVIDENCE_REGISTRY_V0, baseManifest({ version: "1.0.0" }));
  assert.equal(same.ok, false);
  if (!same.ok) assert.equal(same.reason, "already_registered");

  const unregisteredTool = publishSkillManifest(
    SKILL_REGISTRY_V0,
    EVIDENCE_REGISTRY_V0,
    baseManifest({ toolCapabilities: ["fs.write_file"] }),
  );
  assert.equal(unregisteredTool.ok, false);
  if (!unregisteredTool.ok) assert.equal(unregisteredTool.reason, "tool_not_registered");

  const unknownBinding = publishSkillManifest(
    SKILL_REGISTRY_V0,
    EVIDENCE_REGISTRY_V0,
    baseManifest({ evidenceBindings: [{ cardId: "evd_does_not_exist_001", cardVersion: "1.0.0" }] }),
  );
  assert.equal(unknownBinding.ok, false);
  if (!unknownBinding.ok) assert.equal(unknownBinding.reason, "binding_unresolved");

  const ok = publishSkillManifest(SKILL_REGISTRY_V0, EVIDENCE_REGISTRY_V0, baseManifest());
  assert.ok(ok);
  if (ok.ok) {
    assert.equal(ok.registry.skills["emotion_support"].activeVersion, "2.0.0");
  }
  // Rollback to the already-active version is a legal no-op (registered + approved);
  // an unknown version is rejected.
  const rolled = rollbackSkillManifest(SKILL_REGISTRY_V0, "emotion_support", "1.0.0");
  assert.ok(rolled.ok);
  if (rolled.ok) {
    assert.equal(rolled.activeVersion, "1.0.0");
  }
  assert.equal(rollbackSkillManifest(SKILL_REGISTRY_V0, "emotion_support", "9.9.9").ok, false);
  if (ok.ok) {
    const back = rollbackSkillManifest(ok.registry, "emotion_support", "1.0.0");
    assert.ok(back.ok);
    if (back.ok) {
      assert.equal(back.registry.skills["emotion_support"].activeVersion, "1.0.0");
    }
  }
});

test("publish/rollback is pure and reproducible across independent runs", () => {
  const runOnce = () => {
    const published = publishEvidenceCardVersion(EVIDENCE_REGISTRY_V0, baseCard({ version: "2.0.0" }));
    if (!published.ok) {
      return null;
    }
    const rolled = rollbackEvidenceCard(published.registry, "evd_eef_sel_primary_001", "1.0.0");
    return rolled.ok ? rolled.registry : null;
  };
  const first = runOnce();
  const second = runOnce();
  assert.ok(first !== null && second !== null);
  if (first !== null && second !== null) {
    assert.ok(registryStatesAreEquivalent(first, second));
  }
});

// ---------------------------------------------------------------------------
// Alignment negative controls (each check must be able to fire)
// ---------------------------------------------------------------------------

test("alignment fires on a suite/registry disagreement for a shared evidence id", () => {
  const mutatedSuite = {
    ...EVAL_SUITE_V1,
    evidence: {
      ...EVAL_SUITE_V1.evidence,
      evd_eef_sel_primary_001: {
        evidenceId: "evd_eef_sel_primary_001",
        reviewed: false,
        appliesToSkills: ["emotion_support"] as const,
        summary: "A conflicting summary.",
      },
    },
  };
  const problems = validateRegistriesAgainstEvalSuite(mutatedSuite);
  assert.ok(problems.some((entry) => entry.code === "suite_evidence_status_conflict"));
});

test("alignment fires on unknown evaluation refs, unregistered tools and broken bindings", () => {
  const badManifest = baseManifest({
    evaluationRefs: ["emotion.applicable.does-not-exist-999"],
    toolCapabilities: ["fs.write_file"],
    evidenceBindings: [{ cardId: "evd_gone_001", cardVersion: "1.0.0" }],
  }) as unknown as Readonly<SkillManifestV0>;
  const skills: SkillRegistryV0 = {
    ...SKILL_REGISTRY_V0,
    skills: {
      ...SKILL_REGISTRY_V0.skills,
      emotion_support: { activeVersion: "2.0.0", versions: { "2.0.0": badManifest, "1.0.0": SKILL_REGISTRY_V0.skills["emotion_support"].versions["1.0.0"] } },
    },
  };
  const problems = validateRegistriesAgainstEvalSuite(EVAL_SUITE_V1, { skills, evidence: EVIDENCE_REGISTRY_V0 });
  assert.ok(problems.some((entry) => entry.code === "evaluation_ref_unknown_scenario"));
  assert.ok(problems.some((entry) => entry.code === "skill_tools_unregistered"));
  assert.ok(problems.some((entry) => entry.code === "skill_binding_unresolved"));
});

test("alignment fires when the skill set drifts from the first-party ids", () => {
  const reducedSkills: SkillRegistryV0 = {
    ...SKILL_REGISTRY_V0,
    skills: { emotion_support: SKILL_REGISTRY_V0.skills["emotion_support"] },
  };
  const problems = validateRegistriesAgainstEvalSuite(EVAL_SUITE_V1, { skills: reducedSkills, evidence: EVIDENCE_REGISTRY_V0 });
  assert.ok(problems.some((entry) => entry.code === "skill_id_mismatch"));
});

test("alignment fires when registry content is corrupt", () => {
  const corruptCard = baseCard({ version: "1.0.0", sourceStatus: "mysteriously_unknown" }) as unknown as Readonly<EvidenceCardV0>;
  const corruptEvidence: EvidenceRegistryV0 = {
    ...EVIDENCE_REGISTRY_V0,
    cards: {
      ...EVIDENCE_REGISTRY_V0.cards,
      evd_eef_sel_primary_001: { activeVersion: "1.0.0", versions: { "1.0.0": corruptCard } },
    },
  };
  const problems = validateRegistriesAgainstEvalSuite(EVAL_SUITE_V1, { skills: SKILL_REGISTRY_V0, evidence: corruptEvidence });
  assert.ok(problems.some((entry) => entry.code === "registry_content_invalid"));
});

test("loadSkillForChild results are fully frozen structural data", () => {
  const result: SkillLoadResult = loadSkillForChild("emotion_support", 8);
  assert.ok(Object.isFrozen(result));
  if (result.status === "served") {
    assert.ok(Object.isFrozen(result.limitations));
    assert.ok(Object.isFrozen(result.evidence));
  }
});
