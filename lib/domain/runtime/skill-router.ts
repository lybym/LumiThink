/**
 * R1-03 Skill Router (issue #15, docs/HARNESS.md §1 component 3
 * "Orchestrator ──路由：普通对话 / 专业 Skill / 场景工具").
 *
 * v0 routing is DETERMINISTIC over the input text (synthetic corpus rules),
 * answering the HARNESS.md §8.3 open question ("Orchestrator 对双 Skill
 * 冲突请求的仲裁规则") with one fixed, documented arbitration rule:
 *
 *   when both an emotion signal and a homework signal appear in the same
 *   turn, emotion_support takes precedence — emotional readiness gates
 *   learning support (R0 scenario 3: "能从倾听转向任务澄清，不机械执行
 *   两个相互矛盾的 Agent"). The arbitration fact is recorded so the eval
 *   layer can regress it.
 *
 * Invariants:
 * - the router can only emit registered skill ids (EVAL_SKILL_IDS) or
 *   "none" — no caller input can add a route;
 * - routing never executes anything and never consults the model;
 * - the same input always yields the same route (deterministic regression
 *   surface; LLM-based routing belongs to a later, evaluated iteration);
 * - the router sees ONLY gate-allowed text: the pipeline calls it after the
 *   input gate, so crisis/injection text never reaches routing.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { ContractValidationError, problem } from "../contract/core.ts";
import { ingestDomainFact } from "../legacy-guard.ts";
import { EVAL_SKILL_IDS, type EvalSkillRoute } from "../eval/scenario.ts";

/** Version of the deterministic routing rule set (trace fact). */
export const SKILL_ROUTER_VERSION = "1.0" as const;

/** Why the router decided (enumerated; never echoes the submitted text). */
export const SKILL_ROUTE_REASONS = Object.freeze([
  "emotion_signal",
  "homework_signal",
  "joint_emotion_precedence",
  "no_signal",
] as const);

export type SkillRouteReason = (typeof SKILL_ROUTE_REASONS)[number];

export interface SkillRouteDecision {
  readonly route: EvalSkillRoute;
  readonly reason: SkillRouteReason;
  /** Present exactly when both signals competed and one was arbitrated. */
  readonly arbitration: "emotion_precedence" | null;
  readonly routerVersion: typeof SKILL_ROUTER_VERSION;
}

/**
 * v0 signal patterns, tuned to the synthetic corpus (R0-C scenarios and the
 * eval suite). Conservative: a miss degrades to normal conversation, which
 * is the safe direction for v0 (skill absence never bypasses a gate).
 */
const EMOTION_SIGNAL_PATTERNS: readonly RegExp[] = Object.freeze([
  /委屈/,
  /难过/,
  /伤心/,
  /生气/,
  /愤怒/,
  /害怕/,
  /恐惧/,
  /烦躁/,
  /郁闷/,
  /不开心/,
  /不想(?:继续|说话|讲|学)/,
  /好烦/,
  /\bsad\b/i,
  /\bangry\b/i,
  /\bupset\b/i,
  /\bscared\b/i,
  /\bfrustrated\b/i,
]);

const HOMEWORK_SIGNAL_PATTERNS: readonly RegExp[] = Object.freeze([
  /作业/,
  /数学题/,
  /(?:一道|这道|那道)?题(?:目|)?(?:不会|好难|太难)/,
  /不会做/,
  /不会写/,
  /功课/,
  /习题/,
  /\bhomework\b/i,
  /\bmath\b/i,
  /\bstuck\b/i,
]);

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Route one gate-allowed turn text to a registered skill (or none).
 * Deterministic; the submitted text is never part of the result.
 */
export function routeSkillForText(text: string): Readonly<SkillRouteDecision> {
  if (typeof text !== "string") {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "text", "skill router expects string text."),
    ]);
  }
  const emotion = matchesAny(text, EMOTION_SIGNAL_PATTERNS);
  const homework = matchesAny(text, HOMEWORK_SIGNAL_PATTERNS);
  let decision: SkillRouteDecision;
  if (emotion && homework) {
    decision = {
      route: "emotion_support",
      reason: "joint_emotion_precedence",
      arbitration: "emotion_precedence",
      routerVersion: SKILL_ROUTER_VERSION,
    };
  } else if (emotion) {
    decision = {
      route: "emotion_support",
      reason: "emotion_signal",
      arbitration: null,
      routerVersion: SKILL_ROUTER_VERSION,
    };
  } else if (homework) {
    decision = {
      route: "homework_initiation",
      reason: "homework_signal",
      arbitration: null,
      routerVersion: SKILL_ROUTER_VERSION,
    };
  } else {
    decision = {
      route: "none",
      reason: "no_signal",
      arbitration: null,
      routerVersion: SKILL_ROUTER_VERSION,
    };
  }
  // Defensive: the route vocabulary is closed.
  if (!(EVAL_SKILL_IDS as readonly string[]).includes(decision.route) && decision.route !== "none") {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "route", "router produced an unregistered route."),
    ]);
  }
  return ingestDomainFact(decision) as Readonly<SkillRouteDecision>;
}
