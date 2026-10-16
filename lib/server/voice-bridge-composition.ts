/**
 * R1-V2 Bridge composition — the Orchestrator-side integration that binds
 * the R1-V1 Turn Orchestrator, the children Output Gate stream handling,
 * the private IPC transport and the Bridge service into one working
 * runtime (issue #29 实现范围 1–5; docs/VOICE_RUNTIME.md §2/§4).
 *
 * This is the composition the issue's acceptance scenarios drive. It owns
 * the STRICT interruption ordering (docs/VOICE_RUNTIME.md §4):
 *   1. `bargeInCancel` fences FIRST (R1-V1 `cancelTurn` atomically bumps
 *      the trusted epoch and revokes the old turn's output rights),
 *   2. only then sends `turn.cancel` to the Bridge, which performs the
 *      in-process `agent.cancel({ kind: 'user' })` and awaits
 *      `whenIdle()`,
 *   3. on idle confirmation the Orchestrator settles CANCELLED and the
 *      scheduler may dispatch the next queued turn (`whenIdle 后调度新
 *      turn`) — never before.
 *
 * Live deltas flow runtime → Bridge → IPC → stream gate, where every
 * delta is re-fenced against the CURRENT trusted epoch and every complete
 * sentence passes the REAL R1-15 children Output Gate before TTS
 * admission. Late deltas of a fenced epoch are rejected at the gate.
 *
 * Crash semantics: a worker fault quarantines the Bridge worker; the
 * affected turn settles FAILED (never resumes), and only after a fresh
 * session.open rebuilds the worker does the scheduler dispatch again —
 * confirmed state only, no side-effect replay.
 *
 * PRIVACY (revised by issue #51 / E2E-01): the ONLY transcript plaintext in
 * this composition is the authorized transient channel — `submitPrompt`
 * holds it in the bounded in-memory prompt vault until the turn's
 * `turn.prompt` dispatch consumes it (destroyed on use, failure, cancel or
 * crash); it is never persisted, exported, logged or audited. No child
 * audio or key material ever appears here; the auth token is generated per
 * process and never logged.
 */

import { randomBytes } from "node:crypto";
import {
  createBridgeStreamGate,
  type BridgeStreamGate,
} from "../domain/voice/bridge/stream-gate.ts";
import {
  createVoiceBridge,
  type BridgeMetricsSnapshot,
  type VoiceBridgeService,
} from "../domain/voice/bridge/bridge.ts";
import type { BridgeAgentPort } from "../domain/voice/bridge/agent-port.ts";
import { createMockCordisRuntime, type MockCordisRuntime, type MockGenerationScript } from "../domain/voice/bridge/mock-cordis.ts";
import { canonicalBridgeProfile, type BridgeCordisProfile } from "../domain/voice/bridge/profile.ts";
import { createVoiceTurnOrchestrator, type VoiceTurnOrchestrator } from "../domain/voice/orchestrator.ts";
import { VOICE_TERMINAL_TURN_STATES } from "../domain/voice/schema.ts";
import {
  createVoiceBridgeIpcClient,
  createVoiceBridgeIpcServer,
  dispatchBridgeCommand,
  resolveBridgeIpcEndpoint,
  wireBridgeEventForwarding,
  type BridgeIpcEndpoint,
  type VoiceBridgeIpcClient,
  type VoiceBridgeIpcServer,
} from "./voice-bridge-ipc.ts";
import { parseBridgeFrame, type BridgeCommandFrame, type BridgeFrame } from "../domain/voice/bridge/ipc-contract.ts";

// ---------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------

