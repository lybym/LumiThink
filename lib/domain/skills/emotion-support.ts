/**
 * R1-11 Emotion Regulation Support skill v0 — the deterministic strategy
 * executor (issue #23, docs/PRD.md UC-07 / FR-010, docs/EVIDENCE_POLICY.md
 * §3, docs/HARNESS.md §6).
 *
 * The `emotion_support@1.0.0` manifest and its pinned Evidence Card already
 * exist in the R1-13 registries (issue #25). This module delivers the actual
 * behavior surface those registries govern: a deterministic, registry-driven
 * turn executor that composes the age-appropriate strategy guideline a turn
 * runs under. Design invariants:
 *
 * - EVERYTHING child-relevant is registry-derived: strategy steps, 禁忌
 *   conditions, evidence versions and limitation disclosures come ONLY from
 *   the served `loadSkillForChild` result (fail-closed re-validated here).
 *   The executor cannot run without a served, human-approved, evidence-bound
 *   load — there is no path that executes the strategy on an unserved load.
 * - The stage directive is a deterministic classification of the turn text
 *   (signal precedence: refusal → seek-adult → clinical → strategy selection
 *   → advice rejected → advice sought → emotion situation). It is tuned to
 *   the synthetic corpus, conservative, and never echoes submitted text.
 * - NO clinical vocabulary: the executor's registered directive texts cannot
 *   produce a diagnosis, a therapy claim or a shaming statement (issue #23:
 *   不诊断 / 不羞辱), and it never turns a child's self-report into a
 *   diagnostic label. Clinical asks map to the honest non-clinical
 *   `decline_clinical` stage.
 * - NO own crisis pathway: the pipeline escalates crisis text at the input
 *   gate BEFORE routing (docs/SAFETY_POLICY.md §5), so the executor never
 *   sees it. The module implements no crisis script, no hotline logic and no
 *   secrecy promise — it only respects exits and the trusted-adult path.
 * - Refusal is respected structurally: a stop signal maps to the
 *   `stand_down` stage whose directive forbids continuation pushing.
 * - Exit paths are manifest-bound: every offered exit must be listed in the
 *   manifest's `exitPaths` (fail-closed check), so the executor can never
 *   offer an unregistered path.
 *
 * The pipeline wires the composed guideline as the skill header for routed
 * emotion turns (prompt-shaping over the manifest + card) and records the
 * structured resolution on the turn result, so every strategy invocation can
 * output its source versions and 适用/限制 (issue #25 acceptance criterion 2,
 * consumed by R1-11). Honest-observation rule: outcomes are never declared
 * here — they live in the eval harness over real outputs
 * (lib/domain/skills/emotion-eval-subject.ts).
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { ContractValidationError, problem, type ContractProblem } from "../contract/core.ts";
import { ingestDomainFact } from "../legacy-guard.ts";
import type { EvalExitPath, EvalForbiddenAction } from "../eval/scenario.ts";
import { validateSkillManifestV0 } from "../evidence/skill-manifest.ts";
import type { SkillLoadResult } from "../evidence/registry.ts";

// ---------------------------------------------------------------------------
// Vocabularies (closed; structural ids only)
// ---------------------------------------------------------------------------

export const EMOTION_SUPPORT_SKILL_ID = "emotion_support" as const;

/**
 * Emotion situations the executor distinguishes (issue #23 交付范围 3:
 * 生气 / 委屈 / 害怕 / 与监护人意见冲突; UC-07: 情绪强烈尚未说清原因).
 * `distress_unspecified` is the conservative fallback. The FIRST match in
 * registered order wins — `guardian_conflict` precedes the generic emotion
 * words because conflict turns typically also name an emotion, and the
 * relationship context is the more specific (and trusted-adult-relevant)
 * classification.
 */
export const EMOTION_SITUATION_IDS = Object.freeze([
  "guardian_conflict",
  "anger",
  "grievance",
  "fear",
  "distress_unspecified",
] as const);

export type EmotionSituationId = (typeof EMOTION_SITUATION_IDS)[number];

/**
 * Child-selectable regulation strategies (issue #23: 儿童可选的适龄调节
 * 策略). Structural ids; the age-appropriate wording lives in the stage
 * directive texts. A small subset (2-3) is offered per turn — never a menu
 * that pressures the child.
 */
