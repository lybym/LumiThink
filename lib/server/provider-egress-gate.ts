/**
 * R1-06 server-side provider egress gate + vendor request counter
 * (issue #18 AC: 禁用第三方数据外发后供应商请求数为 0).
 *
 * A ModelProvider decorator consulted by the R1-02 model gateway:
 * - `dataEgressAuthorized` becomes a DYNAMIC getter driven by the guardian
 *   feature switch (lib/domain/guardian/permissions.ts
 *   providerEgressAuthorized): with third-party egress disabled, a
 *   third-party-classified provider reports unauthorized and the gateway's
 *   existing fail-closed gate refuses the call BEFORE any transport is
 *   touched — the vendor request count stays 0 by construction, not by
 *   observation;
 * - every `stream()` invocation (a vendor request attempt) is counted per
 *   provider, so the guardian status surface can report the actual request
 *   counts (状态核对) instead of an assumption.
 *
 * The decorated provider is otherwise untouched: deltas, cancellation,
 * failure classification and registration metadata pass through.
 *
 * This module stays framework-free (no next/react/prisma imports); it lives
 * in lib/server because it composes the guardian switch state (serving
 * configuration) with a domain provider — the domain gateway itself must
 * not depend on guardian state.
 */

import type { ModelProvider } from "../domain/gateway/provider.ts";
import type { GuardianEgressStatus } from "../domain/guardian/authorizations.ts";
import type { ProviderEgressClass } from "../domain/guardian/permissions.ts";
import { providerEgressAuthorized } from "../domain/guardian/permissions.ts";
import type { ModelRequest, ProviderStreamEvent } from "../domain/gateway/types.ts";

export interface ProviderEgressGateOptions {
  readonly provider: ModelProvider;
  /** How this provider's data path is classified (server-owned decision). */
  readonly classification: ProviderEgressClass;
  /** Live guardian switch state (third_party_data_egress). */
  readonly isThirdPartyEgressEnabled: () => boolean;
}

export interface EgressGatedProvider extends ModelProvider {
  /** Vendor request attempts actually passed to the inner provider. */
  requestCount(): number;
}

export function gateProviderEgress(options: ProviderEgressGateOptions): EgressGatedProvider {
  const inner = options.provider;
  let requests = 0;
  return Object.freeze({
    providerId: inner.providerId,
    kind: inner.kind,
    // Dynamic gate: evaluated on EVERY gateway admission check, so a
    // guardian revocation takes effect for subsequent calls immediately.
    get dataEgressAuthorized(): boolean {
      return providerEgressAuthorized(
        options.classification,
        inner.dataEgressAuthorized === true,
        options.isThirdPartyEgressEnabled(),
      );
    },
    description: inner.description,
    stream(
      request: Readonly<ModelRequest>,
      streamOptions: { readonly signal: AbortSignal },
    ): AsyncIterable<ProviderStreamEvent> {
      requests += 1;
      return inner.stream(request, streamOptions);
    },
    registrationView: () => inner.registrationView(),
    requestCount: () => requests,
  }) as EgressGatedProvider;
}

// ---------------------------------------------------------------------------
// Egress status aggregation (guardian 状态核对 feed)
// ---------------------------------------------------------------------------

/** One egress-gated provider registration observed by the status feed. */
export interface ProviderEgressRegistration {
  readonly providerId: string;
  readonly classification: ProviderEgressClass;
  /** Live vendor request counter of the gated provider (read per call). */
  readonly requestCount: () => number;
}

/**
 * Aggregate the guardian egress status from the REAL registered gated
 * providers: per-provider counts for every registration, and the
 * third-party count as the sum over `third_party_api`-classified
 * registrations only. The sum over an (currently empty) third-party set is
 * 0 by AGGREGATION, never by constant — registering a third-party provider
 * updates the status feed without touching the wiring. Counters are read
 * dynamically, so every status snapshot reflects the live state.
 */
export function buildProviderEgressStatus(
  registrations: readonly ProviderEgressRegistration[],
): GuardianEgressStatus {
  const providerRequestCounts: Record<string, number> = {};
  let thirdPartyProviderRequestCount = 0;
  for (const registration of registrations) {
    const count = registration.requestCount();
    providerRequestCounts[registration.providerId] = count;
    if (registration.classification === "third_party_api") {
      thirdPartyProviderRequestCount += count;
    }
  }
  return Object.freeze({
    providerRequestCounts: Object.freeze(providerRequestCounts),
    thirdPartyProviderRequestCount,
  });
}
