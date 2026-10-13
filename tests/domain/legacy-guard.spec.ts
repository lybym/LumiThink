import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_COGNITIVE_PROFILE_SCORE_KEYS,
  LegacyDomainIntakeError,
  LegacyMigrationRefusedError,
  archiveLegacyCognitiveProfile,
  archiveLegacyRawEvents,
  assertFreeOfLegacyShapes,
  ingestDomainFact,
  isLegacyCognitiveProfileRecord,
  isLegacyRawEventRecord,
} from "../../lib/domain/legacy-guard.ts";

const ACK = {
  acknowledgeLegacyScoresDrop: true,
  actor: "maintainer-ops",
  reason: "R1-00 legacy audit rehearsal on synthetic data",
} as const;

function legacyProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: "profile_001",
    childId: "child_demo_001",
    numberSenseScore: 0.87,
    spatialScore: 0.4,
    logicScore: 0,
    strategyScore: 0.25,
    latestDiagnosisSummary: "Profile initialized. Awaiting first parent upload.",
    ...overrides,
  };
}

test("legacy CognitiveProfile records are structurally detected", () => {
  assert.equal(isLegacyCognitiveProfileRecord(legacyProfile()), true);
  assert.equal(isLegacyCognitiveProfileRecord({ latestDiagnosisSummary: "x" }), true);
  assert.equal(isLegacyCognitiveProfileRecord({ childId: "child_demo_001" }), false);
  assert.equal(isLegacyCognitiveProfileRecord(null), false);
  assert.equal(isLegacyCognitiveProfileRecord([legacyProfile()]), false);
});

test("legacy RawEvent records are structurally detected", () => {
  assert.equal(
    isLegacyRawEventRecord({ eventType: "KID_INTERACTION_TRACE", payload: {} }),
    true,
  );
  assert.equal(
    isLegacyRawEventRecord({ eventType: "NOT_A_LEGACY_TYPE", payload: {} }),
    false,
  );
  assert.equal(isLegacyRawEventRecord({ eventType: "PARENT_UPLOAD" }), false);
  assert.equal(isLegacyRawEventRecord("PARENT_UPLOAD"), false);
});

test("ingestDomainFact rejects a flat legacy CognitiveProfile record", () => {
  assert.throws(() => ingestDomainFact(legacyProfile()), (error: unknown) => {
    assert.ok(error instanceof LegacyDomainIntakeError);
    assert.equal(error.legacyShape, "CognitiveProfile");
    assert.equal(error.path, "domainFact");
    return true;
  });
});

test("ingestDomainFact rejects a legacy RawEvent record", () => {
  assert.throws(() => ingestDomainFact({ eventType: "LLM_EVALUATION", payload: { any: 1 } }), (error: unknown) => {
    assert.ok(error instanceof LegacyDomainIntakeError);
    assert.equal(error.legacyShape, "RawEvent");
    return true;
  });
});

