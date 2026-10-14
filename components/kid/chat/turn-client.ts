/**
 * R1-05 web MVP — framework-free chat turn consumer (issue #17).
 *
 * The complete browser-side protocol state machine of the child chat UI,
 * pure and headless-testable (node:test): consecutive multi-turn messages,
 * streaming consumption with seq-based replay dedupe, IMMEDIATE output
 * consumption revocation on stop (late chunks for a stopped turn are
 * dropped even if the transport still delivers them — defense in depth on
 * top of the server-side cancel), duplicate-submit lock, error-recovery
 * states (network/timeout/rejected/auth/invalid/internal) and retry.
 *
 * Leak rule: the reducer NEVER renders server error envelopes (messages,
 * details or rule ids). Error states carry only an enumerated kind + a
 * retriable flag; the UI maps kinds to fixed, child-appropriate copy, so a
 * rejected/inappropriate input can never leak internal rules.
 *
 * This module must stay framework-free (no react/next imports).
 */

import {
  parseInteractionAck,
  type InteractionAck,
} from "../../../lib/domain/contract/idempotency.ts";
import {
  parseStreamEvent,
  type StreamEvent,
} from "../../../lib/domain/contract/response.ts";

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

export type ChatErrorKind =
  | "network"
  | "timeout"
  | "rejected"
  | "auth"
  | "invalid"
  | "internal";

export interface ChatErrorState {
  readonly kind: ChatErrorKind;
  readonly retriable: boolean;
  /** The text whose submission failed (retry re-sends it with a NEW id). */
  readonly failedText: string | null;
}

export interface ChatMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface ChatState {
  /** Finalized transcript (a user message appears once its ack arrived). */
  readonly messages: readonly ChatMessage[];
  /** Server-assigned conversation continuation (null → next send starts one). */
  readonly conversationId: string | null;
  readonly pending: {
    readonly requestId: string;
    readonly userText: string;
    readonly phase: "sending" | "streaming" | "stopping";
    readonly turnId: string | null;
    readonly traceId: string | null;
    /** Highest applied stream seq (replay/reconnect dedupe). */
    readonly lastSeq: number;
    readonly assistantText: string;
  } | null;
  readonly error: ChatErrorState | null;
}

