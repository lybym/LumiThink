/**
 * R1-01 mock request/response fixtures of the versioned interaction
 * contract (docs/API_CONTRACT.md §9; issue #13: "提供 Mock 请求/响应
 * fixtures；通过合成数据验证多轮与客户端升级兼容").
 *
 * EVERY value here is synthetic: child references are the documented demo
 * child (`chd_demo_001`), texts are clearly marked synthetic strings. No
 * real child data, recordings, credentials or vendor session ids may ever
 * be added to this file (issue #13 merge requirements).
 *
 * Fixture ids are deterministic so tests are reproducible.
 *
 * This module must stay dependency-free (no prisma, no react, no next).
 */

import type { ActorContext, SessionRef } from "./actor.ts";
import type { InteractionRequest, InteractionEvent } from "./interaction.ts";
import type { AgentResponse, StreamEvent, TurnCancelRequest, TurnCancelResult } from "./response.ts";
import type { ErrorEnvelope } from "./errors.ts";
import type { InteractionAck } from "./idempotency.ts";

/** The synthetic demo child used across all R1 fixtures and tests. */
export const SYNTHETIC_CHILD_REF = "chd_demo_001" as const;

// ---------------------------------------------------------------------------
// Synthetic server-verified actors (what the server injects after check)
// ---------------------------------------------------------------------------

export const syntheticChildActor: Readonly<ActorContext> = Object.freeze({
  role: "child",
  actorId: "act_demo_child_0001",
  childRef: SYNTHETIC_CHILD_REF,
  verifiedBy: "demo-guardian-session",
  verifiedAt: "2026-10-13T10:00:00.000Z",
});

export const syntheticGuardianActor: Readonly<ActorContext> = Object.freeze({
  role: "guardian",
  actorId: "act_demo_guardian_0001",
  childRef: SYNTHETIC_CHILD_REF,
  verifiedBy: "demo-guardian-session",
  verifiedAt: "2026-10-13T10:00:00.000Z",
});

export const syntheticSystemActor: Readonly<ActorContext> = Object.freeze({
  role: "system",
  actorId: "act_demo_system_0001",
  childRef: null,
  verifiedBy: "internal-pipeline",
  verifiedAt: "2026-10-13T10:00:00.000Z",
});

export const syntheticVoiceDeviceActor: Readonly<ActorContext> = Object.freeze({
  role: "voice_device",
  actorId: "act_demo_device_0001",
  childRef: SYNTHETIC_CHILD_REF,
  verifiedBy: "voice-adapter-device-binding",
  verifiedAt: "2026-10-13T10:00:00.000Z",
});

export const syntheticSessionRef: Readonly<SessionRef> = Object.freeze({
  sessionId: "ses_demo_session_0001",
  conversationId: "conv_demo_conversation_0001",
  actorId: syntheticChildActor.actorId,
  role: syntheticChildActor.role,
  createdAt: "2026-10-13T10:00:01.000Z",
});

// ---------------------------------------------------------------------------
// Synthetic requests (Web + Voice Adapter, multi-turn)
// ---------------------------------------------------------------------------

const SYNTHETIC_TEXT_TURN_1 = "[synthetic] 我今天的数学作业好难，不想开始。";
const SYNTHETIC_TEXT_TURN_2 = "[synthetic] 还是不会做第一题，可以陪我看看吗？";

/** Web client, turn 1 — starts a new conversation (no conversationId). */
export const webTextInteractionRequestTurn1: Readonly<InteractionRequest> = Object.freeze({
  protocolVersion: "1.0",
  interaction: Object.freeze({
    kind: "text" as const,
    clientRequestId: "req_fixture_web_t1_0001",
    text: Object.freeze({ content: SYNTHETIC_TEXT_TURN_1, format: "plain" as const }),
    clientContext: Object.freeze({ client: "web" as const, clientVersion: "2.0.0-web" }),
  }),
});

/** Voice Adapter client, same domain content as the web turn 1 fixture. */
export const voiceAdapterTextInteractionRequestTurn1: Readonly<InteractionRequest> = Object.freeze({
  protocolVersion: "1.0",
  interaction: Object.freeze({
    kind: "text" as const,
    clientRequestId: "req_fixture_voice_t1_01",
    text: Object.freeze({ content: SYNTHETIC_TEXT_TURN_1, format: "plain" as const }),
    clientContext: Object.freeze({ client: "voice_adapter" as const, clientVersion: "0.1.0-adapter" }),
  }),
});

