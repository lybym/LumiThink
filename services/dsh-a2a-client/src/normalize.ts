/**
 * P2-02 (issue #114) — SDK runtime-shape normalization for the DSH A2A
 * Client (ADR-0018 Appendix B component 6 + P0-02 R9 adaptation).
 *
 * The locked @a2a-js/sdk@1.3.0 client returns RUNTIME-shaped objects:
 * a Task/Message object itself (not a `{task: …}` wrapper — P0-02 R9) with
 * NUMERIC TaskState enum values (P0-02 R4 family). Everything the client
 * persists in the ledger or reports to a tool goes through this module so
 * the persisted/observed shapes are protocol-stable strings, never numeric
 * enum values that only make sense inside one SDK build.
 *
 * Task-only policy: the LumiThink A2A server answers SendMessage with a
 * Task (never a bare final Message), but a spec-compliant remote agent MAY
 * return a Message for non-task interactions; the client keeps that
 * distinction explicit instead of guessing.
 */
import { TaskState } from '@a2a-js/sdk';
import type { Message, Task } from '@a2a-js/sdk';

/** Protocol-stable state names (TASK_LIFECYCLE §3 vocabulary). */
export type A2aStateName =
  | 'submitted'
  | 'working'
  | 'input_required'
  | 'auth_required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'
  | 'unrecognized';

const STATE_NAMES: readonly A2aStateName[] = [
  'submitted',
  'working',
  'input_required',
  'auth_required',
  'completed',
  'failed',
  'canceled',
  'rejected',
];

/** TASK_LIFECYCLE §3: terminal states are irreversible (no out-edges). */
export function isTerminalStateName(state: A2aStateName): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'rejected';
}

/**
 * Maps the SDK runtime numeric enum (or already-string state) to the stable
 * name. Unrecognized values map to 'unrecognized' and never crash — a task
 * in an unknown state stays observable (pollable) instead of breaking the
 * wait loop (fail-visible, not fail-silent).
 */
export function taskStateName(state: TaskState | number | string | undefined): A2aStateName {
  if (state === undefined || state === null) return 'unrecognized';
  if (typeof state === 'string') {
    const name = state.replace(/^TASK_STATE_/, '').toLowerCase();
    return (STATE_NAMES as readonly string[]).includes(name) ? (name as A2aStateName) : 'unrecognized';
  }
  const entry = Object.entries(TaskState).find(([, value]) => value === state);
  if (entry === undefined) return 'unrecognized';
  return taskStateName(entry[0]);
}

export function isTaskShape(value: unknown): value is Task {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'contextId' in value &&
    'status' in value
  );
}

export function isMessageShape(value: unknown): value is Message {
  return (
    typeof value === 'object' &&
    value !== null &&
    'messageId' in value &&
    !('status' in value)
  );
}

/** Extracts the first text value of a runtime Part list (P0-02 R4 shape). */
export function firstTextOfParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  for (const part of parts) {
    const content = (part as { content?: { $case?: string; value?: unknown } })?.content;
    if (content?.$case === 'text' && typeof content.value === 'string') return content.value;
  }
  return '';
}

/** Extracts a readable status message from a runtime Task, if any. */
export function statusMessageOf(task: Task): string | undefined {
  const message = task.status?.message as unknown;
  if (message === undefined || message === null) return undefined;
  const text = firstTextOfParts((message as { parts?: unknown }).parts);
  return text === '' ? undefined : text;
}
