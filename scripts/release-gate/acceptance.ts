/**
 * E2E-12 (issue #62) first-product acceptance registry verifier.
 *
 * `release/release-candidate.json` is the machine-checkable half of the
 * first-product acceptance gate (the human half is deploy/xiaozhi/runbook.md
 * §15): it freezes the v1 product scope, registers per-DoD evidence with an
 * explicit automated/human surface split, and encodes the release discipline
 * as structural invariants:
 *
 *   - automated evidence must point at REAL repo artifacts (gate workflow +
 *     proof files) that exist on disk — no unverifiable claims;
 *   - human evidence (real-device runs, independent acceptor judgment) is
 *     `pending` until actually executed — the registry cannot proxy-PASS a
 *     physical item, and a `pending` decision forbids any recorded row;
 *   - a Go decision requires the independent acceptor record with per-
 *     dimension verdicts (technical safety, product experience, privacy/
 *     authorization, professional skills, operations, rollback) and every
 *     human evidence row recorded — failed must-items cannot be downgraded
 *     to prose;
 *   - a created release requires the Go decision AND an explicit user
 *     approval record — `requiresExplicitUserApproval` is a hard constant
 *     (issue 实现范围 6: 不在本串行 Issue 流中绕过用户发版偏好).
 *
 * Every state transition of this registry is a code change: a reviewed PR
 * plus the full CI regression (same discipline as the evidence/skill
 * registries). Parsing is fail-closed: unknown keys, unknown enums, missing
 * coverage and dangling artifact references all block.
 *
 * This is a CI-side script: node builtins are allowed here (scripts are
 * outside the lib/domain boundary enforced by tests/domain/boundary.spec.ts).
 */

import { ReleaseGateError } from "./verify.ts";

export const RELEASE_CANDIDATE_SCHEMA_VERSION = "1.0" as const;

/** The six independent-acceptor Go/No-Go dimensions (issue 实现范围 3). */
export const ACCEPTANCE_DIMENSIONS = Object.freeze([
  "technical_safety",
  "product_experience",
  "privacy_authorization",
  "professional_skills",
  "operations",
  "rollback",
] as const);

export type AcceptanceDimension = (typeof ACCEPTANCE_DIMENSIONS)[number];

export type EvidenceSurface = "automated" | "human";
export type EvidenceStatus = "proven" | "pending" | "recorded";
export type AcceptanceDecision = "pending" | "go" | "no-go";
export type ReleaseState = "not_created" | "created";
export type ImplementationStatus = "delivered_this_pr" | "pending_human_execution";

export interface ScopedItem {
  readonly id: string;
  readonly item: string;
  readonly reason?: string;
}

export interface ImplementationScopeItem {
  readonly id: string;
  readonly item: string;
  readonly status: ImplementationStatus;
  readonly pointer: string;
}

export interface AcceptanceCriterion {
  readonly id: string;
  readonly statement: string;
}

export interface EvidenceRow {
  readonly id: string;
  readonly covers: readonly string[];
  readonly surface: EvidenceSurface;
  readonly status: EvidenceStatus;
  /** automated only: the CI gate that continuously proves this surface. */
  readonly gate?: string;
  /** automated only: repo paths (tests/scripts/probes/docs) backing the row. */
  readonly proof?: readonly string[];
  /** human only: the runbook protocol that must be executed to record it. */
  readonly protocol?: string;
  /** human only, required once recorded: where the executed record lives. */
  readonly evidenceRef?: string;
  readonly note: string;
}

export interface GoNoGoRecord {
  readonly decidedBy: string;
  readonly decidedAt: string;
  readonly verdicts: Readonly<Record<AcceptanceDimension, "go" | "no-go">>;
  /** Non-empty only for no-go (or a go-with-conditions, which blocks). */
  readonly blockedItems: readonly string[];
  /** Where the decision evidence lives (issue comment / records). */
  readonly evidenceUrls: readonly string[];
}

export interface UserApproval {
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly approvalRef: string;
}

export interface ReleaseRecord {
  /** The tag or release URL, present only after the user-approved release. */
  readonly ref: string;
  readonly createdAt: string;
}

