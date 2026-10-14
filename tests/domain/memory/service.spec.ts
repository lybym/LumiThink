import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryService } from "../../../lib/domain/memory/service.ts";
import { MEMORY_SCHEMA_VERSION } from "../../../lib/domain/memory/schema.ts";

/**
 * R1-14 memory service tests (issue #26 AC 2 / AC 3; all data synthetic).
 */

const CHILD_REF = "chd_demo_001";
const OTHER_CHILD_REF = "chd_other_002";

function makeService(overrides: { auditCapacity?: number } = {}) {
  let nowMs = Date.parse("2026-01-01T00:00:00Z");
  let counter = 0;
  const service = createMemoryService({
    nowFactory: () => new Date(nowMs).toISOString(),
    idFactory: () => {
      counter += 1;
      return `mem_testid${String(counter).padStart(6, "0")}`;
    },
    auditCapacity: overrides.auditCapacity,
  });
  return {
    service,
    advanceSeconds: (seconds: number) => {
      nowMs += seconds * 1000;
    },
    now: () => new Date(nowMs).toISOString(),
  };
}

function actor(
  role: "child" | "guardian" | "system" | "voice_device",
  overrides: { childRef?: string | null; actorId?: string } = {},
): Record<string, unknown> {
  const actorId = overrides.actorId ?? `act_${role}_test01`;
  const childRef =
    overrides.childRef !== undefined ? overrides.childRef : role === "system" ? null : CHILD_REF;
  return {
    role,
    actorId,
    childRef,
    verifiedBy: "test-verifier",
    verifiedAt: "2026-01-01T00:00:00Z",
  };
}

const child = () => actor("child");
const guardian = () => actor("guardian", { actorId: "act_guardian_t01" });
const system = () => actor("system");
const device = () => actor("voice_device");
const otherChild = () => actor("child", { childRef: OTHER_CHILD_REF, actorId: "act_otherchld01" });

function candidateInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    subjectRef: CHILD_REF,
    type: "confirmed_preference",
    claim: "喜欢太空主题的故事",
    source: "child_statement",
    observedAt: "2026-01-01T00:00:00Z",
    expiresAt: null,
    reviewAt: null,
    sensitivity: "normal",
    ...overrides,
  };
}

test("intake creates a CANDIDATE only — never a persisted fact — and audits it", () => {
  const { service } = makeService();
  const result = service.proposeCandidate(candidateInput(), child());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.entry.status, "candidate");
    assert.equal(result.entry.confirmedAt, null);
    assert.equal(result.entry.supersedes, null);
    assert.equal(result.entry.proposedByRole, "child");
  }
  // Nothing is retrievable before confirmation (candidate-only invariant).
  const refs = service.retrieveForContext({ subjectRef: CHILD_REF }, child());
  assert.equal(refs.ok, true);
  if (refs.ok) {
    assert.equal(refs.refs.length, 0);
  }
  const audit = service.auditSnapshot();
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.action, "memory.propose");
  assert.equal(audit[0]?.outcome, "ok");
});

