/**
 * R1-02 Model Gateway — provider contract (docs/MODEL_GATEWAY.md §2,
 * docs/HARNESS.md §3, PRD FR-004 "可替换至少一种模型实现或使用 Mock").
 *
 * A provider turns a validated ModelRequest into a stream of text deltas
 * followed by exactly one completed event carrying usage. Providers own
 * transport concerns (HTTP, wire protocol) but MUST:
 * - throw only ProviderFailure (static classification) or propagate the
 *   caller's abort — never raw provider error bodies with payload text;
 * - honor `options.signal` for both caller cancellation and attempt timeout;
 * - never embed a default endpoint: the real provider adapter requires an
 *   explicit baseURL + key source + data-egress review acknowledgement
 *   (issue #14: 未配置 Provider/密钥时 fail-closed).
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { ProviderFailure, type ProviderFailureClassification } from "./errors.ts";
import type { ModelRequest, ProviderStreamEvent } from "./types.ts";

export const PROVIDER_KINDS = ["mock", "http_messages"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * Value-free metadata a provider discloses for the auditable config view.
 * Key callbacks and credential material are structurally excluded: only the
 * presence flag `hasKeySource` is reported, and `baseURL` is reduced to its
 * origin by describeGatewayConfig (config.ts).
 */
export interface ProviderRegistrationView {
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly baseURL: string | null;
  readonly hasKeySource: boolean;
  readonly dataEgressReview: Readonly<{ reviewer: string; reason: string }> | null;
}

export interface ModelProvider {
  readonly providerId: string;
  readonly kind: ProviderKind;
  /**
   * True only when the provider's data path has an explicit authorization
   * record. The in-process mock has no external egress at all; the HTTP
   * adapter requires the explicit data-egress review acknowledgement.
   */
  readonly dataEgressAuthorized: boolean;
  /** Human-readable, value-free description for the audit config view. */
  readonly description: string;
  stream(
    request: Readonly<ModelRequest>,
    options: { readonly signal: AbortSignal },
  ): AsyncIterable<ProviderStreamEvent>;
  /** Disclose the registration metadata for the config view. */
  registrationView(): ProviderRegistrationView;
}

/**
 * Helper for provider adapters: wrap an unknown thrown value into a
 * ProviderFailure so no foreign error message can escape the provider
 * boundary (the original message is deliberately discarded, not stored).
 */
export function asProviderFailure(
  error: unknown,
  fallback: ProviderFailureClassification = "unavailable",
): ProviderFailure {
  if (error instanceof ProviderFailure) {
    return error;
  }
  return new ProviderFailure(fallback);
}
