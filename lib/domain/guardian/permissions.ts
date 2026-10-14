/**
 * R1-06 guardian permission rules (issue #18, PRD FR-005, Roadmap R1-06).
 *
 * Pure, fail-closed role/relationship decisions consumed by the server
 * layer:
 * - the guardian-surface role matrix: read surfaces admit the family
 *   guardian and the independent maintainer (admin) account; every MUTATION
 *   of family authorizations is guardian-only (issue #18 实现范围 1/3: role
 *   separation; the admin may observe, never reconfigure parental consent);
 * - the family cancellation rule: a verified guardian may stop an in-flight
 *   turn of the family child (contract §6 role matrix admits `guardian`
 *   with reason `guardian_stop`); a foreign childRef never matches, so
 *   cross-family cancel is structurally impossible;
 * - the provider egress rule: a provider classified as third-party may only
 *   be egress-authorized while the guardian feature switch is enabled AND
 *   the provider itself carries its own data-egress authorization; a local
 *   (no-egress) provider is always authorized. This drives the gateway's
 *   existing fail-closed `dataEgressAuthorized` gate (docs/MODEL_GATEWAY.md)
 *   through a dynamic getter — disabled egress means the gateway refuses
 *   the call BEFORE any transport is touched (issue #18 AC: 禁用第三方数据
 *   外发后供应商请求数为 0).
 *
 * There is deliberately no "promote role" rule anywhere: roles come only
 * from the server-side family registry + login verification; no API payload
 * in this module carries a role field (parsers in authorizations.ts reject
 * unknown fields), so a child cannot self-elevate (issue #18 实现范围 3).
 *
 * This module must stay dependency-free (no prisma, react, next or node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { type ActorContext } from "../contract/actor.ts";
import { ContractValidationError, problem } from "../contract/core.ts";
import { ADMIN_ACTOR_ID } from "./authorizations.ts";

/** Guardian surfaces this issue exposes (docs/API_CONTRACT.md §12). */
export type GuardianSurface = "status_read" | "audit_read" | "authorization_mutation" | "session_write";

/**
 * Role matrix. The contract knows exactly four roles (child | guardian |
 * system | voice_device); the independent maintainer account (PRD 维护者)
 * verifies as the `system` role carrying the admin actor id — so:
 * - read surfaces admit the family guardian and the admin principal;
 * - EVERY authorization mutation is guardian-only (the admin may observe,
 *   never reconfigure parental consent — issue #18 实现范围 1/3);
 * - child/voice_device never pass any guardian surface.
 */
export function isGuardianSurfaceAllowed(
  actor: Readonly<ActorContext>,
  surface: GuardianSurface,
): boolean {
  if (surface === "authorization_mutation") {
    return actor.role === "guardian";
  }
  return (
    actor.role === "guardian" ||
    (actor.role === "system" && actor.actorId === ADMIN_ACTOR_ID)
  );
}

/**
 * Assert form used by the guardian service after session authentication.
 * The actor must already be server-verified; anonymous callers never reach
 * this function (the server layer rejects them with
 * CONTRACT_UNTRUSTED_IDENTITY before any domain check).
 */
export function assertGuardianSurfaceAccess(
  actor: Readonly<ActorContext>,
  surface: GuardianSurface,
): void {
  if (isGuardianSurfaceAllowed(actor, surface)) {
    return;
  }
  // Role names are public vocabulary; the actor id is not echoed.
  const detail =
    surface === "authorization_mutation"
      ? "authorization mutations are guardian-only"
      : "allowed roles: guardian, system(admin)";
  throw new ContractValidationError([
    problem(
      "CONTRACT_WRONG_ROLE",
      `guardian.${surface}`,
      `role "${actor.role}" may not use this surface; ${detail}.`,
    ),
  ]);
}

/**
 * Family-cancellation rule (R1-06 角色分权 wiring of contract §6): a
 * verified GUARDIAN may cancel a turn owned by another principal ONLY when
 * that owner is bound to the SAME family childRef. Self-cancellation
 * (ownerActorId equality) is handled upstream by the interaction service's
 * existing actor scoping and is NOT this rule's concern. Foreign childRefs
 * never pass — no existence leak (the interaction service maps a false
 * result to the indistinguishable `unknown_turn` no-op).
 */
export function canCancelFamilyTurn(
  canceller: Readonly<ActorContext>,
  owner: { readonly actorId: string; readonly childRef: string | null; readonly turnId: string },
): boolean {
  if (canceller.role !== "guardian") {
    return false;
  }
  if (canceller.childRef === null || owner.childRef === null) {
    return false;
  }
  return canceller.childRef === owner.childRef;
}

// ---------------------------------------------------------------------------
// Provider egress rule (issue #18 AC: disabled third-party egress → 0 vendor
// requests)
// ---------------------------------------------------------------------------

/** How a provider's data path is classified for the egress gate. */
export const PROVIDER_EGRESS_CLASSES = Object.freeze(["local_no_egress", "third_party_api"] as const);

export type ProviderEgressClass = (typeof PROVIDER_EGRESS_CLASSES)[number];

/**
 * Whether a provider may carry model traffic right now. Evaluated per call:
 * - `local_no_egress` providers (in-process mock) are always authorized —
 *   they have no external egress by construction;
 * - `third_party_api` providers require BOTH the provider's own static
 *   data-egress authorization record AND the guardian feature switch to be
 *   enabled right now.
 */
export function providerEgressAuthorized(
  classification: ProviderEgressClass,
  providerSelfAuthorized: boolean,
  thirdPartyEgressEnabled: boolean,
): boolean {
  if (classification === "local_no_egress") {
    return providerSelfAuthorized;
  }
  return providerSelfAuthorized && thirdPartyEgressEnabled;
}

/** Fail-closed assertion form used by the server-side provider gate. */
export function assertProviderEgressPermitted(
  classification: ProviderEgressClass,
  providerSelfAuthorized: boolean,
  thirdPartyEgressEnabled: boolean,
): void {
  if (!providerEgressAuthorized(classification, providerSelfAuthorized, thirdPartyEgressEnabled)) {
    throw new ContractValidationError([
      problem(
        "CONTRACT_WRONG_ROLE",
        "provider.egress",
        "third-party data egress is not currently authorized by the guardian.",
      ),
    ]);
  }
}