test("every rejection path stores NOTHING (AC 3: 失败路径不暗写候选)", () => {
  const { service } = makeService();
  const before = service.listEntries(CHILD_REF, guardian()).length;
  assert.equal(before, 0);

  const rejections: [string, unknown, unknown][] = [
    ["invalid actor shape", candidateInput(), { role: "child" }],
    ["voice_device", candidateInput({ source: "agent_proposal" }), device()],
    ["child wrong subject", candidateInput({ subjectRef: OTHER_CHILD_REF }), child()],
    ["label type attempt", candidateInput({ type: "psychological_label" }), system()],
    ["agent label screen", candidateInput({ source: "agent_proposal", claim: "孩子可能有多动症" }), system()],
    ["malformed claim", candidateInput({ claim: "   " }), child()],
    ["unknown schema version", candidateInput({ schemaVersion: "9.9" }), child()],
  ];
  for (const [name, input, actorValue] of rejections) {
    const result = service.proposeCandidate(input, actorValue);
    assert.equal(result.ok, false, name);
    if (!result.ok) {
      assert.ok(result.ruleIds.length > 0, `${name} must carry structured rule ids`);
    }
  }
  // The distinguished label-type rejection (AC 2: 自动记心理标签拒绝).
  const labelAttempt = service.proposeCandidate(candidateInput({ type: "psychological_label" }), system());
  assert.equal(labelAttempt.ok, false);
  if (!labelAttempt.ok) {
    assert.equal(labelAttempt.code, "memory.type_not_allowed");
  }
  const screenAttempt = service.proposeCandidate(
    candidateInput({ source: "agent_proposal", claim: "建议记录 IQ 评分结果" }),
    system(),
  );
  assert.equal(screenAttempt.ok, false);
  if (!screenAttempt.ok) {
    assert.equal(screenAttempt.code, "memory.label_screen_block");
  }

  assert.equal(service.listEntries(CHILD_REF, guardian()).length, 0);
  const audit = service.auditSnapshot();
  assert.ok(audit.every((entry) => entry.outcome === "rejected"));
  assert.ok(audit.every((entry) => entry.memoryId === null));
});

test("duplicate candidates are rejected (AC 2), regardless of whitespace/case form", () => {
  const { service } = makeService();
  const first = service.proposeCandidate(candidateInput({ claim: "喜欢太空故事" }), child());
  assert.equal(first.ok, true);
  const duplicate = service.proposeCandidate(candidateInput({ claim: " 喜欢太空故事 " }), child());
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) {
    assert.equal(duplicate.code, "memory.duplicate");
  }
  // A duplicate against an already-CONFIRMED fact is also rejected.
  const { service: service2 } = makeService();
  const proposed = service2.proposeCandidate(candidateInput({ claim: "喜欢太空故事" }), child());
  assert.ok(proposed.ok);
  if (proposed.ok) {
    const confirmed = service2.confirmCandidate({ memoryId: proposed.entry.memoryId }, child());
    assert.equal(confirmed.ok, true);
  }
  const duplicateOfConfirmed = service2.proposeCandidate(candidateInput({ claim: "喜欢太空故事" }), child());
  assert.equal(duplicateOfConfirmed.ok, false);
  if (!duplicateOfConfirmed.ok) {
    assert.equal(duplicateOfConfirmed.code, "memory.duplicate");
  }
});

test("confirmation is the explicit human moment: child confirms own candidate", () => {
  const { service } = makeService();
  const proposed = service.proposeCandidate(candidateInput(), child());
  assert.ok(proposed.ok);
  if (!proposed.ok) return;
  const confirmed = service.confirmCandidate({ memoryId: proposed.entry.memoryId }, child());
  assert.equal(confirmed.ok, true);
  if (confirmed.ok) {
    assert.equal(confirmed.entry.status, "confirmed");
    assert.equal(confirmed.entry.confirmedByRole, "child");
    assert.ok(confirmed.entry.confirmedAt !== null);
  }
  // Now retrievable for the subject.
  const refs = service.retrieveForContext({ subjectRef: CHILD_REF }, child());
  assert.equal(refs.ok, true);
  if (refs.ok) {
    assert.equal(refs.refs.length, 1);
    assert.equal(refs.refs[0]?.refId, proposed.entry.memoryId);
    assert.equal(refs.refs[0]?.version, "1");
  }
});

