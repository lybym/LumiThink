import assert from "node:assert/strict";
import test from "node:test";
import { connect, type Socket } from "node:net";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * E2E-07 (issue #57) — Voice Gateway ↔ xiaozhi server WIRING integration
 * tests. On the POSIX CI target the protected internal transport is driven
 * as a REAL socket (UDS); on the Windows dev sandbox (sockets cannot be
 * OPENED — the documented EPERM boundary, shared with
 * voice-bridge-ipc.spec.ts) the same routing is driven through the
 * server-side frame entry point, with the byte-level transport covered by
 * voice-gateway-internal-transport.spec.ts + the POSIX CI run. The Bridge
 * stack runs its REAL local-socket IPC on POSIX (in-process protocol
 * fallback on Windows, the documented dev-sandbox mode).
 *
 * Coverage maps to the issue DoD:
 *   - authorized hello → turn → Output-Gate sentences → tts_end (the
 *     protocol-simulated full loop, minus the pinned server itself);
 *   - unauthorized device / unknown device / duplicate connection /
 *     forged session;
 *   - server restart (bridge reconnect → leases closed → session continues);
 *   - abort fence (epoch bump; no sentence crosses after the abort);
 *   - real audio accounting (audio_delivered → content-free metrics/audit);
 *   - empty-output settlement still ends the bridge stream;
 *   - zero-leak scan: the transcript never appears in any frame, the
 *     response sentences appear ONLY inside authorized tts_sentence frames.
 */

import { createWiredVoiceGateway, verifyDeviceAuthorization, type WiredVoiceGateway } from "../../lib/server/voice-gateway-wiring.ts";
import type { GatewayInternalInboundFrame, GatewayInternalOutboundFrame } from "../../lib/server/voice-gateway-internal-transport.ts";
import type { MockGenerationScript } from "../../lib/domain/voice/bridge/mock-cordis.ts";
import type {
  BridgeAgentHandle,
  BridgeAgentPort,
  BridgeDurableEvent,
  BridgeStreamEvent,
} from "../../lib/domain/voice/bridge/agent-port.ts";

const SOCKETS_AVAILABLE = process.platform !== "win32";

const DEVICE_ID = "aabbccddeeff";
const ACTOR = "act_parent0001";
const CONVERSATION = "conv_child0001";
const ACTIVATION_DIGEST = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const AUTH_KEY = "deployment-auth-key-0123456789abcdef";
const TRANSPORT_TOKEN = "internal-transport-token-0123456789";
const SESSION_ID = "sess-abcd1234";

const BRIDGE_TRANSPORT = process.platform === "win32" ? ("in_process" as const) : ("ipc" as const);

function scriptFor(_sessionKey: string, _turnId: string): MockGenerationScript {
  return [
    { channel: "text", text: "我们一起看看这道题。" },
    { channel: "text", text: "先找已知条件。" },
  ];
}

function mintDeviceToken(authKey: string, clientId: string | null, deviceId: string, tsSeconds: number): string {
  const content = `${clientId ?? "None"}|${deviceId}|${tsSeconds}`;
  const sig = createHmac("sha256", authKey).update(content, "utf8").digest("base64url").replace(/=+$/, "");
  return `Bearer ${sig}.${tsSeconds}`;
}

interface Fixture {
  readonly wired: WiredVoiceGateway;
  readonly outFrames: { readonly kind: string; readonly frame: Record<string, unknown> }[];
  readonly cleanup: () => void;
}

async function createWired(
  script?: (sessionKey: string, turnId: string) => MockGenerationScript,
  inject?: {
    readonly agentPort: BridgeAgentPort;
    readonly onAgentFault?: (listener: (info: { readonly sessionKey: string; readonly code: "worker_crashed" }) => void) => void;
  },
): Promise<Fixture> {
  const socketDir = mkdtempSync(join(tmpdir(), "lumithink-wiring-"));
  const outFrames: { kind: string; frame: Record<string, unknown> }[] = [];
  let turnSeq = 0;
  const wired = createWiredVoiceGateway({
    bindings: [
      { deviceId: DEVICE_ID, actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION_DIGEST },
    ],
    deviceAuthKey: AUTH_KEY,
    transportAuthToken: TRANSPORT_TOKEN,
    socketDir,
    endpointName: `wiring-${Math.floor(Math.random() * 0xffffff).toString(16)}`,
    scriptFor: script ?? scriptFor,
    ...(inject !== undefined ? { agentPort: inject.agentPort } : {}),
    ...(inject?.onAgentFault !== undefined ? { onAgentFault: inject.onAgentFault } : {}),
    transport: BRIDGE_TRANSPORT,
    turnIdFactory: () => {
      turnSeq += 1;
      return `trn_wiring${turnSeq.toString().padStart(7, "0")}`;
    },
    onBridgeFrame: (frame) => {
      outFrames.push({ kind: frame.kind, frame: frame as unknown as Record<string, unknown> });
    },
  });
  await wired.start();
  return {
    wired,
    outFrames,
    cleanup: () => {
      rmSync(socketDir, { recursive: true, force: true });
    },
  };
}

/** Bridge-side driver: REAL socket where available, frame injection otherwise. */
interface BridgeDriver {
  send(frame: GatewayInternalInboundFrame): Promise<void>;
  destroy(): Promise<void>;
}

async function connectBridge(fixture: Fixture): Promise<BridgeDriver> {
  if (SOCKETS_AVAILABLE) {
    const endpoint = fixture.wired.endpoint;
    const path = endpoint.kind === "uds" ? endpoint.path : `\\\\.\\pipe\\${endpoint.name}`;
    // The single-bridge lease refuses a second concurrent connection: a
    // reconnect must wait until the transport observed the previous close
    // (the server-side close handler is asynchronous), otherwise the new
    // connection is refused and no bridge_ready ever arrives.
    assert.ok(
      await waitFor(() => !fixture.wired.transport.isBridgeConnected(), 5_000),
      "the previous bridge connection must be closed before reconnecting",
    );
    const socket = connect(path);
    // Write faults (EPIPE when the server destroys a refused connection)
    // are never assertion signals — close is.
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    socket.on("data", () => undefined); // outbound frames are asserted via the tap
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", resolve);
    });
    socket.write(frameBytes({ kind: "bridge_auth", v: 1, token: TRANSPORT_TOKEN }));
    return {
      async send(frame) {
        socket.write(frameBytes(frame));
      },
      async destroy() {
        socket.destroy();
      },
    };
  }
  // Dev-sandbox fallback: the same server-side routing entry point (the
  // byte-level transport has its own suites + the POSIX CI run). The
  // bridge lifecycle (fresh server instance) is announced explicitly, as
  // the real transport would on connect/close.
  fixture.wired.notifyBridgeLifecycleForTest("authenticated");
  return {
    async send(frame) {
      await fixture.wired.handleBridgeFrameForTest(frame);
    },
    async destroy() {
      fixture.wired.notifyBridgeLifecycleForTest("closed");
      await Promise.resolve();
    },
  };
}

