/**
 * P0-02 test harness: runs the locked-JS-SDK wire verification (loopback
 * JSON-RPC + SSE + standard errors + duplicate CancelTask + A2A-Version) as a
 * node:test case. All assertions live in src/wire-verify.mjs so the standalone
 * script (`pnpm run verify:wire`) and this suite share one code path.
 */
import test from 'node:test';

test('official JS SDK server/client wire behavior matches the frozen v1.0 contract', async () => {
  await import('../src/wire-verify.mjs');
});
