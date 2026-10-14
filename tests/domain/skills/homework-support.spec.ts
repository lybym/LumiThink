import assert from "node:assert/strict";
import test from "node:test";

import { ContractValidationError } from "../../../lib/domain/contract/core.ts";
import { loadSkillForChild } from "../../../lib/domain/evidence/registry.ts";
import {
  HOMEWORK_INITIATION_SKILL_ID,
  HOMEWORK_OBSTACLE_IDS,
  HOMEWORK_STEP_IDS,
  classifyHomeworkTurnSignals,
  composeHomeworkSkillGuideline,
  deriveHomeworkSkillActions,
  deriveHomeworkStage,
  executeHomeworkSkillTurn,
  resolveHomeworkSkillTurn,
  type HomeworkSkillTurnResolution,
} from "../../../lib/domain/skills/index.ts";

/**
 * R1-12 homework-skill executor unit tests (issue #24; sibling of the
 * R1-11 emotion executor tests): deterministic classification of the
 * obstacle kinds (issue #24 交付范围 1), the documented stage transition
 * table (澄清 → 拆分/示范 → 独立尝试 → 反思/渐退/退出 + 禁忌 branches),
 * served-load-only execution with fail-closed manifest re-validation,
 * manifest-bound exits, guideline composition from registry-owned facts,
 * the controlled-degradation seam (R1-11 review P2-4 disposition) and the
 * honest-observation action mapping.
 */

function servedHomeworkLoad(): Extract<ReturnType<typeof loadSkillForChild>, { status: "served" }> {
  const load = loadSkillForChild("homework_initiation", 9);
  if (load.status !== "served") {
    throw new Error("fixture load must serve for age 9");
  }
  return load;
}

// ---------------------------------------------------------------------------
// Signal classification
// ---------------------------------------------------------------------------

test("classify: the presenting avoidance turn is a hard-task obstacle, not a refusal", () => {
  const signals = classifyHomeworkTurnSignals(
    "[synthetic] 数学作业第一题太难了，我不知道从哪里开始，不想做了。",
  );
  assert.equal(signals.refusal, false, "task avoidance must be worked with, not stood down");
  assert.equal(signals.ghostwriting, false);
  assert.equal(signals.obstacle, "task_hard_unspecified");
});

test("classify: each registered obstacle kind is recognized (issue #24 交付范围 1)", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["[synthetic] 题目看不懂，说的是什么意思呀。", "task_comprehension"],
    ["[synthetic] 这部分我还没学过，不会做。", "prerequisite_missing"],
    ["[synthetic] 家里没人教我，太吵了也没法写。", "environmental_obstacle"],
    ["[synthetic] 明天就要交了，来不及了。", "deadline_pressure"],
    ["[synthetic] 一想到数学作业就有点烦。", "emotional_blocking"],
    ["[synthetic] 这道题太难，我不会做。", "task_hard_unspecified"],
  ];
  for (const [text, expected] of cases) {
    const signals = classifyHomeworkTurnSignals(text);
    assert.equal(signals.obstacle, expected, text);
    assert.ok((HOMEWORK_OBSTACLE_IDS as readonly string[]).includes(expected));
  }
});

test("classify: ghostwriting / answer-provision asks are detected", () => {
  for (const text of [
    "[synthetic] 这道数学题你直接写好答案给我抄上去就行。",
    "[synthetic] 你帮我写完这篇吧。",
    "[synthetic] 把答案告诉我。",
    "[synthetic] 答案是多少？",
  ]) {
    assert.equal(classifyHomeworkTurnSignals(text).ghostwriting, true, text);
  }
});

test("classify: method rejection, adult help, completion, willingness, refusal", () => {
  assert.equal(
    classifyHomeworkTurnSignals("[synthetic] 这个办法没有用。").methodRejected,
    true,
  );
  assert.equal(
    classifyHomeworkTurnSignals("[synthetic] 我想去问老师这道题。").seekAdultHelp,
    true,
  );
  assert.equal(
    classifyHomeworkTurnSignals("[synthetic] 我做出来第一小步了！").stepCompleted,
    true,
  );
  assert.equal(
    classifyHomeworkTurnSignals("[synthetic] 那我先试第一小步。").readyToTry,
    true,
  );
  const selected = classifyHomeworkTurnSignals("[synthetic] 我想先复习一遍课本。");
  assert.equal(selected.selectedStep, "review_example");
  assert.equal(
    classifyHomeworkTurnSignals("[synthetic] 我不想按你说的方法开始，我想先去玩。").refusal,
    true,
  );
  assert.equal(classifyHomeworkTurnSignals("[synthetic] 我先休息一会儿。").refusal, true);
});

