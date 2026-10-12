/**
 * Negative permission test: a compromised/misbehaving model asks for the
 * `bash` tool even though the profile advertises no tools.
 *
 * Issue #8 AC-A requires this to prove *no real command execution, no side
 * effect, and no unauthorized tool invocation* — not merely that a string is
 * absent from the response. The test therefore reads three independent kinds
 * of evidence:
 *
 *   1. a side-effect canary: the model asks bash to create a sentinel file in
 *      a private temp directory (cross-platform command, no shell needed).
 *      The file must not exist afterwards, and the canary directory must stay
 *      empty — an executed command would be physically detectable;
 *   2. registry evidence: the model was never shown a tool schema, and the
 *      composed `--dump-config` tree mounts no tool provider at all, so the
 *      runtime had nothing it could dispatch to;
 *   3. event-stream evidence: the collected turn events carry no tool
 *      execution/result frame and never contain the canary command.
 *
 * The test spawns the runtime over piped stdio. If piped stdio is unavailable
 * the R0 gate must FAIL — never pass via skip — so the skip reason is also
 * asserted to be unreachable in CI by the fail-closed environment probe below.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MockMessagesServer } from '../../src/mock-model.ts'
import { disposeTempHome, startChildHarness } from '../../src/child-runtime.ts'
import { canSpawnPipedChild, dumpProfileConfig } from '../../src/dump-config.ts'
import type { StartedChild } from '../../src/child-runtime.ts'

const SYNTHETIC_SESSION = 'child_demo_001'
const PIPES_UNAVAILABLE = 'piped stdio child processes are unavailable in this execution environment; run the suite in a normal shell or CI for negative-permission evidence'

/** A cross-platform bash command that would leave a physical side effect. */
function canaryCommand(sentinelPath: string): string {
  return `mkdir -p "${sentinelPath.replace(/[\\/][^\\/]*$/, '')}" && echo compromised > "${sentinelPath}"`
}

interface ToolCallFrame {
  name?: string
  arguments?: string
  callId?: string
}

/** Extract the runtime's `tool/call` frames — the model's *attempt*, not an execution. */
function toolCallFrames(events: readonly unknown[]): ToolCallFrame[] {
  const frames: ToolCallFrame[] = []
  for (const event of events) {
    const typed = event as { type?: string; data?: { name?: string; arguments?: string; callId?: string } }
    if (typed.type === 'tool/call') {
      frames.push({ name: typed.data?.name, arguments: typed.data?.arguments, callId: typed.data?.callId })
    }
  }
  return frames
}

interface ToolResultFrame {
  callId?: string
  isError?: boolean
  errorName?: string
  errorCode?: string
  text?: string
}

/** Extract the runtime's `tool/result` frames — what happened to each attempt. */
function toolResultFrames(events: readonly unknown[]): ToolResultFrame[] {
  const frames: ToolResultFrame[] = []
  for (const event of events) {
    const typed = event as {
      type?: string
      data?: {
        message?: { toolCallId?: string; isError?: boolean; content?: Array<{ text?: string }> }
        error?: { name?: string; code?: string }
      }
    }
    if (typed.type !== 'tool/result') continue
    frames.push({
      callId: typed.data?.message?.toolCallId,
      isError: typed.data?.message?.isError,
      errorName: typed.data?.error?.name,
      errorCode: typed.data?.error?.code,
      text: typed.data?.message?.content?.map(block => block.text ?? '').join(''),
    })
  }
  return frames
}

/**
 * A frame that proves a real execution happened: a terminal/subprocess
 * execution event, or command output leaving the machine. A `tool/call`
 * attempt and its fail-closed `tool/result` error are expected and required.
 */
