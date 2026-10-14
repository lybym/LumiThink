import assert from "node:assert/strict";
import test from "node:test";

import {
  DANGEROUS_PERMISSIONS,
  DANGEROUS_TOOL_CATEGORIES,
  evaluateToolGate,
  SAFE_TOOL_REGISTRY,
  type ToolCallCandidate,
} from "../../../lib/domain/safety/tool-gate.ts";

const FIXED_AT = "2026-10-13T12:00:00.000Z";

function candidate(overrides: Partial<ToolCallCandidate>): ToolCallCandidate {
  return {
    toolId: "evidence.search",
    declaredCategory: "evidence_read",
    declaredVersion: "1.0",
    requestedPermissions: ["evidence.read"],
    actorRole: "child",
    ...overrides,
  };
}

test("registered whitelist tools pass for allowed roles", () => {
  for (const toolId of Object.keys(SAFE_TOOL_REGISTRY)) {
    const spec = SAFE_TOOL_REGISTRY[toolId];
    for (const role of spec.allowedRoles) {
      const result = evaluateToolGate(
        candidate({
          toolId,
          declaredCategory: spec.category,
          declaredVersion: spec.version,
          requestedPermissions: [...spec.permissions],
          actorRole: role,
        }),
        { decidedAt: FIXED_AT },
      );
      assert.equal(result.decision, "allow", `${toolId} as ${role}`);
      assert.deepEqual([...result.hits], []);
      assert.equal(result.trace.policyVersion, "1.0");
      assert.equal(result.trace.layer, "tool");
    }
  }
});

test("v0 whitelist matches the HARNESS tool candidates (least privilege)", () => {
  assert.deepEqual(Object.keys(SAFE_TOOL_REGISTRY).sort(), ["evidence.search", "memory.lookup", "memory.propose"]);
  assert.equal(SAFE_TOOL_REGISTRY["memory.propose"].sideEffects, "memory_candidate");
  assert.equal(SAFE_TOOL_REGISTRY["evidence.search"].sideEffects, "read_only");
  assert.ok(DANGEROUS_TOOL_CATEGORIES.includes("shell"));
  assert.ok(DANGEROUS_TOOL_CATEGORIES.includes("arbitrary_fs"));
  assert.ok(DANGEROUS_TOOL_CATEGORIES.includes("arbitrary_network"));
  assert.ok(DANGEROUS_TOOL_CATEGORIES.includes("plugin_install"));
  assert.ok(DANGEROUS_TOOL_CATEGORIES.includes("subagent_spawn"));
  assert.ok(DANGEROUS_TOOL_CATEGORIES.includes("raw_db"));
  assert.ok(DANGEROUS_PERMISSIONS.includes("memory.direct_write"));
  assert.ok(DANGEROUS_PERMISSIONS.includes("child_data.export"));
});

test("unregistered tools are refused without echoing the id", () => {
  for (const toolId of ["shell.exec", "fs.read.any", "net.fetch.raw", "db.raw.sql", "totally_unknown"]) {
    const result = evaluateToolGate(candidate({ toolId }));
    assert.equal(result.decision, "block", `${toolId} must be unregistered`);
    assert.ok(result.hits.some((hit) => hit.ruleId === "tool.unregistered"));
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(toolId), "refusal must not echo the submitted tool id");
  }
});

test("dangerous categories and permissions are blocked outright (issue #27 交付范围 2)", () => {
  const dangerousCategory = evaluateToolGate(candidate({ declaredCategory: "shell" }));
  assert.equal(dangerousCategory.decision, "block");
  assert.ok(dangerousCategory.hits.some((hit) => hit.ruleId === "tool.dangerous_category"));

  for (const permission of ["shell.exec", "net.fetch", "fs.write", "plugin.install", "subagent.spawn", "db.raw_sql"]) {
    const result = evaluateToolGate(candidate({ requestedPermissions: [permission] }));
    assert.equal(result.decision, "block", `${permission} must block`);
    assert.ok(result.hits.some((hit) => hit.ruleId === "tool.dangerous_category"), permission);
  }
});

test("tool schema forgery is blocked (issue #27 AC 1)", () => {
  // Registered tool id, but the descriptor lies about its category.
  const forgedCategory = evaluateToolGate(
    candidate({ declaredCategory: "memory_read" }),
  );
  assert.equal(forgedCategory.decision, "block");
  assert.ok(forgedCategory.hits.some((hit) => hit.ruleId === "tool.schema_forgery"));

  // Registered tool id, but the version does not match the registry.
  const forgedVersion = evaluateToolGate(candidate({ declaredVersion: "9.9" }));
  assert.equal(forgedVersion.decision, "block");
  assert.ok(forgedVersion.hits.some((hit) => hit.ruleId === "tool.schema_forgery"));
});

test("direct memory writes are blocked; only the candidate path exists", () => {
  const result = evaluateToolGate(
    candidate({ toolId: "memory.propose", declaredCategory: "memory_propose", requestedPermissions: ["memory.direct_write"] }),
  );
  assert.equal(result.decision, "block");
  assert.ok(result.hits.some((hit) => hit.ruleId === "tool.memory_write_unauthorized"));

  // The plain proposal path itself is allowed.
  const proposal = evaluateToolGate(candidate({ toolId: "memory.propose", declaredCategory: "memory_propose", requestedPermissions: ["memory.propose"] }));
  assert.equal(proposal.decision, "allow");
});

