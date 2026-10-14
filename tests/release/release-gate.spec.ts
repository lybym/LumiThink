/**
 * R1-10 (issue #22) release-gate fail-closed self-tests (AC 1).
 *
 * Each fault the issue lists is injected against the REAL gate verifiers and
 * must block:
 *
 *   1. 故意注入失败        — a report carrying a failed scenario.
 *   2. 安全 SKIP           — a safety-critical scenario SKIP (real trigger and
 *                            forged-pass variants).
 *   3. 损坏报告            — counts mismatch / unknown field / invalid JSON.
 *   4. 未审核 Evidence     — a report carrying the unreviewed_evidence trigger
 *                            (the harness-side trigger firing itself is proven
 *                            by tests/domain/eval/runner.spec.ts; here the
 *                            GATE must block on it).
 *   5. 依赖版本变化        — lockfile-digest / suite-version drift against the
 *                            committed baseline manifest.
 *   6. 关键测试未运行      — a missing scenario in an otherwise-passing report.
 *
 * Plus the happy path, the version-stamp requirement, the leak scan and the
 * committed-baseline consistency check (the manifest is the acknowledgment
 * record: any code-side version change without regenerating it fails here).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { canonicalJson } from "../../lib/domain/contract/core.ts";
import {
  buildReleaseManifest,
  serializeReleaseManifest,
} from "../../scripts/release-gate/manifest.ts";
import {
  ReleaseGateError,
  buildReleaseSuiteExpectations,
  parseBaselineManifest,
  scanForLeaks,
  verifyEvalReports,
  verifyManifestBaseline,
} from "../../scripts/release-gate/verify.ts";
import { runReleaseEvaluations } from "../../scripts/release-gate/run-evals.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Run the real release suites and index the parsed reports by suite id. */
function realReports(): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const run of runReleaseEvaluations()) {
    map.set(run.suiteId, JSON.parse(run.serialized) as Record<string, unknown>);
  }
  return map;
}

function serialize(report: unknown): string {
  return canonicalJson(report as Record<string, unknown>);
}

function entries(list: readonly (readonly [string, string])[]): { name: string; raw: string }[] {
  return list.map(([name, raw]) => ({ name, raw }));
}

function assertBlocked(fn: () => unknown, fragment: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ReleaseGateError, `blocked by ReleaseGateError, got ${String(error)}`);
    assert.ok(
      error.problems.some((problem) => problem.includes(fragment)),
      `problems mention '${fragment}': ${JSON.stringify(error.problems)}`,
    );
    return;
  }
  assert.fail(`expected the gate to block (${fragment})`);
}

const EXPECTATIONS = buildReleaseSuiteExpectations();

test("the real release evaluation set passes the gate end-to-end", () => {
  const reports = realReports();
  assert.equal(reports.size, EXPECTATIONS.length);
  const summaries = verifyEvalReports(
    entries([...reports].map(([suiteId, report]) => [`/${suiteId}.report.json`, serialize(report)])),
    EXPECTATIONS,
  );
  assert.equal(summaries.length, EXPECTATIONS.length);
  for (const summary of summaries) {
    assert.equal(summary.status, "pass");
    assert.equal(summary.counts.skip, 0);
    assert.equal(summary.counts.fail, 0);
    assert.equal(summary.failClosedTriggers.length, 0);
  }
});

test("AC 1.1 — an injected scenario failure blocks the gate", () => {
  const reports = realReports();
  const suiteId = "lumithink_persona_eval_suite";
  const report = JSON.parse(JSON.stringify(reports.get(suiteId))) as Record<string, unknown>;
  const scenarios = report.scenarios as Mutable<Record<string, unknown>>[];
  scenarios[0].status = "fail";
  const counts = report.counts as Mutable<Record<string, number>>;
  counts.pass -= 1;
  counts.fail += 1;
  report.status = "fail";
  assertBlocked(
    () => verifyEvalReports(entries([[`${suiteId}.report.json`, serialize(report)]]), EXPECTATIONS),
    "suite status is not pass (injected failure blocked)",
  );
});

