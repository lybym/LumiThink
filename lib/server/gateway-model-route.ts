/**
 * E2E-08 (issue #58) — operator opt-in REAL-model route for the Voice Gateway
 * host.
 *
 * The E2E-07/E2E-08 wiring gate boots the gateway host with the REAL locked-
 * version DSH worker (LUMITHINK_GATEWAY_AGENT=real) whose model route is the
 * local synthetic Messages mock. The REAL DEVICE loop (runbook §11) needs the
 * same worker served by the REVIEWED real provider instead of the synthetic
 * mock — WITHOUT ever handing the vendor credential to the worker child.
 *
 * This module composes the already-reviewed E2E-03 surfaces into that route:
 *
 *   LUMITHINK_MODEL_ROUTE=real + the full LUMITHINK_REAL_PROVIDER_* record
 *     → parseRealProviderActivation (fail-closed, variable NAMES only)
 *     → buildRealProviderGateway (Model Gateway: budget/retry/breaker/
 *       timeout/cancel/audit/single-provider; keySource resolves
 *       LUMITHINK_MODEL_PROVIDER_KEY at REQUEST time, never at parse)
 *     → createGatewayEgressProxy (loopback Messages endpoint for the worker)
 *     → workerEnv.DSH_BRIDGE_MODEL_BASE_URL = the loopback proxy URL
 *
 * The pinned bridge worker profile (poc/dsh-child/profiles/
 * lumi-dsh-runtime-bridge/cordis.patch.yml) routes
 * `$DSH_BRIDGE_MODEL_BASE_URL ?? $DSH_POC_MOCK_BASE_URL ?? discard`, so the
 * workerEnv entry here is the ONLY thing that flips the model route; when
 * this module returns `mock` the host keeps the exact E2E-07 behavior.
 *
 * PRIVACY / FAIL-CLOSED (inherited, not re-implemented):
 *  - the vendor credential never enters the child env, the audit, or any
 *    view (the child keeps its pinned synthetic placeholder key);
 *  - an incomplete/malformed record fails closed BEFORE any listener exists,
 *    reporting variable NAMES only;
 *  - the proxy binds loopback only and serves only the registered model id.
 *
 * This module is deployment tooling (the gateway host launcher), NOT the main
 * app composition root: the web MVP runtime stays mock-only by design
 * (issue #53 review r1 P2-3, real-provider-composition.spec.ts).
 */

import {
  parseRealProviderActivation,
  buildRealProviderGateway,
  type EnvSource,
} from "./real-provider-composition.ts";
import { createGatewayEgressProxy, type GatewayEgressProxy } from "./gateway-egress-proxy.ts";

export interface GatewayModelRoute {
  /** `mock` = the E2E-07 synthetic route (no proxy, no workerEnv override). */
  readonly mode: "mock" | "real";
  /** Real mode only: loopback base URL the worker must use. */
  readonly modelBaseUrl: string | null;
  /**
   * Real mode only: extra child env entries (the pinned profile prefers
   * DSH_BRIDGE_MODEL_BASE_URL over the synthetic mock).
   */
  readonly workerEnv: Readonly<Record<string, string>>;
  /** Real mode only: the routing label pinned by the activation record. */
  readonly providerId: string | null;
  /** Real mode only: the single registered model id (worker env DSH_BRIDGE_MODEL). */
  readonly modelId: string | null;
  /** Real mode only: the loopback proxy (stats surface for diagnostics). */
  readonly proxy: GatewayEgressProxy | null;
  /** Idempotent teardown (no-op in mock mode). */
  stop(): Promise<void>;
}

/**
 * Compose the model route from `env`. Mock unless the env carries the full
 * real activation record; any activation failure propagates fail-closed.
 */
export async function createGatewayModelRoute(env: EnvSource): Promise<GatewayModelRoute> {
  const activation = parseRealProviderActivation(env);
  if (activation.mode === "mock") {
    return Object.freeze({
      mode: "mock" as const,
      modelBaseUrl: null,
      workerEnv: Object.freeze({}) as Readonly<Record<string, string>>,
      providerId: null,
      modelId: null,
      proxy: null,
      async stop(): Promise<void> {
        /* mock route owns no listener */
      },
    });
  }
  const record = activation.record;
  const { gateway, modelId, providerId } = buildRealProviderGateway(record, env);
  const proxy = createGatewayEgressProxy({ gateway, allowedModelIds: [modelId] });
  const started = await proxy.start();
  return Object.freeze({
    mode: "real" as const,
    modelBaseUrl: started.url,
    workerEnv: Object.freeze({ DSH_BRIDGE_MODEL_BASE_URL: started.url }),
    providerId,
    modelId,
    proxy,
    stop(): Promise<void> {
      return proxy.stop();
    },
  });
}