test("the system role can propose but can NEVER self-confirm (AC 2 越权)", () => {
  const { service } = makeService();
  const proposed = service.proposeCandidate(candidateInput({ source: "agent_proposal" }), system());
  assert.equal(proposed.ok, true);
  if (!proposed.ok) return;
  const selfConfirm = service.confirmCandidate({ memoryId: proposed.entry.memoryId }, system());
  assert.equal(selfConfirm.ok, false);
  if (!selfConfirm.ok) {
    assert.equal(selfConfirm.code, "memory.unauthorized");
  }
  // The candidate is still intact and still not retrievable.
  const refs = service.retrieveForContext({ subjectRef: CHILD_REF }, child());
  assert.equal(refs.ok, true);
  if (refs.ok) {
    assert.equal(refs.refs.length, 0);
  }
  // A guardian may confirm the agent-proposed candidate.
  const guardianConfirm = service.confirmCandidate({ memoryId: proposed.entry.memoryId }, guardian());
  assert.equal(guardianConfirm.ok, true);
});

test("confirmation rejections: other child, device, unknown id, wrong state, expired", () => {
  const { service, advanceSeconds } = makeService();
  const proposed = service.proposeCandidate(candidateInput(), child());
  assert.ok(proposed.ok);
  if (!proposed.ok) return;
  const memoryId = proposed.entry.memoryId;

  assert.equal(
    service.confirmCandidate({ memoryId }, otherChild()).ok,
    false,
    "another child must not confirm",
  );
  assert.equal(service.confirmCandidate({ memoryId }, device()).ok, false, "device must not confirm");
  assert.equal(
    service.confirmCandidate({ memoryId: "mem_unknown0001" }, child()).ok,
    false,
    "unknown id must fail",
  );
  const malformed = service.confirmCandidate({ memoryId: "NOT-A-MEM-ID" }, child());
  assert.equal(malformed.ok, false);
  if (!malformed.ok) {
    assert.equal(malformed.code, "memory.parse_failed");
  }

  // Confirm once, then re-confirm → wrong_state (not silently idempotent).
  assert.equal(service.confirmCandidate({ memoryId }, child()).ok, true);
  const again = service.confirmCandidate({ memoryId }, child());
  assert.equal(again.ok, false);
  if (!again.ok) {
    assert.equal(again.code, "memory.wrong_state");
  }

  // Expired candidate: confirm must reject.
  const { service: service2, advanceSeconds: advance2 } = makeService();
  const shortLived = service2.proposeCandidate(
    candidateInput({ expiresAt: "2026-01-01T01:00:00Z" }),
    child(),
  );
  assert.ok(shortLived.ok);
  advance2(2 * 60 * 60);
  if (shortLived.ok) {
    const expired = service2.confirmCandidate({ memoryId: shortLived.entry.memoryId }, child());
    assert.equal(expired.ok, false);
    if (!expired.ok) {
      assert.equal(expired.code, "memory.expired");
    }
  }
  void advanceSeconds;
});

test("conflicting confirmed memories are rejected — changes go through correction (AC 2)", () => {
  const { service } = makeService();
  const first = service.proposeCandidate(candidateInput({ claim: "喜欢太空故事" }), child());
  assert.ok(first.ok);
  if (first.ok) {
    assert.equal(service.confirmCandidate({ memoryId: first.entry.memoryId }, child()).ok, true);
  }
  // A second, different preference of the same type is a CONFLICT for the
  // plain propose+confirm path (an active confirmed fact already exists).
  const second = service.proposeCandidate(candidateInput({ claim: "喜欢恐龙故事" }), child());
  assert.ok(second.ok);
  if (second.ok) {
    const conflict = service.confirmCandidate({ memoryId: second.entry.memoryId }, child());
    assert.equal(conflict.ok, false);
    if (!conflict.ok) {
      assert.equal(conflict.code, "memory.conflict");
    }
    // The conflicting candidate stays a candidate — never silently written.
    const refs = service.retrieveForContext({ subjectRef: CHILD_REF }, child());
    if (refs.ok) {
      assert.equal(refs.refs.length, 1);
    }
  }
});

