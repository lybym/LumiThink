/**
 * R1-07 versioned synthetic evaluation scenarios (docs/HARNESS.md §6,
 * issue #19: "建立版本化合成场景 fixtures").
 *
 * A scenario is a fully declarative, versioned fixture that describes one
 * synthetic child-support situation and the deterministic expectations that
 * an evaluation subject must satisfy: expected skill routing, forbidden
 * actions, required/forbidden Evidence Card citations, expected exit/help
 * paths and — via the optional gate probe — the exact decision the real
 * Safety Gate pipeline must produce for a fixed synthetic input.
 *
 * Fail-closed parsing: unknown fields, unregistered enum values, malformed
 * ids and inconsistent gate probe/expectation pairs are rejected. Scenario
 * fixtures are developer-authored in-repo constants (never attacker input),
 * so parse problems may echo the offending fixture key.
 *
 * EVERY text in scenario fixtures is synthetic and prefixed "[synthetic]".
 * No real child data, recordings or credentials may ever be added here
 * (issue #19 merge requirements).
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { ACTOR_ROLES, type ActorRole } from "../contract/actor.ts";
import { ContractValidationError, problem, type ContractProblem } from "../contract/core.ts";
import { SAFETY_ENTRANCES, SAFETY_RULE_IDS, type SafetyEntrance, type SafetyRuleId } from "../safety/policy.ts";
import type { ToolCallCandidate } from "../safety/tool-gate.ts";

// ---------------------------------------------------------------------------
// Version registry (fail-closed, mirrors the interaction/safety contracts)
// ---------------------------------------------------------------------------

/**
 * Supported evaluation schema versions. Appending an entry is the ONLY way
 * to accept a new version; unknown versions fail closed.
 *
 * v1.1 (R1-11, issue #23): adds the optional `versionStamps` field to the
 * run report — the HARNESS §6.4 version-stamp merge performed by the
 * subject-wiring issue that first drives a real skill surface through the
 * harness. v1.0 reports remain valid and parse without stamps.
 */
export const EVAL_SCHEMA_VERSIONS = Object.freeze(["1.0", "1.1"] as const);

export type EvalSchemaVersion = (typeof EVAL_SCHEMA_VERSIONS)[number];

/** Latest supported evaluation schema version. */
export const EVAL_SCHEMA_VERSION: EvalSchemaVersion =
  EVAL_SCHEMA_VERSIONS[EVAL_SCHEMA_VERSIONS.length - 1];

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/**
 * The scenario families fixed by issue #19 goal 1: daily emotion, difficult
 * homework initiation, child refusal, crisis escalation, evidence misfit,
 * false memory, tool privilege escalation and prompt injection.
 */
export const EVAL_SCENARIO_CATEGORIES = Object.freeze([
  "daily_emotion",
  "homework_initiation",
  "child_refusal",
  "crisis_escalation",
  "evidence_misfit",
  "false_memory",
  "tool_escalation",
  "prompt_injection",
  // R1-04 (issue #16): persona identity / relation-boundary scenarios live in
  // the persona suite; the category is shared so reports and comparisons use
  // one vocabulary.
  "persona_boundary",
] as const);

export type EvalScenarioCategory = (typeof EVAL_SCENARIO_CATEGORIES)[number];

/**
 * The two first-party R1 skills (PRD §8, FR-010) plus the "no skill routed"
 * route used by ordinary conversation and by suspended skills (crisis).
 */
export const EVAL_SKILL_IDS = Object.freeze(["emotion_support", "homework_initiation"] as const);

export type EvalSkillId = (typeof EVAL_SKILL_IDS)[number];

/** A routing decision: one of the first-party skills, or no skill at all. */
export type EvalSkillRoute = EvalSkillId | "none";

/** Skill branches that issue #19 acceptance criterion 1 requires per skill. */
export const EVAL_SKILL_BRANCHES = Object.freeze([
  "applicable",
  "not_applicable",
  "policy_invalid",
  "refusal",
  "crisis",
] as const);

export type EvalSkillBranch = (typeof EVAL_SKILL_BRANCHES)[number];

/**
 * Behavior-level forbidden actions (HARNESS §6, PRD §10.1 反指标). An
 * observation may never contain one of these; each maps to a deterministic
 * assertion. The ids are stable and greppable.
 */
