/**
 * Fail-closed proof for the unexpected-egress guard.
 *
 * The R0 boundary is "the synthetic model is the only reachable endpoint".
 * These tests pin the guard's direction: loopback passes, everything else
 * blocks — including public provider endpoints, unparseable routes, real
 * credentials, and recorded egress that leaves the local mock route.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  EgressViolation,
  SYNTHETIC_KEY_PLACEHOLDER,
  assertNoEgress,
  inspectChildEnv,
  inspectModelBaseUrl,
  inspectRequestRecords,
} from '../../src/egress.ts'
import { inspectComposedRoute } from '../../src/egress-cli.ts'
import { buildChildEnv } from '../../src/child-env.ts'

describe('unexpected-egress guard (synthetic-only model boundary)', () => {
  it('allows the loopback synthetic mock and the loopback discard fallback', () => {
    assert.deepEqual(inspectModelBaseUrl('http://127.0.0.1:45678'), [])
    assert.deepEqual(inspectModelBaseUrl('http://localhost:1/v1/messages'), [])
    assert.deepEqual(inspectModelBaseUrl('http://[::1]:9'), [])
  })

  it('blocks the public DeepSeek and OpenAI model endpoints', () => {
    for (const url of ['https://api.deepseek.com', 'https://api.openai.com/v1', 'https://generativelanguage.googleapis.com']) {
      const findings = inspectModelBaseUrl(url)
      assert.ok(findings.length > 0, `${url} must block`)
      assert.ok(findings.some(item => item.rule === 'egress/non-loopback-host'), `${url} must report a non-loopback host`)
    }
  })

  it('blocks a private-network or metadata endpoint that is not loopback', () => {
    for (const url of ['http://10.0.0.5:8080', 'http://169.254.169.254/latest/meta-data', 'http://mock.internal:11434']) {
      assert.ok(inspectModelBaseUrl(url).length > 0, `${url} must block`)
    }
  })

  it('blocks an empty, unparseable, or non-http route', () => {
    assert.ok(inspectModelBaseUrl('').length > 0)
    assert.ok(inspectModelBaseUrl('not a url').length > 0)
    assert.ok(inspectModelBaseUrl('file:///etc/passwd').length > 0)
  })

  it('blocks https on loopback because the synthetic mock is plain http', () => {
    const findings = inspectModelBaseUrl('https://127.0.0.1:8443')
    assert.ok(findings.some(item => item.rule === 'egress/unexpected-tls'))
  })

  it('resolves the composed profile route to loopback and blocks a drifted literal', () => {
    assert.deepEqual(inspectComposedRoute("!!js process.env.DSH_POC_MOCK_BASE_URL ?? 'http://127.0.0.1:9'"), [])
    assert.deepEqual(inspectComposedRoute('http://127.0.0.1:9'), [])
    const drifted = inspectComposedRoute('https://api.deepseek.com')
    assert.ok(drifted.some(item => item.rule === 'egress/non-loopback-host'), 'a literal public route must block')
    const missing = inspectComposedRoute("!!js process.env.SOME_OTHER_VAR ?? 'https://api.deepseek.com'")
    assert.ok(missing.length > 0, 'a fallback to the public API must block')
  })

  it('blocks a child environment carrying a real credential', () => {
    const synthetic = buildChildEnv({ dshHome: 'C:/tmp/isolated', mockBaseUrl: 'http://127.0.0.1:9' })
    assert.deepEqual(inspectChildEnv(synthetic as Record<string, string | undefined>), [])

    const realKey = { ...synthetic, DEEPSEEK_API_KEY: 'sk-real-looking-credential-value' } as Record<string, string | undefined>
    const findings = inspectChildEnv(realKey)
    assert.ok(findings.some(item => item.rule === 'egress/real-credential'))

    const missing = { ...synthetic, DEEPSEEK_API_KEY: undefined } as Record<string, string | undefined>
    assert.ok(inspectChildEnv(missing).some(item => item.rule === 'egress/missing-synthetic-key'))

    const extra = { ...synthetic, OPENAI_API_KEY: 'sk-other' } as Record<string, string | undefined>
    assert.ok(inspectChildEnv(extra).some(item => item.rule === 'egress/extra-credential-variable'))
  })

  it('accepts sanitized mock records and blocks a non-synthetic credential record', () => {
    assert.deepEqual(
      inspectRequestRecords([{ path: '/v1/messages', authorization: 'absent', apiKeyHeader: SYNTHETIC_KEY_PLACEHOLDER }]),
      [],
    )
    const leaked = inspectRequestRecords([{ path: '/v1/messages', apiKeyHeader: 'present (non-synthetic)' }])
    assert.ok(leaked.some(item => item.rule === 'egress/non-synthetic-credential'))
    const offRoute = inspectRequestRecords([{ path: '/v1/chat/completions' }])
    assert.ok(offRoute.some(item => item.rule === 'egress/unexpected-path'))
  })

  it('throws a blocking violation instead of passing when any finding exists', () => {
    assert.doesNotThrow(() => assertNoEgress([], 'no findings'))
    assert.throws(
      () => assertNoEgress(inspectModelBaseUrl('https://api.deepseek.com'), 'guard'),
      (error: unknown) => error instanceof EgressViolation && error.message.includes('non-loopback'),
    )
  })
})