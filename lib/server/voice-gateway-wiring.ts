/**
 * E2E-07 (issue #57) — Voice Gateway ↔ xiaozhi-esp32-server WIRING
 * composition: binds the existing Voice Gateway Adapter stack (R1-V1
 * Orchestrator + R1-V2 Bridge over the REAL local-socket transport + the
 * injected DSH agent port) to the pinned xiaozhi server's bridge extension
 * over the protected internal transport
 * (lib/server/voice-gateway-internal-transport.ts).
 *
 * Wiring contract (docs/VOICE_GATEWAY_PROTOCOL.md, ADR-0011):
 *
 *   device (v2.5.2 wire) → pinned xiaozhi server (WS, auth, VAD, ASR, TTS,
 *   Opus) → fork-patched hooks + LumithinkBridgeLLM module
 *     → PROTECTED internal transport (UDS/named pipe + token, no TCP)
 *       → THIS composition → existing Adapter (GatewayCorePort) →
 *         Bridge (REAL IPC) → DSH runtime
 *     ← fence-stamped TTS sentences (Output-Gate-approved) ←
 *   pinned server TTS engine → Opus → device.
 *
 * - Device auth mapping (设备鉴权握手与服务端可信映射): the bridge forwards
 *   the REAL `Device-Id` / `Client-Id` / `Authorization` handshake
 *   material; this composition verifies the upstream AuthManager scheme
 *   VERBATIM (HMAC-SHA256 over `${clientId}|${deviceId}|${ts}` under the
 *   shared deployment key, pinned commit core/auth.py) and only then maps
 *   the device onto its guardian binding (activation digest). Credentials
 *   are never derivable from the MAC alone — a MAC without a fresh signed
 *   token and a guardian binding opens nothing.
 * - Fail-closed: an unverified hello, an unmapped device, a duplicate
 *   connection (Adapter lease) or a forged session results in an
 *   enumerated rejection frame and a `device_drop` (the bridge closes the
 *   device WebSocket — the server edge enforces the LumiThink lease).
 * - TTS fence (TTS 音频发送栅栏): sentences reach the bridge ONLY through
 *   the stream-gate admission (Output Gate + `tts_queue` fence); abort →
 *   epoch bump → further old-epoch sentences are structurally impossible;
 *   the server's native abort path (client_abort → clear_queues → tts
 *   stop) clears whatever was already enqueued. `queue_clear` frames are
 *   the LumiThink-side belt-and-braces.
 * - Real audio accounting: `audio_delivered` frames (real Opus frame count
 *   + SHA-256 over the actual bytes, produced by the fork-patched send
 *   path) are recorded through the Adapter's content-free accounting
 *   (v1.4), replacing the v1.3 frameCount/audioDigest placeholder with
 *   observed facts.
 *
 * PRIVACY: the transcript (`turn_prompt.text`) and the admitted sentences
 * (`tts_sentence.text`) exist ONLY inside this wiring's transient frame
 * path — never in logs, audit, metrics or snapshots. Everything this
 * module records (audit/metrics via the Adapter) is content-free.
 *
 * This module is server-layer infrastructure; lib/domain stays free of it.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createVoiceGatewayStack, type VoiceGatewayStack } from "./voice-gateway-composition.ts";
import {
  createVoiceGatewayInternalServer,
  resolveGatewayInternalEndpoint,
  type GatewayInternalEndpoint,
  type GatewayInternalInboundFrame,
  type GatewayInternalOutboundFrame,
  type GatewayInternalServer,
} from "./voice-gateway-internal-transport.ts";
import type { MockGenerationScript } from "../domain/voice/bridge/mock-cordis.ts";
import type { BridgeAgentPort } from "../domain/voice/bridge/agent-port.ts";
import type { GatewayDeviceDirective } from "../domain/voice/adapter/protocol.ts";
import { VOICE_TERMINAL_TURN_STATES } from "../domain/voice/schema.ts";

// ---------------------------------------------------------------------------
// Device-token verification (upstream AuthManager scheme, pinned commit)
// ---------------------------------------------------------------------------

/**
 * The pinned commit's AuthManager signs `f"{client_id}|{username}|{ts}"`
 * with HMAC-SHA256 and emits `{urlsafe_b64_nopad_sig}.{ts}`
 * (core/auth.py @ 27399a2). A missing Client-Id header is `None` in
 * Python — mirrored literally as the string "None" so the gateway
 * recomputes the exact same content the server verified.
 */
