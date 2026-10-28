/**
 * E2E-06 (issue #56) — real TTS provider activation record + content-free
 * evidence record.
 *
 * Issue #56 connects a REAL TTS provider in the self-hosted xiaozhi server
 * (the pinned commit's `selected_module.TTS` extension point —
 * deploy/xiaozhi/config/gateway-tts-real.yaml). The VENDOR is called by the
 * pinned xiaozhi server, never by LumiThink: this module therefore owns the
 * ACTIVATION RECORD (the reviewed, fail-closed description of that provider
 * path) and the EVIDENCE RECORD (the content-independent facts a real-TTS
 * evidence run may publish), not a second vendor client. LumiThink never
 * touches vendor audio: the pinned server synthesizes, encodes and streams
 * the Opus downlink; the Adapter contract surface stays frame counts + hex
 * digests (docs/VOICE_GATEWAY_PROTOCOL.md §2.4).
 *
 * First provider (mirrors the E2E-05 vendor choice): Aliyun Bailian
 * CosyVoice DUAL_STREAM TTS (`type: alibl_stream`) at the pinned commit's
 * TTS extension point — same vendor family as the reviewed real-ASR path
 * (issue #55), so the vendor security/retention review, the dashscope
 * endpoint anchor and the API-key lifecycle extend to TTS.
 *
 * Fail-closed gates (mirroring lib/server/real-asr-composition.ts):
 *  - The route selector is `LUMITHINK_TTS_ROUTE`: `mock` (default, CI) or
 *    `real` (explicitly reviewed operator environments only). Anything else
 *    fails closed.
 *  - `real` requires EVERY structural fact of the reviewed TTS provider
 *    record: the vendor endpoint (must equal the pinned commit's default
 *    WSS inference endpoint verbatim — drift means the review no longer
 *    describes the path), the model id, the voice, the negotiated downlink
 *    sample rate (16/24 kHz per the pinned wire contract), and the
 *    data-egress review record (reviewer + reason). Problems list variable
 *    NAMES only.
 *  - The provider credential is NEVER read at parse/activation time (the
 *    secrets-registry slot `tts_provider_api_key` is consumed by the deploy
 *    tier's render_config.py via `XIAOZHI_TTS_API_KEY`, not by this module).
 *  - CHILD DATA BOUNDARY: `CHILD_DATA_EGRESS_REVIEW_STATUS` (issue #53
 *    constant) stays `not_performed`; no configuration can unlock real
 *    child-data egress through this record. The activation covers the
 *    adult-synthetic/public-sample server-side verification path only.
 *
 * This module is server-layer (no next/react/prisma imports) and reuses the
 * dependency-free domain gateway's review-acknowledgement type.
 */

import type { DataEgressReviewAcknowledgement } from "../domain/gateway/index.ts";
import { CHILD_DATA_EGRESS_REVIEW_STATUS } from "./real-provider-composition.ts";

/** Route selector values (issue #56: Mock 缺省，真实供应商显式授权才可激活). */
export const TTS_ROUTE_VALUES = ["mock", "real"] as const;
export type TtsProviderRoute = (typeof TTS_ROUTE_VALUES)[number];

/**
 * The internal label of the FIRST reviewed real TTS provider (issue #56
 * 实施范围 1): Aliyun Bailian CosyVoice dual-stream TTS, wired at the pinned
 * xiaozhi commit's `TTS.AliBLStreamTTS` extension point (`type: alibl_stream`).
 * Routing label, not an endpoint — the endpoint below is validated, never
 * discovered.
 */
export const REAL_TTS_PROVIDER_ID = "aliyun-bailian-cosyvoice-dual-stream" as const;

/**
 * The vendor WSS endpoint the PINNED xiaozhi commit defaults to inside
 * core/utils/alibl_endpoint.py (8f2dda09… — the file is unchanged
 * v0.9.7→v0.9.8, re-checked 2026-10-28, `DEFAULT_WS_URL`) — the value
 * used when the deploy template omits `ws_url` (which it deliberately does).
 * The activation record must name exactly this value: if the pin changes it,
 * activation fails until the egress review is re-performed. Note: this is
 * the SAME dashscope inference host as the reviewed real-ASR anchor (issue
 * #55); the pinned TTS default carries a trailing slash while the pinned
 * ASR hard-code does not — both are recorded verbatim, never normalized.
 */
export const REAL_TTS_VENDOR_ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/" as const;

/**
 * Vendor output format requested by the pinned provider (alibl_stream.py
 * default `format: pcm`); the pinned TTS base then encodes Opus for the
 * downlink at the connection's negotiated sample rate
 * (`sample_rate: self.conn.sample_rate`). Pinned here as the review anchor —
 * the deploy template pins the same value.
 */
export const REAL_TTS_VENDOR_OUTPUT_FORMAT = "pcm" as const;

