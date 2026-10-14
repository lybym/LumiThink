import { NextResponse } from "next/server";

import {
  MAX_INTERACTION_BODY_BYTES,
  readJsonBodyWithCap,
  safeErrorResult,
} from "@/lib/server/interaction-service";
import { getWebMvpRuntime } from "@/lib/server/web-mvp-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/v1/guardian/session (docs/API_CONTRACT.md §12, issue #18).
 *
 * Guardian/admin login: the server verifies the access code (constant-time
 * comparison, bounded global lockout) and mints an opaque session token.
 * Identity fields (role/actorId/child_id) are server-resolved only — the
 * request schema rejects them, so no forged child_id or self-assigned role
 * can enter. No cookie is set: the token travels only in the client-held
 * Authorization header (no ambient authority → no CSRF surface).
 */
export async function POST(request: Request): Promise<Response> {
  const nowIso = new Date().toISOString();
  let body: unknown;
  try {
    body = await readJsonBodyWithCap(request.body ?? null, MAX_INTERACTION_BODY_BYTES);
  } catch (error) {
    const { httpStatus, envelope } = safeErrorResult(error, {}, nowIso);
    return NextResponse.json(envelope, { status: httpStatus });
  }
  const result = getWebMvpRuntime().guardian.sessionLogin({ body });
  if (result.kind === "error") {
    return NextResponse.json(result.envelope, { status: result.httpStatus });
  }
  return NextResponse.json(result.body, { status: result.httpStatus });
}
