/**
 * Sanitize the R0 JUnit artifact before it leaves CI (Issue #8 AC-B).
 *
 * The report is uploaded on success *and* failure, so it must not carry the
 * runner's absolute paths, hostname, or any other environment detail beyond
 * what the evidence needs. This step rewrites `file` attributes to
 * repository-relative paths (`poc/dsh-child/...`) and redacts `hostname`.
 *
 * It is a source module (not an inline shell one-liner) so the same file runs
 * unchanged on Linux, macOS and Windows: bash quoting is not portable, and an
 * inline Node `-e` snippet silently produced an empty artifact set on the
 * Windows runner.
 *
 * Usage:
 *   node --experimental-strip-types src/sanitize-artifact.ts <raw.xml> <out.xml>
 *
 * Exit codes: 0 on success; 1 when the input is missing, unreadable, empty,
 * unparseable, or when the sanitized output would still contain an absolute
 * path (fail closed: never upload unsanitized evidence).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ReportGateError } from './report-gate.ts'

/** Repository-relative prefix every `file` attribute must end up under. */
export const SANITIZED_PATH_PREFIX = 'poc/dsh-child/'

/** Matches an absolute POSIX or Windows path that must not survive sanitization. */
const ABSOLUTE_PATH_PATTERN = /(?:^|["'>])((?:[A-Za-z]:[\\/]|\/)[^\s"'<>]*poc[\\/]dsh-child[\\/][^\s"'<>]*)/

/**
 * Rewrite one report body.
 *
 * Every `file`/`path`-style attribute is reduced to the repository-relative
 * `poc/dsh-child/...` suffix, and the runner hostname is redacted.
 */
export function sanitizeReport(raw: string): { text: string; rewrittenPaths: number; redactedHostnames: number } {
  let rewrittenPaths = 0
  let redactedHostnames = 0

  let text = raw.replace(/(\b(?:file|path)=")([^"]*)(")/g, (_match, prefix: string, value: string, suffix: string) => {
    const normalized = value.replace(/\\/g, '/')
    const marker = SANITIZED_PATH_PREFIX.replace(/\/$/, '')
    const at = normalized.lastIndexOf(marker)
    if (at < 0) return `${prefix}${value}${suffix}`
    rewrittenPaths += 1
    return `${prefix}${normalized.slice(at)}${suffix}`
  })

  text = text.replace(/\bhostname="[^"]*"/g, () => {
    redactedHostnames += 1
    return 'hostname="(redacted)"'
  })

  return { text, rewrittenPaths, redactedHostnames }
}

function main(argv: string[]): number {
  const [inputPath, outputPath] = argv.filter(argument => !argument.startsWith('--'))
  if (inputPath === undefined || outputPath === undefined) {
    process.stderr.write('R0 artifact sanitizer: usage: sanitize-artifact.ts <raw.xml> <sanitized.xml>\n')
    return 1
  }
  try {
    const raw = readFileSync(inputPath, 'utf8')
    if (raw.trim().length === 0) {
      throw new ReportGateError(`${inputPath} is empty; refusing to upload an empty artifact`)
    }
    if (!/<testsuites\b/.test(raw)) {
      throw new ReportGateError(`${inputPath} has no <testsuites> root; refusing to sanitize an unparseable report`)
    }
    const { text, rewrittenPaths, redactedHostnames } = sanitizeReport(raw)
    const residual = text.match(ABSOLUTE_PATH_PATTERN)
    if (residual !== null) {
      throw new ReportGateError(`sanitized output still contains an absolute path near ${JSON.stringify(residual[1])}`)
    }
    if (text.trim().length === 0) {
      throw new ReportGateError('sanitized output is empty; refusing to upload it')
    }
    writeFileSync(outputPath, text, 'utf8')
    process.stdout.write(
      [
        'R0 artifact sanitizer: OK',
        `input: ${inputPath}`,
        `output: ${outputPath}`,
        `file paths rewritten: ${rewrittenPaths}`,
        `hostnames redacted: ${redactedHostnames}`,
      ].join('\n') + '\n',
    )
    return 0
  } catch (error) {
    process.stderr.write(`R0 artifact sanitizer: BLOCKED — ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

/** Run only when this file is the process entry point (not when imported). */
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  return typeof entry === 'string' && resolve(entry) === resolve(import.meta.filename)
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2))
}