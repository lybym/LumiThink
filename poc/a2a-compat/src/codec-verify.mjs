/**
 * P0-02 (issue #80) isolated codec verification against the locked official
 * JS SDK @a2a-js/sdk@1.3.0.
 *
 * Proves on the real codec path (SDK fromJSON/toJSON):
 *  - docs/fixtures/a2a-v1.0/01..04 parse and re-encode round-trip;
 *  - append/lastChunk belong to TaskArtifactUpdateEvent, never to Artifact;
 *  - custom metadata (lumithinkOutput / lumithinkContent / lumithinkResult)
 *    survives the official codec;
 *  - UTF-8 half-open byte ranges and per-chunk SHA-256 digests match;
 *  - the two chunk events aggregate to the completed-task snapshot text;
 *  - the cancel-suppressed snapshot carries the frozen result flags.
 *
 * Synthetic data only. No network, no services, no credentials.
 */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Task, TaskArtifactUpdateEvent, TaskState, Role } from '@a2a-js/sdk';

const FIXTURES_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../docs/fixtures/a2a-v1.0');

const load = (name) => JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));

/** Canonicalize for deep comparison: drop undefined values recursively, sort object keys. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = canonical(value[key]);
    }
    return out;
  }
  return value;
}

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const utf8Len = (text) => Buffer.byteLength(text, 'utf8');
/** Wire form uses `{text}`; the parsed in-memory form wraps it as a oneof `{content: {$case:'text', value}}`. */
const parsedText = (part) => (part.content && part.content.$case === 'text' ? part.content.value : part.text);

const results = [];

const record = (name, detail) => {
  results.push({ name, detail });
  console.log(`PASS ${name} :: ${detail}`);
};

// --- 1) Artifact update events: parse + re-encode round-trip ----------------
const ev01 = load('01-artifact-event.json');
const ev02 = load('02-artifact-event.json');

for (const [name, raw] of [['01-artifact-event.json', ev01], ['02-artifact-event.json', ev02]]) {
  const ev = TaskArtifactUpdateEvent.fromJSON(raw);
  const back = TaskArtifactUpdateEvent.toJSON(ev);

  // ProtoJSON canonical form: the official codec omits scalar fields at their
  // default value (append:false / lastChunk:false) on re-encode. Parsers must
  // treat a missing append/lastChunk as false. Record the omission explicitly,
  // then compare semantics with defaults filled in.
  const filled = { append: back.append ?? false, lastChunk: back.lastChunk ?? false, ...back };
  assert.deepEqual(canonical(filled), canonical(raw), `${name} round-trip mismatch`);
  if (raw.append === false) assert.ok(!('append' in back), 'toJSON omits append:false (proto3 default value)');
  if (raw.lastChunk === false) assert.ok(!('lastChunk' in back), 'toJSON omits lastChunk:false (proto3 default value)');
  if (raw.append === true) assert.equal(back.append, true);
  if (raw.lastChunk === true) assert.equal(back.lastChunk, true);
  record(`${name} fromJSON/toJSON round-trip`, 'semantically equal; proto3 default omission: append/lastChunk false → key absent');

  // append/lastChunk ownership: on the event, never on the artifact.
  assert.equal(typeof ev.append, 'boolean', 'event.append must survive');
  assert.equal(typeof ev.lastChunk, 'boolean', 'event.lastChunk must survive');
  const artifactKeys = Object.keys(back.artifact);
  assert.ok(!artifactKeys.includes('append'), 'artifact must not carry append');
  assert.ok(!artifactKeys.includes('lastChunk'), 'artifact must not carry lastChunk');
  record(`${name} append/lastChunk ownership`, `event fields present; artifact keys = [${artifactKeys.join(', ')}]`);

  // Custom event metadata survives the official codec.
  const meta = back.metadata.lumithinkOutput;
  assert.equal(meta.version, 1);
  assert.equal(typeof meta.chunkId, 'string');
  record(`${name} metadata.lumithinkOutput round-trip`, `chunkId=${meta.chunkId} startByte=${meta.startByte} endByte=${meta.endByte}`);

  // UTF-8 half-open byte range + SHA-256 of the chunk text.
  const text = back.artifact.parts[0].text;
  const bytes = Buffer.from(text, 'utf8');
  assert.ok(meta.endByte > meta.startByte, 'byte range must be non-empty');
  assert.equal(meta.endByte - meta.startByte, bytes.length, `byte range must equal UTF-8 length of chunk (${name})`);
  assert.equal(meta.sha256, sha256(text), `sha256 must match chunk text (${name})`);
  record(`${name} byte-range + sha256`, `utf8 bytes=${bytes.length} range=[${meta.startByte},${meta.endByte}) sha256=${meta.sha256.slice(0, 16)}…`);
}

