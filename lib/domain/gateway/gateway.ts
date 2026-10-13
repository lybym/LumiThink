/**
 * R1-02 Model Gateway — orchestration (docs/MODEL_GATEWAY.md, issue #14).
 *
 * One place enforces every gateway invariant for every provider:
 *
 * - fail-closed request validation, then model → provider registry resolution
 *   (Object.hasOwn / null-prototype; an unknown model or provider rejects
 *   with GATEWAY_NO_PROVIDER BEFORE any transport is touched);
 * - daily budget gate BEFORE the provider is contacted (拒绝并审计);
 * - per-provider circuit breaker gate (availability failures only);
 * - bounded retries with exponential backoff for retriable availability
 *   failures (429/5xx/transport) — NEVER for auth/protocol/invalid-request
 *   failures, NEVER after the first visible delta, and timeouts are never
 *   auto-retried (a timed-out child turn must not double-bill);
 * - per-attempt timeout via AbortController: timeout CANCELS the in-flight
 *   provider call and yields a structured GATEWAY_PROVIDER_TIMEOUT;
 * - caller cancellation (user stop) is a first-class outcome
 *   (GATEWAY_CANCELLED / outcome user_cancelled), distinct from timeout and
 *   from provider failures — even when the provider classifies the shared
 *   abort as a plain cancellation (issue #14: 区分用户中止、超时与服务器失败);
 * - NO provider failover exists anywhere: one model maps to exactly one
 *   provider; a failure degrades the turn with a structured error instead of
 *   silently switching to any other provider (issue #14: 不得因失败切换到
 *   未经授权的 Provider);
 * - every delta is validated (non-empty, ≤ contract per-delta code points)
 *   and the accumulated text must be non-empty on completion;
 * - the audit trail records structural facts only — ids (echoed ONLY after
 *   grammar re-validation, like the contract error envelope), attempts,
 *   outcomes, token/cost integers, breaker transitions — never message text,
 *   provider bodies or key material.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { isValidContractId, type ContractIdKind } from "../contract/core.ts";
import { ingestDomainFact } from "../legacy-guard.ts";
import {
  buildGatewayRegistry,
  describeGatewayConfig,
  lookupGatewayRegistry,
  type ModelGatewayConfig,
  type ProviderRegistrationView,
} from "./config.ts";
import {
  gatewayCodeForClassification,
  isAvailabilityFailure,
  GATEWAY_ERROR_REGISTRY,
  ProviderFailure,
  GatewayError,
  type GatewayErrorCode,
  type GatewayOutcome,
} from "./errors.ts";
import type { ModelProvider } from "./provider.ts";
import {
  computeCostMicroUsd,
  createCircuitBreaker,
  createInMemoryUsageLedger,
  dayKeyOf,
  evaluateDailyBudget,
  type BreakerState,
  type CircuitBreaker,
  type UsageLedger,
} from "./budget.ts";
import {
  parseModelRequest,
  validateProviderDelta,
  type ModelRequest,
  type ModelUsage,
  type ProviderStreamEvent,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export const GATEWAY_PROTOCOL_VERSION = "1.0" as const;

/** One streamed item; the stream ends with exactly one completed item. */
export type GatewayStreamItem =
  | { readonly kind: "delta"; readonly text: string }
  | { readonly kind: "completed"; readonly result: GatewayCompleteResult };

/** Terminal result of a successful gateway turn (structural facts + text). */
export interface GatewayCompleteResult {
  readonly protocolVersion: typeof GATEWAY_PROTOCOL_VERSION;
  readonly fullText: string;
  readonly usage: Readonly<ModelUsage>;
  readonly costMicroUsd: number;
  readonly modelId: string;
  readonly providerId: string;
  readonly attempts: number;
}

/**
 * Structural audit fact (value-free). Ids are echoed only after grammar
 * re-validation — otherwise the fixed mask below is recorded instead, so an
 * attacker-shaped value can never travel into audit (same no-echo rule as
 * the contract error envelope and the evidence registry).
 */
export const AUDIT_UNVERIFIED_ID = "[unverified]" as const;

