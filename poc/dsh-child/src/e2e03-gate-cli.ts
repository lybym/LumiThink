/**
 * CLI for the fail-closed E2E-03 gateway-route gate (issue #53) and its
 * report contract.
 *
 * Usage:
 *   node --experimental-strip-types src/e2e03-gate-cli.ts summarize <report.xml>
 *   node --experimental-strip-types src/e2e03-gate-cli.ts check <report.xml>
 *
 * Same machine-readable contract and fail-closed conditions as the E2E-02
 * gate (shared evaluator), with the E2E-03 baseline and the required
 * real-runtime-through-gateway scenarios.
 *
 * Exit codes:
 *   0  the requested step succeeded
 *   1  the gate BLOCKED (missing/empty/unparseable report, non-zero
 *      fail/error/skip, missing required scenario, or baseline mismatch)
 */
import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ReportGateError,
  evaluateJUnitReportForBaseline,
  type ReportGateResult,
  summarizeJUnitFile,
} from './report-gate.ts'

/** Exact baseline the E2E-03 gateway-route suite must produce. */
export const E2E03_BASELINE = {
  /** Total `<testcase>` rows in the E2E-03 acceptance suite. */
  tests: 4,
  /** Suites in the E2E-03 acceptance report. */
  suites: 1,
  /** Exact `skipped` count. Never allowed to be anything but 0. */
  skipped: 0,
  /** Exact `failures` count. */
  failures: 0,
  /** Exact `errors` count. */
  errors: 0,
} as const

/** The key real-runtime-through-gateway scenarios; each must be present AND executed. */
export const E2E03_REQUIRED_TESTS: ReadonlyArray<{ file: string; name: string }> = [
  {
    file: 'tests/bridge/e2e03-gateway-route.spec.ts',
    name: 'completes three real rounds with streamed deltas and verifiable gateway accounting',
  },
  {
    file: 'tests/bridge/e2e03-gateway-route.spec.ts',
    name: 'degrades a vendor auth failure FAILED with an auditable GATEWAY_AUTH_FAILED and no key echo',
  },
  {
    file: 'tests/bridge/e2e03-gateway-route.spec.ts',
    name: 'refuses turns beyond the daily budget BEFORE the vendor and fails them closed',
  },
  {
    file: 'tests/bridge/e2e03-gateway-route.spec.ts',
    name: 'propagates a mid-stream barge-in cancel to the gateway as an auditable caller cancellation',
  },
]

const USAGE = 'usage: e2e03-gate-cli.ts <summarize|check> <report.xml>'

/** Read + evaluate the report file against the E2E-03 contract (fail closed). */
export function evaluateReportFromDisk(reportPath: string): ReportGateResult {
  let raw: string
  try {
    const stats = statSync(reportPath)
    if (!stats.isFile()) {
      throw new ReportGateError(`JUnit report ${reportPath} is not a regular file`)
    }
    if (stats.size === 0) {
      throw new ReportGateError(`JUnit report ${reportPath} is empty (0 bytes); the gate fails closed`)
    }
    raw = readFileSync(reportPath, 'utf8')
  } catch (error) {
    if (error instanceof ReportGateError) throw error
    throw new ReportGateError(
      `JUnit report ${reportPath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return evaluateJUnitReportForBaseline(raw, E2E03_BASELINE, E2E03_REQUIRED_TESTS, { reportPath })
}

function summarizeCommand(reportPath: string): number {
  try {
    const summary = summarizeJUnitFile(reportPath)
    process.stdout.write(
      [
        'E2E-03 report summarizer: OK',
        `report: ${reportPath}`,
        `tests: ${summary.tests}`,
        `suites: ${summary.suites}`,
        `pass: ${summary.pass}`,
        `fail: ${summary.fail}`,
        `errors: ${summary.errors}`,
        `skipped: ${summary.skipped}`,
      ].join('\n') + '\n',
    )
    return 0
  } catch (error) {
    if (error instanceof ReportGateError) {
      process.stderr.write(`E2E-03 report summarizer: BLOCKED — ${error.message}\n`)
      return 1
    }
    throw error
  }
}

function checkCommand(reportPath: string): number {
  try {
    const result = evaluateReportFromDisk(reportPath)
    process.stdout.write(
      [
        'E2E-03 report gate: PASS',
        `report: ${reportPath}`,
        `tests: ${result.counts.tests}`,
        `suites: ${result.counts.suites}`,
        `pass: ${result.counts.pass}`,
        `fail: ${result.counts.fail}`,
        `errors: ${result.counts.errors}`,
        `skipped: ${result.counts.skipped}`,
        `cancelled: ${result.counts.cancelled}`,
        `baseline: ${E2E03_BASELINE.tests}`,
        `required scenarios executed (${result.requiredExecuted.length}/${E2E03_REQUIRED_TESTS.length}):`,
        ...result.requiredExecuted.map(entry => `  - ${entry}`),
      ].join('\n') + '\n',
    )
    return 0
  } catch (error) {
    if (error instanceof ReportGateError) {
      process.stderr.write(`E2E-03 report gate: BLOCKED — ${error.message}\n`)
      return 1
    }
    throw error
  }
}

export function main(argv: string[]): number {
  const [command, reportPath] = argv
  if (command !== 'summarize' && command !== 'check') {
    process.stderr.write(`E2E-03 report gate: ${USAGE}\n`)
    return 1
  }
  if (reportPath === undefined || reportPath.startsWith('--')) {
    process.stderr.write(`E2E-03 report gate: ${USAGE}\n`)
    return 1
  }
  return command === 'summarize' ? summarizeCommand(reportPath) : checkCommand(reportPath)
}

/** Run only when this file is the process entry point (not when imported). */
function isEntryPoint(): boolean {
  const entry = process.argv[1]
  return typeof entry === 'string' && resolve(entry) === resolve(import.meta.filename)
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2))
}
