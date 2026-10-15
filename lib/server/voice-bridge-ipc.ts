/**
 * R1-V2 Bridge IPC transport — private local-socket wiring for the
 * lumi-dsh-runtime-bridge (issue #29 实现范围 3; docs/VOICE_RUNTIME.md §3/§8).
 *
 * Production target: a Linux Unix Domain Socket that is ONLY reachable on
 * the host (file mode 0600 after listen, stale-socket cleanup, absolute
 * path required). On Windows development/CI the same frame protocol runs
 * over a local named pipe — a platform fallback for tests, never the
 * production endpoint shape (the issue's UDS permission guarantees apply
 * on the POSIX target).
 *
 * Transport guarantees (fail closed):
 * - length-prefixed JSON frames with a hard byte cap (oversize destroys
 *   the connection);
 * - protocol version + bounded auth token on the FIRST frame — anything
 *   else is rejected before any command executes;
 * - single-connection lease: one authenticated Orchestrator at a time; a
 *   second concurrent client is closed with `lease_denied` stats;
 * - per-connection rate limiting over a sliding window (injectable clock
 *   for deterministic tests) with a bounded violation budget;
 * - commands dispatched strictly in arrival order; events are pushed to
 *   the leased client only.
 *
 * The auth token is a local secret: it is never logged, echoed into
 * errors, or included in any diagnostic string this module produces.
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
  BRIDGE_IPC_AUTH_PATTERN,
  BRIDGE_IPC_MAX_FRAMES_PER_WINDOW,
  BRIDGE_IPC_PROTOCOL,
  BRIDGE_IPC_RATE_WINDOW_MS,
  parseBridgeFrame,
  type BridgeCommandFrame,
  type BridgeFrame,
  type BridgeReplyRejectionFrame,
  type BridgeSessionClosePayload,
  type BridgeSessionOpenPayload,
  type BridgeTurnCancelPayload,
  type BridgeTurnPromptPayload,
  type BridgeTurnStreamPayload,
} from "../domain/voice/bridge/ipc-contract.ts";
import type { VoiceBridgeService } from "../domain/voice/bridge/bridge.ts";

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export type BridgeIpcEndpoint =
  | { readonly kind: "uds"; readonly path: string }
  | { readonly kind: "named_pipe"; readonly name: string };

/**
 * Resolve the default endpoint for this platform: a UDS path under
 * `socketDir` on POSIX (the production shape), a named pipe on Windows
 * (development/CI fallback with the same protocol).
 */
export function resolveBridgeIpcEndpoint(options: {
  readonly socketDir?: string;
  readonly name: string;
}): BridgeIpcEndpoint {
  if (typeof options.name !== "string" || options.name.length === 0 || options.name.length > 64 || !/^[A-Za-z0-9._-]+$/.test(options.name)) {
    throw new Error("bridge ipc endpoint name must be a bounded safe identifier.");
  }
  if (process.platform === "win32") {
    return { kind: "named_pipe", name: options.name };
  }
  const dir = options.socketDir ?? tmpdir();
  if (!isAbsolute(dir)) {
    throw new Error("bridge ipc socket dir must be an absolute path.");
  }
  return { kind: "uds", path: join(dir, `${options.name}.sock`) };
}

// ---------------------------------------------------------------------------
// Frame codec (byte level)
// ---------------------------------------------------------------------------

export const BRIDGE_IPC_MAX_FRAME_BYTES = 65_536;

