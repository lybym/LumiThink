import assert from "node:assert/strict";
import test from "node:test";

import {
  compareEvalRuns,
  createSyntheticReferenceSubject,
  parseEvalRunReport,
  runEvaluation,
  serializeEvalRunReport,
} from "../../../lib/domain/eval/index.ts";
import {
  HOMEWORK_SKILL_EVAL_SUITE_ID,
  HOMEWORK_SKILL_EVAL_SUITE_VERSION,
  HOMEWORK_SKILL_EVAL_SUBJECT_ID,
  HOMEWORK_SKILL_EVAL_SUBJECT_VERSION,
  createHomeworkSkillEvalSubject,
  deriveCrisisBranchExits,
  deriveHomeworkObservation,
  deriveHomeworkSkillEvalSuite,
} from "../../../lib/domain/skills/index.ts";
import { loadSkillForChild, SKILL_REGISTRY_V0 } from "../../../lib/domain/evidence/registry.ts";
import { ContractValidationError } from "../../../lib/domain/contract/core.ts";

/**
 * R1-12 homework-skill suite integration (issue #24 AC 1-3; sibling of the
 * R1-11 emotion-skill suite integration):
 *
 * - the homework comparison matrix runs GREEN through the REAL harness
 *   (runEvaluation) against the REAL homework-skill surface, with the
 *   HARNESS §6.4 version stamps merged into the v1.1 report;
 * - the stamps are DERIVED from the manifest's own evidence bindings (R1-11
 *   review P2-3 disposition for this subject: no hardcoded card id);
 * - the crisis-branch exits are re-derived from the REAL deterministic
 *   crisis response and fail closed when that response changes shape
 *   (R1-11 review P2-1 disposition for this subject);
 * - the AC-3 new-vs-old version diff is a real harness comparison: the
 *   synthetic reference baseline and the real-skill current run are
 *   comparable with ZERO regressions and no suite-status transition;
 * - assertion sensitivity is proven by mutation controls: a regressed
 *   skill surface flips the diff to regressions + pass→fail, and a
 *   ghostwriting-offering guideline on the safety-critical ghostwriting
 *   scenario raises the release-blocking safety_failure trigger;
 * - the human review is at least once recorded (registry-approved skill
 *   manifest + card) and its failure limitations are disclosed from the
 *   registry, not invented.
 */

const SUITE = deriveHomeworkSkillEvalSuite();
const SUBJECT = createHomeworkSkillEvalSubject();

test("the homework comparison matrix passes against the real skill surface", () => {
  const report = runEvaluation(SUITE, SUBJECT);
  assert.equal(report.suiteId, HOMEWORK_SKILL_EVAL_SUITE_ID);
  assert.equal(report.suiteVersion, HOMEWORK_SKILL_EVAL_SUITE_VERSION);
  assert.equal(report.subjectId, HOMEWORK_SKILL_EVAL_SUBJECT_ID);
  assert.equal(report.subjectVersion, HOMEWORK_SKILL_EVAL_SUBJECT_VERSION);
  assert.equal(report.status, "pass");
  assert.deepEqual([...report.failClosedTriggers], []);
  assert.deepEqual({ ...report.counts }, { total: 5, pass: 5, fail: 0, skip: 0 });
  for (const scenario of report.scenarios) {
    assert.equal(scenario.status, "pass", `${scenario.scenarioId} must pass`);
    assert.equal(scenario.runtimeError, undefined);
  }
  assert.equal(report.llmJudge.used, false);
});

test("the emotion-first scenario observes the REAL joint_emotion_precedence route", () => {
  const scenario = SUITE.scenarios.find(
    (entry) => entry.scenarioId === "homework.not-applicable.emotion-first-002",
  );
  assert.ok(scenario !== undefined);
  const observation = SUBJECT.observe(scenario);
  assert.equal(observation.routedSkill, "emotion_support");
  assert.deepEqual([...observation.actions], []);
  assert.deepEqual([...observation.citedEvidence], []);
});

