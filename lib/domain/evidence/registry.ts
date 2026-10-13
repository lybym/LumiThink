/**
 * R1-13 Skill Registry v0 + Evidence Registry v0 (docs/EVIDENCE_POLICY.md,
 * PRD §8 / FR-010, Roadmap R1-13, issue #25).
 *
 * A local, READ-ONLY, versioned registry pair that binds the two first-party
 * skills (emotion_support, homework_initiation) to their human-reviewed
 * Evidence Cards:
 *
 * - registries are frozen in-repo constants — no network access, no dynamic
 *   execution, no plugins (issue #25: 不引入任意动态执行插件);
 * - every entry keeps ALL registered versions plus an `activeVersion`
 *   pointer, so publishing and rolling back are pure, reproducible data
 *   operations (new frozen registry object in, old one untouched);
 * - the loader fail-closes on unknown evidence ids, unapproved evidence,
 *   version drift, retracted (invalidated) citations and unapproved skills,
 *   and degrades in a controlled way when the child's age is outside the
 *   bound cards' source-population range (issue #25 acceptance criterion 1);
 * - publish REQUIRES the explicit human-review gate (approved status with
 *   reviewer handle and review date) and a strictly increasing semver;
 * - `loadSkillForChild` returns structural facts only (resolved card
 *   versions, limitations, applicability) — every strategy invocation can
 *   output its source version and 适用/限制 (issue #25 acceptance
 *   criterion 2). There is deliberately NO self-reported outcome/pass-fail
 *   API: results live in the eval harness, derived from real turn outputs.
 *
 * Registry lookups use `Object.hasOwn` everywhere (never bare property
 * access), so prototype-chain ids like "constructor"/"toString" can never
 * masquerade as registered entries — the class of bug called out in the
 * approved R1-15 review of SAFE_TOOL_REGISTRY must not recur here.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { ContractValidationError, problem, type ContractProblem } from "../contract/core.ts";
import { SAFE_TOOL_REGISTRY } from "../safety/tool-gate.ts";
import {
  EVAL_SKILL_IDS,
  type EvalEvidenceCard,
  type EvalSkillId,
  type EvalSkillRoute,
  type EvalSuiteFixture,
} from "../eval/scenario.ts";
import { EVAL_SUITE_V1 } from "../eval/fixtures.ts";

import {
  isApprovedHumanReview,
  validateEvidenceCardV0,
  type EvidenceCardV0,
} from "./card.ts";
import { validateSkillManifestV0, type SkillManifestV0 } from "./skill-manifest.ts";

// ---------------------------------------------------------------------------
// Registry shapes (versioned; every entry keeps all published versions)
// ---------------------------------------------------------------------------

export interface EvidenceRegistryEntry {
  /** The published version loaders resolve by default (reversible). */
  readonly activeVersion: string;
  readonly versions: Readonly<Record<string, Readonly<EvidenceCardV0>>>;
}

export interface EvidenceRegistryV0 {
  readonly registryId: string;
  readonly registryVersion: string;
  readonly cards: Readonly<Record<string, Readonly<EvidenceRegistryEntry>>>;
}

export interface SkillRegistryEntry {
  readonly activeVersion: string;
  readonly versions: Readonly<Record<string, Readonly<SkillManifestV0>>>;
}

export interface SkillRegistryV0 {
  readonly registryId: string;
  readonly registryVersion: string;
  readonly skills: Readonly<Record<string, Readonly<SkillRegistryEntry>>>;
}

/** The registry pair a loader resolves against. */
export interface EvidenceAndSkillRegistries {
  readonly skills: Readonly<SkillRegistryV0>;
  readonly evidence: Readonly<EvidenceRegistryV0>;
}

// ---------------------------------------------------------------------------
// Semver helpers (strictly-increasing publish rule, reproducible revisions)
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
// Shipped Evidence Cards (first batch: EEF guidance, human-verified metadata)
// ---------------------------------------------------------------------------

/**
 * v0 cards store CITATION METADATA ONLY (title/publisher/year/URL plus
 * structural scope fields) — never source text excerpts (issue #25: 默认
 * 合成数据测试，不自动抓取受版权保护文本). The citations follow the PRD
 * §8/§10.3 first-batch source list; v0 scope fields (age range, evidence
 * level, edition notes) are conservative human encodings explicitly marked
 * for re-verification in `limitations`.
 */
