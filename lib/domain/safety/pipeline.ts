/**
 * R1-15 turn-level Safety Gate pipeline (docs/SAFETY_POLICY.md §8).
 *
 * Single composition point that makes the three enforced entrances
 * (issue #27 AC 3) — Web UI turn path (`ui_web`), text API
 * (`api_text`, POST /api/v1/interactions) and DSH tool invocations
 * (`dsh_tool`) — go through the same Input → Tool → Output sequence with
 * the same fail-closed semantics. Actual HTTP/UI/DSH wiring happens in
 * R1-03/R1-05; those layers MUST call this pipeline (or the individual
 * gates) and may not bypass it.
 *
 * Ordering contract:
 * 1. Input Gate runs on submitted text. A block aborts the turn (no tools,
 *    no output). A crisis escalation switches to the deterministic
 *    crisis-safe response and suspends normal advice and tools.
 * 2. Tool Gate runs per candidate; any block aborts the turn.
 * 3. Output Gate runs on the draft output via the fail-closed wrapper
 *    (gate failure blocks, never releases). A blocked draft yields no
 *    final output.
 */

import { ACTOR_ROLES, type ActorRole } from "../contract/actor.ts";
import { ContractValidationError, problem } from "../contract/core.ts";

import { buildCrisisSafeResponse, type CrisisAssessment } from "./crisis.ts";
import { SAFETY_ENTRANCES, type SafetyEntrance } from "./policy.ts";
import { evaluateInputGate, type InputGateResult } from "./input-gate.ts";
import { evaluateToolGate, type ToolCallCandidate, type ToolGateResult } from "./tool-gate.ts";
import { runOutputGateSafely, type OutputGateResult } from "./output-gate.ts";
import type { SafetyTraceRecord } from "./trace.ts";

export interface TurnSafetyInput {
  /** Which enforced entrance produced this turn (AC 3). */
  readonly entrance: SafetyEntrance;
  /** Server-verified role of the caller; never self-reported trust. */
  readonly actorRole: ActorRole;
  /** Submitted text; null for pure tool turns (DSH tool entrance). */
  readonly interactionText: string | null;
  /** Tool calls scheduled for this turn; may be empty. */
  readonly toolCalls?: readonly ToolCallCandidate[];
  /**
   * Model draft output for this turn. Required for text turns that expect a
   * reply; ignored (and never emitted) when the input gate blocked or
   * escalated to crisis.
   */
  readonly draftOutput?: string | null;
  /**
   * The session's own (server-resolved) child reference, forwarded to the
   * Output Gate so foreign child references in the draft are detected as
   * data leaks against the caller's real session (review round 1 P2-3).
   * When omitted, the gate falls back to the synthetic demo child
   * reference used by the contract fixtures.
   */
  readonly ownChildRef?: string;
  readonly refs?: { readonly requestId?: string; readonly traceId?: string; readonly turnId?: string };
  readonly decidedAt?: string;
}

export interface TurnSafetyResult {
  readonly input: Readonly<InputGateResult> | null;
  readonly tools: readonly Readonly<ToolGateResult>[];
  readonly output: Readonly<OutputGateResult> | null;
  readonly crisis: Readonly<CrisisAssessment> | null;
  /** What may reach the child; null whenever anything was blocked. */
  readonly finalOutput: string | null;
  readonly blocked: boolean;
  /** Input trace → tool traces → output trace, in decision order. */
  readonly traces: readonly Readonly<SafetyTraceRecord>[];
}

/**
 * Evaluate one full turn through all three layers. Fail-closed end to end:
 * invalid shapes throw structured validation errors instead of guessing.
 */
