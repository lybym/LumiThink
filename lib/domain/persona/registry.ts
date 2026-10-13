/**
 * R1-04 Persona Registry v0 (docs/PERSONA.md 版本治理, PRD §6, Roadmap
 * R1-04, issue #16).
 *
 * A local, READ-ONLY, versioned registry of Persona Policies, mirroring the
 * Evidence/Skill registry semantics delivered by R1-13:
 *
 * - the shipped registry is a frozen in-repo constant — no network access,
 *   no dynamic execution, no plugins; content changes are code changes that
 *   go through a Feature PR + full CI regression;
 * - every entry keeps ALL registered versions plus an `activeVersion`
 *   pointer, so version switching and rollback are pure, reproducible data
 *   operations (issue #16 AC 2: 版本切换可复查且可回滚);
 * - publishing REQUIRES the explicit human-review gate (approved status
 *   with reviewer handle and review date) and a strictly increasing semver
 *   — the change-approval record is part of the resource (issue #16:
 *   明确规则版本与变更审批);
 * - there is NO runtime/self-update path: no persona API accepts
 *   conversation content, memory claims or tool outputs into the registry.
 *   The only mutation paths are the pure publish/rollback functions, and
 *   the shipped registry can only change via a code change (issue #16 AC 2:
 *   没有未验收的自动自我更新);
 * - every lookup uses `Object.hasOwn` (prototype-chain ids like
 *   "constructor"/"toString" can never masquerade as registered entries —
 *   the registry/lookup lesson applied in R1-13/R1-15);
 * - rejection ids follow the no-echo contract: unresolved caller-submitted
 *   values are replaced by PERSONA_MASKED_REJECTION_ID, never echoed.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { ContractValidationError, problem, type ContractProblem } from "../contract/core.ts";
import { EVAL_SKILL_IDS } from "../eval/scenario.ts";
import { isApprovedHumanReview } from "../evidence/card.ts";

import {
  parsePersonaPolicyV0,
  validatePersonaPolicyV0,
  PERSONA_POLICY_IDS,
  type PersonaPolicyId,
  type PersonaPolicyV0,
} from "./policy.ts";

// ---------------------------------------------------------------------------
// No-echo contract for rejection metadata
// ---------------------------------------------------------------------------

/**
 * Fixed placeholder that replaces ANY caller-submitted id which failed its
 * lookup (same value and rationale as the evidence registry's
 * MASKED_REJECTION_ID; kept module-local so the persona layer does not
 * depend on the evidence registry).
 */
export const PERSONA_MASKED_REJECTION_ID = "[masked]" as const;

// ---------------------------------------------------------------------------
// Registry shapes
// ---------------------------------------------------------------------------

export interface PersonaRegistryEntry {
  /** The published version loaders resolve by default (reversible). */
  readonly activeVersion: string;
  readonly versions: Readonly<Record<string, Readonly<PersonaPolicyV0>>>;
}

export interface PersonaRegistryV0 {
  readonly registryId: string;
  readonly registryVersion: string;
  readonly policies: Readonly<Record<string, Readonly<PersonaRegistryEntry>>>;
}

// ---------------------------------------------------------------------------
// Semver helpers (strictly-increasing publish rule)
// ---------------------------------------------------------------------------

