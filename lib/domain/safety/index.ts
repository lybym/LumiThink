/**
 * R1-15 public entrypoint of the Safety Gate
 * (lib/domain/safety/, docs/SAFETY_POLICY.md).
 *
 * Import safety symbols from here (or from the specific module). The safety
 * layer is dependency-free domain code inside the lib/domain/ boundary
 * enforced by tests/domain/boundary.spec.ts, and may only build on the
 * versioned interaction contract (lib/domain/contract/).
 */

export * from "./policy.ts";
export * from "./trace.ts";
export * from "./crisis.ts";
export * from "./input-gate.ts";
export * from "./tool-gate.ts";
export * from "./output-gate.ts";
export * from "./pipeline.ts";
