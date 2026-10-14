/**
 * R1-V1 SQLite adapter of the trusted voice fence store (issue #28 实现范围 3;
 * docs/VOICE_RUNTIME.md §5: "SQLite 实现以事务原子核验会话归属/epoch/身份").
 *
 * Implements the SAME `VoiceFenceStore` port as the in-memory
 * implementation (lib/domain/voice/store.ts) on top of the Node 24
 * built-in `node:sqlite`. Every mutating operation is ONE
 * `BEGIN IMMEDIATE` transaction that validates — inside the transaction —
 *
 *   1. session ownership (the session exists and is bound to one owner/
 *      conversation pair),
 *   2. the claimed epoch against the TRUSTED epoch row,
 *   3. turn identity (globally unique turn ids; cross-session references
 *      are rejected),
 *   4. the turn state machine, and
 *   5. the idempotency key/fingerprint pair
 *
 * before any row is written. The unsafe SELECT-then-separate-INSERT
 * pattern the issue forbids cannot occur: every check and every write
 * share the same transaction, and a rejection ROLLS BACK with no effect.
 *
 * SCHEMA (synthetic POC data only — no child audio/text can be stored:
 * every column is an id, an epoch, a state code, a hex fingerprint digest
 * or a bounded integer):
 *
 *   voice_fence_meta(key, value)          — store format + schema version
 *   voice_sessions(session_key PK, conversation_id, owner_actor_id,
 *                  created_at_ms, epoch)
 *   voice_turns(turn_id PK, session_key, trace_id, epoch, state,
 *               idempotency_key, fingerprint, created_at_ms,
 *               started_at_ms, settled_at_ms)
 *   voice_idempotency(session_key, idem_key, turn_id, fingerprint)  PK(session_key, idem_key)
 *   voice_tts_queue(item_id PK, session_key, turn_id, epoch, queued_at_ms)
 *
 * Opening the store runs the versioned migration step (CREATE TABLE IF
 * NOT EXISTS + version check); a store written by an unknown future
 * schema version refuses to open (fail-closed migration test).
 *
 * This is a lib/server adapter: it MAY use node builtins and MUST NOT be
 * imported from lib/domain (enforced by tests/domain/boundary.spec.ts).
 */

import { DatabaseSync } from "node:sqlite";

