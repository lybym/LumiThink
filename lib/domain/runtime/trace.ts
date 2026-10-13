/**
 * R1-03 Cordis domain pipeline — runtime trace (issue #15, docs/HARNESS.md
 * §1 component 6 "Recorder", Roadmap R1-03 "Trace 可见规则、模型、工具和时间").
 *
 * The runtime trace records STRUCTURAL FACTS ONLY:
 *
 * - which component acted and under which VERSION (protocol / gateway /
 *   persona / skill / evidence / model / provider / DSH profile);
 * - which RULE ids (safety rule hits, persona override classes, routing
 *   reasons) and which RESULT CODES decided the turn;
 * - how long each step and the whole turn took;
 * - execution failures and tool rejections as first-class observable events
 *   (issue #15: 保留执行失败与工具拒绝的可观测事件).
 *
 * It NEVER records full private content: submitted child text, model draft
 * output, handler payloads and evidence card bodies are structurally
 * excluded — only enumerated ids, codes, versions, booleans, integers and
 * grammar-validated contract ids may appear (the same no-echo discipline as
 * the gateway audit and the safety traces; enforced by tests).
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { isValidContractId, type ContractIdKind } from "../contract/core.ts";
import { ingestDomainFact } from "../legacy-guard.ts";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The DSH child profile the pipeline is bound to (fixed, R0-verified). */
export const RUNTIME_DSH_PROFILE_ID = "lumithink-child" as const;

/** Components that can emit runtime trace events. */
export const RUNTIME_COMPONENTS = Object.freeze([
  "input_gate",
  "context_builder",
  "skill_router",
  "persona",
  "tool_gate",
  "cordis_service",
  "model_gateway",
  "output_gate",
  "session_map",
] as const);

export type RuntimeComponent = (typeof RUNTIME_COMPONENTS)[number];

/** Deterministic result codes (no free text, no payload echo). */
export const RUNTIME_RESULT_CODES = Object.freeze([
  "ok",
  "blocked",
  "crisis_escalated",
  "session_unavailable",
  "skill_unavailable",
  "tool_rejected",
  "tool_failed",
  "model_rejected",
  "model_failed",
  "model_cancelled",
  "output_blocked",
  "output_oversized",
] as const);

export type RuntimeResultCode = (typeof RUNTIME_RESULT_CODES)[number];

/** Stable, greppable session lifecycle event names. */
export const RUNTIME_SESSION_EVENT_KINDS = Object.freeze([
  "session.created",
  "session.reused",
  "session.reconnecting",
  "session.reconnected",
  "session.closed",
  "session.defect",
] as const);

export type RuntimeSessionEventKind = (typeof RUNTIME_SESSION_EVENT_KINDS)[number];

/**
 * One runtime trace event. All fields are structural facts: component /
 * model / rule / skill / evidence VERSIONS, durations and result codes.
 * Contract ids are echoed only after grammar re-validation (same rule as
 * the gateway audit); anything else is recorded as the fixed mask below.
 */
export const TRACE_UNVERIFIED_ID = "[unverified]" as const;

