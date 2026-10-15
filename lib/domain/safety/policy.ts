/**
 * R1-15 versioned safety policy registry (docs/SAFETY_POLICY.md).
 *
 * The Safety Gate implements PRD §5.1 "安全分层": entry (Input Gate), before
 * tools (Tool Gate) and after output (Output Gate) enforce independently —
 * never only via a system prompt or a single LLM self-check (PRD FR-002 /
 * FR-005 / FR-007, Roadmap R1-15, issue #27).
 *
 * Trust model: every rule in this registry is server-owned. User messages,
 * retrieval documents, tool results and model output are all treated as
 * untrusted attack surface (PRD §10.1) and can never add, remove or rewrite
 * rules, policy versions or decisions. The only way to accept a new policy
 * version or rule is to register it here and pass the gate tests; unknown
 * values fail closed.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import {
  ContractValidationError,
  problem,
  type ContractProblem,
} from "../contract/core.ts";

// ---------------------------------------------------------------------------
// Policy version registry (fail-closed, mirrors the interaction contract)
// ---------------------------------------------------------------------------

/**
 * Supported safety policy versions. The first released version. Adding an
 * entry is the ONLY way to accept a new version; unknown versions are
 * rejected fail-closed (issue #27: 版本化三层策略接口).
 */
export const SAFETY_POLICY_VERSIONS = Object.freeze(["1.0"] as const);

export type SafetyPolicyVersion = (typeof SAFETY_POLICY_VERSIONS)[number];

/** Latest supported safety policy version. */
export const SAFETY_POLICY_VERSION: SafetyPolicyVersion =
  SAFETY_POLICY_VERSIONS[SAFETY_POLICY_VERSIONS.length - 1];

export function isSupportedSafetyPolicyVersion(
  value: unknown,
): value is SafetyPolicyVersion {
  return (
    typeof value === "string" &&
    (SAFETY_POLICY_VERSIONS as readonly string[]).includes(value)
  );
}

