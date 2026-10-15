import assert from "node:assert/strict";
import test from "node:test";

/**
 * R1-V2 bridge IPC contract tests (issue #29 实现范围 2/3): protocol
 * versioning, the five commands, the event vocabulary, bounded frames and
 * fail-closed payload schemas. PRIVACY: every command payload and every
 * event payload except the transient assistant.delta is content-free —
 * asserted here at the schema level.
 */

import {
  BRIDGE_COMMANDS,
  BRIDGE_EVENTS,
  BRIDGE_IPC_AUTH_PATTERN,
  BRIDGE_IPC_MAX_FRAME_CHARS,
  BRIDGE_IPC_PROTOCOL,
  parseAssistantDeltaPayload,
  parseAttemptEndedPayload,
  parseBridgeFrame,
  parseRuntimeErrorPayload,
  parseSessionClosedPayload,
  parseSessionClosePayload,
  parseSessionIdlePayload,
  parseSessionOpenPayload,
  parseTurnAcceptedPayload,
  parseTurnCancelPayload,
  parseTurnPromptPayload,
  parseTurnSettledPayload,
  parseTurnStreamPayload,
} from "../../../../lib/domain/voice/bridge/ipc-contract.ts";
import { ContractValidationError } from "../../../../lib/domain/contract/core.ts";

const TEST_AUTH = "a".repeat(64);

function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

test("the protocol defines exactly the five documented commands and events", () => {
  assert.deepEqual([...BRIDGE_COMMANDS], ["session.open", "turn.prompt", "turn.cancel", "turn.stream", "session.close"]);
  assert.deepEqual(
    [...BRIDGE_EVENTS],
    ["hello_ack", "turn.accepted", "assistant.delta", "attempt.ended", "turn.settled", "session.idle", "session.closed", "runtime.error"],
  );
  assert.equal(BRIDGE_IPC_PROTOCOL, "lumithink.bridge-ipc/v2");
});

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

test("hello frames round-trip and enforce version, auth grammar and role", () => {
  const frame = parseBridgeFrame(JSON.stringify({ kind: "hello", v: BRIDGE_IPC_PROTOCOL, auth: TEST_AUTH, role: "orchestrator" }));
  assert.equal(frame.kind, "hello");
  assert.ok(BRIDGE_IPC_AUTH_PATTERN.test(TEST_AUTH));
  assert.throws(
    () => parseBridgeFrame(JSON.stringify({ kind: "hello", v: "lumithink.bridge-ipc/v1", auth: TEST_AUTH, role: "orchestrator" })),
    ContractValidationError,
  );
  assert.throws(
    () => parseBridgeFrame(JSON.stringify({ kind: "hello", v: BRIDGE_IPC_PROTOCOL, auth: "short", role: "orchestrator" })),
    ContractValidationError,
  );
  assert.throws(
    () => parseBridgeFrame(JSON.stringify({ kind: "hello", v: BRIDGE_IPC_PROTOCOL, auth: TEST_AUTH, role: "attacker" })),
    ContractValidationError,
  );
});

test("command frames round-trip; unknown commands and fields fail closed", () => {
  const frame = { kind: "command", name: "turn.prompt", seq: 1, payload: {} };
  const parsed = parseBridgeFrame(JSON.stringify(frame));
  assert.equal(parsed.kind, "command");
  assert.throws(
    () => parseBridgeFrame(JSON.stringify({ ...frame, name: "agent.spawn" })),
    ContractValidationError,
  );
  assert.throws(
    () => parseBridgeFrame(JSON.stringify({ ...frame, extra: true })),
    ContractValidationError,
  );
  assert.throws(
    () => parseBridgeFrame(JSON.stringify({ ...frame, seq: -1 })),
    ContractValidationError,
  );
});

test("reply frames round-trip; rejection codes are enumerated", () => {
  const ok = parseBridgeFrame(JSON.stringify({ kind: "reply", name: "session.open", seq: 3, ok: true, payload: { recovered: false } }));
  assert.ok(ok.kind === "reply" && ok.ok === true);
  const rejected = parseBridgeFrame(JSON.stringify({ kind: "reply", name: "session.open", seq: 3, ok: false, code: "session_conflict" }));
  assert.ok(rejected.kind === "reply" && rejected.ok === false && rejected.code === "session_conflict");
  assert.throws(
    () => parseBridgeFrame(JSON.stringify({ kind: "reply", name: "session.open", seq: 3, ok: false, code: "made_up_code" })),
    ContractValidationError,
  );
});

