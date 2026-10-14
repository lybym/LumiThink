/**
 * R1-14 Child Memory v0 — public surface (issue #26).
 *
 * Re-exports the minimal memory schema and the trusted memory service. The
 * module must stay dependency-free (no prisma, react, next, node builtins)
 * — enforced by tests/domain/boundary.spec.ts.
 */
export * from "./schema.ts";
export { createMemoryService, validateMemoryRestoreEntries, type MemoryService, type MemoryServiceOptions, type MemoryDeleteResult, type MemoryRetrievalResult, type MemoryWriteResult } from "./service.ts";
