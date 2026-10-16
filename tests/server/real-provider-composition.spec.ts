/**
 * E2E-03 (issue #53) real-provider activation + composition tests.
 *
 * Proves the fail-closed activation gates (issue #53 实施范围 1/3, DoD 2/3/4):
 * - the route selector defaults to mock and CI never constructs egress;
 * - `LUMITHINK_MODEL_ROUTE=real` without the FULL reviewed provider record
 *   fails closed, listing variable NAMES only (no values echoed);
 * - the composed gateway keeps the single-provider route and the gateway's
 *   own redacted config view (origin-only baseURL, key presence flag only);
 * - the credential is resolved at REQUEST time: with no key configured every
 *   request fails closed as GATEWAY_AUTH_FAILED and the (loopback) vendor is
 *   never contacted;
 * - the main app composition root stays mock-only even with a complete real
 *   activation env in the process environment (production wiring is a
 *   declared follow-up task, issue #53 review r1 P2-3);
 * - the child-data egress review status is a locked constant (DoD 4).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";

import {
  CHILD_DATA_EGRESS_REVIEW_STATUS,
  RealProviderActivationError,
  buildRealProviderGateway,
  parseRealProviderActivation,
  REAL_PROVIDER_ENV_VARS,
  REAL_PROVIDER_ID,
  type RealProviderActivationRecord,
} from "../../lib/server/real-provider-composition.ts";
import { GatewayError } from "../../lib/domain/gateway/index.ts";
import { createWebMvpRuntime, WEB_MVP_PROVIDER_ID } from "../../lib/server/web-mvp-runtime.ts";

/** A complete, valid activation env for a LOOPBACK synthetic vendor (tests only). */
function validRealEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    LUMITHINK_MODEL_ROUTE: "real",
    LUMITHINK_REAL_PROVIDER_BASEURL: "http://127.0.0.1:9",
    LUMITHINK_REAL_PROVIDER_MODEL_ID: "deepseek-v4-flash",
    LUMITHINK_REAL_PROVIDER_REVIEWER: "e2e03-test-reviewer",
    LUMITHINK_REAL_PROVIDER_REVIEW_REASON: "synthetic loopback activation for issue #53 tests",
    LUMITHINK_REAL_PROVIDER_MAX_OUTPUT_TOKENS: "1024",
    LUMITHINK_REAL_PROVIDER_INPUT_MICRO_USD_PER_MTOKEN: "1000",
    LUMITHINK_REAL_PROVIDER_OUTPUT_MICRO_USD_PER_MTOKEN: "2000",
    LUMITHINK_REAL_PROVIDER_MAX_REQUESTS_PER_DAY: "100",
    LUMITHINK_REAL_PROVIDER_MAX_COST_MICRO_USD_PER_DAY: "5000000",
    LUMITHINK_REAL_PROVIDER_MAX_TOTAL_TOKENS_PER_DAY: "1000000",
    LUMITHINK_REAL_PROVIDER_REQUEST_TIMEOUT_MS: "30000",
    LUMITHINK_REAL_PROVIDER_RETRY_MAX_ATTEMPTS: "1",
    LUMITHINK_REAL_PROVIDER_RETRY_BACKOFF_BASE_MS: "10",
    LUMITHINK_REAL_PROVIDER_BREAKER_FAILURE_THRESHOLD: "3",
    LUMITHINK_REAL_PROVIDER_BREAKER_COOLDOWN_MS: "60000",
    ...overrides,
  };
}

test("the route selector defaults to mock and never constructs egress", () => {
  assert.deepEqual(parseRealProviderActivation({}), { mode: "mock" });
  assert.deepEqual(parseRealProviderActivation({ LUMITHINK_MODEL_ROUTE: "mock" }), { mode: "mock" });
});