export type RuntimeTraceEvent =
  | {
      readonly type: "turn.started";
      readonly component: "input_gate";
      readonly atMs: number;
      readonly traceId: string;
      readonly turnId: string;
      readonly sessionId: string;
      readonly entrance: string;
      readonly protocolVersion: string;
    }
  | {
      readonly type: "input.decision";
      readonly component: "input_gate";
      readonly atMs: number;
      readonly traceId: string;
      readonly turnId: string;
      readonly sessionId: string;
      readonly decision: "allow" | "block" | "escalate_crisis";
      readonly ruleIds: readonly string[];
      readonly durationMs: number;
      readonly resultCode: RuntimeResultCode;
    }
  | {
      readonly type: "session.event";
      readonly component: "session_map";
      readonly atMs: number;
      readonly traceId: string;
      readonly turnId: string;
      readonly sessionId: string;
      readonly event: RuntimeSessionEventKind;
      readonly state: string;
      readonly resultCode: RuntimeResultCode;
    }
  | {
      readonly type: "context.built";
      readonly component: "context_builder";
      readonly atMs: number;
      readonly traceId: string;
      readonly turnId: string;
      readonly sessionId: string;
      /** Number of context references (IDs only, never bodies). */
      readonly contextRefCount: number;
      readonly historyMessages: number;
      readonly contextCharBudget: number;
      readonly contextCharsUsed: number;
      readonly personaVersion: string;
      readonly durationMs: number;
      readonly resultCode: RuntimeResultCode;
    }
  | {
      readonly type: "skill.routed";
      readonly component: "skill_router";
      readonly atMs: number;
      readonly traceId: string;
      readonly turnId: string;
      readonly sessionId: string;
      readonly route: "emotion_support" | "homework_initiation" | "none";
      readonly reason: string;
      /** Present when two skill signals competed and one was arbitrated. */
      readonly arbitration: "emotion_precedence" | null;
      readonly skillVersion: string | null;
      readonly evidenceRefs: readonly string[];
      readonly durationMs: number;
      readonly resultCode: RuntimeResultCode;
    }
  | {
      readonly type: "persona.resolved";
      readonly component: "persona";
      readonly atMs: number;
      readonly traceId: string;
      readonly turnId: string;
      readonly sessionId: string;
      readonly policyId: string;
      readonly policyVersion: string;
      readonly boundariesEnforced: readonly string[];
      readonly overrideAttempts: readonly string[];
      readonly durationMs: number;
      readonly resultCode: RuntimeResultCode;
    }
  | {
      readonly type: "model.requested";
      readonly component: "model_gateway";
      readonly atMs: number;
      readonly traceId: string;
      readonly turnId: string;
      readonly sessionId: string;
      readonly modelId: string;
      readonly gatewayProtocolVersion: string;
      readonly messageCount: number;
      readonly toolCount: number;
    }
  | {
      readonly type: "model.failed";
      readonly component: "model_gateway";
      readonly atMs: number;
      readonly traceId: string;
      readonly turnId: string;
      readonly sessionId: string;
      readonly modelId: string;
      readonly gatewayCode: string;
      readonly contractErrorCode: string;
      readonly durationMs: number;
      readonly resultCode: RuntimeResultCode;
    }
  | {
      readonly type: "tool.rejected";
      readonly component: "tool_gate";
      readonly atMs: number;
      readonly traceId: string;
      readonly turnId: string;
      readonly sessionId: string;
      /** The REJECTED call id is never echoed; only the decision facts. */
      readonly decision: "block";
      readonly ruleIds: readonly string[];
      readonly entrance: string;
      readonly durationMs: number;
      readonly resultCode: RuntimeResultCode;
    }
  | {
      readonly type: "tool.executed";
      readonly component: "cordis_service";
      readonly atMs: number;
      readonly traceId: string;
      readonly turnId: string;
      readonly sessionId: string;
      readonly toolId: string;
      readonly toolVersion: string;
      readonly sideEffects: string;
      readonly durationMs: number;
      readonly resultCode: RuntimeResultCode;
    }
  | {
      readonly type: "tool.failed";
      readonly component: "cordis_service";
      readonly atMs: number;
      readonly traceId: string;
      readonly turnId: string;
      readonly sessionId: string;
      readonly toolId: string;
      readonly durationMs: number;
      readonly resultCode: RuntimeResultCode;
    }
  | {
      readonly type: "output.decision";
      readonly component: "output_gate";
      readonly atMs: number;
      readonly traceId: string;
      readonly turnId: string;
      readonly sessionId: string;
      readonly decision: "allow" | "block";
      readonly ruleIds: readonly string[];
      readonly durationMs: number;
      readonly resultCode: RuntimeResultCode;
    }
  | {
      readonly type: "turn.completed";
      readonly component: "input_gate";
      readonly atMs: number;
      readonly traceId: string;
      readonly turnId: string;
      readonly sessionId: string;
      readonly status: "completed" | "cancelled" | "ignored" | "failed";
      readonly resultCode: RuntimeResultCode;
      readonly durationMs: number;
    };

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/** Ids are echoed only after grammar re-validation; anything else is masked. */
function maskedId(kind: ContractIdKind, value: unknown): string {
  return isValidContractId(kind, value) ? (value as string) : TRACE_UNVERIFIED_ID;
}

export interface TraceIdRefs {
  readonly traceId: unknown;
  readonly turnId: unknown;
  readonly sessionId: unknown;
}

/** Re-validate the id triple once per event push (fail-closed to the mask). */
export function maskedTraceIds(refs: TraceIdRefs): {
  readonly traceId: string;
  readonly turnId: string;
  readonly sessionId: string;
} {
  return {
    traceId: maskedId("traceId", refs.traceId),
    turnId: maskedId("turnId", refs.turnId),
    sessionId: maskedId("sessionId", refs.sessionId),
  };
}

export interface RuntimeTraceRecorder {
  /** Append one event (deep-frozen through the domain intake guard). */
  push(event: RuntimeTraceEvent): void;
  /** Ring-buffered snapshot, oldest first. */
  events(): readonly RuntimeTraceEvent[];
}

const MAX_TRACE_EVENTS = 1000;

export function createRuntimeTraceRecorder(): RuntimeTraceRecorder {
  const events: RuntimeTraceEvent[] = [];
  return Object.freeze({
    push(event: RuntimeTraceEvent): void {
      events.push(ingestDomainFact(event) as RuntimeTraceEvent);
      if (events.length > MAX_TRACE_EVENTS) {
        events.shift();
      }
    },
    events(): readonly RuntimeTraceEvent[] {
      return Object.freeze([...events]);
    },
  });
}
