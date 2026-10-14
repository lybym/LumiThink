import assert from "node:assert/strict";
import test from "node:test";

import {
  EMOTION_SKILL_STAGES,
  EMOTION_SITUATION_IDS,
  EMOTION_STRATEGY_IDS,
  classifyEmotionTurnSignals,
  composeEmotionSkillGuideline,
  deriveEmotionSkillActions,
  deriveEmotionStage,
  resolveEmotionSkillTurn,
  type EmotionSkillTurnResolution,
} from "../../../lib/domain/skills/emotion-support.ts";
import { loadSkillForChild, SKILL_REGISTRY_V0 } from "../../../lib/domain/evidence/registry.ts";

/**
 * R1-11 emotion-skill executor unit tests (issue #23 交付范围 1-3):
 *
 * - the seven issue branches are classified deterministically (生气 / 委屈 /
 *   害怕 / 与监护人意见冲突 / 不想继续 / 建议无效或反感 / 寻求现实成年人帮助)
 *   plus the clinical (policy-invalid) and strategy-selection signals;
 * - the multi-turn stage machine follows the documented transition table
 *   (表达 → 澄清 → 自主选择 → 可退出) with threaded prior stages;
 * - everything child-relevant is registry-bound: exact skill/evidence
 *   versions, merged limitation disclosures, manifest-bound exits;
 * - the composed guideline never carries clinical labels, secrecy promises
 *   or dependency building (issue #23: 不诊断 / 不羞辱 / 不排他依恋 /
 *   不秘密保留重大危险信息) and always offers exits;
 * - fail-closed: unserved loads, wrong skills, tampered manifests, bad
 *   stages and non-string text are rejected, never executed.
 */

function servedLoad() {
  const load = loadSkillForChild("emotion_support", 9);
  if (load.status !== "served") {
    throw new Error(`fixture load must serve, got ${load.status}`);
  }
  return load;
}

test("the served emotion load carries the pinned manifest, card and limitations", () => {
  const load = servedLoad();
  assert.equal(load.skillId, "emotion_support");
  assert.equal(load.skillVersion, "1.0.0");
  assert.equal(load.manifest.skillId, "emotion_support");
  assert.deepEqual(load.evidence.map((entry) => entry.cardVersion), ["1.0.0"]);
  assert.equal(load.evidence[0].cardId, "evd_eef_sel_primary_001");
  assert.ok(load.limitations.length > 0, "limitation disclosures must be present");
  assert.equal(load.manifest.review.status, "approved");
});

test("signal classification covers the issue branches deterministically", () => {
  // 生气
  assert.equal(classifyEmotionTurnSignals("[synthetic] 我好生气，他们抢了我的书。").situation, "anger");
  // 委屈
  assert.equal(classifyEmotionTurnSignals("[synthetic] 老师误会了我，我觉得好委屈。").situation, "grievance");
  // 害怕
  assert.equal(classifyEmotionTurnSignals("[synthetic] 晚上一个人在房间我有点害怕。").situation, "fear");
  // 与监护人意见冲突
  assert.equal(
    classifyEmotionTurnSignals("[synthetic] 我和妈妈吵架了，因为她不让我出去玩。").situation,
    "guardian_conflict",
  );
  // 尚未说清原因（UC-07）
  assert.equal(classifyEmotionTurnSignals("[synthetic] 我心里有点难受。").situation, "distress_unspecified");
  // 儿童不想继续
  assert.equal(classifyEmotionTurnSignals("[synthetic] 我不想聊了，别问了。").refusal, true);
  // 建议无效/反感
  assert.equal(classifyEmotionTurnSignals("[synthetic] 这个办法没有用，我不想做了。").adviceRejected, true);
  // 寻求现实成年人帮助
  assert.equal(classifyEmotionTurnSignals("[synthetic] 我想告诉妈妈这件事。").seekAdult, true);
  // 策略选择（自主选择）
  assert.equal(classifyEmotionTurnSignals("[synthetic] 那我想先深呼吸。").selectedStrategy, "pause_breathe");
  // 临床/诊断请求（policy-invalid branch）
  assert.equal(classifyEmotionTurnSignals("[synthetic] 我是不是得了抑郁症？").clinical, true);
  // 请求办法 → 提供选择
  assert.equal(classifyEmotionTurnSignals("[synthetic] 我很委屈，有什么办法吗？").adviceSeek, true);
});

