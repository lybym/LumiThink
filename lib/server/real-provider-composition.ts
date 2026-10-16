/**
 * E2E-03 (issue #53) — real LLM provider activation and gateway composition.
 *
 * Issue #53 turns the R1-02 promise (docs/MODEL_GATEWAY.md §7: the real
 * provider path is shipped but disabled) into a REVIEWED, EXPLICITLY
 * CONFIGURED activation path with fail-closed gates:
 *
 *  - The route selector is `LUMITHINK_MODEL_ROUTE`: `mock` (default, CI) or
 *    `real` (opt-in test environments only). Any other value fails closed.
 *  - `real` requires EVERY structural fact of the "首个模型 Provider" record:
 *    endpoint origin (https; loopback http only for synthetic servers),
 *    model id, output ceiling, integer pricing, explicit daily budget,
 *    retry/breaker bounds, per-attempt timeout, and the data-egress review
 *    record (reviewer + reason) — the independent review the runtime side
 *    must be able to name (issue #53 实施范围 3). Problems list variable
 *    NAMES only, never values.
 *  - The provider credential is NEVER read at parse/activation time: the
 *    keySource closure resolves `LUMITHINK_MODEL_PROVIDER_KEY` at REQUEST
 *    time (R1-00 rule; secrets-registry slot `model_provider_api_key`). With
 *    no key configured every request fails closed as GATEWAY_AUTH_FAILED
 *    before any vendor call is accounted as success.
 *  - The gateway keeps ALL semantics (error classification, token/cost
 *    accounting, timeout, budget, cancellation, single-provider routing —
 *    one model ↔ one provider, no failover); this module only assembles it.
 *  - CHILD DATA BOUNDARY (issue #53 DoD 4): the child-data processing review
 *    and guardian authorization have NOT been performed. `CHILD_DATA_
 *    EGRESS_REVIEW_STATUS` is a constant, not a flag: no configuration can
 *    unlock real-child-data egress through this composition. The activation
 *    record covers the synthetic/adult-content evidence path only.
 *
 * This module is server-layer (node-free apart from types; no next/react/
 * prisma imports) and reuses the dependency-free domain gateway.
 */

import {
  createHttpMessagesProvider,
  createModelGateway,
  parseModelGatewayConfig,
  type DataEgressReviewAcknowledgement,
  type ModelGateway,
  type ModelProvider,
} from "../domain/gateway/index.ts";
import {
  MAX_OUTPUT_TOKENS_LIMIT,
  MAX_REQUEST_TIMEOUT_MS,
  isGatewayId,
} from "../domain/gateway/types.ts";

/** Route selector values (issue #53 DoD 3: Mock/真实可配置切换，CI 默认 Mock). */
export const MODEL_ROUTE_VALUES = ["mock", "real"] as const;
export type ModelProviderRoute = (typeof MODEL_ROUTE_VALUES)[number];

/**
 * The internal provider registry label of the FIRST reviewed provider
 * (issue #53 实施范围 1). It is a routing label, not an endpoint: the actual
 * endpoint comes exclusively from the explicit activation configuration.
 * Matches the pinned DSH runtime's provider id so the Bridge child and the
 * gateway describe the same provider.
 */
export const REAL_PROVIDER_ID = "deepseek-official" as const;

/**
 * Child-data processing review status (issue #53 DoD 4). Deliberately a
 * CONSTANT: until a dedicated review + guardian authorization exist, real
 * child data must stay structurally unable to reach a remote provider.
 */
export const CHILD_DATA_EGRESS_REVIEW_STATUS = "not_performed" as const;

