/**
 * Trusted identity resolution for the A2A validation service
 * (P1-03, issue #85; design §5.2/§5.3).
 *
 * resolve(token, sessionGrantId?) performs the two-tier resolution:
 *   Client tier     — the credential's registered client (must be active).
 *   Principal tier  — bound principal user (membership re-checked per
 *                     request) or a restricted visitor elevated ONLY by a
 *                     valid short-term grant (scope + expiry + session
 *                     binding + client binding).
 *
 * Decision cache (AC 3 缓存): keyed by token digest, validated against the
 * store's `revocation_epoch` and the cached entry's own expiry. Any
 * revocation (credential/membership/grant) or re-seed bumps the epoch, so a
 * cached decision can never outlive the revocation that should kill it.
 *
 * The executor gate (工具提交) re-checks the CURRENT server-side state of a
 * task's owning credential before each output admission — this is the
 * TASK_LIFECYCLE §8 contract: 权限撤销由身份服务提高绑定或策略版本，Task
 * Manager 关闭受影响结果准入并发起内部取消.
 */
import type {
  AuthContext,
  GrantRecord,
  Operation,
} from './model.ts';
import { authorizeGrantScopedOperation, authorizeOperation } from './authorization-policy.ts';
import { sha256Hex } from './schema.ts';
import type { IdentityStore } from './identity-store.ts';

export type ResolveOutcome =
  | { kind: 'denied'; code: string; message: string }
  | { kind: 'authorized'; auth: AuthContext };

interface CacheEntry {
  outcome: ResolveOutcome;
  epoch: number;
  /** Wall-clock point after which the entry is stale regardless of epoch. */
  staleAtMs: number;
}

export interface AuthorizerOptions {
  store: IdentityStore;
  /** Decision-cache upper bound per entry (never longer than the design §5.2 5-minute adapter-credential ceiling). */
  cacheTtlMs?: number;
  now?: () => number;
}

