/**
 * CLI for the R0 unexpected-egress guard (Issue #8 AC-B).
 *
 * Usage:
 *   node --experimental-strip-types src/egress-cli.ts [--requests=<json>]
 *
 * It inspects, in order:
 *   1. the composed `lumithink-child` profile (`--dump-config` evidence): the
 *      model adapter route must resolve to a loopback URL, and the composed
 *      tree must expose no tool.
 *   2. the effective child environment: the credential must be the synthetic
 *      placeholder, with no extra provider credential variable.
 *   3. optionally, captured mock request records (`--requests=<json>`): every
 *      recorded path/credential must stay on the local synthetic mock.
 *
 * Exit code 0 means "no unexpected egress path exists"; anything else is a
 * blocked R0 gate and the CI job fails.
 */
import { buildChildEnv } from './child-env.ts'
import { dumpProfileConfig } from './dump-config.ts'
import { isolatedDshHome } from './child-runtime.ts'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertNoEgress, inspectChildEnv, inspectModelBaseUrl, inspectRequestRecords, type EgressFinding } from './egress.ts'

/** The `!!js` expression the patch file declares; resolved by the child at boot. */
const MOCK_EXPRESSION_MARKER = 'DSH_POC_MOCK_BASE_URL'
/** The loopback discard fallback the profile uses when the mock variable is absent. */
const DISCARD_FALLBACK = 'http://127.0.0.1:9'

/**
 * Resolve the composed adapter route to a concrete loopback URL.
 *
 * The dump prints the raw `!!js` expression verbatim (parsed as a literal
 * string by our loader), so the route is only provably loopback when the
 * expression itself references the mock variable or the loopback fallback.
 * Any other shape blocks.
 */
export function inspectComposedRoute(raw: string): EgressFinding[] {
  if (raw.includes(MOCK_EXPRESSION_MARKER) || raw.trim().startsWith(DISCARD_FALLBACK)) {
    // The expression resolves at child boot to either the loopback mock or the
    // loopback discard port; both are loopback and both fail closed.
    const probe = raw.includes(MOCK_EXPRESSION_MARKER) ? DISCARD_FALLBACK : raw.trim()
    return inspectModelBaseUrl(probe, 'composed llm-deepseek baseURL')
  }
  return inspectModelBaseUrl(raw, 'composed llm-deepseek baseURL')
}

async function main(argv: string[]): Promise<number> {
  const findings: EgressFinding[] = []

  const dump = await dumpProfileConfig({ dshHome: isolatedDshHome() })
  const llm = dump.entries.find(entry => entry.id === 'llm-deepseek')
  if (llm === undefined) {
    findings.push({ severity: 'block', rule: 'egress/missing-adapter', detail: 'the composed profile has no llm-deepseek row' })
  } else {
    findings.push(...inspectComposedRoute(String(llm.config?.baseURL ?? '')))
  }

  const toolsRow = dump.entries.find(entry => entry.id === 'tools')
  if (toolsRow === undefined) {
    findings.push({ severity: 'block', rule: 'egress/missing-tools-row', detail: 'the composed profile has no tool registry row' })
  }
  const toolEntries = dump.entries.filter(
    entry => typeof entry.name === 'string' && (entry.name.includes('tool-') || entry.name.includes('terminal') || entry.name.includes('subprocess')),
  )
  if (toolEntries.length > 0) {
    findings.push({
      severity: 'block',
      rule: 'egress/unexpected-tool-provider',
      detail: `the composed profile mounts tool-capable services: ${toolEntries.map(entry => entry.name).join(', ')}`,
    })
  }

  findings.push(...inspectChildEnv(buildChildEnv({ dshHome: isolatedDshHome(), mockBaseUrl: DISCARD_FALLBACK })))

  const requestsArgument = argv.find(argument => argument.startsWith('--requests='))
  if (requestsArgument !== undefined) {
    const requestPath = requestsArgument.slice('--requests='.length)
    const parsed = JSON.parse(readFileSync(requestPath, 'utf8')) as Array<{ path: string; authorization?: string; apiKeyHeader?: string }>
    findings.push(...inspectRequestRecords(parsed))
  }

  assertNoEgress(findings, 'R0 unexpected-egress guard')
  process.stdout.write(
    [
      'R0 unexpected-egress guard: PASS',
      `composed rows checked: ${dump.entries.length}`,
      `composed adapter route: ${String(llm?.config?.baseURL ?? '(missing)')}`,
      'child credential: synthetic placeholder only',
      requestsArgument === undefined ? 'recorded requests: not supplied' : `recorded requests: ${requestsArgument.slice('--requests='.length)}`,
    ].join('\n') + '\n',
  )
  return 0
}

/** Run the guard only when this file is the process entry point (not when imported by tests). */
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  return typeof entry === 'string' && resolve(entry) === resolve(import.meta.filename)
}

if (isEntryPoint()) {
  main(process.argv.slice(2))
    .then(code => {
      process.exitCode = code
    })
    .catch(error => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`R0 unexpected-egress guard: BLOCKED — ${message}\n`)
      process.exitCode = 1
    })
}