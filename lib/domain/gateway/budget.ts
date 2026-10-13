/**
 * R1-02 Model Gateway — daily usage ledger + circuit breaker
 * (docs/MODEL_GATEWAY.md §5, issue #14: "Token/费用统计、每日预算与熔断").
 *
 * - The ledger is an in-memory, day-keyed accumulator behind a narrow
   interface so a durable store (R1-08/R1-09) can replace it without touching
   the gateway. It records request counts, total tokens and cost in integer
   micro-USD — floats never touch money math.
 * - The breaker is a per-provider closed/open/half-open state machine driven
   by an injectable clock. Availability failures only (see errors.ts
   `isAvailabilityFailure`); budget rejections and auth/protocol failures
   never open the breaker because they say nothing about provider health.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { ingestDomainFact } from "../legacy-guard.ts";
import type { BreakerConfig, DailyBudgetConfig } from "./config.ts";
import type { ModelUsage } from "./types.ts";

// ---------------------------------------------------------------------------
// Day keys (UTC — budgets roll over at UTC midnight, documented)
// ---------------------------------------------------------------------------

/** UTC day key `YYYY-MM-DD` for an epoch-ms timestamp. */
export function dayKeyOf(epochMs: number): string {
  const date = new Date(epochMs);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Usage ledger
// ---------------------------------------------------------------------------

export interface UsageSnapshot {
  readonly requests: number;
  readonly totalTokens: number;
  readonly costMicroUsd: number;
}

export interface UsageLedger {
  /** Current accumulator for the given UTC day key (zeroed when absent). */
  snapshot(dayKey: string): UsageSnapshot;
  /** Add one completed request's actual usage to the day accumulator. */
  record(
    dayKey: string,
    delta: { readonly usage: ModelUsage; readonly costMicroUsd: number },
  ): void;
}

/** In-memory ledger (null-prototype day map; no persistence in R1-02). */
export function createInMemoryUsageLedger(): UsageLedger {
  const days: Record<string, { requests: number; totalTokens: number; costMicroUsd: number }> =
    Object.create(null);
  return Object.freeze({
    snapshot(dayKey: string): UsageSnapshot {
      if (!Object.hasOwn(days, dayKey)) {
        return Object.freeze({ requests: 0, totalTokens: 0, costMicroUsd: 0 });
      }
      const day = days[dayKey];
      return Object.freeze({
        requests: day.requests,
        totalTokens: day.totalTokens,
        costMicroUsd: day.costMicroUsd,
      });
    },
    record(
      dayKey: string,
      delta: { readonly usage: ModelUsage; readonly costMicroUsd: number },
    ): void {
      if (!Object.hasOwn(days, dayKey)) {
        days[dayKey] = { requests: 0, totalTokens: 0, costMicroUsd: 0 };
      }
      const day = days[dayKey];
      day.requests += 1;
      day.totalTokens += delta.usage.inputTokens + delta.usage.outputTokens;
      day.costMicroUsd += delta.costMicroUsd;
    },
  });
}

/** Pre-check decision of the budget gate (issue #14: 预算耗尽 → 拒绝并审计). */
export type BudgetDecision =
  | { readonly allowed: true; readonly reason: null }
  | { readonly allowed: false; readonly reason: "requests" | "cost" | "tokens" };

/**
 * Evaluate the daily budget BEFORE contacting the provider. Requests and
 * accumulated cost/tokens are checked against the configured caps; a single
 * response that overshoots a cap is recorded (with an audit trail) and every
 * subsequent request is rejected — the post-response window is documented in
 * docs/MODEL_GATEWAY.md §5.
 */
export function evaluateDailyBudget(
  budget: Readonly<DailyBudgetConfig>,
  snapshot: Readonly<UsageSnapshot>,
): BudgetDecision {
  if (snapshot.requests + 1 > budget.maxRequestsPerDay) {
    return { allowed: false, reason: "requests" };
  }
  if (snapshot.costMicroUsd >= budget.maxCostMicroUsdPerDay) {
    return { allowed: false, reason: "cost" };
  }
  if (snapshot.totalTokens >= budget.maxTotalTokensPerDay) {
    return { allowed: false, reason: "tokens" };
  }
  return { allowed: true, reason: null };
}

/** Deterministic integer cost in micro-USD (ceiling per side). */
export function computeCostMicroUsd(
  usage: Readonly<ModelUsage>,
  pricing: Readonly<{ inputMicroUsdPerMillionTokens: number; outputMicroUsdPerMillionTokens: number }> | null,
): number {
  if (pricing === null) {
    return 0;
  }
  const input = Math.ceil((usage.inputTokens * pricing.inputMicroUsdPerMillionTokens) / 1_000_000);
  const output = Math.ceil((usage.outputTokens * pricing.outputMicroUsdPerMillionTokens) / 1_000_000);
  return input + output;
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export const BREAKER_STATES = ["closed", "open", "half_open"] as const;
export type BreakerState = (typeof BREAKER_STATES)[number];

export interface CircuitBreaker {
  readonly state: BreakerState;
  /** Whether a request may attempt the provider right now (and in which mode). */
  canAttempt(now: number): { readonly allowed: boolean; readonly state: BreakerState };
  recordSuccess(now: number): void;
  recordFailure(now: number): void;
}

type BreakerInternal = {
  state: BreakerState;
  consecutiveFailures: number;
  openedAtMs: number | null;
  halfOpenProbeUsed: boolean;
};

/**
 * Per-provider circuit breaker: closed → (threshold consecutive availability
 * failures) → open → (cooldown elapsed) → half_open (single probe) →
 * closed on success / open again on failure.
 */
export function createCircuitBreaker(
  config: Readonly<BreakerConfig>,
  providerId: string,
): CircuitBreaker {
  const internal: BreakerInternal = {
    state: "closed",
    consecutiveFailures: 0,
    openedAtMs: null,
    halfOpenProbeUsed: false,
  };

  function snapshot(): BreakerState {
    return internal.state;
  }

  return Object.freeze({
    get state(): BreakerState {
      return snapshot();
    },
    canAttempt(now: number): { readonly allowed: boolean; readonly state: BreakerState } {
      if (internal.state === "closed") {
        return Object.freeze({ allowed: true, state: "closed" });
      }
      if (internal.state === "open") {
        if (internal.openedAtMs !== null && now - internal.openedAtMs >= config.cooldownMs) {
          // Cooldown elapsed: allow exactly one probe.
          internal.state = "half_open";
          internal.halfOpenProbeUsed = false;
        } else {
          return Object.freeze({ allowed: false, state: "open" });
        }
      }
      // half_open: allow only the first probe.
      if (internal.halfOpenProbeUsed) {
        return Object.freeze({ allowed: false, state: "half_open" });
      }
      internal.halfOpenProbeUsed = true;
      return Object.freeze({ allowed: true, state: "half_open" });
    },
    recordSuccess(now: number): void {
      internal.state = "closed";
      internal.consecutiveFailures = 0;
      internal.openedAtMs = null;
      internal.halfOpenProbeUsed = false;
    },
    recordFailure(now: number): void {
      if (internal.state === "half_open") {
        internal.state = "open";
        internal.openedAtMs = now;
        internal.halfOpenProbeUsed = true;
        return;
      }
      internal.consecutiveFailures += 1;
      if (internal.consecutiveFailures >= config.failureThreshold) {
        internal.state = "open";
        internal.openedAtMs = now;
      }
    },
  });
}

/** Frozen audit fact describing one breaker transition (value-free). */
export interface BreakerTransitionFact {
  readonly providerId: string;
  readonly from: BreakerState;
  readonly to: BreakerState;
  readonly atMs: number;
}

export function breakerTransition(
  providerId: string,
  from: BreakerState,
  to: BreakerState,
  atMs: number,
): Readonly<BreakerTransitionFact> {
  return ingestDomainFact({ providerId, from, to, atMs });
}
