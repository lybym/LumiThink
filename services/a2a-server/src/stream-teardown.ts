/**
 * SSE stream lifecycle teardown (P1-12, issue #121; TASK_LIFECYCLE §6.2
 * 断流语义: 断开的订阅消费侧要及时收口).
 *
 * ── Why the locked SDK leaks the abandoned consumer ─────────────────────────
 * The locked SDK express handler (`@a2a-js/sdk@1.3.0`,
 * dist/server/express/index.js jsonRpcHandler) pulls the response generator
 * in a tight `for await` loop and `res.write()`s every frame. When the
 * client disconnects SILENTLY (socket gone, no CancelTask), writes on the
 * destroyed socket are silently dropped by Node (OutgoingMessage._writeRaw
 * returns false on a destroyed connection without erroring the write loop —
 * observed: the abandoned consumer stayed subscribed until task settlement,
 * P1-11 repro review id 5692103052), so the SDK write loop keeps awaiting
 * the next event and the response generator — with the ExecutionEventQueue
 * it subscribed to the task's event bus — stays alive until the task
 * settles. The abandoned queue keeps buffering every further bus event for
 * a consumer that is gone.
 *
 * ── Why `generator.return()` through `yield*` is NOT enough ────────────────
 * A delegating wrapper (`yield* inner` + teardown calling `it.return()`)
 * only propagates while the wrapper is suspended AT A YIELD POINT. In the
 * real flow the express loop pulls the next frame immediately after writing
 * the previous one, so at disconnect time the wrapper is EXECUTING (awaiting
 * the inner generator's next()), and the inner is parked awaiting its
 * queue's next event. Per async-generator semantics the return() request
 * queues BEHIND that pending next() and is never processed until an event
 * arrives (verified with a Node probe: return() settles instantly at a
 * yield point, never settles in the executing state). A delegating teardown
 * would therefore only increment counters — a false green for exactly the
 * parked-task scenario this issue reports.
 *
 * ── The fix (and why the SEND path must stay passthrough) ───────────────────
 *   1. `attachStreamTeardownMiddleware` — mounted before the SDK handler,
 *      installs a `res.once('close')` handle for the SubscribeToTask
 *      request and stashes it on the request;
 *   2. `lumithinkUserBuilder` (identity/express-auth) carries the handle
 *      into the SDK `ServerCallContext.user` (the only correlation channel
 *      the SDK offers on this path — no abort signal, no disconnect hook,
 *      verified against the 1.3.0 bundle);
 *   3. `withStreamTeardown` decorates the resubscribe handler method with a
 *      faithful reimplementation of the locked SDK's
 *      `DefaultRequestHandler.resubscribe` (same store, same bus manager,
 *      same terminal/not-found errors via the public `@a2a-js/sdk/errors`
 *      classes, same task-first snapshot and event filtering) that OWNS its
 *      `ExecutionEventQueue` (public export of `@a2a-js/sdk/server`) and
 *      stops it in a disconnect race — the abandoned consumer releases its
 *      bus subscription immediately instead of at task settlement. This is
 *      the fix the issue titles.
 *
 *   SendStreamingMessage is deliberately PASSED THROUGH untouched. In the
 *   locked SDK the streaming-send delivery loop is not just delivery: the
 *   per-request `ResultManager.processEvent` runs INSIDE the generator's
 *   `for await` loop (server/index.js L3163), and the ResultManager is the
 *   taskStore writer that persists every task-state transition. The express
 *   write loop's pending `next()` is the pump that drains bus events through
 *   the ResultManager — terminating the client-facing stream on disconnect
 *   starves that pump, and the task's terminal settlement (e.g. COMPLETED
 *   published by the executor after the client left) is NEVER persisted:
 *   the task stays `working` in the store. This is not hypothetical — it
 *   failed the xiaozhi-a2a-provider real-link gate exactly this way (the
 *   damaged-ledger full-chain test waits for the server task row to reach
 *   `completed` after a mid-turn silent disconnect) on two consecutive CI
 *   runs before this passthrough correction. The resubscribe path has NO
 *   ResultManager (pure event forwarding, server/index.js L3335-3382), so
 *   tearing IT down never affects persistence — which is exactly why the
 *   issue's titular fix (terminate the resubscribe generator) is both safe
 *   and sufficient here.
 *
 * Deliberately NOT touched: the executor side. 断流≠取消 (R8) — tearing
 * down the delivery generator never cancels the running execution; the
 * task settles only through its own path (completion, explicit CancelTask,
 * deadline, revocation). The upstream stream-order guard is not relaxed.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { TaskState, type StreamResponse, type Task } from '@a2a-js/sdk';
import {
  ExecutionEventQueue,
  type AgentExecutionEvent,
  type ExecutionEventBusManager,
  type ServerCallContext,
} from '@a2a-js/sdk/server';
import { RequestMalformedError, TaskNotFoundError, UnsupportedOperationError } from '@a2a-js/sdk/errors';

/** Marker the disconnect race resolves with (never a real iterator result). */
const DISCONNECTED: unique symbol = Symbol('lumithink.streamTeardown.disconnected');

