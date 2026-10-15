/**
 * E2E-02 (issue #52) test helpers — compose the REAL runtime stack: the
 * R1-V1 Orchestrator + children Output Gate + private IPC + R1-V2 Bridge
 * domain service driven by the REAL locked-version DSH adapter from
 * `src/real-agent-port.ts` over the local synthetic Messages mock.
 *
 * PRIVACY: every prompt here is a clearly marked synthetic sample
 * (`E2E02-…` markers). No real child data, credentials or audio exist in
 * this suite.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer as createNetServer } from 'node:net'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, closeSync, openSync, readFileSync, rmSync } from 'node:fs'
import assert from 'node:assert/strict'
import { MockMessagesServer, type MockScript } from '../../src/mock-model.ts'
import { buildChildEnv } from '../../src/child-env.ts'
import { resolveDshBin } from '../../src/dump-config.ts'
import {
  materializeBridgeProfileInto,
  createRealCordisAgentPort,
  type RealCordisAgentPort,
} from '../../src/real-agent-port.ts'
import { createVoiceBridgeStack, type VoiceBridgeStack } from '../../../../lib/server/voice-bridge-composition.ts'
import yaml from 'js-yaml'

export const PIPED_CHILD_UNAVAILABLE =
  'piped stdio child processes are unavailable in this execution environment; the real-runtime evidence must run in a normal shell or CI (fail-closed, never skip)'

/** Whether local sockets (UDS / named pipe) can be opened in this environment. */
export async function canOpenLocalSocket(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = createNetServer()
    probe.once('error', () => resolve(false))
    probe.listen(0, '127.0.0.1', () => {
      probe.close(() => resolve(true))
    })
  })
}

/** POSIX-only socket gate for the real-IPC scenarios (issue #52 AC 3). */
export const SOCKETS_AVAILABLE = process.platform !== 'win32'

export interface BridgeFixture {
  readonly stack: VoiceBridgeStack
  readonly port: RealCordisAgentPort
  readonly mock: MockMessagesServer
  readonly dshHome: string
  readonly sessionKey: string
  /** Observed bridge event frames (assistant.delta carries the transient text). */
  readonly frames: { readonly name: string; readonly payload: Record<string, unknown> }[]
  readonly childEnv: Record<string, string | undefined>
  dispose(): Promise<void>
}

export interface BridgeFixtureOptions {
  /** The synthetic generation script the mock model serves (per turn index). */
  readonly script: MockScript
  /** Extra worker-child environment entries (named fault injections). */
  readonly workerEnv?: Readonly<Record<string, string>>
  /** Bounded whenIdle stop-verification deadline for the adapter. */
  readonly whenIdleTimeoutMs?: number
  /** Force the transport (default: real sockets on POSIX, in-process elsewhere). */
  readonly transport?: 'ipc' | 'in_process'
  /** Session key (default `ses_e2e02bridge01`). */
  readonly sessionKey?: string
}

const SESSION_DEFAULT = 'ses_e2e02bridge01'

/** Compose the full real-runtime stack for one scenario. */
export async function startBridgeFixture(options: BridgeFixtureOptions): Promise<BridgeFixture> {
  const dshHome = await mkdtemp(join(tmpdir(), 'lumithink-bridge-home-'))
  await materializeBridgeProfileInto(dshHome)
  const mock = new MockMessagesServer(options.script)
  const mockBaseUrl = await mock.listen()
  const sessionKey = options.sessionKey ?? SESSION_DEFAULT
  const port = createRealCordisAgentPort({
    dshHome,
    mockBaseUrl,
    ...(options.workerEnv !== undefined ? { workerEnv: options.workerEnv } : {}),
    ...(options.whenIdleTimeoutMs !== undefined ? { whenIdleTimeoutMs: options.whenIdleTimeoutMs } : {}),
  })
  const frames: { name: string; payload: Record<string, unknown> }[] = []
  const transport = options.transport ?? (SOCKETS_AVAILABLE ? 'ipc' : 'in_process')
  const stack = createVoiceBridgeStack({
    scriptFor: () => [],
    agentPort: port,
    onAgentFault: (listener) => port.onFault(listener),
    transport,
    ...(SOCKETS_AVAILABLE ? { socketDir: dshHome } : {}),
  })
  stack.client.onEvent((frame) => {
    if (frame.kind === 'event') {
      frames.push({ name: frame.name, payload: (frame.payload ?? {}) as Record<string, unknown> })
    }
  })
  await stack.start()
  return {
    stack,
    port,
    mock,
    dshHome,
    sessionKey,
    frames,
    childEnv: buildChildEnv({ dshHome, mockBaseUrl }),
    async dispose() {
      await stack.stop().catch(() => undefined)
      await port.disposeAll().catch(() => undefined)
      await mock.close().catch(() => undefined)
      if (dshHome.startsWith(tmpdir())) {
        await rm(dshHome, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  }
}

/** Standard three-round synthetic script (one mock instance per fixture). */
export const THREE_ROUND_TEXTS = Object.freeze([
  'E2E02 第一轮。合成回复句一。合成回复句二！',
  'E2E02 第二轮。合成回复句三。合成回复句四？',
  'E2E02 第三轮。合成回复句五。合成回复句六；',
])

export function threeRoundScript(): MockScript {
  return { fixedTurnTexts: [...THREE_ROUND_TEXTS] }
}

/** Poll until `predicate` holds; fail with `describe` after `timeoutMs`. */
export async function waitFor(
  describe: string,
  predicate: () => boolean,
  timeoutMs = 15_000,
  stepMs = 25,
): Promise<void> {
  const startedAt = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - startedAt > timeoutMs) {
      assert.fail(`timed out after ${timeoutMs}ms waiting for ${describe}`)
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, stepMs)
      timer.unref?.()
    })
  }
}

