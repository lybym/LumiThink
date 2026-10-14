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
