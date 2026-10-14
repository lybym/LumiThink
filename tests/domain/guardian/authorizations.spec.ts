/**
 * R1-06 domain tests — guardian authorizations (issue #18): fail-closed
 * request parsing with no-echo, the disclosure registry, consent/switch
 * state transitions (ack-before-mutate, revocation always allowed,
 * idempotency), the status snapshot surface and the audit vocabulary.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CURRENT_GUARDIAN_DISCLOSURE_VERSION,
  GUARDIAN_CONSENT_IDS,
  GUARDIAN_DISCLOSURE_ID,
  GUARDIAN_FEATURE_SWITCH_IDS,
  applyGuardianAuthorizationAction,
  buildGuardianStatusSnapshot,
  currentGuardianDisclosure,
  initialGuardianAuthorizationState,
  parseGuardianAuthorizationAction,
  parseGuardianAuditEntry,
} from "../../../lib/domain/guardian/authorizations.ts";
import { parseGuardianLoginRequest } from "../../../lib/domain/guardian/session.ts";
import { ContractValidationError } from "../../../lib/domain/contract/core.ts";

const NOW = "2026-10-14T08:00:00.000Z";

function firstProblemMessage(error: unknown): string {
  assert.ok(error instanceof ContractValidationError, "expected ContractValidationError");
  const problem = error.problems[0];
  assert.ok(problem !== undefined);
  return problem.message;
}

/**
 * ContractValidationError's own message is the generic wrapper text; the
 * useful message lives on the structured problems — assert there.
 */
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

// ---------------------------------------------------------------------------
// Login request parsing (fail-closed, no identity fields, no echo)
// ---------------------------------------------------------------------------

test("login request parses the minimal credential payload", () => {
  const parsed = parseGuardianLoginRequest({
    protocolVersion: "1.0",
    accessCode: "some-access-code",
  });
  assert.equal(parsed.accessCode, "some-access-code");
});

test("login request rejects missing/unknown protocol versions", () => {
  assertProblem(
    () => parseGuardianLoginRequest({ accessCode: "some-access-code" }),
    /protocolVersion is required/,
  );
  assertProblem(
    () => parseGuardianLoginRequest({ protocolVersion: "9.9", accessCode: "some-access-code" }),
    /not a supported version/,
  );
});

test("login request rejects identity fields — no client-supplied role/actor/child_id path", () => {
  // Issue #18 AC: forged child_id and self-assigned roles must be rejected.
  const error = (() => {
    try {
      parseGuardianLoginRequest({
        protocolVersion: "1.0",
        accessCode: "some-access-code",
        role: "admin",
        actorId: "act_attacker0001",
        childId: "chd_demo_001",
      });
      return null;
    } catch (caught) {
      return caught;
    }
  })();
  assert.ok(error instanceof ContractValidationError);
  // No-echo: the submitted values never appear in the problems.
  const serialized = JSON.stringify(error.problems);
  assert.ok(!serialized.includes("admin"), "submitted role must not be echoed");
  assert.ok(!serialized.includes("act_attacker0001"), "submitted actor id must not be echoed");
  assert.match(serialized, /unknown field/);
});

test("login request rejects short credentials without echoing them", () => {
  let message = "";
  try {
    parseGuardianLoginRequest({ protocolVersion: "1.0", accessCode: "short" });
  } catch (error) {
    message = firstProblemMessage(error);
  }
  assert.match(message, /8-128 characters/);
  assert.ok(!message.includes("short"), "the submitted value must not be echoed");
});

// ---------------------------------------------------------------------------
// Action parsing
// ---------------------------------------------------------------------------

