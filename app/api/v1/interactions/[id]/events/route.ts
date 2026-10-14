import { NextResponse } from "next/server";

import { resolveWebMvpActor, safeErrorResult } from "@/lib/server/interaction-service";
import { getWebMvpRuntime } from "@/lib/server/web-mvp-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** SSE Last-Event-ID → resume seq (absent/invalid → full replay). */
function parseLastEventSeq(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * GET /api/v1/interactions/{traceId}/events (docs/API_CONTRACT.md §5, SSE).
 *
 * Actor-scoped event stream: versioned StreamEvents are replayed (or
 * resumed from Last-Event-ID) and followed live until stream.end. Frames
 * are contract-canonical (`event: <kind>` + canonical JSON payload); the
 * interaction service validates every frame on the way out.
 *
 * Next.js App Router constraint: sibling dynamic segments of one level must
 * share ONE slug name, so both /{traceId}/events and /{turnId}/cancel use
 * the filesystem segment `[id]` — the wire URLs are unchanged and each
 * handler interprets the id per its route (events: traceId, cancel: turnId).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  const nowIso = new Date().toISOString();
  const actor = resolveWebMvpActor(nowIso);
  const result = getWebMvpRuntime().service.openEventStream({
    actor,
    traceId: id,
    lastEventSeq: parseLastEventSeq(request.headers.get("last-event-id")),
  });
  if (result.kind === "error") {
    return NextResponse.json(result.envelope, { status: result.httpStatus });
  }

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const step = await result.events.next();
      if (step.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(step.value));
    },
    cancel() {
      // Client disconnected: stop the server-side iterator; the TURN is not
      // cancelled (the child may reconnect and replay — cancel is explicit).
      void result.events.return?.();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
