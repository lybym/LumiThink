/**
 * R1-08 encrypted snapshot store tests (issue #20 交付范围 5). Encryption at
 * rest is mandatory, writes are atomic, and every failure mode (wrong key,
 * tampering, truncation, bad magic) fails closed without echoing plaintext.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SNAPSHOT_FILE_MAGIC,
  SnapshotStoreError,
  decryptSnapshotBuffer,
  encryptSnapshotBuffer,
  readSnapshotFile,
  readSnapshotFileSync,
  readSnapshotKeyFileSync,
  snapshotFileExists,
  snapshotFileExistsSync,
  writeSnapshotFile,
  writeSnapshotFileSync,
} from "../../lib/server/snapshot/snapshot-store.ts";

const KEY_A = "11".repeat(32);
const KEY_B = "22".repeat(32);
const PAYLOAD = JSON.stringify({ format: "lumithink.runtime-snapshot/v1", counts: { conversations: 1 } });

test("the snapshot frame carries the magic, a fresh IV and authenticates the plaintext", () => {
  const frame = encryptSnapshotBuffer(PAYLOAD, KEY_A);
  const magic = Buffer.from(SNAPSHOT_FILE_MAGIC, "utf8");
  assert.ok(frame.subarray(0, magic.length).equals(magic));
  assert.ok(frame.length > magic.length + 12 + 16);
  // Same plaintext encrypts to different ciphertext (random IV).
  const frame2 = encryptSnapshotBuffer(PAYLOAD, KEY_A);
  assert.ok(!frame.equals(frame2));
  assert.equal(decryptSnapshotBuffer(frame, KEY_A), PAYLOAD);
});

test("wrong keys, tampering and truncation fail closed without echoing plaintext", () => {
  const frame = encryptSnapshotBuffer(PAYLOAD, KEY_A);
  assert.throws(() => decryptSnapshotBuffer(frame, KEY_B), (error: unknown) => {
    assert.ok(error instanceof SnapshotStoreError);
    assert.equal(error.reason, "auth_failed");
    return true;
  });
  const tampered = Buffer.from(frame);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => decryptSnapshotBuffer(tampered, KEY_A), SnapshotStoreError);
  assert.throws(() => decryptSnapshotBuffer(frame.subarray(0, 10), KEY_A), (error: unknown) => {
    assert.ok(error instanceof SnapshotStoreError);
    assert.equal(error.reason, "truncated");
    return true;
  });
  assert.throws(
    () => decryptSnapshotBuffer(Buffer.alloc(64, 7), KEY_A),
    (error: unknown) => {
      assert.ok(error instanceof SnapshotStoreError);
      assert.equal(error.reason, "bad_magic");
      return true;
    },
  );
  // Malformed keys never reach the cipher.
  assert.throws(() => encryptSnapshotBuffer(PAYLOAD, "zz"), (error: unknown) => {
    assert.ok(error instanceof SnapshotStoreError);
    assert.equal(error.reason, "bad_key");
    return true;
  });
});

test("atomic file writes round-trip and reject stale temp files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lumithink-snap-"));
  try {
    const path = join(dir, "nested", "snapshot.bin");
    assert.equal(await snapshotFileExists(path), false);
    await writeSnapshotFile(path, PAYLOAD, KEY_A);
    assert.equal(await snapshotFileExists(path), true);
    assert.equal(await readSnapshotFile(path, KEY_A), PAYLOAD);
    // On-disk bytes are ciphertext: the plaintext marker must not appear.
    const onDisk = readFileSync(path, "utf8");
    assert.equal(onDisk.includes("runtime-snapshot"), false);

    assert.equal(snapshotFileExistsSync(path), true);
    writeSnapshotFileSync(path, PAYLOAD, KEY_A);
    assert.equal(readSnapshotFileSync(path, KEY_A), PAYLOAD);
    // The atomic write leaves no temp file behind.
    assert.equal(existsSync(`${path}.tmp`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the key file must contain exactly the 64 hex chars", () => {
  const dir = mkdtempSync(join(tmpdir(), "lumithink-key-"));
  try {
    const good = join(dir, "snapshot.key");
    writeFileSync(good, `${KEY_A}\n`, "utf8");
    assert.equal(readSnapshotKeyFileSync(good), KEY_A);
    const bad = join(dir, "bad.key");
    writeFileSync(bad, "too-short", "utf8");
    assert.throws(() => readSnapshotKeyFileSync(bad), (error: unknown) => {
      assert.ok(error instanceof SnapshotStoreError);
      assert.equal(error.reason, "bad_key_file");
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
