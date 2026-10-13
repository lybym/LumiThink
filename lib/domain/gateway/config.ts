/**
 * R1-02 Model Gateway — auditable configuration and model registry
 * (docs/MODEL_GATEWAY.md §3, issue #14: "Provider 接口、模型注册与可审查的配置").
 *
 * Fail-closed principles encoded here:
 * - There is NO default provider, NO default baseURL and NO default key
 *   anywhere in this module. An empty configuration yields a gateway that
 *   rejects every request with GATEWAY_NO_PROVIDER before any transport
 *   exists (issue #14 AC: 未配置 Provider/密钥时 fail-closed，不意外外发).
 * - Registering an external (`http_messages`) provider REQUIRES an explicit
 *   baseURL, a key source callback and a data-egress review acknowledgement
 *   — the same explicit opt-in idiom as the R1-00 legacy migration
 *   acknowledgement. Until the independent data-export review exists, no
 *   production configuration can enable real egress (issue #14: 先 Mock，
 *   真实供应商须经独立数据外发评审).
 * - Registry lookups use `Object.hasOwn` on null-prototype maps only
 *   (repo-wide lesson from the R1-15/R1-13 reviews).
 * - `describeGatewayConfig` produces the reviewable/auditable view: origin
 *   only for baseURL, boolean presence for key sources, never key material.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { type ContractProblem, ContractValidationError, problem } from "../contract/core.ts";
import { ingestDomainFact } from "../legacy-guard.ts";
import { isGatewayId, MAX_OUTPUT_TOKENS_LIMIT, MAX_REQUEST_TIMEOUT_MS } from "./types.ts";
import { PROVIDER_KINDS, type ProviderKind, type ProviderRegistrationView } from "./provider.ts";

// ---------------------------------------------------------------------------
// Data-egress review acknowledgement (real-provider activation gate)
// ---------------------------------------------------------------------------

/**
 * Explicit, auditable opt-in required to register an external provider.
 * Modeled after the legacy migration acknowledgement (lib/domain/
 * legacy-guard.ts): the flag must be literally `true` so the gate cannot be
 * satisfied by a truthy placeholder.
 */
export interface DataEgressReviewAcknowledgement {
  /** Must be literally `true` — forces an explicit, reviewed opt-in. */
  readonly acknowledgeDataEgressReview: true;
  /** Person or body that performed the independent data-export review. */
  readonly reviewer: string;
  /** Where/why the review happened (no credentials, no child data). */
  readonly reason: string;
}

function isDataEgressAcknowledgement(value: unknown): value is DataEgressReviewAcknowledgement {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.acknowledgeDataEgressReview === true &&
    typeof record.reviewer === "string" &&
    record.reviewer.trim().length > 0 &&
    typeof record.reason === "string" &&
    record.reason.trim().length > 0
  );
}

// ---------------------------------------------------------------------------
// Configuration shapes
// ---------------------------------------------------------------------------

export interface ModelPricing {
  /** Micro-USD per million input tokens (integer math only). */
  readonly inputMicroUsdPerMillionTokens: number;
  /** Micro-USD per million output tokens (integer math only). */
  readonly outputMicroUsdPerMillionTokens: number;
}

export interface ModelRegistration {
  readonly modelId: string;
  /** The single provider that serves this model. NO automatic failover. */
  readonly providerId: string;
  readonly maxOutputTokens: number;
  readonly pricing: ModelPricing | null;
}

export interface DailyBudgetConfig {
  /** Max provider requests per UTC day. */
  readonly maxRequestsPerDay: number;
  /** Max accumulated cost in micro-USD per UTC day. */
  readonly maxCostMicroUsdPerDay: number;
  /** Max accumulated total tokens (input+output) per UTC day. */
  readonly maxTotalTokensPerDay: number;
}

export interface RetryConfig {
  /** Total attempts per request (1 = no retry). Hard cap 5. */
  readonly maxAttempts: number;
  /** Base backoff in ms before the 2nd..nth attempt (exponential: base*2^k). */
  readonly backoffBaseMs: number;
}

export interface BreakerConfig {
  /** Consecutive availability failures before the breaker opens. */
  readonly failureThreshold: number;
  /** Open-state cooldown in ms before a single half-open probe is allowed. */
  readonly cooldownMs: number;
}

export interface ModelGatewayConfig {
  readonly gatewayVersion: "1.0";
  readonly models: readonly ModelRegistration[];
  readonly budget: DailyBudgetConfig;
  readonly retry: RetryConfig;
  readonly breaker: BreakerConfig;
  /** Default per-attempt timeout when a request does not carry one. */
  readonly requestTimeoutMs: number;
}

