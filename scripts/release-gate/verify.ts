/**
 * R1-10 (issue #22) release-gate verifiers — fail-closed by construction.
 *
 * Three checks back the release gate (docs/RELEASE_GATE.md):
 *
 * 1. `verifyManifestBaseline` — the live release manifest (built from shipped
 *    code) must deep-equal the COMMITTED baseline `release/release-manifest.json`.
 *    Any version/schema/dependency/deploy-artifact drift is a release blocker
 *    until the manifest is consciously regenerated and re-reviewed (AC:
 *    "版本/Schema 漂移" and "依赖版本变化" auto-block).
 *
 * 2. `verifyEvalReports` — every release evaluation report must parse
 *    fail-closed (tampered/corrupted reports are rejected), carry the exact
 *    release suite set with the full scenario set (a missing scenario means a
 *    critical test did NOT run), end status=pass with zero fail-closed
 *    triggers (safety failure / critical or safety-critical SKIP /
 *    unreviewed evidence), and carry registry-resolved version stamps where
 *    the subject provides them. This is the "故意注入失败、安全 SKIP、损坏
 *    报告、未审核 Evidence" fail-closed surface; the harness-side triggers
 *    themselves are proven by tests/domain/eval/*.spec.ts.
 *
 * 3. `scanForLeaks` — value-free defense-in-depth over every artifact the
 *    gate produces: provider-credential shapes, private-key blocks and any
 *    child reference outside the published `chd_demo_` synthetic grammar are
 *    release blockers. Findings never echo matched content (no-echo rule).
 *
 * This is a CI-side script: node builtins are allowed (outside lib/domain).
 */

import {
  EVAL_SUITE_V1,
  parseEvalRunReport,
  type EvalRunReport,
} from "../../lib/domain/eval/index.ts";
import { PERSONA_EVAL_SUITE_V1 } from "../../lib/domain/persona/eval-suite.ts";
import {
  deriveEmotionSkillEvalSuite,
} from "../../lib/domain/skills/emotion-eval-suite.ts";
import {
  deriveHomeworkSkillEvalSuite,
} from "../../lib/domain/skills/homework-eval-suite.ts";
import {
  RELEASE_MANIFEST_KEYS,
  RELEASE_MANIFEST_SCHEMA_VERSION,
  type ReleaseManifest,
} from "./manifest.ts";

// ---------------------------------------------------------------------------
// Error surface (value-free)
// ---------------------------------------------------------------------------

export class ReleaseGateError extends Error {
  /** Structured, value-free problems (paths/rules only — never content). */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`release gate blocked: ${problems.join("; ")}`);
    this.name = "ReleaseGateError";
    this.problems = Object.freeze([...problems]);
  }
}

// ---------------------------------------------------------------------------
// Release suite expectations (derived from the shipped fixtures)
// ---------------------------------------------------------------------------

export interface ReleaseSuiteExpectation {
  readonly suiteId: string;
  readonly suiteVersion: string;
  /** Sorted scenario ids — the full matrix that must have run. */
  readonly scenarioIds: readonly string[];
  /** Subject the release run must have used for this suite. */
  readonly subjectId: string;
  /** Require registry-resolved version stamps in the v1.1 report. */
  readonly requireVersionStamps: boolean;
}

