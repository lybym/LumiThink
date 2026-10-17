/**
 * E2E-07 (issue #57) — Voice Gateway host launcher: boots the REAL wired
 * stack for the xiaozhi-esp32-server bridge (CI + operator opt-in runs):
 *
 *   pinned xiaozhi server (device WS, VAD, ASR, TTS, Opus)
 *     → bridge LLM module (deploy/xiaozhi/gateway_bridge/lumithink_llm.py)
 *       → PROTECTED internal transport (UDS + token, no TCP)
 *         → THIS host:
 *             VoiceGatewayStack (REAL local-socket Bridge IPC)
 *               → the agent runtime selected by LUMITHINK_GATEWAY_AGENT:
 *                 - `synthetic` (default, CI): the deterministic in-process
 *                   synthetic Cordis runtime — reproducible wiring evidence;
 *                 - `real` (operator opt-in): the REAL locked-version DSH
 *                   Cordis agent port (worker child process, poc/dsh-child,
 *                   dsh-v0.2.0-rc.2) over the local synthetic Messages mock.
 *
 * NEITHER runtime is the pinned server's built-in AI second path (that is
 * structurally unreachable: the bridge module is the ONLY selected LLM).
 * The real-runtime CI proof is the E2E-02 gate (poc/dsh-child, same HEAD).
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
 *   LUMITHINK_GATEWAY_AGENT         `synthetic` (default) | `real`
 *   LUMITHINK_GATEWAY_HOME          scratch dir for the DSH home (`real`)
 *
 * TYPECHECK NOTE: this launcher imports `poc/dsh-child` sources and is
 * therefore excluded from the ROOT tsconfig — `poc/dsh-child` is an
 * isolated package with its own toolchain and @types resolution
 * (pnpm-workspace.yaml: "poc/dsh-child ... must stay fully isolated").
 * The launcher is validated at RUNTIME by the e2e-07 CI wiring job (boot
 * readiness is a hard gate) and by `pnpm --dir poc/dsh-child run
 * typecheck` for the imported poc surface.
 */

