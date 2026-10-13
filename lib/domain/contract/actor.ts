/**
 * R1-01 actor identity and session binding of the versioned interaction
 * contract (docs/API_CONTRACT.md §3; PRD §5.1 Input Gate; issue #13).
 *
 * Security model (issue #13, acceptance criterion 2):
 * - Four distinct roles exist: child, guardian, system, voice_device.
 * - An ActorContext is ALWAYS constructed server-side after verification.
 *   Clients have no way to submit one: the interaction request schema does
 *   not carry actor fields, and any client attempt to smuggle them in is
 *   rejected with CONTRACT_UNTRUSTED_IDENTITY (see interaction.ts).
 * - A client-supplied actor/child_id never constitutes authorization.
 *
 * This module must stay dependency-free (no prisma, no react, no next).
 */

import {
  type ContractProblem,
  ContractValidationError,
  problem,
  validateContractId,
  validateTimestamp,
} from "./core.ts";

/** The four identity kinds distinguished by the contract. */
export const ACTOR_ROLES = ["child", "guardian", "system", "voice_device"] as const;

export type ActorRole = (typeof ACTOR_ROLES)[number];

/** Server-verified identity injected into every domain operation. */
export interface ActorContext {
  readonly role: ActorRole;
  /** Server-verified principal id (`act_…`). Never taken from client input. */
  readonly actorId: string;
  /**
   * Server-resolved child reference (`chd_…`). Required for child, guardian
   * and voice_device actors; must be null for the system actor.
   */
  readonly childRef: string | null;
  /** Which server verification injected this identity (short token). */
  readonly verifiedBy: string;
  /** When the server verified the identity. */
  readonly verifiedAt: string;
}

const VERIFIED_BY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ROLES_REQUIRING_CHILD_REF: readonly ActorRole[] = ["child", "guardian", "voice_device"];

/**
 * Parse and validate a server-side ActorContext. Rejects unknown roles and
 * inconsistent child references. This function is for SERVER code paths
 * (verification results); client payloads can never reach it as identity.
 */
export function parseActorContext(value: unknown): Readonly<ActorContext> {
  const problems: ContractProblem[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "actor", "actor must be an object."),
    ]);
  }
  const record = value as Record<string, unknown>;

  const role = record.role;
  if (role === undefined || role === null || role === "") {
    problems.push(problem("CONTRACT_FIELD_MISSING", "actor.role", "actor.role is required."));
  } else if (typeof role !== "string" || !(ACTOR_ROLES as readonly string[]).includes(role)) {
    // Wrong role submissions fail without echoing the submitted value.
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "actor.role",
        `actor.role must be one of: ${ACTOR_ROLES.join(" | ")}.`,
      ),
    );
  }

  validateContractId("actorId", record.actorId, "actor.actorId", problems);

  const roleIsKnown = typeof role === "string" && (ACTOR_ROLES as readonly string[]).includes(role);
  if (record.childRef === undefined || record.childRef === null) {
    if (roleIsKnown && ROLES_REQUIRING_CHILD_REF.includes(role as ActorRole)) {
      problems.push(
        problem(
          "CONTRACT_FIELD_MISSING",
          "actor.childRef",
          `actor.childRef is required for role "${role as ActorRole}".`,
        ),
      );
    }
  } else {
    if (roleIsKnown && role === "system") {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          "actor.childRef",
          "actor.childRef must be null for the system role.",
        ),
      );
    }
    validateContractId("childRef", record.childRef, "actor.childRef", problems);
  }

  if (typeof record.verifiedBy !== "string" || !VERIFIED_BY_PATTERN.test(record.verifiedBy)) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "actor.verifiedBy",
        "actor.verifiedBy must be 1-64 chars of [A-Za-z0-9._:-] naming the server verification.",
      ),
    );
  }
  validateTimestamp(record.verifiedAt, "actor.verifiedAt", problems);

  const allowedKeys = ["role", "actorId", "childRef", "verifiedBy", "verifiedAt"];
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          `actor.${key}`,
          "actor carries an unknown field; the ActorContext is server-constructed only.",
        ),
      );
    }
  }

  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return Object.freeze({
    role: role as ActorRole,
    actorId: record.actorId as string,
    childRef: (record.childRef as string | null) ?? null,
    verifiedBy: record.verifiedBy as string,
    verifiedAt: record.verifiedAt as string,
  });
}

