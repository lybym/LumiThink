/**
 * Bounded admission scheduler (P1-09, issue #91; docs/A2A_DESIGN.md §13.4,
 * docs/TASK_LIFECYCLE.md §4.1 步骤 3 / §10 容量耗尽). Decisions recorded in
 * docs/adr/0017-a2a-bounded-resource-limits.md.
 *
 * INVARIANT: every admit() -> 'admitted' is matched by exactly one
 * releaseExecution(ticketId). releaseExecution is idempotent; a repeated
 * release only bumps `doubleReleases` (leak diagnostic) and never makes a
 * missing release invisible.
 *
 * Process-local bookkeeping only: persisted facts stay authoritative in the
 * repository, so a restart rebuilds the scheduler empty.
 * SYNTHETIC validation values only (P1 口径).
 */
import type { A2aLimitsConfig } from './config.ts';

/** Stable application reasons (never wire codes). */
export type LimitsRejectionReason =
  | 'queue_full_global'
  | 'queue_full_household'
  | 'queue_wait_timeout'
  | 'capacity_full'
  | 'scheduler_closed'
  | 'daily_budget_exhausted'
  | 'task_budget_exhausted'
  | 'model_slots_full'
  | 'model_wait_timeout';

export interface AdmissionRequest {
  taskId: string;
  contextId: string;
  householdId: string;
  /** Up-front token reservation: estimated input + maximum output (§13.4). */
  tokensToReserve: number;
  /** Queue-slot wait deadline in ms (0 = decide immediately). */
  maxWaitMs: number;
}

export type AdmissionDecision =
  | { outcome: 'admitted'; ticket: AdmissionTicket }
  | { outcome: 'refused'; reason: LimitsRejectionReason; waitedMs: number };

/** A held admission: the ONLY object that can release the slots. */
export interface AdmissionTicket {
  readonly ticketId: number;
  readonly taskId: string;
  readonly contextId: string;
  readonly householdId: string;
  readonly tokensReserved: number;
  readonly waitedMs: number;
}

/** One granted model slot; `release` is idempotent (leak-proof by shape). */
export interface ModelGrant {
  readonly grantId: number;
  /** Tokens reserved by THIS grant (input estimate + maximum output). */
  readonly tokensReserved: number;
  release(outcome: 'completed' | 'failed' | 'canceled'): void;
}

export type ModelCallDecision =
  | { outcome: 'granted'; grant: ModelGrant; waitedMs: number }
  | { outcome: 'refused'; reason: LimitsRejectionReason; waitedMs: number };

export interface ModelCallRequest {
  householdId: string;
  taskId: string;
  /** Estimated input + maximum output, reserved BEFORE the call. */
  tokens: number;
  /** Bounded wait for a model slot (0 = decide immediately). */
  maxWaitMs: number;
}

/** One reserved control-lane permit (查询 / 取消 / 健康检查). */
export interface ControlPermit {
  /** Time spent acquiring the permit (0 when granted immediately). */
  readonly waitedMs: number;
  release(): void;
}

export interface SchedulerSnapshot {
  limits: A2aLimitsConfig;
  queuedGlobal: number;
  queuedByHousehold: Record<string, number>;
  heldTickets: number;
  activeWorkersByHousehold: Record<string, number>;
  activeExecutionsByConversation: Record<string, number>;
  activeModelRequestsByHousehold: Record<string, number>;
  taskTokensByTask: Record<string, number>;
  dailyTokensByHousehold: Record<string, number>;
  /** Un-released model grants (0 in a healthy process; a leak diagnostic). */
  liveModelGrants: number;
  controlInFlight: number;
  counters: SchedulerCounters;
}

