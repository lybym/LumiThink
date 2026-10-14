/**
 * R1-00 startup environment validation.
 *
 * The R1-00 engineering baseline must boot without any real model provider
 * key, without any real child data and without a database connection. Only a
 * small, explicit set of variables is understood; everything else is ignored.
 *
 * R1-08 (issue #20) adds OPTIONAL deployment configuration: real guardian /
 * admin access codes (replacing the disclosed synthetic demo codes when set)
 * and the encrypted runtime-snapshot subsystem. All of it stays unset on the
 * synthetic demo boot path; when set, every value is validated fail-closed.
 *
 * Validation failure modes:
 * - `readStartupEnv` throws `StartupEnvError` listing the variable NAMES that
 *   are misconfigured. Error messages never echo variable values, so a failed
 *   health check cannot leak secrets or child data.
 */

export const STARTUP_ENV_ERROR_CODE = "STARTUP_ENV_INVALID";

const NODE_ENV_VALUES = ["development", "production", "test"] as const;

export type NodeEnv = (typeof NODE_ENV_VALUES)[number];

/**
 * Loose env source type: Next.js type augmentation makes NODE_ENV required on
 * NodeJS.ProcessEnv, which would make synthetic test environments unassignable.
 * Runtime code only ever reads string|undefined keys.
 */
export type EnvSource = Readonly<Record<string, string | undefined>>;

export interface StartupSnapshotConfig {
  /**
   * Encrypted runtime-snapshot file path (R1-08 encrypted backup). `null`
   * disables the snapshot subsystem entirely (default; synthetic demo boots).
   */
  readonly path: string | null;
  /** 32-byte AES-256-GCM key as 64 hex chars, from `LUMITHINK_SNAPSHOT_KEY`. */
  readonly keyHex: string | null;
  /** Path to a file holding the 64-hex key (`LUMITHINK_SNAPSHOT_KEY_FILE`). */
  readonly keyFile: string | null;
  /** Snapshot interval in ms (`LUMITHINK_SNAPSHOT_INTERVAL_MS`); null = default. */
  readonly intervalMs: number | null;
  /**
   * EXPLICIT per-boot operator override for the child-deletion replay after
   * a boot-time snapshot restore (`LUMITHINK_SNAPSHOT_RESTORE_REPLAY`).
   * Default false: the normal restart path must PRESERVE confirmed events
   * (the current snapshot file is internally consistent). The one-shot
   * replay request used by `deploy/restore.sh` is the SELF-CLEARING marker
   * file `<snapshot-dir>/restore-replay.pending` — the runtime consumes it
   * after the one replaying boot — NEVER this env flag: a flag left at 1
   * would replay (and purge everything created since the previous restart)
   * after EVERY restart (review P1-1). Set it to 1 only deliberately, for
   * a bounded diagnostic window, and unset it right after (ADR-0005: a
   * restore may never resurrect deleted data).
   */
  readonly restoreReplay: boolean;
}

export interface StartupEnv {
  readonly nodeEnv: NodeEnv;
  readonly port: number | null;
  // ---------------------------------------------------------------------------
  // R1-08 (issue #20) deployment secrets + encrypted backup configuration.
  // Everything below is OPTIONAL: the synthetic demo boot (CI, local dev,
  // clean-environment health check) works with all of it unset. Values are
  // carried for server-side use only; they are never logged or echoed.
  // ---------------------------------------------------------------------------
  /**
   * Real guardian access code (`LUMITHINK_GUARDIAN_ACCESS_CODE`). When set,
   * the guardian service verifies against THIS code's SHA-256 digest and the
   * published demo code is rejected. `null` keeps the disclosed demo mode.
   */
  readonly guardianAccessCode: string | null;
  /** Real independent-admin access code (`LUMITHINK_ADMIN_ACCESS_CODE`). */
  readonly adminAccessCode: string | null;
  /** Encrypted-snapshot subsystem configuration (see StartupSnapshotConfig). */
  readonly snapshot: StartupSnapshotConfig;
}

