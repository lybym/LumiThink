/**
 * R1-09 data lifecycle domain tests (issue #21): the retention-matrix
 * vocabulary (AC 3: 数据流/保留矩阵), the fail-closed data-action parser and
 * the emit-side shape validators. All data synthetic.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ContractValidationError } from "../../../lib/domain/contract/core.ts";
import {
  CHILD_DATA_ACTION_KINDS,
  DATA_KIND_POLICIES,
  DATA_STORAGE_LOCATIONS,
  LIFECYCLE_FAMILY_CHILD_REF,
  MAX_DELETION_LEDGER_RECORDS,
  lifecycleOperatorRole,
  parseChildDataActionRequest,
  validateChildDataDeletionRecord,
  validateChildDataEraseResult,
  validateChildDataExport,
  validateChildDataInventory,
} from "../../../lib/domain/lifecycle/index.ts";

// ---------------------------------------------------------------------------
// Retention matrix integrity (AC 3)
// ---------------------------------------------------------------------------

test("every text-bearing data kind has a concrete deletion path", () => {
  for (const policy of DATA_KIND_POLICIES) {
    if (policy.carriesChildText) {
      assert.ok(
        policy.deletedBy.length > 0 && policy.deletedBy !== "不适用（无存储）",
        `text-bearing kind ${policy.dataKind} must name a deletion path`,
      );
    }
  }
});

test("audio is structurally uncollected and vendor-side deletion is never fabricated", () => {
  const audio = DATA_KIND_POLICIES.find((policy) => policy.dataKind === "audio");
  assert.ok(audio !== undefined, "the matrix must classify audio explicitly");
  assert.equal(audio.storedIn, "none", "audio must be marked as not stored in this build");
  assert.equal(audio.carriesChildText, false);

  const vendor = DATA_KIND_POLICIES.find((policy) => policy.dataKind === "vendor_side");
  assert.ok(vendor !== undefined, "the matrix must classify vendor-side data explicitly");
  assert.ok(
    vendor.deletedBy.includes("不可由本系统担保"),
    "vendor-side deletion must not be claimed as guaranteed",
  );
  assert.ok(DATA_STORAGE_LOCATIONS.includes("vendor_side"));
});

test("the deletion ledger is bounded and the pinned subject is the family child", () => {
  assert.ok(Number.isInteger(MAX_DELETION_LEDGER_RECORDS) && MAX_DELETION_LEDGER_RECORDS > 0);
  assert.equal(LIFECYCLE_FAMILY_CHILD_REF, "chd_demo_001");
  assert.equal(lifecycleOperatorRole("guardian"), "guardian");
});

// ---------------------------------------------------------------------------
// Data-action parser (fail-closed, no-echo)
// ---------------------------------------------------------------------------

test("parseChildDataActionRequest accepts exactly the two registered actions", () => {
  const erase = parseChildDataActionRequest({ protocolVersion: "1.0", action: "erase_child_data" });
  assert.equal(erase.kind, "erase_child_data");
  const replay = parseChildDataActionRequest({ protocolVersion: "1.0", action: "replay_child_deletions" });
  assert.equal(replay.kind, "replay_child_deletions");
  assert.deepEqual([...CHILD_DATA_ACTION_KINDS], ["erase_child_data", "replay_child_deletions"]);
});

test("parseChildDataActionRequest rejects missing/unknown versions and unknown fields without echo", () => {
  assert.throws(() => parseChildDataActionRequest({ action: "erase_child_data" }), ContractValidationError);
  assert.throws(
    () => parseChildDataActionRequest({ protocolVersion: "9.9", action: "erase_child_data" }),
    ContractValidationError,
  );
  assert.throws(
    () => parseChildDataActionRequest({ protocolVersion: "1.0" }),
    ContractValidationError,
  );
  assert.throws(
    () => parseChildDataActionRequest({ protocolVersion: "1.0", action: "destroy_everything" }),
    ContractValidationError,
  );
  try {
    parseChildDataActionRequest({ protocolVersion: "1.0", action: "destroy_everything" });
    assert.fail("unreachable");
  } catch (error) {
    assert.ok(error instanceof ContractValidationError);
    // No-echo: the rejected submitted action value never appears in the
    // problem message.
    assert.ok(!JSON.stringify(error.problems).includes("destroy_everything"));
  }
  assert.throws(
    () =>
      parseChildDataActionRequest({
        protocolVersion: "1.0",
        action: "erase_child_data",
        subjectRef: "chd_attacker01",
      }),
    ContractValidationError,
  );
  assert.throws(() => parseChildDataActionRequest(null), ContractValidationError);
  assert.throws(() => parseChildDataActionRequest("erase"), ContractValidationError);
});

// ---------------------------------------------------------------------------
// Emit-side validators (fail-closed out)
// ---------------------------------------------------------------------------

const VALID_PURGED = {
  conversations: 1,
  historyEntries: 3,
  turnStreams: 2,
  memories: 4,
  dshSessions: 1,
};

test("inventory validator accepts the structural shape and rejects unknown fields", () => {
  const inventory = validateChildDataInventory({
    protocolVersion: "1.0",
    childRef: LIFECYCLE_FAMILY_CHILD_REF,
    recordingEnabled: false,
    conversations: [{ conversationId: "conv_demo0001", sessionId: "ses_demo0001", historyEntries: 0 }],
    turnStreams: { total: 0, running: 0 },
    dshSessions: { mapped: 0 },
    memories: { total: 0, candidates: 0, confirmed: 0, superseded: 0, expired: 0 },
    deletionLedger: { records: 0, lastErasedAt: null },
    generatedAt: "2026-10-14T08:00:00.000Z",
  });
  assert.equal(inventory.childRef, LIFECYCLE_FAMILY_CHILD_REF);
  assert.equal(inventory.recordingEnabled, false);

  assert.throws(
    () =>
      validateChildDataInventory({
        protocolVersion: "1.0",
        childRef: LIFECYCLE_FAMILY_CHILD_REF,
        recordingEnabled: false,
        conversations: [],
        turnStreams: { total: 0, running: 0 },
        dshSessions: { mapped: 0 },
        memories: { total: 0, candidates: 0, confirmed: 0, superseded: 0, expired: 0 },
        deletionLedger: { records: 0, lastErasedAt: null },
        generatedAt: "2026-10-14T08:00:00.000Z",
        smuggledClaim: "喜欢太空主题的秘密内容",
      }),
    ContractValidationError,
  );
  assert.throws(
    () =>
      validateChildDataInventory({
        protocolVersion: "1.0",
        childRef: LIFECYCLE_FAMILY_CHILD_REF,
        recordingEnabled: false,
        conversations: [],
        turnStreams: { total: -1, running: 0 },
        dshSessions: { mapped: 0 },
        memories: { total: 0, candidates: 0, confirmed: 0, superseded: 0, expired: 0 },
        deletionLedger: { records: 0, lastErasedAt: null },
        generatedAt: "2026-10-14T08:00:00.000Z",
      }),
    ContractValidationError,
  );
});

test("erase result validator rejects a shape carrying deleted content fields", () => {
  const result = validateChildDataEraseResult({
    protocolVersion: "1.0",
    childRef: LIFECYCLE_FAMILY_CHILD_REF,
    action: "erase_child_data",
    erasedAt: "2026-10-14T08:00:00.000Z",
    operatorRole: "guardian",
    purged: VALID_PURGED,
    deletionRecordId: "del_demo000001",
  });
  assert.equal(result.action, "erase_child_data");
  assert.equal(result.purged.memories, 4);

  // The result shape must not be able to smuggle the deleted claim text.
  assert.throws(
    () =>
      validateChildDataEraseResult({
        protocolVersion: "1.0",
        childRef: LIFECYCLE_FAMILY_CHILD_REF,
        action: "erase_child_data",
        erasedAt: "2026-10-14T08:00:00.000Z",
        operatorRole: "guardian",
        purged: VALID_PURGED,
        deletionRecordId: "del_demo000001",
        deletedClaims: ["喜欢太空主题的秘密内容"],
      }),
    ContractValidationError,
  );
  assert.throws(
    () =>
      validateChildDataEraseResult({
        protocolVersion: "1.0",
        childRef: LIFECYCLE_FAMILY_CHILD_REF,
        action: "erase_child_data",
        erasedAt: "2026-10-14T08:00:00.000Z",
        operatorRole: "guardian",
        purged: { ...VALID_PURGED, memories: -2 },
        deletionRecordId: "del_demo000001",
      }),
    ContractValidationError,
  );
});

test("deletion-record validator enforces the content-free tombstone shape", () => {
  const record = validateChildDataDeletionRecord({
    recordId: "del_demo000001",
    seq: 1,
    at: "2026-10-14T08:00:00.000Z",
    subjectRef: LIFECYCLE_FAMILY_CHILD_REF,
    action: "replay_child_deletions",
    operatorRole: "guardian",
    purged: VALID_PURGED,
  });
  assert.equal(record.seq, 1);
  assert.throws(
    () =>
      validateChildDataDeletionRecord({
        recordId: "del_demo000001",
        seq: 1,
        at: "2026-10-14T08:00:00.000Z",
        subjectRef: LIFECYCLE_FAMILY_CHILD_REF,
        action: "erase_child_data",
        operatorRole: "guardian",
        purged: VALID_PURGED,
        claims: ["喜欢太空主题的秘密内容"],
      }),
    ContractValidationError,
  );
});

test("export validator bounds history content but admits the content-bearing shape", () => {
  const data = validateChildDataExport({
    protocolVersion: "1.0",
    childRef: LIFECYCLE_FAMILY_CHILD_REF,
    exportedAt: "2026-10-14T08:00:00.000Z",
    recordingEnabled: true,
    conversations: [
      {
        conversationId: "conv_demo0001",
        sessionId: "ses_demo0001",
        history: [
          { role: "user", content: "[synthetic] 导出测试" },
          { role: "assistant", content: "[synthetic] 回复" },
        ],
      },
    ],
    memories: [],
    exclusions: ["音频：本系统不采集、不存储"],
  });
  assert.equal(data.conversations.length, 1);
  assert.equal(data.recordingEnabled, true);

  // Overlong content is rejected.
  assert.throws(
    () =>
      validateChildDataExport({
        protocolVersion: "1.0",
        childRef: LIFECYCLE_FAMILY_CHILD_REF,
        exportedAt: "2026-10-14T08:00:00.000Z",
        recordingEnabled: true,
        conversations: [
          {
            conversationId: "conv_demo0001",
            sessionId: "ses_demo0001",
            history: [{ role: "user", content: "x".repeat(4001) }],
          },
        ],
        memories: [],
        exclusions: [],
      }),
    ContractValidationError,
  );
  // Unknown history roles are rejected.
  assert.throws(
    () =>
      validateChildDataExport({
        protocolVersion: "1.0",
        childRef: LIFECYCLE_FAMILY_CHILD_REF,
        exportedAt: "2026-10-14T08:00:00.000Z",
        recordingEnabled: true,
        conversations: [
          {
            conversationId: "conv_demo0001",
            sessionId: "ses_demo0001",
            history: [{ role: "system", content: "smuggled" }],
          },
        ],
        memories: [],
        exclusions: [],
      }),
    ContractValidationError,
  );
});
