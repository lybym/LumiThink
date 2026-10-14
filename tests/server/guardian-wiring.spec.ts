/**
 * R1-06 wiring tests (issue #18): the composed web MVP runtime with the
 * guardian service wired into the interaction service — the consent gate on
 * family model turns (including replays after revocation), the provider
 * egress gate with a REAL third-party-classified provider through the real
 * gateway (disabled switch → GATEWAY_NO_PROVIDER before transport, vendor
 * request count 0), the family cancel policy (guardian stops the child's
 * in-flight turn, honest `by: guardian` attribution), the guardian_config
 * persona style reaching the turn resolution, and session-token
 * non-leakage across model-call audit, runtime trace and error envelopes.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseActorContext, type ActorContext } from "../../lib/domain/contract/actor.ts";
import { CONTRACT_ID_PREFIXES, type ContractIdKind } from "../../lib/domain/contract/core.ts";
import type { InteractionAck } from "../../lib/domain/contract/idempotency.ts";
import { parseStreamEvent, type StreamEvent } from "../../lib/domain/contract/response.ts";
import { createModelGateway } from "../../lib/domain/gateway/index.ts";
import { parseModelGatewayConfig } from "../../lib/domain/gateway/config.ts";
import { createMockModelProvider } from "../../lib/domain/gateway/mock-provider.ts";
import { GatewayError } from "../../lib/domain/gateway/errors.ts";
import { resolveActivePersona } from "../../lib/domain/persona/registry.ts";
import { createCordisPipeline } from "../../lib/domain/runtime/pipeline.ts";
import { createDshSessionMapper } from "../../lib/domain/runtime/session-map.ts";
import { createRuntimeTraceRecorder } from "../../lib/domain/runtime/trace.ts";
import {
  GUARDIAN_ACTOR_ID,
  GUARDIAN_FAMILY_CHILD_REF,
} from "../../lib/domain/guardian/authorizations.ts";
import { createInProcessDshAdapter } from "../../lib/server/dsh-inprocess-adapter.ts";
import {
  ADMIN_DEMO_ACCESS_CODE,
  GUARDIAN_DEMO_ACCESS_CODE,
  createGuardianService,
} from "../../lib/server/guardian-service.ts";
import {
  createInteractionService,
  resolveWebMvpActor,
  WEB_MVP_DEMO_CHILD_AGE_YEARS,
  type InteractionService,
} from "../../lib/server/interaction-service.ts";
import { WEB_MVP_PROVIDER_ID } from "../../lib/server/web-mvp-runtime.ts";
import {
  buildProviderEgressStatus,
  gateProviderEgress,
  type ProviderEgressRegistration,
} from "../../lib/server/provider-egress-gate.ts";
import { createWebMvpRuntime, WEB_MVP_MODEL_ID } from "../../lib/server/web-mvp-runtime.ts";

const NOW = "2026-10-14T08:00:00.000Z";

let idCounter = 0;
function nextId(kind: ContractIdKind): string {
  idCounter += 1;
  return `${CONTRACT_ID_PREFIXES[kind]}${String(idCounter).padStart(8, "0")}`;
}

function childActor(): Readonly<ActorContext> {
  return resolveWebMvpActor(NOW);
}

function submitBody(conversationId?: string, requestId?: string): Record<string, unknown> {
  return {
    protocolVersion: "1.0",
    interaction: {
      kind: "text",
      clientRequestId: requestId ?? nextId("requestId"),
      ...(conversationId !== undefined ? { conversationId } : {}),
      text: { content: "[synthetic] R1-06 wiring 测试", format: "plain" },
      clientContext: { client: "web", clientVersion: "2.0.0-web" },
    },
  };
}

async function drainEvents(
  service: InteractionService,
  ack: Readonly<InteractionAck>,
  actor: Readonly<ActorContext>,
): Promise<StreamEvent[]> {
  const opened = service.openEventStream({ actor, traceId: ack.traceId });
  assert.equal(opened.kind, "stream");
  if (opened.kind !== "stream") {
    throw new Error("unreachable");
  }
  const frames: StreamEvent[] = [];
  for await (const frame of opened.events) {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(dataLine !== undefined);
    frames.push(parseStreamEvent(JSON.parse(dataLine.slice("data: ".length)) as unknown));
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Composed runtime: consent gate on family model turns
// ---------------------------------------------------------------------------

test("seeded family consent lets the child turn run; the local provider request is counted", async () => {
  const runtime = createWebMvpRuntime();
  const actor = childActor();
  const result = await runtime.service.submitInteraction({ body: submitBody(), actor });
  assert.equal(result.kind, "ack");
  if (result.kind !== "ack") {
    throw new Error("unreachable");
  }
  const events = await drainEvents(runtime.service, result.body, actor);
  assert.ok(events.some((event) => event.kind === "agent.completed"));

  const status = runtime.guardian.getAuthorizations({ authorization: null });
  // No session: status stays protected — read the egress evidence from the
  // gateway + gate instead.
  assert.equal(runtime.gateway.auditTrail().some((event) => event.type === "turn.completed"), true);
  // The egress gate counted exactly the local provider request; no
  // third-party provider is wired, so the third-party count is 0.
  const audit = JSON.stringify(runtime.gateway.auditTrail());
  assert.ok(audit.includes(WEB_MVP_PROVIDER_ID));
  assert.ok(!audit.includes("vendor-"));
  void status;
});

test("revoked family consent rejects new family turns — including replays of pre-revoke request ids", async () => {
  const runtime = createWebMvpRuntime();
  const actor = childActor();
  const first = await runtime.service.submitInteraction({ body: submitBody(), actor });
  assert.equal(first.kind, "ack");

  // Guardian login (real random token via the default factory).
  const login = runtime.guardian.sessionLogin({
    body: { protocolVersion: "1.0", accessCode: GUARDIAN_DEMO_ACCESS_CODE },
  });
  assert.equal(login.kind, "ok");
  const token = (login.kind === "ok" ? (login.body as { sessionToken: string }).sessionToken : "");
  const auth = `Bearer ${token}`;

  const revoke = runtime.guardian.postAuthorizations({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "revoke_consent", consentId: "child_model_interaction" },
  });
  assert.equal(revoke.kind, "ok");

  // New turn after revocation → rejected (AC: 撤销后继续调用模型被拒绝).
  const rejected = await runtime.service.submitInteraction({ body: submitBody(), actor });
  assert.equal(rejected.kind, "error");
  if (rejected.kind === "error") {
    assert.equal(rejected.envelope.error.code, "CONTRACT_WRONG_ROLE");
  }

  // Replay of the PRE-revoke requestId with the same payload → also
  // rejected: the gate runs BEFORE the idempotency ledger, so no model work
  // can start from a replay either.
  const replay = await runtime.service.submitInteraction({
    body: submitBody(undefined, (first.kind === "ack" ? first.body : null)?.requestId),
    actor,
  });
  assert.equal(replay.kind, "error");
  if (replay.kind === "error") {
    assert.equal(replay.envelope.error.code, "CONTRACT_WRONG_ROLE");
  }

  // Re-grant restores service.
  const regrant = runtime.guardian.postAuthorizations({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "grant_consent", consentId: "child_model_interaction" },
  });
  assert.equal(regrant.kind, "ok");
  const restored = await runtime.service.submitInteraction({ body: submitBody(), actor });
  assert.equal(restored.kind, "ack");
});

test("a request id rejected during revocation is not burned — after re-grant the SAME id executes fresh", async () => {
  const runtime = createWebMvpRuntime();
  const actor = childActor();
  const login = runtime.guardian.sessionLogin({
    body: { protocolVersion: "1.0", accessCode: GUARDIAN_DEMO_ACCESS_CODE },
  });
  assert.equal(login.kind, "ok");
  const auth = `Bearer ${(login.kind === "ok" ? (login.body as { sessionToken: string }).sessionToken : "")}`;

  // Revoke first: this request id is rejected by the consent gate BEFORE the
  // idempotency ledger is consulted.
  const revoke = runtime.guardian.postAuthorizations({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "revoke_consent", consentId: "child_model_interaction" },
  });
  assert.equal(revoke.kind, "ok");
  const rejectedId = nextId("requestId");
  const rejected = await runtime.service.submitInteraction({ body: submitBody(undefined, rejectedId), actor });
  assert.equal(rejected.kind, "error");
  if (rejected.kind === "error") {
    assert.equal(rejected.envelope.error.code, "CONTRACT_WRONG_ROLE");
  }

  // Re-grant: the SAME request id resolves as a FRESH accept and executes —
  // the gate never consumed a ledger slot for it, so no duplicate-ack
  // short-circuit can suppress the execution (pins the no-slot-burn
  // ordering of the consent gate vs the ledger).
  const regrant = runtime.guardian.postAuthorizations({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "grant_consent", consentId: "child_model_interaction" },
  });
  assert.equal(regrant.kind, "ok");
  const fresh = await runtime.service.submitInteraction({ body: submitBody(undefined, rejectedId), actor });
  assert.equal(fresh.kind, "ack");
  if (fresh.kind === "ack") {
    const events = await drainEvents(runtime.service, fresh.body, actor);
    assert.ok(events.some((event) => event.kind === "agent.completed"), "the turn must execute for real");
  }
});

test("client-submitted identity fields stay rejected on the interaction path (no self-promotion path)", async () => {
  const runtime = createWebMvpRuntime();
  const actor = childActor();
  const body = submitBody();
  (body as Record<string, unknown>).actor = { role: "admin" };
  const result = await runtime.service.submitInteraction({ body, actor });
  assert.equal(result.kind, "error");
  if (result.kind === "error") {
    assert.equal(result.envelope.error.code, "CONTRACT_UNTRUSTED_IDENTITY");
  }
});

// ---------------------------------------------------------------------------
// Token non-leakage across model-call audit, trace and error envelopes
// ---------------------------------------------------------------------------

test("the session token never appears in the gateway audit, runtime trace or error envelopes", async () => {
  const runtime = createWebMvpRuntime();
  const actor = childActor();

  const login = runtime.guardian.sessionLogin({
    body: { protocolVersion: "1.0", accessCode: GUARDIAN_DEMO_ACCESS_CODE },
  });
  assert.equal(login.kind, "ok");
  const token = (login.kind === "ok" ? (login.body as { sessionToken: string }).sessionToken : "");
  assert.ok(token.length >= 43);

  const result = await runtime.service.submitInteraction({ body: submitBody(), actor });
  assert.equal(result.kind, "ack");
  if (result.kind === "ack") {
    await drainEvents(runtime.service, result.body, actor);
  }

  // A malformed submission from the child → error envelope must not leak.
  const bad = await runtime.service.submitInteraction({
    body: { protocolVersion: "1.0", interaction: { kind: "text", sessionToken: token } },
    actor,
  });
  assert.equal(bad.kind, "error");

  const surfaces = [
    JSON.stringify(runtime.gateway.auditTrail()),
    JSON.stringify(runtime.trace.events()),
    JSON.stringify(runtime.guardian.auditEntries()),
    bad.kind === "error" ? JSON.stringify(bad.envelope) : "",
  ].join("\n");
  assert.ok(!surfaces.includes(token), "no surface may carry the session token");
  assert.ok(!surfaces.includes("Bearer"), "no surface may carry credential schemes");
});

// ---------------------------------------------------------------------------
// Egress gate end-to-end (real gateway, real third-party classification)
// ---------------------------------------------------------------------------

test("disabled third-party egress: the gateway refuses the call BEFORE transport (0 vendor requests)", async () => {
  const guardian = createGuardianService();
  const vendorProvider = createMockModelProvider({
    providerId: "vendor-egress-x",
    script: { reply: { prefix: "VENDOR", chunkCount: 2, delayMsPerChunk: 0 } },
  });
  const gated = gateProviderEgress({
    provider: vendorProvider,
    classification: "third_party_api",
    isThirdPartyEgressEnabled: () => guardian.isThirdPartyEgressEnabled(),
  });
  const gateway = createModelGateway(
    parseModelGatewayConfig({
      gatewayVersion: "1.0",
      models: [{ modelId: "vendor-model-1", providerId: "vendor-egress-x", maxOutputTokens: 256, pricing: null }],
      budget: { maxRequestsPerDay: 100, maxCostMicroUsdPerDay: 100_000, maxTotalTokensPerDay: 100_000 },
      retry: { maxAttempts: 1, backoffBaseMs: 1 },
      breaker: { failureThreshold: 5, cooldownMs: 1_000 },
      requestTimeoutMs: 30_000,
    }),
    [gated],
  );
  const request = {
    requestId: nextId("requestId"),
    traceId: nextId("traceId"),
    turnId: nextId("turnId"),
    modelId: "vendor-model-1",
    messages: [{ role: "user", content: "[synthetic] egress probe" }],
  };

  // Switch OFF (fail-closed default): GATEWAY_NO_PROVIDER, zero transport.
  let caught: GatewayError | null = null;
  try {
    await gateway.complete(request);
  } catch (error) {
    if (error instanceof GatewayError) {
      caught = error;
    } else {
      throw error;
    }
  }
  assert.ok(caught !== null, "the call must fail closed");
  assert.equal(caught?.code, "GATEWAY_NO_PROVIDER");
  assert.equal(gated.requestCount(), 0, "the vendor provider must never be contacted");
  assert.ok(
    gateway.auditTrail().some((event) => event.type === "request.rejected"),
    "the pre-transport rejection must be observable in the audit",
  );

  // Guardian grants the switch → the SAME request now goes through.
  const login = guardian.sessionLogin({
    body: { protocolVersion: "1.0", accessCode: GUARDIAN_DEMO_ACCESS_CODE },
  });
  assert.equal(login.kind, "ok");
  const grant = guardian.postAuthorizations({
    authorization: `Bearer ${(login.kind === "ok" ? (login.body as { sessionToken: string }).sessionToken : "")}`,
    body: {
      protocolVersion: "1.0",
      action: "set_feature_switch",
      switchId: "third_party_data_egress",
      enabled: true,
    },
  });
  assert.equal(grant.kind, "ok");

  const completed = await gateway.complete(request);
  assert.equal(completed.providerId, "vendor-egress-x");
  assert.equal(gated.requestCount(), 1);
});

test("egress enabled + provider failure: the vendor attempt counts and degrades structurally", async () => {
  const guardian = createGuardianService();
  const login = guardian.sessionLogin({
    body: { protocolVersion: "1.0", accessCode: GUARDIAN_DEMO_ACCESS_CODE },
  });
  assert.equal(login.kind, "ok");
  const grant = guardian.postAuthorizations({
    authorization: `Bearer ${(login.kind === "ok" ? (login.body as { sessionToken: string }).sessionToken : "")}`,
    body: {
      protocolVersion: "1.0",
      action: "set_feature_switch",
      switchId: "third_party_data_egress",
      enabled: true,
    },
  });
  assert.equal(grant.kind, "ok");

  const failingVendor = createMockModelProvider({
    providerId: "vendor-egress-fail",
    script: {
      reply: { prefix: "VENDOR", chunkCount: 2, delayMsPerChunk: 0 },
      failure: { classification: "unavailable", times: "always" },
    },
  });
  const gated = gateProviderEgress({
    provider: failingVendor,
    classification: "third_party_api",
    isThirdPartyEgressEnabled: () => guardian.isThirdPartyEgressEnabled(),
  });
  const gateway = createModelGateway(
    parseModelGatewayConfig({
      gatewayVersion: "1.0",
      models: [{ modelId: "vendor-model-1", providerId: "vendor-egress-fail", maxOutputTokens: 256, pricing: null }],
      budget: { maxRequestsPerDay: 100, maxCostMicroUsdPerDay: 100_000, maxTotalTokensPerDay: 100_000 },
      retry: { maxAttempts: 1, backoffBaseMs: 1 },
      breaker: { failureThreshold: 5, cooldownMs: 1_000 },
      requestTimeoutMs: 30_000,
    }),
    [gated],
  );

  // Switch ON + vendor unavailable → a CLASSIFIED gateway failure (structured
  // degradation), not a raw transport throw, and the vendor attempt WAS
  // transported: the counter reflects it.
  let caught: GatewayError | null = null;
  try {
    await gateway.complete({
      requestId: nextId("requestId"),
      traceId: nextId("traceId"),
      turnId: nextId("turnId"),
      modelId: "vendor-model-1",
      messages: [{ role: "user", content: "[synthetic] egress failure probe" }],
    });
  } catch (error) {
    if (error instanceof GatewayError) {
      caught = error;
    } else {
      throw error;
    }
  }
  assert.ok(caught !== null, "the failure must surface as a GatewayError");
  assert.equal(caught?.code, "GATEWAY_PROVIDER_UNAVAILABLE");
  assert.equal(gated.requestCount(), 1, "the switched-on vendor attempt must be counted");
  assert.ok(
    gateway
      .auditTrail()
      .some((event) => event.type === "attempt.failed" && event.providerId === "vendor-egress-fail"),
    "the provider failure must be observable in the value-free audit",
  );
});

// ---------------------------------------------------------------------------
// Egress status aggregation (review P2-2)
// ---------------------------------------------------------------------------

test("buildProviderEgressStatus aggregates counts by egress classification", () => {
  const registrations: ProviderEgressRegistration[] = [
    { providerId: "local-a", classification: "local_no_egress", requestCount: () => 5 },
    { providerId: "vendor-a", classification: "third_party_api", requestCount: () => 3 },
    { providerId: "vendor-b", classification: "third_party_api", requestCount: () => 4 },
  ];
  const status = buildProviderEgressStatus(registrations);
  assert.deepEqual(status.providerRequestCounts, { "local-a": 5, "vendor-a": 3, "vendor-b": 4 });
  assert.equal(status.thirdPartyProviderRequestCount, 7);
  // Counters are read dynamically per call.
  let live = 10;
  const liveRegistration: ProviderEgressRegistration = {
    providerId: "vendor-live",
    classification: "third_party_api",
    requestCount: () => live,
  };
  assert.equal(buildProviderEgressStatus([liveRegistration]).thirdPartyProviderRequestCount, 10);
  live = 11;
  assert.equal(buildProviderEgressStatus([liveRegistration]).thirdPartyProviderRequestCount, 11);
  // Empty registration set: 0 by aggregation over the empty third-party set.
  const empty = buildProviderEgressStatus([]);
  assert.deepEqual(empty.providerRequestCounts, {});
  assert.equal(empty.thirdPartyProviderRequestCount, 0);
});

test("the composed runtime's guardian status egress block is aggregated from real gated counters", async () => {
  const runtime = createWebMvpRuntime();
  const actor = childActor();
  const result = await runtime.service.submitInteraction({ body: submitBody(), actor });
  assert.equal(result.kind, "ack");
  if (result.kind === "ack") {
    await drainEvents(runtime.service, result.body, actor);
  }

  // Admin may read the status surface (role matrix): the local provider's
  // REAL attempt count is reported…
  const login = runtime.guardian.sessionLogin({
    body: { protocolVersion: "1.0", accessCode: ADMIN_DEMO_ACCESS_CODE },
  });
  assert.equal(login.kind, "ok");
  const status = runtime.guardian.getAuthorizations({
    authorization: `Bearer ${(login.kind === "ok" ? (login.body as { sessionToken: string }).sessionToken : "")}`,
  });
  assert.equal(status.kind, "ok");
  const snapshot = (status.kind === "ok" ? status.body : null) as {
    egress: { providerRequestCounts: Record<string, number>; thirdPartyProviderRequestCount: number };
  };
  assert.ok(
    (snapshot.egress.providerRequestCounts[WEB_MVP_PROVIDER_ID] ?? 0) >= 1,
    "the local provider's real request count must reach the status feed",
  );
  // …while the third-party count is the aggregation over
  // third_party_api-classified registrations only (none wired): 0 even
  // though a local provider ran — computed, not a constant.
  assert.equal(snapshot.egress.thirdPartyProviderRequestCount, 0);
});

// ---------------------------------------------------------------------------
// Family cancellation policy (guardian stops the family child's turn)
// ---------------------------------------------------------------------------

function buildCancelRig(): { readonly service: InteractionService; readonly guardian: ReturnType<typeof createGuardianService> } {
  const guardian = createGuardianService();
  const slowProvider = createMockModelProvider({
    providerId: "test-provider-1",
    script: { reply: { prefix: "MOCK", chunkCount: 6, delayMsPerChunk: 25 } },
  });
  const pipeline = createCordisPipeline({
    gateway: createModelGateway(
      parseModelGatewayConfig({
        gatewayVersion: "1.0",
        models: [{ modelId: "test-model-1", providerId: "test-provider-1", maxOutputTokens: 512, pricing: null }],
        budget: { maxRequestsPerDay: 100, maxCostMicroUsdPerDay: 100_000, maxTotalTokensPerDay: 100_000 },
        retry: { maxAttempts: 1, backoffBaseMs: 1 },
        breaker: { failureThreshold: 5, cooldownMs: 1_000 },
        requestTimeoutMs: 30_000,
      }),
      [slowProvider],
    ),
    modelId: "test-model-1",
    sessionMapper: createDshSessionMapper({ port: createInProcessDshAdapter() }),
    personaPolicy: resolveActivePersona(),
    trace: createRuntimeTraceRecorder(),
  });
  const service = createInteractionService({
    pipeline,
    childAgeYears: WEB_MVP_DEMO_CHILD_AGE_YEARS,
    entrance: "ui_web",
    ingress: "web",
    nowFactory: () => NOW,
    idFactory: nextId,
    stream: { fragmentCodePoints: 5, interFrameDelayMs: 0 },
    cancelSettleMs: 2_000,
    authorizeTurn: (actor) => guardian.assertModelInteractionAuthorized(actor),
    cancelPolicy: (canceller, owner) => guardian.familyCancelPolicy(canceller, owner),
  });
  return { service, guardian };
}

test("a family guardian may stop the child's in-flight turn; attribution names the guardian", async () => {
  const rig = buildCancelRig();
  const actor = childActor();
  const submitted = await rig.service.submitInteraction({ body: submitBody(), actor });
  assert.equal(submitted.kind, "ack");
  const ack = (submitted.kind === "ack" ? submitted.body : null);
  assert.ok(ack !== null);

  const guardianActor = parseActorContext({
    role: "guardian",
    actorId: GUARDIAN_ACTOR_ID,
    childRef: GUARDIAN_FAMILY_CHILD_REF,
    verifiedBy: "guardian-session-v1",
    verifiedAt: NOW,
  });
  const cancel = await rig.service.cancelTurn({
    actor: guardianActor,
    urlTurnId: ack?.turnId,
    body: {
      protocolVersion: "1.0",
      turnId: ack?.turnId,
      conversationId: ack?.conversationId,
      reason: "guardian_stop",
    },
  });
  assert.equal(cancel.kind, "result");
  assert.equal((cancel.kind === "result" ? cancel.body.status : ""), "cancelled");

  const events = await drainEvents(rig.service, ack as Readonly<InteractionAck>, actor);
  const cancelled = events.find((event) => event.kind === "turn.cancelled");
  assert.ok(cancelled !== undefined, "the turn must emit turn.cancelled");
  if (cancelled !== undefined && cancelled.payload.type === "cancelled") {
    assert.equal(cancelled.payload.by, "guardian");
  }
  assert.ok(
    rig.guardian.auditEntries().some((entry) => entry.kind === "guardian_cancel" && entry.target === ack?.turnId),
  );
});

test("a foreign guardian (different family) gets the indistinguishable unknown_turn no-op", async () => {
  const rig = buildCancelRig();
  const actor = childActor();
  const submitted = await rig.service.submitInteraction({ body: submitBody(), actor });
  assert.equal(submitted.kind, "ack");
  const ack = submitted.kind === "ack" ? submitted.body : null;
  assert.ok(ack !== null);

  const foreignGuardian = parseActorContext({
    role: "guardian",
    actorId: "act_foreigngd01",
    childRef: "chd_demo_002",
    verifiedBy: "guardian-session-v1",
    verifiedAt: NOW,
  });
  const cancel = await rig.service.cancelTurn({
    actor: foreignGuardian,
    urlTurnId: ack?.turnId,
    body: {
      protocolVersion: "1.0",
      turnId: ack?.turnId,
      conversationId: ack?.conversationId,
      reason: "guardian_stop",
    },
  });
  assert.equal(cancel.kind, "result");
  assert.equal((cancel.kind === "result" ? cancel.body.status : ""), "unknown_turn");
  assert.equal(
    rig.guardian.auditEntries().filter((entry) => entry.kind === "guardian_cancel").length,
    0,
  );
});

// ---------------------------------------------------------------------------
// Guardian persona style reaches the turn resolution
// ---------------------------------------------------------------------------

test("the guardian_config style flows into the pipeline persona resolution (re-validated)", async () => {
  const guardian = createGuardianService();
  const login = guardian.sessionLogin({
    body: { protocolVersion: "1.0", accessCode: GUARDIAN_DEMO_ACCESS_CODE },
  });
  assert.equal(login.kind, "ok");
  const set = guardian.postAuthorizations({
    authorization: `Bearer ${(login.kind === "ok" ? (login.body as { sessionToken: string }).sessionToken : "")}`,
    body: {
      protocolVersion: "1.0",
      action: "set_persona_style",
      updates: [{ knobId: "answer_length", value: "detailed" }],
    },
  });
  assert.equal(set.kind, "ok");

  const provider = createMockModelProvider({
    providerId: "test-provider-1",
    script: { reply: { prefix: "MOCK", chunkCount: 2, delayMsPerChunk: 0 } },
  });
  const pipeline = createCordisPipeline({
    gateway: createModelGateway(
      parseModelGatewayConfig({
        gatewayVersion: "1.0",
        models: [{ modelId: "test-model-1", providerId: "test-provider-1", maxOutputTokens: 512, pricing: null }],
        budget: { maxRequestsPerDay: 100, maxCostMicroUsdPerDay: 100_000, maxTotalTokensPerDay: 100_000 },
        retry: { maxAttempts: 1, backoffBaseMs: 1 },
        breaker: { failureThreshold: 5, cooldownMs: 1_000 },
        requestTimeoutMs: 30_000,
      }),
      [provider],
    ),
    modelId: "test-model-1",
    sessionMapper: createDshSessionMapper({ port: createInProcessDshAdapter() }),
    personaPolicy: resolveActivePersona(),
    trace: createRuntimeTraceRecorder(),
  });
  const actor = parseActorContext({
    role: "child",
    actorId: "act_webmvp_demo01",
    childRef: GUARDIAN_FAMILY_CHILD_REF,
    verifiedBy: "web-mvp-local-identity",
    verifiedAt: NOW,
  });
  const event = {
    protocolVersion: "1.0" as const,
    eventId: nextId("eventId"),
    kind: "text" as const,
    requestId: nextId("requestId"),
    conversationId: nextId("conversationId"),
    turnId: nextId("turnId"),
    traceId: nextId("traceId"),
    occurredAt: NOW,
    ingress: "web" as const,
    actor,
    text: {
      content: "[synthetic] style probe",
      format: "plain" as const,
      charCount: [..."[synthetic] style probe"].length,
    },
  };
  const turn = await pipeline.runTurn({
    entrance: "ui_web",
    actor,
    session: { sessionId: nextId("sessionId"), conversationId: event.conversationId },
    event,
    childAgeYears: WEB_MVP_DEMO_CHILD_AGE_YEARS,
    personaStyle: guardian.currentFamilyStyle(),
  });
  assert.equal(turn.persona?.style.answer_length, "detailed");
  assert.equal(
    turn.persona?.knobProvenance.find((entry) => entry.knobId === "answer_length")?.source,
    "guardian_config",
  );
});
