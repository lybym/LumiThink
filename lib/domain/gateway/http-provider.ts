/**
 * R1-02 Model Gateway — real provider adapter (`http_messages` kind)
 * (docs/MODEL_GATEWAY.md §2/§7, issue #14).
 *
 * Wire shape: DeepSeek/Anthropic-compatible Messages protocol over HTTPS —
 * the same protocol family the R0 synthetic mock (poc/dsh-child/src/
 * mock-model.ts) speaks, so the R0 evidence carries over. The adapter is
 * SHIPPED DISABLED BY DEFAULT and gated by three independent, fail-closed
 * requirements (issue #14: 真实 Provider 仅在显式授权、隔离环境中运行):
 *
 *   1. an EXPLICIT baseURL (no default endpoint exists in this codebase —
 *      an empty/absent baseURL is a construction error);
 *   2. an EXPLICIT key source callback (credentials are resolved at request
 *      time by the deployer, never read at startup — R1-00 rule kept intact;
 *      the key value is structurally excluded from errors and audit);
 *   3. an EXPLICIT data-egress review acknowledgement
 *      (DataEgressReviewAcknowledgement) — the independent data-export
 *      review required by the issue has NOT happened yet, so no production
 *      configuration can enable real egress through this adapter today.
 *
 * Transport is injectable for tests; the default uses the global fetch.
 * All failures are normalized to ProviderFailure with a static
 * classification — provider response bodies are never surfaced (only the
 * HTTP status class), and the key never enters any header record, error or
 * log. Tests use a loopback synthetic server only; CI is all-mock/local.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import {
  ProviderFailure,
  type ProviderFailureClassification,
} from "./errors.ts";
import type { ModelProvider, ProviderKind } from "./provider.ts";
import type { ModelRequest, ModelUsage, ProviderStreamEvent } from "./types.ts";
import type { DataEgressReviewAcknowledgement } from "./config.ts";
import { ingestDomainFact } from "../legacy-guard.ts";

/** A fetch-compatible transport (injectable; default = global fetch). */
export type HttpTransport = (
  url: string,
  init: { method: string; headers: Readonly<Record<string, string>>; body: string; signal: AbortSignal },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | null;
}>;

export interface HttpMessagesProviderConfig {
  readonly providerId: string;
  /**
   * Absolute endpoint ORIGIN only (protocol + host, no path or /v1 suffix) —
   * the adapter itself appends the versioned messages path (issue #15
   * review reconciliation: the old trailing-"v1" example contradicted that
   * join and would have doubled the version segment). REQUIRED.
   */
  readonly baseURL: string;
  /** Resolves the credential at request time; null = no key configured. */
  readonly keySource: () => string | null;
  /** Explicit data-egress review acknowledgement. REQUIRED. */
  readonly dataEgressReview: DataEgressReviewAcknowledgement;
}

function assertBaseURL(baseURL: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new Error("http_messages provider requires a valid absolute baseURL (none is provided by default).");
  }
  const isLoopbackHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]" || parsed.hostname === "::1");
  if (parsed.protocol !== "https:" && !isLoopbackHttp) {
    throw new Error("http_messages provider baseURL must use https (plain http is allowed for loopback test servers only).");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("http_messages provider baseURL must not embed credentials.");
  }
  return baseURL;
}

function classificationForStatus(status: number): ProviderFailureClassification {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status >= 500) {
    return "server_error";
  }
  if (status === 408) {
    return "timeout";
  }
  return "bad_request";
}

/** Minimal line reader over byte chunks (UTF-8; no node builtin imports). */
async function* readLines(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      yield line;
    }
  }
  if (buffer.length > 0) {
    yield buffer;
  }
}

interface SseFrame {
  readonly event: string | null;
  readonly data: string;
}

async function* readSseFrames(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): AsyncGenerator<SseFrame> {
  let event: string | null = null;
  let data: string[] = [];
  for await (const line of readLines(chunks)) {
    if (line === "") {
      if (event !== null || data.length > 0) {
        yield { event, data: data.join("\n") };
      }
      event = null;
      data = [];
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice(5).trim());
      continue;
    }
    // Unknown SSE fields (comments, retry) are tolerated.
  }
  if (event !== null || data.length > 0) {
    yield { event, data: data.join("\n") };
  }
}

function usageFromMessage(
  messageUsage: unknown,
): ModelUsage | null {
  if (messageUsage === null || typeof messageUsage !== "object") {
    return null;
  }
  const record = messageUsage as Record<string, unknown>;
  const inputTokens = record.input_tokens;
  const outputTokens = record.output_tokens;
  if (typeof inputTokens !== "number" || !Number.isInteger(inputTokens) || inputTokens < 0) {
    return null;
  }
  if (typeof outputTokens !== "number" || !Number.isInteger(outputTokens) || outputTokens < 0) {
    return null;
  }
  return ingestDomainFact({ inputTokens, outputTokens }) as ModelUsage;
}

