import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const moduleUrl = new URL("../../lib/server/gateway-host-shutdown.ts", import.meta.url).href;

async function runFault(mode: string): Promise<{ code: number | null; output: string }> {
  const script = [
    `import { createGatewayHostShutdown, installGatewayHostShutdown } from ${JSON.stringify(moduleUrl)};`,
    `const mode = ${JSON.stringify(mode)};`,
    'const secret = "synthetic-private-prompt-and-key";',
    'const shutdown = createGatewayHostShutdown({',
    ' timeoutMs: 100,',
    ' closeAdmission: () => console.log("ADMISSION_CLOSED"),',
    ' cleanup: async () => {',
    '  if (mode === "hung") await new Promise(() => {});',
    '  if (mode === "cleanup_error") throw new Error(secret);',
    '  await new Promise(resolve => setTimeout(resolve, 30));',
    '  console.log("CLEANUP_FINISHED");',
    ' }',
    '});',
    'installGatewayHostShutdown(shutdown);',
    'if (mode === "signal") process.emit("SIGTERM");',
    'else if (mode === "rejection") Promise.reject(new Error(secret));',
    'else if (mode === "repeated") {',
    ' process.emit("SIGTERM");',
    ' setTimeout(() => { throw new Error(secret); }, 5);',
    '} else queueMicrotask(() => { throw new Error(secret); });',
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("shutdown fixture timed out")); }, 5_000);
    child.stdout.on("data", (part) => { output += part.toString(); });
    child.stderr.on("data", (part) => { output += part.toString(); });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => { clearTimeout(timeout); resolve({ code, output }); });
  });
}

for (const mode of ["exception", "rejection", "hung", "cleanup_error", "repeated", "signal"]) {
  test(`gateway shutdown: ${mode} closes admission, exits with the right status and leaks no error value`, async () => {
    const result = await runFault(mode);
    assert.equal(result.code, mode === "signal" ? 0 : 1, result.output);
    assert.equal(result.output.split("ADMISSION_CLOSED").length - 1, 1);
    assert.equal(result.output.split("shutdown reason=").length - 1, 1);
    assert.ok(!result.output.includes("synthetic-private-prompt-and-key"));
    if (mode !== "hung" && mode !== "cleanup_error") assert.ok(result.output.includes("CLEANUP_FINISHED"));
  });
}
