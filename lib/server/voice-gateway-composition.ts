/**
 * R1-V3 Voice Gateway composition — the server-side integration that binds
 * the R1-V3 Voice Gateway Adapter (device/protocol edge) to the R1-V2
 * Bridge stack (R1-V1 trusted Orchestrator + children Output Gate + Bridge
 * + synthetic Cordis runtime) into one working gateway runtime (issue #30
 * 实现范围 1–5; docs/VOICE_RUNTIME.md §2; docs/VOICE_GATEWAY_PROTOCOL.md).
 *
 * Data flow (device edge → core):
 *   device event → binding/lease + session authorization → ASR digest →
 *   stack.submitPrompt (trusted Orchestrator) / stack.bargeInCancel
 *   (fence-first interruption) — the Adapter NEVER bypasses the Core.
 *
 * Data flow (core → device edge):
 *   Bridge events (turn.settled / runtime.error / attempt.ended) →
 *   playback-stop + queue-clear directives; orchestrator TTS queue →
 *   drain → audio_send re-fence → tts.frames directives (frame counts +
 *   digests only — no audio bytes exist in this POC).
 *
 * PRIVACY: no child audio, transcript or key material ever appears here;
 * the auth token is generated per process and never logged; ASR text is
 * digested inside the Adapter and discarded.
 */

import { createVoiceBridgeStack, type VoiceBridgeStack } from "./voice-bridge-composition.ts";
import {
  createVoiceGatewayAdapter,
  type GatewayCorePort,
  type GatewayMappingSnapshotEntry,
  type GatewayMetricsSnapshot,
  type VoiceGatewayAdapter,
} from "../domain/voice/adapter/gateway-adapter.ts";
import { createGatewayDeviceBindingRegistry, type GatewayDeviceBindingRegistry } from "../domain/voice/adapter/binding.ts";
import type { GatewayDeviceDirective } from "../domain/voice/adapter/protocol.ts";
import type { MockGenerationScript } from "../domain/voice/bridge/mock-cordis.ts";
import type { BridgeCordisProfile } from "../domain/voice/bridge/profile.ts";

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

export interface VoiceGatewayStackOptions {
  /** Deterministic per-turn generation script (synthetic samples only). */
  readonly scriptFor: (sessionKey: string, turnId: string) => MockGenerationScript;
  readonly profile?: Readonly<BridgeCordisProfile>;
  readonly socketDir?: string;
  readonly endpointName?: string;
  /** `ipc` (default) or `in_process` — see voice-bridge-composition. */
  readonly transport?: "ipc" | "in_process";
  readonly clock?: () => number;
  readonly turnIdFactory?: () => string;
  /** Synthetic frames per admitted TTS sentence (POC stand-in). */
  readonly framesPerSentence?: number;
  /** Device-directive sink override (defaults to the injected mock sink). */
  readonly directiveSink?: (directive: GatewayDeviceDirective) => void;
}

export interface VoiceGatewayStack {
  readonly stack: VoiceBridgeStack;
  readonly binding: GatewayDeviceBindingRegistry;
  readonly adapter: VoiceGatewayAdapter;
  readonly transportMode: "ipc" | "in_process";
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Guardian-issued device binding (activation digest only). */
  bindDevice(refs: {
    readonly deviceId: string;
    readonly actorId: string;
    readonly conversationId: string;
    readonly activationDigest: string;
  }): { readonly ok: true; readonly created: boolean } | { readonly ok: false; readonly code: string };
  /** Ingest one raw device event on one connection (fail-closed). */
  handleDeviceEvent(connectionId: string, raw: unknown): Promise<{ readonly ok: boolean; readonly kind?: string; readonly code?: string; readonly sessionKey?: string | null }>;
  /** Drain + fence + send current-epoch TTS for one session (deterministic). */
  pumpPlayback(sessionKey: string): { readonly ok: true; readonly sent: number; readonly staleRejected: number; readonly droppedStale: number } | { readonly ok: false; readonly code: string };
  /** Timeout sweep for one mapped session. */
  sweep(sessionKey: string): { readonly ok: true; readonly timedOutTurnIds: readonly string[] } | { readonly ok: false; readonly code: string };
  readonly findSessionKeyByDevice: (deviceId: string) => string | null;
  readonly mappingSnapshot: () => readonly Readonly<GatewayMappingSnapshotEntry>[];
  readonly adapterMetrics: () => Readonly<GatewayMetricsSnapshot>;
}

