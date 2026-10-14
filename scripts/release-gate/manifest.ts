/**
 * R1-10 (issue #22) release manifest builder.
 *
 * The release manifest is the version-lock record a release is audited
 * against: the application version, the declared toolchain, the evaluation
 * report schema + suite/subject versions, the domain policy versions, the
 * exact DSH plugin pins with both lockfile digests, the persistence-facts
 * (frozen prisma schema digest + runtime-snapshot format) and the deploy
 * artifact digests.
 *
 * Two distinct artifacts must not be confused:
 * - the COMMITTED baseline (`release/release-manifest.json`): built WITHOUT
 *   a commit field. It is the reviewed/approved version set. Any live drift
 *   (a version bump, a lockfile change, a schema/deploy edit) makes the
 *   gate fail closed until the manifest is consciously regenerated and
 *   re-reviewed — that is the manual acknowledgment step.
 * - the PER-RUN record: the same manifest plus `commit` (and produced only
 *   into CI's artifact space), tying the release evidence to an exact SHA.
 *   It is never committed (a commit field could never be stable).
 *
 * Every live value is IMPORTED from shipped code or digested from files —
 * nothing is hand-copied, so the manifest cannot silently lag the code.
 *
 * This is a CI-side script: node builtins are allowed here (scripts are
 * outside the lib/domain boundary enforced by tests/domain/boundary.spec.ts).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

import { canonicalJson, SUPPORTED_PROTOCOL_VERSIONS } from "../../lib/domain/contract/core.ts";
import { REGISTRIES_V0_VERSION } from "../../lib/domain/evidence/registry.ts";
import {
  EVAL_SUITE_V1,
  SYNTHETIC_REFERENCE_SUBJECT_ID,
  SYNTHETIC_REFERENCE_SUBJECT_VERSION,
} from "../../lib/domain/eval/index.ts";
import { GATEWAY_PROTOCOL_VERSION } from "../../lib/domain/gateway/gateway.ts";
import { CURRENT_GUARDIAN_DISCLOSURE_VERSION } from "../../lib/domain/guardian/authorizations.ts";
import { PERSONA_EVAL_SUITE_V1 } from "../../lib/domain/persona/eval-suite.ts";
import {
  PERSONA_EVAL_SUBJECT_ID,
  PERSONA_EVAL_SUBJECT_VERSION,
} from "../../lib/domain/persona/eval-subject.ts";
import { PERSONA_REGISTRY_V0_VERSION } from "../../lib/domain/persona/registry.ts";
import { SAFETY_POLICY_VERSIONS } from "../../lib/domain/safety/policy.ts";
import {
  EMOTION_SKILL_EVAL_SUBJECT_VERSION,
  createEmotionSkillEvalSubject,
} from "../../lib/domain/skills/emotion-eval-subject.ts";
import {
  EMOTION_SKILL_EVAL_SUITE_VERSION,
  deriveEmotionSkillEvalSuite,
} from "../../lib/domain/skills/emotion-eval-suite.ts";
import {
  HOMEWORK_SKILL_EVAL_SUBJECT_VERSION,
  createHomeworkSkillEvalSubject,
} from "../../lib/domain/skills/homework-eval-subject.ts";
import {
  HOMEWORK_SKILL_EVAL_SUITE_VERSION,
  deriveHomeworkSkillEvalSuite,
} from "../../lib/domain/skills/homework-eval-suite.ts";
import { RUNTIME_PIPELINE_VERSION } from "../../lib/domain/runtime/pipeline.ts";
import { SKILL_ROUTER_VERSION } from "../../lib/domain/runtime/skill-router.ts";
import { RUNTIME_SNAPSHOT_FORMAT } from "../../lib/server/snapshot/runtime-snapshot.ts";

/** Repo-root-relative paths digested into the manifest. */
const ROOT_LOCKFILE = "pnpm-lock.yaml";
const POC_LOCKFILE = "poc/dsh-child/pnpm-lock.yaml";
const POC_PACKAGE = "poc/dsh-child/package.json";
const PRISMA_SCHEMA = "prisma/schema.prisma";

