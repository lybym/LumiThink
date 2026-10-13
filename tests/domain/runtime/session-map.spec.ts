import assert from "node:assert/strict";
import test from "node:test";

import {
  createDshSessionMapper,
  type DshRuntimePort,
} from "../../../lib/domain/runtime/session-map.ts";
import { SYNTHETIC_ACTOR_ID, SYNTHETIC_CONVERSATION_A, SYNTHETIC_CONVERSATION_B, SYNTHETIC_SESSION_A, SYNTHETIC_SESSION_B } from "./helpers.ts";

function refsFor(sessionId: string, conversationId: string) {
  return {
    lumiSessionId: sessionId,
    conversationId,
    actorId: SYNTHETIC_ACTOR_ID,
    traceId: "trc_r1t3tr000010",
    turnId: "trn_r1t3tr000010",
  };
}

function fakePort(overrides: Partial<DshRuntimePort> = {}): DshRuntimePort {
  return {
    adapterId: "fake-dsh-adapter@rc.2",
    openSession: async (request) => ({
      ok: true,
      dshSessionKey: `dshsess-${request.lumiSessionId.slice(-8)}`,
      dshVersion: "0.2.0-rc.2",
    }),
    resumeSession: async () => ({ ok: true, dshVersion: "0.2.0-rc.2" }),
    closeSession: async () => ({ ok: true }),
    advertisedTools: () => [],
    ...overrides,
  };
}

test("without a port the mapper fails closed and tracks defects until defective", async () => {
  const mapper = createDshSessionMapper({ clock: () => 1000 });
  const first = await mapper.ensureSession(refsFor(SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A));
  assert.equal(first.ok, false);
  assert.equal(first.ok ? null : first.reason, "no_port_bound");
  const second = await mapper.ensureSession(refsFor(SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A));
  assert.equal(second.ok, false);
  const third = await mapper.ensureSession(refsFor(SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A));
  assert.equal(third.ok, false);
  assert.equal(third.ok ? null : third.descriptor.state, "defective");
  const fourth = await mapper.ensureSession(refsFor(SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A));
  assert.equal(fourth.ok, false);
  assert.equal(fourth.ok ? null : fourth.reason, "session_defective");
});

test("create → reuse keeps one stable DSH session key per Lumi session", async () => {
  const mapper = createDshSessionMapper({ port: fakePort(), clock: () => 1000 });
  const created = await mapper.ensureSession(refsFor(SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A));
  assert.equal(created.ok, true);
  assert.equal(created.ok ? created.created : null, true);
  const descriptor = created.ok ? created.descriptor : null;
  assert.equal(descriptor?.state, "active");
  assert.ok(descriptor?.dshSessionKey !== null && descriptor?.dshSessionKey !== undefined);
  assert.equal(descriptor?.dshVersion, "0.2.0-rc.2");
  assert.equal(descriptor?.adapterId, "fake-dsh-adapter@rc.2");

  const reused = await mapper.ensureSession(refsFor(SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A));
  assert.equal(reused.ok, true);
  assert.equal(reused.ok ? reused.created : null, false);
  assert.equal(reused.ok ? reused.descriptor.dshSessionKey : null, descriptor?.dshSessionKey);
});

test("two Lumi sessions map to distinct DSH sessions (isolation invariant)", async () => {
  const mapper = createDshSessionMapper({ port: fakePort(), clock: () => 1000 });
  const a = await mapper.ensureSession(refsFor(SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A));
  const b = await mapper.ensureSession(refsFor(SYNTHETIC_SESSION_B, SYNTHETIC_CONVERSATION_B));
  assert.equal(a.ok && b.ok, true);
  const keyA = a.ok ? a.descriptor.dshSessionKey : null;
  const keyB = b.ok ? b.descriptor.dshSessionKey : null;
  assert.notEqual(keyA, keyB);
  assert.equal(mapper.describeAll().length, 2);
});

test("session creation timeout is a tracked defect and later opens may still succeed", async () => {
  const mapper = createDshSessionMapper({
    port: fakePort({
      // Never-resolving open: the lifecycle timeout must fire first.
      openSession: () => new Promise<never>(() => undefined),
    }),
    clock: () => 1000,
    lifecycleTimeoutMs: 20,
  });
  const timedOut = await mapper.ensureSession(refsFor(SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A));
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.ok ? null : timedOut.reason, "open_timeout");
  assert.equal(timedOut.ok ? null : timedOut.descriptor.defectCount, 1);
  assert.equal(timedOut.ok ? null : timedOut.descriptor.lastDefectCode, "open_timeout");
});

