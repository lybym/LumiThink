import assert from "node:assert/strict";
import test from "node:test";

import {
  computeCostMicroUsd,
  createCircuitBreaker,
  createInMemoryUsageLedger,
  dayKeyOf,
  evaluateDailyBudget,
} from "../../../lib/domain/gateway/budget.ts";
import type { DailyBudgetConfig } from "../../../lib/domain/gateway/config.ts";

test("day keys are UTC-based and roll over at UTC midnight", () => {
  assert.equal(dayKeyOf(Date.UTC(2026, 9, 14, 0, 0, 0)), "2026-10-14");
  assert.equal(dayKeyOf(Date.UTC(2026, 9, 14, 23, 59, 59)), "2026-10-14");
  assert.equal(dayKeyOf(Date.UTC(2026, 9, 14, 23, 59, 59) + 1000), "2026-10-15");
  assert.equal(dayKeyOf(0), "1970-01-01");
});

test("the in-memory ledger accumulates requests, tokens and integer cost per day", () => {
  const ledger = createInMemoryUsageLedger();
  const day = "2026-10-14";
  assert.deepEqual(ledger.snapshot(day), { requests: 0, totalTokens: 0, costMicroUsd: 0 });
  ledger.record(day, { usage: { inputTokens: 100, outputTokens: 50 }, costMicroUsd: 37 });
  ledger.record(day, { usage: { inputTokens: 10, outputTokens: 5 }, costMicroUsd: 3 });
  assert.deepEqual(ledger.snapshot(day), { requests: 2, totalTokens: 165, costMicroUsd: 40 });
  // Days are independent.
  assert.deepEqual(ledger.snapshot("2026-10-15"), { requests: 0, totalTokens: 0, costMicroUsd: 0 });
});

test("cost math stays in integer micro-USD with per-side ceiling", () => {
  const pricing = { inputMicroUsdPerMillionTokens: 1_500_000, outputMicroUsdPerMillionTokens: 6_000_000 };
  // 1.5 input tokens worth of micro-USD per million -> ceil, never float drift.
  assert.equal(computeCostMicroUsd({ inputTokens: 1, outputTokens: 0 }, pricing), 2);
  assert.equal(computeCostMicroUsd({ inputTokens: 0, outputTokens: 1 }, pricing), 6);
  assert.equal(computeCostMicroUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, pricing), 7_500_000);
  assert.equal(computeCostMicroUsd({ inputTokens: 999, outputTokens: 0 }, pricing), 1499);
  assert.equal(computeCostMicroUsd({ inputTokens: 10, outputTokens: 10 }, null), 0);
});

test("the daily budget gate rejects before provider contact when exhausted", () => {
  const budget: DailyBudgetConfig = {
    maxRequestsPerDay: 2,
    maxCostMicroUsdPerDay: 100,
    maxTotalTokensPerDay: 1000,
  };
  assert.deepEqual(evaluateDailyBudget(budget, { requests: 0, totalTokens: 0, costMicroUsd: 0 }), {
    allowed: true,
    reason: null,
  });
  assert.equal(evaluateDailyBudget(budget, { requests: 2, totalTokens: 0, costMicroUsd: 0 }).reason, "requests");
  assert.equal(evaluateDailyBudget(budget, { requests: 0, totalTokens: 0, costMicroUsd: 100 }).reason, "cost");
  assert.equal(evaluateDailyBudget(budget, { requests: 0, totalTokens: 1000, costMicroUsd: 0 }).reason, "tokens");
  // Overshoot is rejected on the NEXT request (post-response window documented).
  assert.equal(
    evaluateDailyBudget(budget, { requests: 1, totalTokens: 1200, costMicroUsd: 0 }).allowed,
    false,
  );
});

test("the circuit breaker opens after the configured consecutive availability failures", () => {
  const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 }, "provider-a");
  let now = 1000;
  assert.equal(breaker.state, "closed");
  assert.equal(breaker.canAttempt(now).allowed, true);
  breaker.recordFailure(now += 1);
  breaker.recordFailure(now += 1);
  assert.equal(breaker.state, "closed");
  breaker.recordFailure(now += 1);
  assert.equal(breaker.state, "open");
  assert.equal(breaker.canAttempt(now).allowed, false);
  // Before the cooldown elapses nothing gets through.
  assert.equal(breaker.canAttempt(now + 999).allowed, false);
});

test("the breaker half-open state admits exactly one probe", () => {
  const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 500 }, "provider-a");
  let now = 10_000;
  breaker.recordFailure(now);
  assert.equal(breaker.state, "open");
  now += 500;
  const probe = breaker.canAttempt(now);
  assert.deepEqual(probe, { allowed: true, state: "half_open" });
  // The second concurrent request is rejected while the probe is in flight.
  assert.equal(breaker.canAttempt(now).allowed, false);
  // Probe succeeds -> closed and healthy again.
  breaker.recordSuccess(now + 10);
  assert.equal(breaker.state, "closed");
  assert.equal(breaker.canAttempt(now + 20).state, "closed");
});

test("a failed half-open probe reopens the breaker with a fresh cooldown", () => {
  const breaker = createCircuitBreaker({ failureThreshold: 1, cooldownMs: 500 }, "provider-a");
  let now = 10_000;
  breaker.recordFailure(now);
  now += 500;
  assert.equal(breaker.canAttempt(now).state, "half_open");
  breaker.recordFailure(now + 10);
  assert.equal(breaker.state, "open");
  // The cooldown restarted at the probe failure, not at the original opening.
  assert.equal(breaker.canAttempt(now + 10 + 499).allowed, false);
  assert.equal(breaker.canAttempt(now + 10 + 500).allowed, true);
});

test("success resets the consecutive-failure count", () => {
  const breaker = createCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 }, "provider-a");
  let now = 0;
  breaker.recordFailure(now += 1);
  breaker.recordFailure(now += 1);
  breaker.recordSuccess(now += 1);
  breaker.recordFailure(now += 1);
  breaker.recordFailure(now += 1);
  assert.equal(breaker.state, "closed", "success must clear the consecutive counter");
});
