/**
 * R1-08 CSP middleware tests (issue #20 AC 4 基础安全头核验; ADR-0003
 * decision 4 carried to R1-08). The header logic is a pure function; the
 * middleware.ts wrapper is verified in CI by the deployment smoke (real
 * Next.js request path + build).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContentSecurityPolicy,
  CSP_NONCE_HEADER,
  CSP_RESPONSE_HEADER,
} from "../../lib/server/security-headers.ts";

const NONCE = "abcd1234abcd1234abcd1234abcd1234";

test("production CSP pins the per-request nonce with strict-dynamic and denies embedding", () => {
  const csp = buildContentSecurityPolicy(NONCE, "production");
  assert.match(csp, new RegExp(`script-src 'nonce-${NONCE}' 'strict-dynamic'`));
  assert.equal(csp.includes("unsafe-eval"), false, "production must not allow eval");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  assert.match(csp, /img-src 'self' data:/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

test("development CSP keeps the tooling escape hatch but the same nonce discipline", () => {
  const csp = buildContentSecurityPolicy(NONCE, "development");
  assert.match(csp, new RegExp(`script-src 'self' 'nonce-${NONCE}' 'strict-dynamic' 'unsafe-eval'`));
});

test("a malformed nonce fails closed to a fixed placeholder (never an unnonced policy)", () => {
  const csp = buildContentSecurityPolicy("", "production");
  assert.match(csp, /script-src 'nonce-missing-nonce' 'strict-dynamic'/);
  assert.doesNotMatch(csp, /'nonce-'/);
});

test("header names are the documented constants", () => {
  assert.equal(CSP_NONCE_HEADER, "x-lumithink-csp-nonce");
  assert.equal(CSP_RESPONSE_HEADER, "Content-Security-Policy");
});
