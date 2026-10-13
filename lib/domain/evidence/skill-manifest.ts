/**
 * R1-13 Skill Manifest v0 schema (docs/EVIDENCE_POLICY.md, PRD §8, FR-010,
 * Roadmap R1-13, issue #25).
 *
 * A Skill Manifest is the versioned governance record of one first-party
 * professional skill (PRD §8 Skill 最小字段): skill_id/version, goal,
 * entrance signals, applicable and disabled (禁忌) conditions, the pinned
 * Evidence Card bindings (循证依据, bound to exact card versions), the
 * stepwise strategy, tool capabilities, child-selectable exit paths and the
 * evaluation references that tie the skill to the R1-07 eval regression
 * suite.
 *
 * Honest-observation design (review note from the approved R1-07 review):
 * the manifest deliberately contains NO self-reported outcome/pass-fail
 * field. Results and metrics live in the eval suite + run reports (derived
 * from real turn outputs through the EvalSubject adapter), never in a
 * manifest that the skill could write about itself. `evaluationRefs` only
 * pins WHICH scenarios evaluate this skill.
 *
 * Fail-closed rules:
 * - `efficacyStatement` accepts exactly one registered value
 *   (`no_ai_efficacy_claim`): a skill manifest can never register a claim
 *   that AI-agent efficacy has been proven (issue #25 交付范围 4);
 * - `toolCapabilities` ids must match the safety tool-id shape and are
 *   checked against the SAFE_TOOL_REGISTRY whitelist at registry level —
 *   no unregistered tool can be advertised;
 * - `exitPaths` reuse the eval exit-path vocabulary so every skill offers
 *   child-selectable exits in the same language the eval suite asserts;
 * - at least one Evidence Card binding and one disabled condition are
 *   mandatory (双 Skill 均须绑定已核验证据卡并声明禁忌).
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { failOnProblems, problem, type ContractProblem } from "../contract/core.ts";
import { TOOL_ID_PATTERN } from "../safety/tool-gate.ts";
import { EVAL_EXIT_PATHS, EVAL_SKILL_IDS, type EvalExitPath, type EvalSkillId } from "../eval/scenario.ts";

import {
  GOVERNANCE_ID_PATTERN,
  validateHumanReview,
  type HumanReviewV0,
} from "./card.ts";

// ---------------------------------------------------------------------------
// Version registry (fail-closed, mirrors the interaction/safety contracts)
// ---------------------------------------------------------------------------

/**
 * Supported Skill Manifest schema versions. Appending an entry is the ONLY
 * way to accept a new version; unknown versions fail closed.
 */
export const SKILL_MANIFEST_SCHEMA_VERSIONS = Object.freeze(["1.0"] as const);

export type SkillManifestSchemaVersion = (typeof SKILL_MANIFEST_SCHEMA_VERSIONS)[number];

/** Latest supported Skill Manifest schema version. */
export const SKILL_MANIFEST_SCHEMA_VERSION: SkillManifestSchemaVersion =
  SKILL_MANIFEST_SCHEMA_VERSIONS[SKILL_MANIFEST_SCHEMA_VERSIONS.length - 1];

/**
 * The only registered efficacy statement. A manifest that claims proven AI
 * efficacy cannot even be parsed; the value space makes the forbidden
 * inference (school-practice evidence ⇒ AI-agent efficacy) unrepresentable.
 */
export const SKILL_EFFICACY_STATEMENTS = Object.freeze(["no_ai_efficacy_claim"] as const);
export type SkillEfficacyStatement = (typeof SKILL_EFFICACY_STATEMENTS)[number];

// ---------------------------------------------------------------------------
// Manifest shape
// ---------------------------------------------------------------------------

/** One pinned Evidence Card binding (循证依据, exact version — no drift). */
export interface EvidenceBinding {
  readonly cardId: string;
  readonly cardVersion: string;
}

