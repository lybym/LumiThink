/**
 * R1-V1 trusted voice fence store — atomic conditional commit + idempotency
 * (issue #28 实现范围 3; docs/VOICE_RUNTIME.md §5; ADR-002).
 *
 * The store is the SINGLE TRUSTED OWNER of the per-session monotonic epoch
 * and of every turn's state. Clients can trigger behavior but can never
 * name the next epoch: every mutation re-derives it from the trusted
 * counter, and any request that CLAIMS an epoch must present the current
 * trusted one (`epoch_forged` / `stale_turn_rejected` otherwise).
 *
 * The issue's forbidden pattern — an unsafe SELECT-then-separate-INSERT
 * implementation — is structurally impossible here:
 *
 * - The in-memory implementation performs validation AND commit inside one
 *   SYNCHRONOUS critical section (no `await` between check and write), the
 *   single-threaded analog of `BEGIN IMMEDIATE`. Internal rejections unwind
 *   via `VoiceRejection` BEFORE the first mutation, so a rejected operation
 *   changes nothing; malformed input throws a structured parse failure
 *   (the same fail-closed parser discipline as every other domain module).
 * - The SQLite adapter (lib/server/voice-turn-sqlite-store.ts) implements
 *   the SAME port with real `BEGIN IMMEDIATE` transactions that validate
 *   session ownership, epoch, identity and the idempotency key inside ONE
 *   transaction.
 *
 * Session ownership: a session is bound to one (ownerActorId,
 * conversationId) pair. Turn ids are globally unique; an operation that
 * references a turn under a different session key is rejected with
 * `cross_session_rejected` (no state change, nothing echoed).
 *
 * Restart: `exportState`/`restoreState` provide the process-restart port.
 * Restore is fail-closed (every record re-validated; forged snapshots with
 * turn epochs above the session epoch are rejected) and keeps terminal
 * states terminal, so a cancelled turn can never be resurrected and the
 * epoch stays monotonic across restarts.
 *
 * PRIVACY: session/turn/queue records carry ids, epochs, states, result
 * codes and bounded timestamps only. The caller-computed content-free
 * fingerprint is the only content-derived value and is a hex digest —
 * never audio, text or any other payload (schema-tested).
 *
 * This module must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { isValidContractId, type ContractIdKind, type ContractProblem } from "../contract/core.ts";
import {
  isLegalVoiceTurnTransition,
  isVoiceFingerprint,
  isVoiceIdempotencyKey,
  isValidVoiceEpoch,
  isVoiceTurnState,
  VOICE_SETTLE_OUTCOMES,
  VOICE_TERMINAL_TURN_STATES,
  VOICE_WRITE_KINDS,
  failVoiceParse,
  validateVoiceRefs,
  type VoiceSessionRecord,
  type VoiceSettleOutcome,
  type VoiceTurnRecord,
  type VoiceTurnState,
  type VoiceWriteKind,
} from "./schema.ts";

// ---------------------------------------------------------------------------
// Store format
// ---------------------------------------------------------------------------

export const VOICE_FENCE_STORE_FORMAT = "lumithink.voice-fence-store/v1" as const;

/** Bounded TTS queue per session (backpressure; VOICE_RUNTIME §6). */
export const VOICE_MAX_TTS_QUEUE_ITEMS = 64;

/** Structural rejection codes shared by the store operations. */
export type VoiceStoreRejectionCode =
  | "session_unknown"
  | "session_conflict"
  | "turn_unknown"
  | "cross_session_rejected"
  | "epoch_forged"
  | "stale_turn_rejected"
  | "turn_terminal"
  | "cancel_already_active"
  | "turn_state_transition_illegal"
  | "idempotency_conflict";

/**
 * Marker thrown inside critical sections; each operation catches it and
 * maps it to its enumerated failure result WITHOUT any mutation applied.
 */
export class VoiceRejection extends Error {
  readonly code: VoiceStoreRejectionCode;
  constructor(code: VoiceStoreRejectionCode) {
    super(code);
    this.name = "VoiceRejection";
    this.code = code;
  }
}

/**
 * Run one critical section: map an internal `VoiceRejection` to the
 * operation's enumerated `{ ok: false, code }` failure result; rethrow
 * parse failures and anything unexpected. The single cast is the
 * documented invariant that every code an operation can throw is part of
 * its declared result union.
 */
