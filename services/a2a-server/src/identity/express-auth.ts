/**
 * HTTP-boundary identity wiring (P1-03, issue #85): the two-tier
 * authentication middleware, the context-continuation guard, the SDK user
 * builder, the authorizing Task Store decorator, the stream registry that
 * closes live SSE flows on revocation (AC 3), and the IdentityController
 * facade the service exposes for provisioning/revocation.
 *
 * Wire contract (all standard; no new A2A states/methods):
 *   - Unknown/expired/revoked credential or inactive client → HTTP 401 +
 *     JSON-RPC -32000 + ErrorInfo AUTHENTICATION_REQUIRED (domain
 *     lumithink.a2a) — the P1-01 shape, now resolved against the identity
 *     store instead of one static token. NO task is created.
 *   - Authenticated client with an invalid principal (membership revoked,
 *     user disabled) or rejected session grant → HTTP 403 + -32000 +
 *     ErrorInfo PERMISSION_DENIED. NO task is created.
 *   - Task access denied (Get/Cancel/Subscribe; decorator load → undefined)
 *     → the locked SDK's own TaskNotFoundError (-32001): from the caller's
 *     perspective the task does not exist. The audit log records the real
 *     reason (design §4.1: 逐条校验引用归属，不靠 ID 保密 — authorization is
 *     never RELIED on ID secrecy).
 *   - Context continuation denied (SendMessage with a contextId bound to
 *     another household/principal) → -32602 invalid params + ErrorInfo
 *     CONTEXT_ACCESS_DENIED; NO task is created.
 *
 * Anti-forgery (AC 1): the middleware resolves identity from the
 * Authorization header + server bindings ONLY. Message metadata
 * (userId/householdId/role), the A2A `tenant` request field and contextId
 * are never consulted for authorization anywhere in this file.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { User } from '@a2a-js/sdk/server';
import type { TaskStore } from '../task-manager-port.ts';
import { jsonRpcErrorBody, type ErrorInfo } from '../error-map.ts';
import { IdentityError, type AuthContext, type AuditEntry } from './model.ts';
import { Authorizer, denialMessageOf } from './authorizer.ts';
import type { IdentityStore } from './identity-store.ts';
import type { StreamTeardownHandle } from '../stream-teardown.ts';

const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';

function errorInfo(reason: string, domain: string): ErrorInfo[] {
  return [{ '@type': ERROR_INFO_TYPE, reason, domain }];
}

/** Best-effort JSON-RPC id extraction for pre-SDK error responses. */
function requestIdOf(req: Request): unknown {
  const body = req.body as { id?: unknown } | undefined;
  if (body && typeof body === 'object' && 'id' in body) return body.id;
  return null;
}

/** Parses the `Authorization: Bearer <token>` header value ('' when absent). */
function presentedBearerOf(header: unknown): string {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length).trim();
}

// ---------------------------------------------------------------------------
// Stream registry — 撤权对已有流及时生效 (AC 3)
// ---------------------------------------------------------------------------

interface StreamRegistration {
  credentialId: string;
  clientId: string;
  principalUserId: string | null;
  grantId: string | null;
  res: Response;
}

export class StreamRegistry {
  private readonly streams = new Map<Response, StreamRegistration>();

  register(entry: StreamRegistration): void {
    this.streams.set(entry.res, entry);
    entry.res.once('close', () => this.streams.delete(entry.res));
  }

  get size(): number {
    return this.streams.size;
  }

  private closeMatching(matches: (entry: StreamRegistration) => boolean): number {
    let closed = 0;
    for (const [res, entry] of this.streams) {
      if (!matches(entry)) continue;
      this.streams.delete(res);
      if (!res.writableEnded) {
        // Immediate teardown of the SSE flow: the SDK handler's write loop
        // observes the destroyed socket and ends the stream. Graceful
        // outbox-based resume semantics belong to P1-06/#88.
        res.destroy();
        closed += 1;
      }
    }
    return closed;
  }

  closeAllForCredential(credentialId: string): number {
    return this.closeMatching((entry) => entry.credentialId === credentialId);
  }

  closeAllForPrincipal(userId: string): number {
    return this.closeMatching((entry) => entry.principalUserId === userId);
  }