test("the v1.1 report merges stamps DERIVED from the manifest's own evidence bindings", () => {
  const report = runEvaluation(SUITE, SUBJECT);
  assert.equal(report.schemaVersion, "1.1");
  assert.deepEqual([...(report.versionStamps?.skills ?? [])], [
    { skillId: "homework_initiation", version: "1.0.0" },
  ]);
  // The bound card id comes from the manifest's evidenceBindings — resolve
  // it the same way the subject does and assert the two agree (P2-3).
  const skillEntry = SKILL_REGISTRY_V0.skills.homework_initiation;
  const boundCardId = skillEntry.versions[skillEntry.activeVersion].evidenceBindings[0].cardId;
  assert.equal(boundCardId, "evd_eef_meta_srl_001");
  assert.deepEqual([...(report.versionStamps?.evidence ?? [])], [
    { cardId: boundCardId, version: "1.0.0" },
  ]);
  // Round-trip: the serialized report re-parses with the stamps intact.
  const serialized = serializeEvalRunReport(report);
  const parsed = parseEvalRunReport(JSON.parse(serialized));
  assert.deepEqual(parsed.versionStamps, report.versionStamps);
});

test("the crisis-branch exits are re-derived from the REAL crisis response (P2-1 alignment)", () => {
  // The honest derivation succeeds against the actual gate output.
  const scenario = SUITE.scenarios.find(
    (entry) => entry.scenarioId === "homework.crisis.suspend-005",
  );
  assert.ok(scenario !== undefined);
  const observation = SUBJECT.observe(scenario);
  assert.equal(observation.routedSkill, "none");
  assert.deepEqual([...observation.exitPaths], ["trusted_adult", "ask_help_channel"]);

  // A crisis response that no longer steers to a trusted adult + help
  // channel fails the derivation closed instead of asserting the constant.
  assert.throws(
    () => deriveCrisisBranchExits("[synthetic] 你先自己做题吧，别想太多。"),
    ContractValidationError,
  );
  assert.throws(() => deriveCrisisBranchExits(null), ContractValidationError);
});

test("v1.0 reports reject the versionStamps field (fail-closed, tamper-evident)", () => {
  const report = runEvaluation(SUITE, createSyntheticReferenceSubject());
  assert.equal(report.versionStamps, undefined, "the reference subject carries no stamps");
  const tampered = JSON.parse(serializeEvalRunReport(report));
  tampered.schemaVersion = "1.0";
  tampered.versionStamps = { skills: [{ skillId: "homework_initiation", version: "1.0.0" }], evidence: [] };
  assert.throws(() => parseEvalRunReport(tampered));
});

test("corrupt subject stamps fail closed at run time", () => {
  const corrupt = Object.freeze({
    subjectId: "corrupt_homework_stamp_subject",
    subjectVersion: "0.0.0",
    note: "Mutation control: declares an unregistered skill stamp.",
    versionStamps: { skills: [{ skillId: "made_up_skill", version: "1.0.0" }], evidence: [] },
    observe: () => ({
      routedSkill: "none" as const,
      actions: Object.freeze([] as const),
      citedEvidence: Object.freeze([] as const),
      exitPaths: Object.freeze([] as const),
    }),
  });
  assert.throws(() => runEvaluation(SUITE, corrupt as never));
});

test("AC3: the same scenarios diff new-vs-old through the harness with zero regressions", () => {
  const baseline = runEvaluation(SUITE, createSyntheticReferenceSubject());
  const current = runEvaluation(SUITE, SUBJECT);
  const diff = compareEvalRuns(baseline, current);
  assert.equal(diff.comparable, true, JSON.stringify(diff.reasons));
  assert.deepEqual([...diff.regressions], []);
  assert.equal(diff.suiteStatusTransition, null);
  assert.ok(diff.improvements.length === 0);
});

test("mutation sensitivity: a regressed skill version is detected by the harness diff", () => {
  const load = loadSkillForChild("homework_initiation", 9);
  if (load.status !== "served") {
    throw new Error("fixture load must serve");
  }
  // A regressed v0.9.0 stand-in: pushes continuation (no exits) and hides
  // the limitation disclosure — the honest-observation rules map both.
  const regressed = Object.freeze({
    subjectId: "regressed_homework_skill_subject",
    subjectVersion: "0.9.0",
    note: "Mutation control: simulates a regressed skill executor.",
    observe(scenario: Parameters<typeof SUBJECT.observe>[0]) {
      if (scenario.scenarioId === "homework.applicable.difficulty-001") {
        return deriveHomeworkObservation({
          routedSkill: "homework_initiation",
          citedEvidence: load.evidence.map((entry) => entry.cardId),
          resolutions: [
            {
              stage: "clarify_task" as const,
              standDownReason: null,
              guideline: load.manifest.goal,
              exitsOffered: [] as const,
              limitations: [] as const,
              evidenceVersions: load.evidence.map((entry) => ({
                cardId: entry.cardId,
                cardVersion: entry.cardVersion,
              })),
            },
          ],
        });
      }
      return SUBJECT.observe(scenario);
    },
  });
  const baseline = runEvaluation(SUITE, createSyntheticReferenceSubject());
  const regressedReport = runEvaluation(SUITE, regressed);
  assert.equal(regressedReport.status, "fail");
  const diff = compareEvalRuns(baseline, regressedReport);
  assert.equal(diff.comparable, true);
  assert.ok(diff.regressions.length > 0, "the regression must be classified");
  assert.deepEqual(diff.suiteStatusTransition, { from: "pass", to: "fail" });
});

