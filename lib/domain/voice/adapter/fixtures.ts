/**
 * R1-V3 replayable Mock protocol fixtures + sanitized report contract
 * (issue #30 实现范围 5: 详尽且可重放的 Mock 协议 fixture、脱敏测试报告与
 * 后续 R5 验收基线; docs/VOICE_GATEWAY_PROTOCOL.md).
 *
 * A fixture is a NAMED, deterministic fault scenario (no timers, no
 * randomness — the PRNG seed and the schedule order fully define the run).
 * `runGatewayFixture` in the fault-injection test drives each fixture twice:
 * once for the invariants, once for the replay fingerprint comparison.
 *
 * The sanitized report builder turns per-scenario results into a
 * content-free JSON document: counts, enumerated codes, hex digests and
 * candidate latency buckets only. A schema test proves no synthetic
 * sentence text can appear anywhere in a report.
 *
 * This module must stay dependency-free (no prisma, react, next, node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { XIAOZHI_GATEWAY_BASELINE } from "./protocol.ts";

// ---------------------------------------------------------------------------
// Fixture families (issue #30 实现范围 3, one entry per required fault)
// ---------------------------------------------------------------------------

export const GATEWAY_FIXTURE_FAMILIES = Object.freeze([
  {
    name: "late_asr",
    fault: "ASR final arrives while the old turn is still stopping (before and after the fence)",
    expect: "late prompt queued at its birth epoch; pre-fence siblings cancelled with the fence; post-fence prompt completes; zero old-epoch playback",
  },
  {
    name: "consecutive_abort",
    fault: "consecutive device aborts (连续抢话), including aborts with no active playback",
    expect: "exactly one fence per playback turn; aborts without playback are enumerated no-ops; zero duplicate stops; zero old responses",
  },
  {
    name: "server_restart",
    fault: "the self-hosted server restarts mid-session and every xiaozhi session id is invalidated",
    expect: "mappings invalidated; playback suspended; reconnect re-maps with a fresh session id; the old session id is refused (session_forged); no deadlock",
  },
  {
    name: "out_of_order_output",
    fault: "frame batches are held and applied out of order / after a stop",
    expect: "the device refuses every stale or post-stop batch (stale_epoch / after_stop); played frames are all current-epoch",
  },
  {
    name: "network_drop_reconnect",
    fault: "connection drop while a turn is running, then trusted rebind on the same device",
    expect: "playback suspended, not lost; prompts keep their trusted states; reconnect reuses the same trusted session and identity; frames only flow on the open connection",
  },
  {
    name: "duplicate_connection",
    fault: "a second connection for an already-connected device",
    expect: "the duplicate lease is refused (device_connection_conflict); its events are all rejected; the first lease is unaffected; no deadlock",
  },
  {
    name: "forged_identity",
    fault: "unknown device, foreign session ids, changed device_id without activation",
    expect: "all identity forgeries rejected enumerated (device_unbound / session_forged / session_not_mapped); the child session is never authorized",
  },
] as const);

export type GatewayFixtureFamily = (typeof GATEWAY_FIXTURE_FAMILIES)[number]["name"];

export function isGatewayFixtureFamily(value: unknown): value is GatewayFixtureFamily {
  return typeof value === "string" && GATEWAY_FIXTURE_FAMILIES.some((entry) => entry.name === value);
}

// ---------------------------------------------------------------------------
// Synthetic, child-safe sample pool (the ONLY text the fixtures use)
// ---------------------------------------------------------------------------

export const GATEWAY_SYNTHETIC_SENTENCES = Object.freeze([
  "我们一起看看这道题。",
  "先找已知条件。",
  "答案思路是分步计算。",
  "你刚才说得很好。",
  "再来试一次好吗？",
] as const);

// ---------------------------------------------------------------------------
// Sanitized report contract
// ---------------------------------------------------------------------------

export interface GatewayFixtureScenarioReport {
  readonly family: GatewayFixtureFamily;
  readonly seeds: readonly number[];
  readonly scenarios: number;
  readonly turnsTerminal: number;
  readonly nonTerminalTurns: number;
  readonly staleFramesPlayed: number;
  readonly staleFramesRefused: number;
  readonly abortsFenced: number;
  readonly abortsWithoutPlayback: number;
  readonly forgedSessionsRefused: number;
  readonly duplicateConnectionsRefused: number;
  readonly suspensions: number;
  readonly deadlocks: number;
}

export interface GatewaySanitizedReport {
  readonly report: "voice-gateway-adapter/1";
  readonly sanitized: true;
  readonly baseline: {
    readonly firmwareRepo: string;
    readonly firmwareTag: string;
    readonly serverRepo: string;
    readonly serverRef: string;
    readonly serverTag: string;
    readonly deviceVerified: boolean;
  };
  readonly totals: {
    readonly scenarios: number;
    readonly nonTerminalTurns: number;
    readonly staleFramesPlayed: number;
    readonly deadlocks: number;
  };
  readonly perFamily: readonly GatewayFixtureScenarioReport[];
  /**
   * Candidate latency/race buckets collected during the runs — reported,
   * never claimed as achieved SLAs (issue #30: 任何未测项不能写 PASS).
   */
  readonly candidateLatency: {
    readonly cancelAckMaxMs: number;
    readonly whenIdleMaxMs: number;
    readonly firstSafeTextMaxMs: number;
    readonly abortToStopDirectives: number;
  };
}