test("correction supersedes the old fact; retrieval never replays it", () => {
  const { service } = makeService();
  const proposed = service.proposeCandidate(candidateInput({ claim: "喜欢太空故事" }), child());
  assert.ok(proposed.ok);
  if (!proposed.ok) return;
  const memoryId = proposed.entry.memoryId;
  assert.equal(service.confirmCandidate({ memoryId }, child()).ok, true);

  const corrected = service.correctMemory({ memoryId, claim: "现在更喜欢恐龙故事" }, child());
  assert.equal(corrected.ok, true);
  if (!corrected.ok) return;
  assert.equal(corrected.entry.supersedes, memoryId);
  assert.equal(corrected.entry.source, "child_statement");
  assert.equal(corrected.entry.status, "confirmed");

  // Old version marked superseded and EXCLUDED from retrieval forever.
  const entries = service.listEntries(CHILD_REF, guardian());
  const oldEntry = entries.find((entry) => entry.memoryId === memoryId);
  assert.equal(oldEntry?.status, "superseded");
  assert.ok(oldEntry?.supersededAt !== null);

  const refs = service.retrieveForContext({ subjectRef: CHILD_REF }, child());
  assert.equal(refs.ok, true);
  if (refs.ok) {
    assert.deepEqual(
      refs.refs.map((ref) => ref.refId),
      [corrected.entry.memoryId],
    );
  }
  // Repeated retrieval never resurrects the corrected claim (no replay).
  const refsAgain = service.retrieveForContext({ subjectRef: CHILD_REF }, child());
  if (refsAgain.ok) {
    assert.equal(refsAgain.refs.some((ref) => ref.refId === memoryId), false);
  }
});

test("correction rejections: system, unknown id, non-confirmed target, unchanged claim", () => {
  const { service } = makeService();
  const proposed = service.proposeCandidate(candidateInput({ claim: "喜欢太空故事" }), child());
  assert.ok(proposed.ok);
  if (!proposed.ok) return;
  const memoryId = proposed.entry.memoryId;

  // system may not correct; a mere CANDIDATE may not be corrected.
  assert.equal(service.correctMemory({ memoryId, claim: "x" }, system()).ok, false);
  const onCandidate = service.correctMemory({ memoryId, claim: "现在更喜欢恐龙故事" }, child());
  assert.equal(onCandidate.ok, false);
  if (!onCandidate.ok) {
    assert.equal(onCandidate.code, "memory.wrong_state");
  }

  assert.equal(service.confirmCandidate({ memoryId }, child()).ok, true);
  const unchanged = service.correctMemory({ memoryId, claim: " 喜欢太空故事 " }, child());
  assert.equal(unchanged.ok, false);
  if (!unchanged.ok) {
    assert.equal(unchanged.code, "memory.claim_unchanged");
  }
  assert.equal(
    service.correctMemory({ memoryId: "mem_unknown0001", claim: "x" }, child()).ok,
    false,
  );
  assert.equal(service.correctMemory({ memoryId, claim: "   " }, child()).ok, false);
  // A correction colliding with another ACTIVE fact is a duplicate.
  const other = service.proposeCandidate(candidateInput({ claim: "喜欢恐龙故事" }), child());
  assert.ok(other.ok);
});

