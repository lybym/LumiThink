/**
 * R1-V2 `lumi-dsh-runtime-bridge` Cordis Profile contract (issue #29 实现
 * 范围 1/6; docs/VOICE_RUNTIME.md §8; docs/adr/0002-voice-runtime-bridge.md).
 *
 * The Bridge runs its OWN minimal-permission Cordis Profile. It must never
 * silently reuse the R0 `lumithink-child` profile, the official default
 * `sdk`/`sdk-minimal` profiles, or anything else: the profile id, pinned
 * upstream version, composition-tree whitelist, telemetry/session-log
 * switches and egress destinations are all validated FAIL-CLOSED here.
 *
 * Single source of truth for tools stays the R1-15 `SAFE_TOOL_REGISTRY` via
 * `../../runtime/cordis.ts` — the bridge whitelist is DERIVED from it, so a
 * tool can never be bridge-advertised but unregistered, and the R0 zero-skip
 * security baseline (35/35 PASS, 0 SKIP) is untouched by construction.
 *
 * This module must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { ContractValidationError, problem, type ContractProblem } from "../../contract/core.ts";
import { ingestDomainFact } from "../../legacy-guard.ts";
import {
  assertAdvertisedToolsWithinWhitelist,
  CORDIS_SERVICE_WHITELIST,
} from "../../runtime/cordis.ts";

// ---------------------------------------------------------------------------
// Identity (locked upstream; VOICE_RUNTIME.md §1 fact table)
// ---------------------------------------------------------------------------

/** The pinned upstream DSH version the Bridge binds to. */
export const BRIDGE_DSH_VERSION = "dsh-v0.2.0-rc.2" as const;

/** The bridge's own profile id — never an alias of any other profile. */
export const BRIDGE_PROFILE_ID = "lumi-dsh-runtime-bridge" as const;

/**
 * Profile ids the bridge profile is FORBIDDEN from reusing or aliasing:
 * the R0 synthetic PoC profile, the official defaults and any wildcard.
 */
export const BRIDGE_FORBIDDEN_PROFILE_IDS = Object.freeze([
  "lumithink-child",
  "sdk",
  "sdk-minimal",
  "*",
] as const);

/**
 * The runtime that owns AgentHandles for voice sessions. The bridge is the
 * ONLY owner; no SDK Server or side channel may create agents for the same
 * session (issue #29 实现范围 1).
 */
export const BRIDGE_OWNERSHIP_MODE = "bridge_exclusive" as const;

// ---------------------------------------------------------------------------
// Composition-tree whitelist (derived, never hand-maintained)
// ---------------------------------------------------------------------------

/**
 * The exact composition-tree whitelist for the bridge profile, derived
 * from `CORDIS_SERVICE_WHITELIST` (single source of truth:
 * `SAFE_TOOL_REGISTRY`, in registry id spelling). Frozen; tests assert
 * the derivation identity.
 */
export function describeBridgeProfileTools(): readonly string[] {
  return CORDIS_SERVICE_WHITELIST;
}

/**
 * Validate an advertised composition tree against the bridge whitelist.
 * Any unknown tool name is a violation (fail closed); the returned list is
 * diagnostic evidence only (unknown names are echoed `[unverified]` when
 * they cannot be registry ids by grammar).
 */
export function assertBridgeAdvertisedToolsWithinWhitelist(
  advertised: readonly { readonly name: unknown; readonly description: unknown }[],
): readonly string[] {
  return assertAdvertisedToolsWithinWhitelist(advertised);
}

// ---------------------------------------------------------------------------
// Telemetry / session log / egress switches (issue #29 实现范围 6)
// ---------------------------------------------------------------------------

/** The ONLY accepted switch value for privacy-critical profile fields. */
export const BRIDGE_SWITCH_OFF = "off" as const;

/**
 * Privacy-critical switches that must be exactly "off" for the bridge
 * profile: default telemetry, DSH session logs and crash reporting must
 * never ship child-adjacent runtime content anywhere.
 */
export const BRIDGE_PRIVACY_SWITCHES = Object.freeze([
  "telemetry",
  "sessionLog",
  "crashReporting",
] as const);

export type BridgePrivacySwitch = (typeof BRIDGE_PRIVACY_SWITCHES)[number];

/**
 * Egress destinations the bridge runtime may contact: loopback only (the
 * synthetic mock model route). Anything else — including any public model,
 * telemetry or OTA endpoint — is a violation (issue #29: 未经授权网络外发 0;
 * 默认上传 0).
 */
export const BRIDGE_ALLOWED_EGRESS_DESTINATIONS = Object.freeze(["127.0.0.1"] as const);

export const BRIDGE_EGRESS_POLICY = "loopback_only" as const;

// ---------------------------------------------------------------------------
// Profile shape + fail-closed validation
// ---------------------------------------------------------------------------

/** The validated bridge profile document (content-free by construction). */
export interface BridgeCordisProfile {
  readonly profileId: typeof BRIDGE_PROFILE_ID;
  readonly dshVersion: typeof BRIDGE_DSH_VERSION;
  readonly ownership: typeof BRIDGE_OWNERSHIP_MODE;
  readonly tools: readonly string[];
  readonly switches: Readonly<Record<BridgePrivacySwitch, typeof BRIDGE_SWITCH_OFF>>;
  readonly egress: {
    readonly policy: typeof BRIDGE_EGRESS_POLICY;
    readonly destinations: readonly string[];
  };
}

