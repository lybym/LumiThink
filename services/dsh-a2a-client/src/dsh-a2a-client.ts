/**
 * P2-02 (issue #114) — the LumiThink DSH A2A Client (ADR-0018 Appendix B).
 *
 * A thin, durable adapter over the LOCKED official `@a2a-js/sdk@1.3.0`
 * client. The SDK owns transport/codec/version headers/error semantics
 * (P0-02 verified); this adapter owns the application duties that
 * TASK_LIFECYCLE assigns to the client:
 *
 *   §7.4 (ADR-0018 hard constraint 2): persist stable messageId + original
 *   request BEFORE the wire send; persist taskId the moment it arrives;
 *   poll or subscribe afterwards.
 *
 *   §7.4 (constraint 3): a tool abort first stops local presentation, then
 *   the cleanup CancelTask goes out over an INDEPENDENT AbortController with
 *   its own §7.3 timeout (default 2000ms) — it never carries the aborted
 *   tool signal. When no taskId was received yet, the §5.3 path recovers the
 *   task by resending the ORIGINAL message (same messageId, returnImmediately)
 *   and then cancels; recovery and cancel are both ledger-recorded.
 *
 *   §7.3: a cancel whose response misses the deadline resolves with the
 *   standard `unconfirmed_timeout` outcome and the readable note
 *   "取消结果未确认，可查询任务" — the persistent intent stays valid.
 *
 *   Constraint 4: finite network retries; SDK semantic error classes map to
 *   the client taxonomy (TaskNotFoundError ≠ input request).
 *
 *   Constraint 5: INPUT_REQUIRED/AUTH_REQUIRED return STRUCTURED handles
 *   (taskId + contextId + status message + distinct flags), never plain
 *   text; follow-up input re-points at the original task via contextId +
 *   taskId/referenceTaskIds.
 *
 * Credential rule (constraint 1): credentials flow ONLY through the
 * official `AuthenticationHandler` face (`createAuthenticatingFetchWithRetry`),
 * supplied from memory (config/env). No token is ever persisted or logged.
 */
import { randomUUID } from 'node:crypto';

import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  createAuthenticatingFetchWithRetry,
  type AuthenticationHandler,
  type Client,
} from '@a2a-js/sdk/client';
import { Role, type Message, type Part, type Task } from '@a2a-js/sdk';

import {
  resolveDshA2aClientConfig,
  type DshA2aClientConfig,
  type ResolvedDshA2aClientConfig,
} from './config.ts';
import {
  DshA2aClientError,
  TaskWaitAbortedError,
  mapClientError,
  type CancelOutcome,
} from './errors.ts';
import type { LedgerCancelIntent, LedgerRecord, TaskLedger } from './ledger.ts';
import {
  firstTextOfParts,
  isMessageShape,
  isTaskShape,
  isTerminalStateName,
  statusMessageOf,
  taskStateName,
  type A2aStateName,
} from './normalize.ts';

/** Structured task handle returned by every client operation (constraint 5). */
export interface TaskHandle {
  /** Stable client messageId (idempotency anchor; persisted before send). */
  messageId: string;
  /** Server task id, when known. */
  taskId?: string;
  contextId?: string;
  /** Normalized task state name, when observed. */
  state?: A2aStateName;
  /** Readable status message from the server, when present. */
  statusMessage?: string;
  /** Structured early-exit flags (never downgraded to plain text). */
  inputRequired?: boolean;
  authRequired?: boolean;
  /** Admitted artifact chunk count observed on the last snapshot. */
  artifactChunks?: number;
}

export interface SendMessageInput {
  /** Synthetic business text (first text part). */
  text: string;
  /** Stable messageId; a fresh UUID when omitted (persisted before send). */
  messageId?: string;
  /** Optional conversation continuation. */
  contextId?: string;
  /** Optional explicit task reference (follow-up input). */
  taskId?: string;
  referenceTaskIds?: string[];
  /** Application metadata (e.g. lumithinkScenario). */
  metadata?: Record<string, unknown>;
}

