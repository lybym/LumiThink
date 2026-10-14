"use client";

/**
 * R1-05 minimal web children's client (issue #17) — the Lumi conversation
 * surface, rebuilt on the formal interaction API (contract v1.0):
 *
 * - AI identity is always visible (child must know they talk to an AI —
 *   PRD §3 role table);
 * - text input, streaming reply, in-progress state, stop current turn,
 *   retry, and clear-current-content (Roadmap R1-05);
 * - touch + keyboard/mouse operable (Enter sends, Shift+Enter newline,
 *   real buttons ≥ 44px targets, labelled controls, aria-live transcript);
 * - clear duplicate-submit prevention (control disabling + reducer lock +
 *   server-side idempotency), distinct error states for network drop,
 *   timeout, cancellation, auth failure — never rendering server error
 *   envelopes (no internal-rule leakage);
 * - visible child exit path (back home / playground).
 *
 * All protocol logic lives in the headless turn-client reducer; this file
 * only wires DOM events (fetch/EventSource) to dispatched actions.
 */

import Link from "next/link";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { STREAM_EVENT_KINDS } from "@/lib/domain/contract";
import {
  chatErrorKindForStatus,
  chatReducer,
  initialChatState,
  makeClientRequestId,
  type ChatErrorKind,
} from "./turn-client";

const SUBMIT_TIMEOUT_MS = 15_000;

/** Fixed, child-appropriate copy per error kind. Never server-provided. */
function errorCopy(kind: ChatErrorKind): string {
  switch (kind) {
    case "network":
      return "连接断开了。再试一次吧。";
    case "timeout":
      return "等了有点久，试试再发一次。";
    case "rejected":
      return "这条消息我不能回复。可以换个说法，或者告诉信任的大人。";
    case "auth":
      return "身份校验没有通过，请刷新页面再试。";
    case "invalid":
      return "这条消息没有通过检查，换个说法试试。";
    case "internal":
      return "Lumi 现在遇到一点问题，稍后再试一次。";
  }
}