export class Authorizer {
  private readonly store: IdentityStore;
  private readonly cacheTtlMs: number;
  private readonly nowFn: () => number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: AuthorizerOptions) {
    this.store = options.store;
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.nowFn = options.now ?? (() => Date.now());
  }

  /** Test/diagnostics visibility: current decision-cache size. */
  get cacheSize(): number {
    return this.cache.size;
  }

  private now(): number {
    return this.nowFn();
  }

  /**
   * Resolves the presented bearer credential into an AuthContext, or a
   * stable denial. Base decisions may come from the epoch-validated cache;
   * grant-elevated resolutions are always fresh and NEVER cached (the
   * session headers are per-request state — caching them would let one
   * elevated request poison later un-elevated ones).
   *
   * Grant references (design §5.2: 授权绑定…连接代际、会话) require BOTH the
   * grant id and the matching session binding; a grant id without its
   * binding, or with a stale one, is denied fail-closed.
   */
  resolve(
    token: string,
    sessionGrantId?: string | null,
    sessionBinding?: string | null,
  ): ResolveOutcome {
    const digest = sha256Hex(token);
    if (sessionGrantId) {
      return this.resolveFresh(token, digest, sessionGrantId, sessionBinding ?? null);
    }
    const epoch = this.store.revocationEpoch;
    const cached = this.cache.get(digest);
    if (cached && cached.epoch === epoch && cached.staleAtMs > this.now()) {
      return cached.outcome;
    }
    const outcome = this.resolveFresh(token, digest, undefined, undefined);
    this.cache.set(digest, {
      outcome,
      epoch,
      staleAtMs: Math.min(this.now() + this.cacheTtlMs, this.minCacheExpiry(outcome)),
    });
    return outcome;
  }

  /** Cache entries must not outlive the credential/grant expiry they encode. */
  private minCacheExpiry(outcome: ResolveOutcome): number {
    if (outcome.kind === 'authorized') {
      const auth = outcome.auth;
      const credential = this.store.findCredentialById(auth.credentialId);
      let min = credential?.expiresAtMs ?? Number.MAX_SAFE_INTEGER;
      if (
        auth.principal.kind === 'session_verified' ||
        auth.principal.kind === 'voiceprint_candidate'
      ) {
        const grant = this.store.findGrant(auth.principal.grantId);
        if (grant) min = Math.min(min, grant.expiresAtMs);
      }
      return min;
    }
    return Number.MAX_SAFE_INTEGER;
  }

  private resolveFresh(
    token: string,
    digest: string,
    sessionGrantId: string | undefined,
    sessionBinding: string | null | undefined,
  ): ResolveOutcome {
    const nowMs = this.now();
    const credential = this.store.findCredentialByDigest(digest);
    if (!credential) {
      return { kind: 'denied', code: 'unknown_credential', message: 'Unknown bearer credential' };
    }
    if (credential.status === 'revoked' || credential.revokedAtMs !== null) {
      return { kind: 'denied', code: 'credential_revoked', message: 'Credential has been revoked' };
    }
    if (credential.status === 'expired' || (credential.expiresAtMs !== null && credential.expiresAtMs <= nowMs)) {
      return { kind: 'denied', code: 'credential_expired', message: 'Credential has expired' };
    }
    const client = this.store.findClient(credential.clientId);
    if (!client || client.status !== 'active') {
      return { kind: 'denied', code: 'client_disabled', message: 'Client registration is not active' };
    }

    const base = {
      credentialId: credential.credentialId,
      clientId: client.clientId,
      clientKind: client.kind,
      revocationEpoch: this.store.revocationEpoch,
      resolvedAtMs: nowMs,
    };

    if (credential.binding === 'bound_principal') {
      // A session-grant header on a principal-bound credential is a protocol
      // anomaly: those credentials already carry their verified principal and
      // never accept device-session elevation (fail-closed).
      if (sessionGrantId) {
        return { kind: 'denied', code: 'grant_client_mismatch', message: 'Session grants never elevate principal-bound credentials' };
      }
      const userId = credential.principalUserId;
      const householdId = credential.householdId;
      if (userId === null || householdId === null) {
        return {
          kind: 'denied',
          code: 'principal_membership_revoked',
          message: 'Credential principal binding is incomplete',
        };
      }
      if (this.store.userDisabled(userId)) {
        return { kind: 'denied', code: 'principal_disabled', message: 'Principal user is not active' };
      }
      const membership = this.store.activeMembership(householdId, userId);
      if (!membership) {
        return {
          kind: 'denied',
          code: 'principal_membership_revoked',
          message: 'Principal no longer holds an active membership in the bound household',
        };
      }
      return {
        kind: 'authorized',
        auth: {
          ...base,
          householdId,
          principal: {
            kind: 'bound_user',
            userId,
            role: membership.role,
            assurance: 'credential_bound',
          },
        },
      };
    }

    // client_only credential: restricted visitor unless a valid grant elevates.
    if (!sessionGrantId) {      return {
        kind: 'authorized',
        auth: {
          ...base,
          householdId: credential.householdId ?? client.householdId ?? null,
          principal: { kind: 'visitor', assurance: 'unverified_visitor' },
        },
      };
    }
    const elevation = this.validateGrant(sessionGrantId, client.clientId, nowMs, sessionBinding ?? '');
    // '' (absent header) never matches the stored non-empty binding:
    // referencing a grant WITHOUT its session binding denies fail-closed.
    if (typeof elevation === 'string') {
      return { kind: 'denied', code: elevation, message: `Session grant rejected: ${elevation}` };
    }
    const grant = elevation;
    if (this.store.userDisabled(grant.userId ?? grant.candidateUserId ?? '')) {
      return { kind: 'denied', code: 'principal_disabled', message: 'Grant subject is not active' };
    }
    if (grant.kind === 'session_verified') {
      const membership = this.store.activeMembership(grant.householdId, grant.userId as string);
      if (!membership) {
        return {
          kind: 'denied',
          code: 'principal_membership_revoked',
          message: 'Granted user no longer holds an active membership',
        };
      }
      return {
        kind: 'authorized',
        auth: {
          ...base,
          householdId: grant.householdId,
          principal: {
            kind: 'session_verified',
            userId: grant.userId as string,
            role: membership.role,
            assurance: 'session_verified',
            grantId: grant.grantId,
          },
        },
      };
    }
    // Voiceprint candidate: household-scoped low-sensitivity tier ONLY.
    return {
      kind: 'authorized',
      auth: {
        ...base,
        householdId: grant.householdId,
        principal: {
          kind: 'voiceprint_candidate',
          candidateUserId: grant.candidateUserId as string,
          assurance: 'voiceprint_candidate',
          grantId: grant.grantId,
        },
      },
    };
  }

  /**
   * Validates a short-term grant against the presenting CLIENT and session:
   * existence, expiry, revocation, client binding and session binding.
   * Returns the grant record or a stable denial code.
   */
  validateGrant(
    grantId: string,
    clientId: string,
    nowMs: number,
    sessionBinding?: string | null,
  ): GrantRecord | string {
    const grant = this.store.findGrant(grantId);
    if (!grant) return 'grant_unknown';
    if (grant.status === 'revoked' || grant.revokedAtMs !== null) return 'grant_revoked';
    if (grant.status === 'expired' || grant.expiresAtMs <= nowMs) return 'grant_expired';
    if (grant.clientId !== clientId) return 'grant_client_mismatch';
    if (sessionBinding !== undefined && sessionBinding !== grant.sessionBinding) {
      return 'grant_session_mismatch';
    }
    return grant;
  }

  /**
   * Executor admission gate (工具提交 / 输出准入): re-checks the COMPLETE
   * acceptance chain against CURRENT server-side state — never the
   * request-time snapshot (AC 3, Step 05 review P1 fix):
   *   accepting credential (revoked/expired → deny) → client (disabled →
   *   deny) → verified principal (user disabled / membership revoked →
   *   deny) → elevating grant (revoked/expired → deny) → centralized policy
   *   for the delivered operation ('chat.general'; grant-elevated tasks
   *   additionally re-check grant scope).
   *
   * The gate consults the binding's recorded attribution (credential_id /
   * grant_id / principal_kind, identity schema v2). A bound row without
   * attribution (pre-v2 row) denies fail-closed; a row not yet written (the
   * in-flight acceptance window of the very request being served) allows —
   * an unbound task is unreadable for everyone afterwards (load denies
   * task_not_bound), so only positive revocation evidence denies here.
   */
  assertTaskStillAuthorized(taskId: string): { allowed: boolean; reason?: string } {
    const binding = this.store.taskBinding(taskId);
    if (!binding) {
      return { allowed: true, reason: 'task_not_bound_yet' };
    }
    const nowMs = this.now();

    // 1. The accepting credential must STILL be active — credential
    //    revocation closes tool submission, not only the transport stream.
    if (!binding.credentialId) {
      return { allowed: false, reason: 'task_not_attributable' };
    }
    const credential = this.store.findCredentialById(binding.credentialId);
    if (!credential || credential.status === 'revoked' || credential.revokedAtMs !== null) {
      return { allowed: false, reason: 'credential_revoked' };
    }
    if (
      credential.status === 'expired' ||
      (credential.expiresAtMs !== null && credential.expiresAtMs <= nowMs)
    ) {
      return { allowed: false, reason: 'credential_expired' };
    }

    // 2. The accepting client must still be registered and active.
    const client = this.store.findClient(binding.clientId);
    if (!client || client.status !== 'active') {
      return { allowed: false, reason: 'client_disabled' };
    }

    // 3. Verified-principal bindings: the user and the household membership
    //    must STILL be active.
    if (binding.principalKind === 'user' && binding.principalUserId !== null) {
      if (this.store.userDisabled(binding.principalUserId)) {
        return { allowed: false, reason: 'principal_disabled' };
      }
      if (!this.store.activeMembership(binding.householdId, binding.principalUserId)) {
        return { allowed: false, reason: 'principal_membership_revoked' };
      }
    }

    // 4. Grant-elevated bindings: the grant must STILL be active.
    let grantScope: readonly Operation[] | null = null;
    if (binding.grantId) {
      const grant = this.store.findGrant(binding.grantId);
      if (!grant) return { allowed: false, reason: 'grant_unknown' };
      if (grant.status === 'revoked' || grant.revokedAtMs !== null) {
        return { allowed: false, reason: 'grant_revoked' };
      }
      if (grant.status === 'expired' || grant.expiresAtMs <= nowMs) {
        return { allowed: false, reason: 'grant_expired' };
      }
      grantScope = grant.scope;
    }

    // 5. Centralized policy (Step 05 review P2-1 wiring): the only output the
    //    synthetic executor delivers is an admitted chat answer, so the
    //    delivered operation is 'chat.general'; grant-elevated tasks are
    //    additionally re-checked against the grant scope. Any future domain
    //    operation MUST route through authorizeOperation /
    //    authorizeGrantScopedOperation the same way (ADR-0014).
    const policyAuth: AuthContext = {
      credentialId: binding.credentialId,
      clientId: binding.clientId,
      clientKind: binding.clientKind,
      householdId: binding.householdId,
      principal:
        binding.principalKind === 'user' && binding.principalUserId !== null
          ? {
              kind: 'bound_user',
              userId: binding.principalUserId,
              role:
                this.store.activeMembership(binding.householdId, binding.principalUserId)?.role ??
                'member',
              assurance: 'credential_bound',
            }
          : binding.principalKind === 'candidate' &&
              binding.principalUserId !== null &&
              binding.grantId !== null
            ? {
                kind: 'voiceprint_candidate',
                candidateUserId: binding.principalUserId,
                assurance: 'voiceprint_candidate',
                grantId: binding.grantId,
              }
            : { kind: 'visitor', assurance: 'unverified_visitor' },
      revocationEpoch: this.store.revocationEpoch,
      resolvedAtMs: nowMs,
    };
    const policyInput = {
      auth: policyAuth,
      operation: 'chat.general' as Operation,
      targetHouseholdId: binding.householdId,
      targetSubjectUserId: binding.principalUserId ?? undefined,
    };
    const decision = grantScope
      ? authorizeGrantScopedOperation(policyInput, grantScope)
      : authorizeOperation(policyInput);
    return decision.allowed
      ? { allowed: true, reason: decision.reason }
      : { allowed: false, reason: decision.reason };
  }
}

/** Stable identity denial → stable message (single place, tests pin it). */
export function denialMessageOf(code: string): string {
  switch (code) {
    case 'unknown_credential':
      return 'Authentication required: the presented bearer credential is not registered.';
    case 'credential_revoked':
      return 'Authentication required: the presented bearer credential has been revoked.';
    case 'credential_expired':
      return 'Authentication required: the presented bearer credential has expired.';
    case 'client_disabled':
      return 'Authentication required: the client registration is not active.';
    default:
      return `Authentication required: ${code.replaceAll('_', ' ')}.`;
  }
}
