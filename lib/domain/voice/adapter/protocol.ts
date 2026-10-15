/**
 * R1-V3 Voice Gateway Adapter — device-edge protocol contract, pinned to the
 * xiaozhi official firmware v2.5.2 wire protocol and the self-hosted
 * xinnan-tech/xiaozhi-esp32-server evaluation baseline (issue #30 实现范围 1/2;
 * docs/VOICE_GATEWAY_PROTOCOL.md; docs/VOICE_RUNTIME.md §2/§4).
 *
 * This module owns the PROTOCOL VOCABULARY and fail-closed parsers for the
 * device/protocol edge: what the Adapter accepts from the xiaozhi side and
 * what it may emit back. The fixed baseline (firmware tag, server commit,
 * audio parameters) is a frozen constant so the compatibility matrix is
 * enforced by tests, not by prose.
 *
 * TERMINOLOGY (recorded discrepancy, see the matrix doc): the v2.5.2 wire
 * message for "stop playing, I interrupted you" is `{"type":"abort"}`;
 * `client_abort` is the self-hosted server's INTERNAL state flag set when it
 * handles that message (xinnan-tech abortHandle.py). This contract names the
 * device-side intent `abort` and keeps `client_abort` for the semantics the
 * issue and docs/VOICE_RUNTIME.md §4 describe.
 *
 * PRIVACY (issue #30 统一阻断规则, revised by issue #51 / E2E-01): the ONLY
 * content-bearing fields in the whole gateway protocol are the transient
 * `text` of `asr_partial` / `asr_final`. A length-capped, Input-Gate-screened
 * final transcript MAY continue into the authorized transient channel
 * (protected single-turn call → necessary Bridge IPC → approved model
 * request) and is destroyed at every failure/cancel point; it is NEVER
 * persisted, audited, logged or echoed. A partial remains a candidate only.
 * No audio bytes exist anywhere in this contract: the Opus send surface is
 * frame counts + hex digests (real encode/decode is R5 hardware work;
 * everything here is pure-synthetic and replayable).
 *
 * This module must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

// ---------------------------------------------------------------------------
// Pinned evaluation baseline (issue #30: 固定版本/契约)
// ---------------------------------------------------------------------------

/**
 * The pinned protocol baseline the Adapter contract was evaluated against.
 * Sources (read 2026-10-15, unauthorized to change at runtime):
 * - firmware protocol doc at tag v2.5.2 of 78/xiaozhi-esp32;
 * - xinnan-tech/xiaozhi-esp32-server abort/hello/connection handling at the
 *   pinned main commit (latest tag at evaluation time: v0.9.7).
 * Server/firmware compatibility and private OTA are NOT device-verified
 * (未实机验证) — this constant only fixes what the CONTRACT was written for.
 */
export const XIAOZHI_GATEWAY_BASELINE = Object.freeze({
  firmwareRepo: "78/xiaozhi-esp32",
  firmwareTag: "v2.5.2",
  firmwareProtocolDoc:
    "https://github.com/78/xiaozhi-esp32/blob/v2.5.2/docs/websocket.md",
  wireProtocolVersion: 1,
  /** Device uplink audio parameters (firmware hello). */
  uplinkAudio: Object.freeze({
    format: "opus",
    sampleRate: 16000,
    channels: 1,
    frameDurationMs: 60,
  }),
  /**
   * Downlink audio: the v2.5.2 doc notes the server MAY push 24 kHz for
   * playback; the rate is negotiated per hello, never assumed.
   */
  downlinkAudio: Object.freeze({
    format: "opus",
    sampleRateMax: 24000,
    channels: 1,
    frameDurationMs: 60,
  }),
  serverRepo: "xinnan-tech/xiaozhi-esp32-server",
  serverRef: "main@27399a2fb64b5910196f438a256ce0a9f868481f",
  serverTag: "v0.9.7",
  evaluatedAt: "2026-10-15",
  deviceVerified: false,
} as const);

// ---------------------------------------------------------------------------
// Id grammars (device edge)
// ---------------------------------------------------------------------------

/**
 * Device-Id: the physical device MAC, separator-stripped and lower-cased by
 * the transport. 12..32 lowercase hex chars — enough for MAC and extended
 * board ids, never any content.
 */
export const XIAOZHI_DEVICE_ID_PATTERN = /^[0-9a-f]{12,32}$/;