test("route=real without the full reviewed record fails closed, naming variables only", () => {
  try {
    parseRealProviderActivation({ LUMITHINK_MODEL_ROUTE: "real" });
    assert.fail("activation must fail closed");
  } catch (error) {
    assert.ok(error instanceof RealProviderActivationError);
    const joined = error.problems.join("\n");
    for (const name of [
      "LUMITHINK_REAL_PROVIDER_BASEURL",
      "LUMITHINK_REAL_PROVIDER_MODEL_ID",
      "LUMITHINK_REAL_PROVIDER_REVIEWER",
      "LUMITHINK_REAL_PROVIDER_REVIEW_REASON",
      "LUMITHINK_REAL_PROVIDER_MAX_OUTPUT_TOKENS",
      "LUMITHINK_REAL_PROVIDER_MAX_REQUESTS_PER_DAY",
      "LUMITHINK_REAL_PROVIDER_REQUEST_TIMEOUT_MS",
      "LUMITHINK_REAL_PROVIDER_RETRY_MAX_ATTEMPTS",
      "LUMITHINK_REAL_PROVIDER_BREAKER_COOLDOWN_MS",
    ]) {
      assert.ok(joined.includes(name), `problem must name ${name}`);
    }
    assert.ok(joined.length < 2000, "problems stay bounded");
  }
});

test("route=real rejects unknown selector values and malformed fields without echoing values", () => {
  assert.throws(
    () => parseRealProviderActivation({ LUMITHINK_MODEL_ROUTE: "yes" }),
    (error: unknown) => error instanceof RealProviderActivationError && error.problems.length === 1,
  );
  const dirtyModel = "EVADED-model-value-should-never-echo";
  try {
    parseRealProviderActivation(validRealEnv({ LUMITHINK_REAL_PROVIDER_MODEL_ID: dirtyModel }));
    assert.fail("invalid model id must fail");
  } catch (error) {
    assert.ok(error instanceof RealProviderActivationError);
    assert.ok(!JSON.stringify(error.problems).includes(dirtyModel), "submitted values are never echoed");
  }
  assert.throws(
    () => parseRealProviderActivation(validRealEnv({ LUMITHINK_REAL_PROVIDER_RETRY_MAX_ATTEMPTS: "6" })),
    (error: unknown) => error instanceof RealProviderActivationError,
  );
  assert.throws(
    () => parseRealProviderActivation(validRealEnv({ LUMITHINK_REAL_PROVIDER_MAX_OUTPUT_TOKENS: "0" })),
    (error: unknown) => error instanceof RealProviderActivationError,
  );
  assert.throws(
    () => parseRealProviderActivation(validRealEnv({ LUMITHINK_REAL_PROVIDER_REQUEST_TIMEOUT_MS: "999999" })),
    (error: unknown) => error instanceof RealProviderActivationError,
  );
});

/** Parse `env` and return the real-mode record (asserts real mode). */
function realRecord(env: Record<string, string | undefined>): RealProviderActivationRecord {
  const activation = parseRealProviderActivation(env);
  assert.equal(activation.mode, "real");
  if (activation.mode !== "real") throw new Error("unreachable");
  return activation.record;
}

test("a complete activation record carries the data-egress review and gateway grammar facts", () => {
  const record = realRecord(validRealEnv());
  assert.equal(record.providerId, REAL_PROVIDER_ID);
  assert.equal(record.modelId, "deepseek-v4-flash");
  assert.equal(record.dataEgressReview.acknowledgeDataEgressReview, true);
  assert.equal(record.dataEgressReview.reviewer, "e2e03-test-reviewer");
  assert.ok(record.budget.maxRequestsPerDay > 0);
});

test("the composed gateway exposes the redacted view: origin-only baseURL, key presence flag only", () => {
  const { gateway, modelId, providerId } = buildRealProviderGateway(
    realRecord(validRealEnv()),
    validRealEnv({ LUMITHINK_MODEL_PROVIDER_KEY: "sk-test-vendor-key-do-not-leak" }),
  );
  const view = gateway.describeConfig();
  assert.equal(view.models.length, 1);
  assert.equal(view.models[0].modelId, modelId);
  assert.equal(view.models[0].providerId, providerId);
  assert.equal(view.providers.length, 1);
  assert.equal(view.providers[0].baseURLOrigin, "http://127.0.0.1:9");
  assert.equal(view.providers[0].hasKeySource, true);
  assert.notEqual(view.providers[0].dataEgressReview, "absent");
  if (view.providers[0].dataEgressReview !== "absent") {
    assert.equal(view.providers[0].dataEgressReview.reviewer, "e2e03-test-reviewer");
  }
  // No key material anywhere in the view.
  assert.ok(!JSON.stringify(view).includes("sk-test-vendor-key-do-not-leak"));
});

