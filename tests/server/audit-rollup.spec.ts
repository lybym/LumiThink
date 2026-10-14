/**
 * R1-08 audit-trace rollup + log-sanitization negative tests (issue #20
 * 交付范围 4; AC 3 日志脱敏负向测试).
 *
 * AC (交付范围 4): one audited turn must expose, across the runtime trace +
 * gateway audit, the request id, model / persona / skill / evidence versions,
 * the TOKEN COST and the error classification — with no content fields.
 * AC 3: after injecting pseudo keys, names and family information, NOTHING
 * emitted to the ordinary log/audit surfaces (guardian audit ring, runtime
 * trace, gateway audit, error envelopes) matches the dirty markers.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseActorContext, type ActorContext } from "../../lib/domain/contract/actor.ts";
import { resolveWebMvpActor } from "../../lib/server/interaction-service.ts";
import { createWebMvpRuntime } from "../../lib/server/web-mvp-runtime.ts";
import { GUARDIAN_DEMO_ACCESS_CODE } from "../../lib/server/guardian-service.ts";

const NOW = "2026-10-14T08:00:00.000Z";

function childActor(): Readonly<ActorContext> {
  return resolveWebMvpActor(NOW);
}

function submitBody(content: string, requestId: string): Record<string, unknown> {
  return {
    protocolVersion: "1.0",
    interaction: {
      kind: "text",
      clientRequestId: requestId,
      text: { content, format: "plain" },
      clientContext: { client: "web", clientVersion: "2.0.0-web" },
    },
  };
}

async function runTurn(
  runtime: ReturnType<typeof createWebMvpRuntime>,
  content: string,
  requestId: string,
): Promise<void> {
  const result = await runtime.service.submitInteraction({ body: submitBody(content, requestId), actor: childActor() });
  assert.equal(result.kind, "ack");
  if (result.kind !== "ack") {
    throw new Error("unreachable");
  }
  const opened = runtime.service.openEventStream({ actor: childActor(), traceId: result.body.traceId });
  assert.equal(opened.kind, "stream");
  if (opened.kind !== "stream") {
    throw new Error("unreachable");
  }
  for await (const frame of opened.events) {
    // Drain to the terminal event (content-agnostic here; the dirty-marker
    // test below separately inspects AUDIT surfaces, not the SSE channel —
    // the SSE channel is the child-facing product surface by contract).
    void frame;
  }
}

function allAuditSurfaces(runtime: ReturnType<typeof createWebMvpRuntime>): string[] {
  return [
    JSON.stringify(runtime.guardian.auditEntries()),
    JSON.stringify(runtime.trace.events()),
    JSON.stringify(runtime.gateway.auditTrail()),
    JSON.stringify(runtime.memory.auditSnapshot()),
  ];
}

// ---------------------------------------------------------------------------
// 交付范围 4: the audited turn answers request id / versions / cost / errors
// ---------------------------------------------------------------------------

test("a completed turn is auditable end-to-end: ids, versions, token cost, no content", async () => {
  const runtime = createWebMvpRuntime();
  const requestId = "req_rollup0001";
  await runTurn(runtime, "[synthetic] 审计面测试：请帮我开始写作业", requestId);

  const events = runtime.trace.events();
  // request_id: the trace chain carries traceId/turnId/sessionId; the model
  // completion carries the CONTRACT request id.
  const modelCompleted = events.find((event) => event.type === "model.completed");
  assert.ok(modelCompleted !== undefined, "model.completed trace event missing");
  if (modelCompleted.type !== "model.completed") {
    throw new Error("unreachable");
  }
  assert.equal(modelCompleted.requestId, requestId);
  assert.match(modelCompleted.modelId, /lumithink-mock/);
  // Token cost as a first-class audit field.
  assert.equal(typeof modelCompleted.inputTokens, "number");
  assert.equal(typeof modelCompleted.outputTokens, "number");
  assert.equal(typeof modelCompleted.costMicroUsd, "number");
  // Versions: persona policy, skill, evidence refs.
  const persona = events.find((event) => event.type === "persona.resolved");
  assert.ok(persona !== undefined && persona.policyVersion.length > 0);
  const routed = events.find((event) => event.type === "skill.routed");
  assert.ok(routed !== undefined);
  assert.ok(routed.skillVersion !== null && routed.skillVersion.length > 0);
  assert.ok(Array.isArray(routed.evidenceRefs));
  // Error classification vocabulary exists on the turn terminal event.
  const completed = events.find((event) => event.type === "turn.completed");
  assert.ok(completed !== undefined && completed.resultCode.length > 0);
  // The gateway audit independently carries the same cost facts.
  const gatewayCompleted = runtime.gateway.auditTrail().find((event) => event.type === "turn.completed");
  assert.ok(gatewayCompleted !== undefined);
  if (gatewayCompleted.type !== "turn.completed") {
    throw new Error("unreachable");
  }
  assert.equal(gatewayCompleted.outputTokens, modelCompleted.outputTokens);
  assert.equal(gatewayCompleted.costMicroUsd, modelCompleted.costMicroUsd);
  // No audit surface carries the submitted content.
  for (const surface of allAuditSurfaces(runtime)) {
    assert.equal(surface.includes("请帮我开始写作业"), false);
  }
});

// ---------------------------------------------------------------------------
// AC 3: 日志脱敏负向测试 — dirty markers never reach the audit surfaces
// ---------------------------------------------------------------------------

const DIRTY_PSEUDO_KEY = "sk-dirty-pseudo-key-0a1b2c3d4e5f";
const DIRTY_NAME = "王小明";
const DIRTY_FAMILY = "家住幸福路12号，妈妈李女士的电话是13800001234";

test("AC 3: pseudo keys, names and family info injected into turns match 0 in every audit surface", async () => {
  const runtime = createWebMvpRuntime();
  const auth = runtime.guardian.sessionLogin({
    body: { protocolVersion: "1.0", accessCode: GUARDIAN_DEMO_ACCESS_CODE },
  });
  assert.equal(auth.kind, "ok");
  if (auth.kind !== "ok") {
    throw new Error("unreachable");
  }
  const bearer = `Bearer ${(auth.body as { sessionToken: string }).sessionToken}`;

  // Dirty content flows through a full turn (input-gate evaluation runs; the
  // mock provider replies regardless).
  await runTurn(
    runtime,
    `[synthetic-dirty] 我的名字叫${DIRTY_NAME}，${DIRTY_FAMILY}，我的 key 是 ${DIRTY_PSEUDO_KEY}`,
    "req_dirty000001",
  );
  // Dirty guardian-side failure: a wrong login attempt (structural facts only).
  runtime.guardian.sessionLogin({ body: { protocolVersion: "1.0", accessCode: DIRTY_PSEUDO_KEY } });
  // A guardian audit read (data_view entry) after the dirty turn.
  runtime.guardian.getAuthorizations({ authorization: bearer });

  for (const surface of allAuditSurfaces(runtime)) {
    assert.equal(surface.includes(DIRTY_PSEUDO_KEY), false, `pseudo key leaked: ${surface.slice(0, 200)}`);
    assert.equal(surface.includes(DIRTY_NAME), false);
    assert.equal(surface.includes(DIRTY_FAMILY), false);
    assert.equal(surface.includes("13800001234"), false);
    assert.equal(surface.includes("幸福路12号"), false);
  }
  // The error envelope of the rejected login carries no dirty value either.
  const failed = runtime.guardian.sessionLogin({ body: { protocolVersion: "1.0", accessCode: DIRTY_PSEUDO_KEY } });
  if (failed.kind === "error") {
    const envelope = JSON.stringify(failed.envelope);
    assert.equal(envelope.includes(DIRTY_PSEUDO_KEY), false);
  }
});

test("AC 3: a registered secret value is redacted from any audit detail by the wired hook", async () => {
  // The composition root registers real credential digests and wires
  // secrets.redact into the guardian audit path. The dirty-marker guarantee:
  // even a detail field that somehow carries the value cannot emit it.
  const runtime = createWebMvpRuntime();
  runtime.secrets.registerValue("guardian_access_code", DIRTY_PSEUDO_KEY);
  const redacted = runtime.secrets.redact(`detail=conv=1,hist=2,${DIRTY_PSEUDO_KEY}`);
  assert.equal(redacted.includes(DIRTY_PSEUDO_KEY), false);
  assert.match(redacted, /\[REDACTED:guardian_access_code\]/);
});
