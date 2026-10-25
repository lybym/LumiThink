/**
 * P0-02 interop server: boots the same synthetic official-JS-SDK server used
 * by wire-verify.mjs and keeps it alive so the official Python client
 * (poc/a2a-compat/py/interop_probe.py) can exercise it cross-SDK.
 *
 * Usage: node src/interop-server.mjs [port]
 * Prints "READY <base>" once listening; exits when stdin closes or on SIGINT.
 */
import { startVerifyServer } from './server-lib.mjs';

const port = Number(process.argv[2] ?? 0);
const { base, server } = await startVerifyServer({ port });
console.log(`READY ${base}`);

const shutdown = () => {
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
// Safety timer so an orphaned server can never be left behind; probes are
// short-lived, and CI/harness runners close the process explicitly.
setTimeout(shutdown, 120_000).unref();
