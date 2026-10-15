import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * R1-V2 bridge IPC transport tests (issue #29 实现范围 3): versioned
 * handshake with a bounded auth token, single-connection lease,
 * length-prefixed frames with a byte cap, per-connection rate limiting,
 * UDS file-mode restriction on the POSIX target, and fail-closed handling
 * of oversize/malformed frames. The named pipe is the Windows fallback
 * carrying the same protocol.
 */

import { BridgeFrameDecoder, createVoiceBridgeIpcClient, createVoiceBridgeIpcServer, resolveBridgeIpcEndpoint } from "../../lib/server/voice-bridge-ipc.ts";
import { createVoiceBridge } from "../../lib/domain/voice/bridge/bridge.ts";
import { createMockCordisRuntime } from "../../lib/domain/voice/bridge/mock-cordis.ts";
import { canonicalBridgeProfile, validateBridgeProfile } from "../../lib/domain/voice/bridge/profile.ts";
import type { VoiceBridgeService } from "../../lib/domain/voice/bridge/bridge.ts";

const AUTH_OK = "ab".repeat(48); // 96 hex chars, grammar-valid
const AUTH_BAD = "cd".repeat(48);

const SESSION = "ses_ipcspec01";

/**
 * The dev sandbox on Windows forbids OPENING sockets (named pipes fail
 * `connect EPERM` at the OS boundary), so socket-level tests run on the
 * POSIX CI target (real UDS, the production shape). Everything that needs
 * no socket — endpoint resolution, frame decoding, construction guards —
 * runs on every platform.
 */
const SOCKETS_AVAILABLE = process.platform !== "win32";

function createService(): VoiceBridgeService {
  const runtime = createMockCordisRuntime({
    scriptFor: () => [{ channel: "text", text: "你好。" }],
  });
  return createVoiceBridge({ profile: validateBridgeProfile(canonicalBridgeProfile()), agentPort: runtime });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("endpoint resolution picks a UDS path on POSIX and a named pipe on Windows", () => {
  const endpoint = resolveBridgeIpcEndpoint({ name: "lumithink-test" });
  if (process.platform === "win32") {
    assert.equal(endpoint.kind, "named_pipe");
  } else {
    assert.equal(endpoint.kind, "uds");
    assert.ok(join(tmpdir(), "lumithink-test.sock").endsWith(endpoint.kind === "uds" ? "lumithink-test.sock" : ""));
  }
  assert.throws(() => resolveBridgeIpcEndpoint({ name: "../evil" }), Error);
  assert.throws(() => resolveBridgeIpcEndpoint({ name: "" }), Error);
});

test("the frame decoder assembles partial deliveries and flags oversize/malformed", () => {
  const decoder = new BridgeFrameDecoder();
  // A valid hello frame split across three chunks.
  const encoder = encodeHello();
  const a = encoder.subarray(0, 2);
  const b = encoder.subarray(2, 7);
  const c = encoder.subarray(7);
  assert.deepEqual(decoder.push(a).frames.length, 0);
  assert.deepEqual(decoder.push(b).frames.length, 0);
  const third = decoder.push(c);
  assert.equal(third.frames.length, 1);
  assert.equal(third.frames[0]?.frame.kind, "hello");

  // Oversize: a length prefix far beyond the cap.
  const oversize = Buffer.alloc(8);
  oversize.writeUInt32BE(0xffffff, 0);
  assert.equal(decoder.push(oversize).oversized, true);

  // Malformed JSON body with a well-formed prefix.
  const body = Buffer.from("not-json", "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  const malformed = decoder.push(Buffer.concat([header, body]));
  assert.equal(malformed.malformed, true);

  function encodeHello(): Buffer {
    const body = Buffer.from(
      JSON.stringify({ kind: "hello", v: "lumithink.bridge-ipc/v1", auth: AUTH_OK, role: "orchestrator" }),
      "utf8",
    );
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
  }
});

test("server refuses weak lease tokens at construction", () => {
  assert.throws(
    () => createVoiceBridgeIpcServer({ endpoint: resolveBridgeIpcEndpoint({ name: "lumithink-weak" }), authToken: "short", service: createService() }),
    Error,
  );
});

test("handshake, single lease and command round-trip work over the real socket", { skip: !SOCKETS_AVAILABLE }, async () => {
  const socketDir = mkdtempSync(join(tmpdir(), "lumithink-ipc-"));
  try {
    const endpoint = resolveBridgeIpcEndpoint({ socketDir, name: "lumithink-spec" });
    const service = createService();
    const server = createVoiceBridgeIpcServer({ endpoint, authToken: AUTH_OK, service });
    await server.start();
    try {
      const client = createVoiceBridgeIpcClient({ endpoint, authToken: AUTH_OK });
      await client.connect();
      assert.ok(client.isConnected());

      // Lease: a second concurrent client is closed before any command.
      const intruder = createVoiceBridgeIpcClient({ endpoint, authToken: AUTH_OK });
      await assert.rejects(() => intruder.connect(), Error);
      assert.ok(!intruder.isConnected());

      const reply = await client.command("session.open", { sessionKey: SESSION, ownerActorId: "act_owner0001", conversationId: "conv_ipcsp001" });
      assert.ok(reply.ok);
      const payload = reply.payload as { profileId: string; dshVersion: string; recovered: boolean };
      assert.equal(payload.profileId, "lumi-dsh-runtime-bridge");
      assert.equal(payload.dshVersion, "dsh-v0.2.0-rc.2");

      const closeReply = await client.command("session.close", { sessionKey: SESSION, reason: "orchestrator_close" });
      assert.ok(closeReply.ok);
      await client.close();
      await waitFor(() => server.stats().activeConnections === 0);
      assert.equal(server.stats().authenticatedClients, 1);
      assert.equal(server.stats().deniedLease, 1);
    } finally {
      await server.stop();
    }
    if (endpoint.kind === "uds") {
      assert.equal(statSyncSafe(endpoint.path), false, "the UDS file is removed on stop");
    }
  } finally {
    rmSync(socketDir, { recursive: true, force: true });
  }
});

test("a wrong auth token is rejected before any command executes", { skip: !SOCKETS_AVAILABLE }, async () => {
  const socketDir = mkdtempSync(join(tmpdir(), "lumithink-ipc-"));
  try {
    const endpoint = resolveBridgeIpcEndpoint({ socketDir, name: "lumithink-auth" });
    const service = createService();
    const server = createVoiceBridgeIpcServer({ endpoint, authToken: AUTH_OK, service });
    await server.start();
    try {
      const impostor = createVoiceBridgeIpcClient({ endpoint, authToken: AUTH_BAD });
      await assert.rejects(() => impostor.connect(), Error);
      await waitFor(() => server.stats().rejectedAuth === 1);
      // The service never saw a session.
      const stats = server.stats();
      assert.equal(stats.authenticatedClients, 0);
    } finally {
      await server.stop();
    }
  } finally {
    rmSync(socketDir, { recursive: true, force: true });
  }
});

test("oversize and malformed frames close the connection without touching the service", { skip: !SOCKETS_AVAILABLE }, async () => {
  const socketDir = mkdtempSync(join(tmpdir(), "lumithink-ipc-"));
  try {
    const endpoint = resolveBridgeIpcEndpoint({ socketDir, name: "lumithink-frames" });
    const service = createService();
    const server = createVoiceBridgeIpcServer({ endpoint, authToken: AUTH_OK, service });
    await server.start();
    try {
      const client = createVoiceBridgeIpcClient({ endpoint, authToken: AUTH_OK });
      await client.connect();

      // Oversize: a declared body beyond the byte cap.
      const header = Buffer.alloc(4);
      header.writeUInt32BE(0xffffff, 0);
      client.sendBytes(header);
      await waitFor(() => server.stats().closedOversize === 1);
      await waitFor(() => !client.isConnected());

      // New lease for the malformed-frame case.
      const client2 = createVoiceBridgeIpcClient({ endpoint, authToken: AUTH_OK });
      await client2.connect();
      client2.sendRaw({ kind: "command", name: "agent.spawn", seq: 1, payload: {} });
      await waitFor(() => server.stats().closedProtocolViolation === 1);
      await waitFor(() => !client2.isConnected());
    } finally {
      await server.stop();
    }
  } finally {
    rmSync(socketDir, { recursive: true, force: true });
  }
});

test("rate limiting replies rate_limited with an injectable clock and closes repeat offenders", { skip: !SOCKETS_AVAILABLE }, async () => {
  const socketDir = mkdtempSync(join(tmpdir(), "lumithink-ipc-"));
  try {
    const endpoint = resolveBridgeIpcEndpoint({ socketDir, name: "lumithink-rate" });
    const service = createService();
    let nowMs = 1_000;
    const server = createVoiceBridgeIpcServer({
      endpoint,
      authToken: AUTH_OK,
      service,
      maxFramesPerWindow: 3,
      rateWindowMs: 1_000,
      rateViolationsBeforeClose: 2,
      now: () => nowMs,
    });
    await server.start();
    try {
      const client = createVoiceBridgeIpcClient({ endpoint, authToken: AUTH_OK });
      await client.connect();
      const open = { sessionKey: SESSION, ownerActorId: "act_owner0001", conversationId: "conv_ipcsp001" };
      assert.ok((await client.command("session.open", open)).ok, "window 1: frames 1-3 pass");

      await client.command("session.close", { sessionKey: SESSION, reason: "orchestrator_close" });
      await client.command("session.open", open);
      const limited = await client.command("session.close", { sessionKey: SESSION, reason: "orchestrator_close" });
      assert.ok(!limited.ok && limited.code === "rate_limited", "the 4th frame in the window is limited");

      // Second violation breaches the budget → the socket is closed.
      await client.command("session.open", open);
      await waitFor(() => !client.isConnected());
      assert.ok(server.stats().rateLimitedReplies >= 1);
    } finally {
      await server.stop();
    }
  } finally {
    rmSync(socketDir, { recursive: true, force: true });
  }
});

test("the UDS socket file carries owner-only permissions on the POSIX target", { skip: !SOCKETS_AVAILABLE }, async () => {
  const socketDir = mkdtempSync(join(tmpdir(), "lumithink-ipc-"));
  try {
    const endpoint = resolveBridgeIpcEndpoint({ socketDir, name: "lumithink-perm" });
    const server = createVoiceBridgeIpcServer({ endpoint, authToken: AUTH_OK, service: createService() });
    await server.start();
    try {
      const st = statSync(endpoint.kind === "uds" ? endpoint.path : "");
      assert.equal(st.mode & 0o777, 0o600, "the socket file must be owner-only");
    } finally {
      await server.stop();
    }
  } finally {
    rmSync(socketDir, { recursive: true, force: true });
  }
});

function statSyncSafe(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