/**
 * xiaozhi `session_id`: minted per connection by the server (uuid4 in the
 * pinned server: core/connection.py `self.session_id = str(uuid.uuid4())`).
 * EPHEMERAL by contract — never a child identity, never persisted as one.
 */
export const XIAOZHI_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

/** Activation digest: content-free hex proof of a guardian-issued binding. */
export const GATEWAY_ACTIVATION_DIGEST_PATTERN = /^[0-9a-f]{16,64}$/;

// ---------------------------------------------------------------------------
// Inbound device events (device/server → Adapter), fail-closed
// ---------------------------------------------------------------------------

export const GATEWAY_LISTEN_STATES = Object.freeze(["start", "stop", "detect"] as const);
export type GatewayListenState = (typeof GATEWAY_LISTEN_STATES)[number];

export const GATEWAY_LISTEN_MODES = Object.freeze(["auto", "manual", "realtime"] as const);
export type GatewayListenMode = (typeof GATEWAY_LISTEN_MODES)[number];

/**
 * Device abort reasons (v2.5.2: `reason` is implementation-defined; these
 * are the ones the Adapter contract recognizes — anything else fails closed
 * at the parser instead of being guessed at).
 */
export const GATEWAY_ABORT_REASONS = Object.freeze([
  "wake_word_detected",
  "manual",
  "vad_detected",
] as const);
export type GatewayAbortReason = (typeof GATEWAY_ABORT_REASONS)[number];

export const GATEWAY_DISCONNECT_REASONS = Object.freeze([
  "network",
  "server",
  "device",
] as const);
export type GatewayDisconnectReason = (typeof GATEWAY_DISCONNECT_REASONS)[number];

export interface GatewayAudioParams {
  readonly format: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly frameDurationMs: number;
}

/** One inbound gateway event. Only asr_* carries (transient) text. */
export type GatewayDeviceEvent =
  | {
      readonly kind: "hello";
      readonly deviceId: string;
      /**
       * Device possession proof (content-free hex): the activation digest the
       * guardian issued for THIS device. Compared against the binding record
       * at connection time — a public MAC alone never opens a lease (issue
       * #30 验收 1; binding.ts openConnection). Wire-level replay protection
       * (TLS / challenge-response) stays transport work (R5).
       */
      readonly clientDigest: string | null;
      readonly audioParams: GatewayAudioParams | null;
    }
  | {
      readonly kind: "session_issued";
      /** Server-minted per-connection session handle (EPHEMERAL). */
      readonly xiaozhiSessionId: string;
    }
  | {
      readonly kind: "listen";
      readonly xiaozhiSessionId: string;
      readonly state: GatewayListenState;
      readonly mode: GatewayListenMode | null;
    }
  | {
      readonly kind: "asr_partial";
      readonly xiaozhiSessionId: string;
      /** Transient partial hypothesis — digested and discarded. */
      readonly text: string;
    }
  | {
      readonly kind: "asr_final";
      readonly xiaozhiSessionId: string;
      /** Transient final transcript — digested and discarded. */
      readonly text: string;
    }
  | {
      readonly kind: "abort";
      readonly xiaozhiSessionId: string;
      readonly reason: GatewayAbortReason;
    }
  | {
      readonly kind: "connection_dropped";
      readonly reason: GatewayDisconnectReason;
    }
  | { readonly kind: "server_restart" };

export type GatewayDeviceEventKind = GatewayDeviceEvent["kind"];

/** Bounded transient ASR text lengths (chars). */
export const GATEWAY_MAX_ASR_PARTIAL_CHARS = 256;
export const GATEWAY_MAX_ASR_FINAL_CHARS = 512;

function failGatewayParse(path: string, message: string): never {
  throw new Error(`gateway.${path}: ${message}`);
}

function requireObjectRecord(raw: unknown, what: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    failGatewayParse(what, "expected a JSON object.");
  }
  return raw as Record<string, unknown>;
}

