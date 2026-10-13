/**
 * R1-00 startup environment validation.
 *
 * The R1-00 engineering baseline must boot without any real model provider
 * key, without any real child data and without a database connection. Only a
 * small, explicit set of variables is understood; everything else is ignored.
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

export interface StartupEnv {
  readonly nodeEnv: NodeEnv;
  readonly port: number | null;
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

  if (problems.length > 0) {
    throw new StartupEnvError(problems);
  }

  return { nodeEnv, port };
}
