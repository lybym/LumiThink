/**
 * R1-02 Model Gateway — in-process deterministic Mock provider
 * (docs/MODEL_GATEWAY.md §2, issue #14 AC: "Mock E2E").
 *
 * Conceptually reuses the R0 synthetic-model approach (poc/dsh-child keeps
 * its own HTTP-loopback mock for SDK evidence; the root project never depends
 * on poc). This provider is IN-PROCESS: no sockets, no egress, deterministic
 * output that never echoes submitted content (only structural facts), and a
 * scriptable failure-injection table used by the failure tests:
 *
 * - timeout / 429 / 5xx / invalid key / protocol violations / retry storms;
 * - caller cancellation observed between chunks (中止信号);
 * - streaming with configurable chunking and inter-chunk delay.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { ProviderFailure, type ProviderFailureClassification } from "./errors.ts";
import type { ModelProvider, ProviderKind } from "./provider.ts";
import type { ModelRequest, ModelUsage, ProviderStreamEvent } from "./types.ts";
import { ingestDomainFact } from "../legacy-guard.ts";

/** How the mock produces the assistant text (structural facts only). */
export interface MockReplyStyle {
  /** Prefix of the deterministic reply; default "MOCK-OK". */
  readonly prefix?: string;
  /** Emit the reply in this many deltas (default 2). */
  readonly chunkCount?: number;
  /** Delay before each chunk in ms (default 0). */
  readonly delayMsPerChunk?: number;
  /** Usage reported on completion (default 3/7). */
  readonly usage?: ModelUsage;
}

/**
 * Failure injection script. `classification` is thrown either on every call
 * (`times: "always"`) or for exactly N calls before normal behavior resumes.
 * `afterChunks` delays the failure until after N deltas were streamed (used
 * to prove the gateway never retries once output is visible).
 */
export interface MockFailureScript {
  readonly classification: ProviderFailureClassification;
  readonly times: number | "always";
  readonly afterChunks?: number;
}

export interface MockProviderScript {
  readonly reply?: MockReplyStyle;
  readonly failure?: MockFailureScript;
  /**
   * Protocol violation injection: emit an oversized delta (code points over
   * the contract per-delta cap) so the gateway's enforcement is exercised.
   */
  readonly oversizedDelta?: boolean;
  /** Protocol violation injection: complete with empty accumulated text. */
  readonly completeEmpty?: boolean;
  /** Protocol violation injection: omit the terminal completed event. */
  readonly omitCompleted?: boolean;
}

export interface MockProviderStats {
  readonly callCount: number;
  readonly observedCancels: number;
}

const DEFAULT_USAGE = Object.freeze({ inputTokens: 3, outputTokens: 7 });

/**
 * Abort-aware delay that works with injected or global timers. Uses only
 * globals (setTimeout / AbortSignal), never node builtin imports.
 */
function delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderFailure("cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderFailure("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createMockModelProvider(options: {
  readonly providerId: string;
  readonly script?: MockProviderScript;
}): ModelProvider & { stats(): MockProviderStats } {
  const script: MockProviderScript = options.script ?? {};
  const reply = script.reply ?? {};
  let callCount = 0;
  let observedCancels = 0;
  let failuresRemaining = script.failure === undefined ? 0 : script.failure.times === "always" ? Number.MAX_SAFE_INTEGER : script.failure.times;

  const provider: ModelProvider = {
    providerId: options.providerId,
    kind: "mock" satisfies ProviderKind,
    dataEgressAuthorized: true, // in-process: zero external egress by construction
    description: "in-process deterministic mock (no network, no egress)",
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
      callCount += 1;
      async function* generate(): AsyncGenerator<ProviderStreamEvent> {
        const failAfterChunks = script.failure?.afterChunks ?? 0;
        if (failuresRemaining > 0 && failAfterChunks === 0) {
          failuresRemaining -= 1;
          throw new ProviderFailure(script.failure?.classification ?? "unavailable");
        }
        const prefix = reply.prefix ?? "MOCK-OK";
        const text = `${prefix} messages=${request.messages.length} model=${request.modelId}`;
        const usage = reply.usage ?? DEFAULT_USAGE;
        if (script.completeEmpty === true) {
          // Protocol violation: completes with NO deltas at all, so the
          // accumulated text is empty (gateway must reject empty_output).
          yield { type: "completed", usage: ingest(usage) };
          return;
        }
        if (script.oversizedDelta === true) {
          yield { type: "delta", text: "x".repeat(2000) };
          yield { type: "completed", usage: ingest(usage) };
          return;
        }
        const chunkCount = Math.max(1, reply.chunkCount ?? 2);
        const base = Math.max(1, Math.floor(text.length / chunkCount));
        let emittedChunks = 0;
        let emitted = 0;
        for (let index = 0; index < chunkCount; index += 1) {
          await delayWithAbort(reply.delayMsPerChunk ?? 0, signal).catch((error: unknown) => {
            observedCancels += 1;
            throw error;
          });
          if (signal.aborted) {
            observedCancels += 1;
            throw new ProviderFailure("cancelled");
          }
          const start = emitted;
          const end = index === chunkCount - 1 ? text.length : Math.min(text.length, start + base);
          emitted = end;
          const chunk = text.slice(start, end);
          if (chunk.length > 0) {
            emittedChunks += 1;
            yield { type: "delta", text: chunk };
          }
          if (failuresRemaining > 0 && emittedChunks >= failAfterChunks) {
            failuresRemaining -= 1;
            throw new ProviderFailure(script.failure?.classification ?? "unavailable");
          }
        }
        if (script.omitCompleted === true) {
          return; // stream ends without a terminal event: protocol violation
        }
        yield { type: "completed", usage: ingest(usage) };
      }
      return generate();
    },
  };

  function ingest(usage: ModelUsage): ModelUsage {
    return ingestDomainFact(usage) as ModelUsage;
  }

  return Object.freeze({
    providerId: provider.providerId,
    kind: provider.kind,
    dataEgressAuthorized: provider.dataEgressAuthorized,
    description: provider.description,
    stream: provider.stream,
    registrationView: provider.registrationView,
    /**
     * Structural stats for tests/audit; no request content is ever exposed.
     */
    stats(): MockProviderStats {
      return { callCount, observedCancels };
    },
  }) as ModelProvider & { stats(): MockProviderStats };
}
