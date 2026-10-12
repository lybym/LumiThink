/**
 * Unexpected-egress guard for the R0 synthetic-only boundary (Issue #8 AC-B).
 *
 * The PoC must be unable to reach any non-loopback model endpoint. This module
 * is the policy that proves it, both in-process (tests) and as a CLI the R0
 * workflow runs against the composed `--dump-config` tree, the child
 * environment, and any captured mock request records:
 *
 *   * every model base URL must be loopback (`127.0.0.1`, `::1`, `localhost`)
 *     or an explicitly permitted local port;
 *   * a credential value may only ever be the fixed synthetic placeholder —
 *     anything shaped like a real provider key blocks the run;
 *   * the parent environment must not carry a real `DEEPSEEK_API_KEY`.
 *
 * Every violation is reported as an {@link EgressViolation}; the CLI exits
 * non-zero so CI fails closed instead of silently passing.
 */

/** The only credential value the synthetic PoC may use. */
export const SYNTHETIC_KEY_PLACEHOLDER = 'dsh-poc-synthetic-key'

/**
 * Loopback hosts the synthetic mock may use. `127.0.0.1:9` is the discard
 * port the profile falls back to when the mock variable is absent — it must
 * fail closed, so the host is allowed and the port is deliberately dead.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Hosts that are never loopback even though they look local-ish. */
const NON_LOOPBACK_SUFFIXES = ['.local', '.internal', '.localdomain']

export class EgressViolation extends Error {
  override readonly name = 'EgressViolation'
}

export interface EgressFinding {
  severity: 'block'
  rule: string
  detail: string
}

function finding(rule: string, detail: string): EgressFinding {
  return { severity: 'block', rule, detail }
}

/**
 * Inspect one concrete model endpoint URL.
 *
 * Returns an empty array for a loopback URL; otherwise a blocking finding.
 * Anything that cannot be parsed as an absolute URL is blocking (an unparseable
 * route is an unknown route, and unknown is not allowed).
 */
export function inspectModelBaseUrl(raw: string, context = 'model base URL'): EgressFinding[] {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return [finding('egress/empty-url', `${context} is empty; an unknown route must block`)]
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return [finding('egress/unparseable-url', `${context} ${JSON.stringify(trimmed)} is not an absolute URL`)]
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return [finding('egress/unsupported-protocol', `${context} uses ${url.protocol} (only http/https loopback is allowed)`)]
  }

  const host = url.hostname.toLowerCase()
  if (!LOOPBACK_HOSTS.has(host)) {
    return [
      finding(
        'egress/non-loopback-host',
        `${context} points at non-loopback host ${JSON.stringify(host)}; only loopback synthetic endpoints are allowed`,
      ),
    ]
  }
  if (NON_LOOPBACK_SUFFIXES.some(suffix => host.endsWith(suffix))) {
    return [finding('egress/non-loopback-host', `${context} points at ${JSON.stringify(host)}`)]
  }
  if (url.protocol === 'https:') {
    // https on loopback is pointless for the synthetic mock and hides a
    // redirect/proxy path; the R0 boundary is plain-http loopback only.
    return [finding('egress/unexpected-tls', `${context} uses https on loopback (the synthetic mock is plain http)`)]
  }
  return []
}

/**
 * Inspect any captured mock request records (wire evidence).
 *
 * Every recorded path must be `/v1/messages` on the local mock; every recorded
 * credential must be the synthetic placeholder or absent.
 */
export function inspectRequestRecords(
  records: ReadonlyArray<{ path: string; authorization?: string; apiKeyHeader?: string }>,
): EgressFinding[] {
  const findings: EgressFinding[] = []
  for (const record of records) {
    if (!record.path.endsWith('/v1/messages')) {
      findings.push(finding('egress/unexpected-path', `recorded egress path ${JSON.stringify(record.path)} is not the local mock route`))
    }
    for (const [header, value] of [
      ['authorization', record.authorization],
      ['x-api-key', record.apiKeyHeader],
    ] as const) {
      if (value === undefined || value === 'absent') continue
      if (!value.includes(SYNTHETIC_KEY_PLACEHOLDER)) {
        findings.push(
          finding('egress/non-synthetic-credential', `recorded ${header} was not the synthetic placeholder (${JSON.stringify(value)})`),
        )
      }
    }
  }
  return findings
}

/**
 * Inspect the effective child environment for real credentials.
 *
 * The PoC pins `DEEPSEEK_API_KEY` to the synthetic placeholder; any other
 * value (or any extra provider credential variable) blocks.
 */
export function inspectChildEnv(env: Record<string, string | undefined>): EgressFinding[] {
  const findings: EgressFinding[] = []
  const apiKey = env.DEEPSEEK_API_KEY
  if (apiKey === undefined) {
    findings.push(finding('egress/missing-synthetic-key', 'DEEPSEEK_API_KEY is not pinned to the synthetic placeholder'))
  } else if (apiKey !== SYNTHETIC_KEY_PLACEHOLDER) {
    findings.push(
      finding(
        'egress/real-credential',
        `DEEPSEEK_API_KEY is not the synthetic placeholder (length ${apiKey.length}); a real credential must never reach the child`,
      ),
    )
  }

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value.length === 0) continue
    if (key === 'DEEPSEEK_API_KEY') continue
    if (/(API_KEY|APIKEY|ACCESS_TOKEN|SECRET|CLIENT_SECRET|PRIVATE_KEY)$/i.test(key) || /^(OPENAI|ANTHROPIC|AZURE|AWS|GITHUB|GOOGLE)_/i.test(key)) {
      findings.push(finding('egress/extra-credential-variable', `child environment carries ${key}, which is not part of the R0 synthetic policy`))
    }
  }
  return findings
}

/** Throw {@link EgressViolation} when any finding blocks. */
export function assertNoEgress(findings: readonly EgressFinding[], context: string): void {
  const blocking = findings.filter(item => item.severity === 'block')
  if (blocking.length === 0) return
  const lines = blocking.map(item => `  - [${item.rule}] ${item.detail}`)
  throw new EgressViolation(`${context}: unexpected egress to a non-loopback model endpoint is blocked\n${lines.join('\n')}`)
}