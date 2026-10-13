/**
 * R1-04 Persona Policy v0 schema (docs/PERSONA.md, PRD §6 / FR-003 / UC-01,
 * Roadmap R1-04, issue #16).
 *
 * A Persona Policy is the versioned, server-owned rule resource that defines
 * WHO Lumi is for a child turn: the honest AI identity, the core character
 * traits, the NON-OVERRIDABLE relation boundaries and the adjustable style
 * knobs. It is a governance constant like the Safety rule registry — parsed
 * fail-closed, published only through the explicit human-review gate, never
 * rewritten from conversation content (PRD §1.1 principle 4/6, §6 版本治理).
 *
 * Schema-level non-representability (issue #16 实现范围 2/3):
 * - there is NO field anywhere in the value space that could register a
 *   "claim to be human" identity, an allowed exclusive relationship, an
 *   unconditional secrecy promise, a diagnosis/therapy role or a
 *   parent/teacher replacement role — the relation boundaries are a fixed
 *   registry the policy must carry COMPLETELY (a v0 policy cannot drop one);
 * - the ONLY adjustable fields are the four style knobs (language difficulty,
 *   answer length, humor, question density); identity, traits, boundaries
 *   and exit paths are structurally outside every adjustment path
 *   (lib/domain/persona/turn.ts accepts no parameter that could touch them);
 * - the review status rides with every version so "which rule version was
 *   approved by whom" is always answerable; approval is enforced at the
 *   registry gates (publish / load / rollback target — see registry.ts),
 *   mirroring the Evidence Card lifecycle where review status is data on
 *   the resource.
 *
 * Skill rule entry (issue #16 实现范围 4): `appliesToSkills` lists the
 * first-party skills that run under THIS persona rule version; the registry
 * alignment check pins both shipped skills to the same policy, so a skill
 * turn and an ordinary conversation turn resolve the same persona rules.
 *
 * The human-review record shape is REUSED from the evidence governance
 * schema (lib/domain/evidence/card.ts) — one review vocabulary across
 * governance modules, mirroring how skill-manifest.ts reuses it.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { ContractValidationError, failOnProblems, problem, type ContractProblem } from "../contract/core.ts";
import { EVAL_EXIT_PATHS, EVAL_SKILL_IDS, type EvalExitPath, type EvalSkillId } from "../eval/scenario.ts";

import {
  validateHumanReview,
  type HumanReviewV0,
} from "../evidence/card.ts";

// ---------------------------------------------------------------------------
// Version registry (fail-closed, mirrors the interaction/safety contracts)
// ---------------------------------------------------------------------------

/**
 * Supported Persona Policy schema versions. Appending an entry is the ONLY
 * way to accept a new version; unknown versions fail closed.
 */
export const PERSONA_SCHEMA_VERSIONS = Object.freeze(["1.0"] as const);

export type PersonaSchemaVersion = (typeof PERSONA_SCHEMA_VERSIONS)[number];

/** Latest supported Persona Policy schema version. */
export const PERSONA_SCHEMA_VERSION: PersonaSchemaVersion =
  PERSONA_SCHEMA_VERSIONS[PERSONA_SCHEMA_VERSIONS.length - 1];

// ---------------------------------------------------------------------------
// Identity disclosure registry (issue #16: 明确这是 AI、诚实)
// ---------------------------------------------------------------------------

/**
 * Registered persona policy ids. v0 ships exactly one child-facing persona
 * (PRD ARCHITECTURE: 单一 Persona); new personas are new registry entries,
 * never runtime parameters.
 */
export const PERSONA_POLICY_IDS = Object.freeze(["lumithink_child_persona"] as const);

export type PersonaPolicyId = (typeof PERSONA_POLICY_IDS)[number];

/**
 * Registered identity-disclosure templates, keyed by template id. The v0
 * value space contains ONLY honest AI-identity statements: there is no
 * template id (and no field) that could register a "claim to be human"
 * identity. Disclosure text is a developer-authored constant, never derived
 * from conversation content.
 */
export const PERSONA_IDENTITY_DISCLOSURE_IDS = Object.freeze([
  "ai_companion_disclosed_v1",
] as const);

export type PersonaIdentityDisclosureId = (typeof PERSONA_IDENTITY_DISCLOSURE_IDS)[number];

export const PERSONA_IDENTITY_DISCLOSURES: Readonly<
  Record<PersonaIdentityDisclosureId, string>
> = Object.freeze({
  ai_companion_disclosed_v1:
    "我是 Lumi，一个 AI 学习伙伴，不是真人。我说实话，不知道的时候会告诉你我不知道。",
});

