/**
 * E2E-03 (issue #53) — the loopback Model Gateway egress proxy.
 *
 * The REAL DSH runtime (poc/dsh-child bridge worker) speaks the Anthropic-
 * Messages wire protocol over HTTP and can only be pointed at a base URL.
 * To give the real runtime a reviewed remote-LLM path WITHOUT creating a
 * second, uncontrolled agent (issue #53 实施范围 2), this proxy is the ONLY
 * model route the bridge worker may take for real egress:
 *
 *     DSH worker ──loopback HTTP──▶ GatewayEgressProxy
 *                                   └─▶ ModelGateway (budget/retry/breaker/
 *                                       timeout/cancel/audit/single-provider)
 *                                        └─▶ http_messages provider ─▶ vendor
 *
 * Invariants:
 *  - LOOPBACK ONLY: the server refuses to bind anything but 127.0.0.1/::1/
 *    localhost. The vendor key NEVER enters the worker process (the child
 *    keeps its synthetic placeholder credential; the real key lives in the
 *    host-side keySource closure).
 *  - SINGLE ROUTE: every request is translated into one ModelGateway request
 *    (server-minted contract ids, no identity fields) and answered from the
 *    gateway's outcome — the proxy owns no provider logic of its own.
 *  - FAIL CLOSED: bearer mismatch, unknown path, oversize/invalid payload,
 *    unregistered model, non-text content blocks (never silently stripped —
 *    issue #53 review r1 P2-2) and every gateway rejection map to static
 *    Messages-protocol error responses. Response text is value-free: no
 *    prompt text, no provider body, no key material is ever echoed.
 *  - CANCELLATION: a client disconnect aborts the gateway stream (the
 *    gateway records the auditable user_cancelled outcome and never bills a
 *    completed turn).
 *  - NO LOGGING: the proxy keeps integer counters only — request/response
 *    bodies are never read into any log or error surface.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import {
  GatewayError,
  MAX_OUTPUT_TOKENS_LIMIT,
  parseModelRequest,
  type ModelGateway,
} from "../domain/gateway/index.ts";
import { CONTRACT_ID_PREFIXES } from "../domain/contract/core.ts";

/**
 * The bearer credential the bridge worker presents (the SAME pinned
 * synthetic placeholder the child env policy allows — never a vendor key;
 * poc/dsh-child/src/child-env.ts is the single source for the child side).
 * The proxy guards the gateway route, not the vendor: a leaked placeholder
 * can only reach the gateway's own budget/review gates.
 */
export const GATEWAY_EGRESS_PROXY_DEFAULT_TOKEN = "dsh-poc-synthetic-key";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
/** Hard cap on one accepted request body (messages are 8k chars each, ≤32). */
const MAX_BODY_BYTES = 1_000_000;

export interface GatewayEgressProxyOptions {
  /** The gateway every request is served through. */
  readonly gateway: ModelGateway;
  /** The model ids this route may serve (single-provider routing surface). */
  readonly allowedModelIds: readonly string[];
  /** Bearer the worker must present (default: the pinned synthetic placeholder). */
  readonly proxyToken?: string;
  /** Bind host — loopback only. */
  readonly host?: string;
  /** Bind port — 0 (default) picks an ephemeral loopback port. */
  readonly port?: number;
}

export interface GatewayEgressProxyStats {
  readonly requests: number;
  readonly rejected: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}

export interface GatewayEgressProxy {
  start(): Promise<{ readonly url: string; readonly port: number }>;
  stop(): Promise<void>;
  stats(): GatewayEgressProxyStats;
}

interface StaticErrorShape {
  readonly status: number;
  readonly type: string;
  readonly message: string;
}

/**
 * Gateway code → static Messages-protocol error mapping. Everything the
 * gateway decided BEFORE contacting the vendor (budget/circuit/no-provider/
 * invalid) maps to non-retryable 4xx; availability classes map to 5xx so the
 * runtime's own retry policy stays meaningful while the gateway remains the
 * single accounting point.
 */
