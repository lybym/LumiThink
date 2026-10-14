/**
 * R1-05 web MVP server infrastructure — composition root (issue #17).
 *
 * Wires the delivered R1 domains into the serving surface exactly once per
 * process:
 *
 * - Model Gateway (R1-02): the in-process Mock provider is THE default —
 *   zero egress, no key material anywhere (issue #14/#17 merge requirement:
 *   the demo runs without real API keys; real-provider activation stays
 *   behind the independent data-egress review and is NOT wired here).
 * - DSH session mapper (R1-03) bound to the deterministic in-process
 *   adapter BEFORE serving turns (carried #38 review P2-2: an unbound port
 *   window would poison sessions with `no_port_bound` defects).
 * - Cordis pipeline (R1-03): real Input/Output safety gates (`ui_web`
 *   entrance), persona registry policy, skill router, context budget,
 *   value-free trace.
 * - Interaction service: contract v1.0 endpoint semantics (see
 *   interaction-service.ts).
 *
 * The container is a globalThis singleton so Next.js dev hot-reload cannot
 * fork a second pipeline/ledger while one process is serving. All state is
 * process-local memory (single-process MVP; no persisted schema).
 *
 * This module stays framework-free (no next/react imports) so the composed
 * runtime is testable with node:test.
 */

import { createModelGateway } from "../domain/gateway/gateway.ts";
import { createMockModelProvider } from "../domain/gateway/mock-provider.ts";
import { parseModelGatewayConfig } from "../domain/gateway/config.ts";
import { resolveActivePersona } from "../domain/persona/registry.ts";
import { createCordisPipeline, type CordisPipeline } from "../domain/runtime/pipeline.ts";
import { createDshSessionMapper } from "../domain/runtime/session-map.ts";
import { createRuntimeTraceRecorder, type RuntimeTraceRecorder } from "../domain/runtime/trace.ts";

import { createInProcessDshAdapter } from "./dsh-inprocess-adapter.ts";
import {
  createInteractionService,
  WEB_MVP_DEMO_CHILD_AGE_YEARS,
  type InteractionService,
} from "./interaction-service.ts";

export const WEB_MVP_MODEL_ID = "lumithink-mock-1" as const;
export const WEB_MVP_PROVIDER_ID = "mock-local" as const;

export interface WebMvpRuntime {
  readonly service: InteractionService;
  readonly pipeline: CordisPipeline;
  readonly trace: RuntimeTraceRecorder;
}

/**
 * Deterministic gateway configuration for the web MVP. The Mock provider is
 * in-process (zero egress by construction); the explicit budget/retry/
 * breaker/timeout values keep every gateway invariant active (fail-closed
 * config parsing rejects anything else).
 */
export function createWebMvpPipeline(trace?: RuntimeTraceRecorder): CordisPipeline {
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
      budget: {
        maxRequestsPerDay: 2000,
        maxCostMicroUsdPerDay: 1_000_000,
        maxTotalTokensPerDay: 2_000_000,
      },
      retry: { maxAttempts: 1, backoffBaseMs: 1_000 },
      breaker: { failureThreshold: 5, cooldownMs: 60_000 },
      requestTimeoutMs: 30_000,
    }),
    [
      createMockModelProvider({
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
      }),
    ],
  );

  return createCordisPipeline({
    gateway,
    modelId: WEB_MVP_MODEL_ID,
    // Port bound BEFORE serving (carried #38 review P2-2); deterministic
    // in-process adapter — the real DSH SDK adapter stays deferred to the
    // process-topology work (docs/TECH_STACK.md §2, docs/HARNESS.md §7).
    sessionMapper: createDshSessionMapper({ port: createInProcessDshAdapter() }),
    personaPolicy: resolveActivePersona(),
    trace: trace ?? createRuntimeTraceRecorder(),
  });
}

/** Compose one complete web MVP runtime (fresh; tests may create several). */
export function createWebMvpRuntime(): WebMvpRuntime {
  const trace = createRuntimeTraceRecorder();
  const pipeline = createWebMvpPipeline(trace);
  const service = createInteractionService({
    pipeline,
    childAgeYears: WEB_MVP_DEMO_CHILD_AGE_YEARS,
    entrance: "ui_web",
    ingress: "web",
  });
  return { service, pipeline, trace };
}

const RUNTIME_GLOBAL_KEY = Symbol.for("lumithink.web-mvp.runtime");

/**
 * Process singleton (survives Next.js dev hot-reload; one pipeline, one
 * idempotency ledger and one turn registry per process).
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