const EEF_SEL_CARD_V1: Readonly<EvidenceCardV0> = Object.freeze({
  schemaVersion: "1.0",
  cardId: "evd_eef_sel_primary_001",
  version: "1.0.0",
  citation: Object.freeze({
    sourceUrl: "https://educationendowmentfoundation.org.uk/education-evidence/guidance-reports/primary-sel",
    title: "Improving Social and Emotional Learning in Primary Schools",
    publisher: "Education Endowment Foundation",
    year: 2019,
    documentVersion: "guidance report (edition note to re-verify on the source page)",
  }),
  researchDesign: "guidance_synthesis",
  evidenceLevel: "moderate",
  targetAges: Object.freeze({ minAgeYears: 4, maxAgeYears: 11 }),
  subjectsAndContext:
    "Primary-school classrooms and whole-school SEL provision led by teachers " +
    "and school staff; population-level school practice, not AI-delivered intervention.",
  claimedEffects:
    "Guidance-level summary: structured school-based social and emotional learning " +
    "provision is associated with improvements in children's social-emotional skills " +
    "and related outcomes, as assessed by the source guidance synthesis. This card " +
    "makes no claim about AI-agent-delivered support.",
  limitations: Object.freeze([
    "The evidence addresses teacher/school-led practice; it does not establish that " +
      "an AI agent can reproduce these effects for an individual child.",
    "Population-level guidance synthesis; no individual-child effect, diagnosis or " +
      "treatment claim is licensed.",
    "v0 metadata (age range, evidence level, edition note) is a conservative human " +
      "encoding pending re-verification against the cited source page.",
  ]),
  applicableConditions: Object.freeze([
    "Daily, non-clinical emotion recognition and regulation support for " +
      "primary-school-age children",
    "Child is not in the crisis branch and has not requested clinical help",
  ]),
  exclusionConditions: Object.freeze([
    "Crisis or self-harm signals (the deterministic crisis branch takes over)",
    "Clinical, diagnostic or therapeutic requests",
    "Formal mental-health assessment contexts",
  ]),
  aiTransferBoundary: "school_practice_only",
  appliesToSkills: Object.freeze(["emotion_support"] as const),
  sourceStatus: "live",
  updatedAt: "2026-10-14",
  review: Object.freeze({
    status: "approved",
    reviewedBy: "maintainer-r1-13",
    reviewedAt: "2026-10-14",
    note:
      "Citation, scope and extrapolation boundary verified against the PRD §8/§10.3 " +
      "first-batch source list; no source text copied; school-practice-only boundary recorded.",
  }),
  summary:
    "EEF primary SEL guidance synthesis backing daily emotion support; school-practice " +
    "evidence only, no AI-efficacy claim.",
});

const EEF_META_CARD_V1: Readonly<EvidenceCardV0> = Object.freeze({
  schemaVersion: "1.0",
  cardId: "evd_eef_meta_srl_001",
  version: "1.0.0",
  citation: Object.freeze({
    sourceUrl: "https://educationendowmentfoundation.org.uk/education-evidence/guidance-reports/metacognition",
    title: "Metacognition and Self-Regulated Learning",
    publisher: "Education Endowment Foundation",
    year: 2025,
    documentVersion: "2nd edition (2025 revision, per PRD §10.3)",
  }),
  researchDesign: "guidance_synthesis",
  evidenceLevel: "moderate",
  targetAges: Object.freeze({ minAgeYears: 5, maxAgeYears: 16 }),
  subjectsAndContext:
    "School classrooms across primary and secondary phases; metacognitive and " +
    "self-regulation strategies modelled and scaffolded by teachers within subject " +
    "teaching; population-level school practice, not AI-delivered intervention.",
  claimedEffects:
    "Guidance-level summary: explicitly teaching metacognitive and self-regulation " +
    "strategies within subject teaching is associated with measurable learning gains, " +
    "as assessed by the source guidance synthesis. This card makes no claim about " +
    "AI-agent-delivered support.",
  limitations: Object.freeze([
    "The evidence addresses teacher/school-led practice; it does not establish that " +
      "an AI agent can reproduce these effects for an individual child.",
    "Population-level guidance synthesis; no individual-child effect, diagnosis or " +
      "treatment claim is licensed.",
    "v0 metadata (age range, evidence level, edition note) is a conservative human " +
      "encoding pending re-verification against the cited source page.",
  ]),
  applicableConditions: Object.freeze([
    "Difficult-task initiation and study-strategy support within ordinary homework contexts",
    "Child is not in the crisis branch and has not requested clinical help",
  ]),
  exclusionConditions: Object.freeze([
    "Crisis or self-harm signals (the deterministic crisis branch takes over)",
    "Ghostwriting or answer-provision requests (blocked by the output gate)",
    "Clinical or diagnostic requests about learning ability",
  ]),
  aiTransferBoundary: "school_practice_only",
  appliesToSkills: Object.freeze(["homework_initiation"] as const),
  sourceStatus: "live",
  updatedAt: "2026-10-14",
  review: Object.freeze({
    status: "approved",
    reviewedBy: "maintainer-r1-13",
    reviewedAt: "2026-10-14",
    note:
      "Citation, scope and extrapolation boundary verified against the PRD §8/§10.3 " +
      "first-batch source list; no source text copied; school-practice-only boundary recorded.",
  }),
  summary:
    "EEF metacognition/self-regulation guidance synthesis backing homework initiation; " +
    "school-practice evidence only, no AI-efficacy claim.",
});

// ---------------------------------------------------------------------------
// Shipped Skill Manifests (both first-party skills, pinned card versions)
// ---------------------------------------------------------------------------

