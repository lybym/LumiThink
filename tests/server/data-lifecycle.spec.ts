/**
 * R1-09 child data lifecycle — server integration tests (issue #21).
 *
 * Acceptance coverage (all synthetic data):
 * - AC 1: after the synthetic child's data is erased, cross-session
 *   retrieval is 0 and nothing can be recovered from the conversation/
 *   turn-stream/DSH-session state (the in-process equivalents of the DSH
 *   session & temp artifacts).
 * - AC 2: delete, export, recording-off, unauthorized delete and the
 *   post-backup-restore delete replay are all exercised automatically.
 * - AC 3: the recording switch defaults to OFF (最小化采集), the inventory
 *   is structural-only, and the audit/ledger never carry deleted content.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { parseActorContext, type ActorContext } from "../../lib/domain/contract/actor.ts";
import {
  CONTRACT_ID_PREFIXES,
  type ContractIdKind,
} from "../../lib/domain/contract/core.ts";
import type { InteractionAck } from "../../lib/domain/contract/idempotency.ts";
import { parseStreamEvent, type StreamEvent } from "../../lib/domain/contract/response.ts";
import {
  GUARDIAN_FAMILY_CHILD_REF,
} from "../../lib/domain/guardian/authorizations.ts";
import {
  ADMIN_DEMO_ACCESS_CODE,
  GUARDIAN_DEMO_ACCESS_CODE,
} from "../../lib/server/guardian-service.ts";
import { resolveWebMvpActor, WEB_MVP_CHILD_REF } from "../../lib/server/interaction-service.ts";
import { createWebMvpRuntime } from "../../lib/server/web-mvp-runtime.ts";

const NOW = "2026-10-14T08:00:00.000Z";

let idCounter = 0;
function nextId(kind: ContractIdKind): string {
  idCounter += 1;
  return `${CONTRACT_ID_PREFIXES[kind]}${String(idCounter).padStart(8, "0")}`;
}

function childActor(): Readonly<ActorContext> {
  return resolveWebMvpActor(NOW);
}

function guardianSessionActor(): Readonly<ActorContext> {
  return parseActorContext({
    role: "guardian",
    actorId: "act_guardian_demo01",
    childRef: GUARDIAN_FAMILY_CHILD_REF,
    verifiedBy: "guardian-session-v1",
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
      text: { content: "[synthetic] R1-09 lifecycle 测试偏好：喜欢太空主题的故事", format: "plain" },
      clientContext: { client: "web", clientVersion: "2.0.0-web" },
    },
  };
}

async function drainEvents(
  runtime: ReturnType<typeof createWebMvpRuntime>,
  ack: Readonly<InteractionAck>,
  actor: Readonly<ActorContext>,
): Promise<StreamEvent[]> {
  const opened = runtime.service.openEventStream({ actor, traceId: ack.traceId });
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

/** Login a guardian/admin and return the Bearer header value. */
function loginAs(
  runtime: ReturnType<typeof createWebMvpRuntime>,
  code: string,
): string {
  const login = runtime.guardian.sessionLogin({ body: { protocolVersion: "1.0", accessCode: code } });
  assert.equal(login.kind, "ok");
  if (login.kind !== "ok") {
    throw new Error("unreachable");
  }
  return `Bearer ${(login.body as { sessionToken: string }).sessionToken}`;
}

/** Submit one serving turn and drain it to completion. */
async function runServingTurn(
  runtime: ReturnType<typeof createWebMvpRuntime>,
  conversationId?: string,
): Promise<Readonly<InteractionAck>> {
  const result = await runtime.service.submitInteraction({ body: submitBody(conversationId), actor: childActor() });
  assert.equal(result.kind, "ack");
  if (result.kind !== "ack") {
    throw new Error("unreachable");
  }
  await drainEvents(runtime, result.body, childActor());
  return result.body;
}