export function evaluateTurnSafety(input: TurnSafetyInput): TurnSafetyResult {
  if (input === null || typeof input !== "object") {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "input", "turn safety expects an input object."),
    ]);
  }
  if (typeof input.entrance !== "string" || !(SAFETY_ENTRANCES as readonly string[]).includes(input.entrance)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "entrance", "turn safety requires a registered entrance."),
    ]);
  }
  if (
    typeof input.actorRole !== "string" ||
    !(ACTOR_ROLES as readonly string[]).includes(input.actorRole)
  ) {
    throw new ContractValidationError([
      problem(
        "CONTRACT_FIELD_INVALID",
        "actorRole",
        "turn safety requires a verified actor role from the role registry.",
      ),
    ]);
  }
  if (input.interactionText !== null && typeof input.interactionText !== "string") {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "interactionText", "interactionText must be a string or null."),
    ]);
  }
  if (input.draftOutput !== undefined && input.draftOutput !== null && typeof input.draftOutput !== "string") {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "draftOutput", "draftOutput must be a string or null."),
    ]);
  }
  if (
    input.ownChildRef !== undefined &&
    (typeof input.ownChildRef !== "string" || input.ownChildRef.length === 0)
  ) {
    throw new ContractValidationError([
      problem(
        "CONTRACT_FIELD_INVALID",
        "ownChildRef",
        "ownChildRef must be a non-empty string when present.",
      ),
    ]);
  }
  const toolCalls = input.toolCalls ?? [];
  if (!Array.isArray(toolCalls)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "toolCalls", "toolCalls must be an array when present."),
    ]);
  }

  const gateOptions = {
    entrance: input.entrance,
    refs: input.refs,
    decidedAt: input.decidedAt,
  };

  // 1. Input layer.
  let inputResult: Readonly<InputGateResult> | null = null;
  let crisis: Readonly<CrisisAssessment> | null = null;
  if (input.interactionText !== null) {
    inputResult = evaluateInputGate(input.interactionText, gateOptions);
    crisis = inputResult.crisis;

    if (inputResult.decision === "block") {
      return Object.freeze({
        input: inputResult,
        tools: Object.freeze([]),
        output: null,
        crisis: null,
        finalOutput: null,
        blocked: true,
        traces: Object.freeze([inputResult.trace]),
      });
    }

    if (inputResult.decision === "escalate_crisis") {
      // Crisis branch: normal advice and tools are suspended. The only
      // admissible output is the deterministic crisis-safe response; it is
      // re-checked through the output gate for uniform enforcement.
      const crisisAssessment: Readonly<CrisisAssessment> =
        crisis ?? Object.freeze({ category: "self_harm" as const });
      const safeResponse = buildCrisisSafeResponse(crisisAssessment);
      const output = runOutputGateSafely({
        content: safeResponse,
        crisisEscalation: true,
        requiredCrisisResponse: safeResponse,
        ownChildRef: input.ownChildRef,
        entrance: input.entrance,
        refs: input.refs,
        decidedAt: input.decidedAt,
      });
      return Object.freeze({
        input: inputResult,
        tools: Object.freeze([]),
        output,
        crisis: crisisAssessment,
        finalOutput: output.decision === "allow" ? safeResponse : null,
        blocked: output.decision === "block",
        traces: Object.freeze([inputResult.trace, output.trace]),
      });
    }
  }

  // 2. Tool layer (only reached when the input layer allowed the turn).
  const toolResults: Readonly<ToolGateResult>[] = [];
  for (const candidate of toolCalls) {
    const result = evaluateToolGate(candidate, gateOptions);
    toolResults.push(result);
    if (result.decision === "block") {
      return Object.freeze({
        input: inputResult,
        tools: Object.freeze(toolResults),
        output: null,
        crisis: null,
        finalOutput: null,
        blocked: true,
        traces: Object.freeze([
          ...(inputResult ? [inputResult.trace] : []),
          ...toolResults.map((tool) => tool.trace),
        ]),
      });
    }
  }

  // 3. Output layer (fail-closed wrapper; mandatory for every draft).
  const traces: Readonly<SafetyTraceRecord>[] = [
    ...(inputResult ? [inputResult.trace] : []),
    ...toolResults.map((tool) => tool.trace),
  ];
  if (input.draftOutput === undefined || input.draftOutput === null) {
    return Object.freeze({
      input: inputResult,
      tools: Object.freeze(toolResults),
      output: null,
      crisis: null,
      finalOutput: null,
      blocked: false,
      traces: Object.freeze(traces),
    });
  }
  const output = runOutputGateSafely({
    content: input.draftOutput,
    crisisEscalation: false,
    ownChildRef: input.ownChildRef,
    entrance: input.entrance,
    refs: input.refs,
    decidedAt: input.decidedAt,
  });
  traces.push(output.trace);
  const allowed = output.decision === "allow";
  return Object.freeze({
    input: inputResult,
    tools: Object.freeze(toolResults),
    output,
    crisis: null,
    finalOutput: allowed ? input.draftOutput : null,
    blocked: !allowed,
    traces: Object.freeze(traces),
  });
}
