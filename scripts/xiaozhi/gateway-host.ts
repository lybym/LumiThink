/**
 * E2E-07 (issue #57) — Voice Gateway host launcher: boots the REAL wired
 * stack for the xiaozhi-esp32-server bridge (CI + operator opt-in runs).
 *
 * TYPECHECK NOTE: this launcher imports `poc/dsh-child` sources and is
 * therefore excluded from the ROOT tsconfig — `poc/dsh-child` is an
 * isolated package with its own toolchain and @types resolution
 * (pnpm-workspace.yaml: "poc/dsh-child ... must stay fully isolated");
 * re-typing its sources under the root graph would violate that contract.
 * The launcher is validated at RUNTIME by the e2e-07 CI wiring job (boot
 * readiness is a hard gate) and by `pnpm --dir poc/dsh-child run
 * typecheck` for the imported poc surface.
 *
 *   pinned xiaozhi server (device WS, VAD, ASR, TTS, Opus)
 *     → bridge LLM module (deploy/xiaozhi/gateway_bridge/lumithink_llm.py)
 *       → PROTECTED internal transport (UDS + token, no TCP)
 *         → THIS host:
 *             VoiceGatewayStack (REAL local-socket Bridge IPC)
 *               → REAL locked-version DSH Cordis agent port
 *                 (worker child process, poc/dsh-child, dsh-v0.2.0-rc.2)
 *               → deterministic synthetic model script (CI; a real model
 *                 endpoint is an operator opt-in outside this issue)
 *
 * Readiness line: prints `GATEWAY-HOST READY endpoint=<uds-path>` once the
 * protected transport is listening; exits non-zero on any boot failure.
 * Secrets arrive via env, never argv; nothing secret is ever logged.
 *
 * Env contract:
 *   LUMITHINK_GATEWAY_SOCKET        UDS path to listen on (no TCP option)
 *   LUMITHINK_GATEWAY_BRIDGE_TOKEN  internal transport token (required)
 *   LUMITHINK_GATEWAY_AUTH_KEY      device-token HMAC key (required)
 *   LUMITHINK_GATEWAY_BINDINGS      JSON file: [{deviceId, actorId,
 *                                   conversationId, activationDigest}]
 *   LUMITHINK_GATEWAY_HOME          scratch dir for the DSH home (optional)
 */

import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createWiredVoiceGateway } from "../../lib/server/voice-gateway-wiring.ts";
import type { MockGenerationScript } from "../../lib/domain/voice/bridge/mock-cordis.ts";
import { MockMessagesServer } from "../../poc/dsh-child/src/mock-model.ts";
import { materializeBridgeProfileInto, createRealCordisAgentPort } from "../../poc/dsh-child/src/real-agent-port.ts";
import { canSpawnPipedChild } from "../../poc/dsh-child/src/dump-config.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    console.error(`[gateway-host] missing required env ${name}`);
    process.exit(1);
  }
  return value;
}

/** Deterministic synthetic response (CI; clearly synthetic, child-safe). */
function scriptFor(_sessionKey: string, _turnId: string): MockGenerationScript {
  return [
    { channel: "text", text: "好呀，我们一起看看这道题。" },
    { channel: "text", text: "先找已知条件，再一步一步算。" },
  ];
}

/** The synthetic model's fixed turn texts (must match scriptFor above). */
const FIXED_TURN_TEXTS = ["好呀，我们一起看看这道题。", "先找已知条件，再一步一步算。"];

interface BindingFile {
  readonly deviceId: string;
  readonly actorId: string;
  readonly conversationId: string;
  readonly activationDigest: string;
}