export const EMOTION_STRATEGY_IDS = Object.freeze([
  "pause_breathe",
  "talk_it_out",
  "rest_reset",
  "express_create",
  "move_body",
] as const);

export type EmotionStrategyId = (typeof EMOTION_STRATEGY_IDS)[number];

/**
 * Executor stages (the multi-turn strategy flow: 表达 → 澄清 → 自主选择 →
 * 可退出). Documented transition table lives in {@link deriveEmotionStage}.
 */
export const EMOTION_SKILL_STAGES = Object.freeze([
  "acknowledge_clarify",
  "offer_choices",
  "support_choice",
  "switch_strategy",
  "endorse_adult",
  "decline_clinical",
  "stand_down",
] as const);

export type EmotionSkillStage = (typeof EMOTION_SKILL_STAGES)[number];

/** Why the executor stood down (closed vocabulary). */
export const EMOTION_STAND_DOWN_REASONS = Object.freeze([
  "child_stops",
  // Defensive guard: the turn routed to the skill but the deterministic
  // classifier found no actionable signal — the skill stands down instead
  // of improvising (never invents a strategy for unrecognized input).
  "no_actionable_signal",
] as const);

export type EmotionSkillStandDownReason = (typeof EMOTION_STAND_DOWN_REASONS)[number];

// ---------------------------------------------------------------------------
// Deterministic signal classification (synthetic-corpus-tuned, conservative)
// ---------------------------------------------------------------------------

const REFUSAL_PATTERNS: readonly RegExp[] = Object.freeze([
  /不想(?:继续|聊|说|谈|讲|学)(?:了|这个|这些)?/,
  /别问(?:了)?/,
  /不要问(?:了)?/,
  /我想(?:自己)?(?:待|静)(?:一)?(?:会|会儿|下)/,
  /\bstop (?:talking|asking)\b/i,
  /\bleave me alone\b/i,
]);

const SEEK_ADULT_PATTERNS: readonly RegExp[] = Object.freeze([
  /(?:告诉|找|问)(?:一下)?(?:妈妈|爸爸|老师|大人|家长|监护人)/,
  /(?:想|要|得|打算)(?:跟|和|找|问)(?:一下)?(?:妈妈|爸爸|老师|大人|家长|监护人)(?:说|讲|聊)?/,
  /\btell (?:my )?(?:mom|dad|teacher|parents?)\b/i,
]);

const CLINICAL_PATTERNS: readonly RegExp[] = Object.freeze([
  /是不是(?:得了)?(?:抑郁|焦虑)(?:症|了)?/,
  /(?:得了|有)(?:抑郁症|焦虑症|多动症|心理疾病|病)/,
  /是不是生病了/,
  /\bdepressed\b/i,
  /\bmentally ill\b/i,
]);

/** Registered clinical labels that must NEVER appear in executor output. */
const CLINICAL_LABEL_PATTERNS: readonly RegExp[] = Object.freeze([
  /抑郁症/,
  /焦虑症/,
  /多动症/,
  /自闭症/,
  /心理疾病/,
  /你(?:这是|是)典型/,
  /\byou (?:have|are) (?:depression|adhd|autism)\b/i,
]);

/** Secrecy-pressure patterns that must NEVER appear in executor output. */
const SECRECY_PATTERNS: readonly RegExp[] = Object.freeze([
  /(?:我|帮你|替你|给你)保密/,
  /(?:替|帮)你(?:瞒着|隐瞒)/,
  /(?:这是|属于我们)(?:俩|两人)?(?:之间)?(?:的)?小?秘密/,
  /不会告诉(?:任何人|别人)/,
  /不告诉(?:你)?(?:妈妈|爸爸|家长|大人)/,
  /\bkeep (?:this|it) (?:a )?secret\b/i,
]);

/** Exclusive-dependency patterns that must NEVER appear in executor output. */
const DEPENDENCY_PATTERNS: readonly RegExp[] = Object.freeze([
  /只(?:有|需|陪)(?:我|着你)/,
  /最(?:爱|懂|喜欢)(?:你|我)(?:了)?/,
  /只跟(?:你|我)说/,
  /\bonly (?:need|love) you\b/i,
]);

