/**
 * R1-15 structured safety trace records (docs/SAFETY_POLICY.md §6).
 *
 * Every gate decision produces one trace record carrying policy version,
 * decision, matched rule ids and risk level — and NEVER raw sensitive
 * content (issue #27: 结构化记录 gate_decision、policy_version、rule_id 和
 * 风险级别，不记录原始敏感内容). Unknown fields — top-level and inside
 * refs — are rejected fail-closed so a leaky caller cannot smuggle payload
 * text into a trace.
 */

import {
  ContractValidationError,
  isValidContractTimestamp,
  problem,
  validateContractId,
  type ContractProblem,
} from "../contract/core.ts";

import {
  SAFETY_DECISIONS,
  SAFETY_ENTRANCES,
  SAFETY_LAYERS,
  SAFETY_POLICY_VERSION,
  SAFETY_POLICY_VERSIONS,
  SAFETY_RULES,
  maxSeverityOf,
  type SafetyEntrance,
  type SafetyGateDecision,
  type SafetyLayer,
  type SafetyPolicyVersion,
  type SafetyRuleId,
  type SafetySeverity,
} from "./policy.ts";

/** Stable, registry-constrained reason codes for a trace record. */
export const SAFETY_TRACE_REASONS = Object.freeze([
  "rule_hit",
  "crisis_escalation",
  "gate_unavailable",
] as const);
export type SafetyTraceReason = (typeof SAFETY_TRACE_REASONS)[number];

/**
 * Correlation ids echoed into the trace. Every present id is re-validated
 * against the unified contract ID vocabulary; unvalidated client values are
 * dropped by the caller (same rule as the error envelope).
 */
export interface SafetyTraceRefs {
  readonly requestId?: string;
  readonly traceId?: string;
  readonly turnId?: string;
}

export interface SafetyTraceRecord {
  readonly policyVersion: SafetyPolicyVersion;
  readonly layer: SafetyLayer;
  readonly decision: SafetyGateDecision;
  /** Matched registry rules; empty exactly when the decision is "allow". */
  readonly ruleIds: readonly SafetyRuleId[];
  /** Highest severity of `ruleIds`; "low" when the decision is "allow". */
  readonly riskLevel: SafetySeverity;
  readonly reason: SafetyTraceReason;
  /** Entrance that produced this decision (AC 3: three enforced entrances). */
  readonly entrance?: SafetyEntrance;
  readonly refs: Readonly<SafetyTraceRefs>;
  readonly decidedAt: string;
}

export interface BuildSafetyTraceParams {
  readonly layer: SafetyLayer;
  readonly decision: SafetyGateDecision;
  readonly ruleIds: readonly SafetyRuleId[];
  readonly reason: SafetyTraceReason;
  readonly entrance?: SafetyEntrance;
  readonly refs?: Readonly<SafetyTraceRefs>;
  /** Optional fixed timestamp (tests pass deterministic values). */
  readonly decidedAt?: string;
}

const TRACE_REF_KINDS: Readonly<Record<keyof SafetyTraceRefs, "requestId" | "traceId" | "turnId">> =
  Object.freeze({
    requestId: "requestId",
    traceId: "traceId",
    turnId: "turnId",
  });

/**
 * Non-cryptographic FNV-1a fingerprint (pure JS — the domain layer imports
 * no node builtins). Used only to correlate masked unknown-field names in
 * structured problems; it is not a security control.
 */
function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Masked, purely structural stand-in for an untrusted unknown field name
 * (review round 1 P2-4): the key itself can carry attacker-chosen text, so
 * neither the value nor the full key is ever echoed into a problem path —
 * only the key length plus a short digest, for debug correlation.
 */
function describeUnknownFieldKey(key: string): string {
  return `<unknown:len=${key.length}#fnv1a-${fnv1aHex(key)}>`;
}