export interface SchedulerCounters {
  admissionsAttempted: number;
  admissionsAdmitted: number;
  admissionsRefused: number;
  admissionsQueued: number;
  modelCallsGranted: number;
  modelCallsRefused: number;
  releases: number;
  doubleReleases: number;
  controlRequests: number;
  controlReleased: number;
  doubleControlReleases: number;
  /** Refusals NOT yet admitted, by stable reason (AC 1 / AC 4 evidence). */
  refusalsByReason: Record<LimitsRejectionReason, number>;
  /** Times the fair pump skipped a household that already held its share. */
  fairnessSkips: number;
  queueHighWater: number;
  workerHighWater: number;
  /** Longest granted queue wait (limit measurement for the load report). */
  maxWaitMs: number;
  /** Longest control-permit wait (AC 1 bounded control handling). */
  maxControlWaitMs: number;
  /** Longest observed queue wait INCLUDING timed-out waiters (measured). */
  maxObservedQueueWaitMs: number;
}

/** Internal waiter of the generation FIFO. */
interface Waiter {
  seq: number;
  request: AdmissionRequest;
  enqueuedAtMs: number;
  settled: boolean;
  timer: NodeJS.Timeout | null;
  resolve(decision: AdmissionDecision): void;
}

/** Internal waiter of the model-concurrency FIFO. */
interface ModelWaiter {
  seq: number;
  request: ModelCallRequest;
  enqueuedAtMs: number;
  settled: boolean;
  timer: NodeJS.Timeout | null;
  resolve(decision: ModelCallDecision): void;
}

function bump(map: Map<string, number>, key: string, delta: number): void {
  const next = (map.get(key) ?? 0) + delta;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

function total(map: Map<string, number>): number {
  let acc = 0;
  for (const value of map.values()) acc += value;
  return acc;
}

function toRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(map.entries());
}

function zeroRefusals(): Record<LimitsRejectionReason, number> {
  return {
    queue_full_global: 0,
    queue_full_household: 0,
    queue_wait_timeout: 0,
    capacity_full: 0,
    scheduler_closed: 0,
    daily_budget_exhausted: 0,
    task_budget_exhausted: 0,
    model_slots_full: 0,
    model_wait_timeout: 0,
  };
}

export class AdmissionScheduler {
  private readonly counters: SchedulerCounters = {
    admissionsAttempted: 0,
    admissionsRefused: 0,
    admissionsAdmitted: 0,
    admissionsQueued: 0,
    modelCallsGranted: 0,
    modelCallsRefused: 0,
    releases: 0,
    doubleReleases: 0,
    controlRequests: 0,
    doubleControlReleases: 0,
    controlReleased: 0,
    refusalsByReason: zeroRefusals(),
    fairnessSkips: 0,
    queueHighWater: 0,
    workerHighWater: 0,
    maxWaitMs: 0,
    maxControlWaitMs: 0,
    maxObservedQueueWaitMs: 0,
  };

  private readonly limits: A2aLimitsConfig;
  private readonly now: () => number;

  private readonly queue: Waiter[] = [];
  private readonly modelQueue: ModelWaiter[] = [];
  private readonly heldTickets = new Map<number, AdmissionTicket>();
  private nextTicketId = 1;
  private nextSeq = 1;

  private readonly activeWorkers = new Map<string, number>();
  private readonly activeExecutions = new Map<string, number>();
  private readonly activeModelRequests = new Map<string, number>();
  private readonly dailyTokens = new Map<string, number>();
  private readonly taskTokens = new Map<string, number>();
  /** Live model grants (diagnostics: an un-released grant is a leak). */
  private readonly grants = new Map<number, () => void>();

  private controlInFlight = 0;
  private closed = false;

  constructor(options: { limits: A2aLimitsConfig; now?: () => number }) {
    this.limits = options.limits;
    this.now = options.now ?? ((): number => Date.now());
  }

  get configuredLimits(): A2aLimitsConfig {
    return this.limits;
  }
  // ---------------------------------------------------------------------
  // Refusal accounting (one place so no refusal path can be forgotten).
  // ---------------------------------------------------------------------


  private refuse(reason: LimitsRejectionReason, waitedMs: number): AdmissionDecision {
    this.counters.admissionsRefused += 1;
    this.counters.refusalsByReason[reason] += 1;
    return { outcome: 'refused', reason, waitedMs };
  }

