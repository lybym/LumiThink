/**
 * R1-12 homework-skill comparison suite (issue #24 AC 3: "专业评测覆盖
 * 适用/不适用/愤怒/拒绝/策略失败及渐退支持，输出可追踪证据版本"; the
 * comparison pattern carried from R1-11 / issue #23 AC 3).
 *
 * `lumithink_homework_skill_eval_suite` v1.0.0 is the versioned comparison
 * matrix for the homework skill surface: it projects the five shipped
 * homework scenarios of `lumithink_eval_suite` (the homework manifest's
 * `evaluationRefs`, unchanged scenario objects) under a dedicated suite id,
 * so the SAME scenarios can be run through the SAME harness against
 * different subjects:
 *
 * - the synthetic reference subject (`synthetic_reference_subject@0.1.0`,
 *   the v0 baseline stand-in) — the "old" behavior;
 * - the real homework-skill subject (`homework_initiation_skill_subject`,
 *   lib/domain/skills/homework-eval-subject.ts) — the "new" surface;
 * - mutation controls that simulate a regressed skill version.
 *
 * `compareEvalRuns` then refuses nothing (same schema/suite/scenario set)
 * and classifies every transition — the new-vs-old version diff is a real,
 * reproducible harness comparison, not a prose claim. The projection is
 * derived from the shipped fixture at module load (never re-typed), so the
 * comparison matrix can never drift from the shipped scenarios. The
 * multi-turn subject scripts additionally thread 适用 → 拆分/示范 → 自主
 * 选择 → 策略失败 → 渐退/暂停 through the real stage machine, and every
 * served resolution carries the resolved skill/evidence versions (可追踪
 * 证据版本, issue #25 acceptance criterion 2).
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { EVAL_SUITE_V1 } from "../eval/fixtures.ts";
import type { EvalSuiteFixture } from "../eval/scenario.ts";

export const HOMEWORK_SKILL_EVAL_SUITE_ID = "lumithink_homework_skill_eval_suite" as const;
export const HOMEWORK_SKILL_EVAL_SUITE_VERSION = "1.0.0" as const;

/**
 * Project the shipped homework scenarios into the comparison suite. The
 * scenario objects are reused verbatim (same ids, expectations and gate
 * probes); only the suite envelope differs, which is exactly what
 * `compareEvalRuns` keys its comparability rule on.
 */
export function deriveHomeworkSkillEvalSuite(): Readonly<EvalSuiteFixture> {
  const scenarios = EVAL_SUITE_V1.scenarios.filter(
    (scenario) => scenario.skill === "homework_initiation",
  );
  if (scenarios.length === 0) {
    // Fail closed: an empty comparison matrix would trigger the runner's
    // empty_suite trigger instead of silently comparing nothing.
    throw new Error("the homework skill comparison suite requires the shipped homework scenarios.");
  }
  return Object.freeze({
    suiteId: HOMEWORK_SKILL_EVAL_SUITE_ID,
    suiteVersion: HOMEWORK_SKILL_EVAL_SUITE_VERSION,
    scenarios: Object.freeze(scenarios.map((scenario) => Object.freeze(scenario))),
    evidence: EVAL_SUITE_V1.evidence,
  });
}
