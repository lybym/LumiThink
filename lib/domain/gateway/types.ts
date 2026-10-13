/**
 * R1-02 Model Gateway — request/result/delta vocabulary and fail-closed
 * parsing (docs/MODEL_GATEWAY.md, docs/HARNESS.md §3, PRD FR-004, Roadmap
 * R1-02, issue #14).
 *
 * The gateway speaks the R1-01 contract ID vocabulary (trace/turn/request)
 * and reuses its grammar so correlation ids can flow into ErrorEnvelope /
 * StreamEvent later without re-interpretation. The gateway request itself is
 * a SERVER-side internal structure: it must never carry identity fields
 * (actor/childRef) — identity resolution happens upstream in the orchestrator
 * and only the minimal necessary context is forwarded to a provider
 * (issue #14: 模型请求只携带最小必要上下文).
 *
 * Validation is fail-closed like every contract parser: unknown fields are
 * rejected, submitted values are never echoed in problem messages, and text
 * length checks short-circuit on UTF-16 length before counting code points
 * (lesson from the R1-01 review P2-d: never spread unbounded strings).
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import {
  type ContractProblem,
  ContractValidationError,
  problem,
  validateContractId,
} from "../contract/core.ts";
import { ingestDomainFact } from "../legacy-guard.ts";
import { MAX_STREAM_DELTA_LENGTH } from "../contract/response.ts";

// ---------------------------------------------------------------------------
// Identifier grammars
// ---------------------------------------------------------------------------

/**
 * Model and provider ids are server-authored registry keys (not client
 * input), but they are still validated fail-closed so a typo can never
 * silently route a turn to an unintended provider.
 */
export const GATEWAY_ID_PATTERN = /^[a-z][a-z0-9-]{1,38}(\.[a-z0-9-]{1,38})?$/;

export function isGatewayId(value: unknown): value is string {
  return typeof value === "string" && GATEWAY_ID_PATTERN.test(value);
}

function validateGatewayId(
  kind: "modelId" | "providerId",
  value: unknown,
  path: string,
  problems: ContractProblem[],
): void {
  if (value === undefined || value === null || value === "") {
    problems.push(problem("CONTRACT_FIELD_MISSING", path, `${path} is required.`));
    return;
  }
  if (!isGatewayId(value)) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        path,
        `${path} must match ${GATEWAY_ID_PATTERN.source}; the submitted value is not echoed.`,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export const MODEL_MESSAGE_ROLES = ["system", "user", "assistant"] as const;
export type ModelMessageRole = (typeof MODEL_MESSAGE_ROLES)[number];

/**
 * Maximum code points of ONE message content. Larger than the contract's
 * 4000-code-point child input because a request carries the composed system
 * policy plus bounded history, but still hard-capped (issue #14: 最小必要上下文).
 */
export const MAX_MODEL_MESSAGE_CHARS = 8000;
/** UTF-16 short-circuit: reject early before any code-point counting. */
const MAX_MODEL_MESSAGE_UTF16 = MAX_MODEL_MESSAGE_CHARS * 2;
/** Maximum number of messages in one request (bounded context window). */
export const MAX_MODEL_REQUEST_MESSAGES = 32;

export interface ModelMessage {
  readonly role: ModelMessageRole;
  readonly content: string;
}

function parseModelMessage(value: unknown, path: string, problems: ContractProblem[]): ModelMessage | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", path, "message must be an object."));
    return null;
  }
  const record = value as Record<string, unknown>;
  let role: ModelMessageRole | null = null;
  if (typeof record.role !== "string" || !(MODEL_MESSAGE_ROLES as readonly string[]).includes(record.role)) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        `${path}.role`,
        `message role must be one of: ${MODEL_MESSAGE_ROLES.join(" | ")}.`,
      ),
    );
  } else {
    role = record.role as ModelMessageRole;
  }
  let content: string | null = null;
  if (typeof record.content !== "string") {
    problems.push(problem("CONTRACT_FIELD_MISSING", `${path}.content`, "message content is required."));
  } else if (record.content.length === 0) {
    problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.content`, "message content must be non-empty."));
  } else if (record.content.length > MAX_MODEL_MESSAGE_UTF16) {
    // UTF-16 short-circuit: definitely over the code-point cap, reject now.
    problems.push(
      problem(
        "CONTRACT_TEXT_TOO_LONG",
        `${path}.content`,
        `message content exceeds the ${MAX_MODEL_MESSAGE_CHARS} code-point limit.`,
        { limit: MAX_MODEL_MESSAGE_CHARS },
      ),
    );
  } else {
    const codePoints = [...record.content];
    if (codePoints.length > MAX_MODEL_MESSAGE_CHARS) {
      problems.push(
        problem(
          "CONTRACT_TEXT_TOO_LONG",
          `${path}.content`,
          `message content exceeds the ${MAX_MODEL_MESSAGE_CHARS} code-point limit.`,
          { limit: MAX_MODEL_MESSAGE_CHARS, actual: codePoints.length },
        ),
      );
    } else {
      content = record.content;
    }
  }
  for (const key of Object.keys(record)) {
    if (key !== "role" && key !== "content") {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", `${path}.${key}`, "message carries an unknown field; " +
          "identity and client fields never ride along to a provider."),
      );
    }
  }
  return role === null || content === null ? null : { role, content };
}

// ---------------------------------------------------------------------------
// Tool declarations (optional; v0 carries them opaquely-but-bounded)
// ---------------------------------------------------------------------------

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,47}$/;
export const MAX_MODEL_REQUEST_TOOLS = 16;

export interface ModelToolDeclaration {
  readonly name: string;
  readonly description: string;
}

function parseModelTool(
  value: unknown,
  path: string,
  problems: ContractProblem[],
): ModelToolDeclaration | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", path, "tool declaration must be an object."));
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || !TOOL_NAME_PATTERN.test(record.name)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", `${path}.name`, "tool name must match ^[a-z][a-z0-9_-]{1,47}$."),
    );
  }
  if (typeof record.description !== "string" || record.description.length === 0) {
    problems.push(problem("CONTRACT_FIELD_MISSING", `${path}.description`, "tool description is required."));
  } else if (record.description.length > 500) {
    problems.push(
      problem("CONTRACT_TEXT_TOO_LONG", `${path}.description`, "tool description exceeds 500 UTF-16 units."),
    );
  }
  for (const key of Object.keys(record)) {
    if (key !== "name" && key !== "description") {
      problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.${key}`, "tool declaration carries an unknown field."));
    }
  }
  return typeof record.name === "string" && typeof record.description === "string"
    ? { name: record.name, description: record.description }
    : null;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_REQUEST_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_TOKENS_LIMIT = 8192;