const GATEWAY_ERROR_RESPONSES: Readonly<Record<string, StaticErrorShape>> = Object.freeze({
  GATEWAY_INVALID_REQUEST: { status: 400, type: "invalid_request_error", message: "request rejected by model gateway (GATEWAY_INVALID_REQUEST)" },
  GATEWAY_NO_PROVIDER: { status: 503, type: "api_error", message: "no provider is registered for this route (GATEWAY_NO_PROVIDER)" },
  GATEWAY_BUDGET_EXHAUSTED: { status: 400, type: "invalid_request_error", message: "daily model budget exhausted (GATEWAY_BUDGET_EXHAUSTED)" },
  GATEWAY_CIRCUIT_OPEN: { status: 503, type: "overloaded_error", message: "provider circuit is open (GATEWAY_CIRCUIT_OPEN)" },
  GATEWAY_PROVIDER_TIMEOUT: { status: 504, type: "api_error", message: "provider attempt timed out (GATEWAY_PROVIDER_TIMEOUT)" },
  GATEWAY_PROVIDER_UNAVAILABLE: { status: 502, type: "api_error", message: "provider is unavailable (GATEWAY_PROVIDER_UNAVAILABLE)" },
  GATEWAY_PROVIDER_RATE_LIMITED: { status: 429, type: "rate_limit_error", message: "provider rate limit hit (GATEWAY_PROVIDER_RATE_LIMITED)" },
  GATEWAY_PROVIDER_SERVER_ERROR: { status: 502, type: "api_error", message: "provider server failure (GATEWAY_PROVIDER_SERVER_ERROR)" },
  GATEWAY_AUTH_FAILED: { status: 401, type: "authentication_error", message: "provider credential rejected or absent (GATEWAY_AUTH_FAILED)" },
  GATEWAY_PROVIDER_PROTOCOL: { status: 502, type: "api_error", message: "provider protocol violation (GATEWAY_PROVIDER_PROTOCOL)" },
});

function staticErrorFor(code: string): StaticErrorShape {
  return GATEWAY_ERROR_RESPONSES[code] ?? { status: 500, type: "api_error", message: "model gateway failure" };
}

function writeError(res: ServerResponse, shape: StaticErrorShape): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ type: "error", error: { type: shape.type, message: shape.message } });
  res.writeHead(shape.status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}

function sendFrame(res: ServerResponse, event: string, data: Record<string, unknown>): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
}

/** Extract text from an Anthropic-style content field (string or block array). */
function textOfContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string" && text.length > 0) {
          parts.push(text);
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Fail-closed content guard (issue #53 review r1 P2-2): the gateway route
 * serves a TEXT-ONLY Messages context (the pinned bridge profile mounts no
 * tools, streams no reasoning and sends no images). A non-text content block
 * (tool_use/tool_result/image/thinking/…) — or a malformed array element —
 * can never be represented in the gateway's text context, and silently
 * stripping it would shrink the model's context with zero audit trace
 * (fabricated semantics). The proxy therefore rejects the request statically
 * BEFORE the gateway: value-free 400, `rejected` counter, no vendor contact.
 * Content that is merely EMPTY (empty string / empty text blocks) stays
 * droppable: it is provably value-free, and an all-empty request still fails
 * visibly in parseModelRequest.
 */
function contentCarriesNonTextBlock(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false; // string content is text by definition
  }
  return content.some((block) => {
    if (block === null || typeof block !== "object") {
      return true; // malformed element: not provably text
    }
    return (block as { type?: unknown }).type !== "text";
  });
}

function requestCarriesNonTextBlock(payload: Record<string, unknown>): boolean {
  if (contentCarriesNonTextBlock(payload.system)) {
    return true;
  }
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
  return rawMessages.some((message) => {
    if (message === null || typeof message !== "object") {
      // Message-level shapes stay with buildGatewayRequest/parseModelRequest.
      return false;
    }
    return contentCarriesNonTextBlock((message as { content?: unknown }).content);
  });
}

/**
 * Fail-closed role guard (issue #53 review r2 P2-1): the gateway context is a
 * user/assistant text exchange (the `system` record is built from the
 * top-level `system` field, not from a messages element). A messages element
 * with any other role — or a malformed element — can never be represented in
 * that context, and silently skipping it would shrink the model's context
 * with zero audit trace (the same fabricated-semantics class the r1 review
 * fixed for non-text blocks). The proxy rejects the request statically BEFORE
 * the gateway: value-free 400, `rejected` counter, no vendor contact.
 */
function requestCarriesUnexpectedMessageRole(payload: Record<string, unknown>): boolean {
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
  return rawMessages.some((raw) => {
    if (raw === null || typeof raw !== "object") {
      return true; // malformed element: not a representable message
    }
    const role = (raw as { role?: unknown }).role;
    return role !== "user" && role !== "assistant";
  });
}

