import assert from "node:assert/strict";
import test from "node:test";

import {
  MEMORY_SCHEMA_VERSION,
  MEMORY_TYPES,
  MEMORY_SOURCES,
  MEMORY_STATUSES,
  MEMORY_SENSITIVITIES,
  MEMORY_LABEL_SCREEN_TERMS,
  MEMORY_MAX_CLAIM_CODE_POINTS,
  claimCarriesPsychologicalLabel,
  memoryFactKey,
  normalizeClaim,
  parseMemoryCandidateInput,
  admitMemoryEntry,
} from "../../../lib/domain/memory/schema.ts";
import { ingestDomainFact } from "../../../lib/domain/legacy-guard.ts";

/**
 * R1-14 memory schema tests (issue #26; all data synthetic).
 */

function candidateInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    subjectRef: "chd_demo_001",
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

test("the memory vocabulary has exactly the two confirmed-fact types and no label types", () => {
  assert.deepEqual([...MEMORY_TYPES], ["confirmed_preference", "necessary_fact"]);
  // No psychological/personality/ability/diagnosis type exists anywhere in
  // the vocabulary — auto-recording such labels is structurally impossible.
  const vocabulary = [
    ...MEMORY_TYPES,
    ...MEMORY_SOURCES,
    ...MEMORY_STATUSES,
    ...MEMORY_SENSITIVITIES,
  ].join("|");
  for (const banned of ["诊断", "人格", "智商", "diagnosis", "personality", "score", "label"]) {
    assert.ok(!vocabulary.toLowerCase().includes(banned), `vocabulary must not contain "${banned}"`);
  }
});

test("a valid candidate parses and is returned frozen", () => {
  const parsed = parseMemoryCandidateInput(candidateInput());
  assert.equal(parsed.schemaVersion, "1.0");
  assert.equal(parsed.subjectRef, "chd_demo_001");
  assert.equal(parsed.type, "confirmed_preference");
  assert.equal(parsed.claim, "喜欢太空主题的故事");
  assert.equal(parsed.source, "child_statement");
  assert.equal(parsed.sensitivity, "normal");
  assert.equal(Object.isFrozen(parsed), true);
});

test("fail-closed parsing: missing, unknown and malformed fields are rejected without echo", () => {
  const parseProblems = (input: unknown): string[] => {
    try {
      parseMemoryCandidateInput(input);
    } catch (error) {
      assert.ok(error instanceof Error);
      return (error as { problems?: { path: string }[] }).problems?.map((entry) => entry.path) ?? [];
    }
    return ["<no-throw>"];
  };

  assert.throws(() => parseMemoryCandidateInput(null));
  assert.throws(() => parseMemoryCandidateInput("not-an-object"));
  assert.throws(() => parseMemoryCandidateInput([]));
  assert.deepEqual(parseProblems(candidateInput({ schemaVersion: "9.9" })).some((p) => p.includes("schemaVersion")), true);
  assert.deepEqual(parseProblems(candidateInput({ subjectRef: "not-a-child-ref" })).some((p) => p.includes("subjectRef")), true);
  assert.deepEqual(parseProblems(candidateInput({ claim: "   " })).some((p) => p.includes("claim")), true);
  assert.deepEqual(
    parseProblems(candidateInput({ claim: "x".repeat(MEMORY_MAX_CLAIM_CODE_POINTS + 1) })).some((p) => p.includes("claim")),
    true,
  );
  assert.deepEqual(parseProblems(candidateInput({ source: "wiretap" })).some((p) => p.includes("source")), true);
  assert.deepEqual(parseProblems(candidateInput({ sensitivity: "public" })).some((p) => p.includes("sensitivity")), true);
  assert.deepEqual(parseProblems(candidateInput({ observedAt: "yesterday" })).some((p) => p.includes("observedAt")), true);
  assert.deepEqual(parseProblems(candidateInput({ expiresAt: "2026-13-99T00:00:00Z" })).some((p) => p.includes("expiresAt")), true);
  // Unknown fields are rejected — including a smuggled supersedes (correction
  // goes through the dedicated path) and a smuggled status.
  assert.deepEqual(parseProblems(candidateInput({ supersedes: "mem_someid0001" })).some((p) => p.includes("supersedes")), true);
  assert.deepEqual(parseProblems(candidateInput({ status: "confirmed" })).some((p) => p.includes("status")), true);
  assert.deepEqual(parseProblems(candidateInput({ memoryId: "mem_someid0001" })).some((p) => p.includes("memoryId")), true);
  // Optional timestamps accept explicit null.
  const parsed = parseMemoryCandidateInput(candidateInput());
  assert.equal(parsed.expiresAt, null);
  assert.equal(parsed.reviewAt, null);
});

