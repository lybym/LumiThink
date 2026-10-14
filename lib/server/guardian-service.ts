/**
 * R1-06 guardian service — server-side verification, sessions, family
 * authorizations and the security-change audit (issue #18; PRD FR-005;
 * docs/API_CONTRACT.md §12; docs/adr/0003-guardian-auth-v0.md).
 *
 * Server-owned identity for the single-family first phase (synthetic demo
 * values, same discipline as the #17 demo child identity):
 *
 * - LOGIN verifies one of the two configured demo access codes (guardian /
 *   independent admin) with constant-time comparison and a bounded global
 *   lockout; the demo codes are SYNTHETIC constants for the in-memory MVP —
 *   real secret management is R1-08 (docs/TECH_STACK.md §6) and no real
 *   credential ever enters this repository.
 * - SESSIONS are opaque 256-bit server-minted tokens (base64url) stored
 *   server-side with an absolute TTL and explicit revocation. They travel
 *   ONLY in the Authorization: Bearer header — no cookie is ever set, so
 *   there is no ambient authority and CSRF has no surface on these routes;
 *   replay of interaction requests stays covered by the (verifiedActor,
 *   requestId) idempotency ledger of the interaction service.
 * - AUTHORIZATION: every guardian route re-derives a server-side
 *   ActorContext from the session (never from client input) and applies the
 *   domain role matrix (lib/domain/guardian/permissions.ts): reads for
 *   guardian+admin, mutations guardian-only, child/anonymous always
 *   rejected (403 CONTRACT_UNTRUSTED_IDENTITY / CONTRACT_WRONG_ROLE).
 * - REVOCATION EFFECT: while the family consent `child_model_interaction`
 *   is revoked, the interaction service (wired via
 *   `assertModelInteractionAuthorized`) rejects every new family model turn
 *   fail-closed — model calls cannot continue after revocation (issue #18
 *   AC). Already-started turns complete: the gate is a submit-time gate.
 * - EGRESS: `isThirdPartyEgressEnabled` drives the server-side provider
 *   egress gate; with the switch off, the model gateway refuses any
 *   third-party-classified provider BEFORE transport (existing fail-closed
 *   `dataEgressAuthorized` gate), so vendor request count stays 0.
 * - AUDIT: an append-only bounded ring records every security-relevant
 *   event (seeded-state disclosure at construction, login success/failure/
 *   lockout, logout, disclosure ack, consent grant/revoke, switch change,
 *   style change, denied access, guardian cancel). Entries are structural
 *   facts only — no access codes, no session tokens, no submitted text
 *   (tested). Style changes are idempotent: an identical re-submission
 *   reports `unchanged` without a duplicate audit entry.
 * - STYLE: the guardian sets persona style knobs through the trusted
 *   `guardian_config` provenance (lib/domain/persona/turn.ts
 *   applyPersonaStyleKnobs) with the {knobId, value, source} audit trail —
 *   the first real supplier of that provenance (issue #16 forward note).
 *
 * STATE BOUNDARY: sessions, authorizations, style and audit are in-memory
 * and process-local (single-process web MVP, same as #17). No persisted
 * schema is introduced or changed (docs/TECH_STACK.md §3 keeps the new
 * domain persistence decision deferred); disclosed in the PR.
 *
 * This module stays framework-free (no next/react/prisma imports) so the
 * endpoint behavior is testable with node:test.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { parseActorContext, type ActorContext } from "../domain/contract/actor.ts";
import { ContractValidationError, problem } from "../domain/contract/core.ts";
import type { ErrorEnvelope } from "../domain/contract/errors.ts";
import {
  ADMIN_ACTOR_ID,
  GUARDIAN_ACTOR_ID,
  GUARDIAN_FAMILY_CHILD_REF,
  applyGuardianAuthorizationAction,
  buildGuardianStatusSnapshot,
  initialGuardianAuthorizationState,
  isConsentActive,
  isSwitchEnabled,
  parseGuardianAuthorizationAction,
  parseGuardianAuditEntry,
  type GuardianAuditEntry,
  type GuardianAuthorizationState,
  type GuardianEgressStatus,
  type GuardianUsageSummary,
} from "../domain/guardian/authorizations.ts";
import { assertGuardianSurfaceAccess, canCancelFamilyTurn } from "../domain/guardian/permissions.ts";
import {
  buildGuardianLoginResponse,
  buildGuardianLogoutResponse,
  parseGuardianLoginRequest,
  sessionTokenFromAuthorizationHeader,
  type GuardianPrincipal,
} from "../domain/guardian/session.ts";
import {
  applyPersonaStyleKnobs,
  personaDefaultStyle,
  type PersonaKnobProvenanceEntry,
  type PersonaKnobUpdate,
  type PersonaStyleWithProvenance,
} from "../domain/persona/turn.ts";
import {
  PERSONA_STYLE_KNOBS,
  type PersonaPolicyV0,
  type PersonaStyleState,
} from "../domain/persona/policy.ts";
import { resolveActivePersona } from "../domain/persona/registry.ts";
import {
  parseChildDataActionRequest,
  type ChildDataEraseResult,
  type ChildDataExport,
  type ChildDataInventory,
} from "../domain/lifecycle/index.ts";

import { safeErrorResult } from "./interaction-service.ts";

// ---------------------------------------------------------------------------
// Demo family credentials (SYNTHETIC, disclosed — never real credentials)
// ---------------------------------------------------------------------------

/**
 * Synthetic demo access codes for the single-family in-memory MVP. These
 * are NOT real secrets: they are published constants so the demo guardian
 * console is usable, clearly labeled as demo material, and exist only to
 * make the verification path real. Real credential storage/rotation is
 * R1-08 (docs/TECH_STACK.md §6); the PR and ADR-0003 disclose this.
 */
