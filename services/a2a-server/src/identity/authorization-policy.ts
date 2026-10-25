/**
 * Centralized authorization policy (P1-03, issue #85; design §7).
 *
 * ONE policy function decides "same-household shared facts by relationship
 * and operation" (AC 2) and the device/voiceprint permission ceiling
 * (AC 4). It is PURE: every input is server-resolved (AuthContext,
 * membership role, relationship state); there is NO parameter a caller
 * could use to inject a claimed userId/householdId/role from the wire —
 * that is the AC 1 anti-forgery property by construction.
 *
 * P1 stance (design §2.3/§7.2, 先只读): learning/plan WRITE operations are
 * denied for everyone; raw conversation reading is denied (另设策略,
 * 单独授权); household administration stays guardian-only.
 */
import type { AuthContext, Operation } from './model.ts';

export interface PolicyInput {
  /** Server-resolved request identity. */
  auth: AuthContext;
  /** Operation being authorized (server-chosen, never wire-supplied). */
  operation: Operation;
  /** Target household — must equal the authorized scope (tenant isolation). */
  targetHouseholdId: string;
  /** Target subject user (whose data is touched); undefined for household-level ops. */
  targetSubjectUserId?: string;
  /** Active guardian→child relationship of the CALLER inside the household (server-resolved). */
  callerHasGuardianRelationship?: boolean;
}

export type PolicyDecision =
  | { allowed: true; reason: string }
  | { allowed: false; reason: string };

const allow = (reason: string): PolicyDecision => ({ allowed: true, reason });
const deny = (reason: string): PolicyDecision => ({ allowed: false, reason });

/** The shared-device low-sensitivity allowlist (design §6.2). */
export const LOW_SENSITIVITY_OPERATIONS: readonly Operation[] = [
  'chat.general',
  'personalization.low_sensitivity.read',
];

/**
 * Decides one operation. Rules follow design §7.2 with the P1 freeze:
 * verified = bound_user | session_verified; voiceprint candidates and
 * unverified visitors never reach private data.
 */
export function authorizeOperation(input: PolicyInput): PolicyDecision {
  const { auth, operation, targetHouseholdId, targetSubjectUserId } = input;

  // Tenant isolation first: the household scope comes from server bindings;
  // a different target household is denied regardless of who asks (AC 1/AC 2).
  if (auth.householdId === null || auth.householdId !== targetHouseholdId) {
    return deny('cross_household_denied');
  }

  const principal = auth.principal;

  if (principal.kind === 'visitor') {
    // 未识别: 通用陪伴聊天 only; no private reads, no personal writes.
    return operation === 'chat.general'
      ? allow('visitor_restricted_chat')
      : deny('unverified_visitor_private_denied');
  }

  if (principal.kind === 'voiceprint_candidate') {
    // 候选声纹不提升私有数据权限 (AC 4): only the low-sensitivity allowlist,
    // and personalization only for the candidate's OWN profile.
    if (operation === 'chat.general') return allow('candidate_restricted_chat');
    if (
      operation === 'personalization.low_sensitivity.read' &&
      targetSubjectUserId === principal.candidateUserId
    ) {
      return allow('candidate_own_low_sensitivity');
    }
    return deny('voiceprint_candidate_private_denied');
  }

  // Verified principal from here (bound_user | session_verified).
  const callerUserId = principal.userId;
  const role = principal.role;
  const isSelf = targetSubjectUserId === undefined || targetSubjectUserId === callerUserId;

  switch (operation) {
    case 'chat.general':
      return allow('member_chat');
    case 'personalization.low_sensitivity.read':
      return isSelf ? allow('own_low_sensitivity') : deny('personalization_other_denied');
    case 'learning.fact.read': {
      if (isSelf) return allow('own_learning_read');
      if (role === 'guardian' && input.callerHasGuardianRelationship === true) {
        return allow('guardian_child_learning_read');
      }
      return deny('learning_read_requires_guardian_relationship');
    }
    case 'plan.read': {
      if (isSelf) return allow('own_plan_read');
      if (role === 'guardian' && input.callerHasGuardianRelationship === true) {
        return allow('guardian_child_plan_read');
      }
      return deny('plan_read_requires_guardian_relationship');
    }
    case 'learning.fact.write':
    case 'plan.write':
      // P1 freeze: 学习业务先提供只读查询 (design §2.3); writes open later
      // only after source/permission verification.
      return deny('write_not_open_p1');
    case 'conversation.raw.read':
      // 原始对话默认拒绝 (design §7.2): separate explicit authorization only.
      return deny('conversation_raw_read_not_authorized');
    case 'household.admin':
      return role === 'guardian'
        ? allow('guardian_admin')
        : deny('household_admin_requires_guardian');
    default: {
      // Exhaustiveness guard: an unknown operation is denied fail-closed.
      return deny('unknown_operation_denied');
    }
  }
}

/**
 * Grant-scope check for grant-elevated principals (session_verified /
 * voiceprint_candidate): the operation must be inside the grant's scope,
 * which is itself capped by the low-sensitivity/device rules above.
 */
export function authorizeGrantScopedOperation(
  input: PolicyInput,
  grantScope: readonly Operation[],
): PolicyDecision {
  const base = authorizeOperation(input);
  if (!base.allowed) return base;
  if (!grantScope.includes(input.operation)) {
    return { allowed: false, reason: 'operation_outside_grant_scope' };
  }
  return base;
}
