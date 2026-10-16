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
  // constraint); numpy/onnxruntime back the only enabled module (SileroVAD);
  // opuslib_next is imported unconditionally at server import time.
  assert.ok(pinned.has("websockets"), "websockets pin missing");
  assert.ok(lines.includes("websockets==14.2"));
  assert.ok(pinned.has("numpy"));
  assert.ok(lines.includes("numpy==1.26.4"));
  assert.ok(pinned.has("onnxruntime"), "deployment-added onnxruntime pin missing");
  assert.ok(pinned.has("opuslib_next"), "opuslib_next pin missing (top-level import)");
  assert.ok(pinned.has("jinja2"), "jinja2 pin missing (prompt manager top-level import)");
  assert.ok(pinned.has("cryptography"), "cryptography pin missing (auth util top-level import)");
  // The heavy model stack must NOT leak into the gateway-minimal profile.
  for (const forbidden of ["torch", "torchaudio", "funasr", "modelscope", "sherpa_onnx", "mem0ai", "powermem"]) {
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

  // The explicit-disabled surface: recursive merge keeps upstream default
  // keys alive, so EVERY module key must be explicitly overridden — cognitive
  // layers to loopback dead endpoints, Memory/Intent explicitly off.
  const block = raw.slice(raw.indexOf("selected_module:"), raw.indexOf("VAD:\n  SileroVAD:"));
  assert.ok(block.length > 0, "selected_module block not found");
  for (const key of ["VAD", "ASR", "LLM", "TTS", "VLLM", "Memory", "Intent"]) {
    assert.match(block, new RegExp(`^  ${key}: `, "m"), `selected_module lacks explicit ${key}`);
  }
  assert.match(block, /^  Memory: nomem$/m);
  assert.match(block, /^  Intent: nointent$/m);
  // VLLM is EXPLICITLY disabled ("" is falsy: upstream vision_handler raises
  // before instantiating any provider — i.e. before any egress; the multipart
  // request-body read happens BEFORE that raise, but reading produces no
  // egress — review R2 P1-1 wording fix). Upstream ships external VLLM
  // segments (ChatGLMVLLM etc.): the recursive merge keeps them alive but
  // UNSELECTED in the effective config; selecting the upstream default would
  // send vision requests to https://open.bigmodel.cn (review R1 P2-1).
  assert.match(block, /^  VLLM: ""$/m);

  // Zero-egress assertion: every concrete URL on an active line is either an
  // injected ${VAR} (whole host a placeholder) or a loopback (127.0.0.1/
  // localhost) dead endpoint. No concrete external host may appear outside
  // comments.
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const urlMatches = [...trimmed.matchAll(/https?:\/\/([^\/\s"']+)/g)];
    for (const match of urlMatches) {
      const host = match[1];
      assert.match(
        host,
        /^(\$\{[A-Z_][A-Z0-9_]*\}|127\.0\.0\.1|localhost)(:\d+)?$/,
        `active config line carries a concrete external URL (egress risk): ${trimmed}`,
      );
    }
  }
});

test("render placeholder contract: only the three injected keys, only on active lines", () => {
  const raw = read("deploy/xiaozhi/config/gateway-minimal.yaml");
  // Replicates render_config.py's placeholder extraction over ACTIVE lines.
  // A literal ${...} inside a comment would be treated as a required env key
  // and fail every render — this pins the contract so that class of bug
  // cannot return silently.
  const activeLines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join("\n");
  const placeholders = [...activeLines.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(
    (match) => match[1],
  );
  assert.deepEqual([...new Set(placeholders)].sort(), [
    "XIAOZHI_AUTH_KEY",
    "XIAOZHI_DEVICE_WS_URL",
    "XIAOZHI_PUBLIC_DOMAIN",
  ]);
});

// ---------------------------------------------------------------------------
// E2E-05 (issue #55): the reviewed real-ASR tier (gateway-asr-real)
// ---------------------------------------------------------------------------

test("gateway-asr-real tier template: reviewed streaming ASR selected at the pinned extension point", () => {
  const raw = read("deploy/xiaozhi/config/gateway-asr-real.yaml");

  // The tier change is the ASR selection ONLY: the safety skeleton of
  // gateway-minimal must be byte-for-byte equivalent in semantics.
  assert.match(raw, /^  ip: 127\.0\.0\.1$/m);
  assert.match(raw, /^    enabled: true$/m);
  assert.match(raw, /^    allowed_devices: \[\]$/m);
  assert.match(raw, /^read_config_from_api: false$/m);
  assert.match(raw, /^delete_audio: true$/m);
  assert.match(raw, /^  VLLM: ""$/m);
  assert.match(raw, /^  Memory: nomem$/m);
  assert.match(raw, /^  Intent: nointent$/m);

  // The reviewed first real ASR provider: Aliyun Bailian Paraformer realtime
  // streaming at the pinned commit's extension point, 16 kHz uplink contract.
  assert.match(raw, /^  ASR: AliyunBLStreamASR$/m);
  const asr = raw.slice(raw.indexOf("ASR:\n  AliyunBLStreamASR:"), raw.indexOf("# 占位 LLM"));
  assert.ok(asr.length > 0, "ASR provider block not found");
  assert.match(asr, /^    type: aliyunbl_stream$/m);
  assert.match(asr, /^    api_key: \$\{XIAOZHI_ASR_API_KEY\}$/m, "the credential is render-time injected, never literal");
  assert.match(asr, /^    model: paraformer-realtime-v2$/m);
  assert.match(asr, /^    format: pcm$/m);
  assert.match(asr, /^    sample_rate: 16000$/m, "the 16 kHz uplink contract is pinned in the template");
  assert.match(asr, /^    max_sentence_silence: 200$/m, "provider-side endpoint detection window pinned");

  // Transcript-retention gates: the pinned commit logs 识别文本 at INFO —
  // the real-ASR tier must run at WARNING (issue #55: 默认不保存原始转写).
  assert.match(raw, /^  log_level: WARNING$/m);

  // Zero-egress discipline unchanged: no concrete external host on active
  // lines (the reviewed vendor endpoint is upstream-hardcoded, documented in
  // comments and the runbook — it is not a template value).
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const urlMatches = [...trimmed.matchAll(/https?:\/\/([^\/\s"']+)/g)];
    for (const match of urlMatches) {
      const host = match[1];
      assert.match(
        host,
        /^(\$\{[A-Z_][A-Z0-9_]*\}|127\.0\.0\.1|localhost)(:\d+)?$/,
        `active config line carries a concrete external URL (egress risk): ${trimmed}`,
      );
    }
  }
  // The review anchor must stay documented in the file (drift = re-review).
  assert.ok(raw.includes("wss://dashscope.aliyuncs.com/api-ws/v1/inference"));
  assert.ok(raw.includes("27399a2f"));
});

test("gateway-asr-real render placeholder contract: the four injected keys, only on active lines", () => {
  const raw = read("deploy/xiaozhi/config/gateway-asr-real.yaml");
  const activeLines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join("\n");
  const placeholders = [...activeLines.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(
    (match) => match[1],
  );
  assert.deepEqual([...new Set(placeholders)].sort(), [
    "XIAOZHI_ASR_API_KEY",
    "XIAOZHI_AUTH_KEY",
    "XIAOZHI_DEVICE_WS_URL",
    "XIAOZHI_PUBLIC_DOMAIN",
  ]);
});

test("gateway-asr-real env template carries no real secret values (shapes only)", () => {
  const raw = read("deploy/xiaozhi/env/gateway-asr-real.example");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    assert.match(
      trimmed,
      /^XIAOZHI_[A-Z_]+=/,
      `unexpected non-XIAOZHI_ active line: ${trimmed}`,
    );
    const value = trimmed.slice(trimmed.indexOf("=") + 1);
    assert.ok(
      value === "" || /^(<generate|wss:\/\/xiaozhi\.example\.com|xiaozhi\.example\.com)/.test(value),
      `env template line carries a real-looking value: ${trimmed}`,
    );
  }
});

test("bootstrap keeps gateway-minimal as the default tier and supports --template (E2E-05 tier switch)", () => {
  const bootstrap = read("deploy/xiaozhi/bootstrap.sh");
  // Default render = the zero-egress E2E-04 tier.
  assert.match(bootstrap, /^TEMPLATE="config\/gateway-minimal\.yaml"$/m);
  // The real-ASR tier is selectable explicitly.
  assert.ok(bootstrap.includes("--template"));
  assert.ok(bootstrap.includes("--template not found"));
  // The render call consumes the selectable template.
  assert.match(bootstrap, /--template "\$\{TEMPLATE\}"/);
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
  // Device-real token path: the OTA-issued token must be replayed over WSS
  // (review R1 test-gap 1), not only the self-minted one.
  assert.ok(healthcheck.includes("--token"), "OTA-issued token replay missing");

  const bootstrap = read("deploy/xiaozhi/bootstrap.sh");
  const pins = parseVersionEnv(read("deploy/xiaozhi/version.env"));
  // Bootstrap installs the pinned commit by SHA and installs the minimal set.
  assert.ok(bootstrap.includes("XIAOZHI_SERVER_COMMIT"));
  assert.ok(bootstrap.includes("requirements-gateway-minimal.txt"));
  assert.ok(bootstrap.includes("render_config.py"));
  // Ownership contract (review R1 P1-1): every root render must leave the
  // rendered config owned by the service user (os.replace drops ownership).
  assert.ok(bootstrap.includes("--service-user"));
  assert.ok(bootstrap.includes("--owner"));
  assert.ok(bootstrap.includes("chown -R"));

  const render = read("deploy/xiaozhi/render_config.py");
  assert.ok(render.includes("--owner"), "render_config.py lacks the --owner contract");
  assert.ok(render.includes("os.replace"), "atomic write missing");

  const unit = read("deploy/xiaozhi/xiaozhi-server.service");
  assert.match(unit, /^User=xiaozhi-server$/m);
  assert.match(unit, /^NoNewPrivileges=yes$/m);
  assert.match(unit, /^RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX$/m);
  assert.match(unit, /^ExecStart=\/opt\/xiaozhi-esp32-server\/venv\/bin\/python app\.py$/m);
  // No runtime secret environment (review R1 P2-3): upstream reads only the
  // rendered config (no env interpolation), so the unit must not inject the
  // env file into the process environment (the word may still appear in
  // explanatory comments — match the directive itself, anchored at line start).
  assert.doesNotMatch(unit, /^EnvironmentFile=/m, "unit must not inject env secrets at runtime");

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
  // Review R1 doc regressions: the ownership failure mode (P1-1) and the
  // web_test_client bypass disclosure (P2-1) must stay documented.
  assert.ok(runbook.includes("Permission denied"));
  assert.ok(runbook.includes("web_test_client"));
});

test("the CI deployment gate pins the same Python version as version.env", () => {
  // Review R1 test-gap 5: workflow PYTHON_VERSION vs version.env drift is
  // caught fail-closed by bootstrap at runtime; assert it explicitly too.
  const pins = parseVersionEnv(read("deploy/xiaozhi/version.env"));
  const py = pins.get("XIAOZHI_SERVER_PYTHON");
  assert.match(py ?? "", /^\d+\.\d+$/);
  const workflow = read(".github/workflows/e2e-04-xiaozhi-deployment-gate.yml");
  assert.ok(
    workflow.includes(`PYTHON_VERSION: '${py}'`),
    `workflow PYTHON_VERSION must equal version.env XIAOZHI_SERVER_PYTHON (${py})`,
  );
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
  // Review R2 P1-1 (enhancement adopted): the effective-config scan must pin
  // the upstream default shape — external VLLM segments exist but stay
  // unselected — so a future pin bump cannot silently void the
  // explicit-disable rationale while CI stays green.
  for (const upstreamDefault of ["open.bigmodel.cn", "dashscope.aliyuncs.com"]) {
    assert.ok(
      workflow.includes(upstreamDefault),
      `effective-config scan lacks the upstream VLLM default pin: ${upstreamDefault}`,
    );
  }
  // Review R2 P2-2: the corrupted-config negative must poll the process exit
  // (no blind sleep race) and must NOT rely on a bare `error` signature.
  assert.ok(workflow.includes("did not exit within 20s of TERM"), "corrupted-config negative lacks the exit poll");
  assert.doesNotMatch(workflow, /grep -qiE 'yaml\|scanner\|parser\|error'/, "corrupted-config negative still uses the bare-error signature");
  // E2E-05 (issue #55): the real-ASR tier is rendered/merge-scanned in CI but
  // never booted — no vendor network, no real credential.
  assert.ok(workflow.includes("gateway-asr-real.yaml"), "workflow lacks the real-ASR tier render/scan");
  assert.ok(workflow.includes("XIAOZHI_ASR_API_KEY"), "workflow lacks the provider-key fail-closed check");
  assert.match(workflow, /NO vendor network/i, "the real-tier scan must disclose that it never touches the vendor");
});

test("the runbook carries the real-ASR tier section with its policy and honest boundaries (E2E-05)", () => {
  const runbook = read("deploy/xiaozhi/runbook.md");
  assert.ok(runbook.includes("gateway-asr-real"), "the real-ASR tier section is missing");
  // Policy surface: auth injection, retention gates, disable switch.
  assert.ok(runbook.includes("XIAOZHI_ASR_API_KEY"));
  assert.ok(runbook.includes("log_level: WARNING"));
  assert.ok(runbook.includes("read_config_from_api: false"));
  assert.ok(runbook.includes("delete_audio: true"));
  // Disable switch = re-render the default zero-egress tier.
  assert.ok(runbook.includes("禁用开关"));
  // Honest boundaries: not device-verified; confidence not on the wire.
  assert.ok(runbook.includes("未实机验证"));
  assert.ok(runbook.includes("confidence.onWire=false"));
  // Review anchor + child-data gate references.
  assert.ok(runbook.includes("dashscope.aliyuncs.com"));
  assert.ok(runbook.includes("not_performed"));
});
