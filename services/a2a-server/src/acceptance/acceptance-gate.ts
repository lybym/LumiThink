/**
 * Idempotent acceptance gate (P1-04, issue #86; TASK_LIFECYCLE §4.1/§5).
 *
 * Express middleware mounted AFTER two-tier auth + context-access guard and
 * BEFORE the locked SDK handler. It intercepts SendMessage /
 * SendStreamingMessage and runs the PERSISTENT idempotency decision through
 * the single authoritative repository transaction (request ledger + Task +
 * Turn + history + Outbox commit together — §4.1 step 4):
 *
 *   new request            → ownership binding written FIRST (P1-03
 *                            fail-closed ordering, pre-assigned task id),
 *                            then acceptInput() commits the task; the SDK
 *                            handler receives the SAME taskId (injected into
 *                            the message) and dispatches exactly this task —
 *                            "事务提交后才能返回 Task 或派发 Runtime" (§4.1
 *                            step 5);
 *   same key, same fingerprint
 *                          → the ORIGINAL task snapshot is returned directly
 *                            (SendMessage: JSON-RPC result; streaming: one
 *                            SSE frame). The executor NEVER runs again —
 *                            重复原消息恢复原任务，不重复推理 (AC 1/AC 2).
 *                            Access is re-checked first: 权限已撤销 → 拒绝,
 *                            even though the key exists (§5.2);
 *   same key, different fingerprint
 *                          → JSON-RPC -32602 + stable application reason
 *                            MESSAGE_ID_CONFLICT; no new task (§5.2). The
 *                            wire error carries NO other-subject data;
 *   tombstoned key          → standard error + application reason
 *                            RESULT_PURGED; never re-runs, never resurrects
 *                            body (§5.2, AC 4).
 *
 * Auth/param failures never reach here (upstream middleware) and never
 * create a Task. All decisions are audit-logged server-side without message
 * content (design §13.2 minimal audit).
 *
 * Requires the authoritative store to be the SQLite Task Manager; with a
 * caller-supplied custom TaskStore the gate passes through unchanged (the
 * dispatch-lease/idempotency semantics are repository-owned).
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Message as MessageCodec, Task as TaskCodec, type Message } from '@a2a-js/sdk';
import { jsonRpcErrorBody, type ErrorInfo } from '../error-map.ts';
import { isTaskManagerError } from '../task-manager/errors.ts';
import type { SqliteTaskManager } from '../task-manager/sqlite-task-manager.ts';
import type { IdentityStore } from '../identity/identity-store.ts';
import type { AuthContext } from '../identity/model.ts';
import { fingerprintOf, requestKeyOf } from './request-key.ts';

const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';

/** Mirrors the locked SDK's JSON-RPC SSE framing (server/express). */
const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

function errorInfo(reason: string, domain: string): ErrorInfo[] {
  return [{ '@type': ERROR_INFO_TYPE, reason, domain }];
}

function requestIdOf(req: Request): unknown {
  const body = req.body as { id?: unknown } | undefined;
  if (body && typeof body === 'object' && 'id' in body) return body.id;
  return null;
}

function principalUserIdOf(auth: AuthContext): string | null {
  if (auth.principal.kind === 'bound_user' || auth.principal.kind === 'session_verified') {
    return auth.principal.userId;
  }
  if (auth.principal.kind === 'voiceprint_candidate') {
    return auth.principal.candidateUserId;
  }
  return null;
}

export interface AcceptanceGateOptions {
  /** Authoritative repository (idempotency ledger owner). */
  taskManager: SqliteTaskManager | undefined;
  /** Identity store for ownership binding + duplicate-access re-check. */
  identity: IdentityStore;
  /** HMAC key for versioned request fingerprints (config-owned). */
  fingerprintKey: string;
  /** Agent identity component of the scoped request key. */
  agentName: string;
  /** Audit sink (defaults to the identity store's minimal audit log). */
  audit?: (entry: Parameters<IdentityStore['audit']>[0]) => void;
}

/**
 * Builds the gate middleware. When `taskManager` is undefined (custom Task
 * Store wired by the caller) the returned handler is a pass-through.
 */
