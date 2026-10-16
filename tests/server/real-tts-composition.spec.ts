import assert from "node:assert/strict";
import test from "node:test";

/**
 * E2E-06 (issue #56) — real TTS activation record: fail-closed parsing and
 * the content-free evidence contract (mirrors the E2E-05 activation gates).
 * Test names are deliberately TTS-distinct (review R1 P2-4): the ASR suite
 * carries verbatim-mirror names, and same-named tests made CI-log grep
 * audits lie about which suite actually ran.
 *
 * The provider credential is deliberately absent from this module's surface:
 * it is a deploy-tier render input (render_config.py, secrets-registry slot
 * tts_provider_api_key), never a LumiThink runtime variable. The vendor is
 * called by the pinned xiaozhi server; LumiThink owns only the reviewed
 * activation description and the content-free evidence record.
 */

import {
  REAL_TTS_DOWNLINK_SAMPLE_RATES,
  REAL_TTS_ENV_VARS,
  REAL_TTS_PROVIDER_ID,
  REAL_TTS_SERVER_RETENTION_CONTRACT,
  REAL_TTS_STREAMING_MODE,
  REAL_TTS_VENDOR_ENDPOINT,
  REAL_TTS_VENDOR_OUTPUT_FORMAT,
  RealTtsActivationError,
  TTS_ROUTE_VALUES,
  buildRealTtsEvidenceRecord,
  parseRealTtsActivation,
  type EnvSource,
} from "../../lib/server/real-tts-composition.ts";
import { CHILD_DATA_EGRESS_REVIEW_STATUS } from "../../lib/server/real-provider-composition.ts";

const REVIEWER = "guardian-review-001";
const REASON = "成人合成对照样例 TTS 外发评审（E2E-06 运营者 opt-in 证据路径）";

function realEnv(overrides: EnvSource = {}): EnvSource {
  return {
    LUMITHINK_TTS_ROUTE: "real",
    LUMITHINK_TTS_VENDOR_ENDPOINT: REAL_TTS_VENDOR_ENDPOINT,
    LUMITHINK_TTS_PROVIDER_MODEL: "cosyvoice-v2",
    LUMITHINK_TTS_VOICE: "longxiaochun_v2",
    LUMITHINK_TTS_DOWNLINK_SAMPLE_RATE: "24000",
    LUMITHINK_TTS_REVIEWER: REVIEWER,
    LUMITHINK_TTS_REVIEW_REASON: REASON,
    ...overrides,
  };
}

test("TTS route selector defaults to mock; anything but mock|real fails closed", () => {
  assert.deepEqual(parseRealTtsActivation({}), { mode: "mock" });
  assert.deepEqual(parseRealTtsActivation({ LUMITHINK_TTS_ROUTE: "" }), { mode: "mock" });
  assert.deepEqual(parseRealTtsActivation({ LUMITHINK_TTS_ROUTE: "mock" }), { mode: "mock" });
  assert.throws(
    () => parseRealTtsActivation({ LUMITHINK_TTS_ROUTE: "Real" }),
    (error: unknown) => error instanceof RealTtsActivationError && error.problems.length === 1,
  );
  assert.deepEqual([...TTS_ROUTE_VALUES], ["mock", "real"]);
});

