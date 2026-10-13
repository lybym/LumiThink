import assert from "node:assert/strict";
import test from "node:test";

import {
  assertAdvertisedToolsWithinWhitelist,
  CORDIS_SERVICE_WHITELIST,
  cordisToolIdFromModelName,
  describeCordisSurface,
  describeCordisToolSchema,
  executeCordisServiceCall,
  type CordisServiceHandler,
} from "../../../lib/domain/runtime/cordis.ts";
import { SAFE_TOOL_REGISTRY } from "../../../lib/domain/safety/index.ts";
import { MAX_MODEL_REQUEST_TOOLS } from "../../../lib/domain/gateway/types.ts";

test("the Cordis whitelist is exactly the safety tool registry (composition-tree assertion)", () => {
  assert.deepEqual([...CORDIS_SERVICE_WHITELIST], Object.keys(SAFE_TOOL_REGISTRY));
  const surface = describeCordisSurface();
  assert.equal(surface.length, CORDIS_SERVICE_WHITELIST.length);
  for (const entry of surface) {
    const registered = SAFE_TOOL_REGISTRY[entry.toolId];
    assert.ok(registered !== undefined);
    assert.equal(entry.category, registered.category);
    assert.equal(entry.version, registered.version);
    assert.equal(entry.sideEffects, registered.sideEffects);
    assert.deepEqual([...entry.permissions], [...registered.permissions]);
    assert.deepEqual([...entry.allowedRoles], [...registered.allowedRoles]);
  }
});

test("the model-visible tool schema whitelist is bounded and descriptive", () => {
  const schema = describeCordisToolSchema();
  assert.ok(schema.length > 0);
  assert.ok(schema.length <= MAX_MODEL_REQUEST_TOOLS);
  // The gateway model-tool grammar has no dots: the whitelist ids map to
  // model names via a deterministic dot→underscore rename, reversible
  // through cordisToolIdFromModelName.
  assert.deepEqual(
    schema.map((tool) => tool.name),
    ["evidence_search", "memory_lookup", "memory_propose"],
  );
  for (const tool of schema) {
    assert.equal(cordisToolIdFromModelName(tool.name), tool.name.replace(/_/g, "."));
    assert.ok(tool.description.length > 0);
    assert.ok(tool.description.length <= 500);
  }
  assert.equal(cordisToolIdFromModelName("shell"), null);
  assert.equal(cordisToolIdFromModelName(42), null);
});

test("a DSH port advertising tools outside the whitelist is a composition-tree violation", () => {
  const compliant = assertAdvertisedToolsWithinWhitelist(describeCordisToolSchema());
  assert.deepEqual([...compliant], []);
  const violating = assertAdvertisedToolsWithinWhitelist([
    { name: "evidence.search", description: "ok" },
    { name: "shell", description: "MUST NEVER APPEAR" },
    { name: "plugin-manager", description: "MUST NEVER APPEAR" },
  ]);
  assert.deepEqual([...violating], ["shell", "plugin-manager"]);
  const malformed = assertAdvertisedToolsWithinWhitelist([
    { name: 42, description: "not a string" },
  ]);
  assert.deepEqual([...malformed], ["[unverified]"]);
});

const BASE_CALL = {
  callId: "call-0001",
  toolId: "evidence.search",
  declaredCategory: "evidence_read",
  declaredVersion: "1.0",
  requestedPermissions: ["evidence.read"],
};

test("a whitelisted call with a bound handler executes and returns structural refs", async () => {
  const handlerSaw: { value: { readonly toolId: string; readonly actorRole: string } | null } = {
    value: null,
  };
  const execution = await executeCordisServiceCall(BASE_CALL, {
    actorRole: "child",
    handlers: {
      "evidence.search": async ({ call, actorRole }) => {
        handlerSaw.value = { toolId: call.toolId, actorRole };
        return {
          ok: true,
          refs: [{ kind: "evidence", refId: "ev_synthetic_card_01", version: "1.0.0" }],
          candidateOnly: false,
        };
      },
    },
  });
  assert.equal(execution.status, "executed");
  assert.equal(handlerSaw.value?.toolId, "evidence.search");
  assert.equal(handlerSaw.value?.actorRole, "child");
  assert.equal(execution.status === "executed" ? execution.toolVersion : null, "1.0");
  assert.equal(execution.status === "executed" ? execution.refs[0]?.refId : null, "ev_synthetic_card_01");
  assert.equal(execution.status === "executed" ? execution.trace.layer : null, "tool");
});

