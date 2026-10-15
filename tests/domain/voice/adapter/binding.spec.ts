import assert from "node:assert/strict";
import test from "node:test";

/**
 * R1-V3 trusted device binding tests (issue #30 实现范围 1 + 验收 1: 设备可信
 * 绑定、变更 device_id/冒用 session_id 无法获得儿童会话授权、session_id 不是
 * 儿童永久身份).
 */

import { createGatewayDeviceBindingRegistry } from "../../../../lib/domain/voice/adapter/binding.ts";

const DEVICE = "aabbccddeeff0011";
const ACTOR = "act_owner0001";
const CONVERSATION = "conv_child0001";
const ACTIVATION = "0123456789abcdef0123456789abcdef";

function createRegistry() {
  let nowMs = 1_000;
  return {
    registry: createGatewayDeviceBindingRegistry({ clock: () => nowMs }),
    tick: () => {
      nowMs += 1;
    },
  };
}

test("a device is bound only by a guardian activation and re-binding is digest-checked", () => {
  const { registry } = createRegistry();
  const bound = registry.bindDevice({ deviceId: DEVICE, actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION });
  assert.ok(bound.ok && bound.value.created);
  // Same digest: idempotent re-bind.
  const rebound = registry.bindDevice({ deviceId: DEVICE, actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION });
  assert.ok(rebound.ok && !rebound.value.created);
  // A different activation digest must never re-bind the device.
  const hijack = registry.bindDevice({
    deviceId: DEVICE,
    actorId: "act_attacker01",
    conversationId: "conv_evil0001",
    activationDigest: "ffffffffffffffffffffffffffffffff",
  });
  assert.ok(!hijack.ok && hijack.code === "device_rebinding_denied");
  // Grammar violations fail closed.
  assert.throws(() => registry.bindDevice({ deviceId: "BAD", actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION }));
  const withExtra: Record<string, unknown> = {
    deviceId: DEVICE,
    actorId: ACTOR,
    conversationId: CONVERSATION,
    activationDigest: ACTIVATION,
    extra: 1,
  };
  assert.throws(() => registry.bindDevice(withExtra as Parameters<typeof registry.bindDevice>[0]));
});

test("an unknown device can never open a connection (变更 device_id 无授权)", () => {
  const { registry } = createRegistry();
  const refused = registry.openConnection({ connectionId: "conn_rogue01", deviceId: "ffff0102030405", activationDigest: ACTIVATION });
  assert.ok(!refused.ok && refused.code === "device_unbound");
  // No binding appeared.
  assert.equal(registry.describeBinding("ffff0102030405"), null);
});

test("a bound deviceId without the possession proof can never open a lease (P1: 冒用已绑定 device_id)", () => {
  const { registry } = createRegistry();
  const bound = registry.bindDevice({ deviceId: DEVICE, actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION });
  assert.ok(bound.ok);
  // MAC-only replay (no credential) → enumerated possession denial.
  const missing = registry.openConnection({ connectionId: "conn_spoof01", deviceId: DEVICE, activationDigest: null });
  assert.ok(!missing.ok && missing.code === "device_possession_denied");
  // A malformed credential is an authorization failure, not a parse throw.
  const malformed = registry.openConnection({ connectionId: "conn_spoof02", deviceId: DEVICE, activationDigest: "not-a-digest" });
  assert.ok(!malformed.ok && malformed.code === "device_possession_denied");
  // A WRONG credential is denied too.
  const wrong = registry.openConnection({ connectionId: "conn_spoof03", deviceId: DEVICE, activationDigest: "ffffffffffffffffffffffffffffffff" });
  assert.ok(!wrong.ok && wrong.code === "device_possession_denied");
  // No lease was ever created and the device still accepts the holder.
  assert.equal(registry.hasOpenConnection(DEVICE), false);
  const holder = registry.openConnection({ connectionId: "conn_first01", deviceId: DEVICE, activationDigest: ACTIVATION });
  assert.ok(holder.ok);
  // Possession is checked BEFORE the duplicate-lease rule: a credential-less
  // second connection is a possession denial, not a conflict (no occupancy
  // oracle for credential-less probes).
  const probe = registry.openConnection({ connectionId: "conn_spoof04", deviceId: DEVICE, activationDigest: null });
  assert.ok(!probe.ok && probe.code === "device_possession_denied");
});