test("all five guardian actions parse with registered ids", () => {
  const ack = parseGuardianAuthorizationAction({
    protocolVersion: "1.0",
    action: "acknowledge_disclosure",
    disclosureVersion: "1.0.0",
  });
  assert.equal(ack.kind, "acknowledge_disclosure");
  assert.equal(ack.disclosureVersion, "1.0.0");

  const grant = parseGuardianAuthorizationAction({
    protocolVersion: "1.0",
    action: "grant_consent",
    consentId: "child_model_interaction",
  });
  assert.deepEqual(grant, { kind: "grant_consent", consentId: "child_model_interaction" });

  const revoke = parseGuardianAuthorizationAction({
    protocolVersion: "1.0",
    action: "revoke_consent",
    consentId: "child_model_interaction",
  });
  assert.deepEqual(revoke, { kind: "revoke_consent", consentId: "child_model_interaction" });

  const switchAction = parseGuardianAuthorizationAction({
    protocolVersion: "1.0",
    action: "set_feature_switch",
    switchId: "third_party_data_egress",
    enabled: true,
  });
  assert.deepEqual(switchAction, {
    kind: "set_feature_switch",
    switchId: "third_party_data_egress",
    enabled: true,
  });

  const style = parseGuardianAuthorizationAction({
    protocolVersion: "1.0",
    action: "set_persona_style",
    updates: [{ knobId: "language_level", value: "advanced" }],
  });
  assert.deepEqual(style, {
    kind: "set_persona_style",
    updates: [{ knobId: "language_level", value: "advanced" }],
  });
});

test("action parsing rejects unknown versions, actions, ids and shapes without echo", () => {
  const base = { protocolVersion: "1.0" };
  assertProblem(() => parseGuardianAuthorizationAction({ ...base, action: "promote_role" }), /not a registered guardian action/);
  assertProblem(
    () => parseGuardianAuthorizationAction({ ...base, action: "grant_consent", consentId: "constructor" }),
    /registered consent id/,
  );
  assertProblem(
    () =>
      parseGuardianAuthorizationAction({
        ...base,
        action: "set_feature_switch",
        switchId: "third_party_data_egress",
        enabled: "yes",
      }),
    /enabled must be a boolean/,
  );
  assertProblem(
    () =>
      parseGuardianAuthorizationAction({
        ...base,
        action: "acknowledge_disclosure",
        disclosureVersion: "constructor",
      }),
    /registered version/,
  );
  assertProblem(
    () => parseGuardianAuthorizationAction({ ...base, action: "grant_consent", consentId: "child_model_interaction", extra: 1 }),
    /unknown field/,
  );
  // No-echo across the rejected ids.
  assert.ok(
    !JSON.stringify(
      (() => {
        try {
          parseGuardianAuthorizationAction({ ...base, action: "grant_consent", consentId: "not_a_consent" });
          return "";
        } catch (error) {
          return JSON.stringify((error as ContractValidationError).problems);
        }
      })(),
    ).includes("not_a_consent"),
  );
});

test("style action rejects unknown/duplicate knobs and unregistered values", () => {
  const base = { protocolVersion: "1.0", action: "set_persona_style" };
  assertProblem(
    () => parseGuardianAuthorizationAction({ ...base, updates: [{ knobId: "voice_pitch", value: "high" }] }),
    /registered, non-duplicated knob id/,
  );
  assertProblem(
    () =>
      parseGuardianAuthorizationAction({
        ...base,
        updates: [
          { knobId: "language_level", value: "simple" },
          { knobId: "language_level", value: "advanced" },
        ],
      }),
    /non-duplicated/,
  );
  assertProblem(
    () => parseGuardianAuthorizationAction({ ...base, updates: [{ knobId: "language_level", value: "shouting" }] }),
    /registered value/,
  );
  assertProblem(() => parseGuardianAuthorizationAction({ ...base, updates: [] }), /non-empty/);
});

// ---------------------------------------------------------------------------
// Disclosure registry
// ---------------------------------------------------------------------------