test("unregistered and dangerous tools are rejected fail-closed; no handler is ever consulted", async () => {
  let handlerCalls = 0;
  const handlers: Record<string, CordisServiceHandler> = {
    "evidence.search": async () => {
      handlerCalls += 1;
      return { ok: true, refs: [], candidateOnly: false };
    },
  };

  const unregistered = await executeCordisServiceCall(
    { ...BASE_CALL, toolId: "shell.exec", declaredCategory: "shell", requestedPermissions: ["shell.exec"] },
    { actorRole: "child", handlers },
  );
  assert.equal(unregistered.status, "rejected");
  assert.ok((unregistered.status === "rejected" ? unregistered.ruleIds : []).includes("tool.unregistered"));
  assert.ok((unregistered.status === "rejected" ? unregistered.ruleIds : []).includes("tool.dangerous_category"));

  const bash = await executeCordisServiceCall(
    { ...BASE_CALL, toolId: "bash", declaredCategory: "shell", requestedPermissions: [] },
    { actorRole: "child", handlers },
  );
  assert.equal(bash.status, "rejected");

  const pluginManager = await executeCordisServiceCall(
    { ...BASE_CALL, toolId: "plugin.install", declaredCategory: "plugin_install", requestedPermissions: ["plugin.install"] },
    { actorRole: "child", handlers },
  );
  assert.equal(pluginManager.status, "rejected");

  assert.equal(handlerCalls, 0, "no handler may run for rejected calls");
});

test("permission overreach, schema forgery and unauthorized roles are rejected", async () => {
  const overreach = await executeCordisServiceCall(
    { ...BASE_CALL, requestedPermissions: ["evidence.read", "fs.read"] },
    { actorRole: "child" },
  );
  assert.equal(overreach.status, "rejected");
  assert.ok((overreach.status === "rejected" ? overreach.ruleIds : []).includes("tool.dangerous_category"));

  const memoryWrite = await executeCordisServiceCall(
    {
      callId: "call-0002",
      toolId: "memory.propose",
      declaredCategory: "memory_propose",
      declaredVersion: "1.0",
      requestedPermissions: ["memory.propose", "memory.direct_write"],
    },
    { actorRole: "child" },
  );
  assert.equal(memoryWrite.status, "rejected");
  assert.ok(
    (memoryWrite.status === "rejected" ? memoryWrite.ruleIds : []).includes("tool.memory_write_unauthorized"),
  );

  const forged = await executeCordisServiceCall(
    { ...BASE_CALL, declaredVersion: "9.9" },
    { actorRole: "child" },
  );
  assert.equal(forged.status, "rejected");
  assert.ok((forged.status === "rejected" ? forged.ruleIds : []).includes("tool.schema_forgery"));

  const voiceDevice = await executeCordisServiceCall(BASE_CALL, { actorRole: "voice_device" });
  assert.equal(voiceDevice.status, "rejected");
  assert.ok((voiceDevice.status === "rejected" ? voiceDevice.ruleIds : []).includes("tool.privacy_overreach"));
});

test("a whitelisted tool without a bound handler fails closed instead of inventing a result", async () => {
  const execution = await executeCordisServiceCall(BASE_CALL, { actorRole: "child" });
  assert.equal(execution.status, "failed");
});

test("handler exceptions and malformed results collapse to structural failures", async () => {
  const throwing = await executeCordisServiceCall(BASE_CALL, {
    actorRole: "child",
    handlers: {
      "evidence.search": async () => {
        throw new Error("internal explosion detail must never escape");
      },
    },
  });
  assert.equal(throwing.status, "failed");

  const malformed = await executeCordisServiceCall(BASE_CALL, {
    actorRole: "child",
    handlers: {
      "evidence.search": async () => ({ ok: true, refs: [{ kind: "evidence", refId: "", version: null }], candidateOnly: false }),
    },
  });
  assert.equal(malformed.status, "failed");
});

test("memory.propose is candidate-only regardless of what its handler returns", async () => {
  const execution = await executeCordisServiceCall(
    {
      callId: "call-0003",
      toolId: "memory.propose",
      declaredCategory: "memory_propose",
      declaredVersion: "1.0",
      requestedPermissions: ["memory.propose"],
    },
    {
      actorRole: "child",
      handlers: {
        "memory.propose": async () => ({
          ok: true,
          refs: [{ kind: "memory", refId: "mem_candidate_0001", version: null }],
          candidateOnly: false,
        }),
      },
    },
  );
  assert.equal(execution.status, "executed");
  assert.equal(execution.status === "executed" ? execution.candidateOnly : null, true);
});

test("malformed call shapes throw structured validation errors", async () => {
  await assert.rejects(() => executeCordisServiceCall(null, { actorRole: "child" }));
  await assert.rejects(() =>
    executeCordisServiceCall({ ...BASE_CALL, intruder: "field" }, { actorRole: "child" }),
  );
  await assert.rejects(() =>
    executeCordisServiceCall({ ...BASE_CALL, requestedPermissions: [42] }, { actorRole: "child" }),
  );
});
