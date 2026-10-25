/**
 * P1-04 configuration tests (issue #86 AC 4): the retention windows are
 * configurable INITIAL values — 24h auto-retry / 7d result retention / a
 * tombstone window with a HARD 30-day floor (TASK_LIFECYCLE §5.4) — plus
 * the fingerprint HMAC key and the dispatch-lease TTL.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import {
  A2A_DISPATCH_LEASE_DEFAULT_TTL_MS,
  A2A_FINGERPRINT_SYNTHETIC_DEFAULT_KEY,
  A2A_RETENTION_DEFAULTS,
  loadA2aServiceConfig,
} from '../src/config.ts';

const BASE_ENV = { LUMITHINK_A2A_VALIDATION_TOKEN: 'config-spec-synthetic-token-0123456789' };

test('retention defaults are exactly the TASK_LIFECYCLE §5.4 initial values (24h / 7d / 30d)', () => {
  const config = loadA2aServiceConfig(BASE_ENV);
  assert.equal(config.retention.retryWindowMs, 24 * 60 * 60 * 1000);
  assert.equal(config.retention.resultRetentionMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(config.retention.tombstoneRetentionMs, 30 * 24 * 60 * 60 * 1000);
  assert.deepEqual(A2A_RETENTION_DEFAULTS, config.retention);
  assert.equal(config.dispatchLeaseTtlMs, A2A_DISPATCH_LEASE_DEFAULT_TTL_MS);
  assert.equal(config.fingerprintKey, A2A_FINGERPRINT_SYNTHETIC_DEFAULT_KEY,
    'the synthetic default fingerprint key is documented and deterministic');
});

test('retention windows and dispatch/lease settings are overridable via environment', () => {
  const config = loadA2aServiceConfig({
    ...BASE_ENV,
    LUMITHINK_A2A_RETENTION_RETRY_HOURS: '48',
    LUMITHINK_A2A_RETENTION_RESULT_DAYS: '14',
    LUMITHINK_A2A_RETENTION_TOMBSTONE_DAYS: '90',
    LUMITHINK_A2A_DISPATCH_LEASE_TTL_MS: '60000',
    LUMITHINK_A2A_FINGERPRINT_KEY: 'deployment-specific-hmac-key',
  });
  assert.equal(config.retention.retryWindowMs, 48 * 60 * 60 * 1000);
  assert.equal(config.retention.resultRetentionMs, 14 * 24 * 60 * 60 * 1000);
  assert.equal(config.retention.tombstoneRetentionMs, 90 * 24 * 60 * 60 * 1000);
  assert.equal(config.dispatchLeaseTtlMs, 60000);
  assert.equal(config.fingerprintKey, 'deployment-specific-hmac-key');
});

test('the tombstone window has a HARD 30-day floor — weaker configs refuse to start', () => {
  assert.throws(
    () => loadA2aServiceConfig({ ...BASE_ENV, LUMITHINK_A2A_RETENTION_TOMBSTONE_DAYS: '29' }),
    /30-day minimum/,
  );
});

test('malformed retention/lease numbers fail closed with explicit errors', () => {
  assert.throws(
    () => loadA2aServiceConfig({ ...BASE_ENV, LUMITHINK_A2A_RETENTION_RETRY_HOURS: 'nope' }),
    /LUMITHINK_A2A_RETENTION_RETRY_HOURS/,
  );
  assert.throws(
    () => loadA2aServiceConfig({ ...BASE_ENV, LUMITHINK_A2A_RETENTION_RESULT_DAYS: '0' }),
    /LUMITHINK_A2A_RETENTION_RESULT_DAYS/,
  );
  assert.throws(
    () => loadA2aServiceConfig({ ...BASE_ENV, LUMITHINK_A2A_RETENTION_TOMBSTONE_DAYS: '-1' }),
    /LUMITHINK_A2A_RETENTION_TOMBSTONE_DAYS/,
  );
  assert.throws(
    () => loadA2aServiceConfig({ ...BASE_ENV, LUMITHINK_A2A_DISPATCH_LEASE_TTL_MS: '0' }),
    /LUMITHINK_A2A_DISPATCH_LEASE_TTL_MS/,
  );
});
