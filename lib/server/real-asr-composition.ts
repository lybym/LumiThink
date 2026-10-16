/**
 * E2E-05 (issue #55) — real ASR provider activation record + content-free
 * evidence record.
 *
 * Issue #55 connects at least one REAL streaming ASR provider in the
 * self-hosted xiaozhi server (the pinned commit's `selected_module.ASR`
 * extension point — deploy/xiaozhi/config/gateway-asr-real.yaml). The VENDOR
 * is called by the pinned xiaozhi server, never by LumiThink: this module
 * therefore owns the ACTIVATION RECORD (the reviewed, fail-closed
 * description of that provider path) and the EVIDENCE RECORD (the
 * content-independent facts a real-ASR evidence run may publish), not a
 * second vendor client. LumiThink only ever receives the wire `asr_final`
 * through the Gateway Adapter (issue #51 transient channel) — there is no
 * LumiThink-side vendor egress path to compose.
 *
 * Fail-closed gates (mirroring lib/server/real-provider-composition.ts):
 *  - The route selector is `LUMITHINK_ASR_ROUTE`: `mock` (default, CI) or
 *    `real` (explicitly reviewed operator environments only). Anything else
 *    fails closed.
 *  - `real` requires EVERY structural fact of the reviewed ASR provider
 *    record: the vendor endpoint (must equal the pinned commit's hard-coded
 *    provider endpoint — drift means the review no longer describes the
 *    path), the model id, the 16 kHz upstream sample rate contract, the
 *    provider-side endpoint-detection window, and the data-egress review
 *    record (reviewer + reason). Problems list variable NAMES only.
 *  - The provider credential is NEVER read at parse/activation time (the
 *    secrets-registry slot `asr_provider_api_key` is consumed by the deploy
 *    tier's render_config.py, not by this module at all).
 *  - CHILD DATA BOUNDARY: `CHILD_DATA_EGRESS_REVIEW_STATUS` (issue #53
 *    constant) stays `not_performed`; no configuration can unlock real
 *    child-data egress through this record. The activation covers the
 *    adult-synthetic/public-sample comparison path only.
 *
 * This module is server-layer (no next/react/prisma imports) and reuses the
 * dependency-free domain gateway's review-acknowledgement type.
 */

import type { DataEgressReviewAcknowledgement } from "../domain/gateway/index.ts";
import { CHILD_DATA_EGRESS_REVIEW_STATUS } from "./real-provider-composition.ts";

/** Route selector values (issue #55: Mock 缺省，真实供应商显式授权才可激活). */
export const ASR_ROUTE_VALUES = ["mock", "real"] as const;
export type AsrProviderRoute = (typeof ASR_ROUTE_VALUES)[number];

/**
 * The internal label of the FIRST reviewed real ASR provider (issue #55
 * 实施范围 1): Aliyun Bailian (百炼) Paraformer realtime streaming, wired at
 * the pinned xiaozhi commit's `ASR.AliyunBLStreamASR` extension point
 * (`type: aliyunbl_stream`). Routing label, not an endpoint — the endpoint
 * below is validated, never discovered.
 */
export const REAL_ASR_PROVIDER_ID = "aliyun-bailian-paraformer-realtime" as const;

/**
 * The vendor WebSocket endpoint the PINNED xiaozhi commit hard-codes inside
 * core/providers/asr/aliyunbl_stream.py (27399a2f…, `self.ws_url`). The
 * activation record must name exactly this value: if the pin changes it,
 * activation fails until the egress review is re-performed.
 */
export const REAL_ASR_VENDOR_ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference" as const;

/**
 * Device uplink contract (XIAOZHI_GATEWAY_BASELINE.uplinkAudio): Opus
 * 16 kHz mono; the pinned server decodes Opus → PCM 16 kHz before the
 * streaming provider. The provider segment pins `sample_rate: 16000`,
 * `format: pcm` — recorded here as the review anchor.
 */
export const REAL_ASR_UPSTREAM_SAMPLE_RATE = 16_000 as const;

/** Streaming mode of the reviewed provider (duplex WebSocket, pinned commit). */
export const REAL_ASR_STREAMING_MODE = "websocket_duplex" as const;

/**
 * What the pinned server retains by default when this tier is active — the
 * facts the runbook must keep true (tests/deploy + CI assert the template):
 * delete_audio: true (no audio files), read_config_from_api: false
 * (ASR/TTS report queues structurally never fill), log_level: WARNING
 * (the pinned commit logs 识别文本 at INFO).
 */
export const REAL_ASR_SERVER_RETENTION_CONTRACT = Object.freeze({
  audioFiles: "delete_audio_true_no_audio_files",
  transcriptReportQueue: "read_config_from_api_false_never_enqueued",
  transcriptLogs: "log_level_warning_info_suppressed",
  exceptionsResidual: "operator_reviewed_warning_only_see_adr_0009",
} as const);

