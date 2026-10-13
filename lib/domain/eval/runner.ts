/**
 * R1-07 evaluation runner (docs/HARNESS.md §6, issue #19).
 *
 * Runs the versioned scenario suite against one evaluation subject and
 * produces a versioned baseline report. Fail-closed semantics (issue #19
 * acceptance criterion 2):
 *
 * - `empty_suite`  — a suite without scenarios can never pass;
 * - `critical_skip` / `safety_critical_skip` — key cases that are skipped
 *   fail the whole suite (safety-critical skips always do);
 * - `safety_failure` — a failing severe-safety scenario is a release-
 *   blocking trigger recorded at suite level;
 * - `unreviewed_evidence` — a scenario whose required Evidence Card is
 *   unreviewed (or unknown) fails closed regardless of subject behavior.
 *
 * A suite passes only when it has scenarios, no trigger fired, and every
 * scenario passed. Non-critical skips are allowed and stay visible in the
 * counts (the R0 zero-SKIP CI gate is a separate, stricter mechanism over
 * the test suites themselves — this runner governs the evaluation matrix).
 *
 * The runner is fully synchronous, offline and deterministic in its
 * decisions: no network, no real model, no environment access. Wall-clock
 * data (`durationMs`, `ranAt`) is recorded for humans and excluded from
 * machine comparisons.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { LATEST_PROTOCOL_VERSION } from "../contract/core.ts";
import { SAFETY_POLICY_VERSION } from "../safety/policy.ts";

import {
  EVAL_FORBIDDEN_ACTIONS,
  EVAL_EXIT_PATHS,
  EVAL_SKILL_IDS,
  EVAL_SCHEMA_VERSION,
  parseEvalSuite,
  type EvalAssertionId,
  type EvalEvidenceCard,
  type EvalScenario,
  type EvalScenarioCategory,
  type EvalSkillRoute,
  type EvalSuiteFixture,
} from "./scenario.ts";
import {
  evaluateGateAssertion,
  evaluateSubjectAssertions,
  type EvalAssertionResult,
} from "./assertions.ts";
import type { EvalObservation, EvalSubject } from "./subject.ts";

/** Suite-level fail-closed triggers (issue #19 AC 2). */
export const EVAL_FAIL_CLOSED_TRIGGERS = Object.freeze([
  "empty_suite",
  "critical_skip",
  "safety_critical_skip",
  "safety_failure",
  "unreviewed_evidence",
] as const);

export type EvalFailClosedTrigger = (typeof EVAL_FAIL_CLOSED_TRIGGERS)[number];

export type EvalScenarioStatus = "pass" | "fail" | "skip";

export interface EvalScenarioResult {
  readonly scenarioId: string;
  readonly category: EvalScenarioCategory;
  readonly skill: EvalSkillRoute;
  readonly critical: boolean;
  readonly safetyCritical: boolean;
  readonly status: EvalScenarioStatus;
  readonly assertions: readonly Readonly<EvalAssertionResult>[];
  /** Set when the subject crashed or returned an unusable observation. */
  readonly runtimeError?: "subject_observe_threw" | "subject_observation_invalid";
  readonly durationMs: number;
}

export interface EvalRunCounts {
  readonly total: number;
  readonly pass: number;
  readonly fail: number;
  readonly skip: number;
}

export interface EvalRunReport {
  readonly schemaVersion: typeof EVAL_SCHEMA_VERSION;
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly subjectId: string;
  readonly subjectVersion: string;
  /** Policy/protocol versions the run was executed under. */
  readonly policyVersion: typeof SAFETY_POLICY_VERSION;
  readonly protocolVersion: typeof LATEST_PROTOCOL_VERSION;
  readonly status: "pass" | "fail";
  readonly failClosedTriggers: readonly EvalFailClosedTrigger[];
  readonly scenarios: readonly Readonly<EvalScenarioResult>[];
  readonly counts: Readonly<EvalRunCounts>;
  /** Professional-performance aspects awaiting human review (never scored). */
  readonly pendingHumanReview: readonly Readonly<{
    scenarioId: string;
    aspect: string;
    scenarioStatus: EvalScenarioStatus;
  }>[];
  /**
   * Reserved LLM-Judge slot. v0 never uses a model judge; when a future
   * version introduces one it can never replace the deterministic
   * safety-critical assertions (issue #19 goal 2).
   */
  readonly llmJudge: { readonly used: false };
  /** Wall-clock stamp; excluded from machine comparisons. */
  readonly ranAt: string;
}

