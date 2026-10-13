/**
 * R1-03 Context Builder (issue #15, docs/HARNESS.md §1 component 2 / §2
 * State-Context contract).
 *
 * Assembles the per-turn HarnessContext and the minimal-necessary model
 * messages under an explicit CONTEXT BUDGET (issue #15: 上下文预算必须可复查):
 *
 * - context references are IDS + VERSIONS only (`context_refs`) — evidence
 *   card bodies, memory payloads and child text never enter the context
 *   structure (来源可复查: every ref carries its source kind and version);
 * - history is bounded: at most MAX_CONTEXT_HISTORY_MESSAGES messages and
 *   MAX_CONTEXT_TOTAL_CHARS UTF-16 units across the composed request;
 *   over-budget history drops OLDEST-first (deterministic), while a single
 *   over-limit message fails closed (a bug/attack, not a budget case);
 * - the system message is composed ONLY from registry-owned constants
 *   (persona disclosure, enforced boundaries, skill headers) — user text
 *   can never alter the policy part of the context;
 * - unknown/missing caller fields are preserved as labeled `unknownFields`
 *   entries and never silently dropped or guessed (docs/HARNESS.md §2:
 *   未知/缺失字段保留为 unknown 并显式标注).
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import {
  ContractValidationError,
  problem,
  validateContractId,
  type ContractProblem,
} from "../contract/core.ts";
import { parseActorContext, type ActorContext } from "../contract/actor.ts";
import { MAX_MODEL_MESSAGE_CHARS, type ModelMessage } from "../gateway/types.ts";
import { ingestDomainFact } from "../legacy-guard.ts";

// ---------------------------------------------------------------------------
// Budget constants
// ---------------------------------------------------------------------------

/** Max history messages composed into one request (system + current extra). */
export const MAX_CONTEXT_HISTORY_MESSAGES = 12;
/** Max UTF-16 units across ALL composed message contents in one request. */
export const MAX_CONTEXT_TOTAL_CHARS = 12_000;
/** Max labeled unknown fields per context (bounded audit surface). */
export const MAX_UNKNOWN_FIELDS = 16;

export interface TurnBudget {
  readonly maxHistoryMessages: number;
  readonly maxContextChars: number;
  /** v0 executes at most one model call per turn (retry stays in the gateway). */
  readonly maxModelCallsPerTurn: 1;
}

// ---------------------------------------------------------------------------
// HarnessContext (docs/HARNESS.md §2)
// ---------------------------------------------------------------------------

export interface ContextRef {
  readonly kind: "evidence" | "memory";
  readonly refId: string;
  readonly version: string | null;
}

export interface SkillVersionFact {
  readonly skillId: string;
  readonly version: string;
}

export interface HarnessContext {
  readonly protocolVersion: "1.0";
  readonly requestId: string;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly actor: Readonly<ActorContext>;
  readonly personaVersion: string;
  readonly skillVersions: readonly SkillVersionFact[];
  readonly contextRefs: readonly ContextRef[];
  readonly budget: TurnBudget;
  /** Voice fencing field; text-side v0 is constant 0. */
  readonly epoch: 0;
  /** Labeled unknown caller fields — preserved, never guessed. */
  readonly unknownFields: readonly string[];
}