const EMOTION_SUPPORT_MANIFEST_V1: Readonly<SkillManifestV0> = Object.freeze({
  schemaVersion: "1.0",
  skillId: "emotion_support",
  version: "1.0.0",
  goal:
    "Age-appropriate everyday emotion recognition and regulation support: listen, " +
    "help name feelings, offer a small choice of regulation strategies; never " +
    "clinical treatment or diagnosis.",
  entranceSignals: Object.freeze([
    "child_reports_daily_emotion_distress",
    "child_shares_school_or_friendship_upset",
    "child_asks_for_help_feeling_better",
  ]),
  applicableConditions: Object.freeze([
    "Daily, non-clinical emotion context",
    "Child age covered by the bound evidence card",
  ]),
  disabledConditions: Object.freeze([
    "Crisis signals present (the deterministic crisis branch takes over)",
    "Clinical, therapeutic or diagnosis requests",
    "Child explicitly declines the strategy",
  ]),
  evidenceBindings: Object.freeze([
    Object.freeze({ cardId: "evd_eef_sel_primary_001", cardVersion: "1.0.0" }),
  ]),
  strategySteps: Object.freeze([
    "Listen and reflect the feeling in age-appropriate words",
    "Offer a small, optional choice of regulation strategies within the bound evidence scope",
    "Offer pause/exit and a trusted-adult path; never push continuation",
  ]),
  toolCapabilities: Object.freeze([] as const),
  exitPaths: Object.freeze(["pause_rest", "end_turn", "trusted_adult"] as const),
  efficacyStatement: "no_ai_efficacy_claim",
  evaluationRefs: Object.freeze([
    "emotion.applicable.daily-emotion-001",
    "emotion.not-applicable.factual-question-002",
    "emotion.policy-invalid.diagnosis-003",
    "emotion.refusal.strategy-004",
    "emotion.crisis.suspend-005",
  ]),
  updatedAt: "2026-10-14",
  review: Object.freeze({
    status: "approved",
    reviewedBy: "maintainer-r1-13",
    reviewedAt: "2026-10-14",
    note: "Manifest binds the reviewed EEF SEL card v1.0.0; efficacy statement fixed to no_ai_efficacy_claim.",
  }),
});

const HOMEWORK_INITIATION_MANIFEST_V1: Readonly<SkillManifestV0> = Object.freeze({
  schemaVersion: "1.0",
  skillId: "homework_initiation",
  version: "1.0.0",
  goal:
    "Difficult-task initiation support: clarify the task, confirm the hard part, " +
    "agree one smallest next step, and plan support withdrawal; never ghostwriting.",
  entranceSignals: Object.freeze([
    "child_reports_homework_difficulty",
    "child_avoids_starting_task",
    "child_asks_to_skip_homework",
  ]),
  applicableConditions: Object.freeze([
    "Ordinary homework or learning-task context",
    "Child age covered by the bound evidence card",
  ]),
  disabledConditions: Object.freeze([
    "Crisis signals present (the deterministic crisis branch takes over)",
    "Ghostwriting or answer-provision requests",
    "Child explicitly declines the strategy or wants to stop",
  ]),
  evidenceBindings: Object.freeze([
    Object.freeze({ cardId: "evd_eef_meta_srl_001", cardVersion: "1.0.0" }),
  ]),
  strategySteps: Object.freeze([
    "Clarify the task and confirm the specific hard part",
    "Agree one smallest next step the child chooses",
    "Plan support withdrawal and offer pause/exit; never force continuation",
  ]),
  toolCapabilities: Object.freeze([] as const),
  exitPaths: Object.freeze(["pause_rest", "end_turn", "switch_strategy"] as const),
  efficacyStatement: "no_ai_efficacy_claim",
  evaluationRefs: Object.freeze([
    "homework.applicable.difficulty-001",
    "homework.not-applicable.emotion-first-002",
    "homework.policy-invalid.ghostwriting-003",
    "homework.refusal.strategy-004",
    "homework.crisis.suspend-005",
  ]),
  updatedAt: "2026-10-14",
  review: Object.freeze({
    status: "approved",
    reviewedBy: "maintainer-r1-13",
    reviewedAt: "2026-10-14",
    note: "Manifest binds the reviewed EEF metacognition card v1.0.0; efficacy statement fixed to no_ai_efficacy_claim.",
  }),
});

// ---------------------------------------------------------------------------
// The shipped v0 registries (frozen in-repo constants; read-only)
// ---------------------------------------------------------------------------

export const EVIDENCE_REGISTRY_ID = "lumithink_evidence_registry" as const;
export const SKILL_REGISTRY_ID = "lumithink_skill_registry" as const;
export const REGISTRIES_V0_VERSION = "1.0.0" as const;

/**
 * Evidence Registry v0. Content changes are code changes: they go through a
 * feature PR whose test run re-executes the full eval suite plus the
 * registry alignment checks (issue #25 acceptance criterion 2: 一处人工修订
 * 触发相关 Eval 回归).
 */
export const EVIDENCE_REGISTRY_V0: Readonly<EvidenceRegistryV0> = Object.freeze({
  registryId: EVIDENCE_REGISTRY_ID,
  registryVersion: REGISTRIES_V0_VERSION,
  cards: Object.freeze({
    evd_eef_sel_primary_001: Object.freeze({
      activeVersion: "1.0.0",
      versions: Object.freeze({ "1.0.0": EEF_SEL_CARD_V1 }),
    }),
    evd_eef_meta_srl_001: Object.freeze({
      activeVersion: "1.0.0",
      versions: Object.freeze({ "1.0.0": EEF_META_CARD_V1 }),
    }),
  }),
});

/**
 * Skill Registry v0: both first-party skills at version 1.0.0, each pinning
 * its reviewed Evidence Card version (issue #25: 双 Skill 具备已核验的最小
 * 证据卡并与 Skill 版本关联).
 */
export const SKILL_REGISTRY_V0: Readonly<SkillRegistryV0> = Object.freeze({
  registryId: SKILL_REGISTRY_ID,
  registryVersion: REGISTRIES_V0_VERSION,
  skills: Object.freeze({
    emotion_support: Object.freeze({
      activeVersion: "1.0.0",
      versions: Object.freeze({ "1.0.0": EMOTION_SUPPORT_MANIFEST_V1 }),
    }),
    homework_initiation: Object.freeze({
      activeVersion: "1.0.0",
      versions: Object.freeze({ "1.0.0": HOMEWORK_INITIATION_MANIFEST_V1 }),
    }),
  }),
});

