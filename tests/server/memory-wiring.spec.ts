import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRACT_ID_PREFIXES,
  type ContractIdKind,
} from "../../lib/domain/contract/core.ts";
import type { ActorContext } from "../../lib/domain/contract/actor.ts";
import { parseStreamEvent, type StreamEvent } from "../../lib/domain/contract/response.ts";
import type { InteractionAck } from "../../lib/domain/contract/idempotency.ts";
import {
  resolveWebMvpActor,
  WEB_MVP_CHILD_REF,
  type InteractionService,
} from "../../lib/server/interaction-service.ts";
import { createWebMvpRuntime } from "../../lib/server/web-mvp-runtime.ts";

/**
 * R1-14 server wiring tests (issue #26): the web MVP runtime binds the real
 * candidate-only memory service to the whitelisted memory tools and the
 * pipeline context hook. All data synthetic.
 */

const NOW = "2026-10-14T08:00:00.000Z";

let idCounter = 0;
function nextId(kind: ContractIdKind): string {
  idCounter += 1;
  return `${CONTRACT_ID_PREFIXES[kind]}${String(idCounter).padStart(8, "0")}`;
}

function childActor(): Readonly<ActorContext> {
  return resolveWebMvpActor(NOW);
}

function guardianActor(): Readonly<ActorContext> {
  return {
    role: "guardian",
    actorId: "act_guardiandemo1",
    childRef: WEB_MVP_CHILD_REF,
    verifiedBy: "memory-wiring-test",
    verifiedAt: NOW,
  };
}