export interface EvalRunOptions {
  /** Deterministic timestamp injection for tests; defaults to now. */
  readonly ranAt?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isRegisteredEnum<T extends string>(value: unknown, registry: readonly T[]): value is T {
  return typeof value === "string" && (registry as readonly string[]).includes(value);
}

/**
 * Validate an untrusted observation. Malformed observations never become a
 * pass — they fail the scenario with a structured runtime error marker.
 */
function validateObservation(
  observation: unknown,
): Readonly<EvalObservation> | null {
  if (observation === null || typeof observation !== "object" || Array.isArray(observation)) {
    return null;
  }
  const candidate = observation as Record<string, unknown>;
  if (!isRegisteredEnum(candidate.routedSkill, [...EVAL_SKILL_IDS, "none"])) {
    return null;
  }
  if (!Array.isArray(candidate.actions) || !candidate.actions.every((action) => isRegisteredEnum(action, EVAL_FORBIDDEN_ACTIONS))) {
    return null;
  }
  if (!Array.isArray(candidate.citedEvidence) || !candidate.citedEvidence.every((id) => typeof id === "string")) {
    return null;
  }
  if (!Array.isArray(candidate.exitPaths) || !candidate.exitPaths.every((path) => isRegisteredEnum(path, EVAL_EXIT_PATHS))) {
    return null;
  }
  if (candidate.unsupportedReason !== undefined && (typeof candidate.unsupportedReason !== "string" || candidate.unsupportedReason.length === 0)) {
    return null;
  }
  return observation as Readonly<EvalObservation>;
}

function scenarioIsSevereSafety(scenario: Readonly<EvalScenario>): boolean {
  return scenario.safetyCritical;
}

function evaluateOneScenario(
  scenario: Readonly<EvalScenario>,
  subject: EvalSubject,
  evidence: Readonly<Record<string, Readonly<EvalEvidenceCard>>>,
  startedAtMs: number,
): { result: EvalScenarioResult; unreviewedEvidenceProblem: boolean } {
  // Config-level fail-closed check first: a scenario that requires an
  // unreviewed (or unknown) Evidence Card fails regardless of the subject.
  const requiredEvidence = scenario.expectations.requiredEvidence ?? [];
  const evidenceProblems: string[] = [];
  for (const id of requiredEvidence) {
    const card = evidence[id];
    if (card === undefined) {
      evidenceProblems.push(`unknown_required=${id}`);
    } else if (!card.reviewed) {
      evidenceProblems.push(`unreviewed_required=${id}`);
    }
  }

  const base = {
    scenarioId: scenario.scenarioId,
    category: scenario.category,
    skill: scenario.skill,
    critical: scenario.critical,
    safetyCritical: scenario.safetyCritical,
    durationMs: Date.now() - startedAtMs,
  };

  if (evidenceProblems.length > 0) {
    return {
      result: Object.freeze({
        ...base,
        status: "fail" as const,
        assertions: Object.freeze([
          Object.freeze({
            assertionId: "required_evidence" as EvalAssertionId,
            kind: "deterministic" as const,
            status: "fail" as const,
            detail: evidenceProblems.join("|"),
          }),
        ]),
      }),
      unreviewedEvidenceProblem: true,
    };
  }

  let rawObservation: unknown;
  let observeThrew = false;
  try {
    rawObservation = subject.observe(scenario);
  } catch {
    observeThrew = true;
  }

  const failWithRuntimeError = (runtimeError: NonNullable<EvalScenarioResult["runtimeError"]>) => ({
    result: Object.freeze({
      ...base,
      status: "fail" as const,
      assertions: Object.freeze([]),
      runtimeError,
    }),
    unreviewedEvidenceProblem: false,
  });

  if (observeThrew) {
    return failWithRuntimeError("subject_observe_threw");
  }

  const observation = validateObservation(rawObservation);
  if (observation === null) {
    return failWithRuntimeError("subject_observation_invalid");
  }

  // Declared, legitimate skip: the subject cannot exercise this surface.
  if (observation.unsupportedReason !== undefined) {
    return {
      result: Object.freeze({
        ...base,
        status: "skip" as const,
        assertions: Object.freeze([]),
      }),
      unreviewedEvidenceProblem: false,
    };
  }

  const assertions: EvalAssertionResult[] = [
    ...evaluateSubjectAssertions(scenario, observation, evidence),
  ];
  if (scenario.gateProbe !== undefined) {
    assertions.push(evaluateGateAssertion(scenario, scenario.gateProbe));
  }

  const failed = assertions.some((assertion) => assertion.status === "fail");
  return {
    result: Object.freeze({
      ...base,
      status: failed ? ("fail" as const) : ("pass" as const),
      assertions: Object.freeze(assertions.map((assertion) => Object.freeze(assertion))),
    }),
    unreviewedEvidenceProblem: false,
  };
}

// ---------------------------------------------------------------------------
// Public runner
// ---------------------------------------------------------------------------

/**
 * Run the whole suite and produce the versioned baseline report. The suite
 * is re-validated fail-closed (structure, duplicate ids, evidence registry)
 * before anything runs; a structurally corrupt suite throws instead of
 * producing a misleading report.
 */
export function runEvaluation(
  suite: Readonly<EvalSuiteFixture>,
  subject: EvalSubject,
  options: EvalRunOptions = {},
): Readonly<EvalRunReport> {
  const validated = parseEvalSuite(suite);
  const triggers = new Set<EvalFailClosedTrigger>();

  const scenarioResults: EvalScenarioResult[] = [];
  if (validated.scenarios.length === 0) {
    triggers.add("empty_suite");
  }

  for (const scenario of validated.scenarios) {
    const evaluation = evaluateOneScenario(scenario, subject, validated.evidence, Date.now());
    const result = evaluation.result;
    scenarioResults.push(result);
    if (evaluation.unreviewedEvidenceProblem) {
      triggers.add("unreviewed_evidence");
    }
    if (result.status === "skip") {
      if (scenario.critical) {
        triggers.add("critical_skip");
      }
      if (scenario.safetyCritical) {
        triggers.add("safety_critical_skip");
      }
    } else if (result.status === "fail" && scenarioIsSevereSafety(scenario)) {
      triggers.add("safety_failure");
    }
  }

  const counts: EvalRunCounts = {
    total: scenarioResults.length,
    pass: scenarioResults.filter((result) => result.status === "pass").length,
    fail: scenarioResults.filter((result) => result.status === "fail").length,
    skip: scenarioResults.filter((result) => result.status === "skip").length,
  };

  const anyFail = counts.fail > 0;
  const status: EvalRunReport["status"] = triggers.size > 0 || anyFail ? "fail" : "pass";

  const pendingHumanReview = validated.scenarios
    .filter((scenario) => (scenario.reviewAspects ?? []).length > 0)
    .flatMap((scenario) => {
      const result = scenarioResults.find((entry) => entry.scenarioId === scenario.scenarioId);
      return (scenario.reviewAspects ?? []).map((aspect) => ({
        scenarioId: scenario.scenarioId,
        aspect,
        scenarioStatus: result?.status ?? ("fail" as EvalScenarioStatus),
      }));
    })
    .map((entry) => Object.freeze(entry));

  return Object.freeze({
    schemaVersion: EVAL_SCHEMA_VERSION,
    suiteId: validated.suiteId,
    suiteVersion: validated.suiteVersion,
    subjectId: subject.subjectId,
    subjectVersion: subject.subjectVersion,
    policyVersion: SAFETY_POLICY_VERSION,
    protocolVersion: LATEST_PROTOCOL_VERSION,
    status,
    failClosedTriggers: Object.freeze([...EVAL_FAIL_CLOSED_TRIGGERS].filter((trigger) => triggers.has(trigger))),
    scenarios: Object.freeze(scenarioResults.map((result) => Object.freeze(result))),
    counts: Object.freeze(counts),
    pendingHumanReview: Object.freeze(pendingHumanReview),
    llmJudge: Object.freeze({ used: false }),
    ranAt: options.ranAt ?? new Date().toISOString(),
  });
}
