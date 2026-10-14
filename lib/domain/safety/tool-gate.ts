/**
 * R1-15 Tool Gate (docs/SAFETY_POLICY.md §4.2, HARNESS §4 工具接口).
 *
 * Positive whitelist enforcement before any tool executes: dangerous
 * categories/permissions are forbidden outright, tools must be registered,
 * a submitted descriptor must match the registered one (schema forgery),
 * requested permissions must be a subset of the registered tool's own
 * permission set (permission overreach), memory writes only exist as
 * candidate-only proposals, and the verified actor role must be allowed.
 * Everything fails closed; a refusal never
 * relies on prompt-level constraints instead of permissions.
 *
 * Continues the R0 conclusion (poc/dsh-child): the child profile has no
 * shell/PTY, no general FS, no arbitrary network, no plugin install and no
 * unauthorized sub-agents.
 */

import { ACTOR_ROLES, type ActorRole } from "../contract/actor.ts";
import { ContractValidationError, problem } from "../contract/core.ts";

import type { SafetyEntrance, SafetyRuleHit, SafetyRuleId } from "./policy.ts";
import { buildSafetyTrace, type SafetyTraceRecord, type SafetyTraceRefs } from "./trace.ts";

/** A registered, allow-listed business tool (v0: synthetic fakes). */
export interface SafeToolSpec {
  readonly toolId: string;
  readonly category: string;
  readonly version: string;
  readonly allowedRoles: readonly ActorRole[];
  readonly permissions: readonly string[];
  /** How the tool may affect the world; v0 uses read-only/candidate-only. */
  readonly sideEffects: "none" | "read_only" | "memory_candidate";
}

/** Valid toolId shape (lowercase, dot/underscore/dash separated). */
export const TOOL_ID_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/;

/**
 * Categories that must never execute in the child environment
 * (PRD §5.0 最小权限, ARCHITECTURE §5.4).
 */
export const DANGEROUS_TOOL_CATEGORIES: readonly string[] = Object.freeze([
  "shell",
  "arbitrary_fs",
  "arbitrary_network",
  "plugin_install",
  "subagent_spawn",
  "raw_db",
  "memory_write",
]);

/**
 * Permissions that are forbidden regardless of what the tool claims to be.
 * child_data.export / raw_audio.read are privacy violations (PRD §10.1);
 * memory.direct_write bypasses the candidate/approval path.
 */
export const DANGEROUS_PERMISSIONS: readonly string[] = Object.freeze([
  "shell.exec",
  "pty.open",
  "fs.read",
  "fs.write",
  "net.fetch",
  "net.connect",
  "plugin.install",
  "subagent.spawn",
  "db.raw_sql",
  "memory.direct_write",
  "child_data.export",
  "raw_audio.read",
]);

/**
 * The registry is a NULL-PROTOTYPE frozen map and every lookup goes through
 * `Object.hasOwn` (carried #27 review hard precondition, fixed for R1-05
 * wiring): with a plain object, a crafted toolId such as "constructor" or
 * "toString" inherited `Object.prototype` members, was misread as
 * "registered", and then crashed the gate with a bare TypeError — fail-
 * closed in effect, but unstructured. Registered ids are own data properties
 * only; prototype-chain names are unregistered like any other id.
 */
const REGISTRY_ENTRIES: Readonly<Record<string, SafeToolSpec>> = Object.freeze(
  (() => {
    const map: Record<string, SafeToolSpec> = Object.create(null);
    map["evidence.search"] = {
      toolId: "evidence.search",
      category: "evidence_read",
      version: "1.0",
      allowedRoles: ["child", "guardian", "system"],
      permissions: ["evidence.read"],
      sideEffects: "read_only",
    };
    map["memory.lookup"] = {
      toolId: "memory.lookup",
      category: "memory_read",
      version: "1.0",
      allowedRoles: ["child", "guardian", "system"],
      permissions: ["memory.read"],
      sideEffects: "read_only",
    };
    map["memory.propose"] = {
      toolId: "memory.propose",
      category: "memory_propose",
      version: "1.0",
      allowedRoles: ["child", "guardian", "system"],
      permissions: ["memory.propose"],
      sideEffects: "memory_candidate",
    };
    return map;
  })(),
);

/**
 * v0 whitelist (HARNESS §4 业务工具候选): read-only evidence search,
 * controlled memory lookup and the candidate-only memory proposal. First
 * versions are synthetic fake implementations; the gate is data-driven so
 * new tools register here and re-run the gate tests.
 */
export const SAFE_TOOL_REGISTRY: Readonly<Record<string, SafeToolSpec>> =
  Object.freeze(REGISTRY_ENTRIES);

/** A tool call candidate submitted by any entrance (DSH tool adapter, etc.). */
export interface ToolCallCandidate {
  readonly toolId: string;
  /** Category as declared by the caller; must match the registry. */
  readonly declaredCategory: string;
  /** Version as declared by the caller; must match the registry. */
  readonly declaredVersion: string;
  readonly requestedPermissions: readonly string[];
  /** Server-verified role of the caller (never self-reported as trusted). */
  readonly actorRole: ActorRole;
  /** Arguments; never echoed into results or traces. */
  readonly input?: unknown;
}

