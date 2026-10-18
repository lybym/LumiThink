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
 * The real profile IS wired-loop proven in CI since E2E-08 (issue #58): the
 * wiring-e2e job swaps the host to `LUMITHINK_GATEWAY_AGENT=real` behind the
 * SAME pinned server and re-runs the full loop — the REAL locked-version DSH
 * worker child process answers inside the wired stack (the E2E-02 gate
 * remains the worker-mechanics bisection anchor, same HEAD).
 *
 * Readiness line: prints `GATEWAY-HOST READY endpoint=<uds-path>
 * agent=<synthetic|real>` once the protected transport is listening; exits
 * non-zero on any boot failure.
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
 * TYPECHECK NOTE (updated by E2E-08, issue #58): this launcher imports
 * `poc/dsh-child` sources; it is typechecked by the scoped project
 * `scripts/xiaozhi/tsconfig.json` (extends the poc toolchain so the poc
 * types resolve) wired into CI as `pnpm run typecheck:gateway-host`
 * (e2e-07-gateway-wiring-gate.yml wiring-e2e job). The ROOT tsconfig still
 * excludes this path (its program must stay poc-free), and `poc/dsh-child`
 * is an isolated package with its own toolchain and @types resolution.
 */

import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createWiredVoiceGateway, type WiredVoiceGateway } from "../../lib/server/voice-gateway-wiring.ts";
import { createGatewayModelRoute, type GatewayModelRoute } from "../../lib/server/gateway-model-route.ts";
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

  // ---- model route (E2E-08, issue #58): synthetic mock (default, CI) or the
  // operator opt-in REAL provider route (LUMITHINK_MODEL_ROUTE=real + the
  // full LUMITHINK_REAL_PROVIDER_* record, E2E-03 contract). The REAL route
  // starts the loopback gateway egress proxy and overrides the worker's model
  // base URL via workerEnv (the pinned profile prefers
  // DSH_BRIDGE_MODEL_BASE_URL over the synthetic mock); the vendor credential
  // never leaves the host-side keySource closure.
  let modelRoute: GatewayModelRoute;
  try {
    modelRoute = await createGatewayModelRoute(process.env);
  } catch (error) {
    console.error(`[gateway-host] model route failed closed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (modelRoute.mode === "real") {
    console.log(`[gateway-host] model route mode=real provider=${modelRoute.providerId} proxy=loopback`);
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
      ...(modelRoute.mode === "real"
        ? {
            provider: modelRoute.providerId ?? undefined,
            model: modelRoute.modelId ?? undefined,
            workerEnv: modelRoute.workerEnv,
          }
        : {}),
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
      // The SYNTHETIC runtime is pump-driven by contract (deterministic
      // replay surface): pump only AFTER the dispatch completed —
      // turn_started is sent once turn.prompt+turn.stream both succeeded,
      // so the runtime's attempt is active and the deltas land in the
      // stream gate. Pumping at turn.accepted would re-enter mid-dispatch
      // and lose every delta (observed: settle COMPLETED, 0 admissions).
      if (frame.kind === "turn_started" && agentRuntime === "synthetic") {
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
      // E2E-08 (issue #58) real-profile evidence: a settled turn in real
      // mode must have been served by a LIVE locked-version DSH worker
      // child process (content-free; session keys are synthetic).
      if (agentRuntime === "real") {
        const workers = wired.stack
          .mappingSnapshot()
          .map((entry) => `${entry.sessionKey}:${(agentPort as RealCordisAgentPort).hasLiveWorker(entry.sessionKey) ? "live" : "dead"}`)
          .join(",");
        console.log(`[gateway-host] real agent workers ${workers} rssMB=${Math.round(process.memoryUsage().rss / 1048576)} (E2E-08 memory trail)`);
      }
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

  // The endpoint union mirrors the protected transport (UDS production /
  // named pipe on Windows dev): print the actual endpoint label — a naked
  // `.path` access would not typecheck on the union (E2E-08 scoped
  // typecheck, issue #58).
  const endpointLabel = wired.endpoint.kind === "uds" ? wired.endpoint.path : `\\\\.\\pipe\\${wired.endpoint.name}`;
  console.log(`GATEWAY-HOST READY endpoint=${endpointLabel} agent=${agentRuntime}`);
  const shutdown = async () => {
    try {
      await wired.stop();
      if (mock !== null) {
        await mock.close();
      }
      await modelRoute.stop();
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
