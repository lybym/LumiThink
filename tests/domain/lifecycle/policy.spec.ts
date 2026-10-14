/**
 * R1-09 data lifecycle domain tests (issue #21): the retention-matrix
 * vocabulary (AC 3: 数据流/保留矩阵), the fail-closed data-action parser and
 * the emit-side shape validators. All data synthetic.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
// Review round 1 (P2-2): the admission gate is MECHANICAL — the exact row
// set is pinned and both doc matrices are mirrored by machine, so an
// unregistered store can no longer ship with a green suite (P0-1 was the
// live demonstration of that hole).
// ---------------------------------------------------------------------------

/** The exact row set of the retention matrix, in order (speed bump). */
const EXPECTED_DATA_KIND_ROWS = Object.freeze([
  "conversation_history",
  "turn_stream_events",
  "dsh_session_mapping",
  "memory_entries",
  "memory_audit",
  "guardian_audit",
  "runtime_trace",
  "gateway_audit",
  "deletion_ledger",
  "idempotency_ledger",
  // R1-08 (issue #20): the encrypted runtime snapshot — the first
  // host-filesystem data kind, registered with its erase-then-rewrite +
  // restore-replay delete contract.
  "runtime_snapshot_file",
  "audio",
  "vendor_side",
]);

test("the retention matrix pins its exact data-kind row set (admission speed bump)", () => {
  assert.deepEqual(
    DATA_KIND_POLICIES.map((policy) => policy.dataKind),
    [...EXPECTED_DATA_KIND_ROWS],
    "a new data kind must consciously extend this pin + both doc mirrors (issue #21 AC 3, review P2-2)",
  );
});

test("the R1-08 encrypted snapshot row is registered honestly (text-carrying, encrypted, replay-backed)", () => {
  const snapshotRow = DATA_KIND_POLICIES.find((policy) => policy.dataKind === "runtime_snapshot_file");
  assert.ok(snapshotRow !== undefined, "the runtime snapshot must be enumerated in the matrix");
  assert.equal(
    snapshotRow.carriesChildText,
    true,
    "the snapshot embeds retained child text (recording on) — the honest answer",
  );
  assert.equal(snapshotRow.storedIn, "host_filesystem");
  assert.ok(snapshotRow.retention.includes("AES-256-GCM"), "encryption at rest is mandatory and pinned");
  assert.ok(snapshotRow.deletedBy.includes("replay_child_deletions"), "the restore-replay delete contract is pinned");
  assert.ok(DATA_STORAGE_LOCATIONS.includes("host_filesystem"));
});

test("the idempotency ledger row is registered content-free (review R1 P0-1)", () => {
  const ledger = DATA_KIND_POLICIES.find((policy) => policy.dataKind === "idempotency_ledger");
  assert.ok(ledger !== undefined, "the idempotency ledger must be enumerated in the matrix");
  assert.equal(
    ledger.carriesChildText,
    false,
    "the ledger stores only the 64-bit payload digest + ids (P0-1 fix) — never child text",
  );
  assert.equal(ledger.storedIn, "process_memory");
  assert.ok(ledger.retention.includes("500"), "the bounded 500-entry ledger is disclosed");
  assert.ok(ledger.retention.includes("摘要"), "the content-free digest storage is disclosed");
});

/** Read a repo doc relative to this spec (robust against the cwd). */
function readRepoDoc(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf-8");
}

/** Parse the pipe table of one markdown section into cell rows (raw). */
function parseMarkdownTableRows(markdown: string, sectionHeadingPrefix: string): string[][] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(sectionHeadingPrefix));
  assert.ok(start >= 0, `doc section ${sectionHeadingPrefix} not found`);
  const rows: string[][] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("## ")) {
      break;
    }
    if (!line.startsWith("|")) {
      continue;
    }
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length > 0 && cells.every((cell) => /^-+$/.test(cell))) {
      continue; // separator row
    }
    rows.push(cells);
  }
  return rows;
}

test("MEMORY_POLICY §2 mirrors DATA_KIND_POLICIES row-for-row, including the carries-text column", () => {
  const markdown = readRepoDoc("../../../docs/MEMORY_POLICY.md");
  const rows = parseMarkdownTableRows(markdown, "## 2.").slice(1); // drop header
  assert.ok(rows.length >= EXPECTED_DATA_KIND_ROWS.length, "the mirror table must cover every row");
  const docKinds: string[] = [];
  for (const cells of rows) {
    const kindCell = cells[0] ?? "";
    const ids = [...kindCell.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
    assert.equal(ids.length, 1, `each MEMORY_POLICY §2 row pins exactly one data kind: ${kindCell}`);
    const kind = ids[0];
    docKinds.push(kind);
    const policy = DATA_KIND_POLICIES.find((entry) => entry.dataKind === kind);
    assert.ok(policy !== undefined, `MEMORY_POLICY §2 row ${kind} must exist in DATA_KIND_POLICIES`);
    assert.equal(
      cells[1],
      policy.carriesChildText ? "是" : "否",
      `the 可含儿童正文 column must mirror carriesChildText for ${kind}`,
    );
  }
  assert.deepEqual(
    docKinds,
    [...EXPECTED_DATA_KIND_ROWS],
    "MEMORY_POLICY §2 must mirror the matrix row-for-row (same order)",
  );
});

test("PRIVACY_DATA_FLOW §2 mirrors the DATA_KIND_POLICIES kind set exactly", () => {
  const markdown = readRepoDoc("../../../docs/PRIVACY_DATA_FLOW.md");
  const rows = parseMarkdownTableRows(markdown, "## 2.").slice(1); // drop header
  const docKinds = new Set<string>();
  for (const cells of rows) {
    const kindCell = cells[0] ?? "";
    const ids = [...kindCell.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]);
    assert.ok(ids.length >= 1, `each PRIVACY_DATA_FLOW §2 row pins its data kind(s): ${kindCell}`);
    for (const kind of ids) {
      assert.ok(
        DATA_KIND_POLICIES.some((entry) => entry.dataKind === kind),
        `PRIVACY_DATA_FLOW §2 kind ${kind} must exist in DATA_KIND_POLICIES`,
      );
      docKinds.add(kind);
    }
  }
  const policyKinds = new Set(DATA_KIND_POLICIES.map((policy) => policy.dataKind));
  assert.deepEqual(
    [...docKinds].sort(),
    [...policyKinds].sort(),
    "PRIVACY_DATA_FLOW §2 must mirror the matrix kind set exactly (both directions)",
  );
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
