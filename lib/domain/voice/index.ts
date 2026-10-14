/**
 * R1-V1 Voice Turn Orchestrator + epoch fencing — public surface
 * (issue #28; docs/VOICE_RUNTIME.md; docs/adr/0002-voice-runtime-bridge.md).
 *
 * The voice runtime is INDEPENDENT of any device and of DSH: it owns the
 * per-session monotonic epoch, the turn state machine and every downstream
 * fence (text delta, TTS queue, audio send, candidate memory, domain
 * writes). The Cordis Bridge (R1-V2) will consume this surface through the
 * IPC contract; the text pipeline stays untouched.
 *
 * This module must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

export {
  // State machine contract.
  isLegalVoiceTurnTransition,
  isVoiceTurnState,
  VOICE_AUDIT_ACTIONS,
  VOICE_AUDIT_FIELDS,
  VOICE_CANCEL_REASONS,
  VOICE_OUTPUT_KINDS,
  VOICE_REJECTION_CODES,
  VOICE_SETTLE_OUTCOMES,
  VOICE_TERMINAL_TURN_STATES,
  VOICE_TURN_STATES,
  VOICE_TURN_TRANSITIONS,
  VOICE_WRITE_KINDS,
  // Id/digest grammars.
  VOICE_FINGERPRINT_PATTERN,
  VOICE_IDEMPOTENCY_KEY_PATTERN,
  isVoiceFingerprint,
  isVoiceIdempotencyKey,
  isValidVoiceEpoch,
  // Shapes.
  type VoiceAuditAction,
  type VoiceAuditEntry,
  type VoiceAuditResultCode,
  type VoiceCancelReason,
  type VoiceOutputKind,
  type VoiceSessionRecord,
  type VoiceSettleOutcome,
  type VoiceTerminalTurnState,
  type VoiceTtsQueueItem,
  type VoiceTurnState,
  type VoiceTurnRecord,
  type VoiceWriteKind,
} from "./schema.ts";

export {
  createInMemoryVoiceFenceStore,
  VoiceRejection,
  VOICE_FENCE_STORE_FORMAT,
  VOICE_MAX_TTS_QUEUE_ITEMS,
  type InMemoryVoiceFenceStoreOptions,
  type VoiceCancelTurnResult,
  type VoiceDrainTtsResult,
  type VoiceFenceOutputResult,
  type VoiceFenceStore,
  type VoiceFenceWriteResult,
  type VoiceOpenSessionResult,
  type VoicePumpResult,
  type VoiceRegisterPromptResult,
  type VoiceSettleResult,
  type VoiceStoreRejectionCode,
  type VoiceSweepTimeoutsResult,
} from "./store.ts";

export {
  createVoiceTurnOrchestrator,
  MAX_VOICE_AUDIT_ENTRIES,
  VOICE_ORCHESTRATOR_VERSION,
  type VoicePromptOutcome,
  type VoiceTurnOrchestrator,
  type VoiceTurnOrchestratorOptions,
  type VoiceTurnSettleResult,
} from "./orchestrator.ts";