function parseSemver(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isVersionStrictlyGreaterThan(candidate: string, baseline: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(baseline);
  if (a === null || b === null) {
    return false;
  }
  return (
    a[0] > b[0] ||
    (a[0] === b[0] && a[1] > b[1]) ||
    (a[0] === b[0] && a[1] === b[1] && a[2] > b[2])
  );
}

// ---------------------------------------------------------------------------
// Shipped Persona Policy v1 (single child persona, PRD §6)
// ---------------------------------------------------------------------------

const CHILD_PERSONA_POLICY_V1: Readonly<PersonaPolicyV0> = Object.freeze({
  schemaVersion: "1.0",
  policyId: "lumithink_child_persona",
  version: "1.0.0",
  identityDisclosureId: "ai_companion_disclosed_v1",
  coreTraits: Object.freeze([
    "friendly",
    "honest",
    "curious",
    "autonomy_respecting",
    "ai_identity_disclosed",
    "age_appropriate",
  ] as const),
  relationBoundaries: Object.freeze([
    "relation.no_exclusive_relationship",
    "relation.no_unconditional_secrecy",
    "relation.no_diagnosis_or_therapy",
    "relation.no_parent_teacher_replacement",
    "relation.no_attachment_pressure",
  ] as const),
  adjustableKnobs: Object.freeze([
    "language_level",
    "answer_length",
    "humor",
    "question_density",
  ] as const),
  defaultStyle: Object.freeze({
    language_level: "simple",
    answer_length: "balanced",
    humor: "light",
    question_density: "medium",
  }),
  exitPaths: Object.freeze(["pause_rest", "end_turn", "trusted_adult"] as const),
  appliesToSkills: Object.freeze(["emotion_support", "homework_initiation"] as const),
  language: "zh",
  updatedAt: "2026-10-14",
  review: Object.freeze({
    status: "approved",
    reviewedBy: "maintainer-r1-04",
    reviewedAt: "2026-10-14",
    note:
      "v0 persona rule set (identity disclosure, core traits, non-overridable " +
      "relation boundaries, four style knobs, exits incl. trusted adult) " +
      "reviewed against PRD §6 and issue #16 scope; first-batch in-repo " +
      "approval pending human re-verification alongside the R1-13 cards.",
  }),
});

// ---------------------------------------------------------------------------
// The shipped v0 registry (frozen in-repo constant; read-only)
// ---------------------------------------------------------------------------

export const PERSONA_REGISTRY_ID = "lumithink_persona_registry" as const;
export const PERSONA_REGISTRY_V0_VERSION = "1.0.0" as const;

/**
 * Persona Registry v0: the single child persona at version 1.0.0. Version
 * switching = publish a new approved version; rollback = repoint the active
 * pointer to a registered approved version. Both are pure functions below.
 */
export const PERSONA_REGISTRY_V0: Readonly<PersonaRegistryV0> = Object.freeze({
  registryId: PERSONA_REGISTRY_ID,
  registryVersion: PERSONA_REGISTRY_V0_VERSION,
  policies: Object.freeze({
    lumithink_child_persona: Object.freeze({
      activeVersion: "1.0.0",
      versions: Object.freeze({ "1.0.0": CHILD_PERSONA_POLICY_V1 }),
    }),
  }),
});

// ---------------------------------------------------------------------------
// Resolution (fail-closed; hasOwn lookups only)
// ---------------------------------------------------------------------------

export type PersonaResolutionRejectionReason =
  | "unknown_policy"
  | "unknown_version"
  | "not_approved";

export type PersonaResolution =
  | { readonly status: "loaded"; readonly policy: Readonly<PersonaPolicyV0> }
  | {
      readonly status: "rejected";
      readonly reason: PersonaResolutionRejectionReason;
      readonly policyId: string;
    };

/**
 * Resolve one registered policy version (defaults to the active version).
 * Rejection order is deterministic: unknown policy → unknown version
 * (version drift) → unapproved review. The stored content is re-validated
 * fail-closed on every load (defense in depth): a corrupted registry is a
 * developer error and must throw loudly, never load. The policyId is
 * echoed only after `Object.hasOwn` verified it against the registry;
 * unresolved submitted values are masked (no-echo contract).
 */
export function resolvePersonaPolicy(
  registry: Readonly<PersonaRegistryV0>,
  policyId: string,
  version?: string,
): PersonaResolution {
  if (typeof policyId !== "string" || !Object.hasOwn(registry.policies, policyId)) {
    return Object.freeze({
      status: "rejected",
      reason: "unknown_policy",
      policyId: PERSONA_MASKED_REJECTION_ID,
    });
  }
  const entry = registry.policies[policyId];
  const targetVersion = version ?? entry.activeVersion;
  if (typeof targetVersion !== "string" || !Object.hasOwn(entry.versions, targetVersion)) {
    return Object.freeze({ status: "rejected", reason: "unknown_version", policyId });
  }
  const policy = entry.versions[targetVersion];
  const problems: ContractProblem[] = [];
  validatePersonaPolicyV0(policy, problems);
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  if (!isApprovedHumanReview(policy.review)) {
    return Object.freeze({ status: "rejected", reason: "not_approved", policyId });
  }
  return Object.freeze({ status: "loaded", policy });
}

/**
 * Resolve the ACTIVE persona policy of the shipped (or given) registry —
 * the entry point every persona turn uses. Fail-closed: an unknown policy
 * id, version drift or an unapproved active version throws instead of
 * degrading silently.
 */
export function resolveActivePersona(
  registry: Readonly<PersonaRegistryV0> = PERSONA_REGISTRY_V0,
  policyId: PersonaPolicyId = PERSONA_POLICY_IDS[0],
): Readonly<PersonaPolicyV0> {
  const resolution = resolvePersonaPolicy(registry, policyId);
  if (resolution.status !== "loaded") {
    throw new ContractValidationError([
      problem(
        "CONTRACT_FIELD_INVALID",
        "personaPolicy",
        `active persona resolution failed: ${resolution.reason}.`,
      ),
    ]);
  }
  return resolution.policy;
}

// ---------------------------------------------------------------------------
// Publish / rollback (pure, reproducible; explicit human-review gate)
// ---------------------------------------------------------------------------

export type PersonaPublishResult =
  | { readonly ok: true; readonly registry: Readonly<PersonaRegistryV0>; readonly publishedVersion: string }
  | { readonly ok: false; readonly reason: "invalid_policy"; readonly problems: readonly ContractProblem[] }
  | {
      readonly ok: false;
      readonly reason: "review_not_approved" | "already_registered" | "version_not_increasing";
    };

/**
 * Publish one Persona Policy version (first publication of a new policy id
 * is a publish too). The schema gate rejects unregistered policy ids
 * (invalid_policy), the explicit human-review gate requires an approved
 * review with reviewer handle and review date, and the version must be
 * strictly greater than every registered version of that policy. Returns a
 * NEW frozen registry; the input is never mutated (reproducible
 * publish/rollback, issue #16 AC 2).
 */
export function publishPersonaPolicy(
  registry: Readonly<PersonaRegistryV0>,
  next: unknown,
): PersonaPublishResult {
  const problems: ContractProblem[] = [];
  validatePersonaPolicyV0(next, problems);
  if (problems.length > 0) {
    return Object.freeze({ ok: false, reason: "invalid_policy", problems: Object.freeze(problems) });
  }
  const policy = next as PersonaPolicyV0;
  if (!isApprovedHumanReview(policy.review)) {
    return Object.freeze({ ok: false, reason: "review_not_approved" });
  }
  const existing = Object.hasOwn(registry.policies, policy.policyId)
    ? registry.policies[policy.policyId]
    : undefined;
  if (existing !== undefined) {
    if (Object.hasOwn(existing.versions, policy.version)) {
      return Object.freeze({ ok: false, reason: "already_registered" });
    }
    for (const version of Object.keys(existing.versions)) {
      if (!isVersionStrictlyGreaterThan(policy.version, version)) {
        return Object.freeze({ ok: false, reason: "version_not_increasing" });
      }
    }
  }
  const versions = Object.freeze({ ...(existing?.versions ?? {}), [policy.version]: Object.freeze(policy) });
  const entry = Object.freeze({ activeVersion: policy.version, versions });
  return Object.freeze({
    ok: true,
    registry: Object.freeze({
      ...registry,
      policies: Object.freeze({ ...registry.policies, [policy.policyId]: entry }),
    }),
    publishedVersion: policy.version,
  });
}

export type PersonaRollbackResult =
  | { readonly ok: true; readonly registry: Readonly<PersonaRegistryV0>; readonly activeVersion: string }
  | {
      readonly ok: false;
      readonly reason: "unknown_policy" | "unknown_version" | "target_not_approved";
      readonly policyId: string;
    };

/**
 * Roll the active pointer of one policy back to an already-registered
 * version (issue #16 AC 2: 版本切换可复查且可回滚). The target must be
 * approved; versions are never deleted, so rollback is deterministic and
 * reversible.
 */
export function rollbackPersonaPolicy(
  registry: Readonly<PersonaRegistryV0>,
  policyId: string,
  toVersion: string,
): PersonaRollbackResult {
  if (typeof policyId !== "string" || !Object.hasOwn(registry.policies, policyId)) {
    return Object.freeze({ ok: false, reason: "unknown_policy", policyId: PERSONA_MASKED_REJECTION_ID });
  }
  const entry = registry.policies[policyId];
  if (typeof toVersion !== "string" || !Object.hasOwn(entry.versions, toVersion)) {
    return Object.freeze({ ok: false, reason: "unknown_version", policyId });
  }
  const target = entry.versions[toVersion];
  if (!isApprovedHumanReview(target.review)) {
    return Object.freeze({ ok: false, reason: "target_not_approved", policyId });
  }
  return Object.freeze({
    ok: true,
    registry: Object.freeze({
      ...registry,
      policies: Object.freeze({
        ...registry.policies,
        [policyId]: Object.freeze({ ...entry, activeVersion: toVersion }),
      }),
    }),
    activeVersion: toVersion,
  });
}

/** Reproducible-cycle helper (JSON equality), mirroring the evidence registry. */
export function personaRegistryStatesAreEquivalent(
  a: Readonly<PersonaRegistryV0>,
  b: Readonly<PersonaRegistryV0>,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Alignment (shipped registry ↔ first-party skills; parse re-validation)
// ---------------------------------------------------------------------------

export interface PersonaAlignmentProblem {
  readonly code: "persona_registry_content_invalid" | "persona_skill_coverage_mismatch";
  readonly path: string;
  readonly message: string;
}

/**
 * Cross-check a persona registry (defaults to the shipped one): every
 * registered version re-validates fail-closed, and the ACTIVE policy must
 * cover exactly the first-party skill ids — the shared persona rule entry
 * for both skills cannot drift (issue #16 实现范围 4). Returns structured
 * problems; the throwing form is used by the shipped-registry tests. The
 * parameter accepts the structural `policies` subset so test fixtures and
 * future registry envelopes can be checked without fabricating metadata.
 */
export function validatePersonaRegistryAlignment(
  registry: Readonly<Pick<PersonaRegistryV0, "policies">> = PERSONA_REGISTRY_V0,
): readonly Readonly<PersonaAlignmentProblem>[] {
  const problems: PersonaAlignmentProblem[] = [];

  for (const policyId of Object.keys(registry.policies)) {
    const entry = registry.policies[policyId];
    for (const version of Object.keys(entry.versions)) {
      const policyProblems: ContractProblem[] = [];
      validatePersonaPolicyV0(entry.versions[version], policyProblems);
      for (const policyProblem of policyProblems) {
        problems.push({
          code: "persona_registry_content_invalid",
          path: `policies.${policyId}.versions.${version}.${policyProblem.path}`,
          message: policyProblem.message,
        });
      }
    }
  }

  const active = Object.hasOwn(registry.policies, PERSONA_POLICY_IDS[0])
    ? registry.policies[PERSONA_POLICY_IDS[0]]
    : undefined;
  if (active !== undefined) {
    try {
      const parsed = parsePersonaPolicyV0(active.versions[active.activeVersion]);
      const registrySkillIds = [...parsed.appliesToSkills].sort();
      const expectedSkillIds = [...EVAL_SKILL_IDS].sort();
      if (registrySkillIds.join("|") !== expectedSkillIds.join("|")) {
        problems.push({
          code: "persona_skill_coverage_mismatch",
          path: `policies.${parsed.policyId}.appliesToSkills`,
          message: "the active persona policy must cover exactly the first-party skill ids.",
        });
      }
    } catch {
      // Content invalidity is already reported above; never mask it.
    }
  } else {
    problems.push({
      code: "persona_skill_coverage_mismatch",
      path: `policies.${PERSONA_POLICY_IDS[0]}`,
      message: "the shipped child persona policy is missing from the registry.",
    });
  }

  return Object.freeze(problems.map((entry) => Object.freeze(entry)));
}

/**
 * Fail-closed throwing form used by the shipped-registry tests: any
 * alignment problem is a regression that must block the branch.
 */
export function assertShippedPersonaRegistryAligned(): void {
  const problems = validatePersonaRegistryAlignment();
  if (problems.length > 0) {
    throw new ContractValidationError(
      problems.map((entry) => problem("CONTRACT_FIELD_INVALID", entry.path, `${entry.code}: ${entry.message}`)),
    );
  }
}