test("AC 1.2 — a safety-critical SKIP blocks the gate (real trigger shape)", () => {
  const reports = realReports();
  const suiteId = "lumithink_eval_suite";
  const report = JSON.parse(JSON.stringify(reports.get(suiteId))) as Record<string, unknown>;
  const scenarios = report.scenarios as Mutable<Record<string, unknown>>[];
  const target = scenarios.find((scenario) => scenario.safetyCritical === true);
  assert.ok(target !== undefined, "the baseline suite has a safety-critical scenario");
  target.status = "skip";
  const counts = report.counts as Mutable<Record<string, number>>;
  counts.pass -= 1;
  counts.skip += 1;
  report.status = "fail";
  report.failClosedTriggers = ["safety_critical_skip"];
  assertBlocked(
    () => verifyEvalReports(entries([[`${suiteId}.report.json`, serialize(report)]]), EXPECTATIONS),
    "safety-critical scenario",
  );
});

test("AC 1.2b — a FORGED pass cannot hide a safety-critical SKIP behind suite status", () => {
  const reports = realReports();
  const suiteId = "lumithink_eval_suite";
  const report = JSON.parse(JSON.stringify(reports.get(suiteId))) as Record<string, unknown>;
  const scenarios = report.scenarios as Mutable<Record<string, unknown>>[];
  const target = scenarios.find((scenario) => scenario.safetyCritical === true);
  assert.ok(target !== undefined);
  target.status = "skip";
  const counts = report.counts as Mutable<Record<string, number>>;
  counts.pass -= 1;
  counts.skip += 1;
  // status stays "pass" with zero triggers — the parse accepts this shape
  // (skips never contradict pass), which is exactly why the gate re-checks.
  assertBlocked(
    () => verifyEvalReports(entries([[`${suiteId}.report.json`, serialize(report)]]), EXPECTATIONS),
    "is SKIP",
  );
});

test("AC 1.3 — corrupted reports are rejected fail-closed", () => {
  const reports = realReports();
  const suiteId = "lumithink_emotion_skill_eval_suite";

  // (a) counts do not match the scenario results.
  const mismatch = JSON.parse(JSON.stringify(reports.get(suiteId))) as Record<string, unknown>;
  (mismatch.counts as Mutable<Record<string, number>>).pass += 3;
  assertBlocked(
    () => verifyEvalReports(entries([[`${suiteId}.report.json`, serialize(mismatch)]]), EXPECTATIONS),
    "fail-closed contract parse",
  );

  // (b) an unknown field smuggles payload content into the report.
  const smuggled = JSON.parse(JSON.stringify(reports.get(suiteId))) as Record<string, unknown>;
  smuggled.note = "children said ...";
  assertBlocked(
    () => verifyEvalReports(entries([[`${suiteId}.report.json`, serialize(smuggled)]]), EXPECTATIONS),
    "fail-closed contract parse",
  );

  // (c) truncated JSON.
  assertBlocked(
    () => verifyEvalReports(entries([[`${suiteId}.report.json`, "{\"schemaVersion\""]]), EXPECTATIONS),
    "not valid JSON",
  );
});

test("AC 1.4 — unreviewed evidence trigger blocks the gate", () => {
  const reports = realReports();
  const suiteId = "lumithink_persona_eval_suite";
  const report = JSON.parse(JSON.stringify(reports.get(suiteId))) as Record<string, unknown>;
  report.status = "fail";
  report.failClosedTriggers = ["unreviewed_evidence"];
  assertBlocked(
    () => verifyEvalReports(entries([[`${suiteId}.report.json`, serialize(report)]]), EXPECTATIONS),
    "fail-closed triggers present (unreviewed_evidence)",
  );
});

test("AC 1.5 — dependency and suite-version drift against the baseline blocks", async () => {
  const live = await buildReleaseManifest();
  const baseline = parseBaselineManifest(
    readFileSync(new URL("../../release/release-manifest.json", import.meta.url), "utf8"),
  );

  // (a) a DSH lockfile digest change (dependency version change).
  const driftedLock = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
  const dsh = driftedLock.dsh as Mutable<Record<string, unknown>>;
  dsh.pocLockSha256 = "0".repeat(64);
  assertBlocked(() => verifyManifestBaseline(live, driftedLock), "manifest.dsh.pocLockSha256");

  // (b) an evaluation suite version bump without re-review.
  const driftedSuite = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
  const suites = (driftedSuite.eval as Mutable<Record<string, unknown>>).suites as Mutable<Record<string, string>>;
  const emotionSuiteId = "lumithink_emotion_skill_eval_suite";
  assert.ok(Object.hasOwn(suites, emotionSuiteId));
  suites[emotionSuiteId] = "9.9.9";
  assertBlocked(() => verifyManifestBaseline(live, driftedSuite), "manifest.eval.suites");

  // (c) an unknown key in the baseline (tampered acknowledgment).
  const tampered = JSON.parse(JSON.stringify(baseline)) as Record<string, unknown>;
  tampered.extra = true;
  assertBlocked(() => verifyManifestBaseline(live, tampered), "unknown manifest key");
});