/** Web client, turn 2 — continues the conversation (same conversationId). */
export const webTextInteractionRequestTurn2: Readonly<InteractionRequest> = Object.freeze({
  protocolVersion: "1.0",
  interaction: Object.freeze({
    kind: "text" as const,
    clientRequestId: "req_fixture_web_t2_0001",
    conversationId: "conv_demo_conversation_0001",
    text: Object.freeze({ content: SYNTHETIC_TEXT_TURN_2, format: "plain" as const }),
    clientContext: Object.freeze({ client: "web" as const, clientVersion: "2.1.0-web-upgraded" }),
  }),
});

// ---------------------------------------------------------------------------
// Synthetic server-side normalization results
// ---------------------------------------------------------------------------

export const syntheticInteractionEventTurn1: Readonly<InteractionEvent> = Object.freeze({
  protocolVersion: "1.0",
  eventId: "evt_fixture_event_t1_001",
  kind: "text",
  conversationId: "conv_demo_conversation_0001",
  turnId: "trn_fixture_turn_t1_0001",
  requestId: "req_fixture_web_t1_0001",
  traceId: "trc_fixture_trace_t1_001",
  actor: syntheticChildActor,
  ingress: "web",
  text: Object.freeze({
    content: SYNTHETIC_TEXT_TURN_1,
    format: "plain" as const,
    charCount: [...SYNTHETIC_TEXT_TURN_1].length,
  }),
  occurredAt: "2026-10-13T10:00:02.000Z",
});

export const syntheticInteractionEventTurn2: Readonly<InteractionEvent> = Object.freeze({
  protocolVersion: "1.0",
  eventId: "evt_fixture_event_t2_001",
  kind: "text",
  conversationId: "conv_demo_conversation_0001",
  turnId: "trn_fixture_turn_t2_0001",
  requestId: "req_fixture_web_t2_0001",
  traceId: "trc_fixture_trace_t2_001",
  actor: syntheticChildActor,
  ingress: "web",
  text: Object.freeze({
    content: SYNTHETIC_TEXT_TURN_2,
    format: "plain" as const,
    charCount: [...SYNTHETIC_TEXT_TURN_2].length,
  }),
  occurredAt: "2026-10-13T10:01:00.000Z",
});

// ---------------------------------------------------------------------------
// Synthetic acks
// ---------------------------------------------------------------------------

export const syntheticInteractionAckTurn1: Readonly<InteractionAck> = Object.freeze({
  protocolVersion: "1.0",
  requestId: "req_fixture_web_t1_0001",
  conversationId: "conv_demo_conversation_0001",
  turnId: "trn_fixture_turn_t1_0001",
  traceId: "trc_fixture_trace_t1_001",
  status: "accepted",
  streamUrl: "/api/v1/interactions/trc_fixture_trace_t1_001/events",
  cancelUrl: "/api/v1/interactions/trn_fixture_turn_t1_0001/cancel",
  acceptedAt: "2026-10-13T10:00:02.000Z",
});

export const syntheticDuplicateAckTurn1: Readonly<InteractionAck> = Object.freeze({
  ...syntheticInteractionAckTurn1,
  status: "duplicate",
  acceptedAt: "2026-10-13T10:00:05.000Z",
});

// ---------------------------------------------------------------------------
// Synthetic agent responses
// ---------------------------------------------------------------------------

export const syntheticAgentResponseCompleted: Readonly<AgentResponse> = Object.freeze({
  protocolVersion: "1.0",
  agentResponseId: "rsp_fixture_resp_t1_001",
  conversationId: "conv_demo_conversation_0001",
  turnId: "trn_fixture_turn_t1_0001",
  traceId: "trc_fixture_trace_t1_001",
  status: "completed",
  content: Object.freeze({
    text: "[synthetic] 没关系，我们一起把第一题拆成很小的一步，先只看题目问什么，好吗？",
    format: "plain" as const,
  }),
  completedAt: "2026-10-13T10:00:06.000Z",
});