function frameBytes(frame: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(frame), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return predicate();
}

/** Authenticate a device end-to-end: hello + session_issued, asserting ok. */
async function helloDevice(driver: BridgeDriver, fixture: Fixture, refs: {
  readonly connId: string;
  readonly deviceId: string;
  readonly authorization?: string | null;
}): Promise<void> {
  await driver.send({
    kind: "device_hello",
    connId: refs.connId,
    deviceId: refs.deviceId,
    // The test signs the token over the normalized id, so no separate
    // wire value is needed (production: the raw MAC header).
    deviceIdWire: null,
    clientId: "client-probe",
    authorization: refs.authorization === undefined ? mintDeviceToken(AUTH_KEY, "client-probe", refs.deviceId, Math.floor(Date.now() / 1000)) : refs.authorization,
    audioParams: { format: "opus", sampleRate: 16000, channels: 1, frameDurationMs: 60 },
  });
  assert.ok(
    await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "device_hello_result" && entry.frame.connId === refs.connId)),
    `hello result for ${refs.connId} arrived`,
  );
}

test("the upstream AuthManager token scheme is verified verbatim (fresh, signed, MAC alone is worthless)", () => {
  const ts = Math.floor(Date.now() / 1000);
  assert.ok(verifyDeviceAuthorization({ authorization: mintDeviceToken(AUTH_KEY, "c1", DEVICE_ID, ts), deviceId: DEVICE_ID, clientId: "c1", authKey: AUTH_KEY, expireSeconds: 604_800 }).ok);
  // A MAC without a signed token never maps.
  assert.equal(verifyDeviceAuthorization({ authorization: null, deviceId: DEVICE_ID, clientId: "c1", authKey: AUTH_KEY, expireSeconds: 604_800 }).ok, false);
  // Wrong key / wrong client binding / expired.
  assert.equal(verifyDeviceAuthorization({ authorization: mintDeviceToken("another-key-0123456789abcdef", "c1", DEVICE_ID, ts), deviceId: DEVICE_ID, clientId: "c1", authKey: AUTH_KEY, expireSeconds: 604_800 }).ok, false);
  assert.equal(verifyDeviceAuthorization({ authorization: mintDeviceToken(AUTH_KEY, "c2", DEVICE_ID, ts), deviceId: DEVICE_ID, clientId: "c1", authKey: AUTH_KEY, expireSeconds: 604_800 }).ok, false);
  assert.equal(verifyDeviceAuthorization({ authorization: mintDeviceToken(AUTH_KEY, "c1", DEVICE_ID, ts - 604_801), deviceId: DEVICE_ID, clientId: "c1", authKey: AUTH_KEY, expireSeconds: 604_800 }).ok, false);
});

