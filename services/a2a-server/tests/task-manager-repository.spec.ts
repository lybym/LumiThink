/**
 * SQLite unified repository tests (P1-02, issue #84).
 *
 * Evidence map (issue #84 acceptance criteria):
 *  - AC 1  schema/turns/executions traceability + terminal irreversibility
 *          (transition table AND database trigger);
 *  - AC 2  atomic acceptance/state/result/Outbox transactions with injected
 *          failures at every write boundary — zero rows after rollback;
 *  - AC 3  conditional state-version races (exactly one winner), late
 *          callbacks rejected on terminal tasks and closed admission;
 *  - AC 4  bounded write-lock contention (no unbounded in-transaction
 *          waits), synchronous-only transaction bodies (fetch guard),
 *          versioned migration with fail-closed future versions.
 *
 * All data is synthetic; every database is a throwaway temp file or
 * ':memory:'.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskManagerError } from '../src/task-manager/errors.ts';
import { A2A_TASK_MANAGER_SCHEMA_VERSION } from '../src/task-manager/schema.ts';
import {
  SqliteTaskManager,
  type TestFailurePoint,
} from '../src/task-manager/sqlite-task-manager.ts';
import { userMessage } from './helpers.ts';

function tempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'a2a-task-manager-'));
  return { dir, dbPath: path.join(dir, 'tasks.sqlite3') };
}

function removeTempDir(dir: string): void {
  // Windows can briefly hold freshly-closed SQLite/WAL files (AV scan);
  // retry EPERM/EBUSY instead of failing the test on cleanup.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function newManager(dbPath: string, overrides: { busyTimeoutMs?: number } = {}): SqliteTaskManager {
  return new SqliteTaskManager({ dbPath, busyTimeoutMs: overrides.busyTimeoutMs });
}

function accept(mgr: SqliteTaskManager, key: string, text = '你好'): { taskId: string; contextId: string } {
  const result = mgr.acceptInput({
    requestKey: key,
    fingerprint: `fp-${key}`,
    messageId: `msg-${key}`,
    inputMessage: userMessage(`msg-${key}`, text),
  });
  assert.equal(result.outcome, 'created');
  if (result.outcome !== 'created') throw new Error('unreachable');
  return { taskId: result.taskId, contextId: result.contextId };
}

function assertAllZero(mgr: SqliteTaskManager): void {
  const stats = mgr.stats();
  for (const [table, count] of Object.entries(stats)) {
    assert.equal(count, 0, `table ${table} must be empty after rollback`);
  }
}

// ---------------------------------------------------------------------------
// Migration (AC 4)
// ---------------------------------------------------------------------------

test('migration creates schema v1 idempotently and records the version', () => {
  const { dir, dbPath } = tempDbPath();
  try {
    const mgr = newManager(dbPath);
    try {
      assert.equal(mgr.schemaVersion, A2A_TASK_MANAGER_SCHEMA_VERSION);
      const db = new DatabaseSync(dbPath);
      const version = (
        db.prepare("SELECT value FROM lumithink_a2a_meta WHERE key = 'schema_version'").get() as {
          value: string;
        }
      ).value;
      assert.equal(version, String(A2A_TASK_MANAGER_SCHEMA_VERSION));
      // Reopen: migration is a no-op at the current version (no error, no bump).
      const reopened = newManager(dbPath);
      assert.equal(reopened.schemaVersion, A2A_TASK_MANAGER_SCHEMA_VERSION);
      reopened.close();
      db.close();
    } finally {
      mgr.close();
    }
  } finally {
    removeTempDir(dir);
  }
});

test('fail-closed: a database from a NEWER schema version refuses to open (AC 4)', () => {
  const { dir, dbPath } = tempDbPath();
  try {
    const mgr = newManager(dbPath);
    mgr.close();
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE lumithink_a2a_meta SET value = '999' WHERE key = 'schema_version'").run();
    db.close();
    assert.throws(() => newManager(dbPath), (error: unknown) => {
      assert.ok(error instanceof TaskManagerError);
      assert.equal(error.code, 'schema_version_not_supported');
      assert.match(error.message, /NEWER/);
      return true;
    });
  } finally {
    removeTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Atomic acceptance (AC 2)
// ---------------------------------------------------------------------------

test('acceptInput commits ledger + task + turn + history + outbox in ONE transaction', () => {
  const mgr = newManager(':memory:');
  try {
    const { taskId, contextId } = accept(mgr, 'accept-1');
    const stats = mgr.stats();
    assert.equal(stats.conversations, 1);
    assert.equal(stats.tasks, 1);
    assert.equal(stats.turns, 1);
    assert.equal(stats.ledger, 1);
    assert.equal(stats.history, 1);
    assert.equal(stats.outbox, 1);
    const detail = mgr.getTaskDetail(taskId);
    assert.equal(detail.currentState, 'submitted');
    assert.equal(detail.stateVersion, 1);
    assert.equal(detail.contextId, contextId);
    assert.equal(detail.turns.length, 1);
    assert.equal(detail.turns[0].turnSeq, 1);
    assert.equal(detail.turns[0].epoch, 1);
    assert.equal(detail.turns[0].outputAdmission, 'open');
    const outbox = mgr.readOutbox(taskId);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].kind, 'task');
    assert.equal(outbox[0].seq, 1);
  } finally {
    mgr.close();
  }
});

test('duplicate request (same key + fingerprint) returns the original task without a new Turn', () => {
  const mgr = newManager(':memory:');
  try {
    const first = accept(mgr, 'accept-dup');
    const before = mgr.stats();
    const second = mgr.acceptInput({
      requestKey: 'accept-dup',
      fingerprint: 'fp-accept-dup',
      messageId: 'msg-accept-dup',
      inputMessage: userMessage('msg-accept-dup', '你好'),
    });
    assert.equal(second.outcome, 'duplicate');
    if (second.outcome === 'duplicate') {
      assert.equal(second.taskId, first.taskId);
      assert.equal(second.currentState, 'submitted');
    }
    assert.deepEqual(mgr.stats(), before, 'duplicate acceptance must write nothing');
  } finally {
    mgr.close();
  }
});

test('same key with a DIFFERENT fingerprint is the stable message_id_conflict error', () => {
  const mgr = newManager(':memory:');
  try {
    accept(mgr, 'accept-conflict');
    const before = mgr.stats();
    assert.throws(
      () =>
        mgr.acceptInput({
          requestKey: 'accept-conflict',
          fingerprint: 'fp-DIFFERENT',
          messageId: 'msg-accept-conflict',
          inputMessage: userMessage('msg-accept-conflict', '换个内容'),
        }),
      (error: unknown) => {
        assert.ok(error instanceof TaskManagerError);
        assert.equal(error.code, 'message_id_conflict');
        return true;
      },
    );
    assert.deepEqual(mgr.stats(), before, 'conflicting acceptance must write nothing');
  } finally {
    mgr.close();
  }
});

test('injected failure at EVERY write boundary rolls back completely (AC 2)', () => {
  const points: TestFailurePoint[] = [
    'afterLedgerWrite',
    'afterTaskWrite',
    'afterTurnWrite',
    'afterOutboxWrite',
    'beforeCommit',
  ];
  for (const point of points) {
    const mgr = newManager(':memory:');
    try {
      mgr.setTestFailurePoint(point);
      assert.throws(
        () =>
          mgr.acceptInput({
            requestKey: `accept-fail-${point}`,
            fingerprint: `fp-${point}`,
            messageId: `msg-${point}`,
            inputMessage: userMessage(`msg-${point}`, '你好'),
          }),
        /injected test failure/,
      );
      assertAllZero(mgr);
      // The injection is one-shot: clearing it lets the same request succeed.
      mgr.setTestFailurePoint(null);
      const retry = mgr.acceptInput({
        requestKey: `accept-fail-${point}`,
        fingerprint: `fp-${point}`,
        messageId: `msg-${point}`,
        inputMessage: userMessage(`msg-${point}`, '你好'),
      });
      assert.equal(retry.outcome, 'created');
      assert.equal(mgr.stats().tasks, 1);
    } finally {
      mgr.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Conditional state transitions + races (AC 1 / AC 3)
// ---------------------------------------------------------------------------

test('transitionTask commits with version bump and a statusUpdate outbox event', () => {
  const mgr = newManager(':memory:');
  try {
    const { taskId } = accept(mgr, 'transition-1');
    const first = mgr.transitionTask({
      taskId,
      expectedState: 'submitted',
      expectedStateVersion: 1,
      nextState: 'working',
    });
    assert.equal(first.outcome, 'committed');
    if (first.outcome === 'committed') {
      assert.equal(first.stateVersion, 2);
    }
    const outbox = mgr.readOutbox(taskId);
    const statusUpdate = outbox.find((event) => event.kind === 'statusUpdate');
    assert.ok(statusUpdate, 'statusUpdate event must be committed transactionally');
    assert.equal(statusUpdate.payload['from'], 'submitted');
    assert.equal(statusUpdate.payload['to'], 'working');
  } finally {
    mgr.close();
  }
});

test('version race: only ONE competing writer commits, the loser re-reads (AC 3)', () => {
  const mgr = newManager(':memory:');
  try {
    const { taskId } = accept(mgr, 'race-1');
    const winner = mgr.transitionTask({
      taskId,
      expectedState: 'submitted',
      expectedStateVersion: 1,
      nextState: 'working',
    });
    const loser = mgr.transitionTask({
      taskId,
      expectedState: 'submitted',
      expectedStateVersion: 1,
      nextState: 'failed',
    });
    assert.equal(winner.outcome, 'committed');
    assert.equal(loser.outcome, 'stale');
    if (loser.outcome === 'stale') {
      assert.equal(loser.currentState, 'working');
      assert.equal(loser.stateVersion, 2);
    }
    const detail = mgr.getTaskDetail(taskId);
    assert.equal(detail.currentState, 'working');
    // Only the winner's outbox event exists — the loser wrote nothing.
    const statusUpdates = mgr.readOutbox(taskId).filter((event) => event.kind === 'statusUpdate');
    assert.equal(statusUpdates.length, 1);
    assert.equal(statusUpdates[0].payload['to'], 'working');
  } finally {
    mgr.close();
  }
});

test('terminal state is irreversible: transition table AND database trigger (AC 1)', () => {
  const { dir, dbPath } = tempDbPath();
  try {
    const mgr = newManager(dbPath);
    try {
      const { taskId } = accept(mgr, 'terminal-1');
      assert.equal(
        mgr.transitionTask({ taskId, expectedState: 'submitted', expectedStateVersion: 1, nextState: 'working' })
          .outcome,
        'committed',
      );
      const completed = mgr.transitionTask({
        taskId,
        expectedState: 'working',
        expectedStateVersion: 2,
        nextState: 'completed',
      });
      assert.equal(completed.outcome, 'committed');
      const detail = mgr.getTaskDetail(taskId);
      assert.equal(detail.currentState, 'completed');
      assert.ok(detail.terminalAtMs !== null);

      // 1. Application layer: any transition out of a terminal state throws.
      assert.throws(
        () =>
          mgr.transitionTask({
            taskId,
            expectedState: 'completed',
            expectedStateVersion: 3,
            nextState: 'working',
          }),
        (error: unknown) => {
          assert.ok(error instanceof TaskManagerError);
          assert.equal(error.code, 'illegal_transition');
          return true;
        },
      );
      // 2. Database layer: even a raw UPDATE cannot move a terminal row.
      const db = new DatabaseSync(dbPath);
      assert.throws(
        () =>
          db
            .prepare("UPDATE a2a_tasks SET current_state = 'working' WHERE task_id = ?")
            .run(taskId),
        /terminal task state is irreversible/,
      );
      db.close();
      // The authoritative row is untouched by both attempts.
      assert.equal(mgr.getTaskDetail(taskId).currentState, 'completed');
    } finally {
      mgr.close();
    }
  } finally {
    removeTempDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Dispatch lease + execution attribution (AC 1 / AC 3)
// ---------------------------------------------------------------------------

test('claimExecution atomically registers the execution and moves submitted→working', () => {
  const mgr = newManager(':memory:');
  try {
    const { taskId } = accept(mgr, 'claim-1');
    const claimed = mgr.claimExecution({
      taskId,
      executionId: 'exec-1',
      leaseId: 'lease-1',
      leaseExpiresAtMs: Date.now() + 60_000,
      workerId: 'worker-a',
    });
    assert.equal(claimed.outcome, 'claimed');
    if (claimed.outcome === 'claimed') {
      assert.equal(claimed.stateVersion, 2);
      assert.equal(claimed.epoch, 1);
    }
    const detail = mgr.getTaskDetail(taskId);
    assert.equal(detail.currentState, 'working');
    assert.equal(detail.turns[0].executions.length, 1);
    assert.equal(detail.turns[0].executions[0].executionId, 'exec-1');
    assert.equal(detail.turns[0].executions[0].leaseId, 'lease-1');
    assert.equal(detail.turns[0].executions[0].state, 'registered');
    // A second claim attempt is stale (already dispatched).
    const again = mgr.claimExecution({ taskId, executionId: 'exec-2' });
    assert.equal(again.outcome, 'stale');
  } finally {
    mgr.close();
  }
});

test('cancel-vs-dispatch race: the conditional update picks exactly one winner (AC 3)', () => {
  const mgr = newManager(':memory:');
  try {
    const { taskId } = accept(mgr, 'race-dispatch-1');
    assert.equal(mgr.recordCancelIntent({ taskId, reason: 'user cancel' }).outcome, 'recorded');
    // Cancel settlement and dispatch claim both anchor on submitted@v1.
    const settled = mgr.transitionTask({
      taskId,
      expectedState: 'submitted',
      expectedStateVersion: 1,
      nextState: 'canceled',
      reason: 'cancel before dispatch',
    });
    assert.equal(settled.outcome, 'committed');
    const claim = mgr.claimExecution({ taskId, executionId: 'exec-late' });
    assert.equal(claim.outcome, 'stale');
    assert.equal(mgr.getTaskDetail(taskId).currentState, 'canceled');
    assert.equal(mgr.stats().executions, 0, 'no execution row may appear after cancel won');
  } finally {
    mgr.close();
  }
});

test('admitChunk: attribution, append-only chunks with stable ids/bytes/digests, outbox events', async () => {
  const mgr = newManager(':memory:');
  try {
    const { taskId } = accept(mgr, 'admit-1');
    assert.equal(
      mgr.claimExecution({ taskId, executionId: 'exec-1', leaseId: 'lease-1' }).outcome,
      'claimed',
    );
    const chunk1 = mgr.admitChunk({
      taskId,
      executionId: 'exec-1',
      turnSeq: 1,
      epoch: 1,
      leaseId: 'lease-1',
      artifactId: 'answer-1',
      text: '你好。',
    });
    assert.equal(chunk1.outcome, 'admitted');
    if (chunk1.outcome === 'admitted') {
      assert.equal(chunk1.chunkSeq, 1);
      assert.equal(chunk1.chunkId, 'answer-1#chunk-1');
    }
    const chunk2 = mgr.admitChunk({
      taskId,
      executionId: 'exec-1',
      turnSeq: 1,
      epoch: 1,
      leaseId: 'lease-1',
      artifactId: 'answer-1',
      text: '我们开始吧。',
      lastChunk: true,
    });
    assert.equal(chunk2.outcome, 'admitted');

    const artifacts = (await mgr.load(taskId))?.artifacts ?? [];
    assert.equal(artifacts.length, 1);
    const parts = artifacts[0].parts;
    assert.equal(parts.length, 2);
    const text = parts
      .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
      .join('');
    assert.equal(text, '你好。我们开始吧。');
    // Stable positions: [0,9) + [9,25) in UTF-8 bytes.
    const outbox = mgr.readOutbox(taskId).filter((event) => event.kind === 'artifactUpdate');
    assert.equal(outbox.length, 2);
    const first = outbox[0].payload['chunk'] as Record<string, unknown>;
    const second = outbox[1].payload['chunk'] as Record<string, unknown>;
    assert.equal(first['startByte'], 0);
    assert.equal(first['endByte'], Buffer.byteLength('你好。', 'utf8'));
    assert.equal(second['startByte'], Buffer.byteLength('你好。', 'utf8'));
    assert.equal(outbox[1].seq, outbox[0].seq + 1, 'task-scoped monotonic seq');

    // Idempotent redelivery with the same stable chunkId keeps the original.
    const redelivered = mgr.admitChunk({
      taskId,
      executionId: 'exec-1',
      turnSeq: 1,
      epoch: 1,
      leaseId: 'lease-1',
      artifactId: 'answer-1',
      chunkId: 'answer-1#chunk-1',
      text: '你好。',
    });
    assert.equal(redelivered.outcome, 'duplicate');
    assert.equal(mgr.stats().chunks, 2, 'redelivery must not append a second copy');
  } finally {
    mgr.close();
  }
});

test('late callback after terminal: no state change, no body append (AC 3)', () => {
  const mgr = newManager(':memory:');
  try {
    const { taskId } = accept(mgr, 'late-1');
    assert.equal(
      mgr.claimExecution({ taskId, executionId: 'exec-1', leaseId: 'lease-1' }).outcome,
      'claimed',
    );
    assert.equal(
      mgr.admitChunk({
        taskId, executionId: 'exec-1', turnSeq: 1, epoch: 1, leaseId: 'lease-1',
        artifactId: 'answer-1', text: '你好。',
      }).outcome,
      'admitted',
    );
    assert.equal(
      mgr.transitionTask({
        taskId,
        expectedState: 'working',
        expectedStateVersion: 2,
        nextState: 'completed',
        reason: 'settle',
        execution: { executionId: 'exec-1', turnSeq: 1, epoch: 1, leaseId: 'lease-1' },
      }).outcome,
      'committed',
    );
    const before = mgr.stats();
    const outboxBefore = mgr.readOutbox(taskId).length;
    // Late result for the settled execution → rejected, nothing written.
    const late = mgr.admitChunk({
      taskId,
      executionId: 'exec-1',
      turnSeq: 1,
      epoch: 1,
      leaseId: 'lease-1',
      artifactId: 'answer-1',
      text: '迟到的正文',
    });
    assert.equal(late.outcome, 'rejected');
    if (late.outcome === 'rejected') assert.equal(late.reason, 'task_terminal');
    assert.deepEqual(mgr.stats(), before);
    assert.equal(mgr.readOutbox(taskId).length, outboxBefore);
    // Stale epoch attribution is rejected as well.
    assert.equal(
      mgr.claimExecution({ taskId, executionId: 'exec-2' }).outcome,
      'stale',
      'terminal task cannot be re-dispatched',
    );
  } finally {
    mgr.close();
  }
});

test('cancel intent closes output admission; epochs and leases stay traceable (AC 1)', () => {
  const mgr = newManager(':memory:');
  try {
    const { taskId } = accept(mgr, 'cancel-admission-1');
    assert.equal(
      mgr.claimExecution({ taskId, executionId: 'exec-1', leaseId: 'lease-1' }).outcome,
      'claimed',
    );
    assert.equal(mgr.recordCancelIntent({ taskId, reason: 'cancel while working' }).outcome, 'recorded');
    // Duplicate cancel intent is idempotent — no double side effects.
    assert.equal(mgr.recordCancelIntent({ taskId, reason: 'again' }).outcome, 'already-recorded');
    const blocked = mgr.admitChunk({
      taskId,
      executionId: 'exec-1',
      turnSeq: 1,
      epoch: 1,
      leaseId: 'lease-1',
      artifactId: 'answer-1',
      text: '取消后的新正文',
    });
    assert.equal(blocked.outcome, 'rejected');
    if (blocked.outcome === 'rejected') assert.equal(blocked.reason, 'output_admission_closed');
    const detail = mgr.getTaskDetail(taskId);
    assert.equal(detail.cancelIntent, true);
    assert.equal(detail.turns[0].outputAdmission, 'closed');
    // Lease mismatch is rejected even with admission open.
    const { taskId: otherId } = accept(mgr, 'cancel-admission-2');
    assert.equal(
      mgr.claimExecution({ taskId: otherId, executionId: 'exec-9', leaseId: 'lease-9' }).outcome,
      'claimed',
    );
    const wrongLease = mgr.admitChunk({
      taskId: otherId,
      executionId: 'exec-9',
      turnSeq: 1,
      epoch: 1,
      leaseId: 'WRONG',
      artifactId: 'answer-9',
      text: '正文',
    });
    assert.equal(wrongLease.outcome, 'rejected');
    if (wrongLease.outcome === 'rejected') assert.equal(wrongLease.reason, 'lease_invalid');
  } finally {
    mgr.close();
  }
});

test('supplementary input appends the next sequential turn (epoch increments)', () => {
  const mgr = newManager(':memory:');
  try {
    const { taskId } = accept(mgr, 'turn-1');
    // Legal chain only (§3): submitted → working → input_required.
    assert.equal(
      mgr.transitionTask({ taskId, expectedState: 'submitted', expectedStateVersion: 1, nextState: 'working' })
        .outcome,
      'committed',
    );
    assert.equal(
      mgr.transitionTask({ taskId, expectedState: 'working', expectedStateVersion: 2, nextState: 'input_required' })
        .outcome,
      'committed',
    );
    const appended = mgr.appendTurn({
      taskId,
      requestKey: 'turn-1-supplement',
      fingerprint: 'fp-supplement',
      inputMessage: userMessage('msg-supplement', '补充说明'),
    });
    assert.equal(appended.outcome, 'created');
    if (appended.outcome === 'created') {
      assert.equal(appended.turnSeq, 2);
      assert.equal(appended.epoch, 2);
    }
    const detail = mgr.getTaskDetail(taskId);
    assert.equal(detail.turns.length, 2);
    assert.equal(detail.turns[1].epoch, 2);
    assert.equal(detail.turns[1].inputMessage.messageId, 'msg-supplement');
    assert.equal(mgr.stats().ledger, 2, 'supplementary input gets its own ledger row');
    // Terminal tasks reject new turns.
    assert.equal(
      mgr.transitionTask({ taskId, expectedState: 'input_required', expectedStateVersion: 3, nextState: 'failed' })
        .outcome,
      'committed',
    );
    const late = mgr.appendTurn({
      taskId,
      requestKey: 'turn-1-late',
      fingerprint: 'fp-late',
      inputMessage: userMessage('msg-late', '太迟了'),
    });
    assert.equal(late.outcome, 'rejected');
    if (late.outcome === 'rejected') assert.equal(late.reason, 'task_terminal');
  } finally {
    mgr.close();
  }
});

// ---------------------------------------------------------------------------
// Outbox replay + publication (AC 2)
// ---------------------------------------------------------------------------

test('outbox: publication is outside the write transactions; replay keeps stable ids', () => {
  const mgr = newManager(':memory:');
  try {
    const { taskId } = accept(mgr, 'outbox-1');
    assert.equal(
      mgr.transitionTask({ taskId, expectedState: 'submitted', expectedStateVersion: 1, nextState: 'working' })
        .outcome,
      'committed',
    );
    assert.equal(mgr.readOutbox(taskId).length, 2, 'unpublished events only, in seq order');

    assert.equal(mgr.markOutboxPublished(taskId, 1), 1);
    assert.equal(mgr.readOutbox(taskId).length, 1);
    // Replay (including published) preserves seq/kind/payload — no rewrite.
    const replay = mgr.readOutbox(taskId, { includePublished: true });
    assert.equal(replay.length, 2);
    assert.equal(replay[0].seq, 1);
    assert.equal(replay[0].publishedAtMs !== null, true);
    assert.equal(replay[1].publishedAtMs, null);
    assert.equal(mgr.markOutboxPublished(taskId, 1), 0, 're-marking publishes nothing new');
  } finally {
    mgr.close();
  }
});

// ---------------------------------------------------------------------------
// Write-lock contention + synchronous transactions (AC 4)
// ---------------------------------------------------------------------------

test('write-lock contention fails FAST with a typed busy error, then recovers (AC 4)', () => {
  const { dir, dbPath } = tempDbPath();
  const blocker = new DatabaseSync(dbPath);
  try {
    const mgr = newManager(dbPath, { busyTimeoutMs: 250 });
    try {
      const { taskId } = accept(mgr, 'lock-1');
      // A second connection holds the SQLite write lock (simulated long
      // external work OUTSIDE the repository — the repository itself never
      // waits on model/network inside a transaction).
      blocker.exec('BEGIN IMMEDIATE');
      blocker.prepare('INSERT INTO a2a_conversations (context_id, created_at_ms) VALUES (?, ?)').run('blocker', 1);
      const started = Date.now();
      assert.throws(
        () =>
          mgr.transitionTask({
            taskId,
            expectedState: 'submitted',
            expectedStateVersion: 1,
            nextState: 'working',
          }),
        (error: unknown) => {
          assert.ok(error instanceof TaskManagerError);
          assert.equal(error.code, 'write_lock_busy');
          assert.match(error.message, /busyTimeoutMs=250/);
          return true;
        },
      );
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 1500, `busy wait must stay bounded, took ${elapsed}ms`);
      blocker.exec('ROLLBACK');
      // After the lock is released the same transition commits.
      const after = mgr.transitionTask({
        taskId,
        expectedState: 'submitted',
        expectedStateVersion: 1,
        nextState: 'working',
      });
      assert.equal(after.outcome, 'committed');
    } finally {
      mgr.close();
    }
  } finally {
    try {
      blocker.exec('ROLLBACK');
    } catch {
      // no active transaction
    }
    blocker.close();
    removeTempDir(dir);
  }
});

test('repository operations make NO network calls (sync transaction bodies, AC 4)', () => {
  const mgr = newManager(':memory:');
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() => {
      throw new Error('network access attempted during repository operation');
    }) as typeof fetch;
    const { taskId } = accept(mgr, 'no-net-1');
    assert.equal(
      mgr.transitionTask({ taskId, expectedState: 'submitted', expectedStateVersion: 1, nextState: 'working' })
        .outcome,
      'committed',
    );
    assert.equal(
      mgr.claimExecution({ taskId, executionId: 'exec-1' }).outcome,
      'stale',
      'claim after manual transition is stale (already working)',
    );
    assert.equal(mgr.readOutbox(taskId).length >= 2, true);
    assert.equal(mgr.markOutboxPublished(taskId, 2), 2);
    const detail = mgr.getTaskDetail(taskId);
    assert.equal(detail.currentState, 'working');
    // An async (Promise-returning) body would half-commit — it must fail
    // the transaction loudly instead.
    assert.throws(
      () =>
        // @ts-expect-error deliberately violating the sync-only contract
        mgr.withWriteTransaction(async () => 'never'),
      /must stay synchronous/,
    );
    assert.equal(mgr.stats().tasks, 1, 'the failed async transaction left no rows');
  } finally {
    globalThis.fetch = originalFetch;
    mgr.close();
  }
});

// ---------------------------------------------------------------------------
// P1-04 (issue #86): dispatch lease vs cancel, lease-holder attribution,
// body purge / tombstones, bridge sync identity-dedupe, schema v2
// ---------------------------------------------------------------------------

test('claimExecution refuses a task with a persisted cancel intent (canceled_pre_dispatch)', () => {
  const mgr = newManager(':memory:');
  try {
    const { taskId } = accept(mgr, 'claim-cancel-1');
    const intent = mgr.recordCancelIntent({ taskId, reason: 'cancel_requested' });
    assert.equal(intent.outcome, 'recorded');

    const claim = mgr.claimExecution({ taskId, executionId: 'exec-canceled' });
    assert.equal(claim.outcome, 'canceled_pre_dispatch');
    if (claim.outcome === 'canceled_pre_dispatch') {
      assert.equal(claim.currentState, 'submitted');
      assert.equal(claim.stateVersion, 1, 'the refusal does not bump the version');
    }
    assert.equal(mgr.stats().executions, 0, 'no execution row for a refused claim');

    // The conditional-update discipline still applies: without the intent
    // the same claim wins.
    const mgr2 = newManager(':memory:');
    try {
      const second = accept(mgr2, 'claim-cancel-2');
      const ok = mgr2.claimExecution({ taskId: second.taskId, executionId: 'exec-ok' });
      assert.equal(ok.outcome, 'claimed');
    } finally {
      mgr2.close();
    }
  } finally {
    mgr.close();
  }
});

test('lease-holder attribution: omitting leaseId on a leased execution is rejected (review #101 ⑤)', () => {
  const mgr = newManager(':memory:');
  try {
    const { taskId } = accept(mgr, 'lease-holder-1');
    assert.equal(
      mgr.claimExecution({ taskId, executionId: 'exec-leased', leaseId: 'lease-A' }).outcome,
      'claimed',
    );

    // Omitted leaseId on a LEASED execution: rejected — presenting nothing
    // is not holder proof.
    const omitted = mgr.admitChunk({
      taskId, executionId: 'exec-leased', turnSeq: 1, epoch: 1,
      artifactId: 'answer-1', text: '省略租约', leaseId: undefined,
    });
    assert.deepEqual(omitted, { outcome: 'rejected', reason: 'lease_invalid' });

    // Wrong holder: rejected.
    const wrong = mgr.admitChunk({
      taskId, executionId: 'exec-leased', turnSeq: 1, epoch: 1,
      artifactId: 'answer-1', text: '错租约', leaseId: 'lease-B',
    });
    assert.deepEqual(wrong, { outcome: 'rejected', reason: 'lease_invalid' });

    // Correct holder: admitted (and the row moves registered→running).
    const right = mgr.admitChunk({
      taskId, executionId: 'exec-leased', turnSeq: 1, epoch: 1,
      artifactId: 'answer-1', text: '对租约', leaseId: 'lease-A',
    });
    assert.equal(right.outcome, 'admitted');

    // An UNLEASED execution keeps accepting callbacks without a lease.
    const { taskId: task2 } = accept(mgr, 'lease-holder-2');
    assert.equal(mgr2TaskState(mgr, task2), 'submitted');
    assert.equal(
      mgr.claimExecution({ taskId: task2, executionId: 'exec-bare' }).outcome,
      'claimed',
    );
    const bare = mgr.admitChunk({
      taskId: task2, executionId: 'exec-bare', turnSeq: 1, epoch: 1,
      artifactId: 'answer-2', text: '无租约执行',
    });
    assert.equal(bare.outcome, 'admitted');

    // transitionTask with an execution ref follows the same holder rule.
    assert.throws(
      () =>
        mgr.transitionTask({
          taskId, expectedState: 'working', expectedStateVersion: 2, nextState: 'completed',
          execution: { executionId: 'exec-leased', turnSeq: 1, epoch: 1 },
        }),
      (error: unknown) => error instanceof TaskManagerError && error.code === 'execution_attribution',
      'an execution ref omitting the lease of a leased execution is attributed-rejected',
    );
  } finally {
    mgr.close();
  }
});

function mgr2TaskState(mgr: SqliteTaskManager, taskId: string): string {
  return mgr.getTaskDetail(taskId).currentState;
}

test('purgeTaskBody deletes all body, tombstones ledger keys, and replays/retries cannot resurrect', async () => {
  const mgr = newManager(':memory:');
  try {
    const { taskId } = accept(mgr, 'purge-1');
    assert.equal(mgr.claimExecution({ taskId, executionId: 'exec-1' }).outcome, 'claimed');
    assert.equal(
      mgr.admitChunk({ taskId, executionId: 'exec-1', turnSeq: 1, epoch: 1, artifactId: 'answer-1', text: '待清理正文' })
        .outcome,
      'admitted',
    );

    const purged = mgr.purgeTaskBody(taskId);
    assert.equal(purged.outcome, 'purged');
    assert.equal(purged.tombstonedKeys, 1);

    const snapshot = JSON.stringify({
      detail: mgr.getTaskDetail(taskId),
      journal: mgr.readOutbox(taskId, { includePublished: true }),
      stats: mgr.stats(),
    });
    assert.ok(!snapshot.includes('待清理正文'), 'no body survives in detail, journal or stats');
    assert.ok(!snapshot.includes('你好'), 'input body is gone');
    assert.equal(mgr.stats().chunks, 0);
    assert.equal(mgr.stats().history, 0);
    assert.equal(mgr.stats().artifacts, 0);

    // Duplicate acceptance on the tombstoned key: tombstoned, never re-run.
    const retry = mgr.acceptInput({
      requestKey: 'purge-1',
      fingerprint: 'fp-purge-1',
      messageId: 'msg-purge-1',
      inputMessage: userMessage('msg-purge-1', '待清理正文'),
    });
    assert.deepEqual(retry, { outcome: 'tombstoned', taskId });
    assert.equal(mgr.stats().executions, 1, 'no new execution behind the tombstone');

    // SDK-bridge save of the purged (empty) snapshot cannot resurrect body.
    const task = await mgr.load(taskId);
    assert.ok(task);
    await mgr.save(task);
    assert.equal(mgr.stats().chunks, 0, 'replay of an empty snapshot does not recreate chunks');
  } finally {
    mgr.close();
  }
});

test('bridge save sync is message-identity keyed: windowed snapshots lose nothing and duplicate nothing (review #101 ⑥)', async () => {
  const mgr = newManager(':memory:');
  try {
    const taskId = 'task-windowed';
    const m1 = userMessage('win-msg-1', '第一');
    const m2 = userMessage('win-msg-2', '第二');
    const m3 = userMessage('win-msg-3', '第三');
    await mgr.save({
      id: taskId, contextId: 'ctx-windowed',
      status: { state: 1, message: undefined, timestamp: undefined },
      artifacts: [], history: [m1], metadata: undefined,
    });
    await mgr.save({
      id: taskId, contextId: 'ctx-windowed',
      status: { state: 1, message: undefined, timestamp: undefined },
      artifacts: [], history: [m1, m2], metadata: undefined,
    });
    assert.equal(mgr.getTaskDetail(taskId).turns.length, 2, 'turn per NEW user message');

    // WINDOWED snapshot (only the last message): existing rows keep their
    // seqs; nothing is dropped, nothing duplicated, no phantom turn.
    await mgr.save({
      id: taskId, contextId: 'ctx-windowed',
      status: { state: 1, message: undefined, timestamp: undefined },
      artifacts: [], history: [m3], metadata: undefined,
    });
    const loaded = await mgr.load(taskId);
    assert.ok(loaded);
    assert.deepEqual(
      (loaded.history ?? []).map((message) => message.messageId),
      ['win-msg-1', 'win-msg-2', 'win-msg-3'],
      'append-only history keeps every message in order despite the windowed save',
    );
    const detail = mgr.getTaskDetail(taskId);
    assert.equal(detail.turns.length, 3, 'the new message created exactly one new turn');
    assert.deepEqual(detail.turns.map((turn) => turn.epoch), [1, 2, 3]);

    // Re-sending the SAME full history is a no-op (idempotent save).
    await mgr.save({
      id: taskId, contextId: 'ctx-windowed',
      status: { state: 1, message: undefined, timestamp: undefined },
      artifacts: [], history: [m1, m2, m3], metadata: undefined,
    });
    assert.equal(mgr.getTaskDetail(taskId).turns.length, 3, 'no duplicate turns for known messages');
  } finally {
    mgr.close();
  }
});

test('bridge append path enforces output admission (review #101 ①: cancel intent closes snapshot appends)', async () => {
  const mgr = newManager(':memory:');
  try {
    const { taskId } = accept(mgr, 'bridge-admission-1');
    assert.equal(mgr.claimExecution({ taskId, executionId: 'exec-1' }).outcome, 'claimed');
    assert.equal(
      mgr.admitChunk({ taskId, executionId: 'exec-1', turnSeq: 1, epoch: 1, artifactId: 'answer-1', text: '已准入' })
        .outcome,
      'admitted',
    );

    // Record the cancel intent (closes output admission on open turns)…
    assert.equal(mgr.recordCancelIntent({ taskId, reason: 'cancel_requested' }).outcome, 'recorded');

    // …a bridge save whose snapshot carries a NEW part is rejected loudly.
    const task = await mgr.load(taskId);
    assert.ok(task);
    await assert.rejects(
      () =>
        mgr.save({
          ...task,
          artifacts: [
            {
              artifactId: 'answer-1', name: 'Admitted answer', description: '',
              parts: [
                { content: { $case: 'text' as const, value: '已准入' }, metadata: undefined, filename: '', mediaType: 'text/plain' },
                { content: { $case: 'text' as const, value: '取消后迟到正文' }, metadata: undefined, filename: '', mediaType: 'text/plain' },
              ],
              metadata: undefined, extensions: [],
            },
          ],
        }),
      (error: unknown) =>
        error instanceof TaskManagerError && error.code === 'output_admission_closed',
    );
    assert.equal(mgr.stats().chunks, 1, 'the late part was NOT appended');

    // The same snapshot WITHOUT new parts stays a clean idempotent save.
    await mgr.save(task);
    assert.equal(mgr.stats().chunks, 1);
  } finally {
    mgr.close();
  }
});

test('schema v2: v1 databases re-migrate additively; tombstoned_at_ms appears and data survives', () => {
  const { dir, dbPath } = tempDbPath();
  try {
    // Build a v2 database, then rewind it to a v1 shape.
    const first = newManager(dbPath);
    const { taskId } = accept(first, 'migration-v2-1');
    first.close();

    const raw = new DatabaseSync(dbPath);
    raw.exec('ALTER TABLE a2a_request_ledger DROP COLUMN tombstoned_at_ms');
    raw.prepare("UPDATE lumithink_a2a_meta SET value = '1' WHERE key = 'schema_version'").run();
    raw.close();

    const reopened = newManager(dbPath);
    try {
      assert.equal(reopened.schemaVersion, 2);
      const probe = new DatabaseSync(dbPath);
      const columns = probe.prepare("PRAGMA table_info('a2a_request_ledger')").all() as { name: string }[];
      assert.ok(columns.some((column) => column.name === 'tombstoned_at_ms'), 'v2 column restored');
      probe.close();
      // Existing data survived the migration.
      assert.equal(reopened.getTaskDetail(taskId).currentState, 'submitted');
      // Purge sets the tombstone timestamp on the migrated column.
      const purged = reopened.purgeTaskBody(taskId);
      assert.equal(purged.outcome, 'purged');
      assert.ok(purged.purgedAtMs > 0);
      const db = new DatabaseSync(dbPath);
      const tomb = db
        .prepare('SELECT status, tombstoned_at_ms FROM a2a_request_ledger WHERE request_key = ?')
        .get('migration-v2-1') as { status: string; tombstoned_at_ms: number | null };
      db.close();
      assert.equal(tomb.status, 'tombstoned');
      assert.ok(tomb.tombstoned_at_ms !== null, 'tombstone timestamp recorded');
    } finally {
      reopened.close();
    }
  } finally {
    removeTempDir(dir);
  }
});