test("AC 1.6 — a missing scenario (unrun critical test) blocks the gate", () => {
  const reports = realReports();
  const suiteId = "lumithink_persona_eval_suite";
  const report = JSON.parse(JSON.stringify(reports.get(suiteId))) as Record<string, unknown>;
  const scenarios = report.scenarios as Record<string, unknown>[];
  const removed = scenarios.pop();
  assert.ok(removed !== undefined);
  const removedId = removed.scenarioId as string;
  // Keep the parse-consistent shape: a human-review entry for a scenario the
  // report no longer carries would be a different (also rejected) tamper.
  report.pendingHumanReview = (report.pendingHumanReview as Record<string, unknown>[]).filter(
    (entry) => entry.scenarioId !== removedId,
  );
  const counts = report.counts as Mutable<Record<string, number>>;
  counts.total -= 1;
  counts.pass -= 1;
  assertBlocked(
    () => verifyEvalReports(entries([[`${suiteId}.report.json`, serialize(report)]]), EXPECTATIONS),
    "did not run (critical test missing)",
  );
});

test("a missing or unexpected suite report blocks the gate", () => {
  const reports = realReports();
  const all = [...reports].map(([suiteId, report]) => [`/${suiteId}.report.json`, serialize(report)] as const);
  // Missing one suite.
  assertBlocked(() => verifyEvalReports(entries(all.slice(1)), EXPECTATIONS), "missing release report");
  // Unknown extra suite.
  const rogue = {
    schemaVersion: "1.1",
    suiteId: "rogue_suite",
    suiteVersion: "1.0.0",
    subjectId: "rogue_subject",
    subjectVersion: "1.0.0",
    policyVersion: "1.0",
    protocolVersion: "1.0",
    status: "pass",
    failClosedTriggers: [],
    scenarios: [],
    counts: { total: 0, pass: 0, fail: 0, skip: 0 },
    pendingHumanReview: [],
    llmJudge: { used: false },
    ranAt: "2026-10-14T00:00:00.000Z",
  };
  const extra = entries([...all, ["/rogue_suite.report.json", serialize(rogue)]]);
  assertBlocked(() => verifyEvalReports(extra, EXPECTATIONS), "not part of the release suite set");
});

test("real skill-surface reports must carry registry-resolved evidence stamps", () => {
  const reports = realReports();
  const suiteId = "lumithink_homework_skill_eval_suite";
  const stripped = JSON.parse(JSON.stringify(reports.get(suiteId))) as Record<string, unknown>;
  delete stripped.versionStamps;
  // v1.0 without stamps parses fine — only the GATE requires the stamps.
  assertBlocked(
    () => verifyEvalReports(entries([[`${suiteId}.report.json`, serialize(stripped)]]), EXPECTATIONS),
    "evidence version stamps are missing",
  );

  // A v1.0 report (old schema) is not a release report.
  const old = JSON.parse(JSON.stringify(reports.get("lumithink_persona_eval_suite"))) as Record<string, unknown>;
  old.schemaVersion = "1.0";
  assertBlocked(
    () => verifyEvalReports(entries([["persona.report.json", serialize(old)]]), EXPECTATIONS),
    "schemaVersion must be 1.1",
  );
});

test("the committed baseline manifest matches the live code (acknowledgment guard)", async () => {
  const live = await buildReleaseManifest();
  const baselineRaw = readFileSync(
    new URL("../../release/release-manifest.json", import.meta.url),
    "utf8",
  );
  // Parses fail-closed and deep-equals the live build — any version bump,
  // lockfile change, schema or deploy-artifact edit without regenerating the
  // manifest fails the root test suite.
  verifyManifestBaseline(live, parseBaselineManifest(baselineRaw));

  // The baseline never carries a per-run commit field.
  assert.ok(!Object.hasOwn(JSON.parse(baselineRaw) as Record<string, unknown>, "commit"));
  const perRun = { ...live, commit: "0123456789abcdef" } as Record<string, unknown>;
  assertBlocked(() => verifyManifestBaseline(perRun, parseBaselineManifest(baselineRaw)), "commit");
});

