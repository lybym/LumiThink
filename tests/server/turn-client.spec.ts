/**
 * R1-05 chat turn consumer tests (issue #17): the headless browser-side
 * protocol state machine (components/kid/chat/turn-client.ts) — consecutive
 * multi-turn messages, slow streaming, late chunks after stop, duplicate
 * submit lock, disconnect/retry recovery, seq-based replay dedupe and the
 * no-leak error mapping.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  chatReducer,
  chatErrorKindForStatus,
  initialChatState,
  makeClientRequestId,
  type ChatState,
} from "../../components/kid/chat/turn-client.ts";

const NOW = "2026-10-14T08:00:00.000Z";

let counter = 0;

/** Minimal VALID default payload per stream kind (contract parser rejects {}). */
function defaultPayload(kind: string): Record<string, unknown> {
  switch (kind) {
    case "stream.started":
      return { type: "started", acceptedAt: NOW };
    case "agent.delta":
      return { type: "delta", text: "" };
    case "turn.cancelled":
      return { type: "cancelled", by: "child" };
    case "stream.end":
      return { type: "end" };
    default:
      return { type: "unknown" };
  }
}

function streamEvent(
  overrides: Partial<Record<string, unknown>> & { readonly kind: string; readonly seq: number },
): {
  readonly type: "stream/event";
  readonly kind: string;
  readonly data: Record<string, unknown>;
} {
  counter += 1;
  const { kind, seq, ...rest } = overrides;
  return {
    type: "stream/event",
    kind,
    data: {
      protocolVersion: "1.0",
      seq,
      conversationId: "conv_it00000001",
      turnId: "trn_it00000001",
      traceId: "trc_it00000001",
      occurredAt: NOW,
      payload: defaultPayload(kind),
      ...rest,
    },
  };
}

function streamingState(): ChatState {
  // A state with an acked, streaming turn (as after send/requested + ack).
  let state = chatReducer(initialChatState(), {
    type: "send/requested",
    text: "[synthetic] 你好",
    requestId: "req_it00000001",
  });
  state = chatReducer(state, {
    type: "send/ack",
    raw: {
      protocolVersion: "1.0",
      requestId: "req_it00000001",
      conversationId: "conv_it00000001",
      turnId: "trn_it00000001",
      traceId: "trc_it00000001",
      status: "accepted",
      streamUrl: "/api/v1/interactions/trc_it00000001/events",
      cancelUrl: "/api/v1/interactions/trn_it00000001/cancel",
      acceptedAt: NOW,
    },
  });
  return state;
}

test("consecutive messages: user message commits at ack, assistant message at completed", () => {
  let state = streamingState();
  assert.equal(state.messages.length, 1, "the user message commits when the ack arrives");
  assert.equal(state.messages[0].role, "user");
  assert.equal(state.pending?.phase, "streaming");

  state = chatReducer(state, streamEvent({ kind: "stream.started", seq: 0 }));
  state = chatReducer(state, streamEvent({ kind: "agent.delta", seq: 1, payload: { type: "delta", text: "你好" } }));
  assert.equal(state.pending?.assistantText, "你好");

  state = chatReducer(state, {
    type: "stream/event",
    kind: "agent.completed",
    data: {
      protocolVersion: "1.0",
      seq: 2,
      conversationId: "conv_it00000001",
      turnId: "trn_it00000001",
      traceId: "trc_it00000001",
      occurredAt: NOW,
      payload: {
        type: "completed",
        response: {
          protocolVersion: "1.0",
          agentResponseId: "rsp_it00000001",
          conversationId: "conv_it00000001",
          turnId: "trn_it00000001",
          traceId: "trc_it00000001",
          status: "completed",
          content: { text: "我们一起想办法。", format: "plain" },
          completedAt: NOW,
        },
      },
    },
  });
  assert.equal(state.pending, null);
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[1].role, "assistant");
  assert.equal(state.messages[1].text, "我们一起想办法。");

  // The next message continues the same conversation (id retained).
  const second = chatReducer(state, {
    type: "send/requested",
    text: "[synthetic] 第二条",
    requestId: "req_it00000002",
  });
  assert.notEqual(second.pending, null);
  assert.equal(second.conversationId, "conv_it00000001");
});

test("slow streaming accumulates deltas in order while the in-progress state holds", () => {
  let state = streamingState();
  state = chatReducer(state, streamEvent({ kind: "stream.started", seq: 0 }));
  const chunks = ["今", "天", "我", "们", "一", "起"];
  chunks.forEach((chunk, index) => {
    state = chatReducer(state, streamEvent({ kind: "agent.delta", seq: index + 1, payload: { type: "delta", text: chunk } }));
    assert.equal(state.pending?.phase, "streaming", "in-progress state holds during the stream");
  });
  assert.equal(state.pending?.assistantText, chunks.join(""));
});