/** Every environment variable the `real` route may consume (names only). */
export const REAL_ASR_ENV_VARS = Object.freeze([
  "LUMITHINK_ASR_ROUTE",
  "LUMITHINK_ASR_VENDOR_ENDPOINT",
  "LUMITHINK_ASR_PROVIDER_MODEL",
  "LUMITHINK_ASR_ENDPOINT_SILENCE_MS",
  "LUMITHINK_ASR_REVIEWER",
  "LUMITHINK_ASR_REVIEW_REASON",
] as const);

export class RealAsrActivationError extends Error {
  /** Variable names/rules that failed validation. Values are never included. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Real ASR activation failed closed: ${problems.join("; ")}`);
    this.name = "RealAsrActivationError";
    this.problems = Object.freeze([...problems]);
  }
}

/** Loose env source (same idiom as lib/env.ts). */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** The reviewed first real ASR provider record the `real` route describes. */
export interface RealAsrActivationRecord {
  readonly providerId: typeof REAL_ASR_PROVIDER_ID;
  /** The vendor endpoint — must equal REAL_ASR_VENDOR_ENDPOINT (review anchor). */
  readonly vendorEndpoint: string;
  /** The reviewed streaming model (e.g. paraformer-realtime-v2). */
  readonly model: string;
  readonly streamingMode: typeof REAL_ASR_STREAMING_MODE;
  readonly upstreamSampleRate: typeof REAL_ASR_UPSTREAM_SAMPLE_RATE;
  /** Provider-side endpoint detection window in ms (max_sentence_silence). */
  readonly endpointSilenceMs: number;
  /** The named data-egress review record (issue #55 DoD 3). */
  readonly dataEgressReview: DataEgressReviewAcknowledgement;
}

export type RealAsrActivation =
  | { readonly mode: "mock" }
  | { readonly mode: "real"; readonly record: RealAsrActivationRecord };

/** Model id grammar: lowercase alphanumeric with dots/dashes (vendor ids). */
const ASR_MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

/**
 * Parse the route selector + activation record fail-closed. Returns `mock`
 * for the default/absent selector; throws `RealAsrActivationError`
 * (variable NAMES only) when `LUMITHINK_ASR_ROUTE=real` is incomplete.
 * The provider key is deliberately NOT an input of this module.
 */
export function parseRealAsrActivation(env: EnvSource): RealAsrActivation {
  const rawRoute = env.LUMITHINK_ASR_ROUTE;
  if (rawRoute === undefined || rawRoute === "" || rawRoute === "mock") {
    return { mode: "mock" };
  }
  if (rawRoute !== "real") {
    throw new RealAsrActivationError([
      "LUMITHINK_ASR_ROUTE must be one of mock | real when set",
    ]);
  }

  const problems: string[] = [];
  const requireField = (name: string, value: string | undefined, rule: string): string => {
    if (value === undefined || value === "") {
      problems.push(`${name} is required when LUMITHINK_ASR_ROUTE=real`);
      return "";
    }
    if (rule !== "" && !new RegExp(rule).test(value)) {
      problems.push(`${name} ${rule}`);
      return "";
    }
    return value;
  };

  const vendorEndpoint = requireField(
    "LUMITHINK_ASR_VENDOR_ENDPOINT",
    env.LUMITHINK_ASR_VENDOR_ENDPOINT,
    "",
  );
  if (vendorEndpoint !== "" && vendorEndpoint !== REAL_ASR_VENDOR_ENDPOINT) {
    // The endpoint is the REVIEW ANCHOR: the pinned commit hard-codes it, so
    // any other value means the review no longer describes the actual path.
    problems.push("LUMITHINK_ASR_VENDOR_ENDPOINT must equal the pinned provider endpoint under review");
  }

  const model = requireField("LUMITHINK_ASR_PROVIDER_MODEL", env.LUMITHINK_ASR_PROVIDER_MODEL, ASR_MODEL_PATTERN.source);

  const reviewer = requireField("LUMITHINK_ASR_REVIEWER", env.LUMITHINK_ASR_REVIEWER, "");
  const reviewReason = requireField("LUMITHINK_ASR_REVIEW_REASON", env.LUMITHINK_ASR_REVIEW_REASON, "");

  const silenceRaw = env.LUMITHINK_ASR_ENDPOINT_SILENCE_MS;
  let endpointSilenceMs: number | null = null;
  if (silenceRaw === undefined || silenceRaw === "") {
    problems.push("LUMITHINK_ASR_ENDPOINT_SILENCE_MS is required when LUMITHINK_ASR_ROUTE=real");
  } else {
    const parsed = Number(silenceRaw);
    if (!Number.isInteger(parsed) || parsed < 200 || parsed > 6000) {
      problems.push("LUMITHINK_ASR_ENDPOINT_SILENCE_MS must be an integer between 200 and 6000 when LUMITHINK_ASR_ROUTE=real");
    } else {
      endpointSilenceMs = parsed;
    }
  }

  if (problems.length > 0) {
    throw new RealAsrActivationError(problems);
  }

  return {
    mode: "real",
    record: Object.freeze({
      providerId: REAL_ASR_PROVIDER_ID,
      vendorEndpoint,
      model,
      streamingMode: REAL_ASR_STREAMING_MODE,
      upstreamSampleRate: REAL_ASR_UPSTREAM_SAMPLE_RATE,
      endpointSilenceMs: endpointSilenceMs as number,
      dataEgressReview: Object.freeze({
        acknowledgeDataEgressReview: true,
        reviewer,
        reason: reviewReason,
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Content-free evidence record (issue #55 DoD 1/DoD 3)
// ---------------------------------------------------------------------------

/** The content-independent ASR metrics an evidence run may publish. */
export interface RealAsrEvidenceMetrics {
  readonly asrEndpointWindows: number;
  readonly asrPartialsSeen: number;
  readonly asrFinalsAccepted: number;
  readonly asrDuplicateFinalsSuppressed: number;
  readonly inputGateBlocked: number;
  readonly asrFinalAcceptMs: { readonly count: number; readonly maxMs: number };
}

export interface RealAsrEvidenceRecord {
  readonly evidence: "voice-asr-real/1";
  /** Content-free by construction: schema-tested, leak-scanned. */
  readonly sanitized: true;
  readonly route: AsrProviderRoute;
  /** Null in mock mode (the synthetic source is not a provider). */
  readonly provider:
    | null
    | {
        readonly providerId: string;
        readonly vendorEndpoint: string;
        readonly model: string;
        readonly streamingMode: string;
        readonly upstreamSampleRate: number;
        readonly endpointSilenceMs: number;
      };
  /** Null in mock mode; reviewer/reason are non-secret by policy. */
  readonly dataEgressReview: null | {
    readonly reviewer: string;
    readonly reason: string;
  };
  readonly childDataEgressReviewStatus: typeof CHILD_DATA_EGRESS_REVIEW_STATUS;
  readonly serverRetentionContract: typeof REAL_ASR_SERVER_RETENTION_CONTRACT;
  readonly metrics: RealAsrEvidenceMetrics;
  /**
   * Provider confidence is structurally NOT exposed by the pinned server's
   * wire (the `stt` message carries transcript text only) and the pinned
   * provider code never forwards it. Honest marker — never a synthesized
   * number. Endpoint metrics ARE collected (windows/finals/suppressions).
   */
  readonly confidence: { readonly onWire: false; readonly note: string };
  /** Result of the run's content-leak scan over every content-free surface. */
  readonly leakageScanClean: boolean;
}

/** Loose shape of the gateway adapter's metrics snapshot (structural subset). */
export type AsrEvidenceMetricsSource = Readonly<{
  asrEndpointWindows: number;
  asrPartialsSeen: number;
  asrFinalsAccepted: number;
  asrDuplicateFinalsSuppressed: number;
  inputGateBlocked: number;
  asrFinalAcceptMs: { readonly count: number; readonly maxMs: number };
}>;

/**
 * Build the content-independent evidence record for one ASR evidence run.
 * Every field is a count, a duration, an id or an enumerated marker — the
 * schema test proves no transcript text can appear here.
 */
export function buildRealAsrEvidenceRecord(refs: {
  readonly activation: RealAsrActivation;
  readonly metrics: AsrEvidenceMetricsSource;
  readonly leakageScanClean: boolean;
}): RealAsrEvidenceRecord {
  if (refs.activation.mode === "mock") {
    return Object.freeze({
      evidence: "voice-asr-real/1",
      sanitized: true,
      route: "mock",
      provider: null,
      dataEgressReview: null,
      childDataEgressReviewStatus: CHILD_DATA_EGRESS_REVIEW_STATUS,
      serverRetentionContract: REAL_ASR_SERVER_RETENTION_CONTRACT,
      metrics: Object.freeze({ ...refs.metrics, asrFinalAcceptMs: Object.freeze({ ...refs.metrics.asrFinalAcceptMs }) }),
      confidence: Object.freeze({
        onWire: false as const,
        note: "synthetic source; provider confidence not exposed on the pinned server wire (stt carries text only)",
      }),
      leakageScanClean: refs.leakageScanClean,
    });
  }
  const record = refs.activation.record;
  return Object.freeze({
    evidence: "voice-asr-real/1",
    sanitized: true,
    route: "real",
    provider: Object.freeze({
      providerId: record.providerId,
      vendorEndpoint: record.vendorEndpoint,
      model: record.model,
      streamingMode: record.streamingMode,
      upstreamSampleRate: record.upstreamSampleRate,
      endpointSilenceMs: record.endpointSilenceMs,
    }),
    dataEgressReview: Object.freeze({
      reviewer: record.dataEgressReview.reviewer,
      reason: record.dataEgressReview.reason,
    }),
    childDataEgressReviewStatus: CHILD_DATA_EGRESS_REVIEW_STATUS,
    serverRetentionContract: REAL_ASR_SERVER_RETENTION_CONTRACT,
    metrics: Object.freeze({ ...refs.metrics, asrFinalAcceptMs: Object.freeze({ ...refs.metrics.asrFinalAcceptMs }) }),
    confidence: Object.freeze({
      onWire: false as const,
      note: "provider confidence not exposed on the pinned server wire (stt carries text only, commit 27399a2f)",
    }),
    leakageScanClean: refs.leakageScanClean,
  });
}