/**
 * Role authorization matrix for POST /api/v1/interactions (text, R1).
 * `voice_device` principals submit turns through the future Voice Adapter
 * path (R1-V), never through the text interaction API, so a device principal
 * calling this API is a mis-authorization (CONTRACT_WRONG_ROLE).
 */
const TEXT_INTERACTION_ALLOWED_ROLES: readonly ActorRole[] = ["child", "guardian", "system"];

export function assertCanSubmitTextInteraction(actor: Readonly<ActorContext>): void {
  if (!TEXT_INTERACTION_ALLOWED_ROLES.includes(actor.role)) {
    // Role names are public vocabulary; the actor id is not echoed.
    throw new ContractValidationError([
      problem(
        "CONTRACT_WRONG_ROLE",
        "actor.role",
        `role "${actor.role}" may not submit text interactions; ` +
          `allowed roles: ${TEXT_INTERACTION_ALLOWED_ROLES.join(", ")}.`,
      ),
    ]);
  }
}

export function assertRoleIn(
  actor: Readonly<ActorContext>,
  allowed: readonly ActorRole[],
  path: string,
): void {
  if (!allowed.includes(actor.role)) {
    throw new ContractValidationError([
      problem(
        "CONTRACT_WRONG_ROLE",
        path,
        `role "${actor.role}" is not allowed here; allowed roles: ${allowed.join(", ")}.`,
      ),
    ]);
  }
}

/** Server-owned binding between a session, a conversation and one actor. */
export interface SessionRef {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly actorId: string;
  readonly role: ActorRole;
  readonly createdAt: string;
}

/** Validate a server-side SessionRef (parse form of the JSON Schema). */
export function parseSessionRef(value: unknown): Readonly<SessionRef> {
  const problems: ContractProblem[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "sessionRef", "sessionRef must be an object."),
    ]);
  }
  const record = value as Record<string, unknown>;
  validateContractId("sessionId", record.sessionId, "sessionRef.sessionId", problems);
  validateContractId("conversationId", record.conversationId, "sessionRef.conversationId", problems);
  validateContractId("actorId", record.actorId, "sessionRef.actorId", problems);
  if (
    typeof record.role !== "string" ||
    !(ACTOR_ROLES as readonly string[]).includes(record.role)
  ) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "sessionRef.role",
        `sessionRef.role must be one of: ${ACTOR_ROLES.join(" | ")}.`,
      ),
    );
  }
  validateTimestamp(record.createdAt, "sessionRef.createdAt", problems);
  const allowedKeys = ["sessionId", "conversationId", "actorId", "role", "createdAt"];
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", `sessionRef.${key}`, "sessionRef carries an unknown field."),
      );
    }
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return Object.freeze({
    sessionId: record.sessionId as string,
    conversationId: record.conversationId as string,
    actorId: record.actorId as string,
    role: record.role as ActorRole,
    createdAt: record.createdAt as string,
  });
}

/**
 * Create a SessionRef binding an already-verified actor to a conversation.
 * Both ids are supplied by the caller (server generator) and re-validated
 * here so the contract cannot be violated by a careless generator.
 */
export function createSessionRef(
  actor: Readonly<ActorContext>,
  ids: { sessionId: string; conversationId: string; createdAt: string },
): Readonly<SessionRef> {
  return parseSessionRef({
    sessionId: ids.sessionId,
    conversationId: ids.conversationId,
    actorId: actor.actorId,
    role: actor.role,
    createdAt: ids.createdAt,
  });
}