function attempt<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof VoiceRejection) {
      return { ok: false, code: error.code } as T;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

export type VoiceOpenSessionResult =
  | { readonly ok: true; readonly created: boolean; readonly epoch: number }
  | { readonly ok: false; readonly code: "session_conflict" };

export type VoiceRegisterPromptResult =
  | {
      readonly ok: true;
      /** True when an earlier prompt with the same idempotency key replays. */
      readonly replayed: boolean;
      readonly turn: Readonly<VoiceTurnRecord>;
    }
  | {
      readonly ok: false;
      readonly code: "session_unknown" | "idempotency_conflict";
    };

export type VoiceCancelTurnResult =
  | {
      readonly ok: true;
      /** The NEW trusted epoch after the atomic bump. */
      readonly epoch: number;
      readonly previousEpoch: number;
      /** Non-terminal turns of the old epoch flipped to CANCELLING. */
      readonly fencedTurnIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code:
        | "session_unknown"
        | "turn_unknown"
        | "cross_session_rejected"
        | "turn_terminal"
        | "cancel_already_active"
        | "stale_turn_rejected";
    };

export type VoicePumpResult =
  | {
      readonly ok: true;
      /** Turn moved CREATED → QUEUED (oldest current-epoch waiter). */
      readonly enqueuedTurnId: string | null;
      /** Turn moved QUEUED → RUNNING (only when no old task is unstopped). */
      readonly dispatchedTurnId: string | null;
      /** Present when the dispatch gate blocked on a RUNNING/CANCELLING turn. */
      readonly busyTurnId: string | null;
    }
  | { readonly ok: false; readonly code: "session_unknown" };

export type VoiceSettleResult =
  | { readonly ok: true; readonly turn: Readonly<VoiceTurnRecord> }
  | {
      readonly ok: false;
      readonly code:
        | "session_unknown"
        | "turn_unknown"
        | "cross_session_rejected"
        | "stale_turn_rejected"
        | "turn_state_transition_illegal";
    };

export type VoiceFenceOutputResult =
  | { readonly ok: true; readonly allowed: true; readonly ttsItemId: string | null }
  | {
      readonly ok: false;
      readonly code:
        | "session_unknown"
        | "turn_unknown"
        | "cross_session_rejected"
        | "epoch_forged"
        | "stale_turn_rejected"
        | "turn_terminal"
        | "turn_state_transition_illegal";
    };

export type VoiceFenceWriteResult =
  | {
      readonly ok: true;
      /** True when the same idempotency key + fingerprint replayed (no re-commit). */
      readonly replayed: boolean;
      readonly turnId: string;
      readonly epoch: number;
      readonly committedAtMs: number;
    }
  | {
      readonly ok: false;
      readonly code:
        | "session_unknown"
        | "turn_unknown"
        | "cross_session_rejected"
        | "epoch_forged"
        | "stale_turn_rejected"
        | "turn_terminal"
        | "turn_state_transition_illegal"
        | "idempotency_conflict";
    };

export type VoiceDrainTtsResult =
  | {
      readonly ok: true;
      /** Only items whose epoch matches the CURRENT trusted epoch survive. */
      readonly deliverable: readonly { readonly itemId: string; readonly turnId: string; readonly epoch: number }[];
      /** Stale-epoch items dropped by the drain (never deliverable later). */
      readonly droppedStale: number;
    }
  | { readonly ok: false; readonly code: "session_unknown" };

export type VoiceSweepTimeoutsResult =
  | { readonly ok: true; readonly timedOutTurnIds: readonly string[] }
  | { readonly ok: false; readonly code: "session_unknown" };

/**
 * The store port. Every mutating method is ONE atomic operation (sync
 * critical section here; `BEGIN IMMEDIATE` transaction in the SQLite
 * adapter) that validates session ownership, epoch, identity and the
 * idempotency key before anything is written.
 */
export interface VoiceFenceStore {
  openSession(refs: {
    readonly sessionKey: string;
    readonly conversationId: string;
    readonly ownerActorId: string;
    readonly nowMs: number;
  }): VoiceOpenSessionResult;

  /**
   * Receive one prompt (new ASR). Runs in parallel with an in-flight
   * cancellation: the turn is born CREATED at the CURRENT epoch, but the
   * scheduler only DISPATCHES it once the old task has stopped (pump).
   * Same idempotency key + fingerprint replays the ORIGINAL turn; the same
   * key with a different fingerprint is `idempotency_conflict`.
   */
  registerPrompt(refs: {
    readonly sessionKey: string;
    readonly turnId: string;
    readonly traceId: string | null;
    readonly idempotencyKey: string | null;
    readonly fingerprint: string | null;
    readonly nowMs: number;
  }): VoiceRegisterPromptResult;

  /**
   * ONE effective interruption (issue #28: 首先原子递增可信存储的 epoch):
   * inside a single atomic step the trusted epoch is bumped and every
   * non-terminal turn of the old epoch is flipped to CANCELLING — its
   * text/TTS/audio/candidate-memory/domain-write permissions are revoked
   * at the same instant. Duplicate cancels and stale-epoch cancels are
   * fence-rejected WITHOUT a second bump.
   */
  cancelTurn(refs: {
    readonly sessionKey: string;
    readonly turnId: string;
    readonly nowMs: number;
  }): VoiceCancelTurnResult;

  /**
   * Scheduler pump: enqueue the oldest current-epoch CREATED turn, then —
   * only when no RUNNING/CANCELLING turn holds the agent — dispatch the
   * oldest QUEUED one. New prompts may arrive at any time; the dispatch
   * gate is what keeps a new prompt off the Agent Loop until the old task
   * stopped (docs/VOICE_RUNTIME.md §4 step 5).
   */
  pumpScheduler(refs: { readonly sessionKey: string; readonly nowMs: number }): VoicePumpResult;

  settleTurn(refs: {
    readonly sessionKey: string;
    readonly turnId: string;
    readonly outcome: VoiceSettleOutcome;
    readonly nowMs: number;
  }): VoiceSettleResult;

  /**
   * Ephemeral output fence (text delta / TTS enqueue / audio send). The
   * request must present the CURRENT trusted epoch and the turn must be
   * RUNNING — a late delta or TTS sentence for a fenced epoch is rejected
   * here, not silently dropped downstream. `tts_queue` appends a bounded
   * queue item stamped with the epoch; `drainTtsQueue` delivers only
   * current-epoch items.
   */
  fenceOutput(refs: {
    readonly sessionKey: string;
    readonly turnId: string;
    readonly epoch: number;
    readonly kind: "text_delta" | "tts_queue" | "audio_send";
    readonly ttsItemId: string;
    readonly nowMs: number;
  }): VoiceFenceOutputResult;

  /**
   * THE atomic conditional commit for downstream side effects (issue #28:
   * 记忆事务竞态). Ownership + claimed epoch + turn identity + turn state +
   * the idempotency key are all validated, and the write is committed,
   * inside one critical section/transaction. Same key + same fingerprint
   * replays; same key + different fingerprint is `idempotency_conflict`.
   */
  fenceWrite(refs: {
    readonly sessionKey: string;
    readonly turnId: string;
    readonly epoch: number;
    readonly kind: VoiceWriteKind;
    readonly idempotencyKey: string;
    readonly fingerprint: string;
    readonly nowMs: number;
  }): VoiceFenceWriteResult;

  /**
   * TTS send-side second fence (VOICE_RUNTIME §5: 音频发送器二次栅栏校验):
   * delivers only items whose epoch matches the CURRENT trusted epoch and
   * permanently drops stale ones.
   */
  drainTtsQueue(refs: { readonly sessionKey: string; readonly nowMs: number }): VoiceDrainTtsResult;

  /** RUNNING/CANCELLING turns older than the budget → TIMED_OUT (fenced). */
  sweepTimeouts(refs: {
    readonly sessionKey: string;
    readonly budgetMs: number;
    readonly nowMs: number;
  }): VoiceSweepTimeoutsResult;

  // Read-only surfaces (audit/observability; no content).
  currentEpoch(sessionKey: string): number | null;
  describeSession(sessionKey: string): Readonly<VoiceSessionRecord> | null;
  describeTurn(sessionKey: string, turnId: string): Readonly<VoiceTurnRecord> | null;
  listTurns(sessionKey: string): readonly Readonly<VoiceTurnRecord>[];
  ttsQueueDepth(sessionKey: string): number;

  /** Process-restart port: content-free, deterministic JSON-able snapshot. */
  exportState(): {
    readonly format: typeof VOICE_FENCE_STORE_FORMAT;
    readonly sessions: readonly Readonly<VoiceSessionRecord>[];
    readonly turns: readonly Readonly<VoiceTurnRecord>[];
    /**
     * The FULL idempotency ledger (prompt keys AND committed downstream
     * write keys). Without it, a restart would forget committed write keys
     * and a replayed write could execute TWICE across the restart — the
     * exact duplicate-side-effect hole the issue forbids.
     */
    readonly idempotency: readonly {
      readonly sessionKey: string;
      readonly key: string;
      readonly turnId: string;
      readonly fingerprint: string;
    }[];
  };

  /** Fail-closed restore of an exported snapshot (restart monotonicity). */
  restoreState(raw: unknown): { readonly restoredSessions: number; readonly restoredTurns: number };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isValidStoreId(kind: ContractIdKind, value: unknown): value is string {
  return typeof value === "string" && isValidContractId(kind, value);
}

function assertNowMs(nowMs: number): void {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs) || nowMs < 0) {
    failVoiceParse("nowMs", "nowMs must be a non-negative finite number.");
  }
}