const SHIPPED_REGISTRIES: Readonly<EvidenceAndSkillRegistries> = Object.freeze({
  skills: SKILL_REGISTRY_V0,
  evidence: EVIDENCE_REGISTRY_V0,
});

// ---------------------------------------------------------------------------
// Resolution (fail-closed; hasOwn lookups only)
// ---------------------------------------------------------------------------

export type EvidenceRejectionReason =
  | "unknown_card"
  | "unknown_version"
  | "not_approved"
  | "source_retracted";

export type EvidenceResolution =
  | { readonly status: "loaded"; readonly card: Readonly<EvidenceCardV0> }
  | {
      readonly status: "rejected";
      readonly reason: EvidenceRejectionReason;
      readonly cardId: string;
    };

/**
 * Resolve one registered card version (defaults to the active version).
 * Rejection order is deterministic: unknown card → unknown version (version
 * drift) → card-level citation invalidation (the ACTIVE version marked
 * retracted blocks every load of this card, including older pinned
 * versions) → unapproved review → retracted pinned version. Registry ids
 * are developer-authored keys, so echoing them in the structured rejection
 * is safe; submitted card ids from untrusted callers are matched, never
 * echoed.
 */
export function resolveEvidenceCard(
  registry: Readonly<EvidenceRegistryV0>,
  cardId: string,
  version?: string,
): EvidenceResolution {
  if (typeof cardId !== "string" || !Object.hasOwn(registry.cards, cardId)) {
    return Object.freeze({ status: "rejected", reason: "unknown_card", cardId: typeof cardId === "string" ? cardId : "" });
  }
  const entry = registry.cards[cardId];
  const targetVersion = version ?? entry.activeVersion;
  if (typeof targetVersion !== "string" || !Object.hasOwn(entry.versions, targetVersion)) {
    return Object.freeze({ status: "rejected", reason: "unknown_version", cardId });
  }
  const card = entry.versions[targetVersion];
  // Defense in depth: re-validate the stored card fail-closed. A corrupted
  // registry is a developer error and must throw loudly (tests catch it),
  // never load.
  const problems: ContractProblem[] = [];
  validateEvidenceCardV0(card, problems);
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  // Citation invalidation is a CARD-level fail-closed state: when the active
  // version marks the source retracted, the card can no longer back ANY
  // load — including loads pinned to older versions — until a human
  // publishes a new live version or rolls the active pointer back
  // (issue #25 AC 1 引用失效).
  const activeCard = entry.versions[entry.activeVersion];
  if (activeCard.sourceStatus === "retracted") {
    return Object.freeze({ status: "rejected", reason: "source_retracted", cardId });
  }
  if (!isApprovedHumanReview(card.review)) {
    return Object.freeze({ status: "rejected", reason: "not_approved", cardId });
  }
  if (card.sourceStatus === "retracted") {
    return Object.freeze({ status: "rejected", reason: "source_retracted", cardId });
  }
  return Object.freeze({ status: "loaded", card });
}

export type SkillResolution =
  | { readonly status: "loaded"; readonly manifest: Readonly<SkillManifestV0> }
  | { readonly status: "rejected"; readonly reason: "unknown_skill" | "unknown_version" };

/** Resolve one registered manifest version (defaults to the active version). */
export function resolveSkillManifest(
  registry: Readonly<SkillRegistryV0>,
  skillId: string,
  version?: string,
): SkillResolution {
  if (typeof skillId !== "string" || !Object.hasOwn(registry.skills, skillId)) {
    return Object.freeze({ status: "rejected", reason: "unknown_skill" });
  }
  const entry = registry.skills[skillId];
  const targetVersion = version ?? entry.activeVersion;
  if (typeof targetVersion !== "string" || !Object.hasOwn(entry.versions, targetVersion)) {
    return Object.freeze({ status: "rejected", reason: "unknown_version" });
  }
  const manifest = entry.versions[targetVersion];
  const problems: ContractProblem[] = [];
  validateSkillManifestV0(manifest, problems);
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return Object.freeze({ status: "loaded", manifest });
}

// ---------------------------------------------------------------------------
// Skill loading (issue #25 AC 1: 拒绝或受控降级; AC 2: 来源版本 + 适用/限制)
// ---------------------------------------------------------------------------

export interface ResolvedSkillEvidence {
  readonly cardId: string;
  readonly cardVersion: string;
  readonly card: Readonly<EvidenceCardV0>;
}

export type SkillLoadRejectionReason =
  | "unknown_skill"
  | "skill_not_approved"
  | "evidence_unknown_card"
  | "evidence_version_drift"
  | "evidence_not_approved"
  | "evidence_source_retracted";

export type SkillLoadResult =
  | {
      readonly status: "served";
      readonly skillId: EvalSkillId;
      readonly skillVersion: string;
      readonly manifest: Readonly<SkillManifestV0>;
      readonly evidence: readonly Readonly<ResolvedSkillEvidence>[];
      /** Merged limitations of every bound card (dedup, binding order). */
      readonly limitations: readonly string[];
    }
  | {
      /** Controlled degradation: the conversation continues without the skill. */
      readonly status: "degraded";
      readonly reason: "age_not_applicable";
      readonly skillId: EvalSkillId;
      readonly skillVersion: string;
      readonly detail: readonly Readonly<{
        cardId: string;
        cardVersion: string;
        minAgeYears: number;
        maxAgeYears: number;
      }>[];
    }
  | {
      /** Fail-closed rejection with a structured reason (ids only, no payload). */
      readonly status: "rejected";
      readonly reason: SkillLoadRejectionReason;
      readonly skillId: string;
      readonly detail: readonly string[];
    };

