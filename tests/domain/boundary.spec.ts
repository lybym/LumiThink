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

/**
 * Recursively collect .ts files under lib/domain (including subdirectories
 * such as lib/domain/contract/) as paths relative to the domain root.
 */
function collectDomainFiles(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...collectDomainFiles(join(dir, entry.name), relative));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(relative);
    }
  }
  return found;
}

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
    // Catches every form of reaching the legacy Prisma singleton: relative
    // paths ("../../lib/db", "../db"), TypeScript-suffixed variants
    // ("../../lib/db.ts") and the bare "db"/"db.ts" specifiers — but not
    // unrelated modules that merely contain "db" in a longer name.
    pattern: /from\s+["'](?:[^"']*\/)?db(?:\.ts)?["']/,
    reason: "the domain boundary must not import the legacy Prisma singleton (lib/db)",
  },
  {
    pattern: /from\s+["']@\//,
    reason: "domain modules must use relative imports only",
  },
];

/**
 * Reasons a source file violates the boundary, given its full source text.
 * Shared by the lib/domain scan and the positive fixtures below so the
 * fixtures exercise exactly the production check.
 */
function boundaryViolations(source: string): string[] {
  return FORBIDDEN_IMPORTS.filter(({ pattern }) => pattern.test(source)).map(({ reason }) => reason);
}

test("lib/domain exists and exposes the legacy guard as the intake boundary", () => {
  const files = collectDomainFiles(domainDir);
  assert.ok(
    files.includes("legacy-guard.ts"),
    "lib/domain/legacy-guard.ts must exist",
  );
});

test("lib/domain modules import no persistence, framework or legacy app layers", () => {
  const files = collectDomainFiles(domainDir);
  assert.ok(files.length > 0);

  for (const file of files) {
    const source = readFileSync(join(domainDir, file), "utf8");
    const violations = boundaryViolations(source);
    assert.deepEqual(
      violations,
      [],
      `lib/domain/${file} violates the directory boundary: ${violations.join("; ")}`,
    );
  }
});

test("the forbidden-import patterns actually catch violations (positive fixtures)", () => {
  const imports = (specifier: string) => boundaryViolations(`import x from ${specifier};`);
  // Persistence
  assert.ok(imports(`"@prisma/client"`).length > 0, "@prisma/client must be caught");
  assert.ok(imports(`"../../lib/db"`).length > 0, "lib/db deep import must be caught");
  assert.ok(imports(`"../../lib/db.ts"`).length > 0, "lib/db.ts deep import must be caught");
  assert.ok(imports(`"../db"`).length > 0, "../db import must be caught");
  assert.ok(imports(`"db.ts"`).length > 0, "bare db.ts import must be caught");
  assert.ok(imports(`"@/lib/db"`).length > 0, "@/lib/db import must be caught");
  // Frameworks
  assert.ok(imports(`"react"`).length > 0, "react import must be caught");
  assert.ok(imports(`"react-dom"`).length > 0, "react-dom import must be caught");
  assert.ok(imports(`"next/headers"`).length > 0, "next/* import must be caught");
  // Alias imports
  assert.ok(imports(`"@/lib/env"`).length > 0, "@/ alias import must be caught");
  // Benign sources must stay clean.
  assert.deepEqual(
    boundaryViolations(`import { validateContractId } from "./core.ts";\nimport { ingestDomainFact } from "../legacy-guard.ts";`),
    [],
    "legitimate domain-relative imports must not be flagged",
  );
  assert.deepEqual(
    boundaryViolations(`const label = "react beginner";\nconst path = "mylib/database/config";`),
    [],
    "non-import mentions must not be flagged",
  );
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
