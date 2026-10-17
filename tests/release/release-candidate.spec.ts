/**
 * E2E-12 (issue #62) first-product acceptance registry — fail-closed
 * self-tests.
 *
 * `release/release-candidate.json` is the machine-checkable half of the
 * first-product acceptance gate. These tests pin:
 *
 *   - the happy path: the committed registry parses fail-closed, covers every
 *     DoD id, references only artifacts that really exist, and keeps the
 *     candidate version coherent with package.json and the release manifest;
 *   - the discipline as injected faults against the REAL verifier: a human
 *     row cannot be recorded while the decision is pending (no proxy PASS),
 *     a Go decision cannot coexist with pending human evidence, no-go
 *     dimensions or blocked items (must-items cannot be downgraded to prose),
 *     and a created release cannot exist without the Go decision and the
 *     recorded explicit user approval;
 *   - the frozen scope and the DoD id list (changes are code changes, i.e.
 *     reviewed PRs).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";

import {
  ACCEPTANCE_DIMENSIONS,
  verifyReleaseCandidate,
  type ReleaseCandidateContext,
} from "../../scripts/release-gate/acceptance.ts";
import { ReleaseGateError, scanForLeaks } from "../../scripts/release-gate/verify.ts";

const REGISTRY_URL = new URL("../../release/release-candidate.json", import.meta.url);
const REGISTRY_RAW = readFileSync(REGISTRY_URL, "utf8");

const CONTEXT: ReleaseCandidateContext = {
  packageVersion: (JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string }).version,
  manifestAppVersion: (JSON.parse(
    readFileSync(new URL("../../release/release-manifest.json", import.meta.url), "utf8"),
  ) as { app: { version: string } }).app.version,
  artifactExists: (repoPath) => existsSync(new URL(`../../${repoPath}`, import.meta.url)),
};

/** Re-serialize the committed registry with one mutation applied. */
function mutated(mutate: (value: Record<string, unknown>) => void): string {
  const value = JSON.parse(REGISTRY_RAW) as Record<string, unknown>;
  mutate(value);
  return JSON.stringify(value);
}

function assertBlocked(raw: string, fragment: string): void {
  try {
    verifyReleaseCandidate(raw, CONTEXT);
  } catch (error) {
    assert.ok(error instanceof ReleaseGateError, `blocked by ReleaseGateError, got ${String(error)}`);
    assert.ok(
      error.problems.some((problem) => problem.includes(fragment)),
      `problems mention '${fragment}': ${JSON.stringify(error.problems)}`,
    );
    return;
  }
  assert.fail(`expected the gate to block (${fragment})`);
}

test("the committed acceptance registry passes the real verifier end-to-end", () => {
  const registry = verifyReleaseCandidate(REGISTRY_RAW, CONTEXT);
  assert.equal(registry.schemaVersion, "1.0");
  assert.equal(registry.issue, "https://github.com/lybym/LumiThink/issues/62");
  assert.equal(registry.productScope.frozen, true);
  assert.equal(registry.goNoGo.decision, "pending");
  assert.equal(registry.release.state, "not_created");
  assert.equal(registry.release.requiresExplicitUserApproval, true);
});

test("the candidate version is coherent with package.json and the release manifest", () => {
  const registry = verifyReleaseCandidate(REGISTRY_RAW, CONTEXT);
  assert.equal(registry.candidate.version, CONTEXT.packageVersion);
  assert.equal(registry.candidate.version, CONTEXT.manifestAppVersion);
  assert.notEqual(registry.candidate.version, "0.0.0", "the candidate version must be the assembled RC version");
});

test("every automated evidence row references artifacts that exist, every human row is pending with a protocol", () => {
  const registry = verifyReleaseCandidate(REGISTRY_RAW, CONTEXT);
  assert.ok(registry.evidence.length >= 8, "both DoD surfaces must be registered");
  const automated = registry.evidence.filter((row) => row.surface === "automated");
  const human = registry.evidence.filter((row) => row.surface === "human");
  assert.ok(automated.length >= 4);
  assert.ok(human.length >= 4);
  for (const row of human) {
    assert.equal(row.status, "pending");
    assert.ok(row.protocol !== undefined && row.protocol.length > 0);
    assert.equal(row.evidenceRef, undefined);
  }
});

test("the six acceptance dimensions are registered exactly", () => {
  const registry = verifyReleaseCandidate(REGISTRY_RAW, CONTEXT);
  assert.deepEqual([...registry.goNoGo.dimensions].sort(), [...ACCEPTANCE_DIMENSIONS].sort());
});

test("fault: an unknown top-level key blocks (fail-closed parse)", () => {
  assertBlocked(mutated((value) => { value.note = "children said ..."; }), "unknown key");
});

test("fault: a wrong schemaVersion blocks", () => {
  assertBlocked(mutated((value) => { value.schemaVersion = "1.1"; }), "schemaVersion");
});