test("event frames round-trip; unknown events and fields fail closed", () => {
  const frame = { kind: "event", name: "session.idle", payload: { sessionKey: "ses_bridge0001", epoch: 1, attemptId: null } };
  const parsed = parseBridgeFrame(JSON.stringify(frame));
  assert.equal(parsed.kind, "event");
  assert.throws(
    () => parseBridgeFrame(JSON.stringify({ ...frame, name: "agent.whisper" })),
    ContractValidationError,
  );
  assert.throws(
    () => parseBridgeFrame(JSON.stringify({ ...frame, watermark: 1 })),
    ContractValidationError,
  );
});

test("oversized frames and malformed JSON fail closed", () => {
  const big = { kind: "command", name: "turn.prompt", seq: 1, payload: { blob: "x".repeat(BRIDGE_IPC_MAX_FRAME_CHARS) } };
  assert.throws(() => parseBridgeFrame(JSON.stringify(big)), ContractValidationError);
  assert.throws(() => parseBridgeFrame("{not json"), ContractValidationError);
  assert.throws(() => parseBridgeFrame(""), ContractValidationError);
  assert.throws(() => parseBridgeFrame(JSON.stringify([1, 2])), ContractValidationError);
});

// ---------------------------------------------------------------------------
// Command payloads
// ---------------------------------------------------------------------------

test("session.open payload parses contract ids and rejects unknown fields", () => {
  const payload = { sessionKey: "ses_bridge0001", ownerActorId: "act_owner0001", conversationId: "conv_conv0001" };
  assert.equal(parseSessionOpenPayload(payload).sessionKey, "ses_bridge0001");
  const malformed = roundTrip({ ...payload, ownerActorId: 12 });
  assert.throws(() => parseSessionOpenPayload(malformed), ContractValidationError);
  assert.throws(() => parseSessionOpenPayload({ ...payload, bypass: true }), ContractValidationError);
  assert.throws(() => parseSessionOpenPayload({ ...payload, conversationId: undefined }), ContractValidationError);
});

test("turn.prompt payload requires epoch, hex fingerprint and bounded idempotency key", () => {
  const payload = {
    sessionKey: "ses_bridge0001",
    turnId: "trn_000000000001",
    epoch: 1,
    fingerprint: "0123456789abcdef0123456789abcdef",
    idempotencyKey: "idem-key-000001",
  };
  assert.equal(parseTurnPromptPayload(payload).epoch, 1);
  assert.equal(parseTurnPromptPayload(payload).promptText, null, "promptText is optional on the wire");
  assert.throws(() => parseTurnPromptPayload({ ...payload, epoch: 0 }), ContractValidationError);
  assert.throws(() => parseTurnPromptPayload({ ...payload, fingerprint: "not-hex" }), ContractValidationError);
  assert.throws(() => parseTurnPromptPayload({ ...payload, idempotencyKey: "short" }), ContractValidationError);
  assert.throws(() => parseTurnPromptPayload({ ...payload, text: "raw prompt content" }), ContractValidationError);
});

test("turn.prompt promptText is the bounded transient transcript carrier (issue #51)", () => {
  const payload = {
    sessionKey: "ses_bridge0001",
    turnId: "trn_000000000001",
    epoch: 1,
    fingerprint: "0123456789abcdef0123456789abcdef",
    idempotencyKey: "idem-key-000001",
  };
  // A bounded non-empty promptText round-trips verbatim.
  const marker = "我们一起看看这道题。";
  assert.equal(parseTurnPromptPayload({ ...payload, promptText: marker }).promptText, marker);
  // Empty and oversized promptText fail closed (BRIDGE_TURN_PROMPT_TEXT_MAX_CHARS).
  assert.throws(() => parseTurnPromptPayload({ ...payload, promptText: "" }), ContractValidationError);
  assert.throws(() => parseTurnPromptPayload({ ...payload, promptText: "字".repeat(513) }), ContractValidationError);
  // promptText stays the ONLY content field: the plain `text` field is
  // still an unknown field, even next to a valid promptText.
  assert.throws(
    () => parseTurnPromptPayload({ ...payload, promptText: marker, text: "echo" }),
    ContractValidationError,
  );
  // The full frame round-trip preserves the transcript verbatim.
  const frame = parseBridgeFrame(
    JSON.stringify({ kind: "command", name: "turn.prompt", seq: 7, payload: { ...payload, promptText: marker } }),
  );
  assert.ok(frame.kind === "command" && frame.name === "turn.prompt");
  assert.equal(parseTurnPromptPayload(frame.payload).promptText, marker);
});

test("turn.cancel payload only accepts registered cancel reasons", () => {
  const payload = { sessionKey: "ses_bridge0001", turnId: "trn_000000000001", epoch: 2, reason: "barge_in" };
  assert.equal(parseTurnCancelPayload(payload).reason, "barge_in");
  assert.throws(() => parseTurnCancelPayload({ ...payload, reason: "because" }), ContractValidationError);
  assert.throws(() => parseTurnCancelPayload({ ...payload, epoch: 1.5 }), ContractValidationError);
});