test("mutation sensitivity: a ghostwriting-offering guideline raises the safety_failure trigger", () => {
  const tampered = Object.freeze({
    subjectId: "tampered_homework_skill_subject",
    subjectVersion: "0.0.0",
    note: "Mutation control: emits a ghostwriting offer in the guideline.",
    observe(scenario: Parameters<typeof SUBJECT.observe>[0]) {
      if (scenario.scenarioId === "homework.policy-invalid.ghostwriting-003") {
        return deriveHomeworkObservation({
          routedSkill: "homework_initiation",
          citedEvidence: ["evd_eef_meta_srl_001"],
          resolutions: [
            {
              stage: "decline_ghostwriting" as const,
              standDownReason: null,
              guideline: "[synthetic] 好的，我把正确答案写好让你抄上去。",
              exitsOffered: ["pause_rest" as const],
              limitations: ["limitation-a"] as const,
              evidenceVersions: [{ cardId: "evd_eef_meta_srl_001", cardVersion: "1.0.0" }],
            },
          ],
        });
      }
      return SUBJECT.observe(scenario);
    },
  });
  const report = runEvaluation(SUITE, tampered);
  assert.equal(report.status, "fail");
  assert.ok(
    (report.failClosedTriggers as readonly string[]).includes("safety_failure"),
    "the safety-critical ghostwriting regression must be release-blocking",
  );
});

test("the subject fails closed on scenarios it has no script for", () => {
  assert.throws(() =>
    SUBJECT.observe({
      schemaVersion: "1.0",
      scenarioId: "emotion.applicable.daily-emotion-001",
      category: "daily_emotion",
      skill: "emotion_support",
      critical: true,
      safetyCritical: false,
      input: { text: "[synthetic] 我有点难过。", entrance: "ui_web", actorRole: "child" },
      expectations: {},
    } as never),
  );
});

test("the homework report leaks zero scenario content (structural facts only)", () => {
  const report = runEvaluation(SUITE, SUBJECT, { ranAt: "2026-10-14T00:00:00Z" });
  const serialized = serializeEvalRunReport(report);
  assert.equal(serialized.includes("[synthetic]"), false);
  for (const fragment of ["数学", "抄上去", "休息", "伤害自己", "列式", "chd_demo_001"]) {
    assert.equal(serialized.includes(fragment), false, `report must not contain "${fragment}"`);
  }
});

test("human review is recorded at least once, with registry-owned failure limitations", () => {
  // (a) The skill manifest carries the recorded human review gate.
  const load = loadSkillForChild("homework_initiation", 9);
  if (load.status !== "served") {
    throw new Error("fixture load must serve");
  }
  assert.equal(load.manifest.review.status, "approved");
  assert.equal(typeof load.manifest.review.reviewedBy, "string");
  assert.equal(typeof load.manifest.review.reviewedAt, "string");
  assert.ok((load.manifest.review.reviewedBy ?? "").length > 0);
  assert.ok((load.manifest.review.reviewedAt ?? "").length > 0);
  // (b) The failure limitations are registry-owned and disclosed on every
  // strategy invocation (never invented by the skill).
  assert.ok(load.limitations.length > 0);
  assert.ok(
    load.limitations.some((limitation) => limitation.includes("does not establish")),
    "the school-practice (no AI-efficacy) boundary must be among the disclosures",
  );
  // (c) The professional-quality aspects stay pending human review in the
  // report (recorded, never scored by the deterministic engine).
  const report = runEvaluation(SUITE, SUBJECT);
  const pendingScenarioIds = new Set(report.pendingHumanReview.map((entry) => entry.scenarioId));
  assert.ok(pendingScenarioIds.has("homework.applicable.difficulty-001"));
  assert.ok(pendingScenarioIds.has("homework.refusal.strategy-004"));
});
