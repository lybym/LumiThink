/**
 * R1-05 web MVP server infrastructure — composition root (issue #17),
 * extended by R1-06 guardian authorization wiring (issue #18).
 *
 * Wires the delivered R1 domains into the serving surface exactly once per
 * process:
 *
 * - Model Gateway (R1-02): the in-process Mock provider is THE default —
 *   zero egress, no key material anywhere (issue #14/#17 merge requirement:
 *   the demo runs without real API keys; real-provider activation stays
 *   behind the independent data-egress review and is NOT wired here).
 *   R1-06: the provider is wrapped in the egress gate + vendor request
 *   counter (lib/server/provider-egress-gate.ts) driven by the guardian
 *   `third_party_data_egress` switch — disabled third-party egress means
 *   the gateway refuses such providers BEFORE transport (vendor requests 0).
 * - DSH session mapper (R1-03) bound to the deterministic in-process
 *   adapter BEFORE serving turns (carried #38 review P2-2: an unbound port
 *   window would poison sessions with `no_port_bound` defects).
 * - Cordis pipeline (R1-03): real Input/Output safety gates (`ui_web`
 *   entrance), persona registry policy, skill router, context budget,
 *   value-free trace.
 * - Interaction service: contract v1.0 endpoint semantics (see
 *   interaction-service.ts), now with the R1-06 hooks: the family consent
 *   gate (`authorizeTurn`), the family cancel policy (guardian may stop
 *   own-family child turns) and the trusted guardian persona style.
 * - Guardian service (R1-06): login/session verification, disclosure
 *   acknowledgment, consent grant/revoke, feature switches, audit (see
 *   guardian-service.ts).
 * - Child memory service (R1-14): the whitelisted `memory.propose` /
 *   `memory.lookup` tools bind to the real candidate-only memory service,
 *   and the pipeline's memory-context hook retrieves confirmed refs per
 *   turn (ids + versions only). Agent proposals always concern the pinned
 *   demo child; confirm/correct/delete stay explicit human operations.
 *
 * The container is a globalThis singleton so Next.js dev hot-reload cannot
 * fork a second pipeline/ledger while one process is serving. All state is
 * process-local memory (single-process MVP; no persisted schema — guardian
 * sessions, authorizations and child memories included; disclosed in
 * docs/adr/0003-guardian-auth-v0.md and docs/adr/0004-child-memory-v0.md).
 *
 * This module stays framework-free (no next/react imports) so the composed
 * runtime is testable with node:test.
 */

import { createModelGateway, type ModelGateway } from "../domain/gateway/gateway.ts";
import { createMockModelProvider } from "../domain/gateway/mock-provider.ts";
import { parseModelGatewayConfig } from "../domain/gateway/config.ts";
import { parseActorContext } from "../domain/contract/actor.ts";
import { resolveActivePersona } from "../domain/persona/registry.ts";
import { createMemoryService, type MemoryService } from "../domain/memory/index.ts";
import { createCordisPipeline, type CordisPipeline } from "../domain/runtime/pipeline.ts";
import { createDshSessionMapper } from "../domain/runtime/session-map.ts";
import { createRuntimeTraceRecorder, type RuntimeTraceRecorder } from "../domain/runtime/trace.ts";
import type { CordisServiceHandler } from "../domain/runtime/cordis.ts";

import { createInProcessDshAdapter } from "./dsh-inprocess-adapter.ts";
import {
  createInteractionService,
  WEB_MVP_ACTOR_ID,
  WEB_MVP_CHILD_REF,
  WEB_MVP_DEMO_CHILD_AGE_YEARS,
  WEB_MVP_VERIFIED_BY,
  type InteractionService,
} from "./interaction-service.ts";
import {
  createGuardianService,
  type GuardianService,
} from "./guardian-service.ts";
import { gateProviderEgress, buildProviderEgressStatus, type ProviderEgressRegistration } from "./provider-egress-gate.ts";

export const WEB_MVP_MODEL_ID = "lumithink-mock-1" as const;
export const WEB_MVP_PROVIDER_ID = "mock-local" as const;
/**
 * Server-owned runtime principal for memory service calls (R1-14). Agent
 * proposals through the `memory.propose` tool surface under this system
 * identity; the SUBJECT is pinned separately to the demo child constant.
 */