test("classify: non-string text fails closed", () => {
  assert.throws(() => classifyHomeworkTurnSignals(undefined as never), ContractValidationError);
});

// ---------------------------------------------------------------------------
// Stage derivation (documented precedence table)
// ---------------------------------------------------------------------------

test("derive: taboo branches win in the documented precedence order", () => {
  const refusalFirst = deriveHomeworkStage(
    {
      refusal: true,
      ghostwriting: true,
      methodRejected: true,
      seekAdultHelp: true,
      prerequisiteMissing: false,
      stepCompleted: false,
      selectedStep: null,
      readyToTry: false,
      obstacle: "task_hard_unspecified",
    },
    null,
  );
  assert.deepEqual(refusalFirst, { stage: "stand_down", standDownReason: "child_stops" });

  const ghostwriteSecond = deriveHomeworkStage(
    {
      refusal: false,
      ghostwriting: true,
      methodRejected: true,
      seekAdultHelp: true,
      prerequisiteMissing: false,
      stepCompleted: false,
      selectedStep: null,
      readyToTry: false,
      obstacle: "task_hard_unspecified",
    },
    null,
  );
  assert.deepEqual(ghostwriteSecond, { stage: "decline_ghostwriting", standDownReason: null });

  const switchThird = deriveHomeworkStage(
    {
      refusal: false,
      ghostwriting: false,
      methodRejected: true,
      seekAdultHelp: true,
      prerequisiteMissing: false,
      stepCompleted: false,
      selectedStep: null,
      readyToTry: false,
      obstacle: "task_hard_unspecified",
    },
    "split_demo",
  );
  assert.deepEqual(switchThird, { stage: "switch_plan", standDownReason: null });
});

test("derive: help path for adult-help asks AND missing prerequisites (issue #24 AC 2)", () => {
  for (const prerequisiteMissing of [false, true]) {
    const derived = deriveHomeworkStage(
      {
        refusal: false,
        ghostwriting: false,
        methodRejected: false,
        seekAdultHelp: !prerequisiteMissing,
        prerequisiteMissing,
        stepCompleted: false,
        selectedStep: null,
        readyToTry: false,
        obstacle: prerequisiteMissing ? "prerequisite_missing" : null,
      },
      "clarify_task",
    );
    assert.deepEqual(derived, { stage: "help_path", standDownReason: null });
  }
});

test("derive: strategy flow threads clarify → split → attempt, and re-clarifies after terminal stages", () => {
  const obstacle = { obstacle: "task_hard_unspecified" as const };
  const base = {
    refusal: false,
    ghostwriting: false,
    methodRejected: false,
    seekAdultHelp: false,
    prerequisiteMissing: false,
    stepCompleted: false,
    selectedStep: null,
    readyToTry: false,
    ...obstacle,
  };
  assert.equal(deriveHomeworkStage(base, null).stage, "clarify_task");
  assert.equal(deriveHomeworkStage(base, "clarify_task").stage, "split_demo");
  assert.equal(deriveHomeworkStage(base, "split_demo").stage, "guided_attempt");
  assert.equal(deriveHomeworkStage(base, "guided_attempt").stage, "guided_attempt");
  assert.equal(deriveHomeworkStage(base, "stand_down").stage, "clarify_task");
  assert.equal(deriveHomeworkStage(base, "help_path").stage, "clarify_task");
});

test("derive: completion reflects+fades, willingness guides the attempt, no signal stands down", () => {
  const derived = deriveHomeworkStage(
    {
      refusal: false,
      ghostwriting: false,
      methodRejected: false,
      seekAdultHelp: false,
      prerequisiteMissing: false,
      stepCompleted: true,
      selectedStep: null,
      readyToTry: false,
      obstacle: null,
    },
    "guided_attempt",
  );
  assert.deepEqual(derived, { stage: "reflect_fade", standDownReason: null });

  const defensive = deriveHomeworkStage(
    {
      refusal: false,
      ghostwriting: false,
      methodRejected: false,
      seekAdultHelp: false,
      prerequisiteMissing: false,
      stepCompleted: false,
      selectedStep: null,
      readyToTry: false,
      obstacle: null,
    },
    "split_demo",
  );
  assert.deepEqual(defensive, { stage: "stand_down", standDownReason: "no_actionable_signal" });
});

