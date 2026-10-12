/**
 * `dsh --profile lumithink-child --dump-config` runner and parser.
 *
 * The dump prints the composed profile tree (the effective configuration the
 * runtime would mount) without booting. The security tests assert against
 * this composed tree — never against source declarations — so a drifted
 * profile fails loudly even if the YAML reads correctly.
 */
import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'
import { buildChildEnv } from './child-env.ts'
import { isolatedDshHome, materializeProfileInto } from './child-runtime.ts'

/** The dump renders DSH's custom `!!js` config expressions verbatim; parse them as literal strings. */
const jsExpressionTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: (value: string) => value,
})
const dumpSchema = (yaml.DEFAULT_SCHEMA as yaml.Schema).extend([jsExpressionTag])

/** One composed profile entry row from the dump. */
export interface DumpEntry {
  id?: string
  name?: string
  disabled?: boolean | string
  inject?: string[]
  config?: Record<string, unknown>
}

export interface DumpResult {
  /** Raw dump text (with `# ==` source annotations). */
  raw: string
  entries: DumpEntry[]
}

/**
 * Resolve the pinned dsh CLI executable through the PoC's own dependency
 * graph (the SDK client resolves the same-version package the same way).
 */
export function resolveDshBin(): string {
  const req = createRequire(import.meta.url)
  const manifestPath = resolvePocPackageManifest(req, '@deepseek-ai/dsh')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    version: string
    bin?: Record<string, string> | string
  }
  if (manifest.version !== '0.2.0-rc.2') {
    throw new Error(`@deepseek-ai/dsh resolved to ${manifest.version}; the R0-01 pin is 0.2.0-rc.2`)
  }
  const binSpec = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
  if (binSpec === undefined) throw new Error('@deepseek-ai/dsh manifest declares no bin')
  return join(dirname(manifestPath), binSpec)
}

/** Locate an installed package's manifest, tolerating exports maps without `./package.json`. */
function resolvePocPackageManifest(req: NodeRequire, packageName: string): string {
  try {
    return req.resolve(`${packageName}/package.json`)
  } catch {
    const mainPath = req.resolve(packageName).replace(/\\/g, '/')
    const marker = `/node_modules/${packageName}/`
    const at = mainPath.lastIndexOf(marker)
    if (at < 0) throw new Error(`cannot locate installed package manifest for ${packageName}`)
    return mainPath.slice(0, at) + marker + packageName + '/package.json'
  }
}

/**
 * Run the dump for the isolated lumithink-child profile and parse the rows.
 *
 * The profile is fully materialized into the exact home the child uses
 * BEFORE the spawn below: `spawnSync` blocks the event loop, so any pending
 * asynchronous continuation cannot run until after the child has exited. On
 * a clean environment (fresh clone / CI, where `.r0/` is gitignored and
 * absent) an unawaited materialization leaves the home empty and the child
 * fails with `profile "lumithink-child" does not exist`.
 *
 * Output is captured through file-descriptor redirection (`stdio: ['ignore',
 * fd, fd]`), which works in every environment — including confined sandboxes
 * where piped child stdio is unavailable.
 */
export async function dumpProfileConfig(options: { dshHome?: string } = {}): Promise<DumpResult> {
  const dshHome = options.dshHome ?? isolatedDshHome()
  await materializeProfileInto(dshHome)
  const bin = resolveDshBin()
  const scratch = mkdtempSync(join(tmpdir(), 'lumithink-dump-'))
  const outPath = join(scratch, 'dump.txt')
  const errPath = join(scratch, 'err.txt')
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  try {
    const result = spawnSync(process.execPath, [bin, '--profile', 'lumithink-child', '--dump-config'], {
      cwd: import.meta.dirname,
      env: { ...buildChildEnv({ dshHome, mockBaseUrl: 'http://127.0.0.1:9' }) },
      stdio: ['ignore', outFd, errFd],
      timeout: 120_000,
    })
    const stderr = readFileSync(errPath, 'utf8')
    if (result.error !== undefined) {
      throw new Error(`--dump-config could not spawn: ${String(result.error)}`)
    }
    if (result.status !== 0) {
      throw new Error(`--dump-config failed (${result.status}): ${stderr.slice(0, 4000)}`)
    }
    const raw = readFileSync(outPath, 'utf8')
    const parsed = yaml.load(raw, { schema: dumpSchema }) as DumpEntry[] | { insert?: DumpEntry[] }
    const entries = Array.isArray(parsed) ? parsed : (parsed.insert ?? [])
    return { raw, entries }
  } finally {
    closeSync(outFd)
    closeSync(errFd)
    try {
      unlinkSync(outPath)
      unlinkSync(errPath)
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      /* scratch cleanup is best-effort */
    }
  }
}

/** Version of an installed package, resolved from the PoC's dependency graph. */
export function installedPackageVersion(packageName: string): string {
  const req = createRequire(import.meta.url)
  const manifest = JSON.parse(readFileSync(resolvePocPackageManifest(req, packageName), 'utf8')) as { version: string }
  return manifest.version
}

/**
 * Whether this environment allows child processes with piped stdio.
 *
 * The DeepSeek Harness execution sandbox forbids named pipes for spawned
 * processes, which blocks the SDK's stdio JSON-RPC transport. This probe lets
 * the runtime e2e tests skip with an explicit environmental reason instead of
 * failing spuriously; in a normal shell or CI the tests always run.
 */
export function canSpawnPipedChild(): boolean {
  const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 15_000,
  })
  return probe.error === undefined && probe.status === 0
}