export const GUARDIAN_DEMO_ACCESS_CODE = "lumithink-guardian-demo" as const;
export const ADMIN_DEMO_ACCESS_CODE = "lumithink-admin-demo" as const;

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const GUARDIAN_SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h absolute TTL
const MAX_SESSIONS = 32;
const MAX_FAILED_LOGINS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const MAX_AUDIT_ENTRIES = 500;
const STATUS_AUDIT_TAIL = 20;

export type GuardianCallResult =
  | { readonly kind: "ok"; readonly httpStatus: 200; readonly body: unknown }
  | { readonly kind: "error"; readonly httpStatus: number; readonly envelope: Readonly<ErrorEnvelope> };

interface GuardianSession {
  readonly token: string;
  readonly principal: GuardianPrincipal;
  readonly actorId: string;
  readonly role: "guardian" | "system";
  readonly childRef: string | null;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export interface GuardianServiceOptions {
  /** Persona policy snapshot the guardian style path applies knobs to. */
  readonly personaPolicy?: Readonly<PersonaPolicyV0>;
  /** ms clock (TTLs, lockout). */
  readonly clock?: () => number;
  /** ISO-8601 UTC timestamps (audit + contract grammar). */
  readonly nowFactory?: () => string;
  /** Session token factory (tests inject deterministic tokens). */
  readonly tokenFactory?: () => string;
}

export interface GuardianService {
  /** POST /api/v1/guardian/session (login). */
  sessionLogin(params: { readonly body: unknown }): GuardianCallResult;
  /** POST /api/v1/guardian/session/logout. */
  sessionLogout(params: { readonly authorization: string | null }): GuardianCallResult;
  /** GET /api/v1/guardian/authorizations (status 核对). */
  getAuthorizations(params: { readonly authorization: string | null }): GuardianCallResult;
  /** POST /api/v1/guardian/authorizations (ack / grant / revoke / switch / style). */
  postAuthorizations(params: {
    readonly authorization: string | null;
    readonly body: unknown;
  }): GuardianCallResult;
  /** GET /api/v1/guardian/audit (security-change audit). */
  getAudit(params: { readonly authorization: string | null }): GuardianCallResult;

