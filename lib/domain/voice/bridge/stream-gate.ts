/**
 * R1-V2 Bridge stream gate — Orchestrator-side live delta handling
 * (issue #29 实现范围 4; docs/VOICE_RUNTIME.md §6; ADR-002).
 *
 * Every `assistant.delta` event is:
 *  1. bound to (sessionKey, turnId, epoch, attemptId, stepId, index) and
 *     re-fenced through the R1-V1 trusted store (`fenceOutput` with kind
 *     `text_delta`) — a delta from a fenced epoch/terminal turn is
 *     rejected HERE, never merely dropped downstream;
 *  2. order-checked: per (session, turn, attempt) the index must be
 *     strictly increasing — replays and reordering are rejectable. Gaps
 *     are tolerated because the Bridge drops non-text channel chunks
 *     upstream (VOICE_RUNTIME §6 order validation on the text channel);
 *  3. buffered per attempt and split at short-sentence boundaries (。！？；
 *     ！?；\n) with bounded caps (backpressure);
 *  4. every complete sentence passes the REAL R1-15 children Output Gate
 *     (fail-closed) BEFORE TTS admission, which itself re-fences through
 *     `fenceOutput(kind: "tts_queue")` — un-gated raw tokens can never
 *     reach TTS, and a sentence blocked by the gate is never queued.
 *
 * Tool-call / thinking content never enters the buffer (the Bridge drops
 * those channels; this module defends in depth and would refuse them).
 * Durable messages never take this path at all.
 *
 * PRIVACY: deltas are transient and volatile — buffered only in memory
 * for sentence assembly, never persisted, audited or logged. Audit and
 * metric shapes are content-free.
 *
 * This module must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { ContractValidationError, problem } from "../../contract/core.ts";
import { evaluateOutputGate, type OutputGateFunction, type OutputGateResult } from "../../safety/output-gate.ts";
import type { VoiceTurnOrchestrator } from "../orchestrator.ts";
import type { BridgeAssistantDeltaPayload } from "./ipc-contract.ts";

// ---------------------------------------------------------------------------
// Constants + results
// ---------------------------------------------------------------------------

/** Sentence terminators that flush a buffer (short-sentence boundary). */
const SENTENCE_TERMINATORS = Object.freeze(["。", "！", "？", "!", "?", "；", ";", "\n"] as const);

/** Max chars of one buffered sentence before a forced gate flush. */
export const BRIDGE_MAX_SENTENCE_CHARS = 64;

/** Max buffered chars per attempt before backpressure rejects the stream. */
export const BRIDGE_MAX_BUFFERED_CHARS = 512;

export type StreamGateRejectCode =
  | "turn_unknown"
  | "stale_turn_rejected"
  | "epoch_forged"
  | "attempt_mismatch"
  | "index_gap"
  | "buffer_overflow";

export interface StreamGateDeltaResult {
  readonly ok: boolean;
  readonly code: "ok" | StreamGateRejectCode;
  readonly ttsAdmitted: number;
  readonly ttsBlocked: number;
}

export interface StreamGateFlushResult {
  readonly ttsAdmitted: number;
  readonly ttsBlocked: number;
}

export interface StreamGateMetrics {
  readonly deltasFenced: number;
  readonly ttsAdmissions: number;
  readonly ttsBlockedSentences: number;
  /** First-safe-text latency per attempt: first admission − first delta. */
  readonly firstSafeText: { readonly count: number; readonly maxMs: number };
  /**
   * E2E-07 (issue #57): admitted sentences whose delivery sink THREW — the
   * content-free TTS slot stays queued (the turn still settles) but the
   * sentence text never reached the wired TTS input. Fail-closed direction:
   * a wiring fault can never crash the stream, it is only ever counted.
   */
  readonly sentenceDeliveryFailures: number;
}

/**
 * E2E-07 (issue #57): one Output-Gate-admitted TTS sentence, handed to an
 * optional delivery sink (the wired xiaozhi bridge transport). The text is
 * the authorized TTS INPUT (it already passed the children Output Gate and
 * the `tts_queue` fence); it is transient — the sink must not persist,
 * audit or log it. `itemId` is the exact id queued in the trusted store, so
 * the wired device edge can correlate real audio accounting (frame counts +
 * digests reported by the pinned server) back to this admission.
 */
export interface AdmittedSentenceEntry {
  readonly sessionKey: string;
  readonly turnId: string;
  readonly epoch: number;
  readonly itemId: string;
  readonly text: string;
}

export interface BridgeStreamGate {
  handleDelta(payload: BridgeAssistantDeltaPayload): StreamGateDeltaResult;
  /** Flush trailing partial buffer for one session (attempt end). */
  flushSession(sessionKey: string): StreamGateFlushResult;
  /** Clear one turn's buffer (settlement/cancel; volatile only). */
  clearTurn(sessionKey: string, turnId: string): void;
  metricsSnapshot(): Readonly<StreamGateMetrics>;
}

