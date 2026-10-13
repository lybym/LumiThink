/**
 * R1-15 synthetic crisis handling branch (docs/SAFETY_POLICY.md §5).
 *
 * PRD §10.1 / issue #27: when self-harm, abuse or severe danger cues appear,
 * the system must suspend its normal advice script and answer with a
 * non-diagnostic, age-appropriate safety response that encourages the child
 * to contact a trusted adult and appropriate local emergency support — while
 * never promising secrecy and never claiming that the AI alone can handle
 * the crisis.
 *
 * v0 is deterministic: detection uses fixed pattern rules and the response
 * is built from fixed templates, so the crisis path is fully testable
 * (quality tuning of recall/false positives belongs to R1-07 evaluation).
 * No real child data, hotlines are placeholders that a production
 * deployment must verify for its own jurisdiction.
 */

import { ContractValidationError, problem } from "../contract/core.ts";

/** Crisis categories recognized by the v0 synthetic rules. */
export const CRISIS_CATEGORIES = Object.freeze([
  "self_harm",
  "abuse",
  "severe_danger",
] as const);
export type CrisisCategory = (typeof CRISIS_CATEGORIES)[number];

/** Deterministic assessment result; category priority is fixed (see below). */
export interface CrisisAssessment {
  readonly category: CrisisCategory;
}

/**
 * v0 crisis cue patterns. Written against the synthetic corpus; they are
 * deliberately conservative to keep recall high on high-severity cues,
 * accepting possible false positives (a false block is the safe direction).
 */
const CRISIS_PATTERNS: Readonly<Record<CrisisCategory, readonly RegExp[]>> =
  Object.freeze({
    self_harm: Object.freeze([
      /自杀/,
      /自残/,
      /自伤/,
      /想死/,
      /不想活/,
      /活不下去/,
      /结束(?:自己|我的)?(?:的)?生命/,
      /伤害自己/,
      /\bsuicid(?:e|al)\b/i,
      /\bkill\s+myself\b/i,
      /\bhurt\s+myself\b/i,
      /\bend\s+my\s+life\b/i,
      /\bcut\s+myself\b/i,
    ]),
    abuse: Object.freeze([
      /虐待/,
      /家暴/,
      /被打(?:得|的)(?:很|好|特别)?(?:惨|重|厉害)/,
      /(?:有人|爸爸|妈妈|继父|继母|家里的大人|家长)(?:经常|总是|一直在)?(?:在家里)?(?:打|揍)我/,
      /\bthey\s+(?:hit|beat)\s+me\b/i,
      /\b(?:I am|I'm)\s+being\s+abused\b/i,
      /\babuse[sd]?\s+me\b/i,
    ]),
    severe_danger: Object.freeze([
      /着火/,
      /火灾/,
      /煤气(?:泄漏|漏气)/,
      /闯入/,
      /流血不止/,
      /生命危险/,
      /(?:很|非常|特别|太)危险/,
      /\bthere(?:'s| is) a fire\b/i,
      /\bsomeone (?:broke in|broken into|is breaking in)\b/i,
      /\bbleeding (?:a lot|badly|heavily)\b/i,
      /\bemergency\b/i,
    ]),
  });

/**
 * Assessment order is fixed for determinism: self_harm > abuse >
 * severe_danger. Returns null when no crisis cue is present.
 */
export function assessCrisisSignals(text: string): CrisisAssessment | null {
  if (typeof text !== "string") {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "text", "crisis assessment expects string text."),
    ]);
  }
  for (const category of CRISIS_CATEGORIES) {
    for (const pattern of CRISIS_PATTERNS[category]) {
      if (pattern.test(text)) {
        return Object.freeze({ category });
      }
    }
  }
  return null;
}

/**
 * Emergency channels referenced by the v0 templates. These are
 * well-known public placeholder channels for the zh deployment; a
 * production rollout must configure and verify the correct local channels
 * before real use (docs/SAFETY_POLICY.md §5).
 */
export const CRISIS_LOCAL_CHANNELS = Object.freeze({
  policeAndMedical: "110 / 120",
  youthHotline: "12355",
});

/**
 * Build the deterministic crisis-safe response for the assessed category.
 *
 * Contract (asserted by tests, see tests/domain/safety/crisis.spec.ts):
 * - non-diagnostic: no clinical labels, no "you have/are …" claims;
 * - suspends normal advice: no suggestions beyond staying safe and seeking help;
 * - encourages contacting a trusted adult now;
 * - names local emergency channels;
 * - never promises secrecy; explicitly steers to adults;
 * - states the AI cannot handle the crisis alone;
 * - age-appropriate plain language; deterministic output.
 */
export function buildCrisisSafeResponse(assessment: CrisisAssessment): string {
  if (
    assessment === null ||
    typeof assessment !== "object" ||
    !(CRISIS_CATEGORIES as readonly string[]).includes(assessment.category)
  ) {
    throw new ContractValidationError([
      problem(
        "CONTRACT_FIELD_INVALID",
        "assessment",
        "crisis response requires a valid crisis assessment category.",
      ),
    ]);
  }
  const opening: Readonly<Record<CrisisCategory, string>> = Object.freeze({
    self_harm:
      "我听到了，你现在心里可能非常难受，谢谢你愿意把这件事告诉我。我不是医生，不能也不会判断你出了什么状况，" +
      "但你现在最需要的是安全，还有愿意帮助你的人。",
    abuse:
      "谢谢你愿意告诉我这些，说出来需要很大的勇气。发生这样的事不是你的错。我不能独自处理这件事，" +
      "但有一件确定的事：你值得被保护。",
    severe_danger:
      "你现在可能正处在危险中。请先放下手上的事情，尽快到安全的地方去，不要一个人留在危险的环境里。",
  });
  const closing: Readonly<Record<CrisisCategory, string>> = Object.freeze({
    self_harm:
      "接下来的每一步，都请让身边的大人陪你一起完成。你不是一个人在面对这件事，" +
      "在你联系上帮助之前，我一直在这里陪着你说话。",
    abuse:
      "接下来的每一步，都请让身边的大人陪你一起完成。你没有做错什么，也不需要一个人扛着这件事，" +
      "在你联系上帮助之前，我一直在这里陪着你说话。",
    severe_danger:
      "在你联系上帮助之前，请尽量待在安全的地方。你不是一个人在面对这件事，我一直在这里陪着你说话。",
  });
  const body =
    `现在最重要的是马上联系一位你能找到的、信任的大人——比如爸爸妈妈、家里的其他大人、老师或者同学的父母，` +
    `把刚才告诉我的事情也告诉他们。如果一时联系不上他们，或者情况紧急，请直接拨打紧急电话 ` +
    `${CRISIS_LOCAL_CHANNELS.policeAndMedical}，也可以拨打青少年服务热线 ${CRISIS_LOCAL_CHANNELS.youthHotline}，` +
    `那里有受过训练的大人会帮助你。`;

  const note =
    "这件事不需要瞒着任何大人：为了你的安全，我会一直鼓励你寻求大人的帮助，我也没办法替你处理真正的危险。" +
    "虽然我只是一个 AI，但你现在可以先把心里的感受说给我听，我们一起等你联系上帮助你的人。";

  return `${opening[assessment.category]}${body}${closing[assessment.category]}${note}`;
}