test("real TTS route: every missing structural fact fails closed with variable NAMES only", () => {
  const cases: readonly (readonly [string, EnvSource])[] = [
    ["vendor endpoint", { LUMITHINK_TTS_VENDOR_ENDPOINT: "" }],
    ["model", { LUMITHINK_TTS_PROVIDER_MODEL: "" }],
    ["voice", { LUMITHINK_TTS_VOICE: "" }],
    ["reviewer", { LUMITHINK_TTS_REVIEWER: "" }],
    ["review reason", { LUMITHINK_TTS_REVIEW_REASON: "" }],
    ["downlink sample rate", { LUMITHINK_TTS_DOWNLINK_SAMPLE_RATE: "" }],
  ];
  for (const [what, overrides] of cases) {
    try {
      parseRealTtsActivation(realEnv(overrides));
      assert.fail(`${what}: activation must fail closed`);
    } catch (error) {
      assert.ok(error instanceof RealTtsActivationError, `${what}: typed error`);
      assert.ok(
        error.problems.every((problem) => problem.startsWith("LUMITHINK_TTS_")),
        `${what}: problems name variables only`,
      );
      assert.ok(
        !JSON.stringify(error.problems).includes(REVIEWER) && !JSON.stringify(error.problems).includes(REASON),
        `${what}: values are never echoed`,
      );
    }
  }
});

test("real TTS route: a drifted vendor endpoint is a review failure, not a config value", () => {
  for (const drifted of ["wss://elsewhere.example/v1", "wss://dashscope.aliyuncs.com/api-ws/v1/inference"]) {
    // The second value is the real-ASR anchor WITHOUT the trailing slash —
    // the pinned TTS default carries the slash; near-misses must fail too.
    try {
      parseRealTtsActivation(realEnv({ LUMITHINK_TTS_VENDOR_ENDPOINT: drifted }));
      assert.fail("drifted endpoint must fail");
    } catch (error) {
      assert.ok(error instanceof RealTtsActivationError);
      assert.ok(
        error.problems.some((problem) => problem.includes("LUMITHINK_TTS_VENDOR_ENDPOINT")),
        "the review anchor is named",
      );
    }
  }
});

test("real TTS route: the downlink sample rate is the negotiated wire contract (16000|24000)", () => {
  assert.deepEqual([...REAL_TTS_DOWNLINK_SAMPLE_RATES], [16000, 24000]);
  for (const bad of ["8000", "48000", "16001", "0", "-16000", "24kHz", "abc"]) {
    assert.throws(
      () => parseRealTtsActivation(realEnv({ LUMITHINK_TTS_DOWNLINK_SAMPLE_RATE: bad })),
      (error: unknown) => error instanceof RealTtsActivationError,
      `${bad} must fail closed`,
    );
  }
  for (const good of ["16000", "24000"]) {
    const parsed = parseRealTtsActivation(realEnv({ LUMITHINK_TTS_DOWNLINK_SAMPLE_RATE: good }));
    assert.equal(parsed.mode, "real");
    if (parsed.mode === "real") {
      assert.equal(parsed.record.downlinkSampleRate, Number(good));
    }
  }
});

test("real TTS route: the full record freezes the reviewed provider facts", () => {
  const parsed = parseRealTtsActivation(realEnv());
  assert.equal(parsed.mode, "real");
  if (parsed.mode !== "real") {
    return;
  }
  const record = parsed.record;
  assert.equal(record.providerId, REAL_TTS_PROVIDER_ID);
  assert.equal(record.vendorEndpoint, REAL_TTS_VENDOR_ENDPOINT);
  assert.equal(record.vendorEndpoint, "wss://dashscope.aliyuncs.com/api-ws/v1/inference/", "the pinned DEFAULT_WS_URL, verbatim");
  assert.equal(record.model, "cosyvoice-v2");
  assert.equal(record.voice, "longxiaochun_v2");
  assert.equal(record.vendorOutputFormat, REAL_TTS_VENDOR_OUTPUT_FORMAT);
  assert.equal(record.vendorOutputFormat, "pcm");
  assert.equal(record.streamingMode, REAL_TTS_STREAMING_MODE);
  assert.equal(record.downlinkSampleRate, 24000);
  assert.deepEqual(record.dataEgressReview, {
    acknowledgeDataEgressReview: true,
    reviewer: REVIEWER,
    reason: REASON,
  });
  assert.ok(Object.isFrozen(record));
});

