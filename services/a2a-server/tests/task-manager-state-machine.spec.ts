/**
 * Task Manager state machine unit tests (P1-02, issue #84, AC 1).
 *
 * Pins the transition table against TASK_LIFECYCLE.md §3 exactly: every
 * listed legal transition, terminal irreversibility (empty target lists),
 * and the fail-closed SDK TaskState mapping (UNSPECIFIED/UNRECOGNIZED are
 * wire-degenerate forms and never map to a persisted state).
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { TaskState } from '@a2a-js/sdk';
import {
  A2A_TASK_STATES,
  LEGAL_TASK_TRANSITIONS,
  TERMINAL_TASK_STATES,
  fromSdkTaskState,
  isLegalTaskTransition,
  isTerminalTaskState,
  legalTargetsOf,
  toSdkTaskState,
} from '../src/task-manager/state-machine.ts';

test('state machine covers exactly the eight standard states', () => {
  assert.deepEqual(
    [...A2A_TASK_STATES],
    [
      'submitted',
      'working',
      'input_required',
      'auth_required',
      'completed',
      'failed',
      'canceled',
      'rejected',
    ],
  );
  assert.equal(LEGAL_TASK_TRANSITIONS['submitted' as keyof typeof LEGAL_TASK_TRANSITIONS].length > 0, true);
  for (const state of A2A_TASK_STATES) {
    assert.ok(LEGAL_TASK_TRANSITIONS[state], `every state has a transition entry: ${state}`);
  }
});

test('terminal states are irreversible: no outgoing transitions (AC 1)', () => {
  assert.deepEqual(
    [...TERMINAL_TASK_STATES],
    ['completed', 'failed', 'canceled', 'rejected'],
  );
  for (const terminal of TERMINAL_TASK_STATES) {
    assert.deepEqual(
      legalTargetsOf(terminal),
      [],
      `terminal state ${terminal} must have no outgoing transitions`,
    );
    assert.equal(isTerminalTaskState(terminal), true);
    for (const target of A2A_TASK_STATES) {
      assert.equal(
        isLegalTaskTransition(terminal, target),
        false,
        `terminal state ${terminal} must never transition to ${target}`,
      );
    }
  }
});

test('legal transitions match TASK_LIFECYCLE §3 state diagram', () => {
  const expectedPairs: [string, string][] = [
    ['submitted', 'working'],
    ['submitted', 'rejected'],
    ['submitted', 'canceled'],
    ['submitted', 'failed'],
    ['working', 'input_required'],
    ['working', 'auth_required'],
    ['working', 'completed'],
    ['working', 'failed'],
    ['working', 'canceled'],
    ['input_required', 'working'],
    ['input_required', 'canceled'],
    ['input_required', 'failed'],
    ['auth_required', 'working'],
    ['auth_required', 'canceled'],
    ['auth_required', 'failed'],
  ];
  for (const [from, to] of expectedPairs) {
    assert.equal(
      isLegalTaskTransition(from as 'submitted', to as 'working'),
      true,
      `${from} → ${to} must be legal`,
    );
  }
  const forbidden: [string, string][] = [
    ['submitted', 'input_required'],
    ['submitted', 'auth_required'],
    ['submitted', 'submitted'],
    ['working', 'submitted'],
    ['working', 'rejected'],
    ['input_required', 'completed'],
    ['input_required', 'auth_required'],
    ['auth_required', 'completed'],
    ['completed', 'working'],
    ['canceled', 'working'],
    ['failed', 'working'],
    ['rejected', 'submitted'],
  ];
  for (const [from, to] of forbidden) {
    assert.equal(
      isLegalTaskTransition(from as 'submitted', to as 'working'),
      false,
      `${from} → ${to} must be illegal`,
    );
  }
});

test('SDK TaskState mapping round-trips and fails closed on degenerate forms', () => {
  for (const state of A2A_TASK_STATES) {
    assert.equal(fromSdkTaskState(toSdkTaskState(state)), state, `round-trip ${state}`);
  }
  assert.equal(toSdkTaskState('submitted'), TaskState.TASK_STATE_SUBMITTED);
  assert.equal(toSdkTaskState('completed'), TaskState.TASK_STATE_COMPLETED);
  assert.equal(toSdkTaskState('canceled'), TaskState.TASK_STATE_CANCELED);
  assert.equal(fromSdkTaskState(TaskState.TASK_STATE_WORKING), 'working');
  assert.equal(fromSdkTaskState(TaskState.TASK_STATE_INPUT_REQUIRED), 'input_required');
  assert.equal(fromSdkTaskState(TaskState.TASK_STATE_AUTH_REQUIRED), 'auth_required');
  assert.equal(fromSdkTaskState(TaskState.TASK_STATE_REJECTED), 'rejected');
  assert.throws(() => fromSdkTaskState(TaskState.TASK_STATE_UNSPECIFIED), /Cannot map/);
  assert.throws(() => fromSdkTaskState(TaskState.UNRECOGNIZED), /Cannot map/);
});