/** Every environment variable the `real` route may consume (names only). */
export const REAL_PROVIDER_ENV_VARS = Object.freeze([
  "LUMITHINK_MODEL_ROUTE",
  "LUMITHINK_REAL_PROVIDER_BASEURL",
  "LUMITHINK_REAL_PROVIDER_MODEL_ID",
  "LUMITHINK_REAL_PROVIDER_REVIEWER",
  "LUMITHINK_REAL_PROVIDER_REVIEW_REASON",
  "LUMITHINK_REAL_PROVIDER_MAX_OUTPUT_TOKENS",
  "LUMITHINK_REAL_PROVIDER_INPUT_MICRO_USD_PER_MTOKEN",
  "LUMITHINK_REAL_PROVIDER_OUTPUT_MICRO_USD_PER_MTOKEN",
  "LUMITHINK_REAL_PROVIDER_MAX_REQUESTS_PER_DAY",
  "LUMITHINK_REAL_PROVIDER_MAX_COST_MICRO_USD_PER_DAY",
  "LUMITHINK_REAL_PROVIDER_MAX_TOTAL_TOKENS_PER_DAY",
  "LUMITHINK_REAL_PROVIDER_REQUEST_TIMEOUT_MS",
  "LUMITHINK_REAL_PROVIDER_RETRY_MAX_ATTEMPTS",
  "LUMITHINK_REAL_PROVIDER_RETRY_BACKOFF_BASE_MS",
  "LUMITHINK_REAL_PROVIDER_BREAKER_FAILURE_THRESHOLD",
  "LUMITHINK_REAL_PROVIDER_BREAKER_COOLDOWN_MS",
  /**
   * The credential slot — REQUEST-TIME ONLY (never read during activation
   * parsing; never logged; secrets-registry slot `model_provider_api_key`).
   */
  "LUMITHINK_MODEL_PROVIDER_KEY",
] as const);