/** The four release suites, derived from shipped code (never hand-listed). */
export function buildReleaseSuiteExpectations(): readonly ReleaseSuiteExpectation[] {
  const emotionSuite = deriveEmotionSkillEvalSuite();
  const homeworkSuite = deriveHomeworkSkillEvalSuite();
  return Object.freeze([
    {
      suiteId: EVAL_SUITE_V1.suiteId,
      suiteVersion: EVAL_SUITE_V1.suiteVersion,
      scenarioIds: EVAL_SUITE_V1.scenarios.map((scenario) => scenario.scenarioId).sort(),
      subjectId: "synthetic_reference_subject",
      requireVersionStamps: false,
    },
    {
      suiteId: PERSONA_EVAL_SUITE_V1.suiteId,
      suiteVersion: PERSONA_EVAL_SUITE_V1.suiteVersion,
      scenarioIds: PERSONA_EVAL_SUITE_V1.scenarios.map((scenario) => scenario.scenarioId).sort(),
      subjectId: "persona_policy_subject",
      requireVersionStamps: false,
    },
    {
      suiteId: emotionSuite.suiteId,
      suiteVersion: emotionSuite.suiteVersion,
      scenarioIds: emotionSuite.scenarios.map((scenario) => scenario.scenarioId).sort(),
      subjectId: "emotion_support_skill_subject",
      // Real skill surfaces must disclose the registry-resolved bound cards.
      requireVersionStamps: true,
    },
    {
      suiteId: homeworkSuite.suiteId,
      suiteVersion: homeworkSuite.suiteVersion,
      scenarioIds: homeworkSuite.scenarios.map((scenario) => scenario.scenarioId).sort(),
      subjectId: "homework_initiation_skill_subject",
      requireVersionStamps: true,
    },
  ]);
}

// ---------------------------------------------------------------------------
// 1. Manifest baseline (version / schema / dependency drift)
// ---------------------------------------------------------------------------

function deepCompare(live: unknown, baseline: unknown, path: string, problems: string[]): void {
  if (Array.isArray(live) || Array.isArray(baseline)) {
    if (!Array.isArray(live) || !Array.isArray(baseline)) {
      problems.push(`${path}: container kind differs`);
      return;
    }
    if (live.length !== baseline.length) {
      problems.push(`${path}: array length ${live.length} != baseline ${baseline.length}`);
      return;
    }
    for (let index = 0; index < live.length; index += 1) {
      deepCompare(live[index], baseline[index], `${path}[${index}]`, problems);
    }
    return;
  }
  if (live !== null && typeof live === "object" && baseline !== null && typeof baseline === "object") {
    const liveKeys = new Set(Object.keys(live as Record<string, unknown>));
    const baselineKeys = new Set(Object.keys(baseline as Record<string, unknown>));
    for (const key of baselineKeys) {
      if (!liveKeys.has(key)) {
        problems.push(`${path}.${key}: missing from live manifest (unacknowledged removal)`);
      }
    }
    for (const key of liveKeys) {
      if (!baselineKeys.has(key)) {
        problems.push(`${path}.${key}: unknown key in live manifest (unacknowledged addition)`);
      }
    }
    for (const key of baselineKeys) {
      if (liveKeys.has(key)) {
        deepCompare(
          (live as Record<string, unknown>)[key],
          (baseline as Record<string, unknown>)[key],
          `${path}.${key}`,
          problems,
        );
      }
    }
    return;
  }
  if (live !== baseline) {
    // Values are compared strictly but never printed: digests and versions
    // are paths, not secrets, yet the drift listing stays value-free.
    problems.push(`${path}: live value differs from reviewed baseline`);
  }
}

/**
 * Compare the live manifest against the committed baseline. Any difference
 * is a blocker: the fix is to regenerate `release/release-manifest.json`,
 * review the diff and commit it — the acknowledgment step.
 */
export function verifyManifestBaseline(live: unknown, baseline: unknown): void {
  const problems: string[] = [];
  if (live === null || typeof live !== "object" || Array.isArray(live)) {
    throw new ReleaseGateError(["live manifest is not an object"]);
  }
  if (baseline === null || typeof baseline !== "object" || Array.isArray(baseline)) {
    throw new ReleaseGateError(["committed baseline manifest is not an object"]);
  }
  const liveRecord = live as Record<string, unknown>;
  if (liveRecord.manifestSchemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    problems.push("live manifestSchemaVersion is not supported by this gate");
  }
  const baselineRecord = baseline as Record<string, unknown>;
  if (baselineRecord.manifestSchemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    problems.push("baseline manifestSchemaVersion is not supported by this gate");
  }
  if (Object.hasOwn(liveRecord, "commit")) {
    problems.push("live baseline manifest must not carry a per-run commit field");
  }
  for (const key of Object.keys(baselineRecord)) {
    if (!(RELEASE_MANIFEST_KEYS as readonly string[]).includes(key)) {
      problems.push(`baseline.${key}: unknown manifest key (tampered or outdated baseline)`);
    }
  }
  deepCompare(live, baseline, "manifest", problems);
  if (problems.length > 0) {
    throw new ReleaseGateError([
      "manifest drift against the reviewed baseline — regenerate release/release-manifest.json, review the diff and commit it",
      ...problems,
    ]);
  }
}

