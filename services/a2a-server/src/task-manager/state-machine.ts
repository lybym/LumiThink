/**
 * A2A task state machine for the LumiThink Task Manager (P1-02, issue #84).
 *
 * Authority: docs/TASK_LIFECYCLE.md §3 (A2A 状态机) — the transition table is
 * the frozen application contract; the wire format uses the A2A 1.0 SDK
 * `TASK_STATE_*` enum. Internal storage uses lowercase snake codes so the
 * SQLite CHECK constraints and triggers stay readable.
 *
 * Invariants enforced here (and re-enforced at the database level in
 * schema.ts):
 *   1. Every transition must be listed in LEGAL_TASK_TRANSITIONS.
 *   2. Terminal states (completed/failed/canceled/rejected) have NO outgoing
 *      transitions — 终态不可逆 (TASK_LIFECYCLE §1.4); late callbacks can
 *      never re-open or re-state a terminal task.
 *   3. Only the Task Manager repository writes these states; protocol layers
 *      submit commands/events only (TASK_LIFECYCLE §1.2).
 */
import { TaskState } from '@a2a-js/sdk';

export const A2A_TASK_STATES = [
  'submitted',
  'working',
  'input_required',
  'auth_required',
  'completed',
  'failed',
  'canceled',
  'rejected',
] as const;

export type A2aTaskState = (typeof A2A_TASK_STATES)[number];

/** Terminal states: no outgoing transitions, database-enforced. */
export const TERMINAL_TASK_STATES: readonly A2aTaskState[] = [
  'completed',
  'failed',
  'canceled',
  'rejected',
];

export function isTerminalTaskState(state: A2aTaskState): boolean {
  return (TERMINAL_TASK_STATES as readonly string[]).includes(state);
}

/**
 * TASK_LIFECYCLE.md §3 state diagram, one entry per source state.
 * Terminal states map to empty arrays — the terminal-irreversibility
 * constraint. Any state pair not listed here is illegal by construction.
 */
export const LEGAL_TASK_TRANSITIONS: Readonly<
  Record<A2aTaskState, readonly A2aTaskState[]>
> = {
  submitted: ['working', 'rejected', 'canceled', 'failed'],
  working: ['input_required', 'auth_required', 'completed', 'failed', 'canceled'],
  input_required: ['working', 'canceled', 'failed'],
  auth_required: ['working', 'canceled', 'failed'],
  completed: [],
  failed: [],
  canceled: [],
  rejected: [],
};

export function isLegalTaskTransition(from: A2aTaskState, to: A2aTaskState): boolean {
  return (LEGAL_TASK_TRANSITIONS[from] ?? []).includes(to);
}

const INTERNAL_TO_SDK: Readonly<Record<A2aTaskState, TaskState>> = {
  submitted: TaskState.TASK_STATE_SUBMITTED,
  working: TaskState.TASK_STATE_WORKING,
  input_required: TaskState.TASK_STATE_INPUT_REQUIRED,
  auth_required: TaskState.TASK_STATE_AUTH_REQUIRED,
  completed: TaskState.TASK_STATE_COMPLETED,
  failed: TaskState.TASK_STATE_FAILED,
  canceled: TaskState.TASK_STATE_CANCELED,
  rejected: TaskState.TASK_STATE_REJECTED,
};

const SDK_TO_INTERNAL: ReadonlyMap<TaskState, A2aTaskState> = new Map(
  (Object.keys(INTERNAL_TO_SDK) as A2aTaskState[]).map((internal) => [
    INTERNAL_TO_SDK[internal],
    internal,
  ]),
);

export function toSdkTaskState(state: A2aTaskState): TaskState {
  return INTERNAL_TO_SDK[state];
}

/**
 * Maps a runtime SDK TaskState to the internal code. UNSPECIFIED and
 * UNRECOGNIZED never appear on a persisted LumiThink task (they are wire
 * degenerate forms) and are rejected fail-closed instead of silently mapped.
 */
export function fromSdkTaskState(state: TaskState): A2aTaskState {
  const mapped = SDK_TO_INTERNAL.get(state);
  if (mapped === undefined) {
    throw new Error(`Cannot map SDK TaskState ${String(state)} to a LumiThink task state`);
  }
  return mapped;
}

/** Lists the legal target states for a source state (diagnostics/tests). */
export function legalTargetsOf(state: A2aTaskState): readonly A2aTaskState[] {
  return LEGAL_TASK_TRANSITIONS[state] ?? [];
}