export interface ToolGateResult {
  readonly decision: "allow" | "block";
  readonly hits: readonly SafetyRuleHit[];
  readonly trace: Readonly<SafetyTraceRecord>;
}

export interface ToolGateOptions {
  readonly entrance?: SafetyEntrance;
  readonly refs?: Readonly<SafetyTraceRefs>;
  readonly decidedAt?: string;
}

function isDangerousCategory(category: string): boolean {
  return DANGEROUS_TOOL_CATEGORIES.includes(category);
}

function requestedDangerousPermissions(
  requested: readonly string[],
): { dangerous: string[]; memoryWrite: boolean; privacy: boolean } {
  const dangerous: string[] = [];
  let memoryWrite = false;
  let privacy = false;
  for (const permission of requested) {
    if (permission === "memory.direct_write") {
      memoryWrite = true;
      continue;
    }
    if (permission === "child_data.export" || permission === "raw_audio.read") {
      privacy = true;
      continue;
    }
    if (DANGEROUS_PERMISSIONS.includes(permission)) {
      dangerous.push(permission);
    }
  }
  return { dangerous, memoryWrite, privacy };
}

/**
 * Evaluate one tool call candidate against the tool layer. Accumulates all
 * matched rules, then blocks when any rule hit. `input` is accepted but
 * never echoed (structured rule ids only).
 */
export function evaluateToolGate(
  candidate: ToolCallCandidate,
  options: ToolGateOptions = {},
): ToolGateResult {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "candidate", "tool gate expects a candidate object."),
    ]);
  }
  if (typeof candidate.actorRole !== "string" || !(ACTOR_ROLES as readonly string[]).includes(candidate.actorRole)) {
    throw new ContractValidationError([
      problem(
        "CONTRACT_FIELD_INVALID",
        "actorRole",
        "tool gate requires a verified actor role from the role registry.",
      ),
    ]);
  }
  if (!Array.isArray(candidate.requestedPermissions)) {
    throw new ContractValidationError([
      problem(
        "CONTRACT_FIELD_INVALID",
        "requestedPermissions",
        "requestedPermissions must be an array of strings.",
      ),
    ]);
  }

  const hits: SafetyRuleHit[] = [];
  const push = (ruleId: SafetyRuleId) => hits.push(Object.freeze({ ruleId, layer: "tool" as const, severity: "high" as const }));

  const toolId = candidate.toolId;
  if (
    typeof toolId !== "string" ||
    !TOOL_ID_PATTERN.test(toolId) ||
    !Object.hasOwn(SAFE_TOOL_REGISTRY, toolId)
  ) {
    // Unregistered tools are refused without echoing the submitted id.
    push("tool.unregistered");
  }

  if (typeof candidate.declaredCategory === "string" && isDangerousCategory(candidate.declaredCategory)) {
    push("tool.dangerous_category");
  }

  // Permission handling is fail-closed: non-string entries are a malformed
  // descriptor (schema forgery), never silently dropped — a dropped entry
  // would let an attacker smuggle semantics past the gate (issue #27 AC 1,
  // review round 1 P1-1).
  const requested: string[] = [];
  for (const permission of candidate.requestedPermissions) {
    if (typeof permission === "string") {
      requested.push(permission);
    } else {
      push("tool.schema_forgery");
    }
  }
  const dangerous = requestedDangerousPermissions(requested);
  if (dangerous.memoryWrite) {
    push("tool.memory_write_unauthorized");
  }
  if (dangerous.privacy) {
    push("tool.privacy_overreach");
  }
  if (dangerous.dangerous.length > 0) {
    push("tool.dangerous_category");
  }

  const registered =
    typeof toolId === "string" && Object.hasOwn(SAFE_TOOL_REGISTRY, toolId)
      ? SAFE_TOOL_REGISTRY[toolId]
      : undefined;
  if (registered !== undefined) {
    if (candidate.declaredCategory !== registered.category || candidate.declaredVersion !== registered.version) {
      push("tool.schema_forgery");
    }
    if (!registered.allowedRoles.includes(candidate.actorRole)) {
      push("tool.privacy_overreach");
    }
    // Positive permission whitelist (SAFETY_POLICY.md §4.2): a registered
    // tool may only request permissions from its own registered permission
    // set. Anything else is a privilege-escalation attempt and blocks.
    for (const permission of requested) {
      if (!registered.permissions.includes(permission)) {
        push("tool.permission_overreach");
        break;
      }
    }
  }

  const decision: ToolGateResult["decision"] = hits.length > 0 ? "block" : "allow";
  // Same rule may be matched by several checks; dedupe while keeping order.
  const uniqueHits: SafetyRuleHit[] = [];
  for (const hit of hits) {
    if (!uniqueHits.some((existing) => existing.ruleId === hit.ruleId)) {
      uniqueHits.push(hit);
    }
  }
  const trace = buildSafetyTrace({
    layer: "tool",
    decision,
    ruleIds: uniqueHits.map((hit) => hit.ruleId),
    reason: "rule_hit",
    entrance: options.entrance,
    refs: options.refs,
    decidedAt: options.decidedAt,
  });

  return Object.freeze({ decision, hits: Object.freeze(uniqueHits), trace });
}