export interface SkillManifestV0 {
  readonly schemaVersion: SkillManifestSchemaVersion;
  /** First-party skill id (same vocabulary as the eval suite). */
  readonly skillId: EvalSkillId;
  /** Content version (semver); bumped by a human revision + re-review. */
  readonly version: string;
  /** 结构化目标 (structural; no child data). */
  readonly goal: string;
  /** 入口信号 — structural signal ids the router may match on. */
  readonly entranceSignals: readonly string[];
  /** 适用条件. */
  readonly applicableConditions: readonly string[];
  /** 禁用条件 — at least one is mandatory. */
  readonly disabledConditions: readonly string[];
  /** 循证依据 — pinned Evidence Card versions (at least one, no drift). */
  readonly evidenceBindings: readonly Readonly<EvidenceBinding>[];
  /** 分步策略 — structural steps, never payloads. */
  readonly strategySteps: readonly string[];
  /** 工具能力 — subset of the SAFE_TOOL_REGISTRY whitelist (may be empty). */
  readonly toolCapabilities: readonly string[];
  /** 儿童可选择退出路径 — eval exit-path vocabulary, non-empty. */
  readonly exitPaths: readonly EvalExitPath[];
  /** Fixed statement: this manifest makes no proven-AI-efficacy claim. */
  readonly efficacyStatement: SkillEfficacyStatement;
  /** Scenario ids of the eval suite that regression-test this skill. */
  readonly evaluationRefs: readonly string[];
  /** 更新时间 of the manifest content (ISO date). */
  readonly updatedAt: string;
  readonly review: HumanReviewV0;
}

// ---------------------------------------------------------------------------
// Fail-closed parsing helpers (local; mirrors card.ts conventions)
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

