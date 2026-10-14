/**
 * R1-08 encrypted runtime-snapshot tests (issue #20 交付范围 5; AC 1 重启后
 * Session 策略可恢复; AC 2 备份恢复不丢已确认事件、不复活被删数据).
 *
 * All synthetic data. The round trip runs capture on one composed runtime and
 * restore into a FRESH runtime — the in-process equivalent of a restart with
 * the snapshot file.
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
import { GUARDIAN_FAMILY_CHILD_REF } from "../../lib/domain/guardian/authorizations.ts";
import { GUARDIAN_DEMO_ACCESS_CODE } from "../../lib/server/guardian-service.ts";
import { resolveWebMvpActor, WEB_MVP_CHILD_REF } from "../../lib/server/interaction-service.ts";
import { createWebMvpRuntime } from "../../lib/server/web-mvp-runtime.ts";
import {
  RUNTIME_SNAPSHOT_FORMAT,
  captureRuntimeSnapshot,
  restoreRuntimeSnapshot,
  validateRuntimeSnapshot,
} from "../../lib/server/snapshot/runtime-snapshot.ts";
import { WEB_MVP_ACTOR_ID } from "../../lib/server/interaction-service.ts";

const NOW = "2026-10-14T08:00:00.000Z";

let idCounter = 0;
function nextId(kind: ContractIdKind): string {
  idCounter += 1;
  return `${CONTRACT_ID_PREFIXES[kind]}${String(idCounter).padStart(8, "0")}`;
}

function childActor(): Readonly<ActorContext> {
  return resolveWebMvpActor(NOW);
}

function submitBody(conversationId?: string): Record<string, unknown> {
  return {
    protocolVersion: "1.0",
    interaction: {
      kind: "text",
      clientRequestId: nextId("requestId"),
      ...(conversationId !== undefined ? { conversationId: conversationId } : {}),
      text: { content: "[synthetic] R1-08 快照恢复测试：偏好安静的背景音", format: "plain" },
      clientContext: { client: "web", clientVersion: "2.0.0-web" },
    },
  };
}

async function drainEvents(
  runtime: ReturnType<typeof createWebMvpRuntime>,
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

async function runRecordedTurn(
  runtime: ReturnType<typeof createWebMvpRuntime>,
): Promise<Readonly<InteractionAck>> {
  const result = await runtime.service.submitInteraction({ body: submitBody(), actor: childActor() });
  assert.equal(result.kind, "ack");
  if (result.kind !== "ack") {
    throw new Error("unreachable");
  }
  await drainEvents(runtime, result.body);
  return result.body;
}

function loginAs(runtime: ReturnType<typeof createWebMvpRuntime>): string {
  const login = runtime.guardian.sessionLogin({
    body: { protocolVersion: "1.0", accessCode: GUARDIAN_DEMO_ACCESS_CODE },
  });
  assert.equal(login.kind, "ok");
  if (login.kind !== "ok") {
    throw new Error("unreachable");
  }
  return `Bearer ${(login.body as { sessionToken: string }).sessionToken}`;
}

function enableRecording(runtime: ReturnType<typeof createWebMvpRuntime>): void {
  const result = runtime.guardian.postAuthorizations({
    authorization: loginAs(runtime),
    body: { protocolVersion: "1.0", action: "set_feature_switch", switchId: "conversation_recording", enabled: true },
  });
  assert.equal(result.kind, "ok");
}

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

function capture(
  runtime: ReturnType<typeof createWebMvpRuntime>,
): ReturnType<typeof captureRuntimeSnapshot> {
  return captureRuntimeSnapshot(runtime, { source: "manual", childActorId: WEB_MVP_ACTOR_ID, nowFactory: () => NOW });
}

test("snapshot round trip preserves confirmed events into a fresh runtime (AC 1/AC 2)", async () => {
  const source = createWebMvpRuntime();
  enableRecording(source);
  const ack = await runRecordedTurn(source);
  const memoryId = confirmSyntheticMemory(source, "[synthetic] 偏好：喜欢恐龙主题");

  const snapshot = capture(source);
  assert.equal(snapshot.format, RUNTIME_SNAPSHOT_FORMAT);
  assert.equal(snapshot.counts.conversations, 1);
  assert.ok(snapshot.counts.historyEntries >= 2);
  assert.equal(snapshot.counts.memories, 1);

  const restored = createWebMvpRuntime();
  const result = await restoreRuntimeSnapshot(restored, JSON.parse(JSON.stringify(snapshot)) as unknown, {
    childActorId: WEB_MVP_ACTOR_ID,
    replayAfterRestore: false,
  });
  assert.equal(result.conversations, 1);
  assert.equal(result.memories, 1);
  assert.equal(result.idempotency >= 1, true);

  // Session POLICY (the recording switch) survived the restart.
  const recording = restored.guardian.isConversationRecordingEnabled();
  assert.equal(recording, true);
  // The confirmed memory is retrievable again with its ORIGINAL id.
  const entries = restored.memory.listEntries(WEB_MVP_CHILD_REF, parseActorContext({
    role: "guardian",
    actorId: "act_guardian_data_lifecycle",
    childRef: GUARDIAN_FAMILY_CHILD_REF,
    verifiedBy: "data-lifecycle-v1",
    verifiedAt: NOW,
  }));
  assert.equal(entries.some((entry) => entry.memoryId === memoryId), true);
  // The retained history (confirmed domain content) is present again.
  const dataSnapshot = restored.service.childDataSnapshot(WEB_MVP_ACTOR_ID);
  assert.equal(dataSnapshot.conversations.length, 1);
  assert.equal(dataSnapshot.conversations[0]?.conversationId, ack.conversationId);
  // The idempotency ledger keeps its replay protection: re-submitting the
  // SAME requestId is answered as a replay, not a new turn.
  const replay = await restored.service.submitInteraction({
    body: {
      protocolVersion: "1.0",
      interaction: {
        kind: "text",
        clientRequestId: ack.requestId,
        text: { content: "[synthetic] R1-08 快照恢复测试：偏好安静的背景音", format: "plain" },
        clientContext: { client: "web", clientVersion: "2.0.0-web" },
      },
    },
    actor: childActor(),
  });
  assert.equal(replay.kind, "ack");
  if (replay.kind !== "ack") {
    throw new Error("unreachable");
  }
  assert.equal(replay.body.status, "duplicate");
});

test("restore excludes live sessions (fail-closed re-login) and discloses the restore in the audit", async () => {
  const source = createWebMvpRuntime();
  enableRecording(source);
  const oldAuth = loginAs(source);
  const snapshot = capture(source);

  const restored = createWebMvpRuntime();
  await restoreRuntimeSnapshot(restored, JSON.parse(JSON.stringify(snapshot)) as unknown, {
    childActorId: WEB_MVP_ACTOR_ID,
    replayAfterRestore: false,
  });
  // The OLD bearer token is NOT restored: the restore surface rejects it.
  const withOldToken = restored.guardian.getAuthorizations({ authorization: oldAuth });
  assert.equal(withOldToken.kind, "error");
  // A fresh login works and the audit ring discloses the restore.
  const newAuth = loginAs(restored);
  const status = restored.guardian.getAuthorizations({ authorization: newAuth });
  assert.equal(status.kind, "ok");
  const audit = restored.guardian.auditEntries();
  const restoreEntry = audit.find((entry) => entry.kind === "snapshot_restored");
  assert.ok(restoreEntry !== undefined);
  assert.match(restoreEntry.detail ?? "", /src=manual/);
  // The restored ring carries seq continuity from the source ring.
  const lastSeq = audit[audit.length - 1]?.seq ?? 0;
  assert.ok(lastSeq >= (snapshot.guardian.auditNextSeq ?? 0));
});

test("restoring an OLDER archive with the replay flag never resurrects deleted data (AC 2)", async () => {
  const source = createWebMvpRuntime();
  enableRecording(source);
  await runRecordedTurn(source);
  confirmSyntheticMemory(source, "[synthetic] 偏好：低音量朗读");
  // Snapshot T0: content exists.
  const snapshotT0 = capture(source);

  // AFTER the snapshot: the guardian erases the subject (tombstone lands).
  const auth = loginAs(source);
  const erase = await source.guardian.eraseChildData({
    authorization: auth,
    body: { protocolVersion: "1.0", action: "erase_child_data" },
  });
  assert.equal(erase.kind, "ok");

  // Restore the T0 archive into a fresh runtime WITH the replay (what
  // deploy/restore.sh configures): the resurrected content is re-purged.
  const restored = createWebMvpRuntime();
  const result = await restoreRuntimeSnapshot(restored, JSON.parse(JSON.stringify(snapshotT0)) as unknown, {
    childActorId: WEB_MVP_ACTOR_ID,
    replayAfterRestore: true,
  });
  assert.equal(result.replayed, true);
  assert.ok(result.replayPurged.conversations >= 1);
  const dataSnapshot = restored.service.childDataSnapshot(WEB_MVP_ACTOR_ID);
  assert.equal(dataSnapshot.conversations.length, 0);
  assert.equal(restored.memory.listEntries(WEB_MVP_CHILD_REF, parseActorContext({
    role: "guardian",
    actorId: "act_guardian_data_lifecycle",
    childRef: GUARDIAN_FAMILY_CHILD_REF,
    verifiedBy: "data-lifecycle-v1",
    verifiedAt: NOW,
  })).length, 0);
  // The replay landed its own tombstone (ledger continuity preserved).
  assert.equal(restored.lifecycle.deletionRecords().length, snapshotT0.tombstones.length + 1);
  const last = restored.lifecycle.deletionRecords().at(-1);
  assert.equal(last?.action, "replay_child_deletions");
});

function problemsOf(error: unknown): string {
  const problems = (error as { problems?: readonly { path?: string; message?: string }[] })?.problems ?? [];
  return JSON.stringify(problems);
}

test("snapshot validation fails closed: unknown fields, wrong format, malformed sections", () => {
  const source = createWebMvpRuntime();
  const snapshot = JSON.parse(JSON.stringify(capture(source))) as Record<string, unknown>;
  assert.equal(validateRuntimeSnapshot(snapshot).format, RUNTIME_SNAPSHOT_FORMAT);

  assert.throws(() => validateRuntimeSnapshot({ ...snapshot, format: "other/v9" }), (error: unknown) => problemsOf(error).includes("snapshot.format"));
  assert.throws(() => validateRuntimeSnapshot({ ...snapshot, intruder: true }), (error: unknown) => problemsOf(error).includes("unknown field"));
  assert.throws(() => validateRuntimeSnapshot({ ...snapshot, source: "hacked" }), (error: unknown) => problemsOf(error).includes("snapshot.source"));
  assert.throws(() => validateRuntimeSnapshot({ ...snapshot, createdAt: "not-a-date" }), (error: unknown) => problemsOf(error).includes("snapshot.createdAt"));
  assert.throws(() => validateRuntimeSnapshot(null), (error: unknown) => problemsOf(error).includes("must be an object"));
});

test("an invalid section aborts the restore with NO partial state (all-or-nothing)", async () => {
  const source = createWebMvpRuntime();
  enableRecording(source);
  const snapshot = JSON.parse(JSON.stringify(capture(source))) as Record<string, unknown>;
  // Corrupt ONLY the tombstones section.
  (snapshot as Record<string, unknown>).tombstones = [{ recordId: "not-valid" }];

  const restored = createWebMvpRuntime();
  await assert.rejects(
    () =>
      restoreRuntimeSnapshot(restored, snapshot as unknown, {
        childActorId: WEB_MVP_ACTOR_ID,
        replayAfterRestore: false,
      }),
    (error: unknown) => problemsOf(error).includes("deletionRecord"),
  );
  // The fresh runtime kept its DEFAULT state: the recording switch is still
  // OFF and the guardian audit ring is the construction seed burst only.
  assert.equal(restored.guardian.isConversationRecordingEnabled(), false);
  const audit = restored.guardian.auditEntries();
  assert.ok(audit.every((entry) => entry.kind === "seed"));
  assert.equal(restored.service.childDataSnapshot(WEB_MVP_ACTOR_ID).conversations.length, 0);
});