/** Disclosure languages a v0 policy may declare (v0: Chinese only). */
export const PERSONA_LANGUAGES = Object.freeze(["zh"] as const);

export type PersonaLanguage = (typeof PERSONA_LANGUAGES)[number];

// ---------------------------------------------------------------------------
// Core traits and relation boundaries (immutable invariants, PRD §6)
// ---------------------------------------------------------------------------

/**
 * Core character traits (PRD §6 核心不变项). A v0 policy must carry the
 * COMPLETE registry set — traits are invariants, not configuration.
 */
export const PERSONA_CORE_TRAITS = Object.freeze([
  "friendly",
  "honest",
  "curious",
  "autonomy_respecting",
  "ai_identity_disclosed",
  "age_appropriate",
] as const);

export type PersonaCoreTrait = (typeof PERSONA_CORE_TRAITS)[number];

/**
 * NON-OVERRIDABLE relation boundaries (issue #16 实现范围 3). Every value
 * below is FORBIDDEN by design: a policy can only enforce the full set —
 * the schema offers no representation for relaxing any of them, so user
 * prompts, memory claims and tool outputs cannot weaken them through any
 * persona API (enforcement of the text itself stays with the Safety Gate;
 * the persona layer keeps the RULES unrepresentable and the disclosures
 * present on every turn).
 */
export const PERSONA_RELATION_BOUNDARIES = Object.freeze([
  "relation.no_exclusive_relationship",
  "relation.no_unconditional_secrecy",
  "relation.no_diagnosis_or_therapy",
  "relation.no_parent_teacher_replacement",
  "relation.no_attachment_pressure",
] as const);

export type PersonaRelationBoundary = (typeof PERSONA_RELATION_BOUNDARIES)[number];

// ---------------------------------------------------------------------------
// Adjustable style knobs (issue #16 实现范围 2 — the ONLY adjustable fields)
// ---------------------------------------------------------------------------

/**
 * The four adjustable knobs fixed by issue #16. Everything else on a policy
 * is an invariant; adding a knob is a schema/registry change with review.
 * (PRD §6 also lists 故事化程度/语音节奏 as future knobs — deliberately not
 * registered in v0.)
 */
export const PERSONA_STYLE_KNOBS = Object.freeze([
  "language_level",
  "answer_length",
  "humor",
  "question_density",
] as const);

export type PersonaStyleKnobId = (typeof PERSONA_STYLE_KNOBS)[number];

/** Registered values per knob; unknown values fail closed. */
export const PERSONA_KNOB_VALUES: Readonly<
  Record<PersonaStyleKnobId, readonly string[]>
> = Object.freeze({
  language_level: Object.freeze(["simple", "standard", "advanced"]),
  answer_length: Object.freeze(["brief", "balanced", "detailed"]),
  humor: Object.freeze(["none", "light", "playful"]),
  question_density: Object.freeze(["low", "medium", "high"]),
});

export type PersonaStyleKnobValue = string;

/**
 * TRUSTED knob provenances. Only these channels may change a style knob:
 * the system default, the guardian configuration path, and the structured
 * child-feedback channel (PRD §6 可调项: 儿童可反馈和修改 — feedback is a
 * structured product channel, never raw prompt text).
 */
export const PERSONA_KNOB_SOURCES = Object.freeze([
  "system_default",
  "guardian_config",
  "child_feedback",
] as const);

export type PersonaKnobSource = (typeof PERSONA_KNOB_SOURCES)[number];

/**
 * UNTRUSTED provenances (issue #16 实现范围 2). Text arriving under these
 * provenances can NEVER carry knobs or boundaries — persona turn resolution
 * inspects it (override-attempt detection, observability only) and applies
 * nothing from it.
 */
export const PERSONA_UNTRUSTED_PROVENANCES = Object.freeze([
  "user_prompt_text",
  "memory_claim",
  "tool_output",
] as const);

export type PersonaUntrustedProvenance = (typeof PERSONA_UNTRUSTED_PROVENANCES)[number];

// ---------------------------------------------------------------------------
// Policy shape
// ---------------------------------------------------------------------------

export interface PersonaStyleState {
  readonly [knobId: string]: PersonaStyleKnobValue;
}