export interface VoiceBridgeStackOptions {
  /** Deterministic per-turn generation script (synthetic samples only). */
  readonly scriptFor: (sessionKey: string, turnId: string) => MockGenerationScript;
  readonly profile?: Readonly<BridgeCordisProfile>;
  readonly socketDir?: string;
  readonly endpointName?: string;
  /**
   * `ipc` (default) runs the REAL local-socket transport (UDS on the POSIX
   * production target / named pipe on Windows dev). `in_process` runs the
   * same frame protocol and dispatch order over an in-memory queue — used
   * where the sandbox forbids opening sockets; it is a test/analysis mode,
   * never the deployment shape.
   */
  readonly transport?: "ipc" | "in_process";
  /**
   * E2E-02 (issue #52): an injected REAL agent port (the locked-version
   * DSH Cordis adapter from `poc/dsh-child`) replaces the synthetic mock
   * runtime as the Bridge's upstream. The composition semantics — one
   * handle per session, fence-first cancel, quarantine/recovery — are
   * identical for both. Default (omitted) keeps the synthetic mock.
   */
  readonly agentPort?: BridgeAgentPort;
  /**
   * Fault signal of an injected agent port (wired to the Bridge's worker
   * quarantine). The default mock runtime's fault channel is pre-wired.
   */
  readonly onAgentFault?: (listener: (info: { readonly sessionKey: string; readonly code: "worker_crashed" }) => void) => void;
  /** Injectable wall clock (ms) shared by orchestrator/gate/bridge. */
  readonly clock?: () => number;
  /** Injectable turn-id factory for deterministic tests. */
  readonly turnIdFactory?: () => string;
}

export interface BridgeBaselineMetrics {
  /** 取消命令 ACK（受理，非停稳）— candidate baseline. */
  readonly cancelAckMs: { readonly count: number; readonly maxMs: number };
  /** Agent `whenIdle()` 停稳 — candidate baseline. */
  readonly whenIdleMs: { readonly count: number; readonly maxMs: number };
  /** 首段安全文字（首个通过 Output Gate 的 TTS 准入）— candidate baseline. */
  readonly firstSafeTextMs: { readonly count: number; readonly maxMs: number };
  /** 异常 Worker 回收重建 — candidate baseline. */
  readonly workerRecoveryMs: { readonly count: number; readonly maxMs: number };
}

export interface VoiceBridgeStack {
  readonly orchestrator: VoiceTurnOrchestrator;
  readonly gate: BridgeStreamGate;
  readonly service: VoiceBridgeService;
  readonly runtime: MockCordisRuntime;
  /** The agent port actually serving the Bridge (mock by default; the injected real adapter when provided, issue #52). */
  readonly agentPort: BridgeAgentPort;
  /** Null in `in_process` transport mode (no socket exists). */
  readonly server: VoiceBridgeIpcServer | null;
  readonly client: VoiceBridgeIpcClient;
  readonly endpoint: BridgeIpcEndpoint;
  readonly transportMode: "ipc" | "in_process";
  start(): Promise<void>;
  stop(): Promise<void>;
  openSession(refs: {
    readonly sessionKey: string;
    readonly conversationId: string;
    readonly ownerActorId: string;
  }): Promise<{ ok: true; recovered: boolean } | { ok: false; code: string }>;
  /**
   * Submit one new prompt (new ASR). `transientText` is REQUIRED (issue
   * #51): a voice prompt without its transcript must never dispatch, so no
   * digest-only model input can exist. When the scheduler can dispatch
   * immediately the Bridge commands go out; a busy session leaves the
   * turn queued (dispatched=false) until a later stop/settlement pumps it.
   */
  submitPrompt(refs: {
    readonly sessionKey: string;
    readonly traceId?: string;
    readonly idempotencyKey?: string;
    readonly fingerprint?: string;
    readonly transientText: string;
  }): Promise<{ ok: true; turnId: string; dispatched: boolean } | { ok: false; code: string }>;
  /**
   * The effective interruption: fence FIRST (epoch bump), then Bridge
   * cancel + whenIdle, then CANCELLED settlement, then scheduler pump.
   */
  bargeInCancel(refs: {
    readonly sessionKey: string;
    readonly turnId: string;
    readonly reason: "device_abort" | "barge_in" | "system_policy";
  }): Promise<{ ok: true } | { ok: false; code: string; fenced: boolean }>;
  /** Drive the synthetic runtime's generation (deterministic dispatch). */
  pumpRuntime(sessionKey: string, max?: number): number;
  /** Drive the orchestrator scheduler pump. */
  pumpScheduler(sessionKey: string): { ok: boolean; dispatchedTurnId: string | null; busyTurnId: string | null };
  /** Merged candidate baseline metrics (never claimed as achieved SLAs). */
  baselineMetrics(): Readonly<BridgeBaselineMetrics>;
}