function expectSemver(value: unknown, path: string, problems: ContractProblem[]): void {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", path, "expected a semver string."));
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
  minItems: number,
  maxItems: number,
  maxItemLength: number,
  problems: ContractProblem[],
): void {
  if (!Array.isArray(value)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", path, "expected an array."));
    return;
  }
  if (value.length < minItems || value.length > maxItems) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", path, `expected between ${minItems} and ${maxItems} items.`),
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

// ---------------------------------------------------------------------------
// Manifest parser
// ---------------------------------------------------------------------------

/** Validate one Skill Manifest v0 value into `problems` (does not throw). */
export function validateSkillManifestV0(value: unknown, problems: ContractProblem[]): void {
  const before = problems.length;
  expectObject(value, "manifest", problems);
  if (deepChecksDisabled(problems, before) || value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const manifest = value as Record<string, unknown>;
  rejectUnknownKeys(
    manifest,
    [
      "schemaVersion",
      "skillId",
      "version",
      "goal",
      "entranceSignals",
      "applicableConditions",
      "disabledConditions",
      "evidenceBindings",
      "strategySteps",
      "toolCapabilities",
      "exitPaths",
      "efficacyStatement",
      "evaluationRefs",
      "updatedAt",
      "review",
    ],
    "manifest",
    problems,
  );

  expectEnum(manifest.schemaVersion, SKILL_MANIFEST_SCHEMA_VERSIONS, "manifest.schemaVersion", problems);
  expectEnum(manifest.skillId, EVAL_SKILL_IDS, "manifest.skillId", problems);
  expectSemver(manifest.version, "manifest.version", problems);
  expectEnum(manifest.efficacyStatement, SKILL_EFFICACY_STATEMENTS, "manifest.efficacyStatement", problems);
  expectIsoDate(manifest.updatedAt, "manifest.updatedAt", problems);
  expectBoundedString(manifest.goal, "manifest.goal", 300, problems);
  expectBoundedStringArray(manifest.entranceSignals, "manifest.entranceSignals", 1, 8, 120, problems);
  expectBoundedStringArray(manifest.applicableConditions, "manifest.applicableConditions", 1, 10, 300, problems);
  expectBoundedStringArray(manifest.disabledConditions, "manifest.disabledConditions", 1, 10, 300, problems);
  expectBoundedStringArray(manifest.strategySteps, "manifest.strategySteps", 1, 10, 300, problems);

  // evidenceBindings: 1..10 pinned bindings, shape-checked here; resolution
  // against the evidence registry happens at registry level (fail-closed).
  if (!Array.isArray(manifest.evidenceBindings) || manifest.evidenceBindings.length === 0) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "manifest.evidenceBindings", "expected a non-empty array of bindings."),
    );
  } else if (manifest.evidenceBindings.length > 10) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "manifest.evidenceBindings", "at most 10 bindings."));
  } else {
    manifest.evidenceBindings.forEach((entry, index) => {
      const bindingBefore = problems.length;
      expectObject(entry, `manifest.evidenceBindings[${index}]`, problems);
      if (
        deepChecksDisabled(problems, bindingBefore) ||
        entry === null ||
        typeof entry !== "object" ||
        Array.isArray(entry)
      ) {
        return;
      }
      const binding = entry as Record<string, unknown>;
      rejectUnknownKeys(binding, ["cardId", "cardVersion"], `manifest.evidenceBindings[${index}]`, problems);
      if (typeof binding.cardId !== "string" || !GOVERNANCE_ID_PATTERN.test(binding.cardId)) {
        problems.push(
          problem("CONTRACT_FIELD_INVALID", `manifest.evidenceBindings[${index}].cardId`, "expected a governance id."),
        );
      }
      expectSemver(binding.cardVersion, `manifest.evidenceBindings[${index}].cardVersion`, problems);
    });
  }

  // toolCapabilities: shape must match the safety tool-id pattern; the
  // membership check against SAFE_TOOL_REGISTRY happens at registry level.
  if (manifest.toolCapabilities !== undefined) {
    if (!Array.isArray(manifest.toolCapabilities) || manifest.toolCapabilities.length > 8) {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", "manifest.toolCapabilities", "expected an array of at most 8 tool ids."),
      );
    } else {
      manifest.toolCapabilities.forEach((entry, index) => {
        if (typeof entry !== "string" || !TOOL_ID_PATTERN.test(entry)) {
          problems.push(
            problem("CONTRACT_FIELD_INVALID", `manifest.toolCapabilities[${index}]`, "expected a valid tool id."),
          );
        }
      });
    }
  }

  // exitPaths: eval vocabulary, non-empty (PRD §8: 儿童可选择退出路径).
  if (!Array.isArray(manifest.exitPaths) || manifest.exitPaths.length === 0) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "manifest.exitPaths", "expected a non-empty array of exit paths."),
    );
  } else {
    manifest.exitPaths.forEach((entry, index) => {
      expectEnum(entry, EVAL_EXIT_PATHS, `manifest.exitPaths[${index}]`, problems);
    });
  }

  // evaluationRefs: eval scenario ids (resolution against the suite happens
  // at registry level). Shape-only here.
  if (!Array.isArray(manifest.evaluationRefs) || manifest.evaluationRefs.length === 0) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "manifest.evaluationRefs", "expected a non-empty array of scenario ids."),
    );
  } else if (manifest.evaluationRefs.length > 20) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "manifest.evaluationRefs", "at most 20 scenario refs."));
  } else {
    manifest.evaluationRefs.forEach((entry, index) => {
      if (typeof entry !== "string" || !GOVERNANCE_ID_PATTERN.test(entry)) {
        problems.push(
          problem("CONTRACT_FIELD_INVALID", `manifest.evaluationRefs[${index}]`, "expected a governance id."),
        );
      }
    });
  }

  validateHumanReview(manifest.review, "manifest.review", problems);
}

/** Parse one Skill Manifest v0; unknown shapes fail closed. */
export function parseSkillManifestV0(value: unknown): Readonly<SkillManifestV0> {
  const problems: ContractProblem[] = [];
  validateSkillManifestV0(value, problems);
  failOnProblems(problems);
  return Object.freeze(value as SkillManifestV0);
}