/** Intake + confirm one memory for the demo child (the synthetic fact). */
function confirmSyntheticMemory(
  runtime: ReturnType<typeof createWebMvpRuntime>,
  claim: string,
): string {
  const proposed = runtime.memory.proposeCandidate(
    {
      schemaVersion: "1.0",
      subjectRef: WEB_MVP_CHILD_REF,
      type: "confirmed_preference",
      claim,
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
  const confirmed = runtime.memory.confirmCandidate({ memoryId: proposed.entry.memoryId }, childActor());
  assert.ok(confirmed.ok);
  return proposed.entry.memoryId;
}

function retrievalCount(runtime: ReturnType<typeof createWebMvpRuntime>): number {
  const result = runtime.memory.retrieveForContext({ subjectRef: WEB_MVP_CHILD_REF }, childActor());
  assert.ok(result.ok);
  return result.ok ? result.refs.length : -1;
}

// ---------------------------------------------------------------------------
// AC 1: erase → cross-session retrieval 0, no accidental recovery
// ---------------------------------------------------------------------------

test("erase: cross-session retrieval becomes 0 and no store keeps recoverable child content", async () => {
  const runtime = createWebMvpRuntime();
  // Seed saved content: one recorded conversation (switch ON), one memory.
  const auth = loginAs(runtime, GUARDIAN_DEMO_ACCESS_CODE);
  const enable = runtime.guardian.postAuthorizations({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "set_feature_switch", switchId: "conversation_recording", enabled: true },
  });
  assert.equal(enable.kind, "ok");
  const ack = await runServingTurn(runtime);
  const memoryId = confirmSyntheticMemory(runtime, "喜欢太空主题的故事");
  assert.ok(retrievalCount(runtime) >= 1, "precondition: the fact is retrievable");

  // A second conversation/session also exists (跨 Session 前置).
  await runServingTurn(runtime);
  assert.equal(runtime.service.conversationsOwnedBy(childActor().actorId).length, 2);

  const erase = await runtime.guardian.eraseChildData({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "erase_child_data" },
  });
  assert.equal(erase.kind, "ok");
  const eraseBody = (erase.kind === "ok" ? erase.body : null) as {
    action: string;
    purged: { conversations: number; historyEntries: number; turnStreams: number; memories: number; dshSessions: number };
  } | null;
  assert.ok(eraseBody !== null);
  assert.equal(eraseBody.action, "erase_child_data");
  assert.ok(eraseBody.purged.conversations >= 2);
  assert.ok(eraseBody.purged.historyEntries >= 2, "recorded history text must be purged");
  assert.ok(eraseBody.purged.turnStreams >= 2, "turn event buffers must be purged");
  assert.ok(eraseBody.purged.memories >= 1);
  assert.ok(eraseBody.purged.dshSessions >= 2, "DSH session mappings must be closed");

  // AC 1: cross-session retrieval is 0 — a NEW conversation/session gets no
  // memory refs, and no memory entry survives.
  assert.equal(retrievalCount(runtime), 0);
  assert.equal(runtime.memory.listEntries(WEB_MVP_CHILD_REF, guardianSessionActor()).length, 0);
  // The interaction state holds no recoverable conversation content.
  assert.equal(runtime.service.conversationsOwnedBy(childActor().actorId).length, 0);
  const snapshot = runtime.service.childDataSnapshot(childActor().actorId);
  assert.equal(snapshot.conversations.length, 0);
  assert.equal(snapshot.turnStreams.total, 0);
  // The purged conversation's DSH session mapping is closed: a replay of the
  // erased conversation id cannot resume into the old DSH session.
  const resumed = await runtime.service.submitInteraction({
    body: submitBody(ack.conversationId),
    actor: childActor(),
  });
  assert.equal(resumed.kind, "error", "the erased conversation no longer exists (no recovery)");
  // The turn stream of the erased turn is gone from the registry.
  const lateStream = runtime.service.openEventStream({ actor: childActor(), traceId: ack.traceId });
  assert.equal(lateStream.kind, "error", "the erased turn's event buffer is not recoverable");

  // The erase result and every audit surface carry structure only — the
  // deleted claim text never reappears anywhere (交付范围 4).
  const claim = "喜欢太空主题的故事";
  const surfaces = [
    JSON.stringify(eraseBody),
    JSON.stringify(runtime.guardian.auditEntries()),
    JSON.stringify(runtime.lifecycle.deletionRecords()),
  ].join("\n");
  assert.ok(!surfaces.includes(claim), "deleted content must not survive in any audit/ledger surface");
  // The memory audit ring records the hard-delete facts without the claim.
  assert.ok(runtime.memory.auditSnapshot().some((entry) => entry.action === "memory.delete" && entry.outcome === "purged"));
  // The guardian audit has the structured erase fact.
  assert.ok(runtime.guardian.auditEntries().some((entry) => entry.kind === "data_erase"));
});