test("authorized device: hello → turn → fence-stamped sentences → tts_end (full wired loop)", async () => {
  const fixture = await createWired();
  try {
    const driver = await connectBridge(fixture);
    await helloDevice(driver, fixture, { connId: "conn-0001", deviceId: DEVICE_ID });
    const helloResult = fixture.outFrames.find((entry) => entry.frame.kind === "device_hello_result")?.frame;
    assert.equal(helloResult?.ok, true);

    await driver.send({ kind: "session_issued", connId: "conn-0001", xiaozhiSessionId: SESSION_ID });
    await driver.send({ kind: "turn_prompt", connId: "conn-0001", xiaozhiSessionId: SESSION_ID, text: "我们来玩个游戏好不好" });

    assert.ok(await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "turn_started")), "the turn was minted");
    const sessionKey = fixture.wired.stack.findSessionKeyByDevice(DEVICE_ID);
    assert.ok(sessionKey);
    fixture.wired.stack.stack.pumpRuntime(sessionKey as string, 20);

    assert.ok(await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "tts_end")), "the turn ended");
    const sentences = fixture.outFrames.filter((entry) => entry.frame.kind === "tts_sentence");
    assert.ok(sentences.length >= 2, `both Output-Gate sentences were delivered (${sentences.length})`);
    const texts = sentences.map((entry) => entry.frame.text);
    assert.ok(texts.includes("我们一起看看这道题。"), "the admitted sentence text reached the bridge");
    assert.ok(
      sentences.every((entry) => typeof entry.frame.turnId === "string" && typeof entry.frame.itemId === "string" && typeof entry.frame.epoch === "number"),
      "every sentence frame is fence-keyed (turnId/itemId/epoch)",
    );
    const ended = fixture.outFrames.find((entry) => entry.frame.kind === "tts_end")?.frame;
    assert.equal(ended?.reason, "completed");

    // Zero-leak: the transcript never crosses ANY frame; the response
    // sentences appear ONLY inside tts_sentence frames; the Adapter audit
    // ring carries no response text either.
    const allFrameJson = JSON.stringify(fixture.outFrames);
    assert.ok(!allFrameJson.includes("我们来玩个游戏好不好"), "the transcript never crosses the transport");
    const auditJson = JSON.stringify(fixture.wired.stack.adapter.auditSnapshot());
    assert.ok(!auditJson.includes("我们一起看看这道题。"), "the audit ring is content-free");
    assert.ok(!auditJson.includes("我们来玩个游戏好不好"), "no transcript residue in the audit ring");
    for (const entry of fixture.outFrames) {
      const frameJson = JSON.stringify(entry.frame);
      if (frameJson.includes("我们一起看看这道题。")) {
        assert.equal(entry.kind, "tts_sentence", "response text appears only in authorized tts_sentence frames");
      }
    }
    await driver.destroy();
  } finally {
    await fixture.wired.stop();
    fixture.cleanup();
  }
});