test("with no key configured every request fails closed as GATEWAY_AUTH_FAILED and the vendor is never contacted", async () => {
  let vendorRequests = 0;
  const vendor: Server = createServer((_req, res) => {
    vendorRequests += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("event: message_stop\ndata: {}\n\n");
  });
  await new Promise<void>((resolve) => vendor.listen(0, "127.0.0.1", resolve));
  const address = vendor.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const baseURL = `http://127.0.0.1:${address.port}`;

  try {
    const env = validRealEnv({ LUMITHINK_REAL_PROVIDER_BASEURL: baseURL });
    const activation = parseRealProviderActivation(env);
    if (activation.mode !== "real") throw new Error("unreachable");
    const { gateway } = buildRealProviderGateway(activation.record, env);

    await assert.rejects(
      gateway.complete({
        requestId: "req_testcomp0001",
        traceId: "trc_testcomp001",
        turnId: "trn_testcomp001",
        modelId: "deepseek-v4-flash",
        messages: [{ role: "user", content: "synthetic probe" }],
      }),
      (error: unknown) => error instanceof GatewayError && error.code === "GATEWAY_AUTH_FAILED",
    );
    assert.equal(vendorRequests, 0, "no vendor contact without a credential");
    const audit = gateway.auditTrail();
    assert.ok(audit.some((event) => event.type === "attempt.failed" && event.code === "GATEWAY_AUTH_FAILED"));
  } finally {
    await new Promise<void>((resolve) => vendor.close(() => resolve()));
  }
});

test("buildRealProviderGateway fails closed on a non-loopback http baseURL (composition-layer https gate)", () => {
  // Issue #53 review r2 test gap 5: the https enforcement lives in the
  // provider adapter (lib/domain/gateway/http-provider.ts assertBaseURL);
  // the composition layer must surface it as a construction failure for a
  // public http origin — the activation parser deliberately allows the http
  // SCHEME (loopback synthetic servers), so this is the gate that holds.
  const publicHttpEnv = validRealEnv({ LUMITHINK_REAL_PROVIDER_BASEURL: "http://203.0.113.7/v1" });
  assert.equal(parseRealProviderActivation(publicHttpEnv).mode, "real", "the record parses (scheme-level), so only the construction gate can refuse it");
  assert.throws(
    () => buildRealProviderGateway(realRecord(publicHttpEnv), validRealEnv()),
    /must use https \(plain http is allowed for loopback test servers only\)/,
  );
});

test("the child-data egress review is a locked constant (real child data stays unavailable)", () => {
  assert.equal(CHILD_DATA_EGRESS_REVIEW_STATUS, "not_performed");
});

test("the activation env enumeration names every variable the real route may consume", () => {
  assert.ok(REAL_PROVIDER_ENV_VARS.includes("LUMITHINK_MODEL_ROUTE"));
  assert.ok(REAL_PROVIDER_ENV_VARS.includes("LUMITHINK_MODEL_PROVIDER_KEY"));
  assert.ok(!JSON.stringify(REAL_PROVIDER_ENV_VARS).includes("="), "names only, never values");
});

test("the main app composition root stays mock-only even with a complete real activation env (no-op negative test)", () => {
  // Issue #53 review r1 P2-3 + test gap: the real route is NOT wired into the
  // main app composition root yet (docs/MODEL_GATEWAY.md §7). A FULLY VALID
  // activation record in the process environment must not change what the
  // web MVP runtime composes — and the record itself parses as `real`, which
  // rules out "nothing happened because the record was invalid".
  const env = validRealEnv({ LUMITHINK_MODEL_PROVIDER_KEY: "sk-negative-test-key-do-not-leak" });
  assert.equal(parseRealProviderActivation(env).mode, "real");

  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    previous[name] = process.env[name];
    process.env[name] = value;
  }
  try {
    const runtime = createWebMvpRuntime();
    const view = runtime.gateway.describeConfig();
    assert.equal(view.providers.length, 1);
    assert.equal(view.providers[0].providerId, WEB_MVP_PROVIDER_ID, "only the local mock provider is registered");
    assert.ok(!JSON.stringify(view).includes(REAL_PROVIDER_ID), "no real provider is registered on the main-app gateway");
    assert.ok(!JSON.stringify(view).includes("sk-negative-test-key-do-not-leak"), "the credential material never enters the runtime view");
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