export interface WaitOptions {
  /** Tool signal: aborting stops LOCAL presentation only (§7.4 step 1). */
  signal?: AbortSignal;
  /** Poll cadence override. */
  pollIntervalMs?: number;
  /** Max wall time polling before poll_timeout. */
  pollTimeoutMs?: number;
  /** Progress callback for every observed state change. */
  onProgress?: (handle: TaskHandle) => void;
}

export type SendMode = 'wait' | 'returnImmediately';

export interface SendOptions extends WaitOptions {
  /** 'wait' (default): send + poll to terminal/early-exit. 'returnImmediately': handle only. */
  mode?: SendMode;
}

/** Normalized SSE event surfaced by consumeStream/resubscribe. */
export interface StreamEvent {
  kind: 'task' | 'statusUpdate' | 'artifactUpdate' | 'message' | 'unknown';
  taskId?: string;
  contextId?: string;
  state?: A2aStateName;
  statusMessage?: string;
  /** Raw SDK event payload for advanced consumers (still token-free). */
  raw: unknown;
}

/** Restart recovery scan item (§9-style pending-operation report). */
export interface PendingOperation {
  messageId: string;
  taskId?: string;
  lastKnownState?: string;
  cancelIntentStatus?: LedgerCancelIntent['status'];
  followUpOfTaskId?: string;
  suggestedAction:
    | 'query_or_reattach'
    | 'recover_via_resend'
    | 'reconfirm_cancel'
    | 'nothing_pending';
}

export class DshA2aClient {
  private readonly config: ResolvedDshA2aClientConfig;
  private readonly clientPromise: Promise<Client>;
  private cachedToken: string | null = null;
  /** Last credential renewal failure detail (token-free) — §7.4 visibility. */
  lastRenewalFailure: string | null = null;