/** Terminal task states — mirrors the locked SDK's TERMINAL_STATE_LIST (1.3.0). */
const TERMINAL_STATES: readonly TaskState[] = [
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
];

/** Per-request handle bridging the HTTP disconnect to the stream generator. */
export interface StreamTeardownHandle {
  /** Resolves when the client disconnect is observed (never rejects). */
  readonly disconnected: Promise<typeof DISCONNECTED>;
  /** True once the disconnect was observed (before or after generator start). */
  readonly fired: boolean;
  /** Releases the handle after normal stream completion (fire becomes a no-op). */
  detach(): void;
}

/**
 * Installs the disconnect handle on a streaming response. The `close` event
 * fires for both silent client disconnects and server-side teardowns
 * (revocation destroys the response) — both are lifecycle收口 points.
 */
export function attachStreamTeardown(res: Response): StreamTeardownHandle {
  let fired = false;
  let detached = false;
  let resolveDisconnected: () => void = () => undefined;
  const disconnected = new Promise<typeof DISCONNECTED>((resolve) => {
    resolveDisconnected = () => resolve(DISCONNECTED);
  });
  const fire = (): void => {
    if (detached || fired) return;
    fired = true;
    resolveDisconnected();
  };
  res.once('close', fire);
  return {
    detach(): void {
      detached = true;
    },
    get fired(): boolean {
      return fired;
    },
    get disconnected(): Promise<typeof DISCONNECTED> {
      return disconnected;
    },
  };
}

const TEARDOWN_METHODS = new Set(['SubscribeToTask']);

/**
 * Middleware mounted before the locked SDK handler: attaches the teardown
 * handle to the resubscribe request only. Mounted AFTER the acceptance gate
 * (body.method is final by then) and BEFORE the SDK handler (whose user
 * builder carries the handle into the call context).
 *
 * SendStreamingMessage is deliberately NOT attached: its delivery loop is
 * the locked SDK's persistence pump (see the module docstring) and must keep
 * the SDK's own disconnect behavior unchanged.
 */
export function attachStreamTeardownMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const body = req.body as { method?: unknown } | undefined;
    if (typeof body?.method === 'string' && TEARDOWN_METHODS.has(body.method)) {
      req.lumithinkStreamTeardown = attachStreamTeardown(res);
    }
    next();
  };
}

/** Content-free lifecycle counters (observability + regression evidence). */
export interface StreamLifecycleCounters {
  /** Resubscribe generators created with a disconnect handle attached (one per live stream). */
  registered: number;
  /** Resubscribe generators terminated because the client disconnected. */
  tornDown: number;
  /** Resubscribe generators that ran to natural completion (client stayed attached). */
  completed: number;
}

/** Collaborators the resubscribe teardown shares with the locked SDK handler. */
export interface ResubscribeTeardownDeps {
  /**
   * The SAME guarded task store the locked SDK handler was built with
   * (P1-04 single-writer): resubscribe reads the authoritative snapshot.
   */
  taskStore: { load(taskId: string, context?: ServerCallContext): Promise<Task | undefined> };
  /** The SAME event bus manager the locked SDK handler was built with. */
  eventBusManager: ExecutionEventBusManager;
}

/**
 * Faithful reimplementation of the locked SDK's resubscribe generator
 * (`DefaultRequestHandler.resubscribe`, @a2a-js/sdk@1.3.0) with ONE
 * lifecycle difference: the `ExecutionEventQueue` is owned here and stopped
 * in a disconnect race — the abandoned consumer releases its bus
 * subscription immediately instead of at task settlement (P1-12, #121).
 *
 * Protocol behavior is kept 1:1 with the locked SDK:
 *   - missing task → `TaskNotFoundError` (-32001, same message);
 *   - terminal task → `UnsupportedOperationError` (-32004, same message) —
 *     the pinned 终态订阅 -32004 semantics stay untouched;
 *   - malformed id → `RequestMalformedError` ('Task ID is required');
 *   - first frame is always the persisted task snapshot;
 *   - no active bus → snapshot-only stream (ends);
 *   - statusUpdate/artifactUpdate/task frames filtered by taskId; message
 *     events skipped; unknown kinds rejected like `assertUnreachableEvent`.
 *
 * Safe to tear down (unlike the send path): resubscribe runs NO
 * ResultManager — it only filters and forwards bus events, so terminating
 * it never starves task-state persistence (see the module docstring).
 */