function parseContextRef(value: unknown, path: string, problems: ContractProblem[]): ContextRef | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", path, "context ref must be an object."));
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "evidence" && record.kind !== "memory") {
    problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.kind`, 'ref kind must be "evidence" or "memory".'));
  }
  if (typeof record.refId !== "string" || record.refId.length === 0 || record.refId.length > 80) {
    problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.refId`, "refId must be a bounded string."));
  }
  if (record.version !== null && typeof record.version !== "string") {
    problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.version`, "version must be a string or null."));
  }
  for (const key of Object.keys(record)) {
    if (!["kind", "refId", "version"].includes(key)) {
      problems.push(problem("CONTRACT_FIELD_INVALID", `${path}.${key}`, "context ref carries an unknown field."));
    }
  }
  if (problems.length > 0 && problems.some((entry) => entry.path.startsWith(path))) {
    return null;
  }
  return {
    kind: record.kind as "evidence" | "memory",
    refId: record.refId as string,
    version: (record.version ?? null) as string | null,
  };
}

export interface BuildHarnessContextInput {
  readonly requestId: unknown;
  readonly sessionId: unknown;
  readonly conversationId: unknown;
  readonly actor: unknown;
  readonly personaVersion: unknown;
  readonly skillVersions?: readonly unknown[];
  readonly contextRefs?: readonly unknown[];
  /** Caller-declared unknown field NAMES (labels only, never values). */
  readonly unknownFields?: readonly unknown[];
  readonly budget?: { readonly maxHistoryMessages?: number; readonly maxContextChars?: number };
}

/**
 * Build and validate the HarnessContext for one turn. Fail-closed on every
 * field; the result is deeply frozen through the domain intake guard.
 */
export function buildHarnessContext(input: BuildHarnessContextInput): Readonly<HarnessContext> {
  const problems: ContractProblem[] = [];
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "input", "harness context input must be an object."),
    ]);
  }
  validateContractId("requestId", input.requestId, "requestId", problems);
  validateContractId("sessionId", input.sessionId, "sessionId", problems);
  validateContractId("conversationId", input.conversationId, "conversationId", problems);

  let actor: Readonly<ActorContext> | null = null;
  try {
    actor = parseActorContext(input.actor);
  } catch (error) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "actor",
        "actor must be a server-verified ActorContext (parseActorContext failed).",
      ),
    );
    void error;
  }

  if (typeof input.personaVersion !== "string" || input.personaVersion.length === 0 || input.personaVersion.length > 32) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "personaVersion", "personaVersion must be a bounded string."));
  }

  const skillVersions: SkillVersionFact[] = [];
  if (input.skillVersions !== undefined) {
    if (!Array.isArray(input.skillVersions) || input.skillVersions.length > 4) {
      problems.push(problem("CONTRACT_FIELD_INVALID", "skillVersions", "skillVersions must be an array of at most 4 entries."));
    } else {
      input.skillVersions.forEach((entry, index) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          problems.push(problem("CONTRACT_FIELD_INVALID", `skillVersions[${index}]`, "skill version must be an object."));
          return;
        }
        const record = entry as Record<string, unknown>;
        if (typeof record.skillId !== "string" || record.skillId.length === 0 || record.skillId.length > 64) {
          problems.push(problem("CONTRACT_FIELD_INVALID", `skillVersions[${index}].skillId`, "skillId must be a bounded string."));
        }
        if (typeof record.version !== "string" || record.version.length === 0 || record.version.length > 32) {
          problems.push(problem("CONTRACT_FIELD_INVALID", `skillVersions[${index}].version`, "version must be a bounded string."));
        }
        for (const key of Object.keys(record)) {
          if (key !== "skillId" && key !== "version") {
            problems.push(problem("CONTRACT_FIELD_INVALID", `skillVersions[${index}].${key}`, "skill version carries an unknown field."));
          }
        }
        if (typeof record.skillId === "string" && typeof record.version === "string") {
          skillVersions.push({ skillId: record.skillId, version: record.version });
        }
      });
    }
  }

  const contextRefs: ContextRef[] = [];
  if (input.contextRefs !== undefined) {
    if (!Array.isArray(input.contextRefs) || input.contextRefs.length > 32) {
      problems.push(problem("CONTRACT_FIELD_INVALID", "contextRefs", "contextRefs must be an array of at most 32 refs."));
    } else {
      input.contextRefs.forEach((entry, index) => {
        const ref = parseContextRef(entry, `contextRefs[${index}]`, problems);
        if (ref !== null) {
          contextRefs.push(ref);
        }
      });
    }
  }

  const unknownFields: string[] = [];
  if (input.unknownFields !== undefined) {
    if (!Array.isArray(input.unknownFields) || input.unknownFields.length > MAX_UNKNOWN_FIELDS) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          "unknownFields",
          `unknownFields must be an array of at most ${MAX_UNKNOWN_FIELDS} labels.`,
        ),
      );
    } else {
      for (const label of input.unknownFields) {
        if (typeof label !== "string" || label.length === 0 || label.length > 64) {
          problems.push(
            problem("CONTRACT_FIELD_INVALID", "unknownFields[]", "unknown field labels must be bounded strings."),
          );
          break;
        }
        unknownFields.push(label);
      }
    }
  }

  const maxHistoryMessages =
    input.budget?.maxHistoryMessages === undefined
      ? MAX_CONTEXT_HISTORY_MESSAGES
      : input.budget.maxHistoryMessages;
  const maxContextChars =
    input.budget?.maxContextChars === undefined ? MAX_CONTEXT_TOTAL_CHARS : input.budget.maxContextChars;
  if (!Number.isInteger(maxHistoryMessages) || maxHistoryMessages < 1 || maxHistoryMessages > 32) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "budget.maxHistoryMessages", "must be an integer between 1 and 32."));
  }
  if (!Number.isInteger(maxContextChars) || maxContextChars < 256 || maxContextChars > MAX_CONTEXT_TOTAL_CHARS) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "budget.maxContextChars",
        `must be an integer between 256 and ${MAX_CONTEXT_TOTAL_CHARS}.`,
      ),
    );
  }

  for (const key of Object.keys(input)) {
    if (
      !["requestId", "sessionId", "conversationId", "actor", "personaVersion", "skillVersions", "contextRefs", "unknownFields", "budget"].includes(
        key,
      )
    ) {
      problems.push(problem("CONTRACT_FIELD_INVALID", key, "harness context input carries an unknown field."));
    }
  }

  if (problems.length > 0 || actor === null) {
    throw new ContractValidationError(problems.length > 0 ? problems : [
      problem("CONTRACT_FIELD_INVALID", "actor", "actor is required."),
    ]);
  }

  return ingestDomainFact({
    protocolVersion: "1.0" as const,
    requestId: input.requestId as string,
    sessionId: input.sessionId as string,
    conversationId: input.conversationId as string,
    actor,
    personaVersion: input.personaVersion as string,
    skillVersions: Object.freeze(skillVersions.map((entry) => Object.freeze(entry))),
    contextRefs: Object.freeze(contextRefs.map((ref) => Object.freeze(ref))),
    budget: {
      maxHistoryMessages,
      maxContextChars,
      maxModelCallsPerTurn: 1 as const,
    },
    epoch: 0 as const,
    unknownFields: Object.freeze(unknownFields),
  }) as Readonly<HarnessContext>;
}

// ---------------------------------------------------------------------------
// Model message composition
// ---------------------------------------------------------------------------

export interface HistoryMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ComposeModelMessagesInput {
  /** Registry-owned persona disclosure (constant per policy version). */
  readonly identityDisclosure: string;
  /** Registry-owned enforced boundaries (constant list). */
  readonly boundaries: readonly string[];
  /** Skill header when a skill was routed and served (registry-owned). */
  readonly skillHeader: string | null;
  /** Bounded prior conversation (server-owned history). */
  readonly history: readonly unknown[];
  /** The current, gate-allowed user text for this turn. */
  readonly currentText: string;
  readonly budget: { readonly maxHistoryMessages: number; readonly maxContextChars: number };
}

function utf16Length(value: string): number {
  return value.length;
}

/**
 * Compose the model messages: [system policy] + [bounded history] + [current
 * user text]. The system part is registry-owned constants; history is
 * bounded by count and total characters (oldest dropped first); a single
 * over-limit message fails closed. The result is guaranteed to pass the
 * gateway's per-message shape (roles, non-empty, ≤ MAX_MODEL_MESSAGE_CHARS).
 */
export function composeModelMessages(input: ComposeModelMessagesInput): readonly Readonly<ModelMessage>[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "input", "composeModelMessages expects an input object."),
    ]);
  }
  if (typeof input.identityDisclosure !== "string" || input.identityDisclosure.length === 0) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_MISSING", "identityDisclosure", "identityDisclosure is required."),
    ]);
  }
  if (!Array.isArray(input.boundaries) || input.boundaries.some((b) => typeof b !== "string")) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "boundaries", "boundaries must be an array of strings."),
    ]);
  }
  if (input.skillHeader !== null && typeof input.skillHeader !== "string") {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "skillHeader", "skillHeader must be a string or null."),
    ]);
  }
  if (typeof input.currentText !== "string" || input.currentText.length === 0) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_MISSING", "currentText", "currentText is required and must be non-empty."),
    ]);
  }

  const systemParts: string[] = [
    input.identityDisclosure,
    `Enforced boundaries: ${input.boundaries.join("; ")}.`,
  ];
  if (input.skillHeader !== null) {
    systemParts.push(input.skillHeader);
  }
  const systemText = systemParts.join("\n");

  // History validation: shapes, per-message cap (fail closed), then budget.
  const history: HistoryMessage[] = [];
  if (!Array.isArray(input.history)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "history", "history must be an array when present."),
    ]);
  }
  for (const [index, entry] of input.history.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ContractValidationError([
        problem("CONTRACT_FIELD_INVALID", `history[${index}]`, "history entry must be an object."),
      ]);
    }
    const record = entry as Record<string, unknown>;
    if (
      (record.role !== "user" && record.role !== "assistant") ||
      typeof record.content !== "string" ||
      record.content.length === 0
    ) {
      throw new ContractValidationError([
        problem(
          "CONTRACT_FIELD_INVALID",
          `history[${index}]`,
          "history entry must carry role user|assistant and non-empty content.",
        ),
      ]);
    }
    for (const key of Object.keys(record)) {
      if (key !== "role" && key !== "content") {
        throw new ContractValidationError([
          problem("CONTRACT_FIELD_INVALID", `history[${index}].${key}`, "history entry carries an unknown field."),
        ]);
      }
    }
    const message: HistoryMessage = { role: record.role, content: record.content };
    if ([...message.content].length > MAX_MODEL_MESSAGE_CHARS) {
      throw new ContractValidationError([
        problem(
          "CONTRACT_TEXT_TOO_LONG",
          `history[${index}].content`,
          `history message exceeds the ${MAX_MODEL_MESSAGE_CHARS} code-point per-message limit.`,
          { limit: MAX_MODEL_MESSAGE_CHARS },
        ),
      ]);
    }
    history.push(message);
  }

  // Budget: drop OLDEST history first until the composed request fits.
  let totalChars = utf16Length(systemText) + utf16Length(input.currentText);
  const kept: HistoryMessage[] = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index] as HistoryMessage;
    if (kept.length >= input.budget.maxHistoryMessages) {
      break;
    }
    if (totalChars + utf16Length(message.content) > input.budget.maxContextChars) {
      break;
    }
    totalChars += utf16Length(message.content);
    kept.unshift(message);
  }

  const messages: ModelMessage[] = [
    { role: "system", content: systemText },
    ...kept.map((message) => ({ role: message.role, content: message.content })),
    { role: "user", content: input.currentText },
  ];
  if (messages.length > 2 + input.budget.maxHistoryMessages) {
    // Defensive: never exceed the declared budget shape.
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "messages", "composed messages exceed the declared budget."),
    ]);
  }
  return Object.freeze(messages.map((message) => Object.freeze(message)));
}