export class RealProviderActivationError extends Error {
  /** Variable names/rules that failed validation. Values are never included. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Real provider activation failed closed: ${problems.join("; ")}`);
    this.name = "RealProviderActivationError";
    this.problems = Object.freeze([...problems]);
  }
}

/** Loose env source (same idiom as lib/env.ts). */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/** The reviewed "first provider" record the `real` route is built from. */
export interface RealProviderActivationRecord {
  readonly providerId: typeof REAL_PROVIDER_ID;
  /** Absolute endpoint ORIGIN (https; loopback http only for synthetic test servers). */
  readonly baseURL: string;
  /** The single model id bound to the single provider (no failover). */
  readonly modelId: string;
  readonly maxOutputTokens: number;
  readonly pricing: {
    readonly inputMicroUsdPerMillionTokens: number;
    readonly outputMicroUsdPerMillionTokens: number;
  };
  readonly budget: {
    readonly maxRequestsPerDay: number;
    readonly maxCostMicroUsdPerDay: number;
    readonly maxTotalTokensPerDay: number;
  };
  readonly retry: { readonly maxAttempts: number; readonly backoffBaseMs: number };
  readonly breaker: { readonly failureThreshold: number; readonly cooldownMs: number };
  readonly requestTimeoutMs: number;
  /** The named data-egress review record (issue #53 实施范围 3). */
  readonly dataEgressReview: DataEgressReviewAcknowledgement;
}

export type RealProviderActivation =
  | { readonly mode: "mock" }
  | { readonly mode: "real"; readonly record: RealProviderActivationRecord };

function isPositiveInt(value: string | undefined, min: number, max: number): value is string {
  if (value === undefined || value === "") {
    return false;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max;
}

/**
 * Parse the route selector + activation record fail-closed. Returns `mock`
 * for the default/absent selector; throws `RealProviderActivationError`
 * (variable NAMES only) when `LUMITHINK_MODEL_ROUTE=real` is incomplete.
 * The provider key is deliberately NOT read here.
 */
export function parseRealProviderActivation(env: EnvSource): RealProviderActivation {
  const rawRoute = env.LUMITHINK_MODEL_ROUTE;
  if (rawRoute === undefined || rawRoute === "") {
    return { mode: "mock" };
  }
  if (rawRoute === "mock") {
    return { mode: "mock" };
  }
  if (rawRoute !== "real") {
    throw new RealProviderActivationError([
      "LUMITHINK_MODEL_ROUTE must be one of mock | real when set",
    ]);
  }

  const problems: string[] = [];
  const requireField = (name: string, value: string | undefined, rule: string): string => {
    if (value === undefined || value === "") {
      problems.push(`${name} is required when LUMITHINK_MODEL_ROUTE=real`);
      return "";
    }
    if (rule !== "" && !new RegExp(rule).test(value)) {
      problems.push(`${name} ${rule}`);
      return "";
    }
    return value;
  };

  // Endpoint: absolute URL; scheme enforcement (https, loopback http only)
  // is re-validated by the provider adapter at construction — fail closed there.
  const baseURL = requireField("LUMITHINK_REAL_PROVIDER_BASEURL", env.LUMITHINK_REAL_PROVIDER_BASEURL, "^https?://[^\\s]+$");
  if (baseURL !== "") {
    try {
      // eslint-disable-next-line no-new -- parseability check only
      new URL(baseURL);
    } catch {
      problems.push("LUMITHINK_REAL_PROVIDER_BASEURL must be an absolute URL");
    }
  }

  const modelId = requireField("LUMITHINK_REAL_PROVIDER_MODEL_ID", env.LUMITHINK_REAL_PROVIDER_MODEL_ID, "");
  if (modelId !== "" && !isGatewayId(modelId)) {
    problems.push("LUMITHINK_REAL_PROVIDER_MODEL_ID must match the gateway id grammar");
  }

  const reviewer = requireField("LUMITHINK_REAL_PROVIDER_REVIEWER", env.LUMITHINK_REAL_PROVIDER_REVIEWER, "");
  const reviewReason = requireField("LUMITHINK_REAL_PROVIDER_REVIEW_REASON", env.LUMITHINK_REAL_PROVIDER_REVIEW_REASON, "");

  const intField = (
    name: string,
    raw: string | undefined,
    min: number,
    max: number,
  ): number | null => {
    if (!isPositiveInt(raw, min, max)) {
      problems.push(`${name} must be an integer between ${min} and ${max} when LUMITHINK_MODEL_ROUTE=real`);
      return null;
    }
    return Number(raw);
  };

  const maxOutputTokens = intField("LUMITHINK_REAL_PROVIDER_MAX_OUTPUT_TOKENS", env.LUMITHINK_REAL_PROVIDER_MAX_OUTPUT_TOKENS, 1, MAX_OUTPUT_TOKENS_LIMIT);
  const inputPrice = intField("LUMITHINK_REAL_PROVIDER_INPUT_MICRO_USD_PER_MTOKEN", env.LUMITHINK_REAL_PROVIDER_INPUT_MICRO_USD_PER_MTOKEN, 1, 1_000_000_000);
  const outputPrice = intField("LUMITHINK_REAL_PROVIDER_OUTPUT_MICRO_USD_PER_MTOKEN", env.LUMITHINK_REAL_PROVIDER_OUTPUT_MICRO_USD_PER_MTOKEN, 1, 1_000_000_000);
  const maxRequests = intField("LUMITHINK_REAL_PROVIDER_MAX_REQUESTS_PER_DAY", env.LUMITHINK_REAL_PROVIDER_MAX_REQUESTS_PER_DAY, 1, 1_000_000_000);
  const maxCost = intField("LUMITHINK_REAL_PROVIDER_MAX_COST_MICRO_USD_PER_DAY", env.LUMITHINK_REAL_PROVIDER_MAX_COST_MICRO_USD_PER_DAY, 1, 1_000_000_000);
  const maxTokens = intField("LUMITHINK_REAL_PROVIDER_MAX_TOTAL_TOKENS_PER_DAY", env.LUMITHINK_REAL_PROVIDER_MAX_TOTAL_TOKENS_PER_DAY, 1, 1_000_000_000);
  const requestTimeoutMs = intField("LUMITHINK_REAL_PROVIDER_REQUEST_TIMEOUT_MS", env.LUMITHINK_REAL_PROVIDER_REQUEST_TIMEOUT_MS, 1, MAX_REQUEST_TIMEOUT_MS);
  const retryMaxAttempts = intField("LUMITHINK_REAL_PROVIDER_RETRY_MAX_ATTEMPTS", env.LUMITHINK_REAL_PROVIDER_RETRY_MAX_ATTEMPTS, 1, 5);
  const retryBackoffBaseMs = intField("LUMITHINK_REAL_PROVIDER_RETRY_BACKOFF_BASE_MS", env.LUMITHINK_REAL_PROVIDER_RETRY_BACKOFF_BASE_MS, 1, 60_000);
  const breakerThreshold = intField("LUMITHINK_REAL_PROVIDER_BREAKER_FAILURE_THRESHOLD", env.LUMITHINK_REAL_PROVIDER_BREAKER_FAILURE_THRESHOLD, 1, 100);
  const breakerCooldownMs = intField("LUMITHINK_REAL_PROVIDER_BREAKER_COOLDOWN_MS", env.LUMITHINK_REAL_PROVIDER_BREAKER_COOLDOWN_MS, 1, 3_600_000);

  if (problems.length > 0) {
    throw new RealProviderActivationError(problems);
  }

  return {
    mode: "real",
    record: Object.freeze({
      providerId: REAL_PROVIDER_ID,
      baseURL,
      modelId,
      maxOutputTokens: maxOutputTokens as number,
      pricing: Object.freeze({
        inputMicroUsdPerMillionTokens: inputPrice as number,
        outputMicroUsdPerMillionTokens: outputPrice as number,
      }),
      budget: Object.freeze({
        maxRequestsPerDay: maxRequests as number,
        maxCostMicroUsdPerDay: maxCost as number,
        maxTotalTokensPerDay: maxTokens as number,
      }),
      retry: Object.freeze({ maxAttempts: retryMaxAttempts as number, backoffBaseMs: retryBackoffBaseMs as number }),
      breaker: Object.freeze({ failureThreshold: breakerThreshold as number, cooldownMs: breakerCooldownMs as number }),
      requestTimeoutMs: requestTimeoutMs as number,
      dataEgressReview: Object.freeze({
        acknowledgeDataEgressReview: true,
        reviewer,
        reason: reviewReason,
      }),
    }),
  };
}

export interface RealProviderGateway {
  /** The composed gateway (budget/retry/breaker/timeout/cancel/audit enforced). */
  readonly gateway: ModelGateway;
  /** The registered `http_messages` provider (construction passed the review gate). */
  readonly provider: ModelProvider;
  /** The single model id served by this route. */
  readonly modelId: string;
  readonly providerId: typeof REAL_PROVIDER_ID;
}

/**
 * Compose the real-provider Model Gateway from an activation record. The
 * keySource resolves the credential from the env source AT REQUEST TIME —
 * the value never passes through this module's return surface, config views
 * or audit (the gateway redacts it structurally). `buildRealProviderGateway`
 * fails closed if the adapter's own construction gates reject the record.
 */
export function buildRealProviderGateway(
  record: RealProviderActivationRecord,
  env: EnvSource,
): RealProviderGateway {
  const provider = createHttpMessagesProvider({
    providerId: record.providerId,
    baseURL: record.baseURL,
    keySource: () => env.LUMITHINK_MODEL_PROVIDER_KEY ?? null,
    dataEgressReview: record.dataEgressReview,
  });
  const config = parseModelGatewayConfig({
    gatewayVersion: "1.0",
    models: [
      {
        modelId: record.modelId,
        providerId: record.providerId,
        maxOutputTokens: record.maxOutputTokens,
        pricing: {
          inputMicroUsdPerMillionTokens: record.pricing.inputMicroUsdPerMillionTokens,
          outputMicroUsdPerMillionTokens: record.pricing.outputMicroUsdPerMillionTokens,
        },
      },
    ],
    budget: { ...record.budget },
    retry: { ...record.retry },
    breaker: { ...record.breaker },
    requestTimeoutMs: record.requestTimeoutMs,
  });
  const gateway = createModelGateway(config, [provider]);
  return Object.freeze({
    gateway,
    provider,
    modelId: record.modelId,
    providerId: record.providerId,
  });
}