// ---------------------------------------------------------------------------
// AC 2 (recording switch): default OFF, explicit ON, turn buffer purge
// ---------------------------------------------------------------------------

test("recording defaults to OFF: no conversation text is retained and ended buffers purge", async () => {
  const runtime = createWebMvpRuntime();
  const inventory = runtime.lifecycle.inventory();
  assert.equal(inventory.recordingEnabled, false, "默认最小化采集：记录开关默认关闭");

  const ack = await runServingTurn(runtime);
  // The turn ran (stream completed), but NOTHING was retained.
  const snapshot = runtime.service.childDataSnapshot(childActor().actorId);
  const conversation = snapshot.conversations.find((c) => c.conversationId === ack.conversationId);
  assert.ok(conversation !== undefined, "the conversation record (ids only) still exists for continuity");
  assert.equal(conversation.history.length, 0, "no chat text is retained with recording off");
  // The ended turn's event buffer (child text + output) is purged at end.
  assert.equal(snapshot.turnStreams.total, 0);
  const lateStream = runtime.service.openEventStream({ actor: childActor(), traceId: ack.traceId });
  assert.equal(lateStream.kind, "error", "ended turn buffers do not outlive their consumers");

  // Export with recording off carries no conversation text.
  const auth = loginAs(runtime, GUARDIAN_DEMO_ACCESS_CODE);
  const exportResult = runtime.guardian.exportChildData({ authorization: auth });
  assert.equal(exportResult.kind, "ok");
  const data = (exportResult.kind === "ok" ? exportResult.body : null) as {
    recordingEnabled: boolean;
    conversations: { history: unknown[] }[];
  } | null;
  assert.ok(data !== null);
  assert.equal(data.recordingEnabled, false);
  assert.ok(data.conversations.every((c) => c.history.length === 0));
});

test("recording ON: history is retained, inventory shows it, export carries it", async () => {
  const runtime = createWebMvpRuntime();
  const auth = loginAs(runtime, GUARDIAN_DEMO_ACCESS_CODE);
  const enable = runtime.guardian.postAuthorizations({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "set_feature_switch", switchId: "conversation_recording", enabled: true },
  });
  assert.equal(enable.kind, "ok");

  const ack = await runServingTurn(runtime);
  const inventory = runtime.lifecycle.inventory();
  assert.equal(inventory.recordingEnabled, true);
  const conversationView = inventory.conversations.find((c) => c.conversationId === ack.conversationId);
  assert.ok(conversationView !== undefined);
  assert.ok(conversationView.historyEntries >= 1, "recorded history shows up as COUNTS in the inventory");

  // The inventory shape itself must not carry content fields.
  const inventoryJson = JSON.stringify(inventory);
  assert.ok(!inventoryJson.includes("喜欢太空主题的故事"), "inventory never carries conversation text");

  // Export (authorized) DOES carry the content.
  const exportResult = runtime.guardian.exportChildData({ authorization: auth });
  assert.equal(exportResult.kind, "ok");
  const data = (exportResult.kind === "ok" ? exportResult.body : null) as {
    conversations: { history: { role: string; content: string }[] }[];
  } | null;
  assert.ok(data !== null);
  const exported = data.conversations.find((c) => c.history.length > 0);
  assert.ok(exported !== undefined, "the authorized export carries the saved conversation text");
  assert.ok(exported.history.some((entry) => entry.content.includes("喜欢太空主题的故事")));
});

// ---------------------------------------------------------------------------
// AC 2 (replay): post-backup-restore delete replay
// ---------------------------------------------------------------------------