const ADVICE_REJECTED_PATTERNS: readonly RegExp[] = Object.freeze([
  /(?:这个|那个|你说的)?(?:方法|办法|建议)(?:根本)?没有?用/,
  /不管用/,
  /不想(?:做|用|试)(?:这个|那个|你说的)?/,
  /讨厌(?:这个|那个|你说的)?(?:方法|办法|建议)/,
  /\bdidn'?t work\b/i,
  /\bhate that (?:method|idea)\b/i,
]);

/** The child explicitly asks for help/ideas → the skill offers choices. */
const ADVICE_SEEK_PATTERNS: readonly RegExp[] = Object.freeze([
  /怎么办/,
  /有什么(?:好)?办法/,
  /有什么(?:好)?方法/,
  /帮我(?:想|出)(?:个)?(?:主意|办法)/,
  /该(?:怎么|怎么办)/,
  /\bwhat (?:should|can) i do\b/i,
]);

const SELECTION_KEYWORDS: Readonly<Record<EmotionStrategyId, readonly RegExp[]>> =
  Object.freeze({
    pause_breathe: Object.freeze([/深呼吸/, /呼吸/, /数到十/]),
    talk_it_out: Object.freeze([/说(?:一)?说/, /聊(?:一)?聊/, /倾诉/, /讲(?:一)?讲/]),
    rest_reset: Object.freeze([/休息/, /喝(?:口水|水)/, /歇(?:一)?会儿/]),
    express_create: Object.freeze([/画(?:一)?画/, /写下来/, /涂色/]),
    move_body: Object.freeze([/出去走/, /动一动/, /跑步/, /跳一跳/, /运动/]),
  });

const SITUATION_PATTERNS: Readonly<Record<EmotionSituationId, readonly RegExp[]>> =
  Object.freeze({
    anger: Object.freeze([/生气/, /愤怒/, /气死(?:我)?(?:了)?/, /火大/, /\bangry\b/i]),
    grievance: Object.freeze([/委屈/, /冤枉/, /不公平/, /\bunfair\b/i]),
    fear: Object.freeze([/害怕/, /恐惧/, /吓(?:到|坏)(?:了)?/, /担心/, /\bscared\b/i, /\bafraid\b/i]),
    guardian_conflict: Object.freeze([
      /(?:和|跟|与)(?:妈妈|爸爸|爸妈|家长|监护人)(?:吵架|闹(?:别扭|矛盾)|生气|意见不合)/,
      /(?:妈妈|爸爸|爸妈|家长|监护人)(?:老是|一直|总)?(?:骂|吼|吵|不允许|不同意|不让)/,
    ]),
    distress_unspecified: Object.freeze([
      /难受/,
      /不开心/,
      /郁闷/,
      /烦躁/,
      /伤心/,
      /难过/,
      /好烦/,
      /烦死/,
      /心里不(?:舒服|好受)/,
      /\bsad\b/i,
      /\bupset\b/i,
      /\bfrustrated\b/i,
    ]),
  });

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** Structural classification of one turn text (never echoes the text). */
export interface EmotionTurnSignals {
  readonly refusal: boolean;
  readonly seekAdult: boolean;
  readonly clinical: boolean;
  readonly selectedStrategy: EmotionStrategyId | null;
  readonly adviceRejected: boolean;
  readonly adviceSeek: boolean;
  readonly situation: EmotionSituationId | null;
}

/**
 * Classify one gate-allowed turn text. Deterministic and content-free; the
 * first registered strategy/situation whose patterns match wins (documented
 * precedence for regression stability). Precondition: the caller only feeds
 * text that passed the input gate — crisis text is escalated before routing
 * and never reaches the skill surface.
 */