// ---------------------------------------------------------------------------
// Resolution (served-load-only, manifest-bound, registry-composed)
// ---------------------------------------------------------------------------

test("resolve: the five-step conversation threads the real stage machine (issue #24 AC 1)", () => {
  const load = servedHomeworkLoad();
  const steps = [
    "[synthetic] 数学作业第一题太难了，我不知道从哪里开始，不想做了。",
    "[synthetic] 是第二小题的计算，我不知道怎么列式，这道题不会做。",
    "[synthetic] 那我先试第一小步，把这道习题的第一问先算出来。",
    "[synthetic] 这个办法没有用，这道数学题我还是不会做。",
    "[synthetic] 我先休息一会儿，作业等会儿自己接着写。",
  ];
  const resolutions: HomeworkSkillTurnResolution[] = [];
  let priorStage: HomeworkSkillTurnResolution["stage"] | null = null;
  for (const step of steps) {
    const resolution = resolveHomeworkSkillTurn({ load, turnText: step, priorStage });
    resolutions.push(resolution);
    priorStage = resolution.stage;
  }
  assert.deepEqual(
    resolutions.map((resolution) => resolution.stage),
    ["clarify_task", "split_demo", "guided_attempt", "switch_plan", "stand_down"],
  );
  // The autonomous-choice turn echoes the child's own selected step.
  assert.equal(resolutions[2].selectedStep, "try_first_small_step");
  // The switch turn never offers the first (rejected) menu entry first.
  assert.notEqual(resolutions[3].offeredSteps[0], resolutions[2].offeredSteps[0]);
  // The stand-down carries its reason and keeps exits open.
  assert.equal(resolutions[4].standDownReason, "child_stops");
  assert.ok(resolutions[4].exitsOffered.includes("pause_rest"));
  assert.ok(resolutions[4].exitsOffered.includes("end_turn"));
});

test("resolve: versions, evidence and limitations are registry-owned on every invocation", () => {
  const load = servedHomeworkLoad();
  const resolution = resolveHomeworkSkillTurn({
    load,
    turnText: "[synthetic] 这道题太难，我不会做。",
  });
  assert.equal(resolution.skillId, "homework_initiation");
  assert.equal(resolution.skillVersion, "1.0.0");
  assert.deepEqual(
    resolution.evidenceVersions.map((entry) => `${entry.cardId}@${entry.cardVersion}`),
    ["evd_eef_meta_srl_001@1.0.0"],
  );
  assert.ok(resolution.limitations.length > 0);
  assert.ok(
    resolution.limitations.some((limitation) => limitation.includes("does not establish")),
    "the school-practice (no AI-efficacy) boundary must be among the disclosures",
  );
  const guideline = resolution.guideline;
  assert.ok(guideline.includes("homework_initiation@1.0.0"));
  assert.ok(guideline.includes("evd_eef_meta_srl_001@1.0.0"));
  assert.ok(guideline.includes("限制与边界"));
  assert.ok(guideline.includes(resolution.limitations[0]));
});

test("resolve: offered exits are a manifest-bound subset (fail-closed vocabulary)", () => {
  const load = servedHomeworkLoad();
  const manifestExits = load.manifest.exitPaths as readonly string[];
  // Each registered stage is reachable through the documented transition
  // table, keeps at least one exit open, and never offers an undeclared exit.
  const cases: readonly (readonly [HomeworkSkillTurnResolution["stage"], string, HomeworkSkillTurnResolution["stage"] | null])[] = [
    ["clarify_task", "[synthetic] 这道题太难了。", null],
    ["split_demo", "[synthetic] 是第二小题不会做。", "clarify_task"],
    ["guided_attempt", "[synthetic] 这道题太难了。", "split_demo"],
    ["reflect_fade", "[synthetic] 我做完了第一小步。", "guided_attempt"],
    ["switch_plan", "[synthetic] 这个办法没有用。", "split_demo"],
    ["help_path", "[synthetic] 我想问老师这道题。", null],
    ["decline_ghostwriting", "[synthetic] 你帮我写完吧。", null],
    ["stand_down", "[synthetic] 我先休息一会儿。", null],
  ];
  for (const [stage, text, priorStage] of cases) {
    const resolution = resolveHomeworkSkillTurn({ load, turnText: text, priorStage });
    assert.equal(resolution.stage, stage, `stage ${stage} must be reachable`);
    for (const exit of resolution.exitsOffered) {
      assert.ok(
        manifestExits.includes(exit),
        `exit ${exit} must be declared by the manifest (stage ${stage})`,
      );
    }
    assert.ok(resolution.exitsOffered.length > 0, `stage ${stage} must keep exits open`);
  }
});

