/**
 * R1-V2 Bridge — the exclusive in-process owner of every voice session's
 * AgentHandle (issue #29 实现范围 1/2/5; docs/VOICE_RUNTIME.md §3/§7;
 * docs/adr/0002-voice-runtime-bridge.md).
 *
 * Responsibilities, in the issue's words, mapped to code:
 * - 同一 Voice Session 只有 Bridge 拥有 AgentHandle：one handle per
 *   sessionKey, created ONLY here through the injected agent port; the
 *   port's exclusive-ownership contract makes side-channel creation
 *   structurally impossible.
 * - 落地 session.open / turn.prompt / turn.cancel / turn.stream /
 *   session.close：the five commands below are the ONLY control surface;
 *   every reply is an enumerated result, never an echo of submitted data.
 * - 打断先 fence、再 stop/取消：the Bridge NEVER fences by itself — the
 *   Orchestrator bumps the trusted epoch first and only then sends
 *   turn.cancel; the Bridge performs the in-process
 *   `cancel({ kind: 'user' })`, awaits `whenIdle()`, and only reports the
 *   stop so the Orchestrator can schedule the next turn.
 * - 瞬态 Delta 与持久 session/event：only transient chunk deltas of the
 *   subscribed text channel are forwarded; tool_call/thinking channels
 *   are counted and dropped; the durable `assistant/message` becomes a
 *   turn.settled notification (id only) and its body NEVER crosses.
 * - 阻塞时隔离并回收 Worker：a crashed or stop-timeout worker is
 *   quarantined (disposed, no further forwarding); the next session.open
 *   rebuilds a fresh worker and binds ONLY confirmed session identity —
 *   no side effect is ever replayed.
 *
 * PRIVACY: audit entries and metrics are content-free (ids, epochs,
 * enumerated codes, counts, bounded durations). No field here can carry
 * child audio, transcript or model output.
 *
 * This module must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { ContractValidationError, problem } from "../../contract/core.ts";
import { ingestDomainFact } from "../../legacy-guard.ts";
import type {
  BridgeAgentHandle,
  BridgeAgentPort,
  BridgeDurableEvent,
  BridgeStreamEvent,
} from "./agent-port.ts";
import {
  parseSessionClosePayload,
  parseSessionOpenPayload,
  parseTurnCancelPayload,
  parseTurnPromptPayload,
  parseTurnStreamPayload,
  type BridgeEventFrame,
  type BridgeRejectionCode,
  type BridgeSessionClosePayload,
  type BridgeSessionOpenPayload,
  type BridgeTurnCancelPayload,
  type BridgeTurnPromptPayload,
  type BridgeTurnStreamPayload,
} from "./ipc-contract.ts";
import type { BridgeCordisProfile } from "./profile.ts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export const VOICE_BRIDGE_VERSION = "1.0" as const;

/** whenIdle sanity budget: a resolved whenIdle must leave a stopped agent. */
export const BRIDGE_CANCEL_TIMEOUT_MS = 2_000;

export interface BridgeMetricsSnapshot {
  readonly cancelAck: { readonly count: number; readonly maxMs: number };
  readonly whenIdle: { readonly count: number; readonly maxMs: number };
  readonly workerRecovery: { readonly count: number; readonly maxMs: number };
  readonly deltasForwarded: number;
  readonly deltasDroppedNonText: number;
  readonly deltasDroppedStale: number;
  readonly deltasDroppedUnsubscribed: number;
}

export interface BridgeAuditEntry {
  readonly seq: number;
  readonly atMs: number;
  readonly action:
    | "bridge.session_opened"
    | "bridge.turn_prompted"
    | "bridge.cancel_acked"
    | "bridge.stop_confirmed"
    | "bridge.stream_started"
    | "bridge.session_closed"
    | "bridge.worker_quarantined"
    | "bridge.worker_recovered"
    | "bridge.delta_dropped";
  readonly sessionKey: string | null;
  readonly turnId: string | null;
  readonly epoch: number | null;
  readonly resultCode: string;
  readonly count: number | null;
}