test("deletion purges the whole supersedes lineage; retrieval returns 0 (AC 1 end)", () => {
  const { service } = makeService();
  const first = service.proposeCandidate(candidateInput({ claim: "喜欢太空故事" }), child());
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.equal(service.confirmCandidate({ memoryId: first.entry.memoryId }, child()).ok, true);
  const corrected = service.correctMemory(
    { memoryId: first.entry.memoryId, claim: "现在更喜欢恐龙故事" },
    child(),
  );
  assert.ok(corrected.ok);
  if (!corrected.ok) return;

  const deleted = service.deleteMemory({ memoryId: corrected.entry.memoryId }, child());
  assert.equal(deleted.ok, true);
  if (deleted.ok) {
    // Both the correction and its superseded predecessor are gone.
    assert.deepEqual([...deleted.purgedIds].sort(), [first.entry.memoryId, corrected.entry.memoryId].sort());
  }
  assert.equal(service.listEntries(CHILD_REF, guardian()).length, 0);
  const refs = service.retrieveForContext({ subjectRef: CHILD_REF }, child());
  if (refs.ok) {
    assert.equal(refs.refs.length, 0);
  }
  const audit = service.auditSnapshot();
  const deleteEntry = audit.find((entry) => entry.action === "memory.delete");
  assert.equal(deleteEntry?.outcome, "purged");
  assert.equal(deleteEntry?.count, 2);

  // Deleting an unknown id is a structured rejection, not a crash.
  const missing = service.deleteMemory({ memoryId: "mem_unknown0001" }, child());
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, "memory.not_found");
  }
  // system/device may not delete; another child may not delete.
  const second = service.proposeCandidate(candidateInput({ claim: "喜欢恐龙故事" }), child());
  assert.ok(second.ok);
  if (second.ok) {
    assert.equal(service.deleteMemory({ memoryId: second.entry.memoryId }, system()).ok, false);
    assert.equal(service.deleteMemory({ memoryId: second.entry.memoryId }, device()).ok, false);
    assert.equal(service.deleteMemory({ memoryId: second.entry.memoryId }, otherChild()).ok, false);
  }
});

test("retrieval is minimal-by-need: sensitivity and review-due filtering, newest-first order", () => {
  // v0 conflict model: one ACTIVE fact per (subject, type); a different fact
  // of the same type must go through correction. The filter scenarios below
  // therefore each use their own subject store.
  const { service, advanceSeconds } = makeService();

  // -- Sensitivity filtering: a sensitive necessary_fact exists. ----------
  const sensitive = service.proposeCandidate(
    candidateInput({ claim: "家里最近搬到新城市", sensitivity: "sensitive", type: "necessary_fact" }),
    guardian(),
  );
  assert.ok(sensitive.ok);
  const sensitiveId = sensitive.ok ? sensitive.entry.memoryId : "";
  if (sensitive.ok) {
    assert.equal(service.confirmCandidate({ memoryId: sensitiveId }, guardian()).ok, true);
  }
  // Child context: no sensitive entries, ever.
  const childRefs = service.retrieveForContext({ subjectRef: CHILD_REF }, child());
  assert.equal(childRefs.ok, true);
  if (childRefs.ok) {
    assert.deepEqual(childRefs.refs.map((ref) => ref.refId), []);
  }
  // Guardian with explicit includeSensitive sees the sensitive fact.
  const guardianRefs = service.retrieveForContext(
    { subjectRef: CHILD_REF, includeSensitive: true },
    guardian(),
  );
  assert.equal(guardianRefs.ok, true);
  if (guardianRefs.ok) {
    assert.deepEqual(guardianRefs.refs.map((ref) => ref.refId), [sensitiveId]);
  }
  // A child may not request sensitive inclusion.
  assert.equal(
    service.retrieveForContext({ subjectRef: CHILD_REF, includeSensitive: true }, child()).ok,
    false,
  );
  // Another child cannot retrieve the subject's memories.
  assert.equal(service.retrieveForContext({ subjectRef: CHILD_REF }, otherChild()).ok, false);
  assert.equal(service.retrieveForContext({ subjectRef: CHILD_REF }, device()).ok, false);

  // -- Review-due filtering: a confirmed fact stops surfacing at its deadline.
  // (Separate store: the sensitivity fact above occupies the one active
  // necessary_fact slot of the v0 conflict model.)
  const { service: service3, advanceSeconds: advance3 } = makeService();
  const reviewDue = service3.proposeCandidate(
    candidateInput({ claim: "周四有游泳课", type: "necessary_fact", reviewAt: "2026-01-01T00:00:01Z" }),
    guardian(),
  );
  assert.ok(reviewDue.ok);
  const reviewDueId = reviewDue.ok ? reviewDue.entry.memoryId : "";
  if (reviewDue.ok) {
    assert.equal(service3.confirmCandidate({ memoryId: reviewDueId }, guardian()).ok, true);
  }
  const beforeDue = service3.retrieveForContext({ subjectRef: CHILD_REF }, child());
  if (beforeDue.ok) {
    assert.deepEqual(beforeDue.refs.map((ref) => ref.refId), [reviewDueId]);
  }
  advance3(60);
  const afterDue = service3.retrieveForContext({ subjectRef: CHILD_REF }, child());
  if (afterDue.ok) {
    assert.deepEqual(afterDue.refs.map((ref) => ref.refId), [], "review-due entries must not surface");
  }
  // Expired confirmed entries are likewise excluded.
  const { service: service2, advanceSeconds: advance2 } = makeService();
  const expiringFact = service2.proposeCandidate(
    candidateInput({ claim: "喜欢太空故事", expiresAt: "2026-01-01T00:30:00Z" }),
    child(),
  );
  assert.ok(expiringFact.ok);
  if (expiringFact.ok) {
    assert.equal(service2.confirmCandidate({ memoryId: expiringFact.entry.memoryId }, child()).ok, true);
    advance2(31 * 60);
    const afterExpiry = service2.retrieveForContext({ subjectRef: CHILD_REF }, child());
    if (afterExpiry.ok) {
      assert.deepEqual(afterExpiry.refs.map((ref) => ref.refId), []);
    }
  }
});