function parseAudioParams(raw: unknown, what: string): GatewayAudioParams | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const record = requireObjectRecord(raw, what);
  if (record.format !== "opus") {
    failGatewayParse(`${what}.format`, "the gateway baseline negotiates opus only.");
  }
  const sampleRate = record.sampleRate;
  const channels = record.channels;
  const frameDurationMs = record.frameDurationMs;
  if (
    typeof sampleRate !== "number" ||
    !Number.isInteger(sampleRate) ||
    (sampleRate as number) < 8000 ||
    (sampleRate as number) > 48000
  ) {
    failGatewayParse(`${what}.sampleRate`, "sampleRate must be an integer in [8000, 48000].");
  }
  if (typeof channels !== "number" || !Number.isInteger(channels) || (channels as number) < 1 || (channels as number) > 2) {
    failGatewayParse(`${what}.channels`, "channels must be an integer in [1, 2].");
  }
  if (
    typeof frameDurationMs !== "number" ||
    !Number.isInteger(frameDurationMs) ||
    (frameDurationMs as number) < 10 ||
    (frameDurationMs as number) > 120
  ) {
    failGatewayParse(`${what}.frameDurationMs`, "frameDurationMs must be an integer in [10, 120].");
  }
  return {
    format: record.format as string,
    sampleRate: sampleRate as number,
    channels: channels as number,
    frameDurationMs: frameDurationMs as number,
  };
}

function requireSessionId(record: Record<string, unknown>, what: string): string {
  const value = record.xiaozhiSessionId;
  if (typeof value !== "string" || !XIAOZHI_SESSION_ID_PATTERN.test(value)) {
    failGatewayParse(`${what}.xiaozhiSessionId`, "xiaozhiSessionId must match the bounded session grammar.");
  }
  return value as string;
}

/**
 * Parse one inbound device event. Fail closed on: non-object, unknown kind,
 * unknown fields, grammar violations or oversized transient text. The text
 * fields are length-capped but otherwise opaque — the Adapter digests them.
 */
export function parseGatewayDeviceEvent(raw: unknown): GatewayDeviceEvent {
  const record = requireObjectRecord(raw, "event");
  const kind = record.kind;
  for (const key of Object.keys(record)) {
    if (!isAllowedEventField(kind as string, key)) {
      failGatewayParse(`event.${key}`, "unknown event field.");
    }
  }
  switch (kind) {
    case "hello": {
      const deviceId = record.deviceId;
      if (typeof deviceId !== "string" || !XIAOZHI_DEVICE_ID_PATTERN.test(deviceId)) {
        failGatewayParse("event.deviceId", "deviceId must match the bounded device grammar.");
      }
      let clientDigest: string | null = null;
      if (record.clientDigest !== undefined && record.clientDigest !== null) {
        if (typeof record.clientDigest !== "string" || !GATEWAY_ACTIVATION_DIGEST_PATTERN.test(record.clientDigest)) {
          failGatewayParse("event.clientDigest", "clientDigest must be a bounded hex digest.");
        }
        clientDigest = record.clientDigest as string;
      }
      return {
        kind: "hello",
        deviceId,
        clientDigest,
        audioParams: parseAudioParams(record.audioParams, "event.audioParams"),
      };
    }
    case "session_issued":
      return { kind: "session_issued", xiaozhiSessionId: requireSessionId(record, "event") };
    case "listen": {
      const state = record.state;
      if (!(GATEWAY_LISTEN_STATES as readonly string[]).includes(state as string)) {
        failGatewayParse("event.state", "listen state must be start, stop or detect.");
      }
      let mode: GatewayListenMode | null = null;
      if (record.mode !== undefined && record.mode !== null) {
        if (!(GATEWAY_LISTEN_MODES as readonly string[]).includes(record.mode as string)) {
          failGatewayParse("event.mode", "listen mode must be auto, manual or realtime.");
        }
        mode = record.mode as GatewayListenMode;
      }
      return {
        kind: "listen",
        xiaozhiSessionId: requireSessionId(record, "event"),
        state: state as GatewayListenState,
        mode,
      };
    }
    case "asr_partial": {
      const text = record.text;
      if (typeof text !== "string" || text.length === 0 || text.length > GATEWAY_MAX_ASR_PARTIAL_CHARS) {
        failGatewayParse("event.text", "asr_partial text must be a bounded non-empty string.");
      }
      return { kind: "asr_partial", xiaozhiSessionId: requireSessionId(record, "event"), text };
    }
    case "asr_final": {
      const text = record.text;
      if (typeof text !== "string" || text.length === 0 || text.length > GATEWAY_MAX_ASR_FINAL_CHARS) {
        failGatewayParse("event.text", "asr_final text must be a bounded non-empty string.");
      }
      return { kind: "asr_final", xiaozhiSessionId: requireSessionId(record, "event"), text };
    }
    case "abort": {
      const reason = record.reason;
      if (!(GATEWAY_ABORT_REASONS as readonly string[]).includes(reason as string)) {
        failGatewayParse("event.reason", "abort reason must be a registered gateway reason.");
      }
      return { kind: "abort", xiaozhiSessionId: requireSessionId(record, "event"), reason: reason as GatewayAbortReason };
    }
    case "connection_dropped": {
      const reason = record.reason;
      if (!(GATEWAY_DISCONNECT_REASONS as readonly string[]).includes(reason as string)) {
        failGatewayParse("event.reason", "disconnect reason must be a registered gateway reason.");
      }
      return { kind: "connection_dropped", reason: reason as GatewayDisconnectReason };
    }
    case "server_restart":
      return { kind: "server_restart" };
    default:
      failGatewayParse("event.kind", "event kind is not a registered gateway event.");
  }
}

