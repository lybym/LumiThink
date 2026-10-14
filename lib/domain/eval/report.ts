/**
 * R1-07 versioned baseline report (docs/HARNESS.md §6, issue #19 goal 4).
 *
 * The report is the persisted, content-free regression matrix: scenario
 * ids, statuses, assertion facts, durations and version stamps — never
 * scenario text, observation payloads or any child content (合成场景的
 * 正文永远不进入报告). Serialization uses the contract's canonical JSON so
 * reports are byte-stable for diffing, and parsing re-validates fail-closed
 * (unknown fields, inconsistent counts, status/trigger contradictions are
 * rejected).
 *
 * `compareEvalRuns` is the before/after comparison for Persona/Skill/
 * Gateway changes: it refuses to compare across different schema/suite
 * versions or scenario sets, and classifies each scenario transition by
 * rank (pass > skip > fail) into regressions and improvements.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import {
  SUPPORTED_PROTOCOL_VERSIONS,
  ContractValidationError,
  canonicalJson,
  isValidContractTimestamp,
  problem,
  type ContractProblem,
} from "../contract/core.ts";
import { SAFETY_POLICY_VERSIONS } from "../safety/policy.ts";

import {
  EVAL_ASSERTION_IDS,
  EVAL_ASSERTION_KINDS,
  EVAL_HUMAN_REVIEW_ASPECTS,
  EVAL_ID_PATTERN,
  EVAL_SCENARIO_CATEGORIES,
  EVAL_SCHEMA_VERSIONS,
  EVAL_SKILL_IDS,
} from "./scenario.ts";
import {
  EVAL_FAIL_CLOSED_TRIGGERS,
  type EvalRunReport,
  type EvalScenarioStatus,
} from "./runner.ts";

// ---------------------------------------------------------------------------
// Parsing (fail-closed)
// ---------------------------------------------------------------------------

const REPORT_KEYS = Object.freeze([
  "schemaVersion",
  "suiteId",
  "suiteVersion",
  "subjectId",
  "subjectVersion",
  "policyVersion",
  "protocolVersion",
  "status",
  "failClosedTriggers",
  "scenarios",
  "counts",
  "pendingHumanReview",
  "llmJudge",
  "versionStamps",
  "ranAt",
] as const);

const SCENARIO_RESULT_KEYS = Object.freeze([
  "scenarioId",
  "category",
  "skill",
  "critical",
  "safetyCritical",
  "status",
  "assertions",
  "runtimeError",
  "durationMs",
] as const);

const ASSERTION_KEYS = Object.freeze(["assertionId", "kind", "status", "detail"] as const);

const STAMP_SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const MAX_REPORT_VERSION_STAMPS = 10;

/** Validate the v1.1 `versionStamps` field (fail-closed; bounded counts). */
function validateVersionStamps(value: unknown, problems: ContractProblem[]): void {
  expectObject(value, "report.versionStamps", problems);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const stamps = value as Record<string, unknown>;
  rejectUnknownKeys(stamps, ["skills", "evidence"], "report.versionStamps", problems);
  for (const listField of ["skills", "evidence"] as const) {
    if (!Array.isArray(stamps[listField])) {
      problems.push(problem("CONTRACT_FIELD_INVALID", `report.versionStamps.${listField}`, "expected an array."));
      continue;
    }
    if (stamps[listField].length > MAX_REPORT_VERSION_STAMPS) {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", `report.versionStamps.${listField}`, "stamp count over bound."),
      );
    }
    stamps[listField].forEach((entry, index) => {
      const path = `report.versionStamps.${listField}[${index}]`;
      expectObject(entry, path, problems);
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return;
      }
      const record = entry as Record<string, unknown>;
      const idField = listField === "skills" ? "skillId" : "cardId";
      rejectUnknownKeys(record, [idField, "version"], path, problems);
      if (listField === "skills") {
        expectEnum(record.skillId, EVAL_SKILL_IDS, `${path}.skillId`, problems);
      } else if (typeof record.cardId !== "string" || !EVAL_ID_PATTERN.test(record.cardId)) {
        problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.cardId`, "not a valid evaluation id."));
      }
      if (typeof record.version !== "string" || !STAMP_SEMVER_PATTERN.test(record.version)) {
        problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.version`, "expected a semver string."));
      }
    });
  }
}

