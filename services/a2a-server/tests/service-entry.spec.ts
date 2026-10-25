/**
 * Independent entry-point boot test (P1-01, issue #83): `src/main.ts` must
 * start as a standalone process on the configured loopback port, serve Agent
 * Card discovery, and exit cleanly on SIGTERM. This is the "独立服务入口"
 * evidence — everything else in the suite drives the composed service
 * in-process.
 */
import test from 'node:test';
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

test('service entry boots standalone, serves discovery, exits on SIGTERM', async () => {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', 'src/main.ts'],
    {
      cwd: SERVICE_DIR,
      env: {
        ...process.env,
        LUMITHINK_A2A_VALIDATION_TOKEN: 'entry-boot-synthetic-token-0123456789',
        LUMITHINK_A2A_VALIDATION_PORT: '0', // ephemeral; the banner reveals the URL
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const stdoutChunks: string[] = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => stdoutChunks.push(chunk));

  try {
    // Wait for the listening banner (bounded — never hang the suite).
    const banner = await new Promise<string>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const text = stdoutChunks.join('');
        const match = text.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) {
          clearInterval(timer);
          resolve(match[1]);
        } else if (Date.now() - started > 20000) {
          clearInterval(timer);
          reject(new Error(`entry did not report listening in 20s; stdout: ${text}`));
        }
      }, 100);
    });
    assert.match(banner, /http:\/\/127\.0\.0\.1:\d+/);
    assert.match(stdoutChunks.join(''), /SYNTHETIC/,
      'the entry banner must carry the synthetic marking');

    // Discovery works on the standalone process.
    const card = await fetch(`${banner}/.well-known/agent-card.json`);
    assert.equal(card.status, 200);
    const cardBody = (await card.json()) as { name?: string };
    assert.equal(cardBody.name, 'lumithink');

    // And the bearer gate is live on the standalone process too.
    const rpc = await fetch(`${banner}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } }),
    });
    assert.equal(rpc.status, 401, 'standalone entry enforces the bearer gate');

    // SIGTERM shutdown: POSIX delivers the signal to the entry's handler
    // (clean exit 0). Windows has no deliverable SIGTERM — Node terminates
    // the child unconditionally, so there we only assert termination.
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    child.kill('SIGTERM');
    const { code } = await exited;
    // Reaching the exit event proves termination on every platform; the
    // clean-exit-code contract is deliverable only where SIGTERM exists.
    if (process.platform !== 'win32') {
      assert.equal(code, 0, 'SIGTERM must shut the entry down cleanly');
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
});
