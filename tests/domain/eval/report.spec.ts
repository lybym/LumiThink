import assert from "node:assert/strict";
import test from "node:test";

import { ContractValidationError } from "../../../lib/domain/contract/core.ts";
import {
  compareEvalRuns,
  createSyntheticReferenceSubject,
  EVAL_SUITE_V1,
  parseEvalRunReport,
  runEvaluation,
  serializeEvalRunReport,
  type EvalRunReport,
} from "../../../lib/domain/eval/index.ts";

/**
 * R1-07 report contract (issue #19 goal 4 / AC 2 / AC 3): the persisted
 * baseline report is versioned, content-free (no synthetic corpus text and
 * therefore no child content), byte-stable under canonical JSON, and the
 * before/after comparison refuses to diff across suites while classifying
 * every scenario transition. Parsing is fail-closed.
 */

const DETERMINISTIC_TS = "2026-10-13T12:00:00.000Z";

function fullRun(): Readonly<EvalRunReport> {
  return runEvaluation(EVAL_SUITE_V1, createSyntheticReferenceSubject(), { ranAt: DETERMINISTIC_TS });
}

test("the baseline report carries the version stamps the harness contract requires", () => {
  const report = fullRun();
  assert.equal(report.schemaVersion, "1.1");
  assert.equal(report.suiteId, "lumithink_eval_suite");
  assert.equal(report.suiteVersion, "1.1.0");
  assert.equal(report.policyVersion, "1.0");
  assert.equal(report.protocolVersion, "1.0");
  assert.equal(report.subjectId, "synthetic_reference_subject");
  assert.equal(report.subjectVersion, "0.1.0");
  assert.deepEqual({ ...report.counts }, { total: 17, pass: 17, fail: 0, skip: 0 });
});

test("serialization is canonical, idempotent and re-parsable", () => {
  const report = fullRun();
  const json = serializeEvalRunReport(report);
  const reparsed = parseEvalRunReport(JSON.parse(json));
  const reserialized = serializeEvalRunReport(reparsed);
  assert.equal(reserialized, json);
});

test("the report matrix is content-free: no scenario text, no [synthetic] corpus", () => {
  const json = serializeEvalRunReport(fullRun());
  const texts: string[] = [];
  for (const scenario of EVAL_SUITE_V1.scenarios) {
    if (scenario.input.text !== null) {
      texts.push(scenario.input.text);
    }
    const probe = scenario.gateProbe;
    if (probe !== undefined) {
      if (probe.interactionText !== undefined && probe.interactionText !== null) {
        texts.push(probe.interactionText);
      }
      if (probe.draftOutput !== undefined && probe.draftOutput !== null) {
        texts.push(probe.draftOutput);
      }
    }
    for (const card of Object.values(EVAL_SUITE_V1.evidence)) {
      texts.push(card.summary);
    }
  }
  assert.ok(texts.length > 20);
  for (const text of texts) {
    assert.ok(!json.includes(text), "report must not embed fixture text");
  }
  assert.ok(!json.includes("[synthetic]"), "no corpus marker may leak into the report");
});

test("comparison ignores wall-clock data and reports no diff for identical runs", () => {
  const baseline = JSON.parse(serializeEvalRunReport(fullRun()));
  const current = JSON.parse(serializeEvalRunReport(fullRun()));
  current.ranAt = "2026-10-14T08:30:00.000Z";
  current.scenarios[0].durationMs = 9999;
  const diff = compareEvalRuns(baseline, current);
  assert.equal(diff.comparable, true);
  assert.deepEqual(diff.regressions, []);
  assert.deepEqual(diff.improvements, []);
  assert.equal(diff.suiteStatusTransition, null);
});

test("comparison classifies regressions and suite status transitions", () => {
  const baseline = JSON.parse(serializeEvalRunReport(fullRun()));
  const failingRun = runEvaluation(
    {
      ...EVAL_SUITE_V1,
      scenarios: EVAL_SUITE_V1.scenarios.map((scenario) =>
        scenario.scenarioId === "emotion.applicable.daily-emotion-001"
          ? {
              ...scenario,
              expectations: { ...scenario.expectations, exitPaths: ["end_turn" as const] },
            }
          : scenario,
      ),
    },
    createSyntheticReferenceSubject(),
    { ranAt: DETERMINISTIC_TS },
  );
  const diff = compareEvalRuns(baseline, failingRun);
  assert.equal(diff.comparable, true);
  assert.equal(diff.regressions.length, 1);
  assert.equal(diff.regressions[0].scenarioId, "emotion.applicable.daily-emotion-001");
  assert.equal(diff.regressions[0].from, "pass");
  assert.equal(diff.regressions[0].to, "fail");
  assert.deepEqual(diff.suiteStatusTransition, { from: "pass", to: "fail" });
});

