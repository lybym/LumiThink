/**
 * R1-V3 Voice Gateway Adapter — the device/protocol edge service (issue #30
 * 实现范围 1/3; docs/VOICE_RUNTIME.md §2 "Voice Adapter (标识映射/鉴权)" box,
 * §4 strict interruption ordering; docs/VOICE_GATEWAY_PROTOCOL.md).
 *
 * The Adapter translates the pinned xiaozhi v2.5.2 protocol surface into the
 * trusted Core (Turn Orchestrator / Bridge composition) commands and back:
 *
 * - 设备可信绑定: every event is authorized through the binding registry
 *   (connection lease + connection-scoped xiaozhi session). Unknown devices,
 *   bound-deviceId possession spoofing, duplicate connections, forged session
 *   ids and cross-session refs are rejected enumerated BEFORE any core call.
 *   The hello MUST present the binding's activation digest (possession
 *   proof) — transport-layer authentication is layered ON TOP of this
 *   in-contract check, never a silent precondition of it.
 * - ASR final/partial: a partial is only a candidate (never an interruption,
 *   不是每一帧 VAD 都提升 epoch). An authorized final transcript — length-
 *   capped by the protocol parser and screened by the REAL R1-15 Input
 *   Safety Gate (`evaluateInputGate`, entrance "voice") — continues into the
 *   authorized TRANSIENT channel (issue #51 / E2E-01): the verbatim text is
 *   handed to the core port's protected single-turn call
 *   (`submitPrompt.transientText`) and discarded when the call returns. The
 *   text NEVER enters audit/metrics/directives/snapshots. Its only
 *   content-derived residue is a KEYED fingerprint (injected
 *   `asrFingerprint` — HMAC-SHA256 with a per-process key from the server
 *   composition) used for idempotent dedup: a bare FNV-1a digest no longer
 *   poses as the transcript's privacy guarantee. Gate-blocked or over-long
 *   text fails closed with an enumerated code before any core call.
 * - ASR duplicate finals (E2E-05, issue #55): a real streaming ASR path can
 *   deliver the SAME final twice for one utterance (endpoint double-fire,
 *   reconnect replay). A final whose keyed fingerprint equals the last
 *   ACCEPTED final's fingerprint within a bounded dedup window (and with no
 *   new-utterance device signal in between) is a suppressed enumerated
 *   no-op — no second turn, no second model request, no text anywhere. A
 *   `listen start`/`detect` (new utterance) or a fresh connection clears
 *   the memory, so a legitimately repeated utterance is never confused with
 *   a provider duplicate. The window also bounds the cost of the
 *   conservative direction: a genuine same-text repeat WITHIN the window is
 *   treated as part of the same utterance (fail-safe: one execution beats
 *   two).
 * - Content-independent ASR metrics (E2E-05): endpoint-window count, final
 *   accept latency (event arrival → core submit completion, ms) and the
 *   duplicate-suppression count are recorded content-free for the evidence
 *   snapshot (docs/VOICE_RUNTIME.md §16; the pinned server's wire carries
 *   transcript text only — provider confidence is structurally not exposed
 *   and is recorded as such, never synthesized).
 * - Content-independent TTS metrics (E2E-06, issue #56): turns played,
 *   sentences/frames delivered, first-audio latency (accepted final → first
 *   frame batch of that turn), inter-sentence gaps, stop-effective latency
 *   (abort arrival → device stop directive) and stale-audio suppression are
 *   recorded content-free for the evidence snapshot, alongside the
 *   hello-negotiated downlink sample rate per device. No audio bytes exist
 *   on this contract surface (frame counts + hex digests only); the real
 *   vendor TTS runs inside the pinned xiaozhi server (deploy tier
 *   gateway-tts-real, lib/server/real-tts-composition.ts activation record).
 * - client_abort (wire `abort`): the ONLY device signal that fences. Order
 *   is fence-first (VOICE_RUNTIME §4): the core barge-in atomically bumps
 *   the trusted epoch, then the Adapter issues the device playback-stop
 *   directive, clears the device-bound TTS send path and drops stale queue
 *   items. Consecutive aborts without fresh playback are enumerated no-ops
 *   (no second epoch bump, no duplicate stop).
 * - 播放停止 / TTS 队列清空 / Opus 音频发送: every outbound frame batch is
 *   re-fenced against the CURRENT trusted epoch (`audio_send`) before it is
 *   handed to the device sink; stale batches are counted and dropped, never
 *   sent. Queue clears are evidence (droppedStale counts), not silent.
 * - Session/turn/epoch mapping: the Adapter keeps the per-device mapping
 *   (connectionId, xiaozhiSessionId) → (sessionKey, current turn, epoch) and
 *   exposes it content-free; the xiaozhi session id is never an identity.
 *
 * FAULTS (issue #30 实现范围 3): late ASR, consecutive aborts, server
 * restart, out-of-order output, network drop/reconnect and duplicate device
 * connections are driven through mock-xiaozhi.ts + fixtures.ts; every state
 * change here is a synchronous, bounded store op — no timers, no waits, so
 * the state machine cannot deadlock on the device edge.
 *
 * PRIVACY: audit and metric shapes are content-free (ids, epochs, codes,
 * counts, digests). ASR text lives only inside one handler call frame.
 *
 * This module must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { ingestDomainFact } from "../../legacy-guard.ts";
import { evaluateInputGate } from "../../safety/input-gate.ts";
import { VOICE_TERMINAL_TURN_STATES, type VoiceTurnState } from "../schema.ts";
import type {
  GatewayDeviceBindingRegistry,
  GatewayBindingCode,
} from "./binding.ts";
import {
  parseGatewayDeviceEvent,
  type GatewayDeviceDirective,
  type GatewayDeviceEvent,
  type GatewayPlaybackStopReason,
  type GatewayRejectionCode,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Core port (implemented by the server composition over the Bridge stack)
// ---------------------------------------------------------------------------

/** The trusted Core surface the Adapter drives. The control-plane calls
 * (open/prompt/barge-in) go through the Bridge IPC and stay async; the
 * Orchestrator store ops are SYNCHRONOUS so event-tap ordering (frames →
 * stop → next dispatch) is deterministic — no microtask races. */