test("privacy overreach: forbidden data permissions and unauthorized roles", () => {
  const exportAttempt = evaluateToolGate(candidate({ requestedPermissions: ["child_data.export"] }));
  assert.ok(exportAttempt.hits.some((hit) => hit.ruleId === "tool.privacy_overreach"));

  const audioAttempt = evaluateToolGate(candidate({ requestedPermissions: ["raw_audio.read"] }));
  assert.ok(audioAttempt.hits.some((hit) => hit.ruleId === "tool.privacy_overreach"));

  // voice_device has no text-turn tool permissions in v0.
  const deviceCall = evaluateToolGate(candidate({ actorRole: "voice_device" }));
  assert.equal(deviceCall.decision, "block");
  assert.ok(deviceCall.hits.some((hit) => hit.ruleId === "tool.privacy_overreach"));
});

test("multiple violations accumulate into one blocking trace", () => {
  const result = evaluateToolGate(
    candidate({
      toolId: "shell.exec",
      declaredCategory: "shell",
      declaredVersion: "1.0",
      requestedPermissions: ["shell.exec", "memory.direct_write"],
    }),
  );
  assert.equal(result.decision, "block");
  const ids = result.hits.map((hit) => hit.ruleId);
  assert.ok(ids.includes("tool.unregistered"));
  assert.ok(ids.includes("tool.dangerous_category"));
  assert.ok(ids.includes("tool.memory_write_unauthorized"));
  assert.equal(result.trace.ruleIds.length, ids.length, "traces dedupe to the same rule set");
});

test("tool gate results never echo arguments", () => {
  const canary = "CANARY-ARGUMENTS-保密";
  const result = evaluateToolGate(
    candidate({ input: { query: `reveal ${canary}` } }),
  );
  assert.equal(result.decision, "allow");
  assert.ok(!JSON.stringify(result).includes("CANARY"));
});

test("invalid candidates fail closed", () => {
  assert.throws(() => evaluateToolGate(null as unknown as ToolCallCandidate));
  assert.throws(() =>
    evaluateToolGate(candidate({ actorRole: "hacker" as ToolCallCandidate["actorRole"] })),
  );
  assert.throws(() =>
    evaluateToolGate(candidate({ requestedPermissions: "shell.exec" as unknown as string[] })),
  );
});

test("registered tool requesting an unregistered permission is blocked (positive whitelist, review P1-1)", () => {
  // evidence.search is registered, but evidence.write is not part of its
  // registered permission set — requesting it is a privilege-escalation
  // attempt and must never be silently ignored.
  const overreach = evaluateToolGate(
    candidate({ requestedPermissions: ["evidence.write"] }),
    { decidedAt: FIXED_AT },
  );
  assert.equal(overreach.decision, "block");
  assert.ok(overreach.hits.some((hit) => hit.ruleId === "tool.permission_overreach"));
  assert.ok(overreach.trace.ruleIds.includes("tool.permission_overreach"));

  // A valid permission does not launder an unregistered sibling entry.
  const mixed = evaluateToolGate(
    candidate({ requestedPermissions: ["evidence.read", "evidence.write"] }),
  );
  assert.equal(mixed.decision, "block");
  assert.ok(mixed.hits.some((hit) => hit.ruleId === "tool.permission_overreach"));

  // No registered tool may acquire foreign permissions.
  for (const [toolId, spec] of Object.entries(SAFE_TOOL_REGISTRY)) {
    const foreign = evaluateToolGate(
      candidate({
        toolId,
        declaredCategory: spec.category,
        declaredVersion: spec.version,
        requestedPermissions: ["evidence.write"],
        actorRole: spec.allowedRoles[0],
      }),
    );
    assert.equal(foreign.decision, "block", `${toolId} must not get unregistered permissions`);
    assert.ok(foreign.hits.some((hit) => hit.ruleId === "tool.permission_overreach"), toolId);
  }
});

test("non-string permission entries fail closed instead of being dropped (review P1-1)", () => {
  const malformed = evaluateToolGate(
    candidate({ requestedPermissions: [42, { evil: true }] as unknown as string[] }),
    { decidedAt: FIXED_AT },
  );
  assert.equal(malformed.decision, "block");
  assert.ok(malformed.hits.some((hit) => hit.ruleId === "tool.schema_forgery"));
  assert.ok(
    malformed.trace.ruleIds.includes("tool.schema_forgery"),
    "the malformed descriptor is recorded structurally",
  );
  // Nothing about the malformed entries is echoed.
  const serialized = JSON.stringify(malformed);
  assert.ok(!serialized.includes("evil"));
  assert.ok(!serialized.includes("42"));
});

test("prototype-chain tool ids can never masquerade as registered (carried #27 review, R1-05 hard precondition)", () => {
  // With a plain-object registry, ids like "constructor"/"toString" inherited
  // Object.prototype members, were misread as "registered", and then crashed
  // the gate with a bare TypeError instead of a structured block.
  const registryTarget = SAFE_TOOL_REGISTRY as Record<string, unknown>;
  for (const toolId of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
    const result = evaluateToolGate(
      candidate({
        toolId,
        // Forgery-style descriptors a crafted caller would pair with the id.
        declaredCategory: "evidence_read",
        declaredVersion: "1.0",
        requestedPermissions: ["evidence.read"],
      }),
      { decidedAt: FIXED_AT },
    );
    assert.equal(result.decision, "block", `${toolId} must be treated as unregistered`);
    assert.ok(result.hits.some((hit) => hit.ruleId === "tool.unregistered"), toolId);
    // The registry must not answer prototype lookups at all.
    assert.equal(Object.hasOwn(registryTarget, toolId), false, toolId);
  }
  // The gate returns a STRUCTURED block (no throw) for the crafted ids.
  const structured = evaluateToolGate(candidate({ toolId: "constructor" }));
  assert.equal(structured.trace.layer, "tool");
  assert.ok(structured.trace.ruleIds.includes("tool.unregistered"));
});
