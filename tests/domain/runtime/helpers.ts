/**
 * R1-03 runtime test helpers (synthetic data only — never real child data).
 *
 * Shared fixtures for tests/domain/runtime/*.spec.ts: contract-valid actor
 * contexts, interaction events, a recording ModelProvider stub and a
 * gateway factory. All ids use the contract grammar; all content is marked
 * synthetic and carries no real child information.
 */

import assert from "node:assert/strict";
import { createMockModelProvider, type MockFailureScript } from "../../../lib/domain/gateway/mock-provider.ts";
import {
  createModelGateway,
  type GatewayAuditEvent,
  type GatewayCompleteResult,
  type ModelGateway,
} from "../../../lib/domain/gateway/index.ts";
import type { ModelProvider, ProviderKind } from "../../../lib/domain/gateway/provider.ts";
import type { ModelRequest, ModelUsage, ProviderStreamEvent } from "../../../lib/domain/gateway/types.ts";
import { parseModelGatewayConfig, type ModelGatewayConfig } from "../../../lib/domain/gateway/config.ts";
import { ingestDomainFact } from "../../../lib/domain/legacy-guard.ts";

export const SYNTHETIC_ACTOR_ID = "act_demochild01";
export const SYNTHETIC_CHILD_REF = "chd_demo_001";
export const SYNTHETIC_CONVERSATION_A = "conv_r1t3aaa01";
export const SYNTHETIC_CONVERSATION_B = "conv_r1t3bbb01";
export const SYNTHETIC_SESSION_A = "ses_r1t3aaaa01";
export const SYNTHETIC_SESSION_B = "ses_r1t3bbbb01";

let counter = 0;
export function nextCounter(): number {
  counter += 1;
  return counter;
}

export function syntheticTimestamp(): string {
  return "2026-10-14T00:00:00Z";
}

export function syntheticActor(overrides: {
  readonly role?: "child" | "guardian" | "system" | "voice_device";
  readonly childRef?: string | null;
} = {}): Record<string, unknown> {
  return {
    role: overrides.role ?? "child",
    actorId: SYNTHETIC_ACTOR_ID,
    childRef: overrides.childRef === undefined ? SYNTHETIC_CHILD_REF : overrides.childRef,
    verifiedBy: "test-verifier",
    verifiedAt: syntheticTimestamp(),
  };
}

export interface SyntheticEventOptions {
  readonly conversationId: string;
  readonly turnId: string;
  readonly text: string;
  readonly actor?: Record<string, unknown>;
  readonly ingress?: "web" | "voice_adapter";
}

export function syntheticEvent(options: SyntheticEventOptions): Record<string, unknown> {
  const index = nextCounter();
  return {
    protocolVersion: "1.0",
    eventId: `evt_r1t3ev${String(index).padStart(6, "0")}`,
    kind: "text",
    conversationId: options.conversationId,
    turnId: options.turnId,
    requestId: `req_r1t3rq${String(index).padStart(6, "0")}`,
    traceId: `trc_r1t3tr${String(index).padStart(6, "0")}`,
    actor: options.actor ?? syntheticActor(),
    ingress: options.ingress ?? "web",
    text: {
      content: options.text,
      format: "plain",
      charCount: [...options.text].length,
    },
    occurredAt: syntheticTimestamp(),
  };
}

export function turnId(prefix: string): string {
  return `trn_${prefix}${String(nextCounter()).padStart(6, "0")}`;
}

// ---------------------------------------------------------------------------
// Recording provider stub (captures requests; deterministic streamed reply)
// ---------------------------------------------------------------------------

export interface RecordedRequest {
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly modelId: string;
  readonly maxOutputTokens: number | null;
  readonly timeoutMs: number;
}

export interface RecordingProvider extends ModelProvider {
  requests(): readonly RecordedRequest[];
  callCount(): number;
}

