/**
 * R1-08 secrets registry (issue #20; 交付范围 3 "Secret 从环境/受控挂载注入，
 * 不写 Git/普通日志；模型 API、DSH Profile、外发目标可列举并最小授权").
 *
 * One server-side registry owns the ENUMERATION of every secret slot this
 * deployment understands plus the REDACTION capability that keeps registered
 * secret VALUES out of ordinary logs, audits and error text:
 *
 * - ENUMERATION: every slot is declared with its structural facts — id,
 *   injection source (environment variable / controlled mount), purpose and
 *   the least-privilege scope the credential may be used for. `describeSlots`
 *   returns presence booleans + short SHA-256 fingerprints only; a raw value
 *   is never returned by any method of this module (tested).
 * - REDACTION: `redact(text)` replaces every occurrence of any registered
 *   raw value with `[REDACTED:<slotId>]`. The composed runtime wires this
 *   into the guardian audit emission path as defense-in-depth, so even a
 *   future free-text field cannot carry a credential into the audit ring.
 * - PRESENCE MODEL: the baseline serves the in-process Mock provider (zero
 *   egress). The model-provider-key / DSH-profile / egress-endpoint slots
 *   therefore report `present: false` until the real-provider activation
 *   (independent data-egress review, issue #14 forward note) registers them;
 *   the registry is the single place that enumeration grows.
 *
 * This module stays framework-free (no next/react/prisma imports); node
 * builtins are limited to node:crypto (fingerprinting).
 */

import { createHash } from "node:crypto";

/** The secret slots of the R1 single-host deployment (issue #20). */
export const SECRET_SLOT_IDS = Object.freeze([
  /** Model provider API key — request-time injection only, never at boot. */
  "model_provider_api_key",
  /** DSH `lumithink-child` profile credential — future SDK binding. */
  "dsh_profile_credential",
  /** Guardian console access code (real credential replaces the demo code). */
  "guardian_access_code",
  /** Independent admin console access code. */
  "admin_access_code",
  /** AES-256-GCM key of the encrypted runtime snapshot. */
  "snapshot_encryption_key",
  /** Outbound (egress) target endpoint of a third-party provider. */
  "egress_target_endpoint",
] as const);

export type SecretSlotId = (typeof SECRET_SLOT_IDS)[number];

export interface SecretSlotDescriptor {
  readonly slotId: SecretSlotId;
  /** Where the value may be injected from (env var name / mount path class). */
  readonly source: string;
  /** What the secret authenticates (structural fact, no value). */
  readonly purpose: string;
  /** The least-privilege scope the credential may be used for. */
  readonly leastPrivilege: string;
}

const SLOT_DESCRIPTORS: Readonly<Record<SecretSlotId, SecretSlotDescriptor>> = Object.freeze({
  model_provider_api_key: {
    slotId: "model_provider_api_key",
    source: "environment (request-time keySource only; never read at startup)",
    purpose: "authenticates the model provider API account for model turns",
    leastPrivilege: "model inference endpoint of the registered provider only",
  },
  dsh_profile_credential: {
    slotId: "dsh_profile_credential",
    source: "environment or controlled mount (future DSH SDK process binding)",
    purpose: "authenticates the lumithink-child DSH profile binding",
    leastPrivilege: "the single whitelisted child profile; no shell, no host filesystem",
  },
  guardian_access_code: {
    slotId: "guardian_access_code",
    source: "environment (LUMITHINK_GUARDIAN_ACCESS_CODE) or controlled mount",
    purpose: "guardian console login of the single family",
    leastPrivilege: "guardian role of the pinned family only; stored server-side as SHA-256 digest",
  },
  admin_access_code: {
    slotId: "admin_access_code",
    source: "environment (LUMITHINK_ADMIN_ACCESS_CODE) or controlled mount",
    purpose: "independent administrator console login",
    leastPrivilege: "read-only supervision role (system actor) of the pinned family",
  },
  snapshot_encryption_key: {
    slotId: "snapshot_encryption_key",
    source: "environment (LUMITHINK_SNAPSHOT_KEY) or controlled mount (LUMITHINK_SNAPSHOT_KEY_FILE)",
    purpose: "AES-256-GCM encryption of the runtime state snapshot at rest",
    leastPrivilege: "decrypt/encrypt of the single snapshot file; no other data key",
  },
  egress_target_endpoint: {
    slotId: "egress_target_endpoint",
    source: "gateway provider registration (explicit baseURL behind the data-egress review)",
    purpose: "the single outbound endpoint a third-party provider may contact",
    leastPrivilege: "one registered host:port per provider; no wildcard egress",
  },
});

/** Short fingerprint of a secret value (last 4 hex of its SHA-256). */
function fingerprint(value: string): string {
  const digest = createHash("sha256").update(value, "utf8").digest("hex");
  return `sha256:…${digest.slice(-4)}`;
}

export interface SecretSlotStatus {
  readonly slotId: SecretSlotId;
  readonly source: string;
  readonly purpose: string;
  readonly leastPrivilege: string;
  /** True when a value is registered in THIS process (never the value). */
  readonly present: boolean;
  /** Short non-reversible fingerprint; null when absent. */
  readonly fingerprint: string | null;
}

export interface SecretsRegistry {
  /** Register one raw secret value for redaction (idempotent per slot). */
  registerValue(slotId: SecretSlotId, value: string): void;
  /** Replace every registered raw value occurrence with `[REDACTED:<slot>]`. */
  redact(text: string): string;
  /** Structural inventory (presence + fingerprints; never values). */
  describeSlots(): readonly SecretSlotStatus[];
}

export function createSecretsRegistry(): SecretsRegistry {
  const values = new Map<SecretSlotId, string>();

  return Object.freeze({
    registerValue(slotId: SecretSlotId, value: string): void {
      if (typeof value !== "string" || value.length === 0) {
        return;
      }
      values.set(slotId, value);
    },

    redact(text: string): string {
      if (typeof text !== "string") {
        return "";
      }
      let redacted = text;
      for (const [slotId, value] of values) {
        if (value.length > 0 && redacted.includes(value)) {
          redacted = redacted.split(value).join(`[REDACTED:${slotId}]`);
        }
      }
      return redacted;
    },

    describeSlots(): readonly SecretSlotStatus[] {
      return SECRET_SLOT_IDS.map((slotId) => {
        const descriptor = SLOT_DESCRIPTORS[slotId];
        const value = values.get(slotId);
        return {
          slotId,
          source: descriptor.source,
          purpose: descriptor.purpose,
          leastPrivilege: descriptor.leastPrivilege,
          present: value !== undefined,
          fingerprint: value === undefined ? null : fingerprint(value),
        };
      });
    },
  });
}