function ageCoveredByCard(childAgeYears: number, card: Readonly<EvidenceCardV0>): boolean {
  return childAgeYears >= card.targetAges.minAgeYears && childAgeYears <= card.targetAges.maxAgeYears;
}

/**
 * Load a skill for one child turn against the registries (defaults to the
 * shipped v0 pair). Resolution order is deterministic: unknown skill →
 * skill review gate → evidence bindings (unknown card / version drift /
 * unapproved / retracted, fail-closed on the first problem) → age
 * applicability of EVERY bound card (controlled degradation when any card
 * does not cover the age). The served result carries each bound card's
 * exact version, citation metadata and limitations so the caller can state
 * the strategy's source version and 适用/限制.
 */
export function loadSkillForChild(
  skillId: unknown,
  childAgeYears: unknown,
  registries: Readonly<EvidenceAndSkillRegistries> = SHIPPED_REGISTRIES,
): SkillLoadResult {
  if (
    typeof childAgeYears !== "number" ||
    !Number.isInteger(childAgeYears) ||
    childAgeYears < 0 ||
    childAgeYears > 25
  ) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "childAgeYears", "expected an integer age between 0 and 25."),
    ]);
  }
  if (typeof skillId !== "string" || !(EVAL_SKILL_IDS as readonly string[]).includes(skillId)) {
    return Object.freeze({
      status: "rejected",
      reason: "unknown_skill",
      skillId: typeof skillId === "string" ? skillId : "",
      detail: Object.freeze([] as string[]),
    });
  }
  const skillResolution = resolveSkillManifest(registries.skills, skillId);
  if (skillResolution.status !== "loaded") {
    return Object.freeze({
      status: "rejected",
      reason: "unknown_skill",
      skillId,
      detail: Object.freeze([] as string[]),
    });
  }
  const manifest = skillResolution.manifest;
  if (!isApprovedHumanReview(manifest.review)) {
    return Object.freeze({
      status: "rejected",
      reason: "skill_not_approved",
      skillId,
      detail: Object.freeze([] as string[]),
    });
  }

  const resolved: ResolvedSkillEvidence[] = [];
  for (const binding of manifest.evidenceBindings) {
    const resolution = resolveEvidenceCard(registries.evidence, binding.cardId, binding.cardVersion);
    if (resolution.status === "rejected") {
      const reasonByResolution: Record<EvidenceRejectionReason, SkillLoadRejectionReason> = {
        unknown_card: "evidence_unknown_card",
        unknown_version: "evidence_version_drift",
        not_approved: "evidence_not_approved",
        source_retracted: "evidence_source_retracted",
      };
      return Object.freeze({
        status: "rejected",
        reason: reasonByResolution[resolution.reason],
        skillId,
        detail: Object.freeze([binding.cardId]),
      });
    }
    resolved.push(Object.freeze({ cardId: binding.cardId, cardVersion: binding.cardVersion, card: resolution.card }));
  }

  const ageFailures = resolved
    .filter((entry) => !ageCoveredByCard(childAgeYears, entry.card))
    .map((entry) =>
      Object.freeze({
        cardId: entry.cardId,
        cardVersion: entry.cardVersion,
        minAgeYears: entry.card.targetAges.minAgeYears,
        maxAgeYears: entry.card.targetAges.maxAgeYears,
      }),
    );
  if (ageFailures.length > 0) {
    return Object.freeze({
      status: "degraded",
      reason: "age_not_applicable",
      skillId: skillId as EvalSkillId,
      skillVersion: manifest.version,
      detail: Object.freeze(ageFailures),
    });
  }

  const limitations: string[] = [];
  for (const entry of resolved) {
    for (const limitation of entry.card.limitations) {
      if (!limitations.includes(limitation)) {
        limitations.push(limitation);
      }
    }
  }
  return Object.freeze({
    status: "served",
    skillId: skillId as EvalSkillId,
    skillVersion: manifest.version,
    manifest,
    evidence: Object.freeze(resolved),
    limitations: Object.freeze(limitations),
  });
}

// ---------------------------------------------------------------------------
// Publish / rollback (pure, reproducible; explicit human-review gate)
// ---------------------------------------------------------------------------

export type EvidencePublishResult =
  | { readonly ok: true; readonly registry: Readonly<EvidenceRegistryV0>; readonly publishedVersion: string }
  | { readonly ok: false; readonly reason: "invalid_card"; readonly problems: readonly ContractProblem[] }
  | {
      readonly ok: false;
      readonly reason: "review_not_approved" | "already_registered" | "version_not_increasing";
    };

/**
 * Publish one Evidence Card version (first publication of a new card id is
 * a publish too). The explicit human-review gate requires an approved
 * review with reviewer handle and review date; the version must be strictly
 * greater than every registered version of that card. Returns a NEW frozen
 * registry; the input is never mutated (reproducible publish/rollback,
 * issue #25 交付范围 5).
 */
