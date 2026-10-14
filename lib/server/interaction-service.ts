/**
 * R1-05 web MVP server infrastructure — the interaction endpoint service
 * (issue #17; docs/API_CONTRACT.md v1.0 wiring; docs/SAFETY_POLICY.md §7
 * `ui_web` entrance; PRD FR-001; Roadmap R1-05).
 *
 * One framework-free service implements the three contract routes so the
 * Next.js route handlers stay thin and the full behavior is testable with
 * node:test:
 *
 * - POST /api/v1/interactions        → submitInteraction(): fail-closed
 *   request parsing, server-owned identity injection (no client identity
 *   field is ever trusted — parseInteractionRequest rejects them first),
 *   conversation ownership, idempotency LEDGER KEYED TO (verifiedActor,
 *   requestId) (carried #13/#14 review hard precondition: a global ledger
 *   would let a replayed leaked requestId+payload return another actor's
 *   conversation/turn/trace ids), background turn execution through the
 *   REAL Cordis pipeline (entrance `ui_web`), immediate contract ack.
 * - GET  …/{traceId}/events          → openEventStream(): actor-scoped SSE
 *   replay + live subscription of versioned StreamEvents (seq 0-based
 *   monotonic; `formatStreamEventAsSse` re-validates every frame on the
 *   way out).
 * - POST …/{turnId}/cancel           → cancelTurn(): role-checked cancel,
 *   gateway caller-cancellation through the pipeline AbortSignal, safe
 *   no-op terminal results (cancelled | already_final | unknown_turn) and
 *   late-result suppression (cancelled output never reaches the child).
 *
 * STREAMING SEMANTICS (issue #17, documented boundary): the model streams
 * only server-side. The Output Gate evaluates the COMPLETE draft before
 * anything is emitted (docs/SAFETY_POLICY.md §4.3 — unreviewed deltas never
 * reach a child), and the approved text is then emitted as bounded
 * short-fragment `agent.delta` frames — exactly the contract's "短句片段，
 * 非 raw model token" (docs/API_CONTRACT.md §5). Stop semantics: the child
 * stop (a) revokes UI consumption immediately client-side, (b) aborts the
 * in-flight model call through the gateway's first-class caller-cancellation
 * (real `AbortSignal` propagation), and (c) terminates remaining fragment
 * emission; the DshRuntimePort surface has NO mid-turn cancel (official SDK
 * boundary, docs/HARNESS.md §7) and no code path claims agent-loop true
 * cancel.
 *
 * STATE BOUNDARY: conversation history, the idempotency ledger and the
 * in-flight turn registry are in-memory and process-local (single-process
 * web MVP). No persisted schema is introduced or changed; durable
 * persistence is a later R1 data-modeling decision (docs/TECH_STACK.md §3).
 *
 * R1-06 (issue #18): three optional server-owned hooks wire guardian
 * authorization into this service without changing its contract semantics —
 * `authorizeTurn` (family consent gate, runs before the ledger so a revoked
 * authorization rejects even replays), `cancelPolicy` (a family guardian may
 * stop own-family child turns; contract §6 `guardian_stop`) and
 * `resolvePersonaStyle` (the trusted `guardian_config` persona style, passed
 * through to the pipeline and re-validated there). Cancel attribution now
 * records the real canceller role (`turn.cancelled.by`).
 *
 * This module stays framework-free (no next/react/prisma imports) so the
 * endpoint behavior is testable with node:test like the domain layers.
 */

import {
  CONTRACT_ID_PREFIXES,
  isValidContractId,
  type ContractIdKind,
  type ContractProblem,
  ContractValidationError,
  problem,
} from "../domain/contract/core.ts";
import {
  createSessionRef,
  parseActorContext,
  type ActorContext,
} from "../domain/contract/actor.ts";
import {
  fingerprintInteractionRequest,
  normalizeInteractionRequest,
  parseInteractionRequest,
  TEXT_LIMITS,
  type InteractionEvent,
  type InteractionRequest,
} from "../domain/contract/interaction.ts";
import {
  buildDuplicateAck,
  buildInteractionAck,
  rejectDuplicateRequest,
  resolveIdempotentRetry,
  type InteractionAck,
  type StoredInteraction,
} from "../domain/contract/idempotency.ts";
import {
  parseStreamEvent,
  parseTurnCancelRequest,
  parseTurnCancelResult,
  type StreamEvent,
  type StreamEventKind,
  type StreamEventPayload,
  type TurnCancelRequest,
  type TurnCancelResult,
} from "../domain/contract/response.ts";
import { toSafeErrorEnvelope, CONTRACT_ERROR_REGISTRY, type ErrorEnvelope } from "../domain/contract/errors.ts";
import type { CordisPipeline, CordisTurnResult } from "../domain/runtime/pipeline.ts";
import { ingestDomainFact } from "../domain/legacy-guard.ts";

// ---------------------------------------------------------------------------
// Public service types
// ---------------------------------------------------------------------------

export type SubmitInteractionResult =
  | { readonly kind: "ack"; readonly httpStatus: 200; readonly body: Readonly<InteractionAck> }
  | { readonly kind: "error"; readonly httpStatus: number; readonly envelope: Readonly<ErrorEnvelope> };

export type CancelTurnResult =
  | { readonly kind: "result"; readonly httpStatus: 200; readonly body: Readonly<TurnCancelResult> }
  | { readonly kind: "error"; readonly httpStatus: number; readonly envelope: Readonly<ErrorEnvelope> };

export type OpenEventStreamResult =
  | { readonly kind: "stream"; readonly events: AsyncGenerator<string, void, unknown> }
  | { readonly kind: "error"; readonly httpStatus: number; readonly envelope: Readonly<ErrorEnvelope> };

