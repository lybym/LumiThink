/**
 * R1-V2 Bridge IPC contract — session.open / turn.prompt / turn.cancel /
 * turn.stream / session.close over a private local transport (issue #29
 * 实现范围 2/3; docs/VOICE_RUNTIME.md §3).
 *
 * This module owns the PROTOCOL SEMANTICS as pure, dependency-free schema
 * and fail-closed parsers: protocol version, command/event names, envelope
 * shapes, the bounded auth-token grammar, frame-size caps and rate-limit
 * defaults. The byte-level transport (length prefix, sockets, UDS file
 * permissions, peer lease) lives in lib/server/voice-bridge-ipc.ts — the
 * domain layer never imports node builtins.
 *
 * PRIVACY (issue #29 统一阻断规则): every command payload and every event
 * payload except `assistant.delta` is content-free — ids, epochs, attempt/
 * step/index bindings, enumerated codes, counts and hex digests only. The
 * single content-bearing field in the entire protocol is the transient
 * `text` of an `assistant.delta` event (the live stream the Orchestrator
 * must gate); it is NEVER persisted, audited, logged or re-sent as part of
 * any durable message. Schema tests assert this field allow-list.
 *
 * This module must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import {
  ContractValidationError,
  problem,
  validateContractId,
  type ContractProblem,
} from "../../contract/core.ts";
import { isValidVoiceEpoch, VOICE_CANCEL_REASONS } from "../schema.ts";
import {
  BRIDGE_DSH_VERSION,
  BRIDGE_PROFILE_ID,
} from "./profile.ts";

// ---------------------------------------------------------------------------
// Protocol identity + transport bounds
// ---------------------------------------------------------------------------

export const BRIDGE_IPC_PROTOCOL = "lumithink.bridge-ipc/v1" as const;

/** Maximum JSON frame body length in code units (transport re-caps bytes). */
export const BRIDGE_IPC_MAX_FRAME_CHARS = 16_384;

/** Auth token: 64..128 hex chars (a local secret; never logged). */
export const BRIDGE_IPC_AUTH_PATTERN = /^[0-9a-f]{64,128}$/;

/** Default rate limit: frames per lease window (server-enforced). */
export const BRIDGE_IPC_MAX_FRAMES_PER_WINDOW = 120;
export const BRIDGE_IPC_RATE_WINDOW_MS = 1_000;

// ---------------------------------------------------------------------------
// Command / event vocabulary (VOICE_RUNTIME.md §3)
// ---------------------------------------------------------------------------

export const BRIDGE_COMMANDS = Object.freeze([
  "session.open",
  "turn.prompt",
  "turn.cancel",
  "turn.stream",
  "session.close",
] as const);

export type BridgeCommandName = (typeof BRIDGE_COMMANDS)[number];

export const BRIDGE_EVENTS = Object.freeze([
  "hello_ack",
  "turn.accepted",
  "assistant.delta",
  "attempt.ended",
  "turn.settled",
  "session.idle",
  "session.closed",
  "runtime.error",
] as const);

export type BridgeEventName = (typeof BRIDGE_EVENTS)[number];

/** Enumerated bridge rejection / error codes (never echo submitted values). */
export const BRIDGE_REJECTION_CODES = Object.freeze([
  "session_unknown",
  "session_conflict",
  "bridge_ownership_conflict",
  "turn_unknown",
  "bridge_turn_conflict",
  "epoch_mismatch",
  "stale_turn_rejected",
  "turn_terminal",
  "cancel_unknown_turn",
  "worker_quarantined",
  "worker_recovering",
  "cancel_timeout",
  "rate_limited",
  "protocol_violation",
  "auth_failed",
  "lease_denied",
  "frame_too_large",
  "bridge.parse_failed",
] as const);

export type BridgeRejectionCode = (typeof BRIDGE_REJECTION_CODES)[number];

/** Enumerated runtime.error codes (worker isolation / recovery, §7). */
export const BRIDGE_RUNTIME_ERROR_CODES = Object.freeze([
  "worker_crashed",
  "cancel_timeout",
  "stream_fault",
  "recovered",
] as const);

