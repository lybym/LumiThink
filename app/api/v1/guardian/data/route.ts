import { NextResponse } from "next/server";

import { getWebMvpRuntime } from "@/lib/server/web-mvp-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/guardian/data (docs/API_CONTRACT.md §12.6, issue #21 交付范围
 * 2: 按授权身份查看). Structural inventory of the pinned family child's
 * saved data: conversation ids + retained-entry COUNTS, turn-stream and
 * DSH-session counters, memory entries by status, deletion-ledger size and
 * the live recording-switch state. NO conversation text and NO memory claim
 * text — the content-bearing view is the explicitly authorized export
 * surface. Guardian and admin (independent maintainer) may read.
 */
export async function GET(request: Request): Promise<Response> {
  const result = getWebMvpRuntime().guardian.getChildDataInventory({
    authorization: request.headers.get("authorization"),
  });
  if (result.kind === "error") {
    return NextResponse.json(result.envelope, { status: result.httpStatus });
  }
  return NextResponse.json(result.body, { status: result.httpStatus });
}
