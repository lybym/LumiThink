/**
 * R1-03 Cordis domain pipeline — the minimal orchestrator (issue #15,
 * docs/HARNESS.md §1 execution graph, Roadmap R1-03).
 *
 * One place composes the delivered R1 domains into the enforced turn flow —
 * Input Gate → Context Builder → Skill Router → (Persona) → Model Gateway →
 * Output Gate → Recorder — without modifying the upstream DSH Agent Loop:
 *
 * 1. Session gate: the mapped DSH session must be usable (create / reuse /
 *    reconnect via the `DshSessionMapper`); an unavailable session degrades
 *    the turn fail-closed BEFORE any gate or model call.
 * 2. Input layer of the REAL `evaluateTurnSafety` (ui_web / api_text
 *    entrances): block aborts the turn; crisis escalation switches to the
 *    deterministic crisis-safe response with NO model call and NEVER falls
 *    through to normal orchestration (docs/SAFETY_POLICY.md §5).
 * 3. Context Builder: budget-bounded HarnessContext + minimal model
 *    messages (refs are ids/versions only; the system part is registry-owned).
 * 4. Skill Router (deterministic) + registry skill load: routed skills load
 *    via `loadSkillForChild` (version + evidence refs recorded; degraded or
 *    rejected loads continue WITHOUT the skill — controlled degradation).
 * 5. Persona turn resolution over the RE-VALIDATED policy snapshot (carried
 *    #16 review note): identity/traits/boundaries/exits come only from the
 *    registry policy; the user text enters solely as an untrusted input for
 *    override-attempt observability.
 * 6. Model Gateway call (one per turn; retries stay inside the gateway's
 *    bounded attempt loop). Gateway failures map to structured degradations
 *    — never fabricated answers — and are observable as trace events.
 * 7. Output layer of the REAL `evaluateTurnSafety` on the draft (fail-closed
 *    wrapper); over-contract output fails closed instead of truncating.
 * 8. Recorder: value-free runtime trace events (versions, durations, result
 *    codes) — full private content is structurally excluded.
 *
 * Tool execution is exposed as the explicit Cordis service surface
 * (`executeServiceCall`, entrance `dsh_tool`): whitelist → tool gate →
 * handler, with rejection/failure trace events preserved (issue #15:
 * 保留执行失败与工具拒绝的可观测事件).
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import {
  ContractValidationError,
  isValidContractId,
  problem,
  type ContractProblem,
} from "../contract/core.ts";
import { ACTOR_ROLES, parseActorContext, type ActorContext, type ActorRole } from "../contract/actor.ts";
import { parseInteractionEvent, type InteractionEvent } from "../contract/interaction.ts";
import { parseAgentResponse, type AgentResponse, type TurnStatus } from "../contract/response.ts";
import { ingestDomainFact } from "../legacy-guard.ts";
import {
  evaluateTurnSafety,
  type SafetyTraceRecord,
} from "../safety/index.ts";
import {
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_TO_CONTRACT_ERROR_CODE,
  GatewayError,
  type GatewayCompleteResult,
  type ModelGateway,
} from "../gateway/index.ts";
import { personaIdentityDisclosureText, validatePersonaPolicyV0, type PersonaPolicyV0 } from "../persona/policy.ts";
import { personaDefaultStyle, resolvePersonaTurn, type PersonaStyleWithProvenance, type PersonaTurnResolution } from "../persona/turn.ts";
import { loadSkillForChild } from "../evidence/registry.ts";
import {
  resolveEmotionSkillTurn,
  type EmotionSkillTurnResolution,
} from "../skills/emotion-support.ts";
import {
  executeHomeworkSkillTurn,
  type HomeworkSkillTurnExecutor,
  type HomeworkSkillTurnResolution,
} from "../skills/homework-initiation.ts";

import {
  describeCordisToolSchema,
  executeCordisServiceCall,
  type CordisServiceExecution,
  type CordisServiceHandler,
} from "./cordis.ts";
import { buildHarnessContext, composeModelMessages, type HarnessContext } from "./context-builder.ts";
import { routeSkillForText, SKILL_ROUTER_VERSION, type SkillRouteDecision } from "./skill-router.ts";
import { createDshSessionMapper, type DshSessionMapper } from "./session-map.ts";
import {
  createRuntimeTraceRecorder,
  maskedTraceIds,
  type RuntimeResultCode,
  type RuntimeTraceRecorder,
} from "./trace.ts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Pipeline protocol version (trace fact; bumps with behavior changes). */
export const RUNTIME_PIPELINE_VERSION = "1.0" as const;