export function publishEvidenceCardVersion(
  registry: Readonly<EvidenceRegistryV0>,
  next: unknown,
): EvidencePublishResult {
  const problems: ContractProblem[] = [];
  validateEvidenceCardV0(next, problems);
  if (problems.length > 0) {
    return Object.freeze({ ok: false, reason: "invalid_card", problems: Object.freeze(problems) });
  }
  const card = next as EvidenceCardV0;
  if (!isApprovedHumanReview(card.review)) {
    return Object.freeze({ ok: false, reason: "review_not_approved" });
  }
  const existing = Object.hasOwn(registry.cards, card.cardId) ? registry.cards[card.cardId] : undefined;
  if (existing !== undefined) {
    if (Object.hasOwn(existing.versions, card.version)) {
      return Object.freeze({ ok: false, reason: "already_registered" });
    }
    for (const version of Object.keys(existing.versions)) {
      if (!isVersionStrictlyGreaterThan(card.version, version)) {
        return Object.freeze({ ok: false, reason: "version_not_increasing" });
      }
    }
  }
  const versions = Object.freeze({ ...(existing?.versions ?? {}), [card.version]: Object.freeze(card) });
  const entry = Object.freeze({ activeVersion: card.version, versions });
  return Object.freeze({
    ok: true,
    registry: Object.freeze({
      ...registry,
      cards: Object.freeze({ ...registry.cards, [card.cardId]: entry }),
    }),
    publishedVersion: card.version,
  });
}

export type EvidenceRollbackResult =
  | { readonly ok: true; readonly registry: Readonly<EvidenceRegistryV0>; readonly activeVersion: string }
  | {
      readonly ok: false;
      readonly reason: "unknown_card" | "unknown_version" | "target_not_approved" | "target_source_retracted";
    };

/**
 * Roll the active pointer of one card back to an already-registered
 * version. The target must still be approved and live; versions are never
 * deleted, so rollback is deterministic and reversible.
 */
export function rollbackEvidenceCard(
  registry: Readonly<EvidenceRegistryV0>,
  cardId: string,
  toVersion: string,
): EvidenceRollbackResult {
  if (typeof cardId !== "string" || !Object.hasOwn(registry.cards, cardId)) {
    return Object.freeze({ ok: false, reason: "unknown_card" });
  }
  const entry = registry.cards[cardId];
  if (typeof toVersion !== "string" || !Object.hasOwn(entry.versions, toVersion)) {
    return Object.freeze({ ok: false, reason: "unknown_version" });
  }
  const target = entry.versions[toVersion];
  if (!isApprovedHumanReview(target.review)) {
    return Object.freeze({ ok: false, reason: "target_not_approved" });
  }
  if (target.sourceStatus === "retracted") {
    return Object.freeze({ ok: false, reason: "target_source_retracted" });
  }
  return Object.freeze({
    ok: true,
    registry: Object.freeze({
      ...registry,
      cards: Object.freeze({
        ...registry.cards,
        [cardId]: Object.freeze({ ...entry, activeVersion: toVersion }),
      }),
    }),
    activeVersion: toVersion,
  });
}

export type SkillPublishResult =
  | { readonly ok: true; readonly registry: Readonly<SkillRegistryV0>; readonly publishedVersion: string }
  | { readonly ok: false; readonly reason: "invalid_manifest"; readonly problems: readonly ContractProblem[] }
  | {
      readonly ok: false;
      readonly reason:
        | "review_not_approved"
        | "already_registered"
        | "version_not_increasing"
        | "tool_not_registered"
        | "binding_unresolved";
      readonly detail: readonly string[];
    };

/**
 * Publish one Skill Manifest version. Beyond the human-review gate and the
 * monotonic version rule, publish verifies the manifest's least-privilege
 * claims fail-closed: every advertised tool id must exist in the
 * SAFE_TOOL_REGISTRY whitelist and every pinned Evidence Card binding must
 * resolve (approved + live) in the CURRENT evidence registry — a manifest
 * that binds missing, unapproved, drifted or retracted evidence cannot be
 * published.
 */
export function publishSkillManifest(
  registry: Readonly<SkillRegistryV0>,
  evidenceRegistry: Readonly<EvidenceRegistryV0>,
  next: unknown,
): SkillPublishResult {
  const problems: ContractProblem[] = [];
  validateSkillManifestV0(next, problems);
  if (problems.length > 0) {
    return Object.freeze({ ok: false, reason: "invalid_manifest", problems: Object.freeze(problems) });
  }
  const manifest = next as SkillManifestV0;
  if (!isApprovedHumanReview(manifest.review)) {
    return Object.freeze({ ok: false, reason: "review_not_approved", detail: Object.freeze([] as string[]) });
  }
  const existing = Object.hasOwn(registry.skills, manifest.skillId)
    ? registry.skills[manifest.skillId]
    : undefined;
  if (existing !== undefined) {
    if (Object.hasOwn(existing.versions, manifest.version)) {
      return Object.freeze({ ok: false, reason: "already_registered", detail: Object.freeze([] as string[]) });
    }
    for (const version of Object.keys(existing.versions)) {
      if (!isVersionStrictlyGreaterThan(manifest.version, version)) {
        return Object.freeze({ ok: false, reason: "version_not_increasing", detail: Object.freeze([] as string[]) });
      }
    }
  }
  for (const toolId of manifest.toolCapabilities) {
    if (!Object.hasOwn(SAFE_TOOL_REGISTRY, toolId)) {
      // The submitted tool id is NOT echoed (untrusted-shaped input).
      return Object.freeze({ ok: false, reason: "tool_not_registered", detail: Object.freeze([] as string[]) });
    }
  }
  const unresolved: string[] = [];
  for (const binding of manifest.evidenceBindings) {
    const resolution = resolveEvidenceCard(evidenceRegistry, binding.cardId, binding.cardVersion);
    if (resolution.status === "rejected") {
      unresolved.push(`${binding.cardId}@${binding.cardVersion}:${resolution.reason}`);
    }
  }
  if (unresolved.length > 0) {
    return Object.freeze({ ok: false, reason: "binding_unresolved", detail: Object.freeze(unresolved) });
  }
  const versions = Object.freeze({ ...(existing?.versions ?? {}), [manifest.version]: Object.freeze(manifest) });
  const entry = Object.freeze({ activeVersion: manifest.version, versions });
  return Object.freeze({
    ok: true,
    registry: Object.freeze({
      ...registry,
      skills: Object.freeze({ ...registry.skills, [manifest.skillId]: entry }),
    }),
    publishedVersion: manifest.version,
  });
}

