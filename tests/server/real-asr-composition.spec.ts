import assert from "node:assert/strict";
import test from "node:test";

/**
 * E2E-05 (issue #55) — real ASR activation record: fail-closed parsing and
 * the content-free evidence contract (mirrors the E2E-03 activation gates).
 *
 * The provider credential is deliberately absent from this module's surface:
 * it is a deploy-tier render input (render_config.py, secrets-registry slot
 * asr_provider_api_key), never a LumiThink runtime variable.
 */

import {
  ASR_ROUTE_VALUES,
  REAL_ASR_ENV_VARS,
  REAL_ASR_PROVIDER_ID,
  REAL_ASR_SERVER_RETENTION_CONTRACT,
  REAL_ASR_STREAMING_MODE,
  REAL_ASR_UPSTREAM_SAMPLE_RATE,
  REAL_ASR_VENDOR_ENDPOINT,
  RealAsrActivationError,
  buildRealAsrEvidenceRecord,
  parseRealAsrActivation,
  type EnvSource,
} from "../../lib/server/real-asr-composition.ts";
import { CHILD_DATA_EGRESS_REVIEW_STATUS } from "../../lib/server/real-provider-composition.ts";

const REVIEWER = "guardian-review-001";
const REASON = "成人合成对照样例外发评审（E2E-05 运营者 opt-in 证据路径）";

function realEnv(overrides: Readonly<Record<string, string>> = {}): EnvSource {
  return {
    LUMITHINK_ASR_ROUTE: "real",
    LUMITHINK_ASR_VENDOR_ENDPOINT: REAL_ASR_VENDOR_ENDPOINT,
    LUMITHINK_ASR_PROVIDER_MODEL: "paraformer-realtime-v2",
    LUMITHINK_ASR_ENDPOINT_SILENCE_MS: "200",
    LUMITHINK_ASR_REVIEWER: REVIEWER,
    LUMITHINK_ASR_REVIEW_REASON: REASON,
    ...overrides,
  };
}

test("the route selector defaults to mock; anything but mock|real fails closed", () => {
  assert.deepEqual(parseRealAsrActivation({}), { mode: "mock" });
  assert.deepEqual(parseRealAsrActivation({ LUMITHINK_ASR_ROUTE: "" }), { mode: "mock" });
  assert.deepEqual(parseRealAsrActivation({ LUMITHINK_ASR_ROUTE: "mock" }), { mode: "mock" });
  assert.throws(
    () => parseRealAsrActivation({ LUMITHINK_ASR_ROUTE: "Real" }),
    (error: unknown) => error instanceof RealAsrActivationError && error.problems.length === 1,
  );
  assert.deepEqual([...ASR_ROUTE_VALUES], ["mock", "real"]);
});

test("real route: every missing structural fact fails closed with variable NAMES only", () => {
  const cases: readonly (readonly [string, EnvSource])[] = [
    ["vendor endpoint", { LUMITHINK_ASR_VENDOR_ENDPOINT: "" }],
    ["model", { LUMITHINK_ASR_PROVIDER_MODEL: "" }],
    ["reviewer", { LUMITHINK_ASR_REVIEWER: "" }],
    ["review reason", { LUMITHINK_ASR_REVIEW_REASON: "" }],
    ["endpoint silence", { LUMITHINK_ASR_ENDPOINT_SILENCE_MS: "" }],
  ];
  for (const [what, overrides] of cases) {
    try {
      parseRealAsrActivation(realEnv(overrides));
      assert.fail(`${what}: activation must fail closed`);
    } catch (error) {
      assert.ok(error instanceof RealAsrActivationError, `${what}: typed error`);
      assert.ok(
        error.problems.every((problem) => problem.startsWith("LUMITHINK_ASR_")),
        `${what}: problems name variables only`,
      );
      assert.ok(
        !JSON.stringify(error.problems).includes(REVIEWER) && !JSON.stringify(error.problems).includes(REASON),
        `${what}: values are never echoed`,
      );
    }
  }
});

test("real route: a drifted vendor endpoint is a review failure, not a config value", () => {
  try {
    parseRealAsrActivation(realEnv({ LUMITHINK_ASR_VENDOR_ENDPOINT: "wss://elsewhere.example/v1" }));
    assert.fail("drifted endpoint must fail");
  } catch (error) {
    assert.ok(error instanceof RealAsrActivationError);
    assert.ok(
      error.problems.some((problem) => problem.includes("LUMITHINK_ASR_VENDOR_ENDPOINT")),
      "the review anchor is named",
    );
  }
});

