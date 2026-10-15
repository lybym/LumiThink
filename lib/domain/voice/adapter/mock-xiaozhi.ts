/**
 * R1-V3 synthetic xiaozhi device + self-hosted-server mock — the
 * deterministic, replayable stand-in for the device edge (issue #30 实现范围
 * 3: 纯合成音频/Mock 服务端故障注入; 非目标: 实机/真实音频).
 *
 * What it models of the pinned baseline (78/xiaozhi-esp32 v2.5.2 +
 * xinnan-tech/xiaozhi-esp32-server):
 * - the device connects with a hello (device id, uplink audio params);
 * - the server mints a per-connection `session_id` and returns it
 *   (session_issued) — EPHEMERAL, re-minted after a restart;
 * - the device side emits listen states, transient ASR partials/finals and
 *   `abort` (the wire name of the client_abort intent);
 * - the server can drop a connection (network), crash entirely
 *   (server_restart — every session id is invalidated), or a second
 *   connection for the same device can be attempted (duplicate);
 * - the device playback side (Adapter directive sink) applies tts.start /
 *   tts.frames / tts.stop / tts.clear and ENFORCES its own epoch: frames for
 *   an epoch that was stopped or superseded are stale-rejected, which is how
 *   out-of-order output is made observable without any audio bytes.
 *
 * Determinism: everything is schedule/flush-driven — no timers, no
 * randomness. The scheduled inbound event log and the applied directive log
 * make every scenario replayable byte-for-byte (fixtures.ts asserts replay
 * equality via fingerprint()).
 *
 * PRIVACY: the only text here is the injected synthetic, child-safe script;
 * nothing is persisted. No audio bytes exist — playback is frame counts.
 *
 * This module must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import type {
  GatewayAbortReason,
  GatewayAudioParams,
  GatewayDeviceDirective,
  GatewayDeviceEvent,
  GatewayListenMode,
  GatewayListenState,
} from "./protocol.ts";
import { XIAOZHI_GATEWAY_BASELINE } from "./protocol.ts";

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

/** One scheduled inbound event (device/server → adapter), with its source seq. */
export interface MockGatewaySourceEvent {
  readonly sourceSeq: number;
  readonly connectionId: string;
  readonly event: GatewayDeviceEvent;
}

/** One directive the (mock) device applied, with the device-side epoch check. */
export interface MockDeviceAppliedDirective {
  readonly sourceSeq: number;
  readonly directive: GatewayDeviceDirective;
  readonly accepted: boolean;
  /** Enumerated device-side refusal (stale epoch / after stop / unbound). */
  readonly deviceCode: "ok" | "stale_epoch" | "after_stop" | "unbound_session";
}

export interface MockXiaozhiGatewayOptions {
  /** Deterministic synthetic uplink params (defaults to the pinned baseline). */
  readonly uplinkAudio?: GatewayAudioParams;
  /** Device-side strictness: refuse frames for a stale/stopped epoch (default true). */
  readonly strictDeviceEpoch?: boolean;
}

interface MockConnectionState {
  readonly connectionId: string;
  deviceId: string | null;
  open: boolean;
  xiaozhiSessionId: string | null;
  sessionCounter: number;
  sessionKey: string | null;
  pending: GatewayDeviceEvent[];
  /** Frame batches held back (delayed / out-of-order application). */
  heldFrames: GatewayDeviceDirective[];
  /** The device playback epoch currently bound (tts.start binds it). */
  deviceEpoch: number | null;
  readonly stoppedTurns: Set<string>;
}