/** Encode one frame: 4-byte big-endian body length + UTF-8 JSON body. */
export function encodeBridgeFrame(frame: BridgeFrame): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  if (body.length > BRIDGE_IPC_MAX_FRAME_BYTES) {
    throw new Error("bridge ipc frame body exceeds the byte cap.");
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** One decoded frame candidate with its raw body size. */
export interface DecodedBridgeFrame {
  readonly size: number;
  readonly frame: BridgeFrame;
}

/**
 * Incremental frame decoder. `push(bytes)` returns complete frames and
 * fails closed on oversize or malformed JSON (the caller destroys the
 * connection — a parse failure must never escape into a socket handler).
 */
export class BridgeFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): { readonly frames: DecodedBridgeFrame[]; readonly oversized: boolean; readonly malformed: boolean } {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: DecodedBridgeFrame[] = [];
    for (;;) {
      if (this.buffer.length < 4) {
        return { frames, oversized: false, malformed: false };
      }
      const bodyLength = this.buffer.readUInt32BE(0);
      if (bodyLength > BRIDGE_IPC_MAX_FRAME_BYTES) {
        // Consume the poisoned header so a continued stream cannot re-trigger.
        this.buffer = this.buffer.subarray(4);
        return { frames, oversized: true, malformed: false };
      }
      if (this.buffer.length < 4 + bodyLength) {
        return { frames, oversized: false, malformed: false };
      }
      const body = this.buffer.subarray(4, 4 + bodyLength);
      this.buffer = this.buffer.subarray(4 + bodyLength);
      let parsed;
      try {
        parsed = parseBridgeFrame(body.toString("utf8"));
      } catch {
        return { frames, oversized: false, malformed: true };
      }
      frames.push({ size: bodyLength, frame: parsed });
    }
  }
}

// ---------------------------------------------------------------------------
// Command dispatch (shared by the socket server and the in-process transport)
// ---------------------------------------------------------------------------