export function createRecordingProvider(options: {
  readonly providerId: string;
  readonly replyText: string;
}): RecordingProvider {
  const recorded: RecordedRequest[] = [];
  const provider: ModelProvider = {
    providerId: options.providerId,
    kind: "mock" satisfies ProviderKind,
    dataEgressAuthorized: true,
    description: "test recording provider (in-process, zero egress)",
    registrationView() {
      return {
        providerId: options.providerId,
        kind: "mock" as const,
        baseURL: null,
        hasKeySource: false,
        dataEgressReview: null,
      };
    },
    stream(
      request: Readonly<ModelRequest>,
      { signal }: { readonly signal: AbortSignal },
    ): AsyncIterable<ProviderStreamEvent> {
      recorded.push(
        ingestDomainFact({
          messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
          modelId: request.modelId,
          maxOutputTokens: request.maxOutputTokens,
          timeoutMs: request.timeoutMs,
        }) as unknown as RecordedRequest,
      );
      async function* generate(): AsyncGenerator<ProviderStreamEvent> {
        const usage: ModelUsage = { inputTokens: 5, outputTokens: 9 };
        const text = options.replyText;
        // Chunk at ≤500 UTF-16 units so even oversized replies respect the
        // gateway's per-delta contract cap (1000 code points).
        const chunkSize = 500;
        for (let start = 0; start < text.length; start += chunkSize) {
          if (signal.aborted) {
            throw new Error("aborted");
          }
          yield { type: "delta", text: text.slice(start, Math.min(text.length, start + chunkSize)) };
          await new Promise<void>((resolve, reject) => {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            setTimeout(resolve, 0);
          });
        }
        if (signal.aborted) {
          throw new Error("aborted");
        }
        yield { type: "completed", usage };
      }
      return generate();
    },
  };
  return Object.freeze({
    providerId: provider.providerId,
    kind: provider.kind,
    dataEgressAuthorized: provider.dataEgressAuthorized,
    description: provider.description,
    stream: provider.stream,
    registrationView: provider.registrationView,
    requests(): readonly RecordedRequest[] {
      return Object.freeze([...recorded]);
    },
    callCount(): number {
      return recorded.length;
    },
  }) as RecordingProvider;
}

// ---------------------------------------------------------------------------
// Gateway factory
// ---------------------------------------------------------------------------

export interface TestGatewayOptions {
  readonly provider: ModelProvider;
  /** Model registration ceiling; defaults to 256. */
  readonly maxOutputTokens?: number;
  /** Config-level default per-attempt timeout; defaults to 30000. */
  readonly requestTimeoutMs?: number;
  /** Registered model ids (default: ["mock-model"]); [] registers none. */
  readonly modelIds?: readonly string[];
  readonly retryMaxAttempts?: number;
  readonly backoffBaseMs?: number;
}

export function testGatewayConfig(options: TestGatewayOptions): Readonly<ModelGatewayConfig> {
  return parseModelGatewayConfig({
    gatewayVersion: "1.0",
    models: (options.modelIds ?? ["mock-model"]).map((modelId) => ({
      modelId,
      providerId: options.provider.providerId,
      maxOutputTokens: options.maxOutputTokens ?? 256,
      pricing: null,
    })),
    budget: {
      maxRequestsPerDay: 1000,
      maxCostMicroUsdPerDay: 1_000_000,
      maxTotalTokensPerDay: 1_000_000,
    },
    retry: {
      maxAttempts: options.retryMaxAttempts ?? 2,
      backoffBaseMs: options.backoffBaseMs ?? 1,
    },
    breaker: {
      failureThreshold: 10,
      cooldownMs: 1000,
    },
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
  });
}

export function createTestGateway(options: TestGatewayOptions): ModelGateway {
  return createModelGateway(testGatewayConfig(options), [options.provider]);
}

export function mockProvider(
  options:
    | string
    | { readonly providerId?: string; readonly failure?: MockFailureScript } = {},
): ReturnType<typeof createMockModelProvider> {
  const providerId = typeof options === "string" ? options : (options.providerId ?? "mock");
  const script =
    typeof options === "string" || options.failure === undefined ? undefined : { failure: options.failure };
  return createMockModelProvider({ providerId, script });
}

export { assert };

export type { GatewayAuditEvent, GatewayCompleteResult, ModelGateway };