export interface MockXiaozhiGateway {
  /** Device connects (schedules the hello event). */
  connect(refs: { readonly connectionId: string; readonly deviceId: string; readonly clientDigest?: string }): void;
  /** Server accepts and mints a fresh per-connection session id. */
  serverAccept(connectionId: string): string;
  /** Record the trusted session key the adapter mapped this connection to. */
  bindSession(connectionId: string, sessionKey: string): void;
  /** Schedule listen state events. */
  listenState(connectionId: string, state: GatewayListenState, mode?: GatewayListenMode): void;
  /** Schedule a transient partial hypothesis (synthetic text only). */
  speakPartial(connectionId: string, text: string): void;
  /** Schedule a final transcript (synthetic text only). */
  speakFinal(connectionId: string, text: string): void;
  /** Schedule a device abort (the wire client_abort intent). */
  abortSpeaking(connectionId: string, reason?: GatewayAbortReason): void;
  // ---- fault injection ----
  /** Network drop of one connection. */
  dropConnection(connectionId: string, reason?: "network" | "device"): void;
  /** The whole self-hosted server restarts: every connection dies, every session id is invalidated. */
  restartServer(): void;
  /** Attempt a SECOND connection for an already-connected device. */
  duplicateConnect(refs: { readonly connectionId: string; readonly deviceId: string }): void;
  // ---- inbound delivery ----
  /** Drain the scheduled inbound events of one connection, in schedule order. */
  flush(connectionId: string): readonly GatewayDeviceEvent[];
  /** Flush every connection's pending events (with their connection ids). */
  flushAll(): readonly { readonly connectionId: string; readonly event: GatewayDeviceEvent }[];
  // ---- device playback sink (Adapter → device) ----
  /** Adapter directive sink: apply immediately (or hold, for out-of-order runs). */
  applyDirective(directive: GatewayDeviceDirective): MockDeviceAppliedDirective["deviceCode"];
  /** Hold subsequent frame batches for one connection (delayed application). */
  holdFrames(connectionId: string): void;
  /** Apply everything held so far, in hold order; re-checks the device epoch. */
  flushDevice(connectionId: string): readonly MockDeviceAppliedDirective[];
  /** Counted device-side refusals across all applications. */
  readonly staleFrameRefusals: () => number;
  // ---- replay truth ----
  readonly sourceLog: () => readonly MockGatewaySourceEvent[];
  readonly appliedLog: () => readonly MockDeviceAppliedDirective[];
  readonly fingerprint: () => string;
  readonly sessionCounter: () => number;
}

function createConnectionState(connectionId: string): MockConnectionState {
  return {
    connectionId,
    deviceId: null,
    open: false,
    xiaozhiSessionId: null,
    sessionCounter: 0,
    sessionKey: null,
    pending: [],
    heldFrames: [],
    deviceEpoch: null,
    stoppedTurns: new Set<string>(),
  };
}

