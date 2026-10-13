/**
 * R1-03 Cordis restricted service surface (issue #15, docs/HARNESS.md §4
 * 工具接口, docs/R0_DSH_POC.md R0-B conclusions).
 *
 * The ONLY way domain capabilities enter the DSH agent loop: explicit,
 * whitelisted service calls. Design invariants carried over from R0 and the
 * R1-15 tool gate:
 *
 * - the whitelist has exactly ONE source of truth: the R1-15
 *   `SAFE_TOOL_REGISTRY` (evidence.search / memory.lookup / memory.propose).
 *   The Cordis surface is DERIVED from it and tests assert the two are
 *   identical, so a tool can never be executable here but unregistered
 *   there (issue #15 AC 3: 插件最终组合树与 Tool Schema 白名单断言);
 * - dangerous categories/permissions (shell, PTY, arbitrary FS, arbitrary
 *   network, plugin install, sub-agent spawn, raw DB, direct memory writes,
 *   child-data export, raw audio) are forbidden outright by the tool gate —
 *   there is no code path that registers or executes them;
 * - every call passes the REAL `evaluateToolGate` (fail-closed, entrance
 *   `dsh_tool`) BEFORE any handler exists to serve it; a refusal never
 *   relies on prompt-level constraints (docs/SAFETY_POLICY.md §4.2);
 * - `memory.propose` is candidate-only by registry contract: whatever a
 *   handler returns can never be a persisted write — persistence is a
 *   trusted-service concern outside this surface;
 * - `describeCordisToolSchema()` produces the exact model-visible tool
 *   schema whitelist (≤ the gateway's per-request tool cap) and
 *   `assertAdvertisedToolsWithinWhitelist` checks a DSH port's reported
 *   composition tree against it — a profile that advertises anything else
 *   fails closed.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { ContractValidationError, problem, type ContractProblem } from "../contract/core.ts";
import type { ActorRole } from "../contract/actor.ts";
import { ingestDomainFact } from "../legacy-guard.ts";
import { evaluateToolGate, SAFE_TOOL_REGISTRY, type SafetyTraceRecord } from "../safety/index.ts";
import type { ModelToolDeclaration } from "../gateway/types.ts";

// ---------------------------------------------------------------------------
// Whitelist (derived — single source of truth is SAFE_TOOL_REGISTRY)
// ---------------------------------------------------------------------------

/**
 * Stable descriptions for the model-visible tool schema. They describe the
 * read-only / candidate-only nature of each tool and never promise
 * capabilities the registry does not grant.
 */
const TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
  "evidence.search":
    "Search approved evidence cards by id; read-only, returns ids and versions only.",
  "memory.lookup":
    "Look up confirmed demo memory entries for the current session; read-only.",
  "memory.propose":
    "Propose a memory candidate for trusted-adult approval; never writes directly.",
});

/**
 * The Cordis whitelist: exactly the registered safe tools, each with its
 * description. Object order follows the registry; the structure is frozen.
 */
export const CORDIS_SERVICE_WHITELIST: readonly string[] = Object.freeze(
  Object.keys(SAFE_TOOL_REGISTRY),
);

export interface CordisServiceSpecView {
  readonly toolId: string;
  readonly category: string;
  readonly version: string;
  readonly sideEffects: "none" | "read_only" | "memory_candidate";
  readonly allowedRoles: readonly string[];
  readonly permissions: readonly string[];
}

/** Reviewable view of the full surface (audit / composition-tree evidence). */
export function describeCordisSurface(): readonly CordisServiceSpecView[] {
  return Object.freeze(
    CORDIS_SERVICE_WHITELIST.map((toolId) => {
      const spec = SAFE_TOOL_REGISTRY[toolId];
      return ingestDomainFact({
        toolId: spec.toolId,
        category: spec.category,
        version: spec.version,
        sideEffects: spec.sideEffects,
        allowedRoles: Object.freeze([...spec.allowedRoles]),
        permissions: Object.freeze([...spec.permissions]),
      }) as Readonly<CordisServiceSpecView>;
    }),
  );
}