test("real route: endpoint-silence window is bounded (200..6000 ms)", () => {
  for (const bad of ["199", "6001", "0", "-200", "12.5", "abc"]) {
    assert.throws(
      () => parseRealAsrActivation(realEnv({ LUMITHINK_ASR_ENDPOINT_SILENCE_MS: bad })),
      (error: unknown) => error instanceof RealAsrActivationError,
      `${bad} must fail closed`,
    );
  }
  for (const good of ["200", "6000", "800"]) {
    const parsed = parseRealAsrActivation(realEnv({ LUMITHINK_ASR_ENDPOINT_SILENCE_MS: good }));
    assert.equal(parsed.mode, "real");
    if (parsed.mode === "real") {
      assert.equal(parsed.record.endpointSilenceMs, Number(good));
    }
  }
});

test("real route: the full record freezes the reviewed provider facts", () => {
  const parsed = parseRealAsrActivation(realEnv());
  assert.equal(parsed.mode, "real");
  if (parsed.mode !== "real") {
    return;
  }
  const record = parsed.record;
  assert.equal(record.providerId, REAL_ASR_PROVIDER_ID);
  assert.equal(record.vendorEndpoint, REAL_ASR_VENDOR_ENDPOINT);
  assert.equal(record.model, "paraformer-realtime-v2");
  assert.equal(record.streamingMode, REAL_ASR_STREAMING_MODE);
  assert.equal(record.upstreamSampleRate, REAL_ASR_UPSTREAM_SAMPLE_RATE);
  assert.equal(record.upstreamSampleRate, 16000, "the uplink contract is 16 kHz");
  assert.deepEqual(record.dataEgressReview, {
    acknowledgeDataEgressReview: true,
    reviewer: REVIEWER,
    reason: REASON,
  });
  assert.ok(Object.isFrozen(record));
});

test("the provider key is not a LumiThink env var of this module and never reaches any output", () => {
  // The key belongs to the deploy tier's render_config.py surface.
  assert.ok(!(REAL_ASR_ENV_VARS as readonly string[]).includes("LUMITHINK_ASR_PROVIDER_KEY"));
  const envWithKey: EnvSource = {
    ...realEnv(),
    LUMITHINK_ASR_PROVIDER_KEY: "sk-synthetic-pretend-key-000111222333",
  };
  const parsed = parseRealAsrActivation(envWithKey);
  const serialized = JSON.stringify(parsed);
  assert.ok(!serialized.includes("sk-synthetic-pretend-key"), "no key material in the activation record");
  const evidence = buildRealAsrEvidenceRecord({
    activation: parsed,
    metrics: {
      asrEndpointWindows: 1,
      asrPartialsSeen: 2,
      asrFinalsAccepted: 1,
      asrDuplicateFinalsSuppressed: 0,
      inputGateBlocked: 0,
      asrFinalAcceptMs: { count: 1, maxMs: 7 },
    },
    leakageScanClean: true,
  });
  assert.ok(!JSON.stringify(evidence).includes("sk-synthetic-pretend-key"), "no key material in the evidence record");
});

test("the child-data egress gate stays the issue #53 constant in the ASR path too", () => {
  const evidence = buildRealAsrEvidenceRecord({
    activation: parseRealAsrActivation(realEnv()),
    metrics: {
      asrEndpointWindows: 0,
      asrPartialsSeen: 0,
      asrFinalsAccepted: 0,
      asrDuplicateFinalsSuppressed: 0,
      inputGateBlocked: 0,
      asrFinalAcceptMs: { count: 0, maxMs: 0 },
    },
    leakageScanClean: true,
  });
  assert.equal(evidence.childDataEgressReviewStatus, CHILD_DATA_EGRESS_REVIEW_STATUS);
  assert.equal(evidence.childDataEgressReviewStatus, "not_performed");
  assert.deepEqual(evidence.serverRetentionContract, REAL_ASR_SERVER_RETENTION_CONTRACT);
  assert.equal(evidence.route, "real");
  assert.equal(evidence.provider?.upstreamSampleRate, 16000);
  assert.equal(evidence.confidence.onWire, false);
});

test("mock-route evidence records are provider-free and sanitized", () => {
  const evidence = buildRealAsrEvidenceRecord({
    activation: { mode: "mock" },
    metrics: {
      asrEndpointWindows: 3,
      asrPartialsSeen: 7,
      asrFinalsAccepted: 3,
      asrDuplicateFinalsSuppressed: 1,
      inputGateBlocked: 0,
      asrFinalAcceptMs: { count: 3, maxMs: 11 },
    },
    leakageScanClean: true,
  });
  assert.equal(evidence.route, "mock");
  assert.equal(evidence.provider, null);
  assert.equal(evidence.dataEgressReview, null);
  assert.equal(evidence.metrics.asrDuplicateFinalsSuppressed, 1);
  assert.equal(evidence.sanitized, true);
});
