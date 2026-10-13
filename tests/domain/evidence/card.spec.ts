import assert from "node:assert/strict";
import test from "node:test";

import { ContractValidationError } from "../../../lib/domain/contract/core.ts";
import {
  EVIDENCE_AI_TRANSFER_BOUNDARIES,
  EVIDENCE_REGISTRY_V0,
  parseEvidenceCardV0,
} from "../../../lib/domain/evidence/index.ts";

/**
 * R1-13 Evidence Card v0 schema tests (issue #25 交付范围 1): the card
 * carries source_url / citation info, research design, subjects & age,
 * 适用/禁忌, limitations, update time, human review status and version —
 * all fail-closed. The anti-inference guard is a schema property: no
 * registered enum value can register an "AI efficacy proven" claim.
 */

/** A structurally valid v0 card; overrides build negative controls. */
function baseCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    cardId: "evd_test_card_001",
    version: "1.0.0",
    citation: {
      sourceUrl:
        "https://educationendowmentfoundation.org.uk/education-evidence/guidance-reports/primary-sel",
      title: "Test guidance title",
      publisher: "Test publisher",
      year: 2025,
    },
    researchDesign: "guidance_synthesis",
    evidenceLevel: "moderate",
    targetAges: { minAgeYears: 6, maxAgeYears: 12 },
    subjectsAndContext: "Test subjects and context description.",
    claimedEffects: "Test guidance-level effect summary; no AI-efficacy claim.",
    limitations: ["Test limitation one.", "Test limitation two."],
    applicableConditions: ["Test applicable condition."],
    exclusionConditions: ["Test exclusion condition."],
    aiTransferBoundary: "school_practice_only",
    appliesToSkills: ["emotion_support"],
    sourceStatus: "live",
    updatedAt: "2026-10-14",
    review: { status: "approved", reviewedBy: "test-reviewer", reviewedAt: "2026-10-14" },
    summary: "Test card summary for the eval view.",
    ...overrides,
  };
}

test("every shipped evidence card parses fail-closed", () => {
  for (const cardId of Object.keys(EVIDENCE_REGISTRY_V0.cards)) {
    const entry = EVIDENCE_REGISTRY_V0.cards[cardId];
    for (const version of Object.keys(entry.versions)) {
      const card = parseEvidenceCardV0(entry.versions[version]);
      assert.equal(card.cardId, cardId);
      assert.equal(card.version, version);
      assert.ok(Object.isFrozen(card));
    }
  }
});

test("a structurally valid card parses and is frozen", () => {
  const card = parseEvidenceCardV0(baseCard());
  assert.equal(card.cardId, "evd_test_card_001");
  assert.equal(card.aiTransferBoundary, "school_practice_only");
  assert.ok(Object.isFrozen(card));
});

test("unknown fields are rejected at every level", () => {
  assert.throws(() => parseEvidenceCardV0(baseCard({ sneaky: true })), ContractValidationError);
  assert.throws(
    () =>
      parseEvidenceCardV0(
        baseCard({ citation: { ...(baseCard().citation as Record<string, unknown>), extra: "x" } }),
      ),
    ContractValidationError,
  );
  assert.throws(
    () => parseEvidenceCardV0(baseCard({ targetAges: { minAgeYears: 6, maxAgeYears: 12, other: 1 } })),
    ContractValidationError,
  );
  assert.throws(
    () => parseEvidenceCardV0(baseCard({ review: { status: "approved", reviewedBy: "r", reviewedAt: "2026-10-14", x: 1 } })),
    ContractValidationError,
  );
});

test("unknown schema versions and malformed ids/versions/dates fail closed", () => {
  assert.throws(() => parseEvidenceCardV0(baseCard({ schemaVersion: "0.9" })), ContractValidationError);
  assert.throws(() => parseEvidenceCardV0(baseCard({ cardId: "Not-A-Card-Id" })), ContractValidationError);
  assert.throws(() => parseEvidenceCardV0(baseCard({ cardId: "nodot" })), ContractValidationError);
  assert.throws(() => parseEvidenceCardV0(baseCard({ version: "1.0" })), ContractValidationError);
  assert.throws(() => parseEvidenceCardV0(baseCard({ updatedAt: "2026/10/14" })), ContractValidationError);
  assert.throws(() => parseEvidenceCardV0(baseCard({ updatedAt: "2026-13-40" })), ContractValidationError);
});