export type BridgeRuntimeErrorCode = (typeof BRIDGE_RUNTIME_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// Envelope shapes
// ---------------------------------------------------------------------------

/** Client → bridge command frame. */
export interface BridgeCommandFrame {
  readonly kind: "command";
  readonly name: BridgeCommandName;
  readonly seq: number;
  readonly payload: unknown;
}

/** Bridge → client reply frame (ok or enumerated rejection). */
export interface BridgeReplyFrame {
  readonly kind: "reply";
  readonly name: BridgeCommandName;
  readonly seq: number;
  readonly ok: true;
  readonly payload: unknown;
}

export interface BridgeReplyRejectionFrame {
  readonly kind: "reply";
  readonly name: BridgeCommandName;
  readonly seq: number;
  readonly ok: false;
  readonly code: BridgeRejectionCode;
}

/** Bridge → client unsolicited event frame. */
export interface BridgeEventFrame {
  readonly kind: "event";
  readonly name: BridgeEventName;
  readonly payload: unknown;
}

/** Handshake frames (first frames in both directions). */
export interface BridgeHelloFrame {
  readonly kind: "hello";
  readonly v: typeof BRIDGE_IPC_PROTOCOL;
  readonly auth: string;
  readonly role: "orchestrator";
}

export interface BridgeHelloAckFrame {
  readonly kind: "event";
  readonly name: "hello_ack";
  readonly payload: {
    readonly v: typeof BRIDGE_IPC_PROTOCOL;
    readonly bridgeId: typeof BRIDGE_PROFILE_ID;
    readonly profileId: typeof BRIDGE_PROFILE_ID;
    readonly dshVersion: typeof BRIDGE_DSH_VERSION;
  };
}

export type BridgeFrame =
  | BridgeCommandFrame
  | BridgeReplyFrame
  | BridgeReplyRejectionFrame
  | BridgeEventFrame
  | BridgeHelloFrame;

// ---------------------------------------------------------------------------
// Fail-closed frame validation (string level)
// ---------------------------------------------------------------------------

function failBridgeParse(path: string, message: string): never {
  throw new ContractValidationError([problem("CONTRACT_FIELD_INVALID", path, message)]);
}

/**
 * Validate one inbound frame. Fail closed on: non-object, unknown kind,
 * unknown command/event names, wrong protocol version, oversized frames,
 * malformed envelopes or payloads (payload schemas are validated by the
 * per-command parsers below). The auth token shape is grammar-checked but
 * its value is never echoed anywhere.
 */
export function parseBridgeFrame(raw: string): BridgeFrame {
  if (typeof raw !== "string" || raw.length === 0) {
    failBridgeParse("frame", "frame must be a non-empty JSON string.");
  }
  if (raw.length > BRIDGE_IPC_MAX_FRAME_CHARS) {
    failBridgeParse("frame", `frame exceeds the ${BRIDGE_IPC_MAX_FRAME_CHARS} code-unit limit.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    failBridgeParse("frame", "frame is not valid JSON.");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    failBridgeParse("frame", "frame must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case "hello":
      return parseHelloFrame(record);
    case "command":
      return parseCommandFrame(record);
    case "reply":
      return parseReplyFrame(record);
    case "event":
      return parseEventFrame(record);
    default:
      failBridgeParse("frame.kind", "frame kind must be hello, command, reply or event.");
  }
}

function requireProtocolV(record: Record<string, unknown>, path: string): void {
  if (record.v !== BRIDGE_IPC_PROTOCOL) {
    failBridgeParse(path, `frame protocol version must be ${BRIDGE_IPC_PROTOCOL}.`);
  }
}

function parseHelloFrame(record: Record<string, unknown>): BridgeHelloFrame {
  requireProtocolV(record, "hello.v");
  if (
    typeof record.auth !== "string" ||
    !BRIDGE_IPC_AUTH_PATTERN.test(record.auth) ||
    record.auth.length > 128
  ) {
    failBridgeParse("hello.auth", "hello auth must match the bounded token grammar.");
  }
  if (record.role !== "orchestrator") {
    failBridgeParse("hello.role", "hello role must be orchestrator.");
  }
  for (const key of Object.keys(record)) {
    if (!["kind", "v", "auth", "role"].includes(key)) {
      failBridgeParse(`hello.${key}`, "hello frame carries an unknown field.");
    }
  }
  return {
    kind: "hello",
    v: BRIDGE_IPC_PROTOCOL,
    auth: record.auth as string,
    role: "orchestrator",
  };
}

function parseCommandFrame(record: Record<string, unknown>): BridgeCommandFrame {
  if (
    typeof record.seq !== "number" ||
    !Number.isInteger(record.seq) ||
    (record.seq as number) < 0 ||
    (record.seq as number) > 2 ** 31 - 1
  ) {
    failBridgeParse("command.seq", "command seq must be a bounded non-negative integer.");
  }
  if (!(BRIDGE_COMMANDS as readonly string[]).includes(record.name as string)) {
    failBridgeParse("command.name", "command name is not a registered bridge command.");
  }
  for (const key of Object.keys(record)) {
    if (!["kind", "name", "seq", "payload"].includes(key)) {
      failBridgeParse(`command.${key}`, "command frame carries an unknown field.");
    }
  }
  return {
    kind: "command",
    name: record.name as BridgeCommandName,
    seq: record.seq as number,
    payload: record.payload,
  };
}

function parseReplyFrame(record: Record<string, unknown>): BridgeReplyFrame | BridgeReplyRejectionFrame {
  if (
    typeof record.seq !== "number" ||
    !Number.isInteger(record.seq) ||
    (record.seq as number) < 0 ||
    (record.seq as number) > 2 ** 31 - 1
  ) {
    failBridgeParse("reply.seq", "reply seq must be a bounded non-negative integer.");
  }
  if (!(BRIDGE_COMMANDS as readonly string[]).includes(record.name as string)) {
    failBridgeParse("reply.name", "reply name must mirror a registered command.");
  }
  for (const key of Object.keys(record)) {
    if (!["kind", "name", "seq", "ok", "payload", "code"].includes(key)) {
      failBridgeParse(`reply.${key}`, "reply frame carries an unknown field.");
    }
  }
  if (record.ok === true) {
    return {
      kind: "reply",
      name: record.name as BridgeCommandName,
      seq: record.seq as number,
      ok: true,
      payload: record.payload,
    };
  }
  if (record.ok === false) {
    if (!(BRIDGE_REJECTION_CODES as readonly string[]).includes(record.code as string)) {
      failBridgeParse("reply.code", "reply rejection code is not a registered bridge code.");
    }
    return {
      kind: "reply",
      name: record.name as BridgeCommandName,
      seq: record.seq as number,
      ok: false,
      code: record.code as BridgeRejectionCode,
    };
  }
  failBridgeParse("reply.ok", "reply ok must be a boolean.");
}

function parseEventFrame(record: Record<string, unknown>): BridgeEventFrame {
  if (!(BRIDGE_EVENTS as readonly string[]).includes(record.name as string)) {
    failBridgeParse("event.name", "event name is not a registered bridge event.");
  }
  for (const key of Object.keys(record)) {
    if (!["kind", "name", "payload"].includes(key)) {
      failBridgeParse(`event.${key}`, "event frame carries an unknown field.");
    }
  }
  return {
    kind: "event",
    name: record.name as BridgeEventName,
    payload: record.payload,
  };
}

// ---------------------------------------------------------------------------
// Command payload schemas (all content-free)
// ---------------------------------------------------------------------------

/** Shared id refs for command payloads (contract grammars, fail-closed). */
function validateSessionTurnRefs(
  payload: Record<string, unknown>,
  problems: ContractProblem[],
  options: { readonly turnId: boolean; readonly traceId: boolean },
): void {
  if (payload.sessionKey === undefined || payload.sessionKey === null) {
    problems.push(problem("CONTRACT_FIELD_MISSING", "payload.sessionKey", "sessionKey is required."));
  } else {
    validateContractId("sessionId", payload.sessionKey, "payload.sessionKey", problems);
  }
  if (options.turnId) {
    if (payload.turnId === undefined || payload.turnId === null) {
      problems.push(problem("CONTRACT_FIELD_MISSING", "payload.turnId", "turnId is required."));
    } else {
      validateContractId("turnId", payload.turnId, "payload.turnId", problems);
    }
  }
  if (options.traceId) {
    if (payload.traceId !== undefined && payload.traceId !== null) {
      validateContractId("traceId", payload.traceId, "payload.traceId", problems);
    }
  }
}

function rejectUnknownFields(
  payload: Record<string, unknown>,
  allowed: readonly string[],
  problems: ContractProblem[],
): void {
  for (const key of Object.keys(payload)) {
    if (!allowed.includes(key)) {
      problems.push(problem("CONTRACT_FIELD_INVALID", `payload.${key}`, "unknown payload field."));
    }
  }
}

function parsePayloadObject(raw: unknown, name: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    failBridgeParse(`payload(${name})`, "payload must be an object.");
  }
  return raw as Record<string, unknown>;
}

export interface BridgeSessionOpenPayload {
  readonly sessionKey: string;
  readonly ownerActorId: string;
  readonly conversationId: string;
}

export function parseSessionOpenPayload(raw: unknown): BridgeSessionOpenPayload {
  const payload = parsePayloadObject(raw, "session.open");
  const problems: ContractProblem[] = [];
  rejectUnknownFields(payload, ["sessionKey", "ownerActorId", "conversationId"], problems);
  for (const field of ["ownerActorId", "conversationId"] as const) {
    if (payload[field] === undefined || payload[field] === null) {
      problems.push(problem("CONTRACT_FIELD_MISSING", `payload.${field}`, `${field} is required.`));
    } else {
      validateContractId(field === "ownerActorId" ? "actorId" : "conversationId", payload[field], `payload.${field}`, problems);
    }
  }
  validateSessionTurnRefs(payload, problems, { turnId: false, traceId: false });
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return {
    sessionKey: payload.sessionKey as string,
    ownerActorId: payload.ownerActorId as string,
    conversationId: payload.conversationId as string,
  };
}

export interface BridgeTurnPromptPayload {
  readonly sessionKey: string;
  readonly turnId: string;
  readonly epoch: number;
  readonly traceId: string | null;
  /** Content-free hex digest of the prompt payload (never the content). */
  readonly fingerprint: string;
  readonly idempotencyKey: string;
}

export function parseTurnPromptPayload(raw: unknown): BridgeTurnPromptPayload {
  const payload = parsePayloadObject(raw, "turn.prompt");
  const problems: ContractProblem[] = [];
  rejectUnknownFields(payload, ["sessionKey", "turnId", "epoch", "traceId", "fingerprint", "idempotencyKey"], problems);
  validateSessionTurnRefs(payload, problems, { turnId: true, traceId: true });
  if (!isValidVoiceEpoch(payload.epoch)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "payload.epoch", "epoch must be a positive integer."));
  }
  if (typeof payload.fingerprint !== "string" || !/^[0-9a-f]{16,64}$/.test(payload.fingerprint)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "payload.fingerprint", "fingerprint must be a hex digest."));
  }
  if (typeof payload.idempotencyKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/.test(payload.idempotencyKey)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "payload.idempotencyKey", "idempotencyKey must match the bounded grammar."));
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return {
    sessionKey: payload.sessionKey as string,
    turnId: payload.turnId as string,
    epoch: payload.epoch as number,
    traceId: (payload.traceId as string | null | undefined) ?? null,
    fingerprint: payload.fingerprint as string,
    idempotencyKey: payload.idempotencyKey as string,
  };
}

export interface BridgeTurnCancelPayload {
  readonly sessionKey: string;
  readonly turnId: string;
  /** The orchestrator's CURRENT trusted epoch at cancel time (fence first). */
  readonly epoch: number;
  readonly reason: string;
}

export function parseTurnCancelPayload(raw: unknown): BridgeTurnCancelPayload {
  const payload = parsePayloadObject(raw, "turn.cancel");
  const problems: ContractProblem[] = [];
  rejectUnknownFields(payload, ["sessionKey", "turnId", "epoch", "reason"], problems);
  validateSessionTurnRefs(payload, problems, { turnId: true, traceId: false });
  if (!isValidVoiceEpoch(payload.epoch)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "payload.epoch", "epoch must be a positive integer."));
  }
  if (!(VOICE_CANCEL_REASONS as readonly string[]).includes(payload.reason as string)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "payload.reason", "reason must be a registered cancel reason."));
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return {
    sessionKey: payload.sessionKey as string,
    turnId: payload.turnId as string,
    epoch: payload.epoch as number,
    reason: payload.reason as string,
  };
}

export interface BridgeTurnStreamPayload {
  readonly sessionKey: string;
  readonly turnId: string;
  readonly epoch: number;
}

export function parseTurnStreamPayload(raw: unknown): BridgeTurnStreamPayload {
  const payload = parsePayloadObject(raw, "turn.stream");
  const problems: ContractProblem[] = [];
  rejectUnknownFields(payload, ["sessionKey", "turnId", "epoch"], problems);
  validateSessionTurnRefs(payload, problems, { turnId: true, traceId: false });
  if (!isValidVoiceEpoch(payload.epoch)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "payload.epoch", "epoch must be a positive integer."));
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return {
    sessionKey: payload.sessionKey as string,
    turnId: payload.turnId as string,
    epoch: payload.epoch as number,
  };
}

export interface BridgeSessionClosePayload {
  readonly sessionKey: string;
  readonly reason: string;
}

export function parseSessionClosePayload(raw: unknown): BridgeSessionClosePayload {
  const payload = parsePayloadObject(raw, "session.close");
  const problems: ContractProblem[] = [];
  rejectUnknownFields(payload, ["sessionKey", "reason"], problems);
  validateSessionTurnRefs(payload, problems, { turnId: false, traceId: false });
  if (typeof payload.reason !== "string" || payload.reason.length === 0 || payload.reason.length > 32) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "payload.reason", "reason must be a bounded string."));
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return {
    sessionKey: payload.sessionKey as string,
    reason: payload.reason as string,
  };
}

// ---------------------------------------------------------------------------
// Event payload schemas
// ---------------------------------------------------------------------------

/**
 * The ONLY content-bearing event: one transient live delta, bound to
 * (sessionKey, turnId, epoch, attemptId, stepId, index). The text is the
 * raw upstream chunk — consumed exclusively by the Orchestrator-side
 * sentence buffer + children Output Gate. It is never persisted, audited
 * or logged, and a durable final message NEVER takes this path.
 */
export interface BridgeAssistantDeltaPayload {
  readonly sessionKey: string;
  readonly turnId: string;
  readonly epoch: number;
  readonly attemptId: string;
  readonly stepId: string;
  readonly index: number;
  readonly text: string;
}

export function parseAssistantDeltaPayload(raw: unknown): BridgeAssistantDeltaPayload {
  const payload = parsePayloadObject(raw, "assistant.delta");
  const problems: ContractProblem[] = [];
  rejectUnknownFields(
    payload,
    ["sessionKey", "turnId", "epoch", "attemptId", "stepId", "index", "text"],
    problems,
  );
  validateSessionTurnRefs(payload, problems, { turnId: true, traceId: false });
  if (!isValidVoiceEpoch(payload.epoch)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "payload.epoch", "epoch must be a positive integer."));
  }
  if (typeof payload.attemptId !== "string" || payload.attemptId.length === 0 || payload.attemptId.length > 64) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "payload.attemptId", "attemptId must be a bounded string."));
  }
  if (typeof payload.stepId !== "string" || payload.stepId.length === 0 || payload.stepId.length > 64) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "payload.stepId", "stepId must be a bounded string."));
  }
  if (typeof payload.index !== "number" || !Number.isInteger(payload.index) || (payload.index as number) < 0) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "payload.index", "index must be a non-negative integer."));
  }
  if (typeof payload.text !== "string" || payload.text.length === 0 || payload.text.length > 512) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "payload.text", "delta text must be a bounded non-empty string."));
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return payload as unknown as BridgeAssistantDeltaPayload;
}

/** Common id-binding fields every non-delta event carries. */
interface BridgeEventBinding {
  readonly sessionKey: string | null;
  readonly turnId: string | null;
  readonly epoch: number | null;
}

function parseEventBinding(
  raw: unknown,
  name: string,
  allowed: readonly string[],
  options: { readonly requireTurnId: boolean; readonly requireSessionKey: boolean },
): { binding: BridgeEventBinding; payload: Record<string, unknown> } {
  const payload = parsePayloadObject(raw, name);
  const problems: ContractProblem[] = [];
  rejectUnknownFields(payload, allowed, problems);
  if (payload.sessionKey === undefined || payload.sessionKey === null) {
    if (options.requireSessionKey) {
      problems.push(problem("CONTRACT_FIELD_MISSING", "payload.sessionKey", "sessionKey is required."));
    }
  } else {
    validateContractId("sessionId", payload.sessionKey, "payload.sessionKey", problems);
  }
  if (options.requireTurnId) {
    if (payload.turnId === undefined || payload.turnId === null) {
      problems.push(problem("CONTRACT_FIELD_MISSING", "payload.turnId", "turnId is required."));
    } else {
      validateContractId("turnId", payload.turnId, "payload.turnId", problems);
    }
  } else if (payload.turnId !== undefined && payload.turnId !== null) {
    validateContractId("turnId", payload.turnId, "payload.turnId", problems);
  }
  if (payload.epoch !== undefined && payload.epoch !== null && !isValidVoiceEpoch(payload.epoch)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "payload.epoch", "epoch must be a positive integer."));
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return {
    binding: {
      sessionKey: payload.sessionKey as string,
      turnId: (payload.turnId as string | null | undefined) ?? null,
      epoch: (payload.epoch as number | null | undefined) ?? null,
    },
    payload,
  };
}

export interface BridgeTurnAcceptedPayload {
  readonly sessionKey: string;
  readonly turnId: string;
  readonly epoch: number;
  readonly attemptId: string;
}

export function parseTurnAcceptedPayload(raw: unknown): BridgeTurnAcceptedPayload {
  const { payload } = parseEventBinding(
    raw,
    "turn.accepted",
    ["sessionKey", "turnId", "epoch", "attemptId"],
    { requireTurnId: true, requireSessionKey: true },
  );
  if (typeof payload.attemptId !== "string" || payload.attemptId.length === 0 || payload.attemptId.length > 64) {
    failBridgeParse("payload.attemptId", "attemptId must be a bounded string.");
  }
  return payload as unknown as BridgeTurnAcceptedPayload;
}

export interface BridgeAttemptEndedPayload {
  readonly sessionKey: string;
  readonly turnId: string;
  readonly epoch: number;
  readonly attemptId: string;
}

export function parseAttemptEndedPayload(raw: unknown): BridgeAttemptEndedPayload {
  const { payload } = parseEventBinding(
    raw,
    "attempt.ended",
    ["sessionKey", "turnId", "epoch", "attemptId"],
    { requireTurnId: true, requireSessionKey: true },
  );
  if (typeof payload.attemptId !== "string" || payload.attemptId.length === 0 || payload.attemptId.length > 64) {
    failBridgeParse("payload.attemptId", "attemptId must be a bounded string.");
  }
  return payload as unknown as BridgeAttemptEndedPayload;
}

export interface BridgeTurnSettledPayload {
  readonly sessionKey: string;
  readonly turnId: string;
  readonly epoch: number;
  /** Durable settlement reference (message id); never the message text. */
  readonly messageId: string;
  readonly finalState: "COMPLETED" | "CANCELLED" | "FAILED" | "TIMED_OUT";
}

export function parseTurnSettledPayload(raw: unknown): BridgeTurnSettledPayload {
  const { payload } = parseEventBinding(
    raw,
    "turn.settled",
    ["sessionKey", "turnId", "epoch", "messageId", "finalState"],
    { requireTurnId: true, requireSessionKey: true },
  );
  if (typeof payload.messageId !== "string" || payload.messageId.length === 0 || payload.messageId.length > 64) {
    failBridgeParse("payload.messageId", "messageId must be a bounded string.");
  }
  if (
    payload.finalState !== "COMPLETED" &&
    payload.finalState !== "CANCELLED" &&
    payload.finalState !== "FAILED" &&
    payload.finalState !== "TIMED_OUT"
  ) {
    failBridgeParse("payload.finalState", "finalState must be a terminal voice turn state.");
  }
  return payload as unknown as BridgeTurnSettledPayload;
}

export interface BridgeSessionIdlePayload {
  readonly sessionKey: string;
  readonly epoch: number | null;
  readonly attemptId: string | null;
}

export function parseSessionIdlePayload(raw: unknown): BridgeSessionIdlePayload {
  const { payload } = parseEventBinding(
    raw,
    "session.idle",
    ["sessionKey", "epoch", "attemptId"],
    { requireTurnId: false, requireSessionKey: true },
  );
  if (
    payload.attemptId !== undefined &&
    payload.attemptId !== null &&
    (typeof payload.attemptId !== "string" || payload.attemptId.length === 0 || payload.attemptId.length > 64)
  ) {
    failBridgeParse("payload.attemptId", "attemptId must be a bounded string when present.");
  }
  return {
    sessionKey: payload.sessionKey as string,
    epoch: (payload.epoch as number | null | undefined) ?? null,
    attemptId: (payload.attemptId as string | null | undefined) ?? null,
  };
}

export interface BridgeSessionClosedPayload {
  readonly sessionKey: string;
  readonly reason: string;
}

export function parseSessionClosedPayload(raw: unknown): BridgeSessionClosedPayload {
  const { payload } = parseEventBinding(raw, "session.closed", ["sessionKey", "reason"], { requireTurnId: false, requireSessionKey: true });
  if (typeof payload.reason !== "string" || payload.reason.length === 0 || payload.reason.length > 32) {
    failBridgeParse("payload.reason", "reason must be a bounded string.");
  }
  return {
    sessionKey: payload.sessionKey as string,
    reason: payload.reason as string,
  };
}

export interface BridgeRuntimeErrorPayload {
  readonly sessionKey: string | null;
  readonly code: BridgeRuntimeErrorCode;
  /** Bounded attempt correlation when known; never any content. */
  readonly attemptId: string | null;
}

export function parseRuntimeErrorPayload(raw: unknown): BridgeRuntimeErrorPayload {
  const { payload } = parseEventBinding(
    raw,
    "runtime.error",
    ["sessionKey", "code", "attemptId"],
    { requireTurnId: false, requireSessionKey: false },
  );
  if (!(BRIDGE_RUNTIME_ERROR_CODES as readonly string[]).includes(payload.code as string)) {
    failBridgeParse("payload.code", "runtime error code is not registered.");
  }
  if (
    payload.attemptId !== undefined &&
    payload.attemptId !== null &&
    (typeof payload.attemptId !== "string" || payload.attemptId.length === 0 || payload.attemptId.length > 64)
  ) {
    failBridgeParse("payload.attemptId", "attemptId must be a bounded string when present.");
  }
  return {
    sessionKey: (payload.sessionKey as string | null | undefined) ?? null,
    code: payload.code as BridgeRuntimeErrorCode,
    attemptId: (payload.attemptId as string | null | undefined) ?? null,
  };
}