/** Server-minted contract id (`req_`/`trc_`/`trn_` + 24 hex). */
function mintId(kind: "requestId" | "traceId" | "turnId"): string {
  return `${CONTRACT_ID_PREFIXES[kind]}${randomBytes(12).toString("hex")}`;
}

/** One accepted request converted into the gateway's minimal context shape. */
function buildGatewayRequest(payload: Record<string, unknown>, defaultTimeoutMs: number): Parameters<typeof parseModelRequest>[0] {
  const rawMessages = Array.isArray(payload.messages) ? payload.messages : [];
  const messages: Array<{ role: string; content: string }> = [];
  const systemText = textOfContent(payload.system);
  if (systemText.length > 0) {
    messages.push({ role: "system", content: systemText });
  }
  for (const raw of rawMessages) {
    if (raw === null || typeof raw !== "object") {
      continue;
    }
    const record = raw as { role?: unknown; content?: unknown };
    if (typeof record.role !== "string" || (record.role !== "user" && record.role !== "assistant")) {
      continue;
    }
    const text = textOfContent(record.content);
    if (text.length > 0) {
      messages.push({ role: record.role, content: text });
    }
  }
  const rawTools = Array.isArray(payload.tools) ? payload.tools : [];
  const tools = rawTools
    .filter((tool): tool is Record<string, unknown> => tool !== null && typeof tool === "object")
    .map((tool) => ({ name: tool.name, description: tool.description }))
    .filter((tool) => typeof tool.name === "string" && typeof tool.description === "string");
  return {
    requestId: mintId("requestId"),
    traceId: mintId("traceId"),
    turnId: mintId("turnId"),
    modelId: typeof payload.model === "string" ? payload.model : "",
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    timeoutMs: defaultTimeoutMs,
    ...(Number.isInteger(payload.max_tokens) && (payload.max_tokens as number) >= 1
      ? // Clamp to the request grammar ceiling; the gateway clamps further to
        // the registered model ceiling (issue #15 wiring).
        { maxOutputTokens: Math.min(payload.max_tokens as number, MAX_OUTPUT_TOKENS_LIMIT) }
      : {}),
  };
}

