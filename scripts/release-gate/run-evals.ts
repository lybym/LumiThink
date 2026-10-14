/**
 * R1-10 (issue #22) release evaluation runner.
 *
 * Executes the four release suites through the ONE harness (`runEvaluation`,
 * HARNESS §6) against their bound subjects:
 *
 * - `lumithink_eval_suite` (baseline coverage matrix: 双 Skill ×
 *   适用/不适用/策略无效/拒绝/危机 + 工具越权 + 假记忆 + 证据越界 +
 *   Prompt 注入) over the synthetic reference subject — the deterministic
 *   safety baseline (real gate probes run through the REAL safety pipeline);
 * - `lumithink_persona_eval_suite` over the REAL persona surface;
 * - `lumithink_emotion_skill_eval_suite` over the REAL emotion-skill surface;
 * - `lumithink_homework_skill_eval_suite` over the REAL homework-skill surface.
 *
 * Reports are serialized content-free (canonical JSON, schema v1.1) into the
 * requested directory for the gate verifier; scenario text, observations and
 * child data never enter a report by construction.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  EVAL_SUITE_V1,
  createSyntheticReferenceSubject,
  runEvaluation,
  serializeEvalRunReport,
  type EvalRunReport,
} from "../../lib/domain/eval/index.ts";
import { PERSONA_EVAL_SUITE_V1 } from "../../lib/domain/persona/eval-suite.ts";
import { createPersonaEvalSubject } from "../../lib/domain/persona/eval-subject.ts";
import { deriveEmotionSkillEvalSuite } from "../../lib/domain/skills/emotion-eval-suite.ts";
import { createEmotionSkillEvalSubject } from "../../lib/domain/skills/emotion-eval-subject.ts";
import { deriveHomeworkSkillEvalSuite } from "../../lib/domain/skills/homework-eval-suite.ts";
import { createHomeworkSkillEvalSubject } from "../../lib/domain/skills/homework-eval-subject.ts";

export interface ReleaseEvalRun {
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly subjectId: string;
  readonly report: EvalRunReport;
  readonly serialized: string;
}

/** Run all four release suites through the real harness. */
export function runReleaseEvaluations(): readonly ReleaseEvalRun[] {
  const runs: ReleaseEvalRun[] = [];
  const push = (suiteId: string, suiteVersion: string, subjectId: string, report: EvalRunReport) => {
    runs.push({
      suiteId,
      suiteVersion,
      subjectId,
      report,
      serialized: serializeEvalRunReport(report),
    });
  };

  const baseline = runEvaluation(EVAL_SUITE_V1, createSyntheticReferenceSubject());
  push(EVAL_SUITE_V1.suiteId, EVAL_SUITE_V1.suiteVersion, baseline.subjectId, baseline);

  const persona = runEvaluation(PERSONA_EVAL_SUITE_V1, createPersonaEvalSubject());
  push(PERSONA_EVAL_SUITE_V1.suiteId, PERSONA_EVAL_SUITE_V1.suiteVersion, persona.subjectId, persona);

  const emotionSuite = deriveEmotionSkillEvalSuite();
  const emotion = runEvaluation(emotionSuite, createEmotionSkillEvalSubject());
  push(emotionSuite.suiteId, emotionSuite.suiteVersion, emotion.subjectId, emotion);

  const homeworkSuite = deriveHomeworkSkillEvalSuite();
  const homework = runEvaluation(homeworkSuite, createHomeworkSkillEvalSubject());
  push(homeworkSuite.suiteId, homeworkSuite.suiteVersion, homework.subjectId, homework);

  return Object.freeze(runs);
}

/** Write the reports (content-free canonical JSON) and print a summary. */
export function writeReleaseEvalReports(outDir: string): readonly ReleaseEvalRun[] {
  const runs = runReleaseEvaluations();
  mkdirSync(outDir, { recursive: true });
  for (const run of runs) {
    writeFileSync(join(outDir, `${run.suiteId}.report.json`), run.serialized, "utf8");
    console.log(
      `suite=${run.suiteId} version=${run.suiteVersion} subject=${run.subjectId} ` +
        `status=${run.report.status} total=${run.report.counts.total} ` +
        `pass=${run.report.counts.pass} fail=${run.report.counts.fail} skip=${run.report.counts.skip} ` +
        `triggers=${run.report.failClosedTriggers.length} ` +
        `pendingHumanReview=${run.report.pendingHumanReview.length}`,
    );
  }
  const failed = runs.filter((run) => run.report.status !== "pass");
  if (failed.length > 0) {
    console.error(`release evaluation failed for ${failed.length} suite(s); reports kept for the gate`);
  }
  return runs;
}