function submitBody(conversationId?: string): Record<string, unknown> {
  return {
    protocolVersion: "1.0",
    interaction: {
      kind: "text",
      clientRequestId: nextId("requestId"),
      ...(conversationId !== undefined ? { conversationId } : {}),
      text: { content: "[synthetic] R1-14 memory wiring 测试", format: "plain" },
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

async function runServingTurn(runtime: ReturnType<typeof createWebMvpRuntime>): Promise<string> {
  const result = await runtime.service.submitInteraction({ body: submitBody(), actor: childActor() });
  assert.equal(result.kind, "ack");
  if (result.kind !== "ack") {
    throw new Error("unreachable");
  }
  const events = await drainEvents(runtime.service, result.body, childActor());
  assert.ok(events.some((event) => event.kind === "agent.completed"));
  return result.body.traceId;
}

/** Activate a known mapped session for direct tool-path calls. */
async function ensureWiredSession(
  runtime: ReturnType<typeof createWebMvpRuntime>,
  sessionId: string,
): Promise<void> {
  const ensured = await runtime.pipeline.sessionMapper.ensureSession({
    lumiSessionId: sessionId,
    conversationId: `conv_wiring${sessionId.slice(-6)}`,
    actorId: childActor().actorId,
    traceId: `trc_w${sessionId.slice(-8)}`,
    turnId: `trn_w${sessionId.slice(-8)}`,
  });
  assert.ok(ensured.ok);
}

test("the composed runtime exposes the memory service with its OWN audit ring", () => {
  const runtime = createWebMvpRuntime();
  assert.equal(typeof runtime.memory.proposeCandidate, "function");
  assert.equal(typeof runtime.memory.auditSnapshot, "function");
  assert.equal(typeof runtime.memory.purgeAudit, "function");
  // Separate structures: memory audit and the runtime trace never mix.
  assert.notEqual(runtime.memory.auditSnapshot, runtime.trace.events);
  assert.equal(runtime.memory.auditSnapshot().length, 0);
});

test("memory.propose through the serving pipeline creates a CANDIDATE (subject pinned server-side)", async () => {
  const runtime = createWebMvpRuntime();
  await ensureWiredSession(runtime, "ses_wiringtool1"); // active mapped session

  const execution = await runtime.pipeline.executeServiceCall(
    {
      callId: nextId("eventId").replace("evt_", "call"),
      toolId: "memory.propose",
      declaredCategory: "memory_propose",
      declaredVersion: "1.0",
      requestedPermissions: ["memory.propose"],
      input: {
        schemaVersion: "1.0",
        type: "confirmed_preference",
        claim: "喜欢太空主题的故事",
        source: "agent_proposal",
        observedAt: NOW,
        expiresAt: null,
        reviewAt: null,
        sensitivity: "normal",
      },
    },
    {
      actorRole: "system",
      traceId: "trc_wiringtool01",
      turnId: "trn_wiringtool1",
      sessionId: "ses_wiringtool1",
    },
  );
  assert.equal(execution.status, "executed");
  if (execution.status !== "executed") {
    throw new Error("unreachable");
  }
  assert.equal(execution.candidateOnly, true);
  const entries = runtime.memory.listEntries(WEB_MVP_CHILD_REF, guardianActor());
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.status, "candidate");
  assert.equal(entries[0]?.source, "agent_proposal");

  // A submitted subjectRef can never redirect the proposal: the handler
  // pins the demo child server-side, so a different subjectRef is replaced.
  const redirect = await runtime.pipeline.executeServiceCall(
    {
      callId: nextId("eventId").replace("evt_", "call"),
      toolId: "memory.propose",
      declaredCategory: "memory_propose",
      declaredVersion: "1.0",
      requestedPermissions: ["memory.propose"],
      input: {
        schemaVersion: "1.0",
        subjectRef: "chd_attacker01",
        type: "confirmed_preference",
        claim: "喜欢恐龙主题的故事",
        source: "agent_proposal",
        observedAt: NOW,
        expiresAt: null,
        reviewAt: null,
        sensitivity: "normal",
      },
    },
    { actorRole: "system", traceId: "trc_wiringtool01", turnId: "trn_wiringtool1", sessionId: "ses_wiringtool1" },
  );
  assert.equal(redirect.status, "executed");
  const after = runtime.memory.listEntries(WEB_MVP_CHILD_REF, guardianActor());
  assert.equal(after.length, 2);
  assert.ok(after.every((entry) => entry.subjectRef === WEB_MVP_CHILD_REF));

  // Audit evidence exists in the MEMORY audit ring, separate from the trace.
  assert.ok(runtime.memory.auditSnapshot().some((entry) => entry.action === "memory.propose"));
  assert.ok(
    runtime.trace
      .events()
      .some((event) => event.type === "tool.executed" && event.toolId === "memory.propose"),
  );
});

test("child confirmation → a NEW serving session references the memory (跨会话)", async () => {
  const runtime = createWebMvpRuntime();
  await runServingTurn(runtime); // session 1

  // Intake + explicit child confirmation.
  const proposed = runtime.memory.proposeCandidate(
    {
      schemaVersion: "1.0",
      subjectRef: WEB_MVP_CHILD_REF,
      type: "confirmed_preference",
      claim: "喜欢太空主题的故事",
      source: "child_statement",
      observedAt: NOW,
      expiresAt: null,
      reviewAt: null,
      sensitivity: "normal",
    },
    childActor(),
  );
  assert.ok(proposed.ok);
  if (!proposed.ok) return;
  assert.ok(runtime.memory.confirmCandidate({ memoryId: proposed.entry.memoryId }, childActor()).ok);

  // A NEW turn (new conversation → new session) references the memory.
  const traceId = await runServingTurn(runtime);
  const memoryEvents = runtime.trace
    .events()
    .filter((event) => event.type === "memory.context" && event.traceId === traceId);
  assert.equal(memoryEvents.length, 1);
  if (memoryEvents[0]?.type === "memory.context") {
    assert.equal(memoryEvents[0].resultCode, "ok");
    assert.equal(memoryEvents[0].memoryRefCount, 1);
  }

  // The lookup tool now returns the confirmed ref (own mapped session).
  await ensureWiredSession(runtime, "ses_wiringlookup1");
  const lookup = await runtime.pipeline.executeServiceCall(
    {
      callId: nextId("eventId").replace("evt_", "call"),
      toolId: "memory.lookup",
      declaredCategory: "memory_read",
      declaredVersion: "1.0",
      requestedPermissions: ["memory.read"],
    },
    { actorRole: "child", traceId: "trc_wiringlook01", turnId: "trn_wiringlook1", sessionId: "ses_wiringlookup1" },
  );
  assert.equal(lookup.status, "executed");
  if (lookup.status === "executed") {
    assert.equal(lookup.refs.length, 1);
    assert.equal(lookup.refs[0]?.refId, proposed.entry.memoryId);
  }
});

test("correction stops the old preference in new sessions; delete empties retrieval", async () => {
  const runtime = createWebMvpRuntime();
  await runServingTurn(runtime);
  const proposed = runtime.memory.proposeCandidate(
    {
      schemaVersion: "1.0",
      subjectRef: WEB_MVP_CHILD_REF,
      type: "confirmed_preference",
      claim: "喜欢太空主题的故事",
      source: "child_statement",
      observedAt: NOW,
      expiresAt: null,
      reviewAt: null,
      sensitivity: "normal",
    },
    childActor(),
  );
  assert.ok(proposed.ok);
  if (!proposed.ok) return;
  const memoryId = proposed.entry.memoryId;
  assert.ok(runtime.memory.confirmCandidate({ memoryId }, childActor()).ok);

  // Correction (儿童否认 → 更正).
  const corrected = runtime.memory.correctMemory(
    { memoryId, claim: "我现在不喜欢太空主题的故事了" },
    childActor(),
  );
  assert.ok(corrected.ok);

  // New session: only the corrected fact is referenced.
  const traceId = await runServingTurn(runtime);
  const memoryEvents = runtime.trace
    .events()
    .filter((event) => event.type === "memory.context" && event.traceId === traceId);
  if (memoryEvents[0]?.type === "memory.context") {
    assert.equal(memoryEvents[0].memoryRefCount, 1);
  }

  // Deletion (guardian may act for the family): retrieval empties.
  const correctedId = corrected.ok ? corrected.entry.memoryId : "";
  assert.ok(runtime.memory.deleteMemory({ memoryId: correctedId }, guardianActor()).ok);
  await runServingTurn(runtime);
  const afterDelete = runtime.memory.retrieveForContext(
    { subjectRef: WEB_MVP_CHILD_REF },
    childActor(),
  );
  assert.ok(afterDelete.ok && afterDelete.refs.length === 0);
});

test("purging the memory audit does not touch the runtime trace (分开审计、清理)", async () => {
  const runtime = createWebMvpRuntime();
  await ensureWiredSession(runtime, "ses_wiringtool3");
  await runtime.pipeline.executeServiceCall(
    {
      callId: nextId("eventId").replace("evt_", "call"),
      toolId: "memory.propose",
      declaredCategory: "memory_propose",
      declaredVersion: "1.0",
      requestedPermissions: ["memory.propose"],
      input: {
        schemaVersion: "1.0",
        type: "confirmed_preference",
        claim: "喜欢太空主题的故事",
        source: "agent_proposal",
        observedAt: NOW,
        expiresAt: null,
        reviewAt: null,
        sensitivity: "normal",
      },
    },
    { actorRole: "system", traceId: "trc_wiringtool03", turnId: "trn_wiringtool3", sessionId: "ses_wiringtool3" },
  );
  assert.ok(runtime.memory.auditSnapshot().length > 0);
  assert.ok(runtime.trace.events().length > 0);

  runtime.memory.purgeAudit();
  assert.equal(runtime.memory.auditSnapshot().length, 0);
  assert.ok(runtime.trace.events().length > 0, "the runtime trace is a separate lifecycle");
});