export interface BridgeStreamGateOptions {
  readonly orchestrator: VoiceTurnOrchestrator;
  /** Defaults to the REAL R1-15 output gate; tests may wrap it. */
  readonly outputGate?: OutputGateFunction;
  readonly clock?: () => number;
  readonly maxSentenceChars?: number;
  readonly maxBufferedChars?: number;
  /**
   * E2E-07 (issue #57): optional delivery sink for admitted sentences. When
   * omitted (every pre-existing composition), admission stays exactly the
   * v1.2 synthetic contract: the text is dropped after gating and only the
   * content-free slot is queued. When present, the gate mints the TTS item
   * id ITSELF (previously the orchestrator minted it), hands the identical
   * id to the `tts_queue` fence and delivers the fence-stamped sentence.
   */
  readonly onAdmittedSentence?: (entry: AdmittedSentenceEntry) => void;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface AttemptBuffer {
  readonly sessionKey: string;
  readonly turnId: string;
  readonly attemptId: string;
  text: string;
  nextIndex: number;
  firstDeltaAtMs: number;
  firstSafeTextRecorded: boolean;
}

function failGateParse(path: string, message: string): never {
  throw new ContractValidationError([problem("CONTRACT_FIELD_INVALID", path, message)]);
}

/** Split buffered text into complete sentences + the trailing partial. */
function splitSentences(text: string, maxSentenceChars: number): { readonly complete: string[]; readonly partial: string } {
  const complete: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if ((SENTENCE_TERMINATORS as readonly string[]).includes(ch)) {
      complete.push(text.slice(start, i + 1));
      start = i + 1;
      continue;
    }
    if (i - start + 1 >= maxSentenceChars) {
      complete.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  return { complete, partial: text.slice(start) };
}

/** Create the bridge stream gate over the R1-V1 orchestrator. */
export function createBridgeStreamGate(options: BridgeStreamGateOptions): BridgeStreamGate {
  if (options === null || typeof options !== "object") {
    failGateParse("options", "stream gate options must be an object.");
  }
  if (typeof options.orchestrator !== "object" || options.orchestrator === null) {
    failGateParse("options.orchestrator", "the voice turn orchestrator is required.");
  }
  const orchestrator = options.orchestrator;
  const outputGate = options.outputGate ?? evaluateOutputGate;
  const clock = options.clock ?? (() => Date.now());
  const maxSentenceChars = Math.max(8, Math.min(options.maxSentenceChars ?? BRIDGE_MAX_SENTENCE_CHARS, 1024));
  const maxBufferedChars = Math.max(maxSentenceChars, Math.min(options.maxBufferedChars ?? BRIDGE_MAX_BUFFERED_CHARS, 8192));

  const buffers = new Map<string, AttemptBuffer>(); // key: `${sessionKey}|${turnId}`
  const metrics = {
    deltasFenced: 0,
    ttsAdmissions: 0,
    ttsBlockedSentences: 0,
    firstSafeText: { count: 0, maxMs: 0 },
    sentenceDeliveryFailures: 0,
  };
  const onAdmittedSentence = options.onAdmittedSentence ?? null;
  // E2E-07: per-gate monotonic TTS item-id sequence. The gate mints the id
  // (same `tts_<turn-suffix>_<n>` shape the orchestrator's default minter
  // uses) so the queued slot, the sink delivery and the wired audio
  // accounting all reference ONE id. Monotonic per gate ⇒ no clock-tie
  // collisions between sentences of the same turn.
  let itemSeq = 0;

  function bufferKey(sessionKey: string, turnId: string): string {
    return `${sessionKey}|${turnId}`;
  }

  /**
   * Gate one complete sentence: REAL output gate first (fail-closed), then
   * the TTS fence re-check. Blocked or fenced sentences are never queued.
   * E2E-07: when a delivery sink is wired, the gate mints the TTS item id,
   * queues THAT id and (only after the fence admits) delivers the
   * fence-stamped sentence text. A throwing sink is counted, never raised —
   * the stream must not crash on a wiring fault (fail-closed observability).
   */
  function admitSentence(buffer: AttemptBuffer, sentence: string): { admitted: number; blocked: number } {
    let gate: OutputGateResult;
    try {
      gate = outputGate({ content: sentence, refs: { turnId: buffer.turnId } });
    } catch {
      // A throwing gate is a fail-closed block (issue #27 AC 2 discipline).
      metrics.ttsBlockedSentences += 1;
      return { admitted: 0, blocked: 1 };
    }
    if (gate.decision !== "allow") {
      metrics.ttsBlockedSentences += 1;
      return { admitted: 0, blocked: 1 };
    }
    // One epoch observation shared by the fence and the sink delivery: the
    // store re-validates it anyway (fenceOutput re-checks the CURRENT epoch).
    const turnEpoch = orchestrator.describeTurn(buffer.sessionKey, buffer.turnId)?.epoch ?? -1;
    let itemId: string | null = null;
    if (onAdmittedSentence !== null) {
      itemSeq += 1;
      itemId = `tts_${buffer.turnId.slice(4)}_${itemSeq.toString().padStart(6, "0")}`;
    }
    const fence = orchestrator.fenceOutput({
      sessionKey: buffer.sessionKey,
      turnId: buffer.turnId,
      epoch: turnEpoch,
      kind: "tts_queue",
      ...(itemId !== null ? { ttsItemId: itemId } : {}),
    });
    if (!fence.ok) {
      // The turn was fenced between delta and admission: stale, dropped.
      return { admitted: 0, blocked: 0 };
    }
    metrics.ttsAdmissions += 1;
    if (!buffer.firstSafeTextRecorded) {
      buffer.firstSafeTextRecorded = true;
      const ms = Math.max(0, clock() - buffer.firstDeltaAtMs);
      metrics.firstSafeText.count += 1;
      if (ms > metrics.firstSafeText.maxMs) {
        (metrics.firstSafeText as { maxMs: number }).maxMs = ms;
      }
    }
    if (onAdmittedSentence !== null && itemId !== null) {
      try {
        onAdmittedSentence({
          sessionKey: buffer.sessionKey,
          turnId: buffer.turnId,
          epoch: turnEpoch,
          itemId,
          text: sentence,
        });
      } catch {
        // Fail-closed: a broken sink must never crash the stream; the
        // content-free slot stays queued (the turn settles normally) and
        // the wiring fault is only ever counted, never swallowed silently.
        metrics.sentenceDeliveryFailures += 1;
      }
    }
    return { admitted: 1, blocked: 0 };
  }

  const gate: BridgeStreamGate = {
    handleDelta(payload) {
      if (payload === null || typeof payload !== "object") {
        failGateParse("payload", "delta payload must be an object.");
      }
      const turn = orchestrator.describeTurn(payload.sessionKey, payload.turnId);
      if (turn === null) {
        return { ok: false, code: "turn_unknown", ttsAdmitted: 0, ttsBlocked: 0 };
      }
      if (turn.epoch !== payload.epoch) {
        const code = payload.epoch > turn.epoch ? "epoch_forged" : "stale_turn_rejected";
        metrics.deltasFenced += 1;
        return { ok: false, code, ttsAdmitted: 0, ttsBlocked: 0 };
      }
      // The trusted fence: only a RUNNING turn at the CURRENT epoch may emit.
      const fence = orchestrator.fenceOutput({
        sessionKey: payload.sessionKey,
        turnId: payload.turnId,
        epoch: payload.epoch,
        kind: "text_delta",
      });
      if (!fence.ok) {
        metrics.deltasFenced += 1;
        return { ok: false, code: fence.code as StreamGateRejectCode, ttsAdmitted: 0, ttsBlocked: 0 };
      }

      const key = bufferKey(payload.sessionKey, payload.turnId);
      let buffer = buffers.get(key);
      if (buffer === undefined) {
        buffer = {
          sessionKey: payload.sessionKey,
          turnId: payload.turnId,
          attemptId: payload.attemptId,
          text: "",
          nextIndex: payload.index,
          firstDeltaAtMs: clock(),
          firstSafeTextRecorded: false,
        };
        buffers.set(key, buffer);
      } else if (buffer.attemptId !== payload.attemptId) {
        return { ok: false, code: "attempt_mismatch", ttsAdmitted: 0, ttsBlocked: 0 };
      } else if (payload.index <= buffer.nextIndex) {
        // Replay or backwards reordering within the attempt.
        return { ok: false, code: "index_gap", ttsAdmitted: 0, ttsBlocked: 0 };
      }
      buffer.nextIndex = payload.index;
      if (buffer.text.length + payload.text.length > maxBufferedChars) {
        // Backpressure: drop the volatile buffer, reject the delta.
        buffers.delete(key);
        return { ok: false, code: "buffer_overflow", ttsAdmitted: 0, ttsBlocked: 0 };
      }
      buffer.text += payload.text;

      const { complete, partial } = splitSentences(buffer.text, maxSentenceChars);
      buffer.text = partial;
      let admitted = 0;
      let blocked = 0;
      for (const sentence of complete) {
        const result = admitSentence(buffer, sentence);
        admitted += result.admitted;
        blocked += result.blocked;
      }
      return { ok: true, code: "ok", ttsAdmitted: admitted, ttsBlocked: blocked };
    },

    flushSession(sessionKey) {
      let admitted = 0;
      let blocked = 0;
      for (const [key, buffer] of [...buffers.entries()]) {
        if (buffer.sessionKey !== sessionKey || buffer.text.length === 0) {
          continue;
        }
        const result = admitSentence(buffer, buffer.text);
        admitted += result.admitted;
        blocked += result.blocked;
        buffer.text = "";
        if (result.admitted === 0 && result.blocked === 0 && !buffer.firstSafeTextRecorded) {
          // Nothing left to keep: the turn settled or fenced.
        }
        void key;
      }
      return { ttsAdmitted: admitted, ttsBlocked: blocked };
    },

    clearTurn(sessionKey, turnId) {
      buffers.delete(bufferKey(sessionKey, turnId));
    },

    metricsSnapshot() {
      return { ...metrics };
    },
  };
  return Object.freeze(gate);
}
