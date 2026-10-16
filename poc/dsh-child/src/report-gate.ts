/**
 * Fail-closed acceptance gate for the R0 Node test JUnit report.
 *
 * The R0-02 merge gate is not "did the test command exit 0?" — it is the
 * machine-readable report. A run can be green while silently skipping the
 * four high-value E2E/negative-permission tests (that is exactly how the
 * R0-01 gap happened), or an artifact can be missing, empty, truncated, or
 * unparseable. Every one of those states must BLOCK, never pass.
 *
 * The gate also owns the report *contract*: the Node test runner's JUnit
 * output carries no machine-readable baseline, so {@link summarizeJUnitFile}
 * derives `<!-- tests N -->`, `<!-- skipped N -->`, `<!-- r0-contract-version
 * 1 -->`, … from the parsed rows and replaces the runner's informational
 * trailing summary. The contract therefore cannot disagree with the evidence,
 * and a downstream reader cannot be fooled by two competing summaries.
 *
 * Contract (all violations throw {@link ReportGateError}):
 *   1. the report file exists and is non-empty;
 *   2. it declares the exact JUnit contract version this gate understands;
 *   3. it parses into at least one `<testsuite>` with at least one `<testcase>`;
 *   4. every count the gate observes matches the declared baseline;
 *   5. `failures`, `errors` and `skipped` are all exactly 0;
 *   6. every required (formerly-skipped) test is present AND executed —
 *      a `<skipped>`/`<error>`/`<failure>` child on a required test is a block,
 *      and `skipped="1"` (or any non-zero skip attribute) on its suite or case
 *      is a block even when no `<skipped>` element is emitted;
 *   7. the parsed counts are internally consistent with the emitted rows.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs'

/** The JUnit report contract revision this gate understands. */
export const REPORT_CONTRACT_VERSION = 1

/** Exact baseline the R0 acceptance suite must produce (updated only with the suite). */
export const R0_BASELINE = {
  /** Total `<testcase>` rows in the R0 acceptance suite (phase 1). */
  tests: 37,
  /** Suites in the R0 acceptance report. */
  suites: 8,
  /** Exact `skipped` count. Never allowed to be anything but 0. */
  skipped: 0,
  /** Exact `failures` count. */
  failures: 0,
  /** Exact `errors` count. */
  errors: 0,
} as const

/**
 * Tests that were SKIPped in the confined R0-01 sandbox. Each must be present
 * and must have actually executed (no `<skipped>`, no non-`0` skip attribute).
 */
export const R0_REQUIRED_TESTS: ReadonlyArray<{ file: string; name: string }> = [
  { file: 'tests/contracts/sdk.e2e.spec.ts', name: 'completes synthetic multi-turn text with streamed events' },
  { file: 'tests/contracts/sdk.e2e.spec.ts', name: 'refuses further runs after close() and leaves no running subprocess' },
  { file: 'tests/contracts/sdk.e2e.spec.ts', name: 'routes every model request to the local synthetic mock only' },
  { file: 'tests/security/negative-tool.spec.ts', name: 'fails closed when the model requests the unmounted bash tool' },
]

/** A blocked gate. The message is the human-readable blocking reason. */
export class ReportGateError extends Error {
  override readonly name = 'ReportGateError'
}

export interface ReportCounts {
  tests: number
  suites: number
  pass: number
  /** Test-runner `fail` summary (same value as {@link failures}). */
  fail: number
  /** Sum of the per-suite `failures` attributes. */
  failures: number
  errors: number
  cancelled: number
  skipped: number
}

export interface ReportCase {
  /** Suite the case belongs to. */
  suite: string
  name: string
  /** `file` attribute, normalized to forward slashes (relative or absolute). */
  file: string
  /** `skipped` attribute of the case (undefined when absent). */
  skippedAttribute?: string
  /** Child elements present on the case. */
  children: string[]
}

export interface ReportGateResult {
  counts: ReportCounts
  cases: ReportCase[]
  /** Required tests that were found and proven executed. */
  requiredExecuted: string[]
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&')
}

function attributesOf(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(tag)) !== null) {
    attributes[match[1]!] = decodeEntities(match[2]!)
  }
  return attributes
}

/** Read the gate's machine-readable contract comments from the raw report. */
function readContractComments(raw: string): Map<string, string> {
  const found = new Map<string, string>()
  const pattern = /<!--\s*([A-Za-z][A-Za-z0-9-]*)\s+(-?\d+)\s*-->/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    found.set(match[1]!, match[2]!)
  }
  return found
}