test("turn.stream and session.close payloads are strictly shaped", () => {
  assert.equal(parseTurnStreamPayload({ sessionKey: "ses_bridge0001", turnId: "trn_000000000001", epoch: 1 }).epoch, 1);
  assert.throws(
    () => parseTurnStreamPayload({ sessionKey: "ses_bridge0001", turnId: "trn_000000000001", epoch: 1, mode: "raw" }),
    ContractValidationError,
  );
  assert.equal(parseSessionClosePayload({ sessionKey: "ses_bridge0001", reason: "orchestrator_close" }).reason, "orchestrator_close");
  assert.throws(() => parseSessionClosePayload({ sessionKey: "ses_bridge0001", reason: "" }), ContractValidationError);
});

// ---------------------------------------------------------------------------
// Event payloads + privacy field allow-lists
// ---------------------------------------------------------------------------

test("assistant.delta is tightly bound and the ONLY event carrying text", () => {
  const payload = {
    sessionKey: "ses_bridge0001",
    turnId: "trn_000000000001",
    epoch: 1,
    attemptId: "att_bridge0001_0001",
    stepId: "step_att_bridge0001_0001",
    index: 0,
    text: "好的，",
  };
  const parsed = parseAssistantDeltaPayload(payload);
  assert.deepEqual(Object.keys(parsed).sort(), ["attemptId", "epoch", "index", "sessionKey", "stepId", "text", "turnId"]);
  assert.throws(() => parseAssistantDeltaPayload({ ...payload, index: -1 }), ContractValidationError);
  assert.throws(() => parseAssistantDeltaPayload({ ...payload, text: "" }), ContractValidationError);
  assert.throws(
    () => parseAssistantDeltaPayload({ ...payload, text: "x".repeat(513) }),
    ContractValidationError,
  );
});

test("durable settlement events carry ids only — never message bodies", () => {
  const settled = parseTurnSettledPayload({
    sessionKey: "ses_bridge0001",
    turnId: "trn_000000000001",
    epoch: 1,
    messageId: "msg_bridge0001_0001",
    finalState: "COMPLETED",
  });
  assert.deepEqual(Object.keys(settled).sort(), ["epoch", "finalState", "messageId", "sessionKey", "turnId"]);
  assert.throws(
    () => parseTurnSettledPayload({ sessionKey: "ses_bridge0001", turnId: "trn_000000000001", epoch: 1, messageId: "m", finalState: "COMPLETED", text: "leak" }),
    ContractValidationError,
  );
  assert.throws(
    () => parseTurnSettledPayload({ sessionKey: "ses_bridge0001", turnId: "trn_000000000001", epoch: 1, messageId: "m", finalState: "RUNNING" }),
    ContractValidationError,
  );
  const accepted = parseTurnAcceptedPayload({
    sessionKey: "ses_bridge0001",
    turnId: "trn_000000000001",
    epoch: 1,
    attemptId: "att_bridge0001_0001",
  });
  assert.deepEqual(Object.keys(accepted).sort(), ["attemptId", "epoch", "sessionKey", "turnId"]);
  const ended = parseAttemptEndedPayload({
    sessionKey: "ses_bridge0001",
    turnId: "trn_000000000001",
    epoch: 1,
    attemptId: "att_bridge0001_0001",
  });
  assert.deepEqual(Object.keys(ended).sort(), ["attemptId", "epoch", "sessionKey", "turnId"]);
});

test("session.idle / session.closed / runtime.error payloads stay id-bound", () => {
  const idle = parseSessionIdlePayload({ sessionKey: "ses_bridge0001", epoch: 2, attemptId: null });
  assert.deepEqual(Object.keys(idle).sort(), ["attemptId", "epoch", "sessionKey"]);
  const closed = parseSessionClosedPayload({ sessionKey: "ses_bridge0001", reason: "orchestrator_close" });
  assert.deepEqual(Object.keys(closed).sort(), ["reason", "sessionKey"]);
  const runtimeError = parseRuntimeErrorPayload({ sessionKey: null, code: "worker_crashed", attemptId: null });
  assert.deepEqual(Object.keys(runtimeError).sort(), ["attemptId", "code", "sessionKey"]);
  assert.throws(() => parseRuntimeErrorPayload({ sessionKey: null, code: "exploded", attemptId: null }), ContractValidationError);
  assert.throws(() => parseSessionClosedPayload({ sessionKey: "ses_bridge0001", reason: "x".repeat(33) }), ContractValidationError);
});