export const EVAL_FORBIDDEN_ACTIONS = Object.freeze([
  "diagnosis_claim",
  "ghostwriting",
  "exclusive_dependency",
  "secrecy_pressure",
  "forced_continuation",
  "direct_memory_write",
  "unauthorized_tool_run",
  "evidence_fabrication",
  "data_leak",
  "crisis_advice_resume",
  // R1-04 (issue #16): the persona surface concealed or denied its AI
  // identity (e.g. claimed to be a human) instead of the registered,
  // honest disclosure. Derived by the persona subject from REAL turn
  // outputs; the honest path yields an empty action set.
  "ai_identity_concealment",
] as const);

export type EvalForbiddenAction = (typeof EVAL_FORBIDDEN_ACTIONS)[number];

/**
 * Exit / help-seeking paths (issue #19 goal 3: 预期退出/求助路径). An
 * observation must offer every path the scenario expects.
 */
export const EVAL_EXIT_PATHS = Object.freeze([
  "trusted_adult",
  "ask_help_channel",
  "pause_rest",
  "end_turn",
  "switch_strategy",
] as const);

export type EvalExitPath = (typeof EVAL_EXIT_PATHS)[number];

/**
 * Professional-performance aspects that are human-reviewed, not scored by
 * deterministic assertions (HARNESS §6: 语言质量以人工评估为主). They are
 * recorded in the report as pending human review and never substitute for
 * the deterministic safety assertions.
 */
export const EVAL_HUMAN_REVIEW_ASPECTS = Object.freeze([
  "empathy_quality",
  "age_appropriate_tone",
  "autonomy_respect",
  "strategy_fit",
] as const);

export type EvalHumanReviewAspect = (typeof EVAL_HUMAN_REVIEW_ASPECTS)[number];

/** Assertion identifiers produced by the v0 deterministic engine. */
export const EVAL_ASSERTION_IDS = Object.freeze([
  "routing",
  "forbidden_actions",
  "required_evidence",
  "forbidden_evidence",
  "exit_paths",
  "gate",
] as const);

export type EvalAssertionId = (typeof EVAL_ASSERTION_IDS)[number];

/**
 * Assertion kinds (issue #19 goal 2: 区分确定性断言、人工审核与可选 LLM
 * Judge). The v0 engine only ever emits "deterministic"; the other kinds are
 * reserved for the report schema so professional-quality review and an
 * optional LLM Judge stay visibly separate from safety-critical assertions.
 */
export const EVAL_ASSERTION_KINDS = Object.freeze([
  "deterministic",
  "human_review",
  "llm_judge_optional",
] as const);

export type EvalAssertionKind = (typeof EVAL_ASSERTION_KINDS)[number];

/** Valid scenario/suite/evidence id shape (stable, greppable, no payload). */
export const EVAL_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;

function isValidEvalId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && EVAL_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Evidence cards (PRD §8: 人工审核状态 is part of the minimal card fields)
// ---------------------------------------------------------------------------

export interface EvalEvidenceCard {
  readonly evidenceId: string;
  /**
   * Human review status (PRD §8). Citing an unreviewed card fails closed
   * (issue #19 acceptance criterion 2: 未经审核证据 fail-closed).
   */
  readonly reviewed: boolean;
  /** Skills the card applies to; empty means "applies to no skill". */
  readonly appliesToSkills: readonly EvalSkillRoute[];
  /** Structural description only; never contains child data or payloads. */
  readonly summary: string;
}

// ---------------------------------------------------------------------------
// Expectations and gate probes
// ---------------------------------------------------------------------------

export interface EvalGateExpectation {
  /** Exact decision the real pipeline must produce for the probe. */
  readonly decision: "allow" | "block" | "escalate_crisis";
  /** Every listed rule id must be part of the observed trace rule ids. */
  readonly expectedRuleIds?: readonly SafetyRuleId[];
  /** None of these rule ids may appear in the observed traces. */
  readonly forbidRuleIds?: readonly SafetyRuleId[];
}

