/**
 * R1-13 public entrypoint of the Evidence Card + Skill Registry domain
 * module (lib/domain/evidence/, docs/EVIDENCE_POLICY.md).
 *
 * Import evidence-governance symbols from here (or from the specific
 * module). The evidence layer is dependency-free domain code inside the
 * lib/domain/ boundary enforced by tests/domain/boundary.spec.ts, and may
 * only build on the versioned interaction contract (lib/domain/contract/),
 * the Safety Gate whitelist (lib/domain/safety/) and the eval vocabulary
 * (lib/domain/eval/).
 */

export * from "./card.ts";
export * from "./skill-manifest.ts";
export * from "./registry.ts";