/**
 * The exact model-visible tool schema whitelist (gateway declaration form).
 *
 * The R1-02 gateway grammar for model tool names (`^[a-z][a-z0-9_-]{1,47}$`,
 * matching real provider APIs) has NO dots, while registry tool ids do
 * ("evidence.search"). The mapping is a deterministic, bijective
 * dot→underscore rename computed from the whitelist — never a second
 * hand-maintained list — and `cordisToolIdFromModelName` reverses it
 * fail-closed so a future adapter can translate model tool_call names back
 * to registry ids (unknown names → null).
 */
const MODEL_NAME_TO_TOOL_ID: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    CORDIS_SERVICE_WHITELIST.map((toolId) => [toolId.replace(/\./g, "_"), toolId]),
  ),
);

/** Reverse mapping: model-facing tool name → registry tool id (or null). */
export function cordisToolIdFromModelName(name: unknown): string | null {
  if (typeof name !== "string") {
    return null;
  }
  return Object.hasOwn(MODEL_NAME_TO_TOOL_ID, name)
    ? (MODEL_NAME_TO_TOOL_ID[name] as string)
    : null;
}

/** The exact model-visible tool schema whitelist (gateway declaration form). */
export function describeCordisToolSchema(): readonly Readonly<ModelToolDeclaration>[] {
  return Object.freeze(
    CORDIS_SERVICE_WHITELIST.map((toolId) =>
      ingestDomainFact({
        name: toolId.replace(/\./g, "_"),
        description: TOOL_DESCRIPTIONS[toolId] ?? "",
      }) as Readonly<ModelToolDeclaration>,
    ),
  );
}

/**
 * Assert a DSH port's reported composition tree against the whitelist.
 * A tool name is compliant when it is a registered tool id OR its
 * deterministic model-facing spelling (dot→underscore) — both denote the
 * same whitelisted tool. Anything else is a violation. Unknown names are
 * echoed only as `[unverified]` when they violate the id grammar — a
 * violation list is diagnostic evidence, and non-grammar names cannot be
 * registry ids by construction.
 */
export function assertAdvertisedToolsWithinWhitelist(
  advertised: readonly { readonly name: unknown; readonly description: unknown }[],
): readonly string[] {
  const violations: string[] = [];
  for (const tool of advertised) {
    const name = tool?.name;
    if (typeof name !== "string") {
      violations.push("[unverified]");
      continue;
    }
    const isRegistryId = Object.hasOwn(SAFE_TOOL_REGISTRY, name);
    const isModelName = cordisToolIdFromModelName(name) !== null;
    if (!isRegistryId && !isModelName) {
      violations.push(name);
    }
  }
  return Object.freeze(violations);
}

// ---------------------------------------------------------------------------
// Execution (tool gate → handler → structural result)
// ---------------------------------------------------------------------------

/** A tool-call candidate as submitted through the DSH tool entrance. */
export interface CordisServiceCall {
  /** Bounded caller-side correlation id; never echoed on rejection. */
  readonly callId: string;
  readonly toolId: string;
  /** Category as declared by the caller; must match the registry. */
  readonly declaredCategory: string;
  /** Version as declared by the caller; must match the registry. */
  readonly declaredVersion: string;
  readonly requestedPermissions: readonly string[];
  /** Arguments; never echoed into results or traces. */
  readonly input?: unknown;
}

/**
 * Structural handler result: ids and counts only — no payload bodies. A
 * handler receives the validated call and the verified actor role and
 * returns reference facts; anything richer (content) must never cross this
 * boundary (issue #15: Trace/结果不记录完整私人内容).
 */
export interface CordisServiceRef {
  readonly kind: "evidence" | "memory";
  readonly refId: string;
  readonly version: string | null;
}