  constructor(config: DshA2aClientConfig) {
    this.config = resolveDshA2aClientConfig(config);

    const authHandler: AuthenticationHandler = {
      headers: async () => ({ authorization: `Bearer ${await this.currentToken()}` }),
      shouldRetryWithHeaders: async (_req, res) => {
        if (res.status !== 401 && res.status !== 403) return undefined;
        // §7.4: 凭据过期 → 有限重试 + 授权续签。A re-sign is only possible
        // with a provider credential; a static token stays honestly 401.
        if (typeof this.config.credential !== 'function') return undefined;
        const usedToken = this.cachedToken;
        let fresh: string;
        try {
          fresh = await (this.config.credential as () => Promise<string>)();
        } catch (error) {
          this.lastRenewalFailure =
            'credential provider failed during re-sign: ' +
            (error instanceof Error ? error.name : 'unknown');
          throw new DshA2aClientError(
            'credential_renewal_failed',
            'Credential re-sign failed after an authentication challenge; the pending ' +
              'operation is NOT confirmed complete (§7.4: 清理未完成需显示/记录).',
            { cause: error },
          );
        }
        if (usedToken !== null && fresh === usedToken) return undefined;
        return { authorization: `Bearer ${fresh}` };
      },
      onSuccessfulRetry: async (headers) => {
        const value = headers['authorization'];
        if (typeof value === 'string' && value.startsWith('Bearer ')) {
          this.cachedToken = value.slice('Bearer '.length);
        }
      },
    };
    const authenticatedFetch = createAuthenticatingFetchWithRetry(this.config.fetchImpl, authHandler);
    const factory = new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl: authenticatedFetch })],
      cardResolver: new DefaultAgentCardResolver({ fetchImpl: authenticatedFetch }),
    });
    this.clientPromise = factory.createFromUrl(this.config.baseUrl);
  }

  private async currentToken(): Promise<string> {
    if (this.cachedToken !== null) return this.cachedToken;
    const token =
      typeof this.config.credential === 'function'
        ? await this.config.credential()
        : this.config.credential;
    this.cachedToken = token;
    return token;
  }

  private async sdkClient(): Promise<Client> {
    return this.clientPromise;
  }

  /** Builds the runtime Message (P0-02 R4 shape; every field required). */
  private buildMessage(input: SendMessageInput, messageId: string): Message {
    const part: Part = {
      content: { $case: 'text', value: input.text },
      metadata: undefined,
      filename: '',
      mediaType: 'text/plain',
    };
    return {
      messageId,
      contextId: input.contextId ?? '',
      taskId: input.taskId ?? '',
      role: Role.ROLE_USER,
      parts: [part],
      metadata: input.metadata,
      extensions: [],
      referenceTaskIds: input.referenceTaskIds ?? [],
    };
  }

  private handleOf(record: LedgerRecord, task?: Task): TaskHandle {
    const source = task ?? undefined;
    const state = source !== undefined ? taskStateName(source.status?.state) : record.lastKnownState ? (record.lastKnownState as A2aStateName) : undefined;
    const statusMessage = source !== undefined ? statusMessageOf(source) : undefined;
    return {
      messageId: record.messageId,
      taskId: record.taskId,
      contextId: record.contextId,
      state,
      statusMessage,
      inputRequired: state === 'input_required',
      authRequired: state === 'auth_required',
      ...(source !== undefined
        ? { artifactChunks: (source.artifacts?.[0]?.parts?.length ?? 0) }
        : {}),
    };
  }

  private async persistRecord(record: LedgerRecord): Promise<void> {
    await this.config.ledger.saveBeforeSend(record);
  }

  /** One wire send (returnImmediately), with finite network retries. */
  private async sendOnWire(
    message: Message,
    signal: AbortSignal | undefined,
  ): Promise<{ task?: Task; message?: Message }> {
    const client = await this.sdkClient();
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.maxSendRetries; attempt += 1) {
      try {
        const result = await client.sendMessage(
          {
            tenant: '',
            message,
            configuration: {
              returnImmediately: true,
              acceptedOutputModes: ['text/plain'],
              taskPushNotificationConfig: undefined,
            },
            metadata: undefined,
          },
          signal !== undefined ? { signal } : undefined,
        );
        if (isTaskShape(result)) return { task: result };
        if (isMessageShape(result)) return { message: result };
        throw new DshA2aClientError('unexpected_response', 'SendMessage returned an unrecognized shape.');
      } catch (error) {
        lastError = error;
        if (signal?.aborted) break;
        // Finite retry for transient network failures only (constraint 4).
        const transient =
          error instanceof TypeError ||
          (error instanceof Error &&
            /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket/i.test(error.message));
        if (!transient || attempt === this.config.maxSendRetries) break;
        await sleep(Math.min(200 * (attempt + 1), 1000), undefined);
      }
    }
    throw mapClientError(lastError);
  }

  /**
   * Sends a message. ALWAYS returnImmediately on the wire (§7.4: persist
   * taskId on arrival, then poll/subscribe in client hands). The ledger
   * record is durable BEFORE the request leaves the process.
   */
  async send(input: SendMessageInput, options: SendOptions = {}): Promise<TaskHandle> {
    const messageId = input.messageId ?? randomUUID();
    const message = this.buildMessage(input, messageId);
    const returnImmediately = options.mode === 'returnImmediately';
    await this.persistRecord({
      messageId,
      agentBaseUrl: this.config.baseUrl,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      originalRequest: {
        method: 'message/send',
        message: structuredClone(message),
        configuration: {
          returnImmediately: true,
          acceptedOutputModes: ['text/plain'],
          taskPushNotificationConfig: undefined,
        },
      },
      returnImmediately,
      ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
      ...(input.taskId !== undefined ? { followUpOfTaskId: input.taskId } : {}),
    });

    try {
      const sent = await this.sendOnWire(message, options.signal);
      if (sent.message !== undefined) {
        // Non-task response: return the message text on the handle (no task
        // exists to track); the ledger keeps the original request for §5.3.
        const text = firstTextOfParts((sent.message as { parts?: unknown }).parts);
        return {
          messageId,
          state: undefined,
          statusMessage: text,
        };
      }
      const task = sent.task as Task;
      // 取得即落盘: persist the mapping BEFORE anything else observes it.
      await this.config.ledger.saveTaskId(messageId, task.id, task.contextId ?? '');
      const record = (await this.config.ledger.load(messageId)) as LedgerRecord;
      const handle = this.handleOf(record, task);
      await this.config.ledger.recordState(messageId, handle.state ?? 'unrecognized');
      if (returnImmediately) return handle;
      return await this.waitUntilTerminal(handle, options);
    } catch (error) {
      if (options.signal?.aborted) {
        throw new TaskWaitAbortedError(
          'The tool signal aborted while the first response was in flight; no taskId was ' +
            'confirmed. Use cancel() to run the §5.3 recovery + cleanup path.',
          { messageId, cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * §7.4 convenience wait: polls until terminal or structured early-exit.
   * On tool-signal abort this loop itself performs the independent cleanup
   * (cancel with a FRESH controller) and reports its outcome on the thrown
   * TaskWaitAbortedError — "先停止本地呈现，再发独立清理请求".
   */
  async waitUntilTerminal(handle: TaskHandle, options: WaitOptions = {}): Promise<TaskHandle> {
    const pollIntervalMs = options.pollIntervalMs ?? this.config.pollIntervalMs;
    const deadline = Date.now() + (options.pollTimeoutMs ?? this.config.pollTimeoutMs);
    let current = handle;
    for (;;) {
      if (current.state !== undefined && isTerminalStateName(current.state)) {
        await this.config.ledger.recordState(current.messageId, current.state);
        return current;
      }
      // Structured early-exit (constraint 5): INPUT_REQUIRED/AUTH_REQUIRED
      // are NOT terminal; the caller decides (supply input / handle auth).
      if (current.inputRequired || current.authRequired) {
        await this.config.ledger.recordState(current.messageId, current.state as string);
        return current;
      }
      if (options.signal?.aborted) {
        // §7.4: stop local presentation, then the INDEPENDENT cleanup.
        const outcome = await this.cancel({ messageId: current.messageId }, 'tool abort during wait');
        throw new TaskWaitAbortedError(
          outcome.status === 'confirmed_canceled'
            ? 'Local wait aborted; independent CancelTask confirmed CANCELED.'
            : `Local wait aborted; cleanup outcome: ${outcome.status}. ${outcome.detail}`,
          {
            messageId: current.messageId,
            taskId: current.taskId,
            cancelOutcome: outcome.status,
            cancelDetail: outcome.detail,
          },
        );
      }
      if (Date.now() > deadline) {
        throw new DshA2aClientError('poll_timeout', 'The task did not reach a terminal state in time.', {
          messageId: current.messageId,
          taskId: current.taskId,
        });
      }
      await sleep(pollIntervalMs, options.signal);
      if (options.signal?.aborted) continue; // handled at loop top
      const task = await this.fetchTaskByHandle(current);
      const record = (await this.config.ledger.load(current.messageId)) as LedgerRecord;
      current = this.handleOf(record, task ?? undefined);
      options.onProgress?.(current);
    }
  }

  /** send + wait convenience (the §7.4 tool-call shape). */
  async sendAndConsume(input: SendMessageInput, options: SendOptions = {}): Promise<TaskHandle> {
    let handle: TaskHandle;
    try {
      handle = await this.send(input, { ...options, mode: 'returnImmediately' });
    } catch (error) {
      if (error instanceof TaskWaitAbortedError) {
        // Aborted BEFORE a taskId arrived: §7.4 → §5.3 recovery, then the
        // independent cleanup. Both steps are ledger-recorded by cancel().
        const outcome = await this.cancel({ messageId: error.messageId }, 'tool abort during send');
        throw new TaskWaitAbortedError(
          outcome.status === 'confirmed_canceled'
            ? 'Local wait aborted before any taskId; §5.3 recovery resent the original message and the independent CancelTask confirmed CANCELED.'
            : `Local wait aborted before any taskId; cleanup outcome: ${outcome.status}. ${outcome.detail}`,
          {
            messageId: error.messageId,
            taskId: outcome.taskId,
            cancelOutcome: outcome.status,
            cancelDetail: outcome.detail,
          },
        );
      }
      throw error;
    }
    return await this.waitUntilTerminal(handle, options);
  }

  private async fetchTaskByHandle(handle: TaskHandle): Promise<Task | null> {
    if (handle.taskId === undefined) return null;
    const client = await this.sdkClient();
    try {
      const task = await client.getTask({ tenant: '', id: handle.taskId });
      await this.config.ledger.recordState(handle.messageId, taskStateName(task.status?.state));
      return task;
    } catch (error) {
      if (handle.taskId !== undefined && isTaskNotFound(error)) {
        // The ledger mapping points at a task this credential cannot see.
        throw mapClientError(error, { messageId: handle.messageId, taskId: handle.taskId });
      }
      throw error;
    }
  }

  /** Query (GetTask) by handle or raw task id. */
  async getTask(input: { messageId?: string; taskId?: string }): Promise<TaskHandle> {
    const client = await this.sdkClient();
    let taskId = input.taskId;
    let messageId = input.messageId;
    if (taskId === undefined && messageId !== undefined) {
      const record = await this.config.ledger.load(messageId);
      taskId = record?.taskId;
    }
    if (taskId === undefined && messageId === undefined) {
      throw new DshA2aClientError('invalid_config', 'getTask needs a messageId or a taskId.');
    }
    try {
      const task = await client.getTask({ tenant: '', id: taskId as string });
      if (messageId !== undefined) {
        await this.config.ledger.recordState(messageId, taskStateName(task.status?.state));
      }
      const record =
        messageId !== undefined
          ? ((await this.config.ledger.load(messageId)) as LedgerRecord | undefined)
          : await this.config.ledger.loadByTaskId(taskId as string);
      if (record !== undefined) {
        const handle = this.handleOf(record, task);
        return { ...handle, taskId: task.id, contextId: task.contextId };
      }
      // Queried by raw taskId outside any ledger record.
      const state = taskStateName(task.status?.state);
      return {
        messageId: messageId ?? '',
        taskId: task.id,
        contextId: task.contextId,
        state,
        statusMessage: statusMessageOf(task),
        inputRequired: state === 'input_required',
        authRequired: state === 'auth_required',
      };
    } catch (error) {
      throw mapClientError(error, { messageId, taskId });
    }
  }

  /**
   * Cancel (§7.4 step 2 / §5.3): with a known taskId → CancelTask under an
   * INDEPENDENT AbortController + §7.3 timeout. Without a taskId → recover
   * via the original-message resend first, then cancel. The outcome (and
   * every intermediate step) is ledger-recorded; a missed deadline yields
   * `unconfirmed_timeout` — never a fabricated CANCELED — and the intent
   * stays durable for restart recovery.
   */
  async cancel(input: { messageId?: string; taskId?: string }, reason: string): Promise<CancelOutcome> {
    let record: LedgerRecord | undefined;
    if (input.messageId !== undefined) {
      record = await this.config.ledger.load(input.messageId);
    } else if (input.taskId !== undefined) {
      record = await this.config.ledger.loadByTaskId(input.taskId);
    }
    const taskId = input.taskId ?? record?.taskId;
    if (taskId !== undefined) {
      return this.cancelThroughTaskId(taskId, record?.messageId, reason);
    }
    if (record === undefined) {
      throw new DshA2aClientError(
        'invalid_config',
        'cancel() needs a messageId with a ledger record or a taskId.',
      );
    }
    // §5.3: no taskId yet → recover the task with the ORIGINAL message, then cancel.
    const recovered = await this.recoverTaskByResend(record);
    const outcome = await this.cancelThroughTaskId(recovered.taskId, record.messageId, reason);
    return { ...outcome, recoveredViaResend: true };
  }

  /**
   * §5.3 public recovery: re-send the ORIGINAL persisted message (same
   * stable messageId, returnImmediately) and re-bind the task. Used after a
   * restart or a lost first response, when the ledger record has no taskId
   * yet. The server's message-idempotency guarantees the SAME task and no
   * duplicate inference; a fresh task here means the original request never
   * arrived — that fact stays recorded on the ledger record.
   */
  async recover(input: { messageId: string }): Promise<TaskHandle> {
    const record = await this.config.ledger.load(input.messageId);
    if (record === undefined) {
      throw new DshA2aClientError('invalid_config', `No ledger record for messageId ${input.messageId}.`);
    }
    if (record.taskId !== undefined) {
      return this.getTask({ messageId: record.messageId });
    }
    const recovered = await this.recoverTaskByResend(record);
    const updated = (await this.config.ledger.load(record.messageId)) as LedgerRecord;
    return {
      messageId: record.messageId,
      taskId: recovered.taskId,
      contextId: recovered.contextId,
      state: updated.lastKnownState as A2aStateName | undefined,
    };
  }

  /** §5.3 recovery: resend the ORIGINAL message (same messageId, immediate). */
  private async recoverTaskByResend(record: LedgerRecord): Promise<{ taskId: string; contextId?: string }> {
    if ((record.recoveryResends ?? 0) >= 1) {
      throw new DshA2aClientError(
        'cancel_recovery_failed',
        'The §5.3 recovery resend already ran once without producing a taskId; refusing to ' +
          'resend again (§5.3 caveat: if the first request never arrived, a resend may create ' +
          'a new task — that fact stays recorded instead of retried blindly).',
        { messageId: record.messageId },
      );
    }
    await this.config.ledger.recordRecoveryResend(record.messageId);
    const original = record.originalRequest;
    const resentMessage = structuredClone(original.message) as Message;
    try {
      const sent = await this.sendOnWire(resentMessage, undefined);
      if (!isTaskShape(sent.task ?? null)) {
        throw new DshA2aClientError(
          'cancel_recovery_failed',
          'The §5.3 recovery resend did not return a task snapshot; cancel intent stays recorded.',
          { messageId: record.messageId },
        );
      }
      const task = sent.task as Task;
      await this.config.ledger.saveTaskId(record.messageId, task.id, task.contextId ?? '');
      return { taskId: task.id, contextId: task.contextId };
    } catch (error) {
      if (error instanceof DshA2aClientError) throw error;
      throw new DshA2aClientError(
        'cancel_recovery_failed',
        'The §5.3 recovery resend failed; the cancel intent remains persisted for restart recovery.',
        { messageId: record.messageId, cause: error },
      );
    }
  }

  /** Independent-context CancelTask (never carries an aborted tool signal). */
  private async cancelThroughTaskId(taskId: string, messageId: string | undefined, reason: string): Promise<CancelOutcome> {
    const intent: LedgerCancelIntent = {
      requestedAtMs: Date.now(),
      reason,
      status: 'requested',
      detail: 'cancel intent recorded before the CancelTask request',
    };
    if (messageId !== undefined) await this.config.ledger.recordCancelIntent(messageId, intent);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.cancelResponseTimeoutMs);
    const client = await this.sdkClient();
    try {
      const task = await client.cancelTask(
        { tenant: '', id: taskId, metadata: undefined },
        { signal: controller.signal },
      );
      const state = taskStateName(task.status?.state);
      let status: LedgerCancelIntent['status'];
      let detail: string;
      if (state === 'canceled') {
        status = 'confirmed_canceled';
        detail = 'CancelTask returned the CANCELED task (server-side real stop evidence per P1-07).';
      } else if (isTerminalStateName(state)) {
        status = 'already_terminal';
        detail = `Task already settled as ${state} (§7.2 race: keep the original terminal state).`;
      } else {
        status = 'unconfirmed_timeout';
        detail = '取消结果未确认，可查询任务；持久取消意图已保存。';
      }
      const resolved: LedgerCancelIntent = { ...intent, status, settledTaskState: state, detail };
      if (messageId !== undefined) {
        await this.config.ledger.recordCancelIntent(messageId, resolved);
        await this.config.ledger.recordState(messageId, state);
      }
      return { status, taskId, taskState: state, detail };
    } catch (error) {
      const mapped = mapClientError(error, { messageId, taskId });
      let status: LedgerCancelIntent['status'] = 'failed';
      let detail: string;
      let observedState: string | undefined;
      if (controller.signal.aborted) {
        status = 'unconfirmed_timeout';
        detail =
          `CancelTask response missed the §7.3 deadline (${String(this.config.cancelResponseTimeoutMs)}ms). ` +
          '取消结果未确认，可查询任务；持久取消意图已保存。';
      } else if (mapped instanceof DshA2aClientError && mapped.code === 'task_not_cancelable') {
        status = 'already_terminal';
        detail = 'Server returned TaskNotCancelable (§7.2: original terminal state stands); querying the real state.';
        // §7.2: the caller must see the REAL terminal state — query it.
        try {
          const task = await client.getTask({ tenant: '', id: taskId });
          observedState = taskStateName(task.status?.state);
          detail += ` Task is ${observedState}.`;
        } catch {
          detail += ' The follow-up state query failed; use getTask().';
        }
      } else if (mapped instanceof DshA2aClientError && mapped.code === 'task_not_found') {
        status = 'not_found';
        detail = 'Server returned TaskNotFound for the cancel target (unknown or inaccessible).';
      } else {
        detail =
          'CancelTask failed; the outcome is NOT confirmed and the cancel intent stays persisted ' +
          '(restart recovery + server-side execution deadline still apply).';
      }
      const resolved: LedgerCancelIntent = {
        ...intent,
        status,
        ...(observedState !== undefined ? { settledTaskState: observedState } : {}),
        detail,
      };
      if (messageId !== undefined) {
        await this.config.ledger.recordCancelIntent(messageId, resolved);
        if (observedState !== undefined) await this.config.ledger.recordState(messageId, observedState);
      }
      return { status, taskId, ...(observedState !== undefined ? { taskState: observedState } : {}), detail };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Multi-turn follow-up (constraint 5): a NEW stable messageId pointing at
   * the original task — same contextId, original taskId/referenceTaskIds —
   * persisted before send like any other record.
   */
  async sendFollowUp(
    input: { fromMessageId?: string; fromTaskId?: string; text: string; metadata?: Record<string, unknown> },
    options: SendOptions = {},
  ): Promise<TaskHandle> {
    let origin: LedgerRecord | undefined;
    if (input.fromMessageId !== undefined) origin = await this.config.ledger.load(input.fromMessageId);
    if (origin === undefined && input.fromTaskId !== undefined) {
      origin = await this.config.ledger.loadByTaskId(input.fromTaskId);
    }
    const originTaskId = input.fromTaskId ?? origin?.taskId;
    if (originTaskId === undefined) {
      throw new DshA2aClientError(
        'invalid_config',
        'sendFollowUp needs the original taskId (directly or via a ledger messageId).',
      );
    }
    const handle = await this.send(
      {
        text: input.text,
        contextId: origin?.contextId,
        taskId: originTaskId,
        referenceTaskIds: [originTaskId],
        metadata: input.metadata,
      },
      options,
    );
    await this.config.ledger.recordFollowUp(handle.messageId, originTaskId);
    return handle;
  }

  /**
   * Streaming consumption (SSE). Records the task id + every observed state
   * into the ledger; the tool signal aborts LOCAL consumption only.
   */
  async *consumeStream(
    input: SendMessageInput,
    options: { signal?: AbortSignal; onEvent?: (event: StreamEvent) => void } = {},
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const messageId = input.messageId ?? randomUUID();
    const message = this.buildMessage(input, messageId);
    await this.persistRecord({
      messageId,
      agentBaseUrl: this.config.baseUrl,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      originalRequest: { method: 'message/send', message: structuredClone(message) },
      returnImmediately: false,
    });
    const client = await this.sdkClient();
    try {
      for await (const event of client.sendMessageStream(
        { tenant: '', message, configuration: undefined, metadata: undefined },
        options.signal !== undefined ? { signal: options.signal } : undefined,
      )) {
        const normalized = normalizeStreamEvent(event);
        if (normalized.kind === 'task' && typeof normalized.taskId === 'string') {
          await this.config.ledger.saveTaskId(messageId, normalized.taskId, normalized.contextId ?? '');
        }
        if (normalized.kind === 'statusUpdate' && normalized.state !== undefined) {
          await this.config.ledger.recordState(messageId, normalized.state);
        }
        options.onEvent?.(normalized);
        yield normalized;
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw new TaskWaitAbortedError(
          'Local stream consumption aborted. Per the server contract (stream-resilience) the ' +
            'task keeps running; use cancel() for the independent cleanup or getTask()/resubscribe() to re-attach.',
          { messageId },
        );
      }
      throw mapClientError(error, { messageId });
    }
  }

  /** Re-attach to an active task's event stream after a disconnect. */
  async *resubscribe(
    input: { messageId?: string; taskId?: string },
    options: { signal?: AbortSignal; onEvent?: (event: StreamEvent) => void } = {},
  ): AsyncGenerator<StreamEvent, void, undefined> {
    let taskId = input.taskId;
    if (taskId === undefined && input.messageId !== undefined) {
      taskId = (await this.config.ledger.load(input.messageId))?.taskId;
    }
    if (taskId === undefined) {
      throw new DshA2aClientError('invalid_config', 'resubscribe needs a taskId (directly or via ledger).');
    }
    const client = await this.sdkClient();
    for await (const event of client.resubscribeTask(
      { tenant: '', id: taskId },
      options.signal !== undefined ? { signal: options.signal } : undefined,
    )) {
      const normalized = normalizeStreamEvent(event);
      options.onEvent?.(normalized);
      yield normalized;
    }
  }

  /**
   * Restart recovery scan (§9 client half; §7.4 last paragraph): reads the
   * durable ledger and reports every record whose operation may still be
   * pending — non-terminal tasks to query/re-attach, taskless records to
   * recover via resend, unconfirmed cancel intents to reconfirm.
   */
  async resumePending(): Promise<PendingOperation[]> {
    const records = await this.config.ledger.loadAll();
    const items: PendingOperation[] = [];
    for (const record of Object.values(records)) {
      const state = record.lastKnownState as A2aStateName | undefined;
      const terminal = state !== undefined && isTerminalStateName(state);
      const cancelSettled =
        record.cancelIntent !== undefined &&
        (record.cancelIntent.status === 'confirmed_canceled' ||
          record.cancelIntent.status === 'already_terminal' ||
          record.cancelIntent.status === 'not_found');
      let suggestedAction: PendingOperation['suggestedAction'] = 'nothing_pending';
      if (record.cancelIntent !== undefined && !cancelSettled) {
        suggestedAction = 'reconfirm_cancel';
      } else if (record.taskId === undefined) {
        suggestedAction = 'recover_via_resend';
      } else if (!terminal) {
        suggestedAction = 'query_or_reattach';
      }
      items.push({
        messageId: record.messageId,
        taskId: record.taskId,
        lastKnownState: record.lastKnownState,
        cancelIntentStatus: record.cancelIntent?.status,
        followUpOfTaskId: record.followUpOfTaskId,
        suggestedAction,
      });
    }
    return items;
  }
}

function normalizeStreamEvent(event: unknown): StreamEvent {
  const payload = (event as { payload?: { $case?: string; value?: Record<string, unknown> } })?.payload;
  const value = payload?.value;
  if (payload?.$case === 'task' && isTaskShape(value)) {
    return {
      kind: 'task',
      taskId: value.id,
      contextId: value.contextId,
      state: taskStateName(value.status?.state),
      statusMessage: statusMessageOf(value),
      raw: event,
    };
  }
  if (payload?.$case === 'statusUpdate') {
    const status = value?.['status'] as { state?: unknown; message?: unknown } | undefined;
    return {
      kind: 'statusUpdate',
      taskId: value?.['taskId'] as string | undefined,
      contextId: value?.['contextId'] as string | undefined,
      state: taskStateName(status?.state as number | undefined),
      statusMessage: status?.message === undefined ? undefined : firstTextOfParts((status.message as { parts?: unknown }).parts),
      raw: event,
    };
  }
  if (payload?.$case === 'artifactUpdate') {
    return { kind: 'artifactUpdate', taskId: value?.['taskId'] as string | undefined, raw: event };
  }
  if (payload?.$case === 'message') {
    return { kind: 'message', raw: event };
  }
  return { kind: 'unknown', raw: event };
}

function isTaskNotFound(error: unknown): boolean {
  return (
    error instanceof DshA2aClientError && error.code === 'task_not_found'
  ) || (
    error instanceof Error && error.name === 'TaskNotFoundError'
  );
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
