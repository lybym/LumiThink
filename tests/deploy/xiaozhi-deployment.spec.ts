import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { XIAOZHI_GATEWAY_BASELINE } from "../../lib/domain/voice/adapter/protocol.ts";

const repoUrl = new URL("../../", import.meta.url); // directory URL ending in "/"
const read = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(relativePath, repoUrl)), "utf8");

const parseVersionEnv = (raw: string): Map<string, string> => {
  const pins = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    assert.ok(eq > 0, `version.env line is not KEY=VALUE: ${trimmed}`);
    pins.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return pins;
};

test("version.env pins the exact server commit/tag that the Adapter contract was evaluated against", () => {
  const pins = parseVersionEnv(read("deploy/xiaozhi/version.env"));
  const baselineCommit = XIAOZHI_GATEWAY_BASELINE.serverRef.split("@")[1];

  assert.match(baselineCommit, /^[0-9a-f]{40}$/);
  assert.equal(pins.get("XIAOZHI_SERVER_REPO"), XIAOZHI_GATEWAY_BASELINE.serverRepo);
  assert.equal(pins.get("XIAOZHI_SERVER_COMMIT"), baselineCommit);
  assert.equal(pins.get("XIAOZHI_SERVER_EVAL_TAG"), XIAOZHI_GATEWAY_BASELINE.serverTag);
  assert.equal(pins.get("XIAOZHI_FIRMWARE_REPO"), XIAOZHI_GATEWAY_BASELINE.firmwareRepo);
  assert.equal(pins.get("XIAOZHI_FIRMWARE_BASELINE_TAG"), XIAOZHI_GATEWAY_BASELINE.firmwareTag);
  // 40-hex integrity for both pinned commits (server + firmware baseline).
  assert.match(pins.get("XIAOZHI_FIRMWARE_BASELINE_COMMIT") ?? "", /^[0-9a-f]{40}$/);
});

test("version.env records the test firmware without pretending device verification", () => {
  const pins = parseVersionEnv(read("deploy/xiaozhi/version.env"));
  // E2E-04 records the existing test firmware ID; device verification stays
  // with #E2E-08 (no PASS claims anywhere in this deliverable).
  assert.equal(pins.get("XIAOZHI_FIRMWARE_TEST_ID"), "v2.5.2_nulllab-ai-vox-v3");
  assert.equal(pins.get("XIAOZHI_FIRMWARE_TEST_BOARD"), "nulllab-ai-vox-v3");
});

test("gateway-minimal requirements are fully pinned and keep the upstream-critical pins", () => {
  const raw = read("deploy/xiaozhi/requirements-gateway-minimal.txt");
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  // Every requirement line is an exact pin (name==version) — no floating refs.
  for (const line of lines) {
    assert.match(line, /^[A-Za-z0-9_.-]+==[A-Za-z0-9.]+$/, `unpinned requirement: ${line}`);
  }
  const pinned = new Set(lines.map((line) => line.split("==")[0].toLowerCase()));
  // websockets 14.2 is the upstream-pinned protocol dependency (cozepy <15
  // constraint); numpy/onnxruntime back the only enabled module (SileroVAD).
  assert.ok(pinned.has("websockets"), "websockets pin missing");
  assert.ok(lines.includes("websockets==14.2"));
  assert.ok(pinned.has("numpy"));
  assert.ok(lines.includes("numpy==1.26.4"));
  assert.ok(pinned.has("onnxruntime"), "deployment-added onnxruntime pin missing");
  // The heavy model stack must NOT leak into the gateway-minimal profile.
  for (const forbidden of ["torch", "torchaudio", "funasr", "modelscope", "sherpa_onnx", "mem0ai"]) {
    assert.ok(!pinned.has(forbidden), `${forbidden} must stay out of gateway-minimal`);
  }
  // Traceability: the file must name the upstream commit its pins were copied from.
  const pins = parseVersionEnv(read("deploy/xiaozhi/version.env"));
  assert.ok(
    raw.includes(pins.get("XIAOZHI_SERVER_COMMIT") ?? ""),
    "requirements header must cite the pinned upstream commit",
  );
});

test("gateway-minimal config template: loopback-only, auth forced on, ASR/TTS/LLM explicitly absent", () => {
  const raw = read("deploy/xiaozhi/config/gateway-minimal.yaml");

  // Loopback-only listeners (public exposure belongs to the Caddy site block).
  assert.match(raw, /^  ip: 127\.0\.0\.1$/m);
  assert.match(raw, /^  port: 8000$/m);
  assert.match(raw, /^  http_port: 8003$/m);

  // Auth forced on with NO device whitelist bypass (least privilege).
  assert.match(raw, /^    enabled: true$/m);
  assert.match(raw, /^    allowed_devices: \[\]$/m);

  // The explicit-disabled surface: selected_module contains VAD and nothing else.
  const block = raw.slice(raw.indexOf("selected_module:"), raw.indexOf("VAD:\n  SileroVAD:"));
  assert.ok(block.length > 0, "selected_module block not found");
  assert.match(block, /^  VAD: SileroVAD$/m);
  assert.doesNotMatch(block, /^  (ASR|LLM|TTS|VLLM|Intent|Memory):/m);

  // Zero-egress assertion: no non-comment line carries a concrete external
  // URL; every scheme occurrence on an active line is an injected ${VAR}.
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (!trimmed.includes("://")) continue;
    assert.match(
      trimmed,
      /\$\{[A-Z_][A-Z0-9_]*\}/,
      `active config line carries a concrete URL (external egress risk): ${trimmed}`,
    );
  }
});