export interface CordisServiceHandlerSuccess {
  readonly ok: true;
  readonly refs: readonly CordisServiceRef[];
  /** True only for candidate-only tools (memory.propose). */
  readonly candidateOnly: boolean;
}

export type CordisServiceHandler = (input: {
  readonly call: Readonly<CordisServiceCall>;
  readonly actorRole: ActorRole;
}) => Promise<CordisServiceHandlerSuccess>;

export type CordisServiceExecution =
  | {
      readonly status: "executed";
      readonly toolId: string;
      readonly toolVersion: string;
      readonly sideEffects: string;
      readonly refs: readonly CordisServiceRef[];
      readonly candidateOnly: boolean;
      readonly trace: Readonly<SafetyTraceRecord>;
    }
  | {
      readonly status: "rejected";
      readonly ruleIds: readonly string[];
      readonly trace: Readonly<SafetyTraceRecord>;
    }
  | {
      /** Gate allowed but no handler is bound, or the handler failed. */
      readonly status: "failed";
      readonly toolId: string;
      readonly ruleIds: readonly string[];
      readonly trace: Readonly<SafetyTraceRecord>;
    };

export interface CordisExecutionOptions {
  /** Server-verified role of the caller (never self-reported). */
  readonly actorRole: ActorRole;
  readonly refs?: { readonly requestId?: string; readonly traceId?: string; readonly turnId?: string };
  readonly decidedAt?: string;
  /**
   * Handlers for allow-listed tools. v0 ships synthetic fakes only; a
   * whitelisted tool without a handler fails closed (`failed`), it never
   * degrades into inventing a result.
   */
  readonly handlers?: Readonly<Record<string, CordisServiceHandler>>;
}

function parseCordisServiceCall(value: unknown): Readonly<CordisServiceCall> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "call", "cordis service call must be an object."),
    ]);
  }
  const record = value as Record<string, unknown>;
  const problems: ContractProblem[] = [];
  if (typeof record.callId !== "string" || record.callId.length === 0 || record.callId.length > 80) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "call.callId", "callId must be a bounded string."),
    );
  }
  let toolId: string | null = null;
  if (typeof record.toolId !== "string" || record.toolId.length === 0 || record.toolId.length > 64) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "call.toolId", "toolId must be a bounded string."));
  } else {
    toolId = record.toolId;
  }
  if (typeof record.declaredCategory !== "string" || record.declaredCategory.length === 0) {
    problems.push(
      problem("CONTRACT_FIELD_MISSING", "call.declaredCategory", "declaredCategory is required."),
    );
  }
  if (typeof record.declaredVersion !== "string" || record.declaredVersion.length === 0) {
    problems.push(
      problem("CONTRACT_FIELD_MISSING", "call.declaredVersion", "declaredVersion is required."),
    );
  }
  let requestedPermissions: string[] = [];
  if (!Array.isArray(record.requestedPermissions)) {
    problems.push(
      problem("CONTRACT_FIELD_MISSING", "call.requestedPermissions", "requestedPermissions is required."),
    );
  } else {
    for (const permission of record.requestedPermissions) {
      if (typeof permission !== "string" || permission.length === 0 || permission.length > 64) {
        problems.push(
          problem("CONTRACT_FIELD_INVALID", "call.requestedPermissions[]", "permissions must be bounded strings."),
        );
        break;
      }
    }
    requestedPermissions = record.requestedPermissions as string[];
  }
  for (const key of Object.keys(record)) {
    if (!["callId", "toolId", "declaredCategory", "declaredVersion", "requestedPermissions", "input"].includes(key)) {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", `call.${key}`, "cordis service call carries an unknown field."),
      );
    }
  }
  if (problems.length > 0 || toolId === null) {
    throw new ContractValidationError(problems.length > 0 ? problems : [
      problem("CONTRACT_FIELD_INVALID", "call.toolId", "toolId is invalid."),
    ]);
  }
  return ingestDomainFact({
    callId: record.callId as string,
    toolId,
    declaredCategory: record.declaredCategory as string,
    declaredVersion: record.declaredVersion as string,
    requestedPermissions: Object.freeze(requestedPermissions),
    input: record.input,
  }) as Readonly<CordisServiceCall>;
}

