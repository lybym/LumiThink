/**
 * R1-11 emotion-skill comparison suite (issue #23 AC 3: "同一场景新旧版本
 * 差异通过 Eval Harness").
 *
 * `lumithink_emotion_skill_eval_suite` v1.0.0 is the versioned comparison
 * matrix for the emotion skill surface: it projects the five shipped
 * emotion scenarios of `lumithink_eval_suite` (the emotion manifest's
 * `evaluationRefs`, unchanged scenario objects) under a dedicated suite id,
 * so the SAME scenarios can be run through the SAME harness against
 * different subjects:
 *
 * - the synthetic reference subject (`synthetic_reference_subject@0.1.0`,
 *   the v0 baseline stand-in) — the "old" behavior;
 * - the real emotion-skill subject (`emotion_support_skill_subject`,
 *   lib/domain/skills/emotion-eval-subject.ts) — the "new" surface;
 * - mutation controls that simulate a regressed skill version.
 *
 * `compareEvalRuns` then refuses nothing (same schema/suite/scenario set)
 * and classifies every transition — the AC's new-vs-old version diff is a
 * real, reproducible harness comparison, not a prose claim. The projection
 * is derived from the shipped fixture at module load (never re-typed), so
 * the comparison matrix can never drift from the shipped scenarios.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { EVAL_SUITE_V1 } from "../eval/fixtures.ts";
import type { EvalSuiteFixture } from "../eval/scenario.ts";

export const EMOTION_SKILL_EVAL_SUITE_ID = "lumithink_emotion_skill_eval_suite" as const;
export const EMOTION_SKILL_EVAL_SUITE_VERSION = "1.0.0" as const;

/**
 * Project the shipped emotion scenarios into the comparison suite. The
 * scenario objects are reused verbatim (same ids, expectations and gate
 * probes); only the suite envelope differs, which is exactly what
 * `compareEvalRuns` keys its comparability rule on.
 */
export function deriveEmotionSkillEvalSuite(): Readonly<EvalSuiteFixture> {
  const scenarios = EVAL_SUITE_V1.scenarios.filter(
    (scenario) => scenario.skill === "emotion_support",
  );
  if (scenarios.length === 0) {
    // Fail closed: an empty comparison matrix would trigger the runner's
    // empty_suite trigger instead of silently comparing nothing.
    throw new Error("the emotion skill comparison suite requires the shipped emotion scenarios.");
  }
  return Object.freeze({
    suiteId: EMOTION_SKILL_EVAL_SUITE_ID,
    suiteVersion: EMOTION_SKILL_EVAL_SUITE_VERSION,
    scenarios: Object.freeze(scenarios.map((scenario) => Object.freeze(scenario))),
    evidence: EVAL_SUITE_V1.evidence,
  });
}