/**
 * Validate the id-shaped refs of one operation. Structured parse failure;
 * submitted values are never echoed.
 */
function assertRefs(refs: {
  sessionKey?: unknown;
  turnId?: unknown;
  traceId?: unknown;
  actorId?: unknown;
  conversationId?: unknown;
}): void {
  const problems: ContractProblem[] = [];
  validateVoiceRefs(refs, problems);
  if (problems.length > 0) {
    failVoiceParse("refs", "voice refs must match the contract id grammars.");
  }
}

/** Deterministic order for iteration: creation order, then turn id. */
function turnOrder(a: VoiceTurnRecord, b: VoiceTurnRecord): number {
  if (a.createdAtMs !== b.createdAtMs) {
    return a.createdAtMs - b.createdAtMs;
  }
  return a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : 0;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export interface InMemoryVoiceFenceStoreOptions {
  /** TTS queue capacity (default VOICE_MAX_TTS_QUEUE_ITEMS). */
  readonly ttsQueueCapacity?: number;
}

/**
 * Create the in-memory trusted fence store. ATOMICITY INVARIANT: every
 * mutating method runs its checks and mutations inside ONE synchronous
 * critical section (the in-memory analog of `BEGIN IMMEDIATE`); a
 * `VoiceRejection` unwinds before the first mutation, so a rejected
 * operation changes nothing.
 */
export function createInMemoryVoiceFenceStore(
  options: InMemoryVoiceFenceStoreOptions = {},
): VoiceFenceStore {
  const ttsCapacity = Math.max(
    1,
    Math.min(options.ttsQueueCapacity ?? VOICE_MAX_TTS_QUEUE_ITEMS, 4096),
  );

  /** sessionKey → session record. */
  const sessions = new Map<string, VoiceSessionRecord>();
  /** sessionKey → (turnId → turn record). */
  const turnsBySession = new Map<string, Map<string, VoiceTurnRecord>>();
  /** sessionKey → (idemKey → { turnId, fingerprint }). */
  const idempotency = new Map<string, Map<string, { readonly turnId: string; readonly fingerprint: string }>>();
  /** sessionKey → queued TTS items (bounded; FIFO; epoch-stamped). */
  const ttsQueues = new Map<string, { itemId: string; turnId: string; epoch: number; queuedAtMs: number }[]>();
  /** turnId → sessionKey (globally unique; cross-session detector). */
  const globalTurnIndex = new Map<string, string>();

  function sessionOrThrow(sessionKey: string): VoiceSessionRecord {
    const session = sessions.get(sessionKey);
    if (session === undefined) {
      throw new VoiceRejection("session_unknown");
    }
    return session;
  }

  function turnOrThrow(sessionKey: string, turnId: string): VoiceTurnRecord {
    const scoped = turnsBySession.get(sessionKey);
    if (scoped !== undefined) {
      const turn = scoped.get(turnId);
      if (turn !== undefined) {
        return turn;
      }
    }
    if (globalTurnIndex.has(turnId)) {
      // A real turn presented under the wrong session key.
      throw new VoiceRejection("cross_session_rejected");
    }
    throw new VoiceRejection("turn_unknown");
  }

  function putTurn(turn: VoiceTurnRecord): void {
    const scoped = turnsBySession.get(turn.sessionKey);
    if (scoped === undefined) {
      throw new VoiceRejection("session_unknown");
    }
    scoped.set(turn.turnId, turn);
    globalTurnIndex.set(turn.turnId, turn.sessionKey);
  }

  function assertValidIdempotencyPair(
    idempotencyKey: string | null,
    fingerprint: string | null,
  ): void {
    if (idempotencyKey !== null && !isVoiceIdempotencyKey(idempotencyKey)) {
      failVoiceParse("idempotencyKey", "idempotencyKey must match the bounded key grammar.");
    }
    if (fingerprint !== null && !isVoiceFingerprint(fingerprint)) {
      failVoiceParse("fingerprint", "fingerprint must be a hex digest (content never crosses this boundary).");
    }
    if ((idempotencyKey === null) !== (fingerprint === null)) {
      failVoiceParse("idempotencyKey", "an idempotency key and its fingerprint are always provided together.");
    }
  }

  // Annotated first so every method below receives its contextual
  // parameter types from the port (a generic Object.freeze call in the
  // expression would break the inference chain).
  const storeImpl: VoiceFenceStore = {
    openSession(refs): VoiceOpenSessionResult {
      assertRefs(refs);
      assertNowMs(refs.nowMs);
      const existing = sessions.get(refs.sessionKey);
      if (existing !== undefined) {
        // Session ownership: the same key with a different owner or
        // conversation binding is a conflict, never a silent rebind.
        if (existing.ownerActorId !== refs.ownerActorId || existing.conversationId !== refs.conversationId) {
          return { ok: false, code: "session_conflict" };
        }
        return { ok: true, created: false, epoch: existing.epoch };
      }
      sessions.set(refs.sessionKey, {
        sessionKey: refs.sessionKey,
        conversationId: refs.conversationId,
        ownerActorId: refs.ownerActorId,
        createdAtMs: refs.nowMs,
        // The trusted epoch starts at 1; only this store ever advances it.
        epoch: 1,
      });
      turnsBySession.set(refs.sessionKey, new Map());
      idempotency.set(refs.sessionKey, new Map());
      return { ok: true, created: true, epoch: 1 };
    },

    registerPrompt(refs): VoiceRegisterPromptResult {
      return attempt(() => {
        assertRefs({ sessionKey: refs.sessionKey, turnId: refs.turnId, traceId: refs.traceId });
        assertNowMs(refs.nowMs);
        assertValidIdempotencyPair(refs.idempotencyKey, refs.fingerprint);
        const session = sessionOrThrow(refs.sessionKey);
        if (globalTurnIndex.has(refs.turnId)) {
          failVoiceParse("turnId", "turnId must be globally unique.");
        }

        // Idempotent replay (same key + same fingerprint) returns the
        // ORIGINAL turn; nothing re-executes and no new turn is minted.
        if (refs.idempotencyKey !== null) {
          const ledger = idempotency.get(refs.sessionKey) as Map<
            string,
            { readonly turnId: string; readonly fingerprint: string }
          >;
          const stored = ledger.get(refs.idempotencyKey);
          if (stored !== undefined) {
            if (stored.fingerprint !== refs.fingerprint) {
              return { ok: false, code: "idempotency_conflict" as const };
            }
            return { ok: true, replayed: true, turn: turnOrThrow(refs.sessionKey, stored.turnId) };
          }
        }

        const turn: VoiceTurnRecord = {
          turnId: refs.turnId,
          sessionKey: refs.sessionKey,
          traceId: refs.traceId,
          // The store stamps the CURRENT trusted epoch; the client can
          // never name one (issue #28: 客户端只能触发行为不能指定下一代数).
          epoch: session.epoch,
          state: "CREATED",
          idempotencyKey: refs.idempotencyKey,
          fingerprint: refs.fingerprint,
          createdAtMs: refs.nowMs,
          startedAtMs: null,
          settledAtMs: null,
        };
        putTurn(turn);
        if (refs.idempotencyKey !== null) {
          const ledger = idempotency.get(refs.sessionKey) as Map<
            string,
            { readonly turnId: string; readonly fingerprint: string }
          >;
          ledger.set(refs.idempotencyKey, { turnId: refs.turnId, fingerprint: refs.fingerprint as string });
        }
        return { ok: true, replayed: false, turn };
      });
    },

    cancelTurn(refs): VoiceCancelTurnResult {
      return attempt(() => {
        assertRefs({ sessionKey: refs.sessionKey, turnId: refs.turnId });
        assertNowMs(refs.nowMs);
        const session = sessionOrThrow(refs.sessionKey);
        const turn = turnOrThrow(refs.sessionKey, refs.turnId);

        // Fence rejections FIRST — they must never bump the epoch.
        if ((VOICE_TERMINAL_TURN_STATES as readonly string[]).includes(turn.state)) {
          return { ok: false as const, code: "turn_terminal" as const };
        }
        if (turn.state === "CANCELLING") {
          return { ok: false as const, code: "cancel_already_active" as const };
        }
        if (turn.epoch !== session.epoch) {
          return { ok: false as const, code: "stale_turn_rejected" as const };
        }

        // ONE atomic step: bump the trusted epoch and flip every
        // non-terminal turn of the old epoch to CANCELLING (revoke text /
        // TTS / audio / candidate-memory / domain-write permissions).
        const previousEpoch = session.epoch;
        const newEpoch = previousEpoch + 1;
        sessions.set(refs.sessionKey, { ...session, epoch: newEpoch });
        const scoped = turnsBySession.get(refs.sessionKey) as Map<string, VoiceTurnRecord>;
        const fencedTurnIds: string[] = [];
        for (const existing of [...scoped.values()].sort(turnOrder)) {
          if ((VOICE_TERMINAL_TURN_STATES as readonly string[]).includes(existing.state)) {
            continue;
          }
          scoped.set(existing.turnId, { ...existing, state: "CANCELLING" });
          fencedTurnIds.push(existing.turnId);
        }
        return { ok: true, epoch: newEpoch, previousEpoch, fencedTurnIds: Object.freeze(fencedTurnIds) };
      });
    },

    pumpScheduler(refs): VoicePumpResult {
      return attempt(() => {
        assertRefs({ sessionKey: refs.sessionKey });
        assertNowMs(refs.nowMs);
        const session = sessionOrThrow(refs.sessionKey);
        const scoped = turnsBySession.get(refs.sessionKey) as Map<string, VoiceTurnRecord>;
        const busy = [...scoped.values()]
          .sort(turnOrder)
          .find((turn) => turn.state === "RUNNING" || turn.state === "CANCELLING");

        let enqueuedTurnId: string | null = null;
        const enqueueCandidate = [...scoped.values()]
          .sort(turnOrder)
          .find((turn) => turn.state === "CREATED" && turn.epoch === session.epoch);
        if (enqueueCandidate !== undefined) {
          scoped.set(enqueueCandidate.turnId, { ...enqueueCandidate, state: "QUEUED" });
          enqueuedTurnId = enqueueCandidate.turnId;
        }

        if (busy !== undefined) {
          // Old task not stopped yet: the new prompt stays queued and
          // never touches the Agent Loop (VOICE_RUNTIME §4 step 5).
          return { ok: true, enqueuedTurnId, dispatchedTurnId: null, busyTurnId: busy.turnId };
        }

        const queued = [...scoped.values()]
          .sort(turnOrder)
          .find((turn) => turn.state === "QUEUED" && turn.epoch === session.epoch);
        if (queued === undefined) {
          return { ok: true, enqueuedTurnId, dispatchedTurnId: null, busyTurnId: null };
        }
        scoped.set(queued.turnId, { ...queued, state: "RUNNING", startedAtMs: refs.nowMs });
        return { ok: true, enqueuedTurnId, dispatchedTurnId: queued.turnId, busyTurnId: null };
      });
    },

    settleTurn(refs): VoiceSettleResult {
      return attempt(() => {
        assertRefs({ sessionKey: refs.sessionKey, turnId: refs.turnId });
        assertNowMs(refs.nowMs);
        if (!(VOICE_SETTLE_OUTCOMES as readonly string[]).includes(refs.outcome)) {
          failVoiceParse("outcome", "outcome must be a registered settle outcome.");
        }
        const session = sessionOrThrow(refs.sessionKey);
        const turn = turnOrThrow(refs.sessionKey, refs.turnId);

        // A fenced (old-epoch) turn can never complete: completion would
        // resurrect output its epoch already lost the right to emit.
        if (turn.epoch !== session.epoch && refs.outcome === "COMPLETED") {
          throw new VoiceRejection("stale_turn_rejected");
        }
        if (!isLegalVoiceTurnTransition(turn.state, refs.outcome)) {
          throw new VoiceRejection("turn_state_transition_illegal");
        }
        const settled: VoiceTurnRecord = { ...turn, state: refs.outcome, settledAtMs: refs.nowMs };
        putTurn(settled);
        return { ok: true, turn: settled };
      });
    },

    fenceOutput(refs): VoiceFenceOutputResult {
      return attempt(() => {
        assertRefs({ sessionKey: refs.sessionKey, turnId: refs.turnId });
        assertNowMs(refs.nowMs);
        if (!isValidVoiceEpoch(refs.epoch)) {
          failVoiceParse("epoch", "epoch must be a positive integer.");
        }
        if (refs.kind !== "text_delta" && refs.kind !== "tts_queue" && refs.kind !== "audio_send") {
          failVoiceParse("kind", "kind must be a registered output kind.");
        }
        const session = sessionOrThrow(refs.sessionKey);
        const turn = turnOrThrow(refs.sessionKey, refs.turnId);

        if (refs.epoch !== session.epoch) {
          throw new VoiceRejection(refs.epoch > session.epoch ? "epoch_forged" : "stale_turn_rejected");
        }
        if (turn.epoch !== session.epoch) {
          throw new VoiceRejection("stale_turn_rejected");
        }
        if ((VOICE_TERMINAL_TURN_STATES as readonly string[]).includes(turn.state)) {
          throw new VoiceRejection("turn_terminal");
        }
        if (turn.state !== "RUNNING") {
          throw new VoiceRejection("turn_state_transition_illegal");
        }
        if (refs.kind === "tts_queue") {
          const q = ttsQueues.get(refs.sessionKey) ?? [];
          if (q.length >= ttsCapacity) {
            // Backpressure: drop the OLDEST item; the queue never grows
            // unbounded (VOICE_RUNTIME §6).
            q.shift();
          }
          q.push({ itemId: refs.ttsItemId, turnId: refs.turnId, epoch: refs.epoch, queuedAtMs: refs.nowMs });
          ttsQueues.set(refs.sessionKey, q);
          return { ok: true, allowed: true, ttsItemId: refs.ttsItemId };
        }
        return { ok: true, allowed: true, ttsItemId: null };
      });
    },

    fenceWrite(refs): VoiceFenceWriteResult {
      return attempt(() => {
        assertRefs({ sessionKey: refs.sessionKey, turnId: refs.turnId });
        assertNowMs(refs.nowMs);
        if (!isValidVoiceEpoch(refs.epoch)) {
          failVoiceParse("epoch", "epoch must be a positive integer.");
        }
        if (!(VOICE_WRITE_KINDS as readonly string[]).includes(refs.kind)) {
          failVoiceParse("kind", "kind must be a registered write kind.");
        }
        if (!isVoiceIdempotencyKey(refs.idempotencyKey)) {
          failVoiceParse("idempotencyKey", "idempotencyKey must match the bounded key grammar.");
        }
        if (!isVoiceFingerprint(refs.fingerprint)) {
          failVoiceParse("fingerprint", "fingerprint must be a hex digest (content never crosses this boundary).");
        }
        const session = sessionOrThrow(refs.sessionKey);
        const turn = turnOrThrow(refs.sessionKey, refs.turnId);

        if (refs.epoch !== session.epoch) {
          throw new VoiceRejection(refs.epoch > session.epoch ? "epoch_forged" : "stale_turn_rejected");
        }
        if (turn.epoch !== session.epoch) {
          throw new VoiceRejection("stale_turn_rejected");
        }
        if ((VOICE_TERMINAL_TURN_STATES as readonly string[]).includes(turn.state)) {
          throw new VoiceRejection("turn_terminal");
        }
        if (turn.state !== "RUNNING") {
          throw new VoiceRejection("turn_state_transition_illegal");
        }
        // Idempotency ledger (scoped per session): same key + same
        // fingerprint replays; same key + different fingerprint conflicts.
        const ledger = idempotency.get(refs.sessionKey) as Map<
          string,
          { readonly turnId: string; readonly fingerprint: string }
        >;
        const stored = ledger.get(refs.idempotencyKey);
        if (stored !== undefined) {
          if (stored.fingerprint !== refs.fingerprint) {
            throw new VoiceRejection("idempotency_conflict");
          }
          return { ok: true, replayed: true, turnId: stored.turnId, epoch: refs.epoch, committedAtMs: refs.nowMs };
        }
        ledger.set(refs.idempotencyKey, { turnId: refs.turnId, fingerprint: refs.fingerprint });
        return { ok: true, replayed: false, turnId: refs.turnId, epoch: refs.epoch, committedAtMs: refs.nowMs };
      });
    },

    drainTtsQueue(refs): VoiceDrainTtsResult {
      return attempt(() => {
        assertRefs({ sessionKey: refs.sessionKey });
        assertNowMs(refs.nowMs);
        const session = sessionOrThrow(refs.sessionKey);
        const q = ttsQueues.get(refs.sessionKey) ?? [];
        const deliverable: { itemId: string; turnId: string; epoch: number }[] = [];
        let droppedStale = 0;
        for (const item of q) {
          if (item.epoch === session.epoch) {
            deliverable.push({ itemId: item.itemId, turnId: item.turnId, epoch: item.epoch });
          } else {
            droppedStale += 1;
          }
        }
        // Drained items leave the queue either way; stale ones can never
        // be delivered by a later drain either (permanently dropped).
        ttsQueues.set(refs.sessionKey, []);
        return { ok: true, deliverable: Object.freeze(deliverable), droppedStale };
      });
    },

    sweepTimeouts(refs): VoiceSweepTimeoutsResult {
      return attempt(() => {
        assertRefs({ sessionKey: refs.sessionKey });
        assertNowMs(refs.nowMs);
        if (typeof refs.budgetMs !== "number" || !Number.isFinite(refs.budgetMs) || refs.budgetMs < 0) {
          failVoiceParse("budgetMs", "budgetMs must be a non-negative finite number.");
        }
        sessionOrThrow(refs.sessionKey);
        const scoped = turnsBySession.get(refs.sessionKey) as Map<string, VoiceTurnRecord>;
        const timedOutTurnIds: string[] = [];
        for (const turn of [...scoped.values()].sort(turnOrder)) {
          if (turn.state !== "RUNNING" && turn.state !== "CANCELLING") {
            continue;
          }
          const startedAt = turn.startedAtMs ?? turn.createdAtMs;
          if (refs.nowMs - startedAt > refs.budgetMs) {
            scoped.set(turn.turnId, { ...turn, state: "TIMED_OUT", settledAtMs: refs.nowMs });
            timedOutTurnIds.push(turn.turnId);
          }
        }
        return { ok: true, timedOutTurnIds: Object.freeze(timedOutTurnIds) };
      });
    },

    currentEpoch(sessionKey: string): number | null {
      return sessions.get(sessionKey)?.epoch ?? null;
    },

    describeSession(sessionKey: string): Readonly<VoiceSessionRecord> | null {
      return sessions.get(sessionKey) ?? null;
    },

    describeTurn(sessionKey: string, turnId: string): Readonly<VoiceTurnRecord> | null {
      return turnsBySession.get(sessionKey)?.get(turnId) ?? null;
    },

    listTurns(sessionKey: string): readonly Readonly<VoiceTurnRecord>[] {
      const scoped = turnsBySession.get(sessionKey);
      return Object.freeze(scoped === undefined ? [] : [...scoped.values()].sort(turnOrder));
    },

    ttsQueueDepth(sessionKey: string): number {
      return ttsQueues.get(sessionKey)?.length ?? 0;
    },

    exportState() {
      const ledgerEntries: { sessionKey: string; key: string; turnId: string; fingerprint: string }[] = [];
      for (const [sessionKey, ledger] of idempotency) {
        for (const [key, entry] of ledger) {
          ledgerEntries.push({ sessionKey, key, turnId: entry.turnId, fingerprint: entry.fingerprint });
        }
      }
      ledgerEntries.sort(
        (a, b) =>
          a.sessionKey.localeCompare(b.sessionKey) ||
          a.key.localeCompare(b.key) ||
          (a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : 0),
      );
      return {
        format: VOICE_FENCE_STORE_FORMAT,
        sessions: Object.freeze(
          [...sessions.values()].sort((a, b) =>
            a.sessionKey < b.sessionKey ? -1 : a.sessionKey > b.sessionKey ? 1 : 0,
          ),
        ),
        turns: Object.freeze(
          [...globalTurnIndex.keys()]
            .map((turnId) => {
              const sessionKey = globalTurnIndex.get(turnId) as string;
              return (turnsBySession.get(sessionKey) as Map<string, VoiceTurnRecord>).get(
                turnId,
              ) as VoiceTurnRecord;
            })
            .sort((a, b) => (a.turnId < b.turnId ? -1 : a.turnId > b.turnId ? 1 : 0)),
        ),
        idempotency: Object.freeze(ledgerEntries),
      };
    },

    restoreState(raw: unknown): { readonly restoredSessions: number; readonly restoredTurns: number } {
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        failVoiceParse("snapshot", "snapshot must be an object.");
      }
      const record = raw as Record<string, unknown>;
      if (record.format !== VOICE_FENCE_STORE_FORMAT) {
        failVoiceParse("format", "snapshot format is not supported.");
      }
      if (!Array.isArray(record.sessions) || !Array.isArray(record.turns)) {
        failVoiceParse("sessions/turns", "snapshot must carry session and turn arrays.");
      }
      // Parse EVERYTHING first, commit only when the whole snapshot is
      // consistent (fail-closed; a rejected restore changes nothing).
      const restoredSessions = new Map<string, VoiceSessionRecord>();
      for (const rawSession of record.sessions) {
        const session = parseSnapshotSession(rawSession);
        restoredSessions.set(session.sessionKey, session);
      }
      const restoredTurns = new Map<string, VoiceTurnRecord>();
      for (const rawTurn of record.turns) {
        const turn = parseSnapshotTurn(rawTurn);
        const owningSession = restoredSessions.get(turn.sessionKey);
        if (owningSession === undefined) {
          failVoiceParse("turns[].sessionKey", "every restored turn must belong to a restored session.");
        }
        if (turn.epoch > (owningSession as VoiceSessionRecord).epoch) {
          // A turn can never outlive its session's trusted epoch: a forged
          // snapshot claiming a future epoch is rejected wholesale.
          failVoiceParse("turns[].epoch", "restored turn epoch exceeds the session epoch.");
        }
        restoredTurns.set(turn.turnId, turn);
      }
      // Idempotency ledger: the snapshot section is authoritative when
      // present (it carries committed WRITE keys too); older snapshots
      // derive the prompt keys from the turn records.
      const restoredLedger = new Map<string, Map<string, { turnId: string; fingerprint: string }>>();
      if (record.idempotency !== undefined) {
        if (!Array.isArray(record.idempotency)) {
          failVoiceParse("idempotency", "snapshot idempotency must be an array.");
        }
        for (const rawEntry of record.idempotency) {
          const entry = parseSnapshotLedgerEntry(rawEntry);
          if (!restoredSessions.has(entry.sessionKey)) {
            failVoiceParse("idempotency[].sessionKey", "every ledger entry must belong to a restored session.");
          }
          const turn = restoredTurns.get(entry.turnId);
          if (turn === undefined || turn.sessionKey !== entry.sessionKey) {
            failVoiceParse("idempotency[].turnId", "every ledger entry must reference a turn of its own session.");
          }
          let ledger = restoredLedger.get(entry.sessionKey);
          if (ledger === undefined) {
            ledger = new Map();
            restoredLedger.set(entry.sessionKey, ledger);
          }
          ledger.set(entry.key, { turnId: entry.turnId, fingerprint: entry.fingerprint });
        }
      } else {
        for (const turn of restoredTurns.values()) {
          if (turn.idempotencyKey !== null && turn.fingerprint !== null) {
            let ledger = restoredLedger.get(turn.sessionKey);
            if (ledger === undefined) {
              ledger = new Map();
              restoredLedger.set(turn.sessionKey, ledger);
            }
            ledger.set(turn.idempotencyKey, { turnId: turn.turnId, fingerprint: turn.fingerprint });
          }
        }
      }
      for (const session of restoredSessions.values()) {
        sessions.set(session.sessionKey, session);
        turnsBySession.set(session.sessionKey, new Map());
        idempotency.set(session.sessionKey, restoredLedger.get(session.sessionKey) ?? new Map());
      }
      for (const turn of restoredTurns.values()) {
        putTurn(turn);
      }
      return { restoredSessions: restoredSessions.size, restoredTurns: restoredTurns.size };
    },
  };
  return Object.freeze(storeImpl);
}