test("an injected agentPort takes the Bridge's upstream seat (the wiring never silently serves the synthetic runtime)", async () => {
  // E2E-08 (issue #58) — regression for the #57 review P1-1 clearance: the
  // stack composition used to DROP a spread-in `agentPort` (TypeScript's
  // excess-property checks do not apply to spreads), so a `real` host would
  // have silently answered with the SYNTHETIC runtime. The stub records the
  // createAgent calls and drives the Bridge contract directly: if the
  // injection path ever regresses, this test fails (synthetic texts, zero
  // createAgent calls) instead of a fake "real" CI pass.
  const created: string[] = [];
  const prompts: { readonly turnId: string; readonly promptText?: string }[] = [];
  let attemptSeq = 0;
  const port: BridgeAgentPort = {
    createAgent(sessionKey) {
      created.push(sessionKey);
      const streamListeners: ((event: BridgeStreamEvent) => void)[] = [];
      const durableListeners: ((event: BridgeDurableEvent) => void)[] = [];
      const handle: BridgeAgentHandle = {
        sessionKey,
        runPrompt(input) {
          prompts.push({ turnId: input.turnId, ...(input.promptText !== undefined ? { promptText: input.promptText } : {}) });
          attemptSeq += 1;
          const attemptId = `att_stub_${attemptSeq.toString().padStart(4, "0")}`;
          const stepId = "step_0001";
          // Real-port timing: a worker's first stream frame crosses a process
          // boundary and lands AFTER the composition's dispatch chain
          // (turn.prompt → turn.stream subscription) completed. A synchronous
          // microtask emission would settle the attempt BEFORE the stream
          // subscription command — chunks dropped, dispatch judged failed —
          // a stub artifact, not wiring behavior.
          setTimeout(() => {
            for (const listener of [...streamListeners]) {
              listener({ kind: "start", attemptId, stepId });
              listener({ kind: "chunk", attemptId, stepId, index: 0, channel: "text", textDelta: "这是注入端口的第一句。" });
              listener({ kind: "chunk", attemptId, stepId, index: 1, channel: "text", textDelta: "这是注入端口的第二句。" });
              listener({ kind: "end", attemptId, stepId });
            }
            for (const listener of [...durableListeners]) {
              listener({ event: "assistant/message", attemptId, messageId: `msg_stub_${attemptSeq}`, messageRef: "stub-ref" });
            }
          }, 5);
          return { ok: true, attemptId };
        },
        cancel() {
          return { ok: false, code: "no_running_attempt" };
        },
        async whenIdle() {
          return { ok: true, attemptId: null };
        },
        async dispose() {
          return { ok: true };
        },
        onStream(listener) {
          streamListeners.push(listener);
          return { ok: true };
        },
        onDurable(listener) {
          durableListeners.push(listener);
          return { ok: true };
        },
        isRunning() {
          return false;
        },
      };
      return { ok: true, handle };
    },
    resumeAgent(sessionKey) {
      return port.createAgent(sessionKey);
    },
  };
  let agentFaultListener: ((info: { readonly sessionKey: string; readonly code: "worker_crashed" }) => void) | null = null;
  const fixture = await createWired(scriptFor, {
    agentPort: port,
    onAgentFault: (listener) => {
      agentFaultListener = listener;
    },
  });
  try {
    const stackEvents: { readonly name: string; readonly payload: Record<string, unknown> }[] = [];
    fixture.wired.stack.stack.client.onEvent((frame) => {
      if (frame.kind === "event") {
        stackEvents.push({ name: frame.name, payload: (frame.payload ?? {}) as Record<string, unknown> });
      }
    });
    const driver = await connectBridge(fixture);
    await helloDevice(driver, fixture, { connId: "conn-inject-1", deviceId: DEVICE_ID });
    await driver.send({ kind: "session_issued", connId: "conn-inject-1", xiaozhiSessionId: SESSION_ID });
    await driver.send({ kind: "turn_prompt", connId: "conn-inject-1", xiaozhiSessionId: SESSION_ID, text: "我们来玩个游戏好不好" });

    assert.ok(await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "tts_end")), "the turn ended");
    // THE seat assertion: the Bridge created its agent through the INJECTED
    // port (exactly once, at the session open) and the delivered sentences
    // are the stub's — the synthetic scriptFor text must never appear.
    assert.equal(created.length, 1, "the Bridge created its agent through the injected port");
    const sentences = fixture.outFrames.filter((entry) => entry.frame.kind === "tts_sentence");
    assert.deepEqual(
      sentences.map((entry) => entry.frame.text),
      ["这是注入端口的第一句。", "这是注入端口的第二句。"],
      "the stub's sentences were served — the injected port holds the upstream seat",
    );
    assert.ok(
      !fixture.outFrames.some((entry) => entry.kind === "tts_sentence" && entry.frame.text === "我们一起看看这道题。"),
      "the synthetic runtime never served the turn",
    );
    // Issue #51 contract across the injection: the transient transcript
    // reached the agent exactly once, non-empty (no digest-only prompt).
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]?.promptText, "我们来玩个游戏好不好");
    assert.ok(prompts[0]?.turnId);
    // The injected port's fault channel reaches the Bridge quarantine.
    assert.ok(agentFaultListener !== null, "the fault listener was registered through the wiring");
    (agentFaultListener as (info: { readonly sessionKey: string; readonly code: "worker_crashed" }) => void)({
      sessionKey: created[0] as string,
      code: "worker_crashed",
    });
    assert.ok(
      await waitFor(() => stackEvents.some((event) => event.name === "runtime.error" && event.payload.code === "worker_crashed")),
      "the injected port's fault channel is wired to the Bridge quarantine",
    );
    await driver.destroy();
  } finally {
    await fixture.wired.stop();
    fixture.cleanup();
  }
});