// --- 2) Artifact-level metadata (stable content attributes) -----------------
assert.deepEqual(canonical(ev01.artifact.metadata), canonical(ev02.artifact.metadata),
  'both chunk events must carry the same stable artifact metadata');
assert.equal(ev01.artifact.metadata.lumithinkContent.category, 'admitted-answer');
record('artifact.metadata.lumithinkContent stability', 'identical stable content attributes on both chunk events');

// --- 3) Append semantics: chunk 1 + chunk 2 == completed snapshot text ------
const fullText = ev01.artifact.parts[0].text + ev02.artifact.parts[0].text;
assert.equal(ev02.metadata.lumithinkOutput.startByte, utf8Len(ev01.artifact.parts[0].text),
  'chunk 2 startByte must continue chunk 1');
assert.equal(ev02.metadata.lumithinkOutput.endByte, utf8Len(fullText),
  'chunk 2 endByte must be the cumulative UTF-8 length');
assert.equal(ev01.append, false, 'first chunk is not append');
assert.equal(ev02.append, true, 'second chunk appends');
assert.equal(ev02.lastChunk, true, 'second chunk ends the artifact');
record('append/lastChunk chunk semantics', `chunk1=append:false,lastChunk:false chunk2=append:true,lastChunk:true fullText="${fullText}" (${utf8Len(fullText)} utf8 bytes)`);

// --- 4) Completed task snapshot: parse + re-encode round-trip ---------------
const task03 = load('03-completed-task.json');
const t3 = Task.fromJSON(task03);
const t3back = canonical(Task.toJSON(t3));
assert.deepEqual(t3back, canonical(task03), '03-completed-task.json round-trip mismatch');
assert.equal(t3.status.state, TaskState.TASK_STATE_COMPLETED, 'fromJSON parses enum numerically; toJSON re-emits TASK_STATE_COMPLETED');
assert.equal(parsedText(t3.artifacts[0].parts[0]), fullText, 'snapshot text must equal aggregated chunk text');
assert.ok(!('append' in t3back.artifacts[0]) && !('lastChunk' in t3back.artifacts[0]),
  'task snapshot artifact must not carry append/lastChunk');
assert.deepEqual(canonical(t3back.artifacts[0].metadata), canonical(task03.artifacts[0].metadata),
  'artifact metadata round-trips into the snapshot');
const res03 = t3back.metadata.lumithinkResult;
assert.deepEqual(res03, { version: 1, outputSuppressedAfterCancel: false, answerComplete: true });
record('03-completed-task.json round-trip', `state=TASK_STATE_COMPLETED snapshot text="${fullText}" lumithinkResult=${JSON.stringify(res03)}`);

// --- 5) Cancel-suppressed snapshot: parse + flags ----------------------------
const task04 = load('04-completed-suppressed-task.json');
const t4 = Task.fromJSON(task04);
const t4back = canonical(Task.toJSON(t4));
assert.deepEqual(t4back, canonical(task04), '04-completed-suppressed-task.json round-trip mismatch');
assert.equal(t4.status.state, TaskState.TASK_STATE_COMPLETED, 'terminal state stays COMPLETED (no custom state added)');
assert.equal(t4.status.message.role, Role.ROLE_AGENT);
const res04 = t4back.metadata.lumithinkResult;
assert.deepEqual(res04, { version: 1, outputSuppressedAfterCancel: true, answerComplete: false });
assert.equal(t4back.artifacts[0].parts[0].text, ev01.artifact.parts[0].text,
  'suppressed snapshot keeps only the first delivered chunk');
record('04-completed-suppressed-task.json round-trip', `lumithinkResult=${JSON.stringify(res04)} statusMessage="${t4back.status.message.parts[0].text}"`);

// --- 6) Enum surface: no CANCELLING state in the locked codec ---------------
const stateNames = Object.values(TaskState).filter((v) => typeof v === 'string');
assert.ok(!stateNames.includes('TASK_STATE_CANCELLING'), 'v1.0.1 has no CANCELLING task state');
record('TaskState enum surface', stateNames.filter((v) => v.startsWith('TASK_STATE_')).join(', '));

console.log(`\nCODEC VERIFY OK: ${results.length} checks passed (locked @a2a-js/sdk@1.3.0, fixtures ${FIXTURES_DIR})`);
export { results };
