/**
 * Deterministic helpers for the R1-V1 voice orchestrator tests
 * (issue #28: 确定性竞态调度和随机种子重放).
 *
 * Everything here is PURE and seeded: no real time, no Math.random, no
 * child content — only ids, hex digests of synthetic payloads and a
 * reproducible PRNG.
 */

import { canonicalJson } from "../../../lib/domain/contract/core.ts";

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) — same seed, same sequence, every run.
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic integer in [0, n). */
export function randomInt(rng: () => number, n: number): number {
  return Math.floor(rng() * n);
}

/** Pick one element deterministically. */
export function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[randomInt(rng, items.length)] as T;
}

// ---------------------------------------------------------------------------
// Deterministic virtual clock: every call advances exactly 1 ms, so the
// whole scenario (and its audit timeline) is a pure function of the seed.
// ---------------------------------------------------------------------------

export function createVirtualClock(startMs = 1_000): { readonly now: () => number; readonly peek: () => number } {
  let nowMs = startMs;
  return {
    now: () => {
      nowMs += 1;
      return nowMs;
    },
    peek: () => nowMs,
  };
}

// ---------------------------------------------------------------------------
// Deterministic ids (contract grammars) and synthetic payload fingerprints.
// ---------------------------------------------------------------------------

export function testSessionKey(index: number): string {
  return `ses_race${index.toString().padStart(8, "0")}`;
}

export function testActorId(index: number): string {
  return `act_owner${index.toString().padStart(8, "0")}`;
}

export function testConversationId(index: number): string {
  return `conv_conv${index.toString().padStart(8, "0")}`;
}

export function testTraceId(index: number): string {
  return `trc_trace${index.toString().padStart(8, "0")}`;
}

/** Deterministic orchestrator turn-id factory (globally unique per test). */
export function createTurnIdFactory(startAt = 0): () => string {
  let n = startAt;
  return () => {
    n += 1;
    return `trn_${n.toString().padStart(12, "0")}`;
  };
}

/** Deterministic TTS item ids. */
export function createTtsItemIdFactory(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `tts_item${n.toString().padStart(10, "0")}`;
  };
}

/**
 * 64-bit FNV-1a over the canonical JSON of a synthetic payload — the same
 * digest discipline as the contract's idempotency fingerprint. The REAL
 * content never enters the orchestrator; only this digest does.
 */
export function syntheticFingerprint(payload: unknown): string {
  const canonical = canonicalJson(payload);
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= BigInt(canonical.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/** Deterministic idempotency key family. */
export function idempotencyKey(index: number): string {
  return `idem-key-${index.toString().padStart(6, "0")}`;
}

// ---------------------------------------------------------------------------
// Canonical snapshot of an audit run (for seed-replay comparison).
// ---------------------------------------------------------------------------

/** Stable JSON of the audit ring: drop seq (ring-relative) and keep atMs. */
export function auditFingerprint(entries: readonly unknown[]): string {
  return syntheticFingerprint(entries);
}
