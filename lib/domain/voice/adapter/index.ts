/**
 * R1-V3 Voice Gateway Adapter — public surface (issue #30;
 * docs/VOICE_GATEWAY_PROTOCOL.md; docs/VOICE_RUNTIME.md §2/§4/§13).
 *
 * The Adapter is the DEVICE/PROTOCOL EDGE between the pinned xiaozhi v2.5.2
 * surface (device + self-hosted xinnan-tech server) and the trusted Core
 * (R1-V1 Turn Orchestrator + R1-V2 Cordis Runtime Bridge). It owns trusted
 * device binding, the ephemeral xiaozhi session mapping (never a child
 * identity), ASR final/partial ingestion (digest-only), the client_abort →
 * fence-first interruption path, playback stop / TTS queue clear directives
 * and the epoch-fenced Opus frame send contract. Everything here is
 * synthetic and replayable; real audio and hardware remain R5 work.
 *
 * This directory must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

export {
  // Pinned protocol baseline + fail-closed device-edge parsers.
  GATEWAY_ABORT_REASONS,
  GATEWAY_DISCONNECT_REASONS,
  GATEWAY_LISTEN_MODES,
  GATEWAY_LISTEN_STATES,
  GATEWAY_MAX_ASR_FINAL_CHARS,
  GATEWAY_MAX_ASR_PARTIAL_CHARS,
  GATEWAY_REJECTION_CODES,
  GATEWAY_ACTIVATION_DIGEST_PATTERN,
  XIAOZHI_DEVICE_ID_PATTERN,
  XIAOZHI_GATEWAY_BASELINE,
  XIAOZHI_SESSION_ID_PATTERN,
  isGatewayRejectionCode,
  parseGatewayDeviceEvent,
  type GatewayAbortReason,
  type GatewayAudioParams,
  type GatewayDeviceDirective,
  type GatewayDeviceEvent,
  type GatewayDeviceEventKind,
  type GatewayDisconnectReason,
  type GatewayListenMode,
  type GatewayListenState,
  type GatewayPlaybackStopReason,
  type GatewayRejectionCode,
} from "./protocol.ts";

export {
  // Trusted device binding registry (guardian-issued, lease-per-device).
  createGatewayDeviceBindingRegistry,
  type GatewayBindingCode,
  type GatewayBindingRegistryOptions,
  type GatewayBindingResult,
  type GatewayConnectionLease,
  type GatewayDeviceBinding,
  type GatewayDeviceBindingRegistry,
  type GatewaySessionMapping,
} from "./binding.ts";

export {
  // The adapter service (device edge → trusted Core).
  GATEWAY_ADAPTER_VERSION,
  GATEWAY_FRAMES_PER_SENTENCE_DEFAULT,
  GATEWAY_MAX_AUDIT_ENTRIES,
  GATEWAY_SWEEP_BUDGET_MS_DEFAULT,
  createVoiceGatewayAdapter,
  gatewayContentDigest,
  type GatewayAuditEntry,
  type GatewayCorePort,
  type GatewayEventOutcome,
  type GatewayMappingSnapshotEntry,
  type GatewayMetricsSnapshot,
  type VoiceGatewayAdapter,
  type VoiceGatewayAdapterOptions,
} from "./gateway-adapter.ts";

export {
  // Deterministic synthetic device+server mock with fault injection.
  createMockXiaozhiGateway,
  type MockDeviceAppliedDirective,
  type MockGatewaySourceEvent,
  type MockXiaozhiGateway,
  type MockXiaozhiGatewayOptions,
} from "./mock-xiaozhi.ts";

export {
  // Named replayable fixtures + sanitized report contract.
  GATEWAY_FIXTURE_FAMILIES,
  GATEWAY_SYNTHETIC_SENTENCES,
  buildSanitizedReport,
  findReportContentLeaks,
  isGatewayFixtureFamily,
  type GatewayFixtureFamily,
  type GatewayFixtureScenarioReport,
  type GatewaySanitizedReport,
} from "./fixtures.ts";
