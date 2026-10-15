import assert from "node:assert/strict";
import test from "node:test";

/**
 * R1-V3 gateway protocol contract tests (issue #30 实现范围 1/2; the pinned
 * v2.5.2 baseline and the fail-closed device-edge parsers).
 */

import {
  GATEWAY_ABORT_REASONS,
  GATEWAY_LISTEN_STATES,
  GATEWAY_MAX_ASR_FINAL_CHARS,
  GATEWAY_MAX_ASR_PARTIAL_CHARS,
  GATEWAY_REJECTION_CODES,
  XIAOZHI_DEVICE_ID_PATTERN,
  XIAOZHI_GATEWAY_BASELINE,
  XIAOZHI_SESSION_ID_PATTERN,
  parseGatewayDeviceEvent,
  type GatewayDeviceDirective,
} from "../../../../lib/domain/voice/adapter/protocol.ts";

test("the evaluation baseline is pinned and explicitly NOT device-verified", () => {
  assert.equal(XIAOZHI_GATEWAY_BASELINE.firmwareRepo, "78/xiaozhi-esp32");
  assert.equal(XIAOZHI_GATEWAY_BASELINE.firmwareTag, "v2.5.2");
  assert.equal(XIAOZHI_GATEWAY_BASELINE.wireProtocolVersion, 1);
  assert.equal(XIAOZHI_GATEWAY_BASELINE.uplinkAudio.format, "opus");
  assert.equal(XIAOZHI_GATEWAY_BASELINE.uplinkAudio.sampleRate, 16000);
  assert.equal(XIAOZHI_GATEWAY_BASELINE.uplinkAudio.frameDurationMs, 60);
  assert.equal(XIAOZHI_GATEWAY_BASELINE.serverRepo, "xinnan-tech/xiaozhi-esp32-server");
  // The server ref is a pinned commit (fixed contract, issue #30).
  assert.match(XIAOZHI_GATEWAY_BASELINE.serverRef, /^main@[0-9a-f]{40}$/);
  assert.equal(XIAOZHI_GATEWAY_BASELINE.deviceVerified, false, "compat/OTA stay 未实机验证");
});

test("device and session id grammars are bounded", () => {
  assert.ok(XIAOZHI_DEVICE_ID_PATTERN.test("aabbccddeeff0011"));
  assert.ok(!XIAOZHI_DEVICE_ID_PATTERN.test("NOT-A-MAC"));
  assert.ok(!XIAOZHI_DEVICE_ID_PATTERN.test("aabb"));
  assert.ok(XIAOZHI_SESSION_ID_PATTERN.test("sessmock-000001-0001"));
  assert.ok(XIAOZHI_SESSION_ID_PATTERN.test("3f9d2a10-8f4e-4c1b-9a2b-7c6d5e4f3a2b"));
  assert.ok(!XIAOZHI_SESSION_ID_PATTERN.test("short"));
});

test("hello events parse and validate audio params fail-closed", () => {
  const event = parseGatewayDeviceEvent({
    kind: "hello",
    deviceId: "aabbccddeeff0011",
    clientDigest: "0123456789abcdef0123456789abcdef",
    audioParams: { format: "opus", sampleRate: 16000, channels: 1, frameDurationMs: 60 },
  });
  assert.equal(event.kind, "hello");
  if (event.kind === "hello") {
    assert.equal(event.deviceId, "aabbccddeeff0011");
    assert.equal(event.audioParams?.sampleRate, 16000);
  }
  // Unknown field.
  assert.throws(() => parseGatewayDeviceEvent({ kind: "hello", deviceId: "aabbccddeeff0011", evil: "x" }));
  // Bad device id.
  assert.throws(() => parseGatewayDeviceEvent({ kind: "hello", deviceId: "zz" }));
  // Non-opus format.
  assert.throws(() =>
    parseGatewayDeviceEvent({
      kind: "hello",
      deviceId: "aabbccddeeff0011",
      audioParams: { format: "mp3", sampleRate: 16000, channels: 1, frameDurationMs: 60 },
    }),
  );
  // Out-of-range sample rate.
  assert.throws(() =>
    parseGatewayDeviceEvent({
      kind: "hello",
      deviceId: "aabbccddeeff0011",
      audioParams: { format: "opus", sampleRate: 7999, channels: 1, frameDurationMs: 60 },
    }),
  );
  // Non-object.
  assert.throws(() => parseGatewayDeviceEvent("hello"));
  assert.throws(() => parseGatewayDeviceEvent(null));
});