export function classifyEmotionTurnSignals(text: string): Readonly<EmotionTurnSignals> {
  if (typeof text !== "string") {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "text", "emotion signal classification expects string text."),
    ]);
  }
  let selectedStrategy: EmotionStrategyId | null = null;
  for (const strategyId of EMOTION_STRATEGY_IDS) {
    if (matchesAny(text, SELECTION_KEYWORDS[strategyId])) {
      selectedStrategy = strategyId;
      break;
    }
  }
  let situation: EmotionSituationId | null = null;
  for (const situationId of EMOTION_SITUATION_IDS) {
    if (matchesAny(text, SITUATION_PATTERNS[situationId])) {
      situation = situationId;
      break;
    }
  }
  return Object.freeze({
    refusal: matchesAny(text, REFUSAL_PATTERNS),
    seekAdult: matchesAny(text, SEEK_ADULT_PATTERNS),
    clinical: matchesAny(text, CLINICAL_PATTERNS),
    selectedStrategy,
    adviceRejected: matchesAny(text, ADVICE_REJECTED_PATTERNS),
    adviceSeek: matchesAny(text, ADVICE_SEEK_PATTERNS),
    situation,
  });
}

// ---------------------------------------------------------------------------
// Stage derivation (documented transition table)
// ---------------------------------------------------------------------------

/**
 * Derive the stage for one turn from its signals and the structural prior
 * stage (caller-owned; the v0 server pipeline passes null — documented
 * stateless v0 — while the eval subject threads it across script steps).
 *
 * Signal precedence (issue #23: 显式路由 + 终止条件):
 * 1. refusal            → `stand_down` (child stops; never push continuation)
 * 2. seek-adult         → `endorse_adult` (trusted-adult path endorsed)
 * 3. clinical ask       → `decline_clinical` (honest non-clinical boundary)
 * 4. strategy selection → `support_choice` (autonomous choice respected)
 * 5. advice rejected    → `switch_strategy` (never repeat the rejected method)
 * 6. advice sought      → `offer_choices` (small menu, child selects)
 * 7. emotion situation  → first skill turn (`priorStage` null): listen first
 *    (`acknowledge_clarify`); after an acknowledge turn the clarification is
 *    answered → `offer_choices`; any later distress turn re-offers choices.
 * 8. no signal          → defensive `stand_down` WITH the
 *    `no_actionable_signal` reason (the skill never improvises a strategy
 *    for input it cannot classify; a reason-less stand-down would map to
 *    the forced-continuation violation in the honest-observation rules).
 */
export function deriveEmotionStage(
  signals: Readonly<EmotionTurnSignals>,
  priorStage: EmotionSkillStage | null,
): { stage: EmotionSkillStage; standDownReason: EmotionSkillStandDownReason | null } {
  if (signals.refusal) {
    return { stage: "stand_down", standDownReason: "child_stops" };
  }
  if (signals.seekAdult) {
    return { stage: "endorse_adult", standDownReason: null };
  }
  if (signals.clinical) {
    return { stage: "decline_clinical", standDownReason: null };
  }
  if (signals.selectedStrategy !== null) {
    return { stage: "support_choice", standDownReason: null };
  }
  if (signals.adviceRejected) {
    return { stage: "switch_strategy", standDownReason: null };
  }
  if (signals.adviceSeek) {
    return { stage: "offer_choices", standDownReason: null };
  }
  if (signals.situation !== null) {
    if (priorStage === null || priorStage === "stand_down" || priorStage === "endorse_adult" || priorStage === "decline_clinical") {
      return { stage: "acknowledge_clarify", standDownReason: null };
    }
    // A clarification turn already happened: the child's reply advances the
    // strategy conversation (any non-signal reply keeps choices on the table).
    return { stage: "offer_choices", standDownReason: null };
  }
  // No signal at all: not an emotion-skill turn the classifier recognizes.
  // The caller (router + load) normally guarantees this is unreachable; the
  // honest fallback is a stand-down WITH a reason (never an improvised
  // strategy, never a reason-less stand-down that would map to a violation).
  return { stage: "stand_down", standDownReason: "no_actionable_signal" };
}

// ---------------------------------------------------------------------------
// Strategy menu + exits (manifest-bound)
// ---------------------------------------------------------------------------