/**
 * Execute one Cordis service call through the real tool gate. Fail-closed
 * order: call shape → tool gate (whitelist, forgery, permissions, roles) →
 * handler. The submitted call (and its `input`) is never part of any
 * returned value except through gate rule ids.
 */
export async function executeCordisServiceCall(
  rawCall: unknown,
  options: CordisExecutionOptions,
): Promise<Readonly<CordisServiceExecution>> {
  const call = parseCordisServiceCall(rawCall);
  const gateResult = evaluateToolGate(
    {
      toolId: call.toolId,
      declaredCategory: call.declaredCategory,
      declaredVersion: call.declaredVersion,
      requestedPermissions: call.requestedPermissions,
      actorRole: options.actorRole,
      input: call.input,
    },
    { entrance: "dsh_tool", refs: options.refs, decidedAt: options.decidedAt },
  );
  if (gateResult.decision === "block") {
    return ingestDomainFact({
      status: "rejected",
      ruleIds: Object.freeze(gateResult.hits.map((hit) => hit.ruleId)),
      trace: gateResult.trace,
    }) as Readonly<CordisServiceExecution>;
  }

  const spec = SAFE_TOOL_REGISTRY[call.toolId];
  const handler = options.handlers?.[call.toolId];
  if (typeof handler !== "function") {
    // Whitelisted but unbound: fail closed, never invent a result.
    return ingestDomainFact({
      status: "failed",
      toolId: call.toolId,
      ruleIds: Object.freeze([] as string[]),
      trace: gateResult.trace,
    }) as Readonly<CordisServiceExecution>;
  }
  try {
    const handlerResult = await handler({ call, actorRole: options.actorRole });
    if (
      handlerResult === null ||
      typeof handlerResult !== "object" ||
      handlerResult.ok !== true ||
      !Array.isArray(handlerResult.refs)
    ) {
      return ingestDomainFact({
        status: "failed",
        toolId: call.toolId,
        ruleIds: Object.freeze([] as string[]),
        trace: gateResult.trace,
      }) as Readonly<CordisServiceExecution>;
    }
    const refs: CordisServiceRef[] = [];
    for (const ref of handlerResult.refs) {
      if (
        ref === null ||
        typeof ref !== "object" ||
        (ref.kind !== "evidence" && ref.kind !== "memory") ||
        typeof ref.refId !== "string" ||
        ref.refId.length === 0 ||
        ref.refId.length > 80 ||
        (ref.version !== null && typeof ref.version !== "string")
      ) {
        return ingestDomainFact({
          status: "failed",
          toolId: call.toolId,
          ruleIds: Object.freeze([] as string[]),
          trace: gateResult.trace,
        }) as Readonly<CordisServiceExecution>;
      }
      refs.push({ kind: ref.kind, refId: ref.refId, version: ref.version });
    }
    // Candidate-only invariant: a candidate-only tool can never report a
    // non-candidate outcome, regardless of what its handler returns.
    const candidateOnly = spec.sideEffects === "memory_candidate" ? true : handlerResult.candidateOnly === true;
    return ingestDomainFact({
      status: "executed",
      toolId: spec.toolId,
      toolVersion: spec.version,
      sideEffects: spec.sideEffects,
      refs: Object.freeze(refs.map((ref) => Object.freeze(ref))),
      candidateOnly,
      trace: gateResult.trace,
    }) as Readonly<CordisServiceExecution>;
  } catch {
    // Handler exceptions are collapsed to a static structural failure —
    // no message, stack or payload ever crosses the boundary.
    return ingestDomainFact({
      status: "failed",
      toolId: call.toolId,
      ruleIds: Object.freeze([] as string[]),
      trace: gateResult.trace,
    }) as Readonly<CordisServiceExecution>;
  }
}
