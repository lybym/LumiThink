/**
 * R1-V2 synthetic Cordis runtime mock — the deterministic, replayable
 * stand-in for the locked upstream runtime (issue #29 验收: 合成 Mock
 * 实测; 非目标: 不做实机音频/不接入真实模型).
 *
 * What it deliberately mirrors of `dsh-v0.2.0-rc.2` process semantics:
 * - `ctx.agents.create/resume` with EXCLUSIVE ownership: a second create
 *   for a live session is refused (the side-channel creation the issue
 *   forbids is structurally impossible through this surface);
 * - one attempt per prompt; transient `agent/assistant-stream` events
 *   (start → chunk* → end) built from the injected script; the durable
 *   `assistant/message` is dispatched ONLY after the stream end (never
 *   before, never as deltas);
 * - `cancel({ kind: 'user' })` stops the attempt AT THE SOURCE: the
 *   pending queues are dropped, no further event is ever emitted, and
 *   `whenIdle()` reports the agent stopped;
 * - `dispose()` and fault injection (`crashNow`) for worker isolation
 *   and recovery tests.
 *
 * Determinism: dispatch is driven by explicit `pump()`/`pumpAll()` calls
 * — no timers, no randomness. The per-turn generation script is
 * injected; every run with the same script produces the same source log,
 * which the race tests replay against.
 *
 * PRIVACY: the only text here is the injected synthetic script (tests
 * use child-safe synthetic samples). Deltas live only in transient
 * events; the durable message body never crosses the Bridge boundary.
 *
 * This module must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import type {
  BridgeAgentCancelInput,
  BridgeAgentCancelResult,
  BridgeAgentHandle,
  BridgeAgentPort,
  BridgeAgentPortErrorCode,
  BridgeDurableEvent,
  BridgeStreamEvent,
} from "./agent-port.ts";

/** One generation fragment of the injected synthetic script. */
export interface MockGenerationFragment {
  readonly channel: "text" | "tool_call" | "thinking";
  readonly text: string;
}

/** The script for one turn: fragments streamed in order. */
export type MockGenerationScript = readonly MockGenerationFragment[];

/** A dispatched upstream event stamped with its source sequence. */
export interface MockSourceEvent {
  readonly sourceSeq: number;
  readonly sessionKey: string;
  readonly event: BridgeStreamEvent | BridgeDurableEvent;
}

export interface MockCordisRuntimeOptions {
  /**
   * The deterministic generation script for one (sessionKey, turnId).
   * Tests inject synthetic, child-safe samples only.
   */
  readonly scriptFor: (sessionKey: string, turnId: string) => MockGenerationScript;
}

interface MockHandleState {
  readonly sessionKey: string;
  disposed: boolean;
  crashed: boolean;
  attemptId: string | null;
  turnId: string | null;
  pending: BridgeStreamEvent[];
  pendingDurable: BridgeDurableEvent[];
  streamListeners: ((event: BridgeStreamEvent) => void)[];
  durableListeners: ((event: BridgeDurableEvent) => void)[];
  cancelCallCount: number;
  whenIdleCount: number;
  attemptCounter: number;
}

function createHandleState(sessionKey: string): MockHandleState {
  return {
    sessionKey,
    disposed: false,
    crashed: false,
    attemptId: null,
    turnId: null,
    pending: [],
    pendingDurable: [],
    streamListeners: [],
    durableListeners: [],
    cancelCallCount: 0,
    whenIdleCount: 0,
    attemptCounter: 0,
  };
}

function isRunning(state: MockHandleState): boolean {
  return state.attemptId !== null && !state.crashed && !state.disposed;
}

/**
 * Build the upstream-shaped handle. The Bridge consumes it exactly like a
 * real `AgentHandle` — the mock adds no extra cancel/stream semantics.
 */
