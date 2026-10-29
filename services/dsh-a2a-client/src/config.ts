/**
 * P2-02 (issue #114) — client configuration, fail-closed on credentials.
 *
 * Credential rule (ADR-0018 hard constraint 1; A2A_DESIGN §13.1): the
 * credential lives in memory only — supplied either directly (string or
 * async provider) or through the environment loader below. Missing
 * credential ⇒ refuse to construct the client (fail-closed). The value is
 * never written to the ledger, never logged, and never embedded in errors.
 *
 * Environment surface (mirrors the server's LUMITHINK_A2A_* convention):
 *   LUMITHINK_A2A_CLIENT_URL            — agent base URL (required)
 *   LUMITHINK_A2A_CLIENT_TOKEN          — synthetic Bearer credential (required)
 *   LUMITHINK_A2A_CLIENT_LEDGER_PATH    — durable ledger file (required by the env loader;
 *                                         explicit-config clients may inject any TaskLedger)
 *   LUMITHINK_A2A_CLIENT_POLL_MS        — polling interval (optional, default 250)
 *   LUMITHINK_A2A_CLIENT_POLL_TIMEOUT_MS — max wait for a terminal state (optional, default 120000)
 *   LUMITHINK_A2A_CLIENT_CANCEL_TIMEOUT_MS — CancelTask response deadline (optional, default 2000 = §7.3)
 *   LUMITHINK_A2A_CLIENT_MAX_SEND_RETRIES  — finite network-failure retries (optional, default 2)
 */
import { FileTaskLedger, type TaskLedger } from './ledger.ts';
import { DshA2aClientError } from './errors.ts';

/** §7.3 initial deadline: CancelTask responses wait at most 2 seconds. */
export const CANCEL_RESPONSE_TIMEOUT_DEFAULT_MS = 2_000;

/** A credential source: static token or async provider (re-sign hook). */
export type CredentialSource = string | (() => Promise<string>);

export interface DshA2aClientConfig {
  /** Agent base URL, e.g. http://127.0.0.1:3312 (loopback in validation). */
  baseUrl: string;
  /** Bearer credential; string or async provider for expiry re-sign. */
  credential: CredentialSource;
  /**
   * Durable ledger. Either a file path (default FileTaskLedger) or a
   * caller-provided TaskLedger implementation (an embedding host with its
   * own durable storage). Required — the client never runs without a
   * durable mapping copy.
   */
  ledger: string | TaskLedger;
  /** Poll interval for the terminal-state wait loop. Default 250ms. */
  pollIntervalMs?: number;
  /** Max time the wait loop polls before surfacing poll_timeout. Default 120s. */
  pollTimeoutMs?: number;
  /** CancelTask response deadline (§7.3). Default 2000ms. */
  cancelResponseTimeoutMs?: number;
  /** Finite retries for transient network failures on the initial send. Default 2. */
  maxSendRetries?: number;
  /**
   * Optional fetch implementation injection (harness/test seam; production
   * callers leave it unset). It sits UNDER the authenticating wrapper, so
   * credential handling is never bypassed.
   */
  fetchImpl?: typeof fetch;
}

export interface ResolvedDshA2aClientConfig {
  baseUrl: string;
  credential: CredentialSource;
  ledger: TaskLedger;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  cancelResponseTimeoutMs: number;
  maxSendRetries: number;
  fetchImpl: typeof fetch;
}

function positiveInt(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new DshA2aClientError('invalid_config', `${label} must be a positive integer, got: ${raw}`);
  }
  return value;
}

function requireString(raw: string | undefined, label: string, minimumLength = 1): string {
  if (raw === undefined || raw.trim().length < minimumLength) {
    throw new DshA2aClientError(
      'credential_missing',
      `${label} is required — the DSH A2A client refuses to start without it (fail-closed).`,
    );
  }
  return raw.trim();
}

/** Resolves user config into the runtime shape with defaults. */
export function resolveDshA2aClientConfig(config: DshA2aClientConfig): ResolvedDshA2aClientConfig {
  if (typeof config.baseUrl !== 'string' || config.baseUrl.trim() === '') {
    throw new DshA2aClientError('invalid_config', 'baseUrl is required.');
  }
  if (config.credential === undefined || config.credential === null || config.credential === '') {
    throw new DshA2aClientError(
      'credential_missing',
      'A credential (token or provider) is required — the client refuses to start ' +
        'unauthenticated (fail-closed; ADR-0018 constraint 1).',
    );
  }
  if (config.ledger === undefined || config.ledger === null || config.ledger === '') {
    throw new DshA2aClientError(
      'invalid_config',
      'A durable ledger (file path or TaskLedger instance) is required — the client ' +
        'never runs without a persistent messageId/task mapping (§7.4).',
    );
  }
  return {
    baseUrl: config.baseUrl.trim(),
    credential: config.credential,
    ledger:
      typeof config.ledger === 'string' ? new FileTaskLedger(config.ledger) : config.ledger,
    pollIntervalMs: config.pollIntervalMs ?? 250,
    pollTimeoutMs: config.pollTimeoutMs ?? 120_000,
    cancelResponseTimeoutMs: config.cancelResponseTimeoutMs ?? CANCEL_RESPONSE_TIMEOUT_DEFAULT_MS,
    maxSendRetries: config.maxSendRetries ?? 2,
    fetchImpl: config.fetchImpl ?? globalThis.fetch,
  };
}

/** Environment loader: fail-closed on missing URL/token/ledger path. */
export function loadDshA2aClientConfig(env: NodeJS.ProcessEnv = process.env): DshA2aClientConfig {
  const baseUrl = requireString(env['LUMITHINK_A2A_CLIENT_URL'], 'LUMITHINK_A2A_CLIENT_URL');
  const token = requireString(env['LUMITHINK_A2A_CLIENT_TOKEN'], 'LUMITHINK_A2A_CLIENT_TOKEN', 16);
  const ledgerPath = requireString(env['LUMITHINK_A2A_CLIENT_LEDGER_PATH'], 'LUMITHINK_A2A_CLIENT_LEDGER_PATH');
  return {
    baseUrl,
    credential: token,
    ledger: ledgerPath,
    pollIntervalMs: positiveInt(env['LUMITHINK_A2A_CLIENT_POLL_MS'], 250, 'LUMITHINK_A2A_CLIENT_POLL_MS'),
    pollTimeoutMs: positiveInt(
      env['LUMITHINK_A2A_CLIENT_POLL_TIMEOUT_MS'],
      120_000,
      'LUMITHINK_A2A_CLIENT_POLL_TIMEOUT_MS',
    ),
    cancelResponseTimeoutMs: positiveInt(
      env['LUMITHINK_A2A_CLIENT_CANCEL_TIMEOUT_MS'],
      CANCEL_RESPONSE_TIMEOUT_DEFAULT_MS,
      'LUMITHINK_A2A_CLIENT_CANCEL_TIMEOUT_MS',
    ),
    maxSendRetries: positiveInt(
      env['LUMITHINK_A2A_CLIENT_MAX_SEND_RETRIES'],
      2,
      'LUMITHINK_A2A_CLIENT_MAX_SEND_RETRIES',
    ),
  };
}
