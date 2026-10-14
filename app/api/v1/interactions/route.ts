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
 * POST /api/v1/interactions (docs/API_CONTRACT.md §4, issue #17).
 *
 * Thin transport adapter: byte-capped body read → server-verified identity
 * injection → the interaction service (contract parsing, idempotency,
 * conversation ownership, background turn through the real pipeline). All
 * error exits flow through the sanctioned ErrorEnvelope mapping.
 */
export async function POST(request: Request): Promise<Response> {
  const nowIso = new Date().toISOString();
  const actor = resolveWebMvpActor(nowIso);
  let body: unknown;
  try {
    body = await readJsonBodyWithCap(request.body ?? null, MAX_INTERACTION_BODY_BYTES);
  } catch (error) {
    const { httpStatus, envelope } = safeErrorResult(error, {}, nowIso);
    return NextResponse.json(envelope, { status: httpStatus });
  }
  const result = await getWebMvpRuntime().service.submitInteraction({ body, actor });
  if (result.kind === "error") {
    return NextResponse.json(result.envelope, { status: result.httpStatus });
  }
  return NextResponse.json(result.body, { status: result.httpStatus });
}
