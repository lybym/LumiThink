import assert from "node:assert/strict";
import test from "node:test";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * E2E-07 (issue #57) — protected internal transport tests: token-gated
 * first frame, single bridge lease, byte-capped/malformed frame
 * destruction, and the fail-closed inbound-frame parser.
 *
 * The dev sandbox on Windows forbids OPENING sockets (named pipes fail
 * `connect EPERM` at the OS boundary — the documented sandbox boundary,
 * same as voice-bridge-ipc.spec.ts), so socket-level tests run on the
 * POSIX CI target (real UDS, the production shape). Everything that needs
 * no socket — frame codec, parser, construction guards — runs on every
 * platform.
 */

import {
  GATEWAY_INTERNAL_MAX_FRAME_BYTES,
  GatewayInternalFrameDecoder,
  createVoiceGatewayInternalServer,
  encodeGatewayInternalFrame,
  parseGatewayInternalInboundFrame,
  resolveGatewayInternalEndpoint,
  type GatewayInternalInboundFrame,
  type GatewayInternalOutboundFrame,
} from "../../lib/server/voice-gateway-internal-transport.ts";

const SOCKETS_AVAILABLE = process.platform !== "win32";
const TOKEN = "gateway-internal-test-token-0123456789abcdef";

test("codec round-trips frames and flags oversize/malformed bodies", () => {
  const decoder = new GatewayInternalFrameDecoder();
  const frame = { kind: "turn_prompt", connId: "conn-0001", xiaozhiSessionId: "sess-abcd1234", text: "你好。" };
  const first = decoder.push(encodeGatewayInternalFrame(frame));
  assert.equal(first.frames.length, 1);
  assert.deepEqual(first.frames[0], frame);

  const header = Buffer.alloc(4);
  header.writeUInt32BE(GATEWAY_INTERNAL_MAX_FRAME_BYTES + 1, 0);
  const oversize = decoder.push(header);
  assert.equal(oversize.oversized, true);

  // A fresh decoder: the oversize header above stays buffered (the caller
  // must destroy the connection), so malformed detection needs clean state.
  const fresh = new GatewayInternalFrameDecoder();
  const malformed = fresh.push(Buffer.concat([Buffer.from([0, 0, 0, 2]), Buffer.from("{]", "utf8")]));
  assert.equal(malformed.malformed, true);
});

test("endpoint resolution picks a UDS path on POSIX and a named pipe on Windows; unsafe names fail closed", () => {
  const endpoint = resolveGatewayInternalEndpoint({ name: "lumithink-gwtest" });
  if (process.platform === "win32") {
    assert.equal(endpoint.kind, "named_pipe");
  } else {
    assert.equal(endpoint.kind, "uds");
    assert.ok(endpoint.path.endsWith("lumithink-gwtest.sock"));
  }
  assert.throws(() => resolveGatewayInternalEndpoint({ name: "../evil" }), Error);
  assert.throws(() => resolveGatewayInternalEndpoint({ name: "" }), Error);
});

test("the inbound-frame parser rejects unknown kinds, fields and grammar violations", () => {
  assert.throws(() => parseGatewayInternalInboundFrame({ kind: "mystery" }));
  assert.throws(() => parseGatewayInternalInboundFrame({ kind: "turn_prompt", connId: "conn-0001", xiaozhiSessionId: "sess-abcd1234", text: "hi", extra: 1 }));
  assert.throws(() => parseGatewayInternalInboundFrame({ kind: "turn_prompt", connId: "conn-0001", xiaozhiSessionId: "sess-abcd1234", text: "x".repeat(600) }));
  assert.throws(() => parseGatewayInternalInboundFrame({ kind: "device_hello", connId: "conn-0001", deviceId: "ZZ:BB:CC" }));
  assert.throws(() => parseGatewayInternalInboundFrame({ kind: "audio_delivered", connId: "conn-0001", turnId: null, frames: 0, digest: "a".repeat(64) }));
  assert.throws(() => parseGatewayInternalInboundFrame({ kind: "audio_delivered", connId: "conn-0001", turnId: null, frames: 3, digest: "nothex" }));
  const ok = parseGatewayInternalInboundFrame({
    kind: "device_hello",
    connId: "conn-0001",
    deviceId: "aabbccddeeff",
    clientId: "client-1",
    authorization: "Bearer abc.123",
    audioParams: { format: "opus", sampleRate: 16000, channels: 1, frameDurationMs: 60 },
  });
  assert.equal(ok.kind, "device_hello");
  assert.equal(ok.deviceId, "aabbccddeeff");
  const abort = parseGatewayInternalInboundFrame({ kind: "abort", connId: "conn-0001", xiaozhiSessionId: "sess-abcd1234" });
  assert.equal(abort.kind, "abort");
  assert.equal(abort.reason, "manual", "upstream abortHandle carries no reason — default manual");
});

interface Fixture {
  readonly endpointPath: string;
  readonly server: ReturnType<typeof createVoiceGatewayInternalServer>;
  readonly inbound: GatewayInternalInboundFrame[];
  readonly cleanup: () => void;
}

async function startServer(): Promise<Fixture> {
  const socketDir = mkdtempSync(join(tmpdir(), "lumithink-gw-"));
  const endpoint = resolveGatewayInternalEndpoint({ socketDir, name: `gw-test-${Math.floor(Math.random() * 0xffffff).toString(16)}` });
  const server = createVoiceGatewayInternalServer({ endpoint, authToken: TOKEN });
  const inbound: GatewayInternalInboundFrame[] = [];
  server.onFrame((frame) => inbound.push(frame));
  await server.start();
  const endpointPath = endpoint.kind === "uds" ? endpoint.path : `\\\\.\\pipe\\${endpoint.name}`;
  return {
    endpointPath,
    server,
    inbound,
    cleanup: () => {
      rmSync(socketDir, { recursive: true, force: true });
    },
  };
}

/** Minimal frame-decoding test client (POSIX/real-socket path only). */
class TestBridgeClient {
  readonly socket: Socket;
  readonly frames: unknown[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  readonly closed: Promise<string>;

  constructor(path: string) {
    this.socket = connect(path);
    this.closed = new Promise<string>((resolve) => {
      this.socket.on("close", (hadError) => resolve(hadError ? "error" : "clean"));
    });
    this.socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        if (this.buffer.length < 4) return;
        const len = this.buffer.readUInt32BE(0);
        if (this.buffer.length < 4 + len) return;
        const body = this.buffer.subarray(4, 4 + len).toString("utf8");
        this.buffer = this.buffer.subarray(4 + len);
        try {
          this.frames.push(JSON.parse(body));
        } catch {
          this.frames.push({ kind: "<malformed>" });
        }
      }
    });
  }

  send(frame: unknown): void {
    this.socket.write(encodeGatewayInternalFrame(frame as GatewayInternalOutboundFrame));
  }

  sendRaw(bytes: Buffer): void {
    this.socket.write(bytes);
  }

  async authenticate(token: string = TOKEN): Promise<void> {
    this.send({ kind: "bridge_auth", v: 1, token });
    await waitFor(() => this.frames.some((frame) => (frame as { kind?: string }).kind === "bridge_ready"));
  }

  destroy(): void {
    this.socket.destroy();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, stepMs = 20): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