test("ingestDomainFact rejects legacy records smuggled inside new-domain envelopes", () => {
  assert.throws(
    () =>
      ingestDomainFact({
        kind: "observation",
        subjectId: "child_demo_001",
        meta: {
          sources: [{ legacyProfile: legacyProfile() }],
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof LegacyDomainIntakeError);
      assert.equal(error.legacyShape, "CognitiveProfile");
      assert.match(error.path, /meta\.sources\[0\]\.legacyProfile/);
      return true;
    },
  );

  assert.throws(
    () =>
      ingestDomainFact({
        kind: "observation",
        attachments: [{ eventType: "PROFILE_SNAPSHOT", payload: { blob: true } }],
      }),
    (error: unknown) => {
      assert.ok(error instanceof LegacyDomainIntakeError);
      assert.equal(error.legacyShape, "RawEvent");
      return true;
    },
  );
});

test("ingestDomainFact admits and freezes a minimal new-domain fact", () => {
  const fact = {
    kind: "preference",
    subjectId: "child_demo_001",
    claim: "likes astronomy",
    source: "child-statement",
    observedAt: "2026-10-13T00:00:00.000Z",
  };
  const ingested = ingestDomainFact(fact);
  assert.equal(Object.isFrozen(ingested), true);
  assert.equal(ingested.claim, "likes astronomy");
  assert.throws(
    () => {
      (ingested as { claim: string }).claim = "changed";
    },
    TypeError,
  );
});

test("explicit legacy migration refuses without full acknowledgement", () => {
  assert.throws(
    () =>
      archiveLegacyCognitiveProfile(legacyProfile(), {
        ...ACK,
        acknowledgeLegacyScoresDrop: false,
      } as never),
    LegacyMigrationRefusedError,
  );
  assert.throws(
    () => archiveLegacyCognitiveProfile(legacyProfile(), { ...ACK, actor: "" }),
    LegacyMigrationRefusedError,
  );
  assert.throws(
    () =>
      archiveLegacyCognitiveProfile(legacyProfile(), {
        acknowledgeLegacyScoresDrop: true,
        actor: "maintainer-ops",
        reason: "  ",
      }),
    LegacyMigrationRefusedError,
  );
  assert.throws(
    () =>
      archiveLegacyCognitiveProfile(
        { id: "profile_002" } as never,
        ACK,
      ),
    LegacyMigrationRefusedError,
  );
});

test("explicit legacy migration drops all capability scores and keeps provenance", () => {
  const archive = archiveLegacyCognitiveProfile(legacyProfile(), ACK);

  for (const key of LEGACY_COGNITIVE_PROFILE_SCORE_KEYS) {
    assert.equal(key in archive, false, `${key} must not survive migration`);
    assert.equal(
      typeof (archive as Record<string, unknown>)[key],
      "undefined",
      `${key} must not be copied in any form`,
    );
  }
  assert.equal("latestDiagnosisSummary" in archive, false);

  assert.equal(archive.legacySource, "prisma.CognitiveProfile");
  assert.equal(archive.childRef, "child_demo_001");
  assert.equal(archive.provenance.migration, "r1-00-legacy-guard@1");
  assert.deepEqual(
    archive.droppedFields,
    [...LEGACY_COGNITIVE_PROFILE_SCORE_KEYS, "latestDiagnosisSummary"],
  );
  assert.equal(Number.isNaN(Date.parse(archive.archivedAt)), false);
  assert.equal(Object.isFrozen(archive), true);

  // The archive itself must pass the same guarded intake as new facts.
  assert.doesNotThrow(() => assertFreeOfLegacyShapes(archive, "legacyProfileArchive"));

  // No numeric score value may appear anywhere in the serialized archive.
  const serialized = JSON.stringify(archive);
  for (const value of [0.87, 0.4, 0.25]) {
    assert.equal(serialized.includes(String(value)), false);
  }
});

test("explicit RawEvent migration counts events without copying payload content", () => {
  const canary = "CANARY-CHILD-CONTENT-7f3a9c";
  const events = [
    { eventType: "KID_INTERACTION_TRACE", payload: { text: canary } },
    { eventType: "KID_INTERACTION_TRACE", payload: { text: canary } },
    { eventType: "PARENT_UPLOAD", payload: { imageRef: "synthetic.png" } },
    { eventType: "LLM_EVALUATION", payload: { note: canary } },
  ];

  const archive = archiveLegacyRawEvents(events, ACK);

  assert.equal(archive.eventCount, 4);
  assert.deepEqual(archive.eventTypeCounts, {
    KID_INTERACTION_TRACE: 2,
    PARENT_UPLOAD: 1,
    LLM_EVALUATION: 1,
  });
  assert.equal(archive.payloadContentsCopied, false);
  assert.equal("payload" in archive, false);

  const serialized = JSON.stringify(archive);
  assert.equal(serialized.includes(canary), false, "payload content leaked into the archive");
  assert.equal(serialized.includes("synthetic.png"), false);

  assert.doesNotThrow(() => assertFreeOfLegacyShapes(archive, "legacyRawEventArchive"));
});

test("RawEvent migration fails closed on non-conforming entries without echoing content", () => {
  assert.throws(
    () =>
      archiveLegacyRawEvents(
        [
          { eventType: "KID_INTERACTION_TRACE", payload: { text: "ok" } },
          { eventType: "KID_INTERACTION_TRACE" } as never,
        ],
        ACK,
      ),
    (error: unknown) => {
      assert.ok(error instanceof LegacyMigrationRefusedError);
      assert.match(error.message, /index 1/);
      return true;
    },
  );
});