test("stop revokes consumption immediately: late chunks for the stopped turn are dropped", () => {
  let state = streamingState();
  state = chatReducer(state, streamEvent({ kind: "stream.started", seq: 0 }));
  state = chatReducer(state, streamEvent({ kind: "agent.delta", seq: 1, payload: { type: "delta", text: "前半" } }));
  assert.equal(state.pending?.assistantText, "前半");

  state = chatReducer(state, { type: "user/stop" });
  assert.equal(state.pending?.phase, "stopping");

  // Late chunks (still delivered by the transport) must NOT be rendered.
  state = chatReducer(state, streamEvent({ kind: "agent.delta", seq: 2, payload: { type: "delta", text: "迟到的后半" } }));
  assert.equal(state.pending?.assistantText, "前半", "late chunk dropped after stop");

  // The terminal frames still finalize the state (partial text is kept).
  state = chatReducer(state, streamEvent({ kind: "turn.cancelled", seq: 3, payload: { type: "cancelled", by: "child" } }));
  assert.equal(state.pending, null);
  assert.equal(state.messages.length, 2);
  assert.equal(state.messages[1].text, "前半");
});

test("duplicate submits are locked: only one turn may be in flight", () => {
  let state = streamingState();
  const locked = chatReducer(state, {
    type: "send/requested",
    text: "[synthetic] 连点第二条",
    requestId: "req_it00000003",
  });
  assert.equal(locked.pending?.requestId, "req_it00000001", "the in-flight turn is untouched");
  assert.equal(locked.messages.length, state.messages.length);

  // The lock releases only when the turn reaches a terminal state.
  state = chatReducer(state, streamEvent({ kind: "stream.end", seq: 9, payload: { type: "end" } }));
  assert.equal(state.pending, null);
  const after = chatReducer(state, {
    type: "send/requested",
    text: "[synthetic] 现在可以了",
    requestId: "req_it00000004",
  });
  assert.equal(after.pending?.requestId, "req_it00000004");
});

test("transport failure before the ack is retriable and keeps the text for retry (new requestId)", () => {
  let state = streamingState();
  state = chatReducer(initialChatState(), {
    type: "send/requested",
    text: "[synthetic] 会断网的一句话",
    requestId: "req_it00000010",
  });
  state = chatReducer(state, { type: "send/failed", failure: { kind: "network", retriable: true } });
  assert.equal(state.pending, null);
  assert.equal(state.error?.kind, "network");
  assert.equal(state.error?.retriable, true);
  assert.equal(state.error?.failedText, "[synthetic] 会断网的一句话");
  assert.equal(state.messages.length, 0, "an unacked message never enters the transcript");

  // Retry re-sends with a NEW requestId (a new turn; idempotent replay of a
  // lost response is handled by the server ledger, not by reusing ids).
  const retry = chatReducer(state, {
    type: "send/requested",
    text: state.error?.failedText ?? "",
    requestId: "req_it00000011",
  });
  assert.equal(retry.pending?.requestId, "req_it00000011");
  assert.equal(retry.error, null);
});

test("reconnect replay dedupes by seq: frames at or below lastSeq are ignored", () => {
  let state = streamingState();
  state = chatReducer(state, streamEvent({ kind: "stream.started", seq: 0 }));
  state = chatReducer(state, streamEvent({ kind: "agent.delta", seq: 1, payload: { type: "delta", text: "第一段" } }));

  // A reconnect replays seq 0 and 1; both must be deduped.
  state = chatReducer(state, streamEvent({ kind: "stream.started", seq: 0 }));
  state = chatReducer(state, streamEvent({ kind: "agent.delta", seq: 1, payload: { type: "delta", text: "第一段" } }));
  assert.equal(state.pending?.assistantText, "第一段", "replayed frames did not double-apply");

  // New frames continue normally.
  state = chatReducer(state, streamEvent({ kind: "agent.delta", seq: 2, payload: { type: "delta", text: "第二段" } }));
  assert.equal(state.pending?.assistantText, "第一段第二段");
});