function requireInteger(map: Map<string, string>, key: string, context: string): number {
  const raw = map.get(key)
  if (raw === undefined) {
    throw new ReportGateError(`${context}: missing "${key}" summary comment in the JUnit report`)
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new ReportGateError(`${context}: "${key}" summary is not a non-negative integer (got "${raw}")`)
  }
  return value
}

/** Structural baseline shape shared by the R0 and E2E-02 report contracts. */
export interface ReportBaseline {
  readonly tests: number
  readonly suites: number
  readonly skipped: number
  readonly failures: number
  readonly errors: number
}

/**
 * Parse and validate one JUnit report against a baseline and required tests.
 *
 * Throws {@link ReportGateError} for every fail-closed condition; returns the
 * observed evidence otherwise. Callers must treat a throw as a blocked gate.
 */
export function evaluateJUnitReportForBaseline(
  raw: string,
  baseline: ReportBaseline,
  requiredTests: ReadonlyArray<{ file: string; name: string }>,
  options: { reportPath?: string } = {},
): ReportGateResult {
  const context = options.reportPath === undefined ? 'JUnit report' : `JUnit report ${options.reportPath}`

  if (raw.trim().length === 0) {
    throw new ReportGateError(`${context} is empty; a missing or empty report can never satisfy the gate`)
  }

  // Read the contract summary. It is validated after the structural checks so
  // an unparseable artifact blocks with "no <testsuite>/<testcase>" rather
  // than with a missing-comment error that hides the real problem.
  const comments = readContractComments(raw)

  const suiteBlocks = raw.match(/<testsuite\b[^>]*>[\s\S]*?<\/testsuite>/g)
  if (suiteBlocks === null || suiteBlocks.length === 0) {
    throw new ReportGateError(`${context}: no <testsuite> element found; the report is unparseable or incomplete`)
  }

  const cases: ReportCase[] = []
  let declaredSuiteSkipped = 0
  let declaredSuiteFailures = 0
  let declaredSuiteErrors = 0

  for (const block of suiteBlocks) {
    const opening = block.match(/<testsuite\b[^>]*>/)
    if (opening === null) throw new ReportGateError(`${context}: malformed <testsuite> opening tag`)
    const suiteAttributes = attributesOf(opening[0])
    const suiteName = suiteAttributes.name ?? '(unnamed suite)'

    for (const attribute of ['skipped', 'failures', 'errors'] as const) {
      const value = Number(suiteAttributes[attribute] ?? '0')
      if (!Number.isInteger(value) || value < 0) {
        throw new ReportGateError(`${context}: suite "${suiteName}" has a non-integer ${attribute}="${suiteAttributes[attribute]}"`)
      }
      if (attribute === 'skipped') declaredSuiteSkipped += value
      if (attribute === 'failures') declaredSuiteFailures += value
      if (attribute === 'errors') declaredSuiteErrors += value
    }

    const casePattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g
    let caseMatch: RegExpExecArray | null
    while ((caseMatch = casePattern.exec(block)) !== null) {
      const caseAttributes = attributesOf(caseMatch[1] ?? '')
      const children: string[] = []
      const inner = caseMatch[3]
      if (typeof inner === 'string' && inner.length > 0) {
        const childPattern = /<(skipped|failure|error|system-out|system-err)\b/g
        let childMatch: RegExpExecArray | null
        while ((childMatch = childPattern.exec(inner)) !== null) children.push(childMatch[1]!)
      }
      cases.push({
        suite: suiteName,
        name: caseAttributes.name ?? '(unnamed case)',
        file: (caseAttributes.file ?? '').replace(/\\/g, '/'),
        skippedAttribute: caseAttributes.skipped,
        children,
      })
    }
  }

  if (cases.length === 0) {
    throw new ReportGateError(`${context}: no <testcase> element found; the report carries no executed tests`)
  }

  const counts: ReportCounts = {
    tests: requireInteger(comments, 'tests', context),
    suites: requireInteger(comments, 'suites', context),
    pass: requireInteger(comments, 'pass', context),
    fail: requireInteger(comments, 'fail', context),
    failures: declaredSuiteFailures,
    errors: requireInteger(comments, 'errors', context),
    cancelled: requireInteger(comments, 'cancelled', context),
    skipped: requireInteger(comments, 'skipped', context),
  }

  const contractVersion = requireInteger(comments, 'r0-contract-version', context)
  if (contractVersion !== REPORT_CONTRACT_VERSION) {
    throw new ReportGateError(
      `${context}: unsupported r0-contract-version ${contractVersion}; the gate understands ${REPORT_CONTRACT_VERSION}`,
    )
  }

  const failedCases = cases.filter(item => item.children.includes('failure')).length
  const erroredCases = cases.filter(item => item.children.includes('error')).length
  const skippedCases = cases.filter(
    item => item.children.includes('skipped') || (item.skippedAttribute !== undefined && item.skippedAttribute !== '0'),
  ).length

  // The gate's hard requirements come first, so a tampered report blocks with
  // the reason that actually matters (baseline drift, skipped, failed).
  if (counts.tests !== baseline.tests) {
    throw new ReportGateError(
      `${context}: baseline mismatch — expected exactly ${baseline.tests} executed tests, observed ${counts.tests}`,
    )
  }
  if (counts.failures !== baseline.failures || counts.fail !== baseline.failures || failedCases > 0) {
    throw new ReportGateError(
      `${context}: failures must be 0 (summary fail=${counts.fail}, suites=${declaredSuiteFailures}, cases=${failedCases})`,
    )
  }
  if (counts.errors !== baseline.errors || erroredCases > 0) {
    throw new ReportGateError(`${context}: errors must be 0 (summary errors=${counts.errors}, cases=${erroredCases})`)
  }
  if (counts.skipped !== R0_BASELINE.skipped || declaredSuiteSkipped > 0 || skippedCases > 0) {
    throw new ReportGateError(
      `${context}: skipped must be 0 — a skipped test is not evidence (summary skipped=${counts.skipped}, suites=${declaredSuiteSkipped}, cases=${skippedCases})`,
    )
  }
  if (counts.cancelled !== 0) {
    throw new ReportGateError(`${context}: cancelled must be 0 (observed ${counts.cancelled})`)
  }

  // Internal consistency: the report's own summary comments must describe the
  // rows actually present. A report that disagrees with itself is
  // untrustworthy even when an individual count looks acceptable.
  if (counts.tests !== cases.length) {
    throw new ReportGateError(
      `${context}: declared tests=${counts.tests} but the report carries ${cases.length} <testcase> rows`,
    )
  }
  if (counts.suites !== suiteBlocks.length) {
    throw new ReportGateError(
      `${context}: declared suites=${counts.suites} but the report carries ${suiteBlocks.length} <testsuite> blocks`,
    )
  }
  if (failedCases !== counts.fail || failedCases !== declaredSuiteFailures) {
    throw new ReportGateError(
      `${context}: inconsistent failure evidence (summary fail=${counts.fail}, suites=${declaredSuiteFailures}, cases=${failedCases})`,
    )
  }
  if (erroredCases !== counts.errors || erroredCases !== declaredSuiteErrors) {
    throw new ReportGateError(
      `${context}: inconsistent error evidence (summary errors=${counts.errors}, suites=${declaredSuiteErrors}, cases=${erroredCases})`,
    )
  }
  if (skippedCases !== counts.skipped || declaredSuiteSkipped !== counts.skipped) {
    throw new ReportGateError(
      `${context}: inconsistent skip evidence (summary skipped=${counts.skipped}, suites=${declaredSuiteSkipped}, cases=${skippedCases})`,
    )
  }
  if (counts.pass !== counts.tests) {
    throw new ReportGateError(`${context}: pass=${counts.pass} does not account for all ${counts.tests} tests`)
  }

  const requiredExecuted: string[] = []
  for (const required of requiredTests) {
    const match = cases.find(item => item.file.endsWith(required.file) && item.name === required.name)
    if (match === undefined) {
      throw new ReportGateError(
        `${context}: required test missing — ${required.file} :: "${required.name}" did not execute`,
      )
    }
    if (match.skippedAttribute !== undefined && match.skippedAttribute !== '0') {
      throw new ReportGateError(
        `${context}: required test skipped — ${required.file} :: "${required.name}" reported skipped="${match.skippedAttribute}"`,
      )
    }
    for (const child of match.children) {
      if (child === 'skipped' || child === 'failure' || child === 'error') {
        throw new ReportGateError(
          `${context}: required test not executed cleanly — ${required.file} :: "${required.name}" carries <${child}>`,
        )
      }
    }
    requiredExecuted.push(`${required.file} :: ${required.name}`)
  }

  return { counts, cases, requiredExecuted }
}

