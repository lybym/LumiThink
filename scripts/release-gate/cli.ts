/**
 * R1-10 (issue #22) release-gate CLI.
 *
 * Commands (all fail closed, all output value-free):
 *
 *   run-evals --out <dir>
 *       Run the four release suites through the real harness and write
 *       <dir>/<suiteId>.report.json (content-free canonical JSON).
 *
 *   manifest --out <file> [--commit <sha>]
 *       Write the release manifest. With --commit this is the per-run record
 *       (release evidence); without it, the committed baseline form.
 *
 *   verify --baseline <file> --reports <dir>
 *       Fail closed unless: the live manifest (rebuilt from shipped code)
 *       deep-equals the committed baseline, and every release suite has a
 *       passing, complete, untampered v1.1 report (drift / injected failure /
 *       safety SKIP / corrupted report / unreviewed evidence / unrun
 *       critical scenarios all block).
 *
 *   scan-leaks --file <path> [--file <path> ...]
 *       Fail closed on credential shapes, private-key blocks or child
 *       references outside the published `chd_demo_` synthetic grammar in
 *       any gate artifact.
 *
 * Usage: node --experimental-strip-types scripts/release-gate/cli.ts <command> ...
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { buildReleaseManifest, serializeReleaseManifest } from "./manifest.ts";
import {
  ReleaseGateError,
  assertNoLeaks,
  parseBaselineManifest,
  scanForLeaks,
  verifyEvalReports,
  verifyManifestBaseline,
} from "./verify.ts";
import { writeReleaseEvalReports } from "./run-evals.ts";

function fail(problems: readonly string[]): never {
  for (const problem of problems) {
    console.error(`::error::${problem}`);
  }
  process.exit(1);
}

function parseArgs(argv: readonly string[]): ReadonlyMap<string, string> {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined) {
      fail([`invalid argument near '${flag ?? "<end>"}'`]);
    }
    args.set(flag.slice(2), value);
  }
  return args;
}

function readReportEntries(reportsDir: string): readonly { name: string; raw: string }[] {
  let entries: string[];
  try {
    entries = readdirSync(reportsDir).filter((name) => name.endsWith(".report.json"));
  } catch {
    fail([`reports directory is unreadable: ${reportsDir}`]);
  }
  if (entries.length === 0) {
    fail(["no *.report.json files found (评测未运行 blocked)"]);
  }
  return entries.map((name) => ({
    name,
    raw: readFileSync(join(reportsDir, name), "utf8"),
  }));
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined) {
    fail(["usage: cli.ts <run-evals|manifest|verify|scan-leaks> [options]"]);
  }

  switch (command) {
    case "run-evals": {
      const args = parseArgs(rest);
      const out = args.get("out");
      if (out === undefined) {
        fail(["run-evals requires --out <dir>"]);
      }
      const runs = writeReleaseEvalReports(out);
      if (runs.some((run) => run.report.status !== "pass")) {
        process.exit(1);
      }
      return;
    }

    case "manifest": {
      const args = parseArgs(rest);
      const out = args.get("out");
      if (out === undefined) {
        fail(["manifest requires --out <file>"]);
      }
      const commit = args.get("commit");
      void buildReleaseManifest({ commit })
        .then((manifest) => {
          mkdirSync(join(out, ".."), { recursive: true });
          writeFileSync(out, `${serializeReleaseManifest(manifest)}\n`, "utf8");
          console.log(`manifest written: ${out} (commit=${manifest.commit ?? "none"})`);
        })
        .catch((error: unknown) => {
          fail([error instanceof Error ? error.message : "manifest build failed"]);
        });
      return;
    }

    case "verify": {
      const args = parseArgs(rest);
      const baselinePath = args.get("baseline");
      const reportsDir = args.get("reports");
      if (baselinePath === undefined || reportsDir === undefined) {
        fail(["verify requires --baseline <file> and --reports <dir>"]);
      }
      void (async () => {
        // 1. Manifest drift gate (versions / schema / dependencies / deploy).
        const baselineRaw = readFileSync(baselinePath, "utf8");
        const baseline = parseBaselineManifest(baselineRaw);
        const live = await buildReleaseManifest();
        verifyManifestBaseline(live, baseline);
        console.log("manifest: live == reviewed baseline (no unacknowledged drift)");

        // 2. Report gate (all release suites green, complete, untampered).
        const reports = readReportEntries(reportsDir);
        const summaries = verifyEvalReports(reports);
        for (const summary of summaries) {
          console.log(
            `report: suite=${summary.suiteId} status=${summary.status} ` +
              `total=${summary.counts.total} skip=${summary.counts.skip} ` +
              `pendingHumanReview=${summary.pendingHumanReviewCount}`,
          );
        }

        // 3. Leak scan over the verified artifacts.
        const findings = scanForLeaks([
          ...reports.map((report) => ({ name: report.name, content: report.raw })),
          { name: "release-manifest", content: baselineRaw },
        ]);
        assertNoLeaks(findings);
        console.log("leak scan: clean (credentials / non-synthetic child refs)");
      })().catch((error: unknown) => {
        fail([error instanceof Error ? error.message : "verify failed"]);
      });
      return;
    }

    case "scan-leaks": {
      const files: string[] = [];
      for (let index = 0; index < rest.length; index += 2) {
        if (rest[index] === "--file" && rest[index + 1] !== undefined) {
          files.push(rest[index + 1] as string);
        }
      }
      if (files.length === 0) {
        fail(["scan-leaks requires at least one --file <path>"]);
      }
      const entries = files.map((file) => ({ name: file, content: readFileSync(file, "utf8") }));
      const findings = scanForLeaks(entries);
      try {
        assertNoLeaks(findings);
        console.log(`leak scan: clean (${files.length} artifact(s))`);
      } catch (error) {
        fail(error instanceof ReleaseGateError ? error.problems : ["leak scan failed"]);
      }
      return;
    }

    default:
      fail([`unknown command '${command}'`]);
  }
}

main();