test("listen events validate state and mode", () => {
  for (const state of GATEWAY_LISTEN_STATES) {
    const event = parseGatewayDeviceEvent({
      kind: "listen",
      xiaozhiSessionId: "sessmock-000001-0001",
      state,
      mode: "auto",
    });
    assert.equal(event.kind, "listen");
  }
  assert.throws(() =>
    parseGatewayDeviceEvent({ kind: "listen", xiaozhiSessionId: "sessmock-000001-0001", state: "yell" }),
  );
  assert.throws(() =>
    parseGatewayDeviceEvent({ kind: "listen", xiaozhiSessionId: "sessmock-000001-0001", state: "start", mode: "shout" }),
  );
  assert.throws(() =>
    parseGatewayDeviceEvent({ kind: "listen", xiaozhiSessionId: "bad id", state: "start" }),
  );
});

test("ASR events are the ONLY text-bearing events and are length-capped", () => {
  const partial = parseGatewayDeviceEvent({
    kind: "asr_partial",
    xiaozhiSessionId: "sessmock-000001-0001",
    text: "先找已知",
  });
  assert.equal(partial.kind, "asr_partial");
  const final = parseGatewayDeviceEvent({
    kind: "asr_final",
    xiaozhiSessionId: "sessmock-000001-0001",
    text: "先找已知条件。",
  });
  assert.equal(final.kind, "asr_final");
  assert.throws(() =>
    parseGatewayDeviceEvent({
      kind: "asr_partial",
      xiaozhiSessionId: "sessmock-000001-0001",
      text: "a".repeat(GATEWAY_MAX_ASR_PARTIAL_CHARS + 1),
    }),
  );
  assert.throws(() =>
    parseGatewayDeviceEvent({
      kind: "asr_final",
      xiaozhiSessionId: "sessmock-000001-0001",
      text: "a".repeat(GATEWAY_MAX_ASR_FINAL_CHARS + 1),
    }),
  );
  assert.throws(() =>
    parseGatewayDeviceEvent({ kind: "asr_final", xiaozhiSessionId: "sessmock-000001-0001", text: "" }),
  );
});

test("abort events accept only registered reasons (client_abort wire name is `abort`)", () => {
  for (const reason of GATEWAY_ABORT_REASONS) {
    const event = parseGatewayDeviceEvent({
      kind: "abort",
      xiaozhiSessionId: "sessmock-000001-0001",
      reason,
    });
    assert.equal(event.kind, "abort");
  }
  assert.throws(() =>
    parseGatewayDeviceEvent({ kind: "abort", xiaozhiSessionId: "sessmock-000001-0001", reason: "because" }),
  );
});

test("transport fault events parse and reject unknown kinds and fields", () => {
  assert.equal(parseGatewayDeviceEvent({ kind: "server_restart" }).kind, "server_restart");
  assert.equal(
    parseGatewayDeviceEvent({ kind: "connection_dropped", reason: "network" }).kind,
    "connection_dropped",
  );
  assert.throws(() => parseGatewayDeviceEvent({ kind: "connection_dropped", reason: "aliens" }));
  assert.throws(() => parseGatewayDeviceEvent({ kind: "explode" }));
  assert.throws(() => parseGatewayDeviceEvent({ kind: "server_restart", extra: 1 }));
  assert.throws(() => parseGatewayDeviceEvent({ kind: "session_issued" }));
  assert.throws(() => parseGatewayDeviceEvent({ kind: "session_issued", xiaozhiSessionId: "x" }));
});

test("gateway rejection codes are a frozen superset of the trusted-core codes", () => {
  assert.ok(Object.isFrozen(GATEWAY_REJECTION_CODES));
  for (const code of ["device_unbound", "device_connection_conflict", "session_forged", "no_active_playback", "gateway.parse_failed"]) {
    assert.ok((GATEWAY_REJECTION_CODES as readonly string[]).includes(code), `missing ${code}`);
  }
});

test("device directives are content-free: no text or audio-byte fields exist", () => {
  const directives: readonly GatewayDeviceDirective[] = [
    { kind: "tts.start", sessionKey: "ses_gw0123456789abcdef", turnId: "trn_000000000001", epoch: 1 },
    {
      kind: "tts.frames",
      sessionKey: "ses_gw0123456789abcdef",
      turnId: "trn_000000000001",
      epoch: 1,
      frameCount: 4,
      audioDigest: "0123456789abcdef",
    },
    { kind: "tts.stop", sessionKey: "ses_gw0123456789abcdef", turnId: "trn_000000000001", epoch: 1, reason: "interrupted" },
    { kind: "tts.clear", sessionKey: "ses_gw0123456789abcdef", epoch: 1, droppedStale: 3 },
  ];
  const forbiddenFields = ["text", "audio", "payload", "content", "samples", "data"];
  for (const directive of directives) {
    const serialized = JSON.stringify(directive);
    for (const field of forbiddenFields) {
      assert.ok(!serialized.includes(`"${field}"`), `directive ${directive.kind} must not carry ${field}`);
    }
  }
});