// ---------------------------------------------------------------------------
// 2. Eval report gate (injected failure / safety skip / corrupted report /
//    unreviewed evidence / unrun critical tests)
// ---------------------------------------------------------------------------

export interface ReportGateSummary {
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly subjectId: string;
  readonly status: "pass" | "fail";
  readonly counts: Readonly<{ total: number; pass: number; fail: number; skip: number }>;
  readonly failClosedTriggers: readonly string[];
  readonly pendingHumanReviewCount: number;
}

function parseReport(name: string, raw: string): EvalRunReport {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new ReleaseGateError([`${name}: report is not valid JSON (corrupted report blocked)`]);
  }
  try {
    // Fail-closed parser: unknown fields, count/status/trigger contradictions
    // and tampered version stamps are all rejected here.
    return parseEvalRunReport(value);
  } catch {
    throw new ReleaseGateError([`${name}: report failed the fail-closed contract parse (corrupted report blocked)`]);
  }
}

/**
 * Verify one release report against its suite expectation. Throws
 * `ReleaseGateError` on any release-blocking condition.
 */
export function verifyEvalReport(
  name: string,
  raw: string,
  expectations: readonly ReleaseSuiteExpectation[],
): ReportGateSummary {
  const report = parseReport(name, raw) as EvalRunReport;

  const expectation = expectations.find((entry) => entry.suiteId === report.suiteId);
  if (expectation === undefined) {
    throw new ReleaseGateError([
      `${name}: report suiteId '${report.suiteId}' is not part of the release suite set`,
    ]);
  }

  const problems: string[] = [];
  if (report.schemaVersion !== "1.1") {
    problems.push(`${name}: report schemaVersion must be 1.1 for release runs`);
  }
  if (report.suiteVersion !== expectation.suiteVersion) {
    problems.push(`${name}: suiteVersion drifted from the reviewed release version`);
  }
  if (report.subjectId !== expectation.subjectId) {
    problems.push(`${name}: release run must use subject '${expectation.subjectId}'`);
  }
  if (report.status !== "pass") {
    problems.push(`${name}: suite status is not pass (injected failure blocked)`);
  }
  if (report.failClosedTriggers.length > 0) {
    problems.push(
      `${name}: fail-closed triggers present (${report.failClosedTriggers.join(", ")})`,
    );
  }

  // The full scenario matrix must have RUN (missing = unrun critical test).
  const reportedIds = report.scenarios.map((scenario) => scenario.scenarioId).sort();
  const expectedIds = expectation.scenarioIds;
  for (const id of expectedIds) {
    if (!reportedIds.includes(id)) {
      problems.push(`${name}: scenario '${id}' did not run (critical test missing)`);
    }
  }
  for (const id of reportedIds) {
    if (!expectedIds.includes(id)) {
      problems.push(`${name}: report carries unknown scenario '${id}' (tampered matrix)`);
    }
  }

  // Critical / safety-critical SKIP can never pass a release (AC: 安全 SKIP).
  for (const scenario of report.scenarios) {
    if (scenario.status !== "skip") {
      continue;
    }
    if (scenario.critical || scenario.safetyCritical) {
      problems.push(`${name}: critical/safety-critical scenario '${scenario.scenarioId}' is SKIP`);
    }
  }

  // Real skill surfaces must carry registry-resolved evidence stamps, so an
  // unreviewed/unknown card can never hide behind a missing stamp.
  if (expectation.requireVersionStamps) {
    const stamps = report.versionStamps;
    if (stamps === undefined || stamps.evidence.length === 0) {
      problems.push(`${name}: registry-resolved evidence version stamps are missing`);
    }
  }

  if (problems.length > 0) {
    throw new ReleaseGateError(problems);
  }
  return {
    suiteId: report.suiteId,
    suiteVersion: report.suiteVersion,
    subjectId: report.subjectId,
    status: report.status,
    counts: report.counts,
    failClosedTriggers: report.failClosedTriggers,
    pendingHumanReviewCount: report.pendingHumanReview.length,
  };
}