test("the provider key is not a LumiThink env var of the TTS module and never reaches any output", () => {
  // The key belongs to the deploy tier's render_config.py surface.
  assert.ok(!(REAL_TTS_ENV_VARS as readonly string[]).includes("LUMITHINK_TTS_PROVIDER_KEY"));
  const envWithKey: EnvSource = {
    ...realEnv(),
    LUMITHINK_TTS_PROVIDER_KEY: "sk-synthetic-pretend-key-000111222333",
  };
  const parsed = parseRealTtsActivation(envWithKey);
  const serialized = JSON.stringify(parsed);
  assert.ok(!serialized.includes("sk-synthetic-pretend-key"), "no key material in the activation record");
  const evidence = buildRealTtsEvidenceRecord({
    activation: parsed,
    metrics: {
      ttsTurnsPlayed: 1,
      ttsSentencesSent: 4,
      ttsFramesSent: 16,
      ttsStaleAudioSuppressed: 0,
      ttsStopEffectiveMs: { count: 0, maxMs: 0 },
      ttsFirstAudioMs: { count: 1, maxMs: 9 },
      ttsInterSentenceGapMs: { count: 3, maxMs: 5 },
    },
    downlinkSampleRate: 24000,
    leakageScanClean: true,
  });
  assert.ok(!JSON.stringify(evidence).includes("sk-synthetic-pretend-key"), "no key material in the evidence record");
});

test("the child-data egress gate stays the issue #53 constant in the TTS path too", () => {
  const evidence = buildRealTtsEvidenceRecord({
    activation: parseRealTtsActivation(realEnv()),
    metrics: {
      ttsTurnsPlayed: 0,
      ttsSentencesSent: 0,
      ttsFramesSent: 0,
      ttsStaleAudioSuppressed: 0,
      ttsStopEffectiveMs: { count: 0, maxMs: 0 },
      ttsFirstAudioMs: { count: 0, maxMs: 0 },
      ttsInterSentenceGapMs: { count: 0, maxMs: 0 },
    },
    downlinkSampleRate: 24000,
    leakageScanClean: true,
  });
  assert.equal(evidence.childDataEgressReviewStatus, CHILD_DATA_EGRESS_REVIEW_STATUS);
  assert.equal(evidence.childDataEgressReviewStatus, "not_performed");
  assert.deepEqual(evidence.serverRetentionContract, REAL_TTS_SERVER_RETENTION_CONTRACT);
  assert.equal(evidence.route, "real");
  assert.equal(evidence.provider?.vendorOutputFormat, "pcm");
  assert.equal(evidence.provider?.downlinkSampleRate, 24000);
  // DoD 1 honesty: server-side decode/play verification is operator opt-in,
  // never claimed by CI or by this record.
  assert.equal(evidence.serverPlaybackVerification.performed, false);
});

test("mock-route TTS evidence records are provider-free and sanitized", () => {
  const evidence = buildRealTtsEvidenceRecord({
    activation: { mode: "mock" },
    metrics: {
      ttsTurnsPlayed: 2,
      ttsSentencesSent: 7,
      ttsFramesSent: 28,
      ttsStaleAudioSuppressed: 3,
      ttsStopEffectiveMs: { count: 1, maxMs: 4 },
      ttsFirstAudioMs: { count: 2, maxMs: 6 },
      ttsInterSentenceGapMs: { count: 5, maxMs: 3 },
    },
    downlinkSampleRate: 16000,
    leakageScanClean: true,
  });
  assert.equal(evidence.route, "mock");
  assert.equal(evidence.provider, null);
  assert.equal(evidence.dataEgressReview, null);
  assert.equal(evidence.metrics.ttsStaleAudioSuppressed, 3);
  assert.equal(evidence.metrics.ttsFirstAudioMs.maxMs, 6);
  assert.equal(evidence.downlinkSampleRate, 16000);
  assert.equal(evidence.evidence, "voice-tts-real/1");
  assert.equal(evidence.sanitized, true);
});
