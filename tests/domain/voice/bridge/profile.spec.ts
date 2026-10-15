import assert from "node:assert/strict";
import test from "node:test";

/**
 * R1-V2 bridge profile tests (issue #29 实现范围 1/6): the
 * lumi-dsh-runtime-bridge profile is its own minimal-permission contract —
 * never a reuse of the R0 profile or the official defaults — with a
 * whitelist DERIVED from the single R1-15 source of truth, privacy
 * switches hard-off and loopback-only egress. Every violation fails
 * closed.
 */

import {
  BRIDGE_ALLOWED_EGRESS_DESTINATIONS,
  BRIDGE_DSH_VERSION,
  BRIDGE_FORBIDDEN_PROFILE_IDS,
  BRIDGE_OWNERSHIP_MODE,
  BRIDGE_PROFILE_ID,
  BRIDGE_SWITCH_OFF,
  assertBridgeAdvertisedToolsWithinWhitelist,
  canonicalBridgeProfile,
  describeBridgeProfileTools,
  validateBridgeProfile,
} from "../../../../lib/domain/voice/bridge/profile.ts";
import {
  CORDIS_SERVICE_WHITELIST,
} from "../../../../lib/domain/runtime/cordis.ts";
import { SAFE_TOOL_REGISTRY } from "../../../../lib/domain/safety/index.ts";
import { ContractValidationError } from "../../../../lib/domain/contract/core.ts";

test("the bridge profile pins the locked upstream and its own id", () => {
  const profile = canonicalBridgeProfile();
  assert.equal(profile.profileId, "lumi-dsh-runtime-bridge");
  assert.equal(BRIDGE_PROFILE_ID, "lumi-dsh-runtime-bridge");
  assert.equal(profile.dshVersion, "dsh-v0.2.0-rc.2");
  assert.equal(BRIDGE_DSH_VERSION, "dsh-v0.2.0-rc.2");
  assert.equal(profile.ownership, "bridge_exclusive");
  assert.equal(BRIDGE_OWNERSHIP_MODE, "bridge_exclusive");
});

test("the bridge tool whitelist is exactly the derived SAFE_TOOL_REGISTRY surface", () => {
  const tools = describeBridgeProfileTools();
  const expected = CORDIS_SERVICE_WHITELIST;
  assert.deepEqual([...tools], [...expected]);
  // Single source of truth: every whitelisted id is a registered tool.
  for (const tool of tools) {
    assert.ok(
      Object.hasOwn(SAFE_TOOL_REGISTRY, tool),
      `bridge tool ${tool} must exist in the R1-15 registry`,
    );
  }
  const profile = canonicalBridgeProfile();
  assert.deepEqual(
    [...profile.tools].sort(),
    [...expected].sort(),
  );
});

test("the bridge profile hard-disables telemetry, session logs and crash reporting", () => {
  const profile = canonicalBridgeProfile();
  for (const [name, value] of Object.entries(profile.switches)) {
    assert.equal(value, BRIDGE_SWITCH_OFF, `switch ${name} must be off`);
  }
  assert.deepEqual(Object.keys(profile.switches), ["telemetry", "sessionLog", "crashReporting"]);
});

test("the bridge profile allows loopback-only egress (no public destinations)", () => {
  const profile = canonicalBridgeProfile();
  assert.equal(profile.egress.policy, "loopback_only");
  assert.deepEqual(profile.egress.destinations, [...BRIDGE_ALLOWED_EGRESS_DESTINATIONS]);
  assert.ok(!BRIDGE_ALLOWED_EGRESS_DESTINATIONS.some((d) => !d.startsWith("127.")));
});

test("the forbidden profile list covers the R0 profile and the official defaults", () => {
  for (const forbidden of ["lumithink-child", "sdk", "sdk-minimal"]) {
    assert.ok((BRIDGE_FORBIDDEN_PROFILE_IDS as readonly string[]).includes(forbidden));
  }
});

test("validateBridgeProfile rejects reusing the R0 profile id or official defaults", () => {
  for (const profileId of ["lumithink-child", "sdk", "sdk-minimal"]) {
    assert.throws(
      () =>
        validateBridgeProfile({
          profileId,
          dshVersion: BRIDGE_DSH_VERSION,
          ownership: BRIDGE_OWNERSHIP_MODE,
          tools: describeBridgeProfileTools(),
          switches: { telemetry: "off", sessionLog: "off", crashReporting: "off" },
          egress: { policy: "loopback_only", destinations: ["127.0.0.1"] },
        }),
      ContractValidationError,
      `profile id ${profileId} must be rejected`,
    );
  }
});