/**
 * Mirrors the contract's agent output cap (lib/domain/contract/response.ts):
 * an over-cap draft fails closed here BEFORE the response parser would
 * reject it, so an oversized model answer can never degrade into silent
 * truncation of child-facing content.
 */
export const RUNTIME_MAX_OUTPUT_CODE_POINTS = 4000;

/** Entrances the text pipeline serves (dsh_tool belongs to service calls). */
export const RUNTIME_TEXT_ENTRANCES = Object.freeze(["ui_web", "api_text"] as const);

export type RuntimeTextEntrance = (typeof RUNTIME_TEXT_ENTRANCES)[number];

/**
 * The structured resolution of the skill that executed on a routed turn
 * (R1-11 emotion, R1-12 homework). Null on every other path (no route,
 * degraded/rejected loads, executor degradation, early ends).
 */
export type RoutedSkillTurnResolution =
  | Readonly<EmotionSkillTurnResolution>
  | Readonly<HomeworkSkillTurnResolution>;

export interface CordisPipelineOptions {
  /** The R1-02 model gateway (mock by default; real adapter behind review). */
  readonly gateway: ModelGateway;
  /** The single registered model the pipeline drives. */
  readonly modelId: string;
  /** DSH ↔ Lumi session mapping (create/reconnect/close + defect tracking). */
  readonly sessionMapper?: DshSessionMapper;
  /** Runtime trace recorder (component versions, durations, result codes). */
  readonly trace?: RuntimeTraceRecorder;
  /**
   * The persona policy snapshot. MUST come from the persona registry
   * (`resolveActivePersona`); the pipeline re-validates it fail-closed at
   * construction and on every turn (carried #16 review note: never trust a
   * passed snapshot blindly).
   */
  readonly personaPolicy: Readonly<PersonaPolicyV0>;
  /** Synthetic v0 handlers for the whitelisted Cordis services. */
  readonly handlers?: Readonly<Record<string, CordisServiceHandler>>;
  /**
   * R1-12 test seam (same DI style as `clock`/`handlers`): the homework
   * executor used for homework-routed turns. Defaults to the REAL
   * `executeHomeworkSkillTurn` (including its controlled-degradation wrap);
   * tests may inject a degraded executor to exercise the
   * skill_unavailable path end-to-end without corrupting shipped
   * registries.
   */
  readonly homeworkExecutor?: HomeworkSkillTurnExecutor;
  readonly clock?: () => number;
  /** agentResponseId generator (contract `rsp_` grammar). */
  readonly agentResponseIdFactory?: () => string;
  /** completedAt timestamp factory (contract ISO-Z grammar). */
  readonly completedAtFactory?: () => string;
}

export interface CordisTurnInput {
  readonly entrance: RuntimeTextEntrance;
  /** Server-verified actor (re-validated via parseActorContext). */
  readonly actor: unknown;
  /** Server-owned session binding (validated for conversation consistency). */
  readonly session: {
    readonly sessionId: unknown;
    readonly conversationId: unknown;
  };
  /** The canonical InteractionEvent (re-validated via parseInteractionEvent). */
  readonly event: unknown;
  /** Verified child age for registry skill loading (integer years). */
  readonly childAgeYears: unknown;
  /** Server-owned bounded history (user/assistant pairs). */
  readonly history?: readonly unknown[];
  /** Caller cancellation signal (user stop; first-class, never retried). */
  readonly signal?: AbortSignal;
  /**
   * R1-06 optional trusted persona style override (e.g. the guardian
   * `guardian_config` path supplied by the serving layer). Validated
   * fail-closed by the persona turn resolution below (same discipline as
   * `actor`: unknown re-validated server values cannot enter a turn).
   * Absent → the pipeline's default style (system_default).
   */
  readonly personaStyle?: unknown;
}

export interface CordisTurnFailure {
  readonly gatewayCode: string;
  readonly contractErrorCode: string;
}

export interface CordisTurnResult {
  readonly response: Readonly<AgentResponse>;
  /** The routing decision (none-fallback when the turn ended before routing). */
  readonly route: Readonly<SkillRouteDecision>;
  readonly skillApplied: boolean;
  readonly skillVersion: string | null;
  /**
   * R1-11/R1-12: structured resolution of the routed skill when it
   * executed (stage, situation/obstacle, offered strategies/steps,
   * manifest-bound exits, evidence versions, limitation disclosures).
   * Null on every other path (no route, degraded/rejected loads, executor
   * degradation, early ends).
   */
  readonly skillResolution: Readonly<RoutedSkillTurnResolution> | null;
  readonly persona: Readonly<PersonaTurnResolution> | null;
  /** Input/tool/output safety traces in decision order. */
  readonly safetyTraces: readonly Readonly<SafetyTraceRecord>[];
  /** Present exactly when the model call failed or was rejected. */
  readonly failure: Readonly<CordisTurnFailure> | null;
  /** Context reference ids used this turn (audit; no bodies). */
  readonly contextRefIds: readonly string[];
  readonly harnessContext: Readonly<HarnessContext> | null;
}