/**
 * Transient prompt vault (issue #51 / E2E-01). Holds the authorized ASR
 * transcript of a QUEUED turn between submission and dispatch. Rules:
 * - bounded capacity (oldest entry dropped — a starved turn fails closed at
 *   dispatch instead of growing unbounded memory);
 * - in-memory ONLY: never exported, persisted, logged or audited;
 * - taken (destroyed) exactly at the `turn.prompt` dispatch — success OR
 *   failure — and destroyed at every other path where the turn can no
 *   longer run (fence, crash, settlement);
 * - a text-bearing turn whose entry is missing at dispatch (e.g. lost to a
 *   process restart) fails CLOSED: the turn settles FAILED rather than
 *   dispatching a digest-only prompt.
 */
const PROMPT_VAULT_MAX_ENTRIES = 64;

function promptVaultKey(sessionKey: string, turnId: string): string {
  return `${sessionKey}\u0000${turnId}`;
}

/** Create the full voice bridge stack (no sockets until start()). */
export function createVoiceBridgeStack(options: VoiceBridgeStackOptions): VoiceBridgeStack {
  if (options === null || typeof options !== "object" || typeof options.scriptFor !== "function") {
    throw new Error("voice bridge stack requires a scriptFor function.");
  }
  const clock = options.clock ?? (() => Date.now());
  const profile = options.profile ?? canonicalBridgeProfile();

  const orchestrator = createVoiceTurnOrchestrator({
    clock,
    ...(options.turnIdFactory !== undefined ? { turnIdFactory: options.turnIdFactory } : {}),
  });
  const mockRuntime = createMockCordisRuntime({ scriptFor: options.scriptFor });
  // E2E-02 (issue #52): an injected port (the real locked-version DSH Cordis
  // adapter) takes the Bridge's upstream seat; the synthetic mock remains the
  // default and keeps its deterministic pump surface (`runtime` field).
  const agentPort: BridgeAgentPort = options.agentPort ?? mockRuntime;
  const service = createVoiceBridge({ profile, agentPort, clock });
  mockRuntime.onFault((info) => service.handleAgentCrash(info.sessionKey));
  options.onAgentFault?.((info) => service.handleAgentCrash(info.sessionKey));
  const gate = createBridgeStreamGate({ orchestrator, clock });

  const endpointName = options.endpointName ?? `lumithink-bridge-${process.pid}-${Math.floor(Math.random() * 0xffffff).toString(16)}`;
  const endpoint = resolveBridgeIpcEndpoint({ ...(options.socketDir !== undefined ? { socketDir: options.socketDir } : {}), name: endpointName });
  // Per-process lease secret; never logged, never persisted.
  const authToken = randomBytes(48).toString("hex");
  const transportMode = options.transport ?? "ipc";
  const server = transportMode === "ipc" ? createVoiceBridgeIpcServer({ endpoint, authToken, service }) : null;

  /**
   * In-process transport: the SAME frame protocol (round-tripped through
   * the real parser) and the SAME dispatch function as the socket server,
   * delivered over an ordered async queue. No sockets are opened.
   */
  function createInProcessClient(): VoiceBridgeIpcClient {
    const eventListeners: ((frame: BridgeFrame) => void)[] = [];
    let connected = false;
    let nextSeq = 1;
    let processQueue: Promise<void> = Promise.resolve();
    // Same shared event wiring as the socket server (single source).
    wireBridgeEventForwarding(service, (event) => {
      const raw = JSON.stringify(event);
      try {
        const parsed = parseBridgeFrame(raw);
        processQueue = processQueue
          .then(() => {
            for (const listener of [...eventListeners]) {
              listener(parsed);
            }
          })
          .catch(() => undefined);
      } catch {
        // An unserviceable event frame must never leak past the boundary.
      }
    });
    return {
      async connect() {
        connected = true;
      },
      async command(name, payload) {
        if (!connected) {
          return { ok: false, code: "protocol_violation" };
        }
        const seq = nextSeq;
        nextSeq += 1;
        let frame: BridgeFrame;
        try {
          const raw = JSON.stringify({ kind: "command", name, seq, payload });
          frame = parseBridgeFrame(raw);
          if (frame.kind !== "command") {
            return { ok: false, code: "protocol_violation" };
          }
        } catch {
          return { ok: false, code: "protocol_violation" };
        }
        const reply = await dispatchBridgeCommand(service, frame as BridgeCommandFrame);
        if (reply.kind !== "reply") {
          return { ok: false, code: "protocol_violation" };
        }
        return reply.ok ? { ok: true, payload: reply.payload } : { ok: false, code: reply.code };
      },
      onEvent(listener) {
        eventListeners.push(listener);
      },
      sendRaw() {
        // Raw-frame injection is a socket-transport test affordance only.
      },
      sendBytes() {
        // Raw-byte injection is a socket-transport test affordance only.
      },
      isConnected() {
        return connected;
      },
      async close() {
        connected = false;
        eventListeners.length = 0;
      },
    };
  }

  const client: VoiceBridgeIpcClient =
    transportMode === "ipc" ? createVoiceBridgeIpcClient({ endpoint, authToken }) : createInProcessClient();

  let started = false;

  // Transient prompt vault (issue #51): see the constant block above.
  const promptVault = new Map<string, string>();

  function vaultPut(sessionKey: string, turnId: string, text: string): void {
    const key = promptVaultKey(sessionKey, turnId);
    if (!promptVault.has(key) && promptVault.size >= PROMPT_VAULT_MAX_ENTRIES) {
      const oldest = promptVault.keys().next();
      if (oldest.done !== true) {
        promptVault.delete(oldest.value);
      }
    }
    promptVault.set(key, text);
  }

  /** Take (read-once-destroy) the held transcript for one turn. */
  function vaultTake(sessionKey: string, turnId: string): string | undefined {
    const key = promptVaultKey(sessionKey, turnId);
    const text = promptVault.get(key);
    if (text !== undefined) {
      promptVault.delete(key);
    }
    return text;
  }

  /** Destroy the held transcript for one turn (failure/cancel path). */
  function vaultDestroy(sessionKey: string, turnId: string): void {
    promptVault.delete(promptVaultKey(sessionKey, turnId));
  }

  async function dispatchQueuedTurn(sessionKey: string): Promise<boolean> {
    const pumped = orchestrator.pump(sessionKey);
    if (!pumped.ok || pumped.dispatchedTurnId === null) {
      return false;
    }
    const issued = await issueBridgeDispatch(sessionKey, pumped.dispatchedTurnId);
    if (!issued.ok) {
      // The Bridge refused the dispatch (e.g. quarantined worker): the
      // trusted turn can never run — settle it FAILED so the scheduler
      // stays live instead of holding a stuck RUNNING turn.
      orchestrator.settleTurn({ sessionKey, turnId: pumped.dispatchedTurnId, outcome: "FAILED" });
      gate.clearTurn(sessionKey, pumped.dispatchedTurnId);
      // The refusal is THIS turn's failure, not the queue's: keep pumping
      // so one fail-closed turn (e.g. prompt_text_lost after vault
      // starvation) does not strand its QUEUED siblings. Every recursion
      // settles one turn terminal, so the drain always terminates
      // (issue #51 review R1 test gap 1: the queue must stay live).
      await dispatchQueuedTurn(sessionKey);
      return false;
    }
    return issued.ok;
  }

  async function issueBridgeDispatch(sessionKey: string, turnId: string): Promise<{ ok: true } | { ok: false; code: string }> {
    const epoch = orchestrator.currentEpoch(sessionKey);
    const turn = orchestrator.describeTurn(sessionKey, turnId);
    if (turn === null || epoch === null) {
      return { ok: false, code: "session_unknown" };
    }
    // The transcript is consumed exactly here, whether or not the dispatch
    // succeeds — a destroyed-on-use invariant (issue #51 失败销毁). A
    // text-bearing turn without a vault entry (lost to a restart) must
    // NEVER dispatch as a digest-only prompt: fail closed.
    const heldText = vaultTake(sessionKey, turnId);
    if (heldText === undefined) {
      return { ok: false, code: "prompt_text_lost" };
    }
    const promptReply = await client.command("turn.prompt", {
      sessionKey,
      turnId,
      epoch,
      promptText: heldText,
      ...(turn.idempotencyKey !== null ? { idempotencyKey: turn.idempotencyKey } : {}),
      ...(turn.fingerprint !== null ? { fingerprint: turn.fingerprint } : {}),
    });
    if (!promptReply.ok) {
      return { ok: false, code: promptReply.code };
    }
    const streamReply = await client.command("turn.stream", { sessionKey, turnId, epoch });
    if (!streamReply.ok) {
      return { ok: false, code: streamReply.code };
    }
    return { ok: true };
  }

  function handleBridgeEvent(frame: unknown): void {
    if (frame === null || typeof frame !== "object") {
      return;
    }
    const event = frame as { readonly kind?: string; readonly name?: string; readonly payload?: unknown };
    if (event.kind !== "event") {
      return;
    }
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    switch (event.name) {
      case "assistant.delta": {
        gate.handleDelta(payload as unknown as Parameters<BridgeStreamGate["handleDelta"]>[0]);
        return;
      }
      case "attempt.ended": {
        if (typeof payload.sessionKey === "string") {
          gate.flushSession(payload.sessionKey);
        }
        return;
      }
      case "turn.settled": {
        if (
          typeof payload.sessionKey === "string" &&
          typeof payload.turnId === "string"
        ) {
          const finalState = typeof payload.finalState === "string" ? payload.finalState : null;
          if (finalState === "COMPLETED") {
            const settled = orchestrator.settleTurn({
              sessionKey: payload.sessionKey,
              turnId: payload.turnId,
              outcome: "COMPLETED",
            });
            if (settled.ok) {
              vaultDestroy(payload.sessionKey, payload.turnId);
              gate.clearTurn(payload.sessionKey, payload.turnId);
              void dispatchQueuedTurn(payload.sessionKey);
            }
          } else if (finalState === "FAILED") {
            // E2E-03 (issue #53 DoD 2): a model-request failure settles the
            // turn FAILED at the Bridge (durable-settlement-absent marker).
            // The trusted turn must reach a terminal state — the scheduler
            // stays live and the failure is auditable at the Gateway.
            const settled = orchestrator.settleTurn({
              sessionKey: payload.sessionKey,
              turnId: payload.turnId,
              outcome: "FAILED",
            });
            if (settled.ok) {
              vaultDestroy(payload.sessionKey, payload.turnId);
              gate.clearTurn(payload.sessionKey, payload.turnId);
              void dispatchQueuedTurn(payload.sessionKey);
            }
          }
        }
        return;
      }
      case "runtime.error": {
        if (payload.code === "worker_crashed" && typeof payload.sessionKey === "string") {
          // The quarantined worker's active turn can never resume: settle
          // FAILED (legal from RUNNING/CANCELLING), clear the volatile gate
          // buffer, and wait for an explicit reopen — no silent recovery,
          // no side-effect replay. Held transcripts are destroyed (issue
          // #51 失败销毁).
          for (const turn of orchestrator.listTurns(payload.sessionKey)) {
            if (turn.state === "RUNNING" || turn.state === "CANCELLING" || turn.state === "QUEUED") {
              orchestrator.settleTurn({
                sessionKey: payload.sessionKey,
                turnId: turn.turnId,
                outcome: "FAILED",
              });
              vaultDestroy(payload.sessionKey, turn.turnId);
              gate.clearTurn(payload.sessionKey, turn.turnId);
            }
          }
          return;
        }
        if (payload.code === "recovered" && typeof payload.sessionKey === "string") {
          void dispatchQueuedTurn(payload.sessionKey);
        }
        return;
      }
      default:
        return;
    }
  }

  const stack: VoiceBridgeStack = {
    orchestrator,
    gate,
    service,
    runtime: mockRuntime,
    agentPort,
    server,
    client,
    endpoint,
    transportMode,

    async start() {
      if (started) {
        return;
      }
      client.onEvent(handleBridgeEvent);
      if (server !== null) {
        await server.start();
      }
      await client.connect();
      started = true;
    },

    async stop() {
      if (!started) {
        return;
      }
      await client.close();
      if (server !== null) {
        await server.stop();
      }
      started = false;
    },

    async openSession(refs) {
      const opened = orchestrator.openSession({
        sessionKey: refs.sessionKey,
        conversationId: refs.conversationId,
        ownerActorId: refs.ownerActorId,
      });
      if (!opened.ok) {
        return { ok: false, code: opened.code };
      }
      const reply = await client.command("session.open", {
        sessionKey: refs.sessionKey,
        ownerActorId: refs.ownerActorId,
        conversationId: refs.conversationId,
      });
      if (!reply.ok) {
        return { ok: false, code: reply.code };
      }
      await dispatchQueuedTurn(refs.sessionKey);
      const value = (reply.payload ?? {}) as { recovered?: boolean };
      return { ok: true, recovered: value.recovered === true };
    },

    async submitPrompt(refs) {
      const received = orchestrator.receivePrompt({
        sessionKey: refs.sessionKey,
        traceId: refs.traceId ?? null,
        ...(refs.idempotencyKey !== undefined && refs.fingerprint !== undefined
          ? { idempotencyKey: refs.idempotencyKey, fingerprint: refs.fingerprint }
          : {}),
      });
      if (!received.ok) {
        return { ok: false, code: received.code };
      }
      const turnId = received.turn.turnId;
      // Hold the transcript until the turn actually dispatches (bounded,
      // in-memory, destroyed on use/failure). A same-key replay re-puts the
      // same keyed content — same key + same fingerprint implies the same
      // text — so the queued turn keeps its liveness. A replay of an
      // already-TERMINAL turn must NOT re-put: it can never dispatch again,
      // so the entry would sit unconsumed until LRU eviction, against the
      // vault's destroy-when-the-turn-can-no-longer-run invariant
      // (issue #51 review R1 P2-2).
      if (!(VOICE_TERMINAL_TURN_STATES as readonly string[]).includes(received.turn.state)) {
        vaultPut(refs.sessionKey, turnId, refs.transientText);
      }
      const dispatched = received.dispatchedTurnId === turnId;
      if (dispatched) {
        const issued = await issueBridgeDispatch(refs.sessionKey, turnId);
        if (!issued.ok) {
          // Same rollback as dispatchQueuedTurn: a refused dispatch means
          // the trusted turn can never run; settle FAILED (liveness).
          orchestrator.settleTurn({ sessionKey: refs.sessionKey, turnId, outcome: "FAILED" });
          gate.clearTurn(refs.sessionKey, turnId);
          // Same liveness duty as dispatchQueuedTurn: a sibling that raced
          // in QUEUED behind this turn must not strand behind the failure.
          await dispatchQueuedTurn(refs.sessionKey);
          return { ok: false, code: issued.code };
        }
      }
      return { ok: true, turnId, dispatched };
    },

    async bargeInCancel(refs) {
      // STEP 1 — fence FIRST: the R1-V1 store atomically bumps the trusted
      // epoch and revokes the old turn's text/TTS/audio/write permissions.
      const fenced = orchestrator.cancelTurn({
        sessionKey: refs.sessionKey,
        turnId: refs.turnId,
        reason: refs.reason,
      });
      if (!fenced.ok) {
        return { ok: false, code: fenced.code, fenced: false };
      }
      // The fence revoked the target turn AND every queued sibling: their
      // transcripts can never reach a model request — destroy them now.
      vaultDestroy(refs.sessionKey, refs.turnId);
      for (const fencedTurnId of fenced.fencedTurnIds) {
        vaultDestroy(refs.sessionKey, fencedTurnId);
      }
      // STEP 2 — in-process cancel at the Bridge (source-level stop).
      const reply = await client.command("turn.cancel", {
        sessionKey: refs.sessionKey,
        turnId: refs.turnId,
        epoch: orchestrator.currentEpoch(refs.sessionKey),
        reason: refs.reason,
      });
      // `cancel_unknown_turn` means the fenced turn was still QUEUED and
      // had never been dispatched to the Bridge: there is no in-process
      // attempt to stop, so the fence alone already revoked it — settling
      // CANCELLED is correct (and only for that code; a real Bridge
      // failure such as cancel_timeout must NOT be papered over).
      if (!reply.ok && reply.code !== "cancel_unknown_turn") {
        return { ok: false, code: reply.code, fenced: true };
      }
      // STEP 3 — idle confirmed: CANCELLING → CANCELLED in the trusted store.
      const confirmed = orchestrator.confirmStop({ sessionKey: refs.sessionKey, turnId: refs.turnId });
      if (!confirmed.ok) {
        return { ok: false, code: confirmed.code, fenced: true };
      }
      gate.clearTurn(refs.sessionKey, refs.turnId);
      // The SAME atomic fence flipped every old-epoch non-terminal turn to
      // CANCELLING (queued siblings included). None of them can ever run:
      // settle each CANCELLED alongside the target, so the scheduler stays
      // live and no turn resurrects.
      for (const fencedTurnId of fenced.fencedTurnIds) {
        if (fencedTurnId === refs.turnId) {
          continue;
        }
        const settled = orchestrator.confirmStop({ sessionKey: refs.sessionKey, turnId: fencedTurnId });
        if (settled.ok) {
          gate.clearTurn(refs.sessionKey, fencedTurnId);
        }
      }
      // STEP 4 — only now may a queued turn be dispatched.
      await dispatchQueuedTurn(refs.sessionKey);
      return { ok: true };
    },

    pumpRuntime(sessionKey, max) {
      return mockRuntime.pump(sessionKey, max);
    },

    pumpScheduler(sessionKey) {
      const pumped = orchestrator.pump(sessionKey);
      return {
        ok: pumped.ok,
        dispatchedTurnId: pumped.ok ? pumped.dispatchedTurnId : null,
        busyTurnId: pumped.ok ? pumped.busyTurnId : null,
      };
    },

    baselineMetrics() {
      const bridge: BridgeMetricsSnapshot = service.metricsSnapshot();
      const gateMetrics = gate.metricsSnapshot();
      return {
        cancelAckMs: bridge.cancelAck,
        whenIdleMs: bridge.whenIdle,
        firstSafeTextMs: gateMetrics.firstSafeText,
        workerRecoveryMs: bridge.workerRecovery,
      };
    },
  };
  return stack;
}