  closeAllForGrant(grantId: string): number {
    return this.closeMatching((entry) => entry.grantId === grantId);
  }

  closeAllForClient(clientId: string): number {
    return this.closeMatching((entry) => entry.clientId === clientId);
  }
}

// ---------------------------------------------------------------------------
// SDK user bridge
// ---------------------------------------------------------------------------

/** SDK `User` implementation carrying the server-resolved AuthContext. */
export class LumithinkA2aUser implements User {
  readonly auth: AuthContext;
  /**
   * P1-12 (issue #121): the request's SSE disconnect handle (streaming
   * methods only). The locked SDK's context builder copies `user` into the
   * ServerCallContext, which is the only correlation channel between the
   * HTTP response and the stream generator — the SDK accepts no abort
   * signal and exposes no disconnect hook on this path (verified against
   * the 1.3.0 bundle).
   */
  readonly streamTeardown?: StreamTeardownHandle;
  constructor(auth: AuthContext, streamTeardown?: StreamTeardownHandle) {
    this.auth = auth;
    this.streamTeardown = streamTeardown;
  }
  get isAuthenticated(): boolean {
    return true;
  }
  get userName(): string {
    const principal = this.auth.principal;
    if (principal.kind === 'bound_user' || principal.kind === 'session_verified') {
      return principal.userId;
    }
    if (principal.kind === 'voiceprint_candidate') {
      return `candidate:${principal.candidateUserId}`;
    }
    return `client:${this.auth.clientId}`;
  }
}

declare module 'express-serve-static-core' {
  interface Request {
    lumithinkAuth?: AuthContext;
    /**
     * P1-12 (issue #121): per-request SSE disconnect handle for streaming
     * methods, attached by the composition root's teardown middleware and
     * carried into the SDK call context through the user builder. Undefined
     * for non-streaming requests.
     */
    lumithinkStreamTeardown?: StreamTeardownHandle;
  }
}

const LUMITHINK_SESSION_GRANT_HEADER = 'x-lumithink-session-grant';
const LUMITHINK_SESSION_BINDING_HEADER = 'x-lumithink-session-binding';

/**
 * Two-tier authentication middleware (client + principal). Runs BEFORE the
 * SDK handler; failures never reach the handler, so they never create a
 * Task (design §9.2 / TASK_LIFECYCLE §1).
 */
export function requireTwoTierAuth(options: {
  authorizer: Authorizer;
  store: IdentityStore;
  registry: StreamRegistry;
  audit?: (entry: Parameters<IdentityStore['audit']>[0]) => void;
}): RequestHandler {
  const { authorizer, store, registry } = options;
  const audit = options.audit ?? ((entry) => store.audit(entry));
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    const presented = presentedBearerOf(req.headers.authorization);
    const sessionGrantHeader = req.headers[LUMITHINK_SESSION_GRANT_HEADER];
    const sessionGrantId =
      typeof sessionGrantHeader === 'string' && sessionGrantHeader.trim() !== ''
        ? sessionGrantHeader.trim()
        : null;
    const sessionBindingHeader = req.headers[LUMITHINK_SESSION_BINDING_HEADER];
    const sessionBinding =
      typeof sessionBindingHeader === 'string' && sessionBindingHeader.trim() !== ''
        ? sessionBindingHeader.trim()
        : null;
    if (presented.length === 0) {
      audit({
        action: 'authenticate',
        decision: 'deny',
        reason: 'missing_credential',
        clientId: null,
      });
      res.status(401).json(
        jsonRpcErrorBody(
          requestIdOf(req),
          -32000,
          denialMessageOf('unknown_credential'),
          errorInfo('AUTHENTICATION_REQUIRED', 'lumithink.a2a'),
        ),
      );
      return;
    }
    // The presented token is hashed and looked up exactly like a known one;
    // unknown tokens take the same path and deny with a stable message.
    const outcome = authorizer.resolve(presented, sessionGrantId, sessionBinding);
    if (outcome.kind === 'denied') {
      audit({
        action: 'authenticate',
        decision: 'deny',
        reason: outcome.code,
      });
      const isPrincipalLevel = outcome.code.startsWith('principal_') || outcome.code.startsWith('grant_');
      if (isPrincipalLevel) {
        // Authenticated client, unauthorized principal → 403 PERMISSION_DENIED.
        res.status(403).json(
          jsonRpcErrorBody(
            requestIdOf(req),
            -32000,
            outcome.message,
            errorInfo('PERMISSION_DENIED', 'lumithink.a2a'),
          ),
        );
        return;
      }
      res.status(401).json(
        jsonRpcErrorBody(
          requestIdOf(req),
          -32000,
          denialMessageOf(outcome.code),
          errorInfo('AUTHENTICATION_REQUIRED', 'lumithink.a2a'),
        ),
      );
      return;
    }
    const auth = outcome.auth;
    req.lumithinkAuth = auth;
    registry.register({
      credentialId: auth.credentialId,
      clientId: auth.clientId,
      principalUserId:
        auth.principal.kind === 'bound_user' || auth.principal.kind === 'session_verified'
          ? auth.principal.userId
          : auth.principal.kind === 'voiceprint_candidate'
            ? auth.principal.candidateUserId
            : null,
      grantId:
        auth.principal.kind === 'session_verified' || auth.principal.kind === 'voiceprint_candidate'
          ? auth.principal.grantId
          : null,
      res,
    });
    audit({
      action: 'authenticate',
      decision: 'allow',
      reason: `assurance:${auth.principal.assurance}`,
      credentialId: auth.credentialId,
      clientId: auth.clientId,
      principalUserId:
        auth.principal.kind === 'bound_user' || auth.principal.kind === 'session_verified'
          ? auth.principal.userId
          : null,
      householdId: auth.householdId,
    });
    next();
  };
}