export interface FirstBootRequirements {
  /**
   * Names of model provider keys required at first boot. Deliberately empty:
   * the baseline serves the frozen prototype pages and a health endpoint
   * only, with no model egress at all.
   */
  readonly modelProviderKeysRequired: readonly string[];
  /** First boot never touches real child data (synthetic demo data only). */
  readonly childDataRequired: false;
  /** First boot never opens a database connection. */
  readonly databaseRequired: false;
  /** Next.js telemetry stays off by default (see .env.example and CI env). */
  readonly telemetry: "disabled-by-default";
}

export const FIRST_BOOT_REQUIREMENTS: FirstBootRequirements = {
  modelProviderKeysRequired: [],
  childDataRequired: false,
  databaseRequired: false,
  telemetry: "disabled-by-default",
};

export class StartupEnvError extends Error {
  /** Variable names/rules that failed validation. Values are never included. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid startup environment: ${problems.join("; ")}`);
    this.name = "StartupEnvError";
    this.problems = Object.freeze([...problems]);
  }
}

function parsePort(raw: string | undefined, problems: string[]): number | null {
  if (raw === undefined || raw === "") {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    problems.push("PORT must be an integer between 1 and 65535 when set");
    return null;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// R1-08 deployment secret + snapshot variable validation (fail-closed, no
// value ever appears in a problem message — names/rules only).
// ---------------------------------------------------------------------------

/** Demo codes the real credentials must never collide with (ADR-0003). */
const DEMO_CODE_COLLISIONS: ReadonlyArray<readonly [string, string]> = [
  ["LUMITHINK_GUARDIAN_ACCESS_CODE", "lumithink-guardian-demo"],
  ["LUMITHINK_ADMIN_ACCESS_CODE", "lumithink-admin-demo"],
];

function parseAccessCode(
  name: string,
  raw: string | undefined,
  problems: string[],
): string | null {
  if (raw === undefined || raw === "") {
    return null;
  }
  // Real credentials must clear a higher bar than the submit-side grammar
  // (8 chars): a deployment secret shorter than 12 chars is a misconfig.
  if (raw.length < 12 || raw.length > 128) {
    problems.push(`${name} must be 12-128 characters when set`);
    return null;
  }
  if (raw.trim() !== raw || /\s/.test(raw)) {
    problems.push(`${name} must not contain whitespace when set`);
    return null;
  }
  for (const [varName, demoCode] of DEMO_CODE_COLLISIONS) {
    if (varName === name && raw === demoCode) {
      problems.push(`${name} must not be the published synthetic demo code`);
      return null;
    }
  }
  return raw;
}

function parseSnapshotKey(
  raw: string | undefined,
  problems: string[],
): string | null {
  if (raw === undefined || raw === "") {
    return null;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    problems.push("LUMITHINK_SNAPSHOT_KEY must be exactly 64 hex characters (32 bytes) when set");
    return null;
  }
  return raw.toLowerCase();
}

function parseSnapshotPath(
  raw: string | undefined,
  problems: string[],
): string | null {
  if (raw === undefined || raw === "") {
    return null;
  }
  if (raw.length > 512) {
    problems.push("LUMITHINK_SNAPSHOT_PATH must be at most 512 characters when set");
    return null;
  }
  return raw;
}

function parseSnapshotKeyFile(
  raw: string | undefined,
  problems: string[],
): string | null {
  if (raw === undefined || raw === "") {
    return null;
  }
  if (raw.length > 512) {
    problems.push("LUMITHINK_SNAPSHOT_KEY_FILE must be at most 512 characters when set");
    return null;
  }
  return raw;
}

function parseSnapshotInterval(
  raw: string | undefined,
  problems: string[],
): number | null {
  if (raw === undefined || raw === "") {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 86_400_000) {
    problems.push(
      "LUMITHINK_SNAPSHOT_INTERVAL_MS must be an integer between 1000 and 86400000 when set",
    );
    return null;
  }
  return parsed;
}

function parseRestoreReplay(raw: string | undefined, problems: string[]): boolean {
  if (raw === undefined || raw === "") {
    return false;
  }
  if (raw === "1" || raw === "true") {
    return true;
  }
  if (raw === "0" || raw === "false") {
    return false;
  }
  problems.push(
    "LUMITHINK_SNAPSHOT_RESTORE_REPLAY must be one of 0 | 1 | false | true when set",
  );
  return false;
}

/**
 * Validate and read the startup environment. Unknown variables are ignored on
 * purpose: extra environment content (including any provider credentials that
 * may exist on a developer machine) is never read by the baseline app.
 */
export function readStartupEnv(source: EnvSource = process.env): StartupEnv {
  const problems: string[] = [];

  const rawNodeEnv = source.NODE_ENV;
  let nodeEnv: NodeEnv = "development";
  if (rawNodeEnv !== undefined && rawNodeEnv !== "") {
    if ((NODE_ENV_VALUES as readonly string[]).includes(rawNodeEnv)) {
      nodeEnv = rawNodeEnv as NodeEnv;
    } else {
      problems.push(
        `NODE_ENV must be one of ${NODE_ENV_VALUES.join(" | ")} when set`,
      );
    }
  }

  const port = parsePort(source.PORT, problems);

  const databaseUrl = source.DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl !== "") {
    if (!databaseUrl.startsWith("file:")) {
      // Message intentionally does not echo the value.
      problems.push(
        "DATABASE_URL must use the SQLite file: scheme while prisma/schema.prisma is frozen to SQLite",
      );
    }
  }

