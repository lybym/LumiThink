/**
 * R1-V1 Voice Turn Orchestrator — independent of any device and of DSH
 * (issue #28 实现范围 1/2/4/5; docs/VOICE_RUNTIME.md §4; ADR-002 stage 1).
 *
 * The orchestrator OWNS `turn_id` minting and drives the trusted fence
 * store, which owns the per-session monotonic `epoch`. It exists to prove
 * exactly the property the issue asks for: a valid interruption FIRST
 * atomically bumps the trusted epoch (revoking the old turn's text / TTS /
 * audio / candidate-memory / domain-write permissions at the same instant)
 * and only then may the new turn be dispatched — never "drop the late UI
 * return value and move on".
 *
 * Sequencing contract (docs/VOICE_RUNTIME.md §4):
 *  1. `receivePrompt` (new ASR) may arrive at ANY time — including while
 *     the old task is still stopping. The turn is born CREATED at the
 *     current epoch; the scheduler pump keeps it queued until the old task
 *     stopped (no RUNNING/CANCELLING turn remains).
 *  2. `cancelTurn` is the effective interruption: ONE atomic store step
 *     bumps the epoch and flips every non-terminal old-epoch turn to
 *     CANCELLING. Duplicate cancels, late cancels for fenced turns and
 *     unknown/cross-session turns are fence-rejected without a second bump.
 *  3. `confirmStop` (the Bridge `whenIdle` analog) is the ONLY path from
 *     CANCELLING to CANCELLED; until then the session stays busy and no
 *     new prompt is dispatched.
 *  4. `fenceOutput` / `fenceWrite` re-verify the CURRENT trusted epoch at
 *     every emission/commit point — a late delta, TTS sentence, audio send
 *     or memory write for a fenced epoch is rejected here, not merely
 *     dropped by some downstream consumer.
 *
 * STRUCTURED AUDIT (issue #28: 只记 trace_id/turn_id/epoch/结果码): the
 * audit ring records only actions, grammar-checked ids, epochs, enumerated
 * result codes and counts. There is NO field that could carry child audio,
 * transcript text or model output — enforced by the schema test.
 *
 * This module must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { ContractValidationError, problem } from "../contract/core.ts";
import {
  admitVoiceAuditEntry,
  VOICE_AUDIT_FIELDS,
  VOICE_CANCEL_REASONS,
  type VoiceAuditAction,
  type VoiceAuditEntry,
  type VoiceAuditResultCode,
  type VoiceOutputKind,
  type VoiceSessionRecord,
  type VoiceSettleOutcome,
  type VoiceTurnRecord,
  type VoiceWriteKind,
} from "./schema.ts";
import {
  createInMemoryVoiceFenceStore,
  VoiceRejection,
  VOICE_FENCE_STORE_FORMAT,
  type VoiceFenceStore,
} from "./store.ts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Orchestrator protocol version (audit fact; bumps with behavior changes). */
export const VOICE_ORCHESTRATOR_VERSION = "1.0" as const;

/** Max audit ring entries (bounded memory; ring drops the oldest). */
export const MAX_VOICE_AUDIT_ENTRIES = 512;

export interface VoiceTurnOrchestratorOptions {
  /**
   * The trusted fence store. Defaults to the in-memory implementation;
   * the SQLite adapter (lib/server/voice-turn-sqlite-store.ts) binds here
   * for durable, restart-safe deployments.
   */
  readonly store?: VoiceFenceStore;
  /** Wall clock in ms (injectable for deterministic tests). */
  readonly clock?: () => number;
  /** `trn_` turn id factory (overridable for deterministic tests). */
  readonly turnIdFactory?: () => string;
  /** Audit ring capacity (default MAX_VOICE_AUDIT_ENTRIES). */
  readonly auditCapacity?: number;
}

/** The result of settling one turn into a terminal state. */
export type VoiceTurnSettleResult = ReturnType<VoiceFenceStore["settleTurn"]>;

export interface VoiceTurnOrchestrator {
  /** Open (or reopen) one voice session; binds its ownership. */
  openSession(refs: {
    readonly sessionKey: unknown;
    readonly conversationId: unknown;
    readonly ownerActorId: unknown;
  }): ReturnType<VoiceFenceStore["openSession"]>;