test("the disclosure registry carries the current version with pending-verification flags", () => {
  const doc = currentGuardianDisclosure();
  assert.equal(doc.disclosureId, GUARDIAN_DISCLOSURE_ID);
  assert.equal(doc.version, CURRENT_GUARDIAN_DISCLOSURE_VERSION);
  assert.ok(doc.sections.length >= 4, "usage scope, third-party processing, monitoring boundary required");
  const pending = doc.sections.filter((section) => section.pendingVerification);
  assert.ok(
    pending.some((section) => /第三方/.test(section.heading) || /供应商/.test(section.body)),
    "third-party retention/jurisdiction facts must be flagged pending verification",
  );
  assert.ok(
    pending.some((section) => /渠道/.test(section.heading) || /12355/.test(section.body)),
    "crisis channel placeholders must be flagged pending verification (carried #27 caveat)",
  );
  for (const section of doc.sections) {
    assert.ok(section.body.length > 20, `section ${section.sectionId} must carry real content`);
  }
});

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

test("seed state: base consent active, third-party egress switch DISABLED, disclosure acked", () => {
  const state = initialGuardianAuthorizationState(NOW);
  assert.equal(state.disclosureAckVersion, CURRENT_GUARDIAN_DISCLOSURE_VERSION);
  assert.equal(state.consents.child_model_interaction.active, true);
  assert.equal(state.switches.third_party_data_egress.enabled, false);
});

test("grants and switch enablement require the current disclosure acknowledgment; revocation never does", () => {
  const unacked = { ...initialGuardianAuthorizationState(NOW), disclosureAckVersion: null };
  const grant = applyGuardianAuthorizationAction(
    unacked,
    { kind: "grant_consent", consentId: "child_model_interaction" },
    NOW,
  );
  assert.equal(grant.status, "rejected");
  assert.equal(grant.status === "rejected" ? grant.reason : "", "disclosure_not_acknowledged");

  const enable = applyGuardianAuthorizationAction(
    unacked,
    { kind: "set_feature_switch", switchId: "third_party_data_egress", enabled: true },
    NOW,
  );
  assert.equal(enable.status, "rejected");

  // Revocation is the fail-safe direction: always allowed.
  const revoke = applyGuardianAuthorizationAction(
    unacked,
    { kind: "revoke_consent", consentId: "child_model_interaction" },
    NOW,
  );
  assert.equal(revoke.status, "applied");
  assert.equal(revoke.status === "applied" ? revoke.next.consents.child_model_interaction.active : null, false);
});

test("transitions are idempotent: re-grant / re-revoke / same-value switch are unchanged", () => {
  const state = initialGuardianAuthorizationState(NOW);
  const regrant = applyGuardianAuthorizationAction(
    state,
    { kind: "grant_consent", consentId: "child_model_interaction" },
    NOW,
  );
  assert.equal(regrant.status, "unchanged");
  if (regrant.status === "unchanged") {
    assert.equal(regrant.next, state, "unchanged returns the SAME state object");
  }

  const revoque = applyGuardianAuthorizationAction(
    state,
    { kind: "revoke_consent", consentId: "child_model_interaction" },
    NOW,
  );
  assert.equal(revoque.status, "applied");
  const next = revoque.status === "applied" ? revoque.next : state;
  const rerevoke = applyGuardianAuthorizationAction(
    next,
    { kind: "revoke_consent", consentId: "child_model_interaction" },
    NOW,
  );
  assert.equal(rerevoke.status, "unchanged");

  const sameSwitch = applyGuardianAuthorizationAction(
    state,
    { kind: "set_feature_switch", switchId: "third_party_data_egress", enabled: false },
    NOW,
  );
  assert.equal(sameSwitch.status, "unchanged");
});