export interface ReleaseCandidate {
  readonly schemaVersion: typeof RELEASE_CANDIDATE_SCHEMA_VERSION;
  readonly issue: string;
  readonly candidate: Readonly<{ readonly version: string; readonly assembledAt: string }>;
  readonly productScope: Readonly<{
    readonly frozen: true;
    readonly frozenAt: string;
    readonly inScope: readonly ScopedItem[];
    readonly excluded: readonly ScopedItem[];
  }>;
  readonly implementationScope: readonly ImplementationScopeItem[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly evidence: readonly EvidenceRow[];
  readonly goNoGo: Readonly<{
    readonly decision: AcceptanceDecision;
    readonly dimensions: readonly AcceptanceDimension[];
    readonly record: GoNoGoRecord | null;
  }>;
  readonly release: Readonly<{
    readonly requiresExplicitUserApproval: true;
    readonly userApproval: UserApproval | null;
    readonly state: ReleaseState;
    readonly record: ReleaseRecord | null;
  }>;
}

export interface ReleaseCandidateContext {
  /** version from package.json — must equal candidate.version. */
  readonly packageVersion: string;
  /** app.version of the committed release manifest — must equal too. */
  readonly manifestAppVersion: string;
  /** Repo-relative artifact existence probe (wired to fs by the caller). */
  readonly artifactExists: (repoPath: string) => boolean;
}

const TOP_LEVEL_KEYS = Object.freeze([
  "schemaVersion",
  "issue",
  "candidate",
  "productScope",
  "implementationScope",
  "acceptanceCriteria",
  "evidence",
  "goNoGo",
  "release",
] as const);

const ISSUE_URL = "https://github.com/lybym/LumiThink/issues/62";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(problems: readonly string[]): never {
  throw new ReleaseGateError(problems);
}

/** Reject unknown keys at one object level (fail-closed parse). */
function checkKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  problems: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      problems.push(`${where}: unknown key '${key}' (fail-closed contract parse)`);
    }
  }
}

function asString(value: unknown, where: string, problems: string[]): string {
  if (typeof value !== "string" || value.length === 0) {
    problems.push(`${where}: must be a non-empty string`);
    return "";
  }
  return value;
}

function asStringArray(value: unknown, where: string, problems: string[]): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    problems.push(`${where}: must be a non-empty array of non-empty strings`);
    return [];
  }
  return value as readonly string[];
}

function parseScopedItems(value: unknown, where: string, problems: string[]): readonly ScopedItem[] {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push(`${where}: must be a non-empty array`);
    return [];
  }
  const items: ScopedItem[] = [];
  for (const [index, entry] of value.entries()) {
    const itemWhere = `${where}[${index}]`;
    if (!isRecord(entry)) {
      problems.push(`${itemWhere}: must be an object`);
      continue;
    }
    checkKeys(entry, ["id", "item", "reason"], itemWhere, problems);
    items.push({
      id: asString(entry.id, `${itemWhere}.id`, problems),
      item: asString(entry.item, `${itemWhere}.item`, problems),
      ...(entry.reason !== undefined ? { reason: asString(entry.reason, `${itemWhere}.reason`, problems) } : {}),
    });
  }
  return items;
}

function parseEvidenceRow(value: unknown, where: string, problems: string[]): EvidenceRow | null {
  if (!isRecord(value)) {
    problems.push(`${where}: must be an object`);
    return null;
  }
  checkKeys(value, ["id", "covers", "surface", "status", "gate", "proof", "protocol", "evidenceRef", "note"], where, problems);
  const surface = asString(value.surface, `${where}.surface`, problems);
  if (surface !== "automated" && surface !== "human") {
    problems.push(`${where}.surface: unknown surface (must be automated|human)`);
  }
  const status = asString(value.status, `${where}.status`, problems);
  if (status !== "proven" && status !== "pending" && status !== "recorded") {
    problems.push(`${where}.status: unknown status (must be proven|pending|recorded)`);
  }
  const row: EvidenceRow = {
    id: asString(value.id, `${where}.id`, problems),
    covers: asStringArray(value.covers, `${where}.covers`, problems),
    surface: surface as EvidenceSurface,
    status: status as EvidenceStatus,
    ...(value.gate !== undefined ? { gate: asString(value.gate, `${where}.gate`, problems) } : {}),
    ...(value.proof !== undefined ? { proof: asStringArray(value.proof, `${where}.proof`, problems) } : {}),
    ...(value.protocol !== undefined ? { protocol: asString(value.protocol, `${where}.protocol`, problems) } : {}),
    ...(value.evidenceRef !== undefined ? { evidenceRef: asString(value.evidenceRef, `${where}.evidenceRef`, problems) } : {}),
    note: asString(value.note, `${where}.note`, problems),
  };
  return row;
}