/** What a late result looks like after its turn was cancelled. */
export const syntheticAgentResponseIgnored: Readonly<AgentResponse> = Object.freeze({
  protocolVersion: "1.0",
  agentResponseId: "rsp_fixture_resp_t1_001",
  conversationId: "conv_demo_conversation_0001",
  turnId: "trn_fixture_turn_t1_0001",
  traceId: "trc_fixture_trace_t1_001",
  status: "ignored",
  content: null,
  completedAt: "2026-10-13T10:00:07.000Z",
});

// ---------------------------------------------------------------------------
// Synthetic SSE stream events (full coherent stream of turn 1)
// ---------------------------------------------------------------------------

const STREAM_IDS = Object.freeze({
  conversationId: "conv_demo_conversation_0001",
  turnId: "trn_fixture_turn_t1_0001",
  traceId: "trc_fixture_trace_t1_001",
});

export const syntheticStreamEventsTurn1: readonly Readonly<StreamEvent>[] = Object.freeze([
  Object.freeze({
    protocolVersion: "1.0",
    kind: "stream.started",
    seq: 0,
    ...STREAM_IDS,
    occurredAt: "2026-10-13T10:00:02.000Z",
    payload: Object.freeze({ type: "started", acceptedAt: "2026-10-13T10:00:02.000Z" }),
  }),
  Object.freeze({
    protocolVersion: "1.0",
    kind: "agent.delta",
    seq: 1,
    ...STREAM_IDS,
    occurredAt: "2026-10-13T10:00:03.000Z",
    payload: Object.freeze({ type: "delta", text: "[synthetic] 没关系，我们一起" }),
  }),
  Object.freeze({
    protocolVersion: "1.0",
    kind: "agent.delta",
    seq: 2,
    ...STREAM_IDS,
    occurredAt: "2026-10-13T10:00:04.000Z",
    payload: Object.freeze({ type: "delta", text: "把第一题拆成很小的一步，好吗？" }),
  }),
  Object.freeze({
    protocolVersion: "1.0",
    kind: "agent.completed",
    seq: 3,
    ...STREAM_IDS,
    occurredAt: "2026-10-13T10:00:06.000Z",
    payload: Object.freeze({ type: "completed", response: syntheticAgentResponseCompleted }),
  }),
  Object.freeze({
    protocolVersion: "1.0",
    kind: "stream.end",
    seq: 4,
    ...STREAM_IDS,
    occurredAt: "2026-10-13T10:00:06.000Z",
    payload: Object.freeze({ type: "end" }),
  }),
]);

// ---------------------------------------------------------------------------
// Synthetic cancel contract payloads
// ---------------------------------------------------------------------------

export const syntheticTurnCancelRequest: Readonly<TurnCancelRequest> = Object.freeze({
  protocolVersion: "1.0",
  turnId: "trn_fixture_turn_t2_0001",
  conversationId: "conv_demo_conversation_0001",
  reason: "user_stop",
});

export const syntheticTurnCancelResult: Readonly<TurnCancelResult> = Object.freeze({
  protocolVersion: "1.0",
  turnId: "trn_fixture_turn_t2_0001",
  conversationId: "conv_demo_conversation_0001",
  status: "cancelled",
  resolvedAt: "2026-10-13T10:01:10.000Z",
});

// ---------------------------------------------------------------------------
// Synthetic error envelopes
// ---------------------------------------------------------------------------

export const syntheticErrorEnvelopeTextTooLong: Readonly<ErrorEnvelope> = Object.freeze({
  protocolVersion: "1.0",
  error: Object.freeze({
    code: "CONTRACT_TEXT_TOO_LONG",
    message: "The submitted text exceeds the contract length limit.",
    retriable: false,
    details: Object.freeze({ field: "interaction.text.content", limit: 4000, problemCount: 1 }),
    requestId: "req_fixture_web_t1_0001",
  }),
  occurredAt: "2026-10-13T10:00:02.000Z",
});

export const syntheticErrorEnvelopeUnknownVersion: Readonly<ErrorEnvelope> = Object.freeze({
  protocolVersion: "1.0",
  error: Object.freeze({
    code: "CONTRACT_UNKNOWN_VERSION",
    message: "The submitted protocol version is not supported.",
    retriable: false,
    details: Object.freeze({ field: "protocolVersion", problemCount: 1 }),
  }),
  occurredAt: "2026-10-13T10:00:02.000Z",
});