test("every router emotion signal is classifiable by the executor (superset rule)", () => {
  // The router may route a text only if the executor can classify it;
  // otherwise the defensive no-signal stand-down would fire on honest turns.
  const routerSignalTexts = [
    "委屈", "难过", "伤心", "生气", "愤怒", "害怕", "恐惧", "烦躁", "郁闷",
    "不开心", "我不想继续", "我不想说话", "我不想讲", "我不想学了", "好烦",
    "I feel sad", "I am angry", "I am upset", "I am scared", "I am frustrated",
  ];
  for (const text of routerSignalTexts) {
    const signals = classifyEmotionTurnSignals(`[synthetic] ${text}`);
    const classified =
      signals.refusal ||
      signals.seekAdult ||
      signals.clinical ||
      signals.adviceRejected ||
      signals.adviceSeek ||
      signals.situation !== null ||
      signals.selectedStrategy !== null;
    assert.ok(classified, `router signal must be classifiable: ${text}`);
  }
});

test("the multi-turn stage machine follows the documented transition table", () => {
  const load = servedLoad();
  const steps = [
    "[synthetic] 今天在学校被同学笑了，我心里有点难受，也有点生气。",
    "[synthetic] 他们笑我算错答案，我觉得很委屈，有什么办法吗？",
    "[synthetic] 那我想先深呼吸，休息一会儿。",
    "[synthetic] 我不想说话了，别问了。",
  ];
  const stages: string[] = [];
  const situations: (string | null)[] = [];
  let priorStage: EmotionSkillTurnResolution["stage"] | null = null;
  let last: EmotionSkillTurnResolution | null = null;
  for (const step of steps) {
    const resolution = resolveEmotionSkillTurn({ load, turnText: step, priorStage });
    stages.push(resolution.stage);
    situations.push(resolution.situation);
    priorStage = resolution.stage;
    last = resolution;
  }
  // 表达 → 澄清 → 自主选择 → 可退出
  assert.deepEqual(stages, [
    "acknowledge_clarify",
    "offer_choices",
    "support_choice",
    "stand_down",
  ]);
  assert.equal(situations[0], "anger");
  assert.equal(situations[1], "grievance");
  assert.equal(last?.standDownReason, "child_stops");
  assert.deepEqual([...(last?.exitsOffered ?? [])], ["end_turn", "pause_rest"]);
});

test("a prior acknowledge turn advances to offer_choices (clarification answered)", () => {
  const signals = classifyEmotionTurnSignals("[synthetic] 他们嘲笑我，我觉得很委屈。");
  const first = deriveEmotionStage(signals, null);
  assert.equal(first.stage, "acknowledge_clarify");
  const second = deriveEmotionStage(signals, "acknowledge_clarify");
  assert.equal(second.stage, "offer_choices");
});

test("clinical asks resolve to the honest non-clinical stage with the trusted-adult path", () => {
  const load = servedLoad();
  const resolution = resolveEmotionSkillTurn({
    load,
    turnText: "[synthetic] 我最近总是开心不起来，有点难过，是不是生病了？",
    priorStage: null,
  });
  assert.equal(resolution.stage, "decline_clinical");
  assert.ok(resolution.exitsOffered.includes("trusted_adult"));
  // No label, no therapy claim in the guideline.
  assert.equal(/抑郁症|焦虑症|多动症|心理疾病/.test(resolution.guideline), false);
});

test("guardian conflict keeps the trusted-adult path offered", () => {
  const load = servedLoad();
  const resolution = resolveEmotionSkillTurn({
    load,
    turnText: "[synthetic] 我和妈妈吵架了，她不让我看动画片，我很生气。",
    priorStage: null,
  });
  assert.equal(resolution.situation, "guardian_conflict");
  assert.ok(resolution.exitsOffered.includes("trusted_adult"));
});