test("a device holds at most one connection lease (duplicate connection refused)", () => {
  const { registry } = createRegistry();
  registry.bindDevice({ deviceId: DEVICE, actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION });
  const first = registry.openConnection({ connectionId: "conn_first01", deviceId: DEVICE, activationDigest: ACTIVATION });
  assert.ok(first.ok);
  const second = registry.openConnection({ connectionId: "conn_second", deviceId: DEVICE, activationDigest: ACTIVATION });
  assert.ok(!second.ok && second.code === "device_connection_conflict");
  // After the lease is released, a new connection is possible.
  registry.closeConnection({ connectionId: "conn_first01", reason: "network" });
  const third = registry.openConnection({ connectionId: "conn_third01", deviceId: DEVICE, activationDigest: ACTIVATION });
  assert.ok(third.ok);
});

test("session mapping is connection-scoped; forged ids are enumerated rejections", () => {
  const { registry } = createRegistry();
  registry.bindDevice({ deviceId: DEVICE, actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION });
  registry.openConnection({ connectionId: "conn_first01", deviceId: DEVICE, activationDigest: ACTIVATION });

  // No mapping yet.
  const unmapped = registry.authorize({ connectionId: "conn_first01", xiaozhiSessionId: "sessmock-000001-0001" });
  assert.ok(!unmapped.ok && unmapped.code === "session_not_mapped");

  const issued = registry.issueSession({
    connectionId: "conn_first01",
    sessionKey: "ses_gw0123456789abcdef",
    xiaozhiSessionId: "sessmock-000001-0001",
  });
  assert.ok(issued.ok);

  // Exact match authorizes.
  const ok = registry.authorize({
    connectionId: "conn_first01",
    xiaozhiSessionId: "sessmock-000001-0001",
    sessionKey: "ses_gw0123456789abcdef",
  });
  assert.ok(ok.ok);

  // Foreign session id → forged.
  const forged = registry.authorize({ connectionId: "conn_first01", xiaozhiSessionId: "sessmock-999999-9999" });
  assert.ok(!forged.ok && forged.code === "session_forged");

  // Foreign session key → cross-session.
  const cross = registry.authorize({
    connectionId: "conn_first01",
    xiaozhiSessionId: "sessmock-000001-0001",
    sessionKey: "ses_gwotherdevice001",
  });
  assert.ok(!cross.ok && cross.code === "cross_session_rejected");

  // Unknown connection.
  const unknown = registry.authorize({ connectionId: "conn_ghost01", xiaozhiSessionId: "sessmock-000001-0001" });
  assert.ok(!unknown.ok && unknown.code === "connection_unknown");
});

test("closing the connection invalidates its session mapping (session id is ephemeral)", () => {
  const { registry } = createRegistry();
  registry.bindDevice({ deviceId: DEVICE, actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION });
  registry.openConnection({ connectionId: "conn_first01", deviceId: DEVICE, activationDigest: ACTIVATION });
  registry.issueSession({
    connectionId: "conn_first01",
    sessionKey: "ses_gw0123456789abcdef",
    xiaozhiSessionId: "sessmock-000001-0001",
  });
  registry.closeConnection({ connectionId: "conn_first01", reason: "network" });
  const after = registry.authorize({ connectionId: "conn_first01", xiaozhiSessionId: "sessmock-000001-0001" });
  assert.ok(!after.ok && after.code === "connection_closed");
  assert.equal(registry.mappingSnapshot().length, 0, "the ephemeral mapping is gone");
});

