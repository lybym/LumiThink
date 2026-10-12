/**
 * Environment isolation policy tests: the child process must receive a fully
 * scrubbed environment — no developer credentials, an opt-out telemetry
 * switch, a throwaway synthetic API key, and its own DSH_HOME.
 */
import { homedir } from 'node:os'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildChildEnv } from '../../src/child-env.ts'
import { isolatedDshHome } from '../../src/child-runtime.ts'

describe('isolated child environment', () => {
  const env = buildChildEnv({ dshHome: isolatedDshHome(), mockBaseUrl: 'http://127.0.0.1:9' })

  it('pins DSH_HOME away from the developer home', () => {
    assert.equal(env.DSH_HOME, isolatedDshHome())
    assert.ok(!env.DSH_HOME!.includes(homedir()), 'DSH_HOME must not point into the developer home')
    assert.ok(env.DSH_HOME!.includes('.r0'))
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