/** Validate a caller-supplied policy version; unknown versions fail closed. */
export function assertSupportedSafetyPolicyVersion(
  value: unknown,
  path: string,
): void {
  if (isSupportedSafetyPolicyVersion(value)) {
    return;
  }
  // The offending value is intentionally not echoed.
  throw new ContractValidationError([
    problem(
      "CONTRACT_UNKNOWN_VERSION",
      path,
      "safety policy version is not a supported version; " +
        `supported versions are: ${SAFETY_POLICY_VERSIONS.join(", ")}.`,
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** The three enforced layers of the Safety Gate (docs/SAFETY_POLICY.md §2). */
export const SAFETY_LAYERS = Object.freeze(["input", "tool", "output"] as const);
export type SafetyLayer = (typeof SAFETY_LAYERS)[number];

/** Risk levels recorded in structured safety traces. */
export const SAFETY_SEVERITIES = Object.freeze(["low", "medium", "high"] as const);
export type SafetySeverity = (typeof SAFETY_SEVERITIES)[number];

/** Decisions a gate can return. There is no "temporarily allow". */
export const SAFETY_DECISIONS = Object.freeze([
  "allow",
  "block",
  "escalate_crisis",
] as const);
export type SafetyGateDecision = (typeof SAFETY_DECISIONS)[number];

/**
 * The enforced entrances that MUST route through the Safety Gate
 * (issue #27 acceptance criterion 3): the Web UI turn path, the text API
 * (POST /api/v1/interactions), DSH tool invocations — and, since E2E-01
 * (issue #51), the transient voice transcript path: an ASR final may only
 * cross toward a model request after the input layer screens it.
 */
export const SAFETY_ENTRANCES = Object.freeze(["ui_web", "api_text", "dsh_tool", "voice"] as const);
export type SafetyEntrance = (typeof SAFETY_ENTRANCES)[number];

// ---------------------------------------------------------------------------
// Rule registry
// ---------------------------------------------------------------------------

/**
 * Stable, greppable rule ids. Rules are namespaced by layer and only ever
 * added here; traces may only reference ids from this registry (fail-closed).
 */
export const SAFETY_RULE_IDS = [
  // Input layer
  "input.prompt_injection",
  "input.role_forgery",
  "input.privacy_overreach",
  "input.crisis_signals",
  // Tool layer
  "tool.dangerous_category",
  "tool.unregistered",
  "tool.schema_forgery",
  "tool.permission_overreach",
  "tool.memory_write_unauthorized",
  "tool.privacy_overreach",
  // Output layer
  "output.exclusive_dependency",
  "output.secrecy_pressure",
  "output.diagnosis_claim",
  "output.ghostwriting",
  "output.age_inappropriate",
  "output.data_leak",
  "output.crisis_referral_missing",
  "output.gate_unavailable",
] as const;

export type SafetyRuleId = (typeof SAFETY_RULE_IDS)[number];

export interface SafetyRuleSpec {
  readonly id: SafetyRuleId;
  readonly layer: SafetyLayer;
  readonly severity: SafetySeverity;
  /**
   * Structural summary of the rule. Must never embed attack payloads,
   * credentials or child data.
   */
  readonly summary: string;
}

/**
 * Server-owned safety rule registry v1.0 (docs/SAFETY_POLICY.md §3).
 * Every rule is enforced server-side; untrusted content cannot override it.
 */
export const SAFETY_RULES: Readonly<Record<SafetyRuleId, SafetyRuleSpec>> =
  Object.freeze({
    "input.prompt_injection": {
      id: "input.prompt_injection",
      layer: "input",
      severity: "high",
      summary:
        "Submitted text tries to override or reveal trusted system instructions.",
    },
    "input.role_forgery": {
      id: "input.role_forgery",
      layer: "input",
      severity: "high",
      summary:
        "Submitted text forges a parent/guardian/staff/system identity or a " +
        "self-asserted verification to unlock privileges.",
    },
    "input.privacy_overreach": {
      id: "input.privacy_overreach",
      layer: "input",
      severity: "high",
      summary:
        "Submitted text requests private data of other people, other children " +
        "or protected system data.",
    },
    "input.crisis_signals": {
      id: "input.crisis_signals",
      layer: "input",
      severity: "high",
      summary:
        "Self-harm, abuse or severe danger cues trigger the crisis branch: " +
        "normal advice is suspended and the deterministic crisis-safe " +
        "response is used instead.",
    },
    "tool.dangerous_category": {
      id: "tool.dangerous_category",
      layer: "tool",
      severity: "high",
      summary:
        "Tool call requests a forbidden category or permission (shell/PTY, " +
        "arbitrary file system, arbitrary network, plugin install, sub-agent " +
        "spawn, raw database access).",
    },
    "tool.unregistered": {
      id: "tool.unregistered",
      layer: "tool",
      severity: "high",
      summary: "Tool call references a tool that is not in the whitelist registry.",
    },
    "tool.schema_forgery": {
      id: "tool.schema_forgery",
      layer: "tool",
      severity: "high",
      summary:
        "Tool descriptor (category/version/permissions) does not match the " +
        "registered descriptor of that tool id.",
    },
    "tool.permission_overreach": {
      id: "tool.permission_overreach",
      layer: "tool",
      severity: "high",
      summary:
        "Registered tool requests a permission that is not part of its " +
        "registered permission set (privilege escalation beyond the " +
        "positive whitelist).",
    },
    "tool.memory_write_unauthorized": {
      id: "tool.memory_write_unauthorized",
      layer: "tool",
      severity: "high",
      summary:
        "Tool call requests a direct memory write instead of the " +
        "candidate-only proposal path.",
    },
    "tool.privacy_overreach": {
      id: "tool.privacy_overreach",
      layer: "tool",
      severity: "high",
      summary:
        "Verified actor role is not allowed to call this tool, or the call " +
        "requests child-data export / raw audio access.",
    },
    "output.exclusive_dependency": {
      id: "output.exclusive_dependency",
      layer: "output",
      severity: "high",
      summary:
        "Model output claims an exclusive relationship or encourages " +
        "emotional dependency.",
    },
    "output.secrecy_pressure": {
      id: "output.secrecy_pressure",
      layer: "output",
      severity: "high",
      summary:
        "Model output asks the child to keep secrets or promises secrecy " +
        "from parents/guardians.",
    },
    "output.diagnosis_claim": {
      id: "output.diagnosis_claim",
      layer: "output",
      severity: "high",
      summary:
        "Model output issues clinical diagnoses or treatment claims " +
        "(impersonating clinical consultation).",
    },
    "output.ghostwriting": {
      id: "output.ghostwriting",
      layer: "output",
      severity: "medium",
      summary: "Model output offers to do the homework for the child.",
    },
    "output.age_inappropriate": {
      id: "output.age_inappropriate",
      layer: "output",
      severity: "high",
      summary: "Model output contains age-inappropriate sexual or violent content.",
    },
    "output.data_leak": {
      id: "output.data_leak",
      layer: "output",
      severity: "high",
      summary:
        "Model output leaks credentials/secrets, protected environment data " +
        "or child references other than the session's own.",
    },
    "output.crisis_referral_missing": {
      id: "output.crisis_referral_missing",
      layer: "output",
      severity: "high",
      summary:
        "During a crisis escalation the output is not the deterministic " +
        "crisis-safe response (missed referral is blocked).",
    },
    "output.gate_unavailable": {
      id: "output.gate_unavailable",
      layer: "output",
      severity: "high",
      summary:
        "The Output Gate itself failed or returned an unusable result; the " +
        "turn fails closed instead of being released (issue #27 AC 2).",
    },
  });

/** All rule ids belonging to one layer, registry order preserved. */
export function safetyRuleIdsForLayer(layer: SafetyLayer): readonly SafetyRuleId[] {
  return SAFETY_RULE_IDS.filter((id) => SAFETY_RULES[id].layer === layer);
}

/**
 * Validate a rule reference; unknown rule ids fail closed so traces can
 * never be polluted with invented ids.
 */
export function validateSafetyRuleId(
  value: unknown,
  path: string,
  problems: ContractProblem[],
): void {
  if (
    typeof value === "string" &&
    (SAFETY_RULE_IDS as readonly string[]).includes(value)
  ) {
    return;
  }
  problems.push(
    problem(
      "CONTRACT_FIELD_INVALID",
      path,
      "safety rule id is not registered in the safety policy registry; " +
        "the submitted value is not echoed.",
    ),
  );
}

/** Fail-closed throwing form of {@link validateSafetyRuleId}. */
export function assertKnownSafetyRuleId(value: unknown, path: string): void {
  const problems: ContractProblem[] = [];
  validateSafetyRuleId(value, path, problems);
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
}

// ---------------------------------------------------------------------------
// Rule hits
// ---------------------------------------------------------------------------

/** A matched rule with its layer and risk level (registry metadata only). */
export interface SafetyRuleHit {
  readonly ruleId: SafetyRuleId;
  readonly layer: SafetyLayer;
  readonly severity: SafetySeverity;
}

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Readonly<Record<SafetySeverity, number>> = Object.freeze({
  low: 0,
  medium: 1,
  high: 2,
});

export function severityRank(severity: SafetySeverity): number {
  return SEVERITY_RANK[severity];
}

/**
 * Highest severity of the given rule ids; "low" when the list is empty.
 * Unknown rule ids fail closed.
 */
export function maxSeverityOf(ruleIds: readonly SafetyRuleId[]): SafetySeverity {
  let max: SafetySeverity = "low";
  for (const id of ruleIds) {
    assertKnownSafetyRuleId(id, "ruleIds[]");
    const severity = SAFETY_RULES[id].severity;
    if (severityRank(severity) > severityRank(max)) {
      max = severity;
    }
  }
  return max;
}