/**
 * Evaluate a JUnit report against the R0 acceptance baseline. Kept as the
 * exact previous entry point (R0 contract unchanged); the generalized
 * {@link evaluateJUnitReportForBaseline} serves the E2E-02 report contract.
 */
export function evaluateJUnitReport(raw: string, options: { reportPath?: string } = {}): ReportGateResult {
  return evaluateJUnitReportForBaseline(raw, R0_BASELINE, R0_REQUIRED_TESTS, options)
}

/** Read the report from disk and evaluate it. Missing/empty files block. */
export function evaluateJUnitReportFile(reportPath: string): ReportGateResult {
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
  return evaluateJUnitReport(raw, { reportPath })
}

export interface JUnitSummary {
  tests: number
  suites: number
  pass: number
  fail: number
  errors: number
  skipped: number
}

/** Count suites, cases, and outcomes directly from the JUnit rows. */
export function summarizeJUnit(raw: string): JUnitSummary {
  const suiteBlocks = raw.match(/<testsuite\b[^>]*>[\s\S]*?<\/testsuite>/g) ?? []
  const casePattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g
  let tests = 0
  let pass = 0
  let fail = 0
  let errors = 0
  let skipped = 0

  for (const block of suiteBlocks) {
    casePattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = casePattern.exec(block)) !== null) {
      tests += 1
      const attributes = match[1] ?? ''
      const inner = match[3] ?? ''
      const skippedAttribute = /skipped="(\d+)"/.exec(attributes)
      if (/<skipped\b/.test(inner) || (skippedAttribute !== null && skippedAttribute[1] !== '0')) {
        skipped += 1
        continue
      }
      if (/<failure\b/.test(inner)) {
        fail += 1
        continue
      }
      if (/<error\b/.test(inner)) {
        errors += 1
        continue
      }
      pass += 1
    }
  }

  return { tests, suites: suiteBlocks.length, pass, fail, errors, skipped }
}

