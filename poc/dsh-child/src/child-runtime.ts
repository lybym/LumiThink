/**
 * Launch helper for the isolated `lumithink-child` runtime.
 *
 * Wires together everything the R0-01 PoC validates:
 *  - the pinned SDK client (`@deepseek-ai/dsh-sdk-client`, same version as the
 *    runtime via its own dependency resolution),
 *  - the custom explicit profile `lumithink-child` (no official sdk / sdk-minimal /
 *    web profile is ever booted),
 *  - an isolated `DSH_HOME` under the PoC work directory,
 *  - a fully scrubbed child environment with the synthetic model route.
 */
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildChildEnv } from './child-env.ts'
import type { MockMessagesServer } from './mock-model.ts'

/** Where all PoC runtime state lives (never the developer's real home). */
export function pocWorkDir(): string {
  return join(import.meta.dirname, '..', '.r0')
}

/** The isolated Harness home path for the PoC. */
export function isolatedDshHome(): string {
  return join(pocWorkDir(), 'dsh-home')
}

/**
 * Materialize the committed `lumithink-child` profile files into a DSH home
 * (the profile directory as DSH resolves it: `$DSH_HOME/profiles/<name>`).
 *
 * Callers MUST await this before spawning the runtime: the child resolves its
 * profile from disk at boot, and an unmaterialized home fails with
 * `profile "lumithink-child" does not exist`.
 */
export async function materializeProfileInto(dshHome: string): Promise<string> {
  const profileDir = join(dshHome, 'profiles', 'lumithink-child')
  await mkdir(profileDir, { recursive: true })
  const source = join(import.meta.dirname, '..', 'profiles', 'lumithink-child')
  const { copyFile } = await import('node:fs/promises')
  await copyFile(join(source, 'package.json'), join(profileDir, 'package.json'))
  await copyFile(join(source, 'cordis.patch.yml'), join(profileDir, 'cordis.patch.yml'))
  return profileDir
}

/** Materialize the profile into the PoC's default isolated home. */
export function materializeProfileIntoHome(): Promise<string> {
  return materializeProfileInto(isolatedDshHome())
}

export interface StartedChild {
  harness: DeepSeekHarness
  dshHome: string
  mockBaseUrl: string
}

/**
 * Create a `DeepSeekHarness` bound to the isolated profile and home.
 *
 * The subprocess starts lazily on first `run()`; always `close()` (or
 * `await using`) so the child is reaped.
 */
export async function startChildHarness(options: {
  mock: MockMessagesServer
  /** Fresh temp DSH_HOME per start (default) or the shared isolated home. */
  sharedHome?: boolean
  provider?: string
  model?: string
}): Promise<StartedChild> {
  const mockBaseUrl = await options.mock.listen()
  const dshHome = options.sharedHome === true
    ? isolatedDshHome()
    : await mkdtemp(join(tmpdir(), 'lumithink-child-home-'))
  await materializeProfileInto(dshHome)
  const harness = new DeepSeekHarness({
    profile: 'lumithink-child',
    dshHome,
    env: buildChildEnv({ dshHome, mockBaseUrl }),
    provider: options.provider ?? 'deepseek-official',
    model: options.model ?? 'deepseek-v4-flash',
    initializeTimeoutMs: 60_000,
  })
  return { harness, dshHome, mockBaseUrl }
}

/** Remove one temporary DSH_HOME created by {@link startChildHarness}. */
export async function disposeTempHome(dshHome: string): Promise<void> {
  if (dshHome.startsWith(tmpdir())) {
    await rm(dshHome, { recursive: true, force: true })
  }
}