test("resolve: fail-closed on non-served loads, foreign skills, bad priorStage, corrupted manifests", () => {
  const load = servedHomeworkLoad();
  const emotionLoad = loadSkillForChild("emotion_support", 9);
  if (emotionLoad.status !== "served") throw new Error("fixture emotion load must serve");
  assert.throws(
    () => resolveHomeworkSkillTurn({ load: emotionLoad, turnText: "[synthetic] 太难了。" }),
    ContractValidationError,
  );
  const rejected = loadSkillForChild("homework_initiation", 3);
  assert.equal(rejected.status, "degraded");
  assert.throws(
    () =>
      resolveHomeworkSkillTurn({
        load: rejected as never,
        turnText: "[synthetic] 太难了。",
      }),
    ContractValidationError,
  );
  assert.throws(
    () => resolveHomeworkSkillTurn({ load, turnText: "[synthetic] 太难了。", priorStage: "made_up" as never }),
    ContractValidationError,
  );
  // A served-shaped load whose manifest no longer validates (corrupted
  // registry simulation) must throw loudly inside the executor.
  const corrupted = {
    status: "served",
    skillId: "homework_initiation",
    skillVersion: "1.0.0",
    manifest: { schemaVersion: "1.0", skillId: "homework_initiation", version: "1.0.0" },
    evidence: load.evidence,
    limitations: load.limitations,
  } as never;
  assert.throws(
    () => resolveHomeworkSkillTurn({ load: corrupted, turnText: "[synthetic] 太难了。" }),
    ContractValidationError,
  );
});

// ---------------------------------------------------------------------------
// Controlled-degradation seam (R1-11 review P2-4 disposition)
// ---------------------------------------------------------------------------

test("execute: honest served loads execute; fail-closed throws degrade the turn", () => {
  const load = servedHomeworkLoad();
  const executed = executeHomeworkSkillTurn(load, "[synthetic] 这道题太难，我不会做。");
  assert.equal(executed.status, "executed");
  if (executed.status === "executed") {
    assert.equal(executed.resolution.stage, "clarify_task");
  }

  const corrupted = {
    status: "served",
    skillId: "homework_initiation",
    skillVersion: "1.0.0",
    manifest: { schemaVersion: "1.0", skillId: "homework_initiation", version: "1.0.0" },
    evidence: load.evidence,
    limitations: load.limitations,
  } as never;
  const degraded = executeHomeworkSkillTurn(corrupted, "[synthetic] 这道题太难，我不会做。");
  assert.deepEqual(degraded, { status: "degraded", reason: "executor_fail_closed" });
});

// ---------------------------------------------------------------------------
// Honest-observation action mapping (mutation sensitivity)
// ---------------------------------------------------------------------------

function minimalResolution(overrides: {
  stage: HomeworkSkillTurnResolution["stage"];
  standDownReason?: HomeworkSkillTurnResolution["standDownReason"];
  guideline?: string;
  exitsOffered?: HomeworkSkillTurnResolution["exitsOffered"];
  limitations?: HomeworkSkillTurnResolution["limitations"];
  evidenceVersions?: HomeworkSkillTurnResolution["evidenceVersions"];
}): HomeworkSkillTurnResolution {
  return {
    stage: overrides.stage,
    standDownReason: overrides.standDownReason ?? null,
    guideline: overrides.guideline ?? "[synthetic] 正常指引。",
    exitsOffered: overrides.exitsOffered ?? (["pause_rest"] as const),
    limitations: overrides.limitations ?? (["limitation-a"] as const),
    evidenceVersions: overrides.evidenceVersions ?? [{ cardId: "evd_eef_meta_srl_001", cardVersion: "1.0.0" }],
  } as HomeworkSkillTurnResolution;
}

