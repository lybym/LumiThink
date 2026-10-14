import assert from "node:assert/strict";
import test from "node:test";

import { resolveActivePersona } from "../../../lib/domain/persona/registry.ts";
import { createMemoryService } from "../../../lib/domain/memory/service.ts";
import {
  createCordisPipeline,
  type CordisPipeline,
  type CordisTurnResult,
  type MemoryContextProvider,
} from "../../../lib/domain/runtime/pipeline.ts";
import type { CordisServiceHandler } from "../../../lib/domain/runtime/cordis.ts";
import { createDshSessionMapper, type DshRuntimePort } from "../../../lib/domain/runtime/session-map.ts";
import { createRuntimeTraceRecorder } from "../../../lib/domain/runtime/trace.ts";
import {
  createTestGateway,
  mockProvider,
  syntheticActor,
  syntheticEvent,
  SYNTHETIC_CHILD_REF,
  SYNTHETIC_CONVERSATION_A,
  SYNTHETIC_CONVERSATION_B,
  SYNTHETIC_SESSION_A,
  SYNTHETIC_SESSION_B,
  turnId,
} from "./helpers.ts";

/**
 * R1-14 pipeline wiring tests (issue #26): the memory-context hook and the
 * candidate-only propose tool path, end to end through the REAL pipeline.
 * All data synthetic.
 */

function fakePort(): DshRuntimePort {
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
  };
}

interface Fixture {
  readonly pipeline: CordisPipeline;
  readonly memory: ReturnType<typeof createMemoryService>;
  readonly trace: ReturnType<typeof createRuntimeTraceRecorder>;
}

function makeFixture(
  memoryOptions: {
    /** Override the memoryContext provider (defaults to the real service). */
    readonly memoryContext?: (childRef: string) => readonly unknown[];
  } = {},
): Fixture {
  const memory = createMemoryService({
    nowFactory: () => "2026-06-01T08:00:00Z",
    idFactory: (() => {
      let counter = 0;
      return () => {
        counter += 1;
        return `mem_rtfixture${String(counter).padStart(5, "0")}`;
      };
    })(),
  });
  const trace = createRuntimeTraceRecorder();
  const runtimeActor = {
    role: "system",
    actorId: "act_rtruntime1",
    childRef: null,
    verifiedBy: "rt-fixture-verifier",
    verifiedAt: "2026-06-01T08:00:00Z",
  };
  // Handlers mirror the web-runtime wiring: propose → candidate-only
  // intake with the subject pinned server-side; lookup → read-only refs.
  const memoryProposeHandler: CordisServiceHandler = async ({ call }) => {
    const input =
      call.input !== null && typeof call.input === "object" && !Array.isArray(call.input)
        ? (call.input as Record<string, unknown>)
        : {};
    const result = memory.proposeCandidate({ ...input, subjectRef: SYNTHETIC_CHILD_REF }, runtimeActor);
    if (!result.ok) {
      throw new Error("memory_proposal_rejected");
    }
    return {
      ok: true as const,
      refs: [{ kind: "memory" as const, refId: result.entry.memoryId, version: String(result.entry.revision) }],
      candidateOnly: true,
    };
  };
  const memoryLookupHandler: CordisServiceHandler = async () => {
    const result = memory.retrieveForContext({ subjectRef: SYNTHETIC_CHILD_REF }, runtimeActor);
    if (!result.ok) {
      throw new Error("memory_lookup_unavailable");
    }
    return {
      ok: true as const,
      refs: result.refs.map((ref) => ({ kind: "memory" as const, refId: ref.refId, version: ref.version })),
      candidateOnly: false,
    };
  };
  const memoryContextProvider: MemoryContextProvider = ({ childRef }) => {
    const result = memory.retrieveForContext({ subjectRef: childRef }, runtimeActor);
    if (!result.ok) {
      throw new Error("memory_context_unavailable");
    }
    return result.refs;
  };
  const pipeline = createCordisPipeline({
    gateway: createTestGateway({ provider: mockProvider() }),
    modelId: "mock-model",
    sessionMapper: createDshSessionMapper({ port: fakePort(), clock: () => 1000 }),
    trace,
    personaPolicy: resolveActivePersona(),
    handlers: {
      "memory.propose": memoryProposeHandler,
      "memory.lookup": memoryLookupHandler,
    },
    // R1-14: minimal-by-need memory context retrieval (ids + versions only).
    // A service failure throws → the pipeline degrades observably to zero
    // memory refs (memory.context trace, memory_context_failed).
    memoryContext: memoryOptions.memoryContext
      ? (request) => memoryOptions.memoryContext!(request.childRef)
      : memoryContextProvider,
  });
  return { pipeline, memory, trace };
}

async function runTurn(
  pipeline: CordisPipeline,
  sessionId: string,
  conversationId: string,
): Promise<Readonly<CordisTurnResult>> {
  return pipeline.runTurn({
    entrance: "ui_web",
    actor: syntheticActor(),
    session: { sessionId, conversationId },
    event: syntheticEvent({ conversationId, turnId: turnId("r114"), text: "[synthetic] 今天我们读点什么？" }),
    childAgeYears: 9,
  });
}