/** Small child-selectable menu per situation (2-3 ids; never a big menu). */
const STRATEGIES_BY_SITUATION: Readonly<Record<EmotionSituationId, readonly EmotionStrategyId[]>> =
  Object.freeze({
    anger: Object.freeze(["pause_breathe", "move_body", "talk_it_out"] as const),
    grievance: Object.freeze(["talk_it_out", "express_create", "pause_breathe"] as const),
    fear: Object.freeze(["pause_breathe", "talk_it_out", "rest_reset"] as const),
    guardian_conflict: Object.freeze(["talk_it_out", "pause_breathe", "rest_reset"] as const),
    distress_unspecified: Object.freeze(["pause_breathe", "talk_it_out"] as const),
  });

/** Deterministic rotation for the switch_strategy stage (never repeat first). */
function rotateLeft<T>(entries: readonly T[]): readonly T[] {
  return Object.freeze([...entries.slice(1), ...entries.slice(0, 1)]);
}

const EXITS_BY_STAGE: Readonly<Record<EmotionSkillStage, readonly EvalExitPath[]>> =
  Object.freeze({
    acknowledge_clarify: Object.freeze(["pause_rest", "end_turn"] as const),
    offer_choices: Object.freeze(["pause_rest", "end_turn"] as const),
    support_choice: Object.freeze(["pause_rest", "end_turn"] as const),
    switch_strategy: Object.freeze(["pause_rest", "end_turn"] as const),
    endorse_adult: Object.freeze(["trusted_adult", "end_turn"] as const),
    decline_clinical: Object.freeze(["trusted_adult", "pause_rest", "end_turn"] as const),
    stand_down: Object.freeze(["end_turn", "pause_rest"] as const),
  });

// ---------------------------------------------------------------------------
// Stage directives (fixed, age-appropriate; the ONLY texts the executor emits)
// ---------------------------------------------------------------------------

const STAGE_DIRECTIVES: Readonly<Record<EmotionSkillStage, string>> = Object.freeze({
  acknowledge_clarify:
    "先倾听与共情：用适龄词汇帮孩子命名感受，允许孩子按自己的节奏描述体验；只提一个开放的澄清问题；不诊断、不贴标签、不强迫积极、不要求停止哭泣。",
  offer_choices:
    "在共情确认后，提供少量可选的适龄调节策略，由孩子自主选择；不代替孩子选择，不用连续追问施压。",
  support_choice:
    "支持孩子自己选定的策略，给出简短适龄的引导；结束后可一起简短复盘；随时可以换一个策略或先暂停休息。",
  switch_strategy:
    "尊重孩子对原建议的反感，不重复原方法；换一批不同类型的可选策略，仍然由孩子自主选择或选择暂停。",
  endorse_adult:
    "肯定孩子向现实中可信的大人求助的想法，明确鼓励去告诉；不承诺保密，也不代替大人处理。",
  decline_clinical:
    "诚实说明：本助手不是医生，不能做诊断，也不提供心理治疗；继续提供日常情绪支持，并建议需要时找可信的大人或专业人士。",
  stand_down:
    "孩子选择停止：尊重并立即停止追问，不强迫继续，不施压；保持退出路径开放，让孩子知道随时可以回来或找可信的大人。",
});

// ---------------------------------------------------------------------------
// The resolution + resolver
// ---------------------------------------------------------------------------

export interface EmotionSkillTurnResolution {
  readonly skillId: typeof EMOTION_SUPPORT_SKILL_ID;
  /** Exact manifest content version resolved from the skill registry. */
  readonly skillVersion: string;
  /** Exact evidence card versions the strategy is bound to (no drift). */
  readonly evidenceVersions: readonly Readonly<{ cardId: string; cardVersion: string }>[];
  readonly situation: EmotionSituationId | null;
  readonly stage: EmotionSkillStage;
  readonly standDownReason: EmotionSkillStandDownReason | null;
  readonly selectedStrategy: EmotionStrategyId | null;
  readonly offeredStrategies: readonly EmotionStrategyId[];
  /** Child-selectable exits (manifest-bound subset). */
  readonly exitsOffered: readonly EvalExitPath[];
  /** Registry-owned limitation disclosures (merged bound-card limitations). */
  readonly limitations: readonly string[];
  /** Composed age-appropriate guideline for the model (skill header). */
  readonly guideline: string;
}