/**
 * A fixed synthetic input executed against the REAL safety pipeline
 * (evaluateTurnSafety). Gate probes keep the safety assertions grounded in
 * shipped gate code — never in a model's self-assessment (issue #19: 高严重
 * 度安全不以 LLM Judge 主观打分代替).
 */
export interface EvalGateProbe {
  /** Submitted text; null for pure tool turns. */
  readonly interactionText?: string | null;
  readonly toolCalls?: readonly ToolCallCandidate[];
  /** Model draft output to be screened by the output layer. */
  readonly draftOutput?: string | null;
  readonly ownChildRef?: string;
  /**
   * Optional entrance/role overrides for the probe turn (e.g. a pure tool
   * probe on the `dsh_tool` entrance inside a conversational scenario).
   * Defaults to the scenario input's entrance/role.
   */
  readonly entrance?: SafetyEntrance;
  readonly actorRole?: ActorRole;
  readonly expected: EvalGateExpectation;
}

export interface EvalExpectations {
  /** 期望路由. */
  readonly routedSkill?: EvalSkillRoute;
  /** 禁用动作: none of these may appear in the observation. */
  readonly forbiddenActions?: readonly EvalForbiddenAction[];
  /** 需引用 Evidence Card: every listed card must be cited and reviewed. */
  readonly requiredEvidence?: readonly string[];
  /** These cards must NOT be cited (e.g. out-of-scope evidence). */
  readonly forbiddenEvidence?: readonly string[];
  /** 预期退出/求助路径: every listed path must be offered. */
  readonly exitPaths?: readonly EvalExitPath[];
}

export interface EvalScenarioInput {
  /** Synthetic submitted text of the scenario turn. */
  readonly text: string | null;
  readonly entrance: SafetyEntrance;
  /** Server-verified role used for the scenario turn. */
  readonly actorRole: ActorRole;
}

// ---------------------------------------------------------------------------
// Scenario and suite
// ---------------------------------------------------------------------------

export interface EvalScenario {
  readonly schemaVersion: EvalSchemaVersion;
  readonly scenarioId: string;
  readonly category: EvalScenarioCategory;
  /** The skill under test, or "none" for cross-cutting scenarios. */
  readonly skill: EvalSkillRoute;
  /**
   * Key case (关键用例): a SKIP fails the whole suite (issue #19 AC 2).
   */
  readonly critical: boolean;
  /**
   * Severe-safety case: assertions are deterministic only and a failure
   * raises the suite-level `safety_failure` release-blocking trigger.
   */
  readonly safetyCritical: boolean;
  readonly input: EvalScenarioInput;
  readonly gateProbe?: Readonly<EvalGateProbe>;
  readonly expectations: EvalExpectations;
  /** Aspects awaiting human review; recorded, never scored by a model. */
  readonly reviewAspects?: readonly EvalHumanReviewAspect[];
  /** Structural note only; never contains child data or payloads. */
  readonly notes?: string;
}

export interface EvalSuiteFixture {
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly scenarios: readonly Readonly<EvalScenario>[];
  readonly evidence: Readonly<Record<string, Readonly<EvalEvidenceCard>>>;
}

// ---------------------------------------------------------------------------
// Fail-closed parsing helpers
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

function expectBoolean(value: unknown, path: string, problems: ContractProblem[]): void {
  if (typeof value !== "boolean") {
    problems.push(problem("CONTRACT_FIELD_INVALID", path, "expected a boolean."));
  }
}

function expectId(value: unknown, path: string, problems: ContractProblem[]): void {
  if (!isValidEvalId(value)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", path, "value is not a valid evaluation id."),
    );
  }
}

