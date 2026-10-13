/**
 * R1-07 public entrypoint of the Evaluation Harness domain module
 * (lib/domain/eval/, docs/HARNESS.md §6).
 *
 * Import evaluation symbols from here (or from the specific module). The
 * evaluation layer is dependency-free domain code inside the lib/domain/
 * boundary enforced by tests/domain/boundary.spec.ts, and may only build on
 * the versioned interaction contract (lib/domain/contract/) and the Safety
 * Gate (lib/domain/safety/).
 */

export * from "./scenario.ts";
export * from "./subject.ts";
export * from "./assertions.ts";
export * from "./runner.ts";
export * from "./report.ts";
export * from "./fixtures.ts";