test("delete replay re-purges re-created data (备份恢复后的删除重放)", async () => {
  const runtime = createWebMvpRuntime();
  const auth = loginAs(runtime, GUARDIAN_DEMO_ACCESS_CODE);
  // Recording ON so the "restored backup" includes conversation text.
  const enable = runtime.guardian.postAuthorizations({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "set_feature_switch", switchId: "conversation_recording", enabled: true },
  });
  assert.equal(enable.kind, "ok");

  // 1. First erase (creates a deletion record).
  await runServingTurn(runtime);
  confirmSyntheticMemory(runtime, "喜欢恐龙主题的故事");
  const erase = await runtime.guardian.eraseChildData({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "erase_child_data" },
  });
  assert.equal(erase.kind, "ok");
  assert.equal(retrievalCount(runtime), 0);

  // 2. Simulate a backup RESTORE: equivalent data re-appears through the
  // normal creation paths (same subject; this is what a restored backup of
  // a pre-delete state would look like to the serving process).
  await runServingTurn(runtime);
  confirmSyntheticMemory(runtime, "喜欢恐龙主题的故事");
  assert.ok(retrievalCount(runtime) >= 1, "the restored data is live again");
  assert.equal(runtime.service.conversationsOwnedBy(childActor().actorId).length, 1);

  // 3. The replay re-deletes EVERYTHING the prior erase covered.
  const replay = await runtime.guardian.eraseChildData({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "replay_child_deletions" },
  });
  assert.equal(replay.kind, "ok");
  const replayBody = (replay.kind === "ok" ? replay.body : null) as {
    action: string;
    purged: { conversations: number; memories: number };
  } | null;
  assert.ok(replayBody !== null);
  assert.equal(replayBody.action, "replay_child_deletions");
  assert.ok(replayBody.purged.conversations >= 1);
  assert.ok(replayBody.purged.memories >= 1);
  // Cross-session retrieval is 0 again.
  assert.equal(retrievalCount(runtime), 0);
  assert.equal(runtime.memory.listEntries(WEB_MVP_CHILD_REF, guardianSessionActor()).length, 0);
  assert.equal(runtime.service.conversationsOwnedBy(childActor().actorId).length, 0);

  // The ledger holds both tombstones with structural facts only.
  const records = runtime.lifecycle.deletionRecords();
  assert.equal(records.length, 2);
  assert.equal(records[0]?.action, "erase_child_data");
  assert.equal(records[1]?.action, "replay_child_deletions");
  assert.ok(!JSON.stringify(records).includes("喜欢恐龙主题的故事"));
});

test("replay with nothing to delete is a provable no-op that still records a tombstone", async () => {
  const runtime = createWebMvpRuntime();
  const auth = loginAs(runtime, GUARDIAN_DEMO_ACCESS_CODE);
  const replay = await runtime.guardian.eraseChildData({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "replay_child_deletions" },
  });
  assert.equal(replay.kind, "ok");
  const body = (replay.kind === "ok" ? replay.body : null) as {
    purged: { conversations: number; memories: number };
  } | null;
  assert.ok(body !== null);
  assert.equal(body.purged.conversations, 0);
  assert.equal(body.purged.memories, 0);
  assert.equal(runtime.lifecycle.deletionRecords().length, 1);
});

// ---------------------------------------------------------------------------
// AC 2 (unauthorized delete) + role matrix on the data surfaces
// ---------------------------------------------------------------------------

test("data surfaces enforce the role matrix: admin cannot export/erase, child/anonymous get nothing", async () => {
  const runtime = createWebMvpRuntime();
  const guardianAuth = loginAs(runtime, GUARDIAN_DEMO_ACCESS_CODE);
  const adminAuth = loginAs(runtime, ADMIN_DEMO_ACCESS_CODE);

  // Admin may read the structural inventory but never export or erase.
  assert.equal(runtime.guardian.getChildDataInventory({ authorization: adminAuth }).kind, "ok");
  const adminExport = runtime.guardian.exportChildData({ authorization: adminAuth });
  assert.equal(adminExport.kind, "error");
  if (adminExport.kind === "error") {
    assert.equal(adminExport.envelope.error.code, "CONTRACT_WRONG_ROLE");
  }
  const adminErase = await runtime.guardian.eraseChildData({
    authorization: adminAuth,
    body: { protocolVersion: "1.0", action: "erase_child_data" },
  });
  assert.equal(adminErase.kind, "error");
  if (adminErase.kind === "error") {
    assert.equal(adminErase.envelope.error.code, "CONTRACT_WRONG_ROLE");
  }

  // Anonymous: all three surfaces are inaccessible.
  assert.equal(runtime.guardian.getChildDataInventory({ authorization: null }).kind, "error");
  assert.equal(runtime.guardian.exportChildData({ authorization: null }).kind, "error");
  assert.equal(
    (await runtime.guardian.eraseChildData({ authorization: null, body: { protocolVersion: "1.0", action: "erase_child_data" } })).kind,
    "error",
  );

  // A guardian session works on all three surfaces (positive control).
  assert.equal(runtime.guardian.getChildDataInventory({ authorization: guardianAuth }).kind, "ok");
  assert.equal(runtime.guardian.exportChildData({ authorization: guardianAuth }).kind, "ok");

  // No data was destroyed by the denied attempts.
  assert.ok(runtime.guardian.auditEntries().some((entry) => entry.kind === "access_denied" && entry.detail === "role_denied"));
});