export type SkillRollbackResult =
  | { readonly ok: true; readonly registry: Readonly<SkillRegistryV0>; readonly activeVersion: string }
  | { readonly ok: false; readonly reason: "unknown_skill" | "unknown_version" | "target_not_approved" };

/** Roll the active pointer of one skill back to an already-registered version. */
export function rollbackSkillManifest(
  registry: Readonly<SkillRegistryV0>,
  skillId: string,
  toVersion: string,
): SkillRollbackResult {
  if (typeof skillId !== "string" || !Object.hasOwn(registry.skills, skillId)) {
    return Object.freeze({ ok: false, reason: "unknown_skill" });
  }
  const entry = registry.skills[skillId];
  if (typeof toVersion !== "string" || !Object.hasOwn(entry.versions, toVersion)) {
    return Object.freeze({ ok: false, reason: "unknown_version" });
  }
  const target = entry.versions[toVersion];
  if (!isApprovedHumanReview(target.review)) {
    return Object.freeze({ ok: false, reason: "target_not_approved" });
  }
  return Object.freeze({
    ok: true,
    registry: Object.freeze({
      ...registry,
      skills: Object.freeze({
        ...registry.skills,
        [skillId]: Object.freeze({ ...entry, activeVersion: toVersion }),
      }),
    }),
    activeVersion: toVersion,
  });
}

// ---------------------------------------------------------------------------
// Eval-suite bridge (issue #25 AC 2: a human revision triggers eval regression)
// ---------------------------------------------------------------------------

/**
 * Project a governance card onto the minimal EvalEvidenceCard view the R1-07
 * eval suite consumes (lib/domain/eval/scenario.ts). This is the composition
 * path for real subjects (R1-04/R1-11/R1-12): the eval contract view is
 * DERIVED from the reviewed registry card, never invented by a subject.
 */
export function toEvalEvidenceCardView(card: Readonly<EvidenceCardV0>): Readonly<EvalEvidenceCard> {
  return Object.freeze({
    evidenceId: card.cardId,
    reviewed: isApprovedHumanReview(card.review),
    appliesToSkills: Object.freeze([...card.appliesToSkills]) as readonly EvalSkillRoute[],
    summary: card.summary,
  });
}

export const REGISTRY_ALIGNMENT_PROBLEM_CODES = Object.freeze([
  "registry_content_invalid",
  "suite_evidence_status_conflict",
  "skill_id_mismatch",
  "skill_binding_unresolved",
  "skill_tools_unregistered",
  "evaluation_ref_unknown_scenario",
] as const);

export type RegistryAlignmentProblemCode = (typeof REGISTRY_ALIGNMENT_PROBLEM_CODES)[number];

export interface RegistryAlignmentProblem {
  readonly code: RegistryAlignmentProblemCode;
  readonly path: string;
  readonly message: string;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((entry, index) => entry === b[index]);
}

/**
 * Non-throwing resolution for the alignment cross-check: corrupt registry
 * content is already reported as `registry_content_invalid`; the binding
 * check must not mask it with a crash.
 */
function resolveEvidenceCardQuietly(
  registry: Readonly<EvidenceRegistryV0>,
  cardId: string,
  version?: string,
): EvidenceResolution {
  try {
    return resolveEvidenceCard(registry, cardId, version);
  } catch {
    return Object.freeze({ status: "rejected" as const, reason: "unknown_card" as const, cardId });
  }
}

/**
 * Cross-check the registries against an eval suite fixture (never throws;
 * returns structured problems). Checks:
 * - registry content re-validates fail-closed (all registered versions);
 * - an evidence id present in BOTH the suite and the registry must carry
 *   the same review status, skill applicability and summary in both — the
 *   eval view must be the projection of the governance card;
 * - the skill registry covers EXACTLY the first-party skill ids;
 * - every active manifest's evidence bindings resolve (approved + live);
 * - every advertised tool id exists in the SAFE_TOOL_REGISTRY whitelist;
 * - every evaluationRefs id names a scenario of the suite — the manifest's
 *   regression links stay real. Because this check runs in the same test
 *   run as the eval suite, any human revision of a card or manifest that
 *   breaks these links fails CI (issue #25 acceptance criterion 2).
 */