  // ---------------------------------------------------------------------
  // Generation admission: queue slot + pre-reserved budget. The caller MUST
  // release the returned ticket exactly once via releaseExecution.
  // ---------------------------------------------------------------------

  async admit(request: AdmissionRequest): Promise<AdmissionDecision> {
    this.counters.admissionsAttempted += 1;
    if (this.closed) return this.refuse('scheduler_closed', 0);
    const budgetRejection = this.budgetRejection(request);
    if (budgetRejection !== null) return this.refuse(budgetRejection, 0);
    const ticket = this.takeSlot(request, 0);
    if (ticket !== null) {
      this.counters.admissionsAdmitted += 1;
      this.counters.workerHighWater = Math.max(this.counters.workerHighWater, this.heldTickets.size);
      return { outcome: 'admitted', ticket };
    }
    const full = this.queueFullRejection(request.householdId);
    if (full !== null) return this.refuse(full, 0);
    if (request.maxWaitMs <= 0) return this.refuse('capacity_full', 0);
    return await this.enqueue(request);
  }

  /** Synchronous probe: the immediate (no-wait) admission refusal, if any. */
  wouldRefuseImmediately(request: AdmissionRequest): LimitsRejectionReason | null {
    if (this.closed) return 'scheduler_closed';
    const budget = this.budgetRejection(request);
    if (budget !== null) return budget;
    return this.queueFullRejection(request.householdId);
  }

  /** Pre-call budget check (estimated input + max output, §13.4). */
  private budgetRejection(request: AdmissionRequest): LimitsRejectionReason | null {
    const budget = this.limits.modelBudget;
    const dailyUsed = this.dailyTokens.get(request.householdId) ?? 0;
    const me = request.tokensToReserve;
    if (budget.maxDailyTokensPerHousehold > 0 && dailyUsed + me > budget.maxDailyTokensPerHousehold) {
      return 'daily_budget_exhausted';
    }
    const taskUsed = this.taskTokens.get(request.taskId) ?? 0;
    if (taskUsed + me > budget.maxTokensPerTask) return 'task_budget_exhausted';
    return null;
  }

  /** Rejection when the bounded queue itself has no room (AC 1). */
  private queueFullRejection(householdId: string): LimitsRejectionReason | null {
    const familyQueued = this.queue.filter((w) => w.request.householdId === householdId).length;
    if (familyQueued >= this.limits.queue.maxQueuedPerHousehold) return 'queue_full_household';
    if (this.queue.length >= this.limits.queue.maxQueuedGlobal) return 'queue_full_global';
    return null;
  }

  /**
   * Takes a slot when the household has capacity, the conversation is idle
   * and the task holds no ticket yet (a second reservation for one task is a
   * leak shape, not extra capacity).
   */
  private takeSlot(request: AdmissionRequest, waitedMs: number): AdmissionTicket | null {
    const { concurrency } = this.limits;
    if ((this.activeWorkers.get(request.householdId) ?? 0) >= concurrency.maxActiveWorkersPerHousehold) {
      return null;
    }
    if (total(this.activeWorkers) >= concurrency.maxActiveWorkers) return null;
    if (
      (this.activeExecutions.get(request.contextId) ?? 0) >=
      this.limits.conversation.maxActiveExecutionsPerConversation
    ) {
      return null;
    }
    for (const held of this.heldTickets.values()) {
      if (held.taskId === request.taskId) return null;
    }
    const ticketId = this.nextTicketId++;
    const ticket: AdmissionTicket = {
      ticketId,
      taskId: request.taskId,
      householdId: request.householdId,
      contextId: request.contextId,
      tokensReserved: request.tokensToReserve,
      waitedMs,
    };
    this.heldTickets.set(ticketId, ticket);
    bump(this.activeWorkers, request.householdId, 1);
    bump(this.activeExecutions, request.contextId, 1);
    return ticket;
  }