export const WEB_MVP_RUNTIME_ACTOR_ID = "act_webmvp_runtime" as const;

export interface WebMvpRuntime {
  readonly service: InteractionService;
  readonly guardian: GuardianService;
  readonly pipeline: CordisPipeline;
  /** The composed model gateway (value-free audit trail; egress evidence). */
  readonly gateway: ModelGateway;
  readonly trace: RuntimeTraceRecorder;
  /** R1-14 child memory service (own store + own audit ring). */
  readonly memory: MemoryService;
}

/**
 * Deterministic gateway configuration values of the web MVP (exported for
 * the status/audit surfaces and tests). The Mock provider is in-process
 * (zero egress by construction); the explicit budget/retry/breaker/timeout
 * values keep every gateway invariant active (fail-closed config parsing
 * rejects anything else).
 */
export const WEB_MVP_GATEWAY_BUDGET = Object.freeze({
  maxRequestsPerDay: 2000,
  maxCostMicroUsdPerDay: 1_000_000,
  maxTotalTokensPerDay: 2_000_000,
});

/**
 * Compose one complete web MVP runtime (fresh; tests may create several).
 * R1-06 wiring order: guardian service first (own the switch state), then
 * the egress-gated provider, then the pipeline, then the interaction
 * service with the guardian hooks, and finally the guardian status feeds
 * (vendor request counters + usage summary).
 */