test("unauthorized devices fail closed: bad token, unknown device, forged session", async () => {
  const fixture = await createWired();
  try {
    const driver = await connectBridge(fixture);

    // 1. A valid MAC with a garbage token: possession denied + dropped.
    await helloDevice(driver, fixture, { connId: "conn-bad", deviceId: DEVICE_ID, authorization: "Bearer deadbeef.123" });
    const badResult = fixture.outFrames.find((entry) => entry.frame.kind === "device_hello_result" && entry.frame.connId === "conn-bad")?.frame;
    assert.equal(badResult?.ok, false);
    assert.equal(badResult?.code, "device_possession_denied");
    assert.ok(fixture.outFrames.some((entry) => entry.frame.kind === "device_drop" && entry.frame.connId === "conn-bad"));

    // 2. A signed token for an UNBOUND device (never guardian-activated):
    // the Adapter rejects it even though the deployment token verifies.
    await helloDevice(driver, fixture, { connId: "conn-unbound", deviceId: "ccddeeff0011" });
    const unbound = fixture.outFrames.filter((entry) => entry.frame.kind === "device_drop" && entry.frame.connId === "conn-unbound");
    assert.ok(unbound.length >= 1, "the unbound device is dropped");
    assert.equal(unbound[0]?.frame.code, "device_unbound");

    // 3. Forged session on the authorized device: enumerated rejection, no
    // turn, the connection itself survives.
    await helloDevice(driver, fixture, { connId: "conn-0001", deviceId: DEVICE_ID });
    await driver.send({ kind: "session_issued", connId: "conn-0001", xiaozhiSessionId: SESSION_ID });
    await driver.send({ kind: "turn_prompt", connId: "conn-0001", xiaozhiSessionId: "sess-forged999", text: "我们来玩个游戏好不好" });
    assert.ok(
      await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "prompt_rejected" && entry.frame.code === "session_forged")),
      "the forged session is enumerated (session_forged)",
    );
    await driver.destroy();
  } finally {
    await fixture.wired.stop();
    fixture.cleanup();
  }
});

test("duplicate connection: the Adapter lease refuses the second connId and drops it, the first keeps working", async () => {
  const fixture = await createWired();
  try {
    const driver = await connectBridge(fixture);
    await helloDevice(driver, fixture, { connId: "conn-first", deviceId: DEVICE_ID });
    await driver.send({ kind: "session_issued", connId: "conn-first", xiaozhiSessionId: SESSION_ID });

    await helloDevice(driver, fixture, { connId: "conn-second", deviceId: DEVICE_ID });
    const conflict = fixture.outFrames.find((entry) => entry.frame.kind === "device_drop" && entry.frame.connId === "conn-second");
    assert.ok(conflict, "the duplicate connection is dropped");
    assert.equal(conflict?.frame.code, "device_connection_conflict");
    assert.equal(fixture.wired.adapterMetrics().duplicateConnectionsRefused, 1);

    // The original connection is unaffected: its prompt still mints a turn.
    await driver.send({ kind: "turn_prompt", connId: "conn-first", xiaozhiSessionId: SESSION_ID, text: "我们来玩个游戏好不好" });
    assert.ok(await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "turn_started")), "the first connection still works");
    const sessionKey = fixture.wired.stack.findSessionKeyByDevice(DEVICE_ID) as string;
    fixture.wired.stack.stack.pumpRuntime(sessionKey, 20);
    assert.ok(await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "tts_end")));
    await driver.destroy();
  } finally {
    await fixture.wired.stop();
    fixture.cleanup();
  }
});

