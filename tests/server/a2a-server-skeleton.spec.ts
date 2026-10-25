/**
 * Root guard for the P1-01 A2A validation service package (issue #83).
 *
 * The service lives in the fully isolated package `services/a2a-server`
 * (own package.json / pnpm-workspace.yaml / pnpm-lock.yaml — docs/adr/0013).
 * The root dependency surface stays frozen (the R1 release drill fails closed
 * on root dependency drift), so this guard is static: it pins the isolated
 * package's locked dependency surface, its isolation files, and the
 * synthetic/loopback contract markers in its sources. It does NOT import the
 * service (the root workspace cannot resolve its dependencies by design);
 * the executable protocol evidence lives in the service's own suite, run by
 * the dedicated `p1-a2a-server-gate` workflow and `pnpm run test:a2a-server`.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname ?? '.', '..', '..');
const SERVICE_DIR = path.join(ROOT, 'services', 'a2a-server');

test('isolated service package exists with its own lockfile and workspace isolation', () => {
  for (const file of [
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'src/main.ts',
  ]) {
    assert.ok(existsSync(path.join(SERVICE_DIR, file)), `services/a2a-server/${file} must exist`);
  }
  const lock = readFileSync(path.join(SERVICE_DIR, 'pnpm-lock.yaml'), 'utf8');
  assert.match(lock, /^lockfileVersion: '9\.0'/m, 'service lockfile must stay pnpm-10-compatible');
});

test('locked dependency surface: @a2a-js/sdk 1.3.0 + express 5.1.0, node 24.x', () => {
  const pkg = JSON.parse(readFileSync(path.join(SERVICE_DIR, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    engines?: { node?: string };
  };
  assert.equal(pkg.dependencies?.['@a2a-js/sdk'], '1.3.0',
    'the A2A SDK stays locked at the P0-02 verified version');
  assert.equal(pkg.dependencies?.['express'], '5.1.0',
    'express stays locked at the P0-02 verified version');
  assert.equal(pkg.engines?.node, '24.x', 'engines must pin node 24.x like the root');
  assert.equal(pkg.devDependencies?.['typescript'], '5.9.3',
    'typescript must match the repo toolchain pin');
  const rootPkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const rootSurface = JSON.stringify([rootPkg.dependencies, rootPkg.devDependencies]);
  assert.ok(!rootSurface.includes('@a2a-js/sdk'),
    'the root dependency surface must not absorb the A2A SDK (release drill drift guard)');
});

test('service sources carry the synthetic-only and loopback-only contract', () => {
  const read = (relative: string) =>
    readFileSync(path.join(SERVICE_DIR, relative), 'utf8');
  const executor = read('src/synthetic-executor.ts');
  assert.match(executor, /SYNTHETIC/s, 'the executor must be explicitly labeled synthetic');
  assert.match(executor, /not a real DSH execution gate|not the real\s+DSH execution gate|NOT the real/,
    'the executor must deny being a real DSH execution gate');
  const config = read('src/config.ts');
  assert.match(config, /127\.0\.0\.1/, 'the service host must be hard-locked to loopback');
  assert.match(config, /3312/, 'the default port must be the reserved validation port 3312');
  assert.match(config, /refuses to start unauthenticated|fail-closed/i,
    'the service must fail closed without a bearer token');
  const service = read('src/a2a-service.ts');
  assert.match(service, /HARD LOOPBACK BIND|loopback/i,
    'the bind must enforce the loopback host');
  const srcTree = ['src/config.ts', 'src/error-map.ts', 'src/lumithink-agent-card.ts',
    'src/synthetic-executor.ts', 'src/a2a-service.ts', 'src/main.ts', 'src/task-manager-port.ts']
    .map(read).join('\n');
  assert.ok(!/openai/i.test(srcTree), 'no OpenAI-compatible entry may be built (issue boundary)');
});

test('the guard spec stays registered in the root test suite', () => {
  const rootPkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.match(rootPkg.scripts?.test ?? '', /a2a-server-skeleton\.spec\.ts/,
    'this guard spec must remain part of the root pnpm test suite');
  assert.match(rootPkg.scripts?.['test:a2a-server'] ?? '', /services\/a2a-server/,
    'the service suite entry script must stay wired');
});