test("fault: unfreezing the product scope blocks", () => {
  assertBlocked(
    mutated((value) => {
      (value.productScope as Record<string, unknown>).frozen = false;
    }),
    "must be explicitly frozen",
  );
});

test("fault: recording a human evidence row while the decision is pending blocks (no proxy PASS)", () => {
  assertBlocked(
    mutated((value) => {
      const evidence = value.evidence as Record<string, unknown>[];
      const row = evidence.find((entry) => entry.id === "ev-dod1-device-demo");
      assert.ok(row !== undefined);
      row.status = "recorded";
      row.evidenceRef = "https://github.com/lybym/LumiThink/issues/62#issuecomment-0000000000";
    }),
    "human evidence must stay pending",
  );
});

test("fault: a pending human row cannot carry an evidenceRef", () => {
  assertBlocked(
    mutated((value) => {
      const evidence = value.evidence as Record<string, unknown>[];
      const row = evidence.find((entry) => entry.id === "ev-dod1-device-demo");
      assert.ok(row !== undefined);
      row.evidenceRef = "https://example.invalid/evidence";
    }),
    "cannot carry an evidenceRef yet",
  );
});

test("fault: an automated row claimed as pending blocks (CI surface is either proven or absent)", () => {
  assertBlocked(
    mutated((value) => {
      const evidence = value.evidence as Record<string, unknown>[];
      const row = evidence.find((entry) => entry.id === "ev-dod1-automated-voice-loop");
      assert.ok(row !== undefined);
      row.status = "pending";
    }),
    "automated rows must be status 'proven'",
  );
});

test("fault: a dangling gate or proof path blocks", () => {
  assertBlocked(
    mutated((value) => {
      const evidence = value.evidence as Record<string, unknown>[];
      const row = evidence.find((entry) => entry.id === "ev-dod1-automated-voice-loop");
      assert.ok(row !== undefined);
      row.proof = ["tests/server/does-not-exist.spec.ts"];
    }),
    "proof path does not exist",
  );
  assertBlocked(
    mutated((value) => {
      const evidence = value.evidence as Record<string, unknown>[];
      const row = evidence.find((entry) => entry.id === "ev-dod1-automated-voice-loop");
      assert.ok(row !== undefined);
      row.gate = ".github/workflows/rogue-gate.yml";
    }),
    "gate workflow does not exist",
  );
});

test("fault: dropping a DoD id from the evidence coverage blocks", () => {
  assertBlocked(
    mutated((value) => {
      const evidence = value.evidence as Record<string, unknown>[];
      const row = evidence.find((entry) => entry.id === "ev-dod4-human-approval");
      assert.ok(row !== undefined);
      row.covers = [];
    }),
    "must reference at least one DoD id",
  );
  // And an evidence row may not invent an unregistered DoD id either.
  assertBlocked(
    mutated((value) => {
      const evidence = value.evidence as Record<string, unknown>[];
      evidence[0].covers = ["dod-9"];
    }),
    "unknown DoD id",
  );
});

test("fault: a Go decision with pending human evidence blocks", () => {
  assertBlocked(
    mutated((value) => {
      value.goNoGo = {
        decision: "go",
        dimensions: (value.goNoGo as Record<string, unknown>).dimensions,
        record: {
          decidedBy: "independent-acceptor",
          decidedAt: "2026-11-01",
          verdicts: Object.fromEntries(ACCEPTANCE_DIMENSIONS.map((d) => [d, "go"])),
          blockedItems: [],
          evidenceUrls: ["https://github.com/lybym/LumiThink/issues/62#issuecomment-0000000000"],
        },
      };
    }),
    "requires every human evidence row to be recorded",
  );
});

test("fault: a Go decision with a no-go dimension or blockedItems blocks (must-items cannot be downgraded to prose)", () => {
  const goRecord = {
    decidedBy: "independent-acceptor",
    decidedAt: "2026-11-01",
    verdicts: Object.fromEntries(ACCEPTANCE_DIMENSIONS.map((d) => [d, "go"])),
    blockedItems: [],
    evidenceUrls: ["https://github.com/lybym/LumiThink/issues/62#issuecomment-0000000000"],
  };
  const withAllRecorded = (value: Record<string, unknown>) => {
    for (const row of value.evidence as Record<string, unknown>[]) {
      if (row.surface === "human") {
        row.status = "recorded";
        row.evidenceRef = "https://github.com/lybym/LumiThink/issues/62#issuecomment-0000000000";
      }
    }
  };
  assertBlocked(
    mutated((value) => {
      withAllRecorded(value);
      value.goNoGo = {
        decision: "go",
        dimensions: (value.goNoGo as Record<string, unknown>).dimensions,
        record: {
          ...goRecord,
          verdicts: { ...goRecord.verdicts, rollback: "no-go" },
        },
      };
    }),
    "no-go dimension verdict",
  );
  assertBlocked(
    mutated((value) => {
      withAllRecorded(value);
      value.goNoGo = {
        decision: "go",
        dimensions: (value.goNoGo as Record<string, unknown>).dimensions,
        record: { ...goRecord, blockedItems: ["AEC 打断成功率未达冻结门限"] },
      };
    }),
    "cannot carry blockedItems",
  );
});

