/**
 * R1-V3 Voice Gateway Adapter — trusted device binding registry (issue #30
 * 实现范围 1: 设备可信绑定; docs/VOICE_GATEWAY_PROTOCOL.md §3).
 *
 * Identity model:
 * - A device is bound to a child conversation ONLY by a guardian-issued
 *   activation (recorded here as a content-free hex digest of the activation
 *   secret — the secret itself never enters this layer). A device that is
 *   not bound, or presents a different activation digest, can never obtain
 *   the child session (issue #30 验收: 变更 device_id/冒用 session_id 无法
 *   获得儿童会话授权).
 * - Each device holds at most ONE open connection lease. A second concurrent
 *   connection for the same device is refused (`device_connection_conflict`)
 *   — duplicate device connections cannot fork the session.
 * - The xiaozhi `session_id` is an EPHEMERAL per-connection handle minted by
 *   the server. It is recorded only as a connection-scoped mapping check and
 *   is NEVER a child identity: reconnecting mints a new mapping while the
 *   conversation/owner stay bound to the device (issue #30: 不把小智连接
 *   session_id 当作儿童永久身份).
 * - Every inbound event is authorized against (connection, issued session,
 *   session key). A forged or foreign session id is rejected enumerated.
 *
 * PRIVACY: bindings and mappings are content-free (grammar-checked ids,
 * hex digests, timestamps, states only).
 *
 * This module must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { ingestDomainFact } from "../../legacy-guard.ts";
import { validateVoiceRefs } from "../schema.ts";
import {
  GATEWAY_ACTIVATION_DIGEST_PATTERN,
  XIAOZHI_DEVICE_ID_PATTERN,
  XIAOZHI_SESSION_ID_PATTERN,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** One guardian-issued device binding (content-free). */
export interface GatewayDeviceBinding {
  readonly deviceId: string;
  readonly actorId: string;
  readonly conversationId: string;
  /** Hex digest of the activation secret; the secret never enters here. */
  readonly activationDigest: string;
  readonly boundAtMs: number;
  readonly reboundAtMs: number | null;
}

/** One open (or closed) connection lease. */
export interface GatewayConnectionLease {
  readonly connectionId: string;
  readonly deviceId: string;
  readonly openedAtMs: number;
  readonly closed: boolean;
  readonly closedAtMs: number | null;
  readonly closedReason: string | null;
}

/** One connection-scoped xiaozhi session mapping (EPHEMERAL handle only). */
export interface GatewaySessionMapping {
  readonly sessionKey: string;
  readonly deviceId: string;
  readonly connectionId: string;
  readonly xiaozhiSessionId: string;
  readonly issuedAtMs: number;
}

export type GatewayBindingCode =
  | "device_unbound"
  | "device_connection_conflict"
  | "device_rebinding_denied"
  | "connection_unknown"
  | "connection_closed"
  | "session_not_mapped"
  | "session_forged"
  | "cross_session_rejected"
  | "binding.parse_failed";

export type GatewayBindingResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: GatewayBindingCode };

export interface GatewayBindingRegistryOptions {
  readonly clock?: () => number;
  /** Max bound devices (bounded memory; ring-like eviction is NOT allowed — fail instead). */
  readonly maxBindings?: number;
  /** Max tracked connections (closed leases are tombstones for replay). */
  readonly maxConnections?: number;
}

// ---------------------------------------------------------------------------
// Fail-closed helpers
// ---------------------------------------------------------------------------

function failBindingParse(path: string, message: string): never {
  throw new Error(`binding.${path}: ${message}`);
}

function requireStringField(record: Record<string, unknown>, field: string, pattern: RegExp, what: string): string {
  const value = record[field];
  if (typeof value !== "string" || !pattern.test(value)) {
    failBindingParse(`${what}.${field}`, `${field} must match its bounded grammar.`);
  }
  return value as string;
}

function rejectUnknownBindingFields(record: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      failBindingParse(`${what}.${key}`, "unknown field.");
    }
  }
}