export function createWebMvpRuntime(): WebMvpRuntime {
  const trace = createRuntimeTraceRecorder();
  const guardian = createGuardianService();
  const memory = createMemoryService();

  /**
   * Server-verified runtime principal for the memory tool path (R1-14).
   * Built fresh per call; nothing client-side can influence any field.
   */
  const memoryRuntimeActor = () =>
    parseActorContext({
      role: "system",
      actorId: WEB_MVP_RUNTIME_ACTOR_ID,
      childRef: null,
      verifiedBy: WEB_MVP_VERIFIED_BY,
      verifiedAt: new Date().toISOString(),
    });

  /**
   * `memory.propose` tool handler (candidate-only by registry contract):
   * agent proposals become CANDIDATES in the memory service — never writes.
   * The subject is pinned SERVER-SIDE to the demo child constant: a
   * submitted subjectRef can never redirect a proposal at another child.
   * Structured rejections (type/label screen/duplicate/…) live in the
   * memory audit ring; the tool boundary only observes a failed call.
   */
  const memoryProposeHandler: CordisServiceHandler = async ({ call }) => {
    const input =
      call.input !== null && typeof call.input === "object" && !Array.isArray(call.input)
        ? (call.input as Record<string, unknown>)
        : {};
    const result = memory.proposeCandidate({ ...input, subjectRef: WEB_MVP_CHILD_REF }, memoryRuntimeActor());
    if (!result.ok) {
      throw new Error("memory_proposal_rejected");
    }
    return {
      ok: true,
      refs: [{ kind: "memory", refId: result.entry.memoryId, version: String(result.entry.revision) }],
      candidateOnly: true,
    };
  };

  /** `memory.lookup` tool handler: read-only refs for the demo child. */
  const memoryLookupHandler: CordisServiceHandler = async () => {
    const result = memory.retrieveForContext({ subjectRef: WEB_MVP_CHILD_REF }, memoryRuntimeActor());
    if (!result.ok) {
      throw new Error("memory_lookup_unavailable");
    }
    return {
      ok: true,
      refs: result.refs.map((ref) => ({ kind: "memory", refId: ref.refId, version: ref.version })),
      candidateOnly: false,
    };
  };

  const mockProvider = createMockModelProvider({
    providerId: WEB_MVP_PROVIDER_ID,
    script: {
      reply: {
        // Clearly synthetic child-facing demo text (never claims to be a
        // real model answer); structural suffix comes from the provider.
        prefix: "[Mock 演示] 好的，我在听，我们一起想办法。",
        chunkCount: 6,
        delayMsPerChunk: 0,
      },
    },
  });
  const gatedProvider = gateProviderEgress({
    provider: mockProvider,
    // The in-process mock has no external data path by construction.
    classification: "local_no_egress",
    isThirdPartyEgressEnabled: () => guardian.isThirdPartyEgressEnabled(),
  });

  const gateway = createModelGateway(
    parseModelGatewayConfig({
      gatewayVersion: "1.0",
      models: [
        {
          modelId: WEB_MVP_MODEL_ID,
          providerId: WEB_MVP_PROVIDER_ID,
          maxOutputTokens: 1024,
          pricing: null,
        },
      ],
      budget: { ...WEB_MVP_GATEWAY_BUDGET },
      retry: { maxAttempts: 1, backoffBaseMs: 1_000 },
      breaker: { failureThreshold: 5, cooldownMs: 60_000 },
      requestTimeoutMs: 30_000,
    }),
    [gatedProvider],
  );

  const pipeline = createCordisPipeline({
    gateway,
    modelId: WEB_MVP_MODEL_ID,
    // Port bound BEFORE serving (carried #38 review P2-2); deterministic
    // in-process adapter — the real DSH SDK adapter stays deferred to the
    // process-topology work (docs/TECH_STACK.md §2, docs/HARNESS.md §7).
    sessionMapper: createDshSessionMapper({ port: createInProcessDshAdapter() }),
    personaPolicy: resolveActivePersona(),
    trace,
    // R1-14 (issue #26): the whitelisted memory tools are bound to the real
    // candidate-only memory service (propose → candidate; lookup → refs).
    handlers: {
      "memory.propose": memoryProposeHandler,
      "memory.lookup": memoryLookupHandler,
    },
    // R1-14: minimal-by-need memory context retrieval (ids + versions only).
    // A service failure throws → the pipeline degrades observably to zero
    // memory refs (memory.context trace, memory_context_failed).
    memoryContext: ({ childRef }) => {
      const result = memory.retrieveForContext({ subjectRef: childRef }, memoryRuntimeActor());
      if (!result.ok) {
        throw new Error("memory_context_unavailable");
      }
      return result.refs;
    },
  });

  const service = createInteractionService({
    pipeline,
    childAgeYears: WEB_MVP_DEMO_CHILD_AGE_YEARS,
    entrance: "ui_web",
    ingress: "web",
    // R1-06 enforcement points:
    authorizeTurn: (actor) => guardian.assertModelInteractionAuthorized(actor),
    cancelPolicy: (canceller, owner) => guardian.familyCancelPolicy(canceller, owner),
    resolvePersonaStyle: () => guardian.currentFamilyStyle(),
  });

  // Guardian status feeds: real vendor request counters (the egress status
  // is AGGREGATED from the registered egress-gated providers via
  // buildProviderEgressStatus — per-provider counts for every registration
  // and the third-party count summed over third_party_api-classified
  // registrations only). No third-party provider is wired in this
  // composition, so that count is 0 by aggregation over an empty set, and
  // a future third-party registration updates the feed without new wiring.
  const egressRegistrations: ProviderEgressRegistration[] = [
    {
      providerId: WEB_MVP_PROVIDER_ID,
      classification: "local_no_egress",
      requestCount: () => gatedProvider.requestCount(),
    },
  ];
  guardian.configureEgressStatus(() => buildProviderEgressStatus(egressRegistrations));
  guardian.configureUsageSummary(() => ({
    conversationCount: service.conversationsOwnedBy(WEB_MVP_ACTOR_ID).length,
  }));

  return { service, guardian, pipeline, gateway, trace, memory };
}

const RUNTIME_GLOBAL_KEY = Symbol.for("lumithink.web-mvp.runtime");

/**
 * Process singleton (survives Next.js dev hot-reload; one pipeline, one
 * idempotency ledger, one turn registry and one guardian authorization
 * state per process).
 */
export function getWebMvpRuntime(): WebMvpRuntime {
  const container = globalThis as Record<symbol, WebMvpRuntime | undefined>;
  const existing = container[RUNTIME_GLOBAL_KEY];
  if (existing !== undefined) {
    return existing;
  }
  const created = createWebMvpRuntime();
  container[RUNTIME_GLOBAL_KEY] = created;
  return created;
}
