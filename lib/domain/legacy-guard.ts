/**
 * R1-00 legacy domain guard — the single intake boundary for the new
 * LumiThink 2.0 domain model (lib/domain/).
 *
 * The 1.x prototype persisted `CognitiveProfile` records with four uncalibrated
 * capability scores (number sense / spatial / logic / strategy) plus a free
 * diagnosis summary, and `RawEvent` records with arbitrary JSON payloads, in
 * prisma/schema.prisma. Per docs/PRD.md §7/§13 and docs/ROADMAP.md (R0 freeze,
 * R2 migration rules), those legacy shapes must never silently become facts of
 * the new domain model:
 *
 * - Uncalibrated float capability scores must not be copied into the new model.
 * - Raw event payloads may contain child content and must not be copied.
 * - Legacy data may only be carried over through the explicit migration
 *   helpers in this module, which preserve provenance while dropping scores
 *   and payload contents, and which require an explicit acknowledgement.
 *
 * This module itself must stay dependency-free (no prisma, no react, no next
 * imports) — enforced by tests/domain/boundary.spec.ts — so that the domain
 * boundary cannot be bypassed by importing persistence or framework layers.
 */

/** Field names of the frozen legacy `CognitiveProfile` capability scores. */
export const LEGACY_COGNITIVE_PROFILE_SCORE_KEYS = [
  "numberSenseScore",
  "spatialScore",
  "logicScore",
  "strategyScore",
] as const;

export type LegacyCognitiveProfileScoreKey =
  (typeof LEGACY_COGNITIVE_PROFILE_SCORE_KEYS)[number];

/** Event types of the frozen legacy `RawEvent` enum. */
export const LEGACY_RAW_EVENT_TYPES = [
  "PARENT_UPLOAD",
  "KID_INTERACTION_TRACE",
  "LLM_EVALUATION",
  "PROFILE_SNAPSHOT",
] as const;

export type LegacyRawEventType = (typeof LEGACY_RAW_EVENT_TYPES)[number];

/** Shape of a frozen legacy `CognitiveProfile` record (scores may be absent). */
export interface LegacyCognitiveProfileRecord {
  childId?: unknown;
  numberSenseScore?: unknown;
  spatialScore?: unknown;
  logicScore?: unknown;
  strategyScore?: unknown;
  latestDiagnosisSummary?: unknown;
  [key: string]: unknown;
}

/** Shape of a frozen legacy `RawEvent` record. */
export interface LegacyRawEventRecord {
  eventType?: unknown;
  payload?: unknown;
  [key: string]: unknown;
}

export type LegacyShapeName = "CognitiveProfile" | "RawEvent";

export class LegacyDomainIntakeError extends Error {
  readonly legacyShape: LegacyShapeName;
  /** Location of the offending value inside the submitted fact. */
  readonly path: string;

  constructor(legacyShape: LegacyShapeName, path: string) {
    super(
      `Legacy ${legacyShape} record rejected at "${path}": legacy capability scores / raw event payloads cannot enter the new domain model without explicit migration (docs/LEGACY_AUDIT.md).`,
    );
    this.name = "LegacyDomainIntakeError";
    this.legacyShape = legacyShape;
    this.path = path;
  }
}

export class LegacyMigrationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyMigrationRefusedError";
  }
}

/**
 * Structural detection of a legacy `CognitiveProfile` record: at least one
 * numeric capability score, or a diagnosis summary. The new domain model uses
 * a different vocabulary (claim/source/observedAt), so false positives are
 * not expected.
 */
export function isLegacyCognitiveProfileRecord(
  value: unknown,
): value is LegacyCognitiveProfileRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const hasScore = LEGACY_COGNITIVE_PROFILE_SCORE_KEYS.some(
    (key) => typeof record[key] === "number",
  );
  if (hasScore) {
    return true;
  }
  return (
    "latestDiagnosisSummary" in record &&
    typeof record.latestDiagnosisSummary === "string"
  );
}

/** Structural detection of a legacy `RawEvent` record. */
export function isLegacyRawEventRecord(
  value: unknown,
): value is LegacyRawEventRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    LEGACY_RAW_EVENT_TYPES.includes(record.eventType as LegacyRawEventType) &&
    "payload" in record
  );
}

