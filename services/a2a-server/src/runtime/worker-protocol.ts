/**
 * Wire contract between the A2A validation service and a real DSH worker
 * SUBPROCESS (P1-05, issue #87).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ Reused contract: the internal Runtime Bridge speaks control + events    │
 * │ over a child process' stdin/stdout (docs/A2A_DESIGN.md §"LumiThink 到   │
 * │ 内部 DSH"; ADR-0002 pattern; issues #52/#53). This module instantiates  │
 * │ that contract INSIDE the isolated validation package (ADR-0013): the    │
 * │ worker is a REAL separate OS process with real spawn/hello/heartbeat/   │
 * │ exit semantics — the provider CONTENT it executes is synthetic (the     │
 * │ model provider is a synthetic vendor by design, "模型可采用合成供应商    │
 * │ 验证进程机制"; real-model verification stays P1-10/#92).                │
 * │                                                                         │
 * │ Worker kinds (docs/A2A_DESIGN.md: 区分外部工作 DSH 与内部执行进程):     │
 * │   'internal-executor'  — the execution engine registered here (ONLY     │
 * │                          kind the runtime accepts; fail-closed).        │
 * │   'external-companion' — the WORKING DSH that talks to LumiThink as a   │
 * │                          client/plugin; NEVER dispatched by this        │
 * │                          runtime (registration refused).                │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Framing: line-delimited JSON over stdin/stdout, one object per '\n',
 * protocol version 1. stderr is captured as capped diagnostics.
 */

export const WORKER_PROTOCOL_VERSION = 1;

/** Maximum accepted line length (bytes) — a larger frame is a violation. */
export const WORKER_MAX_LINE_BYTES = 1 * 1024 * 1024;

/** Worker kinds; only 'internal-executor' may execute (fail-closed). */
export type WorkerKind = 'internal-executor' | 'external-companion';

/** hello: the worker's registration frame (first frame the worker sends). */
export interface WorkerHello {
  type: 'hello';
  proto: number;
  kind: WorkerKind;
  /** Self-reported stable registration id, e.g. 'dshw-<pid>-<rand>'. */
  workerId: string;
}

/** ready: the worker accepted the start frame and began the execution. */
export interface WorkerReady {
  type: 'ready';
}

/** output: one candidate body chunk for admission (synthetic content). */
export interface WorkerOutput {
  type: 'output';
  /** Stable chunk id (idempotent redelivery). */
  chunkId: string;
  text: string;
  lastChunk: boolean;
}

/** heartbeat: liveness proof; silence beyond lostContactMs = 失联. */
export interface WorkerHeartbeat {
  type: 'heartbeat';
  ts: number;
}

/** result: the worker's own execution result (raw, pre-settlement). */
export interface WorkerResult {
  type: 'result';
  outcome: 'completed' | 'failed' | 'canceled';
  reason?: string;
}

export type WorkerEvent = WorkerHello | WorkerReady | WorkerOutput | WorkerHeartbeat | WorkerResult;

/** start: control frame the runtime writes before any worker event. */
export interface RuntimeStart {
  type: 'start';
  execution: {
    taskId: string;
    turnSeq: number;
    epoch: number;
    executionId: string;
    leaseId: string;
  };
  input: {
    /** The accepted user text (first text part of the message). */
    text: string;
  };
}

/** cancel: control frame asking the worker to stop cooperatively. */
export interface RuntimeCancel {
  type: 'cancel';
  reason: string;
}

export type RuntimeControl = RuntimeStart | RuntimeCancel;

/** Exit evidence captured by the runtime when the process is gone. */
export interface WorkerExitEvidence {
  exitCode: number | null;
  signal: string | null;
  /** True when the runtime itself terminated the process (kill path). */
  killedByRuntime: boolean;
  /** Capped stderr tail (diagnostics only; truncated to stderrCapBytes). */
  stderrTail: string;
}

/** Behavior profiles of the bundled worker entry (synthetic provider). */
export type WorkerBehavior =
  | 'complete'
  | 'exit-failed'
  | 'crash-after-ready'
  | 'no-hello'
  | 'silent-after-ready'
  | 'heartbeat-forever'
  | 'stop-on-cancel'
  | 'flood-after-cancel'
  | 'bad-proto'
  | 'external-kind';

export const WORKER_BEHAVIOR_ENV = 'LUMITHINK_A2A_WORKER_BEHAVIOR';

/** Parses one worker frame; returns undefined for malformed/oversized lines. */
export function parseWorkerFrame(line: string): WorkerEvent | undefined {
  if (line.length === 0 || Buffer.byteLength(line, 'utf8') > WORKER_MAX_LINE_BYTES) return undefined;
  try {
    const parsed = JSON.parse(line) as { type?: unknown };
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    switch (parsed.type) {
      case 'hello':
      case 'ready':
      case 'output':
      case 'heartbeat':
      case 'result':
        return parsed as WorkerEvent;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

export function encodeRuntimeControl(control: RuntimeControl): string {
  return `${JSON.stringify(control)}\n`;
}
