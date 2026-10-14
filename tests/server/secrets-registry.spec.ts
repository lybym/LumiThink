/**
 * R1-08 secrets registry tests (issue #20 交付范围 3). The registry is the
 * single enumeration point of every secret slot and the redaction capability
 * that keeps registered values out of logs/audits — a raw value can never be
 * obtained from the registry (no-echo, tested).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createSecretsRegistry, SECRET_SLOT_IDS } from "../../lib/server/secrets-registry.ts";

const PSEUDO_KEY = "sk-synthetic-pseudo-key-9f8e7d6c5b4a";

test("the registry enumerates every deployment secret slot with least-privilege facts", () => {
  const registry = createSecretsRegistry();
  const slots = registry.describeSlots();
  assert.deepEqual(
    slots.map((slot) => slot.slotId),
    [...SECRET_SLOT_IDS],
  );
  for (const slot of slots) {
    assert.equal(slot.present, false);
    assert.equal(slot.fingerprint, null);
    assert.ok(slot.source.length > 0);
    assert.ok(slot.purpose.length > 0);
    assert.ok(slot.leastPrivilege.length > 0);
  }
  // The model provider key slot must document request-time injection only.
  const modelKey = slots.find((slot) => slot.slotId === "model_provider_api_key");
  assert.ok(modelKey !== undefined);
  assert.match(modelKey.source, /never read at startup/);
});

test("registered values are redacted everywhere and never returned", () => {
  const registry = createSecretsRegistry();
  registry.registerValue("guardian_access_code", PSEUDO_KEY);
  registry.registerValue("snapshot_encryption_key", "a".repeat(64));

  const dirty = `audit detail with ${PSEUDO_KEY} inside and key a${"a".repeat(63)} trailing`;
  const clean = registry.redact(dirty);
  assert.equal(clean.includes(PSEUDO_KEY), false);
  assert.equal(clean.includes("a".repeat(64)), false);
  assert.match(clean, /\[REDACTED:guardian_access_code\]/);
  assert.match(clean, /\[REDACTED:snapshot_encryption_key\]/);

  // The inventory exposes presence + a short fingerprint only.
  const slots = registry.describeSlots();
  const guardianSlot = slots.find((slot) => slot.slotId === "guardian_access_code");
  assert.equal(guardianSlot?.present, true);
  assert.match(guardianSlot?.fingerprint ?? "", /^sha256:…[0-9a-f]{4}$/);
  // The serialized inventory can never carry the raw value.
  assert.equal(JSON.stringify(slots).includes(PSEUDO_KEY), false);
});

test("clean text passes through redaction unchanged and empty registration is a no-op", () => {
  const registry = createSecretsRegistry();
  registry.registerValue("admin_access_code", "");
  const text = "conv=1,hist=2,tomb=0";
  assert.equal(registry.redact(text), text);
});