/** Streaming mode of the reviewed provider (pinned commit: dual-stream WS). */
export const REAL_TTS_STREAMING_MODE = "websocket_dual_stream" as const;

/**
 * Negotiated downlink sample rates the pinned wire contract allows
 * (VOICE_GATEWAY_PROTOCOL §1: uplink 16 kHz fixed; downlink negotiated per
 * hello, server MAY use 24 kHz). The pinned provider request carries
 * `sample_rate: self.conn.sample_rate` — i.e. the negotiated value, never a
 * provider-side override.
 */
export const REAL_TTS_DOWNLINK_SAMPLE_RATES = Object.freeze([16_000, 24_000] as const);

/**
 * What the pinned server retains by default when this tier is active — the
 * facts the runbook must keep true (tests/deploy + CI assert the template):
 * delete_audio: true (dual-stream synthesis never writes tmp audio files),
 * read_config_from_api: false (ASR/TTS report queues structurally never
 * fill), log_level: WARNING (the pinned commit logs sentence text at INFO —
 * alibl_stream.py "句子语音生成…"), WARNING+ exception paths reviewed and
 * disclosed (ADR-0010).
 */
export const REAL_TTS_SERVER_RETENTION_CONTRACT = Object.freeze({
  audioFiles: "delete_audio_true_dual_stream_no_tmp_files",
  transcriptReportQueue: "read_config_from_api_false_never_enqueued",
  ttsTextLogs: "log_level_warning_info_suppressed",
  exceptionsResidual: "operator_reviewed_warning_only_see_adr_0010",
} as const);

/** Every environment variable the `real` route may consume (names only). */
export const REAL_TTS_ENV_VARS = Object.freeze([
  "LUMITHINK_TTS_ROUTE",
  "LUMITHINK_TTS_VENDOR_ENDPOINT",
  "LUMITHINK_TTS_PROVIDER_MODEL",
  "LUMITHINK_TTS_VOICE",
  "LUMITHINK_TTS_DOWNLINK_SAMPLE_RATE",
  "LUMITHINK_TTS_REVIEWER",
  "LUMITHINK_TTS_REVIEW_REASON",
] as const);