  // -- R1-09 data lifecycle surfaces (issue #21) ----------------------------
  /**
   * GET /api/v1/guardian/data — structural inventory (counts + ids, NO
   * content). Guardian + admin (data_read surface).
   */
  getChildDataInventory(params: { readonly authorization: string | null }): GuardianCallResult;
  /**
   * GET /api/v1/guardian/data/export — authorized export of SAVED content.
   * Guardian only (data_export surface: the payload carries child text).
   */
  exportChildData(params: { readonly authorization: string | null }): GuardianCallResult;
  /**
   * POST /api/v1/guardian/data/erase — subject-wide hard delete (and the
   * post-restore deletion replay). Guardian only (data_erase surface).
   */
  eraseChildData(params: {
    readonly authorization: string | null;
    readonly body: unknown;
  }): Promise<GuardianCallResult>;

  // -- Interaction-service wiring (R1-06 enforcement points) ---------------
  /** Fail-closed consent gate for family model turns (submit-time). */
  assertModelInteractionAuthorized(actor: Readonly<ActorContext>): void;
  /** Family cancel policy: guardian may stop own-family child turns. */
  familyCancelPolicy(
    canceller: Readonly<ActorContext>,
    owner: { readonly actorId: string; readonly childRef: string | null; readonly turnId: string },
  ): boolean;
  /** Current trusted family style state (persona `guardian_config`). */
  currentFamilyStyle(): Readonly<PersonaStyleWithProvenance>;
  /** Live egress switch state for the provider gate. */
  isThirdPartyEgressEnabled(): boolean;
  /** R1-09: live recording-switch state for the serving surface. */
  isConversationRecordingEnabled(): boolean;