/**
 * The validated server-side model request (docs/HARNESS.md §3 ModelRequest:
 * model_id / messages / tool_schema / timeout_ms / budget hints / trace_id).
 * `requestId`/`traceId`/`turnId` use the contract ID grammar for audit
 * correlation. There is deliberately NO actor/child field on this type.
 */
export interface ModelRequest {
  readonly requestId: string;
  readonly traceId: string;
  readonly turnId: string;
  readonly modelId: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDeclaration[];
  readonly timeoutMs: number;
  readonly maxOutputTokens: number | null;
}

/**
 * Parse and validate a raw model request. Fail-closed: throws
 * ContractValidationError listing structural problems; submitted text values
 * are never echoed. Result is deeply frozen through the domain intake guard.
 */
export function parseModelRequest(value: unknown): Readonly<ModelRequest> {
  const problems: ContractProblem[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "modelRequest", "modelRequest must be an object."),
    ]);
  }
  const record = value as Record<string, unknown>;
  validateContractId("requestId", record.requestId, "requestId", problems);
  validateContractId("traceId", record.traceId, "traceId", problems);
  validateContractId("turnId", record.turnId, "turnId", problems);
  validateGatewayId("modelId", record.modelId, "modelId", problems);

  let messages: ModelMessage[] = [];
  if (!Array.isArray(record.messages) || record.messages.length === 0) {
    problems.push(
      problem("CONTRACT_FIELD_MISSING", "messages", "messages is required and must be a non-empty array."),
    );
  } else if (record.messages.length > MAX_MODEL_REQUEST_MESSAGES) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "messages",
        `messages exceeds the ${MAX_MODEL_REQUEST_MESSAGES}-message context limit.`,
        { limit: MAX_MODEL_REQUEST_MESSAGES, actual: record.messages.length },
      ),
    );
  } else {
    const parsed: ModelMessage[] = [];
    record.messages.forEach((item, index) => {
      const message = parseModelMessage(item, `messages[${index}]`, problems);
      if (message !== null) {
        parsed.push(message);
      }
    });
    messages = parsed;
  }

  let tools: ModelToolDeclaration[] = [];
  if (record.tools !== undefined) {
    if (!Array.isArray(record.tools)) {
      problems.push(problem("CONTRACT_FIELD_INVALID", "tools", "tools must be an array when present."));
    } else if (record.tools.length > MAX_MODEL_REQUEST_TOOLS) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          "tools",
          `tools exceeds the ${MAX_MODEL_REQUEST_TOOLS}-tool limit.`,
          { limit: MAX_MODEL_REQUEST_TOOLS, actual: record.tools.length },
        ),
      );
    } else {
      const parsedTools: ModelToolDeclaration[] = [];
      record.tools.forEach((item, index) => {
        const tool = parseModelTool(item, `tools[${index}]`, problems);
        if (tool !== null) {
          parsedTools.push(tool);
        }
      });
      tools = parsedTools;
    }
  }

  let timeoutMs: number | null = null;
  if (record.timeoutMs === undefined) {
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  } else if (
    typeof record.timeoutMs !== "number" ||
    !Number.isInteger(record.timeoutMs) ||
    record.timeoutMs < 1 ||
    record.timeoutMs > MAX_REQUEST_TIMEOUT_MS
  ) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "timeoutMs",
        `timeoutMs must be an integer between 1 and ${MAX_REQUEST_TIMEOUT_MS}.`,
        { limit: MAX_REQUEST_TIMEOUT_MS },
      ),
    );
  } else {
    timeoutMs = record.timeoutMs;
  }

  let maxOutputTokens: number | null = null;
  if (record.maxOutputTokens !== undefined) {
    if (
      typeof record.maxOutputTokens !== "number" ||
      !Number.isInteger(record.maxOutputTokens) ||
      record.maxOutputTokens < 1 ||
      record.maxOutputTokens > MAX_OUTPUT_TOKENS_LIMIT
    ) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          "maxOutputTokens",
          `maxOutputTokens must be an integer between 1 and ${MAX_OUTPUT_TOKENS_LIMIT}.`,
          { limit: MAX_OUTPUT_TOKENS_LIMIT },
        ),
      );
    } else {
      maxOutputTokens = record.maxOutputTokens;
    }
  }

  for (const key of Object.keys(record)) {
    if (
      !["requestId", "traceId", "turnId", "modelId", "messages", "tools", "timeoutMs", "maxOutputTokens"]
        .includes(key)
    ) {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", key, "modelRequest carries an unknown field; " +
          "identity fields (actor/childRef/session) never reach the gateway."),
      );
    }
  }

  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return ingestDomainFact({
    requestId: record.requestId as string,
    traceId: record.traceId as string,
    turnId: record.turnId as string,
    modelId: record.modelId as string,
    messages,
    tools,
    timeoutMs: timeoutMs as number,
    maxOutputTokens,
  }) as Readonly<ModelRequest>;
}