function parseGoNoGoRecord(value: unknown, where: string, problems: string[]): GoNoGoRecord | null {
  if (!isRecord(value)) {
    problems.push(`${where}: must be an object when present`);
    return null;
  }
  checkKeys(value, ["decidedBy", "decidedAt", "verdicts", "blockedItems", "evidenceUrls"], where, problems);
  const decidedBy = asString(value.decidedBy, `${where}.decidedBy`, problems);
  const decidedAt = asString(value.decidedAt, `${where}.decidedAt`, problems);
  if (!isRecord(value.verdicts)) {
    problems.push(`${where}.verdicts: must be an object`);
  }
  const verdicts: Partial<Record<AcceptanceDimension, "go" | "no-go">> = {};
  if (isRecord(value.verdicts)) {
    checkKeys(value.verdicts, ACCEPTANCE_DIMENSIONS, `${where}.verdicts`, problems);
    for (const dimension of ACCEPTANCE_DIMENSIONS) {
      const verdict = value.verdicts[dimension];
      if (verdict !== "go" && verdict !== "no-go") {
        problems.push(`${where}.verdicts.${dimension}: must be 'go' or 'no-go'`);
        continue;
      }
      verdicts[dimension] = verdict;
    }
  }
  const blockedItems = Array.isArray(value.blockedItems)
    ? (value.blockedItems as readonly string[])
    : (() => {
        problems.push(`${where}.blockedItems: must be an array (possibly empty)`);
        return [];
      })();
  return {
    decidedBy,
    decidedAt,
    verdicts: verdicts as GoNoGoRecord["verdicts"],
    blockedItems,
    evidenceUrls: asStringArray(value.evidenceUrls, `${where}.evidenceUrls`, problems),
  };
}

/**
 * Parse the registry fail-closed (shape only) and then enforce the
 * acceptance/release discipline invariants against the caller context.
 * Throws ReleaseGateError listing every problem (value-free).
 */