/** The service the IPC transport binds (all commands, plain results). */
export interface VoiceBridgeService {
  readonly profile: Readonly<BridgeCordisProfile>;
  readonly bridgeId: string;
  readonly dshVersion: string;
  openSession(payload: BridgeSessionOpenPayload): Promise<BridgeServiceResult<BridgeSessionOpenResult>>;
  turnPrompt(payload: BridgeTurnPromptPayload): Promise<BridgeServiceResult<BridgeTurnPromptResult>>;
  turnCancel(payload: BridgeTurnCancelPayload): Promise<BridgeServiceResult<BridgeTurnCancelResult>>;
  turnStream(payload: BridgeTurnStreamPayload): Promise<BridgeServiceResult<BridgeTurnStreamResult>>;
  closeSession(payload: BridgeSessionClosePayload): Promise<BridgeServiceResult<BridgeSessionCloseResult>>;
  /** Unsolicited events for the single leased client. */
  onEvent(listener: (event: BridgeEventFrame) => void): void;
  auditSnapshot(): readonly Readonly<BridgeAuditEntry>[];
  metricsSnapshot(): Readonly<BridgeMetricsSnapshot>;
  /** Worker fault entry point (wired to the agent port's fault signal). */
  handleAgentCrash(sessionKey: string): void;
}

export type BridgeServiceResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: BridgeRejectionCode };

export interface BridgeSessionOpenResult {
  readonly recovered: boolean;
  readonly dshVersion: string;
  readonly profileId: string;
}

export interface BridgeTurnPromptResult {
  readonly attemptId: string;
}

export interface BridgeTurnCancelResult {
  readonly cancelAcked: true;
  readonly attemptId: string | null;
  readonly idleConfirmed: boolean;
  readonly whenIdleMs: number | null;
}

export interface BridgeTurnStreamResult {
  readonly streaming: true;
}

export interface BridgeSessionCloseResult {
  readonly closed: true;
}

export interface VoiceBridgeOptions {
  readonly profile: Readonly<BridgeCordisProfile>;
  readonly agentPort: BridgeAgentPort;
  /** Wall clock in ms (injectable for deterministic tests). */
  readonly clock?: () => number;
  readonly auditCapacity?: number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface BridgeSessionState {
  readonly sessionKey: string;
  readonly ownerActorId: string;
  readonly conversationId: string;
  handle: BridgeAgentHandle;
  worker: { readonly status: "active" | "quarantined"; readonly quarantinedAtMs: number | null };
  activeTurn: {
    readonly turnId: string;
    readonly epoch: number;
    readonly attemptId: string;
    readonly streamSubscribed: boolean;
    readonly startedAtMs: number;
  } | null;
}

function failBridgeInput(path: string, message: string): never {
  throw new ContractValidationError([problem("CONTRACT_FIELD_INVALID", path, message)]);
}

function requireObject(value: unknown, path: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    failBridgeInput(path, "expected an object.");
  }
}