/** Dispatch one validated command frame to the service (in-order caller). */
export async function dispatchBridgeCommand(service: VoiceBridgeService, frame: BridgeCommandFrame): Promise<BridgeFrame> {
  function rejection(code: BridgeReplyRejectionFrame["code"]): BridgeReplyRejectionFrame {
    return { kind: "reply", name: frame.name, seq: frame.seq, ok: false, code };
  }
  switch (frame.name) {
    case "session.open": {
      const result = await service.openSession(frame.payload as BridgeSessionOpenPayload);
      return result.ok
        ? { kind: "reply", name: frame.name, seq: frame.seq, ok: true, payload: result.value }
        : rejection(result.code);
    }
    case "turn.prompt": {
      const result = await service.turnPrompt(frame.payload as BridgeTurnPromptPayload);
      return result.ok
        ? { kind: "reply", name: frame.name, seq: frame.seq, ok: true, payload: result.value }
        : rejection(result.code);
    }
    case "turn.cancel": {
      const result = await service.turnCancel(frame.payload as BridgeTurnCancelPayload);
      return result.ok
        ? { kind: "reply", name: frame.name, seq: frame.seq, ok: true, payload: result.value }
        : rejection(result.code);
    }
    case "turn.stream": {
      const result = await service.turnStream(frame.payload as BridgeTurnStreamPayload);
      return result.ok
        ? { kind: "reply", name: frame.name, seq: frame.seq, ok: true, payload: result.value }
        : rejection(result.code);
    }
    case "session.close": {
      const result = await service.closeSession(frame.payload as BridgeSessionClosePayload);
      return result.ok
        ? { kind: "reply", name: frame.name, seq: frame.seq, ok: true, payload: result.value }
        : rejection(result.code);
    }
    default:
      return rejection("protocol_violation");
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface VoiceBridgeIpcServerOptions {
  readonly endpoint: BridgeIpcEndpoint;
  /** The local lease secret (grammar-enforced; never logged). */
  readonly authToken: string;
  readonly service: VoiceBridgeService;
  readonly maxFramesPerWindow?: number;
  readonly rateWindowMs?: number;
  readonly rateViolationsBeforeClose?: number;
  /** Injectable clock for deterministic rate-limit tests. */
  readonly now?: () => number;
}

export interface VoiceBridgeIpcServerStats {
  readonly activeConnections: number;
  readonly authenticatedClients: number;
  readonly rejectedAuth: number;
  readonly deniedLease: number;
  readonly rateLimitedReplies: number;
  readonly closedOversize: number;
  readonly closedProtocolViolation: number;
}

export interface VoiceBridgeIpcServer {
  readonly endpoint: BridgeIpcEndpoint;
  /** The exact listen target (uds path or pipe name). */
  readonly target: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  stats(): Readonly<VoiceBridgeIpcServerStats>;
}

function listenTarget(endpoint: BridgeIpcEndpoint): string {
  return endpoint.kind === "uds" ? endpoint.path : `\\\\.\\pipe\\${endpoint.name}`;
}

/** Create the bridge IPC server (no listener until start()). */
export function createVoiceBridgeIpcServer(options: VoiceBridgeIpcServerOptions): VoiceBridgeIpcServer {
  if (!BRIDGE_IPC_AUTH_PATTERN.test(options.authToken ?? "")) {
    throw new Error("bridge ipc authToken must match the bounded token grammar (refusing a weak lease secret).");
  }
  if (typeof options.service !== "object" || options.service === null) {
    throw new Error("bridge ipc server requires a VoiceBridgeService.");
  }
  const authToken = options.authToken;
  const service = options.service;
  const maxFramesPerWindow = Math.max(1, options.maxFramesPerWindow ?? BRIDGE_IPC_MAX_FRAMES_PER_WINDOW);
  const rateWindowMs = Math.max(1, options.rateWindowMs ?? BRIDGE_IPC_RATE_WINDOW_MS);
  const rateViolationBudget = Math.max(1, options.rateViolationsBeforeClose ?? 10);
  const now = options.now ?? (() => Date.now());

  const stats = {
    activeConnections: 0,
    authenticatedClients: 0,
    rejectedAuth: 0,
    deniedLease: 0,
    rateLimitedReplies: 0,
    closedOversize: 0,
    closedProtocolViolation: 0,
  };

  const server: Server = createServer();
  let leasedSocket: Socket | null = null;
  let started = false;
  let udsPath: string | null = null;

  interface ConnectionState {
    socket: Socket;
    decoder: BridgeFrameDecoder;
    authenticated: boolean;
    windowStart: number;
    windowCount: number;
    rateViolations: number;
    dispatchQueue: Promise<void>;
  }

  const connections = new Set<ConnectionState>();

  function sendFrame(state: ConnectionState, frame: BridgeFrame): void {
    if (state.socket.destroyed) {
      return;
    }
    state.socket.write(encodeBridgeFrame(frame));
  }

  function rejectionReply(frame: BridgeCommandFrame, code: BridgeReplyRejectionFrame["code"]): BridgeReplyRejectionFrame {
    return { kind: "reply", name: frame.name, seq: frame.seq, ok: false, code };
  }

  async function dispatchCommand(frame: BridgeCommandFrame): Promise<BridgeFrame> {
    return dispatchBridgeCommand(service, frame);
  }

  function handleFrame(state: ConnectionState, frame: BridgeFrame): void {
    if (!state.authenticated) {
      if (frame.kind !== "hello" || frame.v !== BRIDGE_IPC_PROTOCOL || frame.auth !== authToken) {
        // Never echo the submitted token or any frame content.
        stats.rejectedAuth += 1;
        state.socket.destroy();
        return;
      }
      if (leasedSocket !== null && !leasedSocket.destroyed) {
        // Lease held by another live client.
        stats.deniedLease += 1;
        state.socket.destroy();
        return;
      }
      state.authenticated = true;
      leasedSocket = state.socket;
      stats.authenticatedClients += 1;
      sendFrame(state, {
        kind: "event",
        name: "hello_ack",
        payload: {
          v: BRIDGE_IPC_PROTOCOL,
          bridgeId: service.bridgeId,
          profileId: service.profile.profileId,
          dshVersion: service.dshVersion,
        },
      });
      return;
    }
    if (frame.kind === "hello") {
      stats.closedProtocolViolation += 1;
      state.socket.destroy();
      return;
    }
    if (frame.kind === "command") {
      // Rate limiting applies to authenticated command frames only.
      const t = now();
      if (t - state.windowStart > rateWindowMs) {
        state.windowStart = t;
        state.windowCount = 0;
      }
      state.windowCount += 1;
      if (state.windowCount > maxFramesPerWindow) {
        state.rateViolations += 1;
        stats.rateLimitedReplies += 1;
        sendFrame(state, rejectionReply(frame, "rate_limited"));
        if (state.rateViolations >= rateViolationBudget) {
          state.socket.destroy();
        }
        return;
      }
      // Strict in-order command execution.
      state.dispatchQueue = state.dispatchQueue.then(async () => {
        const reply = await dispatchCommand(frame);
        sendFrame(state, reply);
      }).catch(() => {
        // The service maps its own failures; a transport-level dispatch
        // fault closes the connection rather than inventing a reply.
        state.socket.destroy();
      });
      return;
    }
    // Replies/events are server→client only; a client sending them is a
    // protocol violation.
    stats.closedProtocolViolation += 1;
    state.socket.destroy();
  }

  server.on("connection", (socket) => {
    const state: ConnectionState = {
      socket,
      decoder: new BridgeFrameDecoder(),
      authenticated: false,
      windowStart: now(),
      windowCount: 0,
      rateViolations: 0,
      dispatchQueue: Promise.resolve(),
    };
    connections.add(state);
    stats.activeConnections = connections.size;
    socket.on("data", (chunk: Buffer) => {
      const { frames, oversized, malformed } = state.decoder.push(chunk);
      if (oversized || malformed) {
        if (oversized) {
          stats.closedOversize += 1;
        } else {
          stats.closedProtocolViolation += 1;
        }
        socket.destroy();
        return;
      }
      for (const { frame } of frames) {
        if (socket.destroyed) {
          break;
        }
        handleFrame(state, frame);
      }
    });
    const cleanup = () => {
      connections.delete(state);
      stats.activeConnections = connections.size;
      if (leasedSocket === socket) {
        leasedSocket = null;
      }
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  return {
    endpoint: options.endpoint,
    get target() {
      return listenTarget(options.endpoint);
    },
    async start() {
      if (started) {
        return;
      }
      if (options.endpoint.kind === "uds") {
        udsPath = options.endpoint.path;
        if (existsSync(udsPath)) {
          const st = statSync(udsPath);
          if (!st.isSocket()) {
            throw new Error("bridge ipc socket path exists and is not a socket; refusing to overwrite.");
          }
          unlinkSync(udsPath);
        }
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => reject(error);
          server.once("error", onError);
          server.listen(udsPath, () => {
            server.off("error", onError);
            try {
              // Restrict the socket file to the owner (issue #29: socket
              // 文件权限). The umask-independent mode is the guarantee.
              chmodSync(udsPath as string, 0o600);
            } catch (error) {
              reject(error instanceof Error ? error : new Error("chmod failed"));
              return;
            }
            resolve();
          });
        });
      } else {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error) => reject(error);
          server.once("error", onError);
          server.listen(listenTarget(options.endpoint), () => {
            server.off("error", onError);
            resolve();
          });
        });
      }
      started = true;
    },
    async stop() {
      if (!started) {
        return;
      }
      for (const state of [...connections]) {
        state.socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      if (udsPath !== null && existsSync(udsPath)) {
        unlinkSync(udsPath);
      }
      started = false;
    },
    stats() {
      return { ...stats };
    },
  };
}

// ---------------------------------------------------------------------------
// Client (the Orchestrator-side end of the lease)
// ---------------------------------------------------------------------------

export interface VoiceBridgeIpcClientOptions {
  readonly endpoint: BridgeIpcEndpoint;
  readonly authToken: string;
  /** Reply wait budget (real-time safety net; normal flows stay fast). */
  readonly commandTimeoutMs?: number;
}

export interface VoiceBridgeIpcClient {
  connect(): Promise<void>;
  command(
    name: BridgeCommandFrame["name"],
    payload: unknown,
  ): Promise<{ readonly ok: true; readonly payload: unknown } | { readonly ok: false; readonly code: string }>;
  onEvent(listener: (frame: BridgeFrame) => void): void;
  /** Raw frame send for protocol-violation tests (bypasses typing). */
  sendRaw(frame: unknown): void;
  /** Raw byte send for oversize tests. */
  sendBytes(bytes: Buffer): void;
  isConnected(): boolean;
  close(): Promise<void>;
}

/** Create the bridge IPC client (no connection until connect()). */
export function createVoiceBridgeIpcClient(options: VoiceBridgeIpcClientOptions): VoiceBridgeIpcClient {
  if (!BRIDGE_IPC_AUTH_PATTERN.test(options.authToken ?? "")) {
    throw new Error("bridge ipc authToken must match the bounded token grammar.");
  }
  const authToken = options.authToken;
  const endpoint = options.endpoint;
  const commandTimeoutMs = Math.max(100, options.commandTimeoutMs ?? 10_000);

  let socket: Socket | null = null;
  let decoder: BridgeFrameDecoder | null = null;
  let connected = false;
  let helloAck: Promise<void> | null = null;
  const eventListeners: ((frame: BridgeFrame) => void)[] = [];
  const pending = new Map<number, (reply: { ok: true; payload: unknown } | { ok: false; code: string }) => void>();
  let processQueue: Promise<void> = Promise.resolve();
  let nextSeq = 1;

  function handleData(chunk: Buffer): void {
    if (decoder === null) {
      return;
    }
    const { frames, oversized, malformed } = decoder.push(chunk);
    if (oversized || malformed) {
      socket?.destroy();
      return;
    }
    for (const { frame } of frames) {
      const captured = frame;
      processQueue = processQueue.then(() => {
        if (captured.kind === "reply") {
          const resolver = pending.get(captured.seq);
          if (resolver !== undefined) {
            pending.delete(captured.seq);
            resolver(captured.ok ? { ok: true, payload: captured.payload } : { ok: false, code: captured.code });
          }
          return;
        }
        for (const listener of [...eventListeners]) {
          listener(captured);
        }
      });
    }
  }

  return {
    async connect() {
      if (connected) {
        return;
      }
      socket = new Socket();
      decoder = new BridgeFrameDecoder();
      socket.on("data", handleData);
      socket.on("error", () => undefined);
      const ack = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("bridge ipc handshake timed out")), commandTimeoutMs);
        helloAck = new Promise<void>((resolveAck, rejectAck) => {
          eventListeners.push((frame) => {
            if (frame.kind === "event" && frame.name === "hello_ack") {
              clearTimeout(timer);
              resolveAck();
            }
          });
          socket!.on("close", () => rejectAck(new Error("bridge ipc closed before handshake")));
          socket!.on("error", (error) => rejectAck(error));
        });
        helloAck.then(() => resolve(), (error) => reject(error));
      });
      await new Promise<void>((resolve, reject) => {
        const target = endpoint.kind === "uds" ? endpoint.path : `\\\\.\\pipe\\${endpoint.name}`;
        socket!.once("error", reject);
        socket!.connect(target, () => {
          socket!.off("error", reject);
          socket!.write(encodeBridgeFrame({ kind: "hello", v: BRIDGE_IPC_PROTOCOL, auth: authToken, role: "orchestrator" }));
          resolve();
        });
      });
      await ack;
      connected = true;
    },
    async command(name, payload) {
      if (!connected || socket === null || socket.destroyed) {
        return { ok: false, code: "protocol_violation" };
      }
      const seq = nextSeq;
      nextSeq += 1;
      const frame: BridgeCommandFrame = { kind: "command", name, seq, payload };
      const reply = await new Promise<{ ok: true; payload: unknown } | { ok: false; code: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(seq);
          reject(new Error("bridge ipc command timed out"));
        }, commandTimeoutMs);
        pending.set(seq, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
        socket!.write(encodeBridgeFrame(frame));
      });
      return reply;
    },
    onEvent(listener) {
      eventListeners.push(listener);
    },
    sendRaw(frame) {
      socket?.write(encodeBridgeFrame(frame as BridgeFrame));
    },
    sendBytes(bytes) {
      socket?.write(bytes);
    },
    isConnected() {
      return connected && socket !== null && !socket.destroyed;
    },
    async close() {
      connected = false;
      if (socket !== null) {
        socket.destroy();
        socket = null;
      }
      decoder = null;
    },
  };
}
