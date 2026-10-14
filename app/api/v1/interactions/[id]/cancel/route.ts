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
 *
 * R1-06 scope note (review P2-3 disposition — keep + document, disclosed in
 * the PR): the guardian FAMILY-cancel policy is wired at the service layer
 * (`cancelPolicy` → `familyCancelPolicy`) and pinned by tests
 * (tests/server/guardian-wiring.spec.ts), but THIS transport still resolves
 * the server-injected demo child actor only — no guardian session is parsed
 * on this route — so family cancel is NOT HTTP-reachable in R1-06. The
 * guardian-session-aware cancel surface lands with the guardian console
 * work (R1-09 or later); API_CONTRACT §12.3 carries the same note.
 *
 * Next.js App Router constraint: sibling dynamic segments of one level must
 * share ONE slug name, so both /{traceId}/events and /{turnId}/cancel use
 * the filesystem segment `[id]` — the wire URLs are unchanged and each
 * handler interprets the id per its route (events: traceId, cancel: turnId).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const nowIso = new Date().toISOString();
  const actor = resolveWebMvpActor(nowIso);
  let body: unknown;
  try {
    body = await readJsonBodyWithCap(request.body ?? null, MAX_INTERACTION_BODY_BYTES);
  } catch (error) {
    const { httpStatus, envelope } = safeErrorResult(error, {}, nowIso);
    return NextResponse.json(envelope, { status: httpStatus });
  }
  const result = await getWebMvpRuntime().service.cancelTurn({ actor, urlTurnId: id, body });
  if (result.kind === "error") {
    return NextResponse.json(result.envelope, { status: result.httpStatus });
  }
  return NextResponse.json(result.body, { status: result.httpStatus });
}