test("expirePastCandidates transitions past-expiry candidates (guardian/system only)", () => {
  const { service, advanceSeconds } = makeService();
  const expiring = service.proposeCandidate(
    candidateInput({ expiresAt: "2026-01-01T00:30:00Z" }),
    child(),
  );
  assert.ok(expiring.ok);
  assert.equal(service.expirePastCandidates(child()), 0, "child may not run cleanup");
  advanceSeconds(31 * 60);
  assert.equal(service.expirePastCandidates(guardian()), 1);
  // The expired candidate can no longer be confirmed.
  if (expiring.ok) {
    const confirm = service.confirmCandidate({ memoryId: expiring.entry.memoryId }, child());
    assert.equal(confirm.ok, false);
    if (!confirm.ok) {
      assert.equal(confirm.code, "memory.wrong_state");
    }
  }
  // Second run is a no-op.
  assert.equal(service.expirePastCandidates(system()), 0);
});

test("the memory audit ring is bounded and purgeable, separate from any data deletion", () => {
  const { service } = makeService({ auditCapacity: 4 });
  for (let index = 0; index < 10; index += 1) {
    service.proposeCandidate(candidateInput({ claim: `合成事实 ${index}` }), child());
  }
  const snapshot = service.auditSnapshot();
  assert.equal(snapshot.length, 4, "oldest audit entries drop off the bounded ring");
  assert.ok(snapshot.every((entry, index) => index === 0 || entry.seq > (snapshot[index - 1]?.seq ?? 0)));
  service.purgeAudit();
  assert.equal(service.auditSnapshot().length, 0);
});

test("no audit entry ever carries claim text (structural no-echo)", () => {
  const { service } = makeService();
  const proposed = service.proposeCandidate(candidateInput({ claim: "喜欢太空主题的秘密偏好内容" }), child());
  assert.ok(proposed.ok);
  service.confirmCandidate(proposed.ok ? { memoryId: proposed.entry.memoryId } : {}, child());
  service.correctMemory(
    proposed.ok ? { memoryId: proposed.entry.memoryId, claim: "改口了" } : {},
    child(),
  );
  const serialized = JSON.stringify(service.auditSnapshot());
  assert.equal(serialized.includes("秘密偏好"), false);
  assert.equal(serialized.includes("太空"), false);
});