function isAllowedEventField(kind: string, field: string): boolean {
  const common: readonly string[] = ["kind"];
  switch (kind) {
    case "hello":
      return (["kind", "deviceId", "clientDigest", "audioParams"] as readonly string[]).includes(field);
    case "session_issued":
      return (["kind", "xiaozhiSessionId"] as readonly string[]).includes(field);
    case "listen":
      return (["kind", "xiaozhiSessionId", "state", "mode"] as readonly string[]).includes(field);
    case "asr_partial":
    case "asr_final":
      return (["kind", "xiaozhiSessionId", "text"] as readonly string[]).includes(field);
    case "abort":
      return (["kind", "xiaozhiSessionId", "reason"] as readonly string[]).includes(field);
    case "connection_dropped":
      return (["kind", "reason"] as readonly string[]).includes(field);
    case "server_restart":
      return common.includes(field);
    default:
      // Unknown kinds are rejected by the switch above; no field is allowed.
      return false;
  }
}

// ---------------------------------------------------------------------------
// Outbound device directives (Adapter → device via the server), content-free
// ---------------------------------------------------------------------------

export type GatewayPlaybackStopReason = "interrupted" | "completed" | "failed";

/**
 * One outbound directive. Every payload is content-free: ids, epochs, frame
 * COUNTS and hex digests. There is no field that could carry audio bytes,
 * transcript text or model output (schema-tested).
 */
export type GatewayDeviceDirective =
  | {
      readonly kind: "tts.start";
      readonly sessionKey: string;
      readonly turnId: string;
      readonly epoch: number;
    }
  | {
      readonly kind: "tts.frames";
      readonly sessionKey: string;
      readonly turnId: string;
      readonly epoch: number;
      /** Synthetic frame count (real Opus framing is R5 hardware work). */
      readonly frameCount: number;
      /** Content-free hex digest of the admitted sentence identity. */
      readonly audioDigest: string;
    }
  | {
      readonly kind: "tts.stop";
      readonly sessionKey: string;
      readonly turnId: string | null;
      readonly epoch: number;
      readonly reason: GatewayPlaybackStopReason;
    }
  | {
      readonly kind: "tts.clear";
      readonly sessionKey: string;
      readonly epoch: number;
      readonly droppedStale: number;
    };

// ---------------------------------------------------------------------------
// Gateway rejection codes (enumerated; submitted values are never echoed)
// ---------------------------------------------------------------------------

export const GATEWAY_REJECTION_CODES = Object.freeze([
  "gateway.parse_failed",
  "device_unbound",
  "device_possession_denied",
  "device_connection_conflict",
  "device_rebinding_denied",
  "binding_capacity_exceeded",
  "connection_unknown",
  "connection_closed",
  "session_not_mapped",
  "session_forged",
  "cross_session_rejected",
  "no_active_playback",
  "session_unknown",
  "idempotency_conflict",
  "input_gate_blocked",
  "worker_recovering",
  "bridge_turn_conflict",
  "stale_turn_rejected",
  "cancel_unknown_turn",
  "cancel_timeout",
  "scheduler_busy",
  "turn_state_transition_illegal",
  // Composition-internal code (lib/server/voice-bridge-composition.ts): the
  // core port reports it when a text-bearing turn's held transcript is
  // missing at dispatch (fail-closed). The Adapter forwards core-port
  // failures verbatim, so this code is part of ITS rejection vocabulary;
  // the Bridge IPC itself never produces it (it is NOT in
  // BRIDGE_REJECTION_CODES — issue #51 review R1 P2-1).
  "prompt_text_lost",
] as const);

export type GatewayRejectionCode = (typeof GATEWAY_REJECTION_CODES)[number];

export function isGatewayRejectionCode(value: unknown): value is GatewayRejectionCode {
  return typeof value === "string" && (GATEWAY_REJECTION_CODES as readonly string[]).includes(value);
}