function requireContractRefs(
  refs: { readonly sessionKey?: unknown; readonly actorId?: unknown; readonly conversationId?: unknown },
  what: string,
): void {
  const problems: Parameters<typeof validateVoiceRefs>[1] = [];
  validateVoiceRefs(refs, problems);
  if (problems.length > 0) {
    failBindingParse(what, problems.map((p) => `${p.path}: ${p.message}`).join("; "));
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface GatewayDeviceBindingRegistry {
  /** Guardian-issued binding (or re-bind of the same device with the SAME activation digest). */
  bindDevice(refs: {
    readonly deviceId: unknown;
    readonly actorId: unknown;
    readonly conversationId: unknown;
    readonly activationDigest: unknown;
  }): GatewayBindingResult<{ readonly created: boolean }>;
  /** Open one connection lease for a bound device (one lease per device). */
  openConnection(refs: { readonly connectionId: unknown; readonly deviceId: unknown }): GatewayBindingResult<{ readonly leased: true }>;
  /** Record the connection-scoped session mapping (called on session_issued). */
  issueSession(refs: {
    readonly connectionId: unknown;
    readonly sessionKey: unknown;
    readonly xiaozhiSessionId: unknown;
  }): GatewayBindingResult<{ readonly mapping: GatewaySessionMapping }>;
  /**
   * Authorize one inbound event: the connection must be open and leased, a
   * session must have been issued on it, and (sessionKey, xiaozhiSessionId)
   * must match the issued mapping exactly.
   */
  authorize(refs: {
    readonly connectionId: unknown;
    readonly xiaozhiSessionId: unknown;
    readonly sessionKey?: unknown;
  }): GatewayBindingResult<{ readonly mapping: GatewaySessionMapping }>;
  /** Close one connection lease (drop/device close/restart). */
  closeConnection(refs: { readonly connectionId: unknown; readonly reason: unknown }): GatewayBindingResult<{ readonly closed: true }>;
  /** Invalidate every lease and mapping (server restart fault). */
  closeAllConnections(refs: { readonly reason: unknown }): { readonly closed: number };
  readonly hasOpenConnection: (deviceId: string) => boolean;
  readonly findSessionKeyByDevice: (deviceId: string) => string | null;
  readonly describeBinding: (deviceId: string) => Readonly<GatewayDeviceBinding> | null;
  /** Content-free snapshots (ids, digests, timestamps, states only). */
  readonly bindingSnapshot: () => readonly Readonly<GatewayDeviceBinding>[];
  readonly connectionSnapshot: () => readonly Readonly<GatewayConnectionLease>[];
  readonly mappingSnapshot: () => readonly Readonly<GatewaySessionMapping>[];
}

export function createGatewayDeviceBindingRegistry(
  options: GatewayBindingRegistryOptions = {},
): GatewayDeviceBindingRegistry {
  if (options === null || typeof options !== "object") {
    failBindingParse("options", "registry options must be an object.");
  }
  const clock = options.clock ?? (() => Date.now());
  const maxBindings = Math.max(1, Math.min(options.maxBindings ?? 256, 65_536));
  const maxConnections = Math.max(1, Math.min(options.maxConnections ?? 1024, 65_536));

  const bindings = new Map<string, GatewayDeviceBinding>();
  const connections = new Map<string, GatewayConnectionLease>();
  const mappings = new Map<string, GatewaySessionMapping>(); // key: connectionId
  const openByDevice = new Map<string, string>(); // deviceId -> connectionId

  function parseBindDevice(refs: unknown): {
    deviceId: string;
    actorId: string;
    conversationId: string;
    activationDigest: string;
  } {
    if (refs === null || typeof refs !== "object") {
      failBindingParse("bindDevice", "refs must be an object.");
    }
    const record = refs as Record<string, unknown>;
    rejectUnknownBindingFields(record, ["deviceId", "actorId", "conversationId", "activationDigest"], "bindDevice");
    const deviceId = requireStringField(record, "deviceId", XIAOZHI_DEVICE_ID_PATTERN, "bindDevice");
    requireContractRefs(
      { actorId: record.actorId, conversationId: record.conversationId },
      "bindDevice",
    );
    const activationDigest = requireStringField(
      record,
      "activationDigest",
      GATEWAY_ACTIVATION_DIGEST_PATTERN,
      "bindDevice",
    );
    return {
      deviceId,
      actorId: record.actorId as string,
      conversationId: record.conversationId as string,
      activationDigest,
    };
  }

  function parseConnectionId(refs: unknown, what: string): string {
    if (refs === null || typeof refs !== "object") {
      failBindingParse(what, "refs must be an object.");
    }
    const record = refs as Record<string, unknown>;
    const value = record.connectionId;
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/.test(value)) {
      failBindingParse(`${what}.connectionId`, "connectionId must match the bounded grammar.");
    }
    return value;
  }

  const registry: GatewayDeviceBindingRegistry = {
    bindDevice(refs) {
      const parsed = parseBindDevice(refs);
      const existing = bindings.get(parsed.deviceId);
      const nowMs = clock();
      if (existing) {
        if (existing.activationDigest !== parsed.activationDigest) {
          // A different activation digest must never silently re-bind a
          // device to (another) child conversation.
          return { ok: false, code: "device_rebinding_denied" };
        }
        if (existing.actorId !== parsed.actorId || existing.conversationId !== parsed.conversationId) {
          return { ok: false, code: "device_rebinding_denied" };
        }
        const updated = ingestDomainFact({
          ...existing,
          reboundAtMs: nowMs,
        }) as Readonly<GatewayDeviceBinding>;
        bindings.set(parsed.deviceId, updated);
        return { ok: true, value: { created: false } };
      }
      if (bindings.size >= maxBindings) {
        return { ok: false, code: "binding.parse_failed" };
      }
      const binding = ingestDomainFact({
        deviceId: parsed.deviceId,
        actorId: parsed.actorId,
        conversationId: parsed.conversationId,
        activationDigest: parsed.activationDigest,
        boundAtMs: nowMs,
        reboundAtMs: null,
      }) as Readonly<GatewayDeviceBinding>;
      bindings.set(parsed.deviceId, binding);
      return { ok: true, value: { created: true } };
    },

    openConnection(refs) {
      const connectionId = parseConnectionId(refs, "openConnection");
      const record = refs as Record<string, unknown>;
      rejectUnknownBindingFields(record, ["connectionId", "deviceId"], "openConnection");
      const deviceId = requireStringField(record, "deviceId", XIAOZHI_DEVICE_ID_PATTERN, "openConnection");
      const binding = bindings.get(deviceId);
      if (!binding) {
        return { ok: false, code: "device_unbound" };
      }
      const existingLease = openByDevice.get(deviceId);
      if (existingLease !== undefined && connections.get(existingLease)?.closed === false) {
        // Duplicate device connection: refused, the first lease holds.
        return { ok: false, code: "device_connection_conflict" };
      }
      if (connections.has(connectionId)) {
        return { ok: false, code: "device_connection_conflict" };
      }
      if (connections.size >= maxConnections) {
        return { ok: false, code: "binding.parse_failed" };
      }
      const lease = ingestDomainFact({
        connectionId,
        deviceId,
        openedAtMs: clock(),
        closed: false,
        closedAtMs: null,
        closedReason: null,
      }) as Readonly<GatewayConnectionLease>;
      connections.set(connectionId, lease);
      openByDevice.set(deviceId, connectionId);
      return { ok: true, value: { leased: true } };
    },

    issueSession(refs) {
      const connectionId = parseConnectionId(refs, "issueSession");
      const record = refs as Record<string, unknown>;
      rejectUnknownBindingFields(record, ["connectionId", "sessionKey", "xiaozhiSessionId"], "issueSession");
      requireContractRefs({ sessionKey: record.sessionKey }, "issueSession");
      const xiaozhiSessionId = requireStringField(
        record,
        "xiaozhiSessionId",
        XIAOZHI_SESSION_ID_PATTERN,
        "issueSession",
      );
      const lease = connections.get(connectionId);
      if (!lease) {
        return { ok: false, code: "connection_unknown" };
      }
      if (lease.closed) {
        return { ok: false, code: "connection_closed" };
      }
      const mapping = ingestDomainFact({
        sessionKey: record.sessionKey as string,
        deviceId: lease.deviceId,
        connectionId,
        xiaozhiSessionId,
        issuedAtMs: clock(),
      }) as Readonly<GatewaySessionMapping>;
      mappings.set(connectionId, mapping);
      return { ok: true, value: { mapping } };
    },

    authorize(refs) {
      const connectionId = parseConnectionId(refs, "authorize");
      const record = refs as Record<string, unknown>;
      rejectUnknownBindingFields(
        record,
        ["connectionId", "xiaozhiSessionId", ...(record.sessionKey !== undefined ? ["sessionKey"] : [])],
        "authorize",
      );
      const lease = connections.get(connectionId);
      if (!lease) {
        return { ok: false, code: "connection_unknown" };
      }
      if (lease.closed) {
        return { ok: false, code: "connection_closed" };
      }
      if (record.xiaozhiSessionId === undefined || record.xiaozhiSessionId === null) {
        return { ok: false, code: "session_not_mapped" };
      }
      const mapping = mappings.get(connectionId);
      if (!mapping) {
        return { ok: false, code: "session_not_mapped" };
      }
      if (record.xiaozhiSessionId !== mapping.xiaozhiSessionId) {
        return { ok: false, code: "session_forged" };
      }
      if (record.sessionKey !== undefined && record.sessionKey !== null && record.sessionKey !== mapping.sessionKey) {
        return { ok: false, code: "cross_session_rejected" };
      }
      return { ok: true, value: { mapping } };
    },

    closeConnection(refs) {
      const connectionId = parseConnectionId(refs, "closeConnection");
      const record = refs as Record<string, unknown>;
      const reason = record.reason;
      if (typeof reason !== "string" || reason.length === 0 || reason.length > 32) {
        failBindingParse("closeConnection.reason", "reason must be a bounded string.");
      }
      const lease = connections.get(connectionId);
      if (!lease) {
        return { ok: false, code: "connection_unknown" };
      }
      if (!lease.closed) {
        const closed = ingestDomainFact({
          ...lease,
          closed: true,
          closedAtMs: clock(),
          closedReason: reason,
        }) as Readonly<GatewayConnectionLease>;
        connections.set(connectionId, closed);
        if (openByDevice.get(lease.deviceId) === connectionId) {
          openByDevice.delete(lease.deviceId);
        }
        mappings.delete(connectionId);
      }
      return { ok: true, value: { closed: true } };
    },

    closeAllConnections(refs) {
      const reason = (refs as Record<string, unknown> | null)?.reason;
      if (typeof reason !== "string" || reason.length === 0 || reason.length > 32) {
        failBindingParse("closeAllConnections.reason", "reason must be a bounded string.");
      }
      let closed = 0;
      for (const connectionId of [...connections.keys()]) {
        const lease = connections.get(connectionId);
        if (lease && !lease.closed) {
          const closedLease = ingestDomainFact({
            ...lease,
            closed: true,
            closedAtMs: clock(),
            closedReason: reason,
          }) as Readonly<GatewayConnectionLease>;
          connections.set(connectionId, closedLease);
          mappings.delete(connectionId);
          closed += 1;
        }
      }
      openByDevice.clear();
      return { closed };
    },

    hasOpenConnection: (deviceId) => {
      const connectionId = openByDevice.get(deviceId);
      return connectionId !== undefined && connections.get(connectionId)?.closed === false;
    },

    findSessionKeyByDevice: (deviceId) => {
      const connectionId = openByDevice.get(deviceId);
      if (connectionId === undefined) {
        return null;
      }
      return mappings.get(connectionId)?.sessionKey ?? null;
    },

    describeBinding: (deviceId) => bindings.get(deviceId) ?? null,

    bindingSnapshot: () => Object.freeze([...bindings.values()]),
    connectionSnapshot: () => Object.freeze([...connections.values()]),
    mappingSnapshot: () => Object.freeze([...mappings.values()]),
  };
  return registry;
}
