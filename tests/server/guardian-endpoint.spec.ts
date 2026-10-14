/**
 * R1-06 server tests — the guardian service (issue #18): login verification
 * with constant-time comparison + lockout, opaque bearer sessions with
 * revocation, the guardian/admin role matrix on every route, consent
 * grant/revoke with the model-interaction gate, the egress switch state,
 * guardian persona style, and a no-leak audit trail (no access codes, no
 * session tokens). All credentials are synthetic demo values.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseActorContext, type ActorContext } from "../../lib/domain/contract/actor.ts";
import { ContractValidationError } from "../../lib/domain/contract/core.ts";
import {
  ADMIN_ACTOR_ID,
  GUARDIAN_ACTOR_ID,
  GUARDIAN_FAMILY_CHILD_REF,
  parseGuardianAuditEntry,
} from "../../lib/domain/guardian/authorizations.ts";
import {
  ADMIN_DEMO_ACCESS_CODE,
  GUARDIAN_DEMO_ACCESS_CODE,
  createGuardianService,
  type GuardianService,
} from "../../lib/server/guardian-service.ts";

const START_MS = Date.parse("2026-10-14T08:00:00.000Z");

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

interface Rig {
  readonly guardian: GuardianService;
  readonly nowMs: (ms: number) => void;
  readonly tokens: () => readonly string[];
}

function createRig(): Rig {
  let nowMs = START_MS;
  let tokenCounter = 0;
  const minted: string[] = [];
  const guardian = createGuardianService({
    clock: () => nowMs,
    nowFactory: () => new Date(nowMs).toISOString(),
    tokenFactory: () => {
      tokenCounter += 1;
      const token = `test${String(tokenCounter).padStart(4, "0")}${"A".repeat(43)}`;
      minted.push(token);
      return token;
    },
  });
  return { guardian, nowMs: (ms: number) => (nowMs = START_MS + ms), tokens: () => minted };
}

function guardianChildActor(): Readonly<ActorContext> {
  return parseActorContext({
    role: "child",
    actorId: "act_webmvp_demo01",
    childRef: GUARDIAN_FAMILY_CHILD_REF,
    verifiedBy: "web-mvp-local-identity",
    verifiedAt: "2026-10-14T08:00:00.000Z",
  });
}

function foreignChildActor(): Readonly<ActorContext> {
  return parseActorContext({
    role: "child",
    actorId: "act_otherchild01",
    childRef: "chd_demo_002",
    verifiedBy: "test-verifier",
    verifiedAt: "2026-10-14T08:00:00.000Z",
  });
}

function loginAs(rig: Rig, code: string): { readonly token: string; readonly principal: string; readonly role: string } {
  const result = rig.guardian.sessionLogin({
    body: { protocolVersion: "1.0", accessCode: code },
  });
  assert.equal(result.kind, "ok");
  if (result.kind !== "ok") {
    throw new Error("unreachable");
  }
  const body = result.body as { sessionToken: string; principal: string; role: string };
  return { token: body.sessionToken, principal: body.principal, role: body.role };
}

function bearer(token: string): string {
  return `Bearer ${token}`;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

test("guardian login mints an opaque session bound to the server-side family identity", () => {
  const rig = createRig();
  const result = rig.guardian.sessionLogin({
    body: { protocolVersion: "1.0", accessCode: GUARDIAN_DEMO_ACCESS_CODE },
  });
  assert.equal(result.kind, "ok");
  const body = (result.kind === "ok" ? result.body : null) as {
    sessionToken: string;
    principal: string;
    role: string;
    actorId: string;
    childRef: string | null;
  };
  assert.equal(body.principal, "guardian");
  assert.equal(body.role, "guardian");
  assert.equal(body.actorId, GUARDIAN_ACTOR_ID);
  assert.equal(body.childRef, GUARDIAN_FAMILY_CHILD_REF);
  assert.match(body.sessionToken, /^[A-Za-z0-9_-]{43,128}$/);
  const kinds = rig.guardian.auditEntries().map((entry) => entry.kind);
  assert.ok(kinds.includes("login_success"));
  // No credential material in the audit.
  assert.ok(!JSON.stringify(rig.guardian.auditEntries()).includes(GUARDIAN_DEMO_ACCESS_CODE));
});

test("wrong access codes fail with a generic, identical message (no enumeration, no echo)", () => {
  const rig = createRig();
  const first = rig.guardian.sessionLogin({
    body: { protocolVersion: "1.0", accessCode: "wrong-code-0001" },
  });
  const second = rig.guardian.sessionLogin({
    body: { protocolVersion: "1.0", accessCode: "totally-different" },
  });
  assert.equal(first.kind, "error");
  assert.equal(second.kind, "error");
  const firstEnvelope = first.kind === "error" ? first.envelope : null;
  const secondEnvelope = second.kind === "error" ? second.envelope : null;
  assert.equal(firstEnvelope?.error.code, "CONTRACT_UNTRUSTED_IDENTITY");
  assert.equal(firstEnvelope?.error.message, secondEnvelope?.error.message);
  assert.ok(!JSON.stringify(firstEnvelope).includes("wrong-code-0001"));
  const kinds = rig.guardian.auditEntries().map((entry) => entry.kind);
  assert.equal(kinds.filter((kind) => kind === "login_failed").length, 2);
});

test("repeated failures lock out login — even the CORRECT code is then rejected", () => {
  const rig = createRig();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = rig.guardian.sessionLogin({
      body: { protocolVersion: "1.0", accessCode: `bad-code-${attempt}` },
    });
    assert.equal(result.kind, "error");
  }
  const locked = rig.guardian.sessionLogin({
    body: { protocolVersion: "1.0", accessCode: GUARDIAN_DEMO_ACCESS_CODE },
  });
  assert.equal(locked.kind, "error");
  assert.ok(rig.guardian.auditEntries().some((entry) => entry.kind === "login_locked_out"));
  // After the lockout window passes, the correct code works again.
  rig.nowMs(15 * 60 * 1000 + 1);
  const recovered = loginAs(rig, GUARDIAN_DEMO_ACCESS_CODE);
  assert.equal(recovered.principal, "guardian");
});

test("malformed login bodies fail closed (unknown fields, missing code, unknown version)", () => {
  const rig = createRig();
  for (const body of [
    { accessCode: GUARDIAN_DEMO_ACCESS_CODE },
    { protocolVersion: "9.9", accessCode: GUARDIAN_DEMO_ACCESS_CODE },
    { protocolVersion: "1.0", accessCode: GUARDIAN_DEMO_ACCESS_CODE, role: "admin" },
    { protocolVersion: "1.0" },
  ]) {
    const result = rig.guardian.sessionLogin({ body });
    assert.equal(result.kind, "error", `expected rejection for ${JSON.stringify(Object.keys(body))}`);
  }
  assert.ok(!JSON.stringify(rig.guardian.auditEntries()).includes("admin"));
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

test("missing, malformed and unknown session tokens are all the same 403 (no existence leak)", () => {
  const rig = createRig();
  for (const authorization of [null, "Bearer", "Basic abc", `Bearer ${"x".repeat(43)}`]) {
    const result = rig.guardian.getAuthorizations({ authorization });
    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.equal(result.envelope.error.code, "CONTRACT_UNTRUSTED_IDENTITY");
    }
  }
  assert.ok(rig.guardian.auditEntries().every((entry) => entry.kind !== "login_success"));
});

test("logout revokes the session; the token is invalid for every surface afterwards", () => {
  const rig = createRig();
  const { token } = loginAs(rig, GUARDIAN_DEMO_ACCESS_CODE);
  const before = rig.guardian.getAuthorizations({ authorization: bearer(token) });
  assert.equal(before.kind, "ok");
  const logout = rig.guardian.sessionLogout({ authorization: bearer(token) });
  assert.equal(logout.kind, "ok");
  const after = rig.guardian.getAuthorizations({ authorization: bearer(token) });
  assert.equal(after.kind, "error");
  assert.ok(rig.guardian.auditEntries().some((entry) => entry.kind === "logout"));
});

// ---------------------------------------------------------------------------
// Role matrix on routes
// ---------------------------------------------------------------------------

test("independent admin reads status and audit but cannot mutate authorizations", () => {
  const rig = createRig();
  const { token } = loginAs(rig, ADMIN_DEMO_ACCESS_CODE);
  assert.equal(rig.guardian.getAuthorizations({ authorization: bearer(token) }).kind, "ok");
  assert.equal(rig.guardian.getAudit({ authorization: bearer(token) }).kind, "ok");
  const mutation = rig.guardian.postAuthorizations({
    authorization: bearer(token),
    body: { protocolVersion: "1.0", action: "revoke_consent", consentId: "child_model_interaction" },
  });
  assert.equal(mutation.kind, "error");
  if (mutation.kind === "error") {
    assert.equal(mutation.envelope.error.code, "CONTRACT_WRONG_ROLE");
  }
  assert.ok(
    rig.guardian
      .auditEntries()
      .some((entry) => entry.kind === "access_denied" && entry.detail === "role_denied"),
  );
  // The consent is untouched.
  assert.equal(
    rig.guardian
      .auditEntries()
      .filter((entry) => entry.kind === "consent_revoke")
      .length,
    0,
  );
});

// ---------------------------------------------------------------------------
// Consent transitions + the model-interaction gate
// ---------------------------------------------------------------------------

test("revoke → applied + audited; the consent gate then rejects family model turns; re-grant restores", () => {
  const rig = createRig();
  const { token } = loginAs(rig, GUARDIAN_DEMO_ACCESS_CODE);
  const auth = bearer(token);

  // Seed: gate open for the family child.
  rig.guardian.assertModelInteractionAuthorized(guardianChildActor());

  const revoke = rig.guardian.postAuthorizations({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "revoke_consent", consentId: "child_model_interaction" },
  });
  assert.equal(revoke.kind, "ok");
  assert.equal((revoke.kind === "ok" ? (revoke.body as { outcome: string }).outcome : ""), "applied");

  // Gate now rejects the family child…
  assertProblem(
    () => rig.guardian.assertModelInteractionAuthorized(guardianChildActor()),
    /Model interaction is not currently authorized/,
  );
  // …but never a foreign child (other families carry their own guardian).
  rig.guardian.assertModelInteractionAuthorized(foreignChildActor());

  const status = rig.guardian.getAuthorizations({ authorization: auth });
  assert.equal(status.kind, "ok");
  const snapshot = (status.kind === "ok" ? status.body : null) as {
    consents: { consentId: string; active: boolean }[];
  };
  assert.equal(snapshot.consents.find((consent) => consent.consentId === "child_model_interaction")?.active, false);

  const regrant = rig.guardian.postAuthorizations({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "grant_consent", consentId: "child_model_interaction" },
  });
  assert.equal(regrant.kind, "ok");
  rig.guardian.assertModelInteractionAuthorized(guardianChildActor());

  const kinds = rig.guardian.auditEntries().map((entry) => entry.kind);
  assert.ok(kinds.includes("consent_revoke"));
  assert.ok(kinds.includes("consent_grant"));
});

test("idempotent mutations report unchanged and do not duplicate audit entries", () => {
  const rig = createRig();
  const { token } = loginAs(rig, GUARDIAN_DEMO_ACCESS_CODE);
  const auth = bearer(token);
  const grant = rig.guardian.postAuthorizations({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "grant_consent", consentId: "child_model_interaction" },
  });
  assert.equal((grant.kind === "ok" ? (grant.body as { outcome: string }).outcome : ""), "unchanged");
  const ack = rig.guardian.postAuthorizations({
    authorization: auth,
    body: {
      protocolVersion: "1.0",
      action: "acknowledge_disclosure",
      disclosureVersion: "1.0.0",
    },
  });
  assert.equal((ack.kind === "ok" ? (ack.body as { outcome: string }).outcome : ""), "unchanged");
  assert.equal(rig.guardian.auditEntries().filter((entry) => entry.kind === "consent_grant").length, 0);
  assert.equal(rig.guardian.auditEntries().filter((entry) => entry.kind === "disclosure_ack").length, 0);
});

// ---------------------------------------------------------------------------
// Egress switch state
// ---------------------------------------------------------------------------

test("the third-party egress switch defaults to OFF and follows the guardian toggle", () => {
  const rig = createRig();
  assert.equal(rig.guardian.isThirdPartyEgressEnabled(), false);
  const { token } = loginAs(rig, GUARDIAN_DEMO_ACCESS_CODE);
  const enable = rig.guardian.postAuthorizations({
    authorization: bearer(token),
    body: {
      protocolVersion: "1.0",
      action: "set_feature_switch",
      switchId: "third_party_data_egress",
      enabled: true,
    },
  });
  assert.equal(enable.kind, "ok");
  assert.equal(rig.guardian.isThirdPartyEgressEnabled(), true);
  const disable = rig.guardian.postAuthorizations({
    authorization: bearer(token),
    body: {
      protocolVersion: "1.0",
      action: "set_feature_switch",
      switchId: "third_party_data_egress",
      enabled: false,
    },
  });
  assert.equal(disable.kind, "ok");
  assert.equal(rig.guardian.isThirdPartyEgressEnabled(), false);
  assert.ok(rig.guardian.auditEntries().some((entry) => entry.kind === "switch_change"));
});

// ---------------------------------------------------------------------------
// Guardian persona style (guardian_config provenance)
// ---------------------------------------------------------------------------

test("style changes flow through the trusted guardian_config provenance with an audit trail", () => {
  const rig = createRig();
  const { token } = loginAs(rig, GUARDIAN_DEMO_ACCESS_CODE);
  const before = rig.guardian.currentFamilyStyle();
  assert.equal(before.style.language_level, "simple");
  assert.ok(before.provenance.every((entry) => entry.source === "system_default"));

  const result = rig.guardian.postAuthorizations({
    authorization: bearer(token),
    body: {
      protocolVersion: "1.0",
      action: "set_persona_style",
      updates: [
        { knobId: "language_level", value: "advanced" },
        { knobId: "humor", value: "light" },
      ],
    },
  });
  assert.equal(result.kind, "ok");
  const after = rig.guardian.currentFamilyStyle();
  assert.equal(after.style.language_level, "advanced");
  assert.equal(after.style.humor, "light");
  assert.equal(after.provenance.find((entry) => entry.knobId === "language_level")?.source, "guardian_config");

  const styleChange = rig.guardian
    .auditEntries()
    .find((entry) => entry.kind === "style_change");
  assert.ok(styleChange !== undefined);
  assert.equal(styleChange?.detail, "guardian_config");
});

test("style updates with unregistered knobs/values are rejected without echo", () => {
  const rig = createRig();
  const { token } = loginAs(rig, GUARDIAN_DEMO_ACCESS_CODE);
  const badKnob = rig.guardian.postAuthorizations({
    authorization: bearer(token),
    body: {
      protocolVersion: "1.0",
      action: "set_persona_style",
      updates: [{ knobId: "voice_pitch", value: "high" }],
    },
  });
  assert.equal(badKnob.kind, "error");
  if (badKnob.kind === "error") {
    assert.ok(!JSON.stringify(badKnob.envelope).includes("voice_pitch"));
  }
  const badValue = rig.guardian.postAuthorizations({
    authorization: bearer(token),
    body: {
      protocolVersion: "1.0",
      action: "set_persona_style",
      updates: [{ knobId: "language_level", value: "shouting" }],
    },
  });
  assert.equal(badValue.kind, "error");
  // Style unchanged.
  assert.equal(rig.guardian.currentFamilyStyle().style.language_level, "simple");
});

// ---------------------------------------------------------------------------
// Audit integrity
// ---------------------------------------------------------------------------

test("every audit entry parses fail-closed and the trail never carries tokens or codes", () => {
  const rig = createRig();
  const { token } = loginAs(rig, GUARDIAN_DEMO_ACCESS_CODE);
  rig.guardian.getAuthorizations({ authorization: null });
  rig.guardian.getAuthorizations({ authorization: "Bearer garbage-garbage-garbage-garbage-garbage" });
  rig.guardian.postAuthorizations({
    authorization: bearer(token),
    body: { protocolVersion: "1.0", action: "set_feature_switch", switchId: "third_party_data_egress", enabled: true },
  });
  rig.guardian.sessionLogout({ authorization: bearer(token) });

  const entries = rig.guardian.auditEntries();
  assert.ok(entries.length >= 4);
  for (const entry of entries) {
    parseGuardianAuditEntry(entry); // throws on any malformed entry
  }
  const serialized = JSON.stringify(entries);
  assert.ok(!serialized.includes(token), "session tokens must never enter the audit");
  assert.ok(!serialized.includes(GUARDIAN_DEMO_ACCESS_CODE), "access codes must never enter the audit");
  assert.ok(!serialized.includes(ADMIN_DEMO_ACCESS_CODE), "access codes must never enter the audit");
  assert.ok(!serialized.includes("garbage-garbage"), "rejected header material must never enter the audit");
});