test("fault: a go/no-go decision without the independent-acceptor record blocks", () => {
  assertBlocked(
    mutated((value) => {
      value.goNoGo = {
        decision: "go",
        dimensions: (value.goNoGo as Record<string, unknown>).dimensions,
        record: null,
      };
    }),
    "requires the independent-acceptor record",
  );
  assertBlocked(
    mutated((value) => {
      value.goNoGo = {
        decision: "no-go",
        dimensions: (value.goNoGo as Record<string, unknown>).dimensions,
        record: null,
      };
    }),
    "requires the independent-acceptor record",
  );
});

test("fault: a no-go decision must cite a no-go dimension or a blocked item", () => {
  assertBlocked(
    mutated((value) => {
      value.goNoGo = {
        decision: "no-go",
        dimensions: (value.goNoGo as Record<string, unknown>).dimensions,
        record: {
          decidedBy: "independent-acceptor",
          decidedAt: "2026-11-01",
          verdicts: Object.fromEntries(ACCEPTANCE_DIMENSIONS.map((d) => [d, "go"])),
          blockedItems: [],
          evidenceUrls: ["https://github.com/lybym/LumiThink/issues/62#issuecomment-0000000000"],
        },
      };
    }),
    "must cite at least one no-go dimension or blocked item",
  );
});

test("fault: creating the release without Go / user approval / release record blocks", () => {
  const releaseCreated = { state: "created", record: { ref: "v1.0.0-rc.1", createdAt: "2026-11-02" } };
  assertBlocked(
    mutated((value) => {
      value.release = {
        requiresExplicitUserApproval: true,
        userApproval: null,
        state: "created",
        record: (releaseCreated as Record<string, unknown>).record,
      };
    }),
    "cannot be created without the Go decision",
  );
  assertBlocked(
    mutated((value) => {
      value.release = {
        requiresExplicitUserApproval: true,
        userApproval: null,
        state: "created",
        record: null,
      };
    }),
    "requires the recorded explicit user approval",
  );
});

test("fault: removing the user-approval requirement blocks (hard constant)", () => {
  assertBlocked(
    mutated((value) => {
      value.release = {
        requiresExplicitUserApproval: false,
        userApproval: null,
        state: "not_created",
        record: null,
      };
    }),
    "hard constant",
  );
});

test("fault: user approval before the Go decision blocks", () => {
  assertBlocked(
    mutated((value) => {
      value.release = {
        requiresExplicitUserApproval: true,
        userApproval: { approvedBy: "user", approvedAt: "2026-11-02", approvalRef: "issue comment" },
        state: "not_created",
        record: null,
      };
    }),
    "can only exist after the Go decision",
  );
});

test("fault: version drift between the registry and package.json / manifest blocks", () => {
  assertBlocked(
    mutated((value) => {
      (value.candidate as Record<string, unknown>).version = "9.9.9";
    }),
    "does not equal the package.json version",
  );
  const driftedContext = { ...CONTEXT, packageVersion: "0.1.0" };
  try {
    verifyReleaseCandidate(REGISTRY_RAW, driftedContext);
  } catch (error) {
    assert.ok(error instanceof ReleaseGateError);
    assert.ok(error.problems.some((problem) => problem.includes("does not equal the package.json version")));
    return;
  }
  assert.fail("expected the gate to block (package version drift)");
});

test("the frozen scope id list is pinned (scope changes are reviewed code changes)", () => {
  const registry = verifyReleaseCandidate(REGISTRY_RAW, CONTEXT);
  assert.deepEqual(
    registry.productScope.inScope.map((item) => item.id),
    ["hw-esp32s3", "fw-v252-nulllab", "aec-barge-in", "srv-xiaozhi-private", "real-providers", "skills", "parent-web"],
  );
  assert.deepEqual(
    registry.productScope.excluded.map((item) => item.id),
    ["hw-xvf3800", "child-real-data", "mock-as-real"],
  );
  assert.deepEqual(
    registry.implementationScope.map((item) => item.id),
    ["scope-1-freeze", "scope-2-register-evidence", "scope-3-gonogo", "scope-4-docs-and-automation", "scope-5-demo-flow", "scope-6-user-release-approval"],
  );
  assert.deepEqual(
    registry.acceptanceCriteria.map((item) => item.id),
    ["dod-1", "dod-2", "dod-3", "dod-4"],
  );
});

test("the registry itself is clean of credential shapes and non-synthetic child refs", () => {
  assert.deepEqual(scanForLeaks([{ name: "release-candidate.json", content: REGISTRY_RAW }]), []);
});