/** Create the full voice gateway stack (no sockets until start()). */
export function createVoiceGatewayStack(options: VoiceGatewayStackOptions): VoiceGatewayStack {
  if (options === null || typeof options !== "object" || typeof options.scriptFor !== "function") {
    throw new Error("voice gateway stack requires a scriptFor function.");
  }
  const clock = options.clock ?? (() => Date.now());

  const stack = createVoiceBridgeStack({
    scriptFor: options.scriptFor,
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.socketDir !== undefined ? { socketDir: options.socketDir } : {}),
    ...(options.endpointName !== undefined ? { endpointName: options.endpointName } : {}),
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.turnIdFactory !== undefined ? { turnIdFactory: options.turnIdFactory } : {}),
  });

  const binding = createGatewayDeviceBindingRegistry({ clock });

  // The core port maps the Adapter's needs onto the EXISTING Bridge stack —
  // the Adapter never reaches past these calls.
  const core: GatewayCorePort = {
    async openCoreSession(refs) {
      const opened = await stack.openSession({
        sessionKey: refs.sessionKey,
        conversationId: refs.conversationId,
        ownerActorId: refs.ownerActorId,
      });
      if (opened.ok) {
        return { ok: true, recovered: opened.recovered, continued: false };
      }
      // An already-live worker owning the same session is benign
      // continuation (the trusted store is idempotent per owner/conversation).
      if (opened.code === "session_conflict") {
        return { ok: true, recovered: false, continued: true };
      }
      return { ok: false, code: opened.code };
    },
    async submitPrompt(refs) {
      const submitted = await stack.submitPrompt({
        sessionKey: refs.sessionKey,
        traceId: refs.traceId ?? undefined,
        idempotencyKey: refs.idempotencyKey,
        fingerprint: refs.fingerprint,
      });
      return submitted.ok
        ? { ok: true, turnId: submitted.turnId, dispatched: submitted.dispatched }
        : { ok: false, code: submitted.code };
    },
    async bargeIn(refs) {
      const cancelled = await stack.bargeInCancel({
        sessionKey: refs.sessionKey,
        turnId: refs.turnId,
        reason: refs.reason,
      });
      return cancelled.ok ? { ok: true } : { ok: false, code: cancelled.code, fenced: cancelled.fenced };
    },
    currentEpoch: (sessionKey) => stack.orchestrator.currentEpoch(sessionKey),
    describeTurn: (sessionKey, turnId) => {
      const turn = stack.orchestrator.describeTurn(sessionKey, turnId);
      return turn === null ? null : { state: turn.state, epoch: turn.epoch };
    },
    fenceAudioSend: (refs) => {
      const fenced = stack.orchestrator.fenceOutput({
        sessionKey: refs.sessionKey,
        turnId: refs.turnId,
        epoch: refs.epoch,
        kind: "audio_send",
      });
      return fenced.ok ? { ok: true } : { ok: false, code: fenced.code };
    },
    drainTts: (sessionKey) => {
      const drained = stack.orchestrator.drainTts(sessionKey);
      return drained.ok
        ? { ok: true, deliverable: drained.deliverable, droppedStale: drained.droppedStale }
        : { ok: false, code: drained.code };
    },
    sweepTimeouts: (refs) => {
      const swept = stack.orchestrator.sweepTimeouts({ sessionKey: refs.sessionKey, budgetMs: refs.budgetMs });
      return swept.ok
        ? { ok: true, timedOutTurnIds: swept.timedOutTurnIds }
        : { ok: false, code: swept.code };
    },
  };

  const adapter = createVoiceGatewayAdapter({
    core,
    binding,
    clock,
    ...(options.framesPerSentence !== undefined ? { framesPerSentence: options.framesPerSentence } : {}),
    ...(options.directiveSink !== undefined ? { sink: options.directiveSink } : {}),
  });

  // Core → device edge tap: Bridge events drive playback stops and pumps.
  // The store-level ops are synchronous, so ordering inside one event batch
  // is deterministic: frames flush → settlement stop → next pump.
  stack.client.onEvent((frame) => {
    if (frame.kind !== "event") {
      return;
    }
    const payload = (frame.payload ?? {}) as Record<string, unknown>;
    if (frame.name === "turn.settled" || frame.name === "attempt.ended" || frame.name === "runtime.error") {
      const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : null;
      if (sessionKey === null) {
        return;
      }
      if (frame.name === "turn.settled") {
        const turnId = typeof payload.turnId === "string" ? payload.turnId : null;
        const finalState = typeof payload.finalState === "string" ? payload.finalState : null;
        if (turnId !== null && finalState !== null) {
          adapter.noteTurnSettled(sessionKey, turnId, finalState);
        }
        adapter.pumpPlayback(sessionKey);
        return;
      }
      if (frame.name === "runtime.error" && payload.code === "worker_crashed") {
        adapter.noteWorkerFault(sessionKey);
        return;
      }
      if (frame.name === "attempt.ended") {
        // The sentence buffer flushed: any newly admitted TTS can go out.
        adapter.pumpPlayback(sessionKey);
      }
    }
  });

  const gateway: VoiceGatewayStack = {
    stack,
    binding,
    adapter,
    transportMode: stack.transportMode,
    async start() {
      await stack.start();
    },
    async stop() {
      await stack.stop();
    },
    bindDevice(refs) {
      return adapter.bindDevice(refs);
    },
    async handleDeviceEvent(connectionId, raw) {
      const outcome = await adapter.handleDeviceEvent(connectionId, raw);
      if (outcome.ok) {
        return { ok: true, kind: outcome.kind, sessionKey: outcome.sessionKey };
      }
      return { ok: false, code: outcome.code };
    },
    pumpPlayback(sessionKey) {
      return adapter.pumpPlayback(sessionKey);
    },
    sweep(sessionKey) {
      return adapter.sweep(sessionKey);
    },
    findSessionKeyByDevice: (deviceId) => adapter.findSessionKeyByDevice(deviceId),
    mappingSnapshot: () => adapter.mappingSnapshot(),
    adapterMetrics: () => adapter.metricsSnapshot(),
  };
  return gateway;
}