// ---------------------------------------------------------------------------
// Provider stream events / usage
// ---------------------------------------------------------------------------

/** One streamed text fragment from a provider (before gateway enforcement). */
export interface ProviderDelta {
  readonly type: "delta";
  readonly text: string;
}

/** Terminal event of a successful provider stream. */
export interface ProviderCompleted {
  readonly type: "completed";
  readonly usage: ModelUsage;
}

export type ProviderStreamEvent = ProviderDelta | ProviderCompleted;

/** Token accounting reported by a provider (structural facts only). */
export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export function parseModelUsage(value: unknown, path: string, problems: ContractProblem[]): ModelUsage | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    problems.push(problem("CONTRACT_FIELD_MISSING", path, "usage is required."));
    return null;
  }
  const record = value as Record<string, unknown>;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  if (typeof record.inputTokens !== "number" || !Number.isInteger(record.inputTokens) || record.inputTokens < 0) {
    problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.inputTokens`, "usage.inputTokens must be a non-negative integer."));
  } else {
    inputTokens = record.inputTokens;
  }
  if (typeof record.outputTokens !== "number" || !Number.isInteger(record.outputTokens) || record.outputTokens < 0) {
    problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.outputTokens`, "usage.outputTokens must be a non-negative integer."));
  } else {
    outputTokens = record.outputTokens;
  }
  for (const key of Object.keys(record)) {
    if (key !== "inputTokens" && key !== "outputTokens") {
      problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.${key}`, "usage carries an unknown field."));
    }
  }
  return inputTokens === null || outputTokens === null ? null : { inputTokens, outputTokens };
}

/**
 * Validate a provider delta. Deltas are non-empty and capped at the
 * contract's per-delta limit (MAX_STREAM_DELTA_LENGTH) so a gateway stream
 * can be forwarded to the SSE contract layer unmodified (UTF-16
 * short-circuit before code-point counting, R1-01 review P2-d lesson).
 */
export function validateProviderDelta(text: unknown): string {
  if (typeof text !== "string" || text.length === 0) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "delta.text", "provider delta text must be a non-empty string."),
    ]);
  }
  if (text.length > MAX_STREAM_DELTA_LENGTH * 2) {
    throw new ContractValidationError([
      problem(
        "CONTRACT_TEXT_TOO_LONG",
        "delta.text",
        `provider delta exceeds the ${MAX_STREAM_DELTA_LENGTH} code-point per-delta limit.`,
        { limit: MAX_STREAM_DELTA_LENGTH },
      ),
    ]);
  }
  const codePoints = [...text];
  if (codePoints.length > MAX_STREAM_DELTA_LENGTH) {
    throw new ContractValidationError([
      problem(
        "CONTRACT_TEXT_TOO_LONG",
        "delta.text",
        `provider delta exceeds the ${MAX_STREAM_DELTA_LENGTH} code-point per-delta limit.`,
        { limit: MAX_STREAM_DELTA_LENGTH, actual: codePoints.length },
      ),
    ]);
  }
  return text;
}