const MAX_INTAKE_SCAN_DEPTH = 16;

function walkForLegacyShapes(
  value: unknown,
  path: string,
  seen: Set<object>,
  depth: number,
): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (isLegacyCognitiveProfileRecord(value)) {
    throw new LegacyDomainIntakeError("CognitiveProfile", path);
  }
  if (isLegacyRawEventRecord(value)) {
    throw new LegacyDomainIntakeError("RawEvent", path);
  }
  if (depth >= MAX_INTAKE_SCAN_DEPTH) {
    throw new Error(
      `Domain intake scan exceeded ${MAX_INTAKE_SCAN_DEPTH} nesting levels at "${path}"`,
    );
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      walkForLegacyShapes(item, `${path}[${index}]`, seen, depth + 1);
    });
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    walkForLegacyShapes(item, `${path}.${key}`, seen, depth + 1);
  }
}

/**
 * Deep scan a candidate domain fact and reject it if any nested value carries
 * a legacy CognitiveProfile or RawEvent shape. Every future domain ingestion
 * path must call this (directly or via `ingestDomainFact`).
 */
export function assertFreeOfLegacyShapes(value: unknown, path = "value"): void {
  walkForLegacyShapes(value, path, new Set<object>(), 0);
}

function deepFreeze<T>(value: T, seen: Set<object>): T {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const item of Object.values(value as Record<string, unknown>)) {
    deepFreeze(item, seen);
  }
  return Object.freeze(value);
}

/**
 * Admit a new-domain fact through the guarded intake. Legacy shapes are
 * rejected; admitted facts are returned deeply frozen so callers cannot
 * mutate an already-ingested fact.
 */
export function ingestDomainFact<T>(fact: T): Readonly<T> {
  assertFreeOfLegacyShapes(fact, "domainFact");
  return deepFreeze(fact, new Set<object>()) as Readonly<T>;
}

export interface LegacyMigrationAcknowledgement {
  /** Must be literally `true` — forces an explicit, reviewed opt-in. */
  readonly acknowledgeLegacyScoresDrop: true;
  /** Person or service performing the migration. Must not be a child id. */
  readonly actor: string;
  /** Why this legacy record is being migrated at all. */
  readonly reason: string;
}

export interface LegacyProfileArchive {
  readonly legacySource: "prisma.CognitiveProfile";
  /** Pseudonymous reference to the legacy child record; never a real identity. */
  readonly childRef: string;
  readonly archivedAt: string;
  readonly provenance: {
    readonly migration: "r1-00-legacy-guard@1";
    readonly sourceSchema: "prisma/schema.prisma (frozen legacy schema)";
    readonly actor: string;
    readonly reason: string;
  };
  /** Names of the legacy fields that were present and deliberately dropped. */
  readonly droppedFields: readonly string[];
  readonly note: "Uncalibrated capability scores and the free-text diagnosis summary are intentionally dropped; none of them are copied into the new domain model.";
}

export interface LegacyRawEventArchive {
  readonly legacySource: "prisma.RawEvent";
  readonly archivedAt: string;
  readonly provenance: {
    readonly migration: "r1-00-legacy-guard@1";
    readonly sourceSchema: "prisma/schema.prisma (frozen legacy schema)";
    readonly actor: string;
    readonly reason: string;
  };
  readonly eventCount: number;
  readonly eventTypeCounts: Readonly<Partial<Record<LegacyRawEventType, number>>>;
  readonly payloadContentsCopied: false;
  readonly note: "Raw event payloads may contain child content; only per-type counts are preserved.";
}

function assertAcknowledged(ack: LegacyMigrationAcknowledgement): void {
  if (
    typeof ack !== "object" ||
    ack === null ||
    ack.acknowledgeLegacyScoresDrop !== true
  ) {
    throw new LegacyMigrationRefusedError(
      "Legacy migration refused: acknowledgeLegacyScoresDrop must be literally true (explicit opt-in required).",
    );
  }
  if (typeof ack.actor !== "string" || ack.actor.trim() === "") {
    throw new LegacyMigrationRefusedError(
      "Legacy migration refused: a non-empty actor is required.",
    );
  }
  if (typeof ack.reason !== "string" || ack.reason.trim() === "") {
    throw new LegacyMigrationRefusedError(
      "Legacy migration refused: a non-empty reason is required.",
    );
  }
}