/** The exact contract comment block appended to a summarized report. */
export function contractCommentBlock(summary: JUnitSummary): string {
  return [
    `\t<!-- r0-contract-version ${REPORT_CONTRACT_VERSION} -->`,
    `\t<!-- tests ${summary.tests} -->`,
    `\t<!-- suites ${summary.suites} -->`,
    `\t<!-- pass ${summary.pass} -->`,
    `\t<!-- fail ${summary.fail} -->`,
    `\t<!-- errors ${summary.errors} -->`,
    '\t<!-- cancelled 0 -->',
    `\t<!-- skipped ${summary.skipped} -->`,
  ].join('\n')
}

/**
 * Remove the Node test runner's own trailing summary comments.
 *
 * The runner emits `<!-- tests N -->`, `<!-- skipped N -->`, … after the last
 * suite. Those values are informational only and would otherwise duplicate the
 * gate contract below, letting a reader (or an attacker) leave two disagreeing
 * summaries in one file. The gate reads exactly one summary: the contract this
 * function's caller writes from the parsed rows.
 */
function stripRunnerSummaryComments(raw: string): string {
  return raw
    .split('\n')
    .filter(line => !/^\s*<!--\s*(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+-?[\d.]+\s*-->\s*$/.test(line))
    .join('\n')
}

/**
 * Attach the gate contract to an on-disk JUnit report, in place.
 *
 * Throws when the report has no `<testsuites>` root, is already summarized, or
 * lost its closing tag: an unparseable artifact must block, never be silently
 * "summarized" into an empty report.
 */
export function summarizeJUnitFile(reportPath: string): JUnitSummary {
  const raw = readFileSync(reportPath, 'utf8')
  if (!/<testsuites\b/.test(raw)) {
    throw new ReportGateError(`${reportPath} has no <testsuites> root; refusing to summarize an unparseable report`)
  }
  if (/<!--\s*r0-contract-version\s/.test(raw)) {
    throw new ReportGateError(`${reportPath} already carries the R0 contract comments; refusing to summarize it twice`)
  }
  const summary = summarizeJUnit(raw)
  const stripped = stripRunnerSummaryComments(raw)
  const closingIndex = stripped.lastIndexOf('</testsuites>')
  if (closingIndex < 0) {
    throw new ReportGateError(`${reportPath} has no closing </testsuites> tag; the artifact is truncated`)
  }
  const summarized = `${stripped.slice(0, closingIndex)}${contractCommentBlock(summary)}\n${stripped.slice(closingIndex)}`
  writeFileSync(reportPath, summarized, 'utf8')
  return summary
}