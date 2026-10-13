import { NextResponse } from "next/server";

import {
  FIRST_BOOT_REQUIREMENTS,
  STARTUP_ENV_ERROR_CODE,
  StartupEnvError,
  readStartupEnv,
} from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Minimal startup/health check for the R1-00 engineering baseline.
 *
 * Guarantees:
 * - Requires no real model provider key, no real child data and no database
 *   connection (see FIRST_BOOT_REQUIREMENTS and the R1-00 acceptance criteria).
 * - On startup env misconfiguration it returns 503 with variable NAMES only —
 *   never values, secrets or child content.
 */
export function GET(): NextResponse {
  try {
    const env = readStartupEnv();
    return NextResponse.json({
      status: "ok",
      service: "lumithink-web",
      baseline: "R1-00",
      env: {
        nodeEnv: env.nodeEnv,
      },
      firstBoot: FIRST_BOOT_REQUIREMENTS,
      legacyDomainGuard: "armed",
    });
  } catch (error) {
    const problems =
      error instanceof StartupEnvError
        ? error.problems
        : ["unknown startup environment failure"];
    return NextResponse.json(
      {
        status: "error",
        error: {
          code: STARTUP_ENV_ERROR_CODE,
          problems,
        },
      },
      { status: 503 },
    );
  }
}