const MAX_MODELS = 64;
const MAX_BUDGET_VALUE = 1_000_000_000;

function isPositiveInt(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max;
}

function parsePricing(
  value: unknown,
  path: string,
  problems: ContractProblem[],
): ModelPricing | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", path, "pricing must be an object when present."));
    return null;
  }
  const record = value as Record<string, unknown>;
  let input: number | null = null;
  let output: number | null = null;
  if (!isPositiveInt(record.inputMicroUsdPerMillionTokens, MAX_BUDGET_VALUE)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", `${path}.inputMicroUsdPerMillionTokens`, "must be a positive integer."),
    );
  } else {
    input = record.inputMicroUsdPerMillionTokens;
  }
  if (!isPositiveInt(record.outputMicroUsdPerMillionTokens, MAX_BUDGET_VALUE)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", `${path}.outputMicroUsdPerMillionTokens`, "must be a positive integer."),
    );
  } else {
    output = record.outputMicroUsdPerMillionTokens;
  }
  for (const key of Object.keys(record)) {
    if (key !== "inputMicroUsdPerMillionTokens" && key !== "outputMicroUsdPerMillionTokens") {
      problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.${key}`, "pricing carries an unknown field."));
    }
  }
  return input !== null && output !== null ? { inputMicroUsdPerMillionTokens: input, outputMicroUsdPerMillionTokens: output } : null;
}

/**
 * Parse the gateway configuration fail-closed. Unknown fields are rejected;
 * integer fields are range-checked; model ids/provider ids must match the
 * gateway grammar. Duplicate model ids are rejected (one model, one owner).
 */
export function parseModelGatewayConfig(value: unknown): Readonly<ModelGatewayConfig> {
  const problems: ContractProblem[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "gatewayConfig", "gatewayConfig must be an object."),
    ]);
  }
  const record = value as Record<string, unknown>;
  if (record.gatewayVersion !== "1.0") {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "gatewayVersion", 'gatewayVersion must be "1.0".'),
    );
  }

  let models: ModelRegistration[] = [];
  if (!Array.isArray(record.models)) {
    problems.push(problem("CONTRACT_FIELD_MISSING", "models", "models must be an array (may be empty)."));
  } else if (record.models.length > MAX_MODELS) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "models", `models exceeds the ${MAX_MODELS} registration limit.`),
    );
  } else {
    const seen = new Set<string>();
    const parsedModels: ModelRegistration[] = [];
    record.models.forEach((item, index) => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) {
        problems.push(problem("CONTRACT_FIELD_INVALID", `models[${index}]`, "model registration must be an object."));
        return;
      }
      const entry = item as Record<string, unknown>;
      if (!isGatewayId(entry.modelId)) {
        problems.push(
          problem("CONTRACT_FIELD_INVALID", `models[${index}].modelId`, "modelId must match the gateway id grammar."),
        );
      } else if (seen.has(entry.modelId)) {
        problems.push(
          problem("CONTRACT_FIELD_INVALID", `models[${index}].modelId`, "duplicate modelId registration."),
        );
      } else {
        seen.add(entry.modelId);
      }
      if (!isGatewayId(entry.providerId)) {
        problems.push(
          problem("CONTRACT_FIELD_INVALID", `models[${index}].providerId`, "providerId must match the gateway id grammar."),
        );
      }
      if (!isPositiveInt(entry.maxOutputTokens, MAX_OUTPUT_TOKENS_LIMIT)) {
        problems.push(
          problem(
            "CONTRACT_FIELD_INVALID",
            `models[${index}].maxOutputTokens`,
            `maxOutputTokens must be an integer between 1 and ${MAX_OUTPUT_TOKENS_LIMIT}.`,
          ),
        );
      }
      const pricing = parsePricing(entry.pricing, `models[${index}].pricing`, problems);
      for (const key of Object.keys(entry)) {
        if (!["modelId", "providerId", "maxOutputTokens", "pricing"].includes(key)) {
          problems.push(
            problem("CONTRACT_FIELD_INVALID", `models[${index}].${key}`, "model registration carries an unknown field."),
          );
        }
      }
      if (
        isGatewayId(entry.modelId) &&
        isGatewayId(entry.providerId) &&
        isPositiveInt(entry.maxOutputTokens, MAX_OUTPUT_TOKENS_LIMIT)
      ) {
        parsedModels.push({
          modelId: entry.modelId,
          providerId: entry.providerId,
          maxOutputTokens: entry.maxOutputTokens,
          pricing,
        });
      }
    });
    models = parsedModels;
  }

  let budget: DailyBudgetConfig | null = null;
  if (record.budget === null || typeof record.budget !== "object" || Array.isArray(record.budget)) {
    problems.push(
      problem("CONTRACT_FIELD_MISSING", "budget", "budget is required (explicit daily limits; no implicit unlimited)."),
    );
  } else {
    const b = record.budget as Record<string, unknown>;
    const fields: Array<{ key: string; value: unknown }> = [
      { key: "maxRequestsPerDay", value: b.maxRequestsPerDay },
      { key: "maxCostMicroUsdPerDay", value: b.maxCostMicroUsdPerDay },
      { key: "maxTotalTokensPerDay", value: b.maxTotalTokensPerDay },
    ];
    const values: number[] = [];
    for (const { key, value: fieldValue } of fields) {
      if (!isPositiveInt(fieldValue, MAX_BUDGET_VALUE)) {
        problems.push(
          problem("CONTRACT_FIELD_INVALID", `budget.${key}`, "must be a positive integer (explicit budget required)."),
        );
        values.push(0);
      } else {
        values.push(fieldValue);
      }
    }
    for (const key of Object.keys(b)) {
      if (!["maxRequestsPerDay", "maxCostMicroUsdPerDay", "maxTotalTokensPerDay"].includes(key)) {
        problems.push(problem("CONTRACT_FIELD_INVALID", `budget.${key}`, "budget carries an unknown field."));
      }
    }
    if (values.every((v) => v > 0)) {
      budget = {
        maxRequestsPerDay: values[0],
        maxCostMicroUsdPerDay: values[1],
        maxTotalTokensPerDay: values[2],
      };
    }
  }

  let retry: RetryConfig | null = null;
  if (record.retry === null || typeof record.retry !== "object" || Array.isArray(record.retry)) {
    problems.push(problem("CONTRACT_FIELD_MISSING", "retry", "retry is required (explicit max attempts)."));
  } else {
    const r = record.retry as Record<string, unknown>;
    if (!isPositiveInt(r.maxAttempts, 5)) {
      problems.push(problem("CONTRACT_FIELD_INVALID", "retry.maxAttempts", "must be an integer between 1 and 5."));
    }
    if (!isPositiveInt(r.backoffBaseMs, 60_000)) {
      problems.push(problem("CONTRACT_FIELD_INVALID", "retry.backoffBaseMs", "must be an integer between 1 and 60000."));
    }
    for (const key of Object.keys(r)) {
      if (!["maxAttempts", "backoffBaseMs"].includes(key)) {
        problems.push(problem("CONTRACT_FIELD_INVALID", `retry.${key}`, "retry carries an unknown field."));
      }
    }
    if (isPositiveInt(r.maxAttempts, 5) && isPositiveInt(r.backoffBaseMs, 60_000)) {
      retry = { maxAttempts: r.maxAttempts, backoffBaseMs: r.backoffBaseMs };
    }
  }

  let breaker: BreakerConfig | null = null;
  if (record.breaker === null || typeof record.breaker !== "object" || Array.isArray(record.breaker)) {
    problems.push(problem("CONTRACT_FIELD_MISSING", "breaker", "breaker is required (explicit thresholds)."));
  } else {
    const br = record.breaker as Record<string, unknown>;
    if (!isPositiveInt(br.failureThreshold, 100)) {
      problems.push(problem("CONTRACT_FIELD_INVALID", "breaker.failureThreshold", "must be an integer between 1 and 100."));
    }
    if (!isPositiveInt(br.cooldownMs, 3_600_000)) {
      problems.push(problem("CONTRACT_FIELD_INVALID", "breaker.cooldownMs", "must be an integer between 1 and 3600000."));
    }
    for (const key of Object.keys(br)) {
      if (!["failureThreshold", "cooldownMs"].includes(key)) {
        problems.push(problem("CONTRACT_FIELD_INVALID", `breaker.${key}`, "breaker carries an unknown field."));
      }
    }
    if (isPositiveInt(br.failureThreshold, 100) && isPositiveInt(br.cooldownMs, 3_600_000)) {
      breaker = { failureThreshold: br.failureThreshold, cooldownMs: br.cooldownMs };
    }
  }

  if (!isPositiveInt(record.requestTimeoutMs, MAX_REQUEST_TIMEOUT_MS)) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "requestTimeoutMs",
        `requestTimeoutMs must be an integer between 1 and ${MAX_REQUEST_TIMEOUT_MS}.`,
      ),
    );
  }

  for (const key of Object.keys(record)) {
    if (!["gatewayVersion", "models", "budget", "retry", "breaker", "requestTimeoutMs"].includes(key)) {
      problems.push(problem("CONTRACT_FIELD_INVALID", key, "gatewayConfig carries an unknown field."));
    }
  }

  if (
    problems.length > 0 ||
    budget === null ||
    retry === null ||
    breaker === null ||
    !isPositiveInt(record.requestTimeoutMs, MAX_REQUEST_TIMEOUT_MS)
  ) {
    throw new ContractValidationError(problems.length > 0 ? problems : [
      problem("CONTRACT_FIELD_INVALID", "gatewayConfig", "gatewayConfig is incomplete."),
    ]);
  }

  return ingestDomainFact({
    gatewayVersion: "1.0",
    models,
    budget: budget as DailyBudgetConfig,
    retry: retry as RetryConfig,
    breaker: breaker as BreakerConfig,
    requestTimeoutMs: record.requestTimeoutMs,
  }) as Readonly<ModelGatewayConfig>;
}

// ---------------------------------------------------------------------------
// Redacted, reviewable config view (audit surface)
// ---------------------------------------------------------------------------

export interface ProviderConfigView {
  readonly providerId: string;
  readonly kind: ProviderKind;
  /** Origin only (protocol + host + port); path/query never included. */
  readonly baseURLOrigin: string | null;
  /** Presence flag only — key material is structurally excluded. */
  readonly hasKeySource: boolean;
  readonly dataEgressReview: { readonly reviewer: string; readonly reason: string } | "absent";
}

export interface GatewayConfigView {
  readonly gatewayVersion: "1.0";
  readonly models: readonly ModelRegistration[];
  readonly providers: readonly ProviderConfigView[];
  readonly budget: DailyBudgetConfig;
  readonly retry: RetryConfig;
  readonly breaker: BreakerConfig;
  readonly requestTimeoutMs: number;
}

function originOf(baseURL: string): string | null {
  try {
    return new URL(baseURL).origin;
  } catch {
    return null;
  }
}

/**
 * Build the auditable config view. Provider metadata comes from the live
 * provider instances plus their registration records; key callbacks and
 * credential material are structurally excluded (presence flags only).
 */
export function describeGatewayConfig(
  config: Readonly<ModelGatewayConfig>,
  providerRegistrations: readonly ProviderRegistrationView[],
): Readonly<GatewayConfigView> {
  return ingestDomainFact({
    gatewayVersion: config.gatewayVersion,
    models: config.models,
    providers: providerRegistrations.map((registration) => ({
      providerId: registration.providerId,
      kind: registration.kind,
      baseURLOrigin: registration.baseURL === null ? null : originOf(registration.baseURL),
      hasKeySource: registration.hasKeySource,
      dataEgressReview: registration.dataEgressReview === null
        ? "absent"
        : {
            reviewer: registration.dataEgressReview.reviewer,
            reason: registration.dataEgressReview.reason,
          },
    })),
    budget: config.budget,
    retry: config.retry,
    breaker: config.breaker,
    requestTimeoutMs: config.requestTimeoutMs,
  }) as Readonly<GatewayConfigView>;
}

/** Re-exported from provider.ts; the config view consumes these records. */
export type { ProviderRegistrationView } from "./provider.ts";

// ---------------------------------------------------------------------------
// Registry helpers (null-prototype + Object.hasOwn only)
// ---------------------------------------------------------------------------

/** Build a null-prototype lookup map; duplicate keys fail closed. */
export function buildGatewayRegistry<T extends { readonly key: string }>(
  entries: readonly T[],
  path: string,
): Readonly<Record<string, T>> {
  const map: Record<string, T> = Object.create(null);
  for (const entry of entries) {
    if (Object.hasOwn(map, entry.key)) {
      throw new ContractValidationError([
        problem("CONTRACT_FIELD_INVALID", path, `duplicate registry key; the submitted value is not echoed.`),
      ]);
    }
    map[entry.key] = entry;
  }
  return Object.freeze(map);
}

export function lookupGatewayRegistry<T>(
  registry: Readonly<Record<string, T>>,
  key: string,
): T | null {
  return Object.hasOwn(registry, key) ? registry[key] : null;
}