export interface PersonaPolicyV0 {
  readonly schemaVersion: PersonaSchemaVersion;
  readonly policyId: PersonaPolicyId;
  /** Content version (semver); bumped by a human revision + re-review. */
  readonly version: string;
  /** Registered honest-AI disclosure template this policy uses. */
  readonly identityDisclosureId: PersonaIdentityDisclosureId;
  /** MUST equal the full PERSONA_CORE_TRAITS set (invariants, not config). */
  readonly coreTraits: readonly PersonaCoreTrait[];
  /** MUST equal the full PERSONA_RELATION_BOUNDARIES set (non-weakening). */
  readonly relationBoundaries: readonly PersonaRelationBoundary[];
  /** Which of the registered knobs are adjustable (v0: all four). */
  readonly adjustableKnobs: readonly PersonaStyleKnobId[];
  /** Default style value for EVERY registered knob. */
  readonly defaultStyle: Readonly<PersonaStyleState>;
  /**
   * Child-selectable exit / help paths (eval vocabulary, non-empty). v0
   * requires "trusted_adult": 无效或不适合时可退出、求助现实成年人.
   */
  readonly exitPaths: readonly EvalExitPath[];
  /** First-party skills that run under this persona rule version. */
  readonly appliesToSkills: readonly EvalSkillId[];
  /** Disclosure language of the registered template. */
  readonly language: PersonaLanguage;
  /** 更新时间 of the policy content (ISO date). */
  readonly updatedAt: string;
  /** Explicit human review = the change-approval record (PRD §6 版本治理). */
  readonly review: HumanReviewV0;
}

// ---------------------------------------------------------------------------
// Fail-closed parsing helpers (local; mirrors card.ts / skill-manifest.ts)
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

function expectStringArray(value: unknown, path: string, problems: ContractProblem[]): void {
  if (!Array.isArray(value)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", path, "expected an array."));
    return;
  }
  value.forEach((entry, index) => {
    if (typeof entry !== "string") {
      problems.push(problem("CONTRACT_FIELD_INVALID", `${path}[${index}]`, "expected a string."));
    }
  });
}

function expectIsoDate(value: unknown, path: string, problems: ContractProblem[]): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    problems.push(problem("CONTRACT_FIELD_INVALID", path, "expected an ISO date (YYYY-MM-DD)."));
  }
}

function expectSemver(value: unknown, path: string, problems: ContractProblem[]): void {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", path, "expected a semver string."));
  }
}

function deepChecksDisabled(problems: ContractProblem[], before: number): boolean {
  return problems.length !== before;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");
}

// ---------------------------------------------------------------------------
// Policy parser
// ---------------------------------------------------------------------------

