/**
 * Delete-first data lifecycle orchestration (P1-08, issue #90;
 * TASK_LIFECYCLE §5.4/§9, A2A_DESIGN §11.2).
 *
 * AC 2 删除优先于 7 天结果留存 and AC 4 处理授权撤回按范围删除:
 * personal-data deletion / processing-authorization withdrawal overrides the
 * regular retention windows. The orchestration purges EVERYTHING the
 * service holds for the scope's tasks:
 *
 *   - revocation (caller-side prerequisite): bumping the identity epoch
 *     invalidates every authorization decision cache IMMEDIATELY (P1-03)
 *     and closes live SSE streams (StreamRegistry) — 撤销访问立即生效;
 *   - ledger record FIRST (deletion-wins crash direction), then
 *     `purgeTaskBody` per task: task history (inputs), admitted artifacts +
 *     chunks, Outbox rows (delivery + replay source), turn inputs (redacted
 *     marker), status/metadata; ledger keys → idempotency tombstones
 *     (≥30d); the task row gains the fail-closed `purged_at_ms` marker so
 *     no snapshot save can resurrect the body;
 *   - task-ownership bindings are KEPT: the tombstone retry contract
 *     (RESULT_PURGED, §5.2) is answered through the binding + ledger key;
 *     bindings carry no body;
 *   - conversation/context rows carry no body and stay FK-bound to the
 *     tombstone task rows — the context surface a client can still touch is
 *     the purged shell (cleaned view); the decision caches and pending
 *     deliveries are covered by the epoch bump + stream close above.
 *
 * Every purge is journaled in the independent DeletionLedger so a later
 * restore of an old Task-DB snapshot replays the deletions before the
 * service opens (已删数据不能复活).
 */
import type { SqliteTaskManager } from '../task-manager/sqlite-task-manager.ts';
import type { IdentityStore } from '../identity/identity-store.ts';
import { DeletionLedger } from './deletion-ledger.ts';

export type DeletionScope =
  | { kind: 'household'; householdId: string }
  | { kind: 'principal'; householdId: string; principalUserId: string }
  | { kind: 'task'; taskId: string };

export function scopeLabel(scope: DeletionScope): string {
  switch (scope.kind) {
    case 'household':
      return `household:${scope.householdId}`;
    case 'principal':
      return `principal:${scope.householdId}:${scope.principalUserId}`;
    case 'task':
      return `task:${scope.taskId}`;
  }
}

export interface PurgeProcessingScopeResult {
  /** Task ids whose body was purged by THIS call. */
  purgedTaskIds: string[];
  /** Task ids already purged before this call (idempotent re-application). */
  alreadyPurgedTaskIds: string[];
  /** Scope task ids that had no task row in the Task Manager DB. */
  missingTaskIds: string[];
}

/**
 * Purges the body of every task inside the scope. The authorization
 * revocation that justifies the deletion is the CALLER's prerequisite (it
 * must take effect immediately and close live streams — the orchestration
 * never grants or re-checks authorization). Task ids are processed in
 * sorted order for deterministic evidence.
 */
export function purgeProcessingScope(options: {
  taskManager: SqliteTaskManager;
  identity: IdentityStore;
  ledger: DeletionLedger;
  scope: DeletionScope;
  /** Stable reason code recorded on every ledger entry. */
  reason: string;
}): PurgeProcessingScopeResult {
  const { taskManager, identity, ledger, scope, reason } = options;
  let taskIds: string[];
  switch (scope.kind) {
    case 'household':
      taskIds = identity.taskBindingsForScope(scope.householdId).map((binding) => binding.taskId);
      break;
    case 'principal':
      taskIds = identity
        .taskBindingsForScope(scope.householdId, scope.principalUserId)
        .map((binding) => binding.taskId);
      break;
    case 'task':
      taskIds = [scope.taskId];
      break;
  }
  const purgedTaskIds: string[] = [];
  const alreadyPurgedTaskIds: string[] = [];
  const missingTaskIds: string[] = [];
  const scopeText = scopeLabel(scope);
  for (const taskId of [...taskIds].sort()) {
    // Record BEFORE purging: a crash in between leaves a ledger entry whose
    // replay re-applies the purge (deletion-wins). A live entry for a task
    // that no longer exists is harmless (replay reports it as missing).
    ledger.recordTaskDeletion({ taskId, scope: scopeText, reason });
    if (!taskManager.taskExists(taskId)) {
      missingTaskIds.push(taskId);
      continue;
    }
    const result = taskManager.purgeTaskBody(taskId);
    if (result.alreadyPurged) alreadyPurgedTaskIds.push(taskId);
    else purgedTaskIds.push(taskId);
  }
  return { purgedTaskIds, alreadyPurgedTaskIds, missingTaskIds };
}
