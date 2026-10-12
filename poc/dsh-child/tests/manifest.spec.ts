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
  packages: Record<string, string>
  profile: { name: string; bundles: unknown[]; patchFile: string }
  lockfile: string
  nodeEngines: string
  verifiedNode: string
  platform: string
  syntheticOnly: boolean
}

describe('runtime manifest matches the installed world', () => {
  const pocRoot = join(import.meta.dirname, '..')
  const manifestPath = join(pocRoot, 'runtime-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RuntimeManifest

  it('pins the exact verified DSH versions', () => {
    assert.equal(manifest.dshTag, 'dsh-v0.2.0-rc.2')
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
    const major = Number(process.version.slice(1).split('.')[0])
    const required = Number(manifest.nodeEngines.replace('>=', ''))
    assert.ok(major >= required, `node ${process.version} does not satisfy ${manifest.nodeEngines}`)
    assert.equal(manifest.syntheticOnly, true)
    assert.equal(manifest.issueUrl, 'https://github.com/lybym/LumiThink/issues/6')
  })
})
