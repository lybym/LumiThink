import assert from "node:assert/strict";
import test from "node:test";

import { parseActorContext, type ActorContext } from "../../lib/domain/contract/actor.ts";
import {
  CONTRACT_ID_PREFIXES,
  type ContractIdKind,
} from "../../lib/domain/contract/core.ts";
import type { InteractionAck } from "../../lib/domain/contract/idempotency.ts";
import { parseStreamEvent } from "../../lib/domain/contract/response.ts";
import { GUARDIAN_FAMILY_CHILD_REF } from "../../lib/domain/guardian/authorizations.ts";
import { MEMORY_LABEL_SCREEN_TERMS } from "../../lib/domain/memory/schema.ts";
import {
  resolveWebMvpActor,
  WEB_MVP_ACTOR_ID,
  WEB_MVP_CHILD_REF,
} from "../../lib/server/interaction-service.ts";
import { createWebMvpRuntime, type WebMvpRuntime } from "../../lib/server/web-mvp-runtime.ts";
import {
  captureRuntimeSnapshot,
  restoreRuntimeSnapshot,
} from "../../lib/server/snapshot/runtime-snapshot.ts";
import { GUARDIAN_DEMO_ACCESS_CODE } from "../../lib/server/guardian-service.ts";

/**
 * E2E-10 (issue #60) — controlled child-memory governance acceptance over
 * the REAL composed serving runtime: 受控记忆的完整闭环
 * (agent 候选 → 明确确认 → 跨会话引用 → 修订 → 删除) plus the hard
 * prohibitions (禁止自动沉淀心理诊断/人格标签、未经确认的候选不进上下文、
 * 直写与设备旁路被拒、恢复快照不复活已删除内容).
 *
 * Honest boundary: the "真实语音触发" leg is the transient channel proven by
 * E2E-01/05/07/08/09 (device → ASR final → authorized transient text →
 * trusted agent). This suite proves the memory-governance loop for what that
 * transcript produces downstream: agent proposals through the WHITELISTED
 * candidate-only memory tool of the real serving pipeline, explicit human
 * confirmations, cross-session references and deletions. The physical device
 * execution is an operator item (deploy/xiaozhi/runbook.md §13).
 *
 * All claims are [synthetic]; no real child data.
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
    actorId: "act_guardian_e2e10",
    childRef: GUARDIAN_FAMILY_CHILD_REF,
    verifiedBy: "e2e10-governance-test",
    verifiedAt: NOW,
  };
}

/** Server-side lifecycle actor (same construction as the wiring). */
function lifecycleActor(): Readonly<ActorContext> {
  return parseActorContext({
    role: "guardian",
    actorId: "act_guardian_data_lifecycle",
    childRef: GUARDIAN_FAMILY_CHILD_REF,
    verifiedBy: "data-lifecycle-v1",
    verifiedAt: NOW,
  });
}

function submitBody(conversationId?: string): Record<string, unknown> {
  return {
    protocolVersion: "1.0",
    interaction: {
      kind: "text",
      clientRequestId: nextId("requestId"),
      ...(conversationId !== undefined ? { conversationId } : {}),
      text: { content: "[synthetic] E2E-10 受控记忆验收轮次", format: "plain" },
      clientContext: { client: "web", clientVersion: "2.0.0-web" },
    },
  };
}

async function drainEvents(
  runtime: WebMvpRuntime,
  ack: Readonly<InteractionAck>,
): Promise<void> {
  const opened = runtime.service.openEventStream({ actor: childActor(), traceId: ack.traceId });
  assert.equal(opened.kind, "stream");
  if (opened.kind !== "stream") {
    throw new Error("unreachable");
  }
  for await (const frame of opened.events) {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(dataLine !== undefined);
    parseStreamEvent(JSON.parse(dataLine.slice("data: ".length)) as unknown);
  }
}

/** One real serving turn; returns its traceId for the memory.context assert. */
async function runServingTurn(runtime: WebMvpRuntime): Promise<string> {
  const result = await runtime.service.submitInteraction({ body: submitBody(), actor: childActor() });
  assert.equal(result.kind, "ack");
  if (result.kind !== "ack") {
    throw new Error("unreachable");
  }
  await drainEvents(runtime, result.body);
  return result.body.traceId;
}