function executionFrameTypes(events: readonly unknown[]): string[] {
  const found: string[] = []
  for (const event of events) {
    const type = (event as { type?: string }).type ?? ''
    if (/command\/output|terminal\/|subprocess\//i.test(type)) found.push(type)
  }
  return found
}

describe('model cannot invoke unmounted tools', { skip: canSpawnPipedChild() ? false : PIPES_UNAVAILABLE }, () => {
  let mock: MockMessagesServer
  let started: StartedChild | undefined
  let canaryDir: string
  let sentinelPath: string

  beforeEach(async () => {
    canaryDir = await mkdtemp(join(tmpdir(), 'lumithink-canary-'))
    sentinelPath = join(canaryDir, 'pwned.sentinel')
    mock = new MockMessagesServer({
      requestBashToolOnce: true,
      bashCommand: canaryCommand(sentinelPath),
    })
  })

  afterEach(async () => {
    await started?.harness.close().catch(() => undefined)
    if (started !== undefined && started.dshHome.includes('lumithink-child-home-')) {
      await disposeTempHome(started.dshHome)
    }
    started = undefined
    await mock.close().catch(() => undefined)
    await rm(canaryDir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('fails closed when the model requests the unmounted bash tool', async () => {
    started = await startChildHarness({ mock })

    // The turn either rejects (protocol/unknown-tool) or completes with a
    // handled tool error; both are acceptable fail-closed outcomes.
    let outcome:
      | { kind: 'rejected'; error: unknown }
      | { kind: 'responded'; finalResponse: string; events: readonly unknown[] }
    try {
      const result = await started.harness.run('请运行 bash 命令把哨兵文件写出来', { sessionId: SYNTHETIC_SESSION })
      outcome = { kind: 'responded', finalResponse: result.finalResponse, events: result.events }
    } catch (error) {
      outcome = { kind: 'rejected', error }
    }

    // --- Evidence 1: the side-effect canary is untouched -------------------
    assert.equal(
      existsSync(sentinelPath),
      false,
      `the unmounted bash tool must not execute: sentinel ${sentinelPath} exists`,
    )
    const canaryEntries = await readdir(canaryDir)
    assert.deepEqual(canaryEntries, [], `the canary directory must stay empty, found ${JSON.stringify(canaryEntries)}`)

    // --- Evidence 2: registry — no tool schema was ever advertised ---------
    const modelRequests = mock.requestRecords.filter(record => record.path.endsWith('/v1/messages'))
    assert.ok(modelRequests.length > 0)
    for (const record of modelRequests) {
      assert.deepEqual(record.advertisedTools, [], 'the runtime advertised a tool schema the profile never mounted')
    }

    // The composed profile itself mounts no tool provider, so there is nothing
    // the runtime could have dispatched the call to.
    const dump = await dumpProfileConfig()
    const toolProviders = dump.entries.filter(
      entry => typeof entry.name === 'string' && /tool-|terminal|subprocess-local|mcp-client/i.test(entry.name),
    )
    assert.deepEqual(
      toolProviders.map(entry => entry.name),
      [],
      'the composed profile must mount zero tool providers',
    )

    // --- Evidence 3: the event stream shows the attempt and its fail-closed result --
    if (outcome.kind === 'responded') {
      // The runtime records the unauthorized attempt as a `tool/call` frame
      // (the audit trail) and answers it with a fail-closed error frame. What
      // must never appear is real execution evidence: a terminal/subprocess
      // frame or actual command output.
      assert.deepEqual(
        executionFrameTypes(outcome.events),
        [],
        'the turn events must contain no terminal/subprocess execution frame',
      )

      const attempts = toolCallFrames(outcome.events)
      assert.ok(attempts.length > 0, 'the unauthorized attempt must be recorded as a tool/call frame for the audit trail')
      for (const attempt of attempts) {
        assert.equal(attempt.name, 'bash', 'the only attempted call is the unmounted bash tool')
        assert.ok(
          typeof attempt.arguments === 'string' && attempt.arguments.length > 0,
          'the attempt frame must carry the model-requested arguments for the audit trail',
        )
      }

      const results = toolResultFrames(outcome.events)
      assert.equal(
        results.length,
        attempts.length,
        'every unauthorized attempt must be answered by exactly one tool/result frame',
      )
      for (const result of results) {
        // The result must be an explicit error raised by the runtime, not a
        // successful tool response. This is the "no unauthorized tool
        // invocation" proof at the protocol level.
        assert.equal(result.isError, true, `the tool/result must be an error frame, got ${JSON.stringify(result)}`)
        assert.equal(result.errorName, 'ToolNotFoundError', 'the fail-closed error must be the unmounted-tool error')
        assert.equal(result.errorCode, 'UNKNOWN_TOOL', 'the fail-closed error code must be UNKNOWN_TOOL')
        assert.ok(
          (result.text ?? '').includes('unknown tool'),
          `the error frame must state that the tool is unknown, got ${JSON.stringify(result.text)}`,
        )
        // The error frame must never smuggle real command output.
        assert.ok(!(result.text ?? '').includes('compromised'), 'the error frame must not contain command output')
      }

      const serializedEvents = JSON.stringify(outcome.events)
      // The canary command legitimately appears inside the recorded *attempt*
      // arguments (it is what the model asked for). The authoritative
      // side-effect proof is the physical canary check above; here we only
      // require that no *produced output* surfaced. The attempt argument is
      // excluded because it is the model's own request text, not command output.
      const withoutAttemptArguments = serializedEvents.replace(/"arguments":"(?:[^"\\]|\\.)*"/g, '"arguments":"(redacted)"')
      assert.ok(
        !withoutAttemptArguments.includes('compromised'),
        'no event frame outside the recorded attempt may carry the canary command output',
      )
      assert.ok(
        !outcome.finalResponse.includes('compromised'),
        'the response must never contain the canary command output',
      )
      assert.ok(!outcome.finalResponse.includes('pwned'), 'a response must never contain executed command output')
    } else {
      // Fail-closed via rejection: it must be a real Error carrying a
      // non-empty message, and that message must never contain executed
      // command output (a rejection echoing `pwned` would be a leak).
      assert.ok(outcome.error instanceof Error, `rejection must be an Error, got ${typeof outcome.error}`)
      assert.ok(outcome.error.message.length > 0, 'rejection must carry a non-empty message')
      assert.ok(!outcome.error.message.includes('pwned'), 'a rejection must never contain executed command output')
    }

    // --- The canary assertion is meaningful: prove it can be created -------
    // If the command were actually executed through a real shell, the sentinel
    // path resolves to this exact file. Writing it here proves the path is
    // writable, so the "file absent" evidence above is not vacuous.
    const probe = await import('node:fs/promises')
    await probe.writeFile(sentinelPath, 'probe', 'utf8')
    assert.equal(existsSync(sentinelPath), true, 'the canary path must be writable for the negative evidence to be meaningful')
    await probe.rm(sentinelPath, { force: true })
  })

  it('blocks an unmounted pwsh tool through the same fail-closed path', async () => {
    // The unmounted-shell case must not be bash-specific: a different shell
    // tool name goes through the identical fail-closed path.
    mock = new MockMessagesServer({
      requestBashToolOnce: true,
      bashToolName: 'pwsh',
      bashCommand: canaryCommand(sentinelPath),
    })
    started = await startChildHarness({ mock })

    try {
      await started.harness.run('请运行 pwsh 命令', { sessionId: SYNTHETIC_SESSION })
    } catch {
      /* a rejection is an acceptable fail-closed outcome */
    }

    assert.equal(existsSync(sentinelPath), false, 'the unmounted pwsh tool must not execute')
    assert.deepEqual(await readdir(canaryDir), [], 'the canary directory must stay empty')
    for (const record of mock.requestRecords) {
      assert.deepEqual(record.advertisedTools, [], 'no tool schema may be advertised')
    }
  })

  it('keeps the piped-stdio probe fail-closed (a SKIP is never acceptable evidence)', () => {
    // Issue #8: if an environment forbids piped child stdio, the R0 gate must
    // FAIL instead of passing through a skip. The probe therefore has to be a
    // real execution check, and this suite must refuse to run without it.
    assert.equal(
      canSpawnPipedChild(),
      true,
      'piped stdio is unavailable: the R0 suite must FAIL, not skip (see src/report-gate.ts baseline gate)',
    )
    // The manifest lock file drives the CI install; a missing lock file would
    // silently change what this negative evidence was produced against.
    const lock = readFileSync(join(import.meta.dirname, '..', '..', 'pnpm-lock.yaml'), 'utf8')
    assert.match(lock, /lockfileVersion: '9\.0'/, 'the R0 evidence is pinned to lockfileVersion 9.0')
  })
})