export function LumiChat() {
  const [state, dispatch] = useReducer(chatReducer, undefined, initialChatState);
  const [draft, setDraft] = useState("");
  const eventsRef = useRef<EventSource | null>(null);

  const pending = state.pending;
  const busy = pending !== null;
  const streaming = pending?.phase === "streaming";
  const stopping = pending?.phase === "stopping";

  // Close the SSE subscription whenever the turn reached a terminal state.
  useEffect(() => {
    if (state.pending === null && eventsRef.current !== null) {
      eventsRef.current.close();
      eventsRef.current = null;
    }
  }, [state.pending]);

  // Unsubscribe on unmount.
  useEffect(() => {
    return () => {
      eventsRef.current?.close();
      eventsRef.current = null;
    };
  }, []);

  const openEvents = useCallback((streamUrl: string) => {
    eventsRef.current?.close();
    const source = new EventSource(streamUrl);
    eventsRef.current = source;
    const onFrame = (kind: string) => (event: MessageEvent<string>) => {
      let data: unknown;
      try {
        data = JSON.parse(event.data) as unknown;
      } catch {
        dispatch({ type: "stream/invalidFrame" });
        return;
      }
      dispatch({ type: "stream/event", kind, data });
    };
    for (const kind of STREAM_EVENT_KINDS) {
      source.addEventListener(kind, onFrame(kind));
    }
    source.onerror = () => {
      // EventSource auto-reconnects (Last-Event-ID); the reducer dedupes by
      // seq. A permanently closed connection surfaces as a network error.
      if (source.readyState === EventSource.CLOSED) {
        dispatch({ type: "stream/transportError" });
      }
    };
  }, []);

  const sendText = useCallback(
    async (text: string) => {
      if (state.pending !== null) {
        return; // duplicate-submit lock (belt) — the reducer enforces it too (braces)
      }
      const requestId = makeClientRequestId();
      dispatch({ type: "send/requested", text, requestId });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
      let response: Response | null = null;
      try {
        response = await fetch("/api/v1/interactions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            protocolVersion: "1.0",
            interaction: {
              kind: "text",
              clientRequestId: requestId,
              ...(state.conversationId !== null ? { conversationId: state.conversationId } : {}),
              text: { content: text, format: "plain" },
              clientContext: { client: "web", clientVersion: "2.0.0-web" },
            },
          }),
          signal: controller.signal,
        });
      } catch {
        clearTimeout(timer);
        dispatch({
          type: "send/failed",
          failure: controller.signal.aborted
            ? { kind: "timeout", retriable: true }
            : { kind: "network", retriable: true },
        });
        return;
      }
      clearTimeout(timer);
      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        dispatch({ type: "send/failed", failure: { kind: "invalid", retriable: false } });
        return;
      }
      if (!response.ok) {
        dispatch({
          type: "send/failed",
          failure: {
            kind: chatErrorKindForStatus(response.status),
            retriable: response.status >= 500,
          },
        });
        return;
      }
      dispatch({ type: "send/ack", raw });
      if (raw !== null && typeof raw === "object" && typeof (raw as { streamUrl?: unknown }).streamUrl === "string") {
        openEvents((raw as { streamUrl: string }).streamUrl);
      }
    },
    [openEvents, state.conversationId, state.pending],
  );

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0 || state.pending !== null) {
      return;
    }
    setDraft("");
    void sendText(text);
  }, [draft, sendText, state.pending]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleStop = useCallback(() => {
    const current = state.pending;
    if (current === null || current.turnId === null || current.phase !== "streaming") {
      return;
    }
    // 1. Revoke output consumption IMMEDIATELY (reducer drops late chunks).
    dispatch({ type: "user/stop" });
    // 2. Cancel on the server (gateway caller-cancellation + fragment stop).
    // The EventSource stays open: the server finishes the stream with
    // turn.cancelled + stream.end; late deltas stay suppressed.
    void fetch(`/api/v1/interactions/${encodeURIComponent(current.turnId)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocolVersion: "1.0",
        turnId: current.turnId,
        conversationId: state.conversationId,
        reason: "user_stop",
      }),
    }).catch(() => undefined);
  }, [state.conversationId, state.pending]);

  const handleRetry = useCallback(() => {
    const error = state.error;
    if (error === null || !error.retriable || error.failedText === null || state.pending !== null) {
      return;
    }
    void sendText(error.failedText);
  }, [sendText, state.error, state.pending]);

  const handleClear = useCallback(() => {
    if (state.pending === null) {
      dispatch({ type: "user/clear" });
    }
  }, [state.pending]);

  const liveText = pending?.assistantText ?? "";

  return (
    <section
      aria-label="Lumi 对话"
      className="mx-auto flex h-[calc(100dvh-8rem)] w-full max-w-2xl flex-col rounded-3xl bg-white shadow-sm ring-1 ring-slate-200 sm:h-[36rem]"
    >
      <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <p className="truncate text-base font-bold text-indigo-700">Lumi</p>
          <p className="truncate text-xs text-slate-500">AI 学习伙伴 · 不是真人</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/kid/playground"
            className="rounded-full bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-200"
          >
            数学游乐场
          </Link>
          <Link
            href="/"
            className="rounded-full bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-600 hover:bg-indigo-100"
          >
            退出
          </Link>
        </div>
      </header>

      <div
        aria-live="polite"
        aria-busy={streaming === true}
        className="flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:px-6"
      >
        {state.messages.length === 0 && pending === null ? (
          <p className="mt-8 text-center text-sm text-slate-400">
            和 Lumi 说说话吧：聊心事，或者问学习中遇到的难题。
          </p>
        ) : null}
        {state.messages.map((message, index) => (
          <div
            key={index}
            className={
              message.role === "user"
                ? "ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 px-4 py-2 text-sm leading-relaxed text-white"
                : "mr-auto max-w-[85%] rounded-2xl rounded-bl-sm bg-slate-100 px-4 py-2 text-sm leading-relaxed text-slate-800"
            }
          >
            <span className="sr-only">{message.role === "user" ? "我：" : "Lumi："}</span>
            {message.text}
          </div>
        ))}
        {pending !== null ? (
          <div className="mr-auto max-w-[85%] rounded-2xl rounded-bl-sm bg-slate-100 px-4 py-2 text-sm leading-relaxed text-slate-800">
            {liveText.length > 0 ? (
              <span>
                {liveText}
                {streaming === true ? (
                  <span aria-hidden="true" className="ml-0.5 animate-pulse">
                    ▍
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-slate-400">
                {pending.phase === "sending" ? "正在发送…" : "Lumi 正在想…"}
              </span>
            )}
          </div>
        ) : null}
        {state.error !== null ? (
          <div
            role="alert"
            className="mr-auto max-w-[85%] rounded-2xl bg-amber-50 px-4 py-2 text-sm text-amber-800"
          >
            <p>{errorCopy(state.error.kind)}</p>
            {state.error.retriable ? (
              <button
                type="button"
                onClick={handleRetry}
                className="mt-2 min-h-11 rounded-full bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700"
              >
                再试一次
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="border-t border-slate-100 px-4 py-3 sm:px-6">
        <div className="flex items-end gap-2">
          <label htmlFor="lumi-input" className="sr-only">
            给 Lumi 发消息
          </label>
          <textarea
            id="lumi-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            maxLength={4000}
            disabled={busy}
            placeholder="说点什么吧…（Enter 发送）"
            className="min-h-11 flex-1 resize-none rounded-2xl border border-slate-200 px-4 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none disabled:bg-slate-50 disabled:text-slate-400"
          />
          {streaming || stopping ? (
            <button
              type="button"
              onClick={handleStop}
              disabled={stopping}
              aria-label="停止本轮回复"
              className="min-h-11 shrink-0 rounded-full bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-50"
            >
              {stopping ? "已停止" : "停止"}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={busy || draft.trim().length === 0}
              aria-label="发送"
              className="min-h-11 shrink-0 rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              发送
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between">
          <button
            type="button"
            onClick={handleClear}
            disabled={busy || (state.messages.length === 0 && state.error === null)}
            className="min-h-11 rounded-full px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-100 disabled:opacity-40"
          >
            清空当前内容
          </button>
          <p className="text-[11px] text-slate-400">遇到不舒服的话题？告诉信任的大人。</p>
        </div>
      </div>
    </section>
  );
}