async function main(): Promise<void> {
  const socketPath = requireEnv("LUMITHINK_GATEWAY_SOCKET");
  const transportToken = requireEnv("LUMITHINK_GATEWAY_BRIDGE_TOKEN");
  const authKey = requireEnv("LUMITHINK_GATEWAY_AUTH_KEY");
  const bindingsPath = requireEnv("LUMITHINK_GATEWAY_BINDINGS");

  const bindings = JSON.parse(readFileSync(bindingsPath, "utf8")) as BindingFile[];
  if (!Array.isArray(bindings) || bindings.length === 0) {
    console.error("[gateway-host] bindings file must carry at least one binding");
    process.exit(1);
  }
  for (const binding of bindings) {
    if (
      typeof binding.deviceId !== "string" ||
      typeof binding.actorId !== "string" ||
      typeof binding.conversationId !== "string" ||
      typeof binding.activationDigest !== "string"
    ) {
      console.error("[gateway-host] malformed binding entry (field names only are ever printed)");
      process.exit(1);
    }
  }

  if (!canSpawnPipedChild()) {
    console.error(
      "[gateway-host] piped stdio child processes are unavailable here; the REAL DSH worker requires a normal shell/CI (fail-closed)",
    );
    process.exit(1);
  }

  // The real locked-version DSH runtime: worker child over the synthetic
  // Messages mock (the deterministic model for CI evidence).
  const dshHome = process.env.LUMITHINK_GATEWAY_HOME ?? mkdtempSync(join(tmpdir(), "lumithink-gw-host-"));
  await materializeBridgeProfileInto(dshHome);
  const mock = new MockMessagesServer({ fixedTurnTexts: FIXED_TURN_TEXTS });
  const mockBaseUrl = await mock.listen();
  const agentPort = createRealCordisAgentPort({ dshHome, mockBaseUrl, childBootTimeoutMs: 20_000 });

  const wired = createWiredVoiceGateway({
    bindings,
    deviceAuthKey: authKey,
    transportAuthToken: transportToken,
    // The protected transport listens EXACTLY on the configured UDS path —
    // the pinned server's bridge config points there.
    transportEndpoint: { kind: "uds", path: resolve(socketPath) },
    scriptFor,
    agentPort,
    onAgentFault: (listener) => agentPort.onFault(listener),
    transport: "ipc",
    // Content-free lifecycle diagnostics (CI evidence; no content).
    onBridgeFrame: (frame) => {
      console.log(`[gateway-host] frame -> bridge kind=${frame.kind}`);
    },
  });

  // Content-free turn-level diagnostics (CI evidence): every stack event,
  // every agent fault, and the settlement outcomes — no content fields.
  wired.stack.stack.client.onEvent((frame) => {
    if (frame.kind !== "event") {
      return;
    }
    const payload = (frame.payload ?? {}) as Record<string, unknown>;
    if (frame.name === "turn.settled") {
      console.log(
        `[gateway-host] stack event ${frame.name} finalState=${String(payload.finalState)} turnId=${String(payload.turnId)}`,
      );
      const gate = wired.stack.stack.gate.metricsSnapshot();
      console.log(
        `[gateway-host] gate metrics deltasFenced=${gate.deltasFenced} ttsAdmissions=${gate.ttsAdmissions} ttsBlocked=${gate.ttsBlockedSentences} deliveryFailures=${gate.sentenceDeliveryFailures}`,
      );
      return;
    }
    console.log(`[gateway-host] stack event ${frame.name}`);
  });
  agentPort.onFault((info) => {
    console.error(
      `[gateway-host] agent fault session=${info.sessionKey} code=${info.code} detail=${info.detail} exit=${String(info.exitCode)} message=${info.message ?? ""}`,
    );
  });

  // Watchdog: if a turn stays unsettled for 30s, dump the worker's
  // content-free diagnostics (alive flag + bounded stderr tail — the
  // snapshot API never carries prompt/model text).
  let pendingTurn: string | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  wired.stack.stack.client.onEvent((frame) => {
    if (frame.kind !== "event") {
      return;
    }
    const payload = (frame.payload ?? {}) as Record<string, unknown>;
    if (frame.name === "turn.accepted" && typeof payload.turnId === "string") {
      pendingTurn = payload.turnId;
      if (watchdog === null) {
        watchdog = setTimeout(() => {
          if (pendingTurn === null) {
            return;
          }
          const sessionKeys = wired.stack.mappingSnapshot().map((entry) => entry.sessionKey);
          const aliveFn = (agentPort as { hasLiveWorker?: (k: string) => boolean }).hasLiveWorker;
          for (const sessionKey of sessionKeys) {
            const described = wired.stack.stack.orchestrator.describeTurn(sessionKey, pendingTurn);
            const alive = typeof aliveFn === "function" ? aliveFn.call(agentPort, sessionKey) : undefined;
            console.log(
              `[gateway-host] watchdog turn=${pendingTurn} session=${sessionKey} state=${described?.state ?? "<unknown>"} epoch=${String(described?.epoch ?? "<none>")} workerLive=${String(alive)}`,
            );
            console.log(`[gateway-host] watchdog stderrTail session=${sessionKey}:\n${agentPort.stderrTailSnapshot(sessionKey)}`);
          }
          // The locked runtime's own footprint under DSH_HOME (names +
          // sizes only — never file content, which could carry the
          // session store's transcript) plus error-shaped log lines.
          try {
            const walk = (dir: string, depth: number): void => {
              if (depth > 3) {
                return;
              }
              for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) {
                  console.log(`[gateway-host] dshHome dir ${full.slice(dshHome.length) || "/"}`);
                  walk(full, depth + 1);
                } else {
                  console.log(`[gateway-host] dshHome file ${full.slice(dshHome.length)} bytes=${statSync(full).size}`);
                }
              }
            };
            walk(dshHome, 0);
          } catch {
            console.log("[gateway-host] dshHome walk failed");
          }
        }, 30_000);
      }
      return;
    }
    if (frame.name === "turn.settled") {
      pendingTurn = null;
      if (watchdog !== null) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    }
  });

  await wired.start();

  console.log(`GATEWAY-HOST READY endpoint=${wired.endpoint.path}`);
  const shutdown = async () => {
    try {
      await wired.stop();
      await mock.close();
    } catch {
      // Best-effort teardown.
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

void main().catch((error: unknown) => {
  console.error(`[gateway-host] boot failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