export function createGatewayEgressProxy(options: GatewayEgressProxyOptions): GatewayEgressProxy {
  if (options === null || typeof options !== "object" || typeof options.gateway?.stream !== "function") {
    throw new Error("gateway egress proxy requires a ModelGateway.");
  }
  if (!Array.isArray(options.allowedModelIds) || options.allowedModelIds.length === 0) {
    throw new Error("gateway egress proxy requires at least one allowed model id.");
  }
  const host = options.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("gateway egress proxy must bind a loopback host only.");
  }
  const port = options.port ?? 0;
  const proxyToken = options.proxyToken ?? GATEWAY_EGRESS_PROXY_DEFAULT_TOKEN;
  const allowedModels = new Set(options.allowedModelIds);
  // The gateway's registered per-attempt timeout default (issue #15 wiring:
  // requests without an explicit timeout get the config value; the gateway
  // clamps anything larger).
  const defaultTimeoutMs = options.gateway.describeConfig().requestTimeoutMs;

  const stats = { requests: 0, rejected: 0, completed: 0, failed: 0, cancelled: 0 };

  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });
  // A client disconnect must never become an unhandled server error.
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Route + bearer gate BEFORE any body is read.
    if (req.method !== "POST" || (req.url ?? "").endsWith("/v1/messages") === false) {
      stats.rejected += 1;
      writeError(res, { status: 404, type: "not_found_error", message: "only POST /v1/messages is served" });
      return;
    }
    const bearer = req.headers["x-api-key"];
    const bearerValue = Array.isArray(bearer) ? bearer[0] : bearer;
    if (bearerValue !== proxyToken) {
      stats.rejected += 1;
      // The submitted value is never echoed.
      writeError(res, { status: 401, type: "authentication_error", message: "missing or invalid route credential" });
      return;
    }

    const chunks: Buffer[] = [];
    let received = 0;
    let oversizeRejected = false;
    for await (const chunk of req) {
      received += (chunk as Buffer).length;
      if (received > MAX_BODY_BYTES) {
        if (!oversizeRejected) {
          // Respond once, then keep draining (never an abrupt RST: the
          // client must observe the static 413; the loopback caller is our
          // own worker, so an unbuffered drain is bounded in practice).
          oversizeRejected = true;
          stats.rejected += 1;
          writeError(res, { status: 413, type: "request_too_large", message: "request body exceeds the proxy limit" });
        }
        continue;
      }
      chunks.push(chunk as Buffer);
    }
    if (oversizeRejected) {
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } catch {
      stats.rejected += 1;
      writeError(res, { status: 400, type: "invalid_request_error", message: "request body is not valid JSON" });
      return;
    }
    if (payload === null || typeof payload !== "object" || typeof payload.model !== "string" || !allowedModels.has(payload.model)) {
      stats.rejected += 1;
      // The submitted model id is never echoed (unregistered route).
      writeError(res, { status: 400, type: "invalid_request_error", message: "model is not registered on this gateway route" });
      return;
    }
    if (requestCarriesNonTextBlock(payload)) {
      // Fail closed on content the text-only route cannot represent
      // (issue #53 review r1 P2-2): no silent stripping, no partial drop.
      // The submitted block types/values are never echoed.
      stats.rejected += 1;
      writeError(res, { status: 400, type: "invalid_request_error", message: "request carries content blocks this route does not serve (text-only route)" });
      return;
    }
    if (requestCarriesUnexpectedMessageRole(payload)) {
      // Fail closed on message shapes the user/assistant context cannot
      // represent (issue #53 review r2 P2-1): silently skipping an unexpected
      // role would shrink the model's context with zero audit trace. The
      // submitted role values are never echoed.
      stats.rejected += 1;
      writeError(res, { status: 400, type: "invalid_request_error", message: "request carries message roles this route does not serve (user/assistant only)" });
      return;
    }

    let request: ReturnType<typeof parseModelRequest>;
    try {
      request = parseModelRequest(buildGatewayRequest(payload, defaultTimeoutMs));
    } catch {
      stats.rejected += 1;
      writeError(res, { status: 400, type: "invalid_request_error", message: "request rejected by model gateway (GATEWAY_INVALID_REQUEST)" });
      return;
    }

    // From here the request is accepted: one gateway request per HTTP call.
    stats.requests += 1;
    const controller = new AbortController();
    // A client disconnect (user stop / worker crash) cancels the gateway
    // attempt — auditable user_cancelled, never a silently billed turn.
    res.on("close", () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    // The SSE headers go out with the FIRST delta (like the real vendor
    // endpoint): a failure that produces no output maps to a clean static
    // error status the runtime can classify; only genuine streaming becomes
    // text/event-stream.
    let streamOpened = false;
    const openStream = (): void => {
      if (streamOpened) {
        return;
      }
      streamOpened = true;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      sendFrame(res, "message_start", {
        message: {
          id: `msg_${request.requestId.slice("req_".length)}`,
          type: "message",
          role: "assistant",
          model: request.modelId,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      sendFrame(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    };

    try {
      for await (const item of options.gateway.stream(request, { signal: controller.signal })) {
        if (item.kind === "delta") {
          openStream();
          sendFrame(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: item.text } });
          continue;
        }
        openStream();
        sendFrame(res, "content_block_stop", { index: 0 });
        sendFrame(res, "message_delta", {
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: item.result.usage.outputTokens },
        });
        sendFrame(res, "message_stop", {});
        res.end();
        stats.completed += 1;
      }
    } catch (error) {
      if (error instanceof GatewayError && error.code === "GATEWAY_CANCELLED") {
        // The caller went away (or the worker crashed): the gateway already
        // recorded the auditable cancellation. No synthetic terminal frame —
        // the socket is closing.
        stats.cancelled += 1;
        res.destroy();
        return;
      }
      stats.failed += 1;
      const shape =
        error instanceof GatewayError
          ? staticErrorFor(error.code)
          : { status: 500, type: "api_error", message: "model gateway failure" };
      if (streamOpened) {
        // Mid-stream failures cannot become a clean error body; the client
        // observes the truncated stream and the gateway holds the audit.
        res.destroy();
        return;
      }
      writeError(res, shape);
    }
  }

  return Object.freeze({
    start() {
      return new Promise<{ url: string; port: number }>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("gateway egress proxy did not acquire a loopback port"));
            return;
          }
          resolve({ url: `http://127.0.0.1:${address.port}`, port: address.port });
        });
      });
    },
    stop() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
    stats: () => ({ ...stats }),
  });
}