export interface InteractionServiceOptions {
  /** The composed Cordis pipeline (real gates, mock gateway by default). */
  readonly pipeline: CordisPipeline;
  /** Server-owned demo child age (evidence age gates). */
  readonly childAgeYears: number;
  /** Safety entrance this serving surface decides (server-owned, `ui_web`). */
  readonly entrance?: "ui_web" | "api_text";
  /** Contract ingress decided by the transport path (server-owned, `web`). */
  readonly ingress?: "web" | "voice_adapter";
  /** ms clock (durations, id material). */
  readonly clock?: () => number;
  /** ISO-8601 UTC timestamps (contract grammar). */
  readonly nowFactory?: () => string;
  /** Contract-id factory (kind → new id). */
  readonly idFactory?: (kind: ContractIdKind) => string;
  /** Presentation pacing of the gate-approved output over SSE. */
  readonly stream?: {
    readonly fragmentCodePoints?: number;
    readonly interFrameDelayMs?: number;
  };
  /** ms to wait for a cancelled turn to reach its terminal state. */
  readonly cancelSettleMs?: number;
  /**
   * R1-06 submit-time turn authorization (e.g. the guardian family consent
   * gate). Called AFTER contract parsing rejected all client identity
   * fields and BEFORE the idempotency ledger / turn start; throwing
   * ContractValidationError rejects the submission fail-closed. Absent →
   * no additional gate (pre-R1-06 behavior).
   */
  readonly authorizeTurn?: (actor: Readonly<ActorContext>) => void;
  /**
   * R1-06 family cancellation policy: may `canceller` stop a turn owned by
   * `owner`? Only consulted when the canceller is NOT the owner (own-turn
   * cancel keeps the existing actorId scoping). Absent → guardian-style
   * cross-principal cancel is not permitted (pre-R1-06 behavior).
   */
  readonly cancelPolicy?: (
    canceller: Readonly<ActorContext>,
    owner: { readonly actorId: string; readonly childRef: string | null; readonly turnId: string },
  ) => boolean;
  /**
   * R1-06 trusted persona style provider (guardian `guardian_config` path).
   * Called per submission; the returned value is re-validated by the
   * pipeline's persona resolution (fail-closed, like the actor).
   */
  readonly resolvePersonaStyle?: () => unknown;
  /**
   * R1-09 (issue #21) conversation-recording gate, server-owned and evaluated
   * dynamically (the guardian `conversation_recording` feature switch).
   * - true / absent → pre-R1-09 behavior: the conversation history of each
   *   conversation is retained (bounded per conversation) and ended turn
   *   streams stay available for SSE replay within the process lifetime.
   * - false → 默认最小化采集: NO conversation text is retained (history
   *   stays empty; each turn runs context-free) and an ended turn stream is
   *   removed from the registry immediately (the event buffer carries the
   *   child text + output text, so a completed turn is a temp artifact that
   *   must not outlive its live consumers). Late SSE subscribers after the
   *   end see the same indistinguishable "not available" answer — disclosed
   *   in docs/MEMORY_POLICY.md.
   */
  readonly isRecordingEnabled?: () => boolean;
}

export interface InteractionService {
  /** POST /api/v1/interactions (contract §4). */
  submitInteraction(params: {
    readonly body: unknown;
    readonly actor: unknown;
  }): Promise<SubmitInteractionResult>;
  /** GET /api/v1/interactions/{traceId}/events (contract §5, SSE). */
  openEventStream(params: {
    readonly actor: unknown;
    readonly traceId: unknown;
    /** SSE Last-Event-ID seq to resume after (absent/invalid → full replay). */
    readonly lastEventSeq?: unknown;
  }): OpenEventStreamResult;
  /** POST /api/v1/interactions/{turnId}/cancel (contract §6). */
  cancelTurn(params: {
    readonly actor: unknown;
    readonly urlTurnId: unknown;
    readonly body: unknown;
  }): Promise<CancelTurnResult>;
  /** Test/audit surface: the in-memory conversation ids owned by an actor. */
  conversationsOwnedBy(actorId: unknown): readonly string[];
  /**
   * R1-09 server-internal lifecycle surface (used only by the server-side
   * data-lifecycle service behind guardian-authorized HTTP routes): the
   * retained conversation records (ids + history CONTENT) and turn-stream
   * counters for one actor. Never exposed over HTTP as-is.
   */
  childDataSnapshot(actorId: unknown): {
    readonly conversations: readonly {
      readonly conversationId: string;
      readonly sessionId: string;
      readonly history: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
    }[];
    readonly turnStreams: { readonly total: number; readonly running: number };
  };
  /**
   * R1-09 server-internal lifecycle surface: subject-wide hard delete of
   * every conversation record, retained history entry and turn stream
   * (running turns are aborted first) of one actor. Returns structural
   * counts only — the deleted content is never returned. `sessions` lists
   * the erased conversations' sessionIds (including conversations created
   * while the erase was settling — review round 1 P2-1) so the lifecycle
   * service can close their DSH mappings after the records are gone.
   */
  eraseChildData(actorId: unknown): Promise<{
    readonly conversations: number;
    readonly historyEntries: number;
    readonly turnStreams: number;
    readonly sessions: readonly string[];
  }>;
  /**
   * R1-09 review round 1 (P0-1) internal observability surface: the
   * idempotency-ledger entries of one actor. Content-free by construction
   * (requestId + ack ids + the 64-bit payload digest — never the submitted
   * text). Never exposed over HTTP as-is; used by lifecycle tests to prove
   * the ledger carries no child content.
   */
  idempotencySnapshot(actorId: unknown): readonly {
    readonly requestId: string;
    readonly conversationId: string;
    readonly turnId: string;
    readonly traceId: string;
    readonly acceptedAt: string;
    readonly fingerprint: string;
  }[];

  // -- R1-08 encrypted runtime snapshot restore ports (issue #20) -----------
  /**
   * R1-08 boot-time restore: re-materialize retained conversation records
   * from an encrypted snapshot. Called ONCE at composition by the runtime
   * wiring (never from an HTTP path); every record is re-validated
   * fail-closed (contract-id grammars, bounded history, known roles) and
   * records bind to the SERVER-PINNED child actorId — a snapshot can never
   * fabricate a conversation for another actor. Duplicate conversation ids
   * inside the restore payload (or colliding with live state) fail closed.
   */
  restoreChildData(
    records: unknown,
    actorId: unknown,
  ): { readonly conversations: number; readonly historyEntries: number };
  /**
   * R1-08 boot-time restore: re-seed the (actorId, requestId) idempotency
   * ledger from the snapshot so pre-restart requestIds keep their replay
   * protection. Entries are re-validated fail-closed (contract grammars,
   * 16-hex fingerprint, bounded timestamps).
   */
  restoreIdempotencyLedger(
    entries: unknown,
    actorId: unknown,
  ): { readonly entries: number };
}

// ---------------------------------------------------------------------------
// Server-owned web MVP identity (dev MVP; real auth is R1-06)
// ---------------------------------------------------------------------------

/** Verified actor constants of the R1-05 web MVP (synthetic demo child). */
export const WEB_MVP_ACTOR_ID = "act_webmvp_demo01" as const;
export const WEB_MVP_CHILD_REF = "chd_demo_001" as const;
export const WEB_MVP_VERIFIED_BY = "web-mvp-local-identity" as const;
/** Demo child age (both first-party skills cover 8 years: 4-11 / 5-16). */
export const WEB_MVP_DEMO_CHILD_AGE_YEARS = 8 as const;

/**
 * Resolve the server-verified actor for one request. NOTHING about the
 * client can influence any field: identity is constructed server-side from
 * pinned constants (R1-06 replaces this with real verification; the
 * contract already rejects any client-submitted identity field).
 */
export function resolveWebMvpActor(nowIso: string): Readonly<ActorContext> {
  return parseActorContext({
    role: "child",
    actorId: WEB_MVP_ACTOR_ID,
    childRef: WEB_MVP_CHILD_REF,
    verifiedBy: WEB_MVP_VERIFIED_BY,
    verifiedAt: nowIso,
  });
}

