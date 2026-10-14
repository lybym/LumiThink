/**
 * R1-08 start preflight: validate the startup environment (fail-closed,
 * value-never-echoed) before the server execs. Used by deploy/start.sh.
 */
import { readStartupEnv } from "../lib/env.ts";

try {
  readStartupEnv();
  console.log("startup env OK");
} catch (error) {
  console.error(error instanceof Error ? error.message : "startup env invalid");
  process.exit(1);
}