function validateRefs(refs: Readonly<SafetyTraceRefs>, problems: ContractProblem[]): void {
  // Allow-list iteration: keys are checked against the known ref kinds first
  // so an untrusted caller cannot smuggle raw content into a trace through
  // an unknown refs side channel (issue #27: traces never record raw
  // sensitive content). Only requestId/traceId/turnId exist.
  for (const key of Object.keys(refs)) {
    if (!Object.prototype.hasOwnProperty.call(TRACE_REF_KINDS, key)) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          `refs.${describeUnknownFieldKey(key)}`,
          "refs carries an unknown field; only requestId/traceId/turnId refs are recorded.",
        ),
      );
      continue;
    }
    const value = refs[key as keyof SafetyTraceRefs];
    if (value === undefined) {
      continue;
    }
    validateContractId(TRACE_REF_KINDS[key as keyof SafetyTraceRefs], value, `refs.${key}`, problems);
  }
}

function assertDecisionConsistency(
  decision: SafetyGateDecision,
  ruleIds: readonly SafetyRuleId[],
  layer: SafetyLayer,
  pathDecision: string,
  problems: ContractProblem[],
): void {
  if (decision === "allow" && ruleIds.length !== 0) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        pathDecision,
        'decision "allow" must not reference any rule id.',
      ),
    );
  }
  if (decision !== "allow" && ruleIds.length === 0) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        pathDecision,
        'decisions "block" and "escalate_crisis" must reference at least one rule id.',
      ),
    );
  }
  if (decision === "escalate_crisis" && layer !== "input") {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        pathDecision,
        'decision "escalate_crisis" is only valid on the input layer.',
      ),
    );
  }
}

/**
 * Build a trace record. Rule ids must be registered, the decision/rule
 * relation must be consistent, and refs must be valid contract ids — any
 * violation fails closed. Risk level is computed, never caller-supplied.
 */
export function buildSafetyTrace(params: BuildSafetyTraceParams): Readonly<SafetyTraceRecord> {
  const problems: ContractProblem[] = [];
  if (!(SAFETY_LAYERS as readonly string[]).includes(params.layer)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "layer", "safety layer is not registered."),
    );
  }
  if (!(SAFETY_DECISIONS as readonly string[]).includes(params.decision)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "decision", "safety decision is not registered."),
    );
  }
  if (!(SAFETY_TRACE_REASONS as readonly string[]).includes(params.reason)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "reason", "safety trace reason is not registered."),
    );
  }
  if (params.entrance !== undefined && !(SAFETY_ENTRANCES as readonly string[]).includes(params.entrance)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "entrance", "safety entrance is not registered."),
    );
  }
  const ruleIds: SafetyRuleId[] = [];
  params.ruleIds.forEach((id, index) => {
    if (
      typeof id === "string" &&
      (SAFETY_RULES as Readonly<Record<string, unknown>>)[id] !== undefined
    ) {
      ruleIds.push(id as SafetyRuleId);
    } else {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          `ruleIds[${index}]`,
          "safety rule id is not registered; the submitted value is not echoed.",
        ),
      );
    }
  });

  if (problems.length === 0) {
    assertDecisionConsistency(params.decision, ruleIds, params.layer, "decision", problems);
    validateRefs(params.refs ?? {}, problems);
  }

  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }

  const record: SafetyTraceRecord = {
    // Current policy version (never the first registry entry): appending a
    // newer version must move the stamp of every newly built trace
    // (review round 1 P2-2).
    policyVersion: SAFETY_POLICY_VERSION,
    layer: params.layer,
    decision: params.decision,
    ruleIds: Object.freeze(ruleIds),
    riskLevel: params.decision === "allow" ? "low" : maxSeverityOf(ruleIds),
    reason: params.reason,
    ...(params.entrance === undefined ? {} : { entrance: params.entrance }),
    refs: Object.freeze({ ...(params.refs ?? {}) }),
    decidedAt: params.decidedAt ?? new Date().toISOString(),
  };
  return Object.freeze(record);
}

/**
 * Parse and validate an untrusted trace-shaped value (e.g. replayed from a
 * log sink). Unknown top-level fields are rejected so raw sensitive content
 * cannot be smuggled into a trace (fail-closed anti-leak rule).
 */