function expectObject(value: unknown, path: string, problems: ContractProblem[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", path, "expected an object."));
  }
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  problems: ContractProblem[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.${key}`, "unknown field; fail-closed."));
    }
  }
}

function expectEnum<T extends string>(
  value: unknown,
  registry: readonly T[],
  path: string,
  problems: ContractProblem[],
): void {
  if (typeof value !== "string" || !(registry as readonly string[]).includes(value)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", path, "value is not registered."));
  }
}

function validateAssertion(value: unknown, path: string, problems: ContractProblem[]): void {
  expectObject(value, path, problems);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const assertion = value as Record<string, unknown>;
  rejectUnknownKeys(assertion, ASSERTION_KEYS, path, problems);
  expectEnum(assertion.assertionId, EVAL_ASSERTION_IDS, `${path}.assertionId`, problems);
  expectEnum(assertion.kind, EVAL_ASSERTION_KINDS, `${path}.kind`, problems);
  expectEnum(assertion.status, ["pass", "fail", "skip"], `${path}.status`, problems);
  if (typeof assertion.detail !== "string") {
    problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.detail`, "expected a string."));
  }
}

function validateScenarioResult(value: unknown, path: string, problems: ContractProblem[]): void {
  expectObject(value, path, problems);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const result = value as Record<string, unknown>;
  rejectUnknownKeys(result, SCENARIO_RESULT_KEYS, path, problems);
  if (typeof result.scenarioId !== "string" || !EVAL_ID_PATTERN.test(result.scenarioId)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.scenarioId`, "not a valid evaluation id."));
  }
  expectEnum(result.category, EVAL_SCENARIO_CATEGORIES, `${path}.category`, problems);
  expectEnum(result.skill, ["emotion_support", "homework_initiation", "none"], `${path}.skill`, problems);
  for (const flag of ["critical", "safetyCritical"] as const) {
    if (typeof result[flag] !== "boolean") {
      problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.${flag}`, "expected a boolean."));
    }
  }
  expectEnum(result.status, ["pass", "fail", "skip"], `${path}.status`, problems);
  if (result.runtimeError !== undefined) {
    expectEnum(
      result.runtimeError,
      ["subject_observe_threw", "subject_observation_invalid"],
      `${path}.runtimeError`,
      problems,
    );
    if (result.status !== "fail") {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", `${path}.runtimeError`, "runtimeError requires status fail."),
      );
    }
  }
  if (typeof result.durationMs !== "number" || !Number.isFinite(result.durationMs) || result.durationMs < 0) {
    problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.durationMs`, "expected a non-negative finite number."));
  }
  if (!Array.isArray(result.assertions)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.assertions`, "expected an array."));
  } else {
    result.assertions.forEach((assertion, index) => {
      validateAssertion(assertion, `${path}.assertions[${index}]`, problems);
    });
  }
}

/**
 * Parse an untrusted report-shaped value (e.g. read back from storage).
 * Counts are recomputed from the scenario results and must match; the suite
 * status must be consistent with the triggers and failure counts.
 */