  /**
   * Receive one new prompt (new ASR may arrive in parallel with a running
   * cancellation). Returns the minted turn and whether the scheduler could
   * dispatch it immediately; a busy session leaves it queued (never lost,
   * never dispatched onto a running old task).
   */
  receivePrompt(refs: {
    readonly sessionKey: unknown;
    readonly traceId: unknown;
    /** Caller-supplied idempotency key + content-free hex digest. */
    readonly idempotencyKey?: unknown;
    readonly fingerprint?: unknown;
  }): VoicePromptOutcome;

  /** The effective interruption: fence FIRST, then flip states. */
  cancelTurn(refs: {
    readonly sessionKey: unknown;
    readonly turnId: unknown;
    /** Unknown at the type level; validated fail-closed at runtime. */
    readonly reason: unknown;
  }): ReturnType<VoiceFenceStore["cancelTurn"]>;

  /** Agent stopped (Bridge `whenIdle` analog): CANCELLING → CANCELLED. */
  confirmStop(refs: { readonly sessionKey: unknown; readonly turnId: unknown }): VoiceTurnSettleResult;

  /** Settle a turn into a terminal state (COMPLETED/FAILED/TIMED_OUT/CANCELLED). */
  settleTurn(refs: {
    readonly sessionKey: unknown;
    readonly turnId: unknown;
    readonly outcome: VoiceSettleOutcome;
  }): VoiceTurnSettleResult;

  /** Manual scheduler pump (receivePrompt already pumps). */
  pump(sessionKey: unknown): ReturnType<VoiceFenceStore["pumpScheduler"]>;

  /**
   * Output fence (text delta / TTS enqueue / audio send): the emission
   * must present the CURRENT trusted epoch of a RUNNING turn.
   */
  fenceOutput(refs: {
    readonly sessionKey: unknown;
    readonly turnId: unknown;
    readonly epoch: unknown;
    readonly kind: VoiceOutputKind;
    /** Item id for `tts_queue` (minted by the caller). */
    readonly ttsItemId?: unknown;
  }): ReturnType<VoiceFenceStore["fenceOutput"]>;

  /** Deliver current-epoch TTS items; stale items are permanently dropped. */
  drainTts(sessionKey: unknown): ReturnType<VoiceFenceStore["drainTtsQueue"]>;

  /**
   * The atomic conditional commit for downstream side effects (memory
   * proposals, learning-state writes) with an idempotency key.
   */
  fenceWrite(refs: {
    readonly sessionKey: unknown;
    readonly turnId: unknown;
    readonly epoch: unknown;
    readonly kind: VoiceWriteKind;
    readonly idempotencyKey: unknown;
    readonly fingerprint: unknown;
  }): ReturnType<VoiceFenceStore["fenceWrite"]>;

  /** RUNNING/CANCELLING turns older than the budget → TIMED_OUT. */
  sweepTimeouts(refs: {
    readonly sessionKey: unknown;
    readonly budgetMs: unknown;
  }): ReturnType<VoiceFenceStore["sweepTimeouts"]>;

  // Read-only surfaces.
  currentEpoch(sessionKey: unknown): number | null;
  describeSession(sessionKey: unknown): Readonly<VoiceSessionRecord> | null;
  describeTurn(sessionKey: unknown, turnId: unknown): Readonly<VoiceTurnRecord> | null;
  listTurns(sessionKey: unknown): readonly Readonly<VoiceTurnRecord>[];
  ttsQueueDepth(sessionKey: unknown): number;

  /** Bounded audit ring snapshot, oldest first (structural facts only). */
  auditSnapshot(): readonly Readonly<VoiceAuditEntry>[];
  /** Clear the audit ring (cleanup is not data deletion). */
  purgeAudit(): void;

  /** Process-restart port (delegates to the trusted store). */
  exportState(): ReturnType<VoiceFenceStore["exportState"]>;
  restoreState(raw: unknown): ReturnType<VoiceFenceStore["restoreState"]>;
}

// ---------------------------------------------------------------------------
// Outcome aliases
// ---------------------------------------------------------------------------

