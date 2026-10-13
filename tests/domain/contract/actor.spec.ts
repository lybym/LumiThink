import assert from "node:assert/strict";
import test from "node:test";

import { ContractValidationError } from "../../../lib/domain/contract/core.ts";
import {
  createSessionRef,
  parseActorContext,
  parseSessionRef,
  assertCanSubmitTextInteraction,
  assertRoleIn,
} from "../../../lib/domain/contract/actor.ts";

import {
  syntheticChildActor,
  syntheticGuardianActor,
  syntheticSystemActor,
  syntheticVoiceDeviceActor,
  syntheticSessionRef,
} from "../../../lib/domain/contract/fixtures.ts";

function problemsOf(error: unknown): { code: string; path: string }[] {
  assert.ok(error instanceof ContractValidationError, "expected ContractValidationError");
  return error.problems.map((p) => ({ code: p.code, path: p.path }));
}

test("all four roles parse as server-verified actors", () => {
  for (const actor of [
    syntheticChildActor,
    syntheticGuardianActor,
    syntheticSystemActor,
    syntheticVoiceDeviceActor,
  ]) {
    const parsed = parseActorContext(actor);
    assert.equal(parsed.role, actor.role);
    assert.equal(parsed.actorId, actor.actorId);
  }
});

test("child, guardian and voice_device require a childRef; system must not have one", () => {
  const withoutChild = { ...syntheticChildActor, childRef: undefined };
  assert.throws(() => parseActorContext(withoutChild), (error: unknown) => {
    const problems = problemsOf(error);
    assert.ok(problems.some((p) => p.path === "actor.childRef" && p.code === "CONTRACT_FIELD_MISSING"));
    return true;
  });

  const systemWithChild = { ...syntheticSystemActor, childRef: "chd_demo_001" };
  assert.throws(() => parseActorContext(systemWithChild), (error: unknown) => {
    const problems = problemsOf(error);
    assert.ok(problems.some((p) => p.path === "actor.childRef" && p.code === "CONTRACT_FIELD_INVALID"));
    return true;
  });
});

test("unknown role strings are rejected without echoing the value", () => {
  const marker = "secret-role-claim";
  assert.throws(() => parseActorContext({ ...syntheticChildActor, role: marker }), (error: unknown) => {
    const problems = problemsOf(error);
    assert.ok(problems.some((p) => p.path === "actor.role" && p.code === "CONTRACT_FIELD_INVALID"));
    assert.equal(JSON.stringify(problems).includes(marker), false);
    return true;
  });
});

test("actor validation rejects malformed ids, verifiedBy and timestamps", () => {
  assert.throws(
    () => parseActorContext({ ...syntheticChildActor, actorId: "child_demo_001" }),
    ContractValidationError,
  );
  assert.throws(
    () => parseActorContext({ ...syntheticChildActor, verifiedBy: "not a valid token!" }),
    ContractValidationError,
  );
  assert.throws(
    () => parseActorContext({ ...syntheticChildActor, verifiedAt: "13.10.2026" }),
    ContractValidationError,
  );
});

test("actor validation rejects unknown extra fields (additionalProperties=false)", () => {
  assert.throws(
    () => parseActorContext({ ...syntheticChildActor, trusted: true }),
    (error: unknown) => {
      const problems = problemsOf(error);
      return problems.some((p) => p.path === "actor.trusted" && p.code === "CONTRACT_FIELD_INVALID");
    },
  );
});

test("only child, guardian and system may submit text interactions; voice_device may not", () => {
  assert.doesNotThrow(() => assertCanSubmitTextInteraction(syntheticChildActor));
  assert.doesNotThrow(() => assertCanSubmitTextInteraction(syntheticGuardianActor));
  assert.doesNotThrow(() => assertCanSubmitTextInteraction(syntheticSystemActor));
  assert.throws(() => assertCanSubmitTextInteraction(syntheticVoiceDeviceActor), (error: unknown) => {
    const problems = problemsOf(error);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].code, "CONTRACT_WRONG_ROLE");
    assert.equal(problems[0].path, "actor.role");
    return true;
  });
});

test("assertRoleIn enforces the given allow-list", () => {
  assert.doesNotThrow(() => assertRoleIn(syntheticGuardianActor, ["guardian"], "actor.role"));
  assert.throws(
    () => assertRoleIn(syntheticChildActor, ["guardian"], "actor.role"),
    (error: unknown) => problemsOf(error)[0].code === "CONTRACT_WRONG_ROLE",
  );
});

test("session refs parse, validate ids and reject unknown fields", () => {
  const parsed = parseSessionRef(syntheticSessionRef);
  assert.equal(parsed.conversationId, syntheticSessionRef.conversationId);
  assert.equal(parsed.role, "child");

  assert.throws(
    () => parseSessionRef({ ...syntheticSessionRef, sessionId: "req_fixture_web_t1_0001" }),
    ContractValidationError,
  );
  assert.throws(
    () => parseSessionRef({ ...syntheticSessionRef, extra: true }),
    (error: unknown) => {
      const problems = problemsOf(error);
      return problems.some((p) => p.path === "sessionRef.extra");
    },
  );
});

test("createSessionRef validates the caller-supplied ids", () => {
  const created = createSessionRef(syntheticGuardianActor, {
    sessionId: "ses_demo_session_0002",
    conversationId: "conv_demo_conversation_0002",
    createdAt: "2026-10-13T10:05:00.000Z",
  });
  assert.equal(created.actorId, syntheticGuardianActor.actorId);
  assert.equal(created.role, "guardian");

  assert.throws(
    () =>
      createSessionRef(syntheticGuardianActor, {
        sessionId: "bad_prefix_demo_0002",
        conversationId: "conv_demo_conversation_0002",
        createdAt: "2026-10-13T10:05:00.000Z",
      }),
    ContractValidationError,
  );
});