export function parseEvalRunReport(value: unknown): Readonly<EvalRunReport> {
  const problems: ContractProblem[] = [];
  expectObject(value, "report", problems);
  if (problems.length > 0 || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError(problems);
  }
  const report = value as Record<string, unknown>;
  rejectUnknownKeys(report, REPORT_KEYS, "report", problems);

  expectEnum(report.schemaVersion, EVAL_SCHEMA_VERSIONS, "report.schemaVersion", problems);
  for (const idField of ["suiteId", "subjectId"] as const) {
    if (typeof report[idField] !== "string" || !EVAL_ID_PATTERN.test(report[idField] as string)) {
      problems.push(problem("CONTRACT_FIELD_INVALID", `report.${idField}`, "not a valid evaluation id."));
    }
  }

  // Version stamps (HARNESS §6.4 merge, R1-11): v1.1 reports may carry the
  // subject's resolved skill/evidence versions; v1.0 reports must not (the
  // field did not exist — an old report with stamps is tampered).
  if (report.versionStamps !== undefined) {
    if (report.schemaVersion !== "1.1") {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", "report.versionStamps", "versionStamps require report schemaVersion 1.1."),
      );
    } else {
      validateVersionStamps(report.versionStamps, problems);
    }
  }
  if (typeof report.suiteVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(report.suiteVersion)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "report.suiteVersion", "expected a semver string."));
  }
  if (typeof report.subjectVersion !== "string" || report.subjectVersion.length === 0) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "report.subjectVersion", "expected a version string."));
  }
  expectEnum(report.policyVersion, SAFETY_POLICY_VERSIONS, "report.policyVersion", problems);
  expectEnum(report.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS, "report.protocolVersion", problems);
  expectEnum(report.status, ["pass", "fail"], "report.status", problems);

  if (!Array.isArray(report.failClosedTriggers)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "report.failClosedTriggers", "expected an array."));
  } else {
    const seen = new Set<string>();
    report.failClosedTriggers.forEach((trigger, index) => {
      expectEnum(trigger, EVAL_FAIL_CLOSED_TRIGGERS, `report.failClosedTriggers[${index}]`, problems);
      if (typeof trigger === "string") {
        if (seen.has(trigger)) {
          problems.push(
            problem("CONTRACT_FIELD_INVALID", `report.failClosedTriggers[${index}]`, "duplicate trigger."),
          );
        }
        seen.add(trigger);
      }
    });
  }

  if (!Array.isArray(report.scenarios)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "report.scenarios", "expected an array."));
  } else {
    const seen = new Set<string>();
    report.scenarios.forEach((scenario, index) => {
      validateScenarioResult(scenario, `report.scenarios[${index}]`, problems);
      if (scenario !== null && typeof scenario === "object" && !Array.isArray(scenario)) {
        const id = (scenario as Record<string, unknown>).scenarioId;
        if (typeof id === "string") {
          if (seen.has(id)) {
            problems.push(
              problem("CONTRACT_FIELD_INVALID", `report.scenarios[${index}].scenarioId`, "duplicate scenario id."),
            );
          }
          seen.add(id);
        }
      }
    });
  }

  expectObject(report.counts, "report.counts", problems);
  let scenarioList: readonly Record<string, unknown>[] = [];
  if (Array.isArray(report.scenarios)) {
    scenarioList = report.scenarios as Record<string, unknown>[];
  }
  if (report.counts !== null && typeof report.counts === "object" && !Array.isArray(report.counts)) {
    const counts = report.counts as Record<string, unknown>;
    rejectUnknownKeys(counts, ["total", "pass", "fail", "skip"], "report.counts", problems);
    const computed = {
      total: scenarioList.length,
      pass: scenarioList.filter((entry) => entry.status === "pass").length,
      fail: scenarioList.filter((entry) => entry.status === "fail").length,
      skip: scenarioList.filter((entry) => entry.status === "skip").length,
    };
    for (const key of ["total", "pass", "fail", "skip"] as const) {
      if (counts[key] !== computed[key]) {
        problems.push(
          problem("CONTRACT_FIELD_INVALID", `report.counts.${key}`, "counts do not match the scenario results."),
        );
      }
    }
  }

  if (Array.isArray(report.pendingHumanReview)) {
    const scenarioIds = new Set(scenarioList.map((entry) => entry.scenarioId));
    report.pendingHumanReview.forEach((entry, index) => {
      const path = `report.pendingHumanReview[${index}]`;
      expectObject(entry, path, problems);
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return;
      }
      const review = entry as Record<string, unknown>;
      rejectUnknownKeys(review, ["scenarioId", "aspect", "scenarioStatus"], path, problems);
      if (typeof review.scenarioId !== "string" || !scenarioIds.has(review.scenarioId)) {
        problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.scenarioId`, "unknown scenario id."));
      }
      expectEnum(review.aspect, EVAL_HUMAN_REVIEW_ASPECTS, `${path}.aspect`, problems);
      expectEnum(review.scenarioStatus, ["pass", "fail", "skip"], `${path}.scenarioStatus`, problems);
    });
  } else {
    problems.push(problem("CONTRACT_FIELD_INVALID", "report.pendingHumanReview", "expected an array."));
  }

  if (report.llmJudge === null || typeof report.llmJudge !== "object" || Array.isArray(report.llmJudge)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "report.llmJudge", "expected the llmJudge slot object."));
  } else {
    const llmJudge = report.llmJudge as Record<string, unknown>;
    rejectUnknownKeys(llmJudge, ["used"], "report.llmJudge", problems);
    if (llmJudge.used !== false) {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", "report.llmJudge.used", "v0 reports never use an LLM judge."),
      );
    }
  }

  if (typeof report.ranAt !== "string" || !isValidContractTimestamp(report.ranAt)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "report.ranAt", "expected an ISO-8601 UTC timestamp."));
  }

  // Status consistency: fail ⇔ triggers or failed scenarios; pass never
  // coexists with a trigger or a failure.
  const triggers = Array.isArray(report.failClosedTriggers) ? report.failClosedTriggers : [];
  const failCount = scenarioList.filter((entry) => entry.status === "fail").length;
  if (report.status === "pass" && (triggers.length > 0 || failCount > 0)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "report.status", "status pass contradicts triggers or failed scenarios."),
    );
  }
  if (report.status === "fail" && triggers.length === 0 && failCount === 0) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "report.status", "status fail requires a trigger or a failed scenario."),
    );
  }

  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return Object.freeze(report as unknown as EvalRunReport);
}

// ---------------------------------------------------------------------------
// Serialization (canonical JSON, content-free by construction)
// ---------------------------------------------------------------------------

/** Serialize a report to canonical JSON (stable key order, no whitespace). */
export function serializeEvalRunReport(report: Readonly<EvalRunReport>): string {
  // Parse first: only structurally valid reports are serialized, so the
  // persisted matrix can never smuggle extra fields.
  return canonicalJson(parseEvalRunReport(report));
}

// ---------------------------------------------------------------------------
// Before/after comparison (Persona/Skill/Gateway changes)
// ---------------------------------------------------------------------------

export interface EvalRunDiffEntry {
  readonly scenarioId: string;
  readonly from: EvalScenarioStatus;
  readonly to: EvalScenarioStatus;
}

export interface EvalRunDiff {
  readonly comparable: boolean;
  /** Refusal reasons when the two runs are not comparable. */
  readonly reasons: readonly string[];
  readonly regressions: readonly Readonly<EvalRunDiffEntry>[];
  readonly improvements: readonly Readonly<EvalRunDiffEntry>[];
  readonly suiteStatusTransition: Readonly<{ from: "pass" | "fail"; to: "pass" | "fail" }> | null;
}

const STATUS_RANK: Readonly<Record<EvalScenarioStatus, number>> = Object.freeze({
  pass: 2,
  skip: 1,
  fail: 0,
});

/**
 * Compare a current run against a baseline. Comparison requires the same
 * evaluation schema version, the same suite id/version and the same
 * scenario id set — different suites are never silently diffed.
 */
export function compareEvalRuns(
  baseline: unknown,
  current: unknown,
): Readonly<EvalRunDiff> {
  const baselineReport = parseEvalRunReport(baseline);
  const currentReport = parseEvalRunReport(current);

  const reasons: string[] = [];
  if (baselineReport.schemaVersion !== currentReport.schemaVersion) {
    reasons.push("schemaVersion differs");
  }
  if (baselineReport.suiteId !== currentReport.suiteId) {
    reasons.push("suiteId differs");
  }
  if (baselineReport.suiteVersion !== currentReport.suiteVersion) {
    reasons.push("suiteVersion differs");
  }
  const baselineIds = new Set(baselineReport.scenarios.map((entry) => entry.scenarioId));
  const currentIds = new Set(currentReport.scenarios.map((entry) => entry.scenarioId));
  for (const id of baselineIds) {
    if (!currentIds.has(id)) {
      reasons.push(`scenario missing in current: ${id}`);
    }
  }
  for (const id of currentIds) {
    if (!baselineIds.has(id)) {
      reasons.push(`scenario missing in baseline: ${id}`);
    }
  }

  if (reasons.length > 0) {
    return Object.freeze({
      comparable: false,
      reasons: Object.freeze(reasons),
      regressions: Object.freeze([]),
      improvements: Object.freeze([]),
      suiteStatusTransition: null,
    });
  }

  const baselineStatus = new Map(
    baselineReport.scenarios.map((entry) => [entry.scenarioId, entry.status]),
  );
  const regressions: EvalRunDiffEntry[] = [];
  const improvements: EvalRunDiffEntry[] = [];
  for (const entry of currentReport.scenarios) {
    const from = baselineStatus.get(entry.scenarioId);
    if (from === undefined || from === entry.status) {
      continue;
    }
    const transition = Object.freeze({
      scenarioId: entry.scenarioId,
      from,
      to: entry.status,
    });
    if (STATUS_RANK[entry.status] < STATUS_RANK[from]) {
      regressions.push(transition);
    } else {
      improvements.push(transition);
    }
  }

  const suiteStatusTransition =
    baselineReport.status === currentReport.status
      ? null
      : Object.freeze({ from: baselineReport.status, to: currentReport.status });

  return Object.freeze({
    comparable: true,
    reasons: Object.freeze([]),
    regressions: Object.freeze(regressions.map((entry) => Object.freeze(entry))),
    improvements: Object.freeze(improvements.map((entry) => Object.freeze(entry))),
    suiteStatusTransition,
  });
}