export function verifyReleaseCandidate(raw: string, context: ReleaseCandidateContext): ReleaseCandidate {
  const problems: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(["release-candidate.json is not valid JSON"]);
  }
  if (!isRecord(parsed)) {
    fail(["release-candidate.json: must be a JSON object"]);
  }
  checkKeys(parsed, TOP_LEVEL_KEYS, "release-candidate", problems);

  const schemaVersion = parsed.schemaVersion;
  if (schemaVersion !== RELEASE_CANDIDATE_SCHEMA_VERSION) {
    problems.push(`release-candidate.schemaVersion: must be '${RELEASE_CANDIDATE_SCHEMA_VERSION}'`);
  }
  const issue = asString(parsed.issue, "release-candidate.issue", problems);
  if (issue.length > 0 && issue !== ISSUE_URL) {
    problems.push(`release-candidate.issue: must be ${ISSUE_URL}`);
  }

  // -- candidate ------------------------------------------------------------
  const candidateWhere = "release-candidate.candidate";
  if (!isRecord(parsed.candidate)) {
    problems.push(`${candidateWhere}: must be an object`);
  }
  const candidate = isRecord(parsed.candidate) ? parsed.candidate : {};
  checkKeys(candidate, ["version", "assembledAt"], candidateWhere, problems);
  const candidateVersion = asString(candidate.version, `${candidateWhere}.version`, problems);
  asString(candidate.assembledAt, `${candidateWhere}.assembledAt`, problems);

  // -- productScope ----------------------------------------------------------
  const scopeWhere = "release-candidate.productScope";
  if (!isRecord(parsed.productScope)) {
    problems.push(`${scopeWhere}: must be an object`);
  }
  const scope = isRecord(parsed.productScope) ? parsed.productScope : {};
  checkKeys(scope, ["frozen", "frozenAt", "inScope", "excluded"], scopeWhere, problems);
  if (scope.frozen !== true) {
    problems.push(`${scopeWhere}.frozen: the v1 product scope must be explicitly frozen (true)`);
  }
  asString(scope.frozenAt, `${scopeWhere}.frozenAt`, problems);
  const inScope = parseScopedItems(scope.inScope, `${scopeWhere}.inScope`, problems);
  const excluded = parseScopedItems(scope.excluded, `${scopeWhere}.excluded`, problems);
  const scopeIds = new Set<string>();
  for (const [list, label] of [
    [inScope, "inScope"],
    [excluded, "excluded"],
  ] as const) {
    for (const item of list) {
      if (scopeIds.has(item.id)) {
        problems.push(`${scopeWhere}.${label}: duplicate scope id '${item.id}'`);
      }
      scopeIds.add(item.id);
    }
  }

  // -- implementationScope ----------------------------------------------------
  const implWhere = "release-candidate.implementationScope";
  const implRaw = Array.isArray(parsed.implementationScope) ? parsed.implementationScope : [];
  if (implRaw.length === 0) {
    problems.push(`${implWhere}: must be a non-empty array`);
  }
  const implIds = new Set<string>();
  const implementationScope: ImplementationScopeItem[] = [];
  for (const [index, entry] of implRaw.entries()) {
    const itemWhere = `${implWhere}[${index}]`;
    if (!isRecord(entry)) {
      problems.push(`${itemWhere}: must be an object`);
      continue;
    }
    checkKeys(entry, ["id", "item", "status", "pointer"], itemWhere, problems);
    const status = asString(entry.status, `${itemWhere}.status`, problems);
    if (status !== "delivered_this_pr" && status !== "pending_human_execution") {
      problems.push(`${itemWhere}.status: unknown implementation status`);
    }
    const pointer = asString(entry.pointer, `${itemWhere}.pointer`, problems);
    if (status === "pending_human_execution" && pointer.length === 0) {
      problems.push(`${itemWhere}.pointer: pending items must point at the execution protocol`);
    }
    const id = asString(entry.id, `${itemWhere}.id`, problems);
    if (implIds.has(id)) {
      problems.push(`${implWhere}: duplicate implementation id '${id}'`);
    }
    implIds.add(id);
    implementationScope.push({
      id,
      item: asString(entry.item, `${itemWhere}.item`, problems),
      status: status as ImplementationStatus,
      pointer,
    });
  }

  // -- acceptanceCriteria ------------------------------------------------------
  const acWhere = "release-candidate.acceptanceCriteria";
  const acRaw = Array.isArray(parsed.acceptanceCriteria) ? parsed.acceptanceCriteria : [];
  if (acRaw.length === 0) {
    problems.push(`${acWhere}: must be a non-empty array (the DoD list)`);
  }
  const acIds = new Set<string>();
  for (const [index, entry] of acRaw.entries()) {
    const itemWhere = `${acWhere}[${index}]`;
    if (!isRecord(entry)) {
      problems.push(`${itemWhere}: must be an object`);
      continue;
    }
    checkKeys(entry, ["id", "statement"], itemWhere, problems);
    const id = asString(entry.id, `${itemWhere}.id`, problems);
    if (acIds.has(id)) {
      problems.push(`${acWhere}: duplicate criterion id '${id}'`);
    }
    acIds.add(id);
    asString(entry.statement, `${itemWhere}.statement`, problems);
  }

  // -- evidence -----------------------------------------------------------------
  const evidenceWhere = "release-candidate.evidence";
  const evidenceRaw = Array.isArray(parsed.evidence) ? parsed.evidence : [];
  if (evidenceRaw.length === 0) {
    problems.push(`${evidenceWhere}: must be a non-empty array`);
  }
  const evidence: EvidenceRow[] = [];
  const evidenceIds = new Set<string>();
  for (const [index, entry] of evidenceRaw.entries()) {
    const row = parseEvidenceRow(entry, `${evidenceWhere}[${index}]`, problems);
    if (row === null) {
      continue;
    }
    if (evidenceIds.has(row.id)) {
      problems.push(`${evidenceWhere}: duplicate evidence id '${row.id}'`);
    }
    evidenceIds.add(row.id);
    if (row.covers.length === 0) {
      problems.push(`${evidenceWhere}[${index}].covers: must reference at least one DoD id`);
    }
    for (const covered of row.covers) {
      if (!acIds.has(covered)) {
        problems.push(`${evidenceWhere}[${index}].covers: unknown DoD id (not registered)`);
      }
    }
    evidence.push(row);
  }

  // -- goNoGo ---------------------------------------------------------------------
  const decisionWhere = "release-candidate.goNoGo";
  if (!isRecord(parsed.goNoGo)) {
    problems.push(`${decisionWhere}: must be an object`);
  }
  const goNoGo = isRecord(parsed.goNoGo) ? parsed.goNoGo : {};
  checkKeys(goNoGo, ["decision", "dimensions", "record"], decisionWhere, problems);
  const decision = goNoGo.decision;
  if (decision !== "pending" && decision !== "go" && decision !== "no-go") {
    problems.push(`${decisionWhere}.decision: unknown decision (must be pending|go|no-go)`);
  }
  const dimensions = goNoGo.dimensions;
  const dimensionSet = new Set<string>(Array.isArray(dimensions) ? (dimensions as string[]) : []);
  if (dimensionSet.size !== ACCEPTANCE_DIMENSIONS.length || !ACCEPTANCE_DIMENSIONS.every((d) => dimensionSet.has(d))) {
    problems.push(`${decisionWhere}.dimensions: must list exactly the six acceptance dimensions`);
  }
  let record: GoNoGoRecord | null = null;
  if (goNoGo.record !== null && goNoGo.record !== undefined) {
    record = parseGoNoGoRecord(goNoGo.record, `${decisionWhere}.record`, problems);
  }

  // -- release ----------------------------------------------------------------------
  const releaseWhere = "release-candidate.release";
  if (!isRecord(parsed.release)) {
    problems.push(`${releaseWhere}: must be an object`);
  }
  const release = isRecord(parsed.release) ? parsed.release : {};
  checkKeys(release, ["requiresExplicitUserApproval", "userApproval", "state", "record"], releaseWhere, problems);
  if (release.requiresExplicitUserApproval !== true) {
    problems.push(
      `${releaseWhere}.requiresExplicitUserApproval: hard constant — a GitHub Release is never created without the user's explicit approval (issue 实现范围 6)`,
    );
  }
  if (release.state !== "not_created" && release.state !== "created") {
    problems.push(`${releaseWhere}.state: unknown release state`);
  }
  let userApproval: UserApproval | null = null;
  if (release.userApproval !== null && release.userApproval !== undefined) {
    if (!isRecord(release.userApproval)) {
      problems.push(`${releaseWhere}.userApproval: must be an object when present`);
    } else {
      checkKeys(release.userApproval, ["approvedBy", "approvedAt", "approvalRef"], `${releaseWhere}.userApproval`, problems);
      userApproval = {
        approvedBy: asString(release.userApproval.approvedBy, `${releaseWhere}.userApproval.approvedBy`, problems),
        approvedAt: asString(release.userApproval.approvedAt, `${releaseWhere}.userApproval.approvedAt`, problems),
        approvalRef: asString(release.userApproval.approvalRef, `${releaseWhere}.userApproval.approvalRef`, problems),
      };
    }
  }
  let releaseRecord: ReleaseRecord | null = null;
  if (release.record !== null && release.record !== undefined) {
    if (!isRecord(release.record)) {
      problems.push(`${releaseWhere}.record: must be an object when present`);
    } else {
      checkKeys(release.record, ["ref", "createdAt"], `${releaseWhere}.record`, problems);
      releaseRecord = {
        ref: asString(release.record.ref, `${releaseWhere}.record.ref`, problems),
        createdAt: asString(release.record.createdAt, `${releaseWhere}.record.createdAt`, problems),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Cross-field invariants (the discipline, structurally enforced).
  // ---------------------------------------------------------------------------
  const humanRows = evidence.filter((row) => row.surface === "human");
  const automatedRows = evidence.filter((row) => row.surface === "automated");

  // I1 — automated rows must be CI-proven and reference REAL artifacts.
  for (const [index, row] of automatedRows.entries()) {
    if (row.status !== "proven") {
      problems.push(`evidence[${index}] (${row.id}): automated rows must be status 'proven' (CI-proven)`);
    }
    if (row.gate === undefined || row.gate.length === 0) {
      problems.push(`evidence[${index}] (${row.id}): automated rows must name their CI gate workflow`);
    } else if (!context.artifactExists(row.gate)) {
      problems.push(`evidence[${index}] (${row.id}): gate workflow does not exist in the repo`);
    }
    if (row.proof === undefined || row.proof.length === 0) {
      problems.push(`evidence[${index}] (${row.id}): automated rows must list at least one proof path`);
    } else {
      for (const proof of row.proof) {
        if (!context.artifactExists(proof)) {
          problems.push(`evidence[${index}] (${row.id}): proof path does not exist in the repo`);
        }
      }
    }
  }

  // I2 — human rows: protocol while pending; evidenceRef once recorded.
  for (const [index, row] of humanRows.entries()) {
    if (row.status === "pending") {
      if (row.protocol === undefined || row.protocol.length === 0) {
        problems.push(`evidence[${index}] (${row.id}): pending human rows must name their execution protocol`);
      }
      if (row.evidenceRef !== undefined) {
        problems.push(`evidence[${index}] (${row.id}): a pending human row cannot carry an evidenceRef yet`);
      }
    } else if (row.status === "recorded") {
      if (row.evidenceRef === undefined || row.evidenceRef.length === 0) {
        problems.push(`evidence[${index}] (${row.id}): recorded human rows must carry their evidenceRef`);
      }
    } else {
      problems.push(`evidence[${index}] (${row.id}): human rows cannot be status 'proven' (CI cannot proxy-PASS a physical item)`);
    }
  }

  // I3 — coverage: every DoD id is covered by at least one evidence row.
  for (const criterionId of acIds) {
    if (!evidence.some((row) => row.covers.includes(criterionId))) {
      problems.push(`acceptanceCriteria: DoD id '${criterionId}' has no evidence row`);
    }
  }

  // I4 — a pending decision forbids any recorded human row (no proxy PASS).
  if (decision === "pending") {
    for (const [index, row] of humanRows.entries()) {
      if (row.status !== "pending") {
        problems.push(
          `evidence[${index}] (${row.id}): the acceptance decision is pending — human evidence must stay pending (record a reviewed decision first)`,
        );
      }
    }
    if (record !== null) {
      problems.push("goNoGo.record: must be null while the decision is pending");
    }
  }

  // I5 — a Go/No-Go decision requires the independent-acceptor record.
  if ((decision === "go" || decision === "no-go") && record === null) {
    problems.push("goNoGo.record: a go/no-go decision requires the independent-acceptor record");
  }
  if (record !== null) {
    const noGoCount = ACCEPTANCE_DIMENSIONS.filter((dimension) => record?.verdicts[dimension] === "no-go").length;
    if (decision === "go") {
      if (noGoCount > 0) {
        problems.push(`goNoGo: a Go decision with ${noGoCount} no-go dimension verdict(s) is not allowed — record no-go or resolve the failing items`);
      }
      if (record.blockedItems.length > 0) {
        problems.push("goNoGo: a Go decision cannot carry blockedItems — failed must-items cannot be downgraded to prose and released");
      }
      for (const [index, row] of humanRows.entries()) {
        if (row.status !== "recorded") {
          problems.push(`evidence[${index}] (${row.id}): a Go decision requires every human evidence row to be recorded`);
        }
      }
    }
    if (decision === "no-go" && noGoCount === 0 && record.blockedItems.length === 0) {
      problems.push("goNoGo: a no-go decision must cite at least one no-go dimension or blocked item");
    }
  }

  // I6 — release discipline.
  if (release.state === "created") {
    if (decision !== "go") {
      problems.push("release.state: a release cannot be created without the Go decision");
    }
    if (userApproval === null) {
      problems.push("release.state: a created release requires the recorded explicit user approval");
    }
    if (releaseRecord === null) {
      problems.push("release.state: a created release requires its release record (tag/URL)");
    }
  }
  if (userApproval !== null && decision !== "go") {
    problems.push("release.userApproval: user approval can only exist after the Go decision");
  }

  // I7 — version coherence (candidate ↔ package.json ↔ release manifest).
  if (candidateVersion.length > 0 && candidateVersion !== context.packageVersion) {
    problems.push(
      `candidate.version (${candidateVersion}) does not equal the package.json version (${context.packageVersion})`,
    );
  }
  if (candidateVersion.length > 0 && candidateVersion !== context.manifestAppVersion) {
    problems.push(
      `candidate.version (${candidateVersion}) does not equal the release manifest app.version (${context.manifestAppVersion})`,
    );
  }

  if (problems.length > 0) {
    fail(problems);
  }

  // The parse above proved every field; the casts below are the typed view.
  return parsed as unknown as ReleaseCandidate;
}