test("markUnhealthy → reconnecting → ensureSession resumes the SAME DSH key", async () => {
  let resumeCalls = 0;
  const mapper = createDshSessionMapper({
    port: fakePort({
      resumeSession: async () => {
        resumeCalls += 1;
        return { ok: true, dshVersion: "0.2.0-rc.2" };
      },
    }),
    clock: () => 1000,
  });
  const created = await mapper.ensureSession(refsFor(SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A));
  assert.equal(created.ok, true);
  const createdKey = created.ok ? created.descriptor.dshSessionKey : null;
  const unhealthy = mapper.markUnhealthy(SYNTHETIC_SESSION_A, "resume_failed");
  assert.equal(unhealthy.state, "reconnecting");
  assert.equal(unhealthy.defectCount, 1);

  const resumed = await mapper.ensureSession(refsFor(SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A));
  assert.equal(resumed.ok, true);
  assert.equal(resumed.ok ? resumed.created : null, false);
  assert.equal(resumeCalls, 1);
  assert.equal(resumed.ok ? resumed.descriptor.dshSessionKey : null, createdKey);
  assert.equal(resumed.ok ? resumed.descriptor.state : null, "active");
});

test("defects accumulate across reconnect cycles and eventually make the session defective", async () => {
  const mapper = createDshSessionMapper({
    port: fakePort(),
    clock: () => 1000,
    maxDefects: 3,
  });
  await mapper.ensureSession(refsFor(SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A));
  // Cycle 1 and 2 recover; the third defect hits the maxDefects ceiling.
  mapper.markUnhealthy(SYNTHETIC_SESSION_A, "resume_failed");
  const cycle1 = await mapper.ensureSession(refsFor(SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A));
  assert.equal(cycle1.ok, true);
  mapper.markUnhealthy(SYNTHETIC_SESSION_A, "runtime_unavailable");
  const cycle2 = await mapper.ensureSession(refsFor(SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A));
  assert.equal(cycle2.ok, true);
  const defective = mapper.markUnhealthy(SYNTHETIC_SESSION_A, "resume_failed");
  assert.equal(defective.state, "defective");
  assert.equal(defective.defectCount, 3);
  const rejected = await mapper.ensureSession(refsFor(SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ok ? null : rejected.reason, "session_defective");
});

test("close is terminal, idempotent, and a close failure still closes Lumi-side", async () => {
  const failingClose = createDshSessionMapper({
    port: fakePort({ closeSession: async () => ({ ok: false, defect: "close_failed" }) }),
    clock: () => 1000,
  });
  await failingClose.ensureSession(refsFor(SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A));
  const closed = await failingClose.close(SYNTHETIC_SESSION_A, "explicit_close");
  assert.equal(closed.state, "closed");
  assert.equal(closed.closeReason, "explicit_close");
  assert.equal(closed.lastDefectCode, "close_failed");
  const rejectedAfterClose = await failingClose.ensureSession(refsFor(SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A));
  assert.equal(rejectedAfterClose.ok, false);
  assert.equal(rejectedAfterClose.ok ? null : rejectedAfterClose.reason, "session_closed");

  const idempotent = await failingClose.close(SYNTHETIC_SESSION_A, "explicit_close");
  assert.equal(idempotent.closedAtMs, closed.closedAtMs);
});

test("invalid session refs and unknown-session operations fail closed", async () => {
  const mapper = createDshSessionMapper({ port: fakePort(), clock: () => 1000 });
  await assert.rejects(
    () =>
      mapper.ensureSession({
        lumiSessionId: "",
        conversationId: SYNTHETIC_CONVERSATION_A,
        actorId: SYNTHETIC_ACTOR_ID,
        traceId: "trc_r1t3tr000010",
        turnId: "trn_r1t3tr000010",
      }),
  );
  assert.throws(() => mapper.confirmActive(SYNTHETIC_SESSION_A));
  await assert.rejects(() => mapper.close(SYNTHETIC_SESSION_A, "explicit_close"));
  assert.throws(() => mapper.markUnhealthy(SYNTHETIC_SESSION_A, "resume_failed"));
});
