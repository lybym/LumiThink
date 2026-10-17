/**
 * E2E-07 (issue #57) — Voice Gateway internal transport: the PROTECTED
 * local-socket wiring between the pinned xiaozhi-esp32-server's bridge
 * extension (deploy/xiaozhi/gateway_bridge, running inside the pinned
 * server) and the LumiThink Voice Gateway Adapter stack.
 *
 * This is the internal half of the xiaozhi↔LumiThink wiring. The DEVICE
 * WebSocket (v2.5.2 wire protocol) stays entirely inside the pinned server;
 * LumiThink never terminates it. The bridge extension forwards the mapped
 * device events (hello/session/ASR-final/abort) plus real audio delivery
 * accounting over THIS transport, and receives the fence-stamped TTS
 * sentences (the text that the pinned server's TTS engine synthesizes and
 * streams to the device as Opus).
 *
 * Production target: a Linux Unix Domain Socket that is ONLY reachable on
 * the host (file mode 0600 after listen, stale-socket cleanup, absolute
 * path required, NO TCP option at all). On Windows development/CI the same
 * frame protocol runs over a local named pipe. The transport token is a
 * per-deployment secret (render-time injected); it is useless without
 * filesystem access to the socket endpoint ("连接令牌绑定受保护的内部传输").
 *
 * Transport guarantees (fail closed, mirroring voice-bridge-ipc.ts):
 * - length-prefixed JSON frames with a hard byte cap (oversize destroys
 *   the connection);
 * - protocol version + bounded auth token on the FIRST frame — anything
 *   else is rejected before any frame is forwarded;
 * - single-bridge lease: one authenticated bridge connection at a time;
 * - malformed JSON or an unknown frame kind destroys the connection — a
 *   parse failure never escapes into a socket handler.
 *
 * PRIVACY: the ONLY content-bearing fields on this transport are the
 * transient `turn_prompt.text` (the device ASR final, inbound) and
 * `tts_sentence.text` (the Output-Gate-admitted TTS input, outbound) — the
 * authorized channel of docs/VOICE_GATEWAY_PROTOCOL.md §2.3. Both are
 * bounded, never logged, never persisted by this module.
 *
 * This module is server infrastructure (node:net/node:fs): it must NOT be
 * imported by lib/domain (boundary-tested) and never opens a public
 * network listener — there is no TCP option at all.
 */

