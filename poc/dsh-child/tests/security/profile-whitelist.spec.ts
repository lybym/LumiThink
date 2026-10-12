/**
 * Security tests: the composed `lumithink-child` profile (as verified by
 * `--dump-config`, i.e. the tree the runtime actually mounts) must contain
 * only the explicit allowlist and must never include Shell/PTY, generic FS,
 * arbitrary HTTP fetch, auto plugin install, session-log upload, feedback
 * telemetry, or subagent capabilities.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dumpProfileConfig, type DumpEntry } from '../../src/dump-config.ts'

/** Plugin package names that must never be mounted in the child profile. */
const FORBIDDEN_PLUGIN_NAMES = [
  '@deepseek-ai/dsh-session-log-deepseek',
  '@deepseek-ai/dsh-plugin-package-inventory-deepseek',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-pwsh-local',
  '@deepseek-ai/dsh-pwsh-sandbox',
  '@deepseek-ai/dsh-terminal',
  '@deepseek-ai/dsh-terminal-bash',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-bash-persistent',
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-pwsh-persistent',
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-str-replace-editor',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-cordis',
  '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-tool-workspace-dependencies',
  '@deepseek-ai/dsh-tool-jobs',
  '@deepseek-ai/dsh-tool-goal',
  '@deepseek-ai/dsh-tool-present',
  '@deepseek-ai/dsh-tool-ralph',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-tool-ask-user',
  '@deepseek-ai/dsh-mcp-resources',
  '@deepseek-ai/dsh-mcp-client',
  '@deepseek-ai/dsh-message-feedback',
  '@deepseek-ai/dsh-command-feedback',
  '@deepseek-ai/dsh-host-product-telemetry-otel',
  '@deepseek-ai/dsh-session-telemetry-otel',
  '@deepseek-ai/dsh-session-telemetry',
  '@deepseek-ai/dsh-hmr',
  '@deepseek-ai/dsh-plugin-manager',
  '@deepseek-ai/dsh-fs-local',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-skill-office',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-webhook',
  '@deepseek-ai/dsh-webhook-github',
] as const

/** Rows the allowlist contract requires to be mounted and enabled. */
const REQUIRED_ROWS: Array<{ id: string; name: string }> = [
  { id: 'sdk-app-startup', name: '@deepseek-ai/dsh-sdk-app' },
  { id: 'sdk-jsonrpc-server', name: '@deepseek-ai/dsh-sdk-jsonrpc-server' },
  { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key' },
  { id: 'llm', name: '@deepseek-ai/dsh-llm' },
  { id: 'session', name: '@deepseek-ai/dsh-session' },
  { id: 'system-prompt', name: '@deepseek-ai/dsh-system-prompt' },
  { id: 'tools', name: '@deepseek-ai/dsh-tools' },
  { id: 'agent', name: '@deepseek-ai/dsh-agent' },
  { id: 'agent-loop', name: '@deepseek-ai/dsh-agent-loop' },
  { id: 'sessions', name: '@deepseek-ai/dsh-session-persistence-jsonl' },
]

/** Companion rows allowed by the explicit allowlist beyond REQUIRED_ROWS. */
const ADDITIONAL_ALLOWED_ROWS = new Set([
  '@deepseek-ai/dsh-deepseek-llm-api-extensions',
  '@deepseek-ai/cordis-plugin-timer',
  '@deepseek-ai/dsh-session-title',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-llm-retry',
  '@deepseek-ai/dsh-jobs-local',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-session/invariant',
  '@deepseek-ai/dsh-agent/invariant',
  '@deepseek-ai/dsh-scope/invariant',
  '@deepseek-ai/dsh-agent-loop/invariant',
])

function findRow(entries: DumpEntry[], id: string): DumpEntry | undefined {
  return entries.find(entry => entry.id === id)
}

describe('lumithink-child composed profile whitelist (dump-config evidence)', () => {
  const dump = dumpProfileConfig()

  it('mounts exactly the explicit allowlist rows', () => {
    const names = dump.entries.map(entry => entry.name).filter((name): name is string => typeof name === 'string')
    assert.ok(names.length > 0, 'the composed tree must not be empty')
    const allowed = new Set([...REQUIRED_ROWS.map(row => row.name), ...ADDITIONAL_ALLOWED_ROWS])
    for (const name of names) {
      assert.ok(
        allowed.has(name),
        `unexpected plugin mounted in child profile: ${name}`,
      )
    }
  })

  it('never mounts a dangerous, upload, telemetry, or plugin-management service', () => {
    const names = new Set(dump.entries.map(entry => entry.name))
    for (const forbidden of FORBIDDEN_PLUGIN_NAMES) {
      assert.equal(names.has(forbidden), false, `${forbidden} must not be mounted`)
    }
  })

  it('mounts every required kernel row enabled', () => {
    for (const required of REQUIRED_ROWS) {
      const row = findRow(dump.entries, required.id)
      assert.ok(row !== undefined, `required row ${required.id} missing`)
      assert.equal(row.name, required.name)
      assert.ok(!row.disabled, `required row ${required.id} must not be disabled`)
    }
  })

  it('keeps the agent loop free of subagents', () => {
    const agentLoop = findRow(dump.entries, 'agent-loop')
    assert.ok(agentLoop !== undefined)
    assert.deepEqual(agentLoop.config?.agents, [])
  })

  it('pins the model adapter to the synthetic mock route, never the public API', () => {
    const llm = findRow(dump.entries, 'llm-deepseek')
    assert.ok(llm !== undefined)
    const baseURL = String(llm.config?.baseURL)
    assert.ok(baseURL.includes('DSH_POC_MOCK_BASE_URL'), `baseURL must be mock-driven, got ${baseURL}`)
    assert.ok(!baseURL.includes('api.deepseek.com'), 'baseURL must never fall back to the public API literal')
  })

  it('persists sessions only under the isolated DSH_HOME', () => {
    const sessions = findRow(dump.entries, 'sessions')
    assert.ok(sessions !== undefined)
    assert.ok(String(sessions.config?.root).includes("dshHomePath('sessions')"))
  })
})
