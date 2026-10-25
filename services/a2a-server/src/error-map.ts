/**
 * Standard error mapping at the A2A transport boundary (P1-01, issue #83).
 *
 * Mapping table (evidence anchors in docs/fixtures/a2a-v1.0):
 *  - Missing / unsupported `A2A-Version` → JSON-RPC -32009 VersionNotSupported,
 *    HTTP 200 + JSON-RPC error body, exactly the frozen fixture 12 shape
 *    (R7, P0-02 matrix §5: LumiThink must validate the header explicitly and
 *    must NOT silently accept the 0.3 default for a missing header).
 *  - Authentication failure → HTTP 401 + JSON-RPC error body with
 *    code -32000 (JSON-RPC implementation-defined server error) and a
 *    google.rpc.ErrorInfo reason `AUTHENTICATION_REQUIRED` in the
 *    application domain `lumithink.a2a`. This is the P1-01 synthetic
 *    validation gate; the authoritative two-tier identity mapping is
 *    P1-03 (issue #85).
 *  - JSON body parse failure → JSON-RPC -32700 ParseError (standard).
 *  - Task-not-found (-32001), TaskNotCancelable (-32002), terminal
 *    SubscribeToTask (-32004) and invalid-params (-32602) are produced by
 *    the locked SDK handler itself; tests pin them against the frozen
 *    fixtures.
 *
 * Auth/version failures NEVER create a Task (design §9.2, TASK_LIFECYCLE §1:
 * only successful acceptance creates tasks; auth/param failures return
 * standard errors).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const ERROR_INFO_TYPE = 'type.googleapis.com/google.rpc.ErrorInfo';

export const VERSION_NOT_SUPPORTED_CODE = -32009;
export const AUTHENTICATION_REQUIRED_CODE = -32000;
export const PARSE_ERROR_CODE = -32700;

export interface ErrorInfo {
  '@type': string;
  reason: string;
  domain: string;
}

export function jsonRpcErrorBody(
  id: unknown,
  code: number,
  message: string,
  data?: unknown,
): { jsonrpc: '2.0'; id: unknown; error: { code: number; message: string; data?: unknown } } {
  return { jsonrpc: '2.0', id, error: { code, message, data } };
}

function errorInfo(reason: string, domain: string): ErrorInfo[] {
  return [{ '@type': ERROR_INFO_TYPE, reason, domain }];
}

/** Best-effort JSON-RPC id extraction for pre-SDK error responses. */
function requestIdOf(req: Request): unknown {
  const body = req.body as { id?: unknown } | undefined;
  if (body && typeof body === 'object' && 'id' in body) return body.id;
  return null;
}

/**
 * Explicit `A2A-Version` guard (R7). Mounted in front of the locked SDK
 * handler so the declared-version policy is owned by LumiThink: a missing
 * header is treated as the spec default '0.3', which this service does not
 * declare, and therefore returns -32009 — never silently accepted.
 */
export function requireA2aVersion(options: {
  supportedVersions: readonly string[];
}): RequestHandler {
  const supported = options.supportedVersions;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    const header = req.headers['a2a-version'];
    const headerValue = Array.isArray(header) ? header[0] : header;
    // Per spec §3.6.2 a missing header defaults to '0.3'; we do not declare
    // 0.3, so a missing header is rejected exactly like an unsupported one
    // (fixture 12, both variants share -32009).
    const requested =
      headerValue === undefined || headerValue === '' ? '0.3' : String(headerValue).trim();
    if (!supported.includes(requested)) {
      res.status(200).json(
        jsonRpcErrorBody(
          requestIdOf(req),
          VERSION_NOT_SUPPORTED_CODE,
          `The requested A2A protocol version '${requested}' is not supported. ` +
            `Supported versions: ${supported.join(', ')}`,
          errorInfo('VERSION_NOT_SUPPORTED', 'a2a-protocol.org'),
        ),
      );
      return;
    }
    next();
  };
}

/**
 * Synthetic bearer gate for the validation service. Discovery
 * (/.well-known/agent-card.json) stays unauthenticated per spec; every
 * JSON-RPC POST requires a valid bearer credential. Failure returns the
 * standard-shaped JSON-RPC error above and NEVER creates a task.
 */
export function requireBearerAuth(options: { bearerToken: string }): RequestHandler {
  const expected = options.bearerToken;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    const header = req.headers.authorization;
    const presented =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length).trim()
        : '';
    if (presented.length === 0 || !timingSafeTokenEquals(presented, expected)) {
      res.status(401).json(
        jsonRpcErrorBody(
          requestIdOf(req),
          AUTHENTICATION_REQUIRED_CODE,
          'Authentication required: a valid bearer credential is required for A2A JSON-RPC ' +
            'methods (P1-01 synthetic validation gate; P1-03/#85 owns the real two-tier identity).',
          errorInfo('AUTHENTICATION_REQUIRED', 'lumithink.a2a'),
        ),
      );
      return;
    }
    next();
  };
}

/** Constant-time comparison, length-independent via SHA-256 digests. */
export function timingSafeTokenEquals(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Converts JSON body parse failures into the standard JSON-RPC parse error
 * (-32700) instead of an HTML 400 page. Mounted after the JSON-RPC handler
 * as an express error handler.
 */
export function jsonRpcParseErrorHandler(): (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const isParseError =
      err !== null && typeof err === 'object' && 'type' in err &&
      (err as { type?: string }).type === 'entity.parse.failed';
    if (!isParseError) {
      res.status(500).json(
        jsonRpcErrorBody(requestIdOf(req), -32603, 'Internal error', undefined),
      );
      return;
    }
    res.status(400).json(
      jsonRpcErrorBody(requestIdOf(req), PARSE_ERROR_CODE, 'Parse error', undefined),
    );
  };
}