test("the source URL must be https, parseable and allowlisted (no fetching ever happens)", () => {
  assert.throws(
    () =>
      parseEvidenceCardV0(
        baseCard({ citation: { ...(baseCard().citation as Record<string, unknown>), sourceUrl: "http://educationendowmentfoundation.org.uk/x" } }),
      ),
    ContractValidationError,
  );
  assert.throws(
    () =>
      parseEvidenceCardV0(
        baseCard({ citation: { ...(baseCard().citation as Record<string, unknown>), sourceUrl: "not a url" } }),
      ),
    ContractValidationError,
  );
  assert.throws(
    () =>
      parseEvidenceCardV0(
        baseCard({ citation: { ...(baseCard().citation as Record<string, unknown>), sourceUrl: "https://unlisted-host.example.org/report" } }),
      ),
    ContractValidationError,
  );
});

test("the anti-inference guard: no AI-efficacy claim can be registered", () => {
  assert.deepEqual([...EVIDENCE_AI_TRANSFER_BOUNDARIES], ["school_practice_only"]);
  // The forbidden inference has NO registered enum value to use.
  assert.throws(
    () => parseEvidenceCardV0(baseCard({ aiTransferBoundary: "proven_for_ai_agent" })),
    ContractValidationError,
  );
});

test("the human-review publish gate: approved requires reviewer handle and date", () => {
  assert.throws(
    () => parseEvidenceCardV0(baseCard({ review: { status: "approved" } })),
    ContractValidationError,
  );
  assert.throws(
    () => parseEvidenceCardV0(baseCard({ review: { status: "approved", reviewedBy: "someone" } })),
    ContractValidationError,
  );
  // pending/rejected are structurally fine (they just never load/publish).
  const pending = parseEvidenceCardV0(baseCard({ review: { status: "pending" } }));
  assert.equal(pending.review.status, "pending");
  assert.throws(() => parseEvidenceCardV0(baseCard({ review: { status: "unknown" } })), ContractValidationError);
});

test("scope fields: mandatory 适用/禁忌, limitations and bounded lengths", () => {
  assert.throws(() => parseEvidenceCardV0(baseCard({ exclusionConditions: [] })), ContractValidationError);
  assert.throws(() => parseEvidenceCardV0(baseCard({ limitations: [] })), ContractValidationError);
  assert.throws(() => parseEvidenceCardV0(baseCard({ applicableConditions: [] })), ContractValidationError);
  assert.throws(
    () => parseEvidenceCardV0(baseCard({ summary: "x".repeat(501) })),
    ContractValidationError,
  );
  assert.throws(
    () => parseEvidenceCardV0(baseCard({ limitations: ["x".repeat(301)] })),
    ContractValidationError,
  );
});

test("target ages must be a plausible inclusive integer range", () => {
  assert.throws(
    () => parseEvidenceCardV0(baseCard({ targetAges: { minAgeYears: 13, maxAgeYears: 6 } })),
    ContractValidationError,
  );
  assert.throws(
    () => parseEvidenceCardV0(baseCard({ targetAges: { minAgeYears: 6.5, maxAgeYears: 12 } })),
    ContractValidationError,
  );
  assert.throws(
    () => parseEvidenceCardV0(baseCard({ targetAges: { minAgeYears: -1, maxAgeYears: 12 } })),
    ContractValidationError,
  );
  assert.throws(
    () => parseEvidenceCardV0(baseCard({ targetAges: { minAgeYears: 6, maxAgeYears: 30 } })),
    ContractValidationError,
  );
});

test("applicability targets registered first-party skills only", () => {
  assert.throws(() => parseEvidenceCardV0(baseCard({ appliesToSkills: [] })), ContractValidationError);
  assert.throws(
    () => parseEvidenceCardV0(baseCard({ appliesToSkills: ["some_other_skill"] })),
    ContractValidationError,
  );
});

test("citation year and unregistered enum values fail closed", () => {
  assert.throws(
    () => parseEvidenceCardV0(baseCard({ citation: { ...(baseCard().citation as Record<string, unknown>), year: 1800 } })),
    ContractValidationError,
  );
  assert.throws(() => parseEvidenceCardV0(baseCard({ researchDesign: "vibes" })), ContractValidationError);
  assert.throws(() => parseEvidenceCardV0(baseCard({ evidenceLevel: "absolute" })), ContractValidationError);
  assert.throws(() => parseEvidenceCardV0(baseCard({ sourceStatus: "unknown" })), ContractValidationError);
});
