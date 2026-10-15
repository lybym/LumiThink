/**
 * R1-V2 Bridge agent port — the locked-`dsh-v0.2.0-rc.2` in-process agent
 * surface the Bridge consumes (issue #29 实现范围 2; docs/VOICE_RUNTIME.md
 * §1 fact table; docs/adr/0002-voice-runtime-bridge.md).
 *
 * The upstream facts this port mirrors (NOT re-implemented — the real
 * Cordis runtime is injected by the composition; the synthetic mock in
 * mock-cordis.ts stands in for tests):
 *
 * - `ctx.agents.create / resume` — the Bridge creates or resumes one
 *   AgentHandle per voice session and is its ONLY lifecycle owner;
 * - `agent.cancel({ kind: 'user' })` — true in-process cancellation that
 *   stops the running attempt at the source (the official TypeScript SDK
 *   has no such wire method — that absence is exactly why the Bridge
 *   exists);
 * - `agent.whenIdle()` — awaited BEFORE a new turn is dispatched onto the
 *   same agent;
 * - `handle.dispose()` — resource reclamation on session.close / worker
 *   isolation;
 * - `agent/assistant-stream` — transient live events (start / chunk /
 *   end) bound to (attemptId, stepId, index), DISTINCT from durable
 *   session events (assistant/message). Only chunk deltas may reach the
 *   Orchestrator; the durable message settles/audits.
 *
 * PRIVACY: stream events carry transient synthetic delta text in the
 * chunk carrier only. Nothing here is persisted; audit shapes elsewhere
 * in this directory are content-free by construction.
 *
 * This module must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

// ---------------------------------------------------------------------------
// Stream events (transient live) and durable session events
// ---------------------------------------------------------------------------

/** Stream channel of an upstream event: text is the only playable one. */
export type BridgeStreamChannel = "text" | "tool_call" | "thinking";

/**
 * One transient `agent/assistant-stream` event. `kind: "chunk"` events
 * carry the raw live delta; `kind: "start" | "end"` delimit one attempt.
 * Deltas from `tool_call`/`thinking` channels NEVER reach the playback
 * path (issue #29: 工具调用/思维内容不出现在播放文本).
 */
export type BridgeStreamEvent =
  | {
      readonly kind: "start";
      readonly attemptId: string;
      readonly stepId: string;
    }
  | {
      readonly kind: "chunk";
      readonly attemptId: string;
      readonly stepId: string;
      /** Monotonic within the attempt; gaps/permuted order are detectable. */
      readonly index: number;
      readonly channel: BridgeStreamChannel;
      readonly textDelta: string;
    }
  | {
      readonly kind: "end";
      readonly attemptId: string;
      readonly stepId: string;
    };

/**
 * One durable session/event record. It settles/audits an attempt; its
 * message body NEVER becomes playback and is never re-split into deltas
 * (issue #29 验收: live delta must come from upstream events, not from
 * splitting the final message).
 */
export interface BridgeDurableEvent {
  readonly event: "assistant/message";
  readonly attemptId: string;
  readonly messageId: string;
  /** Bounded marker only; the body never crosses the Bridge boundary. */
  readonly messageRef: string;
}

/** The cancel argument the Bridge always uses (issue #29 实现范围 2). */
export interface BridgeAgentCancelInput {
  readonly kind: "user";
}

export type BridgeAgentCancelResult =
  | { readonly ok: true; readonly attemptId: string | null }
  | { readonly ok: false; readonly code: "no_running_attempt" | "handle_not_idle_capable" };

/** One live agent handle owned exclusively by the Bridge. */
export interface BridgeAgentHandle {
  readonly sessionKey: string;
  /**
   * Start one attempt for a prompt. Returns the attempt id. `promptText` is
   * the authorized transient transcript (issue #51) — the ONLY channel by
   * which user text reaches the agent; implementations consume it for this
   * single attempt and must not persist, log or audit it.
   */
  runPrompt(input: { readonly turnId: string; readonly nonceFingerprint: string; readonly promptText?: string }): {
    readonly ok: true;
    readonly attemptId: string;
  };
  /** True in-process cancellation (upstream `agent.cancel`). */
  cancel(input: BridgeAgentCancelInput): BridgeAgentCancelResult;
  /** Resolves only once the agent is fully stopped. */
  whenIdle(): Promise<{ readonly ok: true; readonly attemptId: string | null }>;
  /** Reclaim the runtime resources of this handle. */
  dispose(): Promise<{ readonly ok: true }>;
  /** Subscribe to transient stream events (live). */
  onStream(listener: (event: BridgeStreamEvent) => void): { readonly ok: true };
  /** Subscribe to durable session events (settlement/audit only). */
  onDurable(listener: (event: BridgeDurableEvent) => void): { readonly ok: true };
  /** True while an attempt is running (no cancel has taken effect yet). */
  isRunning(): boolean;
}

export type BridgeAgentPortErrorCode =
  | "bridge_ownership_conflict"
  | "session_unknown"
  | "handle_disposed"
  | "worker_fault";

/** The agent lifecycle port the Bridge consumes (upstream Cordis surface). */
export interface BridgeAgentPort {
  /** `ctx.agents.create` analog — exactly one handle per session. */
  createAgent(sessionKey: string): { ok: true; handle: BridgeAgentHandle } | { ok: false; code: BridgeAgentPortErrorCode };
  /** `ctx.agents.resume` analog for an existing owned handle. */
  resumeAgent(sessionKey: string): { ok: true; handle: BridgeAgentHandle } | { ok: false; code: BridgeAgentPortErrorCode };
}