import {
  isLegalVoiceTurnTransition,
  isVoiceFingerprint,
  isVoiceIdempotencyKey,
  isValidVoiceEpoch,
  VOICE_SETTLE_OUTCOMES,
  VOICE_TERMINAL_TURN_STATES,
  VOICE_WRITE_KINDS,
  failVoiceParse,
  type VoiceSessionRecord,
  type VoiceTurnRecord,
  type VoiceTurnState,
} from "../domain/voice/schema.ts";
import {
  attempt,
  isValidStoreId,
  parseSnapshotLedgerEntry,
  parseSnapshotSession,
  parseSnapshotTurn,
  turnOrder,
  VoiceRejection,
  VOICE_FENCE_STORE_FORMAT,
  VOICE_MAX_TTS_QUEUE_ITEMS,
  type VoiceCancelTurnResult,
  type VoiceDrainTtsResult,
  type VoiceFenceOutputResult,
  type VoiceFenceStore,
  type VoiceFenceWriteResult,
  type VoiceOpenSessionResult,
  type VoicePumpResult,
  type VoiceRegisterPromptResult,
  type VoiceSettleResult,
  type VoiceSweepTimeoutsResult,
} from "../domain/voice/store.ts";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Schema version of THIS adapter's tables; bump with a migration step. */
export const VOICE_SQLITE_SCHEMA_VERSION = "1" as const;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS voice_fence_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS voice_sessions (
  session_key     TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  owner_actor_id  TEXT NOT NULL,
  created_at_ms   INTEGER NOT NULL,
  epoch           INTEGER NOT NULL CHECK (epoch >= 1)
);
CREATE TABLE IF NOT EXISTS voice_turns (
  turn_id         TEXT PRIMARY KEY,
  session_key     TEXT NOT NULL,
  trace_id        TEXT,
  epoch           INTEGER NOT NULL CHECK (epoch >= 1),
  state           TEXT NOT NULL,
  idempotency_key TEXT,
  fingerprint     TEXT,
  created_at_ms   INTEGER NOT NULL,
  started_at_ms   INTEGER,
  settled_at_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_voice_turns_session ON voice_turns (session_key);
CREATE TABLE IF NOT EXISTS voice_idempotency (
  session_key TEXT NOT NULL,
  idem_key    TEXT NOT NULL,
  turn_id     TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  PRIMARY KEY (session_key, idem_key)
);
CREATE TABLE IF NOT EXISTS voice_tts_queue (
  item_id      TEXT PRIMARY KEY,
  session_key  TEXT NOT NULL,
  turn_id      TEXT NOT NULL,
  epoch        INTEGER NOT NULL,
  queued_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_tts_session ON voice_tts_queue (session_key);
`;

/** Raised when an existing store file carries an unknown schema/format. */
export class VoiceFenceStoreOpenError extends Error {
  readonly reason: "format_mismatch" | "schema_version_mismatch";
  constructor(reason: "format_mismatch" | "schema_version_mismatch") {
    super(`voice fence store cannot be opened: ${reason}`);
    this.name = "VoiceFenceStoreOpenError";
    this.reason = reason;
  }
}

export interface CreateSqliteVoiceFenceStoreOptions {
  /** Database file path (or ":memory:" for tests). */
  readonly path: string;
  /** TTS queue capacity (default VOICE_MAX_TTS_QUEUE_ITEMS). */
  readonly ttsQueueCapacity?: number;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface SessionRow {
  session_key: string;
  conversation_id: string;
  owner_actor_id: string;
  created_at_ms: number;
  epoch: number;
}

interface TurnRow {
  turn_id: string;
  session_key: string;
  trace_id: string | null;
  epoch: number;
  state: string;
  idempotency_key: string | null;
  fingerprint: string | null;
  created_at_ms: number;
  started_at_ms: number | null;
  settled_at_ms: number | null;
}

function sessionOf(row: SessionRow): VoiceSessionRecord {
  return {
    sessionKey: row.session_key,
    conversationId: row.conversation_id,
    ownerActorId: row.owner_actor_id,
    createdAtMs: row.created_at_ms,
    epoch: row.epoch,
  };
}

function turnOf(row: TurnRow): VoiceTurnRecord {
  return {
    turnId: row.turn_id,
    sessionKey: row.session_key,
    traceId: row.trace_id,
    epoch: row.epoch,
    state: row.state as VoiceTurnState,
    idempotencyKey: row.idempotency_key,
    fingerprint: row.fingerprint,
    createdAtMs: row.created_at_ms,
    startedAtMs: row.started_at_ms,
    settledAtMs: row.settled_at_ms,
  };
}

/**
 * Open (and if needed migrate) the SQLite-backed trusted fence store.
 * Every operation below is a single `BEGIN IMMEDIATE` transaction.
 */
export function createSqliteVoiceFenceStore(
  options: CreateSqliteVoiceFenceStoreOptions,
): VoiceFenceStore & { readonly close: () => void } {
  if (typeof options?.path !== "string" || options.path.length === 0) {
    failVoiceParse("path", "the voice fence store needs a database file path.");
  }
  const ttsCapacity = Math.max(
    1,
    Math.min(options.ttsQueueCapacity ?? VOICE_MAX_TTS_QUEUE_ITEMS, 4096),
  );

  const db = new DatabaseSync(options.path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  // Versioned migration gate: an unknown future store refuses to open.
  const meta = prepare<[string], { value: string }>(
    "SELECT value FROM voice_fence_meta WHERE key = ?",
  );
  const formatRow = meta.get("format");
  const versionRow = meta.get("schema_version");
  if (formatRow === undefined) {
    db.prepare("INSERT INTO voice_fence_meta (key, value) VALUES (?, ?)").run("format", VOICE_FENCE_STORE_FORMAT);
    db.prepare("INSERT INTO voice_fence_meta (key, value) VALUES (?, ?)").run("schema_version", VOICE_SQLITE_SCHEMA_VERSION);
  } else {
    if (formatRow.value !== VOICE_FENCE_STORE_FORMAT) {
      db.close();
      throw new VoiceFenceStoreOpenError("format_mismatch");
    }
    if (versionRow === undefined || versionRow.value !== VOICE_SQLITE_SCHEMA_VERSION) {
      db.close();
      throw new VoiceFenceStoreOpenError("schema_version_mismatch");
    }
  }

  function withTx<T>(run: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The original error is the one that matters.
      }
      throw error;
    }
  }

  /**
   * Typed view over `db.prepare` (the node:sqlite StatementSync returns
   * untyped rows): narrows row shapes and parameters at ONE place instead
   * of casting at every call site. Row values are trusted only insofar as
   * THIS adapter wrote them (same invariant as the in-memory maps).
   */
  type SqlParam = string | number | null;
  function prepare<P extends SqlParam[], R>(sql: string): {
    get(...params: P): R | undefined;
    all(...params: P): R[];
    run(...params: unknown[]): unknown;
  } {
    const statement = db.prepare(sql);
    return {
      get: (...params: P) => statement.get(...params) as R | undefined,
      all: (...params: P) => statement.all(...params) as R[],
      run: (...params: unknown[]) => statement.run(...(params as never[])),
    };
  }

  // Reused prepared statements (all transaction bodies run synchronously).
  const stmtSession = prepare<[string], SessionRow>(
    "SELECT session_key, conversation_id, owner_actor_id, created_at_ms, epoch FROM voice_sessions WHERE session_key = ?",
  );
  const stmtTurn = prepare<[string], TurnRow>(
    "SELECT turn_id, session_key, trace_id, epoch, state, idempotency_key, fingerprint, created_at_ms, started_at_ms, settled_at_ms FROM voice_turns WHERE turn_id = ?",
  );
  const stmtTurnsOfSession = prepare<[string], TurnRow>(
    "SELECT turn_id, session_key, trace_id, epoch, state, idempotency_key, fingerprint, created_at_ms, started_at_ms, settled_at_ms FROM voice_turns WHERE session_key = ?",
  );
  const stmtInsertTurn = db.prepare(
    "INSERT INTO voice_turns (turn_id, session_key, trace_id, epoch, state, idempotency_key, fingerprint, created_at_ms, started_at_ms, settled_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const stmtIdem = prepare<[string, string], { turn_id: string; fingerprint: string }>(
    "SELECT turn_id, fingerprint FROM voice_idempotency WHERE session_key = ? AND idem_key = ?",
  );
  const stmtInsertIdem = db.prepare(
    "INSERT INTO voice_idempotency (session_key, idem_key, turn_id, fingerprint) VALUES (?, ?, ?, ?)",
  );
  const stmtBumpEpoch = db.prepare("UPDATE voice_sessions SET epoch = epoch + 1 WHERE session_key = ?");
  const stmtFenceTurns = db.prepare(
    `UPDATE voice_turns SET state = 'CANCELLING' WHERE session_key = ? AND state NOT IN ('COMPLETED', 'CANCELLED', 'FAILED', 'TIMED_OUT')`,
  );
  const stmtTurnState = db.prepare(
    "UPDATE voice_turns SET state = ?, settled_at_ms = ? WHERE turn_id = ?",
  );
  const stmtTurnStart = db.prepare(
    "UPDATE voice_turns SET state = 'RUNNING', started_at_ms = ? WHERE turn_id = ?",
  );
  const stmtTurnEnqueue = db.prepare(
    "UPDATE voice_turns SET state = 'QUEUED' WHERE turn_id = ?",
  );
  const stmtTtsCount = prepare<[string], { n: number }>(
    "SELECT COUNT(*) AS n FROM voice_tts_queue WHERE session_key = ?",
  );
  const stmtTtsOldestRowid = prepare<[string], { rowid: number | null }>(
    "SELECT MIN(rowid) AS rowid FROM voice_tts_queue WHERE session_key = ?",
  );
  const stmtTtsDeleteRowid = db.prepare("DELETE FROM voice_tts_queue WHERE rowid = ?");
  const stmtTtsInsert = db.prepare(
    "INSERT INTO voice_tts_queue (item_id, session_key, turn_id, epoch, queued_at_ms) VALUES (?, ?, ?, ?, ?)",
  );
  const stmtTtsAll = prepare<[string], { item_id: string; turn_id: string; epoch: number }>(
    "SELECT item_id, turn_id, epoch FROM voice_tts_queue WHERE session_key = ? ORDER BY rowid",
  );
  const stmtTtsDeleteAll = db.prepare("DELETE FROM voice_tts_queue WHERE session_key = ?");

  /** Fetch a session or throw `session_unknown`. */
  function sessionOrThrow(sessionKey: string): SessionRow {
    const row = stmtSession.get(sessionKey);
    if (row === undefined) {
      throw new VoiceRejection("session_unknown");
    }
    return row;
  }

  /** Fetch a turn with strict session scoping (cross-session rejection). */
  function turnOrThrow(sessionKey: string, turnId: string): TurnRow {
    const row = stmtTurn.get(turnId);
    if (row === undefined) {
      throw new VoiceRejection("turn_unknown");
    }
    if (row.session_key !== sessionKey) {
      throw new VoiceRejection("cross_session_rejected");
    }
    return row;
  }

  /** Same clock guard as the in-memory implementation. */
  function assertNowMs(nowMs: number): void {
    if (typeof nowMs !== "number" || !Number.isFinite(nowMs) || nowMs < 0) {
      failVoiceParse("nowMs", "nowMs must be a non-negative finite number.");
    }
  }

  function requireTurnId(refs: { sessionKey: string; turnId: string }): void {
    if (!isValidStoreId("sessionId", refs.sessionKey)) {
      failVoiceParse("sessionKey", "sessionKey must match the contract id grammar.");
    }
    if (!isValidStoreId("turnId", refs.turnId)) {
      failVoiceParse("turnId", "turnId must match the contract id grammar.");
    }
  }

  function assertIdempotencyPair(idempotencyKey: string | null, fingerprint: string | null): void {
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

  const storeImpl: VoiceFenceStore & { readonly close: () => void } = {
    openSession(refs) {
      assertNowMs(refs.nowMs);
      if (
        !isValidStoreId("sessionId", refs.sessionKey) ||
        !isValidStoreId("conversationId", refs.conversationId) ||
        !isValidStoreId("actorId", refs.ownerActorId)
      ) {
        failVoiceParse("refs", "voice refs must match the contract id grammars.");
      }
      return withTx(() => {
        const existing = stmtSession.get(refs.sessionKey);
        if (existing !== undefined) {
          if (existing.owner_actor_id !== refs.ownerActorId || existing.conversation_id !== refs.conversationId) {
            return { ok: false, code: "session_conflict" as const };
          }
          return { ok: true, created: false, epoch: existing.epoch };
        }
        db.prepare(
          "INSERT INTO voice_sessions (session_key, conversation_id, owner_actor_id, created_at_ms, epoch) VALUES (?, ?, ?, ?, 1)",
        ).run(refs.sessionKey, refs.conversationId, refs.ownerActorId, refs.nowMs);
        return { ok: true, created: true, epoch: 1 };
      });
    },

    registerPrompt(refs): VoiceRegisterPromptResult {
      requireTurnId(refs);
      assertNowMs(refs.nowMs);
      assertIdempotencyPair(refs.idempotencyKey, refs.fingerprint);
      if (refs.traceId !== null && !isValidStoreId("traceId", refs.traceId)) {
        failVoiceParse("traceId", "traceId must match the contract id grammar.");
      }
      return attempt(() => withTx(() => {
        const session = sessionOrThrow(refs.sessionKey);
        if (stmtTurn.get(refs.turnId) !== undefined) {
          failVoiceParse("turnId", "turnId must be globally unique.");
        }
        if (refs.idempotencyKey !== null) {
          const stored = stmtIdem.get(refs.sessionKey, refs.idempotencyKey);
          if (stored !== undefined) {
            if (stored.fingerprint !== refs.fingerprint) {
              return { ok: false, code: "idempotency_conflict" as const };
            }
            const original = stmtTurn.get(stored.turn_id);
            if (original === undefined || original.session_key !== refs.sessionKey) {
              throw new VoiceRejection("session_unknown");
            }
            return { ok: true, replayed: true, turn: turnOf(original) };
          }
        }
        stmtInsertTurn.run(
          refs.turnId,
          refs.sessionKey,
          refs.traceId,
          // The trusted epoch row decides the generation (never the client).
          session.epoch,
          "CREATED",
          refs.idempotencyKey,
          refs.fingerprint,
          refs.nowMs,
          null,
          null,
        );
        if (refs.idempotencyKey !== null) {
          stmtInsertIdem.run(refs.sessionKey, refs.idempotencyKey, refs.turnId, refs.fingerprint as string);
        }
        return {
          ok: true,
          replayed: false,
          turn: {
            turnId: refs.turnId,
            sessionKey: refs.sessionKey,
            traceId: refs.traceId,
            epoch: session.epoch,
            state: "CREATED",
            idempotencyKey: refs.idempotencyKey,
            fingerprint: refs.fingerprint,
            createdAtMs: refs.nowMs,
            startedAtMs: null,
            settledAtMs: null,
          },
        };
      }));
    },

    cancelTurn(refs): VoiceCancelTurnResult {
      requireTurnId(refs);
      assertNowMs(refs.nowMs);
      return attempt(() => withTx(() => {
        const session = sessionOrThrow(refs.sessionKey);
        const turn = turnOrThrow(refs.sessionKey, refs.turnId);
        if ((VOICE_TERMINAL_TURN_STATES as readonly string[]).includes(turn.state)) {
          return { ok: false, code: "turn_terminal" as const };
        }
        if (turn.state === "CANCELLING") {
          return { ok: false, code: "cancel_already_active" as const };
        }
        if (turn.epoch !== session.epoch) {
          return { ok: false, code: "stale_turn_rejected" as const };
        }
        // ONE transaction: bump the trusted epoch, then fence every
        // non-terminal old-epoch turn of this session into CANCELLING.
        stmtBumpEpoch.run(refs.sessionKey);
        const before = [...stmtTurnsOfSession.all(refs.sessionKey)];
        stmtFenceTurns.run(refs.sessionKey);
        const fencedTurnIds = before
          .filter((row) => !(VOICE_TERMINAL_TURN_STATES as readonly string[]).includes(row.state))
          .map((row) => row.turn_id)
          .sort();
        return { ok: true, epoch: session.epoch + 1, previousEpoch: session.epoch, fencedTurnIds: Object.freeze(fencedTurnIds) };
      }));
    },

    pumpScheduler(refs): VoicePumpResult {
      if (!isValidStoreId("sessionId", refs.sessionKey)) {
        failVoiceParse("sessionKey", "sessionKey must match the contract id grammar.");
      }
      assertNowMs(refs.nowMs);
      return attempt(() => withTx(() => {
        const session = sessionOrThrow(refs.sessionKey);
        const all = [...stmtTurnsOfSession.all(refs.sessionKey)].sort((a, b) =>
          a.created_at_ms - b.created_at_ms || (a.turn_id < b.turn_id ? -1 : a.turn_id > b.turn_id ? 1 : 0),
        );
        const busy = all.find((row) => row.state === "RUNNING" || row.state === "CANCELLING");
        let enqueuedTurnId: string | null = null;
        const enqueueCandidate = all.find((row) => row.state === "CREATED" && row.epoch === session.epoch);
        if (enqueueCandidate !== undefined) {
          stmtTurnEnqueue.run(enqueueCandidate.turn_id);
          enqueuedTurnId = enqueueCandidate.turn_id;
        }
        if (busy !== undefined) {
          return { ok: true, enqueuedTurnId, dispatchedTurnId: null, busyTurnId: busy.turn_id };
        }
        // Parity with the in-memory store: the turn enqueued by THIS pump
        // is eligible for immediate dispatch when the agent is idle (its
        // row in `all` still says CREATED, so candidates are matched by
        // id as well as by the QUEUED state).
        const queued = all
          .filter(
            (row) =>
              row.epoch === session.epoch &&
              (row.state === "QUEUED" || row.turn_id === enqueuedTurnId),
          )
          .sort((a, b) => a.created_at_ms - b.created_at_ms || (a.turn_id < b.turn_id ? -1 : a.turn_id > b.turn_id ? 1 : 0))[0];
        if (queued === undefined) {
          return { ok: true, enqueuedTurnId, dispatchedTurnId: null, busyTurnId: null };
        }
        stmtTurnStart.run(refs.nowMs, queued.turn_id);
        return { ok: true, enqueuedTurnId, dispatchedTurnId: queued.turn_id, busyTurnId: null };
      }));
    },

    settleTurn(refs): VoiceSettleResult {
      requireTurnId(refs);
      assertNowMs(refs.nowMs);
      if (!(VOICE_SETTLE_OUTCOMES as readonly string[]).includes(refs.outcome)) {
        failVoiceParse("outcome", "outcome must be a registered settle outcome.");
      }
      return attempt(() => withTx(() => {
        const session = sessionOrThrow(refs.sessionKey);
        const turn = turnOrThrow(refs.sessionKey, refs.turnId);
        if (turn.epoch !== session.epoch && refs.outcome === "COMPLETED") {
          throw new VoiceRejection("stale_turn_rejected");
        }
        if (!isLegalVoiceTurnTransition(turn.state as VoiceTurnState, refs.outcome)) {
          throw new VoiceRejection("turn_state_transition_illegal");
        }
        stmtTurnState.run(refs.outcome, refs.nowMs, refs.turnId);
        return {
          ok: true,
          turn: turnOf({
            ...turn,
            state: refs.outcome,
            settled_at_ms: refs.nowMs,
          }),
        };
      }));
    },

    fenceOutput(refs): VoiceFenceOutputResult {
      requireTurnId(refs);
      assertNowMs(refs.nowMs);
      if (!isValidVoiceEpoch(refs.epoch)) {
        failVoiceParse("epoch", "epoch must be a positive integer.");
      }
      if (refs.kind !== "text_delta" && refs.kind !== "tts_queue" && refs.kind !== "audio_send") {
        failVoiceParse("kind", "kind must be a registered output kind.");
      }
      return attempt(() => withTx(() => {
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
          const count = stmtTtsCount.get(refs.sessionKey)?.n ?? 0;
          if (count >= ttsCapacity) {
            const oldest = stmtTtsOldestRowid.get(refs.sessionKey);
            if (oldest !== undefined && oldest.rowid !== null) {
              stmtTtsDeleteRowid.run(oldest.rowid);
            }
          }
          stmtTtsInsert.run(refs.ttsItemId, refs.sessionKey, refs.turnId, refs.epoch, refs.nowMs);
          return { ok: true, allowed: true, ttsItemId: refs.ttsItemId };
        }
        return { ok: true, allowed: true, ttsItemId: null };
      }));
    },

    fenceWrite(refs): VoiceFenceWriteResult {
      requireTurnId(refs);
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
      return attempt(() => withTx(() => {
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
        const stored = stmtIdem.get(refs.sessionKey, refs.idempotencyKey);
        if (stored !== undefined) {
          if (stored.fingerprint !== refs.fingerprint) {
            throw new VoiceRejection("idempotency_conflict");
          }
          return { ok: true, replayed: true, turnId: stored.turn_id, epoch: refs.epoch, committedAtMs: refs.nowMs };
        }
        stmtInsertIdem.run(refs.sessionKey, refs.idempotencyKey, refs.turnId, refs.fingerprint);
        return { ok: true, replayed: false, turnId: refs.turnId, epoch: refs.epoch, committedAtMs: refs.nowMs };
      }));
    },

    drainTtsQueue(refs): VoiceDrainTtsResult {
      if (!isValidStoreId("sessionId", refs.sessionKey)) {
        failVoiceParse("sessionKey", "sessionKey must match the contract id grammar.");
      }
      assertNowMs(refs.nowMs);
      return attempt(() => withTx(() => {
        const session = sessionOrThrow(refs.sessionKey);
        const all = [...stmtTtsAll.all(refs.sessionKey)];
        const deliverable = all
          .filter((item) => item.epoch === session.epoch)
          .map((item) => ({ itemId: item.item_id, turnId: item.turn_id, epoch: item.epoch }));
        const droppedStale = all.length - deliverable.length;
        stmtTtsDeleteAll.run(refs.sessionKey);
        return { ok: true, deliverable: Object.freeze(deliverable), droppedStale };
      }));
    },

    sweepTimeouts(refs): VoiceSweepTimeoutsResult {
      if (!isValidStoreId("sessionId", refs.sessionKey)) {
        failVoiceParse("sessionKey", "sessionKey must match the contract id grammar.");
      }
      if (typeof refs.budgetMs !== "number" || !Number.isFinite(refs.budgetMs) || refs.budgetMs < 0) {
        failVoiceParse("budgetMs", "budgetMs must be a non-negative finite number.");
      }
      return attempt(() => withTx(() => {
        sessionOrThrow(refs.sessionKey);
        const stale = prepare<[string, number, number], TurnRow>(
          `SELECT turn_id, session_key, trace_id, epoch, state, idempotency_key, fingerprint, created_at_ms, started_at_ms, settled_at_ms
           FROM voice_turns
           WHERE session_key = ?
             AND state IN ('RUNNING', 'CANCELLING')
             AND (? - COALESCE(started_at_ms, created_at_ms)) > ?`,
        ).all(refs.sessionKey, refs.nowMs, refs.budgetMs);
        for (const row of stale) {
          stmtTurnState.run("TIMED_OUT", refs.nowMs, row.turn_id);
        }
        return { ok: true, timedOutTurnIds: Object.freeze(stale.map((row) => row.turn_id).sort()) };
      }));
    },

    currentEpoch(sessionKey: string): number | null {
      const row = stmtSession.get(sessionKey);
      return row?.epoch ?? null;
    },

    describeSession(sessionKey: string): VoiceSessionRecord | null {
      const row = stmtSession.get(sessionKey);
      return row === undefined ? null : sessionOf(row);
    },

    describeTurn(sessionKey: string, turnId: string): VoiceTurnRecord | null {
      const row = stmtTurn.get(turnId);
      if (row === undefined || row.session_key !== sessionKey) {
        return null;
      }
      return turnOf(row);
    },

    listTurns(sessionKey: string): readonly VoiceTurnRecord[] {
      return Object.freeze(
        [...stmtTurnsOfSession.all(sessionKey)].map(turnOf).sort(turnOrder),
      );
    },

    ttsQueueDepth(sessionKey: string): number {
      return stmtTtsCount.get(sessionKey)?.n ?? 0;
    },

    exportState() {
      const sessions = prepare<[], SessionRow>(
        "SELECT session_key, conversation_id, owner_actor_id, created_at_ms, epoch FROM voice_sessions ORDER BY session_key",
      )
        .all()
        .map(sessionOf);
      const turns = prepare<[], TurnRow>(
        "SELECT turn_id, session_key, trace_id, epoch, state, idempotency_key, fingerprint, created_at_ms, started_at_ms, settled_at_ms FROM voice_turns ORDER BY turn_id",
      )
        .all()
        .map(turnOf);
      const idempotency = prepare<[], { session_key: string; idem_key: string; turn_id: string; fingerprint: string }>(
        "SELECT session_key, idem_key, turn_id, fingerprint FROM voice_idempotency ORDER BY session_key, idem_key",
      )
        .all()
        .map((row) => ({ sessionKey: row.session_key, key: row.idem_key, turnId: row.turn_id, fingerprint: row.fingerprint }));
      return {
        format: VOICE_FENCE_STORE_FORMAT,
        sessions: Object.freeze(sessions),
        turns: Object.freeze(turns),
        idempotency: Object.freeze(idempotency),
      };
    },

    restoreState(raw) {
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
      // Parse everything first (same parsers as the in-memory store), then
      // commit in ONE transaction: a rejected restore changes nothing.
      const sessions = record.sessions.map(parseSnapshotSession);
      const turns = record.turns.map(parseSnapshotTurn);
      const sessionEpoch = new Map<string, number>();
      for (const session of sessions) {
        sessionEpoch.set(session.sessionKey, session.epoch);
      }
      for (const turn of turns) {
        const epoch = sessionEpoch.get(turn.sessionKey);
        if (epoch === undefined) {
          failVoiceParse("turns[].sessionKey", "every restored turn must belong to a restored session.");
        }
        if (turn.epoch > (epoch as number)) {
          failVoiceParse("turns[].epoch", "restored turn epoch exceeds the session epoch.");
        }
      }
      // Idempotency ledger: the snapshot section is authoritative when
      // present (committed WRITE keys survive the restart); older
      // snapshots derive the prompt keys from the turn records.
      const ledgerEntries: { sessionKey: string; key: string; turnId: string; fingerprint: string }[] = [];
      if (record.idempotency !== undefined) {
        if (!Array.isArray(record.idempotency)) {
          failVoiceParse("idempotency", "snapshot idempotency must be an array.");
        }
        for (const rawEntry of record.idempotency) {
          const entry = parseSnapshotLedgerEntry(rawEntry);
          if (!sessionEpoch.has(entry.sessionKey)) {
            failVoiceParse("idempotency[].sessionKey", "every ledger entry must belong to a restored session.");
          }
          const turn = turns.find((candidate) => candidate.turnId === entry.turnId);
          if (turn === undefined || turn.sessionKey !== entry.sessionKey) {
            failVoiceParse("idempotency[].turnId", "every ledger entry must reference a turn of its own session.");
          }
          ledgerEntries.push(entry);
        }
      } else {
        for (const turn of turns) {
          if (turn.idempotencyKey !== null && turn.fingerprint !== null) {
            ledgerEntries.push({ sessionKey: turn.sessionKey, key: turn.idempotencyKey, turnId: turn.turnId, fingerprint: turn.fingerprint });
          }
        }
      }
      return withTx(() => {
        const insertSession = db.prepare(
          "INSERT OR REPLACE INTO voice_sessions (session_key, conversation_id, owner_actor_id, created_at_ms, epoch) VALUES (?, ?, ?, ?, ?)",
        );
        for (const session of sessions) {
          insertSession.run(session.sessionKey, session.conversationId, session.ownerActorId, session.createdAtMs, session.epoch);
        }
        const insertTurn = db.prepare(
          "INSERT OR REPLACE INTO voice_turns (turn_id, session_key, trace_id, epoch, state, idempotency_key, fingerprint, created_at_ms, started_at_ms, settled_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        for (const turn of turns) {
          insertTurn.run(
            turn.turnId,
            turn.sessionKey,
            turn.traceId,
            turn.epoch,
            turn.state,
            turn.idempotencyKey,
            turn.fingerprint,
            turn.createdAtMs,
            turn.startedAtMs,
            turn.settledAtMs,
          );
        }
        const insertLedger = db.prepare(
          "INSERT OR REPLACE INTO voice_idempotency (session_key, idem_key, turn_id, fingerprint) VALUES (?, ?, ?, ?)",
        );
        for (const entry of ledgerEntries) {
          insertLedger.run(entry.sessionKey, entry.key, entry.turnId, entry.fingerprint);
        }
        return { restoredSessions: sessions.length, restoredTurns: turns.length };
      });
    },

    close() {
      db.close();
    },
  };

  return storeImpl;
}