  const guardianAccessCode = parseAccessCode(
    "LUMITHINK_GUARDIAN_ACCESS_CODE",
    source.LUMITHINK_GUARDIAN_ACCESS_CODE,
    problems,
  );
  const adminAccessCode = parseAccessCode(
    "LUMITHINK_ADMIN_ACCESS_CODE",
    source.LUMITHINK_ADMIN_ACCESS_CODE,
    problems,
  );

  // Encrypted-snapshot subsystem: encryption is MANDATORY (the issue asks for
  // encrypted backups, never plaintext state files) and exactly one key
  // source is allowed.
  const snapshotPath = parseSnapshotPath(source.LUMITHINK_SNAPSHOT_PATH, problems);
  const snapshotKeyHex = parseSnapshotKey(source.LUMITHINK_SNAPSHOT_KEY, problems);
  const snapshotKeyFile = parseSnapshotKeyFile(source.LUMITHINK_SNAPSHOT_KEY_FILE, problems);
  const snapshotIntervalMs = parseSnapshotInterval(source.LUMITHINK_SNAPSHOT_INTERVAL_MS, problems);
  const snapshotRestoreReplay = parseRestoreReplay(source.LUMITHINK_SNAPSHOT_RESTORE_REPLAY, problems);
  if (snapshotKeyHex !== null && snapshotKeyFile !== null) {
    problems.push(
      "LUMITHINK_SNAPSHOT_KEY and LUMITHINK_SNAPSHOT_KEY_FILE are mutually exclusive; choose one key source",
    );
  }
  if (snapshotPath !== null && snapshotKeyHex === null && snapshotKeyFile === null) {
    problems.push(
      "LUMITHINK_SNAPSHOT_PATH requires LUMITHINK_SNAPSHOT_KEY or LUMITHINK_SNAPSHOT_KEY_FILE (snapshots are always encrypted)",
    );
  }
  // Real credentials come as a PAIR: a deployment where only one role has a
  // real code would silently leave the other on the published demo code.
  if ((guardianAccessCode === null) !== (adminAccessCode === null)) {
    problems.push(
      "LUMITHINK_GUARDIAN_ACCESS_CODE and LUMITHINK_ADMIN_ACCESS_CODE must be set together (both roles leave demo mode together)",
    );
  }

  if (problems.length > 0) {
    throw new StartupEnvError(problems);
  }

  return {
    nodeEnv,
    port,
    guardianAccessCode,
    adminAccessCode,
    snapshot: {
      path: snapshotPath,
      keyHex: snapshotKeyHex,
      keyFile: snapshotKeyFile,
      intervalMs: snapshotIntervalMs,
      restoreReplay: snapshotRestoreReplay,
    },
  };
}