import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createWiredVoiceGateway, type WiredVoiceGateway } from "../../lib/server/voice-gateway-wiring.ts";
import type { MockGenerationScript } from "../../lib/domain/voice/bridge/mock-cordis.ts";
import type { BridgeAgentPort } from "../../lib/domain/voice/bridge/agent-port.ts";
import { MockMessagesServer } from "../../poc/dsh-child/src/mock-model.ts";
import { materializeBridgeProfileInto, createRealCordisAgentPort, type RealCordisAgentPort } from "../../poc/dsh-child/src/real-agent-port.ts";
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

  // ---- agent runtime selection -----------------------------------------
  const agentRuntime = process.env.LUMITHINK_GATEWAY_AGENT ?? "synthetic";
  let agentPort: BridgeAgentPort | undefined;
  let mock: MockMessagesServer | null = null;
  let dshHome = "";
  if (agentRuntime === "real") {
    if (!canSpawnPipedChild()) {
      console.error(
        "[gateway-host] piped stdio child processes are unavailable here; the REAL DSH worker requires a normal shell/CI (fail-closed)",
      );
      process.exit(1);
    }
    dshHome = process.env.LUMITHINK_GATEWAY_HOME ?? mkdtempSync(join(tmpdir(), "lumithink-gw-host-"));
    await materializeBridgeProfileInto(dshHome);
    mock = new MockMessagesServer({ fixedTurnTexts: FIXED_TURN_TEXTS });
    const mockBaseUrl = await mock.listen();
    const realPort: RealCordisAgentPort = createRealCordisAgentPort({
      dshHome,
      mockBaseUrl,
      childBootTimeoutMs: 20_000,
    });
    realPort.onFault((info) => {
      console.error(
        `[gateway-host] agent fault session=${info.sessionKey} code=${info.code} detail=${info.detail} exit=${String(info.exitCode)} message=${info.message ?? ""}`,
      );
    });
    agentPort = realPort;
  } else if (agentRuntime !== "synthetic") {
    console.error(`[gateway-host] unknown LUMITHINK_GATEWAY_AGENT value: ${agentRuntime}`);
    process.exit(1);
  }

  const wired = createWiredVoiceGateway({
    bindings,
    deviceAuthKey: authKey,
    transportAuthToken: transportToken,
    // The protected transport listens EXACTLY on the configured UDS path —
    // the pinned server's bridge config points there.
    transportEndpoint: { kind: "uds", path: resolve(socketPath) },
    scriptFor,
    ...(agentPort !== undefined ? { agentPort } : {}),
    ...(agentPort !== undefined
      ? { onAgentFault: (listener: (info: { readonly sessionKey: string; readonly code: "worker_crashed" }) => void) => (agentPort as RealCordisAgentPort).onFault(listener) }
      : {}),
    transport: "ipc",
    // Content-free lifecycle diagnostics (CI evidence; no content).
    onBridgeFrame: (frame) => {
      console.log(`[gateway-host] frame -> bridge kind=${frame.kind}`);
    },
  });

  // Content-free turn-level diagnostics (CI evidence): stack events and
  // the gate metrics on settlement — no content fields.
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

  // Watchdog: if a turn stays unsettled for 30s, dump content-free
  // diagnostics (turn state, gate metrics, worker liveness + bounded
  // stderr tail + the DSH home footprint — names/sizes only, never file
  // content, which could carry the session store's transcript).
  let pendingTurn: string | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  let syntheticPump: NodeJS.Timeout | null = null;
  wired.stack.stack.client.onEvent((frame) => {
    if (frame.kind !== "event") {
      return;
    }
    const payload = (frame.payload ?? {}) as Record<string, unknown>;
    if (frame.name === "turn.accepted" && typeof payload.turnId === "string") {
      pendingTurn = payload.turnId;
      // The SYNTHETIC runtime is pump-driven by contract (deterministic
      // replay surface): the wired host drives it here, the way the tests
      // do. The REAL DSH worker streams autonomously — never pumped.
      if (agentRuntime === "synthetic") {
        for (const sessionKey of wired.stack.mappingSnapshot().map((entry) => entry.sessionKey)) {
          wired.stack.stack.pumpRuntime(sessionKey, 50);
        }
        if (syntheticPump === null) {
          syntheticPump = setInterval(() => {
            for (const sessionKey of wired.stack.mappingSnapshot().map((entry) => entry.sessionKey)) {
              wired.stack.stack.pumpRuntime(sessionKey, 50);
            }
          }, 100);
        }
      }
      if (watchdog === null) {
        watchdog = setTimeout(() => {
          if (pendingTurn === null) {
            return;
          }
          const sessionKeys = wired.stack.mappingSnapshot().map((entry) => entry.sessionKey);
          const gate = wired.stack.stack.gate.metricsSnapshot();
          console.log(
            `[gateway-host] watchdog gate metrics deltasFenced=${gate.deltasFenced} ttsAdmissions=${gate.ttsAdmissions} ttsBlocked=${gate.ttsBlockedSentences} deliveryFailures=${gate.sentenceDeliveryFailures} firstSafeText=${gate.firstSafeText.count}`,
          );
          const realPort = agentPort as RealCordisAgentPort | undefined;
          const aliveFn = realPort?.hasLiveWorker;
          for (const sessionKey of sessionKeys) {
            const described = wired.stack.stack.orchestrator.describeTurn(sessionKey, pendingTurn);
            const alive = typeof aliveFn === "function" ? aliveFn.call(realPort, sessionKey) : "n/a";
            console.log(
              `[gateway-host] watchdog turn=${pendingTurn} session=${sessionKey} state=${described?.state ?? "<unknown>"} epoch=${String(described?.epoch ?? "<none>")} workerLive=${String(alive)}`,
            );
            if (realPort !== undefined) {
              console.log(`[gateway-host] watchdog stderrTail session=${sessionKey}:\n${realPort.stderrTailSnapshot(sessionKey)}`);
            }
          }
          if (dshHome !== "") {
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
      if (syntheticPump !== null) {
        clearInterval(syntheticPump);
        syntheticPump = null;
      }
    }
  });

  await wired.start();

  console.log(`GATEWAY-HOST READY endpoint=${wired.endpoint.path}`);
  const shutdown = async () => {
    try {
      await wired.stop();
      if (mock !== null) {
        await mock.close();
      }
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
