/**
 * Task Manager / Task Store boundary (P1-01, issue #83, AC 4).
 *
 * The locked SDK request handler is wired to EXACTLY ONE Task Store — the
 * single authoritative write path for the tasks it manages. This is the seam
 * where P1-02 (issue #84) plugs in the SQLite Task Manager repository:
 *
 *   TASK_LIFECYCLE.md §4.1: "SDK 的请求处理器不得另行创建一份任务，或在取消
 *   回调返回时自行假设已取消。SDK Task Store 与自建仓储必须适配到同一权威
 *   写入路径" — the handler must not create a parallel task record, and the
 *   SDK Task Store and the LumiThink repository must converge onto ONE
 *   authoritative write path.
 *
 * P1-01 uses the SDK InMemoryTaskStore as the stand-in (process memory only,
 * no persistence). R5/R6 (P0-02 matrix §5): the SQLite Task Manager will
 * implement load/save/list over the unified transactional repository with
 * the transactional Outbox; aggregation of chunk parts into one artifact is
 * an application-layer (Task Manager) contract, NOT a store default.
 *
 * Nothing in this package writes tasks outside the handler+store path.
 */
import type { ListTasksRequest, ListTasksResponse, Task } from '@a2a-js/sdk';
import type { ServerCallContext } from '@a2a-js/sdk/server';

/**
 * Re-export of the locked SDK TaskStore surface. P1-02's SQLite repository
 * adapter implements exactly this interface — no wider surface is exposed to
 * the handler, and the repository's transactional writes stay internal.
 */
export type { TaskStore } from '@a2a-js/sdk/server';

export interface TaskStorePort {
  save(task: Task, context: ServerCallContext): Promise<void>;
  load(taskId: string, context: ServerCallContext): Promise<Task | undefined>;
  list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse>;
}