test("server restart closes every lease and mapping at once", () => {
  const { registry } = createRegistry();
  registry.bindDevice({ deviceId: DEVICE, actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION });
  registry.bindDevice({ deviceId: "bbccddee00112233", actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION });
  registry.openConnection({ connectionId: "conn_a", deviceId: DEVICE, activationDigest: ACTIVATION });
  registry.openConnection({ connectionId: "conn_b", deviceId: "bbccddee00112233", activationDigest: ACTIVATION });
  registry.issueSession({ connectionId: "conn_a", sessionKey: "ses_gw0123456789abcdef", xiaozhiSessionId: "sessmock-000001-0001" });
  registry.issueSession({ connectionId: "conn_b", sessionKey: "ses_gwotherdevice001", xiaozhiSessionId: "sessmock-000002-0001" });
  const closed = registry.closeAllConnections({ reason: "server_restart" });
  assert.equal(closed.closed, 2);
  assert.equal(registry.mappingSnapshot().length, 0);
  assert.equal(registry.hasOpenConnection(DEVICE), false);
  const after = registry.authorize({ connectionId: "conn_a", xiaozhiSessionId: "sessmock-000001-0001" });
  assert.ok(!after.ok && after.code === "connection_closed");
});

test("snapshots are content-free (ids, digests, timestamps, states only)", () => {
  const { registry } = createRegistry();
  registry.bindDevice({ deviceId: DEVICE, actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION });
  registry.openConnection({ connectionId: "conn_first01", deviceId: DEVICE, activationDigest: ACTIVATION });
  registry.issueSession({
    connectionId: "conn_first01",
    sessionKey: "ses_gw0123456789abcdef",
    xiaozhiSessionId: "sessmock-000001-0001",
  });
  const allowedKeys = new Set([
    "deviceId",
    "actorId",
    "conversationId",
    "activationDigest",
    "boundAtMs",
    "reboundAtMs",
    "connectionId",
    "openedAtMs",
    "closed",
    "closedAtMs",
    "closedReason",
    "sessionKey",
    "xiaozhiSessionId",
    "issuedAtMs",
  ]);
  for (const entry of [...registry.bindingSnapshot(), ...registry.connectionSnapshot(), ...registry.mappingSnapshot()]) {
    for (const key of Object.keys(entry)) {
      assert.ok(allowedKeys.has(key), `unexpected snapshot field ${key}`);
    }
  }
});

test("capacity exhaustion is an enumerated capacity code, not a parse failure (P2)", () => {
  // maxBindings exhausted at bindDevice.
  const tightBindings = createGatewayDeviceBindingRegistry({ clock: () => 1_000, maxBindings: 1 });
  const first = tightBindings.bindDevice({ deviceId: DEVICE, actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION });
  assert.ok(first.ok);
  const overBindings = tightBindings.bindDevice({
    deviceId: "bbccddee00112233",
    actorId: ACTOR,
    conversationId: CONVERSATION,
    activationDigest: ACTIVATION,
  });
  assert.ok(!overBindings.ok && overBindings.code === "binding_capacity_exceeded");

  // maxConnections exhausted at openConnection.
  const tightConnections = createGatewayDeviceBindingRegistry({ clock: () => 1_000, maxConnections: 1 });
  const boundA = tightConnections.bindDevice({ deviceId: DEVICE, actorId: ACTOR, conversationId: CONVERSATION, activationDigest: ACTIVATION });
  const boundB = tightConnections.bindDevice({
    deviceId: "bbccddee00112233",
    actorId: ACTOR,
    conversationId: CONVERSATION,
    activationDigest: ACTIVATION,
  });
  assert.ok(boundA.ok && boundB.ok);
  const leaseA = tightConnections.openConnection({ connectionId: "conn_a", deviceId: DEVICE, activationDigest: ACTIVATION });
  assert.ok(leaseA.ok);
  const leaseB = tightConnections.openConnection({
    connectionId: "conn_b",
    deviceId: "bbccddee00112233",
    activationDigest: ACTIVATION,
  });
  assert.ok(!leaseB.ok && leaseB.code === "binding_capacity_exceeded");
  // Real parse failures remain parse failures.
  assert.throws(() => tightConnections.openConnection({ connectionId: "BAD ID", deviceId: DEVICE, activationDigest: ACTIVATION }));
  const withExtra: Record<string, unknown> = {
    connectionId: "conn_x",
    deviceId: DEVICE,
    activationDigest: ACTIVATION,
    extra: 1,
  };
  assert.throws(() => tightConnections.openConnection(withExtra as Parameters<typeof tightConnections.openConnection>[0]));
});