test("actions: the honest executor's real resolutions map to an empty action set", () => {
  const load = servedHomeworkLoad();
  const steps = [
    "[synthetic] 数学作业第一题太难了，我不知道从哪里开始，不想做了。",
    "[synthetic] 你直接写好答案给我抄上去就行。",
    "[synthetic] 这个办法没有用。",
    "[synthetic] 我先休息一会儿。",
  ];
  const resolutions: HomeworkSkillTurnResolution[] = [];
  let priorStage: HomeworkSkillTurnResolution["stage"] | null = null;
  for (const step of steps) {
    const resolution = resolveHomeworkSkillTurn({ load, turnText: step, priorStage });
    resolutions.push(resolution);
    priorStage = resolution.stage;
  }
  assert.deepEqual(deriveHomeworkSkillActions(resolutions), []);
});

test("actions: ghostwriting offers, urging/shaming and ability labels are mapped (mutation controls)", () => {
  const ghostwriting = deriveHomeworkSkillActions([
    minimalResolution({
      stage: "decline_ghostwriting",
      guideline: "[synthetic] 好的，我把正确答案写好让你抄上去。",
    }),
  ]);
  assert.deepEqual(ghostwriting, ["ghostwriting"]);

  const urging = deriveHomeworkSkillActions([
    minimalResolution({ stage: "guided_attempt", guideline: "[synthetic] 你怎么这么懒，必须给我写。" }),
  ]);
  assert.deepEqual(urging, ["forced_continuation"]);

  const diagnosis = deriveHomeworkSkillActions([
    minimalResolution({ stage: "clarify_task", guideline: "[synthetic] 你这是典型的执行功能障碍。" }),
  ]);
  assert.deepEqual(diagnosis, ["diagnosis_claim"]);

  const reasonlessStandDown = deriveHomeworkSkillActions([
    minimalResolution({ stage: "stand_down", standDownReason: null, exitsOffered: [] }),
  ]);
  assert.deepEqual(reasonlessStandDown, ["forced_continuation"]);

  const noExits = deriveHomeworkSkillActions([minimalResolution({ stage: "split_demo", exitsOffered: [] })]);
  assert.deepEqual(noExits, ["forced_continuation"]);

  const noEvidence = deriveHomeworkSkillActions([
    minimalResolution({ stage: "split_demo", limitations: [], evidenceVersions: [] }),
  ]);
  assert.deepEqual(noEvidence, ["evidence_fabrication"]);
});

test("resolve: the prerequisite-gap turn is honest — admits inability, offers help/review, no diagnosis (issue #24 AC 2)", () => {
  const load = servedHomeworkLoad();
  const resolution = resolveHomeworkSkillTurn({
    load,
    turnText: "[synthetic] 这部分我还没学过，不会做。",
  });
  assert.equal(resolution.stage, "help_path");
  assert.equal(resolution.obstacle, "prerequisite_missing");
  // Honest inability + help/review path, without fabricating a definitive
  // diagnosis or a learning-ability label.
  assert.ok(/无法直接/.test(resolution.guideline), "the guideline must admit it cannot solve this directly");
  assert.ok(/(?:老师|家长|大人)/.test(resolution.guideline), "the guideline must offer a trusted-adult help path");
  assert.ok(/(?:复习|例题|笔记)/.test(resolution.guideline), "the guideline must offer a review path");
  assert.equal(/执行功能|学习障碍|多动症|能力(?:评分|定级)/.test(resolution.guideline), false);
});

// ---------------------------------------------------------------------------
// Guideline composition (pure helper)
// ---------------------------------------------------------------------------

test("compose: guideline carries versions, directive, menu, exits and limitations", () => {
  const guideline = composeHomeworkSkillGuideline({
    skillVersion: "1.0.0",
    evidenceVersions: [{ cardId: "evd_eef_meta_srl_001", cardVersion: "1.0.0" }],
    stage: "split_demo",
    offeredSteps: ["read_question", "find_known_part"],
    exitsOffered: ["pause_rest", "end_turn"],
    limitations: ["limitation-a"],
  });
  assert.ok(guideline.includes("homework_initiation@1.0.0"));
  assert.ok(guideline.includes("evd_eef_meta_srl_001@1.0.0"));
  assert.ok(guideline.includes("阶段 split_demo"));
  assert.ok(guideline.includes("read_question / find_known_part"));
  assert.ok(guideline.includes("pause_rest / end_turn"));
  assert.ok(guideline.includes("limitation-a"));
  // Every registered step id stays structural; none leaks child text.
  for (const stepId of HOMEWORK_STEP_IDS) {
    assert.equal(typeof stepId, "string");
  }
  assert.equal(guideline.includes("[synthetic]"), false);
});
