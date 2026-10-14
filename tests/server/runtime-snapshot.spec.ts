/**
 * R1-08 encrypted runtime-snapshot tests (issue #20 交付范围 5; AC 1 重启后
 * Session 策略可恢复; AC 2 备份恢复不丢已确认事件、不复活被删数据).
 *
 * All synthetic data. The round trip runs capture on one composed runtime and
 * restore into a FRESH runtime — the in-process equivalent of a restart with
 * the snapshot file.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";

import { parseActorContext, type ActorContext } from "../../lib/domain/contract/actor.ts";
import {
  CONTRACT_ID_PREFIXES,
  type ContractIdKind,
} from "../../lib/domain/contract/core.ts";
import type { InteractionAck } from "../../lib/domain/contract/idempotency.ts";
import { parseStreamEvent, type StreamEvent } from "../../lib/domain/contract/response.ts";
import { GUARDIAN_FAMILY_CHILD_REF } from "../../lib/domain/guardian/authorizations.ts";
import { ADMIN_DEMO_ACCESS_CODE, GUARDIAN_DEMO_ACCESS_CODE } from "../../lib/server/guardian-service.ts";
import { resolveWebMvpActor, WEB_MVP_CHILD_REF } from "../../lib/server/interaction-service.ts";
import { createWebMvpRuntime, restoreReplayMarkerPathFor } from "../../lib/server/web-mvp-runtime.ts";
import {
  RUNTIME_SNAPSHOT_FORMAT,
  captureRuntimeSnapshot,
  restoreRuntimeSnapshot,
  validateRuntimeSnapshot,
} from "../../lib/server/snapshot/runtime-snapshot.ts";
import {
  readSnapshotFileSync,
  snapshotFileExistsSync,
  writeSnapshotFileSync,
  SnapshotStoreError,
} from "../../lib/server/snapshot/snapshot-store.ts";
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

// ---------------------------------------------------------------------------
// Composition-level per-boot semantics (review round-1 P1-1 regression). The
// one-shot post-restore replay is requested with a SELF-CLEARING marker file
// (`<snapshot-dir>/restore-replay.pending`, touched by deploy/restore.sh) —
// never a persistent env flag — so a missed reset can never turn later
// restarts into a purge of newly created confirmed data (AC 2 red line).
// The marker is consumed by the replaying boot and ONLY after that boot's
// post-restore persist succeeded (review round-2 P1-1).
// ---------------------------------------------------------------------------

const BOOT_KEY = "3a".repeat(32);

/** Let the boot restore microtask chain (restore → replay → post-write) flush. */
async function settleBoot(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function guardianDataActor(): Readonly<ActorContext> {
  return parseActorContext({
    role: "guardian",
    actorId: "act_guardian_data_lifecycle",
    childRef: GUARDIAN_FAMILY_CHILD_REF,
    verifiedBy: "data-lifecycle-v1",
    verifiedAt: NOW,
  });
}

function setRecording(
  runtime: ReturnType<typeof createWebMvpRuntime>,
  enabled: boolean,
): void {
  const result = runtime.guardian.postAuthorizations({
    authorization: loginAs(runtime),
    body: { protocolVersion: "1.0", action: "set_feature_switch", switchId: "conversation_recording", enabled },
  });
  assert.equal(result.kind, "ok");
}

function replayCount(runtime: ReturnType<typeof createWebMvpRuntime>): number {
  return runtime.lifecycle
    .deletionRecords()
    .filter((record) => record.action === "replay_child_deletions").length;
}

test("the restore-replay marker fires ONCE: the replaying boot consumes it and later restarts keep new data (P1-1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lumithink-boot-"));
  try {
    const snapPath = join(dir, "state", "snapshot.bin");
    const markerPath = restoreReplayMarkerPathFor(snapPath);
    assert.ok(markerPath.endsWith("restore-replay.pending"));

    // Boot 1 — confirmed content exists in the runtime; the T0 archive lands
    // on disk (what deploy/restore.sh would place back).
    const boot1 = createWebMvpRuntime({ snapshot: { path: snapPath, keyHex: BOOT_KEY } });
    enableRecording(boot1);
    await runRecordedTurn(boot1);
    confirmSyntheticMemory(boot1, "[synthetic] P1-1 boot1 偏好");
    writeSnapshotFileSync(snapPath, JSON.stringify(capture(boot1)), BOOT_KEY);
    assert.equal(snapshotFileExistsSync(snapPath), true);

    // deploy/restore.sh simulation: archive placed (already done) + marker.
    writeFileSync(markerPath, "", { mode: 0o600 });

    // Boot 2 — the REPLAYING boot: restore + subject-wide replay ONCE +
    // consume the marker. The restored content is re-purged (ADR-0005).
    const boot2 = createWebMvpRuntime({ snapshot: { path: snapPath, keyHex: BOOT_KEY } });
    await settleBoot();
    assert.equal(existsSync(markerPath), false, "the replaying boot must consume the marker");
    const last = boot2.lifecycle.deletionRecords().at(-1);
    assert.equal(last?.action, "replay_child_deletions");
    // The replay actually purged RESTORED content (conversation + memory).
    assert.equal(last?.purged.conversations, 1);
    assert.equal(last?.purged.memories, 1);
    assert.equal(boot2.service.childDataSnapshot(WEB_MVP_ACTOR_ID).conversations.length, 0);
    assert.equal(replayCount(boot2), 1);

    // New confirmed data created AFTER the replaying boot (a real guardian
    // transition flushes it into the snapshot file).
    const survivingMemoryId = confirmSyntheticMemory(boot2, "[synthetic] P1-1 boot2 幸存偏好");
    setRecording(boot2, false);
    setRecording(boot2, true);

    // Boot 3 — a NORMAL restart (no marker): under the old persistent-flag
    // design this boot would have replayed again and purged the new data.
    const boot3 = createWebMvpRuntime({ snapshot: { path: snapPath, keyHex: BOOT_KEY } });
    await settleBoot();
    assert.equal(boot3.service.childDataSnapshot(WEB_MVP_ACTOR_ID).conversations.length, 0);
    const entries3 = boot3.memory.listEntries(WEB_MVP_CHILD_REF, guardianDataActor());
    assert.equal(
      entries3.some((entry) => entry.memoryId === survivingMemoryId),
      true,
      "data created after the replaying boot must survive the normal restart",
    );
    assert.equal(replayCount(boot3), 1, "no second replay on the normal restart");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale restore-replay marker without a snapshot file is consumed and never fires a replay (P1-1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lumithink-stale-"));
  try {
    const snapPath = join(dir, "state", "snapshot.bin");
    const markerPath = restoreReplayMarkerPathFor(snapPath);
    // Marker without a snapshot file: that restore never completed.
    mkdirSync(dirname(snapPath), { recursive: true });
    writeFileSync(markerPath, "", { mode: 0o600 });

    const boot1 = createWebMvpRuntime({ snapshot: { path: snapPath, keyHex: BOOT_KEY } });
    await settleBoot();
    // The stale marker is consumed IMMEDIATELY (a replay without a restore
    // is meaningless and must never fire against unrelated future content).
    assert.equal(existsSync(markerPath), false);
    assert.equal(replayCount(boot1), 0);

    confirmSyntheticMemory(boot1, "[synthetic] P1-1 stale-marker 偏好");
    writeSnapshotFileSync(snapPath, JSON.stringify(capture(boot1)), BOOT_KEY);

    const boot2 = createWebMvpRuntime({ snapshot: { path: snapPath, keyHex: BOOT_KEY } });
    await settleBoot();
    const entries2 = boot2.memory.listEntries(WEB_MVP_CHILD_REF, guardianDataActor());
    assert.equal(entries2.length, 1);
    assert.ok(boot2.lifecycle.deletionRecords().every((record) => record.action !== "replay_child_deletions"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed boot-restore persist keeps the marker pending and the next boot retries restore + replay (P1-1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lumithink-persistfail-"));
  try {
    const snapPath = join(dir, "state", "snapshot.bin");
    const markerPath = restoreReplayMarkerPathFor(snapPath);

    // Boot 1 — confirmed content exists; the T0 archive lands on disk.
    const boot1 = createWebMvpRuntime({ snapshot: { path: snapPath, keyHex: BOOT_KEY } });
    enableRecording(boot1);
    await runRecordedTurn(boot1);
    const memoryId = confirmSyntheticMemory(boot1, "[synthetic] P1-1 persist-fail boot1 偏好");
    writeSnapshotFileSync(snapPath, JSON.stringify(capture(boot1)), BOOT_KEY);
    const archivePlaintext = readSnapshotFileSync(snapPath, BOOT_KEY);

    // deploy/restore.sh simulation: archive placed (already done) + marker.
    writeFileSync(markerPath, "", { mode: 0o600 });

    // Force the boot-restore PERSIST leg to fail while leaving the on-box
    // archive intact (the exact on-disk state of a failed atomic write): a
    // DIRECTORY at the atomic write's temp path makes the pre-write
    // cleanup's unlinkSync fail on EVERY platform (EPERM on Windows, EISDIR
    // on Linux), so the write never starts and the file stays untouched —
    // the disk/permission failure shape of a post-incident restore drill.
    mkdirSync(`${snapPath}.tmp`);

    // Boot 2 — the replaying boot whose post-restore persist FAILS.
    const boot2 = createWebMvpRuntime({ snapshot: { path: snapPath, keyHex: BOOT_KEY } });
    await settleBoot();
    // Restore + replay DID run (ADR-0005: the restored old-archive content
    // is re-purged in memory) — but the marker MUST NOT be consumed: the
    // on-box file is still the pre-replay archive, and consuming the marker
    // here would let the NEXT boot restore that archive WITHOUT the replay
    // (deleted child data resurrected — AC 2 red line).
    assert.equal(existsSync(markerPath), true, "a failed boot-restore persist must leave the marker pending");
    assert.equal(replayCount(boot2), 1);
    assert.equal(boot2.service.childDataSnapshot(WEB_MVP_ACTOR_ID).conversations.length, 0);
    // The on-box archive is untouched (the atomic write failed before its
    // publish rename) — exactly what the next boot must re-restore WITH the
    // pending marker.
    assert.equal(readSnapshotFileSync(snapPath, BOOT_KEY), archivePlaintext);

    // The write failure was transient (operator fixed the disk): reboot.
    // The pending marker must make boot 3 re-run the WHOLE restore + replay.
    rmSync(`${snapPath}.tmp`, { recursive: true, force: true });
    const boot3 = createWebMvpRuntime({ snapshot: { path: snapPath, keyHex: BOOT_KEY } });
    await settleBoot();
    assert.equal(existsSync(markerPath), false, "the retrying boot consumes the marker after a successful persist");
    // The retried restore re-purged the old-archive content (a boot WITHOUT
    // the pending marker would have resurrected conversation + memory).
    assert.equal(boot3.service.childDataSnapshot(WEB_MVP_ACTOR_ID).conversations.length, 0);
    assert.equal(
      boot3.memory.listEntries(WEB_MVP_CHILD_REF, guardianDataActor()).some((entry) => entry.memoryId === memoryId),
      false,
      "the retried replay must re-purge the old archive's memory",
    );
    const last3 = boot3.lifecycle.deletionRecords().at(-1);
    assert.equal(last3?.action, "replay_child_deletions");
    assert.equal(replayCount(boot3), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a decryptable but envelope-invalid snapshot file refuses the composition (P2-1)", () => {
  const dir = mkdtempSync(join(tmpdir(), "lumithink-envelope-"));
  try {
    const snapPath = join(dir, "state", "snapshot.bin");
    mkdirSync(dirname(snapPath), { recursive: true });
    // Decryptable (right key) + valid JSON, but the envelope is invalid:
    // exactly the class the sync decrypt/JSON legs do not cover.
    const bad = JSON.parse(JSON.stringify(capture(createWebMvpRuntime()))) as Record<string, unknown>;
    bad.source = "hacked";
    writeSnapshotFileSync(snapPath, JSON.stringify(bad), BOOT_KEY);

    assert.throws(
      () => createWebMvpRuntime({ snapshot: { path: snapPath, keyHex: BOOT_KEY } }),
      (error: unknown) =>
        error instanceof SnapshotStoreError &&
        error.reason === "bad_snapshot" &&
        error.message.includes("snapshot.source"),
      "an envelope-invalid snapshot file must refuse the composition (fail-closed boot refusal)",
    );
    // The refusing boot leaves the file in place for operator inspection.
    assert.equal(snapshotFileExistsSync(snapPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file-level round trip: erase rewrites the CURRENT file and restoring it keeps content empty with the tombstone (AC 2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lumithink-erase-"));
  try {
    const snapPath = join(dir, "state", "snapshot.bin");
    const boot1 = createWebMvpRuntime({ snapshot: { path: snapPath, keyHex: BOOT_KEY } });
    enableRecording(boot1);
    await runRecordedTurn(boot1);
    writeSnapshotFileSync(snapPath, JSON.stringify(capture(boot1)), BOOT_KEY);

    // The erase is a confirmed mutation: its hook rewrites the file.
    const erase = await boot1.guardian.eraseChildData({
      authorization: loginAs(boot1),
      body: { protocolVersion: "1.0", action: "erase_child_data" },
    });
    assert.equal(erase.kind, "ok");

    // The CURRENT file now: purged content + the erase tombstone, encrypted.
    const parsed = JSON.parse(readSnapshotFileSync(snapPath, BOOT_KEY)) as {
      counts: { conversations: number; memories: number };
      tombstones: { action: string }[];
    };
    assert.equal(parsed.counts.conversations, 0);
    assert.equal(parsed.counts.memories, 0);
    assert.ok(parsed.tombstones.some((tombstone) => tombstone.action === "erase_child_data"));

    // Restoring the CURRENT file into a fresh composition: content stays
    // empty, the tombstone persists, the restore is disclosed in the audit.
    const boot2 = createWebMvpRuntime({ snapshot: { path: snapPath, keyHex: BOOT_KEY } });
    await settleBoot();
    assert.equal(boot2.service.childDataSnapshot(WEB_MVP_ACTOR_ID).conversations.length, 0);
    assert.ok(
      boot2.lifecycle.deletionRecords().some((record) => record.action === "erase_child_data"),
    );
    assert.ok(boot2.guardian.auditEntries().some((entry) => entry.kind === "snapshot_restored"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the snapshot JSON never carries raw access codes or the snapshot key (digest-only pin)", async () => {
  // Composition takes DIGESTS only: even in real-credential mode the raw
  // values are structurally absent from the runtime — and therefore from
  // the snapshot.
  const source = createWebMvpRuntime({
    credentialDigests: {
      guardian: createHash("sha256").update(GUARDIAN_DEMO_ACCESS_CODE, "utf8").digest("hex"),
      admin: createHash("sha256").update(ADMIN_DEMO_ACCESS_CODE, "utf8").digest("hex"),
    },
  });
  enableRecording(source);
  await runRecordedTurn(source);
  confirmSyntheticMemory(source, "[synthetic] secrets-pin 偏好");
  const json = JSON.stringify(capture(source));
  assert.equal(json.includes(GUARDIAN_DEMO_ACCESS_CODE), false, "guardian access code must not appear in the snapshot");
  assert.equal(json.includes(ADMIN_DEMO_ACCESS_CODE), false, "admin access code must not appear in the snapshot");
  assert.equal(json.includes(BOOT_KEY), false, "the snapshot key must not appear in the snapshot");
});