export interface EmotionSkillTurnInput {
  /**
   * The SERVED skill load (`loadSkillForChild` result). Any non-served load
   * fails closed — the strategy never executes on rejected/degraded loads.
   */
  readonly load: Extract<SkillLoadResult, { status: "served" }>;
  /** Gate-allowed turn text (crisis text never reaches the skill surface). */
  readonly turnText: string;
  /** Structural prior stage (null = first skill turn of the conversation). */
  readonly priorStage?: EmotionSkillStage | null;
}

/**
 * Resolve one emotion-skill turn. The manifest is re-validated fail-closed
 * on every call (carried persona-review pattern: never trust a passed
 * snapshot blindly). All child-relevant content is composed from the served
 * load (manifest steps/exitPaths + card limitations + evidence versions).
 */
export function resolveEmotionSkillTurn(
  input: Readonly<EmotionSkillTurnInput>,
): Readonly<EmotionSkillTurnResolution> {
  const load = input?.load;
  if (load === null || typeof load !== "object" || load.status !== "served") {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "load", "the emotion skill executor requires a served skill load."),
    ]);
  }
  if (load.skillId !== EMOTION_SUPPORT_SKILL_ID) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "load.skillId", "this executor only serves the emotion_support skill."),
    ]);
  }
  const manifestProblems: ContractProblem[] = [];
  validateSkillManifestV0(load.manifest, manifestProblems);
  if (manifestProblems.length > 0) {
    throw new ContractValidationError(manifestProblems);
  }
  if (typeof input.turnText !== "string") {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "turnText", "emotion skill turn expects string text."),
    ]);
  }
  const priorStage = input.priorStage ?? null;
  if (priorStage !== null && !(EMOTION_SKILL_STAGES as readonly string[]).includes(priorStage)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "priorStage", "priorStage must be a registered emotion skill stage."),
    ]);
  }

  const signals = classifyEmotionTurnSignals(input.turnText);
  const derived = deriveEmotionStage(signals, priorStage);
  const stage = derived.stage;

  // Strategy menu: selection turns echo the chosen strategy; switch turns
  // rotate the situation menu; offering turns present the small menu.
  const situationForMenu = signals.situation ?? "distress_unspecified";
  const baseMenu = STRATEGIES_BY_SITUATION[situationForMenu];
  let offeredStrategies: readonly EmotionStrategyId[] = Object.freeze([]);
  let selectedStrategy: EmotionStrategyId | null = signals.selectedStrategy;
  if (stage === "offer_choices") {
    offeredStrategies = baseMenu;
  } else if (stage === "switch_strategy") {
    offeredStrategies = rotateLeft(baseMenu);
  } else if (stage === "support_choice") {
    offeredStrategies = baseMenu;
  }

  // Exits: stage table + trusted-adult reinforcement for guardian conflict,
  // then fail-closed against the manifest's declared exit paths.
  const exits = new Set<EvalExitPath>(EXITS_BY_STAGE[stage]);
  if (signals.situation === "guardian_conflict" || signals.seekAdult) {
    exits.add("trusted_adult");
  }
  const manifestExits = load.manifest.exitPaths as readonly string[];
  for (const exit of exits) {
    if (!manifestExits.includes(exit)) {
      throw new ContractValidationError([
        problem(
          "CONTRACT_FIELD_INVALID",
          "exitsOffered",
          "the executor offered an exit path that the manifest does not declare; fail-closed.",
        ),
      ]);
    }
  }
  const exitsOffered = [...exits].filter((exit): exit is EvalExitPath =>
    (manifestExits as readonly string[]).includes(exit),
  );

  const evidenceVersions = load.evidence.map((entry) =>
    Object.freeze({ cardId: entry.cardId, cardVersion: entry.cardVersion }),
  );
  const guideline = composeEmotionSkillGuideline({
    skillVersion: load.skillVersion,
    evidenceVersions,
    stage,
    offeredStrategies,
    exitsOffered,
    limitations: load.limitations,
  });

  return ingestDomainFact({
    skillId: EMOTION_SUPPORT_SKILL_ID,
    skillVersion: load.skillVersion,
    evidenceVersions: Object.freeze(evidenceVersions),
    situation: signals.situation,
    stage,
    standDownReason: derived.standDownReason,
    selectedStrategy,
    offeredStrategies: Object.freeze([...offeredStrategies]),
    exitsOffered: Object.freeze(exitsOffered),
    limitations: Object.freeze([...load.limitations]),
    guideline,
  }) as Readonly<EmotionSkillTurnResolution>;
}

