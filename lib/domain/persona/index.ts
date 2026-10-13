/**
 * R1-04 public entrypoint of the Persona domain module (lib/domain/persona/,
 * docs/PERSONA.md).
 *
 * Import persona symbols from here (or from the specific module). The
 * persona layer is dependency-free domain code inside the lib/domain/
 * boundary enforced by tests/domain/boundary.spec.ts; it may only build on
 * the versioned interaction contract (lib/domain/contract/), the Safety
 * Gate vocabularies (lib/domain/safety/), the eval vocabulary
 * (lib/domain/eval/) and the shared human-review record of the evidence
 * governance schema (lib/domain/evidence/card.ts).
 */

export * from "./policy.ts";
export * from "./registry.ts";
export * from "./turn.ts";
export * from "./eval-subject.ts";
export * from "./eval-suite.ts";