export function buildSanitizedReport(input: {
  readonly perFamily: readonly GatewayFixtureScenarioReport[];
  readonly cancelAckMaxMs: number;
  readonly whenIdleMaxMs: number;
  readonly firstSafeTextMaxMs: number;
}): GatewaySanitizedReport {
  const scenarios = input.perFamily.reduce((sum, entry) => sum + entry.scenarios, 0);
  return {
    report: "voice-gateway-adapter/1",
    sanitized: true,
    baseline: {
      firmwareRepo: XIAOZHI_GATEWAY_BASELINE.firmwareRepo,
      firmwareTag: XIAOZHI_GATEWAY_BASELINE.firmwareTag,
      serverRepo: XIAOZHI_GATEWAY_BASELINE.serverRepo,
      serverRef: XIAOZHI_GATEWAY_BASELINE.serverRef,
      serverTag: XIAOZHI_GATEWAY_BASELINE.serverTag,
      deviceVerified: XIAOZHI_GATEWAY_BASELINE.deviceVerified,
    },
    totals: {
      scenarios,
      nonTerminalTurns: input.perFamily.reduce((sum, entry) => sum + entry.nonTerminalTurns, 0),
      staleFramesPlayed: input.perFamily.reduce((sum, entry) => sum + entry.staleFramesPlayed, 0),
      deadlocks: input.perFamily.reduce((sum, entry) => sum + entry.deadlocks, 0),
    },
    perFamily: input.perFamily,
    candidateLatency: {
      cancelAckMaxMs: input.cancelAckMaxMs,
      whenIdleMaxMs: input.whenIdleMaxMs,
      firstSafeTextMaxMs: input.firstSafeTextMaxMs,
      abortToStopDirectives: input.perFamily.reduce((sum, entry) => sum + entry.abortsFenced, 0),
    },
  };
}

/**
 * Content-freeness check for a sanitized report: the report must not
 * contain ANY synthetic sentence text (nor its digest — digests are allowed
 * only in audit rings, not in the report). Returns the offending fragments.
 */
export function findReportContentLeaks(report: GatewaySanitizedReport, forbiddenTexts: readonly string[]): readonly string[] {
  const serialized = stableJson(report);
  const leaks: string[] = [];
  for (const text of forbiddenTexts) {
    if (serialized.includes(text)) {
      leaks.push(text);
    }
  }
  return leaks;
}

/** Minimal stable stringify (key-sorted; JSON only). */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