const DEPLOY_ARTIFACTS = Object.freeze([
  "deploy/backup.sh",
  "deploy/restore.sh",
  "deploy/start.sh",
  "deploy/healthcheck.sh",
  "deploy/lumithink.service",
  "deploy/caddy/Caddyfile",
] as const);

/** Every top-level key of the manifest (fail-closed parsing/updating). */
export const RELEASE_MANIFEST_KEYS = Object.freeze([
  "manifestSchemaVersion",
  "app",
  "toolchain",
  "eval",
  "domain",
  "dsh",
  "persistence",
  "deploy",
  "commit",
] as const);

export const RELEASE_MANIFEST_SCHEMA_VERSION = "1.0" as const;

export interface ReleaseManifest {
  readonly manifestSchemaVersion: typeof RELEASE_MANIFEST_SCHEMA_VERSION;
  readonly app: Readonly<{ readonly name: string; readonly version: string }>;
  /** Declared (repo-pinned) toolchain requirements — machine-independent. */
  readonly toolchain: Readonly<{ readonly node: string; readonly pnpm: string }>;
  readonly eval: Readonly<{
    readonly reportSchemaVersion: string;
    readonly suites: Readonly<Record<string, string>>;
    readonly subjects: Readonly<Record<string, string>>;
  }>;
  readonly domain: Readonly<{
    readonly safetyPolicyVersion: string;
    readonly protocolVersion: string;
    readonly personaRegistryVersion: string;
    readonly registriesVersion: string;
    readonly skillRouterVersion: string;
    readonly runtimePipelineVersion: string;
    readonly gatewayProtocolVersion: string;
    readonly guardianDisclosureVersion: string;
  }>;
  readonly dsh: Readonly<{
    readonly packages: Readonly<Record<string, string>>;
    readonly rootLockSha256: string;
    readonly pocLockSha256: string;
  }>;
  readonly persistence: Readonly<{
    readonly prismaSchemaSha256: string;
    readonly runtimeSnapshotFormat: string;
  }>;
  readonly deploy: Readonly<{ readonly artifacts: Readonly<Record<string, string>> }>;
  /** Per-run only; the committed baseline never carries it. */
  readonly commit?: string;
}

async function sha256File(relativePath: string): Promise<string> {
  const bytes = await readFile(new URL(`../../${relativePath}`, import.meta.url));
  return createHash("sha256").update(bytes).digest("hex");
}

/** Read the exact DSH plugin pins from the R0 PoC package manifest. */
async function readDshPins(): Promise<Readonly<Record<string, string>>> {
  const raw = await readFile(new URL(`../../${POC_PACKAGE}`, import.meta.url), "utf8");
  const parsed = JSON.parse(raw) as { dependencies?: Record<string, string> };
  const pins: Record<string, string> = {};
  for (const [name, version] of Object.entries(parsed.dependencies ?? {})) {
    if (name.startsWith("@deepseek-ai/")) {
      pins[name] = version;
    }
  }
  if (Object.keys(pins).length === 0) {
    throw new Error("no @deepseek-ai/* pins found in poc/dsh-child/package.json");
  }
  return Object.freeze(pins);
}

interface RootPackageFacts {
  readonly name: string;
  readonly version: string;
  readonly packageManager: string;
  readonly enginesNode: string;
}

/** Read the small, stable root package facts (synchronous on purpose). */
function readRootPackage(): RootPackageFacts {
  const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw) as {
    name?: string;
    version?: string;
    packageManager?: string;
    engines?: { node?: string };
  };
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    throw new Error("package.json is missing a name");
  }
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json is missing a version");
  }
  if (typeof parsed.packageManager !== "string" || !parsed.packageManager.startsWith("pnpm@")) {
    throw new Error("package.json must pin the package manager (pnpm@x.y.z)");
  }
  return {
    name: parsed.name,
    version: parsed.version,
    packageManager: parsed.packageManager,
    enginesNode: parsed.engines?.node ?? "unspecified",
  };
}