export type GatewayAuditEvent =
  | {
      readonly type: "request.accepted";
      readonly atMs: number;
      readonly requestId: string;
      readonly traceId: string;
      readonly turnId: string;
      readonly modelId: string;
    }
  | {
      readonly type: "request.rejected";
      readonly atMs: number;
      readonly requestId: string;
      readonly traceId: string;
      readonly turnId: string;
      readonly code: GatewayErrorCode;
      readonly detailKeys: readonly string[];
    }
  | {
      readonly type: "budget.rejected";
      readonly atMs: number;
      readonly requestId: string;
      readonly dayKey: string;
      readonly reason: "requests" | "cost" | "tokens";
      readonly snapshot: { readonly requests: number; readonly totalTokens: number; readonly costMicroUsd: number };
    }
  | {
      readonly type: "circuit.open";
      readonly atMs: number;
      readonly requestId: string;
      readonly providerId: string;
      readonly state: BreakerState;
    }
  | {
      readonly type: "attempt.started";
      readonly atMs: number;
      readonly requestId: string;
      readonly providerId: string;
      readonly modelId: string;
      readonly attempt: number;
      readonly timeoutMs: number;
    }
  | {
      readonly type: "attempt.failed";
      readonly atMs: number;
      readonly requestId: string;
      readonly providerId: string;
      readonly attempt: number;
      readonly code: GatewayErrorCode;
      readonly retriable: boolean;
    }
  | {
      readonly type: "attempt.cancelled";
      readonly atMs: number;
      readonly requestId: string;
      readonly providerId: string;
      readonly attempt: number;
      readonly by: "caller" | "timeout";
    }
  | {
      readonly type: "turn.completed";
      readonly atMs: number;
      readonly requestId: string;
      readonly providerId: string;
      readonly modelId: string;
      readonly attempts: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly costMicroUsd: number;
      readonly durationMs: number;
    }
  | {
      readonly type: "budget.overshoot";
      readonly atMs: number;
      readonly requestId: string;
      readonly dayKey: string;
    }
  | {
      readonly type: "breaker.transition";
      readonly atMs: number;
      readonly providerId: string;
      readonly from: BreakerState;
      readonly to: BreakerState;
    };

export interface ModelGateway {
  /** Primary streaming surface (docs/HARNESS.md §3 contract). */
  stream(
    request: unknown,
    options?: { readonly signal?: AbortSignal },
  ): AsyncIterable<GatewayStreamItem>;
  /** Convenience non-streaming surface: consumes stream(), returns the result. */
  complete(
    request: unknown,
    options?: { readonly signal?: AbortSignal },
  ): Promise<GatewayCompleteResult>;
  /** Redacted, reviewable configuration view (no key material, origin only). */
  describeConfig(): Readonly<ReturnType<typeof describeGatewayConfig>>;
  /** Ring-buffered structural audit trail (value-free). */
  auditTrail(): readonly GatewayAuditEvent[];
}

const MAX_AUDIT_EVENTS = 1000;
/** Hard UTF-16-unit guard on the accumulated output (defensive overflow). */
const MAX_STREAMED_TEXT_UTF16 = 32000;

function maskedId(kind: ContractIdKind, value: unknown): string {
  return isValidContractId(kind, value) ? (value as string) : AUDIT_UNVERIFIED_ID;
}