// ---------------------------------------------------------------------------
// Snapshot parsing (fail-closed restore)
// ---------------------------------------------------------------------------

/**
 * Parse + re-validate one snapshot session entry. Exported so the SQLite
 * adapter's `restoreState` reuses the EXACT same fail-closed validation
 * (one snapshot grammar, two storage engines).
 */
export function parseSnapshotSession(raw: unknown): VoiceSessionRecord {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    failVoiceParse("sessions[]", "session snapshot entry must be an object.");
  }
  const record = raw as Record<string, unknown>;
  for (const key of ["sessionKey", "conversationId", "ownerActorId", "createdAtMs", "epoch"]) {
    if (!(key in record)) {
      failVoiceParse(`sessions[].${key}`, "session snapshot entry is missing a required field.");
    }
  }
  const problems: ContractProblem[] = [];
  validateVoiceRefs(
    { sessionKey: record.sessionKey, conversationId: record.conversationId, actorId: record.ownerActorId },
    problems,
  );
  if (problems.length > 0) {
    failVoiceParse("sessions[]", "session snapshot ids must match the contract grammars.");
  }
  if (typeof record.createdAtMs !== "number" || !Number.isFinite(record.createdAtMs)) {
    failVoiceParse("sessions[].createdAtMs", "createdAtMs must be a finite number.");
  }
  if (!isValidVoiceEpoch(record.epoch)) {
    failVoiceParse("sessions[].epoch", "epoch must be a positive integer.");
  }
  return {
    sessionKey: record.sessionKey as string,
    conversationId: record.conversationId as string,
    ownerActorId: record.ownerActorId as string,
    createdAtMs: record.createdAtMs,
    epoch: record.epoch,
  };
}