/** Create the voice bridge service over the injected agent port. */
export function createVoiceBridge(options: VoiceBridgeOptions): VoiceBridgeService {
  requireObject(options, "options");
  if (typeof options.profile !== "object" || options.profile === null) {
    failBridgeInput("options.profile", "a validated bridge profile is required.");
  }
  if (typeof options.agentPort !== "object" || options.agentPort === null) {
    failBridgeInput("options.agentPort", "an agent port is required.");
  }
  const clock = options.clock ?? (() => Date.now());
  const auditCapacity = Math.max(1, Math.min(options.auditCapacity ?? 512, 10_000));

  const sessions = new Map<string, BridgeSessionState>();
  const eventListeners: ((event: BridgeEventFrame) => void)[] = [];
  const audit: BridgeAuditEntry[] = [];
  let auditSeq = 0;

  const metrics = {
    cancelAck: { count: 0, maxMs: 0 },
    whenIdle: { count: 0, maxMs: 0 },
    workerRecovery: { count: 0, maxMs: 0 },
    deltasForwarded: 0,
    deltasDroppedNonText: 0,
    deltasDroppedStale: 0,
    deltasDroppedUnsubscribed: 0,
  };

  function pushAudit(entry: Omit<BridgeAuditEntry, "seq" | "atMs">): void {
    auditSeq += 1;
    const admitted = ingestDomainFact({
      seq: auditSeq,
      atMs: clock(),
      action: entry.action,
      sessionKey: entry.sessionKey,
      turnId: entry.turnId,
      epoch: entry.epoch,
      resultCode: entry.resultCode,
      count: entry.count,
    }) as Readonly<BridgeAuditEntry>;
    audit.push(admitted);
    if (audit.length > auditCapacity) {
      audit.shift();
    }
  }

  function emit(event: BridgeEventFrame): void {
    for (const listener of [...eventListeners]) {
      listener(event);
    }
  }

  function recordDuration(bucket: { count: number; maxMs: number }, ms: number): void {
    bucket.count += 1;
    if (ms > bucket.maxMs) {
      bucket.maxMs = ms;
    }
  }

  /** Forward one upstream stream event for the session (fenced, §7). */
  function forwardStreamEvent(state: BridgeSessionState, event: BridgeStreamEvent): void {
    const active = state.activeTurn;
    if (active === null || event.kind === "start") {
      if (event.kind === "chunk") {
        // No active turn: any arriving chunk is stale by definition.
        metrics.deltasDroppedStale += 1;
        pushAudit({
          action: "bridge.delta_dropped",
          sessionKey: state.sessionKey,
          turnId: null,
          epoch: null,
          resultCode: "stale_turn_rejected",
          count: 1,
        });
      }
      return;
    }
    if (event.attemptId !== active.attemptId) {
      metrics.deltasDroppedStale += 1;
      pushAudit({
        action: "bridge.delta_dropped",
        sessionKey: state.sessionKey,
        turnId: active.turnId,
        epoch: active.epoch,
        resultCode: "stale_turn_rejected",
        count: 1,
      });
      return;
    }
    if (event.kind === "end") {
      emit({
        kind: "event",
        name: "attempt.ended",
        payload: {
          sessionKey: state.sessionKey,
          turnId: active.turnId,
          epoch: active.epoch,
          attemptId: active.attemptId,
        },
      });
      return;
    }
    // kind === "chunk"
    if (event.channel !== "text") {
      // Tool calls and thinking NEVER appear in the playback path.
      metrics.deltasDroppedNonText += 1;
      pushAudit({
        action: "bridge.delta_dropped",
        sessionKey: state.sessionKey,
        turnId: active.turnId,
        epoch: active.epoch,
        resultCode: "non_text_channel",
        count: 1,
      });
      return;
    }
    if (!active.streamSubscribed) {
      // Streaming requires turn.stream (filtering/背压, VOICE_RUNTIME §3).
      metrics.deltasDroppedUnsubscribed += 1;
      pushAudit({
        action: "bridge.delta_dropped",
        sessionKey: state.sessionKey,
        turnId: active.turnId,
        epoch: active.epoch,
        resultCode: "stream_not_subscribed",
        count: 1,
      });
      return;
    }
    metrics.deltasForwarded += 1;
    emit({
      kind: "event",
      name: "assistant.delta",
      payload: {
        sessionKey: state.sessionKey,
        turnId: active.turnId,
        epoch: active.epoch,
        attemptId: event.attemptId,
        stepId: event.stepId,
        index: event.index,
        text: event.textDelta,
      },
    });
  }

  /** Settle the durable message: notification with ids only. */
  function forwardDurableEvent(state: BridgeSessionState, event: BridgeDurableEvent): void {
    const active = state.activeTurn;
    if (active === null || event.attemptId !== active.attemptId) {
      return;
    }
    emit({
      kind: "event",
      name: "turn.settled",
      payload: {
        sessionKey: state.sessionKey,
        turnId: active.turnId,
        epoch: active.epoch,
        messageId: event.messageId,
        finalState: "COMPLETED",
      },
    });
    state.activeTurn = null;
  }

  function bindHandle(state: BridgeSessionState, handle: BridgeAgentHandle): void {
    state.handle = handle;
    handle.onStream((event) => forwardStreamEvent(state, event));
    handle.onDurable((event) => forwardDurableEvent(state, event));
  }

  const service: VoiceBridgeService = {
    profile: options.profile,
    bridgeId: options.profile.profileId,
    dshVersion: options.profile.dshVersion,

    async openSession(payload) {
      let parsed: BridgeSessionOpenPayload;
      try {
        parsed = parseSessionOpenPayload(payload);
      } catch {
        return { ok: false, code: "bridge.parse_failed" };
      }
      const existing = sessions.get(parsed.sessionKey);
      let recovered = false;
      if (existing) {
        if (existing.worker.status === "active") {
          // One live owner per session — the exclusive-ownership contract.
          return { ok: false, code: "session_conflict" };
        }
        // Quarantined worker: dispose the dead handle and rebuild. Only
        // confirmed identity (ids) is rebinding; nothing is replayed.
        await existing.handle.dispose().catch(() => undefined);
        const created = options.agentPort.createAgent(parsed.sessionKey);
        if (!created.ok) {
          return { ok: false, code: created.code === "bridge_ownership_conflict" ? "bridge_ownership_conflict" : "worker_recovering" };
        }
        const quarantinedAtMs = existing.worker.quarantinedAtMs ?? clock();
        bindHandle(existing, created.handle);
        (existing as { worker: BridgeSessionState["worker"] }).worker = {
          status: "active",
          quarantinedAtMs: null,
        };
        recovered = true;
        const recoveryMs = Math.max(0, clock() - quarantinedAtMs);
        recordDuration(metrics.workerRecovery, recoveryMs);
        pushAudit({
          action: "bridge.worker_recovered",
          sessionKey: parsed.sessionKey,
          turnId: null,
          epoch: null,
          resultCode: "ok",
          count: null,
        });
        emit({
          kind: "event",
          name: "runtime.error",
          payload: { sessionKey: parsed.sessionKey, code: "recovered", attemptId: null },
        });
      } else {
        const created = options.agentPort.createAgent(parsed.sessionKey);
        if (!created.ok) {
          // Includes the port's own exclusive-ownership refusal.
          return { ok: false, code: created.code === "bridge_ownership_conflict" ? "bridge_ownership_conflict" : "session_conflict" };
        }
        const state: BridgeSessionState = {
          sessionKey: parsed.sessionKey,
          ownerActorId: parsed.ownerActorId,
          conversationId: parsed.conversationId,
          handle: created.handle,
          worker: { status: "active", quarantinedAtMs: null },
          activeTurn: null,
        };
        sessions.set(parsed.sessionKey, state);
        bindHandle(state, created.handle);
      }
      pushAudit({
        action: "bridge.session_opened",
        sessionKey: parsed.sessionKey,
        turnId: null,
        epoch: null,
        resultCode: recovered ? "recovered" : "ok",
        count: null,
      });
      return {
        ok: true,
        value: { recovered, dshVersion: options.profile.dshVersion, profileId: options.profile.profileId },
      };
    },

    async turnPrompt(payload) {
      let parsed: BridgeTurnPromptPayload;
      try {
        parsed = parseTurnPromptPayload(payload);
      } catch {
        return { ok: false, code: "bridge.parse_failed" };
      }
      const state = sessions.get(parsed.sessionKey);
      if (!state) {
        return { ok: false, code: "session_unknown" };
      }
      if (state.worker.status === "quarantined") {
        return { ok: false, code: "worker_recovering" };
      }
      if (state.activeTurn !== null) {
        return { ok: false, code: "bridge_turn_conflict" };
      }
      let run;
      try {
        run = state.handle.runPrompt({ turnId: parsed.turnId, nonceFingerprint: parsed.fingerprint });
      } catch {
        return { ok: false, code: "worker_quarantined" };
      }
      (state as { activeTurn: BridgeSessionState["activeTurn"] }).activeTurn = {
        turnId: parsed.turnId,
        epoch: parsed.epoch,
        attemptId: run.attemptId,
        streamSubscribed: false,
        startedAtMs: clock(),
      };
      pushAudit({
        action: "bridge.turn_prompted",
        sessionKey: parsed.sessionKey,
        turnId: parsed.turnId,
        epoch: parsed.epoch,
        resultCode: "ok",
        count: null,
      });
      emit({
        kind: "event",
        name: "turn.accepted",
        payload: {
          sessionKey: parsed.sessionKey,
          turnId: parsed.turnId,
          epoch: parsed.epoch,
          attemptId: run.attemptId,
        },
      });
      return { ok: true, value: { attemptId: run.attemptId } };
    },

    async turnCancel(payload) {
      let parsed: BridgeTurnCancelPayload;
      try {
        parsed = parseTurnCancelPayload(payload);
      } catch {
        return { ok: false, code: "bridge.parse_failed" };
      }
      const state = sessions.get(parsed.sessionKey);
      if (!state) {
        return { ok: false, code: "session_unknown" };
      }
      if (state.worker.status === "quarantined") {
        return { ok: false, code: "worker_recovering" };
      }
      const active = state.activeTurn;
      if (active === null || active.turnId !== parsed.turnId) {
        // Duplicate or late cancel: rejected WITHOUT touching the agent —
        // the in-process cancel happens exactly once (重复取消 evidence).
        return { ok: false, code: "cancel_unknown_turn" };
      }
      if (parsed.epoch <= active.epoch) {
        // Fence-first ordering (VOICE_RUNTIME §4 step 1→3): the cancel must
        // present the POST-fence epoch, strictly above the dispatched turn's
        // epoch. An equal-or-older epoch means the sender skipped the fence.
        return { ok: false, code: "stale_turn_rejected" };
      }
      const cancelStartedAtMs = clock();
      const cancelled = state.handle.cancel({ kind: "user" });
      if (!cancelled.ok) {
        return { ok: false, code: "cancel_unknown_turn" };
      }
      const cancelAckMs = Math.max(0, clock() - cancelStartedAtMs);
      recordDuration(metrics.cancelAck, cancelAckMs);
      pushAudit({
        action: "bridge.cancel_acked",
        sessionKey: parsed.sessionKey,
        turnId: parsed.turnId,
        epoch: parsed.epoch,
        resultCode: "ok",
        count: null,
      });
      const idleStartedAtMs = clock();
      const idle = await state.handle.whenIdle();
      if (state.handle.isRunning()) {
        // whenIdle resolved but the agent did not stop: isolate the worker.
        service.handleAgentCrash(parsed.sessionKey);
        pushAudit({
          action: "bridge.worker_quarantined",
          sessionKey: parsed.sessionKey,
          turnId: parsed.turnId,
          epoch: parsed.epoch,
          resultCode: "cancel_timeout",
          count: null,
        });
        return { ok: false, code: "cancel_timeout" };
      }
      const whenIdleMs = Math.max(0, clock() - idleStartedAtMs);
      recordDuration(metrics.whenIdle, whenIdleMs);
      const settledAttemptId = cancelled.attemptId;
      (state as { activeTurn: BridgeSessionState["activeTurn"] }).activeTurn = null;
      void idle;
      pushAudit({
        action: "bridge.stop_confirmed",
        sessionKey: parsed.sessionKey,
        turnId: parsed.turnId,
        epoch: parsed.epoch,
        resultCode: "ok",
        count: null,
      });
      emit({
        kind: "event",
        name: "session.idle",
        payload: { sessionKey: parsed.sessionKey, epoch: parsed.epoch, attemptId: settledAttemptId },
      });
      return {
        ok: true,
        value: { cancelAcked: true, attemptId: settledAttemptId, idleConfirmed: true, whenIdleMs },
      };
    },

    async turnStream(payload) {
      let parsed: BridgeTurnStreamPayload;
      try {
        parsed = parseTurnStreamPayload(payload);
      } catch {
        return { ok: false, code: "bridge.parse_failed" };
      }
      const state = sessions.get(parsed.sessionKey);
      if (!state) {
        return { ok: false, code: "session_unknown" };
      }
      if (state.worker.status === "quarantined") {
        return { ok: false, code: "worker_recovering" };
      }
      const active = state.activeTurn;
      if (active === null || active.turnId !== parsed.turnId) {
        return { ok: false, code: "turn_unknown" };
      }
      if (parsed.epoch < active.epoch) {
        return { ok: false, code: "stale_turn_rejected" };
      }
      (state as { activeTurn: BridgeSessionState["activeTurn"] }).activeTurn = {
        ...active,
        streamSubscribed: true,
      };
      pushAudit({
        action: "bridge.stream_started",
        sessionKey: parsed.sessionKey,
        turnId: parsed.turnId,
        epoch: parsed.epoch,
        resultCode: "ok",
        count: null,
      });
      return { ok: true, value: { streaming: true } };
    },

    async closeSession(payload) {
      let parsed: BridgeSessionClosePayload;
      try {
        parsed = parseSessionClosePayload(payload);
      } catch {
        return { ok: false, code: "bridge.parse_failed" };
      }
      const state = sessions.get(parsed.sessionKey);
      if (!state) {
        return { ok: false, code: "session_unknown" };
      }
      await state.handle.dispose().catch(() => undefined);
      sessions.delete(parsed.sessionKey);
      pushAudit({
        action: "bridge.session_closed",
        sessionKey: parsed.sessionKey,
        turnId: null,
        epoch: null,
        resultCode: parsed.reason === "orchestrator_close" ? "ok" : parsed.reason,
        count: null,
      });
      emit({
        kind: "event",
        name: "session.closed",
        payload: { sessionKey: parsed.sessionKey, reason: parsed.reason },
      });
      return { ok: true, value: { closed: true } };
    },

    onEvent(listener) {
      eventListeners.push(listener);
    },

    auditSnapshot() {
      return Object.freeze([...audit]);
    },

    metricsSnapshot() {
      return { ...metrics };
    },

    handleAgentCrash(sessionKey) {
      const state = sessions.get(sessionKey);
      if (!state || state.worker.status === "quarantined") {
        return;
      }
      const crashedAttemptId = state.activeTurn?.attemptId ?? null;
      (state as { worker: BridgeSessionState["worker"] }).worker = {
        status: "quarantined",
        quarantinedAtMs: clock(),
      };
      (state as { activeTurn: BridgeSessionState["activeTurn"] }).activeTurn = null;
      pushAudit({
        action: "bridge.worker_quarantined",
        sessionKey,
        turnId: null,
        epoch: null,
        resultCode: "worker_crashed",
        count: null,
      });
      emit({
        kind: "event",
        name: "runtime.error",
        payload: { sessionKey, code: "worker_crashed", attemptId: crashedAttemptId },
      });
    },
  };
  return service;
}
