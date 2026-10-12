/**
 * Reproducible-baseline test: the committed runtime manifest must match the
 * actually installed packages. This is the probe CI can rerun to prove the
 * DSH version pin never drifted (R0-A "版本和运行时探测命令，CI 能复现").
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { installedPackageVersion } from '../src/dump-config.ts'

interface RuntimeManifest {
  issueUrl: string
  dshTag: string
  commitSha: string
  packages: Record<string, string>
  profile: { name: string; bundles: unknown[]; patchFile: string }
  lockfile: string
  nodeEngines: string
  verifiedNode: string
  verifiedPnpm: string
  platform: string
  syntheticOnly: boolean
}

/** True when `version` (x.y.z) is at least `minimum` (x.y.z), comparing component-wise. */
function satisfiesMinimum(version: string, minimum: string): boolean {
  const have = version.split('.').map(Number)
  const need = minimum.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const current = have[i] ?? 0
    const required = need[i] ?? 0
    if (current !== required) return current > required
  }
  return true
}

/** True when `version` satisfies an `x.y.z`-style Node range (`24.x`, `>=22.6.0`, `24.21.0`). */
function satisfiesNodeRange(version: string, range: string): boolean {
  if (range.startsWith('>=')) return satisfiesMinimum(version, range.slice(2))
  const parts = range.split('.')
  if (parts.length === 1) return version.split('.')[0] === parts[0]
  if (parts[1] === 'x') return version.split('.')[0] === parts[0]
  return satisfiesMinimum(version, range) && satisfiesMinimum(range, version)
}

describe('runtime manifest matches the installed world', () => {
  const pocRoot = join(import.meta.dirname, '..')
  const manifestPath = join(pocRoot, 'runtime-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RuntimeManifest

  it('pins the exact verified DSH versions', () => {
    assert.equal(manifest.dshTag, 'dsh-v0.2.0-rc.2')
    assert.match(manifest.commitSha, /^[0-9a-f]{40}$/, 'upstream provenance must pin a full 40-hex git commit SHA')
    for (const [name, version] of Object.entries(manifest.packages)) {
      assert.equal(installedPackageVersion(name), version, `${name} drifted from the manifest`)
    }
    assert.equal(manifest.packages['@deepseek-ai/dsh'], '0.2.0-rc.2')
    assert.equal(manifest.packages['@deepseek-ai/dsh-sdk-client'], '0.2.0-rc.2')
    assert.equal(manifest.packages['@deepseek-ai/dsh-subprocess'], '0.2.0-rc.2')
  })

  it('declares a zero-bundle explicit profile backed by a committed lockfile', () => {
    assert.equal(manifest.profile.name, 'lumithink-child')
    assert.deepEqual(manifest.profile.bundles, [])
    assert.equal(existsSync(join(pocRoot, manifest.lockfile)), true)
    assert.equal(existsSync(join(pocRoot, manifest.profile.patchFile)), true)
  })

  it('runs on a compliant Node and never touches real data', () => {
    // Type stripping (--experimental-strip-types) requires Node >= 22.6.0;
    // the manifest must agree with package.json engines.node exactly, and the
    // comparison must cover minor/patch too (Node 22.0–22.5 cannot run the suite).
    const pkg = JSON.parse(readFileSync(join(pocRoot, 'package.json'), 'utf8')) as { engines?: { node?: string } }
    assert.equal(pkg.engines?.node, manifest.nodeEngines, 'manifest nodeEngines must match package.json engines.node')
    assert.equal(manifest.nodeEngines, '24.x')
    assert.ok(
      satisfiesNodeRange(process.version.slice(1), manifest.nodeEngines),
      `node ${process.version} does not satisfy ${manifest.nodeEngines}`,
    )
    assert.equal(manifest.syntheticOnly, true)
    assert.equal(manifest.issueUrl, 'https://github.com/lybym/LumiThink/issues/6')
  })

  it('pins the exact Node and pnpm builds the R0 evidence was produced with', () => {
    // Reproducibility (Issue #8 AC-A/AC-D): the local evidence and CI must use
    // a fixed Node build and a pnpm 10 line. pnpm 11 rewrites lockfile/install
    // semantics, so the toolchain version is part of the pinned baseline.
    assert.equal(manifest.verifiedNode, 'v24.21.0')
    assert.equal(manifest.verifiedPnpm, '10.34.7')
    assert.match(manifest.verifiedPnpm, /^10\./, 'the R0-02 baseline is the pnpm 10 line')
    assert.ok(
      satisfiesNodeRange(process.version.slice(1), manifest.verifiedNode.slice(1)),
      `the recorded evidence Node ${manifest.verifiedNode} must be the Node actually running the suite (saw ${process.version})`,
    )
  })
})