/**
 * Parse + re-validate one snapshot turn entry (exported for the SQLite
 * adapter's restore path; same rationale as `parseSnapshotSession`).
 */
/**
 * Parse + re-validate one snapshot idempotency-ledger entry (exported for
 * the SQLite adapter's restore path). The ledger entry shape is
 * content-free: session/turn ids, a bounded key and a hex digest.
 */
export function parseSnapshotLedgerEntry(raw: unknown): {
  sessionKey: string;
  key: string;
  turnId: string;
  fingerprint: string;
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    failVoiceParse("idempotency[]", "ledger snapshot entry must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const requiredKeys = ["sessionKey", "key", "turnId", "fingerprint"];
  for (const key of requiredKeys) {
    if (!(key in record)) {
      failVoiceParse(`idempotency[].${key}`, "ledger snapshot entry is missing a required field.");
    }
  }
  for (const key of Object.keys(record)) {
    if (!requiredKeys.includes(key)) {
      failVoiceParse(`idempotency[].${key}`, "ledger snapshot entry carries an unknown field.");
    }
  }
  const problems: ContractProblem[] = [];
  validateVoiceRefs({ sessionKey: record.sessionKey, turnId: record.turnId }, problems);
  if (problems.length > 0) {
    failVoiceParse("idempotency[]", "ledger snapshot ids must match the contract grammars.");
  }
  if (!isVoiceIdempotencyKey(record.key)) {
    failVoiceParse("idempotency[].key", "ledger key must match the bounded key grammar.");
  }
  if (!isVoiceFingerprint(record.fingerprint)) {
    failVoiceParse("idempotency[].fingerprint", "ledger fingerprint must be a hex digest.");
  }
  return {
    sessionKey: record.sessionKey as string,
    key: record.key,
    turnId: record.turnId as string,
    fingerprint: record.fingerprint,
  };
}

/**
 * Parse + re-validate one snapshot turn entry (exported for the SQLite
 * adapter's restore path; same rationale as `parseSnapshotSession`).
 */
export function parseSnapshotTurn(raw: unknown): VoiceTurnRecord {  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    failVoiceParse("turns[]", "turn snapshot entry must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const requiredKeys = [
    "turnId",
    "sessionKey",
    "traceId",
    "epoch",
    "state",
    "idempotencyKey",
    "fingerprint",
    "createdAtMs",
    "startedAtMs",
    "settledAtMs",
  ];
  for (const key of requiredKeys) {
    if (!(key in record)) {
      failVoiceParse(`turns[].${key}`, "turn snapshot entry is missing a required field.");
    }
  }
  for (const key of Object.keys(record)) {
    if (!requiredKeys.includes(key)) {
      failVoiceParse(`turns[].${key}`, "turn snapshot entry carries an unknown field.");
    }
  }
  const problems: ContractProblem[] = [];
  validateVoiceRefs(
    { sessionKey: record.sessionKey, turnId: record.turnId, traceId: record.traceId ?? undefined },
    problems,
  );
  if (problems.length > 0) {
    failVoiceParse("turns[]", "turn snapshot ids must match the contract grammars.");
  }
  if (!isValidVoiceEpoch(record.epoch)) {
    failVoiceParse("turns[].epoch", "epoch must be a positive integer.");
  }
  if (!isVoiceTurnState(record.state)) {
    failVoiceParse("turns[].state", "state must be a registered voice turn state.");
  }
  if (record.idempotencyKey !== null && !isVoiceIdempotencyKey(record.idempotencyKey)) {
    failVoiceParse("turns[].idempotencyKey", "idempotencyKey must be null or a bounded key.");
  }
  if (record.fingerprint !== null && !isVoiceFingerprint(record.fingerprint)) {
    failVoiceParse("turns[].fingerprint", "fingerprint must be null or a hex digest.");
  }
  for (const [field, value] of [
    ["createdAtMs", record.createdAtMs],
    ["startedAtMs", record.startedAtMs],
    ["settledAtMs", record.settledAtMs],
  ] as const) {
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
      failVoiceParse(`turns[].${field}`, `${field} must be null or a finite number.`);
    }
  }
  const isTerminal = (VOICE_TERMINAL_TURN_STATES as readonly string[]).includes(record.state as string);
  if (isTerminal && typeof record.settledAtMs !== "number") {
    failVoiceParse("turns[].settledAtMs", "a terminal turn must carry settledAtMs.");
  }
  if (!isTerminal && record.settledAtMs !== null) {
    failVoiceParse("turns[].settledAtMs", "a non-terminal turn must not carry settledAtMs.");
  }
  if (record.state === "RUNNING" && typeof record.startedAtMs !== "number") {
    failVoiceParse("turns[].startedAtMs", "a RUNNING turn must carry startedAtMs.");
  }
  return {
    turnId: record.turnId as string,
    sessionKey: record.sessionKey as string,
    traceId: (record.traceId ?? null) as string | null,
    epoch: record.epoch,
    state: record.state as VoiceTurnState,
    idempotencyKey: (record.idempotencyKey ?? null) as string | null,
    fingerprint: (record.fingerprint ?? null) as string | null,
    createdAtMs: record.createdAtMs as number,
    startedAtMs: (record.startedAtMs ?? null) as number | null,
    settledAtMs: (record.settledAtMs ?? null) as number | null,
  };
}

// Re-exported for adapters implementing the SAME port (the SQLite adapter
// reuses the guards and the VoiceRejection→result mapping discipline so
// both implementations stay structurally identical). VoiceRejection itself
// is exported at its declaration above.
export { attempt, isValidStoreId, turnOrder };