export function initialChatState(): ChatState {
  return { messages: [], conversationId: null, pending: null, error: null };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type ChatAction =
  | { readonly type: "send/requested"; readonly text: string; readonly requestId: string }
  | { readonly type: "send/ack"; readonly raw: unknown }
  | { readonly type: "send/failed"; readonly failure: { readonly kind: ChatErrorKind; readonly retriable: boolean } }
  | { readonly type: "stream/event"; readonly kind: string; readonly data: unknown }
  | { readonly type: "stream/invalidFrame" }
  | { readonly type: "stream/transportError" }
  | { readonly type: "user/stop" }
  | { readonly type: "user/clear" };

/** Map an HTTP status of an ErrorEnvelope response to an error kind. */
export function chatErrorKindForStatus(status: number): ChatErrorKind {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 409 || status === 413) {
    return "rejected";
  }
  if (status >= 500) {
    return "internal";
  }
  return "invalid";
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function commitPendingAssistant(state: ChatState): ChatState {
  const pending = state.pending;
  if (pending === null || pending.assistantText.length === 0) {
    return state;
  }
  return {
    ...state,
    messages: [...state.messages, { role: "assistant", text: pending.assistantText }],
  };
}

function withFailure(state: ChatState, kind: ChatErrorKind, retriable: boolean): ChatState {
  const failedText = state.pending?.userText ?? null;
  return {
    ...state,
    pending: null,
    error: { kind, retriable, failedText },
  };
}

/**
 * Pure reducer of the chat turn consumer. Invariants (tested):
 * - at most one in-flight turn (duplicate submits are dropped);
 * - a user message enters the transcript only after its ack;
 * - deltas arriving for a stopping turn are dropped (consumption revoked);
 * - frames with seq ≤ lastSeq are dropped (reconnect replay dedupe);
 * - error states never carry server-provided strings.
 */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "send/requested": {
      // Duplicate-submit lock: a new turn may only start when idle.
      if (state.pending !== null) {
        return state;
      }
      const text = action.text;
      if (text.length === 0) {
        return state;
      }
      return {
        ...state,
        error: null,
        pending: {
          requestId: action.requestId,
          userText: text,
          phase: "sending",
          turnId: null,
          traceId: null,
          lastSeq: -1,
          assistantText: "",
        },
      };
    }

    case "send/ack": {
      if (state.pending === null || state.pending.phase !== "sending") {
        return state;
      }
      let ack: Readonly<InteractionAck>;
      try {
        ack = parseInteractionAck(action.raw);
      } catch {
        return withFailure(state, "internal", true);
      }
      // The ack must correspond to the in-flight request id.
      if (ack.requestId !== state.pending.requestId) {
        return withFailure(state, "internal", true);
      }
      return {
        ...state,
        conversationId: ack.conversationId,
        // The user message becomes part of the transcript only now: a
        // submission that never gets an ack stays retryable, never doubled.
        messages: [...state.messages, { role: "user", text: state.pending.userText }],
        pending: {
          ...state.pending,
          phase: "streaming",
          turnId: ack.turnId,
          traceId: ack.traceId,
        },
      };
    }

    case "send/failed": {
      if (state.pending === null) {
        return state;
      }
      return withFailure(state, action.failure.kind, action.failure.retriable);
    }

    case "stream/event": {
      const pending = state.pending;
      if (pending === null || (pending.phase !== "streaming" && pending.phase !== "stopping")) {
        return state;
      }
      let event: Readonly<StreamEvent>;
      try {
        event = parseStreamEvent({
          ...(action.data as Record<string, unknown>),
          kind: action.kind,
        });
      } catch {
        return withFailure(state, "invalid", false);
      }
      // Correlation guard: ignore frames of any other turn.
      if (pending.traceId !== null && event.traceId !== pending.traceId) {
        return state;
      }
      // Replay/reconnect dedupe: strictly increasing seq only.
      if (event.seq <= pending.lastSeq) {
        return state;
      }
      const nextPending = { ...pending, lastSeq: event.seq };
      const withPending: ChatState = { ...state, pending: nextPending };

      switch (event.kind) {
        case "stream.started": {
          return withPending;
        }
        case "agent.delta": {
          // Stop revokes output consumption immediately: a delta arriving
          // for a stopping turn is dropped (late chunk, never rendered).
          if (nextPending.phase === "stopping") {
            return withPending;
          }
          if (event.payload.type !== "delta") {
            return withFailure(state, "invalid", false);
          }
          return {
            ...withPending,
            pending: { ...nextPending, assistantText: nextPending.assistantText + event.payload.text },
          };
        }
        case "agent.completed": {
          if (event.payload.type !== "completed") {
            return withFailure(state, "invalid", false);
          }
          const response = event.payload.response;
          if (response.status === "completed") {
            if (response.content === null) {
              return withFailure(state, "internal", true);
            }
            return {
              ...withPending,
              messages: [...withPending.messages, { role: "assistant", text: response.content.text }],
              pending: null,
            };
          }
          if (response.status === "cancelled") {
            return { ...commitPendingAssistant(withPending), pending: null };
          }
          if (response.status === "ignored") {
            // Rejected/inappropriate input: fixed safe copy, no retry of
            // the same text, and NO server-provided strings are surfaced.
            return withFailure(state, "rejected", false);
          }
          // failed: the model call degraded; structured, retriable.
          return withFailure(state, "internal", true);
        }
        case "turn.cancelled": {
          return { ...commitPendingAssistant(withPending), pending: null };
        }
        case "stream.error": {
          return withFailure(state, "internal", true);
        }
        case "stream.end": {
          return { ...commitPendingAssistant(withPending), pending: null };
        }
        default: {
          return withFailure(state, "invalid", false);
        }
      }
    }

    case "stream/invalidFrame": {
      return withFailure(state, "invalid", false);
    }

    case "stream/transportError": {
      if (state.pending === null) {
        return state;
      }
      return withFailure(state, "network", true);
    }

    case "user/stop": {
      const pending = state.pending;
      if (pending === null || pending.phase !== "streaming") {
        return state;
      }
      // Immediate consumption revocation: the phase flips now; every later
      // delta for this turn is dropped by the reducer itself.
      return { ...state, pending: { ...pending, phase: "stopping" } };
    }

    case "user/clear": {
      if (state.pending !== null) {
        // Clearing is an idle-time action; never abort state mid-turn.
        return state;
      }
      // Clear the visible content AND the conversation continuation: the
      // next message starts a fresh server-side conversation.
      return initialChatState();
    }

    default: {
      return state;
    }
  }
}

// ---------------------------------------------------------------------------
// Client id material
// ---------------------------------------------------------------------------

/**
 * Client idempotency key (`req_…`, contract grammar). crypto.randomUUID is
 * used when available with a Math.random fallback (browser + node:test).
 */
export function makeClientRequestId(random: () => number = Math.random): string {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const raw =
    globalCrypto?.randomUUID !== undefined
      ? globalCrypto.randomUUID().replaceAll("-", "")
      : `${Date.now().toString(36)}${Math.floor(random() * Number.MAX_SAFE_INTEGER).toString(36)}`;
  return `req_${raw.slice(0, 32)}`;
}
