/**
 * R1-13 Evidence Card v0 schema (docs/EVIDENCE_POLICY.md, PRD §8 / FR-010,
 * Roadmap R1-13, issue #25).
 *
 * An Evidence Card is the minimal verifiable governance record that binds a
 * professional strategy to its human-reviewed research basis: citation and
 * source_url, research design, subjects and target age, claimed effects and
 * limitations, applicable/exclusion (禁忌) conditions, update time, human
 * review status and a content version. Cards are developer-authored in-repo
 * constants — never attacker input and never fetched from the network
 * (issue #25: 不自动抓取受版权保护文本). Parsing problems may therefore echo
 * the offending field path, but never child data or source text.
 *
 * Fail-closed rules baked into the schema (issue #25 acceptance criteria):
 * - the AI-transfer boundary enum has NO value that could register an
 *   "AI efficacy proven" claim; the only registered value is
 *   `school_practice_only` (guideline supports school practice ≠ AI agent
 *   efficacy for an individual child);
 * - a `sourceStatus` of "retracted" can never load (citation invalidation);
 * - an approved review REQUIRES a reviewer handle and review date (explicit
 *   human review publish gate);
 * - fields are length-capped structural metadata — cards store citation
 *   metadata only, never full source text excerpts.
 *
 * Skill ids and exit paths reuse the R1-07 eval vocabulary
 * (lib/domain/eval/scenario.ts) so the governance registry and the eval
 * suite can never drift apart.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { failOnProblems, problem, type ContractProblem } from "../contract/core.ts";
import { EVAL_SKILL_IDS, type EvalSkillId } from "../eval/scenario.ts";

// ---------------------------------------------------------------------------
// Version registry (fail-closed, mirrors the interaction/safety contracts)
// ---------------------------------------------------------------------------

/**
 * Supported Evidence Card schema versions. Appending an entry is the ONLY
 * way to accept a new version; unknown versions fail closed.
 */
export const EVIDENCE_CARD_SCHEMA_VERSIONS = Object.freeze(["1.0"] as const);

export type EvidenceCardSchemaVersion = (typeof EVIDENCE_CARD_SCHEMA_VERSIONS)[number];

/** Latest supported Evidence Card schema version. */
export const EVIDENCE_CARD_SCHEMA_VERSION: EvidenceCardSchemaVersion =
  EVIDENCE_CARD_SCHEMA_VERSIONS[EVIDENCE_CARD_SCHEMA_VERSIONS.length - 1];

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** Research designs a v0 card may record (PRD §8: 研究类型). */
export const EVIDENCE_RESEARCH_DESIGNS = Object.freeze([
  "guidance_synthesis",
  "systematic_review",
  "meta_analysis",
  "rct",
  "quasi_experimental",
  "expert_consensus",
] as const);
export type EvidenceResearchDesign = (typeof EVIDENCE_RESEARCH_DESIGNS)[number];

/**
 * Human-assigned evidence level of the CARD (a conservative rating of the
 * source synthesis; PRD §8: 证据等级). It is metadata about the research
 * basis, never a claim about product effect.
 */
export const EVIDENCE_LEVELS = Object.freeze([
  "strong",
  "moderate",
  "limited",
  "very_limited",
] as const);
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

/** Availability of the cited source (citation invalidation is fail-closed). */
export const EVIDENCE_SOURCE_STATUSES = Object.freeze(["live", "retracted"] as const);
export type EvidenceSourceStatus = (typeof EVIDENCE_SOURCE_STATUSES)[number];

/** Human review statuses (PRD §8: 人工审核状态). */
export const EVIDENCE_REVIEW_STATUSES = Object.freeze(["pending", "approved", "rejected"] as const);
export type EvidenceReviewStatus = (typeof EVIDENCE_REVIEW_STATUSES)[number];

/**
 * Extrapolation boundary (issue #25 交付范围 4: 外推边界). The registry
 * deliberately contains NO "proven for AI agents" value: guidelines that
 * support school teacher practice can never be re-registered as proof of
 * AI-agent efficacy for an individual child. Adding such a value would be a
 * schema change with its own review, not a content edit.
 */
export const EVIDENCE_AI_TRANSFER_BOUNDARIES = Object.freeze(["school_practice_only"] as const);
export type EvidenceAiTransferBoundary = (typeof EVIDENCE_AI_TRANSFER_BOUNDARIES)[number];

