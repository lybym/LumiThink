/**
 * Fail-closed proof for the R0 acceptance gate itself.
 *
 * A gate that cannot be shown to BLOCK is not a gate. These tests drive the
 * real reports/r0-01-acceptance.xml (the frozen run whose path CI consumes)
 * and then mutate it into every unsafe shape: missing, empty, unparseable,
 * truncated, under-counted, over-counted, skipped, failed, errored, and with
 * a required test absent or skipped. Every one of those must throw.
 *
 * The expected contract values are derived from the baseline report *as
 * loaded*, not hardcoded: when the suite itself is failing, the gate must
 * still block, with the reason that matters, instead of degrading into a
 * confusing arithmetic error.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  R0_BASELINE,
  R0_REQUIRED_TESTS,
  REPORT_CONTRACT_VERSION,
  ReportGateError,
  evaluateJUnitReport,
  evaluateJUnitReportFile,
  summarizeJUnit,
} from '../../src/report-gate.ts'

const REPORT_PATH = join(import.meta.dirname, '..', '..', 'reports', 'r0-01-acceptance.xml')

/** The loaded report and its own declared contract, for relative tampering. */
let raw: string
let declared: ReturnType<typeof summarizeJUnit>
/**
 * A normalized copy of the loaded report whose declared counts match the rows
 * it carries and whose outcomes are all clean. On a green run this equals the
 * loaded report; on a red run it lets the tamper tests still prove that the
 * *specific* rule under test fires, rather than tripping over the pre-existing
 * failure the gate correctly reports first.
 */
let cleanBaseline: string

/** Append or replace one `testsuites`-level summary comment. */
function setSummary(report: string, key: string, value: number): string {
  const pattern = new RegExp(`<!--\\s*${key}\\s+-?\\d+\\s*-->`)
  const replacement = `<!-- ${key} ${value} -->`
  if (pattern.test(report)) return report.replace(pattern, replacement)
  // A loaded report may omit a summary line (for example `cancelled`); append
  // it so the tampering targets the value the gate reads.
  return report.replace('</testsuites>', `\t${replacement}\n</testsuites>`)
}

/**
 * Neutralize the outcomes that would otherwise mask the tamper under test:
 * a failing baseline report must not stop the gate from reporting skip,
 * error, suite or cancellation tampering.
 */
function neutralizeOutcomes(report: string): string {
  let next = report
  next = next.replace(/<failure\b[^>]*>[\s\S]*?<\/failure>/g, '')
  next = next.replace(/<failure\b[^>]*\/>/g, '')
  next = next.replace(/<error\b[^>]*>[\s\S]*?<\/error>/g, '')
  next = next.replace(/<error\b[^>]*\/>/g, '')
  next = next.replace(/<skipped\b[^>]*\/>/g, '')
  // Drop the per-case failure marker the runner leaves inside the testcase tag.
  next = next.replace(/(<testcase\b[^>]*?)\sfailure="[^"]*"/g, '$1')
  next = next.replace(/(<testsuite\b[^>]*?)\sfailures="\d+"/g, '$1 failures="0"')
  next = next.replace(/(<testsuite\b[^>]*?)\serrors="\d+"/g, '$1 errors="0"')
  return next
}

/** Make the declared contract agree with the rows actually carried. */
function syncContract(report: string): string {
  const actual = summarizeJUnit(report)
  let next = report
  next = setSummary(next, 'tests', actual.tests)
  next = setSummary(next, 'suites', actual.suites)
  next = setSummary(next, 'pass', actual.pass)
  next = setSummary(next, 'fail', actual.fail)
  next = setSummary(next, 'errors', actual.errors)
  next = setSummary(next, 'cancelled', 0)
  next = setSummary(next, 'skipped', actual.skipped)
  return next
}