import { createServer, Socket, type Server } from "node:net";
import { chmodSync, existsSync, statSync, unlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import {
  GATEWAY_ABORT_REASONS,
  GATEWAY_MAX_ASR_FINAL_CHARS,
  XIAOZHI_DEVICE_ID_PATTERN,
  XIAOZHI_SESSION_ID_PATTERN,
  type GatewayAbortReason,
} from "../domain/voice/adapter/protocol.ts";

// ---------------------------------------------------------------------------
// Endpoint (same shapes as the R1-V2 Bridge IPC)
// ---------------------------------------------------------------------------

export type GatewayInternalEndpoint =
  | { readonly kind: "uds"; readonly path: string }
  | { readonly kind: "named_pipe"; readonly name: string };

/** Resolve the endpoint: UDS under `socketDir` on POSIX, named pipe on win32. */
export function resolveGatewayInternalEndpoint(options: {
  readonly socketDir?: string;
  readonly name: string;
}): GatewayInternalEndpoint {
  if (typeof options.name !== "string" || options.name.length === 0 || options.name.length > 64 || !/^[A-Za-z0-9._-]+$/.test(options.name)) {
    throw new Error("gateway internal endpoint name must be a bounded safe identifier.");
  }
  if (process.platform === "win32") {
    return { kind: "named_pipe", name: options.name };
  }
  const dir = options.socketDir ?? tmpdir();
  if (!isAbsolute(dir)) {
    throw new Error("gateway internal socket dir must be an absolute path.");
  }
  return { kind: "uds", path: join(dir, `${options.name}.sock`) };
}

// ---------------------------------------------------------------------------
// Frame vocabulary (fail-closed parser; allow-listed fields only)
// ---------------------------------------------------------------------------

export const GATEWAY_INTERNAL_PROTOCOL = 1 as const;
export const GATEWAY_INTERNAL_MAX_FRAME_BYTES = 65_536;
/** The bridge presents its per-deployment token on the first frame. */
export const GATEWAY_INTERNAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
/** Bridge-assigned per-device-connection handle (mirrors the Adapter's grammar). */
export const GATEWAY_INTERNAL_CONN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/;

export interface GatewayHelloAudioParams {
  readonly format: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly frameDurationMs: number;
}

/** Inbound frames (authenticated bridge → gateway). */
export type GatewayInternalInboundFrame =
  | {
      readonly kind: "device_hello";
      readonly connId: string;
      readonly deviceId: string;
      /**
       * The RAW wire header Device-Id (e.g. `aa:bb:cc:dd:ee:07`) — the
       * upstream AuthManager token is signed over the RAW header value,
       * so the gateway's HMAC re-computation must use it verbatim. The
       * normalized `deviceId` (transport contract: separator-stripped,
       * lower-cased) is what maps onto the guardian binding.
       */
      readonly deviceIdWire: string | null;
      /** Real handshake headers (Client-Id may be empty upstream). */
      readonly clientId: string | null;
      /** Real `Authorization` header value (`Bearer sig.ts`), verbatim. */
      readonly authorization: string | null;
      readonly audioParams: GatewayHelloAudioParams | null;
    }
  | {
      readonly kind: "session_issued";
      readonly connId: string;
      readonly xiaozhiSessionId: string;
    }
  | {
      readonly kind: "turn_prompt";
      readonly connId: string;
      readonly xiaozhiSessionId: string;
      /** TRANSIENT ASR final text (≤ protocol cap); never logged/persisted. */
      readonly text: string;
    }
  | {
      readonly kind: "abort";
      readonly connId: string;
      readonly xiaozhiSessionId: string;
      /** Upstream abortHandle carries no reason; default is `manual`. */
      readonly reason: GatewayAbortReason;
    }
  | {
      readonly kind: "audio_delivered";
      readonly connId: string;
      /** Current turn when known (bridge-side best effort). */
      readonly turnId: string | null;
      readonly frames: number;
      /** SHA-256 hex over the actual bytes sent to the device. */
      readonly digest: string;
    };

/** Outbound frames (gateway → authenticated bridge). */
export type GatewayInternalOutboundFrame =
  | { readonly kind: "bridge_ready" }
  | { readonly kind: "device_hello_result"; readonly connId: string; readonly ok: boolean; readonly code?: string }
  | { readonly kind: "device_drop"; readonly connId: string; readonly code: string }
  | {
      /** E2E-07: an accepted ASR final minted this turn (correlation key). */
      readonly kind: "turn_started";
      readonly connId: string;
      readonly turnId: string;
      readonly epoch: number;
    }
  | {
      /** E2E-07: the submitted prompt was rejected (enumerated; no turn). */
      readonly kind: "prompt_rejected";
      readonly connId: string;
      readonly code: string;
    }
  | {
      readonly kind: "tts_sentence";
      readonly connId: string;
      readonly xiaozhiSessionId: string;
      readonly turnId: string;
      readonly itemId: string;
      readonly epoch: number;
      /** Output-Gate-admitted TTS input (transient; never logged). */
      readonly text: string;
    }
  | {
      readonly kind: "tts_end";
      readonly connId: string;
      readonly turnId: string;
      readonly epoch: number;
      readonly reason: "completed" | "interrupted" | "failed";
    }
  | { readonly kind: "queue_clear"; readonly connId: string; readonly epoch: number };

export type GatewayInternalFrame = GatewayInternalInboundFrame | GatewayInternalOutboundFrame;

function failFrame(message: string): never {
  throw new Error(`gateway-internal-frame: ${message}`);
}

function frameObject(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    failFrame("expected a JSON object frame.");
  }
  return raw as Record<string, unknown>;
}

function str(record: Record<string, unknown>, key: string, pattern: RegExp): string {
  const value = record[key];
  if (typeof value !== "string" || !pattern.test(value)) {
    failFrame(`${key} must match its bounded grammar.`);
  }
  return value;
}

function optionalStr(record: Record<string, unknown>, key: string, maxLen: number): string | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > maxLen) {
    failFrame(`${key} must be a bounded non-empty string.`);
  }
  return value;
}