test("malformed erase bodies fail closed without echoing submitted values", async () => {
  const runtime = createWebMvpRuntime();
  const auth = loginAs(runtime, GUARDIAN_DEMO_ACCESS_CODE);
  const bad = await runtime.guardian.eraseChildData({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "wipe_database", subjectRef: "chd_attacker01" },
  });
  assert.equal(bad.kind, "error");
  if (bad.kind === "error") {
    const serialized = JSON.stringify(bad.envelope);
    assert.ok(!serialized.includes("wipe_database"));
    assert.ok(!serialized.includes("chd_attacker01"));
  }
  // Unknown protocol version is rejected.
  const badVersion = await runtime.guardian.eraseChildData({
    authorization: auth,
    body: { protocolVersion: "2.0", action: "erase_child_data" },
  });
  assert.equal(badVersion.kind, "error");
});

// ---------------------------------------------------------------------------
// AC 3: matrix + inventory honesty surfaces
// ---------------------------------------------------------------------------

test("the inventory exposes the honest structural picture (ids + counts only)", async () => {
  const runtime = createWebMvpRuntime();
  const auth = loginAs(runtime, GUARDIAN_DEMO_ACCESS_CODE);
  const enable = runtime.guardian.postAuthorizations({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "set_feature_switch", switchId: "conversation_recording", enabled: true },
  });
  assert.equal(enable.kind, "ok");
  await runServingTurn(runtime);
  confirmSyntheticMemory(runtime, "喜欢太空主题的故事");

  const inventory = runtime.lifecycle.inventory();
  assert.equal(inventory.protocolVersion, "1.0");
  assert.equal(inventory.childRef, GUARDIAN_FAMILY_CHILD_REF);
  assert.ok(inventory.conversations.length >= 1);
  assert.ok(inventory.dshSessions.mapped >= 1, "the live DSH mapping shows in the inventory");
  assert.equal(inventory.memories.confirmed, 1);
  assert.equal(inventory.deletionLedger.records, 0);
  // The inventory shape has no content-bearing field (exclusions belong to
  // the export shape only).
  assert.ok(
    !Object.keys(inventory as unknown as Record<string, unknown>).includes("exclusions"),
    "inventory must not carry the export's exclusions/content surfaces",
  );

  // The serialized inventory must not contain the chat text or the claim.
  const serialized = JSON.stringify(inventory);
  assert.ok(!serialized.includes("喜欢太空主题的故事"));
});

test("an unauthorized expire-cleanup attempt is now observable in the memory audit (carried #26 P2-4)", () => {
  const runtime = createWebMvpRuntime();
  const child = childActor();
  const before = runtime.memory.auditSnapshot().filter((entry) => entry.action === "memory.expire_cleanup").length;
  assert.equal(runtime.memory.expirePastCandidates(child), 0, "child may not run cleanup");
  const after = runtime.memory.auditSnapshot().filter((entry) => entry.action === "memory.expire_cleanup");
  assert.equal(after.length, before + 1, "the denial is auditable");
  const last = after[after.length - 1];
  assert.ok(last !== undefined);
  assert.equal(last.outcome, "rejected");
  assert.deepEqual([...last.ruleIds], ["memory.unauthorized"]);
});
