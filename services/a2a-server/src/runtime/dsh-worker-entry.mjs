/**
 * Real DSH worker subprocess entry (P1-05, issue #87).
 *
 * A REAL separate OS process: it is spawned by the runtime, registers with a
 * hello frame, streams candidate output chunks, answers cancels, and exits
 * with a real exit code — every lifecycle fact the Task Manager records
 * (registration, heartbeat, exit evidence) originates HERE, not from an
 * in-process fake.
 *
 * Provider CONTENT is synthetic by design ("模型可采用合成供应商验证进程
 * 机制，需明确真实模型另验", issue #87): this entry proves the process
 * mechanism — spawn/hello/lease/heartbeat/timeout/exit — while real-model
 * verification stays with P1-10/#92. No child data, no credentials, no UDS.
 *
 * Behavior profile: env LUMITHINK_A2A_WORKER_BEHAVIOR (default 'complete').
 * The profiles let tests drive crash / startup failure / 失联 / hang /
 * late-output deterministically through the SAME production spawn path.
 */
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

const PROTO = 1;
const HEARTBEAT_MS = 250;

const behavior = process.env.LUMITHINK_A2A_WORKER_BEHAVIOR ?? 'complete';
const kind = behavior === 'external-kind' ? 'external-companion' : 'internal-executor';

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

let heartbeats = null;
function startHeartbeats() {
  heartbeats = setInterval(() => send({ type: 'heartbeat', ts: Date.now() }), HEARTBEAT_MS);
}
function stopHeartbeats() {
  if (heartbeats !== null) clearInterval(heartbeats);
  heartbeats = null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const forever = () => new Promise(() => {});

async function run() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  // Startup-failure profile: read nothing, send nothing (hello timeout owns cleanup).
  if (behavior === 'no-hello') await forever();

  // Read the runtime's start frame (execution descriptor + input).
  let start = null;
  try {
    start = await new Promise((resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('start frame timeout')), 10_000);
      rl.once('line', (line) => {
        clearTimeout(guard);
        const frame = JSON.parse(line);
        if (frame.type !== 'start') throw new Error(`expected start, got ${frame.type}`);
        resolve(frame);
      });
    });
  } catch {
    process.exit(2);
  }

  // Registration refusal profiles: hellos the runtime must refuse (bad
  // protocol version / external working-DSH kind are never dispatched).
  if (behavior === 'bad-proto' || behavior === 'external-kind') {
    send({
      type: 'hello',
      proto: behavior === 'bad-proto' ? 99 : PROTO,
      kind,
      workerId: `dshw-${process.pid}-${randomUUID().slice(0, 8)}`,
    });
    await forever();
  }

  send({
    type: 'hello',
    proto: PROTO,
    kind,
    workerId: `dshw-${process.pid}-${randomUUID().slice(0, 8)}`,
  });
  send({ type: 'ready' });
  startHeartbeats();

  if (behavior === 'silent-after-ready') {
    // 失联 profile: stops heartbeating and goes silent after ready.
    stopHeartbeats();
    await forever();
  }
  if (behavior === 'crash-after-ready') {
    // Crash profile: abnormal termination before any result. Self-SIGKILL
    // (not process.abort()): abort() can trigger a multi-second core dump
    // on Linux runners, which would blur the crash/失联 distinction.
    await sleep(120);
    process.kill(process.pid, 'SIGKILL');
  }
  if (behavior === 'heartbeat-forever') {
    // Hang profile: heartbeats but never produces a result — the execution
    // deadline owns the cleanup.
    await forever();
  }
  if (behavior === 'exit-failed') {
    await sleep(150);
    send({ type: 'result', outcome: 'failed', reason: 'worker_profile_exit_failed' });
    stopHeartbeats();
    process.exit(3);
  }

  // Output-producing profiles: complete / stop-on-cancel / flood-after-cancel
  // / complete-after-cancel (P1-07 完成竞争) / never-stops (P1-07 非协作).
  if (
    behavior === 'complete' ||
    behavior === 'stop-on-cancel' ||
    behavior === 'flood-after-cancel' ||
    behavior === 'complete-after-cancel' ||
    behavior === 'never-stops'
  ) {
    void (async () => {
      send({ type: 'output', chunkId: 'answer#chunk-1', text: '你好。', lastChunk: false });
      await sleep(150);
      if (behavior === 'complete') {
        send({ type: 'output', chunkId: 'answer#chunk-2', text: '我们开始吧。', lastChunk: true });
        send({ type: 'result', outcome: 'completed' });
        stopHeartbeats();
        process.exit(0);
      }
      // stop-on-cancel / flood-after-cancel / complete-after-cancel /
      // never-stops park here until the cancel control arrives (cooperative
      // stop, late output, completion race and non-cooperation test profiles).
    })();
  }

  rl.on('line', (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame.type !== 'cancel') return;
    if (behavior === 'never-stops') {
      // P1-07 非协作 profile: the cancel control is IGNORED (heartbeats keep
      // running, no result ever arrives) — only the runtime's cancel-grace
      // watchdog terminates this process (forced stop with SIGKILL evidence).
      return;
    }
    stopHeartbeats();
    if (behavior === 'flood-after-cancel') {
      // Late-output profile: keep emitting AFTER the cancel control so the
      // service proves late callbacks are rejected by admission state.
      void (async () => {
        await sleep(120);
        send({ type: 'output', chunkId: 'answer#late-1', text: '迟到的输出。', lastChunk: false });
        send({ type: 'result', outcome: 'canceled', reason: 'worker_profile_canceled' });
        process.exit(0);
      })();
      return;
    }
    if (behavior === 'complete-after-cancel') {
      // P1-07 completion-race profile: the worker had ALREADY finished its
      // work when the cancel control arrived. It emits one late candidate
      // body chunk (the service must suppress it via the admission state),
      // then reports the TRUE completion — the task settles COMPLETED with
      // the suppressed-answer flags, never a fabricated CANCELED.
      void (async () => {
        await sleep(120);
        send({ type: 'output', chunkId: 'answer#late-1', text: '迟到的收尾。', lastChunk: false });
        send({ type: 'result', outcome: 'completed' });
        process.exit(0);
      })();
      return;
    }
    send({ type: 'result', outcome: 'canceled', reason: 'worker_profile_canceled' });
    process.exit(0);
  });
}

void run();
