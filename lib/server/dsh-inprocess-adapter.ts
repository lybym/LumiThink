/**
 * R1-05 web MVP server infrastructure — deterministic in-process
 * `DshRuntimePort` adapter (issue #17; docs/TECH_STACK.md §2, docs/HARNESS.md §7).
 *
 * Why this exists (carried #38 review hard precondition P2-2): an UNBOUND
 * port makes every session fail closed with `no_port_bound`, and that gap
 * counts toward `maxDefects` — an unbound window would permanently poison
 * sessions. Before serving turns, the web MVP therefore binds a port.
 *
 * What this adapter deliberately IS and IS NOT:
 * - It is NOT the DSH SDK. The root project keeps zero `@deepseek-ai/dsh-*`
 *   dependencies (docs/TECH_STACK.md §1); the pinned runtime stays fully
 *   isolated in poc/dsh-child and the confirmed process topology (§2: the
 *   SDK is held by an independent long-lived Node process) is untouched.
 * - It is a deterministic, session-lifecycle-only adapter for the single-
 *   process web MVP: every Lumi session maps to a stable synthetic DSH
 *   session key derived from the session id, so create/resume/close are
 *   reproducible and side-effect free (no subprocess, no network, no egress).
 * - The REAL SDK adapter binding (and its independent acceptance) remains
 *   deferred to the process-topology work; nothing here claims DSH agent
 *   behavior, mid-turn cancellation or real-time deltas — the port surface
 *   has none of those (docs/HARNESS.md §7).
 *
 * This module stays framework-free (no next/react imports) so the endpoint
 * service is testable with node:test like every other layer.
 */

import type {
  DshAdvertisedTool,
  DshCloseReason,
  DshPortOpenRequest,
  DshPortOpenResult,
  DshPortResumeResult,
  DshRuntimePort,
} from "../domain/runtime/session-map.ts";
import { describeCordisToolSchema } from "../domain/runtime/cordis.ts";

export const INPROCESS_DSH_ADAPTER_ID = "inprocess-session-adapter@1.0" as const;

/**
 * DSH session keys are adapter-authored and grammar-checked by the mapper
 * (`^[a-z0-9][a-z0-9-]{7,63}$`). The Lumi session id contains underscores,
 * so the adapter derives a bounded, deterministic key from an FNV-1a hash
 * of it — stable across restarts within one registry version.
 */
function dshSessionKeyFor(lumiSessionId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < lumiSessionId.length; index += 1) {
    hash ^= lumiSessionId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `dshsess-${hash.toString(16).padStart(8, "0")}`;
}

/**
 * Create the deterministic in-process DSH port adapter. `openSession` is
 * asynchronous (same shape as a real transport) but resolves immediately;
 * failures are enumerable, never thrown.
 */
export function createInProcessDshAdapter(): DshRuntimePort {
  const opened = new Set<string>();
  const adapter: DshRuntimePort = {
    adapterId: INPROCESS_DSH_ADAPTER_ID,
    async openSession(request: DshPortOpenRequest): Promise<DshPortOpenResult> {
      if (typeof request.lumiSessionId !== "string" || request.lumiSessionId.length === 0) {
        return { ok: false, defect: "open_failed" };
      }
      const key = dshSessionKeyFor(request.lumiSessionId);
      opened.add(key);
      return { ok: true, dshSessionKey: key, dshVersion: "inprocess-1.0" };
    },
    async resumeSession(dshSessionKey: string): Promise<DshPortResumeResult> {
      if (!opened.has(dshSessionKey)) {
        return { ok: false, defect: "resume_failed" };
      }
      return { ok: true, dshVersion: "inprocess-1.0" };
    },
    async closeSession(dshSessionKey: string, _reason: DshCloseReason): Promise<{ ok: true } | { ok: false; defect: "close_failed" }> {
      opened.delete(dshSessionKey);
      return { ok: true };
    },
    advertisedTools(): readonly DshAdvertisedTool[] {
      // Exactly the Cordis whitelist (single source of truth:
      // SAFE_TOOL_REGISTRY via describeCordisToolSchema).
      return describeCordisToolSchema().map((tool) => ({
        name: tool.name,
        description: tool.description,
      }));
    },
  };
  return Object.freeze(adapter);
}
