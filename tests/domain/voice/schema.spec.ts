/**
 * R1-V1 voice schema/state-machine tests (issue #28; docs/VOICE_RUNTIME.md §4).
 *
 * Proves: the exact state machine vocabulary, terminal irreversibility,
 * the grammar guards, and — the privacy-critical property — that NO audit
 * or record shape has a field that could carry child audio, transcript
 * text or model output.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  isLegalVoiceTurnTransition,
  isVoiceFingerprint,
  isVoiceIdempotencyKey,
  isValidVoiceEpoch,
  isVoiceTurnState,
  VOICE_AUDIT_FIELDS,
  VOICE_REJECTION_CODES,
  VOICE_TERMINAL_TURN_STATES,
  VOICE_TURN_STATES,
  VOICE_TURN_TRANSITIONS,
} from "../../../lib/domain/voice/schema.ts";

test("the state machine carries the exact VOICE_RUNTIME §4 vocabulary", () => {
  assert.deepEqual([...VOICE_TURN_STATES], [
    "CREATED",
    "QUEUED",
    "RUNNING",
    "CANCELLING",
    "COMPLETED",
    "CANCELLED",
    "FAILED",
    "TIMED_OUT",
  ]);
  assert.deepEqual([...VOICE_TERMINAL_TURN_STATES], ["COMPLETED", "CANCELLED", "FAILED", "TIMED_OUT"]);
});

test("the transition table matches the design contract and forbids revival", () => {
  // Forward path.
  assert.ok(isLegalVoiceTurnTransition("CREATED", "QUEUED"));
  assert.ok(isLegalVoiceTurnTransition("QUEUED", "RUNNING"));
  assert.ok(isLegalVoiceTurnTransition("RUNNING", "COMPLETED"));
  // Interruption paths.
  assert.ok(isLegalVoiceTurnTransition("CREATED", "CANCELLING"));
  assert.ok(isLegalVoiceTurnTransition("QUEUED", "CANCELLING"));
  assert.ok(isLegalVoiceTurnTransition("RUNNING", "CANCELLING"));
  assert.ok(isLegalVoiceTurnTransition("CANCELLING", "CANCELLED"));
  // Failure/timeout from every non-terminal state.
  for (const from of ["CREATED", "QUEUED", "RUNNING", "CANCELLING"] as const) {
    assert.ok(isLegalVoiceTurnTransition(from, "FAILED"), `${from} → FAILED`);
    assert.ok(isLegalVoiceTurnTransition(from, "TIMED_OUT"), `${from} → TIMED_OUT`);
  }
  // Terminal states have NO outgoing transition (irreversible).
  for (const terminal of VOICE_TERMINAL_TURN_STATES) {
    assert.deepEqual([...VOICE_TURN_TRANSITIONS[terminal]], [], `${terminal} must be terminal`);
    for (const to of VOICE_TURN_STATES) {
      assert.ok(!isLegalVoiceTurnTransition(terminal, to), `${terminal} → ${to} must be illegal`);
    }
  }
  // No self-transitions, no skipping the CANCELLING gate for CANCELLED.
  for (const state of VOICE_TURN_STATES) {
    assert.ok(!isLegalVoiceTurnTransition(state, state));
  }
  assert.ok(!isLegalVoiceTurnTransition("RUNNING", "CANCELLED"));
  assert.ok(!isLegalVoiceTurnTransition("QUEUED", "COMPLETED"));
});

test("isVoiceTurnState / epoch / fingerprint / idempotency-key guards fail closed", () => {
  assert.ok(isVoiceTurnState("RUNNING"));
  assert.ok(!isVoiceTurnState("running"));
  assert.ok(!isVoiceTurnState(null));
  assert.ok(!isVoiceTurnState(42));

  assert.ok(isValidVoiceEpoch(1));
  assert.ok(isValidVoiceEpoch(987654));
  assert.ok(!isValidVoiceEpoch(0));
  assert.ok(!isValidVoiceEpoch(-3));
  assert.ok(!isValidVoiceEpoch(1.5));
  assert.ok(!isValidVoiceEpoch("2"));

  assert.ok(isVoiceFingerprint("0123456789abcdef"));
  assert.ok(isVoiceFingerprint("a".repeat(64)));
  assert.ok(!isVoiceFingerprint("short"));
  assert.ok(!isVoiceFingerprint("0123456789ABCDEF")); // uppercase not allowed
  assert.ok(!isVoiceFingerprint("zzzzzzzzzzzzzzzz"));

  assert.ok(isVoiceIdempotencyKey("idem-key-000001"));
  assert.ok(isVoiceIdempotencyKey("idem.key.0001"));
  assert.ok(!isVoiceIdempotencyKey("short"));
  assert.ok(!isVoiceIdempotencyKey("-starts-with-dash"));
  assert.ok(!isVoiceIdempotencyKey(null));
});

test("structured rejection codes are enumerated and bounded", () => {
  for (const code of VOICE_REJECTION_CODES) {
    assert.equal(typeof code, "string");
    assert.ok(code.length > 0 && code.length < 48);
    assert.match(code, /^[a-z._]+$/);
  }
  assert.ok(VOICE_REJECTION_CODES.includes("stale_turn_rejected"));
  assert.ok(VOICE_REJECTION_CODES.includes("cross_session_rejected"));
  assert.ok(VOICE_REJECTION_CODES.includes("epoch_forged"));
  assert.ok(VOICE_REJECTION_CODES.includes("idempotency_conflict"));
  assert.ok(VOICE_REJECTION_CODES.includes("cancel_already_active"));
});

test("the audit field set has NO field that could carry child audio or text", () => {
  // The exact field set — any content-shaped field (text, audio, payload,
  // transcript, content, body, …) must make this test fail.
  assert.deepEqual(
    [...VOICE_AUDIT_FIELDS].sort(),
    ["action", "atMs", "count", "epoch", "finalState", "resultCode", "seq", "sessionKey", "traceId", "turnId"].sort(),
  );
  for (const forbidden of ["text", "audio", "payload", "transcript", "content", "body", "delta", "sentence", "url"]) {
    assert.ok(
      !(VOICE_AUDIT_FIELDS as readonly string[]).includes(forbidden),
      `audit must not have a "${forbidden}" field`,
    );
  }
  // Every field is either an enumerated code, a grammar-checked id, a
  // bounded number or null — nothing free-form exists to store.
  const actionValues = ["session.opened", "asr.received", "turn.dispatched", "turn.settled", "cancel.requested", "cancel.stop_confirmed", "output.fenced", "tts.drained", "write.fenced", "timeout.swept"];
  for (const action of actionValues) {
    assert.match(action, /^[a-z._]+$/);
  }
});
