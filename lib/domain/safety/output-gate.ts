/**
 * R1-15 Output Gate (docs/SAFETY_POLICY.md §4.3, HARNESS §5 输出后断点).
 *
 * Mandatory last boundary for every text turn: model output is screened for
 * exclusive-relationship attachment, secrecy pressure, clinical diagnosis
 * claims, homework ghostwriting, age-inappropriate content, data leaks and
 * missed crisis referrals. No output reaches a child without passing this
 * gate — and the gate itself is fail-closed: if it is unavailable, throws,
 * or returns an unusable result, the turn is BLOCKED, never "temporarily
 * released" (issue #27 AC 2).
 *
 * Voice note: the incremental short-sentence broadcast of R1-V reuses this
 * same policy per docs/SAFETY_POLICY.md; voice stream wiring happens in
 * R1-V2 and is out of scope here (issue #27 交付范围 5).
 */

import { ContractValidationError, problem } from "../contract/core.ts";

import type { SafetyEntrance, SafetyRuleHit, SafetyRuleId } from "./policy.ts";
import { SAFETY_RULES } from "./policy.ts";
import {
  buildSafetyTrace,
  parseSafetyTraceRecord,
  type SafetyTraceRecord,
  type SafetyTraceRefs,
} from "./trace.ts";

/** Max code points of gated output; aligned with the contract (response.ts). */
export const OUTPUT_CONTENT_MAX_CODE_POINTS = 4000;

export interface OutputGateInput {
  readonly content: string;
  /** True when the Input Gate escalated this turn into the crisis branch. */
  readonly crisisEscalation?: boolean;
  /**
   * When `crisisEscalation` is true, the ONLY acceptable output is the
   * deterministic crisis-safe response built by the caller from the crisis
   * assessment; anything else is a missed referral (blocked).
   */
  readonly requiredCrisisResponse?: string | null;
  /**
   * The session's own (server-resolved) child reference; any other child
   * reference in output is a data leak.
   */
  readonly ownChildRef?: string;
  readonly entrance?: SafetyEntrance;
  readonly refs?: Readonly<SafetyTraceRefs>;
  readonly decidedAt?: string;
}

export interface OutputGateResult {
  readonly decision: "allow" | "block";
  readonly hits: readonly SafetyRuleHit[];
  readonly trace: Readonly<SafetyTraceRecord>;
}

export type OutputGateFunction = (input: OutputGateInput) => OutputGateResult;

/** v0 detection patterns (deterministic, tuned to the synthetic corpus). */
const EXCLUSIVE_DEPENDENCY_PATTERNS: readonly RegExp[] = Object.freeze([
  /最懂你/,
  /最理解你/,
  /(?:只有|除了)[我Ll]umi?露米.{0,6}(?:才)?(?:懂|理解|明白|关心)你/,
  /只(?:能|可以)?(?:相信|信任|依靠|依赖)(?:我|我一个人)/,
  /你只需要我/,
  /把(?:我|Lumi|露米)当(?:作|成)(?:唯一|最(?:好|亲)|全部)/,
  /\bI am the only one who\b/i,
  /\bonly I (?:truly )?(?:understand|care about)\b/i,
]);

const SECRECY_PRESSURE_PATTERNS: readonly RegExp[] = Object.freeze([
  /不要告诉(?:爸妈|爸爸|妈妈|父母|家长|老师|任何人|大人|别人)/,
  /别告诉(?:爸妈|爸爸|妈妈|父母|家长|老师|任何人|大人|别人)/,
  /这是我们(?:之间)?(?:的)?(?:小)?秘密/,
  /替你保密/,
  /(?:保证|答应)(?:你)?(?:绝对)?(?:不|绝不|不会)告诉(?:别人|任何人|爸妈|爸爸|妈妈|家长|老师)/,
  /(?:这件事|这个话)只(?:有|留在)(?:我们|你和我)(?:之间|知道)/,
  /\bdon'?t tell (?:your )?(?:parents?|mom|dad|teacher|anyone)\b/i,
  /\bkeep (?:this|it) (?:a )?secret\b/i,
]);

const DIAGNOSIS_CLAIM_PATTERNS: readonly RegExp[] = Object.freeze([
  /你(?:可能)?(?:是)?(?:患有|得了|是有)\s*(?:抑郁症|焦虑症|多动症|ADHD|自闭症|抑郁(?:症)?|焦虑(?:症)?)/,
  /诊断(?:为|你患有|出你)/,
  /确诊(?:为|你)/,
  /你这是(?:典型|明显)的(?:抑郁|焦虑|多动|自闭)/,
  /i (?:can )?diagnose you/i,
  /you (?:have|are) (?:depression|depressed|anxiety|ADHD|autism)\b/i,
]);

