/**
 * Service configuration for the LumiThink A2A validation service
 * (P1-01/P1-02/P1-03).
 *
 * Port 3312 is the loopback port reserved by deploy/validation for the A2A
 * validation service (issue #81 §P0-03; ownership assigned to #83 by the
 * P0-04 acceptance index §7). The host is HARD-LOCKED to 127.0.0.1: the
 * validation service must never bind a public interface.
 *
 * Fail-closed: without a bearer token the service refuses to start. Since
 * P1-03 (issue #85) that token is the synthetic credential of the default
 * validation-harness client in the identity store (two-tier Client/
 * Principal resolution); additional synthetic clients/credentials/grants
 * are provisioned through LUMITHINK_A2A_IDENTITY_BOOTSTRAP (JSON) and are
 * optional.
 */
export const A2A_VALIDATION_DEFAULT_PORT = 3312;
export const A2A_LOOPBACK_HOST = '127.0.0.1';
export const A2A_SUPPORTED_VERSIONS: readonly string[] = ['1.0'];
/**
 * Default SQLite Task Manager database (P1-02, issue #84). ':memory:' keeps
 * the standalone validation run stateless and CI-clean (no file writes);
 * durable validation deployments set LUMITHINK_A2A_VALIDATION_DB to a file
 * path. This is NOT DATABASE_URL — the A2A server gate keeps that variable
 * (and every provider credential) unset by contract.
 */
export const A2A_VALIDATION_DEFAULT_DB_PATH = ':memory:';
/**
 * Identity & authorization database (P1-03, issue #85). Separate store from
 * the Task Manager (ADR-0014); ':memory:' default keeps standalone runs
 * CI-clean. Durable deployments set LUMITHINK_A2A_IDENTITY_DB.
 */
export const A2A_IDENTITY_DEFAULT_DB_PATH = ':memory:';

export interface A2aServiceConfig {
  /** Loopback bind port; 0 lets the OS pick an ephemeral port (tests). */
  port: number;
  /** Always '127.0.0.1' — see A2A_LOOPBACK_HOST; never configurable. */
  host: typeof A2A_LOOPBACK_HOST;
  /** Synthetic validation bearer token; required, fail-closed. */
  bearerToken: string;
  /** Declared A2A protocol versions; only '1.0' (R7: never accept 0.3). */
  supportedVersions: readonly string[];
  /** SQLite Task Manager database path (issue #84); ':memory:' default. */
  dbPath: string;
  /** Identity store database path (issue #85); ':memory:' default. */
  identityDbPath: string;
  /** Optional JSON bootstrap for additional synthetic clients/credentials/grants. */
  identityBootstrapJson?: string;
}

export function loadA2aServiceConfig(env: NodeJS.ProcessEnv = process.env): A2aServiceConfig {
  const rawPort = env.LUMITHINK_A2A_VALIDATION_PORT;
  let port = A2A_VALIDATION_DEFAULT_PORT;
  if (rawPort !== undefined && rawPort !== '') {
    port = Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(
        `LUMITHINK_A2A_VALIDATION_PORT must be an integer in [0, 65535], got: ${rawPort}`,
      );
    }
  }
  const bearerToken = env.LUMITHINK_A2A_VALIDATION_TOKEN;
  if (bearerToken === undefined || bearerToken.length < 16) {
    throw new Error(
      'LUMITHINK_A2A_VALIDATION_TOKEN must be set to at least 16 characters — ' +
        'the A2A validation service refuses to start unauthenticated (fail-closed).',
    );
  }
  const rawDbPath = env.LUMITHINK_A2A_VALIDATION_DB;
  const dbPath = rawDbPath !== undefined && rawDbPath.trim() !== ''
    ? rawDbPath.trim()
    : A2A_VALIDATION_DEFAULT_DB_PATH;
  const rawIdentityDbPath = env.LUMITHINK_A2A_IDENTITY_DB;
  const identityDbPath =
    rawIdentityDbPath !== undefined && rawIdentityDbPath.trim() !== ''
      ? rawIdentityDbPath.trim()
      : A2A_IDENTITY_DEFAULT_DB_PATH;
  const rawBootstrap = env.LUMITHINK_A2A_IDENTITY_BOOTSTRAP;
  const identityBootstrapJson =
    rawBootstrap !== undefined && rawBootstrap.trim() !== '' ? rawBootstrap : undefined;
  return {
    port,
    host: A2A_LOOPBACK_HOST,
    bearerToken,
    supportedVersions: A2A_SUPPORTED_VERSIONS,
    dbPath,
    identityDbPath,
    identityBootstrapJson,
  };
}