test("acknowledging a registered version applies; unregistered versions are rejected", () => {
  const unacked = { ...initialGuardianAuthorizationState(NOW), disclosureAckVersion: null };
  const bad = applyGuardianAuthorizationAction(
    unacked,
    { kind: "acknowledge_disclosure", disclosureVersion: "9.9.9" },
    NOW,
  );
  assert.equal(bad.status, "rejected");

  const good = applyGuardianAuthorizationAction(
    unacked,
    { kind: "acknowledge_disclosure", disclosureVersion: CURRENT_GUARDIAN_DISCLOSURE_VERSION },
    NOW,
  );
  assert.equal(good.status, "applied");
  assert.equal(good.status === "applied" ? good.next.disclosureAckVersion : null, CURRENT_GUARDIAN_DISCLOSURE_VERSION);
});

test("set_persona_style is state-neutral but still requires the acknowledgment", () => {
  const state = initialGuardianAuthorizationState(NOW);
  const ok = applyGuardianAuthorizationAction(
    state,
    { kind: "set_persona_style", updates: [{ knobId: "language_level", value: "advanced" }] },
    NOW,
  );
  assert.equal(ok.status, "unchanged");

  const unacked = { ...state, disclosureAckVersion: null };
  const blocked = applyGuardianAuthorizationAction(
    unacked,
    { kind: "set_persona_style", updates: [{ knobId: "language_level", value: "advanced" }] },
    NOW,
  );
  assert.equal(blocked.status, "rejected");
});

// ---------------------------------------------------------------------------
// Status snapshot
// ---------------------------------------------------------------------------

test("the status snapshot exposes counts and registry content — never chat content or tokens", () => {
  const state = initialGuardianAuthorizationState(NOW);
  const snapshot = buildGuardianStatusSnapshot({
    state,
    egress: { providerRequestCounts: { "mock-local": 3 }, thirdPartyProviderRequestCount: 0 },
    usage: { conversationCount: 2 },
    style: {
      values: { language_level: "standard" },
      provenance: [{ knobId: "language_level", value: "standard", source: "system_default" }],
    },
    activeSessions: 1,
    auditTail: [],
  });
  assert.equal(snapshot.protocolVersion, "1.0");
  assert.equal(snapshot.disclosure.document.version, CURRENT_GUARDIAN_DISCLOSURE_VERSION);
  assert.equal(snapshot.egress.thirdPartyProviderRequestCount, 0);
  assert.equal(snapshot.usage.conversationCount, 2);
  // Registry-ordered consent/switch projections.
  assert.deepEqual(
    snapshot.consents.map((consent) => consent.consentId),
    [...GUARDIAN_CONSENT_IDS],
  );
  assert.deepEqual(
    snapshot.switches.map((entry) => entry.switchId),
    [...GUARDIAN_FEATURE_SWITCH_IDS],
  );
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes("transcript"), "no transcript field may exist");
  assert.ok(!serialized.includes("sessionToken"), "no token field may exist");
});

// ---------------------------------------------------------------------------
// Audit vocabulary
// ---------------------------------------------------------------------------

test("audit entries parse fail-closed and reject unknown kinds/fields", () => {
  const entry = parseGuardianAuditEntry({
    seq: 1,
    at: NOW,
    kind: "consent_revoke",
    actorRole: "guardian",
    actorId: "act_guardian_demo01",
    target: "child_model_interaction",
    detail: null,
  });
  assert.equal(entry.kind, "consent_revoke");

  assertProblem(
    () => parseGuardianAuditEntry({ seq: 1, at: NOW, kind: "self_promotion", actorRole: null, target: null, detail: null }),
    /registered audit kind/,
  );
  assertProblem(() => parseGuardianAuditEntry({ seq: -1, at: NOW, kind: "logout" }), /non-negative integer/);
  assertProblem(
    () => parseGuardianAuditEntry({ seq: 1, at: NOW, kind: "logout", sneaky: "x" }),
    /unknown field/,
  );
  assertProblem(
    () => parseGuardianAuditEntry({ seq: 1, at: NOW, kind: "logout", detail: "x".repeat(81) }),
    /bounded string/,
  );
});
