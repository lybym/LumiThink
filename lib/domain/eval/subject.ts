/**
 * R1-07 evaluation subject adapter (docs/HARNESS.md §6).
 *
 * The subject is the behavior surface under evaluation: skill routing,
 * performed policy-relevant actions, cited Evidence Cards and offered
 * exit/help paths. R1-07 delivers the harness CONTRACT plus this adapter
 * interface; the real Persona/Skill Router/Gateway (R1-04/R1-13 and the
 * R1-11/R1-12 skills) plugs in later through the same interface, so the
 * versioned scenario suite stays the single regression target.
 *
 * v0 ships a deterministic synthetic reference subject: a fixed, versioned
 * behavior table over the fixture suite. It exists to keep the full offline
 * regression executable in CI without a real model (issue #19 AC 3) and to
 * provide a stable baseline for before/after comparisons — it is NOT a
 * claim of product behavior. Assertion sensitivity is proven by negative
 * controls (mutation subjects) in tests/domain/eval/runner.spec.ts.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { ContractValidationError, problem } from "../contract/core.ts";
import { EVAL_SKILL_IDS, type EvalForbiddenAction, type EvalExitPath, type EvalScenario, type EvalSkillId, type EvalSkillRoute } from "./scenario.ts";
import { REFERENCE_SUBJECT_OBSERVATIONS } from "./fixtures.ts";

/**
 * Version stamps a subject can carry about the governance surfaces it
 * exercises (HARNESS §6.4 version-stamp merge, delivered with the first
 * real-skill subject wiring in R1-11 / issue #23). The runner copies these
 * onto the report when present; both id sets and versions are validated
 * fail-closed in the report parser. Skill/Evidence versions recorded here
 * are RESOLVED from the shipped registries by the subject — never
 * self-declared numbers.
 */
export interface EvalSubjectVersionStamps {
  readonly skills: readonly Readonly<{ readonly skillId: EvalSkillId; readonly version: string }>[];
  readonly evidence: readonly Readonly<{ readonly cardId: string; readonly version: string }>[];
}

/** What the subject actually did for one scenario (structural facts only). */
export interface EvalObservation {
  readonly routedSkill: EvalSkillRoute;
  /** Policy-relevant actions the subject performed (registry vocabulary). */
  readonly actions: readonly EvalForbiddenAction[];
  /** Evidence card ids the subject cited. */
  readonly citedEvidence: readonly string[];
  /** Exit / help-seeking paths the subject offered. */
  readonly exitPaths: readonly EvalExitPath[];
  /**
   * When present, the subject declares it cannot exercise the surface this
   * scenario targets. The runner records the scenario as SKIP; critical and
   * safety-critical skips fail the suite (issue #19 AC 2).
   */
  readonly unsupportedReason?: string;
}

export interface EvalSubject {
  /** Stable subject identity, recorded in every report for comparisons. */
  readonly subjectId: string;
  readonly subjectVersion: string;
  /** Structural description of what the subject represents. */
  readonly note: string;
  /**
   * Optional version stamps of the governance surfaces this subject
   * exercises (merged into the v1.1 report when present; HARNESS §6.4).
   */
  readonly versionStamps?: EvalSubjectVersionStamps;
  observe(scenario: Readonly<EvalScenario>): Readonly<EvalObservation>;
}

export const SYNTHETIC_REFERENCE_SUBJECT_ID = "synthetic_reference_subject" as const;

/** v0 reference subject version; bump only with a suite review. */
export const SYNTHETIC_REFERENCE_SUBJECT_VERSION = "0.1.0" as const;

/**
 * The v0 synthetic reference subject. Every observation comes from the
 * hand-written table in fixtures.ts; asking for an unknown scenario fails
 * closed instead of inventing an answer.
 */
export function createSyntheticReferenceSubject(): EvalSubject {
  return Object.freeze({
    subjectId: SYNTHETIC_REFERENCE_SUBJECT_ID,
    subjectVersion: SYNTHETIC_REFERENCE_SUBJECT_VERSION,
    note: "Deterministic v0 behavior table over the fixture suite; stands in " +
      "for the real Persona/Skill/Gateway surface until R1-04/R1-13 wire it.",
    observe(scenario: Readonly<EvalScenario>): Readonly<EvalObservation> {
      const observation = REFERENCE_SUBJECT_OBSERVATIONS[scenario.scenarioId];
      if (observation === undefined) {
        // Fail closed: the reference subject never invents behavior for a
        // scenario it was not scripted for.
        throw new ContractValidationError([
          problem(
            "CONTRACT_FIELD_INVALID",
            "scenarioId",
            "the synthetic reference subject has no scripted observation for this scenario id.",
          ),
        ]);
      }
      return observation;
    },
  });
}
