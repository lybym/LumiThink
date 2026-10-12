/**
 * Child-process environment policy for the isolated `lumithink-child` runtime.
 *
 * The SDK client replaces the child environment entirely when `env` is given,
 * so this module owns the credential policy: start from the shared upstream
 * scrubber, keep only the entries a headless runtime needs on this OS, and add
 * the PoC-specific synthetic settings (mock model route, telemetry opt-out,
 * throwaway API key). The developer's real `~/.dsh`, credentials, and shell
 * configuration are never forwarded.
 */
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { isAbsolute, join } from 'node:path'

/** Absolute path of the PoC package directory (this file's grandparent). */
export function pocRoot(): string {
  return resolve('..', import.meta.dirname)
}

function resolve(base: string, from: string | undefined): string {
  if (from === undefined) return base
  return isAbsolute(from) ? from : join(base, from)
}

/** Knobs the runtime child needs for one synthetic session. */
export interface ChildEnvOptions {
  /** Absolute isolated Harness home (`DSH_HOME` for the child). */
  dshHome: string
  /** Loopback base URL of the local synthetic Messages mock. */
  mockBaseUrl: string
}

/** Environment variables deliberately kept for a headless child runtime. */
const KEEP_PREFIXES = ['SystemRoot', 'windir', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']

/**
 * Build the complete child environment.
 *
 * Returns a frozen plain object: `scrubbedParentEnv()` provides the upstream
 * credential scrubbing, we re-project only OS plumbing variables, and every
 * PoC knob is pinned to synthetic values.
 */
export function buildChildEnv(options: ChildEnvOptions): NodeJS.ProcessEnv {
  const scrubbed = scrubbedParentEnv()
  const kept: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(scrubbed)) {
    if (value === undefined) continue
    if (KEEP_PREFIXES.some(prefix => key.toUpperCase().startsWith(prefix.toUpperCase()))) {
      kept[key] = value
    }
  }
  // Windows keeps loading crypto/WSL bits without SystemRoot; keep PATH minimal
  // but non-empty so the child can resolve system DLLs.
  kept.PATH = process.env.PATH ?? ''
  return Object.freeze({
    ...kept,
    DSH_HOME: options.dshHome,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_POC_MOCK_BASE_URL: options.mockBaseUrl,
    DEEPSEEK_API_KEY: 'dsh-poc-synthetic-key',
    DSH_NO_COLOR: '1',
  })
}