/** Assert the gate blocks with a ReportGateError and return the reason. */
function blocks(report: string, expectedFragment: string, baseline: string = cleanBaseline): string {
  try {
    evaluateJUnitReport(report)
  } catch (error) {
    assert.ok(error instanceof ReportGateError, `expected ReportGateError, got ${String(error)}`)
    if (expectedFragment.length > 0) {
      assert.ok(
        error.message.includes(expectedFragment),
        `blocking reason ${JSON.stringify(error.message)} must mention ${JSON.stringify(expectedFragment)}`,
      )
    }
    return error.message
  }
  assert.fail(`the gate accepted a report it must block (baseline had ${summarizeJUnit(baseline).tests} tests)`)
}

/** Count `<testcase>` rows carried by an arbitrary suite block. */
function caseCount(suiteBlock: string): number {
  return (suiteBlock.match(/<testcase\b/g) ?? []).length
}

describe('R0 acceptance gate (fail-closed on the real JUnit report)', () => {
  let scratch: string

  before(async () => {
    assert.equal(existsSync(REPORT_PATH), true, `baseline report missing: ${REPORT_PATH} (run pnpm run test:r0:run)`)
    raw = readFileSync(REPORT_PATH, 'utf8')
    declared = summarizeJUnit(raw)
    cleanBaseline = syncContract(neutralizeOutcomes(raw))
    scratch = await mkdtemp(join(tmpdir(), 'lumithink-gate-'))
  })

  after(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  it('accepts the frozen R0 report and proves the 4 formerly-skipped tests executed', () => {
    const result = evaluateJUnitReport(raw, { reportPath: REPORT_PATH })
    assert.equal(result.counts.tests, R0_BASELINE.tests)
    assert.equal(result.counts.suites, R0_BASELINE.suites)
    assert.equal(result.counts.fail, 0)
    assert.equal(result.counts.errors, 0)
    assert.equal(result.counts.skipped, 0)
    assert.equal(result.counts.cancelled, 0)
    assert.equal(result.counts.pass, result.counts.tests)
    assert.equal(result.requiredExecuted.length, R0_REQUIRED_TESTS.length)
    for (const required of R0_REQUIRED_TESTS) {
      assert.ok(
        result.requiredExecuted.some(entry => entry.includes(required.name)),
        `required test ${required.name} must be reported as executed`,
      )
    }
  })

  it('accepts the normalized baseline so the tamper tests below are meaningful', () => {
    // If this ever stops holding, the tamper assertions would be vacuous.
    const result = evaluateJUnitReport(cleanBaseline)
    assert.equal(result.counts.tests, R0_BASELINE.tests)
    assert.equal(result.counts.skipped, 0)
    assert.equal(result.counts.fail, 0)
    assert.equal(result.counts.errors, 0)
  })

  it('blocks a missing report file', () => {
    assert.throws(
      () => evaluateJUnitReportFile(join(scratch, 'does-not-exist.xml')),
      (error: unknown) => error instanceof ReportGateError && error.message.includes('could not be read'),
    )
  })

  it('blocks an empty report file', async () => {
    const emptyPath = join(scratch, 'empty.xml')
    await writeFile(emptyPath, '', 'utf8')
    assert.throws(
      () => evaluateJUnitReportFile(emptyPath),
      (error: unknown) => error instanceof ReportGateError && error.message.includes('empty'),
    )
  })

  it('blocks a whitespace-only report body', () => {
    blocks('   \n\t  \n', 'empty')
  })

  it('blocks an unparseable report with no testsuite', () => {
    blocks('<html><body>the test runner crashed before emitting a report</body></html>', 'no <testsuite> element')
  })

  it('blocks a report with testsuites but no executed testcase', () => {
    blocks(
      `<?xml version="1.0"?>\n<testsuites>\n<testsuite name="R0" tests="0" failures="0" errors="0" skipped="0"></testsuite>\n<!-- r0-contract-version ${REPORT_CONTRACT_VERSION} -->\n<!-- tests 0 -->\n<!-- suites 1 -->\n<!-- pass 0 -->\n<!-- fail 0 -->\n<!-- errors 0 -->\n<!-- cancelled 0 -->\n<!-- skipped 0 -->\n</testsuites>\n`,
      'no <testcase> element',
    )
  })

  it('blocks a truncated report that lost its summary contract', () => {
    blocks(raw.slice(0, Math.floor(raw.length / 2)), 'missing')
  })

  it('blocks a report whose contract version is unknown', () => {
    blocks(setSummary(raw, 'r0-contract-version', REPORT_CONTRACT_VERSION + 1), 'unsupported r0-contract-version')
  })

  it('blocks a report that declares a different test count than the rows it carries', () => {
    const reason = blocks(setSummary(cleanBaseline, 'tests', declared.tests - 1), '')
    assert.ok(reason.includes('declared tests=') || reason.includes('baseline mismatch'), reason)
  })

  it('blocks a report that declares a different pass count than it carries', () => {
    const reason = blocks(setSummary(cleanBaseline, 'pass', declared.pass - 1), '')
    assert.ok(reason.includes('pass=') || reason.includes('skipped'), reason)
  })

  it('blocks a baseline mismatch even when the report is internally consistent', () => {
    let tampered = setSummary(cleanBaseline, 'tests', declared.tests - R0_REQUIRED_TESTS.length)
    tampered = setSummary(tampered, 'pass', declared.pass - R0_REQUIRED_TESTS.length)
    // Drop the formerly-skipped cases entirely: an internally consistent
    // report that simply never ran them must still block.
    for (const required of R0_REQUIRED_TESTS) {
      tampered = tampered.replace(new RegExp(`<testcase[^>]*name="${escapeRegExp(required.name)}"[^>]*/>`), '')
    }
    tampered = tampered.replace(/<testsuite name="R0-01 SDK contract[^>]*>[\s\S]*?<\/testsuite>\n?/, '')
    tampered = tampered.replace(/<testsuite name="model cannot invoke unmounted tools"[^>]*>[\s\S]*?<\/testsuite>\n?/, '')
    tampered = setSummary(tampered, 'suites', declared.suites - 2)
    const reason = blocks(tampered, 'baseline mismatch')
    assert.ok(reason.includes('baseline mismatch'), reason)
  })

  it('blocks a report that declares a skipped test', () => {
    let tampered = setSummary(cleanBaseline, 'skipped', 1)
    tampered = setSummary(tampered, 'pass', declared.pass - 1)
    tampered = tampered.replace(
      '<testcase name="refuses further runs after close() and leaves no running subprocess"',
      '<testcase skipped="1" name="refuses further runs after close() and leaves no running subprocess"',
    )
    assert.notEqual(tampered, cleanBaseline, 'the tamper target must exist in the report')
    const reason = blocks(tampered, 'skipped must be 0')
    assert.ok(reason.includes('skipped must be 0'), reason)
  })

  it('blocks a non-zero suite skipped attribute even without a <skipped> element', () => {
    let tampered = setSummary(cleanBaseline, 'skipped', 1)
    tampered = setSummary(tampered, 'pass', declared.pass - 1)
    const suiteOpening = /<testsuite name="R0-01 SDK contract over the lumithink-child profile"[^>]*skipped="0"/
    const match = tampered.match(suiteOpening)
    assert.ok(match !== null, 'the suite tamper target must exist in the report')
    tampered = tampered.replace(suiteOpening, match[0].replace('skipped="0"', 'skipped="1"'))
    assert.ok(tampered.includes('skipped="1"'), 'the tampered suite must carry skipped="1"')
    const reason = blocks(tampered, 'skipped must be 0')
    assert.ok(reason.includes('skipped must be 0'), reason)
  })

  it('blocks a declared failure count', () => {
    blocks(setSummary(cleanBaseline, 'fail', 1), 'failures must be 0')
  })

  it('blocks a declared error count', () => {
    blocks(setSummary(cleanBaseline, 'errors', 1), 'errors must be 0')
  })

  it('blocks a case-level <failure> child that the summary under-reports', () => {
    const target = /<testcase name="opts the child out of telemetry"[^>]*\/>/
    const match = cleanBaseline.match(target)
    assert.ok(match !== null, 'the tamper target must exist in the report')
    const tampered = cleanBaseline.replace(
      target,
      '<testcase name="opts the child out of telemetry" classname="isolated child environment" file="tests/privacy/child-env.spec.ts"><failure message="boom">boom</failure></testcase>',
    )
    const reason = blocks(tampered, '')
    assert.ok(reason.includes('failures must be 0') || reason.includes('inconsistent failure evidence'), reason)
  })

  it('blocks when a required test is missing from the report', () => {
    let tampered = setSummary(cleanBaseline, 'tests', declared.tests - 1)
    tampered = setSummary(tampered, 'pass', declared.pass - 1)
    tampered = tampered.replace(
      /<testcase name="routes every model request to the local synthetic mock only"[^>]*\/>\n?/,
      '',
    )
    assert.notEqual(tampered, cleanBaseline, 'the tamper target must exist in the report')
    const reason = blocks(tampered, '')
    assert.ok(reason.includes('required test missing') || reason.includes('baseline mismatch'), reason)
  })

  it('blocks when a required test case is marked skipped in place', () => {
    let tampered = setSummary(cleanBaseline, 'skipped', 1)
    tampered = setSummary(tampered, 'pass', declared.pass - 1)
    tampered = tampered.replace(
      '<testcase name="fails closed when the model requests the unmounted bash tool"',
      '<testcase skipped="1" name="fails closed when the model requests the unmounted bash tool"',
    )
    assert.notEqual(tampered, cleanBaseline, 'the tamper target must exist in the report')
    const reason = blocks(tampered, 'skipped must be 0')
    assert.ok(reason.includes('skipped must be 0'), reason)
  })

  it('blocks a required test that carries a <skipped> child', () => {
    let tampered = setSummary(cleanBaseline, 'skipped', 1)
    tampered = setSummary(tampered, 'pass', declared.pass - 1)
    tampered = tampered.replace(
      /<testcase name="completes synthetic multi-turn text with streamed events"[^>]*\/>/,
      '<testcase name="completes synthetic multi-turn text with streamed events" classname="R0-01 SDK contract over the lumithink-child profile" file="tests/contracts/sdk.e2e.spec.ts"><skipped/></testcase>',
    )
    assert.notEqual(tampered, cleanBaseline, 'the tamper target must exist in the report')
    const reason = blocks(tampered, 'skipped must be 0')
    assert.ok(reason.includes('skipped must be 0'), reason)
  })

  it('blocks a report whose declared suite count does not match its suites', () => {
    const tampered = setSummary(cleanBaseline, 'suites', declared.suites - 1)
    const reason = blocks(tampered, '')
    assert.ok(reason.includes('declared suites=') || reason.includes('baseline mismatch'), reason)
  })

  it('blocks an extra suite case that the declared baseline does not account for', () => {
    const firstSuite = cleanBaseline.match(/<testsuite\b[\s\S]*?<\/testsuite>/)?.[0]
    assert.ok(firstSuite !== undefined, 'the report must carry at least one suite')
    const extraCases = caseCount(firstSuite)
    assert.ok(extraCases > 0, 'the duplicated suite must carry test cases')
    const extraSuite = firstSuite.replace(/name="[^"]*"/, 'name="synthetic padding suite"')
    // Keep the report internally consistent (declared == observed) so the only
    // thing wrong with it is that it exceeds the R0 baseline.
    const tampered = cleanBaseline
      .replace('</testsuites>', `${extraSuite}\n</testsuites>`)
      .replace(/<!--\s*tests\s+\d+\s*-->/, `<!-- tests ${declared.tests + extraCases} -->`)
      .replace(/<!--\s*suites\s+\d+\s*-->/, `<!-- suites ${declared.suites + 1} -->`)
      .replace(/<!--\s*pass\s+\d+\s*-->/, `<!-- pass ${declared.pass + extraCases} -->`)
    const reason = blocks(tampered, 'baseline mismatch')
    assert.ok(reason.includes('baseline mismatch'), reason)
  })

  it('blocks a cancelled run', () => {
    const tampered = setSummary(cleanBaseline, 'cancelled', 1)
    const reason = blocks(tampered, 'cancelled must be 0')
    assert.ok(reason.includes('cancelled must be 0'), reason)
  })
})

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}