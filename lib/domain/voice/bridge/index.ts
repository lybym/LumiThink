/**
 * R1-V2 Cordis Runtime Bridge — public surface (issue #29;
 * docs/VOICE_RUNTIME.md; docs/adr/0002-voice-runtime-bridge.md).
 *
 * The Bridge is the EXCLUSIVE in-process owner of every voice session's
 * AgentHandle (lumi-dsh-runtime-bridge profile), serving the
 * session.open / turn.prompt / turn.cancel / turn.stream / session.close
 * command set over a private local IPC. Live deltas are transient,
 * attempt/step/index-bound and re-fenced Orchestrator-side; only
 * Output-Gate-approved sentences reach TTS. The R1-V1 Orchestrator
 * (`lib/domain/voice/index.ts`) remains the sole trust anchor for
 * turn/epoch fencing.
 *
 * This directory must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

export {
  // Profile (lumi-dsh-runtime-bridge).
  BRIDGE_ALLOWED_EGRESS_DESTINATIONS,
  BRIDGE_DSH_VERSION,
  BRIDGE_EGRESS_POLICY,
  BRIDGE_FORBIDDEN_PROFILE_IDS,
  BRIDGE_OWNERSHIP_MODE,
  BRIDGE_PRIVACY_SWITCHES,
  BRIDGE_PROFILE_ID,
  BRIDGE_SWITCH_OFF,
  assertBridgeAdvertisedToolsWithinWhitelist,
  canonicalBridgeProfile,
  describeBridgeProfileTools,
  validateBridgeProfile,
  type BridgeCordisProfile,
  type BridgePrivacySwitch,
} from "./profile.ts";

export {
  // IPC contract (commands/events/frames, fail-closed parsers).
  BRIDGE_COMMANDS,
  BRIDGE_EVENTS,
  BRIDGE_IPC_AUTH_PATTERN,
  BRIDGE_IPC_MAX_FRAME_CHARS,
  BRIDGE_IPC_MAX_FRAMES_PER_WINDOW,
  BRIDGE_IPC_PROTOCOL,
  BRIDGE_IPC_RATE_WINDOW_MS,
  BRIDGE_REJECTION_CODES,
  BRIDGE_RUNTIME_ERROR_CODES,
  parseAssistantDeltaPayload,
  parseAttemptEndedPayload,
  parseBridgeFrame,
  parseRuntimeErrorPayload,
  parseSessionClosedPayload,
  parseSessionClosePayload,
  parseSessionIdlePayload,
  parseSessionOpenPayload,
  parseTurnAcceptedPayload,
  parseTurnCancelPayload,
  parseTurnPromptPayload,
  parseTurnSettledPayload,
  parseTurnStreamPayload,
  type BridgeAssistantDeltaPayload,
  type BridgeCommandFrame,
  type BridgeCommandName,
  type BridgeEventFrame,
  type BridgeEventName,
  type BridgeFrame,
  type BridgeRejectionCode,
  type BridgeReplyFrame,
  type BridgeReplyRejectionFrame,
  type BridgeRuntimeErrorCode,
  type BridgeSessionClosePayload,
  type BridgeSessionOpenPayload,
  type BridgeTurnCancelPayload,
  type BridgeTurnPromptPayload,
  type BridgeTurnStreamPayload,
} from "./ipc-contract.ts";

export {
  // Agent port (locked upstream in-process surface).
  type BridgeAgentCancelInput,
  type BridgeAgentCancelResult,
  type BridgeAgentHandle,
  type BridgeAgentPort,
  type BridgeAgentPortErrorCode,
  type BridgeDurableEvent,
  type BridgeStreamChannel,
  type BridgeStreamEvent,
} from "./agent-port.ts";

export {
  // Synthetic deterministic runtime mock.
  createMockCordisRuntime,
  type MockCordisRuntime,
  type MockCordisRuntimeOptions,
  type MockGenerationFragment,
  type MockGenerationScript,
  type MockSourceEvent,
} from "./mock-cordis.ts";

export {
  // The Bridge service (exclusive AgentHandle owner).
  createVoiceBridge,
  VOICE_BRIDGE_VERSION,
  type BridgeAuditEntry,
  type BridgeMetricsSnapshot,
  type BridgeServiceResult,
  type BridgeSessionCloseResult,
  type BridgeSessionOpenResult,
  type BridgeTurnCancelResult,
  type BridgeTurnPromptResult,
  type BridgeTurnStreamResult,
  type VoiceBridgeOptions,
  type VoiceBridgeService,
} from "./bridge.ts";

export {
  // Orchestrator-side live delta handling (fence + sentence + Output Gate).
  BRIDGE_MAX_BUFFERED_CHARS,
  BRIDGE_MAX_SENTENCE_CHARS,
  createBridgeStreamGate,
  type BridgeStreamGate,
  type BridgeStreamGateOptions,
  type StreamGateDeltaResult,
  type StreamGateFlushResult,
  type StreamGateMetrics,
  type StreamGateRejectCode,
} from "./stream-gate.ts";
