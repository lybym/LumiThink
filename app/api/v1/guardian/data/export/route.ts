import { NextResponse } from "next/server";

import { getWebMvpRuntime } from "@/lib/server/web-mvp-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/v1/guardian/data/export (docs/API_CONTRACT.md §12.6, issue #21
 * 交付范围 2: 按授权身份导出). Guardian-ONLY export of the family child's
 * SAVED content: retained conversation history text and the full memory
 * entries, plus the honest exclusions list (value-free trace/gateway audit,
 * vendor-side data whose deletion cannot be guaranteed, audio — never
 * collected). Every access lands as a data_export audit fact.
 */
export async function GET(request: Request): Promise<Response> {
  const result = getWebMvpRuntime().guardian.exportChildData({
    authorization: request.headers.get("authorization"),
  });
  if (result.kind === "error") {
    return NextResponse.json(result.envelope, { status: result.httpStatus });
  }
  return NextResponse.json(result.body, { status: result.httpStatus });
}
