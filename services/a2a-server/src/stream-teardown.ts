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
 * ── The fix ──────────────────────────────────────────────────────────────────
 *   1. `attachStreamTeardownMiddleware` — mounted before the SDK handler,
 *      installs a `res.once('close')` handle for streaming requests
 *      (SendStreamingMessage / SubscribeToTask) and stashes it on the
 *      request;
 *   2. `lumithinkUserBuilder` (identity/express-auth) carries the handle
 *      into the SDK `ServerCallContext.user` (the only correlation channel
 *      the SDK offers on this path — no abort signal, no disconnect hook,
 *      verified against the 1.3.0 bundle);
 *   3. `withStreamTeardown` decorates the two streaming handler methods:
 *        - resubscribe: a faithful reimplementation of the locked SDK's
 *          `DefaultRequestHandler.resubscribe` (same store, same bus
 *          manager, same terminal/not-found errors via the public
 *          `@a2a-js/sdk/errors` classes, same task-first snapshot and
 *          event filtering) that OWNS its `ExecutionEventQueue` (public
 *          export of `@a2a-js/sdk/server`) and stops it in a disconnect
 *          race — the abandoned consumer releases its bus subscription
 *          immediately instead of at task settlement. This is the fix the
 *          issue titles.
 *        - sendMessageStream: the SDK generator is pumped through a
 *          disconnect race so the client-facing stream terminates on
 *          `res.close` instead of lingering on a dead socket. The SDK
 *          generator itself creates its queue internally (`new
 *          ExecutionEventQueue(eventBus)` — no injection point), so its
 *          bus subscription still releases at task settlement; documented
 *          limitation, bounded by the task's own lifetime (断流≠取消, R8:
 *          the task settles through its own path either way).
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

const STREAMING_METHODS = new Set(['SendStreamingMessage', 'SubscribeToTask']);

/**
 * Middleware mounted before the locked SDK handler: attaches the teardown
 * handle to streaming requests only. Non-streaming POSTs and GETs complete
 * within the request cycle and need no disconnect teardown. Mounted AFTER
 * the acceptance gate (body.method is final by then) and BEFORE the SDK
 * handler (whose user builder carries the handle into the call context).
 */
export function attachStreamTeardownMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const body = req.body as { method?: unknown } | undefined;
    if (typeof body?.method === 'string' && STREAMING_METHODS.has(body.method)) {
      req.lumithinkStreamTeardown = attachStreamTeardown(res);
    }
    next();
  };
}

/** Content-free lifecycle counters (observability + regression evidence). */
export interface StreamLifecycleCounters {
  /** Streaming generators created with a disconnect handle attached (one per live stream). */
  registered: number;
  /** Client-facing streams terminated because the client disconnected. */
  tornDown: number;
  /** Streams that ran to natural completion (client stayed attached). */
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
 * Wraps a SendStreamingMessage delivery generator in a disconnect race:
 * the client-facing stream terminates as soon as `res.close` fires instead
 * of lingering until the task settles. The inner SDK generator created its
 * ExecutionEventQueue internally (no injection point in the locked SDK), so
 * its bus subscription releases at task settlement — bounded by the task's
 * own lifetime (断流≠取消), never by our teardown.
 */
function pumpWithDisconnect(
  inner: AsyncGenerator<StreamResponse, void, void>,
  handle: StreamTeardownHandle | undefined,
  counters: StreamLifecycleCounters,
): AsyncGenerator<StreamResponse, void, void> {
  if (handle === undefined) return inner;
  // Narrowed capture AFTER the guard: the hoisted `function* pump` below does
  // not inherit control-flow narrowing from this scope (service tsconfig).
  const h: StreamTeardownHandle = handle;
  counters.registered += 1;
  let outcome: 'tornDown' | 'completed' | 'failed' = 'failed';
  const disconnected = h.disconnected;
  async function* pump(): AsyncGenerator<StreamResponse, void, void> {
    const it = inner[Symbol.asyncIterator]();
    try {
      // Client already gone before the first pull: never start the SDK
      // generator at all — nothing subscribes to the bus in the first place.
      if (h.fired) {
        outcome = 'tornDown';
        return;
      }
      while (true) {
        if (h.fired) {
          outcome = 'tornDown';
          return;
        }
        const next = it.next();
        void next.catch(() => undefined); // stays handled if the race resolves via disconnect
        const result = await Promise.race([next, disconnected]);
        if (result === DISCONNECTED) {
          outcome = 'tornDown';
          return;
        }
        if (result.done) {
          outcome = 'completed';
          return;
        }
        yield result.value;
      }
    } finally {
      if (outcome === 'tornDown') counters.tornDown += 1;
      else if (outcome === 'completed') counters.completed += 1;
      h.detach();
      // Best-effort termination of the inner generator; while it is parked
      // awaiting its queue the return() queues behind the pending next()
      // and only lands at settlement (see module docstring).
      void it.return?.().catch(() => undefined);
    }
  }
  return pump();
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
 * Wraps the request handler so every streaming generator
 * (SendStreamingMessage / SubscribeToTask) terminates when its client
 * disconnects (see the module docstring for the mechanism). All other
 * handler methods delegate through the prototype — the composition root
 * keeps passing ONE handler object to the locked SDK.
 */
export function withStreamTeardown<T extends object>(
  handler: T,
  counters: StreamLifecycleCounters,
  deps: ResubscribeTeardownDeps,
): T {
  const anyHandler = handler as {
    sendMessageStream(params: unknown, context: unknown): AsyncGenerator<StreamResponse, void, void>;
  };
  const handleOf = (context: unknown): StreamTeardownHandle | undefined =>
    (context as { user?: { streamTeardown?: StreamTeardownHandle } } | undefined)?.user
      ?.streamTeardown;

  const wrapped = Object.create(handler) as T;
  Object.defineProperties(wrapped, {
    sendMessageStream: {
      enumerable: false,
      value: (params: unknown, context: unknown): AsyncGenerator<StreamResponse, void, void> =>
        pumpWithDisconnect(anyHandler.sendMessageStream(params, context), handleOf(context), counters),
    },
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