/**
 * Build the live release manifest from shipped code and on-disk facts.
 * `commit` is only set for the per-run record — the committed baseline is
 * built without it.
 */
export async function buildReleaseManifest(
  options: { readonly commit?: string } = {},
): Promise<ReleaseManifest> {
  const rootPackage = readRootPackage();
  const pnpmVersion = rootPackage.packageManager.slice("pnpm@".length);

  const emotionSuite = deriveEmotionSkillEvalSuite();
  const homeworkSuite = deriveHomeworkSkillEvalSuite();
  const emotionSubject = createEmotionSkillEvalSubject();
  const homeworkSubject = createHomeworkSkillEvalSubject();
  // Registry-resolved subject versions (never self-declared at build time).
  const subjectVersions: Record<string, string> = {
    [SYNTHETIC_REFERENCE_SUBJECT_ID]: SYNTHETIC_REFERENCE_SUBJECT_VERSION,
    [PERSONA_EVAL_SUBJECT_ID]: PERSONA_EVAL_SUBJECT_VERSION,
    [emotionSubject.subjectId]: emotionSubject.subjectVersion,
    [homeworkSubject.subjectId]: homeworkSubject.subjectVersion,
  };

  const [rootLockSha256, pocLockSha256, prismaSchemaSha256] = await Promise.all([
    sha256File(ROOT_LOCKFILE),
    sha256File(POC_LOCKFILE),
    sha256File(PRISMA_SCHEMA),
  ]);
  const deployEntries = await Promise.all(
    DEPLOY_ARTIFACTS.map(
      async (artifact) => [artifact, await sha256File(artifact)] as const,
    ),
  );

  const safetyPolicyVersion = SAFETY_POLICY_VERSIONS[SAFETY_POLICY_VERSIONS.length - 1];
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1];

  const manifest: ReleaseManifest = {
    manifestSchemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    app: { name: rootPackage.name, version: rootPackage.version },
    toolchain: { node: rootPackage.enginesNode, pnpm: pnpmVersion },
    eval: {
      reportSchemaVersion: "1.1",
      suites: {
        [EVAL_SUITE_V1.suiteId]: EVAL_SUITE_V1.suiteVersion,
        [PERSONA_EVAL_SUITE_V1.suiteId]: PERSONA_EVAL_SUITE_V1.suiteVersion,
        [emotionSuite.suiteId]: emotionSuite.suiteVersion,
        [homeworkSuite.suiteId]: homeworkSuite.suiteVersion,
      },
      subjects: subjectVersions,
    },
    domain: {
      safetyPolicyVersion,
      protocolVersion,
      personaRegistryVersion: PERSONA_REGISTRY_V0_VERSION,
      registriesVersion: REGISTRIES_V0_VERSION,
      skillRouterVersion: SKILL_ROUTER_VERSION,
      runtimePipelineVersion: RUNTIME_PIPELINE_VERSION,
      gatewayProtocolVersion: GATEWAY_PROTOCOL_VERSION,
      guardianDisclosureVersion: CURRENT_GUARDIAN_DISCLOSURE_VERSION,
    },
    dsh: {
      packages: await readDshPins(),
      rootLockSha256,
      pocLockSha256,
    },
    persistence: {
      prismaSchemaSha256,
      runtimeSnapshotFormat: RUNTIME_SNAPSHOT_FORMAT,
    },
    deploy: { artifacts: Object.fromEntries(deployEntries) },
    ...(options.commit !== undefined ? { commit: options.commit } : {}),
  };
  return manifest;
}

/** Canonical (byte-stable) serialization of the manifest. */
export function serializeReleaseManifest(manifest: ReleaseManifest): string {
  return canonicalJson(manifest as unknown as Record<string, unknown>);
}