/**
 * Source hosts a v0 governance card may cite. The shipped first batch is
 * the EEF guidance reports named by PRD §8/§10.3. The registry performs no
 * network access; the allowlist only keeps citation metadata auditable.
 */
export const EVIDENCE_SOURCE_HOST_ALLOWLIST = Object.freeze([
  "educationendowmentfoundation.org.uk",
] as const);

/**
 * Shared id shape for governance records (same shape as EVAL_ID_PATTERN,
 * kept local so the card schema stays independent of eval internals).
 */
export const GOVERNANCE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;

function isGovernanceId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && GOVERNANCE_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Shared human-review record (cards and skill manifests)
// ---------------------------------------------------------------------------

export interface HumanReviewV0 {
  readonly status: EvidenceReviewStatus;
  /** Required when status is "approved" (explicit human review gate). */
  readonly reviewedBy?: string;
  /** Required when status is "approved"; ISO date (YYYY-MM-DD). */
  readonly reviewedAt?: string;
  /** Structural note only; never child data or source text. */
  readonly note?: string;
}

/** The explicit human-review publish gate (issue #25 交付范围 2). */
export function isApprovedHumanReview(review: Readonly<HumanReviewV0>): boolean {
  return (
    review.status === "approved" &&
    typeof review.reviewedBy === "string" &&
    review.reviewedBy.length > 0 &&
    typeof review.reviewedAt === "string"
  );
}

// ---------------------------------------------------------------------------
// Card shape
// ---------------------------------------------------------------------------

export interface EvidenceCardCitation {
  /** https URL of the cited source (metadata only; never fetched). */
  readonly sourceUrl: string;
  readonly title: string;
  readonly publisher: string;
  readonly year: number;
  /** Optional edition/version note of the cited document. */
  readonly documentVersion?: string;
}

export interface EvidenceCardAgeRange {
  readonly minAgeYears: number;
  readonly maxAgeYears: number;
}

export interface EvidenceCardV0 {
  readonly schemaVersion: EvidenceCardSchemaVersion;
  /** Stable card id (registry key; ids never change across versions). */
  readonly cardId: string;
  /** Content version (semver); incremented by a human revision + re-review. */
  readonly version: string;
  readonly citation: EvidenceCardCitation;
  readonly researchDesign: EvidenceResearchDesign;
  readonly evidenceLevel: EvidenceLevel;
  /** Target age range of the SOURCE population (not the platform scope). */
  readonly targetAges: EvidenceCardAgeRange;
  /** 研究对象与场景 — structural description of subjects and context. */
  readonly subjectsAndContext: string;
  /** 效应 — guidance-level effect summary; never an AI-efficacy claim. */
  readonly claimedEffects: string;
  /** 局限 — at least one limitation is mandatory. */
  readonly limitations: readonly string[];
  /** 适用条件. */
  readonly applicableConditions: readonly string[];
  /** 禁忌/排除条件 — at least one is mandatory. */
  readonly exclusionConditions: readonly string[];
  readonly aiTransferBoundary: EvidenceAiTransferBoundary;
  /** First-party skills the card may back; non-empty for registry cards. */
  readonly appliesToSkills: readonly EvalSkillId[];
  readonly sourceStatus: EvidenceSourceStatus;
  /** 更新时间 of the card content (ISO date). */
  readonly updatedAt: string;
  readonly review: HumanReviewV0;
  /** Short structural summary projected into the eval evidence view. */
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// Fail-closed parsing helpers (local; mirrors the eval/contract conventions)
// ---------------------------------------------------------------------------

function expectObject(value: unknown, path: string, problems: ContractProblem[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", path, "expected an object."));
  }
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  problems: ContractProblem[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", `${path}.${key}`, "unknown field; fail-closed."),
      );
    }
  }
}

function expectEnum<T extends string>(
  value: unknown,
  registry: readonly T[],
  path: string,
  problems: ContractProblem[],
): void {
  if (typeof value !== "string" || !(registry as readonly string[]).includes(value)) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        path,
        `value is not registered; registered values are: ${registry.join(", ")}.`,
      ),
    );
  }
}

function expectGovernanceId(value: unknown, path: string, problems: ContractProblem[]): void {
  if (!isGovernanceId(value)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", path, "value is not a valid governance id."));
  }
}