/** SDK express `userBuilder`: projects the resolved AuthContext into the call context. */
export function lumithinkUserBuilder(req: Request): Promise<User> {
  const auth = req.lumithinkAuth;
  if (!auth) {
    // Unreachable when requireTwoTierAuth ran; fail closed anyway.
    return Promise.reject(new IdentityError('unknown_credential', 'request was not authenticated'));
  }
  return Promise.resolve(new LumithinkA2aUser(auth, req.lumithinkStreamTeardown));
}

/**
 * Context-continuation guard (会话续接, AC 2). SendMessage/
 * SendStreamingMessage requests carrying a contextId that is ALREADY bound
 * to another household/principal are rejected BEFORE the handler runs — the
 * SDK would otherwise adopt the foreign context for the new task. Unbound
 * contextIds pass (new conversation; ownership binds on first save).
 */
export function requireContextAccess(options: {
  store: IdentityStore;
  audit?: (entry: Parameters<IdentityStore['audit']>[0]) => void;
}): RequestHandler {
  const { store } = options;
  const audit = options.audit ?? ((entry) => store.audit(entry));
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    const body = req.body as
      | { method?: string; params?: { message?: { contextId?: string } } }
      | undefined;
    const method = body?.method;
    if (method !== 'SendMessage' && method !== 'SendStreamingMessage') {
      next();
      return;
    }
    const auth = req.lumithinkAuth;
    if (!auth) {
      // requireTwoTierAuth guarantees this; fail closed.
      res.status(401).json(
        jsonRpcErrorBody(
          requestIdOf(req),
          -32000,
          denialMessageOf('unknown_credential'),
          errorInfo('AUTHENTICATION_REQUIRED', 'lumithink.a2a'),
        ),
      );
      return;
    }
    const contextId = body?.params?.message?.contextId;
    if (typeof contextId !== 'string' || contextId === '') {
      next();
      return;
    }
    const decision = store.checkContextAccess(contextId, auth);
    if (decision.bound && !decision.allowed) {
      audit({
        action: 'context_access',
        decision: 'deny',
        reason: decision.reason ?? 'context_owned_by_other',
        credentialId: auth.credentialId,
        clientId: auth.clientId,
        principalUserId:
          auth.principal.kind === 'bound_user' || auth.principal.kind === 'session_verified'
            ? auth.principal.userId
            : null,
        householdId: auth.householdId,
        contextId,
      });
      res.status(200).json(
        jsonRpcErrorBody(
          requestIdOf(req),
          -32602,
          'Invalid params: the referenced contextId is not accessible for this principal.',
          errorInfo('CONTEXT_ACCESS_DENIED', 'lumithink.a2a'),
        ),
      );
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Authorizing Task Store decorator
// ---------------------------------------------------------------------------

function authOf(context: unknown): AuthContext | undefined {
  const user = (context as { user?: User } | undefined)?.user;
  return user instanceof LumithinkA2aUser ? user.auth : undefined;
}

/**
 * Wraps the single authoritative Task Store with identity ACL. Ownership is
 * bound at acceptance time (BEFORE the task row persists — fail-closed),
 * and every load/list re-checks the caller's server-side authorization.
 */
export function authorizingTaskStore(
  inner: TaskStore,
  options: { store: IdentityStore },
): TaskStore {
  const { store } = options;
  return {
    async save(task, context): Promise<void> {
      const auth = authOf(context);
      if (!auth) {
        throw new IdentityError('task_access_denied', 'task save without an authenticated principal');
      }
      // Bind BEFORE persisting: a foreign-context save throws and the Task
      // Manager never sees the write (defense in depth behind the
      // requireContextAccess middleware).
      store.bindTask({ taskId: task.id, contextId: task.contextId, auth });
      await inner.save(task, context);
    },
    async load(taskId, context): Promise<Awaited<ReturnType<TaskStore['load']>>> {
      const auth = authOf(context);
      if (!auth) return undefined;
      const decision = store.checkTaskAccess(taskId, auth);
      if (!decision.allowed) {
        store.audit({
          action: 'task_access',
          decision: 'deny',
          reason: decision.reason,
          credentialId: auth.credentialId,
          clientId: auth.clientId,
          principalUserId:
            auth.principal.kind === 'bound_user' || auth.principal.kind === 'session_verified'
              ? auth.principal.userId
              : null,
          householdId: auth.householdId,
          taskId,
        });
        return undefined;
      }
      return inner.load(taskId, context);
    },
    async list(params, context) {
      const auth = authOf(context);
      if (!auth) {
        return { tasks: [], nextPageToken: '', pageSize: 0, totalSize: 0 };
      }
      const response = await inner.list(params, context);
      const tasks = response.tasks.filter((task) => store.checkTaskAccess(task.id, auth).allowed);
      const filtered = tasks.length !== response.tasks.length;
      return {
        tasks,
        // A filtered page cannot honor its continuation token — drop it and
        // surface only the authorized slice (documented P1 limitation).
        nextPageToken: filtered ? '' : response.nextPageToken,
        pageSize: response.pageSize,
        totalSize: filtered ? tasks.length : response.totalSize,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Controller facade (provisioning / revocation / gates)
// ---------------------------------------------------------------------------

export interface IdentityControllerOptions {
  store: IdentityStore;
  authorizer: Authorizer;
  registry: StreamRegistry;
}

export class IdentityController {
  readonly store: IdentityStore;
  readonly authorizer: Authorizer;
  readonly registry: StreamRegistry;

  constructor(options: IdentityControllerOptions) {
    this.store = options.store;
    this.authorizer = options.authorizer;
    this.registry = options.registry;
  }

  get revocationEpoch(): number {
    return this.store.revocationEpoch;
  }

  /** Revokes a credential and immediately closes its live streams (AC 3). */
  revokeCredential(credentialId: string): boolean {
    const revoked = this.store.revokeCredential(credentialId);
    if (revoked) this.registry.closeAllForCredential(credentialId);
    return revoked;
  }

  /** Revokes a membership; live streams of that principal end immediately. */
  revokeMembership(householdId: string, userId: string): boolean {
    const revoked = this.store.revokeMembership(householdId, userId);
    if (revoked) this.registry.closeAllForPrincipal(userId);
    return revoked;
  }

  /** Revokes a short-term grant; streams elevated by it end immediately. */
  revokeGrant(grantId: string): boolean {
    const revoked = this.store.revokeGrant(grantId);
    if (revoked) this.registry.closeAllForGrant(grantId);
    return revoked;
  }

  /** Executor admission gate (工具提交): current-state re-validation. */
  executorGate(taskId: string): { allowed: boolean; reason?: string } {
    return this.authorizer.assertTaskStillAuthorized(taskId);
  }

  auditEntries(limit?: number): AuditEntry[] {
    return this.store.auditEntries(limit);
  }
}
