# ADR-0017: A2A bounded-resource limits, backpressure and content-minimized observability

Status: accepted (P1-09, issue #91)
Date: 2026-10-26
Supersedes: none. Extends ADR-0013 (single authoritative Task Store) and ADR-0016 (runtime lease).

## Context

docs/A2A_DESIGN.md §13.4 freezes the initial protection values for worker/model
concurrency, per-conversation execution, queues, execution deadlines, model
call/token budgets, SQLite bounded waits and worker memory. These numbers are a
capacity contract, not a throughput promise: P1 measures them (load report) and
records any adjustment.

The generation surface must never starve the control surface (查询/取消/健康检查),
and no cap may be "unlimited" (a malformed value refuses to start).

## Decisions

1. **Process-local admission scheduler.** `src/limits/scheduler.ts` holds all
   bounded bookkeeping in-process; persisted facts stay authoritative in the
   repository. A restart rebuilds an EMPTY scheduler (restart recovery, P1-08,
   re-decides every non-terminal state from persisted rows — the two mechanisms
   compose without double-settlement).
2. **Admission runs BEFORE the dispatch lease is claimed (review #108 r1 P0).**
   The composition root injects a synchronous pre-check into the
   dispatch-lease decorator (`capacityPreflight`, backed by
   `scheduler.wouldRefuseImmediately`). A refusal therefore settles on
   `submitted` where REJECTED is a legal transition; claiming first would
   strand the task in `working` forever (working → rejected is an illegal
   snapshot). Residual race windows (a waiter that times out after its claim)
   settle as FAILED through the normal working→failed path instead of
   publishing the illegal snapshot.
3. **Cumulative budgets, retries included (§13.4 调用前预留).** Model grants
   reserve `estimated input + maximum output` tokens up front; releasing a
   grant does NOT refund the reservation — `dailyTokensByHousehold` /
   `taskTokensByTask` are cumulative ledgers for the lifetime of the day/task.
   Per-task CALL COUNTS are tracked separately
   (`maxModelRequestsPerTask`, reason `model_task_call_limit`).
4. **Reserved CONTROL lane.** `control.reservedControlSlots` +
   `controlHandlingDeadlineMs` bound 查询/取消/健康检查 handling independently
   of generation saturation. `/ops/load-report` is served from this lane behind
   the two-tier identity middleware.
5. **Content-minimized observability by ALLOW-LIST.** Structured events carry
   only identifiers, enums, counts, durations and byte sizes
   (`ALLOWED_FIELDS`); unknown fields are DROPPED (counted via
   `droppedFields`). Errors are recorded by CLASS NAME only — messages can
   embed user text. Sensitive-log scanning is structural, not redaction.
6. **Honest enforcement status.** The worker-memory ceiling is enforced via the
   V8 heap flag when configured (`mechanism: 'v8_heap_flag'`,
   `hardLimit: false` — it does not bound native/off-heap memory) and reported
   as `not_configured` otherwise. The per-household daily budget behaves the
   same way. Unfilled §13.4 must-fill values are escalated to a HARD STARTUP
   REFUSAL under `LUMITHINK_A2A_DEPLOYMENT_PROFILE=production`; the default
   'validation' profile starts with a loud warning repeated in the load
   report's `limitations` section. Enforcement is never faked — deferred with
   evidence.

## Consequences

- Capacity refusals settle tasks REJECTED at `submitted` (no dangling rows).
- Leaks are diagnosable (`doubleReleases`, `liveModelGrants`) rather than
  impossible-by-silence; healthy snapshots show zero.
- Multi-instance deployments must re-verify SQLite contention and dispatch
  locking per process count; limits do not multiply automatically.
- Known deferrals recorded on review #108 r1: ledger `busy_timeout`
  differentiation, `working`-without-execution coverage,
  `purgeProcessingScope` trigger wiring (tracked under issue #91 follow-ups /
  #92 acceptance).