import { NextResponse } from "next/server";

import { getWebMvpRuntime } from "@/lib/server/web-mvp-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/v1/guardian/session/logout (docs/API_CONTRACT.md §12, #18).
 *
 * Revokes the caller's server-side session: the token becomes invalid for
 * every guardian surface afterwards (撤销后继续调用被拒绝). No body; the
 * Authorization header carries the session token.
 */
export async function POST(request: Request): Promise<Response> {
  const result = getWebMvpRuntime().guardian.sessionLogout({
    authorization: request.headers.get("authorization"),
  });
  if (result.kind === "error") {
    return NextResponse.json(result.envelope, { status: result.httpStatus });
  }
  return NextResponse.json(result.body, { status: result.httpStatus });
}