test("validateBridgeProfile rejects a wrong pinned upstream version", () => {
  assert.throws(
    () =>
      validateBridgeProfile({
        profileId: BRIDGE_PROFILE_ID,
        dshVersion: "dsh-v0.3.0",
        ownership: BRIDGE_OWNERSHIP_MODE,
        tools: describeBridgeProfileTools(),
        switches: { telemetry: "off", sessionLog: "off", crashReporting: "off" },
        egress: { policy: "loopback_only", destinations: ["127.0.0.1"] },
      }),
    ContractValidationError,
  );
});

test("validateBridgeProfile rejects any tool outside the derived whitelist", () => {
  const tools = describeBridgeProfileTools();
  assert.throws(
    () =>
      validateBridgeProfile({
        profileId: BRIDGE_PROFILE_ID,
        dshVersion: BRIDGE_DSH_VERSION,
        ownership: BRIDGE_OWNERSHIP_MODE,
        tools: [...tools, "shell.exec"],
        switches: { telemetry: "off", sessionLog: "off", crashReporting: "off" },
        egress: { policy: "loopback_only", destinations: ["127.0.0.1"] },
      }),
    ContractValidationError,
  );
  // Dropping one tool also fails: the whitelist is exact, not "subset of".
  assert.throws(
    () =>
      validateBridgeProfile({
        profileId: BRIDGE_PROFILE_ID,
        dshVersion: BRIDGE_DSH_VERSION,
        ownership: BRIDGE_OWNERSHIP_MODE,
        tools: tools.slice(1),
        switches: { telemetry: "off", sessionLog: "off", crashReporting: "off" },
        egress: { policy: "loopback_only", destinations: ["127.0.0.1"] },
      }),
    ContractValidationError,
  );
});

test("validateBridgeProfile fails closed on any non-off privacy switch", () => {
  const tools = describeBridgeProfileTools();
  const base = {
    profileId: BRIDGE_PROFILE_ID,
    dshVersion: BRIDGE_DSH_VERSION,
    ownership: BRIDGE_OWNERSHIP_MODE,
    tools,
    switches: { telemetry: "off", sessionLog: "off", crashReporting: "off" },
    egress: { policy: "loopback_only", destinations: ["127.0.0.1"] },
  };
  for (const switchName of ["telemetry", "sessionLog", "crashReporting"]) {
    assert.throws(
      () =>
        validateBridgeProfile({
          ...base,
          switches: { ...base.switches, [switchName]: "on" },
        }),
      ContractValidationError,
      `${switchName}=on must be rejected`,
    );
  }
});

test("validateBridgeProfile fails closed on non-loopback egress", () => {
  const tools = describeBridgeProfileTools();
  const base = {
    profileId: BRIDGE_PROFILE_ID,
    dshVersion: BRIDGE_DSH_VERSION,
    ownership: BRIDGE_OWNERSHIP_MODE,
    tools,
    switches: { telemetry: "off", sessionLog: "off", crashReporting: "off" },
  };
  assert.throws(
    () =>
      validateBridgeProfile({
        ...base,
        egress: { policy: "loopback_only", destinations: ["127.0.0.1", "api.example.com"] },
      }),
    ContractValidationError,
  );
  assert.throws(
    () =>
      validateBridgeProfile({
        ...base,
        egress: { policy: "public", destinations: ["127.0.0.1"] },
      }),
    ContractValidationError,
  );
});

test("validateBridgeProfile rejects unknown fields and non-object shapes", () => {
  const tools = describeBridgeProfileTools();
  assert.throws(
    () =>
      validateBridgeProfile({
        profileId: BRIDGE_PROFILE_ID,
        dshVersion: BRIDGE_DSH_VERSION,
        ownership: BRIDGE_OWNERSHIP_MODE,
        tools,
        switches: { telemetry: "off", sessionLog: "off", crashReporting: "off" },
        egress: { policy: "loopback_only", destinations: ["127.0.0.1"] },
        extra: true,
      }),
    ContractValidationError,
  );
  assert.throws(() => validateBridgeProfile(null), ContractValidationError);
  assert.throws(() => validateBridgeProfile([BRIDGE_PROFILE_ID]), ContractValidationError);
});

test("composition-tree assertion rejects unknown advertised tools", () => {
  const violations = assertBridgeAdvertisedToolsWithinWhitelist([
    { name: "evidence.search", description: "" },
    { name: "shell.exec", description: "" },
  ]);
  assert.deepEqual(violations, ["shell.exec"]);
});
