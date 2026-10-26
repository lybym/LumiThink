/**
 * Restartable A2A validation service fixture (P1-08 restart evidence,
 * issue #90). A thin wrapper that boots the REAL composed service from
 * environment configuration and stays alive until killed — the test spawns
 * it as a child process, drives one real dsh-worker execution through HTTP,
 * then SIGKILLs it mid-flight to produce a genuine crash-restart scenario
 * (module-level fault evidence for TASK_LIFECYCLE §10 存储与启动故障点).
 *
 * The worker behavior profile is inherited through the environment
 * (LUMITHINK_A2A_WORKER_BEHAVIOR): the runtime spawns workers with
 * {...process.env, ...workerEnv}, so the profile reaches the grandchild.
 */
import { loadA2aServiceConfig } from '../../src/config.ts';
import { startA2aService, stopA2aService } from '../../src/a2a-service.ts';

const config = loadA2aServiceConfig(process.env);
const service = await startA2aService({ config });

// The parent test parses this line to learn the bound loopback base URL.
console.log(`READY ${service.base}`);

process.on('SIGTERM', () => {
  void stopA2aService(service)
    .catch(() => undefined)
    .then(() => process.exit(0));
});

// Keep the event loop alive until the test kills the process.
setInterval(() => undefined, 60_000);
