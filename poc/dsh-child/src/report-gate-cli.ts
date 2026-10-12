/**
 * CLI for the fail-closed R0 acceptance gate and its report contract.
 *
 * Usage:
 *   node --experimental-strip-types src/report-gate-cli.ts summarize <report.xml>
 *   node --experimental-strip-types src/report-gate-cli.ts check <report.xml>
 *
 * `summarize` attaches the machine-readable contract comments (`r0-contract-
 * version`, `tests`, `skipped`, …) derived from the report's own rows.
 * `check` enforces the baseline, zero-skip and required-test evidence.
 *
 * Exit codes:
 *   0  the requested step succeeded
 *   1  the gate BLOCKED (missing / empty / unparseable / truncated report,
 *      non-zero fail/error/skip, missing required test, or baseline mismatch)
 *
 * The full blocking reason goes to stderr so a CI log carries the exact cause;
 * the machine-readable summary is printed to stdout on success only.
 */
import { resolve } from 'node:path'
import {
  R0_BASELINE,
  R0_REQUIRED_TESTS,
  ReportGateError,
  evaluateJUnitReportFile,
  summarizeJUnitFile,
} from './report-gate.ts'

const USAGE = 'usage: report-gate-cli.ts <summarize|check> <report.xml>'

function summarizeCommand(reportPath: string): number {
  try {
    const summary = summarizeJUnitFile(reportPath)
    process.stdout.write(
      [
        'R0 report summarizer: OK',
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
      process.stderr.write(`R0 report summarizer: BLOCKED — ${error.message}\n`)
      return 1
    }
    throw error
  }
}

function checkCommand(reportPath: string): number {
  try {
    const result = evaluateJUnitReportFile(reportPath)
    process.stdout.write(
      [
        'R0 report gate: PASS',
        `report: ${reportPath}`,
        `tests: ${result.counts.tests}`,
        `suites: ${result.counts.suites}`,
        `pass: ${result.counts.pass}`,
        `fail: ${result.counts.fail}`,
        `errors: ${result.counts.errors}`,
        `skipped: ${result.counts.skipped}`,
        `cancelled: ${result.counts.cancelled}`,
        `baseline: ${R0_BASELINE.tests}`,
        `required tests executed (${result.requiredExecuted.length}/${R0_REQUIRED_TESTS.length}):`,
        ...result.requiredExecuted.map(entry => `  - ${entry}`),
      ].join('\n') + '\n',
    )
    return 0
  } catch (error) {
    if (error instanceof ReportGateError) {
      process.stderr.write(`R0 report gate: BLOCKED — ${error.message}\n`)
      return 1
    }
    throw error
  }
}

export function main(argv: string[]): number {
  const [command, reportPath] = argv
  if (command !== 'summarize' && command !== 'check') {
    process.stderr.write(`R0 report gate: ${USAGE}\n`)
    return 1
  }
  if (reportPath === undefined || reportPath.startsWith('--')) {
    process.stderr.write(`R0 report gate: ${USAGE}\n`)
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