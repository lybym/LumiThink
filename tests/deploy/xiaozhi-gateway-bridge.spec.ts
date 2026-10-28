import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * E2E-07 (issue #57) — gateway-bridge tier + fork-patch registry
 * discipline, mirrored from tests/deploy/xiaozhi-deployment.spec.ts (raw
 * text assertions, no YAML dependency): the bridge LLM must be the ONLY
 * selected cognitive LLM (the built-in AI second path is structurally
 * unreachable), the protected transport token enters by ENV NAME only,
 * every URL on an active line stays loopback/placeholder, the render
 * placeholder contract stays closed, and the five registered fork patches
 * are consistent between the review record and the machine mirror.
 */

const read = (path: string): string => readFileSync(path, "utf8");

// The fork-patch registry must cite the CURRENT pin (deploy/xiaozhi/version.env
// is the single source of truth): a pin bump without re-registering the
// baseline fails here (drift = re-verify the anchors, runbook §3.7).
const pinnedCommit =
  read("deploy/xiaozhi/version.env")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("XIAOZHI_SERVER_COMMIT="))
    ?.split("=")[1] ?? "";

test("gateway-bridge tier template: the bridge LLM is the ONLY selected LLM, token by env name", () => {
  const raw = read("deploy/xiaozhi/config/gateway-bridge.yaml");

  // The reviewed gateway-minimal security surface carries over verbatim.
  assert.match(raw, /^  ip: 127\.0\.0\.1$/m);
  assert.match(raw, /^    enabled: true$/m);
  assert.match(raw, /^    allowed_devices: \[\]$/m);
  assert.match(raw, /^read_config_from_api: false$/m);
  assert.match(raw, /^  log_level: WARNING$/m);
  assert.match(raw, /^delete_audio: true$/m);

  // The ONLY tier difference: selected_module.LLM = the LumiThink bridge.
  const block = raw.slice(raw.indexOf("selected_module:"), raw.indexOf("VAD:\n  SileroVAD:"));
  assert.ok(block.length > 0, "selected_module block not found");
  for (const key of ["VAD", "ASR", "LLM", "TTS", "VLLM", "Memory", "Intent"]) {
    assert.match(block, new RegExp(`^  ${key}: `, "m"), `selected_module lacks explicit ${key}`);
  }
  assert.match(block, /^  LLM: LumithinkBridgeLLM$/m);
  assert.match(block, /^  VLLM: ""$/m);
  assert.match(block, /^  Memory: nomem$/m);
  assert.match(block, /^  Intent: nointent$/m);

  // The provider segment: pinned type, endpoint by placeholder, token by
  // ENV NAME (the token value never enters config/Git/logs).
  const llmBlock = raw.slice(raw.indexOf("LLM:\n  LumithinkBridgeLLM:"), raw.indexOf("# 占位 TTS"));
  assert.ok(llmBlock.length > 0, "bridge LLM segment not found");
  assert.match(llmBlock, /^    type: lumithink$/m);
  assert.match(llmBlock, /^    gateway_socket: \$\{LUMITHINK_GATEWAY_SOCKET\}$/m);
  assert.match(llmBlock, /^    auth_token_env: LUMITHINK_GATEWAY_BRIDGE_TOKEN$/m);

  // Zero-egress: every concrete URL on an active line is a placeholder or
  // loopback (the pinned TTS stub URL in CI is loopback by construction).
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const urlMatches = [...trimmed.matchAll(/https?:\/\/([^\/\s"']+)/g)];
    for (const match of urlMatches) {
      assert.match(
        match[1],
        /^(\$\{[A-Z_][A-Z0-9_]*\}|127\.0\.0\.1|localhost)(:\d+)?$/,
        `active config line carries a concrete external URL: ${trimmed}`,
      );
    }
  }
});

test("gateway-bridge render placeholder contract: exactly the injected env keys", () => {
  const raw = read("deploy/xiaozhi/config/gateway-bridge.yaml");
  const activeLines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .join("\n");
  const placeholders = [...activeLines.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(
    (match) => match[1],
  );
  assert.deepEqual([...new Set(placeholders)].sort(), [
    "LUMITHINK_GATEWAY_SOCKET",
    "XIAOZHI_AUTH_KEY",
    "XIAOZHI_DEVICE_WS_URL",
    "XIAOZHI_PUBLIC_DOMAIN",
    "XIAOZHI_TTS_STUB_URL",
  ]);
});

test("env template carries no real values", () => {
  const raw = read("deploy/xiaozhi/env/gateway-bridge.example");
  const offenders = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Z_]+=./.test(line))
    .filter((line) => {
      const value = line.slice(line.indexOf("=") + 1);
      // Documented shapes only: generation placeholders, the example
      // domain, the UDS path shape, and loopback URLs.
      return !(
        value.startsWith("<generate") ||
        value === "xiaozhi.example.com" ||
        value.startsWith("/run/lumithink/") ||
        /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(value)
      );
    });
  assert.deepEqual(offenders, [], "env template must not carry real values");
});

test("fork-patch registry: five registered patches, pinned commit named, machine mirror consistent", () => {
  const doc = read("deploy/xiaozhi/fork-patches.md");
  const installer = read("deploy/xiaozhi/gateway_bridge/install_bridge.py");

  assert.match(pinnedCommit, /^[0-9a-f]{40}$/, "version.env must carry a 40-hex server commit pin");
  assert.match(doc, new RegExp(pinnedCommit), "registry must name the pinned commit");
  for (let i = 1; i <= 5; i += 1) {
    assert.ok(doc.includes(`${i}/5`), `fork-patches.md missing patch ${i}/5`);
  }
  // The installer is the machine-enforced mirror: exactly five patches,
  // each naming its registered files.
  const numbers = [...installer.matchAll(/"number": "(\d\/5)"/g)].map((m) => m[1]);
  assert.deepEqual(numbers, ["1/5", "2/5", "3/5", "4/5", "5/5"]);
  for (const file of ["core/handle/helloHandle.py", "core/handle/abortHandle.py", "core/handle/sendAudioHandle.py", "core/connection.py"]) {
    assert.ok(installer.includes(`"${file}"`), `installer missing registered patch file ${file}`);
  }
  // Every hook is guarded: the exception discipline is load-bearing.
  assert.ok(installer.includes("except Exception:"), "hooks must be guarded");
  // The module carries the ordering guarantee the registry documents.
  const module = read("deploy/xiaozhi/gateway_bridge/lumithink_llm.py");
  assert.match(module, /FRAME ORDERING GUARANTEE/, "the abort-before-prompt ordering must be documented in code");
  assert.match(module, /class _ControlWorker/, "the single-FIFO control worker must exist");
  assert.match(module, /def lumi_on_hello/, "hello registration hook");
  assert.match(module, /def lumi_on_abort/, "abort notification hook");
  assert.match(module, /def lumi_on_audio_frame/, "real audio accounting hook");
  assert.match(module, /def lumi_on_tts_state/, "tts-state flush hook");
  assert.match(module, /def lumi_on_device_closed/, "device-closed cleanup hook");
});