test("rejected input maps to a non-retriable state without any server-provided strings", () => {
  let state = streamingState();
  state = chatReducer(state, {
    type: "stream/event",
    kind: "agent.completed",
    data: {
      protocolVersion: "1.0",
      seq: 0,
      conversationId: "conv_it00000001",
      turnId: "trn_it00000001",
      traceId: "trc_it00000001",
      occurredAt: NOW,
      payload: {
        type: "completed",
        response: {
          protocolVersion: "1.0",
          agentResponseId: "rsp_it00000002",
          conversationId: "conv_it00000001",
          turnId: "trn_it00000001",
          traceId: "trc_it00000001",
          status: "ignored",
          content: null,
          completedAt: NOW,
        },
      },
    },
  });
  assert.equal(state.pending, null);
  assert.equal(state.error?.kind, "rejected");
  assert.equal(state.error?.retriable, false);
  assert.equal(state.messages.length, 1, "the user message stays visible");
  const serialized = JSON.stringify(state.error);
  assert.ok(!serialized.includes("rule"), "no rule identifiers surface in the state");
  assert.ok(!serialized.includes("CONTRACT_"), "no internal error codes surface in the state");
});

test("error kind mapping covers auth, rejection, and retriable internal failures", () => {
  assert.equal(chatErrorKindForStatus(403), "auth");
  assert.equal(chatErrorKindForStatus(401), "auth");
  assert.equal(chatErrorKindForStatus(409), "rejected");
  assert.equal(chatErrorKindForStatus(413), "rejected");
  assert.equal(chatErrorKindForStatus(500), "internal");
  assert.equal(chatErrorKindForStatus(400), "invalid");

  let state = streamingState();
  state = chatReducer(state, { type: "send/failed", failure: { kind: "timeout", retriable: true } });
  assert.equal(state.error?.kind, "timeout");

  state = chatReducer(initialChatState(), {
    type: "send/requested",
    text: "[synthetic] 掉线的一句",
    requestId: "req_it00000020",
  });
  state = chatReducer(state, {
    type: "send/ack",
    raw: { broken: true },
  });
  assert.equal(state.error?.kind, "internal", "a malformed ack fails closed");
});

test("stream.error frames surface a retriable internal failure state", () => {
  let state = streamingState();
  state = chatReducer(state, streamEvent({ kind: "stream.started", seq: 0 }));
  state = chatReducer(state, {
    type: "stream/event",
    kind: "stream.error",
    data: {
      protocolVersion: "1.0",
      seq: 1,
      conversationId: "conv_it00000001",
      turnId: "trn_it00000001",
      traceId: "trc_it00000001",
      occurredAt: NOW,
      payload: {
        type: "error",
        error: {
          protocolVersion: "1.0",
          error: {
            code: "CONTRACT_INTERNAL",
            message: "Internal contract error.",
            retriable: true,
          },
          occurredAt: NOW,
        },
      },
    },
  });
  assert.equal(state.pending, null);
  assert.equal(state.error?.kind, "internal");
  assert.equal(state.error?.retriable, true);
});

test("clear resets the visible content and the conversation continuation", () => {
  let state = streamingState();
  state = chatReducer(state, streamEvent({ kind: "stream.started", seq: 0 }));
  state = chatReducer(state, streamEvent({ kind: "agent.delta", seq: 1, payload: { type: "delta", text: "内容" } }));
  state = chatReducer(state, {
    type: "stream/event",
    kind: "agent.completed",
    data: {
      protocolVersion: "1.0",
      seq: 2,
      conversationId: "conv_it00000001",
      turnId: "trn_it00000001",
      traceId: "trc_it00000001",
      occurredAt: NOW,
      payload: {
        type: "completed",
        response: {
          protocolVersion: "1.0",
          agentResponseId: "rsp_it00000003",
          conversationId: "conv_it00000001",
          turnId: "trn_it00000001",
          traceId: "trc_it00000001",
          status: "completed",
          content: { text: "完整回复。", format: "plain" },
          completedAt: NOW,
        },
      },
    },
  });
  assert.equal(state.messages.length, 2);

  // Clearing mid-turn is refused.
  const midTurn = chatReducer(state, {
    type: "send/requested",
    text: "[synthetic] 又一句",
    requestId: "req_it00000030",
  });
  const refused = chatReducer(midTurn, { type: "user/clear" });
  assert.notEqual(refused.pending, null, "clear never aborts an in-flight turn");

  // Idle clear resets everything, including the conversation id.
  const cleared = chatReducer(state, { type: "user/clear" });
  assert.deepEqual(cleared, initialChatState());
  assert.equal(cleared.conversationId, null, "the next message starts a fresh conversation");
});

test("makeClientRequestId produces contract-valid req_ ids", () => {
  const pattern = /^req_[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
  for (let index = 0; index < 50; index += 1) {
    assert.ok(pattern.test(makeClientRequestId()), makeClientRequestId());
  }
  // Deterministic fallback path (no crypto.randomUUID).
  const fallback = makeClientRequestId(() => 0.123456);
  assert.ok(pattern.test(fallback));
});