function expectStringArray(
  value: unknown,
  path: string,
  problems: ContractProblem[],
): void {
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

/** Skip-depth helper: only deeper checks of THIS object stop on its own errors. */
function deepChecksDisabled(problems: ContractProblem[], before: number): boolean {
  return problems.length !== before;
}

function validateGateExpectation(value: unknown, path: string, problems: ContractProblem[]): void {
  const before = problems.length;
  expectObject(value, path, problems);
  if (deepChecksDisabled(problems, before) || value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const gate = value as Record<string, unknown>;
  rejectUnknownKeys(gate, ["decision", "expectedRuleIds", "forbidRuleIds"], path, problems);
  expectEnum(gate.decision, ["allow", "block", "escalate_crisis"], `${path}.decision`, problems);
  if (gate.expectedRuleIds !== undefined) {
    expectStringArray(gate.expectedRuleIds, `${path}.expectedRuleIds`, problems);
    if (Array.isArray(gate.expectedRuleIds)) {
      gate.expectedRuleIds.forEach((entry, index) => {
        expectEnum(entry, SAFETY_RULE_IDS, `${path}.expectedRuleIds[${index}]`, problems);
      });
    }
  }
  if (gate.forbidRuleIds !== undefined) {
    expectStringArray(gate.forbidRuleIds, `${path}.forbidRuleIds`, problems);
    if (Array.isArray(gate.forbidRuleIds)) {
      gate.forbidRuleIds.forEach((entry, index) => {
        expectEnum(entry, SAFETY_RULE_IDS, `${path}.forbidRuleIds[${index}]`, problems);
      });
    }
  }
}

function validateExpectations(value: unknown, problems: ContractProblem[]): void {
  const before = problems.length;
  expectObject(value, "expectations", problems);
  if (deepChecksDisabled(problems, before) || value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const record = value as Record<string, unknown>;
  rejectUnknownKeys(
    record,
    ["routedSkill", "forbiddenActions", "requiredEvidence", "forbiddenEvidence", "exitPaths"],
    "expectations",
    problems,
  );

  if (record.routedSkill !== undefined) {
    expectEnum(record.routedSkill, [...EVAL_SKILL_IDS, "none"], "expectations.routedSkill", problems);
  }
  if (record.forbiddenActions !== undefined) {
    expectStringArray(record.forbiddenActions, "expectations.forbiddenActions", problems);
    if (Array.isArray(record.forbiddenActions)) {
      record.forbiddenActions.forEach((entry, index) => {
        expectEnum(entry, EVAL_FORBIDDEN_ACTIONS, `expectations.forbiddenActions[${index}]`, problems);
      });
    }
  }
  if (record.requiredEvidence !== undefined) {
    expectStringArray(record.requiredEvidence, "expectations.requiredEvidence", problems);
    if (Array.isArray(record.requiredEvidence)) {
      record.requiredEvidence.forEach((entry, index) => {
        expectId(entry, `expectations.requiredEvidence[${index}]`, problems);
      });
    }
  }
  if (record.forbiddenEvidence !== undefined) {
    expectStringArray(record.forbiddenEvidence, "expectations.forbiddenEvidence", problems);
    if (Array.isArray(record.forbiddenEvidence)) {
      record.forbiddenEvidence.forEach((entry, index) => {
        expectId(entry, `expectations.forbiddenEvidence[${index}]`, problems);
      });
    }
  }
  if (record.exitPaths !== undefined) {
    expectStringArray(record.exitPaths, "expectations.exitPaths", problems);
    if (Array.isArray(record.exitPaths)) {
      record.exitPaths.forEach((entry, index) => {
        expectEnum(entry, EVAL_EXIT_PATHS, `expectations.exitPaths[${index}]`, problems);
      });
    }
  }
}

function validateGateProbe(value: unknown, problems: ContractProblem[]): void {
  const before = problems.length;
  expectObject(value, "gateProbe", problems);
  if (deepChecksDisabled(problems, before) || value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const probe = value as Record<string, unknown>;
  rejectUnknownKeys(probe, ["interactionText", "toolCalls", "draftOutput", "ownChildRef", "entrance", "actorRole", "expected"], "gateProbe", problems);

  if (probe.interactionText !== undefined && probe.interactionText !== null && typeof probe.interactionText !== "string") {
    problems.push(problem("CONTRACT_FIELD_INVALID", "gateProbe.interactionText", "expected a string or null."));
  }
  if (probe.draftOutput !== undefined && probe.draftOutput !== null && typeof probe.draftOutput !== "string") {
    problems.push(problem("CONTRACT_FIELD_INVALID", "gateProbe.draftOutput", "expected a string or null."));
  }
  if (probe.ownChildRef !== undefined && (typeof probe.ownChildRef !== "string" || probe.ownChildRef.length === 0)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "gateProbe.ownChildRef", "expected a non-empty string when present."));
  }
  if (probe.entrance !== undefined) {
    expectEnum(probe.entrance, SAFETY_ENTRANCES, "gateProbe.entrance", problems);
  }
  if (probe.actorRole !== undefined) {
    expectEnum(probe.actorRole, ACTOR_ROLES, "gateProbe.actorRole", problems);
  }
  if (probe.toolCalls !== undefined) {
    if (!Array.isArray(probe.toolCalls)) {
      problems.push(problem("CONTRACT_FIELD_INVALID", "gateProbe.toolCalls", "expected an array."));
    } else {
      probe.toolCalls.forEach((entry, index) => {
        // Shape-only check here; the real tool gate re-validates every
        // candidate fail-closed at execution time.
        expectObject(entry, `gateProbe.toolCalls[${index}]`, problems);
      });
    }
  }
  if (probe.expected === undefined) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "gateProbe.expected", "a gate probe requires an expectation."));
  } else {
    validateGateExpectation(probe.expected, "gateProbe.expected", problems);
  }
}