async function* resubscribeWithTeardown(
  params: { id?: string },
  context: ServerCallContext,
  deps: ResubscribeTeardownDeps,
  handle: StreamTeardownHandle | undefined,
  counters: StreamLifecycleCounters,
): AsyncGenerator<StreamResponse, void, void> {
  const taskId = params.id;
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw new RequestMalformedError('Task ID is required');
  }
  const bus = deps.eventBusManager.getByTaskId(taskId, context);
  const eventQueue = bus === undefined ? undefined : new ExecutionEventQueue(bus);
  let outcome: 'tornDown' | 'completed' | 'failed' = 'failed';
  const disconnected = handle === undefined ? undefined : handle.disconnected;
  try {
    const task = await deps.taskStore.load(taskId, context);
    if (task === undefined) {
      throw new TaskNotFoundError(`Task not found: ${taskId}`);
    }
    if (task.status?.state !== undefined && TERMINAL_STATES.includes(task.status.state)) {
      throw new UnsupportedOperationError(
        `Task ${taskId} is in a terminal state (${task.status.state}) and cannot be subscribed to.`,
      );
    }
    yield { payload: { $case: 'task', value: task } } as StreamResponse;
    if (eventQueue === undefined) {
      outcome = 'completed';
      return;
    }
    const events = eventQueue.events();
    while (true) {
      if (handle?.fired === true) {
        outcome = 'tornDown';
        return;
      }
      const next = events.next();
      void next.catch(() => undefined); // stays handled if the race resolves via disconnect
      const result = await (disconnected === undefined ? next : Promise.race([next, disconnected]));
      if (result === DISCONNECTED) {
        outcome = 'tornDown';
        return; // finally stops the queue — the abandoned subscription is gone NOW
      }
      if (result.done) {
        outcome = 'completed';
        return;
      }
      const event = result.value as AgentExecutionEvent;
      switch (event.kind) {
        case 'statusUpdate':
          if (event.data.taskId === taskId) {
            yield { payload: { $case: 'statusUpdate', value: event.data } } as StreamResponse;
          }
          break;
        case 'artifactUpdate':
          if (event.data.taskId === taskId) {
            yield { payload: { $case: 'artifactUpdate', value: event.data } } as StreamResponse;
          }
          break;
        case 'task':
          if (event.data.id === taskId) {
            yield { payload: { $case: 'task', value: event.data } } as StreamResponse;
          }
          break;
        case 'message':
          // The locked SDK resubscribe skips message events (parity).
          break;
        default: {
          // assertUnreachableEvent parity (plain Error, same wording).
          throw new Error(`Unhandled event kind: ${(event as { kind: string }).kind}`);
        }
      }
    }
  } finally {
    if (outcome === 'tornDown') counters.tornDown += 1;
    else if (outcome === 'completed') counters.completed += 1;
    eventQueue?.stop();
    handle?.detach();
  }
}

/**
 * Wraps the request handler so the resubscribe generator terminates when
 * its client disconnects (see the module docstring for the mechanism and
 * for why SendStreamingMessage must stay passthrough). All other handler
 * methods — including sendMessageStream — delegate through the prototype
 * unchanged; the composition root keeps passing ONE handler object to the
 * locked SDK.
 */
export function withStreamTeardown<T extends object>(
  handler: T,
  counters: StreamLifecycleCounters,
  deps: ResubscribeTeardownDeps,
): T {
  const handleOf = (context: unknown): StreamTeardownHandle | undefined =>
    (context as { user?: { streamTeardown?: StreamTeardownHandle } } | undefined)?.user
      ?.streamTeardown;

  const wrapped = Object.create(handler) as T;
  Object.defineProperties(wrapped, {
    resubscribe: {
      enumerable: false,
      value: (params: unknown, context: unknown): AsyncGenerator<StreamResponse, void, void> => {
        const handle = handleOf(context);
        if (handle !== undefined) counters.registered += 1;
        return resubscribeWithTeardown(
          params as { id?: string },
          context as ServerCallContext,
          deps,
          handle,
          counters,
        );
      },
    },
  });
  return wrapped;
}