test("abort fence: epoch bumps, no sentence crosses after the abort, late turn keeps working", async () => {
  const fixture = await createWired();
  try {
    const driver = await connectBridge(fixture);
    await helloDevice(driver, fixture, { connId: "conn-0001", deviceId: DEVICE_ID });
    await driver.send({ kind: "session_issued", connId: "conn-0001", xiaozhiSessionId: SESSION_ID });

    await driver.send({ kind: "turn_prompt", connId: "conn-0001", xiaozhiSessionId: SESSION_ID, text: "我们来玩个游戏好不好" });
    assert.ok(await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "turn_started")));
    const sessionKey = fixture.wired.stack.findSessionKeyByDevice(DEVICE_ID) as string;
    fixture.wired.stack.stack.pumpRuntime(sessionKey, 1);
    await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "tts_sentence"));

    const abortIndex = fixture.outFrames.length;
    const epochBeforeAbort = fixture.wired.stack.stack.orchestrator.currentEpoch(sessionKey) ?? 1;
    await driver.send({ kind: "abort", connId: "conn-0001", xiaozhiSessionId: SESSION_ID, reason: "vad_detected" });
    assert.ok(
      await waitFor(() => (fixture.wired.stack.stack.orchestrator.currentEpoch(sessionKey) ?? 0) > epochBeforeAbort),
      "the abort fenced (trusted epoch bump)",
    );
    fixture.wired.stack.stack.pumpRuntime(sessionKey, 20);
    await new Promise((resolve) => setTimeout(resolve, 200));

    // No tts_sentence may appear at or after the abort frame position.
    const after = fixture.outFrames.slice(abortIndex);
    assert.ok(
      !after.some((entry) => entry.frame.kind === "tts_sentence"),
      "no sentence crosses the transport after the abort (stale epoch structurally impossible)",
    );
    // A fresh prompt after the interruption works on the new epoch.
    await driver.send({ kind: "turn_prompt", connId: "conn-0001", xiaozhiSessionId: SESSION_ID, text: "那我们读书吧" });
    assert.ok(await waitFor(() => fixture.wired.adapterMetrics().asrFinalsAccepted === 2), "the late turn was accepted");
    fixture.wired.stack.stack.pumpRuntime(sessionKey, 20);
    assert.ok(await waitFor(() => fixture.outFrames.filter((entry) => entry.frame.kind === "tts_sentence" && entry.frame.text === "我们一起看看这道题。").length >= 1), "the late turn's sentence crosses");
    await driver.destroy();
  } finally {
    await fixture.wired.stop();
    fixture.cleanup();
  }
});

test("server restart: the bridge reconnect closes stale leases and the continued session still maps", async () => {
  const fixture = await createWired();
  try {
    let driver = await connectBridge(fixture);
    await helloDevice(driver, fixture, { connId: "conn-before", deviceId: DEVICE_ID });
    await driver.send({ kind: "session_issued", connId: "conn-before", xiaozhiSessionId: "sess-before01" });
    const sessionKeyBefore = fixture.wired.stack.findSessionKeyByDevice(DEVICE_ID) as string;
    assert.ok(sessionKeyBefore);
    await driver.destroy();

    // Server restart: the pinned server's bridge extension reconnects. With
    // the REAL transport the reconnect is a new socket (fresh auth); with
    // injection the routing entry point observes the same server_restart.
    driver = await connectBridge(fixture);
    await helloDevice(driver, fixture, { connId: "conn-after", deviceId: DEVICE_ID });
    await driver.send({ kind: "session_issued", connId: "conn-after", xiaozhiSessionId: "sess-after001" });
    const sessionKeyAfter = fixture.wired.stack.findSessionKeyByDevice(DEVICE_ID) as string;
    assert.equal(sessionKeyAfter, sessionKeyBefore, "the trusted session continues across the restart");

    // A full turn still works on the continued session.
    await driver.send({ kind: "turn_prompt", connId: "conn-after", xiaozhiSessionId: "sess-after001", text: "我们来玩个游戏好不好" });
    assert.ok(await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "turn_started")));
    fixture.wired.stack.stack.pumpRuntime(sessionKeyAfter, 20);
    assert.ok(await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "tts_end")));
    await driver.destroy();
  } finally {
    await fixture.wired.stop();
    fixture.cleanup();
  }
});

