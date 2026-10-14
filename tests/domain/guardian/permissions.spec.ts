/**
 * R1-06 domain tests — guardian permission rules (issue #18): the guardian
 * surface role matrix (guardian vs independent admin vs child/system),
 * the family cancellation rule, and the provider egress rule that keeps
 * vendor requests at 0 while third-party egress is disabled.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseActorContext, type ActorContext } from "../../../lib/domain/contract/actor.ts";
import { ContractValidationError } from "../../../lib/domain/contract/core.ts";
import {
  ADMIN_ACTOR_ID,
  GUARDIAN_ACTOR_ID,
  GUARDIAN_FAMILY_CHILD_REF,
} from "../../../lib/domain/guardian/authorizations.ts";
import {
  assertGuardianSurfaceAccess,
  assertProviderEgressPermitted,
  canCancelFamilyTurn,
  isGuardianSurfaceAllowed,
  providerEgressAuthorized,
} from "../../../lib/domain/guardian/permissions.ts";

const NOW = "2026-10-14T08:00:00.000Z";

/** Problem-message assertion (the wrapper error message is generic). */
function assertProblem(fn: () => unknown, pattern: RegExp): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ContractValidationError, "expected ContractValidationError");
    assert.ok(
      error.problems.some((problem) => pattern.test(problem.message)),
      `expected a problem matching ${String(pattern)}; got ${JSON.stringify(error.problems)}`,
    );
    return;
  }
  assert.fail("expected the call to throw a ContractValidationError");
}

function guardianActor(): Readonly<ActorContext> {
  return parseActorContext({
    role: "guardian",
    actorId: GUARDIAN_ACTOR_ID,
    childRef: GUARDIAN_FAMILY_CHILD_REF,
    verifiedBy: "guardian-session-v1",
    verifiedAt: NOW,
  });
}

function adminActor(): Readonly<ActorContext> {
  return parseActorContext({
    role: "system",
    actorId: ADMIN_ACTOR_ID,
    childRef: null,
    verifiedBy: "guardian-session-v1",
    verifiedAt: NOW,
  });
}

function childActor(childRef: string = GUARDIAN_FAMILY_CHILD_REF): Readonly<ActorContext> {
  return parseActorContext({
    role: "child",
    actorId: "act_webmvp_demo01",
    childRef,
    verifiedBy: "web-mvp-local-identity",
    verifiedAt: NOW,
  });
}

// ---------------------------------------------------------------------------
// Surface role matrix
// ---------------------------------------------------------------------------

test("guardian may read every surface and mutate authorizations", () => {
  const actor = guardianActor();
  assertGuardianSurfaceAccess(actor, "status_read");
  assertGuardianSurfaceAccess(actor, "audit_read");
  assertGuardianSurfaceAccess(actor, "authorization_mutation");
  assert.equal(isGuardianSurfaceAllowed(actor, "authorization_mutation"), true);
});

test("independent admin may read but NEVER mutate family authorizations", () => {
  const actor = adminActor();
  assertGuardianSurfaceAccess(actor, "status_read");
  assertGuardianSurfaceAccess(actor, "audit_read");
  assertProblem(
    () => assertGuardianSurfaceAccess(actor, "authorization_mutation"),
    /guardian-only/,
  );
});

test("a system principal with a different actor id is not the admin", () => {
  const actor = parseActorContext({
    role: "system",
    actorId: "act_otheradmin01",
    childRef: null,
    verifiedBy: "test-verifier",
    verifiedAt: NOW,
  });
  assert.equal(isGuardianSurfaceAllowed(actor, "status_read"), false);
  assert.throws(() => assertGuardianSurfaceAccess(actor, "audit_read"));
});

test("child and voice_device principals never pass any guardian surface", () => {
  const child = childActor();
  for (const surface of ["status_read", "audit_read", "authorization_mutation"] as const) {
    assertProblem(() => assertGuardianSurfaceAccess(child, surface), /may not use this surface/);
  }
  const device = parseActorContext({
    role: "voice_device",
    actorId: "act_voicedev001",
    childRef: GUARDIAN_FAMILY_CHILD_REF,
    verifiedBy: "test-verifier",
    verifiedAt: NOW,
  });
  assertProblem(() => assertGuardianSurfaceAccess(device, "status_read"), /may not use this surface/);
});

// ---------------------------------------------------------------------------
// Family cancellation
// ---------------------------------------------------------------------------

test("a guardian may cancel only same-family turns (childRef match)", () => {
  const guardian = guardianActor();
  assert.equal(
    canCancelFamilyTurn(guardian, {
      actorId: "act_webmvp_demo01",
      childRef: GUARDIAN_FAMILY_CHILD_REF,
      turnId: "trn_test0001",
    }),
    true,
  );
  assert.equal(
    canCancelFamilyTurn(guardian, {
      actorId: "act_otherchild01",
      childRef: "chd_demo_002",
      turnId: "trn_test0002",
    }),
    false,
  );
  assert.equal(
    canCancelFamilyTurn(guardian, { actorId: "act_orphan0001", childRef: null, turnId: "trn_test0003" }),
    false,
  );
});

test("child and admin cancellers never pass the family cancel rule", () => {
  const owner = {
    actorId: "act_webmvp_demo01",
    childRef: GUARDIAN_FAMILY_CHILD_REF,
    turnId: "trn_test0004",
  };
  assert.equal(canCancelFamilyTurn(childActor(), owner), false);
  assert.equal(canCancelFamilyTurn(adminActor(), owner), false);
});

// ---------------------------------------------------------------------------
// Provider egress rule
// ---------------------------------------------------------------------------

test("local (no-egress) providers are always authorized; third-party require the switch", () => {
  assert.equal(providerEgressAuthorized("local_no_egress", true, false), true);
  assert.equal(providerEgressAuthorized("local_no_egress", true, true), true);
  // Defensive: a local provider that lost its own authorization stays blocked.
  assert.equal(providerEgressAuthorized("local_no_egress", false, true), false);

  assert.equal(providerEgressAuthorized("third_party_api", true, false), false);
  assert.equal(providerEgressAuthorized("third_party_api", true, true), true);
  assert.equal(providerEgressAuthorized("third_party_api", false, true), false);
});

test("the assertion form throws the contract wrong-role error when blocked", () => {
  assertProblem(
    () => assertProviderEgressPermitted("third_party_api", true, false),
    /third-party data egress is not currently authorized/,
  );
  assert.doesNotThrow(() => assertProviderEgressPermitted("local_no_egress", true, false));
});
