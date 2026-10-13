/**
 * R1-03 DSH ↔ Lumi session mapping (issue #15, docs/HARNESS.md §7,
 * docs/TECH_STACK.md §2, docs/R0_DSH_POC.md §5).
 *
 * Establishes the explicit, auditable mapping between a SHORT-LIVED DSH
 * session (owned by the pinned DeepSeek Harness runtime) and the LONG-LIVED
 * Lumi domain session (`SessionRef` from the R1-01 contract), including the
 * full lifecycle — create / reuse / reconnect / close — and DEFECT TRACKING
 * (issue #15: 定义创建/重连/关闭及缺陷追踪).
 *
 * Architecture boundary (docs/TECH_STACK.md §1/§2 — 书面确认):
 * - the root project does NOT depend on the DSH SDK packages; the pinned
 *   runtime stays fully isolated (poc/dsh-child keeps its own lockfile) and
 *   is held by an independent long-lived Node process;
 * - the domain layer therefore owns the PORT (`DshRuntimePort`): the exact
 *   surface a DSH SDK adapter must implement, bounded by the R0-verified
 *   minimal-permission profile. The real adapter binds this port in the
 *   R1-05 process-topology work; until then every mapper is constructed
 *   WITHOUT a port and fails closed (`no_port_bound`) — the same explicit
 *   opt-in idiom as the gateway's real-provider adapter;
 * - there is deliberately NO cancel / mid-turn delta surface on the port:
 *   the official SDK has no mid-turn cancel and real-time cancel/delta
 *   belongs to the separate R1-V2 voice bridge (issue #15 非目标).
 *
 * Session isolation: every mapping is keyed by the Lumi `sessionId`; two
 * Lumi sessions can never share a DSH session key, and a closed or
 * defective session refuses further turns fail-closed.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { ContractValidationError, problem } from "../contract/core.ts";
import { ingestDomainFact } from "../legacy-guard.ts";

// ---------------------------------------------------------------------------
// Port (the surface a real DSH SDK adapter implements)
// ---------------------------------------------------------------------------

/** Lifecycle states of the mapped session (short-term DSH ↔ long-term Lumi). */
export const DSH_SESSION_STATES = Object.freeze([
  "creating",
  "active",
  "reconnecting",
  "closed",
  "defective",
] as const);

export type DshSessionState = (typeof DSH_SESSION_STATES)[number];

/** Why a session reached a terminal state (enumerated, never free text). */
export const DSH_CLOSE_REASONS = Object.freeze([
  "explicit_close",
  "defect_exhausted",
  "runtime_unavailable",
] as const);

export type DshCloseReason = (typeof DSH_CLOSE_REASONS)[number];

/** Enumerated defect classes (issue #15 缺陷追踪; no payload echo). */
export const DSH_DEFECT_CODES = Object.freeze([
  "open_timeout",
  "open_failed",
  "resume_failed",
  "close_failed",
  "runtime_unavailable",
] as const);

export type DshDefectCode = (typeof DSH_DEFECT_CODES)[number];

/**
 * The model-visible tool schema a DSH profile advertises. The runtime
 * asserts this list against the Cordis whitelist — a profile that advertises
 * anything outside the whitelist is a composition-tree violation and fails
 * closed (issue #15 AC 3).
 */
export interface DshAdvertisedTool {
  readonly name: string;
  readonly description: string;
}

export interface DshPortOpenRequest {
  /** The Lumi session the DSH session is created for (1:1 mapping). */
  readonly lumiSessionId: string;
  readonly conversationId: string;
  readonly actorId: string;
}

export type DshPortOpenResult =
  | { readonly ok: true; readonly dshSessionKey: string; readonly dshVersion: string }
  | { readonly ok: false; readonly defect: DshDefectCode };

export type DshPortResumeResult =
  | { readonly ok: true; readonly dshVersion: string }
  | { readonly ok: false; readonly defect: DshDefectCode };

export type DshPortCloseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly defect: DshDefectCode };

/**
 * The port a real DSH SDK adapter implements (bounded by the R0
 * lumithink-child profile). All methods return enumerated results — a port
 * never leaks transport errors or provider bodies into the domain layer.
 */
export interface DshRuntimePort {
  /** Stable adapter identity for the trace (e.g. "dsh-sdk-adapter@rc.2"). */
  readonly adapterId: string;
  /** Create a new DSH session bound to the Lumi session. */
  openSession(request: DshPortOpenRequest): Promise<DshPortOpenResult>;
  /** Reconnect to the mapped DSH session after a transient runtime issue. */
  resumeSession(dshSessionKey: string): Promise<DshPortResumeResult>;
  /** Close the mapped DSH session and reap subprocess resources. */
  closeSession(dshSessionKey: string, reason: DshCloseReason): Promise<DshPortCloseResult>;
  /** The final composition tree's model-visible tool schema. */
  advertisedTools(): readonly DshAdvertisedTool[];
}

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

