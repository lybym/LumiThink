import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryService } from "../../../lib/domain/memory/service.ts";
import { MEMORY_SCHEMA_VERSION } from "../../../lib/domain/memory/schema.ts";

/**
 * Issue #26 AC 1 — the synthetic lifecycle case, end to end at the domain
 * level (all data synthetic):
 *
 *   喜欢某类故事 → 确认 → 新 Session 正确引用 → 儿童否认 →
 *   再问不重复旧偏好 → 删除 → 检索为 0
 *
 * "新 Session" is modeled exactly as the architecture defines it: memory
 * retrieval is keyed by SUBJECT, never by session — each step below uses a
 * FRESH retrieval from a fresh "session" against the same subject-bound
 * store. The pipeline-level cross-session wiring (refs entering a new
 * session's context) is asserted in tests/domain/runtime/memory-context.spec.ts.
 */

const CHILD_REF = "chd_demo_001";

function makeService() {
  let nowMs = Date.parse("2026-06-01T08:00:00Z");
  let counter = 0;
  return {
    service: createMemoryService({
      nowFactory: () => new Date(nowMs).toISOString(),
      idFactory: () => {
        counter += 1;
        return `mem_lifecycle${String(counter).padStart(5, "0")}`;
      },
    }),
    tick: () => {
      nowMs += 1000;
    },
  };
}

const childActor = () => ({
  role: "child",
  actorId: "act_child_lc01",
  childRef: CHILD_REF,
  verifiedBy: "lifecycle-verifier",
  verifiedAt: "2026-06-01T08:00:00Z",
});

const refsOf = (service: ReturnType<typeof createMemoryService>) => {
  // A fresh retrieval call models a fresh session asking "what does the
  // child currently like?"; the store is subject-bound, not session-bound.
  const result = service.retrieveForContext({ subjectRef: CHILD_REF }, childActor());
  assert.equal(result.ok, true);
  return result.ok ? result.refs : [];
};

const claimsOf = (service: ReturnType<typeof createMemoryService>) =>
  service
    .listEntries(CHILD_REF, {
      role: "guardian",
      actorId: "act_guardianlc1",
      childRef: CHILD_REF,
      verifiedBy: "lifecycle-verifier",
      verifiedAt: "2026-06-01T08:00:00Z",
    })
    .filter((entry) => entry.status === "candidate" || entry.status === "confirmed")
    .map((entry) => entry.claim);

test("AC1 lifecycle: confirm → new session references → deny → old preference stops repeating → delete → retrieval 0", () => {
  const { service, tick } = makeService();

  // 1. 喜欢某类故事 → the child states a preference; intake creates a candidate.
  const proposed = service.proposeCandidate(
    {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      subjectRef: CHILD_REF,
      type: "confirmed_preference",
      claim: "喜欢太空主题的故事",
      source: "child_statement",
      observedAt: "2026-06-01T08:00:00Z",
      expiresAt: null,
      reviewAt: null,
      sensitivity: "normal",
    },
    childActor(),
  );
  assert.equal(proposed.ok, true);
  if (!proposed.ok) return;
  const memoryId = proposed.entry.memoryId;

  // 2. 确认 — the explicit confirmation moment (the product asked, the child said yes).
  tick();
  const confirmed = service.confirmCandidate({ memoryId }, childActor());
  assert.equal(confirmed.ok, true);

  // 3. 新 Session 正确引用 — a brand-new session retrieves exactly this fact.
  tick();
  const newSessionRefs = refsOf(service);
  assert.deepEqual(
    newSessionRefs.map((ref) => ref.refId),
    [memoryId],
  );

  // 4. 儿童否认 — the child corrects: the old preference is superseded.
  tick();
  const corrected = service.correctMemory({ memoryId, claim: "我现在不喜欢太空主题的故事了" }, childActor());
  assert.equal(corrected.ok, true);
  if (!corrected.ok) return;

  // 5. 再问不重复旧偏好 — fresh sessions surface ONLY the corrected claim;
  //    the superseded one is never replayed or re-injected.
  tick();
  const afterDenialRefs = refsOf(service);
  assert.deepEqual(
    afterDenialRefs.map((ref) => ref.refId),
    [corrected.entry.memoryId],
  );
  assert.equal(afterDenialRefs.some((ref) => ref.refId === memoryId), false);
  // Active claims carry only the corrected fact; the superseded entry stays
  // in the audit view marked superseded (never re-injected into context).
  assert.ok(!claimsOf(service).includes("喜欢太空主题的故事"));
  assert.ok(claimsOf(service).includes("我现在不喜欢太空主题的故事了"));

  // 6. 删除 → 检索为 0 — hard removal of the whole lineage.
  tick();
  const deleted = service.deleteMemory({ memoryId: corrected.entry.memoryId }, childActor());
  assert.equal(deleted.ok, true);
  if (deleted.ok) {
    assert.ok(deleted.purgedIds.includes(memoryId));
    assert.ok(deleted.purgedIds.includes(corrected.entry.memoryId));
  }
  assert.deepEqual(refsOf(service), []);
  assert.deepEqual(claimsOf(service), []);

  // The audit ring retains only structural facts of what happened.
  const actions = service.auditSnapshot().map((entry) => entry.action);
  assert.deepEqual(actions, [
    "memory.propose",
    "memory.confirm",
    "memory.correct",
    "memory.delete",
  ]);
});

test("AC1 guard rails on the way: psychological-label and duplicate attempts never disturb the loop", () => {
  const { service } = makeService();
  // Injection-style attempt: the agent proposes to auto-record a label.
  const labelAttempt = service.proposeCandidate(
    {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      subjectRef: CHILD_REF,
      type: "psychological_label",
      claim: "该儿童表现出多动症特征，建议记录",
      source: "agent_proposal",
      observedAt: "2026-06-01T08:00:00Z",
      expiresAt: null,
      reviewAt: null,
      sensitivity: "normal",
    },
    {
      role: "system",
      actorId: "act_agentpath01",
      childRef: null,
      verifiedBy: "lifecycle-verifier",
      verifiedAt: "2026-06-01T08:00:00Z",
    },
  );
  assert.equal(labelAttempt.ok, false);
  if (!labelAttempt.ok) {
    assert.ok(
      labelAttempt.code === "memory.type_not_allowed" || labelAttempt.code === "memory.label_screen_block",
    );
  }
  // The store stayed empty — the attempt left no candidate behind.
  assert.deepEqual(refsOf(service), []);
});
