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
 * POST /api/v1/guardian/data/erase (docs/API_CONTRACT.md §12.6, issue #21
 * 交付范围 2/3). Guardian-ONLY subject-wide hard delete across the memory
 * domain (full supersedes lineage), conversation history, turn event
 * buffers (running turns are aborted) and the DSH session mapping. Body:
 * `{ protocolVersion, action: "erase_child_data" | "replay_child_deletions" }`
 * — the subject is pinned server-side and never a body field. The result is
 * structural only (purge counts + tombstone id): deleted content cannot be
 * returned because it no longer exists. `replay_child_deletions` re-applies
 * prior deletions — the provable post-backup-restore re-delete procedure
 * (AC 2). Every accepted run lands as a data_erase / data_erase_replay
 * audit fact.
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
  const result = await getWebMvpRuntime().guardian.eraseChildData({
    authorization: request.headers.get("authorization"),
    body,
  });
  if (result.kind === "error") {
    return NextResponse.json(result.envelope, { status: result.httpStatus });
  }
  return NextResponse.json(result.body, { status: result.httpStatus });
}