test("advice rejection rotates the strategy menu and never repeats the first offer", () => {
  const load = servedLoad();
  const offered = resolveEmotionSkillTurn({
    load,
    turnText: "[synthetic] 这个办法没有用。",
    priorStage: "offer_choices",
  });
  assert.equal(offered.stage, "switch_strategy");
  assert.ok(offered.offeredStrategies.length >= 2);
  const plain = resolveEmotionSkillTurn({
    load,
    turnText: "[synthetic] 我心里有点难受。",
    priorStage: null,
  });
  assert.equal(plain.offeredStrategies.length, 0, "acknowledge stage offers no menu yet");
});

test("offered strategies and exits stay inside the registered vocabularies", () => {
  const load = servedLoad();
  const texts = [
    "[synthetic] 我好生气。",
    "[synthetic] 我觉得好委屈。",
    "[synthetic] 我有点害怕。",
    "[synthetic] 我和爸爸闹矛盾了，很生气。",
    "[synthetic] 我心里难受，有什么办法吗？",
    "[synthetic] 那我想休息一会儿。",
    "[synthetic] 我不想谈了。",
    "[synthetic] 我想找老师说说。",
  ];
  for (const text of texts) {
    const resolution = resolveEmotionSkillTurn({ load, turnText: text, priorStage: null });
    for (const strategy of resolution.offeredStrategies) {
      assert.ok(
        (EMOTION_STRATEGY_IDS as readonly string[]).includes(strategy),
        `unregistered strategy ${strategy}`,
      );
    }
    assert.ok(resolution.offeredStrategies.length <= 3, "the menu stays small");
    for (const exit of resolution.exitsOffered) {
      assert.ok(
        (load.manifest.exitPaths as readonly string[]).includes(exit),
        `exit ${exit} must be manifest-bound`,
      );
    }
    assert.ok(resolution.exitsOffered.length > 0, "exits are always offered");
  }
});

test("the guideline carries versions, limitations and exits, and never violates boundaries", () => {
  const load = servedLoad();
  const resolution = resolveEmotionSkillTurn({
    load,
    turnText: "[synthetic] 他们笑我算错答案，我觉得很委屈，有什么办法吗？",
    priorStage: null,
  });
  assert.ok(resolution.guideline.includes("emotion_support@1.0.0"));
  assert.ok(resolution.guideline.includes("evd_eef_sel_primary_001@1.0.0"));
  for (const limitation of load.limitations) {
    assert.ok(resolution.guideline.includes(limitation), "limitation disclosure must be included");
  }
  assert.ok(resolution.guideline.includes("pause_rest"));
  assert.ok(resolution.guideline.includes("end_turn"));
  // Forbidden content classes never appear in the composed guideline.
  assert.equal(/抑郁症|焦虑症|多动症|自闭症|心理疾病/.test(resolution.guideline), false);
  assert.equal(/(?:我|帮你|替你|给你)保密|不会告诉(?:任何人|别人)/.test(resolution.guideline), false);
  assert.equal(/只(?:有|需|陪)(?:我|着你)|最(?:爱|懂|喜欢)(?:你|我)/.test(resolution.guideline), false);
});

test("every stage directive is registered and bounded", () => {
  assert.equal(EMOTION_SKILL_STAGES.length, 7);
  assert.ok((EMOTION_SITUATION_IDS as readonly string[]).length >= 5);
  const guideline = composeEmotionSkillGuideline({
    skillVersion: "9.9.9",
    evidenceVersions: [{ cardId: "evd_x", cardVersion: "1.0.0" }],
    stage: "offer_choices",
    offeredStrategies: ["pause_breathe"],
    exitsOffered: ["pause_rest"],
    limitations: ["limitation-a"],
  });
  assert.ok(guideline.includes("emotion_support@9.9.9"));
  assert.ok(guideline.includes("limitation-a"));
});

test("honest resolutions derive no forbidden actions (totality of the honest path)", () => {
  const load = servedLoad();
  const texts = [
    "[synthetic] 今天在学校被同学笑了，我心里有点难受，也有点生气。",
    "[synthetic] 他们笑我算错答案，我觉得很委屈，有什么办法吗？",
    "[synthetic] 那我想先深呼吸，休息一会儿。",
    "[synthetic] 我不想说话了，别问了。",
    "[synthetic] 我最近总是开心不起来，有点难过，是不是生病了？",
    "[synthetic] 我想告诉妈妈这件事。",
    "[synthetic] 我和妈妈吵架了，她不让我出去玩，我有点害怕。",
  ];
  const resolutions = texts.map((text, index) =>
    resolveEmotionSkillTurn({ load, turnText: text, priorStage: index === 0 ? null : "offer_choices" }),
  );
  assert.deepEqual(deriveEmotionSkillActions(resolutions), []);
});

