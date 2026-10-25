/**
 * Domain model of the LumiThink A2A identity & authorization layer
 * (P1-03, issue #85). Design source: docs/A2A_DESIGN.md §5–§7.
 *
 * Two-tier identity (design §5.2, 冻结):
 *   1. Client Identity — which REGISTERED client/adapter is calling
 *      (dsh_profile / feishu_adapter / xiaozhi_device).
 *   2. Principal Identity — which verified user or restricted visitor the
 *      request acts for, and with what assurance level.
 *
 * ONE bearer credential binds both tiers server-side (不叠加两种认证头).
 * userId/householdId/role carried in message metadata, and the A2A
 * `tenant`/contextId wire fields, are NEVER consulted for authorization —
 * the household scope and principal come exclusively from server-side
 * bindings (design §5.3: A2A tenant 仅用于接口路由).
 *
 * SYNTHETIC scope (P1 口径): identities, tokens and grants in this store
 * are synthetic validation data. Voiceprint recognition, channel OAuth and
 * bot rollout are NOT part of this task (issue #85 复用和边界).
 */

/** Registered client/adapter kinds (design §5.2 table). */
export type ClientKind = 'dsh_profile' | 'feishu_adapter' | 'xiaozhi_device';

/** Household membership role; effective INSIDE one household only. */
export type MembershipRole = 'guardian' | 'child' | 'member';

/**
 * Identity assurance levels (design §5.3 `assurance` + §6.2 three tiers).
 * `credential_bound` — the credential itself carries the verified principal
 *   binding (personal DSH profile).
 * `session_verified` — elevated by a short-term device-session grant issued
 *   after confirmation through a logged-in channel (design §5.2/§6.2).
 * `voiceprint_candidate` — server-side voiceprint evidence established a
 *   CANDIDATE user; never a verified principal (design §6.2: 匹配不提升为
 *   私有数据权限).
 * `unverified_visitor` — device/client authenticated, speaker unidentified;
 *   restricted common chat only.
 */
export type AssuranceLevel =
  | 'credential_bound'
  | 'session_verified'
  | 'voiceprint_candidate'
  | 'unverified_visitor';

/**
 * Centralized authorization operations (design §7 permission matrix subset).
 * The set is frozen for P1: learning stays read-only (先只读), raw
 * conversation reading requires separate explicit authorization (另设策略),
 * so its default decision is deny.
 */
export const AUTH_OPERATIONS = [
  'chat.general',
  'learning.fact.read',
  'learning.fact.write',
  'plan.read',
  'plan.write',
  'conversation.raw.read',
  'personalization.low_sensitivity.read',
  'household.admin',
] as const;

export type Operation = (typeof AUTH_OPERATIONS)[number];

/**
 * Principal resolved for one request. `userId` is present only when the
 * principal is a verified user; `candidateUserId` marks an UNVERIFIED
 * voiceprint candidate that domain tools must never treat as the operator.
 */
export type Principal =
  | {
      kind: 'bound_user';
      userId: string;
      role: MembershipRole;
      assurance: 'credential_bound';
    }
  | {
      kind: 'session_verified';
      userId: string;
      role: MembershipRole;
      assurance: 'session_verified';
      grantId: string;
    }
  | {
      kind: 'voiceprint_candidate';
      candidateUserId: string;
      assurance: 'voiceprint_candidate';
      grantId: string;
    }
  | { kind: 'visitor'; assurance: 'unverified_visitor' };

/** Server-resolved authorization context for one request (design §5.3). */
export interface AuthContext {
  credentialId: string;
  clientId: string;
  clientKind: ClientKind;
  /** Authorized household scope — from server bindings ONLY, never the wire. */
  householdId: string | null;
  principal: Principal;
  /** Revocation epoch observed at resolution time (cache coherence, AC 3). */
  revocationEpoch: number;
  resolvedAtMs: number;
}

/** A short-term grant record (device session confirmation / voiceprint candidate). */
export interface GrantRecord {
  grantId: string;
  clientId: string;
  householdId: string;
  kind: 'session_verified' | 'voiceprint_candidate';
  userId: string | null;
  candidateUserId: string | null;
  sessionBinding: string;
  scope: readonly Operation[];
  issuedAtMs: number;
  expiresAtMs: number;
  revokedAtMs: number | null;
  status: 'active' | 'revoked' | 'expired';
}

/** Who owns a persisted task/conversation, recorded at acceptance time. */
export interface TaskBinding {
  taskId: string;
  contextId: string;
  householdId: string;
  /** Verified user or candidate id; null for pure visitor tasks. */
  principalUserId: string | null;
  /** Acceptance tier of the recorded principal (schema v2). */
  principalKind: 'user' | 'candidate' | 'visitor';
  clientId: string;
  /** Visitor tasks are continued only by the same device client. */
  clientKind: ClientKind;
  /** Credential that accepted the task (schema v2) — re-validated by the output gate. */
  credentialId: string | null;
  /** Elevating grant for session_verified/candidate tasks (schema v2). */
  grantId: string | null;
  createdAtMs: number;
}

/** Minimal audit entry (design §13.2): decision facts only — no tokens, no content. */
export interface AuditEntry {
  auditId: number;
  atMs: number;
  action: string;
  decision: 'allow' | 'deny';
  reason: string;
  credentialId: string | null;
  clientId: string | null;
  principalUserId: string | null;
  householdId: string | null;
  taskId: string | null;
  contextId: string | null;
}

/** Stable identity-layer error codes (TASK_LIFECYCLE §5.2 style identifiers). */
export type IdentityErrorCode =
  | 'unknown_credential'
  | 'credential_revoked'
  | 'credential_expired'
  | 'client_disabled'
  | 'principal_membership_revoked'
  | 'principal_disabled'
  | 'grant_unknown'
  | 'grant_expired'
  | 'grant_revoked'
  | 'grant_session_mismatch'
  | 'grant_client_mismatch'
  | 'grant_household_mismatch'
  | 'task_access_denied'
  | 'context_access_denied'
  | 'invalid_input';

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  constructor(code: IdentityErrorCode, message: string) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}

export function isIdentityError(error: unknown): error is IdentityError {
  return error instanceof IdentityError;
}