export function verifyDeviceAuthorization(refs: {
  readonly authorization: string | null;
  readonly deviceId: string;
  readonly clientId: string | null;
  readonly authKey: string;
  readonly expireSeconds: number;
  readonly nowMs?: number;
}): { readonly ok: true } | { readonly ok: false; readonly reason: "missing_token" | "malformed_token" | "expired" | "signature_mismatch" } {
  const nowMs = refs.nowMs ?? Date.now();
  if (refs.authorization === null || refs.authorization.length === 0) {
    return { ok: false, reason: "missing_token" };
  }
  let token = refs.authorization;
  if (token.startsWith("Bearer ")) {
    token = token.slice("Bearer ".length);
  }
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: "malformed_token" };
  }
  const sigPart = token.slice(0, dot);
  const tsPart = token.slice(dot + 1);
  let ts: number;
  if (!/^-?\d+$/.test(tsPart)) {
    return { ok: false, reason: "malformed_token" };
  }
  ts = Number(tsPart);
  if (nowMs / 1000 - ts > refs.expireSeconds) {
    return { ok: false, reason: "expired" };
  }
  const content = `${refs.clientId ?? "None"}|${refs.deviceId}|${ts}`;
  const expected = createHmac("sha256", refs.authKey).update(content, "utf8").digest("base64url").replace(/=+$/, "");
  const a = Buffer.from(sigPart, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Wiring composition
// ---------------------------------------------------------------------------

/** One guardian-issued device binding (activation digest only — no keys). */
export interface WiredDeviceBinding {
  readonly deviceId: string;
  readonly actorId: string;
  readonly conversationId: string;
  readonly activationDigest: string;
}

export interface WiredVoiceGatewayOptions {
  /** Guardian-issued bindings seeded at start (activation digests only). */
  readonly bindings: readonly WiredDeviceBinding[];
  /**
   * Shared deployment auth key for the device-token scheme (upstream
   * `server.auth_key`). NEVER logged; render-time/env injected.
   */
  readonly deviceAuthKey: string;
  /** Device token freshness window (upstream default: 7 days). */
  readonly deviceTokenExpireSeconds?: number;
  /** Protected internal transport token (bridge → gateway). */
  readonly transportAuthToken: string;
  /** Internal transport endpoint naming (UDS dir / pipe name). */
  readonly socketDir?: string;
  readonly endpointName?: string;
  /** Explicit protected-transport endpoint override (production host). */
  readonly transportEndpoint?: GatewayInternalEndpoint;
  /** Injectable deterministic turn-id factory (test replays). */
  readonly turnIdFactory?: () => string;
  /** Deterministic per-turn generation script (mock runtime fallback). */
  readonly scriptFor: (sessionKey: string, turnId: string) => MockGenerationScript;
  /** E2E-02: inject the REAL locked-version DSH agent port. */
  readonly agentPort?: BridgeAgentPort;
  readonly onAgentFault?: (listener: (info: { readonly sessionKey: string; readonly code: "worker_crashed" }) => void) => void;
  /** Bridge stack transport (default `ipc` — the REAL local socket). */
  readonly transport?: "ipc" | "in_process";
  readonly clock?: () => number;
  /** Diagnostic tap: every frame the gateway sends to the bridge. */
  readonly onBridgeFrame?: (frame: GatewayInternalOutboundFrame) => void;
}

export interface WiredVoiceGateway {
  readonly stack: VoiceGatewayStack;
  readonly transport: GatewayInternalServer;
  readonly endpoint: GatewayInternalEndpoint;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Content-free snapshots for evidence/tests. */
  readonly mappingSnapshot: () => ReturnType<VoiceGatewayStack["mappingSnapshot"]>;
  readonly adapterMetrics: () => ReturnType<VoiceGatewayStack["adapterMetrics"]>;
  /** Injected frames (test affordance; production uses the socket). */
  readonly handleBridgeFrameForTest: (frame: GatewayInternalInboundFrame) => Promise<void>;
  /**
   * Bridge lifecycle events for the frame-injection test path (production
   * fires these from the real transport's connect/close).
   */
  readonly notifyBridgeLifecycleForTest: (event: "authenticated" | "closed") => void;
}

export function createWiredVoiceGateway(options: WiredVoiceGatewayOptions): WiredVoiceGateway {
  if (options === null || typeof options !== "object") {
    throw new Error("wired voice gateway requires options.");
  }
  if (!Array.isArray(options.bindings)) {
    throw new Error("wired voice gateway requires a bindings array.");
  }
  if (typeof options.deviceAuthKey !== "string" || options.deviceAuthKey.length < 16) {
    throw new Error("wired voice gateway requires a bounded deviceAuthKey.");
  }
  const expireSeconds = options.deviceTokenExpireSeconds ?? 604_800;
  const clock = options.clock ?? (() => Date.now());

  // DISTINCT endpoint names: the Bridge stack socket and the internal
  // gateway transport socket live in the same directory on POSIX — a shared
  // name would collide on one .sock path.
  const baseEndpointName =
    options.endpointName ?? `lumithink-gateway-${process.pid}-${Math.floor(Math.random() * 0xffffff).toString(16)}`;
  const internalEndpointName = `${baseEndpointName}-gwint`;
  if (internalEndpointName.length > 64 || !/^[A-Za-z0-9._-]+$/.test(internalEndpointName)) {
    throw new Error("wired voice gateway: derived internal endpoint name is not a safe identifier.");
  }
  const endpoint = options.transportEndpoint ?? resolveGatewayInternalEndpoint({
    ...(options.socketDir !== undefined ? { socketDir: options.socketDir } : {}),
    name: internalEndpointName,
  });

  // connId / sessionKey → device mapping (own bookkeeping for frame routing;
  // the Adapter keeps the authoritative binding/lease state).
  interface ConnRecord {
    readonly deviceId: string;
    sessionKey: string | null;
    xiaozhiSessionId: string | null;
  }
  const connBySessionKey = new Map<string, string>();
  const connById = new Map<string, ConnRecord>();
  /** Sentences delivered per turn (turnId → count) for tts_end dedup. */
  const deliveredByTurn = new Map<string, number>();
  let lastTtsEndTurn: string | null = null;

  function dropMapEntry(connId: string): void {
    const record = connById.get(connId);
    if (record !== undefined && record.sessionKey !== null && connBySessionKey.get(record.sessionKey) === connId) {
      connBySessionKey.delete(record.sessionKey);
    }
    connById.delete(connId);
  }

  function resetAllConns(): void {
    connBySessionKey.clear();
    connById.clear();
  }

  const stack = createVoiceGatewayStack({
    scriptFor: options.scriptFor,
    ...(options.agentPort !== undefined ? { agentPort: options.agentPort } : {}),
    ...(options.onAgentFault !== undefined ? { onAgentFault: options.onAgentFault } : {}),
    ...(options.socketDir !== undefined ? { socketDir: options.socketDir } : {}),
    endpointName: baseEndpointName,
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.turnIdFactory !== undefined ? { turnIdFactory: options.turnIdFactory } : {}),
    directiveSink: (directive: GatewayDeviceDirective) => {
      routeDirective(directive);
    },
    onAdmittedSentence: (entry) => {
      const connId = connBySessionKey.get(entry.sessionKey);
      if (connId === undefined) {
        // No wired connection for this session: nothing to deliver. The
        // content-free TTS slot still settles the turn normally.
        return;
      }
      const record = connById.get(connId);
      if (record === undefined || record.xiaozhiSessionId === null) {
        return;
      }
      deliveredByTurn.set(entry.turnId, (deliveredByTurn.get(entry.turnId) ?? 0) + 1);
      sendToBridge({
        kind: "tts_sentence",
        connId,
        xiaozhiSessionId: record.xiaozhiSessionId,
        turnId: entry.turnId,
        itemId: entry.itemId,
        epoch: entry.epoch,
        text: entry.text,
      });
    },
  });

  const transport = createVoiceGatewayInternalServer({
    endpoint,
    authToken: options.transportAuthToken,
  });

  function sendToBridge(frame: GatewayInternalOutboundFrame): void {
    options.onBridgeFrame?.(frame);
    transport.send(frame);
  }

  function connIdForSession(sessionKey: string): string | null {
    return connBySessionKey.get(sessionKey) ?? null;
  }

  /**
   * Wired-mode fence enforcement (E2E-07): sentence delivery happens at
   * ADMISSION time (stream gate, pre-pump), so a device abort must fence
   * the session's RUNNING turn even when the Adapter holds no playback
   * binding yet (the synthetic "no playback → enumerated no-op" semantics
   * assume frames move only at pump time). The composition enforces the
   * fence-first ordering here through the core port; when the Adapter
   * already fenced (turn CANCELLING/CANCELLED) this is a no-op.
   */
  async function enforceAbortFence(connId: string): Promise<void> {
    const record = connById.get(connId);
    if (record === undefined || record.sessionKey === null) {
      return;
    }
    const sessionKey = record.sessionKey;
    const currentEpoch = stack.stack.orchestrator.currentEpoch(sessionKey);
    if (currentEpoch === null) {
      return;
    }
    const running = stack.stack.orchestrator
      .listTurns(sessionKey)
      .find((turn) => turn.state === "RUNNING" && turn.epoch === currentEpoch);
    if (running === undefined) {
      return;
    }
    await stack.stack.bargeInCancel({ sessionKey, turnId: running.turnId, reason: "device_abort" });
  }

  /** Map Adapter device directives onto the bridge frames. */
  function routeDirective(directive: GatewayDeviceDirective): void {
    if (directive.kind === "tts.stop") {
      const connId = connIdForSession(directive.sessionKey);
      lastTtsEndTurn = directive.turnId;
      if (connId !== null) {
        sendToBridge({
          kind: "tts_end",
          connId,
          turnId: directive.turnId ?? "unknown",
          epoch: directive.epoch,
          reason: directive.reason,
        });
      }
      return;
    }
    if (directive.kind === "tts.clear") {
      const connId = connIdForSession(directive.sessionKey);
      if (connId !== null) {
        sendToBridge({ kind: "queue_clear", connId, epoch: directive.epoch });
      }
      return;
    }
    // tts.start / tts.frames: content-free synthetic-directive surface; the
    // pinned server drives the device protocol itself (tts start /
    // sentence_start / binary opus / stop) from its TTS queue. No bridge
    // frame is needed (documented boundary, ADR-0011).
  }

  async function routeFrame(frame: GatewayInternalInboundFrame): Promise<void> {
    switch (frame.kind) {
      case "device_hello": {
        // The HMAC token was signed over the RAW wire header value (the
        // pinned commit's AuthManager signs `client_id|device_id|ts` with
        // the RAW header strings) — verify against deviceIdWire; the
        // guardian binding maps the NORMALIZED deviceId.
        const auth = verifyDeviceAuthorization({
          authorization: frame.authorization,
          deviceId: frame.deviceIdWire ?? frame.deviceId,
          clientId: frame.clientId,
          authKey: options.deviceAuthKey,
          expireSeconds,
        });
        if (!auth.ok) {
          sendToBridge({ kind: "device_hello_result", connId: frame.connId, ok: false, code: "device_possession_denied" });
          sendToBridge({ kind: "device_drop", connId: frame.connId, code: "device_possession_denied" });
          return;
        }
        // Only a VERIFIED device is mapped onto its guardian binding: the
        // binding's activation digest becomes the Adapter-level possession
        // proof (VOICE_GATEWAY_PROTOCOL §2.1 — the transport maps the
        // device authorization material onto the hello credential).
        const binding = options.bindings.find((entry) => entry.deviceId === frame.deviceId);
        const outcome = await stack.handleDeviceEvent(frame.connId, {
          kind: "hello",
          deviceId: frame.deviceId,
          clientDigest: binding?.activationDigest ?? null,
          audioParams: frame.audioParams,
        });
        if (!outcome.ok) {
          const code = outcome.code ?? "gateway.parse_failed";
          sendToBridge({ kind: "device_hello_result", connId: frame.connId, ok: false, code });
          sendToBridge({ kind: "device_drop", connId: frame.connId, code });
          return;
        }
        connById.set(frame.connId, { deviceId: frame.deviceId, sessionKey: outcome.sessionKey ?? null, xiaozhiSessionId: null });
        if (outcome.sessionKey != null) {
          connBySessionKey.set(outcome.sessionKey, frame.connId);
        }
        sendToBridge({ kind: "device_hello_result", connId: frame.connId, ok: true });
        return;
      }
      case "session_issued": {
        const record = connById.get(frame.connId);
        if (record === undefined) {
          sendToBridge({ kind: "device_drop", connId: frame.connId, code: "connection_unknown" });
          return;
        }
        const outcome = await stack.handleDeviceEvent(frame.connId, {
          kind: "session_issued",
          xiaozhiSessionId: frame.xiaozhiSessionId,
        });
        if (!outcome.ok) {
          sendToBridge({ kind: "device_drop", connId: frame.connId, code: outcome.code ?? "gateway.parse_failed" });
          dropMapEntry(frame.connId);
          return;
        }
        record.xiaozhiSessionId = frame.xiaozhiSessionId;
        return;
      }
      case "turn_prompt": {
        const record = connById.get(frame.connId);
        if (record === undefined || record.sessionKey === null) {
          sendToBridge({ kind: "prompt_rejected", connId: frame.connId, code: "connection_unknown" });
          return;
        }
        const outcome = await stack.handleDeviceEvent(frame.connId, {
          kind: "asr_final",
          xiaozhiSessionId: frame.xiaozhiSessionId,
          text: frame.text,
        });
        if (!outcome.ok) {
          // Enumerated rejection; the device connection stays (a blocked
          // prompt is an outcome, not a transport fault).
          sendToBridge({ kind: "prompt_rejected", connId: frame.connId, code: outcome.code ?? "gateway.parse_failed" });
          return;
        }
        const turnId = outcome.turnId;
        if (typeof turnId === "string") {
          deliveredByTurn.set(turnId, 0);
          sendToBridge({ kind: "turn_started", connId: frame.connId, turnId, epoch: stack.stack.orchestrator.currentEpoch(record.sessionKey) ?? 1 });
        }
        return;
      }
      case "abort": {
        await stack.handleDeviceEvent(frame.connId, {
          kind: "abort",
          xiaozhiSessionId: frame.xiaozhiSessionId,
          reason: frame.reason,
        });
        await enforceAbortFence(frame.connId);
        return;
      }
      case "device_closed": {
        // The device WebSocket closed (the bridge's device-closed hook):
        // release the Adapter lease and the ephemeral mapping — without
        // this, a stuck lease refuses every later hello for the device.
        await stack.handleDeviceEvent(frame.connId, {
          kind: "connection_dropped",
          reason: frame.reason,
        });
        dropMapEntry(frame.connId);
        return;
      }
      case "audio_delivered": {
        const record = connById.get(frame.connId);
        if (record === undefined || record.sessionKey === null) {
          return; // Unknown connection: the observation maps to nothing.
        }
        stack.adapter.noteAudioDelivery({
          sessionKey: record.sessionKey,
          turnId: frame.turnId,
          frames: frame.frames,
          digest: frame.digest,
        });
        return;
      }
      default: {
        // The parser rejects unknown kinds; this branch is unreachable.
        return;
      }
    }
  }

  // Fresh bridge connection = (re)announced server instance: every device
  // lease of the previous server incarnation is dead. server_restart
  // semantics close all leases and suspend playback (Adapter contract §2.4).
  function announceServerRestart(): void {
    resetAllConns();
    deliveredByTurn.clear();
    lastTtsEndTurn = null;
    void stack.handleDeviceEvent("server_transport", { kind: "server_restart" });
  }
  transport.onBridgeAuthenticated(announceServerRestart);
  transport.onBridgeClosed(announceServerRestart);
  transport.onFrame((frame) => {
    // The transport awaits this per frame (strict arrival order), so a
    // routing fault can never reorder or crash the stream; it is logged
    // content-free (frame kind + error class).
    return routeFrame(frame).catch((error: unknown) => {
      console.error(
        `[gateway-wiring] frame routing failed kind=${frame.kind} error=${error instanceof Error ? `${error.message}` : String(error)}`,
      );
    });
  });

  // Settlement tap: a settled turn with ZERO delivered sentences still owes
  // the bridge an end-of-turn signal (the directive sink only fires when a
  // frame batch was pumped). Registered AFTER the composition's own tap, so
  // directive-driven tts_end frames take precedence.
  stack.stack.client.onEvent((frame) => {
    if (frame.kind !== "event" || frame.name !== "turn.settled") {
      return;
    }
    const payload = (frame.payload ?? {}) as Record<string, unknown>;
    const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : null;
    const turnId = typeof payload.turnId === "string" ? payload.turnId : null;
    const finalState = typeof payload.finalState === "string" ? payload.finalState : null;
    if (sessionKey === null || turnId === null || finalState === null) {
      return;
    }
    if (!(VOICE_TERMINAL_TURN_STATES as readonly string[]).includes(finalState)) {
      return;
    }
    if (lastTtsEndTurn === turnId) {
      deliveredByTurn.delete(turnId);
      return; // The directive sink already ended this turn.
    }
    const delivered = deliveredByTurn.get(turnId) ?? null;
    deliveredByTurn.delete(turnId);
    if (delivered === null) {
      return; // A turn this wiring never started (e.g. seeded session).
    }
    const connId = connIdForSession(sessionKey);
    if (connId === null) {
      return;
    }
    sendToBridge({
      kind: "tts_end",
      connId,
      turnId,
      epoch: stack.stack.orchestrator.currentEpoch(sessionKey) ?? 1,
      reason: finalState === "COMPLETED" ? "completed" : finalState === "CANCELLED" ? "interrupted" : "failed",
    });
  });

  const wired: WiredVoiceGateway = {
    stack,
    transport,
    endpoint,
    async start() {
      for (const binding of options.bindings) {
        const seeded = stack.bindDevice(binding);
        if (!seeded.ok) {
          throw new Error(`wired voice gateway: binding seed rejected (${seeded.code}).`);
        }
      }
      await stack.start();
      await transport.start();
    },
    async stop() {
      await transport.stop();
      await stack.stop();
    },
    mappingSnapshot: () => stack.mappingSnapshot(),
    adapterMetrics: () => stack.adapterMetrics(),
    handleBridgeFrameForTest: (frame) => routeFrame(frame),
    notifyBridgeLifecycleForTest: (event) => {
      // Same handler the real transport fires — no listener accumulation.
      announceServerRestart();
    },
  };
  return wired;
}
