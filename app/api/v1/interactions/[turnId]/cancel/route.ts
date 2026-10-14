import { NextResponse } from "next/server";

import {
  MAX_INTERACTION_BODY_BYTES,
  readJsonBodyWithCap,
  resolveWebMvpActor,
  safeErrorResult,
} from "@/lib/server/interaction-service";
import { getWebMvpRuntime } from "@/lib/server/web-mvp-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/v1/interactions/{turnId}/cancel (docs/API_CONTRACT.md §6).
 *
 * Role-checked, actor-scoped cancel: aborts the in-flight model call
 * (gateway caller-cancellation), terminates remaining fragment emission and
 * suppresses late results — cancelled output can never reach the child.
 * Unknown/foreign turns resolve to the safe no-op `unknown_turn`.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ turnId: string }> },
): Promise<Response> {
  const { turnId } = await context.params;
  const nowIso = new Date().toISOString();
  const actor = resolveWebMvpActor(nowIso);
  let body: unknown;
  try {
    body = await readJsonBodyWithCap(request.body ?? null, MAX_INTERACTION_BODY_BYTES);
  } catch (error) {
    const { httpStatus, envelope } = safeErrorResult(error, {}, nowIso);
    return NextResponse.json(envelope, { status: httpStatus });
  }
  const result = await getWebMvpRuntime().service.cancelTurn({ actor, urlTurnId: turnId, body });
  if (result.kind === "error") {
    return NextResponse.json(result.envelope, { status: result.httpStatus });
  }
  return NextResponse.json(result.body, { status: result.httpStatus });
}
