/**
 * Scoped request key + versioned request fingerprint (P1-04, issue #86;
 * TASK_LIFECYCLE §5.1).
 *
 * Unique key  = agent_id + household_id + principal_id + client_id +
 *               channel + messageId
 * Every component comes from the SERVER-resolved authenticated binding —
 * never from message metadata or A2A tenant fields (design §5.3), so a
 * caller cannot dodge dedupe by renaming itself, and two different callers
 * with the same messageId never collide.
 *
 * Fingerprint = 'fpv1:' + HMAC-SHA256(fingerprintKey, canonicalJson(message))
 *   - canonical: recursively key-sorted stable JSON (array order preserved —
 *     parts order is semantic), so a re-serialized retry with different key
 *     order still compares equal;
 *   - versioned: the 'fpv1' prefix pins the normalization rule; upgrading
 *     the rule later keeps old-ledger comparisons stable (§5.1);
 *   - HMAC with a server-persisted key: the stored fingerprint must not be
 *     an enumerable keyless digest of short messages (§5.4 指纹使用服务端
 *     持久密钥的版本化 HMAC). The P1 synthetic default key is documented in
 *     config.ts; durable deployments set their own.
 *   - content: the original Message as sent (messageId, role, parts,
 *     metadata, context/task references, referenceTaskIds). Explicitly
 *     EXCLUDED (§5.1): JSON-RPC id, tokens, returnImmediately / blocking
 *     mode, historyLength and display options — a blocking request and its
 *     immediate-mode retry fingerprint identically.
 *
 * SYNTHETIC data only (P1 口径): keys/fingerprints cover ids and synthetic
 * validation text; no real child content may flow through this service.
 */
import { createHmac } from 'node:crypto';
import type { AuthContext } from '../identity/model.ts';

/** The agent identity component of the request key (single-agent policy). */
export type RequestKeyComponents = {
  agentName: string;
  auth: AuthContext;
  messageId: string;
};

function principalIdOf(auth: AuthContext): string {
  const principal = auth.principal;
  if (principal.kind === 'bound_user' || principal.kind === 'session_verified') {
    return principal.userId;
  }
  if (principal.kind === 'voiceprint_candidate') {
    return `candidate:${principal.candidateUserId}`;
  }
  // Unverified visitor: the stable restricted subject IS the device/client
  // binding (§5.1 设备未验证用户使用稳定的受限主体) — never a shared pool.
  return `visitor:${auth.clientId}`;
}

/**
 * Canonical request key. JSON-array encoding is injective on string tuples
 * (control characters are escaped), so delimiter-colliding messageIds cannot
 * map two different compositions onto one key.
 */
export function requestKeyOf(components: RequestKeyComponents): string {
  const { agentName, auth, messageId } = components;
  return JSON.stringify([
    agentName,
    auth.householdId ?? '',
    principalIdOf(auth),
    auth.clientId,
    // Channel = the authenticated client kind (dsh_profile / feishu_adapter /
    // xiaozhi_device); device & feishu channels enter through the same
    // trusted entry with their own registered clients (design §5.2).
    auth.clientKind,
    messageId,
  ]);
}

/** Recursively key-sorted JSON (arrays keep order). Deterministic encoding. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * Versioned HMAC fingerprint of the raw (wire-shaped) message object. The
 * raw object is canonicalized as received — the fingerprint pins WHAT the
 * client sent, and any content change (same key, different body) conflicts.
 */
export function fingerprintOf(rawMessage: unknown, fingerprintKey: string): string {
  const canonical = canonicalJson({
    v: 1,
    message: rawMessage,
  });
  return `fpv1:${createHmac('sha256', fingerprintKey).update(canonical, 'utf8').digest('hex')}`;
}