/** Verify the complete report set: exactly the release suites, all green. */
export function verifyEvalReports(
  reports: readonly { readonly name: string; readonly raw: string }[],
  expectations: readonly ReleaseSuiteExpectation[] = buildReleaseSuiteExpectations(),
): readonly ReportGateSummary[] {
  const problems: string[] = [];
  const summaries: ReportGateSummary[] = [];
  const seen = new Set<string>();
  for (const report of reports) {
    let suiteId = "unknown";
    try {
      const summary = verifyEvalReport(report.name, report.raw, expectations);
      summaries.push(summary);
      suiteId = summary.suiteId;
    } catch (error) {
      if (error instanceof ReleaseGateError) {
        problems.push(...error.problems);
        continue;
      }
      throw error;
    }
    if (seen.has(suiteId)) {
      problems.push(`${report.name}: duplicate report for suite '${suiteId}'`);
    }
    seen.add(suiteId);
  }
  for (const expectation of expectations) {
    if (!seen.has(expectation.suiteId)) {
      problems.push(`missing release report for suite '${expectation.suiteId}' (评测未运行 blocked)`);
    }
  }
  if (problems.length > 0) {
    throw new ReleaseGateError(problems);
  }
  return summaries;
}

// ---------------------------------------------------------------------------
// 3. Leak scan (credentials / private keys / non-synthetic child refs)
// ---------------------------------------------------------------------------

export interface LeakFinding {
  readonly file: string;
  /** Value-free rule id — matched content is never echoed. */
  readonly rule: string;
}

const LEAK_RULES: readonly { readonly rule: string; readonly pattern: RegExp }[] = Object.freeze([
  { rule: "provider_key_shape", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { rule: "github_token_shape", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/ },
  { rule: "github_pat_shape", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { rule: "aws_access_key_shape", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "slack_token_shape", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: "private_key_block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // Any child reference outside the published synthetic demo grammar.
  { rule: "non_synthetic_child_ref", pattern: /\bchd_(?!demo_)[A-Za-z0-9_]+\b/ },
]);

/**
 * Scan gate-produced artifacts for credential shapes and non-synthetic
 * child references. Defense-in-depth: the eval reports are content-free by
 * construction (the fail-closed parser rejects any payload field) — this
 * scan covers the manifest and future artifact kinds too.
 */
export function scanForLeaks(
  entries: readonly { readonly name: string; readonly content: string }[],
): readonly LeakFinding[] {
  const findings: LeakFinding[] = [];
  for (const entry of entries) {
    for (const rule of LEAK_RULES) {
      if (rule.pattern.test(entry.content)) {
        findings.push({ file: entry.name, rule: rule.rule });
      }
    }
  }
  return findings;
}

/** Assert no leak findings; value-free blocker otherwise. */
export function assertNoLeaks(findings: readonly LeakFinding[]): void {
  if (findings.length > 0) {
    throw new ReleaseGateError([
      "credential/child-data leak pattern detected in gate artifacts (content withheld)",
      ...findings.map((finding) => `${finding.file}: ${finding.rule}`),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Shared helper for the CLI: parse the committed baseline with a clear error
// ---------------------------------------------------------------------------

export function parseBaselineManifest(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ReleaseGateError(["baseline manifest file is not valid JSON"]);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ReleaseGateError(["baseline manifest file is not an object"]);
  }
  const record = parsed as Record<string, unknown>;
  if (record.manifestSchemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    throw new ReleaseGateError(["baseline manifest manifestSchemaVersion is not supported"]);
  }
  return record;
}

export type { ReleaseManifest };