export type PipelineServiceCallResult =
  | { readonly status: "session_unavailable"; readonly state: string }
  | Readonly<CordisServiceExecution>;

export interface CordisPipeline {
  /** Run one full text turn through the enforced pipeline. */
  runTurn(input: Readonly<CordisTurnInput>): Promise<Readonly<CordisTurnResult>>;
  /** Execute one Cordis service call (dsh_tool entrance; session-checked). */
  executeServiceCall(
    rawCall: unknown,
    refs: {
      readonly actorRole: unknown;
      readonly traceId: unknown;
      readonly turnId: unknown;
      readonly sessionId: unknown;
    },
  ): Promise<Readonly<PipelineServiceCallResult>>;
  readonly sessionMapper: DshSessionMapper;
  readonly trace: RuntimeTraceRecorder;
}

function defaultAgentResponseId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `rsp_${Date.now().toString(36)}${random}`.slice(0, 68);
}

function defaultCompletedAt(): string {
  return new Date().toISOString();
}

/** Deterministic fallback route for paths that ended before routing. */
const routeNoneFallback: Readonly<SkillRouteDecision> = Object.freeze({
  route: "none",
  reason: "no_signal",
  arbitration: null,
  routerVersion: SKILL_ROUTER_VERSION,
});

/**
 * Create the Cordis domain pipeline. Fails closed at construction when the
 * persona policy snapshot does not re-validate against the registry schema.
 */