function parseAudioParams(raw: unknown): GatewayHelloAudioParams | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    failFrame("audioParams must be an object.");
  }
  const record = raw as Record<string, unknown>;
  if (record.format !== "opus") {
    failFrame("audioParams.format must be opus.");
  }
  const sampleRate = record.sampleRate;
  const channels = record.channels;
  const frameDurationMs = record.frameDurationMs;
  if (typeof sampleRate !== "number" || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
    failFrame("audioParams.sampleRate must be an integer in [8000, 48000].");
  }
  if (typeof channels !== "number" || !Number.isInteger(channels) || channels < 1 || channels > 2) {
    failFrame("audioParams.channels must be an integer in [1, 2].");
  }
  if (typeof frameDurationMs !== "number" || !Number.isInteger(frameDurationMs) || frameDurationMs < 10 || frameDurationMs > 120) {
    failFrame("audioParams.frameDurationMs must be an integer in [10, 120].");
  }
  return {
    format: record.format as string,
    sampleRate: sampleRate as number,
    channels: channels as number,
    frameDurationMs: frameDurationMs as number,
  };
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      failFrame(`unknown frame field: ${key}`);
    }
  }
}

/**
 * Parse ONE inbound frame (after authentication). Fail closed on unknown
 * kinds/fields/grammars — the caller destroys the connection.
 */
export function parseGatewayInternalInboundFrame(raw: unknown): GatewayInternalInboundFrame {
  const record = frameObject(raw);
  const kind = record.kind;
  switch (kind) {
    case "device_hello": {
      rejectUnknownFields(record, ["kind", "connId", "deviceId", "deviceIdWire", "clientId", "authorization", "audioParams"]);
      return {
        kind: "device_hello",
        connId: str(record, "connId", GATEWAY_INTERNAL_CONN_ID_PATTERN),
        deviceId: str(record, "deviceId", XIAOZHI_DEVICE_ID_PATTERN),
        deviceIdWire: optionalStr(record, "deviceIdWire", 128),
        clientId: optionalStr(record, "clientId", 128),
        authorization: optionalStr(record, "authorization", 512),
        audioParams: parseAudioParams(record.audioParams),
      };
    }
    case "session_issued": {
      rejectUnknownFields(record, ["kind", "connId", "xiaozhiSessionId"]);
      return {
        kind: "session_issued",
        connId: str(record, "connId", GATEWAY_INTERNAL_CONN_ID_PATTERN),
        xiaozhiSessionId: str(record, "xiaozhiSessionId", XIAOZHI_SESSION_ID_PATTERN),
      };
    }
    case "turn_prompt": {
      rejectUnknownFields(record, ["kind", "connId", "xiaozhiSessionId", "text"]);
      const text = record.text;
      if (typeof text !== "string" || text.length === 0 || text.length > GATEWAY_MAX_ASR_FINAL_CHARS) {
        failFrame("turn_prompt text must be a bounded non-empty string.");
      }
      return {
        kind: "turn_prompt",
        connId: str(record, "connId", GATEWAY_INTERNAL_CONN_ID_PATTERN),
        xiaozhiSessionId: str(record, "xiaozhiSessionId", XIAOZHI_SESSION_ID_PATTERN),
        text,
      };
    }
    case "abort": {
      rejectUnknownFields(record, ["kind", "connId", "xiaozhiSessionId", "reason"]);
      let reason: GatewayAbortReason = "manual";
      if (record.reason !== undefined && record.reason !== null) {
        if (typeof record.reason !== "string" || !(GATEWAY_ABORT_REASONS as readonly string[]).includes(record.reason)) {
          failFrame("abort reason must be a registered gateway reason.");
        }
        reason = record.reason as GatewayAbortReason;
      }
      return {
        kind: "abort",
        connId: str(record, "connId", GATEWAY_INTERNAL_CONN_ID_PATTERN),
        xiaozhiSessionId: str(record, "xiaozhiSessionId", XIAOZHI_SESSION_ID_PATTERN),
        reason,
      };
    }
    case "audio_delivered": {
      rejectUnknownFields(record, ["kind", "connId", "turnId", "frames", "digest"]);
      const frames = record.frames;
      const digest = record.digest;
      if (typeof frames !== "number" || !Number.isInteger(frames) || frames <= 0 || frames > 100_000) {
        failFrame("audio_delivered frames must be a positive bounded integer.");
      }
      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
        failFrame("audio_delivered digest must be a 64-hex SHA-256 digest.");
      }
      let turnId: string | null = null;
      if (record.turnId !== undefined && record.turnId !== null) {
        if (typeof record.turnId !== "string" || record.turnId.length === 0 || record.turnId.length > 64) {
          failFrame("audio_delivered turnId must be a bounded string.");
        }
        turnId = record.turnId;
      }
      return {
        kind: "audio_delivered",
        connId: str(record, "connId", GATEWAY_INTERNAL_CONN_ID_PATTERN),
        turnId,
        frames: frames as number,
        digest,
      };
    }
    default:
      failFrame("frame kind is not a registered gateway internal frame.");
  }
}