export interface GatewayCorePort {
  /** Open (or continue) the trusted session for one device binding. */
  openCoreSession(refs: {
    readonly sessionKey: string;
    readonly conversationId: string;
    readonly ownerActorId: string;
  }): Promise<{ readonly ok: true; readonly recovered: boolean; readonly continued: boolean } | { readonly ok: false; readonly code: string }>;
  /**
   * Submit one new prompt (ASR final). The content-free fingerprint drives
   * idempotent dedup; `transientText` is the authorized verbatim transcript
   * for THIS turn's protected single-turn invocation — the implementation
   * must keep it transient (necessary IPC + approved model request only)
   * and destroy it on failure/cancel (issue #51).
   */
  submitPrompt(refs: {
    readonly sessionKey: string;
    readonly traceId: string | null;
    readonly idempotencyKey: string;
    readonly fingerprint: string;
    readonly transientText: string;
  }): Promise<{ readonly ok: true; readonly turnId: string; readonly dispatched: boolean } | { readonly ok: false; readonly code: string }>;
  /** The fence-first interruption flow (VOICE_RUNTIME §4 steps 1–4). */
  bargeIn(refs: {
    readonly sessionKey: string;
    readonly turnId: string;
    readonly reason: "device_abort";
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: string; readonly fenced: boolean }>;
  readonly currentEpoch: (sessionKey: string) => number | null;
  readonly describeTurn: (sessionKey: string, turnId: string) => { readonly state: VoiceTurnState; readonly epoch: number } | null;
  /** Defense-in-depth audio fence before ANY frame batch leaves (§5). */
  readonly fenceAudioSend: (refs: {
    readonly sessionKey: string;
    readonly turnId: string;
    readonly epoch: number;
  }) => { readonly ok: true } | { readonly ok: false; readonly code: string };
  /** Deliver current-epoch TTS items; stale items are permanently dropped. */
  readonly drainTts: (sessionKey: string) => { readonly ok: true; readonly deliverable: readonly { readonly itemId: string; readonly turnId: string; readonly epoch: number }[]; readonly droppedStale: number } | { readonly ok: false; readonly code: string };
  /** RUNNING/CANCELLING turns older than the budget → TIMED_OUT. */
  readonly sweepTimeouts: (refs: {
    readonly sessionKey: string;
    readonly budgetMs: number;
  }) => { readonly ok: true; readonly timedOutTurnIds: readonly string[] } | { readonly ok: false; readonly code: string };
}

// ---------------------------------------------------------------------------
// Metrics + audit (content-free)
// ---------------------------------------------------------------------------

export interface GatewayMetricsSnapshot {
  readonly eventsAccepted: number;
  readonly eventsRejected: number;
  readonly asrFinalsAccepted: number;
  readonly asrPartialsSeen: number;
  readonly inputGateBlocked: number;
  readonly interruptCandidates: number;
  readonly abortsFenced: number;
  readonly abortsWithoutPlayback: number;
  readonly framesSent: number;
  readonly staleFramesRejected: number;
  readonly playbackStopsIssued: number;
  readonly queueClears: number;
  readonly duplicateConnectionsRefused: number;
  readonly possessionRefused: number;
  readonly forgedSessionsRefused: number;
  readonly suspensions: number;
  /** E2E-05: new-utterance windows opened by device listen start/detect. */
  readonly asrEndpointWindows: number;
  /** E2E-05: duplicate finals suppressed inside the dedup window (no-op). */
  readonly asrDuplicateFinalsSuppressed: number;
  /**
   * E2E-05: content-independent processing latency of accepted finals —
   * device-edge event arrival → protected single-turn submit completion.
   * Candidate baseline (virtual-clock measurable), never an SLA claim.
   */
  readonly asrFinalAcceptMs: { readonly count: number; readonly maxMs: number };
  /** E2E-06: turns whose TTS reached the device sink (first frame batch sent). */
  readonly ttsTurnsPlayed: number;
  /** E2E-06: TTS sentence items delivered to the device sink (frame batches). */
  readonly ttsSentencesSent: number;
  /** E2E-06: raw frame count delivered (synthetic framing; no audio bytes exist). */
  readonly ttsFramesSent: number;
  /**
   * E2E-06: stale TTS queue items suppressed after cancel/fence (fenced
   * batches + dropped-stale queue items) — the "取消后残余音频" counter; the
   * old-epoch audio DELIVERED count is structurally 0 (drainTts + re-fence).
   */
  readonly ttsStaleAudioSuppressed: number;
  /** E2E-06: accepted final → first frame batch of that turn (ms; candidate). */
  readonly ttsFirstAudioMs: { readonly count: number; readonly maxMs: number };
  /** E2E-06: gap between consecutive frame batches in one turn (ms; candidate). */
  readonly ttsInterSentenceGapMs: { readonly count: number; readonly maxMs: number };
  /** E2E-06: abort arrival → device stop directive issued (ms; candidate). */
  readonly ttsStopEffectiveMs: { readonly count: number; readonly maxMs: number };
}

export interface GatewayAuditEntry {
  readonly seq: number;
  readonly atMs: number;
  readonly action:
    | "gateway.event_rejected"
    | "gateway.asr_final_accepted"
    | "gateway.asr_partial_seen"
    | "gateway.asr_duplicate_suppressed"
    | "gateway.abort_fenced"
    | "gateway.abort_no_playback"
    | "gateway.frames_sent"
    | "gateway.frames_fenced"
    | "gateway.playback_stopped"
    | "gateway.queue_cleared"
    | "gateway.playback_suspended"
    | "gateway.swept";
  readonly sessionKey: string | null;
  readonly turnId: string | null;
  readonly epoch: number | null;
  /** Enumerated code, count or hex digest — never content. */
  readonly detail: string | null;
  readonly count: number | null;
}

export interface GatewayMappingSnapshotEntry {
  readonly deviceId: string;
  readonly connectionId: string | null;
  readonly xiaozhiSessionId: string | null;
  readonly sessionKey: string;
  readonly actorId: string;
  readonly conversationId: string;
  readonly connected: boolean;
  readonly playbackTurnId: string | null;
  readonly playbackEpoch: number | null;
  /** E2E-06: sample rate negotiated at hello (content-free; 16/24 kHz). */
  readonly downlinkSampleRate: number | null;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const GATEWAY_ADAPTER_VERSION = "1.3" as const;

/** Synthetic frames per admitted TTS sentence (POC stand-in for Opus framing). */
export const GATEWAY_FRAMES_PER_SENTENCE_DEFAULT = 4;

/**
 * E2E-05: bounded window in which a second final with the SAME keyed
 * fingerprint as the last accepted one is treated as a provider duplicate
 * (endpoint double-fire / reconnect replay) and suppressed as an enumerated
 * no-op. A device listen start/detect (new utterance) clears the memory
 * unconditionally, so a legitimately repeated utterance is never confused
 * with a duplicate once the device signals a new turn; the memory itself
 * is PER DEVICE and survives a reconnect (see the hello handler).
 */
export const GATEWAY_ASR_DUPLICATE_WINDOW_MS_DEFAULT = 2_000;

/** Timeout sweep budget default for gateway-driven sweeps (ms). */
export const GATEWAY_SWEEP_BUDGET_MS_DEFAULT = 30_000;

/** Max audit ring entries. */
export const GATEWAY_MAX_AUDIT_ENTRIES = 512;

/** Max exactly-once stop memories kept per device (bounded per-device state;
 * oldest entries are reclaimed first — see issuePlaybackStop). */
export const GATEWAY_MAX_STOPS_TRACKED = 64;

export interface VoiceGatewayAdapterOptions {
  readonly core: GatewayCorePort;
  readonly binding: GatewayDeviceBindingRegistry;
  /**
   * KEYED transcript digest for idempotent dedup (issue #51: 必要去重使用有
   * 明确用途和密钥生命周期的 HMAC). The server composition injects an
   * HMAC-SHA256 hex digest over a per-process random key (never logged,
   * never persisted, discarded with the process). Required — the adapter
   * refuses to be created without it, so no bare/unkeyed digest can silently
   * degrade into the old privacy pretense.
   */
  readonly asrFingerprint: (text: string) => string;
  readonly clock?: () => number;
  readonly framesPerSentence?: number;
  readonly sweepBudgetMs?: number;
  readonly auditCapacity?: number;
  /** E2E-05: dedup window for same-fingerprint duplicate finals (ms). */
  readonly asrDuplicateWindowMs?: number;
  /** Direction sink for device-bound directives (mock in tests). */
  readonly sink?: (directive: GatewayDeviceDirective) => void;
}

export type GatewayEventOutcome =
  | { readonly ok: true; readonly kind: GatewayDeviceEvent["kind"]; readonly sessionKey: string | null }
  | { readonly ok: false; readonly code: GatewayRejectionCode };

interface DeviceState {
  readonly deviceId: string;
  readonly actorId: string;
  readonly conversationId: string;
  sessionKey: string;
  connectionId: string | null;
  xiaozhiSessionId: string | null;
  playback: { readonly turnId: string; readonly epoch: number } | null;
  readonly stopsIssued: Set<string>;
  turnCounter: number;
  /**
   * E2E-05: the last ACCEPTED final's keyed fingerprint and accept time —
   * the duplicate-dedup memory. PER DEVICE: cleared by every new-utterance
   * signal (listen start/detect) and by window expiry; it intentionally
   * SURVIVES a reconnect (a re-delivered final must not mint an error turn
   * on the continued trusted session). Never holds text — the fingerprint
   * is the injected keyed digest, 64 hex.
   */
  lastAcceptedFinal: { readonly fingerprint: string; readonly atMs: number } | null;
  /**
   * E2E-06: sample rate negotiated at hello (content-free number). The
   * pinned server may negotiate the downlink to 24 kHz (docs §1); the
   * pinned TTS provider request carries `sample_rate: conn.sample_rate` —
   * the negotiated value, never a provider-side override.
   */
  downlinkSampleRate: number | null;
  /**
   * E2E-06: the last ACCEPTED final's turn + accept-completion time — the
   * anchor for the first-audio latency measure. Cleared once measured for
   * its turn (or overwritten by the next accepted final).
   */
  lastAcceptedTurn: { readonly turnId: string; readonly acceptedAtMs: number } | null;
  /** E2E-06: clock time of the last frames batch sent within the current playback turn. */
  lastFramesAtMs: number | null;
}

function failAdapterInput(path: string, message: string): never {
  throw new Error(`adapter.${path}: ${message}`);
}

/**
 * 64-bit FNV-1a over a UTF-16 code-unit sequence — the same digest
 * discipline as tests/domain/voice/helpers.ts. Pure TS, no builtins.
 *
 * SCOPE (issue #51): identifier derivation ONLY (session keys, frame-batch
 * digests, replay fingerprints). It must NOT be used on transcripts — the
 * transcript dedup fingerprint is the injected keyed `asrFingerprint`.
 */
export function gatewayContentDigest(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

export interface VoiceGatewayAdapter {
  readonly version: typeof GATEWAY_ADAPTER_VERSION;
  /** Ingest one (already transport-framed) device event; fail-closed. */
  handleDeviceEvent(connectionId: string, raw: unknown): Promise<GatewayEventOutcome>;
  /** Guardian-issued binding entry point (content-free digest only). */
  bindDevice(refs: {
    readonly deviceId: unknown;
    readonly actorId: unknown;
    readonly conversationId: unknown;
    readonly activationDigest: unknown;
  }): { readonly ok: true; readonly created: boolean } | { readonly ok: false; readonly code: GatewayBindingCode };
  /** Drain + fence + send current-epoch TTS to the device sink (deterministic). */
  pumpPlayback(sessionKey: string): { readonly ok: true; readonly sent: number; readonly staleRejected: number; readonly droppedStale: number } | { readonly ok: false; readonly code: string };
  /** Core settlement observation (Bridge turn.settled tap). */
  noteTurnSettled(sessionKey: string, turnId: string, finalState: string): void;
  /** Core worker fault observation (runtime.error worker_crashed tap). */
  noteWorkerFault(sessionKey: string): void;
  /** Timeout sweep for one mapped session. */
  sweep(sessionKey: string): { readonly ok: true; readonly timedOutTurnIds: readonly string[] } | { readonly ok: false; readonly code: string };
  readonly findSessionKeyByDevice: (deviceId: string) => string | null;
  readonly mappingSnapshot: () => readonly Readonly<GatewayMappingSnapshotEntry>[];
  readonly metricsSnapshot: () => Readonly<GatewayMetricsSnapshot>;
  readonly auditSnapshot: () => readonly Readonly<GatewayAuditEntry>[];
  readonly purgeAudit: () => void;
}

export function createVoiceGatewayAdapter(options: VoiceGatewayAdapterOptions): VoiceGatewayAdapter {
  if (options === null || typeof options !== "object") {
    failAdapterInput("options", "adapter options must be an object.");
  }
  const core = options.core;
  const binding = options.binding;
  if (typeof core !== "object" || core === null || typeof binding !== "object" || binding === null) {
    failAdapterInput("options.core/binding", "the core port and the binding registry are required.");
  }
  if (typeof options.asrFingerprint !== "function") {
    failAdapterInput("options.asrFingerprint", "a keyed transcript digest function is required (bare digests must not pose as transcript privacy).");
  }
  const asrFingerprint = options.asrFingerprint;
  const clock = options.clock ?? (() => Date.now());
  const framesPerSentence = Math.max(1, Math.min(options.framesPerSentence ?? GATEWAY_FRAMES_PER_SENTENCE_DEFAULT, 1024));
  const sweepBudgetMs = Math.max(0, options.sweepBudgetMs ?? GATEWAY_SWEEP_BUDGET_MS_DEFAULT);
  const auditCapacity = Math.max(1, Math.min(options.auditCapacity ?? GATEWAY_MAX_AUDIT_ENTRIES, 10_000));
  const asrDuplicateWindowMs = Math.max(0, options.asrDuplicateWindowMs ?? GATEWAY_ASR_DUPLICATE_WINDOW_MS_DEFAULT);
  const sink = options.sink ?? (() => undefined);

  const devices = new Map<string, DeviceState>(); // deviceId -> state
  const audit: GatewayAuditEntry[] = [];
  let auditSeq = 0;
  // Mutable accumulator; snapshots expose it as Readonly<GatewayMetricsSnapshot>.
  const metrics = {
    eventsAccepted: 0,
    eventsRejected: 0,
    asrFinalsAccepted: 0,
    asrPartialsSeen: 0,
    inputGateBlocked: 0,
    interruptCandidates: 0,
    abortsFenced: 0,
    abortsWithoutPlayback: 0,
    framesSent: 0,
    staleFramesRejected: 0,
    playbackStopsIssued: 0,
    queueClears: 0,
    duplicateConnectionsRefused: 0,
    possessionRefused: 0,
    forgedSessionsRefused: 0,
    suspensions: 0,
    asrEndpointWindows: 0,
    asrDuplicateFinalsSuppressed: 0,
    asrFinalAcceptMs: { count: 0, maxMs: 0 },
    ttsTurnsPlayed: 0,
    ttsSentencesSent: 0,
    ttsFramesSent: 0,
    ttsStaleAudioSuppressed: 0,
    ttsFirstAudioMs: { count: 0, maxMs: 0 },
    ttsInterSentenceGapMs: { count: 0, maxMs: 0 },
    ttsStopEffectiveMs: { count: 0, maxMs: 0 },
  };

  function pushAudit(entry: Omit<GatewayAuditEntry, "seq" | "atMs">): void {
    auditSeq += 1;
    const admitted = ingestDomainFact({
      seq: auditSeq,
      atMs: clock(),
      action: entry.action,
      sessionKey: entry.sessionKey,
      turnId: entry.turnId,
      epoch: entry.epoch,
      detail: entry.detail,
      count: entry.count,
    }) as Readonly<GatewayAuditEntry>;
    audit.push(admitted);
    if (audit.length > auditCapacity) {
      audit.shift();
    }
  }

  function reject(code: GatewayRejectionCode, sessionKey: string | null, count = 1): GatewayEventOutcome {
    metrics.eventsRejected += count;
    pushAudit({
      action: "gateway.event_rejected",
      sessionKey,
      turnId: null,
      epoch: null,
      detail: code,
      count,
    });
    return { ok: false, code };
  }

  function emit(directive: GatewayDeviceDirective): void {
    sink(directive);
  }

  function issuePlaybackStop(state: DeviceState, turnId: string | null, reason: GatewayPlaybackStopReason, epoch: number): void {
    if (turnId !== null && state.stopsIssued.has(turnId)) {
      return; // exactly-once stop per turn
    }
    if (turnId !== null) {
      state.stopsIssued.add(turnId);
      // Ring-bound the exactly-once memory: the guard is only consultable
      // while a racing handler for that turn can still be suspended between
      // observation and resume (one event-loop await — never dozens of later
      // playback turns). Insertion order = issue order, so the OLDEST memory
      // is the safest to reclaim; the just-added turn is never evicted.
      if (state.stopsIssued.size > GATEWAY_MAX_STOPS_TRACKED) {
        const oldest = state.stopsIssued.values().next();
        if (oldest.done !== true) {
          state.stopsIssued.delete(oldest.value);
        }
      }
    }
    metrics.playbackStopsIssued += 1;
    pushAudit({
      action: "gateway.playback_stopped",
      sessionKey: state.sessionKey,
      turnId,
      epoch,
      detail: reason,
      count: null,
    });
    emit({
      kind: "tts.stop",
      sessionKey: state.sessionKey,
      turnId,
      epoch,
      reason,
    });
  }

  /** Deterministic session key for one bound device+conversation pair. */
  function deriveSessionKey(deviceId: string, conversationId: string): string {
    return `ses_gw${gatewayContentDigest(`${deviceId}|${conversationId}`)}`;
  }

  function deviceStateBySessionKey(sessionKey: string): DeviceState | null {
    for (const state of devices.values()) {
      if (state.sessionKey === sessionKey) {
        return state;
      }
    }
    return null;
  }

  const adapter: VoiceGatewayAdapter = {
    version: GATEWAY_ADAPTER_VERSION,

    bindDevice(refs) {
      const outcome = binding.bindDevice(refs);
      return outcome.ok ? { ok: true, created: outcome.value.created } : { ok: false, code: outcome.code };
    },

    async handleDeviceEvent(connectionId, raw) {
      if (typeof connectionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/.test(connectionId)) {
        return reject("gateway.parse_failed", null);
      }
      let event: GatewayDeviceEvent;
      try {
        event = parseGatewayDeviceEvent(raw);
      } catch {
        return reject("gateway.parse_failed", null);
      }

      // ---- hello: device possession + trusted binding + connection lease ----
      if (event.kind === "hello") {
        const deviceId = event.deviceId;
        const lease = binding.openConnection({
          connectionId,
          deviceId,
          activationDigest: event.clientDigest,
        });
        if (!lease.ok) {
          if (lease.code === "device_connection_conflict") {
            metrics.duplicateConnectionsRefused += 1;
          }
          if (lease.code === "device_possession_denied") {
            metrics.possessionRefused += 1;
          }
          return reject(lease.code as GatewayRejectionCode, null);
        }
        const bindingRecord = binding.describeBinding(deviceId);
        if (bindingRecord === null) {
          return reject("device_unbound", null);
        }
        let state = devices.get(deviceId);
        if (state === undefined) {
          const sessionKey = deriveSessionKey(deviceId, bindingRecord.conversationId);
          const opened = await core.openCoreSession({
            sessionKey,
            conversationId: bindingRecord.conversationId,
            ownerActorId: bindingRecord.actorId,
          });
          if (!opened.ok) {
            binding.closeConnection({ connectionId, reason: "core_rejected" });
            return reject(opened.code as GatewayRejectionCode, null);
          }
          state = {
            deviceId,
            actorId: bindingRecord.actorId,
            conversationId: bindingRecord.conversationId,
            sessionKey,
            connectionId,
            xiaozhiSessionId: null,
            playback: null,
            stopsIssued: new Set<string>(),
            turnCounter: 0,
            lastAcceptedFinal: null,
            downlinkSampleRate: event.audioParams?.sampleRate ?? null,
            lastAcceptedTurn: null,
            lastFramesAtMs: null,
          };
          devices.set(deviceId, state);
        } else {
          // Reconnect (drop/restart): same trusted session continues; the
          // bridge worker may need recovery, which session.open handles.
          state.connectionId = connectionId;
          state.xiaozhiSessionId = null;
          // E2E-06: the hello renegotiates the audio shape every connection —
          // record the (content-free) sample rate for the evidence snapshot.
          state.downlinkSampleRate = event.audioParams?.sampleRate ?? null;
          // E2E-05: the duplicate-dedup memory is PER DEVICE and survives a
          // reconnect: a final the server re-delivers right after a
          // drop/restart (same keyed fingerprint, inside the bounded window)
          // must not mint an error turn on the continued trusted session
          // (issue #55 DoD: 断线/重连无错轮). The memory is cleared only by
          // a new-utterance device signal (listen start/detect) or by the
          // window expiring — both directions are bounded and documented.
          // state.lastAcceptedFinal intentionally persists here.
          const reopened = await core.openCoreSession({
            sessionKey: state.sessionKey,
            conversationId: state.conversationId,
            ownerActorId: state.actorId,
          });
          if (!reopened.ok && reopened.code !== "session_conflict") {
            binding.closeConnection({ connectionId, reason: "core_rejected" });
            return reject(reopened.code as GatewayRejectionCode, state.sessionKey);
          }
        }
        metrics.eventsAccepted += 1;
        return { ok: true, kind: event.kind, sessionKey: state.sessionKey };
      }

      // ---- server_restart: transport-wide fault, no session id to check ----
      if (event.kind === "server_restart") {
        binding.closeAllConnections({ reason: "server_restart" });
        for (const state of devices.values()) {
          state.connectionId = null;
          state.xiaozhiSessionId = null;
          if (state.playback !== null) {
            state.playback = null;
            state.lastFramesAtMs = null;
            metrics.suspensions += 1;
            pushAudit({
              action: "gateway.playback_suspended",
              sessionKey: state.sessionKey,
              turnId: null,
              epoch: null,
              detail: "server_restart",
              count: null,
            });
          }
        }
        metrics.eventsAccepted += 1;
        return { ok: true, kind: event.kind, sessionKey: null };
      }

      // ---- connection-scoped transport faults ----
      if (event.kind === "connection_dropped") {
        const lease = binding.connectionSnapshot().find((entry) => entry.connectionId === connectionId);
        binding.closeConnection({ connectionId, reason: `dropped_${event.reason}` });
        if (lease) {
          const state = devices.get(lease.deviceId);
          if (state && state.connectionId === connectionId) {
            state.connectionId = null;
            state.xiaozhiSessionId = null;
            if (state.playback !== null) {
              state.playback = null;
              state.lastFramesAtMs = null;
              metrics.suspensions += 1;
              pushAudit({
                action: "gateway.playback_suspended",
                sessionKey: state.sessionKey,
                turnId: null,
                epoch: null,
                detail: `dropped_${event.reason}`,
                count: null,
              });
            }
          }
        }
        metrics.eventsAccepted += 1;
        return { ok: true, kind: event.kind, sessionKey: null };
      }

      // ---- session_issued: record the EPHEMERAL mapping ----
      if (event.kind === "session_issued") {
        const lease = binding.connectionSnapshot().find((entry) => entry.connectionId === connectionId && !entry.closed);
        if (!lease) {
          return reject("connection_unknown", null);
        }
        const state = devices.get(lease.deviceId);
        if (!state) {
          return reject("device_unbound", null);
        }
        const issued = binding.issueSession({
          connectionId,
          sessionKey: state.sessionKey,
          xiaozhiSessionId: event.xiaozhiSessionId,
        });
        if (!issued.ok) {
          return reject(issued.code as GatewayRejectionCode, state.sessionKey);
        }
        state.connectionId = connectionId;
        state.xiaozhiSessionId = event.xiaozhiSessionId;
        metrics.eventsAccepted += 1;
        return { ok: true, kind: event.kind, sessionKey: state.sessionKey };
      }

      // ---- everything else: authorize against the issued mapping ----
      const lease = binding.connectionSnapshot().find((entry) => entry.connectionId === connectionId && !entry.closed);
      if (!lease) {
        return reject("connection_unknown", null);
      }
      const authorized = binding.authorize({
        connectionId,
        xiaozhiSessionId: event.xiaozhiSessionId,
      });
      if (!authorized.ok) {
        if (authorized.code === "session_forged" || authorized.code === "cross_session_rejected") {
          metrics.forgedSessionsRefused += 1;
        }
        return reject(authorized.code as GatewayRejectionCode, null);
      }
      const state = devices.get(lease.deviceId);
      if (!state) {
        return reject("device_unbound", null);
      }

      switch (event.kind) {
        case "listen": {
          if (event.state === "start" || event.state === "detect") {
            // E2E-05: a new-utterance device signal opens a new window and
            // clears the duplicate-dedup memory — a legitimately repeated
            // utterance is never mistaken for a provider duplicate.
            metrics.asrEndpointWindows += 1;
            state.lastAcceptedFinal = null;
          }
          if (event.state === "detect" && state.playback !== null) {
            // A wake-word detect during playback is an interrupt CANDIDATE
            // — recorded, never a fence by itself (VOICE_RUNTIME §4).
            metrics.interruptCandidates += 1;
          }
          metrics.eventsAccepted += 1;
          return { ok: true, kind: event.kind, sessionKey: state.sessionKey };
        }
        case "asr_partial": {
          metrics.asrPartialsSeen += 1;
          if (state.playback !== null) {
            metrics.interruptCandidates += 1;
          }
          pushAudit({
            action: "gateway.asr_partial_seen",
            sessionKey: state.sessionKey,
            turnId: state.playback?.turnId ?? null,
            epoch: state.playback?.epoch ?? null,
            detail: null,
            count: 1,
          });
          metrics.eventsAccepted += 1;
          return { ok: true, kind: event.kind, sessionKey: state.sessionKey };
        }
        case "asr_final": {
          // The transient transcript lives only inside this call frame.
          // Order is fail-closed: Input Safety Gate FIRST (a blocked or
          // crisis text never crosses any boundary), then the keyed
          // fingerprint, then the protected single-turn submit with the
          // verbatim text. Nothing content-bearing reaches audit/metrics.
          const gate = evaluateInputGate(event.text, { entrance: "voice" });
          if (gate.decision !== "allow") {
            metrics.inputGateBlocked += 1;
            // Enumerated rejection only — never the decision details' text.
            return reject("input_gate_blocked", state.sessionKey);
          }
          const fingerprint = asrFingerprint(event.text);
          // E2E-05 duplicate-final dedup: a same-fingerprint final inside
          // the bounded window (no new-utterance signal since — the memory
          // is cleared by listen start/detect) is a provider duplicate
          // (endpoint double-fire / replay). Enumerated no-op: no second
          // turn, no second model request, no text residue beyond the
          // keyed digest already permitted for accepted finals.
          const nowMs = clock();
          const last = state.lastAcceptedFinal;
          if (last !== null && last.fingerprint === fingerprint && nowMs - last.atMs <= asrDuplicateWindowMs) {
            metrics.asrDuplicateFinalsSuppressed += 1;
            pushAudit({
              action: "gateway.asr_duplicate_suppressed",
              sessionKey: state.sessionKey,
              turnId: state.playback?.turnId ?? null,
              epoch: core.currentEpoch(state.sessionKey),
              detail: fingerprint,
              count: 1,
            });
            metrics.eventsAccepted += 1;
            return { ok: true, kind: event.kind, sessionKey: state.sessionKey };
          }
          state.turnCounter += 1;
          const idempotencyKey = `idem-gw${fingerprint.slice(0, 8)}t${state.turnCounter.toString().padStart(3, "0")}`;
          const submitStartedAtMs = clock();
          const submitted = await core.submitPrompt({
            sessionKey: state.sessionKey,
            traceId: null,
            idempotencyKey,
            fingerprint,
            transientText: event.text,
          });
          if (!submitted.ok) {
            return reject(submitted.code as GatewayRejectionCode, state.sessionKey);
          }
          // Content-independent processing latency (E2E-05): event arrival
          // → protected single-turn submit completion. Candidate baseline
          // only; the value is a number, never content.
          const acceptMs = Math.max(0, clock() - submitStartedAtMs);
          metrics.asrFinalAcceptMs = {
            count: metrics.asrFinalAcceptMs.count + 1,
            maxMs: Math.max(metrics.asrFinalAcceptMs.maxMs, acceptMs),
          };
          // Seed the dedup memory only on ACCEPTED submissions: a rejected
          // submit (e.g. scheduler refusal) must stay retryable.
          state.lastAcceptedFinal = { fingerprint, atMs: nowMs };
          // E2E-06: anchor the first-audio latency measure for this turn.
          state.lastAcceptedTurn = { turnId: submitted.turnId, acceptedAtMs: clock() };
          metrics.asrFinalsAccepted += 1;
          metrics.eventsAccepted += 1;
          pushAudit({
            action: "gateway.asr_final_accepted",
            sessionKey: state.sessionKey,
            turnId: submitted.turnId,
            epoch: core.currentEpoch(state.sessionKey),
            detail: fingerprint,
            count: null,
          });
          return { ok: true, kind: event.kind, sessionKey: state.sessionKey };
        }
        case "abort": {
          // client_abort semantics (wire `abort`): fence FIRST via the core
          // barge-in, THEN stop device playback and clear the send path.
          const playback = state.playback;
          if (playback === null) {
            metrics.abortsWithoutPlayback += 1;
            pushAudit({
              action: "gateway.abort_no_playback",
              sessionKey: state.sessionKey,
              turnId: null,
              epoch: core.currentEpoch(state.sessionKey),
              detail: event.reason,
              count: null,
            });
            metrics.eventsAccepted += 1;
            // Accepted but a no-op: no epoch bump, no stop (连续抢话 safety).
            return { ok: true, kind: event.kind, sessionKey: state.sessionKey };
          }
          // E2E-06: the stop-effective latency anchor — abort event arrival
          // → device stop directive issued (includes the fence time; the
          // honest device-edge measure, candidate baseline only).
          const abortArrivalMs = clock();
          const fenced = await core.bargeIn({
            sessionKey: state.sessionKey,
            turnId: playback.turnId,
            reason: "device_abort",
          });
          if (!fenced.ok) {
            if (fenced.code === "cancel_unknown_turn" || fenced.code === "stale_turn_rejected" || fenced.code === "turn_terminal") {
              // The turn stopped (or is no longer fenceable) between
              // observation and abort: the trusted epoch already covers it —
              // no second bump, no drain. The device stop is still owed
              // EXACTLY once: while this connection still tracks the turn,
              // resolve the stop HERE from the turn's actual terminal state,
              // so delivery no longer depends on settled-tap ordering (an
              // in-flight tap becomes a no-op via the exactly-once guard).
              // A fence-unknown turn that is NOT terminal in the trusted
              // store keeps its playback binding for the settled tap.
              pushAudit({
                action: "gateway.abort_no_playback",
                sessionKey: state.sessionKey,
                turnId: playback.turnId,
                epoch: core.currentEpoch(state.sessionKey),
                detail: fenced.code,
                count: null,
              });
              if (state.playback !== null && state.playback.turnId === playback.turnId) {
                const described = core.describeTurn(state.sessionKey, playback.turnId);
                if (described !== null && (VOICE_TERMINAL_TURN_STATES as readonly string[]).includes(described.state)) {
                  const reason: GatewayPlaybackStopReason =
                    described.state === "COMPLETED" ? "completed" : described.state === "CANCELLED" ? "interrupted" : "failed";
                  issuePlaybackStop(state, playback.turnId, reason, playback.epoch);
                  state.playback = null;
                  state.lastFramesAtMs = null;
                  metrics.ttsStopEffectiveMs = {
                    count: metrics.ttsStopEffectiveMs.count + 1,
                    maxMs: Math.max(metrics.ttsStopEffectiveMs.maxMs, Math.max(0, clock() - abortArrivalMs)),
                  };
                }
              }
              metrics.abortsWithoutPlayback += 1;
              metrics.eventsAccepted += 1;
              return { ok: true, kind: event.kind, sessionKey: state.sessionKey };
            }
            return reject(fenced.code as GatewayRejectionCode, state.sessionKey);
          }
          metrics.abortsFenced += 1;
          issuePlaybackStop(state, playback.turnId, "interrupted", playback.epoch);
          metrics.ttsStopEffectiveMs = {
            count: metrics.ttsStopEffectiveMs.count + 1,
            maxMs: Math.max(metrics.ttsStopEffectiveMs.maxMs, Math.max(0, clock() - abortArrivalMs)),
          };
          const cleared = core.drainTts(state.sessionKey);
          if (cleared.ok && cleared.droppedStale > 0) {
            metrics.queueClears += 1;
            metrics.ttsStaleAudioSuppressed += cleared.droppedStale;
            pushAudit({
              action: "gateway.queue_cleared",
              sessionKey: state.sessionKey,
              turnId: null,
              epoch: core.currentEpoch(state.sessionKey),
              detail: null,
              count: cleared.droppedStale,
            });
            emit({
              kind: "tts.clear",
              sessionKey: state.sessionKey,
              epoch: core.currentEpoch(state.sessionKey) ?? playback.epoch,
              droppedStale: cleared.droppedStale,
            });
          }
          state.playback = null;
          state.lastFramesAtMs = null;
          metrics.eventsAccepted += 1;
          return { ok: true, kind: event.kind, sessionKey: state.sessionKey };
        }
        default:
          return reject("gateway.parse_failed", state.sessionKey);
      }
    },

    pumpPlayback(sessionKey) {
      const state = deviceStateBySessionKey(sessionKey);
      if (state === null) {
        return { ok: false, code: "session_unknown" };
      }
      if (state.connectionId === null || !binding.hasOpenConnection(state.deviceId)) {
        return { ok: false, code: "connection_closed" };
      }
      const drained = core.drainTts(sessionKey);
      if (!drained.ok) {
        return { ok: false, code: drained.code };
      }
      let sent = 0;
      let staleRejected = 0;
      for (const item of drained.deliverable) {
        // Defense-in-depth: EVERY batch is re-fenced against the CURRENT
        // trusted epoch before it may leave (VOICE_RUNTIME §5).
        const currentEpoch = core.currentEpoch(sessionKey);
        const fenced = currentEpoch === item.epoch
          ? core.fenceAudioSend({ sessionKey, turnId: item.turnId, epoch: item.epoch })
          : ({ ok: false as const, code: "stale_turn_rejected" });
        if (!fenced.ok) {
          staleRejected += 1;
          metrics.staleFramesRejected += 1;
          metrics.ttsStaleAudioSuppressed += 1;
          pushAudit({
            action: "gateway.frames_fenced",
            sessionKey,
            turnId: item.turnId,
            epoch: item.epoch,
            detail: fenced.code,
            count: 1,
          });
          continue;
        }
        sent += 1;
        metrics.framesSent += framesPerSentence;
        metrics.ttsSentencesSent += 1;
        metrics.ttsFramesSent += framesPerSentence;
        // E2E-06 content-free TTS metrics (candidate baselines; virtual-clock
        // measurable): first-audio latency per turn and inter-sentence gaps.
        const nowMs = clock();
        const continuingTurn = state.playback !== null && state.playback.turnId === item.turnId;
        if (continuingTurn) {
          if (state.lastFramesAtMs !== null) {
            const gapMs = Math.max(0, nowMs - state.lastFramesAtMs);
            metrics.ttsInterSentenceGapMs = {
              count: metrics.ttsInterSentenceGapMs.count + 1,
              maxMs: Math.max(metrics.ttsInterSentenceGapMs.maxMs, gapMs),
            };
          }
        } else {
          metrics.ttsTurnsPlayed += 1;
          const accepted = state.lastAcceptedTurn;
          if (accepted !== null && accepted.turnId === item.turnId) {
            const firstMs = Math.max(0, nowMs - accepted.acceptedAtMs);
            metrics.ttsFirstAudioMs = {
              count: metrics.ttsFirstAudioMs.count + 1,
              maxMs: Math.max(metrics.ttsFirstAudioMs.maxMs, firstMs),
            };
            state.lastAcceptedTurn = null;
          }
        }
        state.lastFramesAtMs = nowMs;
        const audioDigest = gatewayContentDigest(item.itemId);
        pushAudit({
          action: "gateway.frames_sent",
          sessionKey,
          turnId: item.turnId,
          epoch: item.epoch,
          detail: audioDigest,
          count: framesPerSentence,
        });
        if (state.playback === null) {
          emit({ kind: "tts.start", sessionKey, turnId: item.turnId, epoch: item.epoch });
        }
        state.playback = { turnId: item.turnId, epoch: item.epoch };
        emit({
          kind: "tts.frames",
          sessionKey,
          turnId: item.turnId,
          epoch: item.epoch,
          frameCount: framesPerSentence,
          audioDigest,
        });
      }
      if (drained.droppedStale > 0) {
        metrics.queueClears += 1;
        metrics.ttsStaleAudioSuppressed += drained.droppedStale;
        pushAudit({
          action: "gateway.queue_cleared",
          sessionKey,
          turnId: null,
          epoch: core.currentEpoch(sessionKey),
          detail: null,
          count: drained.droppedStale,
        });
        emit({ kind: "tts.clear", sessionKey, epoch: core.currentEpoch(sessionKey) ?? 1, droppedStale: drained.droppedStale });
      }
      return { ok: true, sent, staleRejected, droppedStale: drained.droppedStale };
    },

    noteTurnSettled(sessionKey, turnId, finalState) {
      const state = deviceStateBySessionKey(sessionKey);
      if (state === null || state.playback === null || state.playback.turnId !== turnId) {
        return;
      }
      const epoch = state.playback.epoch;
      const reason: GatewayPlaybackStopReason =
        finalState === "COMPLETED" ? "completed" : finalState === "CANCELLED" ? "interrupted" : "failed";
      issuePlaybackStop(state, turnId, reason, epoch);
      state.playback = null;
      state.lastFramesAtMs = null;
    },

    noteWorkerFault(sessionKey) {
      const state = deviceStateBySessionKey(sessionKey);
      if (state === null || state.playback === null) {
        return;
      }
      const playback = state.playback;
      issuePlaybackStop(state, playback.turnId, "failed", playback.epoch);
      state.playback = null;
      state.lastFramesAtMs = null;
    },

    sweep(sessionKey) {
      const state = deviceStateBySessionKey(sessionKey);
      if (state === null) {
        return { ok: false, code: "session_unknown" };
      }
      const swept = core.sweepTimeouts({ sessionKey, budgetMs: sweepBudgetMs });
      if (!swept.ok) {
        return { ok: false, code: swept.code };
      }
      for (const turnId of swept.timedOutTurnIds) {
        pushAudit({
          action: "gateway.swept",
          sessionKey,
          turnId,
          epoch: core.currentEpoch(sessionKey),
          detail: "TIMED_OUT",
          count: null,
        });
        adapter.noteTurnSettled(sessionKey, turnId, "TIMED_OUT");
      }
      return { ok: true, timedOutTurnIds: swept.timedOutTurnIds };
    },

    findSessionKeyByDevice: (deviceId) => devices.get(deviceId)?.sessionKey ?? null,

    mappingSnapshot() {
      const entries: GatewayMappingSnapshotEntry[] = [];
      for (const state of devices.values()) {
        entries.push({
          deviceId: state.deviceId,
          connectionId: state.connectionId,
          xiaozhiSessionId: state.xiaozhiSessionId,
          sessionKey: state.sessionKey,
          actorId: state.actorId,
          conversationId: state.conversationId,
          connected: state.connectionId !== null && binding.hasOpenConnection(state.deviceId),
          playbackTurnId: state.playback?.turnId ?? null,
          playbackEpoch: state.playback?.epoch ?? null,
          downlinkSampleRate: state.downlinkSampleRate,
        });
      }
      return Object.freeze(entries);
    },

    metricsSnapshot() {
      return { ...metrics };
    },

    auditSnapshot() {
      return Object.freeze([...audit]);
    },

    purgeAudit() {
      audit.length = 0;
    },
  };
  return adapter;
}