function expectSemver(value: unknown, path: string, problems: ContractProblem[]): void {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", path, "expected a semver string."));
  }
}

function expectIsoDate(value: unknown, path: string, problems: ContractProblem[]): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", path, "expected an ISO date (YYYY-MM-DD)."));
    return;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    problems.push(problem("CONTRACT_FIELD_INVALID", path, "expected a real calendar date."));
  }
}

function expectBoundedString(
  value: unknown,
  path: string,
  maxLength: number,
  problems: ContractProblem[],
): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", path, `expected a non-empty string of at most ${maxLength} characters.`),
    );
  }
}

function expectBoundedStringArray(
  value: unknown,
  path: string,
  maxItems: number,
  maxItemLength: number,
  problems: ContractProblem[],
): void {
  if (!Array.isArray(value)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", path, "expected an array."));
    return;
  }
  if (value.length === 0 || value.length > maxItems) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", path, `expected between 1 and ${maxItems} items.`),
    );
    return;
  }
  value.forEach((entry, index) => {
    expectBoundedString(entry, `${path}[${index}]`, maxItemLength, problems);
  });
}

function deepChecksDisabled(problems: ContractProblem[], before: number): boolean {
  return problems.length !== before;
}

/** Validate a shared human-review record into `problems` (does not throw). */
export function validateHumanReview(value: unknown, path: string, problems: ContractProblem[]): void {
  const before = problems.length;
  expectObject(value, path, problems);
  if (deepChecksDisabled(problems, before) || value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const review = value as Record<string, unknown>;
  rejectUnknownKeys(review, ["status", "reviewedBy", "reviewedAt", "note"], path, problems);
  expectEnum(review.status, EVIDENCE_REVIEW_STATUSES, `${path}.status`, problems);
  if (review.reviewedBy !== undefined) {
    expectBoundedString(review.reviewedBy, `${path}.reviewedBy`, 80, problems);
  }
  if (review.reviewedAt !== undefined) {
    expectIsoDate(review.reviewedAt, `${path}.reviewedAt`, problems);
  }
  if (review.note !== undefined) {
    expectBoundedString(review.note, `${path}.note`, 300, problems);
  }
  if (
    review.status === "approved" &&
    (typeof review.reviewedBy !== "string" || review.reviewedBy.length === 0 || typeof review.reviewedAt !== "string")
  ) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        `${path}.reviewedBy`,
        "an approved review requires a reviewer handle and a review date (human review publish gate).",
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Card parser
// ---------------------------------------------------------------------------

/** Validate one Evidence Card v0 value into `problems` (does not throw). */
export function validateEvidenceCardV0(value: unknown, problems: ContractProblem[]): void {
  const before = problems.length;
  expectObject(value, "card", problems);
  if (deepChecksDisabled(problems, before) || value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const card = value as Record<string, unknown>;
  rejectUnknownKeys(
    card,
    [
      "schemaVersion",
      "cardId",
      "version",
      "citation",
      "researchDesign",
      "evidenceLevel",
      "targetAges",
      "subjectsAndContext",
      "claimedEffects",
      "limitations",
      "applicableConditions",
      "exclusionConditions",
      "aiTransferBoundary",
      "appliesToSkills",
      "sourceStatus",
      "updatedAt",
      "review",
      "summary",
    ],
    "card",
    problems,
  );

  expectEnum(card.schemaVersion, EVIDENCE_CARD_SCHEMA_VERSIONS, "card.schemaVersion", problems);
  expectGovernanceId(card.cardId, "card.cardId", problems);
  expectSemver(card.version, "card.version", problems);
  expectEnum(card.researchDesign, EVIDENCE_RESEARCH_DESIGNS, "card.researchDesign", problems);
  expectEnum(card.evidenceLevel, EVIDENCE_LEVELS, "card.evidenceLevel", problems);
  expectEnum(card.aiTransferBoundary, EVIDENCE_AI_TRANSFER_BOUNDARIES, "card.aiTransferBoundary", problems);
  expectEnum(card.sourceStatus, EVIDENCE_SOURCE_STATUSES, "card.sourceStatus", problems);
  expectIsoDate(card.updatedAt, "card.updatedAt", problems);
  expectBoundedString(card.subjectsAndContext, "card.subjectsAndContext", 500, problems);
  expectBoundedString(card.claimedEffects, "card.claimedEffects", 500, problems);
  expectBoundedString(card.summary, "card.summary", 500, problems);
  expectBoundedStringArray(card.limitations, "card.limitations", 10, 300, problems);
  expectBoundedStringArray(card.applicableConditions, "card.applicableConditions", 10, 300, problems);
  expectBoundedStringArray(card.exclusionConditions, "card.exclusionConditions", 10, 300, problems);

  // appliesToSkills: non-empty, first-party skill ids only.
  if (!Array.isArray(card.appliesToSkills) || card.appliesToSkills.length === 0) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "card.appliesToSkills", "expected a non-empty array of skill ids."),
    );
  } else {
    card.appliesToSkills.forEach((entry, index) => {
      expectEnum(entry, EVAL_SKILL_IDS, `card.appliesToSkills[${index}]`, problems);
    });
  }

  // Citation (source_url + 文献/指南信息).
  const citationBefore = problems.length;
  expectObject(card.citation, "card.citation", problems);
  if (
    !deepChecksDisabled(problems, citationBefore) &&
    card.citation !== null &&
    typeof card.citation === "object" &&
    !Array.isArray(card.citation)
  ) {
    const citation = card.citation as Record<string, unknown>;
    rejectUnknownKeys(citation, ["sourceUrl", "title", "publisher", "year", "documentVersion"], "card.citation", problems);
    if (typeof citation.sourceUrl !== "string" || citation.sourceUrl.length === 0 || citation.sourceUrl.length > 300) {
      problems.push(problem("CONTRACT_FIELD_INVALID", "card.citation.sourceUrl", "expected a short https source URL."));
    } else {
      let parsedUrl: URL | null = null;
      try {
        parsedUrl = new URL(citation.sourceUrl);
      } catch {
        parsedUrl = null;
      }
      if (parsedUrl === null || parsedUrl.protocol !== "https:") {
        problems.push(problem("CONTRACT_FIELD_INVALID", "card.citation.sourceUrl", "expected an https URL."));
      } else if (!(EVIDENCE_SOURCE_HOST_ALLOWLIST as readonly string[]).includes(parsedUrl.hostname)) {
        problems.push(
          problem(
            "CONTRACT_FIELD_INVALID",
            "card.citation.sourceUrl",
            "source host is not in the allowlist; registered hosts are: " +
              `${EVIDENCE_SOURCE_HOST_ALLOWLIST.join(", ")}.`,
          ),
        );
      }
    }
    expectBoundedString(citation.title, "card.citation.title", 300, problems);
    expectBoundedString(citation.publisher, "card.citation.publisher", 120, problems);
    if (
      typeof citation.year !== "number" ||
      !Number.isInteger(citation.year) ||
      citation.year < 1970 ||
      citation.year > 2100
    ) {
      problems.push(problem("CONTRACT_FIELD_INVALID", "card.citation.year", "expected a plausible year integer."));
    }
    if (citation.documentVersion !== undefined) {
      expectBoundedString(citation.documentVersion, "card.citation.documentVersion", 120, problems);
    }
  }

  // Target ages (对象与年龄).
  const agesBefore = problems.length;
  expectObject(card.targetAges, "card.targetAges", problems);
  if (
    !deepChecksDisabled(problems, agesBefore) &&
    card.targetAges !== null &&
    typeof card.targetAges === "object" &&
    !Array.isArray(card.targetAges)
  ) {
    const ages = card.targetAges as Record<string, unknown>;
    rejectUnknownKeys(ages, ["minAgeYears", "maxAgeYears"], "card.targetAges", problems);
    const isAge = (entry: unknown): entry is number =>
      typeof entry === "number" && Number.isInteger(entry) && entry >= 0 && entry <= 25;
    if (!isAge(ages.minAgeYears) || !isAge(ages.maxAgeYears)) {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", "card.targetAges", "expected integer ages between 0 and 25."),
      );
    } else if (ages.minAgeYears > ages.maxAgeYears) {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", "card.targetAges", "minAgeYears must not exceed maxAgeYears."),
      );
    }
  }

  validateHumanReview(card.review, "card.review", problems);
}

/** Parse one Evidence Card v0; unknown shapes fail closed. */
export function parseEvidenceCardV0(value: unknown): Readonly<EvidenceCardV0> {
  const problems: ContractProblem[] = [];
  validateEvidenceCardV0(value, problems);
  failOnProblems(problems);
  return Object.freeze(value as EvidenceCardV0);
}