/** Parse failures raise one structured problem list (never partial data). */
export function validateBridgeProfile(raw: unknown): Readonly<BridgeCordisProfile> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "profile", "bridge profile must be an object."),
    ]);
  }
  const record = raw as Record<string, unknown>;
  const problems: ContractProblem[] = [];

  // profileId: exactly the bridge id — never an alias of a forbidden id.
  if (record.profileId !== BRIDGE_PROFILE_ID) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "profile.profileId",
        "the bridge profile must declare exactly the lumi-dsh-runtime-bridge id.",
      ),
    );
  }

  // dshVersion: the pinned upstream tag, nothing else.
  if (record.dshVersion !== BRIDGE_DSH_VERSION) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "profile.dshVersion",
        "the bridge profile must pin the locked upstream version.",
      ),
    );
  }

  // ownership: bridge-exclusive agent lifecycle.
  if (record.ownership !== BRIDGE_OWNERSHIP_MODE) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "profile.ownership",
        "the bridge profile must declare bridge_exclusive agent ownership.",
      ),
    );
  }

  // tools: the derived whitelist, identity-checked, nothing else.
  if (!Array.isArray(record.tools)) {
    problems.push(problem("CONTRACT_FIELD_MISSING", "profile.tools", "profile.tools is required."));
  } else {
    const whitelist = describeBridgeProfileTools();
    const advertised = (record.tools as unknown[]).map((name) => ({ name, description: "" }));
    const violations = assertAdvertisedToolsWithinWhitelist(advertised);
    if (violations.length > 0) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          "profile.tools",
          "profile.tools advertises tools outside the whitelist.",
        ),
      );
    }
    const declared = [...(record.tools as unknown[]).filter((t): t is string => typeof t === "string")].sort();
    const expected = [...whitelist].sort();
    if (declared.length !== expected.length || declared.some((name, i) => name !== expected[i])) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          "profile.tools",
          "profile.tools must be exactly the derived bridge whitelist.",
        ),
      );
    }
  }

  // switches: every privacy-critical switch exactly "off".
  if (record.switches === null || typeof record.switches !== "object" || Array.isArray(record.switches)) {
    problems.push(problem("CONTRACT_FIELD_MISSING", "profile.switches", "profile.switches is required."));
  } else {
    const switches = record.switches as Record<string, unknown>;
    for (const name of BRIDGE_PRIVACY_SWITCHES) {
      if (switches[name] !== BRIDGE_SWITCH_OFF) {
        problems.push(
          problem(
            "CONTRACT_FIELD_INVALID",
            `profile.switches.${name}`,
            "privacy-critical switches must be exactly off.",
          ),
        );
      }
    }
    const known = new Set<string>(BRIDGE_PRIVACY_SWITCHES);
    for (const key of Object.keys(switches)) {
      if (!known.has(key)) {
        problems.push(
          problem("CONTRACT_FIELD_INVALID", `profile.switches.${key}`, "unknown profile switch."),
        );
      }
    }
  }

  // egress: loopback-only policy with the exact allow-list.
  if (record.egress === null || typeof record.egress !== "object" || Array.isArray(record.egress)) {
    problems.push(problem("CONTRACT_FIELD_MISSING", "profile.egress", "profile.egress is required."));
  } else {
    const egress = record.egress as Record<string, unknown>;
    if (egress.policy !== BRIDGE_EGRESS_POLICY) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          "profile.egress.policy",
          "egress policy must be loopback_only.",
        ),
      );
    }
    if (
      !Array.isArray(egress.destinations) ||
      (egress.destinations as unknown[]).length !== BRIDGE_ALLOWED_EGRESS_DESTINATIONS.length ||
      (egress.destinations as unknown[]).some((d) => !(BRIDGE_ALLOWED_EGRESS_DESTINATIONS as readonly string[]).includes(d as string))
    ) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          "profile.egress.destinations",
          "egress destinations must be exactly the loopback allow-list.",
        ),
      );
    }
  }

  const knownFields = new Set(["profileId", "dshVersion", "ownership", "tools", "switches", "egress"]);
  for (const key of Object.keys(record)) {
    if (!knownFields.has(key)) {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", `profile.${key}`, "bridge profile carries an unknown field."),
      );
    }
  }

  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }

  return ingestDomainFact({
    profileId: BRIDGE_PROFILE_ID,
    dshVersion: BRIDGE_DSH_VERSION,
    ownership: BRIDGE_OWNERSHIP_MODE,
    tools: Object.freeze([...describeBridgeProfileTools()]),
    switches: Object.freeze({
      telemetry: BRIDGE_SWITCH_OFF,
      sessionLog: BRIDGE_SWITCH_OFF,
      crashReporting: BRIDGE_SWITCH_OFF,
    }),
    egress: Object.freeze({
      policy: BRIDGE_EGRESS_POLICY,
      destinations: Object.freeze([...BRIDGE_ALLOWED_EGRESS_DESTINATIONS]),
    }),
  }) as Readonly<BridgeCordisProfile>;
}

/** The canonical valid profile (used by the runtime and positive tests). */
export function canonicalBridgeProfile(): Readonly<BridgeCordisProfile> {
  return validateBridgeProfile({
    profileId: BRIDGE_PROFILE_ID,
    dshVersion: BRIDGE_DSH_VERSION,
    ownership: BRIDGE_OWNERSHIP_MODE,
    tools: [...describeBridgeProfileTools()],
    switches: {
      telemetry: BRIDGE_SWITCH_OFF,
      sessionLog: BRIDGE_SWITCH_OFF,
      crashReporting: BRIDGE_SWITCH_OFF,
    },
    egress: {
      policy: BRIDGE_EGRESS_POLICY,
      destinations: [...BRIDGE_ALLOWED_EGRESS_DESTINATIONS],
    },
  });
}
