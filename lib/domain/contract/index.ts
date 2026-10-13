/**
 * R1-01 public entrypoint of the versioned interaction contract
 * (lib/domain/contract/, docs/API_CONTRACT.md).
 *
 * Import contract symbols from here (or from the specific module). The
 * contract layer is dependency-free and stays inside the lib/domain/
 * boundary enforced by tests/domain/boundary.spec.ts.
 */

export * from "./core.ts";
export * from "./actor.ts";
export * from "./errors.ts";
export * from "./interaction.ts";
export * from "./response.ts";
export * from "./idempotency.ts";
export * from "./schemas.ts";
export * from "./fixtures.ts";