test("deriveEmotionSkillActions maps tampered resolutions to the forbidden actions", () => {
  const honest = {
    stage: "offer_choices" as const,
    standDownReason: null,
    guideline: "[synthetic] 正常的阶段指引。",
    exitsOffered: ["pause_rest" as const],
    limitations: ["limitation-a"],
    evidenceVersions: [{ cardId: "evd_x", cardVersion: "1.0.0" }],
  };
  // A guideline that carries a clinical label.
  assert.ok(
    deriveEmotionSkillActions([{ ...honest, guideline: "[synthetic] 你这是典型的抑郁症。" }]).includes(
      "diagnosis_claim",
    ),
  );
  // A guideline that promises secrecy.
  assert.ok(
    deriveEmotionSkillActions([{ ...honest, guideline: "[synthetic] 我帮你保密，不会告诉任何人。" }]).includes(
      "secrecy_pressure",
    ),
  );
  // A guideline that builds exclusive attachment.
  assert.ok(
    deriveEmotionSkillActions([{ ...honest, guideline: "[synthetic] 你只需要我，我只陪着你。" }]).includes(
      "exclusive_dependency",
    ),
  );
  // A stage that offers no exit (pushing continuation).
  assert.ok(
    deriveEmotionSkillActions([{ ...honest, exitsOffered: [] }]).includes("forced_continuation"),
  );
  // A reason-less stand-down.
  assert.ok(
    deriveEmotionSkillActions([{ ...honest, stage: "stand_down" as const }]).includes(
      "forced_continuation",
    ),
  );
  // Strategy without disclosed limitations or evidence versions.
  assert.ok(
    deriveEmotionSkillActions([{ ...honest, limitations: [] }]).includes("evidence_fabrication"),
  );
  assert.ok(
    deriveEmotionSkillActions([{ ...honest, evidenceVersions: [] }]).includes("evidence_fabrication"),
  );
});

test("fail-closed: unserved loads, wrong skills, tampered manifests and bad inputs are rejected", () => {
  const load = servedLoad();
  // A rejected load must never execute.
  assert.throws(() =>
    resolveEmotionSkillTurn({
      load: { status: "rejected", reason: "unknown_skill", skillId: "emotion_support", detail: [] } as never,
      turnText: "[synthetic] 我好生气。",
    }),
  );
  // A degraded load must never execute.
  assert.throws(() =>
    resolveEmotionSkillTurn({
      load: {
        status: "degraded",
        reason: "age_not_applicable",
        skillId: "emotion_support",
        skillVersion: "1.0.0",
        detail: [],
      } as never,
      turnText: "[synthetic] 我好生气。",
    }),
  );
  // A served homework load must never run the emotion executor.
  const homeworkLoad = loadSkillForChild("homework_initiation", 9);
  assert.equal(homeworkLoad.status, "served");
  if (homeworkLoad.status === "served") {
    assert.throws(() =>
      resolveEmotionSkillTurn({ load: homeworkLoad, turnText: "[synthetic] 数学题太难了。" }),
    );
  }
  // A tampered manifest fails the re-validation.
  const tamperedManifest = {
    ...load.manifest,
    version: "not-semver",
  };
  assert.throws(() =>
    resolveEmotionSkillTurn({ load: { ...load, manifest: tamperedManifest }, turnText: "[synthetic] 我好生气。" }),
  );
  // Non-string text and unregistered prior stages.
  assert.throws(() => resolveEmotionSkillTurn({ load, turnText: undefined as never }));
  assert.throws(() =>
    resolveEmotionSkillTurn({ load, turnText: "[synthetic] 我好生气。", priorStage: "made_up" as never }),
  );
  // The manifest registry version stays the pinned active version.
  assert.equal(SKILL_REGISTRY_V0.skills.emotion_support.activeVersion, "1.0.0");
});