const ARCHIVE_PROVENANCE_SCHEMA =
  "prisma/schema.prisma (frozen legacy schema)" as const;

/**
 * Explicit migration of one legacy `CognitiveProfile` record into an archived
 * provenance artifact. Capability scores and the diagnosis summary are
 * dropped, not copied. The produced archive is self-checked against the same
 * intake guard used for new facts.
 */
export function archiveLegacyCognitiveProfile(
  record: LegacyCognitiveProfileRecord,
  ack: LegacyMigrationAcknowledgement,
): Readonly<LegacyProfileArchive> {
  assertAcknowledged(ack);
  if (typeof record?.childId !== "string" || record.childId.trim() === "") {
    throw new LegacyMigrationRefusedError(
      "Legacy CognitiveProfile migration refused: record is missing a non-empty string childId.",
    );
  }

  const droppedFields: string[] = [];
  for (const key of LEGACY_COGNITIVE_PROFILE_SCORE_KEYS) {
    if (typeof record[key] === "number") {
      droppedFields.push(key);
    }
  }
  if (
    "latestDiagnosisSummary" in record &&
    typeof record.latestDiagnosisSummary === "string"
  ) {
    droppedFields.push("latestDiagnosisSummary");
  }

  const archive: LegacyProfileArchive = {
    legacySource: "prisma.CognitiveProfile",
    childRef: record.childId,
    archivedAt: new Date().toISOString(),
    provenance: {
      migration: "r1-00-legacy-guard@1",
      sourceSchema: ARCHIVE_PROVENANCE_SCHEMA,
      actor: ack.actor,
      reason: ack.reason,
    },
    droppedFields,
    note: "Uncalibrated capability scores and the free-text diagnosis summary are intentionally dropped; none of them are copied into the new domain model.",
  };

  // Self-check: the archive must itself pass the guarded intake.
  assertFreeOfLegacyShapes(archive, "legacyProfileArchive");
  return deepFreeze(archive, new Set<object>());
}

/**
 * Explicit migration of legacy `RawEvent` records into a counts-only archive.
 * Payload contents are never copied. Non-conforming entries fail closed and
 * the error never echoes entry content.
 */
export function archiveLegacyRawEvents(
  events: readonly LegacyRawEventRecord[],
  ack: LegacyMigrationAcknowledgement,
): Readonly<LegacyRawEventArchive> {
  assertAcknowledged(ack);
  const eventTypeCounts: Partial<Record<LegacyRawEventType, number>> = {};
  let eventCount = 0;

  events.forEach((event, index) => {
    if (!isLegacyRawEventRecord(event) || typeof event.payload !== "object") {
      throw new LegacyMigrationRefusedError(
        `Legacy RawEvent migration refused: entry at index ${index} is not a conforming legacy RawEvent record.`,
      );
    }
    eventCount += 1;
    const eventType = event.eventType as LegacyRawEventType;
    eventTypeCounts[eventType] = (eventTypeCounts[eventType] ?? 0) + 1;
  });

  const archive: LegacyRawEventArchive = {
    legacySource: "prisma.RawEvent",
    archivedAt: new Date().toISOString(),
    provenance: {
      migration: "r1-00-legacy-guard@1",
      sourceSchema: ARCHIVE_PROVENANCE_SCHEMA,
      actor: ack.actor,
      reason: ack.reason,
    },
    eventCount,
    eventTypeCounts,
    payloadContentsCopied: false,
    note: "Raw event payloads may contain child content; only per-type counts are preserved.",
  };

  // Self-check: the archive must itself pass the guarded intake.
  assertFreeOfLegacyShapes(archive, "legacyRawEventArchive");
  return deepFreeze(archive, new Set<object>());
}