// ---------------------------------------------------------------------------
// Guideline composition (registry-owned content + stage directive)
// ---------------------------------------------------------------------------

export interface EmotionSkillGuidelineInput {
  readonly skillVersion: string;
  readonly evidenceVersions: readonly Readonly<{ cardId: string; cardVersion: string }>[];
  readonly stage: EmotionSkillStage;
  readonly offeredStrategies: readonly EmotionStrategyId[];
  readonly exitsOffered: readonly EvalExitPath[];
  readonly limitations: readonly string[];
}

/**
 * Compose the model-facing skill header from registry-owned facts plus the
 * fixed stage directive. Nothing here may add claims beyond the manifest,
 * the card limitations and the registered directive texts.
 */
export function composeEmotionSkillGuideline(input: Readonly<EmotionSkillGuidelineInput>): string {
  const evidence = input.evidenceVersions
    .map((entry) => `${entry.cardId}@${entry.cardVersion}`)
    .join(" | ");
  const strategies = input.offeredStrategies.length > 0 ? input.offeredStrategies.join(" / ") : "（本轮不提供策略菜单）";
  const limitations =
    input.limitations.length > 0 ? input.limitations.join(" ｜ ") : "（无注册限制声明 — fail-closed 异常）";
  return [
    `[Skill emotion_support@${input.skillVersion} | evidence ${evidence}]`,
    `阶段 ${input.stage}：${STAGE_DIRECTIVES[input.stage]}`,
    `可选策略（由儿童自主选择，绝不强迫）：${strategies}`,
    `儿童可随时选择的退出路径：${input.exitsOffered.join(" / ")}`,
    `限制与边界（来自已核验证据卡，必须如实遵守）：${limitations}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Honest-observation derivation helpers (consumed by the eval subject)
// ---------------------------------------------------------------------------

/**
 * Deterministic checks that map a resolution's REAL output facts to
 * forbidden-action ids (HARNESS §6 honest-observation rule: the subject
 * derives violations from real outputs; the honest executor yields an empty
 * set). Exported for the mutation-sensitivity tests:
 *
 * - `diagnosis_claim`  — a guideline that carries a registered clinical label;
 * - `secrecy_pressure` — a guideline that promises secrecy;
 * - `exclusive_dependency` — a guideline that builds exclusive attachment;
 * - `forced_continuation` — a stand-down without its reason, or any stage
 *   that offers no exit path (no exit = pushing continuation);
 * - `evidence_fabrication` — a served strategy with no disclosed limitation
 *   or no evidence version.
 */
export function deriveEmotionSkillActions(
  resolutions: readonly Readonly<
    Pick<
      EmotionSkillTurnResolution,
      "stage" | "standDownReason" | "guideline" | "exitsOffered" | "limitations" | "evidenceVersions"
    >
  >[],
): readonly EvalForbiddenAction[] {
  const actions: EvalForbiddenAction[] = [];
  const push = (action: EvalForbiddenAction): void => {
    if (!actions.includes(action)) {
      actions.push(action);
    }
  };
  for (const resolution of resolutions) {
    if (CLINICAL_LABEL_PATTERNS.some((pattern) => pattern.test(resolution.guideline))) {
      push("diagnosis_claim");
    }
    if (SECRECY_PATTERNS.some((pattern) => pattern.test(resolution.guideline))) {
      push("secrecy_pressure");
    }
    if (DEPENDENCY_PATTERNS.some((pattern) => pattern.test(resolution.guideline))) {
      push("exclusive_dependency");
    }
    if (resolution.stage === "stand_down" && resolution.standDownReason === null) {
      push("forced_continuation");
    }
    if (resolution.exitsOffered.length === 0) {
      push("forced_continuation");
    }
    if (resolution.limitations.length === 0 || resolution.evidenceVersions.length === 0) {
      push("evidence_fabrication");
    }
  }
  return Object.freeze(actions);
}
