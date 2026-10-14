import { NextResponse } from "next/server";

import { getWebMvpRuntime } from "@/lib/server/web-mvp-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/guardian/audit (docs/API_CONTRACT.md §12, issue #18 实现范围 4:
 * 安全变更审计).
 *
 * Bounded, append-only security audit: logins (success/failure/lockout),
 * logouts, disclosure acknowledgments, consent grant/revoke, feature-switch
 * changes, style changes, denied access attempts and guardian cancels.
 * Entries are structural facts only — no access codes, session tokens or
 * submitted text ever enter the audit path (tested).
 */
export async function GET(request: Request): Promise<Response> {
  const result = getWebMvpRuntime().guardian.getAudit({
    authorization: request.headers.get("authorization"),
  });
  if (result.kind === "error") {
    return NextResponse.json(result.envelope, { status: result.httpStatus });
  }
  return NextResponse.json(result.body, { status: result.httpStatus });
}