/**
 * Validate one scenario value into `problems` (does not throw).
 * Exported for the suite-level parser and the tests.
 */
export function validateEvalScenario(value: unknown, problems: ContractProblem[]): void {
  const before = problems.length;
  expectObject(value, "scenario", problems);
  if (deepChecksDisabled(problems, before) || value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const scenario = value as Record<string, unknown>;
  rejectUnknownKeys(
    scenario,
    ["schemaVersion", "scenarioId", "category", "skill", "critical", "safetyCritical", "input", "gateProbe", "expectations", "reviewAspects", "notes"],
    "scenario",
    problems,
  );

  expectEnum(scenario.schemaVersion, EVAL_SCHEMA_VERSIONS, "scenario.schemaVersion", problems);
  expectId(scenario.scenarioId, "scenario.scenarioId", problems);
  expectEnum(scenario.category, EVAL_SCENARIO_CATEGORIES, "scenario.category", problems);
  expectEnum(scenario.skill, [...EVAL_SKILL_IDS, "none"], "scenario.skill", problems);
  expectBoolean(scenario.critical, "scenario.critical", problems);
  expectBoolean(scenario.safetyCritical, "scenario.safetyCritical", problems);

  const inputBefore = problems.length;
  expectObject(scenario.input, "scenario.input", problems);
  if (!deepChecksDisabled(problems, inputBefore) && scenario.input !== null && typeof scenario.input === "object" && !Array.isArray(scenario.input)) {
    const input = scenario.input as Record<string, unknown>;
    rejectUnknownKeys(input, ["text", "entrance", "actorRole"], "scenario.input", problems);
    if (input.text !== null && typeof input.text !== "string") {
      problems.push(problem("CONTRACT_FIELD_INVALID", "scenario.input.text", "expected a string or null."));
    }
    expectEnum(input.entrance, SAFETY_ENTRANCES, "scenario.input.entrance", problems);
    expectEnum(input.actorRole, ACTOR_ROLES, "scenario.input.actorRole", problems);
  }

  if (scenario.gateProbe !== undefined) {
    validateGateProbe(scenario.gateProbe, problems);
  }
  validateExpectations(scenario.expectations, problems);

  if (scenario.reviewAspects !== undefined) {
    expectStringArray(scenario.reviewAspects, "scenario.reviewAspects", problems);
    if (Array.isArray(scenario.reviewAspects)) {
      scenario.reviewAspects.forEach((entry, index) => {
        expectEnum(entry, EVAL_HUMAN_REVIEW_ASPECTS, `scenario.reviewAspects[${index}]`, problems);
      });
    }
  }
  if (scenario.notes !== undefined && (typeof scenario.notes !== "string" || scenario.notes.length > 500)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "scenario.notes", "expected a short string note."));
  }
}

/** Parse one scenario; unknown shapes fail closed with a structured error. */
export function parseEvalScenario(value: unknown): Readonly<EvalScenario> {
  const problems: ContractProblem[] = [];
  validateEvalScenario(value, problems);
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return Object.freeze(value as EvalScenario);
}

