/**
 * R1-08 encrypted runtime-snapshot store (issue #20 交付范围 5: SQLite（或
 * 选定事实源）加密备份/恢复演练).
 *
 * The R1 selected fact source of the single-process deployment is the
 * composed in-process runtime state (TECH_STACK §3 keeps durable domain
 * persistence a separate, future data-modeling decision; prisma schema
 * stays ZERO-DIFF — disclosed). The snapshot subsystem therefore backs up
 * THAT state as one AES-256-GCM-ENCRYPTED file:
 *
 *   file := "LUMITHINK-SNAPSHOT1" || iv(12) || authTag(16) || ciphertext
 *
 * - Encryption is MANDATORY: plaintext snapshot writes do not exist (the
 *   env validation refuses a snapshot path without a key; this store refuses
 *   any key material that is not exactly 64 hex chars).
 * - Writes are ATOMIC (temp file + rename) so a crash mid-write can never
 *   leave a torn snapshot behind.
 * - Failures fail CLOSED: wrong key, tampered file, bad magic or a truncated
 *   buffer raise SnapshotStoreError WITHOUT echoing key material or plaintext.
 *
 * This module stays framework-free (no next/react/prisma imports); node
 * builtins are limited to node:crypto + node:fs/promises (lib/server layer).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const SNAPSHOT_FILE_MAGIC = "LUMITHINK-SNAPSHOT1" as const;

const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SnapshotStoreError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "SnapshotStoreError";
    this.reason = reason;
  }
}

/** Validate + normalize the snapshot key (exactly 64 hex chars → 32 bytes). */
export function parseSnapshotKeyHex(keyHex: string): Buffer {
  if (typeof keyHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new SnapshotStoreError(
      "bad_key",
      "the snapshot key must be exactly 64 hex characters (32 bytes).",
    );
  }
  return Buffer.from(keyHex, "hex");
}

/** Encrypt one UTF-8 plaintext snapshot into the on-disk frame. */
export function encryptSnapshotBuffer(plaintext: string, keyHex: string): Buffer {
  const key = parseSnapshotKeyHex(keyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from(SNAPSHOT_FILE_MAGIC, "utf8"),
    iv,
    tag,
    ciphertext,
  ]);
}

/** Decrypt one on-disk snapshot frame back to its UTF-8 plaintext. */
export function decryptSnapshotBuffer(buffer: Buffer, keyHex: string): string {
  const key = parseSnapshotKeyHex(keyHex);
  const magic = Buffer.from(SNAPSHOT_FILE_MAGIC, "utf8");
  if (buffer.length < magic.length + IV_BYTES + TAG_BYTES) {
    throw new SnapshotStoreError("truncated", "the snapshot file is truncated or not a snapshot frame.");
  }
  if (!buffer.subarray(0, magic.length).equals(magic)) {
    throw new SnapshotStoreError("bad_magic", "the snapshot file does not carry the snapshot frame magic.");
  }
  const iv = buffer.subarray(magic.length, magic.length + IV_BYTES);
  const tag = buffer.subarray(magic.length + IV_BYTES, magic.length + IV_BYTES + TAG_BYTES);
  const ciphertext = buffer.subarray(magic.length + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Authentication failure (wrong key or tampered ciphertext): never echo
    // any recovered bytes.
    throw new SnapshotStoreError(
      "auth_failed",
      "the snapshot file failed authentication (wrong key or modified content).",
    );
  }
}

/** True when the snapshot file exists (missing file = first boot, not an error). */
export async function snapshotFileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

/** Atomically write one encrypted snapshot frame (temp file + rename). */
export async function writeSnapshotFile(
  path: string,
  plaintext: string,
  keyHex: string,
): Promise<void> {
  const frame = encryptSnapshotBuffer(plaintext, keyHex);
  const tmpPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmpPath, frame);
  await rename(tmpPath, path);
}

/** Read + decrypt one snapshot file; returns the UTF-8 plaintext JSON. */
export async function readSnapshotFile(path: string, keyHex: string): Promise<string> {
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch {
    throw new SnapshotStoreError("unreadable", "the snapshot file could not be read.");
  }
  return decryptSnapshotBuffer(buffer, keyHex);
}

// ---------------------------------------------------------------------------
// Synchronous variants — the composition root restores/writes at process boot
// (once per process) and on confirmed mutations; sync keeps getWebMvpRuntime
// non-async so every HTTP route keeps its current shape. Snapshot payloads
// are bounded (KBs), so the boot/mutation cost is negligible.
// ---------------------------------------------------------------------------

/** Sync existence check (missing file = first boot, not an error). */
export function snapshotFileExistsSync(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function writeFrameAtomicSync(path: string, frame: Buffer): void {
  const tmpPath = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(tmpPath, "w");
  try {
    let offset = 0;
    while (offset < frame.length) {
      offset += writeSync(fd, frame, offset, frame.length - offset);
    }
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
}

/** Atomically write one encrypted snapshot frame (sync; boot/mutation path). */
export function writeSnapshotFileSync(path: string, plaintext: string, keyHex: string): void {
  writeFrameAtomicSync(path, encryptSnapshotBuffer(plaintext, keyHex));
}

/**
 * Sync stale temp cleanup before a new write (review P2-1 root-cause fix:
 * an earlier version only DETECTED the debris and threw `stale_tmp`, which
 * bricked EVERY later snapshot write after one torn write, with no
 * self-healing).
 *
 * Safe precondition (single-writer invariant): `${path}.tmp` is created
 * only by a writer that renames it into place immediately after the full
 * frame is written, all writes in this process run fully synchronously on
 * the main thread, and the deployment runs exactly ONE service instance
 * per snapshot path (single systemd unit; runbook §1). A temp file found
 * here therefore can only be debris of a previous interrupted writer
 * (crash between write and rename) — it was never the published snapshot
 * state (only the rename publishes) and the fresh write that follows this
 * cleanup supersedes it. It is removed. Removal failures stay loud: the
 * error propagates to the caller's stderr line and the write is skipped,
 * so a permission problem is observable instead of silently swallowed.
 */
export function cleanupSnapshotTempSync(path: string): void {
  const tmpPath = `${path}.tmp`;
  if (existsSync(tmpPath)) {
    unlinkSync(tmpPath);
  }
}

/** Read + decrypt one snapshot file (sync; boot path). */
export function readSnapshotFileSync(path: string, keyHex: string): string {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    throw new SnapshotStoreError("unreadable", "the snapshot file could not be read.");
  }
  return decryptSnapshotBuffer(buffer, keyHex);
}

/**
 * Read a snapshot key from a controlled mount file (must contain exactly the
 * 64 hex chars; surrounding whitespace is tolerated, anything else fails).
 */
export function readSnapshotKeyFileSync(keyFile: string): string {
  let raw: string;
  try {
    raw = readFileSync(keyFile, "utf8").trim();
  } catch {
    throw new SnapshotStoreError("unreadable", "the snapshot key file could not be read.");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new SnapshotStoreError(
      "bad_key_file",
      "the snapshot key file must contain exactly 64 hex characters (32 bytes).",
    );
  }
  return raw.toLowerCase();
}