export function requireIdempotentAcceptance(options: AcceptanceGateOptions): RequestHandler {
  const audit = options.audit ?? ((entry) => options.identity.audit(entry));

  const gate: RequestHandler = async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST' || options.taskManager === undefined) {
      next();
      return;
    }
    const body = req.body as
      | { method?: unknown; params?: { message?: Record<string, unknown> } }
      | undefined;
    const method = body?.method;
    if (method !== 'SendMessage' && method !== 'SendStreamingMessage') {
      next();
      return;
    }
    const auth = req.lumithinkAuth;
    if (!auth) {
      // requireTwoTierAuth guarantees this; fail closed without any ledger
      // interaction (no task may be created for an unauthenticated request).
      res.status(401).json(
        jsonRpcErrorBody(
          requestIdOf(req),
          -32000,
          'Authentication required: the request was not resolved against the identity store.',
          errorInfo('AUTHENTICATION_REQUIRED', 'lumithink.a2a'),
        ),
      );
      return;
    }
    const rawMessage: unknown = body?.params?.message;
    const messageId =
      rawMessage !== null &&
      typeof rawMessage === 'object' &&
      typeof (rawMessage as { messageId?: unknown }).messageId === 'string'
        ? ((rawMessage as { messageId: string }).messageId).trim()
        : '';
    if (rawMessage === null || typeof rawMessage !== 'object' || messageId === '') {
      // Malformed params stay the SDK handler's contract (-32602 there).
      next();
      return;
    }

    const taskManager = options.taskManager;
    const requestKey = requestKeyOf({
      agentName: options.agentName,
      auth,
      messageId,
    });
    const fingerprint = fingerprintOf(rawMessage, options.fingerprintKey);

    let accepted: ReturnType<typeof taskManager.acceptInput>;
    try {
      // Fail-closed ordering (P1-03): the ownership binding is written
      // BEFORE the task row, under a PRE-ASSIGNED task id. A crash in
      // between leaves a harmless orphan binding (points at no task); the
      // reverse order would strand an unreadable task whose ledger key can
      // never be re-executed. The contextId is pre-assigned so binding and
      // acceptance share one conversation id.
      const taskId = randomUUID();
      const contextId =
        typeof (rawMessage as { contextId?: unknown }).contextId === 'string' &&
        ((rawMessage as { contextId: string }).contextId).trim() !== ''
          ? ((rawMessage as { contextId: string }).contextId).trim()
          : randomUUID();
      options.identity.bindTask({ taskId, contextId, auth });
      accepted = taskManager.acceptInput({
        requestKey,
        fingerprint,
        messageId,
        inputMessage: MessageCodec.fromJSON(rawMessage) as Message,
        taskId,
        contextId,
      });
    } catch (error) {
      if (isTaskManagerError(error) && error.code === 'message_id_conflict') {
        audit({
          action: 'accept',
          decision: 'deny',
          reason: 'message_id_conflict',
          credentialId: auth.credentialId,
          clientId: auth.clientId,
          principalUserId: principalUserIdOf(auth),
          householdId: auth.householdId,
        });
        res.status(200).json(
          jsonRpcErrorBody(
            requestIdOf(req),
            -32602,
            'Invalid params: the messageId was already used with different content. ' +
              'Resend the original message to recover the original task.',
            errorInfo('MESSAGE_ID_CONFLICT', 'lumithink.a2a'),
          ),
        );
        return;
      }
      if (error instanceof Error && error.name === 'IdentityError') {
        // Ownership binding refused (e.g. no authorized household scope) —
        // nothing was accepted; mirror the P1-03 principal-level shape.
        audit({
          action: 'accept',
          decision: 'deny',
          reason: 'binding_refused',
          credentialId: auth.credentialId,
          clientId: auth.clientId,
        });
        res.status(403).json(
          jsonRpcErrorBody(
            requestIdOf(req),
            -32000,
            'Permission denied: the request has no authorized household scope to bind a task.',
            errorInfo('PERMISSION_DENIED', 'lumithink.a2a'),
          ),
        );
        return;
      }
      if (isTaskManagerError(error) && error.code === 'write_lock_busy') {
        // Transient and SAFE to retry: acceptance is idempotent by key.
        res.status(200).json(
          jsonRpcErrorBody(
            requestIdOf(req),
            -32000,
            'The acceptance transaction could not acquire the write lock in time; retry the SAME message.',
            errorInfo('WRITE_LOCK_BUSY', 'lumithink.a2a'),
          ),
        );
        return;
      }
      throw error;
    }

    if (accepted.outcome === 'conflict') {
      // Defensive mirror of the typed-error path above (no subject data).
      res.status(200).json(
        jsonRpcErrorBody(
          requestIdOf(req),
          -32602,
          'Invalid params: the messageId was already used with different content.',
          errorInfo('MESSAGE_ID_CONFLICT', 'lumithink.a2a'),
        ),
      );
      return;
    }

    if (accepted.outcome === 'tombstoned') {
      audit({
        action: 'accept',
        decision: 'deny',
        reason: 'result_purged',
        credentialId: auth.credentialId,
        clientId: auth.clientId,
        taskId: accepted.taskId,
      });
      res.status(200).json(
        jsonRpcErrorBody(
          requestIdOf(req),
          -32000,
          'The result of this request has been purged; its idempotency tombstone remains and the request is not re-executed.',
          errorInfo('RESULT_PURGED', 'lumithink.a2a'),
        ),
      );
      return;
    }

    if (accepted.outcome === 'duplicate') {
      // §5.2: 权限已撤销 → 拒绝访问，即使请求键已存在。The wire error mirrors
      // the authorizing store's "task does not exist" semantics; the real
      // reason lives in the audit log (design §4.1: 不靠 ID 保密).
      const access = options.identity.checkTaskAccess(accepted.taskId, auth);
      if (!access.allowed) {
        audit({
          action: 'accept_duplicate',
          decision: 'deny',
          reason: access.reason,
          credentialId: auth.credentialId,
          clientId: auth.clientId,
          taskId: accepted.taskId,
        });
        res.status(200).json(
          jsonRpcErrorBody(
            requestIdOf(req),
            -32001,
            'Task not found: the original task of this messageId is not accessible.',
            undefined,
          ),
        );
        return;
      }
      const snapshot = await taskManager.load(accepted.taskId);
      if (!snapshot) {
        // Ledger/task divergence is a repository invariant violation; never
        // fabricate a body — fail loudly, server-side.
        throw new Error(`Idempotency ledger references missing task ${accepted.taskId}`);
      }
      audit({
        action: 'accept_duplicate',
        decision: 'allow',
        reason: `duplicate:${accepted.currentState}`,
        credentialId: auth.credentialId,
        clientId: auth.clientId,
        taskId: accepted.taskId,
      });
      const wireTask = TaskCodec.toJSON(snapshot);
      if (method === 'SendStreamingMessage') {
        for (const [key, value] of Object.entries(SSE_HEADERS)) {
          res.setHeader(key, value);
        }
        res.flushHeaders();
        // One SSE frame carrying the original task; the client re-attaches
        // via Subscribe/GetTask for live progress (§5.2 按请求模式等待或订阅).
        res.write(
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: requestIdOf(req), result: { task: wireTask } })}\n\n`,
        );
        res.end();
        return;
      }
      res.status(200).json({
        jsonrpc: '2.0',
        id: requestIdOf(req),
        result: { task: wireTask },
      });
      return;
    }

    // created: hand the ACCEPTED task to the SDK handler under the SAME id
    // (the acceptance transaction is already committed — §4.1 step 5:
    // publish the task id early; dispatch happens only after the commit).
    const params = body?.params as { message: Record<string, unknown> };
    params.message.taskId = accepted.taskId;
    params.message.contextId = accepted.contextId;
    audit({
      action: 'accept',
      decision: 'allow',
      reason: 'created',
      credentialId: auth.credentialId,
      clientId: auth.clientId,
      principalUserId: principalUserIdOf(auth),
      householdId: auth.householdId,
      taskId: accepted.taskId,
      contextId: accepted.contextId,
    });
    next();
  };

  // Express-safe async wrapper: a rejection routes to the error middleware.
  return (req, res, next) => {
    Promise.resolve(gate(req, res, next)).catch(next);
  };
}