export function validateRegistriesAgainstEvalSuite(
  suite: Readonly<EvalSuiteFixture>,
  registries: Readonly<EvidenceAndSkillRegistries> = SHIPPED_REGISTRIES,
): readonly Readonly<RegistryAlignmentProblem>[] {
  const problems: RegistryAlignmentProblem[] = [];

  // 1. Registry content re-validates (every registered version).
  for (const cardId of Object.keys(registries.evidence.cards)) {
    const entry = registries.evidence.cards[cardId];
    for (const version of Object.keys(entry.versions)) {
      const cardProblems: ContractProblem[] = [];
      validateEvidenceCardV0(entry.versions[version], cardProblems);
      for (const cardProblem of cardProblems) {
        problems.push({
          code: "registry_content_invalid",
          path: `evidence.${cardId}.versions.${version}.${cardProblem.path}`,
          message: cardProblem.message,
        });
      }
    }
  }
  for (const skillId of Object.keys(registries.skills.skills)) {
    const entry = registries.skills.skills[skillId];
    for (const version of Object.keys(entry.versions)) {
      const manifestProblems: ContractProblem[] = [];
      validateSkillManifestV0(entry.versions[version], manifestProblems);
      for (const manifestProblem of manifestProblems) {
        problems.push({
          code: "registry_content_invalid",
          path: `skills.${skillId}.versions.${version}.${manifestProblem.path}`,
          message: manifestProblem.message,
        });
      }
    }
  }

  // 2. Shared evidence ids must agree between suite and registry.
  for (const evalCardId of Object.keys(suite.evidence)) {
    if (!Object.hasOwn(registries.evidence.cards, evalCardId)) {
      continue; // eval-only synthetic control cards stay eval-only.
    }
    const projection = toEvalEvidenceCardView(registries.evidence.cards[evalCardId].versions[
      registries.evidence.cards[evalCardId].activeVersion
    ]);
    const suiteCard = suite.evidence[evalCardId];
    const agree =
      suiteCard !== undefined &&
      projection.evidenceId === suiteCard.evidenceId &&
      projection.reviewed === suiteCard.reviewed &&
      projection.summary === suiteCard.summary &&
      sameStrings([...projection.appliesToSkills], [...(suiteCard.appliesToSkills ?? [])]);
    if (!agree) {
      problems.push({
        code: "suite_evidence_status_conflict",
        path: `evidence.${evalCardId}`,
        message: "the eval suite card and the registry projection of the active version disagree.",
      });
    }
  }

  // 3. The skill registry covers exactly the first-party skill ids.
  const registrySkillIds = Object.keys(registries.skills.skills).sort();
  const evalSkillIds = [...EVAL_SKILL_IDS].sort();
  if (!sameStrings(registrySkillIds, evalSkillIds)) {
    problems.push({
      code: "skill_id_mismatch",
      path: "skills",
      message: "the skill registry must cover exactly the first-party eval skill ids.",
    });
  }

  const suiteScenarioIds = new Set(suite.scenarios.map((scenario) => scenario.scenarioId));

  // 4. Active manifests: bindings, tools and evaluation refs.
  for (const skillId of Object.keys(registries.skills.skills)) {
    const entry = registries.skills.skills[skillId];
    const manifest = entry.versions[entry.activeVersion];
    manifest.evidenceBindings.forEach((binding, index) => {
      const resolution = resolveEvidenceCardQuietly(registries.evidence, binding.cardId, binding.cardVersion);
      if (resolution.status === "rejected") {
        problems.push({
          code: "skill_binding_unresolved",
          path: `skills.${skillId}.manifest.evidenceBindings[${index}]`,
          message: `binding does not resolve: ${binding.cardId}@${binding.cardVersion} (${resolution.reason}).`,
        });
      }
    });
    for (const toolId of manifest.toolCapabilities) {
      if (!Object.hasOwn(SAFE_TOOL_REGISTRY, toolId)) {
        problems.push({
          code: "skill_tools_unregistered",
          path: `skills.${skillId}.manifest.toolCapabilities`,
          message: "an advertised tool id is not in the SAFE_TOOL_REGISTRY whitelist.",
        });
      }
    }
    for (const ref of manifest.evaluationRefs) {
      if (!suiteScenarioIds.has(ref)) {
        problems.push({
          code: "evaluation_ref_unknown_scenario",
          path: `skills.${skillId}.manifest.evaluationRefs`,
          message: "an evaluation ref does not name a scenario of the suite.",
        });
      }
    }
  }

  return Object.freeze(problems.map((entry) => Object.freeze(entry)));
}

/**
 * Fail-closed throwing form used by the shipped-registry tests: any
 * alignment problem is a regression that must block the branch.
 */
export function assertShippedRegistriesAlignedWithEvalSuite(
  suite: Readonly<EvalSuiteFixture> = EVAL_SUITE_V1,
): void {
  const problems = validateRegistriesAgainstEvalSuite(suite);
  if (problems.length > 0) {
    throw new ContractValidationError(
      problems.map((entry) => problem("CONTRACT_FIELD_INVALID", entry.path, `${entry.code}: ${entry.message}`)),
    );
  }
}

/**
 * Reproducible publish/rollback example used by the tests and documented in
 * docs/EVIDENCE_POLICY.md: revise → review → publish → rollback → re-publish
 * yields byte-identical registry states, proving the cycle is pure.
 */
export function registryStatesAreEquivalent(a: Readonly<EvidenceRegistryV0>, b: Readonly<EvidenceRegistryV0>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