  private enqueue(request: AdmissionRequest): Promise<AdmissionDecision> {
    const enqueuedAtMs = this.now();
    this.counters.admissionsQueued += 1;
    return new Promise<AdmissionDecision>((resolve) => {
      const waiter: Waiter = {
        seq: this.nextSeq++,
        request,
        enqueuedAtMs,
        settled: false,
        timer: null,
        resolve,
      };
      this.queue.push(waiter);
      this.counters.queueHighWater = Math.max(this.counters.queueHighWater, this.queue.length);
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        const waitedMs = this.now() - enqueuedAtMs;
        this.counters.maxObservedQueueWaitMs = Math.max(
          this.counters.maxObservedQueueWaitMs,
          waitedMs,
        );
        this.settleWaiter(waiter, this.refuse('queue_wait_timeout', waitedMs), null);
      }, request.maxWaitMs);
      // A slot may have freed between admit()'s takeSlot() and here: let the
      // FAIR pump try every waiter (including the new one, which is last).
      this.pumpQueueAll();
      // Advance high-water marks from the real occupancy, not just on grant.
      this.counters.workerHighWater = Math.max(this.counters.workerHighWater, this.heldTickets.size);
    });
  }

  /**
   * Settles a waiter and removes it from the FIFO. `ticket` is the granted
   * admission when the waiter WON a slot (so a timeout that loses the race
   * to a grant releases the slot again — no leak); `settleWaiter` never
   * resolves a second time.
   */
  private settleWaiter(
    waiter: Waiter,
    decision: AdmissionDecision,
    granted: AdmissionTicket | null,
  ): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    const index = this.queue.indexOf(waiter);
    if (index >= 0) this.queue.splice(index, 1);
    if (granted !== null && decision.outcome !== 'admitted') {
      this.releaseGranted(granted, false);
    }
    waiter.resolve(decision);
  }

  private releaseGranted(ticket: AdmissionTicket, countRelease: boolean): void {
    this.heldTickets.delete(ticket.ticketId);
    bump(this.activeWorkers, ticket.householdId, -1);
    bump(this.activeExecutions, ticket.contextId, -1);
    if (countRelease) this.counters.releases += 1;
  }

  /**
   * Fair pump (AC 1 家庭间不无限饥饿): walk the FIFO in arrival order; a waiter
   * whose household already holds its FULL share is skipped (fairnessSkips)
   * so the next household's waiter can take the free slot.
   *
   * Re-entrancy: settleWaiter() splices the waiter out before resolving, so
   * a resolution-triggered releaseExecution() -> pumpQueue() recursion sees a
   * consistent FIFO (no double grant, no skipped waiter).
   */
  private pumpQueue(): void {
    for (const waiter of [...this.queue]) {
      if (waiter.settled) continue;
      const householdAtCap =
        (this.activeWorkers.get(waiter.request.householdId) ?? 0) >=
        this.limits.concurrency.maxActiveWorkersPerHousehold;
      if (householdAtCap) {
        this.counters.fairnessSkips += 1;
        continue;
      }
      const waitedMs = this.now() - waiter.enqueuedAtMs;
      const ticket = this.takeSlot(waiter.request, waitedMs);
      if (ticket === null) continue; // household spoke (still no free slot)
      if (waiter.settled) {
        // Timed out between takeSlot and here: hand the slot straight back
        // (a granted-then-settled waiter is the only leak shape here).
        this.releaseGranted(ticket, false);
        continue;
      }
      this.counters.admissionsAdmitted += 1;
      this.counters.maxWaitMs = Math.max(this.counters.maxWaitMs, waitedMs);
      this.settleWaiter(waiter, { outcome: 'admitted', ticket }, null);
    }
  }

  private pumpQueueAll(): void {
    this.pumpQueue();
  }

  /**
   * Releases a held admission (AC 2 不泄漏): safe on EVERY end path
   * (settlement, timeout, cancel fence). Idempotent by ticket identity.
   */
  releaseExecution(ticketId: number): void {
    const ticket = this.heldTickets.get(ticketId);
    if (ticket === undefined) {
      this.counters.doubleReleases += 1;
      return;
    }
    this.releaseGranted(ticket, true);
    this.pumpQueueAll();
    this.pumpModelQueue();
  }

  // ---------------------------------------------------------------------
  // Model concurrency + budget (AC 2 模型失败不泄漏; §13.4 模型调用预算)
  // ---------------------------------------------------------------------

  async acquireModelCall(request: ModelCallRequest): Promise<ModelCallDecision> {
    const rejection = this.modelBudgetRejection(request);
    if (rejection !== null) {
      this.counters.modelCallsRefused += 1;
      return { outcome: 'refused', reason: rejection, waitedMs: 0 };
    }
    const grant = this.takeModelSlot(request);
    if (grant !== null) {
      this.counters.modelCallsGranted += 1;
      return { outcome: 'granted', grant, waitedMs: 0 };
    }
    if (request.maxWaitMs <= 0) {
      this.counters.modelCallsRefused += 1;
      return { outcome: 'refused', reason: 'model_slots_full', waitedMs: 0 };
    }
    return await this.enqueueModelCall(request);
  }

  /**
   * Pre-call budget check (§13.4: 调用前预留预算，重试也计入). The reservation
   * covers the estimated input PLUS the maximum output, and BOTH the task
   * budget and the per-household daily budget are checked before the call.
   */
  private modelBudgetRejection(request: ModelCallRequest): LimitsRejectionReason | null {
    const budget = this.limits.modelBudget;
    const taskUsed = this.taskTokens.get(request.taskId) ?? 0;
    if (taskUsed + request.tokens > budget.maxTokensPerTask) return 'task_budget_exhausted';
    const dailyUsed = this.dailyTokens.get(request.householdId) ?? 0;
    if (
      budget.maxDailyTokensPerHousehold > 0 &&
      dailyUsed + request.tokens > budget.maxDailyTokensPerHousehold
    ) {
      return 'daily_budget_exhausted';
    }
    return null;
  }

  private takeModelSlot(request: ModelCallRequest): ModelGrant | null {
    if ((this.activeModelRequests.get(request.householdId) ?? 0) >=
        this.limits.concurrency.maxActiveModelRequestsPerHousehold) {
      return null;
    }
    if (total(this.activeModelRequests) >= this.limits.concurrency.maxActiveModelRequests) return null;
    bump(this.activeModelRequests, request.householdId, 1);
    bump(this.dailyTokens, request.householdId, request.tokens);
    bump(this.taskTokens, request.taskId, request.tokens);
    const grantId = this.nextSeq++;
    let released = false;
    const release = (): void => {
      if (released) {
        this.counters.doubleReleases += 1;
        return;
      }
      released = true;
      this.grants.delete(grantId);
      bump(this.activeModelRequests, request.householdId, -1);
      bump(this.dailyTokens, request.householdId, -request.tokens);
      bump(this.taskTokens, request.taskId, -request.tokens);
      this.pumpModelQueue();
    };
    this.grants.set(grantId, release);
    return { grantId, tokensReserved: request.tokens, release };
  }

  private enqueueModelCall(request: ModelCallRequest): Promise<ModelCallDecision> {
    const enqueuedAtMs = this.now();
    return new Promise<ModelCallDecision>((resolve) => {
      const waiter: ModelWaiter = {
        seq: this.nextSeq++,
        request,
        enqueuedAtMs,
        settled: false,
        timer: null,
        resolve,
      };
      this.modelQueue.push(waiter);
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        this.modelCallsRefusedInPlace();
        this.settleModelWaiter(waiter, {
          outcome: 'refused',
          reason: 'model_wait_timeout',
          waitedMs: this.now() - enqueuedAtMs,
        }, null);
      }, request.maxWaitMs);
      this.pumpModelQueue();
    });
  }

  private modelCallsRefusedInPlace(): void {
    this.counters.modelCallsRefused += 1;
    this.counters.refusalsByReason.model_wait_timeout += 1;
  }

  private settleModelWaiter(
    waiter: ModelWaiter,
    decision: ModelCallDecision,
    granted: ModelGrant | null,
  ): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer !== null) clearTimeout(waiter.timer);
    const index = this.modelQueue.indexOf(waiter);
    if (index >= 0) this.modelQueue.splice(index, 1);
    if (granted !== null && decision.outcome !== 'granted') granted.release('canceled');
    waiter.resolve(decision);
  }

  private pumpModelQueue(): void {
    for (const waiter of [...this.modelQueue]) {
      if (waiter.settled) continue;
      const budget = this.modelBudgetRejection(waiter.request);
      if (budget !== null) {
        this.counters.modelCallsRefused += 1;
        this.counters.refusalsByReason[budget] += 1;
        this.settleModelWaiter(waiter, { outcome: 'refused', reason: budget, waitedMs: 0 }, null);
        continue;
      }
      const grant = this.takeModelSlot(waiter.request);
      if (grant === null) continue;
      this.counters.modelCallsGranted += 1;
      if (waiter.settled) {
        grant.release('canceled');
        continue;
      }
      this.settleModelWaiter(
        waiter,
        { outcome: 'granted', grant, waitedMs: this.now() - waiter.enqueuedAtMs },
        null,
      );
    }
  }

  // ---------------------------------------------------------------------
  // Reserved control lane (AC 1 取消/查询有界期限)
  // ---------------------------------------------------------------------

  tryAcquireControl(): ControlPermit | null {
    this.counters.controlRequests += 1;
    if (this.controlInFlight >= this.limits.control.reservedControlSlots) return null;
    this.controlInFlight += 1;
    let released = false;
    const startedAtMs = this.now();
    return {
      waitedMs: 0,
      release: () => {
        if (released) {
          this.counters.doubleControlReleases += 1;
          return;
        }
        released = true;
        this.controlInFlight -= 1;
        this.counters.controlReleased += 1;
        this.counters.maxControlWaitMs = Math.max(
          this.counters.maxControlWaitMs,
          this.now() - startedAtMs,
        );
      },
    };
  }

  /**
   * Waits up to `deadlineMs` for a reserved control permit. Returns null
   * when the deadline expires (the caller answers with an explicit standard
   * sentinel instead of hanging) — the control lane is bounded by contract.
   */
  async acquireControl(deadlineMs: number): Promise<ControlPermit | null> {
    const startedAtMs = this.now();
    const permit = this.tryAcquireControl();
    if (permit !== null) return permit;
    for (;;) {
      if (this.now() - startedAtMs >= deadlineMs) return null;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const next = this.tryAcquireControl();
      if (next !== null) return next;
    }
  }

  // ---------------------------------------------------------------------
  // Lifecycle + snapshot
  // ---------------------------------------------------------------------

  close(): void {
    this.closed = true;
    for (const waiter of [...this.queue]) {
      this.settleWaiter(waiter, this.refuse('scheduler_closed', 0), null);
    }
    for (const waiter of [...this.modelQueue]) {
      this.settleModelWaiter(
        waiter,
        { outcome: 'refused', reason: 'scheduler_closed', waitedMs: 0 },
        null,
      );
    }
  }

  snapshot(): SchedulerSnapshot {
    return {
      limits: this.limits,
      queuedGlobal: this.queue.length,
      queuedByHousehold: this.queuedByHousehold(),
      heldTickets: this.heldTickets.size,
      activeWorkersByHousehold: toRecord(this.activeWorkers),
      activeExecutionsByConversation: toRecord(this.activeExecutions),
      activeModelRequestsByHousehold: toRecord(this.activeModelRequests),
      taskTokensByTask: toRecord(this.taskTokens),
      dailyTokensByHousehold: toRecord(this.dailyTokens),
      liveModelGrants: this.grants.size,
      controlInFlight: this.controlInFlight,
      counters: {
        ...this.counters,
        refusalsByReason: { ...this.counters.refusalsByReason },
      },
    };
  }

  private queuedByHousehold(): Record<string, number> {
    const counts = new Map<string, number>();
    for (const waiter of this.queue) bump(counts, waiter.request.householdId, 1);
    return toRecord(counts);
  }
}