export function createHttpMessagesProvider(
  config: HttpMessagesProviderConfig,
  deps: { readonly transport?: HttpTransport } = {},
): ModelProvider {
  const baseURL = assertBaseURL(config.baseURL);
  if (
    typeof config.keySource !== "function" ||
    !config.dataEgressReview ||
    config.dataEgressReview.acknowledgeDataEgressReview !== true
  ) {
    throw new Error(
      "http_messages provider requires an explicit key source and a data-egress review acknowledgement.",
    );
  }
  const transport: HttpTransport =
    deps.transport ??
    (async (url, init) => {
      const response = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return {
        ok: response.ok,
        status: response.status,
        headers,
        // Node fetch exposes a web ReadableStream; it is async-iterable.
        body: response.body as unknown as AsyncIterable<Uint8Array> | null,
      };
    });

  return Object.freeze({
    providerId: config.providerId,
    kind: "http_messages" satisfies ProviderKind,
    dataEgressAuthorized: true, // construction succeeded => the review gate was passed
    description:
      "external Messages-protocol provider (explicit baseURL + key source + data-egress review)",
    registrationView() {
      return {
        providerId: config.providerId,
        kind: "http_messages" as const,
        baseURL,
        hasKeySource: true,
        dataEgressReview: {
          reviewer: config.dataEgressReview.reviewer,
          reason: config.dataEgressReview.reason,
        },
      };
    },
    async *stream(
      request: Readonly<ModelRequest>,
      { signal }: { readonly signal: AbortSignal },
    ): AsyncGenerator<ProviderStreamEvent> {
      const key = config.keySource();
      if (key === null || key === "") {
        // Fail closed: never send an unauthenticated request and never
        // fabricate a default credential.
        throw new ProviderFailure("auth");
      }
      const systemText = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
      const wireMessages = request.messages
        .filter((message) => message.role !== "system")
        .map((message) => ({ role: message.role, content: message.content }));
      const payload: Record<string, unknown> = {
        model: request.modelId,
        stream: true,
        max_tokens: request.maxOutputTokens ?? 1024,
        messages: wireMessages,
      };
      if (systemText.length > 0) {
        payload.system = systemText;
      }
      if (request.tools.length > 0) {
        payload.tools = request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
        }));
      }

      let response: Awaited<ReturnType<HttpTransport>>;
      try {
        response = await transport(`${baseURL.replace(/\/$/, "")}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // The credential travels only here — never into errors/audit.
            "x-api-key": key,
          },
          body: JSON.stringify(payload),
          signal,
        });
      } catch {
        if (signal.aborted) {
          throw new ProviderFailure("cancelled");
        }
        throw new ProviderFailure("unavailable");
      }
      if (!response.ok) {
        throw new ProviderFailure(classificationForStatus(response.status), response.status);
      }

      let usage: ModelUsage | null = null;
      let sawMessageStop = false;
      try {
        if (response.body === null) {
          throw new ProviderFailure("protocol");
        }
        for await (const frame of readSseFrames(response.body)) {
          if (frame.event === null || frame.data === "") {
            continue;
          }
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(frame.data) as Record<string, unknown>;
          } catch {
            throw new ProviderFailure("protocol");
          }
          if (frame.event === "content_block_delta") {
            const delta = parsed.delta as Record<string, unknown> | undefined;
            const text = delta?.text;
            if (typeof text === "string" && text.length > 0) {
              yield { type: "delta", text };
            }
            continue;
          }
          if (frame.event === "message_start") {
            const message = parsed.message as Record<string, unknown> | undefined;
            const startUsage = message?.usage === undefined ? null : usageFromMessage(message.usage);
            if (startUsage !== null) {
              usage = startUsage;
            }
            continue;
          }
          if (frame.event === "message_delta") {
            const deltaUsage = parsed.usage === undefined ? null : usageFromMessage(parsed.usage);
            if (deltaUsage !== null) {
              usage = deltaUsage;
            }
            continue;
          }
          if (frame.event === "message_stop") {
            sawMessageStop = true;
            continue;
          }
          // Other event types (ping, content_block_start/stop, error frames)
          // are tolerated structurally.
        }
      } catch (error) {
        if (signal.aborted) {
          throw new ProviderFailure("cancelled");
        }
        throw asFailure(error);
      }
      if (!sawMessageStop || usage === null) {
        throw new ProviderFailure("protocol");
      }
      yield { type: "completed", usage };
    },
  });
}

function asFailure(error: unknown): ProviderFailure {
  if (error instanceof ProviderFailure) {
    return error;
  }
  return new ProviderFailure("protocol");
}
