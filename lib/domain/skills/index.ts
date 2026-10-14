/**
 * R1-11 public entrypoint of the Skills domain module
 * (lib/domain/skills/, issue #23).
 *
 * The skill executors are the deterministic behavior surfaces governed by
 * the R1-13 evidence/skill registries: each consumes ONLY a served
 * registry load (manifest + pinned evidence + limitations) and produces the
 * structured, version-stamped strategy output a turn runs under. Honest
 * observations over these surfaces are derived by the eval subjects, never
 * self-reported here.
 */

export * from "./emotion-support.ts";
export * from "./emotion-eval-subject.ts";
export * from "./emotion-eval-suite.ts";
