/**
 * P0-02 test harness: runs the locked-JS-SDK codec verification as a
 * node:test case. All assertions live in src/codec-verify.mjs so the
 * standalone script (`pnpm run verify:codec`) and this suite share one code
 * path and cannot drift.
 */
import test from 'node:test';

test('official JS SDK @a2a-js/sdk@1.3.0 decodes and re-encodes the v1.0 fixtures', async () => {
  await import('../src/codec-verify.mjs');
});