/** Wait until the trusted turn reaches a terminal state; returns its state. */
export async function waitForTerminalTurn(
  stack: VoiceBridgeStack,
  sessionKey: string,
  turnId: string,
  timeoutMs = 30_000,
): Promise<string> {
  let observed = 'unknown'
  await waitFor(
    `turn ${turnId} to reach a terminal state (last: ${observed})`,
    () => {
      const turn = stack.orchestrator.describeTurn(sessionKey, turnId)
      observed = turn?.state ?? 'unknown'
      return ['COMPLETED', 'CANCELLED', 'FAILED', 'TIMED_OUT'].includes(observed)
    },
    timeoutMs,
  )
  return observed
}

/**
 * Submit one synthetic prompt (contract keys derived) without waiting for the
 * terminal state — used by the mid-stream injection scenarios.
 */
export async function submitSynthetic(
  stack: VoiceBridgeStack,
  sessionKey: string,
  text: string,
): Promise<{ readonly ok: true; readonly turnId: string } | { readonly ok: false; readonly code: string }> {
  const digest = createHash('sha256').update(text, 'utf8').digest('hex')
  const submitted = await stack.submitPrompt({
    sessionKey,
    idempotencyKey: `idem-e2e02-${digest.slice(0, 12)}`,
    fingerprint: digest,
    transientText: text,
  })
  return submitted.ok ? { ok: true, turnId: submitted.turnId } : { ok: false, code: submitted.code }
}

/**
 * Submit one synthetic prompt and wait for its COMPLETED settlement.
 *
 * The IPC contract (v2, issue #51) requires the bounded idempotency key and
 * the content-free hex fingerprint on every `turn.prompt`; this helper derives
 * both deterministically from the synthetic text.
 */
export async function submitAndAwaitCompletion(
  stack: VoiceBridgeStack,
  sessionKey: string,
  text: string,
  timeoutMs = 30_000,
): Promise<string> {
  const digest = createHash('sha256').update(text, 'utf8').digest('hex')
  const submitted = await stack.submitPrompt({
    sessionKey,
    idempotencyKey: `idem-e2e02-${digest.slice(0, 12)}`,
    fingerprint: digest,
    transientText: text,
  })
  assert.equal(submitted.ok, true, `submitPrompt refused: ${JSON.stringify(submitted)}`)
  if (!submitted.ok) throw new Error('unreachable')
  const state = await waitForTerminalTurn(stack, sessionKey, submitted.turnId, timeoutMs)
  assert.equal(state, 'COMPLETED', `turn ${submitted.turnId} settled ${state}, expected COMPLETED`)
  return submitted.turnId
}

// ---------------------------------------------------------------------------
// Bridge profile dump (composed `--dump-config` tree, fd redirection)
// ---------------------------------------------------------------------------

const jsExpressionTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: (value: string) => value,
})
const dumpSchema = (yaml.DEFAULT_SCHEMA as yaml.Schema).extend([jsExpressionTag])

export interface DumpEntry {
  id?: string
  name?: string
  disabled?: boolean | string
  inject?: string[]
  config?: Record<string, unknown>
}

/** Run `--dump-config` for the isolated bridge profile and parse the rows. */
export async function dumpBridgeProfileConfig(dshHome: string, mockBaseUrl: string): Promise<DumpEntry[]> {
  await materializeBridgeProfileInto(dshHome)
  const bin = resolveDshBin()
  const scratch = mkdtempSync(join(tmpdir(), 'lumithink-bridge-dump-'))
  const outPath = join(scratch, 'dump.txt')
  const errPath = join(scratch, 'err.txt')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  try {
    const result = spawnSync(process.execPath, [bin, '--profile', 'lumi-dsh-runtime-bridge', '--dump-config'], {
      cwd: join(dshHome, '..'),
      env: { ...buildChildEnv({ dshHome, mockBaseUrl }) },
      stdio: ['ignore', outFd, errFd],
      timeout: 120_000,
    })
    const stderr = readFileSync(errPath, 'utf8')
    if (result.error !== undefined) {
      throw new Error(`bridge --dump-config could not spawn: ${String(result.error)}`)
    }
    if (result.status !== 0) {
      throw new Error(`bridge --dump-config failed (${result.status}): ${stderr.slice(0, 4000)}`)
    }
    const raw = readFileSync(outPath, 'utf8')
    const parsed = yaml.load(raw, { schema: dumpSchema }) as DumpEntry[] | { insert?: DumpEntry[] }
    return Array.isArray(parsed) ? parsed : (parsed.insert ?? [])
  } finally {
    closeSync(outFd)
    closeSync(errFd)
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      /* scratch cleanup is best-effort */
    }
  }
}