test("real audio accounting: audio_delivered frames become content-free metrics + audit entries", async () => {
  const fixture = await createWired();
  try {
    const driver = await connectBridge(fixture);
    await helloDevice(driver, fixture, { connId: "conn-0001", deviceId: DEVICE_ID });
    await driver.send({ kind: "session_issued", connId: "conn-0001", xiaozhiSessionId: SESSION_ID });
    const digest = createHmac("sha256", "unused").update("frame-bytes", "utf8").digest("hex");
    await driver.send({ kind: "audio_delivered", connId: "conn-0001", turnId: null, frames: 42, digest });
    assert.ok(await waitFor(() => fixture.wired.adapterMetrics().realAudioDeliveries === 1));
    assert.equal(fixture.wired.adapterMetrics().realAudioFramesDelivered, 42);
    const audit = fixture.wired.stack.adapter.auditSnapshot().filter((entry) => entry.action === "gateway.audio_delivered");
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.detail, digest, "the audit carries the content-free digest");
    assert.equal(audit[0]?.count, 42);
    await driver.destroy();
  } finally {
    await fixture.wired.stop();
    fixture.cleanup();
  }
});

test("a settled turn with zero delivered sentences still owes the bridge a tts_end (empty-output turn)", async () => {
  // The scripted response is entirely output-gate hostile (secrecy
  // pressure): every sentence is blocked at the gate, so ZERO sentences are
  // delivered, but the turn still settles and the bridge still learns the
  // end of the stream.
  const blockedScript = (): MockGenerationScript => [
    { channel: "text", text: "这是我们之间的小秘密，不要告诉妈妈。" },
  ];
  const fixture = await createWired(blockedScript);
  try {
    const driver = await connectBridge(fixture);
    await helloDevice(driver, fixture, { connId: "conn-0001", deviceId: DEVICE_ID });
    await driver.send({ kind: "session_issued", connId: "conn-0001", xiaozhiSessionId: SESSION_ID });
    await driver.send({ kind: "turn_prompt", connId: "conn-0001", xiaozhiSessionId: SESSION_ID, text: "我们来玩个游戏好不好" });
    assert.ok(
      await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "turn_started")),
      "the turn minted",
    );
    const sessionKey = fixture.wired.stack.findSessionKeyByDevice(DEVICE_ID) as string;
    fixture.wired.stack.stack.pumpRuntime(sessionKey, 20);
    assert.ok(await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "tts_end")), "a tts_end was still emitted");
    assert.ok(!fixture.outFrames.some((entry) => entry.frame.kind === "tts_sentence"), "zero sentences crossed (all gate-blocked)");
    await driver.destroy();
  } finally {
    await fixture.wired.stop();
    fixture.cleanup();
  }
});

test("a blocked prompt is an outcome, not a transport fault: prompt_rejected is enumerated", async () => {
  const fixture = await createWired();
  try {
    const driver = await connectBridge(fixture);
    await helloDevice(driver, fixture, { connId: "conn-0001", deviceId: DEVICE_ID });
    await driver.send({ kind: "session_issued", connId: "conn-0001", xiaozhiSessionId: SESSION_ID });
    // A prompt that trips the REAL Input Safety Gate (crisis cue →
    // escalate_crisis → enumerated input_gate_blocked).
    await driver.send({ kind: "turn_prompt", connId: "conn-0001", xiaozhiSessionId: SESSION_ID, text: "我不想活了" });
    assert.ok(
      await waitFor(() => fixture.outFrames.some((entry) => entry.frame.kind === "prompt_rejected" && entry.frame.code === "input_gate_blocked")),
      "the input gate's enumerated rejection reaches the bridge",
    );
    assert.equal(fixture.wired.adapterMetrics().inputGateBlocked, 1);
    // The device connection survives (no device_drop for prompt outcomes).
    assert.ok(!fixture.outFrames.some((entry) => entry.frame.kind === "device_drop" && entry.frame.connId === "conn-0001"));
    await driver.destroy();
  } finally {
    await fixture.wired.stop();
    fixture.cleanup();
  }
});
