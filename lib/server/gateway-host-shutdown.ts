/** Bounded host teardown. Error values never enter public diagnostics. */
export type GatewayShutdownReason = "signal" | "fatal_exception" | "fatal_rejection" | "boot_failed";

export interface GatewayHostShutdown {
  request(code: 0 | 1, reason: GatewayShutdownReason): void;
}

export function createGatewayHostShutdown(options: {
  readonly closeAdmission: () => void;
  readonly cleanup: () => Promise<void>;
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
  readonly exit?: (code: number) => void;
}): GatewayHostShutdown {
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("invalid_shutdown_timeout");
  const log = options.log ?? ((line: string) => console.error(line));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let stopping = false;
  let exitCode = 0;
  return {
    request(code, reason) {
      exitCode = Math.max(exitCode, code);
      if (stopping) return;
      stopping = true;
      // Keep the deadline referenced so even a hung async cleanup terminates.
      const deadline = setTimeout(() => exit(1), timeoutMs);
      try { log(`[gateway-host] shutdown reason=${reason}`); } catch { /* diagnostics are best effort */ }
      try { options.closeAdmission(); } catch { exitCode = 1; }
      void (async () => {
        try { await options.cleanup(); } catch { exitCode = 1; }
        finally { clearTimeout(deadline); exit(exitCode); }
      })();
    },
  };
}

/** Keep both handlers installed until exit, including during repeated faults. */
export function installGatewayHostShutdown(shutdown: GatewayHostShutdown): void {
  process.on("uncaughtException", () => shutdown.request(1, "fatal_exception"));
  process.on("unhandledRejection", () => shutdown.request(1, "fatal_rejection"));
  process.on("SIGTERM", () => shutdown.request(0, "signal"));
  process.on("SIGINT", () => shutdown.request(0, "signal"));
}