// ---------------------------------------------------------------------------
// Bounded body reader (contract-layer guard; carried #13/#14 review note)
// ---------------------------------------------------------------------------

/**
 * The endpoint never spreads an unbounded body: `Content-Length` and the
 * actually-read bytes are both capped BEFORE parsing. 64 KiB is generous
 * against the 4000-code-point text cap (≤ 16 KiB UTF-8) and far below any
 * memory risk.
 */
export const MAX_INTERACTION_BODY_BYTES = 64 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super("The request body exceeds the endpoint size cap.");
    this.name = "BodyTooLargeError";
  }
}

/** Minimal structural view of a web ReadableStream (types differ per lib). */
interface ReadableStreamLike<T> {
  getReader(): { read(): Promise<{ done: boolean; value?: T }> };
}

/**
 * Normalize a web ReadableStream or an async iterable of chunks into one
 * async iterable (framework-free; no casts on the call sites).
 */
async function* normalizeChunks(
  body: AsyncIterable<Uint8Array> | ReadableStreamLike<Uint8Array>,
): AsyncGenerator<Uint8Array, void, unknown> {
  const candidate = body as {
    readonly getReader?: () => { read(): Promise<{ done: boolean; value?: Uint8Array }> };
    readonly [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
  };
  if (typeof candidate.getReader === "function") {
    const reader = candidate.getReader();
    for (;;) {
      const step = await reader.read();
      if (step.done) {
        return;
      }
      if (step.value !== undefined) {
        yield step.value;
      }
    }
    return;
  }
  if (typeof candidate[Symbol.asyncIterator] === "function") {
    yield* body as AsyncIterable<Uint8Array>;
    return;
  }
  throw new ContractValidationError([
    problem("CONTRACT_FIELD_MISSING", "body", "A JSON request body is required."),
  ]);
}

/**
 * Read a web ReadableStream<Uint8Array> (or async iterable of chunks) with
 * a hard byte cap. Framework-free; the route passes `request.body`.
 */
export async function readJsonBodyWithCap(
  body: AsyncIterable<Uint8Array> | ReadableStreamLike<Uint8Array> | null,
  maxBytes: number = MAX_INTERACTION_BODY_BYTES,
): Promise<unknown> {
  if (body === null) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_MISSING", "body", "A JSON request body is required."),
    ]);
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let total = 0;
  let text = "";
  for await (const chunk of normalizeChunks(body)) {
    const bytes = chunk.byteLength;
    total += bytes;
    if (total > maxBytes) {
      throw new BodyTooLargeError();
    }
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  if (text.length === 0) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_MISSING", "body", "A JSON request body is required."),
    ]);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "body", "The request body must be valid JSON."),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

interface ConversationRecord {
  readonly conversationId: string;
  readonly actorId: string;
  readonly sessionId: string;
  history: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
}

/** Terminal stream states of one accepted turn. */
type TurnStreamStatus = "running" | "ended";

interface TurnStream {
  readonly traceId: string;
  readonly turnId: string;
  readonly conversationId: string;
  readonly actorId: string;
  /** Server-resolved childRef of the owning actor (family cancel policy). */
  readonly childRef: string | null;
  readonly controller: AbortController;
  events: StreamEvent[];
  seq: number;
  status: TurnStreamStatus;
  /**
   * Role that aborted this turn (set by the cancel path; null while the
   * turn runs untouched) — the `turn.cancelled` `by` attribution.
   */
  cancelledBy: "child" | "guardian" | "system" | null;
  /** Resolves when the stream reached its terminal state (stream.end pushed). */
  readonly ended: Promise<void>;
  /** Resolver of `ended`; owned by the stream so endStream can signal it. */
  readonly resolveEnded: () => void;
  waiters: Set<() => void>;
}

const MAX_IDEMPOTENCY_LEDGER_ENTRIES = 500;
const MAX_CONVERSATIONS_PER_ACTOR = 32;
const MAX_HISTORY_ENTRIES = 40;
const DEFAULT_FRAGMENT_CODE_POINTS = 12;
const DEFAULT_INTER_FRAME_DELAY_MS = 30;
const DEFAULT_CANCEL_SETTLE_MS = 5_000;
/**
 * Bounded re-scan rounds of the erase settle loop (review round 1 P2-1):
 * each round aborts streams that surfaced while the previous settle was
 * yielding. Three rounds bound the erase even under a pathological submit
 * storm; anything still running after the last round stays consumption-
 * revoked and is deleted by the final synchronous pass.
 */
const MAX_ERASE_SETTLE_ROUNDS = 3;

/**
 * The cancel event's `by` role. Text interactions and cancels only admit
 * child|guardian|system (voice_device is rejected upstream by the contract
 * role matrix); this defensive projection keeps the payload type exact.
 * R1-06: the recorded `cancelledBy` attribution (whoever actually aborted —
 * including a family guardian via the cancel policy) wins over the owner's
 * own role.
 */
function cancelledByFor(
  stream: TurnStream,
  actor: Readonly<ActorContext>,
): "child" | "guardian" | "system" {
  if (stream.cancelledBy !== null) {
    return stream.cancelledBy;
  }
  return actor.role === "guardian" || actor.role === "system" ? actor.role : "child";
}