export type VoicePromptOutcome = {
  readonly ok: true;
  readonly replayed: boolean;
  readonly turn: Readonly<VoiceTurnRecord>;
  readonly dispatchedTurnId: string | null;
  readonly busyTurnId: string | null;
} | {
  readonly ok: false;
  readonly code: "session_unknown" | "idempotency_conflict";
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function defaultVoiceTurnId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `trn_${Date.now().toString(36)}${random}`.slice(0, 68);
}

function failVoiceInput(path: string, message: string): never {
  throw new ContractValidationError([problem("CONTRACT_FIELD_INVALID", path, message)]);
}

/** Require a non-empty string id-ish value (grammar is enforced in the store). */
function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    failVoiceInput(path, `${path} is required and must be a non-empty string.`);
  }
  return value;
}

/**
 * Create the voice turn orchestrator. The trusted store is the single
 * serialization point; this object adds turn-id minting, sequencing and
 * the structured audit ring on top.
 */
export function createVoiceTurnOrchestrator(
  options: VoiceTurnOrchestratorOptions = {},
): VoiceTurnOrchestrator {
  if (options === null || typeof options !== "object") {
    failVoiceInput("options", "orchestrator options must be an object.");
  }
  const store = options.store ?? createInMemoryVoiceFenceStore();
  const clock = options.clock ?? (() => Date.now());
  const turnIdFactory = options.turnIdFactory ?? defaultVoiceTurnId;
  const auditCapacity = Math.max(1, Math.min(options.auditCapacity ?? MAX_VOICE_AUDIT_ENTRIES, 10_000));

  const audit: VoiceAuditEntry[] = [];
  let auditSeq = 0;

  function pushAudit(entry: {
    readonly action: VoiceAuditAction;
    readonly sessionKey: string | null;
    readonly turnId: string | null;
    readonly traceId: string | null;
    readonly epoch: number | null;
    readonly resultCode: VoiceAuditResultCode;
    readonly finalState?: VoiceAuditEntry["finalState"];
    readonly count?: number | null;
  }): void {
    auditSeq += 1;
    const admitted = {
      seq: auditSeq,
      atMs: clock(),
      action: entry.action,
      sessionKey: entry.sessionKey,
      turnId: entry.turnId,
      traceId: entry.traceId,
      epoch: entry.epoch,
      resultCode: entry.resultCode,
      finalState: entry.finalState ?? null,
      count: entry.count ?? null,
    };
    audit.push(admitVoiceAuditEntry(admitted));
    if (audit.length > auditCapacity) {
      audit.shift();
    }
  }

  /** Audit one store call outcome with its enumerated code. */
  function auditOutcome(
    action: VoiceAuditAction,
    refs: {
      readonly sessionKey: string | null;
      readonly turnId: string | null;
      readonly traceId: string | null;
    },
    outcome: { readonly ok: boolean; readonly code?: string },
  ): void {
    pushAudit({
      action,
      sessionKey: refs.sessionKey,
      turnId: refs.turnId,
      traceId: refs.traceId,
      epoch: refs.sessionKey === null ? null : store.currentEpoch(refs.sessionKey),
      resultCode: outcome.ok ? "ok" : (outcome.code as VoiceAuditResultCode),
    });
  }

  // Annotated first so every method below receives its contextual
  // parameter types from the interface (a generic Object.freeze call in
  // the expression would break the inference chain).
  const orchestratorImpl: VoiceTurnOrchestrator = {
    openSession(refs) {
      const sessionKey = requireString(refs.sessionKey, "sessionKey");
      const outcome = store.openSession({
        sessionKey,
        conversationId: requireString(refs.conversationId, "conversationId"),
        ownerActorId: requireString(refs.ownerActorId, "ownerActorId"),
        nowMs: clock(),
      });
      auditOutcome("session.opened", { sessionKey, turnId: null, traceId: null }, outcome);
      return outcome;
    },

    receivePrompt(refs): VoicePromptOutcome {
      const sessionKey = requireString(refs.sessionKey, "sessionKey");
      const traceId =
        refs.traceId === undefined || refs.traceId === null
          ? null
          : requireString(refs.traceId, "traceId");
      const idempotencyKey =
        refs.idempotencyKey === undefined || refs.idempotencyKey === null
          ? null
          : requireString(refs.idempotencyKey, "idempotencyKey");
      const fingerprint =
        refs.fingerprint === undefined || refs.fingerprint === null
          ? null
          : requireString(refs.fingerprint, "fingerprint");
      if ((idempotencyKey === null) !== (fingerprint === null)) {
        failVoiceInput("idempotencyKey", "an idempotency key and its fingerprint are always provided together.");
      }

      const turnId = turnIdFactory();
      const registered = store.registerPrompt({
        sessionKey,
        turnId,
        traceId,
        idempotencyKey,
        fingerprint,
        nowMs: clock(),
      });
      auditOutcome(
        "asr.received",
        { sessionKey, turnId: registered.ok ? registered.turn.turnId : turnId, traceId },
        registered,
      );
      if (!registered.ok) {
        return registered;
      }

      // Auto-pump: enqueue/dispatch when the agent is idle. A busy agent
      // keeps the new prompt queued (VOICE_RUNTIME §4 step 5).
      const pumped = store.pumpScheduler({ sessionKey, nowMs: clock() });
      auditOutcome(
        "turn.dispatched",
        { sessionKey, turnId: pumped.ok ? pumped.dispatchedTurnId : null, traceId },
        pumped,
      );
      return {
        ok: true,
        replayed: registered.replayed,
        turn: registered.turn,
        dispatchedTurnId: pumped.ok ? pumped.dispatchedTurnId : null,
        busyTurnId: pumped.ok ? pumped.busyTurnId : null,
      };
    },

    cancelTurn(refs) {
      const sessionKey = requireString(refs.sessionKey, "sessionKey");
      const turnId = requireString(refs.turnId, "turnId");
      if (!(VOICE_CANCEL_REASONS as readonly string[]).includes(refs.reason as string)) {
        failVoiceInput("reason", "reason must be a registered voice cancel reason.");
      }
      const outcome = store.cancelTurn({ sessionKey, turnId, nowMs: clock() });
      pushAudit({
        action: "cancel.requested",
        sessionKey,
        turnId,
        traceId: null,
        epoch: outcome.ok ? outcome.epoch : store.currentEpoch(sessionKey),
        resultCode: outcome.ok ? "ok" : outcome.code,
        count: outcome.ok ? outcome.fencedTurnIds.length : null,
      });
      return outcome;
    },

    confirmStop(refs) {
      const sessionKey = requireString(refs.sessionKey, "sessionKey");
      const turnId = requireString(refs.turnId, "turnId");
      const outcome = store.settleTurn({ sessionKey, turnId, outcome: "CANCELLED", nowMs: clock() });
      pushAudit({
        action: "cancel.stop_confirmed",
        sessionKey,
        turnId,
        traceId: null,
        epoch: store.currentEpoch(sessionKey),
        resultCode: outcome.ok ? "ok" : outcome.code,
        finalState: outcome.ok ? outcome.turn.state : null,
      });
      return outcome;
    },

    settleTurn(refs) {
      const sessionKey = requireString(refs.sessionKey, "sessionKey");
      const turnId = requireString(refs.turnId, "turnId");
      const outcome = store.settleTurn({ sessionKey, turnId, outcome: refs.outcome, nowMs: clock() });
      pushAudit({
        action: "turn.settled",
        sessionKey,
        turnId,
        traceId: null,
        epoch: store.currentEpoch(sessionKey),
        resultCode: outcome.ok ? "ok" : outcome.code,
        finalState: outcome.ok ? outcome.turn.state : null,
      });
      return outcome;
    },

    pump(sessionKey) {
      const key = requireString(sessionKey, "sessionKey");
      const pumped = store.pumpScheduler({ sessionKey: key, nowMs: clock() });
      auditOutcome(
        "turn.dispatched",
        { sessionKey: key, turnId: pumped.ok ? pumped.dispatchedTurnId : null, traceId: null },
        pumped,
      );
      return pumped;
    },

    fenceOutput(refs) {
      const sessionKey = requireString(refs.sessionKey, "sessionKey");
      const turnId = requireString(refs.turnId, "turnId");
      if (typeof refs.epoch !== "number" || !Number.isInteger(refs.epoch) || refs.epoch < 1) {
        failVoiceInput("epoch", "epoch must be a positive integer.");
      }
      const outcome = store.fenceOutput({
        sessionKey,
        turnId,
        epoch: refs.epoch,
        kind: refs.kind,
        ttsItemId:
          refs.ttsItemId === undefined || refs.ttsItemId === null
            ? `tts_${turnId.slice(4)}_${clock()}`
            : requireString(refs.ttsItemId, "ttsItemId"),
        nowMs: clock(),
      });
      pushAudit({
        action: "output.fenced",
        sessionKey,
        turnId,
        traceId: null,
        epoch: refs.epoch,
        resultCode: outcome.ok ? "allowed" : outcome.code,
      });
      return outcome;
    },

    drainTts(sessionKey) {
      const key = requireString(sessionKey, "sessionKey");
      const outcome = store.drainTtsQueue({ sessionKey: key, nowMs: clock() });
      pushAudit({
        action: "tts.drained",
        sessionKey: key,
        turnId: null,
        traceId: null,
        epoch: store.currentEpoch(key),
        resultCode: outcome.ok ? "ok" : outcome.code,
        count: outcome.ok ? outcome.droppedStale : null,
      });
      return outcome;
    },

    fenceWrite(refs) {
      const sessionKey = requireString(refs.sessionKey, "sessionKey");
      const turnId = requireString(refs.turnId, "turnId");
      if (typeof refs.epoch !== "number" || !Number.isInteger(refs.epoch) || refs.epoch < 1) {
        failVoiceInput("epoch", "epoch must be a positive integer.");
      }
      const outcome = store.fenceWrite({
        sessionKey,
        turnId,
        epoch: refs.epoch,
        kind: refs.kind,
        idempotencyKey: requireString(refs.idempotencyKey, "idempotencyKey"),
        fingerprint: requireString(refs.fingerprint, "fingerprint"),
        nowMs: clock(),
      });
      pushAudit({
        action: "write.fenced",
        sessionKey,
        turnId,
        traceId: null,
        epoch: refs.epoch,
        resultCode: outcome.ok ? "ok" : outcome.code,
      });
      return outcome;
    },

    sweepTimeouts(refs) {
      const sessionKey = requireString(refs.sessionKey, "sessionKey");
      if (typeof refs.budgetMs !== "number" || !Number.isFinite(refs.budgetMs) || refs.budgetMs < 0) {
        failVoiceInput("budgetMs", "budgetMs must be a non-negative finite number.");
      }
      const outcome = store.sweepTimeouts({ sessionKey, budgetMs: refs.budgetMs, nowMs: clock() });
      pushAudit({
        action: "timeout.swept",
        sessionKey,
        turnId: null,
        traceId: null,
        epoch: store.currentEpoch(sessionKey),
        resultCode: outcome.ok ? "ok" : outcome.code,
        count: outcome.ok ? outcome.timedOutTurnIds.length : null,
      });
      return outcome;
    },

    currentEpoch(sessionKey) {
      return store.currentEpoch(requireString(sessionKey, "sessionKey"));
    },

    describeSession(sessionKey) {
      return store.describeSession(requireString(sessionKey, "sessionKey"));
    },

    describeTurn(sessionKey, turnId) {
      return store.describeTurn(requireString(sessionKey, "sessionKey"), requireString(turnId, "turnId"));
    },

    listTurns(sessionKey) {
      return store.listTurns(requireString(sessionKey, "sessionKey"));
    },

    ttsQueueDepth(sessionKey) {
      return store.ttsQueueDepth(requireString(sessionKey, "sessionKey"));
    },

    auditSnapshot() {
      return Object.freeze([...audit]);
    },

    purgeAudit() {
      audit.length = 0;
    },

    exportState() {
      return store.exportState();
    },

    restoreState(raw) {
      return store.restoreState(raw);
    },
  };
  return Object.freeze(orchestratorImpl);
}

export { VOICE_FENCE_STORE_FORMAT, VoiceRejection };