  // -- Runtime wiring + test surfaces --------------------------------------
  configureEgressStatus(provider: () => GuardianEgressStatus): void;
  configureUsageSummary(provider: () => GuardianUsageSummary): void;
  /** R1-09: the composed data-lifecycle operations (server-side provider). */
  configureDataLifecycle(
    provider: () => {
      readonly inventory: () => Readonly<ChildDataInventory>;
      readonly exportData: () => Readonly<ChildDataExport>;
      readonly erase: (operatorRole: string) => Promise<Readonly<ChildDataEraseResult>>;
      readonly replayDeletions: (operatorRole: string) => Promise<Readonly<ChildDataEraseResult>>;
    },
  ): void;
  auditEntries(): readonly Readonly<GuardianAuditEntry>[];
}

/** Constant-time digest comparison (length-independent). */
function digestsEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/**
 * True when a style application result resolves EXACTLY the current state:
 * every registered knob value AND the full provenance trail are identical
 * (same order, same {knobId, value, source}). Used for style-mutation
 * idempotency: an identical re-submission reports `unchanged` and produces
 * no duplicate `style_change` audit entry.
 */
function styleResolutionEquals(
  current: Readonly<PersonaStyleWithProvenance>,
  next: {
    readonly style: Readonly<PersonaStyleState>;
    readonly provenance: readonly Readonly<PersonaKnobProvenanceEntry>[];
  },
): boolean {
  for (const knob of PERSONA_STYLE_KNOBS) {
    if (current.style[knob] !== next.style[knob]) {
      return false;
    }
  }
  if (current.provenance.length !== next.provenance.length) {
    return false;
  }
  return current.provenance.every((entry, index) => {
    const other = next.provenance[index];
    return (
      other !== undefined &&
      entry.knobId === other.knobId &&
      entry.value === other.value &&
      entry.source === other.source
    );
  });
}

export function createGuardianService(options: GuardianServiceOptions = {}): GuardianService {
  const policy = options.personaPolicy ?? resolveActivePersona();
  const clock = options.clock ?? (() => Date.now());
  const nowFactory = options.nowFactory ?? (() => new Date().toISOString());
  const tokenFactory =
    options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));

  // Seeded demo state (disclosed): disclosure acked, base consent active,
  // third-party egress switch DISABLED (fail-closed default).
  let authorizations: Readonly<GuardianAuthorizationState> =
    initialGuardianAuthorizationState(nowFactory());
  let style: Readonly<PersonaStyleWithProvenance> = personaDefaultStyle(policy);

  const sessions = new Map<string, GuardianSession>();
  let failedLogins = 0;
  let lockedUntilMs = 0;
  const audit: GuardianAuditEntry[] = [];
  let auditSeq = 0;
  let egressStatusProvider: (() => GuardianEgressStatus) | null = null;
  let usageSummaryProvider: (() => GuardianUsageSummary) | null = null;
  let dataLifecycleProvider: (() => {
    readonly inventory: () => Readonly<ChildDataInventory>;
    readonly exportData: () => Readonly<ChildDataExport>;
    readonly erase: (operatorRole: string) => Promise<Readonly<ChildDataEraseResult>>;
    readonly replayDeletions: (operatorRole: string) => Promise<Readonly<ChildDataEraseResult>>;
  }) | null = null;

  function pushAudit(
    kind: GuardianAuditEntry["kind"],
    fields: {
      readonly actorRole?: string | null;
      readonly actorId?: string | null;
      readonly target?: string | null;
      readonly detail?: string | null;
    },
  ): void {
    auditSeq += 1;
    const entry = parseGuardianAuditEntry({
      seq: auditSeq,
      at: nowFactory(),
      kind,
      actorRole: fields.actorRole ?? null,
      actorId: fields.actorId ?? null,
      target: fields.target ?? null,
      detail: fields.detail ?? null,
    });
    audit.push(entry);
    if (audit.length > MAX_AUDIT_ENTRIES) {
      audit.shift();
    }
  }

  // Seeds are SERVER-preset state, not actor actions, so they are disclosed
  // as `seed` audit entries with actorRole/actorId null (the
  // GuardianAuditEntry type comment: "null for seeds") — one burst per
  // service construction. Construction-scoping is the idempotency point:
  // the serving path builds this service exactly ONCE per process (the
  // getWebMvpRuntime globalThis singleton in web-mvp-runtime.ts), so the
  // burst happens once per process; a fresh process re-discloses its own
  // seeded state, which is precisely the provenance an auditor must be able
  // to see (initialGuardianAuthorizationState doc comment; API_CONTRACT
  // §12.4).
  pushAudit("seed", {
    actorRole: null,
    actorId: null,
    target: authorizations.disclosureAckVersion,
    detail: "acknowledged",
  });
  for (const consent of Object.values(authorizations.consents)) {
    pushAudit("seed", {
      actorRole: null,
      actorId: null,
      target: consent.consentId,
      detail: consent.active ? "active" : "inactive",
    });
  }
  for (const featureSwitch of Object.values(authorizations.switches)) {
    pushAudit("seed", {
      actorRole: null,
      actorId: null,
      target: featureSwitch.switchId,
      detail: featureSwitch.enabled ? "enabled" : "disabled",
    });
  }

  function errorResult(error: unknown): GuardianCallResult {
    const result = safeErrorResult(error, {}, nowFactory());
    return { kind: "error", httpStatus: result.httpStatus, envelope: result.envelope };
  }

  /** Generic login rejection — identical for wrong code and lockout. */
  function loginRejected(): GuardianCallResult {
    return errorResult(
      new ContractValidationError([
        problem(
          "CONTRACT_UNTRUSTED_IDENTITY",
          "accessCode",
          "The access code is invalid or access is not granted.",
        ),
      ]),
    );
  }

  /** Resolve the Authorization header to a server-verified actor. */
  function authenticate(header: string | null):
    | { readonly ok: true; readonly actor: Readonly<ActorContext>; readonly session: GuardianSession }
    | { readonly ok: false; readonly reason: "missing_or_malformed" | "invalid" | "expired" } {
    const token = sessionTokenFromAuthorizationHeader(header);
    if (token === null) {
      return { ok: false, reason: "missing_or_malformed" };
    }
    const session = sessions.get(token);
    if (session === undefined) {
      return { ok: false, reason: "invalid" };
    }
    if (clock() > session.expiresAtMs) {
      sessions.delete(token);
      return { ok: false, reason: "expired" };
    }
    const actor = parseActorContext({
      role: session.role,
      actorId: session.actorId,
      childRef: session.childRef,
      verifiedBy: "guardian-session-v1",
      verifiedAt: nowFactory(),
    });
    return { ok: true, actor, session };
  }

  /** Shared authenticated-entry helper: audit + 403 on any failure. */
  function requireSession(
    header: string | null,
    surface: Parameters<typeof assertGuardianSurfaceAccess>[1],
  ): { readonly actor: Readonly<ActorContext> } | GuardianCallResult {
    const auth = authenticate(header);
    if (!auth.ok) {
      pushAudit("access_denied", {
        actorRole: null,
        target: surface,
        detail: `session_${auth.reason}`,
      });
      return errorResult(
        new ContractValidationError([
          problem(
            "CONTRACT_UNTRUSTED_IDENTITY",
            "authorization",
            "A valid guardian session is required.",
          ),
        ]),
      );
    }
    try {
      assertGuardianSurfaceAccess(auth.actor, surface);
    } catch (error) {
      pushAudit("access_denied", {
        actorRole: auth.actor.role,
        actorId: auth.actor.actorId,
        target: surface,
        detail: "role_denied",
      });
      return errorResult(error);
    }
    return { actor: auth.actor };
  }

  function isCallResult(
    value: { readonly actor: Readonly<ActorContext> } | GuardianCallResult,
  ): value is GuardianCallResult {
    return (value as { readonly kind?: string }).kind !== undefined;
  }

  function principalForCode(accessCode: string): GuardianPrincipal | null {
    if (digestsEqual(accessCode, GUARDIAN_DEMO_ACCESS_CODE)) {
      return "guardian";
    }
    if (digestsEqual(accessCode, ADMIN_DEMO_ACCESS_CODE)) {
      return "admin";
    }
    return null;
  }

  return Object.freeze({
    sessionLogin(params: { readonly body: unknown }): GuardianCallResult {
      const now = nowFactory();
      try {
        const { accessCode } = parseGuardianLoginRequest(params.body);
        if (clock() < lockedUntilMs) {
          pushAudit("login_locked_out", { detail: "lockout_window" });
          return loginRejected();
        }
        const principal = principalForCode(accessCode);
        if (principal === null) {
          failedLogins += 1;
          if (failedLogins >= MAX_FAILED_LOGINS) {
            lockedUntilMs = clock() + LOGIN_LOCKOUT_MS;
            failedLogins = 0;
          }
          pushAudit("login_failed", { detail: "invalid_access_code" });
          return loginRejected();
        }
        failedLogins = 0;
        lockedUntilMs = 0;
        const token = tokenFactory();
        const session: GuardianSession = {
          token,
          principal,
          actorId: principal === "guardian" ? GUARDIAN_ACTOR_ID : ADMIN_ACTOR_ID,
          role: principal === "guardian" ? "guardian" : "system",
          childRef: principal === "guardian" ? GUARDIAN_FAMILY_CHILD_REF : null,
          createdAtMs: clock(),
          expiresAtMs: clock() + GUARDIAN_SESSION_TTL_MS,
        };
        sessions.set(token, session);
        if (sessions.size > MAX_SESSIONS) {
          let oldestToken: string | null = null;
          let oldestAt = Number.POSITIVE_INFINITY;
          for (const [existingToken, existing] of sessions) {
            if (existing.createdAtMs < oldestAt) {
              oldestAt = existing.createdAtMs;
              oldestToken = existingToken;
            }
          }
          if (oldestToken !== null) {
            sessions.delete(oldestToken);
          }
        }
        pushAudit("login_success", {
          actorRole: session.role,
          actorId: session.actorId,
          target: session.principal,
        });
        return {
          kind: "ok",
          httpStatus: 200,
          body: buildGuardianLoginResponse({
            sessionToken: token,
            principal: session.principal,
            role: session.role,
            actorId: session.actorId,
            childRef: session.childRef,
            expiresAt: new Date(session.expiresAtMs).toISOString(),
          }),
        };
      } catch (error) {
        return errorResult(error);
      }
    },

    sessionLogout(params: { readonly authorization: string | null }): GuardianCallResult {
      try {
        const auth = authenticate(params.authorization);
        if (!auth.ok) {
          pushAudit("access_denied", {
            target: "session_write",
            detail: `session_${auth.reason}`,
          });
          return errorResult(
            new ContractValidationError([
              problem(
                "CONTRACT_UNTRUSTED_IDENTITY",
                "authorization",
                "A valid guardian session is required.",
              ),
            ]),
          );
        }
        sessions.delete(auth.session.token);
        pushAudit("logout", {
          actorRole: auth.actor.role,
          actorId: auth.actor.actorId,
          target: auth.session.principal,
        });
        return { kind: "ok", httpStatus: 200, body: buildGuardianLogoutResponse() };
      } catch (error) {
        return errorResult(error);
      }
    },

    getAuthorizations(params: { readonly authorization: string | null }): GuardianCallResult {
      try {
        const session = requireSession(params.authorization, "status_read");
        if (isCallResult(session)) {
          return session;
        }
        const snapshot = buildGuardianStatusSnapshot({
          state: authorizations,
          egress:
            egressStatusProvider?.() ?? { providerRequestCounts: {}, thirdPartyProviderRequestCount: 0 },
          usage: usageSummaryProvider?.() ?? { conversationCount: 0 },
          style: {
            values: { ...style.style },
            provenance: style.provenance.map((entry) => ({ ...entry })),
          },
          activeSessions: sessions.size,
          auditTail: audit.slice(-STATUS_AUDIT_TAIL),
        });
        return { kind: "ok", httpStatus: 200, body: snapshot };
      } catch (error) {
        return errorResult(error);
      }
    },

    postAuthorizations(params: {
      readonly authorization: string | null;
      readonly body: unknown;
    }): GuardianCallResult {
      try {
        const session = requireSession(params.authorization, "authorization_mutation");
        if (isCallResult(session)) {
          return session;
        }
        const actor = session.actor;
        const action = parseGuardianAuthorizationAction(params.body);
        const now = nowFactory();

        if (action.kind === "set_persona_style") {
          // Style flows through the persona domain's ONLY trusted mutation
          // path with the guardian_config provenance (issue #16/#18).
          const transition = applyGuardianAuthorizationAction(authorizations, action, now);
          if (transition.status === "rejected") {
            return errorResult(
              new ContractValidationError([
                problem(
                  "CONTRACT_FIELD_INVALID",
                  "action",
                  "acknowledge the current disclosure before changing configuration.",
                ),
              ]),
            );
          }
          const applied = applyPersonaStyleKnobs(
            policy,
            style,
            action.updates as readonly PersonaKnobUpdate[],
            "guardian_config",
          );
          if (applied.status === "rejected") {
            // Structured rejection; submitted knob ids/values are not echoed.
            return errorResult(
              new ContractValidationError([
                problem(
                  "CONTRACT_FIELD_INVALID",
                  "updates",
                  `style update rejected: ${applied.reason}.`,
                ),
              ]),
            );
          }
          // Idempotency, same discipline as the consent/switch/ack
          // transitions (API_CONTRACT §12.2): a style POST whose RESOLVED
          // outcome is identical to the current style AND provenance is
          // `unchanged` — no state churn, no duplicate `style_change` audit.
          // Re-setting a knob to its current value still re-attributes
          // provenance on the first guardian touch
          // (system_default → guardian_config), so that real re-attribution
          // stays `applied` and audited.
          if (styleResolutionEquals(style, applied)) {
            return {
              kind: "ok",
              httpStatus: 200,
              body: { protocolVersion: "1.0", outcome: "unchanged" },
            };
          }
          style = Object.freeze({ style: applied.style, provenance: applied.provenance });
          pushAudit("style_change", {
            actorRole: actor.role,
            actorId: actor.actorId,
            target: action.updates.map((update) => update.knobId).join(","),
            detail: "guardian_config",
          });
          return { kind: "ok", httpStatus: 200, body: { protocolVersion: "1.0", outcome: "applied" } };
        }

        const transition = applyGuardianAuthorizationAction(authorizations, action, now);
        if (transition.status === "rejected") {
          return errorResult(
            new ContractValidationError([
              problem(
                "CONTRACT_FIELD_INVALID",
                "action",
                transition.reason === "unknown_disclosure_version"
                  ? "the disclosure version is not registered."
                  : "acknowledge the current disclosure before changing configuration.",
              ),
            ]),
          );
        }
        authorizations = transition.next;
        if (transition.status === "applied") {
          switch (action.kind) {
            case "acknowledge_disclosure":
              pushAudit("disclosure_ack", {
                actorRole: actor.role,
                actorId: actor.actorId,
                target: action.disclosureVersion,
              });
              break;
            case "grant_consent":
              pushAudit("consent_grant", {
                actorRole: actor.role,
                actorId: actor.actorId,
                target: action.consentId,
              });
              break;
            case "revoke_consent":
              pushAudit("consent_revoke", {
                actorRole: actor.role,
                actorId: actor.actorId,
                target: action.consentId,
              });
              break;
            case "set_feature_switch":
              pushAudit("switch_change", {
                actorRole: actor.role,
                actorId: actor.actorId,
                target: action.switchId,
                detail: action.enabled ? "enabled" : "disabled",
              });
              break;
            default:
              break;
          }
        }
        return {
          kind: "ok",
          httpStatus: 200,
          body: { protocolVersion: "1.0", outcome: transition.status },
        };
      } catch (error) {
        return errorResult(error);
      }
    },

    getAudit(params: { readonly authorization: string | null }): GuardianCallResult {
      try {
        const session = requireSession(params.authorization, "audit_read");
        if (isCallResult(session)) {
          return session;
        }
        return {
          kind: "ok",
          httpStatus: 200,
          body: { protocolVersion: "1.0", entries: audit.slice() },
        };
      } catch (error) {
        return errorResult(error);
      }
    },

    // -- R1-09 data lifecycle surfaces (issue #21) --------------------------

    getChildDataInventory(params: { readonly authorization: string | null }): GuardianCallResult {
      try {
        const session = requireSession(params.authorization, "data_read");
        if (isCallResult(session)) {
          return session;
        }
        const provider = dataLifecycleProvider;
        if (provider === null) {
          return errorResult(
            new ContractValidationError([
              problem("CONTRACT_INTERNAL", "lifecycle", "the data lifecycle provider is not wired."),
            ]),
          );
        }
        pushAudit("data_view", {
          actorRole: session.actor.role,
          actorId: session.actor.actorId,
          target: GUARDIAN_FAMILY_CHILD_REF,
          detail: "inventory",
        });
        return { kind: "ok", httpStatus: 200, body: provider().inventory() };
      } catch (error) {
        return errorResult(error);
      }
    },

    exportChildData(params: { readonly authorization: string | null }): GuardianCallResult {
      try {
        const session = requireSession(params.authorization, "data_export");
        if (isCallResult(session)) {
          return session;
        }
        const provider = dataLifecycleProvider;
        if (provider === null) {
          return errorResult(
            new ContractValidationError([
              problem("CONTRACT_INTERNAL", "lifecycle", "the data lifecycle provider is not wired."),
            ]),
          );
        }
        pushAudit("data_export", {
          actorRole: session.actor.role,
          actorId: session.actor.actorId,
          target: GUARDIAN_FAMILY_CHILD_REF,
          detail: "export_saved_content",
        });
        return { kind: "ok", httpStatus: 200, body: provider().exportData() };
      } catch (error) {
        return errorResult(error);
      }
    },

    async eraseChildData(params: {
      readonly authorization: string | null;
      readonly body: unknown;
    }): Promise<GuardianCallResult> {
      try {
        const session = requireSession(params.authorization, "data_erase");
        if (isCallResult(session)) {
          return session;
        }
        const provider = dataLifecycleProvider;
        if (provider === null) {
          return errorResult(
            new ContractValidationError([
              problem("CONTRACT_INTERNAL", "lifecycle", "the data lifecycle provider is not wired."),
            ]),
          );
        }
        // The subject is pinned server-side; the body only selects the action.
        const action = parseChildDataActionRequest(params.body);
        const result =
          action.kind === "erase_child_data"
            ? await provider().erase(session.actor.role)
            : await provider().replayDeletions(session.actor.role);
        pushAudit(action.kind === "erase_child_data" ? "data_erase" : "data_erase_replay", {
          actorRole: session.actor.role,
          actorId: session.actor.actorId,
          target: GUARDIAN_FAMILY_CHILD_REF,
          detail: `conv=${result.purged.conversations},hist=${result.purged.historyEntries},turn=${result.purged.turnStreams},mem=${result.purged.memories},dsh=${result.purged.dshSessions}`,
        });
        return { kind: "ok", httpStatus: 200, body: result };
      } catch (error) {
        return errorResult(error);
      }
    },

    assertModelInteractionAuthorized(actor: Readonly<ActorContext>): void {
      // Gate family members only: the single-family MVP's child and guardian
      // carry the family childRef; foreign/server principals pass (their
      // families would run their own authorization in a multi-family world).
      if (
        actor.childRef === GUARDIAN_FAMILY_CHILD_REF &&
        !isConsentActive(authorizations, "child_model_interaction")
      ) {
        throw new ContractValidationError([
          problem(
            "CONTRACT_WRONG_ROLE",
            "actor",
            "Model interaction is not currently authorized for this family.",
          ),
        ]);
      }
    },

    familyCancelPolicy(
      canceller: Readonly<ActorContext>,
      owner: { readonly actorId: string; readonly childRef: string | null; readonly turnId: string },
    ): boolean {
      const allowed = canCancelFamilyTurn(canceller, owner);
      if (allowed) {
        pushAudit("guardian_cancel", {
          actorRole: canceller.role,
          actorId: canceller.actorId,
          target: owner.turnId,
        });
      }
      return allowed;
    },

    currentFamilyStyle(): Readonly<PersonaStyleWithProvenance> {
      return style;
    },

    isThirdPartyEgressEnabled(): boolean {
      return isSwitchEnabled(authorizations, "third_party_data_egress");
    },

    isConversationRecordingEnabled(): boolean {
      return isSwitchEnabled(authorizations, "conversation_recording");
    },

    configureEgressStatus(provider: () => GuardianEgressStatus): void {
      egressStatusProvider = provider;
    },

    configureUsageSummary(provider: () => GuardianUsageSummary): void {
      usageSummaryProvider = provider;
    },

    configureDataLifecycle(provider: () => {
      readonly inventory: () => Readonly<ChildDataInventory>;
      readonly exportData: () => Readonly<ChildDataExport>;
      readonly erase: (operatorRole: string) => Promise<Readonly<ChildDataEraseResult>>;
      readonly replayDeletions: (operatorRole: string) => Promise<Readonly<ChildDataEraseResult>>;
    }): void {
      dataLifecycleProvider = provider;
    },

    auditEntries(): readonly Readonly<GuardianAuditEntry>[] {
      return audit.slice();
    },
  });
}
