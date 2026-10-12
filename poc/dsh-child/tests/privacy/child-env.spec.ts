/**
 * Environment isolation policy tests: the child process must receive a fully
 * scrubbed environment — no developer credentials, an opt-out telemetry
 * switch, a throwaway synthetic API key, and its own DSH_HOME.
 */
import { homedir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildChildEnv } from '../../src/child-env.ts'
import { isolatedDshHome, pocWorkDir } from '../../src/child-runtime.ts'

/** The developer/runner Harness home the child must never read. */
const DEVELOPER_DSH_HOME = join(homedir(), '.dsh')

describe('isolated child environment', () => {
  const env = buildChildEnv({ dshHome: isolatedDshHome(), mockBaseUrl: 'http://127.0.0.1:9' })

  it('pins DSH_HOME inside the isolated PoC work dir, never a real Harness home', () => {
    const dshHome = env.DSH_HOME
    assert.equal(dshHome, isolatedDshHome())
    assert.ok(dshHome !== undefined && dshHome.length > 0, 'DSH_HOME must be set')
    assert.ok(dshHome!.includes('.r0'), `DSH_HOME must live under the PoC .r0 work dir, got ${dshHome}`)

    // The real policy: the child home is a subdirectory of the PoC work dir,
    // i.e. it is NOT the developer/runner `~/.dsh` nor anything inside it.
    const pocRoot = pocWorkDir()
    const inside = relative(pocRoot, dshHome!)
    assert.ok(
      inside.length > 0 && !inside.startsWith('..') && !isAbsolute(inside),
      `DSH_HOME ${dshHome} must be a subdirectory of the PoC work dir ${pocRoot}`,
    )
    assert.ok(
      dshHome !== DEVELOPER_DSH_HOME && !dshHome!.startsWith(`${DEVELOPER_DSH_HOME}\\`) && !dshHome!.startsWith(`${DEVELOPER_DSH_HOME}/`),
      `DSH_HOME ${dshHome} must never be the developer/runner Harness home (${DEVELOPER_DSH_HOME}) or a directory inside it`,
    )
    // A workflow may deliberately export its own isolated DSH_HOME; the child
    // must then receive exactly that path, not a value re-derived from HOME.
    if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0) {
      const ambient = process.env.DSH_HOME
      const ambientEnv = buildChildEnv({ dshHome: ambient, mockBaseUrl: 'http://127.0.0.1:9' })
      assert.equal(ambientEnv.DSH_HOME, ambient, 'an explicit isolated DSH_HOME must be honoured verbatim')
    }
  })

  it('carries no real DeepSeek credentials', () => {
    assert.equal(env.DEEPSEEK_API_KEY, 'dsh-poc-synthetic-key')
  })

  it('opts the child out of telemetry', () => {
    assert.equal(env.DSH_TELEMETRY_DISABLED, '1')
  })

  it('never forwards secret-shaped variables from the parent', () => {
    const secretShaped = Object.keys(env).filter(key =>
      /^(GITHUB|GH_|AWS|AZURE|OPENAI|ANTHROPIC|NPM_TOKEN|SSH)/i.test(key),
    )
    assert.deepEqual(secretShaped, [], 'secret-shaped variables must not reach the child')
    // The only DEEPSEEK_ variable is the synthetic key placeholder.
    const deepseekVars = Object.keys(env).filter(key => key.startsWith('DEEPSEEK_'))
    assert.deepEqual(deepseekVars, ['DEEPSEEK_API_KEY'])
  })

  it('routes the model adapter only to the local mock', () => {
    assert.match(env.DSH_POC_MOCK_BASE_URL!, /^http:\/\/127\.0\.0\.1:\d+$/)
  })
})