function createMockHandle(
  state: MockHandleState,
  scriptFor: (sessionKey: string, turnId: string) => MockGenerationScript,
): BridgeAgentHandle {
  const handle: BridgeAgentHandle = {
    sessionKey: state.sessionKey,
    runPrompt(input) {
      if (state.disposed) {
        throw new Error("handle_disposed");
      }
      if (state.crashed) {
        throw new Error("worker_fault");
      }
      if (state.attemptId !== null) {
        throw new Error("bridge_turn_conflict");
      }
      state.attemptCounter += 1;
      const attemptId = `att_${state.sessionKey.slice(4)}_${state.attemptCounter.toString().padStart(4, "0")}`;
      const stepId = `step_${attemptId.slice(4)}`;
      state.attemptId = attemptId;
      state.turnId = input.turnId;
      state.pending = [
        { kind: "start", attemptId, stepId },
        ...scriptFor(state.sessionKey, input.turnId).map((fragment, index) => ({
          kind: "chunk" as const,
          attemptId,
          stepId,
          index,
          channel: fragment.channel,
          textDelta: fragment.text,
        })),
        { kind: "end", attemptId, stepId },
      ];
      // The durable settlement ONLY arrives after the stream end (pump
      // gates it behind an empty transient queue — never mid-stream).
      state.pendingDurable = [
        {
          event: "assistant/message",
          attemptId,
          messageId: `msg_${attemptId.slice(4)}`,
          messageRef: `ref_${attemptId.slice(4)}`,
        },
      ];
      return { ok: true, attemptId };
    },
    cancel(input: BridgeAgentCancelInput): BridgeAgentCancelResult {
      if (input.kind !== "user") {
        return { ok: false, code: "no_running_attempt" };
      }
      state.cancelCallCount += 1;
      if (!isRunning(state)) {
        return { ok: false, code: "no_running_attempt" };
      }
      // True source-level stop: drop every pending transient event and
      // this attempt's durable settlement — nothing more will ever leave.
      const cancelledAttemptId = state.attemptId;
      state.pending = [];
      state.pendingDurable = [];
      state.attemptId = null;
      state.turnId = null;
      return { ok: true, attemptId: cancelledAttemptId };
    },
    async whenIdle() {
      state.whenIdleCount += 1;
      // The mock has no asynchronous worker loop: an attempt stops when
      // its queue drains (pump) or when cancel/crash clears it.
      return { ok: true, attemptId: state.attemptId };
    },
    async dispose() {
      state.disposed = true;
      state.pending = [];
      state.pendingDurable = [];
      state.attemptId = null;
      state.turnId = null;
      state.streamListeners = [];
      state.durableListeners = [];
      return { ok: true };
    },
    onStream(listener) {
      state.streamListeners.push(listener);
      return { ok: true };
    },
    onDurable(listener) {
      state.durableListeners.push(listener);
      return { ok: true };
    },
    isRunning() {
      return isRunning(state);
    },
  };
  return handle;
}

/** The synthetic Cordis runtime (upstream process stand-in). */
export interface MockCordisRuntime extends BridgeAgentPort {
  /** Fault listener for worker isolation (consumed by the Bridge). */
  onFault(listener: (info: { readonly sessionKey: string; readonly code: "worker_crashed" }) => void): void;
  /** Test-only fault injection: the worker dies mid-flight. */
  crashNow(sessionKey: string): void;
  /** Dispatch up to `max` pending events (transient first, then durable). */
  pump(sessionKey: string, max?: number): number;
  /** Dispatch everything pending for the session; returns event count. */
  pumpAll(sessionKey: string): number;
  /** Whether the session still has undelivered upstream events. */
  hasPending(sessionKey: string): boolean;
  /** The upstream source log (test replay truth), frozen snapshot. */
  sourceLogSnapshot(): readonly MockSourceEvent[];
  /** Cancel-call count for one session (duplicate-cancel assertions). */
  cancelCallCount(sessionKey: string): number;
  /** whenIdle-call count for one session. */
  whenIdleCount(sessionKey: string): number;
  /** Whether a live (non-disposed) handle exists for the session. */
  hasLiveHandle(sessionKey: string): boolean;
  /** Number of live handles across all sessions (ownership evidence). */
  liveHandleCount(): number;
}

