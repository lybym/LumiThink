/**
 * R1-06 guardian session payload shapes (issue #18; docs/API_CONTRACT.md
 * §12). Pure parsing/serialization contracts for the guardian session
 * routes — the verification logic itself (credential comparison, lockout,
 * token minting) is server-side (lib/server/guardian-service.ts); this
 * module only fixes the fail-closed payload grammar.
 *
 * No-echo: submitted access codes and session tokens that fail validation
 * are never echoed anywhere; problems carry structural facts only.
 *
 * This module must stay dependency-free (no prisma, react, next or node
 * builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import {
  type ContractProblem,
  ContractValidationError,
  problem,
} from "../contract/core.ts";
import { ingestDomainFact } from "../legacy-guard.ts";
import { ACTOR_ROLES } from "../contract/actor.ts";
import { GUARDIAN_API_PROTOCOL_VERSIONS, GUARDIAN_MASKED_VALUE } from "./authorizations.ts";

/** Opaque server-minted session tokens: base64url, 32 bytes (43 chars). */
export const GUARDIAN_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

/**
 * The server-side principal kinds of the demo family. `admin` is NOT a
 * contract ActorRole: an admin session verifies as the contract `system`
 * role with the independent admin actor id (PRD 维护者: independent
 * administrative permission); `guardian` verifies as the contract
 * `guardian` role bound to the family childRef.
 */
export const GUARDIAN_PRINCIPALS = Object.freeze(["guardian", "admin"] as const);
export type GuardianPrincipal = (typeof GUARDIAN_PRINCIPALS)[number];

/** Authorization header scheme for guardian sessions. */
export const GUARDIAN_AUTH_SCHEME = "Bearer" as const;

/**
 * Parse a POST /api/v1/guardian/session login body. Unknown fields are
 * rejected (there is no client-suppliable identity field: role, actorId and
 * childRef are all server-resolved), so a login can never carry a forged
 * child_id or a self-assigned role (issue #18 AC: 伪造 child_id 拒绝).
 */
export function parseGuardianLoginRequest(body: unknown): { readonly accessCode: string } {
  const problems: ContractProblem[] = [];
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "body", "login body must be an object."),
    ]);
  }
  const record = body as Record<string, unknown>;
  if (record.protocolVersion === undefined || record.protocolVersion === null || record.protocolVersion === "") {
    problems.push(problem("CONTRACT_FIELD_MISSING", "protocolVersion", "protocolVersion is required."));
  } else if (!(GUARDIAN_API_PROTOCOL_VERSIONS as readonly string[]).includes(record.protocolVersion as string)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "protocolVersion", "protocolVersion is not a supported version."),
    );
  }
  const unknownCount = Object.keys(record).filter(
    (key) => key !== "protocolVersion" && key !== "accessCode",
  ).length;
  if (unknownCount > 0) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "body",
        `login body carries ${unknownCount} unknown field(s); identity is server-resolved only.`,
      ),
    );
  }
  const accessCode = record.accessCode;
  if (accessCode === undefined || accessCode === null || accessCode === "") {
    problems.push(problem("CONTRACT_FIELD_MISSING", "accessCode", "accessCode is required."));
  } else if (typeof accessCode !== "string" || accessCode.length < 8 || accessCode.length > 128) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "accessCode",
        `accessCode must be 8-128 characters (${GUARDIAN_MASKED_VALUE}).`,
      ),
    );
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return Object.freeze({ accessCode: accessCode as string });
}

/** Response of a successful guardian login (server-verified session). */
export interface GuardianLoginResponse {
  readonly protocolVersion: "1.0";
  readonly sessionToken: string;
  readonly principal: GuardianPrincipal;
  /** Contract role of the verified actor (guardian, or system for admin). */
  readonly role: string;
  readonly actorId: string;
  readonly childRef: string | null;
  readonly expiresAt: string;
}

/** Build + re-validate the login response at emit time (fail-closed out). */
export function buildGuardianLoginResponse(parts: {
  readonly sessionToken: string;
  readonly principal: GuardianPrincipal;
  readonly role: string;
  readonly actorId: string;
  readonly childRef: string | null;
  readonly expiresAt: string;
}): Readonly<GuardianLoginResponse> {
  const problems: ContractProblem[] = [];
  if (!GUARDIAN_SESSION_TOKEN_PATTERN.test(parts.sessionToken)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "sessionToken", "sessionToken does not match the token grammar."),
    );
  }
  if (!(GUARDIAN_PRINCIPALS as readonly string[]).includes(parts.principal)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "principal", "principal must be a registered principal."));
  }
  if (!(ACTOR_ROLES as readonly string[]).includes(parts.role)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "role", "role must be a registered contract role."));
  }
  if (parts.childRef !== null && (typeof parts.childRef !== "string" || parts.childRef.length === 0)) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "childRef", "childRef must be null or a server id."));
  }
  if (typeof parts.expiresAt !== "string" || parts.expiresAt.length === 0) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "expiresAt", "expiresAt must be an ISO timestamp."));
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return ingestDomainFact({
    protocolVersion: "1.0",
    sessionToken: parts.sessionToken,
    principal: parts.principal,
    role: parts.role,
    actorId: parts.actorId,
    childRef: parts.childRef,
    expiresAt: parts.expiresAt,
  }) as Readonly<GuardianLoginResponse>;
}

/** Response of a successful logout / session end. */
export interface GuardianLogoutResponse {
  readonly protocolVersion: "1.0";
  readonly status: "ended";
}

export function buildGuardianLogoutResponse(): Readonly<GuardianLogoutResponse> {
  return ingestDomainFact({ protocolVersion: "1.0", status: "ended" }) as Readonly<GuardianLogoutResponse>;
}

/**
 * Extract the session token from an Authorization header value.
 * Returns null for absent/malformed headers (never echoes the header).
 */
export function sessionTokenFromAuthorizationHeader(
  header: string | null | undefined,
): string | null {
  if (typeof header !== "string") {
    return null;
  }
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== GUARDIAN_AUTH_SCHEME) {
    return null;
  }
  const token = parts[1];
  if (token === undefined || !GUARDIAN_SESSION_TOKEN_PATTERN.test(token)) {
    return null;
  }
  return token;
}