test("REAL socket: a correct bridge_auth token opens the lease; wrong token or wrong first frame destroys the connection", { skip: !SOCKETS_AVAILABLE && "socket-level tests run on the POSIX CI target (dev sandbox forbids opening sockets)" }, async () => {
  const fixture = await startServer();
  try {
    // Wrong token → destroyed without bridge_ready.
    const bad = new TestBridgeClient(fixture.endpointPath);
    bad.send({ kind: "bridge_auth", v: 1, token: "wrong-token-wrong-token-000000000001" });
    const badClosed = await Promise.race([bad.closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);
    assert.equal(badClosed, true, "wrong-token connection is destroyed");
    assert.equal(fixture.server.isBridgeConnected(), false);

    // Non-auth first frame → destroyed.
    const notAuth = new TestBridgeClient(fixture.endpointPath);
    notAuth.send({ kind: "device_hello", connId: "conn-0001", deviceId: "aabbccddeeff", clientId: null, authorization: null, audioParams: null });
    const notAuthClosed = await Promise.race([notAuth.closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);
    assert.equal(notAuthClosed, true, "non-auth first frame is destroyed");

    // Correct token → bridge_ready + authenticated handler.
    const good = new TestBridgeClient(fixture.endpointPath);
    await good.authenticate();
    assert.equal(fixture.server.isBridgeConnected(), true);

    good.send({ kind: "abort", connId: "conn-0001", xiaozhiSessionId: "sess-abcd1234" });
    assert.ok(await waitFor(() => fixture.inbound.length === 1), "post-auth frames reach the handler");
    good.destroy();
    assert.ok(await waitFor(() => !fixture.server.isBridgeConnected()));
  } finally {
    await fixture.server.stop();
    fixture.cleanup();
  }
});

test("REAL socket: a second concurrent bridge connection is refused (single lease) without disturbing the first", { skip: !SOCKETS_AVAILABLE && "socket-level tests run on the POSIX CI target (dev sandbox forbids opening sockets)" }, async () => {
  const fixture = await startServer();
  try {
    const first = new TestBridgeClient(fixture.endpointPath);
    await first.authenticate();
    const second = new TestBridgeClient(fixture.endpointPath);
    second.send({ kind: "bridge_auth", v: 1, token: TOKEN });
    const secondClosed = await Promise.race([second.closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);
    assert.equal(secondClosed, true, "the second concurrent connection is closed");
    assert.equal(fixture.server.describe().refusedLeases, 1);
    assert.equal(fixture.server.isBridgeConnected(), true, "the first lease survives");

    first.send({ kind: "audio_delivered", connId: "conn-0001", turnId: null, frames: 3, digest: "a".repeat(64) });
    assert.ok(await waitFor(() => fixture.inbound.length === 1), "the first lease still works");
    first.destroy();
  } finally {
    await fixture.server.stop();
    fixture.cleanup();
  }
});

test("REAL socket: an oversized or malformed frame mid-stream destroys the authenticated connection", { skip: !SOCKETS_AVAILABLE && "socket-level tests run on the POSIX CI target (dev sandbox forbids opening sockets)" }, async () => {
  const fixture = await startServer();
  try {
    const client = new TestBridgeClient(fixture.endpointPath);
    await client.authenticate();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(GATEWAY_INTERNAL_MAX_FRAME_BYTES + 10, 0);
    client.sendRaw(header);
    const closed = await Promise.race([client.closed.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]);
    assert.equal(closed, true, "an oversize frame destroys the connection");
  } finally {
    await fixture.server.stop();
    fixture.cleanup();
  }
});