test("comparison classifies improvements and a pass->skip regression for a critical case", () => {
  const failingBaseline = JSON.parse(
    serializeEvalRunReport(
      runEvaluation(
        {
          ...EVAL_SUITE_V1,
          scenarios: EVAL_SUITE_V1.scenarios.map((scenario) =>
            scenario.scenarioId === "emotion.applicable.daily-emotion-001"
              ? { ...scenario, expectations: { ...scenario.expectations, exitPaths: ["end_turn" as const] } }
              : scenario,
          ),
        },
        createSyntheticReferenceSubject(),
        { ranAt: DETERMINISTIC_TS },
      ),
    ),
  );
  const current = JSON.parse(serializeEvalRunReport(fullRun()));
  current.scenarios.find((entry: { scenarioId: string }) => entry.scenarioId === "homework.refusal.strategy-004").status = "skip";
  current.counts = {
    total: current.counts.total,
    pass: current.counts.pass - 1,
    fail: current.counts.fail,
    skip: current.counts.skip + 1,
  };
  const diff = compareEvalRuns(failingBaseline, current);
  assert.equal(diff.comparable, true);
  const improvement = diff.improvements.find((entry) => entry.scenarioId === "emotion.applicable.daily-emotion-001");
  assert.ok(improvement, "fail -> pass must be an improvement");
  assert.deepEqual(improvement, { scenarioId: "emotion.applicable.daily-emotion-001", from: "fail", to: "pass" });
  const regression = diff.regressions.find((entry) => entry.scenarioId === "homework.refusal.strategy-004");
  assert.ok(regression, "pass -> skip on a critical case is a regression");
  assert.equal(regression.from, "pass");
  assert.equal(regression.to, "skip");
});

test("comparison refuses different suites instead of producing a misleading diff", () => {
  const baseline = JSON.parse(serializeEvalRunReport(fullRun()));
  const otherSuite = JSON.parse(serializeEvalRunReport(fullRun()));
  otherSuite.suiteVersion = "2.0.0";
  const versionDiff = compareEvalRuns(baseline, otherSuite);
  assert.equal(versionDiff.comparable, false);
  assert.ok(versionDiff.reasons.includes("suiteVersion differs"));

  const withExtraScenario = JSON.parse(serializeEvalRunReport(fullRun()));
  withExtraScenario.scenarios.push({ ...withExtraScenario.scenarios[0], scenarioId: "extra.new-scenario-001" });
  withExtraScenario.counts = {
    total: withExtraScenario.counts.total + 1,
    pass: withExtraScenario.counts.pass + 1,
    fail: withExtraScenario.counts.fail,
    skip: withExtraScenario.counts.skip,
  };
  const setDiff = compareEvalRuns(baseline, withExtraScenario);
  assert.equal(setDiff.comparable, false);
  assert.ok(setDiff.reasons.some((reason) => reason.startsWith("scenario missing in baseline:")));
});

test("parseEvalRunReport is fail-closed on tampered reports", () => {
  const report = fullRun();

  assert.throws(() => parseEvalRunReport({ ...report, surprise: true }), ContractValidationError);
  assert.throws(
    () => parseEvalRunReport({ ...report, status: "pass", failClosedTriggers: ["empty_suite"] }),
    ContractValidationError,
    "pass must contradict the empty_suite trigger",
  );
  assert.throws(() =>
    parseEvalRunReport({
      ...report,
      counts: { ...report.counts, pass: report.counts.pass + 1 },
    }), ContractValidationError);
  assert.throws(() => parseEvalRunReport({ ...report, failClosedTriggers: ["not_a_trigger"] }), ContractValidationError);
  assert.throws(() => parseEvalRunReport({ ...report, failClosedTriggers: ["empty_suite", "empty_suite"] }), ContractValidationError);
  assert.throws(() => parseEvalRunReport({ ...report, llmJudge: { used: true } }), ContractValidationError);
  assert.throws(() => parseEvalRunReport({ ...report, ranAt: "yesterday" }), ContractValidationError);
  const withRuntimeErrorOnPass = {
    ...report,
    scenarios: report.scenarios.map((scenario) =>
      scenario.scenarioId === "emotion.not-applicable.factual-question-002"
        ? { ...scenario, runtimeError: "subject_observe_threw" }
        : scenario,
    ),
  };
  assert.throws(() => parseEvalRunReport(withRuntimeErrorOnPass), ContractValidationError);
  const withUnknownReviewScenario = {
    ...report,
    pendingHumanReview: [
      { scenarioId: "unknown.scenario-999", aspect: "empathy_quality", scenarioStatus: "pass" },
    ],
  };
  assert.throws(() => parseEvalRunReport(withUnknownReviewScenario), ContractValidationError);
  const withUnknownReviewAspect = {
    ...report,
    pendingHumanReview: [
      { scenarioId: report.scenarios[0].scenarioId, aspect: "vibes", scenarioStatus: "pass" },
    ],
  };
  assert.throws(() => parseEvalRunReport(withUnknownReviewAspect), ContractValidationError);
});