function seedConfirmedPreference(memory: Fixture["memory"]): string {
  const proposed = memory.proposeCandidate(
    {
      schemaVersion: "1.0",
      subjectRef: SYNTHETIC_CHILD_REF,
      type: "confirmed_preference",
      claim: "喜欢太空主题的故事",
      source: "child_statement",
      observedAt: "2026-06-01T08:00:00Z",
      expiresAt: null,
      reviewAt: null,
      sensitivity: "normal",
    },
    syntheticActor(),
  );
  assert.ok(proposed.ok);
  if (!proposed.ok) return "";
  const confirmed = memory.confirmCandidate({ memoryId: proposed.entry.memoryId }, syntheticActor());
  assert.ok(confirmed.ok);
  return proposed.entry.memoryId;
}

test("a turn in a NEW session carries the confirmed memory ref (跨会话检索)", async () => {
  const { pipeline, memory, trace } = makeFixture();
  const memoryId = seedConfirmedPreference(memory);

  // Session A: the fact is referenced.
  const turnA = await runTurn(pipeline, SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A);
  assert.equal(turnA.response.status, "completed");
  assert.ok(turnA.contextRefIds.includes(memoryId));
  assert.ok(
    turnA.harnessContext?.contextRefs.some((ref) => ref.kind === "memory" && ref.refId === memoryId),
  );

  // Session B (a DIFFERENT session, same subject): the fact is referenced
  // again — memory is subject-bound, not session-bound.
  const turnB = await runTurn(pipeline, SYNTHETIC_SESSION_B, SYNTHETIC_CONVERSATION_B);
  assert.ok(turnB.contextRefIds.includes(memoryId));

  // The trace records the retrieval structurally (count only, no bodies).
  const memoryEvents = trace.events().filter((event) => event.type === "memory.context");
  assert.equal(memoryEvents.length, 2);
  for (const event of memoryEvents) {
    if (event.type === "memory.context") {
      assert.equal(event.resultCode, "ok");
      assert.equal(event.memoryRefCount, 1);
    }
  }
});

test("after correction the old claim never re-enters a new session's context", async () => {
  const { pipeline, memory } = makeFixture();
  const memoryId = seedConfirmedPreference(memory);
  const corrected = memory.correctMemory(
    { memoryId, claim: "我现在不喜欢太空主题的故事了" },
    syntheticActor(),
  );
  assert.ok(corrected.ok);

  const turn = await runTurn(pipeline, SYNTHETIC_SESSION_B, SYNTHETIC_CONVERSATION_B);
  assert.equal(turn.contextRefIds.includes(memoryId), false, "superseded claims must not be re-injected");
  assert.ok(corrected.ok && turn.contextRefIds.includes(corrected.entry.memoryId));
});

test("after deletion no session carries any memory ref (删除 → 检索为 0)", async () => {
  const { pipeline, memory } = makeFixture();
  const memoryId = seedConfirmedPreference(memory);
  assert.ok(memory.deleteMemory({ memoryId }, syntheticActor()).ok);
  const turn = await runTurn(pipeline, SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A);
  assert.deepEqual(turn.contextRefIds, []);
  const memoryEvents = turn.harnessContext?.contextRefs.filter((ref) => ref.kind === "memory") ?? [];
  assert.equal(memoryEvents.length, 0);
});

test("a failing memory provider degrades observably to zero refs — the turn still completes", async () => {
  const { pipeline, trace } = makeFixture({
    memoryContext: () => {
      throw new Error("memory_context_unavailable");
    },
  });
  const turn = await runTurn(pipeline, SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A);
  assert.equal(turn.response.status, "completed");
  assert.equal(turn.contextRefIds.filter((id) => id.startsWith("mem_")).length, 0);
  const memoryEvents = trace.events().filter((event) => event.type === "memory.context");
  assert.equal(memoryEvents.length, 1);
  if (memoryEvents[0]?.type === "memory.context") {
    assert.equal(memoryEvents[0].resultCode, "memory_context_failed");
    assert.equal(memoryEvents[0].memoryRefCount, 0);
  }
});

test("a malformed memory ref degrades fail-closed (never partially admitted)", async () => {
  const { pipeline, trace } = makeFixture({
    memoryContext: () => [
      { kind: "memory", refId: "mem_legit00001", version: "1" },
      { kind: "memory", refId: { smuggled: true }, version: "1" },
    ],
  });
  const turn = await runTurn(pipeline, SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A);
  assert.equal(turn.response.status, "completed");
  assert.equal(turn.contextRefIds.includes("mem_legit00001"), false, "no partial admission");
  const memoryEvents = trace.events().filter((event) => event.type === "memory.context");
  if (memoryEvents[0]?.type === "memory.context") {
    assert.equal(memoryEvents[0].resultCode, "memory_context_failed");
  }
});

