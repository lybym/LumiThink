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
 * GET /api/v1/guardian/authorizations (docs/API_CONTRACT.md §12, issue #18).
 *
 * Status snapshot for the guardian console (状态核对): disclosure document +
 * acknowledgment state, consent and feature-switch states, vendor request
 * counters, minimal usage counts (no chat content), active session count
 * and the audit tail. Guardian and admin (independent maintainer, verified
 * as the system principal) may read.
 */
export async function GET(request: Request): Promise<Response> {
  const result = getWebMvpRuntime().guardian.getAuthorizations({
    authorization: request.headers.get("authorization"),
  });
  if (result.kind === "error") {
    return NextResponse.json(result.envelope, { status: result.httpStatus });
  }
  return NextResponse.json(result.body, { status: result.httpStatus });
}

/**
 * POST /api/v1/guardian/authorizations (docs/API_CONTRACT.md §12, #18).
 *
 * Guardian-only mutations: acknowledge_disclosure / grant_consent /
 * revoke_consent / set_feature_switch / set_persona_style. Every accepted
 * change is recorded in the security audit; revocation is always permitted
 * (fail-safe direction); grants and switch enablement require the current
 * disclosure to be acknowledged first.
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
  const result = getWebMvpRuntime().guardian.postAuthorizations({
    authorization: request.headers.get("authorization"),
    body,
  });
  if (result.kind === "error") {
    return NextResponse.json(result.envelope, { status: result.httpStatus });
  }
  return NextResponse.json(result.body, { status: result.httpStatus });
}