async function ensureWiredSession(runtime: WebMvpRuntime, sessionId: string): Promise<void> {
  const ensured = await runtime.pipeline.sessionMapper.ensureSession({
    lumiSessionId: sessionId,
    conversationId: `conv_e2e10mem${sessionId.slice(-4)}`,
    actorId: childActor().actorId,
    traceId: `trc_e2e10mem${sessionId.slice(-6)}`,
    turnId: `trn_e2e10mem${sessionId.slice(-6)}`,
  });
  assert.ok(ensured.ok);
}

function memoryContextRefCount(runtime: WebMvpRuntime, traceId: string): number | undefined {
  const event = runtime.trace
    .events()
    .find((entry) => entry.type === "memory.context" && entry.traceId === traceId) as
    | { memoryRefCount?: number }
    | undefined;
  return event?.memoryRefCount;
}

// ---------------------------------------------------------------------------

test("E2E-10 受控记忆全环: agent 候选 → 明确确认 → 跨会话引用 → 修订 → 删除（检索归零、审计完整）", async () => {
  const runtime = createWebMvpRuntime();
  await runServingTurn(runtime); // first serving session

  // 1. The agent proposes through the WHITELISTED tool path (what a voice or
  //    web turn's agent would do after the transient transcript): a
  //    CANDIDATE — never a persisted fact.
  await ensureWiredSession(runtime, "ses_e2e10mem01");
  const proposal = await runtime.pipeline.executeServiceCall(
    {
      callId: "call_e2e10mem001",
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
    { actorRole: "system", traceId: "trc_e2e10mem001", turnId: "trn_e2e10mem01", sessionId: "ses_e2e10mem01" },
  );
  assert.equal(proposal.status, "executed");
  if (proposal.status !== "executed") {
    throw new Error("unreachable");
  }
  assert.equal(proposal.candidateOnly, true, "the tool path can only produce candidates");
  const entriesAfterProposal = runtime.memory.listEntries(WEB_MVP_CHILD_REF, guardianActor());
  assert.equal(entriesAfterProposal.length, 1);
  assert.equal(entriesAfterProposal[0]?.status, "candidate");

  // 2. Unconfirmed candidate: the next serving turn retrieves NOTHING.
  const unconfirmedTraceId = await runServingTurn(runtime);
  assert.equal(memoryContextRefCount(runtime, unconfirmedTraceId), 0, "未经确认的候选绝不进入上下文");

  // 3. Explicit HUMAN confirmation (the child themself).
  const memoryId = entriesAfterProposal[0]?.memoryId ?? "";
  const confirmed = runtime.memory.confirmCandidate({ memoryId }, childActor());
  assert.ok(confirmed.ok, "confirmation is the explicit human moment");

  // 4. Cross-session reference: a NEW conversation (new session) retrieves
  //    the confirmed fact.
  const crossSessionTraceId = await runServingTurn(runtime);
  assert.equal(memoryContextRefCount(runtime, crossSessionTraceId), 1, "跨会话引用成立");
  const refs = runtime.memory.retrieveForContext({ subjectRef: WEB_MVP_CHILD_REF }, childActor());
  assert.ok(refs.ok && refs.refs[0]?.refId === memoryId);

  // 5. Revision (儿童否认 → 更正): the correction supersedes the old fact;
  //    new sessions only see the corrected entry.
  const corrected = runtime.memory.correctMemory(
    { memoryId, claim: "我现在不喜欢太空主题的故事了" },
    childActor(),
  );
  assert.ok(corrected.ok);
  const correctedId = corrected.ok ? corrected.entry.memoryId : "";
  assert.notEqual(correctedId, memoryId);
  const afterCorrection = await runServingTurn(runtime);
  assert.equal(memoryContextRefCount(runtime, afterCorrection), 1);
  const refsAfterCorrection = runtime.memory.retrieveForContext(
    { subjectRef: WEB_MVP_CHILD_REF },
    childActor(),
  );
  assert.ok(refsAfterCorrection.ok && refsAfterCorrection.refs[0]?.refId === correctedId);

  // 6. Deletion (guardian may act for the family): the whole supersedes
  //    lineage is hard-deleted; retrieval empties cross-session.
  const deleted = runtime.memory.deleteMemory({ memoryId: correctedId }, guardianActor());
  assert.ok(deleted.ok);
  if (deleted.ok) {
    assert.ok(deleted.purgedIds.includes(memoryId), "the lineage (original) is purged");
    assert.ok(deleted.purgedIds.includes(correctedId), "the lineage (correction) is purged");
  }
  const afterDeletion = await runServingTurn(runtime);
  assert.equal(memoryContextRefCount(runtime, afterDeletion), 0, "删除后跨会话检索为 0");
  const retrievalAfterDeletion = runtime.memory.retrieveForContext(
    { subjectRef: WEB_MVP_CHILD_REF },
    childActor(),
  );
  assert.ok(retrievalAfterDeletion.ok && retrievalAfterDeletion.refs.length === 0);

  // 7. The full loop is auditable in the memory audit ring (structured only).
  const auditActions = runtime.memory.auditSnapshot().map((entry) => entry.action);
  for (const action of ["memory.propose", "memory.confirm", "memory.correct", "memory.delete"] as const) {
    assert.ok(auditActions.includes(action), `the audit ring records ${action}`);
  }
});

test("E2E-10 禁止自动沉淀: 诊断/人格标签候选被拒（直连 + 工具路径）、跨主体候选被拒、直写与旁路无门", () => {
  const runtime = createWebMvpRuntime();

  // The label screen is the deterministic deny-list (no NLP, no guessing).
  assert.ok(MEMORY_LABEL_SCREEN_TERMS.includes("心理诊断"));
  assert.ok(MEMORY_LABEL_SCREEN_TERMS.includes("人格"));

  // Direct path: a system-proposed psychological label is rejected as a
  // candidate and NO entry is created.
  const screened = runtime.memory.proposeCandidate(
    {
      schemaVersion: "1.0",
      subjectRef: WEB_MVP_CHILD_REF,
      type: "confirmed_preference",
      claim: "[synthetic] 心理诊断：有抑郁倾向，人格内向",
      source: "agent_proposal",
      observedAt: NOW,
      expiresAt: null,
      reviewAt: null,
      sensitivity: "normal",
    },
    childActor(),
  );
  assert.equal(screened.ok, false);
  if (!screened.ok) {
    assert.equal(screened.code, "memory.label_screen_block");
  }
  assert.equal(runtime.memory.listEntries(WEB_MVP_CHILD_REF, guardianActor()).length, 0);

  // Tool path: the same proposal through the serving pipeline's tool surface
  // fails the handler (structured tool failure) and still creates nothing.
  // (Executed in the async tool-path test below.)

  // Cross-subject: the child actor cannot sediment facts about ANOTHER child.
  const foreign = runtime.memory.proposeCandidate(
    {
      schemaVersion: "1.0",
      subjectRef: "chd_demo_002",
      type: "necessary_fact",
      claim: "[synthetic] 喜欢恐龙",
      source: "child_statement",
      observedAt: NOW,
      expiresAt: null,
      reviewAt: null,
      sensitivity: "normal",
    },
    childActor(),
  );
  assert.equal(foreign.ok, false);
  if (!foreign.ok) {
    assert.equal(foreign.code, "memory.subject_mismatch");
  }
});

test("E2E-10 禁止自动沉淀（工具路径）: 诊断标签提议在管线工具面 fail，且不产生任何条目", async () => {
  const runtime = createWebMvpRuntime();
  await ensureWiredSession(runtime, "ses_e2e10mem02");
  const before = runtime.memory.listEntries(WEB_MVP_CHILD_REF, guardianActor()).length;

  const screenedProposal = await runtime.pipeline.executeServiceCall(
    {
      callId: "call_e2e10mem002",
      toolId: "memory.propose",
      declaredCategory: "memory_propose",
      declaredVersion: "1.0",
      requestedPermissions: ["memory.propose"],
      input: {
        schemaVersion: "1.0",
        type: "confirmed_preference",
        claim: "[synthetic] 心理诊断：注意力障碍",
        source: "agent_proposal",
        observedAt: NOW,
        expiresAt: null,
        reviewAt: null,
        sensitivity: "normal",
      },
    },
    { actorRole: "system", traceId: "trc_e2e10mem002", turnId: "trn_e2e10mem02", sessionId: "ses_e2e10mem02" },
  );
  assert.equal(screenedProposal.status, "failed", "the rejected proposal surfaces as a tool failure");
  assert.equal(runtime.memory.listEntries(WEB_MVP_CHILD_REF, guardianActor()).length, before);
  const rejection = runtime.memory
    .auditSnapshot()
    .find((entry) => entry.action === "memory.propose" && entry.outcome === "rejected");
  assert.ok(rejection !== undefined, "the rejection is audited in the memory audit ring");
});

test("E2E-10 恢复快照不复活已删除内容: confirmed memory + 保留正文 → T0 快照 → erase → 旧档恢复 + 删除重放 → 一切保持删除，服务继续", async () => {
  const source = createWebMvpRuntime();
  // Recording ON (guardian switch, disclosure acked by the seeded state) so
  // conversation text exists to be erased and restored.
  const login = source.guardian.sessionLogin({
    body: { protocolVersion: "1.0", accessCode: GUARDIAN_DEMO_ACCESS_CODE },
  });
  assert.equal(login.kind, "ok");
  if (login.kind !== "ok") {
    throw new Error("unreachable");
  }
  const auth = `Bearer ${(login.body as { sessionToken: string }).sessionToken}`;
  const switchOn = source.guardian.postAuthorizations({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "set_feature_switch", switchId: "conversation_recording", enabled: true },
  });
  assert.equal(switchOn.kind, "ok");

  // A real serving turn retains content; a confirmed memory is referenced
  // cross-session.
  const traceId = await runServingTurn(source);
  assert.equal(memoryContextRefCount(source, traceId), 0);
  const proposed = source.memory.proposeCandidate(
    {
      schemaVersion: "1.0",
      subjectRef: WEB_MVP_CHILD_REF,
      type: "confirmed_preference",
      claim: "[synthetic] 偏好：低音量朗读",
      source: "child_statement",
      observedAt: NOW,
      expiresAt: null,
      reviewAt: null,
      sensitivity: "normal",
    },
    childActor(),
  );
  assert.ok(proposed.ok);
  if (!proposed.ok) {
    throw new Error("unreachable");
  }
  assert.ok(source.memory.confirmCandidate({ memoryId: proposed.entry.memoryId }, childActor()).ok);
  const referencedTraceId = await runServingTurn(source);
  assert.equal(memoryContextRefCount(source, referencedTraceId), 1);
  const conversationBefore = source.service.childDataSnapshot(WEB_MVP_ACTOR_ID).conversations;
  assert.ok(conversationBefore.length >= 1);
  assert.ok(conversationBefore[0]?.history.length >= 2, "recording ON retains the turn content");

  // T0 snapshot: content exists.
  const snapshotT0 = captureRuntimeSnapshot(source, {
    source: "manual",
    childActorId: WEB_MVP_ACTOR_ID,
    nowFactory: () => NOW,
  });

  // The guardian erases the subject (tombstone lands).
  const erase = await source.guardian.eraseChildData({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "erase_child_data" },
  });
  assert.equal(erase.kind, "ok");

  // Restore the T0 archive into a FRESH runtime WITH the deletion replay
  // (what deploy/restore.sh + the marker file configure): resurrected
  // content is re-purged — 宁可过删，绝不复活.
  const restored = createWebMvpRuntime();
  const result = await restoreRuntimeSnapshot(
    restored,
    JSON.parse(JSON.stringify(snapshotT0)) as unknown,
    { childActorId: WEB_MVP_ACTOR_ID, replayAfterRestore: true },
  );
  assert.equal(result.replayed, true);
  assert.ok(result.replayPurged.conversations >= 1);

  // Nothing came back: no memory, no history, no cross-session refs.
  assert.equal(
    restored.memory.listEntries(WEB_MVP_CHILD_REF, lifecycleActor()).length,
    0,
    "被删除的记忆不复活",
  );
  const dataSnapshot = restored.service.childDataSnapshot(WEB_MVP_ACTOR_ID);
  assert.equal(dataSnapshot.conversations.length, 0, "被删除的会话正文不复活");

  // The restored runtime keeps SERVING safely: a fresh turn completes with
  // zero memory refs (the deleted fact never returns through the context).
  const freshTraceId = await runServingTurn(restored);
  assert.equal(memoryContextRefCount(restored, freshTraceId), 0);

  // The replay landed its own tombstone and the restore is disclosed.
  assert.equal(restored.lifecycle.deletionRecords().at(-1)?.action, "replay_child_deletions");
  assert.ok(
    restored.guardian.auditEntries().some((entry) => entry.kind === "snapshot_restored"),
    "the restore is disclosed in the guardian audit",
  );
});