test("without the hook nothing changes: no memory refs, no memory trace events", async () => {
  const trace = createRuntimeTraceRecorder();
  const pipeline = createCordisPipeline({
    gateway: createTestGateway({ provider: mockProvider() }),
    modelId: "mock-model",
    sessionMapper: createDshSessionMapper({ port: fakePort(), clock: () => 1000 }),
    trace,
    personaPolicy: resolveActivePersona(),
  });
  const turn = await runTurn(pipeline, SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A);
  assert.equal(turn.response.status, "completed");
  assert.equal(trace.events().some((event) => event.type === "memory.context"), false);
});

test("the memory.propose tool path creates a candidate only (never a write)", async () => {
  const { pipeline, memory } = makeFixture();
  // Activate the mapped session first (tool calls only run inside one).
  await runTurn(pipeline, SYNTHETIC_SESSION_A, SYNTHETIC_CONVERSATION_A);

  const execution = await pipeline.executeServiceCall(
    {
      callId: "call_mempropose01",
      toolId: "memory.propose",
      declaredCategory: "memory_propose",
      declaredVersion: "1.0",
      requestedPermissions: ["memory.propose"],
      input: {
        schemaVersion: "1.0",
        type: "confirmed_preference",
        claim: "喜欢太空主题的故事",
        source: "agent_proposal",
        observedAt: "2026-06-01T08:00:00Z",
        expiresAt: null,
        reviewAt: null,
        sensitivity: "normal",
      },
    },
    { actorRole: "system", traceId: "trc_r114tool001", turnId: "trn_r114tool001", sessionId: SYNTHETIC_SESSION_A },
  );
  assert.equal(execution.status, "executed");
  if (execution.status === "executed") {
    assert.equal(execution.candidateOnly, true);
    assert.equal(execution.refs.length, 1);
    assert.equal(execution.refs[0]?.kind, "memory");
  }
  // The candidate is NOT retrievable (candidate-only invariant holds end to end).
  const refs = memory.retrieveForContext({ subjectRef: SYNTHETIC_CHILD_REF }, syntheticActor());
  assert.ok(refs.ok && refs.refs.length === 0);

  // After the HUMAN confirmation, the lookup tool returns the ref.
  const entries = memory.listEntries(SYNTHETIC_CHILD_REF, {
    role: "guardian",
    actorId: "act_rtfamilys1",
    childRef: SYNTHETIC_CHILD_REF,
    verifiedBy: "rt-fixture-verifier",
    verifiedAt: "2026-06-01T08:00:00Z",
  });
  const candidate = entries.find((entry) => entry.status === "candidate");
  assert.ok(candidate !== undefined);
  assert.ok(memory.confirmCandidate({ memoryId: candidate.memoryId }, syntheticActor()).ok);
  const lookup = await pipeline.executeServiceCall(
    {
      callId: "call_memlookup01",
      toolId: "memory.lookup",
      declaredCategory: "memory_read",
      declaredVersion: "1.0",
      requestedPermissions: ["memory.read"],
    },
    { actorRole: "child", traceId: "trc_r114tool002", turnId: "trn_r114tool002", sessionId: SYNTHETIC_SESSION_A },
  );
  assert.equal(lookup.status, "executed");
  if (lookup.status === "executed") {
    assert.equal(lookup.candidateOnly, false);
    assert.equal(lookup.refs.length, 1);
  }

  // A direct-write attempt through the tool entrance stays blocked (carried
  // #19 baseline scenario still holds).
  const directWrite = await pipeline.executeServiceCall(
    {
      callId: "call_memwrite001",
      toolId: "memory.propose",
      declaredCategory: "memory_propose",
      declaredVersion: "1.0",
      requestedPermissions: ["memory.propose", "memory.direct_write"],
      input: { claim: "直接写入" },
    },
    { actorRole: "system", traceId: "trc_r114tool003", turnId: "trn_r114tool003", sessionId: SYNTHETIC_SESSION_A },
  );
  assert.equal(directWrite.status, "rejected");

  // A rejected proposal (label screen) surfaces as a failed tool call and
  // stores nothing.
  const labelProposal = await pipeline.executeServiceCall(
    {
      callId: "call_mempropose02",
      toolId: "memory.propose",
      declaredCategory: "memory_propose",
      declaredVersion: "1.0",
      requestedPermissions: ["memory.propose"],
      input: {
        schemaVersion: "1.0",
        type: "psychological_label",
        claim: "该儿童表现出多动症特征",
        source: "agent_proposal",
        observedAt: "2026-06-01T08:00:00Z",
        expiresAt: null,
        reviewAt: null,
        sensitivity: "normal",
      },
    },
    { actorRole: "system", traceId: "trc_r114tool004", turnId: "trn_r114tool004", sessionId: SYNTHETIC_SESSION_A },
  );
  assert.equal(labelProposal.status, "failed");
  assert.equal(
    memory.listEntries(SYNTHETIC_CHILD_REF, {
      role: "guardian",
      actorId: "act_rtfamilys1",
      childRef: SYNTHETIC_CHILD_REF,
      verifiedBy: "rt-fixture-verifier",
      verifiedAt: "2026-06-01T08:00:00Z",
    }).some((entry) => entry.claim.includes("多动症")),
    false,
  );
});