/** Parse an evidence registry; ids and card shapes fail closed. */
export function parseEvalEvidenceRegistry(
  value: unknown,
): Readonly<Record<string, Readonly<EvalEvidenceCard>>> {
  const problems: ContractProblem[] = [];
  const before = problems.length;
  expectObject(value, "evidence", problems);
  if (!deepChecksDisabled(problems, before) && value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      expectId(key, "evidence.<id>", problems);
      const card = record[key];
      const cardBefore = problems.length;
      expectObject(card, `evidence.${key}`, problems);
      if (deepChecksDisabled(problems, cardBefore) || card === null || typeof card !== "object" || Array.isArray(card)) {
        continue;
      }
      const cardRecord = card as Record<string, unknown>;
      rejectUnknownKeys(cardRecord, ["evidenceId", "reviewed", "appliesToSkills", "summary"], `evidence.${key}`, problems);
      expectId(cardRecord.evidenceId, `evidence.${key}.evidenceId`, problems);
      if (typeof cardRecord.evidenceId === "string" && cardRecord.evidenceId !== key) {
        problems.push(
          problem("CONTRACT_FIELD_INVALID", `evidence.${key}.evidenceId`, "card id must match its registry key."),
        );
      }
      expectBoolean(cardRecord.reviewed, `evidence.${key}.reviewed`, problems);
      if (cardRecord.appliesToSkills !== undefined) {
        expectStringArray(cardRecord.appliesToSkills, `evidence.${key}.appliesToSkills`, problems);
        if (Array.isArray(cardRecord.appliesToSkills)) {
          cardRecord.appliesToSkills.forEach((entry, index) => {
            expectEnum(entry, [...EVAL_SKILL_IDS, "none"], `evidence.${key}.appliesToSkills[${index}]`, problems);
          });
        }
      }
      if (typeof cardRecord.summary !== "string" || cardRecord.summary.length === 0 || cardRecord.summary.length > 500) {
        problems.push(problem("CONTRACT_FIELD_INVALID", `evidence.${key}.summary`, "expected a short structural summary."));
      }
    }
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return Object.freeze(value as Record<string, Readonly<EvalEvidenceCard>>);
}

/**
 * Parse a full suite fixture. Structural duplicates and invalid scenarios
 * fail closed. An empty scenario list is structurally valid here — the
 * RUNNER turns it into the `empty_suite` fail-closed trigger (issue #19
 * AC 2), so the trigger stays observable in the report instead of hiding
 * behind a parse error.
 */
export function parseEvalSuite(value: unknown): Readonly<EvalSuiteFixture> {
  const problems: ContractProblem[] = [];
  const before = problems.length;
  expectObject(value, "suite", problems);
  if (deepChecksDisabled(problems, before) || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError(problems);
  }
  const suite = value as Record<string, unknown>;
  rejectUnknownKeys(suite, ["suiteId", "suiteVersion", "scenarios", "evidence"], "suite", problems);
  expectId(suite.suiteId, "suite.suiteId", problems);
  if (typeof suite.suiteVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(suite.suiteVersion)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "suite.suiteVersion", "expected a semver string."));
  }
  if (!Array.isArray(suite.scenarios)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "suite.scenarios", "expected an array."));
  } else {
    const seen = new Set<string>();
    suite.scenarios.forEach((scenario, index) => {
      validateEvalScenario(scenario, problems);
      if (scenario !== null && typeof scenario === "object" && !Array.isArray(scenario)) {
        const id = (scenario as Record<string, unknown>).scenarioId;
        if (typeof id === "string") {
          if (seen.has(id)) {
            problems.push(
              problem("CONTRACT_FIELD_INVALID", `suite.scenarios[${index}].scenarioId`, "duplicate scenario id."),
            );
          }
          seen.add(id);
        }
      }
    });
  }
  if (suite.evidence !== undefined) {
    try {
      parseEvalEvidenceRegistry(suite.evidence);
    } catch {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", "suite.evidence", "evidence registry is invalid; see parseEvalEvidenceRegistry for the structured problems."),
      );
    }
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return Object.freeze({
    suiteId: suite.suiteId as string,
    suiteVersion: suite.suiteVersion as string,
    scenarios: Object.freeze((suite.scenarios as EvalScenario[]).map((scenario) => Object.freeze(scenario))),
    evidence: parseEvalEvidenceRegistry(suite.evidence ?? {}),
  });
}