test("env template carries no real secret values (shapes only)", () => {
  const raw = read("deploy/xiaozhi/env/gateway-minimal.example");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    assert.match(
      trimmed,
      /^XIAOZHI_[A-Z_]+=/,
      `unexpected non-XIAOZHI_ active line: ${trimmed}`,
    );
    const value = trimmed.slice(trimmed.indexOf("=") + 1);
    // Either empty or a documented shape placeholder — never a real value.
    assert.ok(
      value === "" || /^(<generate|wss:\/\/xiaozhi\.example\.com|xiaozhi\.example\.com)/.test(value),
      `env template line carries a real-looking value: ${trimmed}`,
    );
  }
});

test("probe, healthcheck, bootstrap, unit and Caddy artifacts exist and carry their AC assertions", () => {
  const probe = read("deploy/xiaozhi/probe_hello.py");
  // Token generation mirrors upstream core/auth.py (HMAC over client|device|ts).
  assert.ok(probe.includes("client_id}|{device_id}|{ts}"));
  assert.ok(probe.includes("--expect-auth-failure"));
  assert.ok(probe.includes("--expect-silent-binary"));
  // The abort line contract: {"type":"abort"} in, {"type":"tts","state":"stop"} out.
  assert.ok(probe.includes('"type": "abort"'));
  assert.ok(probe.includes('"tts"') && probe.includes('"stop"'));

  const healthcheck = read("deploy/xiaozhi/healthcheck.sh");
  assert.ok(healthcheck.includes("/xiaozhi/ota/"));
  assert.ok(healthcheck.includes("8000|8003"), "loopback binding assertion missing");
  assert.ok(healthcheck.includes("probe_hello.py"));

  const bootstrap = read("deploy/xiaozhi/bootstrap.sh");
  const pins = parseVersionEnv(read("deploy/xiaozhi/version.env"));
  // Bootstrap installs the pinned commit by SHA and installs the minimal set.
  assert.ok(bootstrap.includes("XIAOZHI_SERVER_COMMIT"));
  assert.ok(bootstrap.includes("requirements-gateway-minimal.txt"));
  assert.ok(bootstrap.includes("render_config.py"));

  const unit = read("deploy/xiaozhi/xiaozhi-server.service");
  assert.match(unit, /^User=xiaozhi-server$/m);
  assert.match(unit, /^NoNewPrivileges=yes$/m);
  assert.match(unit, /^RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX$/m);
  assert.match(unit, /^ExecStart=\/opt\/xiaozhi-esp32-server\/venv\/bin\/python app\.py$/m);

  const caddy = read("deploy/xiaozhi/caddy/Caddyfile.xiaozhi");
  assert.ok(caddy.includes("reverse_proxy @devicews 127.0.0.1:8000"));
  assert.ok(caddy.includes("reverse_proxy @ota 127.0.0.1:8003"));
  assert.ok(caddy.includes("xiaozhi.example.com"), "example domain must stay non-real");
  // Vision analysis stays unrouted in the minimal profile (fail-closed).
  assert.ok(!caddy.includes("mcp/vision/explain") || caddy.includes("# fail-closed：/mcp/vision/explain 不代理"));
});

test("runbook carries the honest acceptance label and stays in sync with version pinning", () => {
  const runbook = read("deploy/xiaozhi/runbook.md");
  const pins = parseVersionEnv(read("deploy/xiaozhi/version.env"));
  assert.ok(runbook.includes(pins.get("XIAOZHI_SERVER_COMMIT") ?? ""));
  assert.ok(runbook.includes(pins.get("XIAOZHI_FIRMWARE_BASELINE_TAG") ?? ""));
  // Issue DoD 4: the acceptance wording is mandatory, verbatim.
  assert.ok(runbook.includes("私有服务端已验证，真实设备仍待 #E2E-08"));
  // Firmware diff is recorded, not rewritten.
  assert.ok(runbook.includes("v2.5.2_nulllab-ai-vox-v3"));
});

test("the CI deployment gate proves the DoD negatives and triggers on the xiaozhi deploy surface", () => {
  const workflow = read(".github/workflows/e2e-04-xiaozhi-deployment-gate.yml");
  for (const expected of [
    "deploy/xiaozhi/**",
    "healthcheck.sh",
    "probe_hello.py",
    "--expect-auth-failure",
    "--expect-silent-binary",
    "requirements-gateway-minimal.txt",
  ]) {
    assert.ok(workflow.includes(expected), `workflow lacks: ${expected}`);
  }
  // Corrupted-config negative: the boot must be asserted to fail.
  assert.match(workflow, /corrupt/i);
});
