/**
 * Service configuration for the LumiThink A2A validation service (P1-01).
 *
 * Port 3312 is the loopback port reserved by deploy/validation for the A2A
 * validation service (issue #81 §P0-03; ownership assigned to #83 by the
 * P0-04 acceptance index §7). The host is HARD-LOCKED to 127.0.0.1: the
 * validation service must never bind a public interface.
 *
 * Fail-closed: without a bearer token the service refuses to start. The
 * token is a synthetic validation credential only — real two-tier
 * Client/Principal identity is P1-03 (issue #85).
 */
export const A2A_VALIDATION_DEFAULT_PORT = 3312;
export const A2A_LOOPBACK_HOST = '127.0.0.1';
export const A2A_SUPPORTED_VERSIONS: readonly string[] = ['1.0'];

export interface A2aServiceConfig {
  /** Loopback bind port; 0 lets the OS pick an ephemeral port (tests). */
  port: number;
  /** Always '127.0.0.1' — see A2A_LOOPBACK_HOST; never configurable. */
  host: typeof A2A_LOOPBACK_HOST;
  /** Synthetic validation bearer token; required, fail-closed. */
  bearerToken: string;
  /** Declared A2A protocol versions; only '1.0' (R7: never accept 0.3). */
  supportedVersions: readonly string[];
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
  return { port, host: A2A_LOOPBACK_HOST, bearerToken, supportedVersions: A2A_SUPPORTED_VERSIONS };
}