/** Deterministic digest for replay fingerprints (FNV-1a over sorted JSON). */
function replayDigest(value: unknown): string {
  const canonical = stableStringify(value);
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= BigInt(canonical.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Minimal stable stringify (key-sorted; JSON only). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

export function createMockXiaozhiGateway(options: MockXiaozhiGatewayOptions = {}): MockXiaozhiGateway {
  if (options === null || typeof options !== "object") {
    throw new Error("mock xiaozhi gateway options must be an object.");
  }
  const uplinkAudio = options.uplinkAudio ?? {
    format: XIAOZHI_GATEWAY_BASELINE.uplinkAudio.format,
    sampleRate: XIAOZHI_GATEWAY_BASELINE.uplinkAudio.sampleRate,
    channels: XIAOZHI_GATEWAY_BASELINE.uplinkAudio.channels,
    frameDurationMs: XIAOZHI_GATEWAY_BASELINE.uplinkAudio.frameDurationMs,
  };
  const strictDeviceEpoch = options.strictDeviceEpoch ?? true;
  const connections = new Map<string, MockConnectionState>();
  const holding = new Set<string>();
  const sourceLog: MockGatewaySourceEvent[] = [];
  const appliedLog: MockDeviceAppliedDirective[] = [];
  let sourceSeq = 0;
  let sessionSeq = 0;
  let appliedSeq = 0;
  let staleRefusals = 0;

  function connection(connectionId: string): MockConnectionState {
    let state = connections.get(connectionId);
    if (state === undefined) {
      state = createConnectionState(connectionId);
      connections.set(connectionId, state);
    }
    return state;
  }

  function schedule(state: MockConnectionState, event: GatewayDeviceEvent): void {
    sourceSeq += 1;
    sourceLog.push({ sourceSeq, connectionId: state.connectionId, event });
    state.pending.push(event);
  }

  function closeInternal(state: MockConnectionState, reason: "network" | "device" | "server"): void {
    state.open = false;
    state.deviceEpoch = null;
    state.heldFrames = [];
    if (reason !== "server") {
      schedule(state, { kind: "connection_dropped", reason });
    }
  }

  /** Shared device-side acceptance check for a frames directive. */
  function checkFrames(state: MockConnectionState, directive: GatewayDeviceDirective): MockDeviceAppliedDirective["deviceCode"] {
    if (!strictDeviceEpoch) {
      return "ok";
    }
    if (state.deviceEpoch === null || directive.kind !== "tts.frames" || directive.epoch !== state.deviceEpoch) {
      return "stale_epoch";
    }
    if (state.stoppedTurns.has(directive.turnId)) {
      return "after_stop";
    }
    return "ok";
  }

  function recordApplied(directive: GatewayDeviceDirective, accepted: boolean, deviceCode: MockDeviceAppliedDirective["deviceCode"]): MockDeviceAppliedDirective {
    appliedSeq += 1;
    if (deviceCode === "stale_epoch" || deviceCode === "after_stop") {
      staleRefusals += 1;
    }
    const record: MockDeviceAppliedDirective = { sourceSeq: appliedSeq, directive, accepted, deviceCode };
    appliedLog.push(record);
    return record;
  }

  const mock: MockXiaozhiGateway = {
    connect(refs) {
      if (typeof refs.connectionId !== "string" || refs.connectionId.length === 0) {
        throw new Error("mock connect requires a connectionId.");
      }
      if (typeof refs.deviceId !== "string" || refs.deviceId.length === 0) {
        throw new Error("mock connect requires a deviceId.");
      }
      const state = connection(refs.connectionId);
      state.deviceId = refs.deviceId;
      state.open = true;
      schedule(state, {
        kind: "hello",
        deviceId: refs.deviceId,
        ...(refs.clientDigest !== undefined ? { clientDigest: refs.clientDigest } : { clientDigest: null }),
        audioParams: { ...uplinkAudio },
      });
    },

    serverAccept(connectionId) {
      const state = connection(connectionId);
      if (!state.open) {
        throw new Error("mock serverAccept requires an open connection.");
      }
      sessionSeq += 1;
      state.sessionCounter += 1;
      // uuid-like but deterministic; dashes allowed by the grammar.
      const sessionId = `sessmock-${sessionSeq.toString().padStart(6, "0")}-${state.sessionCounter
        .toString()
        .padStart(4, "0")}`;
      state.xiaozhiSessionId = sessionId;
      schedule(state, { kind: "session_issued", xiaozhiSessionId: sessionId });
      return sessionId;
    },

    bindSession(connectionId, sessionKey) {
      const state = connection(connectionId);
      state.sessionKey = sessionKey;
    },

    listenState(connectionId, state_, mode) {
      const state = connection(connectionId);
      if (state.xiaozhiSessionId === null) {
        throw new Error("mock listenState requires a server-accepted session.");
      }
      schedule(state, {
        kind: "listen",
        xiaozhiSessionId: state.xiaozhiSessionId,
        state: state_,
        ...(mode !== undefined ? { mode } : { mode: null }),
      });
    },

    speakPartial(connectionId, text) {
      const state = connection(connectionId);
      if (state.xiaozhiSessionId === null) {
        throw new Error("mock speakPartial requires a server-accepted session.");
      }
      schedule(state, { kind: "asr_partial", xiaozhiSessionId: state.xiaozhiSessionId, text });
    },

    speakFinal(connectionId, text) {
      const state = connection(connectionId);
      if (state.xiaozhiSessionId === null) {
        throw new Error("mock speakFinal requires a server-accepted session.");
      }
      schedule(state, { kind: "asr_final", xiaozhiSessionId: state.xiaozhiSessionId, text });
    },

    abortSpeaking(connectionId, reason = "manual") {
      const state = connection(connectionId);
      if (state.xiaozhiSessionId === null) {
        throw new Error("mock abortSpeaking requires a server-accepted session.");
      }
      schedule(state, { kind: "abort", xiaozhiSessionId: state.xiaozhiSessionId, reason });
    },

    dropConnection(connectionId, reason = "network") {
      const state = connection(connectionId);
      if (!state.open) {
        return;
      }
      closeInternal(state, reason);
    },

    restartServer() {
      for (const state of connections.values()) {
        if (state.open) {
          // The restart signal is delivered through the pending queue; the
          // connection itself then dies silently (a dying socket cannot
          // send a close frame).
          schedule(state, { kind: "server_restart" });
          closeInternal(state, "server");
        }
        state.xiaozhiSessionId = null;
      }
    },

    duplicateConnect(refs) {
      const state = connection(refs.connectionId);
      state.deviceId = refs.deviceId;
      state.open = true;
      schedule(state, {
        kind: "hello",
        deviceId: refs.deviceId,
        clientDigest: null,
        audioParams: { ...uplinkAudio },
      });
    },

    flush(connectionId) {
      const state = connection(connectionId);
      const drained = [...state.pending];
      state.pending = [];
      return drained;
    },

    flushAll() {
      const out: { connectionId: string; event: GatewayDeviceEvent }[] = [];
      for (const state of connections.values()) {
        for (const event of mock.flush(state.connectionId)) {
          out.push({ connectionId: state.connectionId, event });
        }
      }
      return out;
    },

    applyDirective(directive) {
      // Route by the trusted session key recorded for the connection.
      let target: MockConnectionState | null = null;
      for (const state of connections.values()) {
        if (state.open && state.sessionKey !== null && state.sessionKey === directive.sessionKey) {
          target = state;
          break;
        }
      }
      if (target === null) {
        return recordApplied(directive, false, "unbound_session").deviceCode;
      }
      if (directive.kind === "tts.frames" && holding.has(target.connectionId)) {
        // Out-of-order simulation: hold the batch for a later flushDevice.
        target.heldFrames.push(directive);
        return "ok";
      }
      let code: MockDeviceAppliedDirective["deviceCode"] = "ok";
      let accepted = true;
      if (directive.kind === "tts.start") {
        target.deviceEpoch = directive.epoch;
        target.stoppedTurns.clear();
      } else if (directive.kind === "tts.frames") {
        code = checkFrames(target, directive);
        accepted = code === "ok";
      } else if (directive.kind === "tts.stop") {
        target.deviceEpoch = null;
        if (directive.turnId !== null) {
          target.stoppedTurns.add(directive.turnId);
        }
      } else if (directive.kind === "tts.clear") {
        // Queue-clear evidence: the device drops everything buffered.
        target.heldFrames = [];
      }
      return recordApplied(directive, accepted, code).deviceCode;
    },

    holdFrames(connectionId) {
      holding.add(connectionId);
    },

    flushDevice(connectionId) {
      holding.delete(connectionId);
      const state = connection(connectionId);
      const applied: MockDeviceAppliedDirective[] = [];
      for (const directive of state.heldFrames) {
        let code: MockDeviceAppliedDirective["deviceCode"] = "ok";
        let accepted = true;
        if (directive.kind === "tts.frames") {
          code = checkFrames(state, directive);
          accepted = code === "ok";
        } else if (directive.kind === "tts.stop") {
          state.deviceEpoch = null;
          if (directive.turnId !== null) {
            state.stoppedTurns.add(directive.turnId);
          }
        }
        applied.push(recordApplied(directive, accepted, code));
      }
      state.heldFrames = [];
      return applied;
    },

    staleFrameRefusals: () => staleRefusals,

    sourceLog: () => Object.freeze([...sourceLog]),
    appliedLog: () => Object.freeze([...appliedLog]),
    fingerprint: () => replayDigest({ source: sourceLog, applied: appliedLog }),
    sessionCounter: () => sessionSeq,
  };

  return mock;
}