test("the label screen matches clinical/persona vocabulary deterministically", () => {
  assert.equal(claimCarriesPsychologicalLabel("建议记录：孩子可能有多动症倾向"), true);
  assert.equal(claimCarriesPsychologicalLabel("Set a personality profile for this child"), true);
  assert.equal(claimCarriesPsychologicalLabel("记录 IQ 评分结果"), true);
  assert.equal(claimCarriesPsychologicalLabel("喜欢太空主题的故事"), false);
  assert.equal(claimCarriesPsychologicalLabel("昨天一起读了恐龙书"), false);
  // Every screen term is lowercase or CJK; matching lowercases the claim.
  for (const term of MEMORY_LABEL_SCREEN_TERMS) {
    assert.equal(term, term.toLowerCase());
  }
});

test("claim normalization is deterministic for dedupe and conflict decisions", () => {
  assert.equal(normalizeClaim("  喜欢  太空 故事 "), normalizeClaim("喜欢 太空 故事"));
  assert.equal(normalizeClaim("Like Space Stories"), normalizeClaim("like space stories"));
  assert.equal(
    memoryFactKey("chd_demo_001", "confirmed_preference", "喜欢太空故事"),
    memoryFactKey("chd_demo_001", "confirmed_preference", " 喜欢太空故事 "),
  );
  assert.notEqual(
    memoryFactKey("chd_demo_001", "confirmed_preference", "喜欢太空故事"),
    memoryFactKey("chd_demo_001", "necessary_fact", "喜欢太空故事"),
  );
  assert.notEqual(
    memoryFactKey("chd_demo_001", "confirmed_preference", "喜欢太空故事"),
    memoryFactKey("chd_demo_002", "confirmed_preference", "喜欢太空故事"),
  );
});

test("the audit entry shape carries no field that could hold claim or child text", () => {
  // Structural proof: the admitted audit fact keys are exactly the
  // structural fields; any claim-bearing extension would have to add a key.
  const auditShape = {
    seq: 1,
    at: "2026-01-01T00:00:00Z",
    action: "memory.propose",
    actorRole: "system",
    subjectRef: "chd_demo_001",
    memoryId: "mem_audit0001",
    outcome: "ok",
    ruleIds: [],
    count: null,
  };
  const admitted = ingestDomainFact(auditShape) as Record<string, unknown>;
  for (const key of Object.keys(admitted)) {
    assert.ok(
      !["claim", "text", "content", "payload", "note", "message"].includes(key),
      `audit must not carry a ${key} field`,
    );
  }
});

test("legacy prisma CognitiveProfile scores cannot enter the memory model", () => {
  // The legacy intake guard rejects legacy shapes before any memory entry
  // could be constructed from them.
  assert.throws(
    () =>
      admitMemoryEntry({
        ...parseMemoryCandidateInput(candidateInput()),
        memoryId: "mem_legacy001",
        supersedes: null,
        status: "candidate",
        proposedByRole: "system",
        createdAt: "2026-01-01T00:00:00Z",
        confirmedAt: null,
        confirmedByRole: null,
        supersededAt: null,
        revision: 1,
        // A legacy score field smuggled into the entry shape:
        numberSenseScore: 0.82,
      } as unknown as Parameters<typeof admitMemoryEntry>[0]),
    /Legacy CognitiveProfile record rejected/,
  );
  // And a fresh legacy-shaped fact cannot even be ingested.
  assert.throws(() => ingestDomainFact({ numberSenseScore: 0.9, childId: "child_demo_001" }));
});