/** Validate one Persona Policy v0 value into `problems` (does not throw). */
export function validatePersonaPolicyV0(value: unknown, problems: ContractProblem[]): void {
  const before = problems.length;
  expectObject(value, "personaPolicy", problems);
  if (deepChecksDisabled(problems, before) || value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const policy = value as Record<string, unknown>;
  rejectUnknownKeys(
    policy,
    [
      "schemaVersion",
      "policyId",
      "version",
      "identityDisclosureId",
      "coreTraits",
      "relationBoundaries",
      "adjustableKnobs",
      "defaultStyle",
      "exitPaths",
      "appliesToSkills",
      "language",
      "updatedAt",
      "review",
    ],
    "personaPolicy",
    problems,
  );

  expectEnum(policy.schemaVersion, PERSONA_SCHEMA_VERSIONS, "personaPolicy.schemaVersion", problems);
  expectEnum(policy.policyId, PERSONA_POLICY_IDS, "personaPolicy.policyId", problems);
  expectSemver(policy.version, "personaPolicy.version", problems);
  expectEnum(
    policy.identityDisclosureId,
    PERSONA_IDENTITY_DISCLOSURE_IDS,
    "personaPolicy.identityDisclosureId",
    problems,
  );

  // Core traits and relation boundaries must carry the COMPLETE registered
  // sets: invariants cannot be dropped by a policy revision (non-weakening,
  // issue #16: 边界不可被覆盖).
  expectStringArray(policy.coreTraits, "personaPolicy.coreTraits", problems);
  if (Array.isArray(policy.coreTraits)) {
    policy.coreTraits.forEach((entry, index) => {
      expectEnum(entry, PERSONA_CORE_TRAITS, `personaPolicy.coreTraits[${index}]`, problems);
    });
    if (
      problems.length === before &&
      !sameSet(policy.coreTraits as string[], PERSONA_CORE_TRAITS)
    ) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          "personaPolicy.coreTraits",
          "a persona policy must carry the COMPLETE core-trait registry set.",
        ),
      );
    }
  }
  expectStringArray(policy.relationBoundaries, "personaPolicy.relationBoundaries", problems);
  if (Array.isArray(policy.relationBoundaries)) {
    policy.relationBoundaries.forEach((entry, index) => {
      expectEnum(entry, PERSONA_RELATION_BOUNDARIES, `personaPolicy.relationBoundaries[${index}]`, problems);
    });
    if (
      problems.length === before &&
      !sameSet(policy.relationBoundaries as string[], PERSONA_RELATION_BOUNDARIES)
    ) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          "personaPolicy.relationBoundaries",
          "a persona policy must carry the COMPLETE relation-boundary registry set.",
        ),
      );
    }
  }

  expectStringArray(policy.adjustableKnobs, "personaPolicy.adjustableKnobs", problems);
  if (Array.isArray(policy.adjustableKnobs)) {
    policy.adjustableKnobs.forEach((entry, index) => {
      expectEnum(entry, PERSONA_STYLE_KNOBS, `personaPolicy.adjustableKnobs[${index}]`, problems);
    });
  }

  // Default style: every registered knob must be present with a registered
  // value, and no extra knobs may appear.
  expectObject(policy.defaultStyle, "personaPolicy.defaultStyle", problems);
  if (
    !deepChecksDisabled(problems, before) &&
    policy.defaultStyle !== null &&
    typeof policy.defaultStyle === "object" &&
    !Array.isArray(policy.defaultStyle)
  ) {
    const style = policy.defaultStyle as Record<string, unknown>;
    rejectUnknownKeys(style, PERSONA_STYLE_KNOBS, "personaPolicy.defaultStyle", problems);
    for (const knob of PERSONA_STYLE_KNOBS) {
      const value = style[knob];
      if (value === undefined) {
        problems.push(
          problem(
            "CONTRACT_FIELD_MISSING",
            `personaPolicy.defaultStyle.${knob}`,
            "every registered knob requires a default value.",
          ),
        );
      } else if (
        typeof value !== "string" ||
        !(PERSONA_KNOB_VALUES[knob] as readonly string[]).includes(value)
      ) {
        problems.push(
          problem(
            "CONTRACT_FIELD_INVALID",
            `personaPolicy.defaultStyle.${knob}`,
            `value is not registered; registered values are: ${PERSONA_KNOB_VALUES[knob].join(", ")}.`,
          ),
        );
      }
    }
  }

  expectStringArray(policy.exitPaths, "personaPolicy.exitPaths", problems);
  if (Array.isArray(policy.exitPaths)) {
    policy.exitPaths.forEach((entry, index) => {
      expectEnum(entry, EVAL_EXIT_PATHS, `personaPolicy.exitPaths[${index}]`, problems);
    });
    if (problems.length === before && (policy.exitPaths as string[]).length === 0) {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", "personaPolicy.exitPaths", "at least one exit path is required."),
      );
    }
    if (
      problems.length === before &&
      !(policy.exitPaths as string[]).includes("trusted_adult")
    ) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          "personaPolicy.exitPaths",
          "a persona policy must always offer the trusted-adult help path.",
        ),
      );
    }
  }

  // Skill rule entry: a v0 policy covers EXACTLY the first-party skills —
  // both skills share the SAME persona rule entry (issue #16 实现范围 4).
  expectStringArray(policy.appliesToSkills, "personaPolicy.appliesToSkills", problems);
  if (Array.isArray(policy.appliesToSkills)) {
    policy.appliesToSkills.forEach((entry, index) => {
      expectEnum(entry, EVAL_SKILL_IDS, `personaPolicy.appliesToSkills[${index}]`, problems);
    });
    if (
      problems.length === before &&
      !sameSet(policy.appliesToSkills as string[], EVAL_SKILL_IDS)
    ) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          "personaPolicy.appliesToSkills",
          "a v0 persona policy must cover exactly the first-party skill ids.",
        ),
      );
    }
  }

  expectEnum(policy.language, PERSONA_LANGUAGES, "personaPolicy.language", problems);
  expectIsoDate(policy.updatedAt, "personaPolicy.updatedAt", problems);
  validateHumanReview(policy.review, "personaPolicy.review", problems);
}

/** Parse one Persona Policy; unknown shapes fail closed with a structured error. */
export function parsePersonaPolicyV0(value: unknown): Readonly<PersonaPolicyV0> {
  const problems: ContractProblem[] = [];
  validatePersonaPolicyV0(value, problems);
  failOnProblems(problems);
  return Object.freeze(value as PersonaPolicyV0);
}

/** The registered disclosure text of a policy (fail-closed on the id). */
export function personaIdentityDisclosureText(
  policy: Readonly<Pick<PersonaPolicyV0, "identityDisclosureId">>,
): string {
  if (!Object.hasOwn(PERSONA_IDENTITY_DISCLOSURES, policy.identityDisclosureId)) {
    throw new ContractValidationError([
      problem(
        "CONTRACT_FIELD_INVALID",
        "personaPolicy.identityDisclosureId",
        "disclosure id is not registered; the submitted value is not echoed.",
      ),
    ]);
  }
  return PERSONA_IDENTITY_DISCLOSURES[policy.identityDisclosureId];
}