export function parseSafetyTraceRecord(value: unknown): Readonly<SafetyTraceRecord> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "trace", "safety trace must be an object."),
    ]);
  }
  const record = value as Record<string, unknown>;
  const problems: ContractProblem[] = [];

  const allowedKeys: readonly string[] = [
    "policyVersion",
    "layer",
    "decision",
    "ruleIds",
    "riskLevel",
    "reason",
    "entrance",
    "refs",
    "decidedAt",
  ];
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          `trace.${describeUnknownFieldKey(key)}`,
          "safety trace carries an unknown field; raw content must never be recorded.",
        ),
      );
    }
  }

  if (
    typeof record.policyVersion !== "string" ||
    !(SAFETY_POLICY_VERSIONS as readonly string[]).includes(record.policyVersion)
  ) {
    problems.push(
      problem(
        "CONTRACT_UNKNOWN_VERSION",
        "policyVersion",
        "safety policy version is not a supported version.",
      ),
    );
  }
  if (typeof record.layer !== "string" || !(SAFETY_LAYERS as readonly string[]).includes(record.layer)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "layer", "safety layer is not registered."),
    );
  }
  if (
    typeof record.decision !== "string" ||
    !(SAFETY_DECISIONS as readonly string[]).includes(record.decision)
  ) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "decision", "safety decision is not registered."),
    );
  }
  if (
    typeof record.reason !== "string" ||
    !(SAFETY_TRACE_REASONS as readonly string[]).includes(record.reason)
  ) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "reason", "safety trace reason is not registered."),
    );
  }
  if (
    record.entrance !== undefined &&
    (typeof record.entrance !== "string" ||
      !(SAFETY_ENTRANCES as readonly string[]).includes(record.entrance))
  ) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "entrance", "safety entrance is not registered."),
    );
  }

  let ruleIds: SafetyRuleId[] = [];
  if (!Array.isArray(record.ruleIds)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "ruleIds", "ruleIds must be an array."));
  } else {
    ruleIds = record.ruleIds.filter(
      (id): id is SafetyRuleId =>
        typeof id === "string" &&
        (SAFETY_RULES as Readonly<Record<string, unknown>>)[id] !== undefined,
    );
    if (ruleIds.length !== record.ruleIds.length) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          "ruleIds",
          "ruleIds contains an id that is not registered; the submitted value is not echoed.",
        ),
      );
    }
  }

  if (
    typeof record.riskLevel !== "string" ||
    record.riskLevel !== maxSeverityOf(ruleIds)
  ) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "riskLevel",
        "riskLevel must equal the highest severity of the referenced rules.",
      ),
    );
  }

  if (record.refs !== undefined && (record.refs === null || typeof record.refs !== "object" || Array.isArray(record.refs))) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "refs", "refs must be an object when present."));
  }

  if (typeof record.decidedAt !== "string" || !isValidContractTimestamp(record.decidedAt)) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "decidedAt",
        "decidedAt must be an ISO-8601 UTC timestamp.",
      ),
    );
  }

  if (problems.length === 0) {
    assertDecisionConsistency(
      record.decision as SafetyGateDecision,
      ruleIds,
      record.layer as SafetyLayer,
      "decision",
      problems,
    );
    validateRefs((record.refs ?? {}) as Readonly<SafetyTraceRefs>, problems);
  }

  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }

  const parsed: SafetyTraceRecord = {
    policyVersion: record.policyVersion as SafetyPolicyVersion,
    layer: record.layer as SafetyLayer,
    decision: record.decision as SafetyGateDecision,
    ruleIds: Object.freeze(ruleIds),
    riskLevel: record.riskLevel as SafetySeverity,
    reason: record.reason as SafetyTraceReason,
    ...(record.entrance === undefined ? {} : { entrance: record.entrance as SafetyEntrance }),
    refs: Object.freeze({ ...(record.refs ?? {}) }),
    decidedAt: record.decidedAt as string,
  };
  return Object.freeze(parsed);
}