export interface DshSessionDescriptor {
  readonly lumiSessionId: string;
  readonly conversationId: string;
  readonly actorId: string;
  readonly state: DshSessionState;
  readonly dshSessionKey: string | null;
  readonly dshVersion: string | null;
  readonly adapterId: string | null;
  readonly createdAtMs: number;
  readonly lastActivityAtMs: number;
  readonly defectCount: number;
  readonly lastDefectCode: DshDefectCode | null;
  readonly closedAtMs: number | null;
  readonly closeReason: DshCloseReason | null;
}

export type DshEnsureFailureReason =
  | "no_port_bound"
  | "session_closed"
  | "session_defective"
  | "open_timeout"
  | "open_failed"
  | "resume_failed"
  | "runtime_unavailable";

export type DshEnsureSessionResult =
  | {
      readonly ok: true;
      readonly descriptor: Readonly<DshSessionDescriptor>;
      /** Whether this call created a new DSH session or reused the mapped one. */
      readonly created: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: DshEnsureFailureReason;
      readonly descriptor: Readonly<DshSessionDescriptor>;
    };

export interface DshSessionEventFact {
  readonly event:
    | "session.created"
    | "session.reused"
    | "session.reconnecting"
    | "session.defect";
  readonly state: DshSessionState;
  readonly resultCode: "ok" | "session_unavailable";
}

export interface DshSessionMapperOptions {
  /**
   * The DSH runtime port. Omitted (the default) until the R1-05 process
   * topology binds the real adapter: every session operation then fails
   * closed with `no_port_bound` and a defect is recorded.
   */
  readonly port?: DshRuntimePort;
  readonly clock?: () => number;
  /** Max open/resume/close wait before the attempt counts as a defect. */
  readonly lifecycleTimeoutMs?: number;
  /** Defects tolerated before the session becomes defective permanently. */
  readonly maxDefects?: number;
}

export interface DshSessionMapper {
  /** Create or reuse the DSH session mapped to one Lumi session. */
  ensureSession(refs: {
    readonly lumiSessionId: string;
    readonly conversationId: string;
    readonly actorId: string;
    readonly traceId: string;
    readonly turnId: string;
    readonly onEvent?: (event: DshSessionEventFact) => void;
  }): Promise<DshEnsureSessionResult>;
  /** Confirm a reconnecting session is healthy again. */
  confirmActive(lumiSessionId: string): Readonly<DshSessionDescriptor>;
  /**
   * Report a transient runtime defect for an ACTIVE session (e.g. the DSH
   * adapter lost the subprocess): active → reconnecting + tracked defect.
   * The next ensureSession drives the resume path. Exceeding maxDefects
   * marks the session defective permanently.
   */
  markUnhealthy(lumiSessionId: string, defect: DshDefectCode): Readonly<DshSessionDescriptor>;
  /** Close the mapped session (idempotent; terminal). */
  close(lumiSessionId: string, reason: DshCloseReason): Promise<Readonly<DshSessionDescriptor>>;
  /** Read-only descriptor lookup (null when unknown). */
  describe(lumiSessionId: string): Readonly<DshSessionDescriptor> | null;
  /** All descriptors (audit surface; no content). */
  describeAll(): readonly Readonly<DshSessionDescriptor>[];
}

const DEFAULT_LIFECYCLE_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_DEFECTS = 3;

/** DSH session keys are adapter-authored; grammar-checked to stay bounded. */
const DSH_SESSION_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{7,63}$/;

function isDshSessionKey(value: unknown): value is string {
  return typeof value === "string" && DSH_SESSION_KEY_PATTERN.test(value);
}

function assertSessionIds(refs: {
  readonly lumiSessionId: string;
  readonly conversationId: string;
  readonly actorId: string;
  readonly traceId: string;
  readonly turnId: string;
}): void {
  for (const value of [
    refs.lumiSessionId,
    refs.conversationId,
    refs.actorId,
    refs.traceId,
    refs.turnId,
  ]) {
    if (typeof value !== "string" || value.length === 0 || value.length > 80) {
      throw new ContractValidationError([
        problem(
          "CONTRACT_FIELD_INVALID",
          "sessionRefs",
          "session mapping expects bounded string ids; the submitted values are not echoed.",
        ),
      ]);
    }
  }
}