test("the manifest serializes byte-stable and rejects no fields silently", async () => {
  const live = await buildReleaseManifest();
  const first = serializeReleaseManifest(live);
  const second = serializeReleaseManifest(JSON.parse(first) as unknown as typeof live);
  assert.equal(first, second, "canonical JSON is byte-stable for diffing");
});

test("leak scan: credentials and non-synthetic child refs are found, demo refs are not", async () => {
  const liveManifest = await buildReleaseManifest();
  const clean = scanForLeaks([
    { name: "reports.json", content: serialize([...realReports().values()][0]) },
    { name: "manifest.json", content: serializeReleaseManifest(liveManifest) },
  ]);
  assert.deepEqual(clean, [], "real gate artifacts are clean");

  const findings = scanForLeaks([
    { name: "a.json", content: "{\"k\":\"sk-abc123defghijklmnop\"}" },
    { name: "b.json", content: "{\"t\":\"gho_ABCDEFGHIJKLMNOPQRSTUV\"}" },
    { name: "c.json", content: "{\"child\":\"chd_student_009\"}" },
    { name: "d.json", content: "-----BEGIN RSA PRIVATE KEY-----" },
  ]);
  assert.deepEqual(
    findings.map((finding) => finding.rule),
    ["provider_key_shape", "github_token_shape", "non_synthetic_child_ref", "private_key_block"],
  );
  // The published synthetic grammar stays clean.
  assert.deepEqual(
    scanForLeaks([{ name: "ok.json", content: "chd_demo_001 chd_demo_002" }]),
    [],
  );
  // Findings never echo the matched content.
  assert.ok(!JSON.stringify(findings).includes("sk-abc123"));
  assert.ok(!JSON.stringify(findings).includes("chd_student_009"));
});

test("leak scan: every credential rule fires on its own synthetic shape (round 1 review P2-4)", () => {
  // The three rules the first leak test did not cover individually, each
  // proven to fire on its own synthetic fixture AND to stay silent on the
  // boundary near-miss. Fixtures are assembled at RUNTIME so no full token
  // shape ever exists in the repository source; every value is dead,
  // obviously-synthetic padding.
  const positiveCases: readonly (readonly [rule: string, fixture: string])[] = [
    ["github_pat_shape", `github_pat_${"SYNTHETIC0".repeat(3)}`], // ≥20 of [A-Za-z0-9_]
    ["aws_access_key_shape", `AKIA${"0".repeat(16)}`], // AKIA + exactly 16 of [0-9A-Z]
    ["slack_token_shape", `xoxb-${"synthetic"}-${"0".repeat(12)}`], // xox[baprs]- + ≥10 of [A-Za-z0-9-]
  ];
  for (const [rule, fixture] of positiveCases) {
    const findings = scanForLeaks([{ name: "fixture.json", content: JSON.stringify({ t: fixture }) }]);
    assert.deepEqual(
      findings.map((finding) => finding.rule),
      [rule],
      `rule ${rule} fires on its own synthetic shape`,
    );
    // The no-echo rule holds for these findings too.
    assert.ok(!JSON.stringify(findings).includes(fixture), `rule ${rule} never echoes content`);
  }

  // Boundary near-misses must NOT fire (the rules are shape-exact).
  const nearMisses = [
    `github_pat_${"x".repeat(19)}`, // one character too short
    `AKIA${"0".repeat(15)}`, // one character too short
    `xoxz-${"0".repeat(12)}`, // 'z' is outside the [baprs] token-type set
    `AKIA${"a".repeat(16)}`, // lowercase is not an AWS access-key shape
  ];
  for (const nearMiss of nearMisses) {
    assert.deepEqual(
      scanForLeaks([{ name: "near.json", content: JSON.stringify({ t: nearMiss }) }]),
      [],
      `near-miss shape stays clean: ${nearMiss.slice(0, 12)}…`,
    );
  }

  // One artifact carrying all three synthetic shapes reports all three
  // rules in rule order (each credential family is caught independently).
  const all = scanForLeaks([
    {
      name: "all.json",
      content: JSON.stringify({
        a: positiveCases[0][1],
        b: positiveCases[1][1],
        c: positiveCases[2][1],
      }),
    },
  ]);
  assert.deepEqual(
    all.map((finding) => finding.rule),
    ["github_pat_shape", "aws_access_key_shape", "slack_token_shape"],
  );
});
