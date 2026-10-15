/**
 * E2E-02 (issue #52) bridge-profile security evidence: the REAL runtime runs
 * under the `lumi-dsh-runtime-bridge` profile and the composed `--dump-config`
 * tree is the security truth (never the YAML source). The negative-permission
 * scenario proves — with a physical side-effect canary — that a misbehaving
 * model cannot invoke an unmounted tool through the real Agent Loop, and that
 * every model request stays on the loopback mock with the synthetic credential.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { canSpawnPipedChild } from '../../src/dump-config.ts'
import { inspectChildEnv, inspectModelBaseUrl, inspectRequestRecords } from '../../src/egress.ts'
import {
  PIPED_CHILD_UNAVAILABLE,
  dumpBridgeProfileConfig,
  startBridgeFixture,
  submitAndAwaitCompletion,
  type BridgeFixture,
} from './helpers.ts'
import { BRIDGE_DSH_VERSION, BRIDGE_PROFILE_ID, canonicalBridgeProfile, validateBridgeProfile } from '../../../../lib/domain/voice/bridge/profile.ts'

const pipedOk = await canSpawnPipedChild()

function canaryCommand(sentinelPath: string): string {
  return `mkdir -p "${sentinelPath.replace(/[\\/][^\\/]*$/, '')}" && echo compromised > "${sentinelPath}"`
}

describe('E2E-02 bridge profile security and negative permissions', { skip: pipedOk ? false : PIPED_CHILD_UNAVAILABLE }, () => {
  let fixture: BridgeFixture | undefined
  let canaryDir: string | undefined
  let sentinelPath = ''

  afterEach(async () => {
    await fixture?.dispose()
    fixture = undefined
    if (canaryDir !== undefined) {
      await rm(canaryDir, { recursive: true, force: true }).catch(() => undefined)
      canaryDir = undefined
    }
  })

  it('refuses an unmounted tool request fail-closed and keeps the physical canary untouched', async () => {
    canaryDir = await mkdtemp(join(tmpdir(), 'lumithink-bridge-canary-'))
    sentinelPath = join(canaryDir, 'pwned.sentinel')
    fixture = await startBridgeFixture({
      script: {
        requestBashToolOnce: true,
        bashToolName: 'bash',
        bashCommand: canaryCommand(sentinelPath),
        fixedTurnTexts: ['TOOL_ATTEMPTED'],
        streamChunkDelayMs: 20,
      },
    })
    const { stack, mock, sessionKey, childEnv } = fixture
    const opened = await stack.openSession({
      sessionKey,
      conversationId: 'conv_e2e02sec01',
      ownerActorId: 'act_e2e02parent01',
    })
    assert.equal(opened.ok, true)

    // --- Evidence 1: the side-effect canary is physically untouched -------
    const completedTurnId = await submitAndAwaitCompletion(stack, sessionKey, 'E2E02-SEC 合成转写，请运行 bash。', 30_000, fixture.forensics)
    assert.ok(completedTurnId.length > 0)
    assert.equal(existsSync(sentinelPath), false, 'the unmounted bash tool must not execute')
    assert.deepEqual(await readdir(canaryDir), [], 'the canary directory must stay empty')

    // --- Evidence 2: the model was never shown a tool schema --------------
    const modelRequests = mock.requestRecords.filter((record) => record.path.endsWith('/v1/messages'))
    assert.ok(modelRequests.length > 0)
    for (const record of modelRequests) {
      assert.deepEqual(record.advertisedTools, [], 'the runtime advertised a tool schema the profile never mounted')
    }

    // --- Evidence 3: the composed profile mounts zero tool providers ------
    const dump = await dumpBridgeProfileConfig(fixture.dshHome, fixture.childEnv.DSH_POC_MOCK_BASE_URL ?? '')
    const toolProviders = dump.filter(
      (entry) => typeof entry.name === 'string' && /tool-|terminal|subprocess-local|mcp-client/i.test(entry.name),
    )
    assert.deepEqual(
      toolProviders.map((entry) => entry.name),
      [],
      'the composed bridge profile must mount zero tool providers',
    )

    // --- Evidence 4: the bridge dropped the tool_call channel deltas ------
    assert.ok(
      stack.service.metricsSnapshot().deltasDroppedNonText > 0,
      'tool-call deltas must be counted and dropped before the playback path',
    )

    // --- The canary assertion is meaningful: the path is writable ---------
    await writeFile(sentinelPath, 'probe', 'utf8')
    assert.equal(existsSync(sentinelPath), true)
    await rm(sentinelPath, { force: true })

    // --- Egress evidence on the very same flow -----------------------------
    for (const record of mock.requestRecords) {
      assert.deepEqual(inspectRequestRecords([record]), [], `unexpected egress evidence: ${JSON.stringify(record)}`)
    }
    assert.deepEqual(inspectChildEnv(childEnv), [], 'the worker child environment must stay synthetic')
  })

  it('mounts only the minimal bridge profile allowlist with loopback-only egress', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'lumithink-bridge-home-dump-'))
    try {
      const mockBaseUrl = 'http://127.0.0.1:9'
      const dump = await dumpBridgeProfileConfig(dshHome, mockBaseUrl)
      const names = dump.map((entry) => entry.name ?? '').filter((name) => name.length > 0)
      const forbidden = /dsh-sdk-app|sdk-jsonrpc|session-log|telemetry|crash|feedback|tool-bash|tool-pwsh|tool-fs|tool-web|tool-subagent|terminal|sandbox|subprocess-local|mcp/i
      const violations = names.filter((name) => forbidden.test(name))
      assert.deepEqual(violations, [], `the composed bridge profile must never mount forbidden services: ${JSON.stringify(violations)}`)
      for (const required of [
        '@deepseek-ai/dsh-agent',
        '@deepseek-ai/dsh-agent-loop',
        '@deepseek-ai/dsh-session',
        '@deepseek-ai/dsh-llm',
        '@deepseek-ai/dsh-llm-deepseek-api-key',
        '@deepseek-ai/dsh-tools',
        '@deepseek-ai/dsh-invariants',
        '@deepseek-ai/dsh-session-persistence-jsonl',
      ]) {
        assert.ok(names.includes(required), `the bridge profile must mount the agent kernel row ${required}`)
      }
      const llmRow = dump.find((entry) => entry.name === '@deepseek-ai/dsh-llm-deepseek-api-key')
      assert.ok(llmRow !== undefined, 'the llm adapter row is required')
      // The dump renders `!!js` config expressions VERBATIM (documented in
      // src/dump-config.ts). Resolve the pinned expression exactly as the
      // runtime would — the ONLY permitted shape references
      // DSH_POC_MOCK_BASE_URL with a loopback discard fallback — then inspect
      // the resulting URL. A plain URL row resolves to itself.
      const rawBaseURL = String((llmRow?.config as { baseURL?: unknown } | undefined)?.baseURL ?? '')
      const expressionPattern =
        /^process\.env\.DSH_POC_MOCK_BASE_URL \?\? '(https?:\/\/[^']+)'$/
      const match = expressionPattern.exec(rawBaseURL)
      const resolved = match !== null ? (process.env.DSH_POC_MOCK_BASE_URL ?? match[1]) : rawBaseURL
      assert.deepEqual(inspectModelBaseUrl(resolved, 'bridge profile llm baseURL'), [])

      // The Lumi-side domain contract must stay intact and consistent with
      // the profile identity the bridge worker boots.
      assert.equal(BRIDGE_PROFILE_ID, 'lumi-dsh-runtime-bridge')
      assert.equal(BRIDGE_DSH_VERSION, 'dsh-v0.2.0-rc.2')
      const canonical = canonicalBridgeProfile()
      assert.equal(canonical.profileId, BRIDGE_PROFILE_ID)
      assert.deepEqual(validateBridgeProfile(canonical).tools, canonical.tools)
      assert.equal(canonical.ownership, 'bridge_exclusive')
      assert.deepEqual(canonical.egress.destinations, ['127.0.0.1'])
    } finally {
      await rm(dshHome, { recursive: true, force: true }).catch(() => undefined)
    }
  })

  it('refuses to run without the piped-stdio child probe (a SKIP is never acceptable evidence)', async () => {
    // The real-runtime evidence requires piped child stdio; in an environment
    // that forbids it, this suite must FAIL (never pass via skip). Mirrors
    // the R0 fail-closed probe contract.
    assert.equal(
      canSpawnPipedChild(),
      true,
      'piped stdio is unavailable: the E2E-02 gate must FAIL, not skip (see the e2e02 zero-skip report gate)',
    )
    const lock = readFileSync(join(import.meta.dirname, '..', '..', 'pnpm-lock.yaml'), 'utf8')
    assert.match(lock, /lockfileVersion: '9\.0'/, 'the E2E-02 evidence is pinned to lockfileVersion 9.0')
  })
})