export function createDshSessionMapper(options: DshSessionMapperOptions = {}): DshSessionMapper {
  const port = options.port ?? null;
  const clock = options.clock ?? (() => Date.now());
  const lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? DEFAULT_LIFECYCLE_TIMEOUT_MS;
  const maxDefects = options.maxDefects ?? DEFAULT_MAX_DEFECTS;

  /** One Lumi session ↔ at most one descriptor (isolation invariant). */
  const sessions = new Map<string, Readonly<DshSessionDescriptor>>();

  function descriptorOf(lumiSessionId: string): Readonly<DshSessionDescriptor> | null {
    return sessions.has(lumiSessionId) ? (sessions.get(lumiSessionId) as Readonly<DshSessionDescriptor>) : null;
  }

  /** Intake + freeze + store; every state change goes through here. */
  function put(descriptor: DshSessionDescriptor): Readonly<DshSessionDescriptor> {
    const frozen = ingestDomainFact(descriptor) as Readonly<DshSessionDescriptor>;
    sessions.set(frozen.lumiSessionId, frozen);
    return frozen;
  }

  function defectFold(
    base: Readonly<DshSessionDescriptor>,
    defect: DshDefectCode,
    terminalStates: readonly DshSessionState[],
  ): Readonly<DshSessionDescriptor> {
    const nowMs = clock();
    const defectCount = base.defectCount + 1;
    const permanentlyDefective = defectCount >= maxDefects;
    const state: DshSessionState = permanentlyDefective
      ? "defective"
      : terminalStates.includes(base.state)
        ? base.state
        : base.state === "active"
          ? "reconnecting"
          : base.state;
    return put({
      ...base,
      state,
      lastActivityAtMs: nowMs,
      defectCount,
      lastDefectCode: defect,
    });
  }

  function freshDescriptor(refs: {
    readonly lumiSessionId: string;
    readonly conversationId: string;
    readonly actorId: string;
  }): DshSessionDescriptor {
    const nowMs = clock();
    return {
      lumiSessionId: refs.lumiSessionId,
      conversationId: refs.conversationId,
      actorId: refs.actorId,
      state: "creating",
      dshSessionKey: null,
      dshVersion: null,
      adapterId: null,
      createdAtMs: nowMs,
      lastActivityAtMs: nowMs,
      defectCount: 0,
      lastDefectCode: null,
      closedAtMs: null,
      closeReason: null,
    };
  }

  /** Race a lifecycle promise against the mapper's lifecycle timeout. */
  function withTimeout<T>(promise: Promise<T>): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), lifecycleTimeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer !== null) {
        clearTimeout(timer);
      }
    });
  }

  return Object.freeze({
    async ensureSession(refs: {
      readonly lumiSessionId: string;
      readonly conversationId: string;
      readonly actorId: string;
      readonly traceId: string;
      readonly turnId: string;
      readonly onEvent?: (event: DshSessionEventFact) => void;
    }): Promise<DshEnsureSessionResult> {
      assertSessionIds(refs);
      const existing = descriptorOf(refs.lumiSessionId);

      if (existing !== null) {
        if (existing.state === "closed" || existing.state === "defective") {
          refs.onEvent?.({
            event: "session.defect",
            state: existing.state,
            resultCode: "session_unavailable",
          });
          return {
            ok: false,
            reason: existing.state === "closed" ? "session_closed" : "session_defective",
            descriptor: existing,
          };
        }
        if (existing.state === "active") {
          refs.onEvent?.({ event: "session.reused", state: "active", resultCode: "ok" });
          return { ok: true, descriptor: existing, created: false };
        }
        // creating / reconnecting fall through to the lifecycle re-drive.
      }

      if (port === null) {
        // No runtime adapter bound (default until R1-05): fail closed and
        // make the gap observable as a tracked defect.
        const base = existing ?? put(freshDescriptor(refs));
        const descriptor = defectFold(base, "runtime_unavailable", ["creating"]);
        refs.onEvent?.({
          event: "session.defect",
          state: descriptor.state,
          resultCode: "session_unavailable",
        });
        return { ok: false, reason: "no_port_bound", descriptor };
      }

      // Resume path: the session exists with a mapped DSH key but is not
      // active (creating/reconnecting after a transient failure).
      if (existing !== null && existing.dshSessionKey !== null) {
        refs.onEvent?.({ event: "session.reconnecting", state: "reconnecting", resultCode: "ok" });
        const reconnecting = put({ ...existing, state: "reconnecting", lastActivityAtMs: clock() });
        const resumed = await withTimeout(port.resumeSession(existing.dshSessionKey));
        if (resumed === null) {
          return {
            ok: false,
            reason: "open_timeout",
            descriptor: defectFold(reconnecting, "open_timeout", ["reconnecting"]),
          };
        }
        if (resumed.ok === false) {
          const reason: DshEnsureFailureReason =
            resumed.defect === "resume_failed" ? "resume_failed" : "runtime_unavailable";
          return {
            ok: false,
            reason,
            descriptor: defectFold(reconnecting, resumed.defect, ["reconnecting"]),
          };
        }
        const descriptor = put({
          ...reconnecting,
          state: "active",
          dshVersion: resumed.dshVersion,
          adapterId: port.adapterId,
          lastActivityAtMs: clock(),
        });
        refs.onEvent?.({ event: "session.reused", state: "active", resultCode: "ok" });
        return { ok: true, descriptor, created: false };
      }

      // Fresh create (no descriptor, or a descriptor without a DSH key yet).
      const base = existing ?? put(freshDescriptor(refs));
      const opened = await withTimeout(
        port.openSession({
          lumiSessionId: refs.lumiSessionId,
          conversationId: refs.conversationId,
          actorId: refs.actorId,
        }),
      );
      if (opened === null) {
        return {
          ok: false,
          reason: "open_timeout",
          descriptor: defectFold(base, "open_timeout", ["creating"]),
        };
      }
      if (opened.ok === false) {
        return {
          ok: false,
          reason: "open_failed",
          descriptor: defectFold(base, opened.defect, ["creating"]),
        };
      }
      if (!isDshSessionKey(opened.dshSessionKey)) {
        return {
          ok: false,
          reason: "open_failed",
          descriptor: defectFold(base, "open_failed", ["creating"]),
        };
      }
      const descriptor = put({
        ...base,
        state: "active",
        dshSessionKey: opened.dshSessionKey,
        dshVersion: opened.dshVersion,
        adapterId: port.adapterId,
        lastActivityAtMs: clock(),
      });
      refs.onEvent?.({ event: "session.created", state: "active", resultCode: "ok" });
      return { ok: true, descriptor, created: true };
    },

    confirmActive(lumiSessionId: string): Readonly<DshSessionDescriptor> {
      const existing = descriptorOf(lumiSessionId);
      if (existing === null) {
        throw new ContractValidationError([
          problem("CONTRACT_FIELD_INVALID", "lumiSessionId", "unknown session; nothing to confirm."),
        ]);
      }
      if (existing.state !== "reconnecting") {
        throw new ContractValidationError([
          problem(
            "CONTRACT_FIELD_INVALID",
            "lumiSessionId",
            "confirmActive is only valid for a reconnecting session.",
          ),
        ]);
      }
      return put({ ...existing, state: "active", lastActivityAtMs: clock() });
    },

    markUnhealthy(lumiSessionId: string, defect: DshDefectCode): Readonly<DshSessionDescriptor> {
      const existing = descriptorOf(lumiSessionId);
      if (existing === null) {
        throw new ContractValidationError([
          problem("CONTRACT_FIELD_INVALID", "lumiSessionId", "unknown session; nothing to mark unhealthy."),
        ]);
      }
      if (existing.state !== "active") {
        throw new ContractValidationError([
          problem(
            "CONTRACT_FIELD_INVALID",
            "lumiSessionId",
            "markUnhealthy is only valid for an active session.",
          ),
        ]);
      }
      return defectFold(existing, defect, ["reconnecting"]);
    },

    async close(
      lumiSessionId: string,
      reason: DshCloseReason,
    ): Promise<Readonly<DshSessionDescriptor>> {
      const existing = descriptorOf(lumiSessionId);
      if (existing === null) {
        throw new ContractValidationError([
          problem("CONTRACT_FIELD_INVALID", "lumiSessionId", "unknown session; nothing to close."),
        ]);
      }
      if (existing.state === "closed") {
        // Idempotent close: keep the original terminal record.
        return existing;
      }
      const nowMs = clock();
      if (port !== null && existing.dshSessionKey !== null) {
        const closed = await withTimeout(port.closeSession(existing.dshSessionKey, reason));
        if (closed === null || closed.ok === false) {
          // A close failure is itself a tracked defect, but the Lumi-side
          // mapping still terminates: a session we asked to close must never
          // accept further turns (fail closed on the Lumi side either way).
          const defectCode: DshDefectCode = closed === null ? "open_timeout" : closed.defect;
          const withDefect = defectFold(existing, defectCode, ["closed"]);
          return put({
            ...withDefect,
            state: "closed",
            closedAtMs: nowMs,
            closeReason: reason,
            lastActivityAtMs: nowMs,
          });
        }
      }
      return put({
        ...existing,
        state: "closed",
        closedAtMs: nowMs,
        closeReason: reason,
        lastActivityAtMs: nowMs,
      });
    },

    describe(lumiSessionId: string): Readonly<DshSessionDescriptor> | null {
      return descriptorOf(lumiSessionId);
    },

    describeAll(): readonly Readonly<DshSessionDescriptor>[] {
      return Object.freeze([...sessions.values()]);
    },
  });
}