export function createModelGateway(
  config: Readonly<ModelGatewayConfig>,
  providers: readonly ModelProvider[],
  deps: {
    readonly clock?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly ledger?: UsageLedger;
  } = {},
): ModelGateway {
  const clock = deps.clock ?? (() => Date.now());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const ledger = deps.ledger ?? createInMemoryUsageLedger();

  const providersById = buildGatewayRegistry(
    providers.map((provider) => ({ key: provider.providerId, provider })),
    "providers",
  );
  const modelsById = buildGatewayRegistry(
    config.models.map((registration) => ({ key: registration.modelId, registration })),
    "models",
  );

  const breakers = new Map<string, CircuitBreaker>();
  function breakerFor(providerId: string): CircuitBreaker {
    const existing = breakers.get(providerId);
    if (existing !== undefined) {
      return existing;
    }
    const created = createCircuitBreaker(config.breaker, providerId);
    breakers.set(providerId, created);
    return created;
  }

  const audit: GatewayAuditEvent[] = [];
  function pushAudit(event: GatewayAuditEvent): void {
    audit.push(ingestDomainFact(event) as GatewayAuditEvent);
    if (audit.length > MAX_AUDIT_EVENTS) {
      audit.shift();
    }
  }

  function recordBreakerTransition(providerId: string, from: BreakerState, to: BreakerState): void {
    if (from !== to) {
      pushAudit({ type: "breaker.transition", atMs: clock(), providerId, from, to });
    }
  }

  async function* run(
    rawRequest: unknown,
    options: { readonly signal?: AbortSignal },
  ): AsyncGenerator<GatewayStreamItem, void, unknown> {
    const callerSignal = options.signal ?? null;
    const startedAtMs = clock();

    // ---- 1. Fail-closed request validation ---------------------------------
    let request: Readonly<ModelRequest>;
    try {
      request = parseModelRequest(rawRequest);
    } catch (error) {
      const problemCount =
        error instanceof Error &&
        "problems" in error &&
        Array.isArray((error as { problems?: unknown[] }).problems)
          ? (error as { problems: unknown[] }).problems.length
          : 1;
      const raw =
        rawRequest !== null && typeof rawRequest === "object" ? (rawRequest as Record<string, unknown>) : {};
      pushAudit({
        type: "request.rejected",
        atMs: clock(),
        // Echo only grammar-verified ids; anything else is masked.
        requestId: maskedId("requestId", raw.requestId),
        traceId: maskedId("traceId", raw.traceId),
        turnId: maskedId("turnId", raw.turnId),
        code: "GATEWAY_INVALID_REQUEST",
        detailKeys: ["problemCount"],
      });
      throw new GatewayError("GATEWAY_INVALID_REQUEST", { problemCount });
    }

    pushAudit({
      type: "request.accepted",
      atMs: clock(),
      requestId: request.requestId,
      traceId: request.traceId,
      turnId: request.turnId,
      modelId: request.modelId,
    });

    // ---- 2. Model → provider resolution (no default route exists) ----------
    const modelEntry = lookupGatewayRegistry(modelsById, request.modelId);
    const registration = modelEntry === null ? null : modelEntry.registration;
    const providerEntry =
      registration === null ? null : lookupGatewayRegistry(providersById, registration.providerId);
    if (registration === null || providerEntry === null) {
      throw new GatewayError("GATEWAY_NO_PROVIDER", {
        registeredModels: Object.keys(modelsById).length,
      });
    }
    const provider: ModelProvider = providerEntry.provider;
    if (provider.dataEgressAuthorized !== true) {
      // Defense in depth: a provider that cannot prove explicit authorization
      // is treated exactly like a missing provider (fail closed, no egress).
      throw new GatewayError("GATEWAY_NO_PROVIDER", {
        registeredModels: Object.keys(modelsById).length,
      });
    }

    // ---- 3. Daily budget gate (before ANY provider contact) ----------------
    const dayKey = dayKeyOf(clock());
    const snapshot = ledger.snapshot(dayKey);
    const decision = evaluateDailyBudget(config.budget, snapshot);
    if (!decision.allowed) {
      pushAudit({
        type: "budget.rejected",
        atMs: clock(),
        requestId: request.requestId,
        dayKey,
        reason: decision.reason,
        snapshot,
      });
      throw new GatewayError("GATEWAY_BUDGET_EXHAUSTED", {
        reason: decision.reason,
        dayKey,
      });
    }

    // ---- 4. Circuit breaker gate -------------------------------------------
    const breaker = breakerFor(registration.providerId);
    const breakerBefore: BreakerState = breaker.state;
    const admission = breaker.canAttempt(clock());
    recordBreakerTransition(registration.providerId, breakerBefore, admission.state);
    if (!admission.allowed) {
      pushAudit({
        type: "circuit.open",
        atMs: clock(),
        requestId: request.requestId,
        providerId: registration.providerId,
        state: admission.state,
      });
      throw new GatewayError("GATEWAY_CIRCUIT_OPEN", {
        providerId: registration.providerId,
        state: admission.state,
      });
    }

    // ---- 5. Bounded attempts ------------------------------------------------
    const maxAttempts = config.retry.maxAttempts;
    let attempts = 0;
    let hasVisibleDelta = false;

    while (attempts < maxAttempts) {
      if (callerSignal?.aborted === true) {
        throw new GatewayError("GATEWAY_CANCELLED", { attempt: attempts });
      }
      attempts += 1;
      const timeoutMs = request.timeoutMs;
      const attemptController = new AbortController();
      // Holder object: property state is never flow-narrowed across the
      // callbacks below (a bare `let` would risk unsound narrowing).
      const attemptState: { cancelReason: "caller" | "timeout" | null } = { cancelReason: null };

      const onCallerAbort = (): void => {
        attemptState.cancelReason = "caller";
        attemptController.abort("caller");
      };
      if (callerSignal !== null) {
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
      const timeoutHandle = setTimeout(() => {
        attemptState.cancelReason = "timeout";
        attemptController.abort("timeout");
      }, timeoutMs);

      let settled = false;
      const abortCtl: { reject: ((marker: { readonly aborted: true }) => void) | null } = { reject: null };
      const abortPromise = new Promise<never>((_resolve, reject) => {
        abortCtl.reject = reject;
      });
      // Never let a late abort become an unhandled rejection.
      abortPromise.catch(() => undefined);
      const onAttemptAbort = (): void => {
        if (attemptState.cancelReason === null) {
          attemptState.cancelReason = "caller";
        }
        if (!settled) {
          settled = true;
          abortCtl.reject?.({ aborted: true });
        }
      };
      attemptController.signal.addEventListener("abort", onAttemptAbort, { once: true });
      if (attemptController.signal.aborted && attemptState.cancelReason !== null && !settled) {
        settled = true;
        abortCtl.reject?.({ aborted: true });
      }

      pushAudit({
        type: "attempt.started",
        atMs: clock(),
        requestId: request.requestId,
        providerId: registration.providerId,
        modelId: request.modelId,
        attempt: attempts,
        timeoutMs,
      });

      const iterator = provider
        .stream(request, { signal: attemptController.signal })
        [Symbol.asyncIterator]();
      let usage: ModelUsage | null = null;
      let fullText = "";

      try {
        for (;;) {
          let step: IteratorResult<ProviderStreamEvent>;
          try {
            step = await Promise.race([iterator.next(), abortPromise]);
          } catch (raceError) {
            // Only the gateway's own abort marker takes the cancellation
            // path; a provider failure must fall through to the outer
            // handler below (classification / retry logic).
            if (
              typeof raceError === "object" &&
              raceError !== null &&
              (raceError as { aborted?: unknown }).aborted === true
            ) {
              break;
            }
            throw raceError;
          }
          if (step.done === true) {
            break;
          }
          const event = step.value;
          if (event.type === "delta") {
            let text: string;
            try {
              text = validateProviderDelta(event.text);
            } catch {
              // A delta that violates the contract is a provider protocol
              // failure and must never reach the consumer.
              throw new GatewayError("GATEWAY_PROVIDER_PROTOCOL", { reason: "delta_invalid" });
            }
            if (fullText.length + text.length > MAX_STREAMED_TEXT_UTF16) {
              throw new GatewayError("GATEWAY_PROVIDER_PROTOCOL", { reason: "output_overflow" });
            }
            fullText += text;
            hasVisibleDelta = true;
            yield { kind: "delta", text };
          } else {
            usage = event.usage;
          }
        }
      } catch (error) {
        const gatewayError = normalizeAttemptError(
          error,
          attemptState.cancelReason,
          registration.providerId,
          attempts,
        );
        pushAudit({
          type: "attempt.failed",
          atMs: clock(),
          requestId: request.requestId,
          providerId: registration.providerId,
          attempt: attempts,
          code: gatewayError.code,
          retriable: gatewayError.retriable,
        });
        if (isAvailabilityFailure(gatewayError.code)) {
          const before = breaker.state;
          breaker.recordFailure(clock());
          recordBreakerTransition(registration.providerId, before, breaker.state);
        }
        if (gatewayError.outcome === "user_cancelled") {
          throw gatewayError;
        }
        if (
          !gatewayError.retriable ||
          attempts >= maxAttempts ||
          gatewayError.code === "GATEWAY_PROVIDER_TIMEOUT" ||
          hasVisibleDelta
        ) {
          throw gatewayError;
        }
        await sleep(config.retry.backoffBaseMs * 2 ** (attempts - 1));
        continue;
      } finally {
        clearTimeout(timeoutHandle);
        if (callerSignal !== null) {
          callerSignal.removeEventListener("abort", onCallerAbort);
        }
        attemptController.signal.removeEventListener("abort", onAttemptAbort);
        if (attemptState.cancelReason !== null) {
          // Cancel in-flight provider work best-effort; never await it.
          void Promise.resolve(iterator.return?.()).catch(() => undefined);
        }
      }

      if (attemptState.cancelReason !== null) {
        pushAudit({
          type: "attempt.cancelled",
          atMs: clock(),
          requestId: request.requestId,
          providerId: registration.providerId,
          attempt: attempts,
          by: attemptState.cancelReason,
        });
        if (attemptState.cancelReason === "timeout") {
          const before = breaker.state;
          breaker.recordFailure(clock());
          recordBreakerTransition(registration.providerId, before, breaker.state);
          throw new GatewayError("GATEWAY_PROVIDER_TIMEOUT", {
            providerId: registration.providerId,
            attempt: attempts,
          });
        }
        throw new GatewayError("GATEWAY_CANCELLED", {
          providerId: registration.providerId,
          attempt: attempts,
        });
      }

      // Provider stream ended normally. Enforce the terminal-event contract.
      if (usage === null) {
        throw new GatewayError("GATEWAY_PROVIDER_PROTOCOL", { reason: "missing_completed" });
      }
      if (fullText.trim().length === 0) {
        throw new GatewayError("GATEWAY_PROVIDER_PROTOCOL", { reason: "empty_output" });
      }

      // ---- 6. Accounting (integer money math; overshoot recorded) ----------
      const costMicroUsd = computeCostMicroUsd(usage, registration.pricing);
      ledger.record(dayKey, { usage, costMicroUsd });
      const afterSnapshot = ledger.snapshot(dayKey);
      if (
        afterSnapshot.totalTokens > config.budget.maxTotalTokensPerDay ||
        afterSnapshot.costMicroUsd > config.budget.maxCostMicroUsdPerDay
      ) {
        pushAudit({ type: "budget.overshoot", atMs: clock(), requestId: request.requestId, dayKey });
      }

      const before = breaker.state;
      breaker.recordSuccess(clock());
      recordBreakerTransition(registration.providerId, before, breaker.state);

      const result: GatewayCompleteResult = ingestDomainFact({
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        fullText,
        usage,
        costMicroUsd,
        modelId: request.modelId,
        providerId: registration.providerId,
        attempts,
      }) as GatewayCompleteResult;

      pushAudit({
        type: "turn.completed",
        atMs: clock(),
        requestId: request.requestId,
        providerId: registration.providerId,
        modelId: request.modelId,
        attempts,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costMicroUsd,
        durationMs: clock() - startedAtMs,
      });

      yield { kind: "completed", result };
      return;
    }

    // Unreachable by construction (every attempt path either throws or is
    // retried with attempts < max); kept fail-closed for future edits.
    throw new GatewayError("GATEWAY_PROVIDER_UNAVAILABLE", { reason: "attempt_exhausted" });
  }

  return Object.freeze({
    stream(
      request: unknown,
      options?: { readonly signal?: AbortSignal },
    ): AsyncIterable<GatewayStreamItem> {
      return run(request, options ?? {});
    },
    async complete(
      request: unknown,
      options?: { readonly signal?: AbortSignal },
    ): Promise<GatewayCompleteResult> {
      let result: GatewayCompleteResult | null = null;
      for await (const item of run(request, options ?? {})) {
        if (item.kind === "completed") {
          result = item.result;
        }
      }
      if (result === null) {
        throw new GatewayError("GATEWAY_PROVIDER_PROTOCOL", { reason: "missing_completed" });
      }
      return result;
    },
    describeConfig() {
      const views: ProviderRegistrationView[] = providers.map((provider) => provider.registrationView());
      return describeGatewayConfig(config, views);
    },
    auditTrail(): readonly GatewayAuditEvent[] {
      return audit;
    },
  });
}

/**
 * Map anything a provider surfaced into a GatewayError. Cancellation
 * ownership: the gateway's own abort bookkeeping wins over the provider's
 * classification, so a user stop can never be mislabeled as a provider
 * failure (and vice versa a timeout can never masquerade as a user stop).
 */
function normalizeAttemptError(
  error: unknown,
  cancelReason: "caller" | "timeout" | null,
  providerId: string,
  attempt: number,
): GatewayError {
  if (cancelReason === "timeout") {
    return new GatewayError("GATEWAY_PROVIDER_TIMEOUT", { providerId, attempt });
  }
  if (cancelReason === "caller") {
    return new GatewayError("GATEWAY_CANCELLED", { providerId, attempt });
  }
  if (error instanceof GatewayError) {
    return error;
  }
  if (error instanceof ProviderFailure) {
    if (error.classification === "cancelled") {
      // The provider observed the shared abort before the gateway's race —
      // with no gateway-side reason recorded this can only be a caller stop.
      return new GatewayError("GATEWAY_CANCELLED", { providerId, attempt });
    }
    const code = gatewayCodeForClassification(error.classification);
    if (code !== null) {
      const details: Record<string, string | number> = { providerId, attempt };
      if (error.statusClass !== null) {
        details.statusClass = error.statusClass;
      }
      return new GatewayError(code, details);
    }
  }
  // Unknown provider exception: collapse to a static unavailable error.
  // The original message/stack is deliberately discarded (no leak path).
  return new GatewayError("GATEWAY_PROVIDER_UNAVAILABLE", { providerId, attempt });
}

export { GATEWAY_ERROR_REGISTRY };
export type { GatewayErrorCode, GatewayOutcome };
