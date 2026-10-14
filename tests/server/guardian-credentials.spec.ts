/**
 * R1-08 guardian real-credential tests (issue #20; ADR-0003 disposition).
 * With injected SHA-256 digests the login verifies against the REAL access
 * codes and the published synthetic demo codes are rejected; raw values
 * never enter the service (digests only) and never leak into the audit.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  createGuardianService,
  GUARDIAN_DEMO_ACCESS_CODE,
  ADMIN_DEMO_ACCESS_CODE,
} from "../../lib/server/guardian-service.ts";

const REAL_GUARDIAN = "deployment-guardian-code-2026";
const REAL_ADMIN = "deployment-admin-code-2026";

function digests(): { guardian: string; admin: string } {
  return {
    guardian: createHash("sha256").update(REAL_GUARDIAN, "utf8").digest("hex"),
    admin: createHash("sha256").update(REAL_ADMIN, "utf8").digest("hex"),
  };
}

function loginCode(
  service: ReturnType<typeof createGuardianService>,
  code: string,
): { kind: string; httpStatus?: number } {
  const result = service.sessionLogin({ body: { protocolVersion: "1.0", accessCode: code } });
  return { kind: result.kind, httpStatus: result.kind === "error" ? result.httpStatus : undefined };
}

test("R1-08: with real digests the demo codes are rejected and real codes verify", () => {
  const service = createGuardianService({ credentialDigests: digests() });
  assert.equal(service.credentialMode(), "real");
  assert.equal(loginCode(service, GUARDIAN_DEMO_ACCESS_CODE).kind, "error");
  assert.equal(loginCode(service, ADMIN_DEMO_ACCESS_CODE).kind, "error");
  assert.equal(loginCode(service, REAL_GUARDIAN).kind, "ok");
  assert.equal(loginCode(service, REAL_ADMIN).kind, "ok");
  // The credential-mode seed disclosure is in the audit ring.
  const modes = service
    .auditEntries()
    .filter((entry) => entry.target === "credential_mode")
    .map((entry) => entry.detail);
  assert.ok(modes.includes("real"));
});

test("R1-08: without digests the disclosed demo mode applies unchanged", () => {
  const service = createGuardianService();
  assert.equal(service.credentialMode(), "demo");
  assert.equal(loginCode(service, GUARDIAN_DEMO_ACCESS_CODE).kind, "ok");
  assert.equal(loginCode(service, ADMIN_DEMO_ACCESS_CODE).kind, "ok");
  assert.equal(loginCode(service, REAL_GUARDIAN).kind, "error");
});

test("R1-08: raw real codes never appear in the audit ring (no-echo)", () => {
  const service = createGuardianService({ credentialDigests: digests() });
  // Failed + successful logins, lockout path.
  loginCode(service, "wrong-code-aaaa");
  loginCode(service, REAL_GUARDIAN);
  const serialized = JSON.stringify(service.auditEntries());
  assert.equal(serialized.includes(REAL_GUARDIAN), false);
  assert.equal(serialized.includes(REAL_ADMIN), false);
  assert.equal(serialized.includes(digests().guardian), false);
  assert.equal(serialized.includes(digests().admin), false);
});

test("R1-08: malformed digests fail the construction (fail-closed)", () => {
  assert.throws(
    () =>
      createGuardianService({
        credentialDigests: { guardian: "not-hex", admin: digests().admin },
      }),
    (error: unknown) => {
      const problems = (error as { problems?: readonly { path?: string }[] })?.problems ?? [];
      return problems.some((entry) => (entry.path ?? "").includes("credentialDigests"));
    },
  );
});