function defaultIdFactory(clock: () => number): (kind: ContractIdKind) => string {
  let counter = 0;
  return (kind) => {
    counter += 1;
    const body =
      `${clock().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    // Grammar: <prefix><8-64 body>; every consumer re-validates fail-closed.
    return `${CONTRACT_ID_PREFIXES[kind]}${body}`;
  };
}

/**
 * Map any thrown value into the sanctioned error exit (envelope + HTTP
 * status from the contract registry). Exported so the thin Next.js route
 * handlers (e.g. body-read failures before the service sees the request)
 * use the exact same fail-closed mapping.
 */
export function safeErrorResult(
  error: unknown,
  safeContext: Record<string, unknown>,
  now: string,
): {
  readonly kind: "error";
  readonly httpStatus: number;
  readonly envelope: Readonly<ErrorEnvelope>;
} {
  // The transport body cap maps to the contract's own too-long code (413):
  // it is a request-size rejection, not an internal failure.
  const cause =
    error instanceof BodyTooLargeError
      ? new ContractValidationError([
          problem(
            "CONTRACT_TEXT_TOO_LONG",
            "body",
            "The request body exceeds the endpoint size cap.",
            { limitBytes: MAX_INTERACTION_BODY_BYTES },
          ),
        ])
      : error;
  const envelope = toSafeErrorEnvelope(cause, { safeContext, now });
  let httpStatus = CONTRACT_ERROR_REGISTRY.CONTRACT_INTERNAL.httpStatus;
  if (cause instanceof ContractValidationError && cause.problems.length > 0) {
    const first: ContractProblem | undefined = cause.problems[0];
    if (first !== undefined) {
      httpStatus = CONTRACT_ERROR_REGISTRY[first.code].httpStatus;
    }
  }
  return { kind: "error", httpStatus, envelope };
}

// ---------------------------------------------------------------------------
// R1-08 snapshot restore payload validators (pure; shared by the boot ports
// and the composition root's all-or-nothing pre-validation)
// ---------------------------------------------------------------------------

const RESTORED_CONTENT_MAX_CODE_POINTS = TEXT_LIMITS.maxChars * 2;
const FINGERPRINT_HEX_PATTERN = /^[0-9a-f]{16}$/;

export interface RestoredChildDataRecord {
  readonly conversationId: string;
  readonly sessionId: string;
  readonly history: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
}

/**
 * Validate a restored child-data payload (fail-closed, no commit): contract
 * id grammars, bounded history, known roles, unique ids. The conversation
 * ids must not collide with the service's LIVE state — so the collision
 * check is injected (null for the pure pre-validation pass, the live set
 * for the commit port).
 */
export function validateChildDataRestorePayload(
  records: unknown,
  liveConversationIds: ReadonlySet<string> | null,
): readonly RestoredChildDataRecord[] {
  if (!Array.isArray(records)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "records", "restored child data must be an array."),
    ]);
  }
  if (records.length > MAX_CONVERSATIONS_PER_ACTOR) {
    throw new ContractValidationError([
      problem(
        "CONTRACT_FIELD_INVALID",
        "records",
        `restored child data exceeds the ${MAX_CONVERSATIONS_PER_ACTOR}-conversation bound.`,
      ),
    ]);
  }
  const prepared: RestoredChildDataRecord[] = [];
  const seen = new Set<string>();
  for (const raw of records) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ContractValidationError([
        problem("CONTRACT_FIELD_INVALID", "records", "restored conversation record must be an object."),
      ]);
    }
    const record = raw as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3 ||
      !isValidContractId("conversationId", record.conversationId) ||
      !isValidContractId("sessionId", record.sessionId) ||
      !Array.isArray(record.history)
    ) {
      throw new ContractValidationError([
        problem(
          "CONTRACT_FIELD_INVALID",
          "records",
          "restored conversation record must carry a grammar-valid conversationId, sessionId and history array (no other fields).",
        ),
      ]);
    }
    const conversationId = record.conversationId as string;
    if (seen.has(conversationId) || liveConversationIds?.has(conversationId) === true) {
      throw new ContractValidationError([
        problem(
          "CONTRACT_FIELD_INVALID",
          "records",
          "restored conversation ids must be unique and must not collide with live state.",
        ),
      ]);
    }
    seen.add(conversationId);
    if (record.history.length > MAX_HISTORY_ENTRIES) {
      throw new ContractValidationError([
        problem(
          "CONTRACT_FIELD_INVALID",
          "history",
          `restored history exceeds the ${MAX_HISTORY_ENTRIES}-entry bound.`,
        ),
      ]);
    }
    const history: { readonly role: "user" | "assistant"; readonly content: string }[] = [];
    for (const rawEntry of record.history) {
      if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        throw new ContractValidationError([
          problem("CONTRACT_FIELD_INVALID", "history", "restored history entry must be an object."),
        ]);
      }
      const entry = rawEntry as Record<string, unknown>;
      const role = entry.role;
      const content = entry.content;
      if (
        Object.keys(entry).length !== 2 ||
        (role !== "user" && role !== "assistant") ||
        typeof content !== "string" ||
        [...content].length === 0 ||
        [...content].length > RESTORED_CONTENT_MAX_CODE_POINTS
      ) {
        throw new ContractValidationError([
          problem(
            "CONTRACT_FIELD_INVALID",
            "history",
            "restored history entry must carry a known role and bounded content (no other fields).",
          ),
        ]);
      }
      history.push(Object.freeze({ role, content }));
    }
    prepared.push(
      Object.freeze({
        conversationId,
        sessionId: record.sessionId as string,
        history: Object.freeze(history),
      }),
    );
  }
  return Object.freeze(prepared);
}

/**
 * Validate a restored idempotency-ledger payload (fail-closed, no commit):
 * contract id grammars, bounded timestamps, 16-hex content-free fingerprints.
 */
export function validateIdempotencyRestorePayload(entries: unknown): readonly StoredInteraction[] {
  if (!Array.isArray(entries)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "entries", "restored ledger entries must be an array."),
    ]);
  }
  if (entries.length > MAX_IDEMPOTENCY_LEDGER_ENTRIES) {
    throw new ContractValidationError([
      problem(
        "CONTRACT_FIELD_INVALID",
        "entries",
        `restored ledger exceeds the ${MAX_IDEMPOTENCY_LEDGER_ENTRIES}-entry bound.`,
      ),
    ]);
  }
  const prepared = entries.map((raw) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ContractValidationError([
        problem("CONTRACT_FIELD_INVALID", "entries", "restored ledger entry must be an object."),
      ]);
    }
    const entry = raw as Record<string, unknown>;
    if (
      Object.keys(entry).length !== 6 ||
      !isValidContractId("requestId", entry.requestId) ||
      !isValidContractId("conversationId", entry.conversationId) ||
      !isValidContractId("turnId", entry.turnId) ||
      !isValidContractId("traceId", entry.traceId) ||
      typeof entry.acceptedAt !== "string" ||
      entry.acceptedAt.length === 0 ||
      entry.acceptedAt.length > 40 ||
      typeof entry.fingerprint !== "string" ||
      !FINGERPRINT_HEX_PATTERN.test(entry.fingerprint)
    ) {
      throw new ContractValidationError([
        problem(
          "CONTRACT_FIELD_INVALID",
          "entries",
          "restored ledger entry must carry grammar-valid ids, a bounded timestamp and a 16-hex fingerprint (no other fields).",
        ),
      ]);
    }
    return Object.freeze({
      requestId: entry.requestId as string,
      conversationId: entry.conversationId as string,
      turnId: entry.turnId as string,
      traceId: entry.traceId as string,
      acceptedAt: entry.acceptedAt,
      fingerprint: entry.fingerprint,
    }) as StoredInteraction;
  });
  return Object.freeze(prepared);
}

export function createInteractionService(options: InteractionServiceOptions): InteractionService {
  const pipeline = options.pipeline;
  const entrance = options.entrance ?? "ui_web";
  const ingress = options.ingress ?? "web";
  const clock = options.clock ?? (() => Date.now());
  const nowFactory =
    options.nowFactory ?? (() => new Date().toISOString());
  const idFactory = options.idFactory ?? defaultIdFactory(clock);
  const fragmentCodePoints = Math.max(
    1,
    Math.min(options.stream?.fragmentCodePoints ?? DEFAULT_FRAGMENT_CODE_POINTS, 1000),
  );
  const interFrameDelayMs = Math.max(0, options.stream?.interFrameDelayMs ?? DEFAULT_INTER_FRAME_DELAY_MS);
  const cancelSettleMs = options.cancelSettleMs ?? DEFAULT_CANCEL_SETTLE_MS;
  const childAgeYears = options.childAgeYears;
  const authorizeTurn = options.authorizeTurn;
  const cancelPolicy = options.cancelPolicy;
  const resolvePersonaStyle = options.resolvePersonaStyle;
  // R1-09 recording gate: absent → recording enabled (pre-R1-09 behavior;
  // every pre-existing rig keeps its semantics). The composed web runtime
  // wires the guardian `conversation_recording` switch (default OFF).
  const isRecordingEnabled = options.isRecordingEnabled ?? (() => true);

  /** conversationId → record (in-memory, process-local). */
  const conversations = new Map<string, ConversationRecord>();
  /** (actorId, requestId) → stored interaction (carried #13/#14 keying). */
  const idempotencyLedger = new Map<string, StoredInteraction>();
  /** traceId → in-flight or finished turn stream. */
  const turnStreams = new Map<string, TurnStream>();
  /** turnId → traceId (cancel lookup). */
  const turnIndex = new Map<string, string>();

  function rememberLedger(key: string, stored: StoredInteraction): void {
    idempotencyLedger.set(key, stored);
    if (idempotencyLedger.size > MAX_IDEMPOTENCY_LEDGER_ENTRIES) {
      const oldest = idempotencyLedger.keys().next();
      if (oldest.done !== true) {
        idempotencyLedger.delete(oldest.value);
      }
    }
  }

  function conversationsOwnedBy(actorId: unknown): readonly string[] {
    const owned: string[] = [];
    if (typeof actorId !== "string") {
      return owned;
    }
    for (const record of conversations.values()) {
      if (record.actorId === actorId) {
        owned.push(record.conversationId);
      }
    }
    return owned;
  }

  function newTurnStream(ids: {
    readonly traceId: string;
    readonly turnId: string;
    readonly conversationId: string;
    readonly actorId: string;
    readonly childRef: string | null;
  }): TurnStream {
    let resolveEnded!: () => void;
    const ended = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });
    const stream: TurnStream = {
      traceId: ids.traceId,
      turnId: ids.turnId,
      conversationId: ids.conversationId,
      actorId: ids.actorId,
      childRef: ids.childRef,
      controller: new AbortController(),
      events: [],
      seq: 0,
      status: "running",
      cancelledBy: null,
      ended,
      resolveEnded,
      waiters: new Set(),
    };
    return stream;
  }

  /** Build + validate + buffer one canonical StreamEvent (fail-closed out). */
  function pushEvent(
    stream: TurnStream,
    kind: StreamEventKind,
    payload: StreamEventPayload,
  ): void {
    const event = parseStreamEvent({
      protocolVersion: "1.0",
      kind,
      seq: stream.seq,
      conversationId: stream.conversationId,
      turnId: stream.turnId,
      traceId: stream.traceId,
      occurredAt: nowFactory(),
      payload,
    });
    stream.seq += 1;
    stream.events.push(event);
    for (const wake of stream.waiters) {
      wake();
    }
  }

  function endStream(stream: TurnStream): void {
    if (stream.status === "ended") {
      return;
    }
    pushEvent(stream, "stream.end", { type: "end" });
    stream.status = "ended";
    for (const wake of stream.waiters) {
      wake();
    }
    stream.resolveEnded();
    // R1-09 minimal collection: with the recording switch OFF, the ended
    // turn's event buffer (child text + gate-approved output) is a temp
    // artifact that must not outlive its live consumers. Live SSE iterators
    // hold their own reference (they keep working); a subscriber arriving
    // after the purge gets the same indistinguishable "not available" as a
    // foreign trace. With recording ON, streams stay available for replay
    // (pre-R1-09 behavior) until an explicit lifecycle erase.
    if (!isRecordingEnabled()) {
      turnStreams.delete(stream.traceId);
      turnIndex.delete(stream.turnId);
    }
  }

  async function delayAbortable(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0 || signal.aborted) {
      return;
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      const onAbort = () => done();
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve();
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function appendHistory(
    record: ConversationRecord,
    entry: { readonly role: "user" | "assistant"; readonly content: string },
  ): void {
    const next = [...record.history, ingestDomainFact({ ...entry })] as ConversationRecord["history"];
    record.history = next.length > MAX_HISTORY_ENTRIES ? next.slice(next.length - MAX_HISTORY_ENTRIES) : next;
  }

  /** Background turn runner: real pipeline → paced gate-approved fragments. */
  function startTurn(params: {
    readonly actor: Readonly<ActorContext>;
    readonly event: Readonly<InteractionEvent>;
    readonly sessionId: string;
    readonly record: ConversationRecord;
  }): void {
    const { actor, event, sessionId, record } = params;
    const stream = newTurnStream({
      traceId: event.traceId,
      turnId: event.turnId,
      conversationId: event.conversationId,
      actorId: actor.actorId,
      childRef: actor.childRef,
    });
    turnStreams.set(stream.traceId, stream);
    turnIndex.set(stream.turnId, stream.traceId);

    const runner = (async (): Promise<void> => {
      pushEvent(stream, "stream.started", { type: "started", acceptedAt: nowFactory() });

      let result: Readonly<CordisTurnResult> | null = null;
      try {
        result = await pipeline.runTurn({
          entrance,
          actor,
          session: { sessionId, conversationId: event.conversationId },
          event,
          childAgeYears,
          history: record.history,
          signal: stream.controller.signal,
          // R1-06: the trusted family style (guardian_config provenance) is
          // re-validated inside the pipeline's persona resolution.
          ...(resolvePersonaStyle === undefined ? {} : { personaStyle: resolvePersonaStyle() }),
        });
      } catch {
        // A pipeline contract violation is a server bug: degrade fail-closed
        // with the sanctioned error exit — never leak the thrown value.
        pushEvent(stream, "stream.error", {
          type: "error",
          error: toSafeErrorEnvelope(new Error("pipeline failure"), { now: nowFactory() }),
        });
        endStream(stream);
        return;
      }

      const response = result.response;

      // History discipline (server-owned, per-conversation scoped): the
      // user text is carried forward only when the input was NOT blocked;
      // assistant text only for completed, gate-approved output. One child
      // can never see another child's history: records are keyed by
      // conversation and bound to the verified actor at submit time.
      // R1-09 recording gate: with the guardian recording switch OFF the
      // conversation content is NEVER retained (默认最小化采集) — the turn
      // still executes normally, but neither side of the exchange is stored,
      // so the next turn runs context-free (disclosed trade-off,
      // docs/MEMORY_POLICY.md).
      const recording = isRecordingEnabled();
      const inputBlocked = result.safetyTraces.some(
        (trace) => trace.layer === "input" && trace.decision === "block",
      );
      if (recording && !inputBlocked) {
        appendHistory(record, { role: "user", content: event.text.content });
      }
      if (recording && response.status === "completed" && response.content !== null) {
        appendHistory(record, { role: "assistant", content: response.content.text });
      }

      // Cancellation that already happened (caller stop) → terminal
      // cancelled frames; no content of a cancelled turn is ever emitted.
      if (stream.controller.signal.aborted) {
        pushEvent(stream, "turn.cancelled", { type: "cancelled", by: cancelledByFor(stream, actor) });
        endStream(stream);
        return;
      }

      if (response.status === "completed" && response.content !== null) {
        // Emit the gate-approved text as bounded short fragments. Stop
        // between fragments revokes the remaining consumption immediately.
        const codePoints = [...response.content.text];
        let cursor = 0;
        while (cursor < codePoints.length) {
          if (stream.controller.signal.aborted) {
            break;
          }
          const fragment = codePoints.slice(cursor, cursor + fragmentCodePoints).join("");
          cursor += fragmentCodePoints;
          pushEvent(stream, "agent.delta", { type: "delta", text: fragment });
          await delayAbortable(interFrameDelayMs, stream.controller.signal);
        }
        if (stream.controller.signal.aborted) {
          pushEvent(stream, "turn.cancelled", { type: "cancelled", by: cancelledByFor(stream, actor) });
          endStream(stream);
          return;
        }
        pushEvent(stream, "agent.completed", { type: "completed", response });
        endStream(stream);
        return;
      }

      // cancelled / ignored / failed turns never carry content (the
      // contract parser enforces it); surface the terminal response.
      pushEvent(stream, "agent.completed", { type: "completed", response });
      endStream(stream);
    })();

    // Last-resort guard: an unexpected throw inside the runner (its event
    // emission is fail-closed by construction) must never become an
    // unhandled rejection that crashes the whole serving process.
    void runner.catch(() => {
      try {
        if (stream.status !== "ended") {
          pushEvent(stream, "stream.error", {
            type: "error",
            error: toSafeErrorEnvelope(new Error("runner failure"), { now: nowFactory() }),
          });
          endStream(stream);
        }
      } catch {
        // Nothing more can be done safely; the subscriber sees a closed
        // stream and the client surfaces its retriable network state.
      }
    });
  }

  return Object.freeze({
    async submitInteraction(params: {
      readonly body: unknown;
      readonly actor: unknown;
    }): Promise<SubmitInteractionResult> {
      const now = nowFactory();
      let verified: Readonly<ActorContext>;
      try {
        verified = parseActorContext(params.actor);
      } catch (error) {
        return safeErrorResult(error, {}, now);
      }
      const safeContext = { requestId: extractClientRequestId(params.body) };
      try {
        // 1. Fail-closed request parsing (rejects client identity fields).
        const request: Readonly<InteractionRequest> = parseInteractionRequest(params.body);

        // 2. R1-06 submit-time authorization (e.g. family consent gate):
        // runs BEFORE the idempotency ledger, so a revoked authorization
        // rejects even replays — no new model work can start.
        if (authorizeTurn !== undefined) {
          authorizeTurn(verified);
        }

        // 3. Idempotency ledger keyed to (verifiedActor, requestId).
        const ledgerKey = `${verified.actorId}\u0000${request.interaction.clientRequestId}`;
        const stored = idempotencyLedger.get(ledgerKey) ?? null;
        const decision = resolveIdempotentRetry({ stored, incomingRequest: request });
        if (decision.action === "replay") {
          return {
            kind: "ack",
            httpStatus: 200,
            body: buildDuplicateAck(decision.stored, { now }),
          };
        }
        if (decision.action === "conflict") {
          rejectDuplicateRequest();
        }

        // 4. Conversation ownership (server-owned; cross-actor continuation
        // is a CONTRACT_CROSS_CONVERSATION rejection, no existence leak).
        const owned = conversationsOwnedBy(verified.actorId);
        const requested = request.interaction.conversationId;
        let conversationId: string;
        let sessionId: string;
        if (requested === undefined) {
          conversationId = idFactory("conversationId");
          sessionId = idFactory("sessionId");
          if (owned.length >= MAX_CONVERSATIONS_PER_ACTOR) {
            throw new ContractValidationError([
              problem(
                "CONTRACT_FIELD_INVALID",
                "interaction.conversationId",
                "The conversation limit for this actor was reached.",
              ),
            ]);
          }
        } else {
          const record = conversations.get(requested);
          if (record === undefined || record.actorId !== verified.actorId) {
            throw new ContractValidationError([
              problem(
                "CONTRACT_CROSS_CONVERSATION",
                "interaction.conversationId",
                "The submitted conversation is not bound to the verified actor.",
              ),
            ]);
          }
          conversationId = record.conversationId;
          sessionId = record.sessionId;
        }

        // 5. Canonical event (contract normalization, ingress server-decided).
        const { event } = normalizeInteractionRequest(request, {
          actor: verified,
          ingress,
          eventId: idFactory("eventId"),
          conversationId,
          turnId: idFactory("turnId"),
          traceId: idFactory("traceId"),
          occurredAt: now,
          boundConversationIds: owned,
        });

        // 6. Session binding (server-owned SessionRef; re-validated).
        createSessionRef(verified, { sessionId, conversationId, createdAt: now });

        // 7. Ledger BEFORE execution so replays can never double-execute.
        rememberLedger(ledgerKey, {
          requestId: request.interaction.clientRequestId,
          conversationId,
          turnId: event.turnId,
          traceId: event.traceId,
          acceptedAt: now,
          fingerprint: fingerprintInteractionRequest(request),
        });

        // 8. Conversation record + background turn.
        let record = conversations.get(conversationId);
        if (record === undefined) {
          record = {
            conversationId,
            actorId: verified.actorId,
            sessionId,
            history: [],
          };
          conversations.set(conversationId, record);
        }
        startTurn({ actor: verified, event, sessionId, record });

        // 9. Immediate contract ack (child connects to the SSE stream).
        return {
          kind: "ack",
          httpStatus: 200,
          body: buildInteractionAck({
            requestId: request.interaction.clientRequestId,
            conversationId,
            turnId: event.turnId,
            traceId: event.traceId,
            acceptedAt: now,
          }),
        };
      } catch (error) {
        return safeErrorResult(error, safeContext, nowFactory());
      }
    },

    openEventStream(params: {
      readonly actor: unknown;
      readonly traceId: unknown;
      readonly lastEventSeq?: unknown;
    }): OpenEventStreamResult {
      const now = nowFactory();
      let verified: Readonly<ActorContext>;
      try {
        verified = parseActorContext(params.actor);
      } catch (error) {
        return safeErrorResult(error, {}, now);
      }
      if (typeof params.traceId !== "string" || params.traceId.length === 0 || params.traceId.length > 80) {
        return safeErrorResult(
          new ContractValidationError([
            problem("CONTRACT_FIELD_INVALID", "traceId", "traceId must be a bounded contract id."),
          ]),
          {},
          now,
        );
      }
      const stream = turnStreams.get(params.traceId);
      // Actor scoping: a foreign or unknown trace is indistinguishable —
      // one child can never observe another child's stream (carried #38
      // review note on server-side per-session scoping).
      if (stream === undefined || stream.actorId !== verified.actorId) {
        return safeErrorResult(
          new ContractValidationError([
            problem(
              "CONTRACT_FIELD_INVALID",
              "traceId",
              "The referenced event stream is not available for the verified actor.",
            ),
          ]),
          {},
          now,
        );
      }
      let fromSeq = 0;
      if (
        typeof params.lastEventSeq === "number" &&
        Number.isInteger(params.lastEventSeq) &&
        params.lastEventSeq >= 0 &&
        params.lastEventSeq <= stream.seq
      ) {
        fromSeq = params.lastEventSeq + 1;
      }

      const boundedStream: TurnStream = stream;
      const readEnded = (): boolean => boundedStream.status === "ended";

      const iterate = async function* (): AsyncGenerator<string, void, unknown> {
        let cursor = fromSeq;
        for (;;) {
          if (cursor < boundedStream.events.length) {
            const event = boundedStream.events[cursor];
            cursor += 1;
            if (event !== undefined) {
              yield `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
            }
            continue;
          }
          if (readEnded()) {
            return;
          }
          let wake!: () => void;
          const next = new Promise<void>((resolve) => {
            wake = resolve;
          });
          boundedStream.waiters.add(wake);
          try {
            // Re-check after registration (single-threaded: no lost wakeup).
            if (cursor < boundedStream.events.length || readEnded()) {
              continue;
            }
            await next;
          } finally {
            boundedStream.waiters.delete(wake);
          }
        }
      };

      return { kind: "stream", events: iterate() };
    },

    async cancelTurn(params: {
      readonly actor: unknown;
      readonly urlTurnId: unknown;
      readonly body: unknown;
    }): Promise<CancelTurnResult> {
      const now = nowFactory();
      let verified: Readonly<ActorContext>;
      try {
        verified = parseActorContext(params.actor);
      } catch (error) {
        return safeErrorResult(error, {}, now);
      }
      const bodyRecord =
        params.body !== null && typeof params.body === "object" && !Array.isArray(params.body)
          ? (params.body as Record<string, unknown>)
          : {};
      const safeContext = { turnId: params.urlTurnId, conversationId: bodyRecord.conversationId };
      try {
        if (typeof params.urlTurnId !== "string" || params.urlTurnId.length === 0 || params.urlTurnId.length > 80) {
          throw new ContractValidationError([
            problem("CONTRACT_FIELD_INVALID", "turnId", "turnId must be a bounded contract id."),
          ]);
        }
        // Role matrix + shape validation (parseTurnCancelRequest).
        const request: Readonly<TurnCancelRequest> = parseTurnCancelRequest(params.body, verified);
        if (request.turnId !== params.urlTurnId) {
          throw new ContractValidationError([
            problem(
              "CONTRACT_FIELD_INVALID",
              "turnId",
              "The URL turnId and the body turnId must match.",
            ),
          ]);
        }
        const traceId = turnIndex.get(request.turnId);
        const stream = traceId === undefined ? undefined : turnStreams.get(traceId);
        // Ownership: the turn's owner always may cancel; R1-06 additionally
        // consults the family cancel policy (guardian stops own-family child
        // turns). Unknown, foreign and policy-denied turns are all the same
        // safe no-op — no existence leak.
        let permitted = stream !== undefined && stream.actorId === verified.actorId;
        if (
          !permitted &&
          stream !== undefined &&
          cancelPolicy !== undefined
        ) {
          permitted = cancelPolicy(verified, {
            actorId: stream.actorId,
            childRef: stream.childRef,
            turnId: stream.turnId,
          });
        }
        if (stream === undefined || !permitted) {
          // Unknown or foreign turn: safe no-op without existence leaks.
          return {
            kind: "result",
            httpStatus: 200,
            body: buildCancelResult(request, "unknown_turn", now),
          };
        }
        if (stream.conversationId !== request.conversationId) {
          return {
            kind: "result",
            httpStatus: 200,
            body: buildCancelResult(request, "unknown_turn", now),
          };
        }
        if (stream.status === "ended") {
          return {
            kind: "result",
            httpStatus: 200,
            body: buildCancelResult(request, "already_final", now),
          };
        }
        // Honest attribution: record WHO aborted (owner or family guardian)
        // before signalling, so `turn.cancelled.by` names the real canceller.
        stream.cancelledBy =
          verified.role === "guardian" || verified.role === "system" ? verified.role : "child";
        // First-class caller cancellation: aborts the in-flight model call
        // and terminates remaining fragment emission (see module header for
        // the documented true-cancel boundary).
        stream.controller.abort();
        await Promise.race([stream.ended, delayAbortable(cancelSettleMs, new AbortController().signal)]);
        return {
          kind: "result",
          httpStatus: 200,
          body: buildCancelResult(request, "cancelled", now),
        };
      } catch (error) {
        return safeErrorResult(error, safeContext, nowFactory());
      }
    },

    conversationsOwnedBy,

    childDataSnapshot(actorId: unknown): {
      readonly conversations: readonly {
        readonly conversationId: string;
        readonly sessionId: string;
        readonly history: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
      }[];
      readonly turnStreams: { readonly total: number; readonly running: number };
    } {
      const owned: {
        readonly conversationId: string;
        readonly sessionId: string;
        readonly history: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
      }[] = [];
      if (typeof actorId !== "string") {
        return Object.freeze({ conversations: Object.freeze(owned), turnStreams: { total: 0, running: 0 } });
      }
      for (const record of conversations.values()) {
        if (record.actorId === actorId) {
          owned.push({
            conversationId: record.conversationId,
            sessionId: record.sessionId,
            history: record.history.map((entry) => ({ role: entry.role, content: entry.content })),
          });
        }
      }
      let total = 0;
      let running = 0;
      for (const stream of turnStreams.values()) {
        if (stream.actorId === actorId) {
          total += 1;
          if (stream.status === "running") {
            running += 1;
          }
        }
      }
      return Object.freeze({ conversations: Object.freeze(owned), turnStreams: { total, running } });
    },

    async eraseChildData(actorId: unknown): Promise<{
      readonly conversations: number;
      readonly historyEntries: number;
      readonly turnStreams: number;
      readonly sessions: readonly string[];
    }> {
      if (typeof actorId !== "string") {
        return { conversations: 0, historyEntries: 0, turnStreams: 0, sessions: [] };
      }
      /** Distinct owned streams this erase revoked or deleted (accounting). */
      const revokedStreams = new Set<string>();
      /** Bounded settle: the streams' terminal ticks or 1s, whichever first. */
      const settleStreams = async (streams: readonly TurnStream[]): Promise<void> => {
        await Promise.race([
          Promise.all(streams.map((stream) => stream.ended)),
          delayAbortable(1_000, new AbortController().signal),
        ]);
      };
      const abortRunning = (streams: readonly TurnStream[]): void => {
        for (const stream of streams) {
          if (stream.status === "running") {
            // Honest attribution: the abort is performed by the SERVER
            // lifecycle operation (cancelledBy=system, content-free frame);
            // the guardian's operator identity lives in the data_erase
            // audit entry of the guardian service.
            stream.cancelledBy = "system";
            stream.controller.abort();
          }
        }
      };
      // 1. Abort every running turn of this actor first (data erase wins over
      // in-flight work; cancelled output never reaches the child).
      const ownedStreams = [...turnStreams.values()].filter((stream) => stream.actorId === actorId);
      for (const stream of ownedStreams) {
        revokedStreams.add(stream.traceId);
      }
      abortRunning(ownedStreams);
      // 2. Give the runners their terminal tick (bounded; a runner that has
      // not settled by then still had its consumption revoked via abort).
      await settleStreams(ownedStreams);
      // 2b. Review round 1 P2-1: the settle above YIELDS the event loop, so
      // a submit interleaving inside the window registers NEW streams after
      // the snapshot in step 1. Re-scan until quiescent (bounded rounds) and
      // abort every late stream the same way — its output must never reach
      // the child either. A pathological submit storm cannot spin the erase
      // forever: after the last round any straggler stays consumption-
      // revoked and the final pass below still deletes it.
      for (let round = 0; round < MAX_ERASE_SETTLE_ROUNDS; round += 1) {
        const lateStreams = [...turnStreams.values()].filter(
          (stream) => stream.actorId === actorId && stream.status === "running",
        );
        if (lateStreams.length === 0) {
          break;
        }
        for (const stream of lateStreams) {
          revokedStreams.add(stream.traceId);
        }
        abortRunning(lateStreams);
        await settleStreams(lateStreams);
      }
      // 3./4. FINAL SYNCHRONOUS PASS — no await between this enumeration and
      // the deletions, so no submit can interleave anymore (single-threaded
      // event loop): the erase cannot return while a window-submitted turn's
      // buffer or index entry survives.
      let historyEntries = 0;
      const erasedConversations = new Set<string>();
      const erasedSessions = new Set<string>();
      for (const record of conversations.values()) {
        if (record.actorId === actorId) {
          historyEntries += record.history.length;
          erasedConversations.add(record.conversationId);
          erasedSessions.add(record.sessionId);
        }
      }
      for (const conversationId of erasedConversations) {
        conversations.delete(conversationId);
      }
      // Hard-delete every owned turn stream + its turn index entry (the
      // event buffers carry child text: 临时工件 must not survive the erase).
      // Streams that already ended were self-purged when recording is OFF
      // (endStream) — they are accounted via revokedStreams either way.
      for (const stream of turnStreams.values()) {
        if (stream.actorId === actorId) {
          revokedStreams.add(stream.traceId);
          turnStreams.delete(stream.traceId);
          turnIndex.delete(stream.turnId);
        }
      }
      return {
        conversations: erasedConversations.size,
        historyEntries,
        turnStreams: revokedStreams.size,
        sessions: [...erasedSessions],
      };
    },

    idempotencySnapshot(actorId: unknown): readonly {
      readonly requestId: string;
      readonly conversationId: string;
      readonly turnId: string;
      readonly traceId: string;
      readonly acceptedAt: string;
      readonly fingerprint: string;
    }[] {
      if (typeof actorId !== "string") {
        return Object.freeze([]);
      }
      const prefix = `${actorId}\u0000`;
      const entries: {
        requestId: string;
        conversationId: string;
        turnId: string;
        traceId: string;
        acceptedAt: string;
        fingerprint: string;
      }[] = [];
      for (const [key, stored] of idempotencyLedger) {
        if (key.startsWith(prefix)) {
          entries.push({
            requestId: stored.requestId,
            conversationId: stored.conversationId,
            turnId: stored.turnId,
            traceId: stored.traceId,
            acceptedAt: stored.acceptedAt,
            fingerprint: stored.fingerprint,
          });
        }
      }
      return Object.freeze(entries);
    },

    // -- R1-08 encrypted runtime snapshot restore ports (issue #20) ----------

    restoreChildData(
      records: unknown,
      actorId: unknown,
    ): { readonly conversations: number; readonly historyEntries: number } {
      if (typeof actorId !== "string") {
        throw new ContractValidationError([
          problem("CONTRACT_FIELD_INVALID", "actorId", "restore requires a server-pinned actor id string."),
        ]);
      }
      // Validate (incl. live-state collision) before any commit.
      const prepared = validateChildDataRestorePayload(
        records,
        new Set(conversations.keys()),
      );
      // Commit phase: bind every restored record to the SERVER-PINNED actor.
      let historyEntries = 0;
      for (const item of prepared) {
        historyEntries += item.history.length;
        conversations.set(item.conversationId, {
          conversationId: item.conversationId,
          actorId: actorId as string,
          // The original sessionId is preserved for the inventory/audit
          // surfaces; the DSH mapping itself is NOT restored (a fresh
          // process mints a new mapped session on the next turn — disclosed).
          sessionId: item.sessionId,
          history: item.history,
        } satisfies ConversationRecord);
      }
      return { conversations: prepared.length, historyEntries };
    },

    restoreIdempotencyLedger(
      entries: unknown,
      actorId: unknown,
    ): { readonly entries: number } {
      if (typeof actorId !== "string") {
        throw new ContractValidationError([
          problem("CONTRACT_FIELD_INVALID", "actorId", "restore requires a server-pinned actor id string."),
        ]);
      }
      const prepared = validateIdempotencyRestorePayload(entries);
      for (const stored of prepared) {
        rememberLedger(`${actorId as string}\u0000${stored.requestId}`, stored);
      }
      return { entries: prepared.length };
    },
  });
}

function buildCancelResult(
  request: Readonly<TurnCancelRequest>,
  status: "cancelled" | "already_final" | "unknown_turn",
  now: string,
): Readonly<TurnCancelResult> {
  return parseTurnCancelResult({
    protocolVersion: "1.0",
    turnId: request.turnId,
    conversationId: request.conversationId,
    status,
    resolvedAt: now,
  });
}

/** Extract a grammar-checkable requestId for error-echo context (or null). */
function extractClientRequestId(body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const interaction = (body as Record<string, unknown>).interaction;
  if (interaction === null || typeof interaction !== "object" || Array.isArray(interaction)) {
    return undefined;
  }
  return (interaction as Record<string, unknown>).clientRequestId;
}