const GHOSTWRITING_PATTERNS: readonly RegExp[] = Object.freeze([
  /代(?:你)?写/,
  /替你写/,
  /我帮你写完/,
  /(?:直接)?给你(?:一份)?(?:完整|全部)?的?答案(?:，?抄|直接抄)?/,
  /抄上去就行/,
  /\bwrite it (?:all )?for you\b/i,
  /\bhere(?:'s| is) the (?:full|complete) answer\b/i,
]);

const AGE_INAPPROPRIATE_PATTERNS: readonly RegExp[] = Object.freeze([
  /色情/,
  /裸(?:体|照)/,
  /\bporn(?:ography|ographic| site)?\b/i,
  /\bnudes?\b/i,
  /\bsexually\s+explicit\b/i,
  /杀害(?:你)?(?:的)?(?:爸妈|父母|老师|同学)/,
  /\bkill your (?:parents|teacher|classmates)\b/i,
]);

const DATA_LEAK_PATTERNS: readonly RegExp[] = Object.freeze([
  /sk-[A-Za-z0-9]{16,}/,
  /sk-ant-[A-Za-z0-9]/,
  /sk-proj-[A-Za-z0-9]/,
  /ghp_[A-Za-z0-9]{16,}/,
  /gho_[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{12,}/,
  /xox[bpars]-[A-Za-z0-9]/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:api[_-]?key|secret|token|password|passwd)\s*[:=：]\s*["']?[A-Za-z0-9_\-]{8,}/i,
  /(?:DATABASE_URL|DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[:=]/,
]);

/** Foreign (non-session) child references, e.g. `chd_ab12cd34`. */
const CHILD_REF_PATTERN = /chd_[A-Za-z0-9][A-Za-z0-9_-]{7,63}/g;

function anyMatch(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function hit(ruleId: SafetyRuleId): SafetyRuleHit {
  return Object.freeze({
    ruleId,
    layer: "output" as const,
    severity: ruleId === "output.ghostwriting" ? ("medium" as const) : ("high" as const),
  });
}

/**
 * Evaluate one model output draft against the output layer. Strictly
 * structural failures (non-string, oversized) throw; callers that must
 * never leak an exception use {@link runOutputGateSafely}.
 */
export function evaluateOutputGate(input: OutputGateInput): OutputGateResult {
  if (input === null || typeof input !== "object") {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "input", "output gate expects an input object."),
    ]);
  }
  const content = input.content;
  if (typeof content !== "string") {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "content", "output gate expects string content."),
    ]);
  }
  const codePoints = [...content];
  if (codePoints.length > OUTPUT_CONTENT_MAX_CODE_POINTS) {
    throw new ContractValidationError([
      problem(
        "CONTRACT_TEXT_TOO_LONG",
        "content",
        `output gate content exceeds the ${OUTPUT_CONTENT_MAX_CODE_POINTS} code-point limit.`,
        { limit: OUTPUT_CONTENT_MAX_CODE_POINTS, actual: codePoints.length },
      ),
    ]);
  }

  const hits: SafetyRuleHit[] = [];
  if (anyMatch(content, EXCLUSIVE_DEPENDENCY_PATTERNS)) {
    hits.push(hit("output.exclusive_dependency"));
  }
  if (anyMatch(content, SECRECY_PRESSURE_PATTERNS)) {
    hits.push(hit("output.secrecy_pressure"));
  }
  if (anyMatch(content, DIAGNOSIS_CLAIM_PATTERNS)) {
    hits.push(hit("output.diagnosis_claim"));
  }
  if (anyMatch(content, GHOSTWRITING_PATTERNS)) {
    hits.push(hit("output.ghostwriting"));
  }
  if (anyMatch(content, AGE_INAPPROPRIATE_PATTERNS)) {
    hits.push(hit("output.age_inappropriate"));
  }
  if (anyMatch(content, DATA_LEAK_PATTERNS)) {
    hits.push(hit("output.data_leak"));
  }

  // Foreign child references: any chd_ id that is not the session's own
  // (default: the synthetic demo child used by the contract fixtures).
  const ownChildRef = input.ownChildRef ?? "chd_demo_001";
  if (ownChildRef === "" || (ownChildRef !== undefined && typeof ownChildRef !== "string")) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "ownChildRef", "ownChildRef must be a string when present."),
    ]);
  }
  const foreignRef = content.match(CHILD_REF_PATTERN)?.find((ref) => ref !== ownChildRef);
  if (foreignRef !== undefined) {
    hits.push(hit("output.data_leak"));
  }

  // Crisis enforcement: a crisis turn may only emit the deterministic
  // crisis-safe response. Anything else is a missed referral (AC 1). A
  // caller that claims a crisis escalation but cannot name the required
  // response fails closed (cannot verify the referral → block).
  if (input.crisisEscalation === true) {
    if (typeof input.requiredCrisisResponse !== "string" || input.requiredCrisisResponse.length === 0) {
      hits.push(hit("output.crisis_referral_missing"));
    } else if (content !== input.requiredCrisisResponse) {
      hits.push(hit("output.crisis_referral_missing"));
    }
  }

  const decision: OutputGateResult["decision"] = hits.length > 0 ? "block" : "allow";
  const trace = buildSafetyTrace({
    layer: "output",
    decision,
    ruleIds: hits.map((h) => h.ruleId),
    reason: "rule_hit",
    entrance: input.entrance,
    refs: input.refs,
    decidedAt: input.decidedAt,
  });

  return Object.freeze({ decision, hits: Object.freeze(hits), trace });
}