export class RealTtsActivationError extends Error {
  /** Variable names/rules that failed validation. Values are never included. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Real TTS activation failed closed: ${problems.join("; ")}`);
    this.name = "RealTtsActivationError";
    this.problems = Object.freeze([...problems]);
  }
}

/** Loose env source (same idiom as lib/env.ts / real-asr-composition.ts). */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** The reviewed first real TTS provider record the `real` route describes. */
export interface RealTtsActivationRecord {
  readonly providerId: typeof REAL_TTS_PROVIDER_ID;
  /** The vendor endpoint — must equal REAL_TTS_VENDOR_ENDPOINT (review anchor). */
  readonly vendorEndpoint: string;
  /** The reviewed synthesis model (e.g. cosyvoice-v2). */
  readonly model: string;
  /** The reviewed voice (e.g. longxiaochun_v2). */
  readonly voice: string;
  readonly vendorOutputFormat: typeof REAL_TTS_VENDOR_OUTPUT_FORMAT;
  readonly streamingMode: typeof REAL_TTS_STREAMING_MODE;
  /** The negotiated downlink sample rate this activation describes. */
  readonly downlinkSampleRate: number;
  /** The named data-egress review record (issue #56 DoD 3). */
  readonly dataEgressReview: DataEgressReviewAcknowledgement;
}

export type RealTtsActivation =
  | { readonly mode: "mock" }
  | { readonly mode: "real"; readonly record: RealTtsActivationRecord };

/** Model id grammar: lowercase alphanumeric with dots/dashes (vendor ids). */
const TTS_MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
/** Voice grammar: vendor voice ids like longxiaochun_v2 / zh-CN-XiaoxiaoNeural. */
const TTS_VOICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;

/**
 * Parse the route selector + activation record fail-closed. Returns `mock`
 * for the default/absent selector; throws `RealTtsActivationError`
 * (variable NAMES only) when `LUMITHINK_TTS_ROUTE=real` is incomplete.
 * The provider key is deliberately NOT an input of this module.
 */
export function parseRealTtsActivation(env: EnvSource): RealTtsActivation {
  const rawRoute = env.LUMITHINK_TTS_ROUTE;
  if (rawRoute === undefined || rawRoute === "" || rawRoute === "mock") {
    return { mode: "mock" };
  }
  if (rawRoute !== "real") {
    throw new RealTtsActivationError([
      "LUMITHINK_TTS_ROUTE must be one of mock | real when set",
    ]);
  }

  const problems: string[] = [];
  const requireField = (name: string, value: string | undefined, rule: string): string => {
    if (value === undefined || value === "") {
      problems.push(`${name} is required when LUMITHINK_TTS_ROUTE=real`);
      return "";
    }
    if (rule !== "" && !new RegExp(rule).test(value)) {
      problems.push(`${name} ${rule}`);
      return "";
    }
    return value;
  };

  const vendorEndpoint = requireField(
    "LUMITHINK_TTS_VENDOR_ENDPOINT",
    env.LUMITHINK_TTS_VENDOR_ENDPOINT,
    "",
  );
  if (vendorEndpoint !== "" && vendorEndpoint !== REAL_TTS_VENDOR_ENDPOINT) {
    // The endpoint is the REVIEW ANCHOR: the pinned commit defaults to it, so
    // any other value means the review no longer describes the actual path.
    problems.push("LUMITHINK_TTS_VENDOR_ENDPOINT must equal the pinned provider endpoint under review");
  }

  const model = requireField("LUMITHINK_TTS_PROVIDER_MODEL", env.LUMITHINK_TTS_PROVIDER_MODEL, TTS_MODEL_PATTERN.source);
  const voice = requireField("LUMITHINK_TTS_VOICE", env.LUMITHINK_TTS_VOICE, TTS_VOICE_PATTERN.source);

  const reviewer = requireField("LUMITHINK_TTS_REVIEWER", env.LUMITHINK_TTS_REVIEWER, "");
  const reviewReason = requireField("LUMITHINK_TTS_REVIEW_REASON", env.LUMITHINK_TTS_REVIEW_REASON, "");

  const rateRaw = env.LUMITHINK_TTS_DOWNLINK_SAMPLE_RATE;
  let downlinkSampleRate: number | null = null;
  if (rateRaw === undefined || rateRaw === "") {
    problems.push("LUMITHINK_TTS_DOWNLINK_SAMPLE_RATE is required when LUMITHINK_TTS_ROUTE=real");
  } else {
    const parsed = Number(rateRaw);
    if (!(REAL_TTS_DOWNLINK_SAMPLE_RATES as readonly number[]).includes(parsed)) {
      problems.push("LUMITHINK_TTS_DOWNLINK_SAMPLE_RATE must be one of 16000 | 24000 when LUMITHINK_TTS_ROUTE=real");
    } else {
      downlinkSampleRate = parsed;
    }
  }

  if (problems.length > 0) {
    throw new RealTtsActivationError(problems);
  }

  return {
    mode: "real",
    record: Object.freeze({
      providerId: REAL_TTS_PROVIDER_ID,
      vendorEndpoint,
      model,
      voice,
      vendorOutputFormat: REAL_TTS_VENDOR_OUTPUT_FORMAT,
      streamingMode: REAL_TTS_STREAMING_MODE,
      downlinkSampleRate: downlinkSampleRate as number,
      dataEgressReview: Object.freeze({
        acknowledgeDataEgressReview: true,
        reviewer,
        reason: reviewReason,
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Content-free evidence record (issue #56 DoD 1/DoD 3)
// ---------------------------------------------------------------------------

/** The content-independent TTS metrics an evidence run may publish. */
export interface RealTtsEvidenceMetrics {
  /** Turns whose TTS reached the device sink (first frame batch sent). */
  readonly ttsTurnsPlayed: number;
  /** TTS sentence items delivered to the device sink (frame batches). */
  readonly ttsSentencesSent: number;
  /** Raw frame count delivered (synthetic framing; no audio bytes exist). */
  readonly ttsFramesSent: number;
  /** Stale TTS items suppressed after cancel/fence (old-epoch audio sent = 0). */
  readonly ttsStaleAudioSuppressed: number;
  /** Abort arrival → device stop directive issued (ms; candidate baseline). */
  readonly ttsStopEffectiveMs: { readonly count: number; readonly maxMs: number };
  /** Accepted final → first frame batch of that turn (ms; candidate baseline). */
  readonly ttsFirstAudioMs: { readonly count: number; readonly maxMs: number };
  /** Gap between consecutive frame batches in one playback turn (ms). */
  readonly ttsInterSentenceGapMs: { readonly count: number; readonly maxMs: number };
}

export interface RealTtsEvidenceRecord {
  readonly evidence: "voice-tts-real/1";
  /** Content-free by construction: schema-tested, leak-scanned. */
  readonly sanitized: true;
  readonly route: TtsProviderRoute;
  /** Null in mock mode (the synthetic source is not a provider). */
  readonly provider:
    | null
    | {
        readonly providerId: string;
        readonly vendorEndpoint: string;
        readonly model: string;
        readonly voice: string;
        readonly vendorOutputFormat: string;
        readonly streamingMode: string;
        readonly downlinkSampleRate: number;
      };
  /** Null in mock mode; reviewer/reason are non-secret by policy. */
  readonly dataEgressReview: null | {
    readonly reviewer: string;
    readonly reason: string;
  };
  readonly childDataEgressReviewStatus: typeof CHILD_DATA_EGRESS_REVIEW_STATUS;
  readonly serverRetentionContract: typeof REAL_TTS_SERVER_RETENTION_CONTRACT;
  readonly metrics: RealTtsEvidenceMetrics;
  /** Sample rate negotiated at hello for the evidence run (null if none). */
  readonly downlinkSampleRate: number | null;
  /**
   * Server-side decode/play verification ("真实 TTS→Opus 线路可解码/播放，
   * 音色清楚") is an OPERATOR opt-in on adult/synthetic samples — never CI,
   * never claimed by this record. Honest constant marker, like the child-data
   * gate; a real run records its facts in the operator log, not here.
   */
  readonly serverPlaybackVerification: { readonly performed: false; readonly note: string };
  /** Result of the run's content-leak scan over every content-free surface. */
  readonly leakageScanClean: boolean;
}

/** Loose shape of the gateway adapter's metrics snapshot (structural subset). */
export type TtsEvidenceMetricsSource = Readonly<{
  ttsTurnsPlayed: number;
  ttsSentencesSent: number;
  ttsFramesSent: number;
  ttsStaleAudioSuppressed: number;
  ttsStopEffectiveMs: { readonly count: number; readonly maxMs: number };
  ttsFirstAudioMs: { readonly count: number; readonly maxMs: number };
  ttsInterSentenceGapMs: { readonly count: number; readonly maxMs: number };
}>;

/**
 * Build the content-independent evidence record for one TTS evidence run.
 * Every field is a count, a duration, an id or an enumerated marker — the
 * schema test proves no audio content or transcript text can appear here
 * (the Adapter contract surface carries frame counts + digests only).
 */
export function buildRealTtsEvidenceRecord(refs: {
  readonly activation: RealTtsActivation;
  readonly metrics: TtsEvidenceMetricsSource;
  /** Hello-negotiated sample rate of the run (from the mapping snapshot). */
  readonly downlinkSampleRate: number | null;
  readonly leakageScanClean: boolean;
}): RealTtsEvidenceRecord {
  const metrics = Object.freeze({
    ttsTurnsPlayed: refs.metrics.ttsTurnsPlayed,
    ttsSentencesSent: refs.metrics.ttsSentencesSent,
    ttsFramesSent: refs.metrics.ttsFramesSent,
    ttsStaleAudioSuppressed: refs.metrics.ttsStaleAudioSuppressed,
    ttsStopEffectiveMs: Object.freeze({ ...refs.metrics.ttsStopEffectiveMs }),
    ttsFirstAudioMs: Object.freeze({ ...refs.metrics.ttsFirstAudioMs }),
    ttsInterSentenceGapMs: Object.freeze({ ...refs.metrics.ttsInterSentenceGapMs }),
  });
  if (refs.activation.mode === "mock") {
    return Object.freeze({
      evidence: "voice-tts-real/1",
      sanitized: true,
      route: "mock",
      provider: null,
      dataEgressReview: null,
      childDataEgressReviewStatus: CHILD_DATA_EGRESS_REVIEW_STATUS,
      serverRetentionContract: REAL_TTS_SERVER_RETENTION_CONTRACT,
      metrics,
      downlinkSampleRate: refs.downlinkSampleRate,
      serverPlaybackVerification: Object.freeze({
        performed: false as const,
        note: "server-side decode/play verification is operator opt-in on adult synthetic samples (ADR-0010); never claimed by CI",
      }),
      leakageScanClean: refs.leakageScanClean,
    });
  }
  const record = refs.activation.record;
  return Object.freeze({
    evidence: "voice-tts-real/1",
    sanitized: true,
    route: "real",
    provider: Object.freeze({
      providerId: record.providerId,
      vendorEndpoint: record.vendorEndpoint,
      model: record.model,
      voice: record.voice,
      vendorOutputFormat: record.vendorOutputFormat,
      streamingMode: record.streamingMode,
      downlinkSampleRate: record.downlinkSampleRate,
    }),
    dataEgressReview: Object.freeze({
      reviewer: record.dataEgressReview.reviewer,
      reason: record.dataEgressReview.reason,
    }),
    childDataEgressReviewStatus: CHILD_DATA_EGRESS_REVIEW_STATUS,
    serverRetentionContract: REAL_TTS_SERVER_RETENTION_CONTRACT,
    metrics,
    downlinkSampleRate: refs.downlinkSampleRate,
    serverPlaybackVerification: Object.freeze({
      performed: false as const,
      note: "server-side decode/play verification is operator opt-in on adult synthetic samples (ADR-0010); never claimed by CI",
    }),
    leakageScanClean: refs.leakageScanClean,
  });
}
