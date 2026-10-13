import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Directory-boundary enforcement for the new domain model (R1-00).
 *
 * lib/domain/ is the only place where 2.0 domain semantics live. It must stay
 * free of persistence (legacy Prisma), framework (react/next) and legacy app
 * imports, so the boundary cannot be bypassed by reaching into those layers.
 */

const domainDir = fileURLToPath(new URL("../../lib/domain/", import.meta.url));

const FORBIDDEN_IMPORTS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /@prisma\/client/,
    reason: "the domain boundary must not depend on the legacy Prisma client",
  },
  {
    pattern: /from\s+["'](?:react|react-dom)["']/,
    reason: "the domain boundary must not depend on React",
  },
  {
    pattern: /from\s+["']next(?:\/|["'])/,
    reason: "the domain boundary must not depend on Next.js",
  },
  {
    pattern: /from\s+["'](?:\.\.\/)+(?:lib\/)?db["']/,
    reason: "the domain boundary must not import the legacy Prisma singleton",
  },
  {
    pattern: /from\s+["']@\//,
    reason: "domain modules must use relative imports only",
  },
];

test("lib/domain exists and exposes the legacy guard as the intake boundary", () => {
  const files = readdirSync(domainDir).filter((name) => name.endsWith(".ts"));
  assert.ok(
    files.includes("legacy-guard.ts"),
    "lib/domain/legacy-guard.ts must exist",
  );
});

test("lib/domain modules import no persistence, framework or legacy app layers", () => {
  const files = readdirSync(domainDir).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0);

  for (const file of files) {
    const source = readFileSync(join(domainDir, file), "utf8");
    for (const { pattern, reason } of FORBIDDEN_IMPORTS) {
      assert.equal(
        pattern.test(source),
        false,
        `lib/domain/${file} violates the directory boundary: ${reason}`,
      );
    }
  }
});

test("domain guard rejects legacy shapes even when imported from outside", () => {
  // Import through the public entrypoint to make sure the module graph of the
  // domain layer alone is enough to arm the guard.
  return import("../../lib/domain/legacy-guard.ts").then(
    ({ ingestDomainFact }) => {
      assert.throws(
        () => ingestDomainFact({ numberSenseScore: 0.5, childId: "child_demo_001" }),
        /Legacy CognitiveProfile record rejected/,
      );
    },
  );
});