/**
 * Fail-closed wrapper mandated by issue #27 AC 2: when the gate function is
 * unavailable, throws (including on malformed input) or returns an unusable
 * decision, the result is a deterministic BLOCK with
 * `output.gate_unavailable` — there is no code path that releases output
 * on gate failure.
 *
 * "Unusable result" covers more than the object shape: a shape-legal result
 * whose trace does not parse as a validated safety trace record, whose
 * trace decision disagrees with the returned decision, or whose hits and
 * trace rule sets disagree is treated as tampered/corrupted and fails
 * closed exactly like an outage (review round 1 P1-2). Without this, a
 * corrupted gate could smuggle an unvalidated trace object into the audit
 * pipeline. A fully self-consistent malicious allow from inside the trust
 * boundary remains a documented residual risk, not a wrapper bypass.
 */
export function runOutputGateSafely(
  input: OutputGateInput,
  gate: OutputGateFunction = evaluateOutputGate,
): OutputGateResult {
  let result: OutputGateResult;
  try {
    const candidate = gate(input);
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      (candidate.decision !== "allow" && candidate.decision !== "block") ||
      !Array.isArray(candidate.hits) ||
      candidate.trace === null ||
      typeof candidate.trace !== "object"
    ) {
      throw new ContractValidationError([
        problem("CONTRACT_FIELD_INVALID", "gate", "output gate returned an unusable result."),
      ]);
    }
    // Semantic validation: the released trace must be a validated record
    // (field allow-list, registered rule ids, computed risk level, decision
    // consistency) and must agree with the returned decision and hits.
    const trace = parseSafetyTraceRecord(candidate.trace);
    if (
      trace.decision !== candidate.decision ||
      !hitsConsistentWithTrace(candidate.hits, trace)
    ) {
      throw new ContractValidationError([
        problem(
          "CONTRACT_FIELD_INVALID",
          "gate",
          "output gate result is internally inconsistent; treated as unusable.",
        ),
      ]);
    }
    result = { decision: candidate.decision, hits: candidate.hits, trace };
  } catch {
    // Never rethrow: fail closed with a structured, content-free trace.
    let trace: Readonly<SafetyTraceRecord>;
    try {
      trace = buildSafetyTrace({
        layer: "output",
        decision: "block",
        ruleIds: ["output.gate_unavailable"],
        reason: "gate_unavailable",
        entrance: input?.entrance,
        refs: input?.refs,
        decidedAt: input?.decidedAt,
      });
    } catch {
      // Caller-supplied refs/entrance/decidedAt failed validation; the
      // wrapper still owes the caller a deterministic block, so degrade to
      // a refs-free minimal trace built from registry constants only
      // (cannot throw; review round 1 P2-1).
      trace = buildSafetyTrace({
        layer: "output",
        decision: "block",
        ruleIds: ["output.gate_unavailable"],
        reason: "gate_unavailable",
      });
    }
    return Object.freeze({
      decision: "block" as const,
      hits: Object.freeze([hit("output.gate_unavailable")]),
      trace,
    });
  }
  return result;
}

/**
 * True when the gate's hits and its parsed trace tell the same story:
 * every hit is a structured hit of the trace's layer, every rule id is
 * registered, both sides reference the same rule-id set, and the decision
 * boundary (allow ⇔ no hits) holds.
 */
function hitsConsistentWithTrace(
  hits: readonly unknown[],
  trace: Readonly<SafetyTraceRecord>,
): boolean {
  for (const entry of hits) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    const candidateHit = entry as Partial<SafetyRuleHit>;
    if (
      typeof candidateHit.ruleId !== "string" ||
      (SAFETY_RULES as Readonly<Record<string, unknown>>)[candidateHit.ruleId] === undefined ||
      candidateHit.layer !== trace.layer
    ) {
      return false;
    }
  }
  const hitRuleIds = new Set(
    (hits as readonly SafetyRuleHit[]).map((entry) => entry.ruleId),
  );
  if (hitRuleIds.size !== new Set(trace.ruleIds).size) {
    return false;
  }
  for (const ruleId of hitRuleIds) {
    if (!trace.ruleIds.includes(ruleId as SafetyRuleId)) {
      return false;
    }
  }
  if (trace.decision === "allow" && hits.length !== 0) {
    return false;
  }
  if (trace.decision !== "allow" && hits.length === 0) {
    return false;
  }
  return true;
}