/** Create the deterministic mock runtime. */
export function createMockCordisRuntime(options: MockCordisRuntimeOptions): MockCordisRuntime {
  if (options === null || typeof options !== "object" || typeof options.scriptFor !== "function") {
    throw new Error("mock cordis runtime requires a scriptFor function.");
  }
  const scriptFor = options.scriptFor;
  const sessions = new Map<string, MockHandleState>();
  const faultListeners: ((info: { readonly sessionKey: string; readonly code: "worker_crashed" }) => void)[] = [];
  const sourceLog: MockSourceEvent[] = [];
  let sourceSeq = 0;

  function recordStream(state: MockHandleState, event: BridgeStreamEvent): void {
    sourceSeq += 1;
    sourceLog.push({ sourceSeq, sessionKey: state.sessionKey, event });
    for (const listener of [...state.streamListeners]) {
      listener(event);
    }
  }

  function recordDurable(state: MockHandleState, event: BridgeDurableEvent): void {
    sourceSeq += 1;
    sourceLog.push({ sourceSeq, sessionKey: state.sessionKey, event });
    for (const listener of [...state.durableListeners]) {
      listener(event);
    }
  }

  const runtime: MockCordisRuntime = {
    createAgent(sessionKey) {
      const existing = sessions.get(sessionKey);
      if (existing && !existing.disposed) {
        return { ok: false, code: "bridge_ownership_conflict" };
      }
      const state = createHandleState(sessionKey);
      sessions.set(sessionKey, state);
      return { ok: true, handle: createMockHandle(state, scriptFor) };
    },
    resumeAgent(sessionKey) {
      const state = sessions.get(sessionKey);
      if (!state || state.disposed) {
        return { ok: false, code: "session_unknown" };
      }
      if (state.crashed) {
        return { ok: false, code: "worker_fault" };
      }
      return { ok: true, handle: createMockHandle(state, scriptFor) };
    },
    onFault(listener) {
      faultListeners.push(listener);
    },
    crashNow(sessionKey) {
      const state = sessions.get(sessionKey);
      if (!state || state.disposed || state.crashed) {
        return;
      }
      state.crashed = true;
      state.pending = [];
      state.pendingDurable = [];
      state.attemptId = null;
      state.turnId = null;
      for (const listener of [...faultListeners]) {
        listener({ sessionKey, code: "worker_crashed" });
      }
    },
    pump(sessionKey, max = 1) {
      const state = sessions.get(sessionKey);
      if (!state || state.disposed || state.crashed) {
        return 0;
      }
      let dispatched = 0;
      while (dispatched < max) {
        const next = state.pending.shift();
        if (next === undefined) {
          break;
        }
        recordStream(state, next);
        dispatched += 1;
      }
      // The durable settlement only after the transient stream ended.
      if (state.pending.length === 0 && state.pendingDurable.length > 0) {
        const durable = state.pendingDurable.shift();
        if (durable !== undefined) {
          recordDurable(state, durable);
          state.attemptId = null;
          state.turnId = null;
          dispatched += 1;
        }
      }
      return dispatched;
    },
    pumpAll(sessionKey) {
      let total = 0;
      for (;;) {
        const n = runtime.pump(sessionKey, Number.MAX_SAFE_INTEGER);
        if (n === 0) {
          break;
        }
        total += n;
      }
      return total;
    },
    hasPending(sessionKey) {
      const state = sessions.get(sessionKey);
      return !!state && (state.pending.length > 0 || state.pendingDurable.length > 0);
    },
    sourceLogSnapshot() {
      return Object.freeze([...sourceLog]);
    },
    cancelCallCount(sessionKey) {
      return sessions.get(sessionKey)?.cancelCallCount ?? 0;
    },
    whenIdleCount(sessionKey) {
      return sessions.get(sessionKey)?.whenIdleCount ?? 0;
    },
    hasLiveHandle(sessionKey) {
      const state = sessions.get(sessionKey);
      return !!state && !state.disposed;
    },
    liveHandleCount() {
      let count = 0;
      for (const state of sessions.values()) {
        if (!state.disposed) {
          count += 1;
        }
      }
      return count;
    },
  };
  return runtime;
}
