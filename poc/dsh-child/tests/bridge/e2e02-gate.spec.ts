/**
 * E2E-02 report-gate self-tests (issue #52): the zero-skip contract must be
 * proven fail-closed — a conforming report passes, and every tampered,
 * skipped, failed or baseline-drifting variant BLOCKS.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { E2E02_BASELINE, E2E02_REQUIRED_TESTS, evaluateReportFromDisk, main as gateMain } from '../../src/e2e02-gate-cli.ts'
import { summarizeJUnitFile } from '../../src/report-gate.ts'

const RUNTIME_CASES = [
  'completes three real rounds with streamed deltas, gate admission and terminal states',
  'cancels mid-stream at the real source, refuses duplicate cancels and admits no old-round text afterwards',
  'keeps thinking and tool-call deltas out of the playback path',
  'quarantines a crashed worker, settles the turn FAILED and rebuilds only on reopen',
  'bounds a hung whenIdle: the stop verification times out, the worker quarantines and no deadlock follows',
  'records content-free structured audit evidence only',
]
const SECURITY_CASES = [
  'refuses an unmounted tool request fail-closed and keeps the physical canary untouched',
  'mounts only the minimal bridge profile allowlist with loopback-only egress',
  'refuses to run without the piped-stdio child probe (a SKIP is never acceptable evidence)',
]
const GATE_CASES = [
  'accepts a conforming report with every required scenario executed',
  'blocks a report carrying a skipped test',
  'blocks a report missing a required scenario or drifting from the baseline',
]

function escapeXml(name: string): string {
  return name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

interface ReportOptions {
  skippedCase?: string
  failedCase?: string
  dropCase?: string
}

function buildReportXml(options: ReportOptions = {}): string {
  const suites: Array<{ name: string; file: string; cases: string[] }> = [
    { name: 'E2E-02 real DSH runtime over the voice bridge stack', file: 'tests/bridge/runtime.e2e.spec.ts', cases: RUNTIME_CASES },
    { name: 'E2E-02 bridge profile security and negative permissions', file: 'tests/bridge/security.spec.ts', cases: SECURITY_CASES },
    { name: 'E2E-02 report gate fails closed', file: 'tests/bridge/e2e02-gate.spec.ts', cases: GATE_CASES },
  ]
  const blocks = suites.map((suite) => {
    const cases = suite.cases
      .filter((name) => name !== options.dropCase)
      .map((name) => {
        if (name === options.skippedCase) {
          return `    <testcase name="${escapeXml(name)}" classname="${suite.name}" file="poc/dsh-child/${suite.file}" time="0.01"><skipped message="probe"/></testcase>`
        }
        if (name === options.failedCase) {
          return `    <testcase name="${escapeXml(name)}" classname="${suite.name}" file="poc/dsh-child/${suite.file}" time="0.01"><failure message="boom">x</failure></testcase>`
        }
        return `    <testcase name="${escapeXml(name)}" classname="${suite.name}" file="poc/dsh-child/${suite.file}" time="0.01"/>`
      })
    const skipped = cases.filter((row) => row.includes('<skipped')).length
    const failures = cases.filter((row) => row.includes('<failure')).length
    return [
      `  <testsuite name="${escapeXml(suite.name)}" tests="${cases.length}" failures="${failures}" errors="0" skipped="${skipped}">`,
      ...cases,
      '  </testsuite>',
    ].join('\n')
  })
  return `<testsuites>\n${blocks.join('\n')}\n</testsuites>\n`
}

describe('E2E-02 report gate fails closed', () => {
  let scratch: string | undefined

  afterEach(async () => {
    if (scratch !== undefined) {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
      scratch = undefined
    }
  })

  async function reportPath(name: string, xml: string): Promise<string> {
    scratch = await mkdtemp(join(tmpdir(), 'lumithink-e2e02-gate-'))
    const path = join(scratch, name)
    await writeFile(path, xml, 'utf8')
    return path
  }

  it('accepts a conforming report with every required scenario executed', async () => {
    const path = await reportPath('conforming.xml', buildReportXml())
    // Mirror the real CI flow: run → summarize (stamps the contract) → check.
    summarizeJUnitFile(path)
    const result = evaluateReportFromDisk(path)
    assert.equal(result.counts.tests, E2E02_BASELINE.tests)
    assert.equal(result.counts.suites, E2E02_BASELINE.suites)
    assert.equal(result.requiredExecuted.length, E2E02_REQUIRED_TESTS.length)
    // The CLI exit-code path agrees with the evaluator.
    assert.equal(gateMain(['check', path]), 0)
  })

  it('blocks a report carrying a skipped test', async () => {
    const path = await reportPath('skipped.xml', buildReportXml({ skippedCase: GATE_CASES[0] ?? '' }))
    summarizeJUnitFile(path)
    assert.throws(() => evaluateReportFromDisk(path), /skipped must be 0/)
  })

  it('blocks a report missing a required scenario or drifting from the baseline', async () => {
    const dropped = E2E02_REQUIRED_TESTS[2]?.name ?? ''
    const missing = await reportPath('missing.xml', buildReportXml({ dropCase: dropped }))
    summarizeJUnitFile(missing)
    assert.throws(() => evaluateReportFromDisk(missing), /baseline mismatch|required test missing/)
    // A summary that disagrees with its own rows is untrustworthy: the
    // summarizer stamps the contract, then a hand-edited count must block.
    const stamped = await reportPath('stamped.xml', buildReportXml())
    summarizeJUnitFile(stamped)
    const raw = await readFile(stamped, 'utf8')
    await writeFile(stamped, raw.replace('<!-- tests 12 -->', '<!-- tests 11 -->'), 'utf8')
    assert.throws(() => evaluateReportFromDisk(stamped), /baseline mismatch/)
  })
})