/**
 * First-frame auth parser (pre-authentication). Anything but a valid
 * `bridge_auth` frame is a rejection.
 */
export function parseGatewayInternalAuthFrame(raw: unknown): { readonly token: string } {
  const record = frameObject(raw);
  rejectUnknownFields(record, ["kind", "v", "token"]);
  if (record.kind !== "bridge_auth") {
    failFrame("the first frame must be bridge_auth.");
  }
  if (record.v !== GATEWAY_INTERNAL_PROTOCOL) {
    failFrame(`protocol version must be ${GATEWAY_INTERNAL_PROTOCOL}.`);
  }
  return { token: str(record, "token", GATEWAY_INTERNAL_TOKEN_PATTERN) };
}

// ---------------------------------------------------------------------------
// Frame codec (byte level, same discipline as voice-bridge-ipc.ts)
// ---------------------------------------------------------------------------

/** Encode one frame: 4-byte big-endian body length + UTF-8 JSON body. */
export function encodeGatewayInternalFrame(frame: GatewayInternalFrame | Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  if (body.length > GATEWAY_INTERNAL_MAX_FRAME_BYTES) {
    throw new Error("gateway internal frame body exceeds the byte cap.");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incremental decoder: returns complete frames; flags oversize/malformed. */
export class GatewayInternalFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): { readonly frames: unknown[]; readonly oversized: boolean; readonly malformed: boolean } {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: unknown[] = [];
    for (;;) {
      if (this.buffer.length < 4) {
        return { frames, oversized: false, malformed: false };
      }
      const bodyLength = this.buffer.readUInt32BE(0);
      if (bodyLength > GATEWAY_INTERNAL_MAX_FRAME_BYTES) {
        return { frames, oversized: true, malformed: false };
      }
      if (this.buffer.length < 4 + bodyLength) {
        return { frames, oversized: false, malformed: false };
      }
      const body = this.buffer.subarray(4, 4 + bodyLength).toString("utf8");
      this.buffer = this.buffer.subarray(4 + bodyLength);
      try {
        frames.push(JSON.parse(body));
      } catch {
        return { frames, oversized: false, malformed: true };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface GatewayInternalServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Send one frame to the authenticated bridge (no-op when not connected). */
  send(frame: GatewayInternalOutboundFrame): void;
  /** Registered inbound-frame handler (after authentication). */
  onFrame(handler: (frame: GatewayInternalInboundFrame) => void): void;
  /** Fired after a bridge authenticates (fresh server instance). */
  onBridgeAuthenticated(listener: (info: { readonly serverInstanceId: string }) => void): void;
  /** Fired when the bridge connection closes. */
  onBridgeClosed(listener: (info: { readonly hadLease: boolean }) => void): void;
  readonly endpoint: GatewayInternalEndpoint;
  isBridgeConnected(): boolean;
  describe(): { readonly listening: boolean; readonly bridgeConnected: boolean; readonly refusedLeases: number };
}

export interface GatewayInternalServerOptions {
  readonly endpoint: GatewayInternalEndpoint;
  /** Per-deployment shared secret; never logged, never echoed. */
  readonly authToken: string;
}

/** Constant-time string compare (length-independent via HMAC discipline). */
function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function createVoiceGatewayInternalServer(options: GatewayInternalServerOptions): GatewayInternalServer {
  if (typeof options.authToken !== "string" || !GATEWAY_INTERNAL_TOKEN_PATTERN.test(options.authToken)) {
    throw new Error("gateway internal server requires a bounded auth token.");
  }
  const endpoint = options.endpoint;
  let server: Server | null = null;
  let listening = false;
  let bridgeSocket: Socket | null = null;
  let bridgeAuthenticated = false;
  let refusedLeases = 0;
  const decoder = new GatewayInternalFrameDecoder();
  let frameHandler: ((frame: GatewayInternalInboundFrame) => void) | null = null;
  const authListeners: ((info: { readonly serverInstanceId: string }) => void)[] = [];
  const closedListeners: ((info: { readonly hadLease: boolean }) => void)[] = [];

  function destroySocket(socket: Socket): void {
    try {
      socket.destroy();
    } catch {
      // Destroying an already-dead socket is a no-op.
    }
  }

  function handleConnection(socket: Socket): void {
    // Single-bridge lease: any second concurrent connection is refused.
    if (bridgeSocket !== null) {
      refusedLeases += 1;
      destroySocket(socket);
      return;
    }
    bridgeSocket = socket;
    bridgeAuthenticated = false;
    let serverInstanceId = "";
    socket.on("data", (chunk: Buffer) => {
      const outcome = decoder.push(chunk);
      if (outcome.oversized || outcome.malformed) {
        // Content-free diagnostics: a destroyed connection must be
        // explainable from the host log.
        console.error(`[gateway-internal] connection destroyed: ${outcome.oversized ? "oversize" : "malformed"} frame`);
        destroySocket(socket);
        return;
      }
      for (const raw of outcome.frames) {
        if (!bridgeAuthenticated) {
          let auth: { readonly token: string };
          try {
            auth = parseGatewayInternalAuthFrame(raw);
          } catch (error) {
            console.error(`[gateway-internal] auth frame rejected: ${error instanceof Error ? error.message : String(error)}`);
            destroySocket(socket);
            return;
          }
          if (!tokensEqual(auth.token, options.authToken)) {
            console.error("[gateway-internal] auth token mismatch");
            destroySocket(socket);
            return;
          }
          bridgeAuthenticated = true;
          // The auth frame may carry a server instance marker (field-checked
          // inside the parser is NOT done for extra fields — the auth frame
          // allows only kind/v/token, so instance identity is implicit in a
          // fresh TCP/UDS connection after a server restart).
          serverInstanceId = `srv-${Date.now().toString(36)}`;
          try {
            socket.write(encodeGatewayInternalFrame({ kind: "bridge_ready" }));
          } catch {
            destroySocket(socket);
            return;
          }
          for (const listener of authListeners) {
            try {
              listener({ serverInstanceId });
            } catch {
              // Listener faults must not break the transport.
            }
          }
          continue;
        }
        try {
          const frame = parseGatewayInternalInboundFrame(raw);
          frameHandler?.(frame);
        } catch (error) {
          console.error(`[gateway-internal] inbound frame rejected: ${error instanceof Error ? error.message : String(error)}`);
          destroySocket(socket);
          return;
        }
      }
    });
    socket.on("error", () => {
      destroySocket(socket);
    });
    socket.on("close", () => {
      if (bridgeSocket === socket) {
        bridgeSocket = null;
        const hadLease = bridgeAuthenticated;
        bridgeAuthenticated = false;
        for (const listener of closedListeners) {
          try {
            listener({ hadLease });
          } catch {
            // Listener faults must not break the transport.
          }
        }
      }
    });
  }

  return {
    endpoint,
    async start() {
      if (listening) {
        return;
      }
      server = createServer((socket) => handleConnection(socket));
      await new Promise<void>((resolve, reject) => {
        const srv = server as Server;
        srv.once("error", reject);
        if (endpoint.kind === "uds") {
          if (existsSync(endpoint.path)) {
            // Stale socket from a crashed predecessor: same cleanup
            // discipline as voice-bridge-ipc.ts.
            if (statSync(endpoint.path).isSocket()) {
              unlinkSync(endpoint.path);
            }
          }
          srv.listen(endpoint.path, () => {
            try {
              chmodSync(endpoint.path, 0o600);
            } catch {
              // chmod is best-effort on filesystems without POSIX perms.
            }
            resolve();
          });
        } else {
          srv.listen(`\\\\.\\pipe\\${endpoint.name}`, () => resolve());
        }
      });
      listening = true;
    },
    async stop() {
      if (bridgeSocket !== null) {
        destroySocket(bridgeSocket);
        bridgeSocket = null;
      }
      bridgeAuthenticated = false;
      if (server !== null && listening) {
        await new Promise<void>((resolve) => {
          const srv = server as Server;
          srv.close(() => resolve());
        });
        if (endpoint.kind === "uds" && existsSync(endpoint.path)) {
          try {
            unlinkSync(endpoint.path);
          } catch {
            // Already removed by the OS on some platforms.
          }
        }
      }
      server = null;
      listening = false;
    },
    send(frame) {
      if (bridgeSocket === null || !bridgeAuthenticated) {
        return;
      }
      try {
        bridgeSocket.write(encodeGatewayInternalFrame(frame));
      } catch {
        destroySocket(bridgeSocket);
      }
    },
    onFrame(handler) {
      frameHandler = handler;
    },
    onBridgeAuthenticated(listener) {
      authListeners.push(listener);
    },
    onBridgeClosed(listener) {
      closedListeners.push(listener);
    },
    isBridgeConnected: () => bridgeSocket !== null && bridgeAuthenticated,
    describe: () => ({ listening, bridgeConnected: bridgeSocket !== null && bridgeAuthenticated, refusedLeases }),
  };
}
