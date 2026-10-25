/**
 * SYNTHETIC LumiThink executor (P1-01, issue #83).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SYNTHETIC — this executor does NOT call the internal DSH Runtime, the   │
 * │ Runtime Bridge, or any model. A protocol/transport pass through this    │
 * │ executor proves ONLY the A2A wire behavior (Agent Card discovery,       │
 * │ JSON-RPC + SSE, Task-only policy, standard errors). It is NOT the real  │
 * │ DSH execution gate (P1-10 / issue #92) and must never be presented as   │
 * │ one (issue #83 acceptance criterion 4).                                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Behavior (mirrors the frozen fixture content, docs/fixtures/a2a-v1.0):
 *  - Task-first publication: every accepted request produces a Task before
 *    any artifact — the Task-only application policy (design §9.2).
 *  - Two append-only answer chunks with `lumithinkOutput` chunk metadata
 *    (version 1, stable chunkId, UTF-8 half-open byte range, SHA-256) and
 *    append/lastChunk ONLY on the update events (never on the artifact).
 *  - Scenario routing via `message.metadata.lumithinkScenario` (application
 *    metadata; the taskId is always server-assigned):
 *      'cancel-test' → parks until CancelTask, then publishes CANCELED;
 *      default       → completes with the two chunks + COMPLETED.
 *
 * R4 guard (P0-02 matrix §5): the SDK event bus requires RUNTIME-shaped
 * objects — Part oneof `{ content: { $case: 'text', value } }` and the
 * numeric TaskState enum. Publishing wire-shaped JSON silently corrupts to
 * UNRECOGNIZED states and empty parts, so this executor builds runtime
 * shapes only; the round-trip tests re-decode everything through the
 * official SDK client, which makes silent corruption fail loudly.
 */
import { createHash } from 'node:crypto';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { TaskState } from '@a2a-js/sdk';
import type { Artifact, Part, Task, TaskStatus, TaskStatusUpdateEvent } from '@a2a-js/sdk';

/** Fixed synthetic timestamp for reproducible evidence (no wall-clock churn). */
const SYNTHETIC_NOW = '2026-10-26T00:00:00.000Z';

const CHUNK_1 = '你好。';
const CHUNK_2 = '我们开始吧。';

function statusOf(state: TaskState): TaskStatus {
  return { state, message: undefined, timestamp: SYNTHETIC_NOW };
}

function textPart(value: string): Part {
  return {
    content: { $case: 'text', value },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  };
}

function chunkMetadata(
  chunkId: string,
  text: string,
  startByte: number,
): Record<string, unknown> {
  return {
    lumithinkOutput: {
      version: 1,
      chunkId,
      startByte,
      endByte: startByte + Buffer.byteLength(text, 'utf8'),
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    },
  };
}

function answerArtifact(parts: Part[]): Artifact {
  return {
    artifactId: 'answer-example',
    name: 'Admitted answer',
    description: '',
    parts,
    metadata: { lumithinkContent: { version: 1, category: 'admitted-answer' } },
    extensions: [],
  };
}

export type LumithinkScenario = 'complete' | 'cancel-test';

export class SyntheticExecutor implements AgentExecutor {
  /** Resolvers for tasks parked in the cancel-test scenario. */
  private readonly awaitingCancel = new Map<string, () => void>();
  private readonly contextByTask = new Map<string, string>();
  cancelInvocations = 0;

  scenarioOf(requestContext: RequestContext): LumithinkScenario {
    const scenario = requestContext.request?.message?.metadata?.lumithinkScenario;
    return scenario === 'cancel-test' ? 'cancel-test' : 'complete';
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId, userMessage } = requestContext;
    this.contextByTask.set(taskId, contextId);

    // Task-first: the Task-only policy anchor (design §9.2). The first
    // published event MUST be a task or message (SDK enforces the ordering).
    const task: Task = {
      id: taskId,
      contextId,
      status: statusOf(TaskState.TASK_STATE_SUBMITTED),
      artifacts: [],
      history: [userMessage],
      metadata: undefined,
    };
    eventBus.publish({ kind: 'task', data: task });

    if (this.scenarioOf(requestContext) === 'cancel-test') {
      await new Promise<void>((resolve) => this.awaitingCancel.set(taskId, resolve));
      // cancelTask() published the terminal event; nothing else to emit.
      return;
    }

    // Legal lifecycle progression (TASK_LIFECYCLE §3): the persisted state
    // path must always move submitted → working before results, so every
    // TaskStore save lands on a legal transition (P1-02 strict state
    // machine, issue #84).
    eventBus.publish({
      kind: 'statusUpdate',
      data: {
        taskId,
        contextId,
        status: statusOf(TaskState.TASK_STATE_WORKING),
        metadata: undefined,
      },
    });
    eventBus.publish({
      kind: 'artifactUpdate',
      data: {
        taskId,
        contextId,
        artifact: answerArtifact([textPart(CHUNK_1)]),
        append: false,
        lastChunk: false,
        metadata: chunkMetadata('chunk-1', CHUNK_1, 0),
      },
    });
    eventBus.publish({
      kind: 'artifactUpdate',
      data: {
        taskId,
        contextId,
        artifact: answerArtifact([textPart(CHUNK_2)]),
        append: true,
        lastChunk: true,
        metadata: chunkMetadata('chunk-2', CHUNK_2, Buffer.byteLength(CHUNK_1, 'utf8')),
      },
    });
    eventBus.publish({
      kind: 'statusUpdate',
      data: {
        taskId,
        contextId,
        status: statusOf(TaskState.TASK_STATE_COMPLETED),
        metadata: undefined,
      },
    });
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    this.cancelInvocations += 1;
    const resolve = this.awaitingCancel.get(taskId);
    this.awaitingCancel.delete(taskId);
    if (resolve) resolve();
    const canceled: TaskStatusUpdateEvent = {
      taskId,
      contextId: this.contextByTask.get(taskId) ?? '',
      status: statusOf(TaskState.TASK_STATE_CANCELED),
      metadata: undefined,
    };
    eventBus.publish({ kind: 'statusUpdate', data: canceled });
  }
}
