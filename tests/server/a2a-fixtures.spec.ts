/**
 * P0-02 A2A fixture integrity tests (issue #80).
 *
 * Pure-Node checks over docs/fixtures/a2a-v1.0: JSON parseability, the frozen
 * field-ownership rule (append/lastChunk on the update event, never on the
 * Artifact), UTF-8 half-open byte ranges and per-chunk SHA-256 digests, the
 * aggregation of chunk events to the completed snapshot, the JSON-RPC and SSE
 * envelope shapes, and the standard error-code table. The locked official SDK
 * codec/wire runs live in poc/a2a-compat (own lockfile; not part of the root
 * dependency graph); this suite pins the committed fixtures so any edit that
 * breaks the recorded contract fails CI.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import path from "node:path";

const FIXTURES_DIR = path.resolve("docs/fixtures/a2a-v1.0");

const load = (name: string): any =>
  JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf8"));

const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const utf8 = (text: string): number => Buffer.byteLength(text, "utf8");

const canonical = (value: any): any => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = canonical(value[key]);
    }
    return out;
  }
  return value;
};

test("01/02 artifact update events: ownership, byte ranges, digests, and append semantics", () => {
  const ev01 = load("01-artifact-event.json");
  const ev02 = load("02-artifact-event.json");

  for (const [name, ev] of [["01", ev01], ["02", ev02]] as const) {
    assert.ok(Array.isArray(ev.artifact.parts));
    assert.ok(!("append" in ev.artifact) && !("lastChunk" in ev.artifact), `${name}: artifact must not carry append/lastChunk`);
    assert.equal(typeof ev.append, "boolean", `${name}: event.append required`);
    assert.equal(typeof ev.lastChunk, "boolean", `${name}: event.lastChunk required`);
    const meta = ev.metadata.lumithinkOutput;
    assert.equal(meta.version, 1);
    const text = ev.artifact.parts[0].text;
    assert.equal(meta.endByte - meta.startByte, utf8(text), `${name}: byte range must equal UTF-8 length`);
    assert.equal(meta.sha256, sha256Hex(text), `${name}: sha256 must match chunk text`);
  }

  assert.equal(ev01.append, false, "first chunk is a fresh artifact");
  assert.equal(ev01.lastChunk, false);
  assert.equal(ev02.append, true, "second chunk appends");
  assert.equal(ev02.lastChunk, true, "second chunk ends the artifact");
  assert.equal(ev02.metadata.lumithinkOutput.startByte, utf8(ev01.artifact.parts[0].text), "chunk 2 continues chunk 1");
  assert.equal(ev02.metadata.lumithinkOutput.endByte, utf8(ev01.artifact.parts[0].text + ev02.artifact.parts[0].text));
  assert.deepEqual(canonical(ev01.artifact.metadata), canonical(ev02.artifact.metadata), "stable artifact metadata must match");
});

test("03/04 task snapshots: aggregation, result flags, and field ownership", () => {
  const ev01 = load("01-artifact-event.json");
  const ev02 = load("02-artifact-event.json");
  const fullText = ev01.artifact.parts[0].text + ev02.artifact.parts[0].text;

  const t03 = load("03-completed-task.json");
  assert.equal(t03.status.state, "TASK_STATE_COMPLETED");
  assert.equal(t03.artifacts[0].parts[0].text, fullText, "snapshot text must equal aggregated chunks");
  assert.ok(!("append" in t03.artifacts[0]) && !("lastChunk" in t03.artifacts[0]));
  assert.deepEqual(t03.metadata.lumithinkResult, { version: 1, outputSuppressedAfterCancel: false, answerComplete: true });

  const t04 = load("04-completed-suppressed-task.json");
  assert.equal(t04.status.state, "TASK_STATE_COMPLETED", "no custom CANCELING state; terminal stays COMPLETED");
  assert.equal(t04.status.message.role, "ROLE_AGENT");
  assert.deepEqual(t04.metadata.lumithinkResult, { version: 1, outputSuppressedAfterCancel: true, answerComplete: false });
  assert.equal(t04.artifacts[0].parts[0].text, ev01.artifact.parts[0].text, "suppressed snapshot keeps only delivered chunk 1");
});

test("05/06 JSON-RPC envelopes: PascalCase methods, task oneof, no append/lastChunk on artifacts", () => {
  const req = load("05-message-send-request.json");
  assert.equal(req.jsonrpc, "2.0");
  assert.equal(req.method, "SendMessage", "v1.0.1 JSON-RPC uses PascalCase method names");
  assert.equal(req.params.message.role, "ROLE_USER");
  assert.ok(req.params.message.messageId);

  const res = load("06-message-send-response.json");
  assert.equal(res.jsonrpc, "2.0");
  assert.deepEqual(Object.keys(res.result), ["task"], "result must carry the task oneof only (Task-only policy)");
  const task = res.result.task;
  assert.equal(task.id, "task-example");
  assert.equal(task.contextId, "ctx-example");
  assert.equal(task.status.state, "TASK_STATE_COMPLETED");
  assert.equal(task.artifacts[0].parts.map((p: any) => p.text).join(""), "你好。我们开始吧。");
  for (const artifact of task.artifacts) {
    assert.ok(!("append" in artifact) && !("lastChunk" in artifact), "snapshot artifact must not carry append/lastChunk");
  }
  // The t03 snapshot aggregates into a single text part (application contract);
  // the SDK default store keeps appended parts — both are acceptable wire
  // forms, so 06 keeps the raw two-part shape from the official SDK run.
  const t03 = load("03-completed-task.json");
  assert.equal(task.artifacts[0].parts.map((p: any) => p.text).join(""), t03.artifacts[0].parts[0].text);
});

test("07 SSE envelope: data: JSON-RPC frames, task first, artifact events, proto3 default omission", () => {
  const raw = readFileSync(path.join(FIXTURES_DIR, "07-message-stream-sse.txt"), "utf8");
  const frames = raw
    .split(/\n\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      assert.ok(line.startsWith("data: "), `every SSE frame must be a data: line, got ${line.slice(0, 20)}`);
      return JSON.parse(line.slice("data: ".length));
    });

  assert.equal(frames.length, 4);
  for (const frame of frames) {
    assert.equal(frame.jsonrpc, "2.0");
    assert.ok("result" in frame && !("error" in frame), "stream frames are success responses");
  }
  const kinds = frames.map((f) => Object.keys(f.result).filter((k) => k !== "jsonrpc" && k !== "id"));
  assert.deepEqual(kinds, [["task"], ["artifactUpdate"], ["artifactUpdate"], ["statusUpdate"]]);

  const [first, chunk1Frame, chunk2Frame, terminal] = frames;
  assert.equal(first.result.task.id, "task-example");
  assert.equal(first.result.task.status.state, "TASK_STATE_SUBMITTED");

  const ev01 = load("01-artifact-event.json");
  const ev02 = load("02-artifact-event.json");
  assert.equal("append" in chunk1Frame.result.artifactUpdate ? chunk1Frame.result.artifactUpdate.append : false, false);
  assert.ok(!("append" in chunk1Frame.result.artifactUpdate), "official codec omits append:false (proto3 default) on the wire");
  assert.equal(chunk2Frame.result.artifactUpdate.append, true);
  assert.equal(chunk2Frame.result.artifactUpdate.lastChunk, true);
  for (const frame of [chunk1Frame, chunk2Frame]) {
    const upd = frame.result.artifactUpdate;
    assert.ok(!("append" in upd.artifact) && !("lastChunk" in upd.artifact), "wire artifact never carries append/lastChunk");
  }
  const meta1 = chunk1Frame.result.artifactUpdate.metadata.lumithinkOutput;
  const meta2 = chunk2Frame.result.artifactUpdate.metadata.lumithinkOutput;
  assert.deepEqual(meta1, ev01.metadata.lumithinkOutput, "chunk-1 digest/range must match fixture 01");
  assert.deepEqual(meta2, ev02.metadata.lumithinkOutput, "chunk-2 digest/range must match fixture 02");
  assert.equal(terminal.result.statusUpdate.status.state, "TASK_STATE_COMPLETED");
});

test("08–12 standard error envelopes match the frozen A2A error table", () => {
  const expected: Array<{ file: string; code: number; reason: string }> = [
    { file: "08-error-cancel-completed.json", code: -32002, reason: "TASK_NOT_CANCELABLE" },
    { file: "10-error-subscribe-terminal.json", code: -32004, reason: "UNSUPPORTED_OPERATION" },
    { file: "11-error-task-not-found.json", code: -32001, reason: "TASK_NOT_FOUND" },
  ];
  for (const { file, code, reason } of expected) {
    const doc = load(file);
    assert.equal(doc.jsonrpc, "2.0");
    assert.equal(doc.error.code, code, `${file}: JSON-RPC code`);
    assert.equal(doc.error.data[0].reason, reason, `${file}: ErrorInfo reason`);
    assert.equal(doc.error.data[0].domain, "a2a-protocol.org");
    assert.ok(doc.error.message.length > 0);
  }

  const idempotent = load("09-cancel-canceled-idempotent.json");
  assert.equal(idempotent.jsonrpc, "2.0");
  assert.ok(idempotent.result && !("error" in idempotent), "duplicate CancelTask on CANCELED is idempotent success");
  assert.equal(idempotent.result.status.state, "TASK_STATE_CANCELED");

  const version = load("12-error-version-not-supported.json");
  assert.equal(version.variants.unsupportedVersionHeader.error.code, -32009);
  assert.equal(version.variants.missingVersionHeader.error.code, -32009);
  for (const key of ["unsupportedVersionHeader", "missingVersionHeader"]) {
    assert.equal(version.variants[key].error.data[0].reason, "VERSION_NOT_SUPPORTED");
  }
});

test("fixture files stay JSON-parseable with no sensitive content markers", () => {
  const files = [
    "01-artifact-event.json",
    "02-artifact-event.json",
    "03-completed-task.json",
    "04-completed-suppressed-task.json",
    "05-message-send-request.json",
    "06-message-send-response.json",
    "08-error-cancel-completed.json",
    "09-cancel-canceled-idempotent.json",
    "10-error-subscribe-terminal.json",
    "11-error-task-not-found.json",
    "12-error-version-not-supported.json",
  ];
  for (const file of files) {
    const parsed = load(file);
    assert.ok(parsed && typeof parsed === "object", `${file} must parse as JSON`);
    const raw = readFileSync(path.join(FIXTURES_DIR, file), "utf8");
    for (const marker of ["Bearer ", "api_key", "apiKey", "token:", "password", "BEGIN PRIVATE KEY"]) {
      assert.ok(!raw.includes(marker), `${file} must not contain credential-like markers (${marker})`);
    }
  }
});