export function createCordisPipeline(options: Readonly<CordisPipelineOptions>): CordisPipeline {
  if (options === null || typeof options !== "object") {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "options", "pipeline options must be an object."),
    ]);
  }
  const clock = options.clock ?? (() => Date.now());
  const agentResponseIdFactory = options.agentResponseIdFactory ?? defaultAgentResponseId;
  const completedAtFactory = options.completedAtFactory ?? defaultCompletedAt;

  // Carried #16 review note: the pipeline re-validates the policy snapshot
  // at construction AND on every turn instead of trusting the passed value.
  const constructionProblems: ContractProblem[] = [];
  validatePersonaPolicyV0(options.personaPolicy, constructionProblems);
  if (constructionProblems.length > 0) {
    throw new ContractValidationError(constructionProblems);
  }

  const gateway = options.gateway;
  const trace = options.trace ?? createRuntimeTraceRecorder();
  const sessionMapper = options.sessionMapper ?? createDshSessionMapper({ clock });

  const personaStyle = personaDefaultStyle(options.personaPolicy);
  const boundariesEnforced: readonly string[] = Object.freeze([
    ...options.personaPolicy.relationBoundaries,
  ]);
  const identityDisclosure = personaIdentityDisclosureText(options.personaPolicy);

  function pushTurnCompleted(refs: {
    readonly traceId: string;
    readonly turnId: string;
    readonly sessionId: string;
    readonly status: TurnStatus;
    readonly resultCode: RuntimeResultCode;
    readonly startedAtMs: number;
  }): void {
    trace.push({
      type: "turn.completed",
      component: "input_gate",
      atMs: clock(),
      traceId: refs.traceId,
      turnId: refs.turnId,
      sessionId: refs.sessionId,
      status: refs.status,
      resultCode: refs.resultCode,
      durationMs: clock() - refs.startedAtMs,
    });
  }

  function buildResponse(input: {
    readonly conversationId: string;
    readonly turnId: string;
    readonly traceId: string;
    readonly status: TurnStatus;
    readonly content: string | null;
  }): Readonly<AgentResponse> {
    return parseAgentResponse({
      protocolVersion: "1.0",
      agentResponseId: agentResponseIdFactory(),
      conversationId: input.conversationId,
      turnId: input.turnId,
      traceId: input.traceId,
      status: input.status,
      content: input.content === null ? null : { text: input.content, format: "plain" },
      completedAt: completedAtFactory(),
    });
  }

  function result(parts: {
    readonly response: Readonly<AgentResponse>;
    readonly route: Readonly<SkillRouteDecision> | null;
    readonly skillApplied: boolean;
    readonly skillVersion: string | null;
    readonly skillResolution: Readonly<RoutedSkillTurnResolution> | null;
    readonly persona: Readonly<PersonaTurnResolution> | null;
    readonly safetyTraces: readonly Readonly<SafetyTraceRecord>[];
    readonly failure: Readonly<CordisTurnFailure> | null;
    readonly contextRefIds: readonly string[];
    readonly harnessContext: Readonly<HarnessContext> | null;
  }): Readonly<CordisTurnResult> {
    return ingestDomainFact({
      response: parts.response,
      route: parts.route ?? routeNoneFallback,
      skillApplied: parts.skillApplied,
      skillVersion: parts.skillVersion,
      skillResolution: parts.skillResolution,
      persona: parts.persona,
      safetyTraces: Object.freeze([...parts.safetyTraces]),
      failure: parts.failure,
      contextRefIds: Object.freeze([...parts.contextRefIds]),
      harnessContext: parts.harnessContext,
    }) as Readonly<CordisTurnResult>;
  }

  return Object.freeze({
    sessionMapper,
    trace,

    async runTurn(rawInput: Readonly<CordisTurnInput>): Promise<Readonly<CordisTurnResult>> {
      const startedAtMs = clock();
      if (rawInput === null || typeof rawInput !== "object") {
        throw new ContractValidationError([
          problem("CONTRACT_FIELD_INVALID", "input", "runTurn expects an input object."),
        ]);
      }
      if (
        typeof rawInput.entrance !== "string" ||
        !(RUNTIME_TEXT_ENTRANCES as readonly string[]).includes(rawInput.entrance)
      ) {
        throw new ContractValidationError([
          problem(
            "CONTRACT_FIELD_INVALID",
            "entrance",
            `entrance must be one of: ${RUNTIME_TEXT_ENTRANCES.join(" | ")}.`,
          ),
        ]);
      }
      const entrance: RuntimeTextEntrance = rawInput.entrance;
      const actor: Readonly<ActorContext> = parseActorContext(rawInput.actor);
      const event: Readonly<InteractionEvent> = parseInteractionEvent(rawInput.event);
      if (typeof rawInput.childAgeYears !== "number" || !Number.isInteger(rawInput.childAgeYears)) {
        throw new ContractValidationError([
          problem("CONTRACT_FIELD_INVALID", "childAgeYears", "childAgeYears must be an integer."),
        ]);
      }
      const childAgeYears = rawInput.childAgeYears;
      const sessionId = typeof rawInput.session?.sessionId === "string" ? rawInput.session.sessionId : "";
      const conversationId =
        typeof rawInput.session?.conversationId === "string" ? rawInput.session.conversationId : "";
      if (!isValidContractId("sessionId", sessionId)) {
        throw new ContractValidationError([
          problem("CONTRACT_FIELD_INVALID", "session.sessionId", "sessionId must match the contract id grammar."),
        ]);
      }
      if (!isValidContractId("conversationId", conversationId)) {
        throw new ContractValidationError([
          problem(
            "CONTRACT_FIELD_INVALID",
            "session.conversationId",
            "conversationId must match the contract id grammar.",
          ),
        ]);
      }
      // Cross-consistency: the event belongs to this session and this actor.
      if (
        event.conversationId !== conversationId ||
        event.actor.actorId !== actor.actorId ||
        event.actor.role !== actor.role
      ) {
        throw new ContractValidationError([
          problem(
            "CONTRACT_FIELD_INVALID",
            "event",
            "event/session/actor identity mismatch; ids are not echoed.",
          ),
        ]);
      }
      const traceIds = maskedTraceIds({
        traceId: event.traceId,
        turnId: event.turnId,
        sessionId,
      });

      trace.push({
        type: "turn.started",
        component: "input_gate",
        atMs: clock(),
        traceId: traceIds.traceId,
        turnId: traceIds.turnId,
        sessionId: traceIds.sessionId,
        entrance,
        protocolVersion: event.protocolVersion,
      });

      // ---- 1. Session gate --------------------------------------------------
      const ensureResult = await sessionMapper.ensureSession({
        lumiSessionId: sessionId,
        conversationId,
        actorId: actor.actorId,
        traceId: traceIds.traceId,
        turnId: traceIds.turnId,
        onEvent: (fact) => {
          trace.push({
            type: "session.event",
            component: "session_map",
            atMs: clock(),
            traceId: traceIds.traceId,
            turnId: traceIds.turnId,
            sessionId: traceIds.sessionId,
            event: fact.event,
            state: fact.state,
            resultCode: fact.resultCode,
          });
        },
      });
      if (!ensureResult.ok) {
        const response = buildResponse({
          conversationId,
          turnId: event.turnId,
          traceId: event.traceId,
          status: "failed",
          content: null,
        });
        pushTurnCompleted({
          traceId: traceIds.traceId,
          turnId: traceIds.turnId,
          sessionId: traceIds.sessionId,
          status: "failed",
          resultCode: "session_unavailable",
          startedAtMs,
        });
        return result({
          response,
          route: null,
          skillApplied: false,
          skillVersion: null,
          skillResolution: null,
          persona: null,
          safetyTraces: [],
          failure: null,
          contextRefIds: [],
          harnessContext: null,
        });
      }

      // ---- 2. Input layer (real safety pipeline) ----------------------------
      const turnText = event.text.content;
      const inputSafety = evaluateTurnSafety({
        entrance,
        actorRole: actor.role,
        interactionText: turnText,
        ownChildRef: actor.childRef ?? undefined,
        refs: { requestId: event.requestId, traceId: event.traceId, turnId: event.turnId },
        decidedAt: completedAtFactory(),
      });
      trace.push({
        type: "input.decision",
        component: "input_gate",
        atMs: clock(),
        traceId: traceIds.traceId,
        turnId: traceIds.turnId,
        sessionId: traceIds.sessionId,
        decision: inputSafety.input?.decision ?? "block",
        ruleIds: Object.freeze((inputSafety.input?.hits ?? []).map((hit) => hit.ruleId)),
        durationMs: 0,
        resultCode:
          inputSafety.input?.decision === "escalate_crisis"
            ? "crisis_escalated"
            : inputSafety.blocked
              ? "blocked"
              : "ok",
      });

      if (inputSafety.input?.decision === "escalate_crisis") {
        // Deterministic crisis branch. The turn NEVER falls through to normal
        // orchestration: the only admissible output is the crisis-safe
        // response (already re-checked by the output gate inside the safety
        // pipeline). A blocked crisis response degrades to no content.
        const crisisAllowed = !inputSafety.blocked && inputSafety.finalOutput !== null;
        const response = buildResponse({
          conversationId,
          turnId: event.turnId,
          traceId: event.traceId,
          status: crisisAllowed ? "completed" : "failed",
          content: crisisAllowed ? inputSafety.finalOutput : null,
        });
        pushTurnCompleted({
          traceId: traceIds.traceId,
          turnId: traceIds.turnId,
          sessionId: traceIds.sessionId,
          status: response.status,
          resultCode: crisisAllowed ? "crisis_escalated" : "output_blocked",
          startedAtMs,
        });
        return result({
          response,
          route: null,
          skillApplied: false,
          skillVersion: null,
          skillResolution: null,
          persona: null,
          safetyTraces: inputSafety.traces,
          failure: null,
          contextRefIds: [],
          harnessContext: null,
        });
      }

      if (inputSafety.blocked) {
        const response = buildResponse({
          conversationId,
          turnId: event.turnId,
          traceId: event.traceId,
          status: "ignored",
          content: null,
        });
        pushTurnCompleted({
          traceId: traceIds.traceId,
          turnId: traceIds.turnId,
          sessionId: traceIds.sessionId,
          status: "ignored",
          resultCode: "blocked",
          startedAtMs,
        });
        return result({
          response,
          route: null,
          skillApplied: false,
          skillVersion: null,
          skillResolution: null,
          persona: null,
          safetyTraces: inputSafety.traces,
          failure: null,
          contextRefIds: [],
          harnessContext: null,
        });
      }

      // ---- 3. Persona resolution (re-validated snapshot) --------------------
      const turnProblems: ContractProblem[] = [];
      validatePersonaPolicyV0(options.personaPolicy, turnProblems);
      if (turnProblems.length > 0) {
        throw new ContractValidationError(turnProblems);
      }
      // R1-06: an explicit trusted style (guardian_config) is passed through
      // and re-validated by resolvePersonaTurn (assertValidStyleState) — a
      // malformed override fails the turn closed instead of degrading to the
      // default silently.
      const turnStyle =
        rawInput.personaStyle === undefined
          ? personaStyle
          : (rawInput.personaStyle as Readonly<PersonaStyleWithProvenance>);
      const persona = resolvePersonaTurn({
        policy: options.personaPolicy,
        style: turnStyle,
        actor,
        untrustedInputs: [{ provenance: "user_prompt_text", text: turnText }],
        turnIndex: 0,
      });
      trace.push({
        type: "persona.resolved",
        component: "persona",
        atMs: clock(),
        traceId: traceIds.traceId,
        turnId: traceIds.turnId,
        sessionId: traceIds.sessionId,
        policyId: persona.policyId,
        policyVersion: persona.policyVersion,
        boundariesEnforced: persona.boundariesEnforced,
        overrideAttempts: Object.freeze(persona.overrideAttempts.map((entry) => entry.reason)),
        durationMs: 0,
        resultCode: "ok",
      });

      // ---- 4. Skill routing + registry load ---------------------------------
      const route = routeSkillForText(turnText);
      let skillApplied = false;
      let skillVersion: string | null = null;
      let skillResolution: Readonly<RoutedSkillTurnResolution> | null = null;
      let skillHeader: string | null = null;
      const contextRefIds: string[] = [];
      const contextRefs: { kind: "evidence" | "memory"; refId: string; version: string | null }[] = [];
      let routeResultCode: RuntimeResultCode = "ok";
      if (route.route !== "none") {
        const loaded = loadSkillForChild(route.route, childAgeYears);
        if (loaded.status === "served") {
          skillApplied = true;
          skillVersion = loaded.skillVersion;
          if (route.route === "emotion_support") {
            // R1-11: the emotion skill executes its deterministic,
            // evidence-bound strategy; the composed guideline (versions,
            // stage directive, child-selectable strategies/exits, registry
            // limitations) shapes the model messages for this turn. The v0
            // pipeline passes priorStage null (stateless per turn; the
            // stage transition table is exercised by the eval subject and
            // the executor tests).
            const resolution = resolveEmotionSkillTurn({ load: loaded, turnText, priorStage: null });
            skillResolution = resolution;
            skillHeader = resolution.guideline;
          } else {
            // R1-12: the homework skill executes its deterministic,
            // evidence-bound strategy; the composed guideline (versions,
            // stage directive, child-selectable smallest steps, exits,
            // registry limitations) shapes the model messages for this
            // turn. The v0 pipeline passes priorStage null (stateless per
            // turn; the stage transition table is exercised by the eval
            // subject and the executor tests).
            //
            // R1-11 review P2-4 disposition for THIS route: the executor
            // call is wrapped in the existing controlled-degradation
            // pattern — a fail-closed executor throw degrades this turn to
            // skill_unavailable (the conversation continues WITHOUT the
            // skill, observable in the trace) instead of failing the whole
            // turn. The emotion route above keeps its pre-R1-12 behavior
            // (changing it here would be silent scope creep; see the PR).
            const execution = (options.homeworkExecutor ?? executeHomeworkSkillTurn)(loaded, turnText);
            if (execution.status === "executed") {
              skillResolution = execution.resolution;
              skillHeader = execution.resolution.guideline;
            } else {
              skillApplied = false;
              skillVersion = null;
              routeResultCode = "skill_unavailable";
            }
          }
          if (skillApplied) {
            for (const entry of loaded.evidence) {
              contextRefIds.push(entry.cardId);
              contextRefs.push({ kind: "evidence", refId: entry.cardId, version: entry.cardVersion });
            }
          }
        } else {
          // Controlled degradation: continue WITHOUT the skill; the gap is
          // observable (issue #25: 拒绝或受控降级).
          routeResultCode = "skill_unavailable";
        }
      }
      trace.push({
        type: "skill.routed",
        component: "skill_router",
        atMs: clock(),
        traceId: traceIds.traceId,
        turnId: traceIds.turnId,
        sessionId: traceIds.sessionId,
        route: route.route,
        reason: route.reason,
        arbitration: route.arbitration,
        skillVersion,
        evidenceRefs: Object.freeze([...contextRefIds]),
        durationMs: 0,
        resultCode: routeResultCode,
      });

      // ---- 5. Context build ---------------------------------------------------
      const harnessContext = buildHarnessContext({
        requestId: event.requestId,
        sessionId,
        conversationId,
        actor,
        personaVersion: persona.policyVersion,
        skillVersions: skillVersion === null || route.route === "none"
          ? []
          : [{ skillId: route.route, version: skillVersion }],
        contextRefs,
        unknownFields: [],
      });
      const messages = composeModelMessages({
        identityDisclosure,
        boundaries: boundariesEnforced,
        skillHeader,
        history: rawInput.history ?? [],
        currentText: turnText,
        budget: {
          maxHistoryMessages: harnessContext.budget.maxHistoryMessages,
          maxContextChars: harnessContext.budget.maxContextChars,
        },
      });
      const contextCharsUsed = messages.reduce((sum, message) => sum + message.content.length, 0);
      trace.push({
        type: "context.built",
        component: "context_builder",
        atMs: clock(),
        traceId: traceIds.traceId,
        turnId: traceIds.turnId,
        sessionId: traceIds.sessionId,
        contextRefCount: harnessContext.contextRefs.length,
        historyMessages: Math.max(0, messages.length - 2),
        contextCharBudget: harnessContext.budget.maxContextChars,
        contextCharsUsed,
        personaVersion: persona.policyVersion,
        durationMs: 0,
        resultCode: "ok",
      });

      // ---- 6. Model gateway call ----------------------------------------------
      const modelRequest = {
        requestId: event.requestId,
        traceId: event.traceId,
        turnId: event.turnId,
        modelId: options.modelId,
        messages,
        // The exact whitelist (issue #15 AC 3): nothing else is ever declared.
        tools: describeCordisToolSchema(),
        // timeoutMs / maxOutputTokens deliberately omitted: the gateway's
        // registered config.requestTimeoutMs and model-registration ceiling
        // now own the defaults (carried #37 review-note wiring).
      };
      trace.push({
        type: "model.requested",
        component: "model_gateway",
        atMs: clock(),
        traceId: traceIds.traceId,
        turnId: traceIds.turnId,
        sessionId: traceIds.sessionId,
        modelId: options.modelId,
        gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION,
        messageCount: messages.length,
        toolCount: modelRequest.tools.length,
      });

      let completed: GatewayCompleteResult | null = null;
      let gatewayError: GatewayError | null = null;
      try {
        completed = await gateway.complete(modelRequest, { signal: rawInput.signal });
      } catch (error) {
        if (error instanceof GatewayError) {
          gatewayError = error;
        } else {
          // Unknown throw shape: collapse to a static provider failure.
          gatewayError = new GatewayError("GATEWAY_PROVIDER_UNAVAILABLE", { reason: "unknown" });
        }
      }

      if (gatewayError !== null) {
        const contractErrorCode: string = GATEWAY_TO_CONTRACT_ERROR_CODE[gatewayError.code];
        const resultCode: RuntimeResultCode =
          gatewayError.code === "GATEWAY_CANCELLED"
            ? "model_cancelled"
            : gatewayError.outcome === "rejected" ||
                gatewayError.outcome === "budget_exhausted" ||
                gatewayError.outcome === "circuit_open"
              ? "model_rejected"
              : "model_failed";
        const status: TurnStatus = gatewayError.code === "GATEWAY_CANCELLED" ? "cancelled" : "failed";
        trace.push({
          type: "model.failed",
          component: "model_gateway",
          atMs: clock(),
          traceId: traceIds.traceId,
          turnId: traceIds.turnId,
          sessionId: traceIds.sessionId,
          modelId: options.modelId,
          gatewayCode: gatewayError.code,
          contractErrorCode,
          durationMs: clock() - startedAtMs,
          resultCode,
        });
        const response = buildResponse({
          conversationId,
          turnId: event.turnId,
          traceId: event.traceId,
          status,
          content: null,
        });
        pushTurnCompleted({
          traceId: traceIds.traceId,
          turnId: traceIds.turnId,
          sessionId: traceIds.sessionId,
          status,
          resultCode,
          startedAtMs,
        });
        return result({
          response,
          route,
          skillApplied,
          skillVersion,
          skillResolution,
          persona,
          safetyTraces: inputSafety.traces,
          failure: { gatewayCode: gatewayError.code, contractErrorCode },
          contextRefIds,
          harnessContext,
        });
      }

      // ---- 7. Output layer (real safety pipeline, fail-closed wrapper) --------
      const draft = completed?.fullText ?? "";
      const draftCodePoints = [...draft].length;
      if (draftCodePoints > RUNTIME_MAX_OUTPUT_CODE_POINTS) {
        trace.push({
          type: "output.decision",
          component: "output_gate",
          atMs: clock(),
          traceId: traceIds.traceId,
          turnId: traceIds.turnId,
          sessionId: traceIds.sessionId,
          decision: "block",
          ruleIds: Object.freeze(["output.over_contract_length"] as string[]),
          durationMs: 0,
          resultCode: "output_oversized",
        });
        const response = buildResponse({
          conversationId,
          turnId: event.turnId,
          traceId: event.traceId,
          status: "failed",
          content: null,
        });
        pushTurnCompleted({
          traceId: traceIds.traceId,
          turnId: traceIds.turnId,
          sessionId: traceIds.sessionId,
          status: "failed",
          resultCode: "output_oversized",
          startedAtMs,
        });
        return result({
          response,
          route,
          skillApplied,
          skillVersion,
          skillResolution,
          persona,
          safetyTraces: inputSafety.traces,
          failure: null,
          contextRefIds,
          harnessContext,
        });
      }

      const outputSafety = evaluateTurnSafety({
        entrance,
        actorRole: actor.role,
        interactionText: null,
        draftOutput: draft,
        ownChildRef: actor.childRef ?? undefined,
        refs: { requestId: event.requestId, traceId: event.traceId, turnId: event.turnId },
        decidedAt: completedAtFactory(),
      });
      trace.push({
        type: "output.decision",
        component: "output_gate",
        atMs: clock(),
        traceId: traceIds.traceId,
        turnId: traceIds.turnId,
        sessionId: traceIds.sessionId,
        decision: outputSafety.output?.decision ?? "block",
        ruleIds: Object.freeze((outputSafety.output?.hits ?? []).map((hit) => hit.ruleId)),
        durationMs: 0,
        resultCode: outputSafety.finalOutput === null ? "output_blocked" : "ok",
      });

      const outputAllowed = outputSafety.finalOutput !== null;
      const response = buildResponse({
        conversationId,
        turnId: event.turnId,
        traceId: event.traceId,
        status: outputAllowed ? "completed" : "ignored",
        content: outputAllowed ? outputSafety.finalOutput : null,
      });
      pushTurnCompleted({
        traceId: traceIds.traceId,
        turnId: traceIds.turnId,
        sessionId: traceIds.sessionId,
        status: response.status,
        resultCode: outputAllowed ? "ok" : "output_blocked",
        startedAtMs,
      });
      return result({
        response,
        route,
        skillApplied,
        skillVersion,
        skillResolution,
        persona,
        safetyTraces: [...inputSafety.traces, ...outputSafety.traces],
        failure: null,
        contextRefIds,
        harnessContext,
      });
    },

    async executeServiceCall(
      rawCall: unknown,
      refs: {
        readonly actorRole: unknown;
        readonly traceId: unknown;
        readonly turnId: unknown;
        readonly sessionId: unknown;
      },
    ): Promise<Readonly<PipelineServiceCallResult>> {
      if (typeof refs.actorRole !== "string" || !(ACTOR_ROLES as readonly string[]).includes(refs.actorRole)) {
        throw new ContractValidationError([
          problem("CONTRACT_FIELD_INVALID", "actorRole", "service calls need a verified actor role."),
        ]);
      }
      const traceIds = maskedTraceIds({
        traceId: refs.traceId,
        turnId: refs.turnId,
        sessionId: refs.sessionId,
      });
      // Session gate: tool calls only run inside an ACTIVE mapped session.
      const descriptor = sessionMapper.describe(traceIds.sessionId);
      if (descriptor === null || descriptor.state !== "active") {
        trace.push({
          type: "session.event",
          component: "session_map",
          atMs: clock(),
          traceId: traceIds.traceId,
          turnId: traceIds.turnId,
          sessionId: traceIds.sessionId,
          event: "session.defect",
          state: descriptor?.state ?? "unknown",
          resultCode: "session_unavailable",
        });
        return { status: "session_unavailable", state: descriptor?.state ?? "unknown" };
      }
      const execution = await executeCordisServiceCall(rawCall, {
        actorRole: refs.actorRole as ActorRole,
        handlers: options.handlers,
        refs: {
          traceId: isValidContractId("traceId", refs.traceId) ? (refs.traceId as string) : undefined,
          turnId: isValidContractId("turnId", refs.turnId) ? (refs.turnId as string) : undefined,
        },
      });
      if (execution.status === "rejected") {
        trace.push({
          type: "tool.rejected",
          component: "tool_gate",
          atMs: clock(),
          traceId: traceIds.traceId,
          turnId: traceIds.turnId,
          sessionId: traceIds.sessionId,
          decision: "block",
          ruleIds: execution.ruleIds,
          entrance: "dsh_tool",
          durationMs: 0,
          resultCode: "tool_rejected",
        });
      } else if (execution.status === "executed") {
        trace.push({
          type: "tool.executed",
          component: "cordis_service",
          atMs: clock(),
          traceId: traceIds.traceId,
          turnId: traceIds.turnId,
          sessionId: traceIds.sessionId,
          toolId: execution.toolId,
          toolVersion: execution.toolVersion,
          sideEffects: execution.sideEffects,
          durationMs: 0,
          resultCode: "ok",
        });
      } else {
        trace.push({
          type: "tool.failed",
          component: "cordis_service",
          atMs: clock(),
          traceId: traceIds.traceId,
          turnId: traceIds.turnId,
          sessionId: traceIds.sessionId,
          toolId: execution.toolId,
          durationMs: 0,
          resultCode: "tool_failed",
        });
      }
      return execution;
    },
  });
}
