/**
 * R1-02 Model Gateway — public entry (docs/MODEL_GATEWAY.md, issue #14).
 *
 * Exposes the smallest complete gateway surface:
 * - createModelGateway: orchestration (fail-closed config, budget, breaker,
 *   timeout/cancel, bounded retries, audit, NO provider failover);
 * - createMockModelProvider: the CI/default provider (in-process, zero egress);
 * - createHttpMessagesProvider: the real-provider adapter, shipped DISABLED
 *   BY DEFAULT behind an explicit baseURL + key source + data-egress review
 *   acknowledgement (the independent review required by issue #14 has not
 *   happened yet — no production configuration may enable real egress today).
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

export {
  GATEWAY_PROTOCOL_VERSION,
  AUDIT_UNVERIFIED_ID,
  createModelGateway,
  type GatewayAuditEvent,
  type GatewayCompleteResult,
  type GatewayStreamItem,
  type ModelGateway,
} from "./gateway.ts";
export {
  GATEWAY_ERROR_CODES,
  GATEWAY_ERROR_REGISTRY,
  GATEWAY_OUTCOMES,
  GATEWAY_TO_CONTRACT_ERROR_CODE,
  GatewayError,
  ProviderFailure,
  describeGatewayError,
  gatewayCodeForClassification,
  isAvailabilityFailure,
  type GatewayErrorDetail,
  type GatewayErrorCode,
  type GatewayErrorMetadata,
  type GatewayOutcome,
  type ProviderFailureClassification,
} from "./errors.ts";
export {
  parseModelGatewayConfig,
  describeGatewayConfig,
  buildGatewayRegistry,
  lookupGatewayRegistry,
  type BreakerConfig,
  type DailyBudgetConfig,
  type DataEgressReviewAcknowledgement,
  type GatewayConfigView,
  type ModelGatewayConfig,
  type ModelPricing,
  type ModelRegistration,
  type ProviderConfigView,
  type ProviderRegistrationView,
  type RetryConfig,
} from "./config.ts";
export {
  PROVIDER_KINDS,
  asProviderFailure,
  type ModelProvider,
  type ProviderKind,
} from "./provider.ts";
export {
  createMockModelProvider,
  type MockFailureScript,
  type MockProviderScript,
  type MockProviderStats,
  type MockReplyStyle,
} from "./mock-provider.ts";
export {
  createHttpMessagesProvider,
  type HttpMessagesProviderConfig,
  type HttpTransport,
} from "./http-provider.ts";
export {
  BREAKER_STATES,
  computeCostMicroUsd,
  createCircuitBreaker,
  createInMemoryUsageLedger,
  dayKeyOf,
  evaluateDailyBudget,
  type BreakerState,
  type CircuitBreaker,
  type BudgetDecision,
  type UsageLedger,
  type UsageSnapshot,
} from "./budget.ts";
export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_MODEL_MESSAGE_CHARS,
  MAX_MODEL_REQUEST_MESSAGES,
  MAX_MODEL_REQUEST_TOOLS,
  MAX_OUTPUT_TOKENS_LIMIT,
  MAX_REQUEST_TIMEOUT_MS,
  MODEL_MESSAGE_ROLES,
  parseModelRequest,
  validateProviderDelta,
  type ModelMessage,
  type ModelMessageRole,
  type ModelRequest,
  type ModelToolDeclaration,
  type ModelUsage,
  type ProviderCompleted,
  type ProviderDelta,
  type ProviderStreamEvent,
} from "./types.ts";
