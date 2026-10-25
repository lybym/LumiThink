/**
 * Independent service entry for the LumiThink A2A validation service
 * (P1-01, issue #83). Loopback-only on the reserved validation port 3312.
 *
 * SYNTHETIC scope: the started service carries the synthetic executor — a
 * running process proves the transport/protocol skeleton is up, nothing more.
 * It is not the real DSH execution gate and not a production deployment.
 */
import { loadA2aServiceConfig } from './config.ts';
import { startA2aService, stopA2aService } from './a2a-service.ts';

const config = loadA2aServiceConfig(process.env);
const service = await startA2aService({ config });

const runtimeNote =
  config.runtimeMode === 'dsh-worker'
    ? 'DSH-WORKER real subprocess runtime (synthetic provider content — ' +
      'real-model verification remains P1-10/#92)'
    : 'SYNTHETIC executor only — not a real DSH execution gate';
console.log(
  `[lumithink-a2a] validation service listening on ${service.base} ` +
    `(P1-01..P1-05, issues #83/#84/#85/#86/#87; A2A ${config.supportedVersions.join(', ')}; ` +
    `SQLite Task Manager db=${config.dbPath}; identity store db=${config.identityDbPath}; ` +
    `two-tier Client/Principal identity active; runtime=${config.runtimeMode}: ${runtimeNote})`,
);

const shutdown = (signal: string) => {
  console.log(`[lumithink-a2a] ${signal} received; closing loopback listener`);
  stopA2aService(service)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('[lumithink-a2a] shutdown error', error);
      process.exit(1);
    });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
