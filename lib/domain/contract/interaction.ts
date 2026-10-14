/**
 * R1-01 input side of the versioned interaction contract
 * (docs/API_CONTRACT.md §4; PRD FR-001; issue #13).
 *
 * Defines the client → server request of POST /api/v1/interactions, the
 * canonical InteractionEvent both the Web client and the future Voice
 * Adapter normalize into, and the conversation-binding rule that rejects
 * cross-conversation correlation attempts.
 *
 * Identity rule: the request carries NO actor fields. Anything that looks
 * like client-supplied identity (actor / childId / sessionId / role …) is
 * rejected with CONTRACT_UNTRUSTED_IDENTITY; the server injects the verified
 * ActorContext during normalization.
 *
 * This module must stay dependency-free (no prisma, no react, no next)
 * except for the domain intake guard, which every admitted domain fact must
 * pass through (docs/TECH_STACK.md §4).
 */

import {
  assertSupportedProtocolVersion,
  canonicalJson,
  type ContractProblem,
  ContractValidationError,
  problem,
  validateContractId,
  validateTimestamp,
} from "./core.ts";
import { assertCanSubmitTextInteraction, parseActorContext, type ActorContext } from "./actor.ts";
import { ingestDomainFact } from "../legacy-guard.ts";

/** Text limits of the R1 text contract (issue #13: message length limits). */
export const TEXT_LIMITS = Object.freeze({
  /** Minimum non-whitespace code points. */
  minChars: 1,
  /** Maximum code points per message (Unicode code points, not UTF-16 units). */
  maxChars: 4000,
});

/** Where a normalized interaction entered the system. Closed enum by design. */
export const INGRESS_KINDS = ["web", "voice_adapter"] as const;
export type IngressKind = (typeof INGRESS_KINDS)[number];

/** Advisory client self-description. Never trusted, never part of the canonical event. */
export interface InteractionClientContext {
  readonly client: IngressKind;
  readonly clientVersion?: string;
}

const MAX_CLIENT_VERSION_LENGTH = 64;
/** Public so schemas.ts publishes the same grammar without duplication. */
export const CLIENT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,63}$/;

/**
 * Keys a client may never place in a request: they mirror server-owned
 * identity/correlation fields and are rejected fail-closed even when their
 * value is empty or null.
 */
export const FORBIDDEN_CLIENT_KEYS: readonly string[] = [
  "actor",
  "actorContext",
  "childId",
  "child_id",
  "childRef",
  "role",
  "sessionId",
  "session_id",
  "traceId",
  "serverIdentity",
];

/** The client → server request body of POST /api/v1/interactions. */
export interface InteractionRequest {
  readonly protocolVersion: string;
  readonly interaction: {
    /** R1 text interactions only; the enum grows with later contract versions. */
    readonly kind: "text";
    /** Client-generated idempotency key (`req_…`). */
    readonly clientRequestId: string;
    /** Absent → start a new conversation (server assigns the id). */
    readonly conversationId?: string;
    readonly text: {
      readonly content: string;
      readonly format: "plain";
    };
    readonly clientContext?: InteractionClientContext;
  };
}

function rejectForbiddenClientKeys(
  record: Record<string, unknown>,
  scope: string,
  problems: ContractProblem[],
): void {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_CLIENT_KEYS.includes(key)) {
      problems.push(
        problem(
          "CONTRACT_UNTRUSTED_IDENTITY",
          scope ? `${scope}.${key}` : key,
          `"${key}" is server-owned identity/correlation state; clients cannot submit it.`,
        ),
      );
    }
  }
}

function validateClientContext(
  value: unknown,
  problems: ContractProblem[],
): InteractionClientContext | null {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "interaction.clientContext", "clientContext must be an object."),
    );
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.client !== "string" ||
    !(INGRESS_KINDS as readonly string[]).includes(record.client)
  ) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "interaction.clientContext.client",
        `clientContext.client must be one of: ${INGRESS_KINDS.join(" | ")}. ` +
          "No vendor or device-protocol names are part of the contract.",
      ),
    );
    return null;
  }
  let clientVersion: string | undefined;
  if (record.clientVersion !== undefined) {
    if (
      typeof record.clientVersion !== "string" ||
      !CLIENT_VERSION_PATTERN.test(record.clientVersion)
    ) {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          "interaction.clientContext.clientVersion",
          `clientContext.clientVersion must be 1-${MAX_CLIENT_VERSION_LENGTH} chars of ` +
            "[A-Za-z0-9._+:-]; unknown client versions are tolerated but must be well-formed.",
        ),
      );
    } else {
      clientVersion = record.clientVersion;
    }
  }
  for (const key of Object.keys(record)) {
    if (key !== "client" && key !== "clientVersion") {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          `interaction.clientContext.${key}`,
          "clientContext carries an unknown field.",
        ),
      );
    }
  }
  return clientVersion === undefined
    ? { client: record.client as IngressKind }
    : { client: record.client as IngressKind, clientVersion };
}

/**
 * Parse and validate the request body of POST /api/v1/interactions.
 * Fails closed with structured problems; submitted values are never echoed.
 */
export function parseInteractionRequest(value: unknown): Readonly<InteractionRequest> {
  const problems: ContractProblem[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "", "The request body must be a JSON object."),
    ]);
  }
  const record = value as Record<string, unknown>;
  rejectForbiddenClientKeys(record, "", problems);

  if (record.protocolVersion === undefined || record.protocolVersion === null) {
    problems.push(
      problem("CONTRACT_FIELD_MISSING", "protocolVersion", "protocolVersion is required."),
    );
  } else {
    try {
      assertSupportedProtocolVersion(record.protocolVersion, "protocolVersion");
    } catch (error) {
      if (error instanceof ContractValidationError) {
        problems.push(...error.problems);
      } else {
        throw error;
      }
    }
  }

  const interaction = record.interaction;
  if (interaction === null || typeof interaction !== "object" || Array.isArray(interaction)) {
    problems.push(problem("CONTRACT_FIELD_MISSING", "interaction", "interaction is required."));
  } else {
    const ir = interaction as Record<string, unknown>;
    rejectForbiddenClientKeys(ir, "interaction", problems);

    if (ir.kind === undefined || ir.kind === null) {
      problems.push(problem("CONTRACT_FIELD_MISSING", "interaction.kind", "interaction.kind is required."));
    } else if (ir.kind !== "text") {
      problems.push(
        problem(
          "CONTRACT_FIELD_INVALID",
          "interaction.kind",
          'interaction.kind must be "text" in contract v1.0 (voice turns use the R1-V path).',
        ),
      );
    }

    validateContractId("requestId", ir.clientRequestId, "interaction.clientRequestId", problems);

    if (ir.conversationId !== undefined) {
      validateContractId("conversationId", ir.conversationId, "interaction.conversationId", problems);
    }

    const text = ir.text;
    if (text === null || typeof text !== "object" || Array.isArray(text)) {
      problems.push(problem("CONTRACT_FIELD_MISSING", "interaction.text", "interaction.text is required."));
    } else {
      const tr = text as Record<string, unknown>;
      if (typeof tr.content !== "string") {
        problems.push(
          problem("CONTRACT_FIELD_MISSING", "interaction.text.content", "interaction.text.content is required."),
        );
      } else {
        const codePoints = [...tr.content];
        if (codePoints.length > TEXT_LIMITS.maxChars) {
          problems.push(
            problem(
              "CONTRACT_TEXT_TOO_LONG",
              "interaction.text.content",
              `interaction.text.content exceeds the ${TEXT_LIMITS.maxChars} code-point limit.`,
              { limit: TEXT_LIMITS.maxChars, actual: codePoints.length },
            ),
          );
        } else if (
          codePoints.length < TEXT_LIMITS.minChars ||
          tr.content.trim().length === 0
        ) {
          problems.push(
            problem(
              "CONTRACT_FIELD_INVALID",
              "interaction.text.content",
              "interaction.text.content must contain non-whitespace characters.",
            ),
          );
        }
      }
      if (tr.format !== undefined && tr.format !== "plain") {
        problems.push(
          problem(
            "CONTRACT_FIELD_INVALID",
            "interaction.text.format",
            'interaction.text.format must be "plain" in contract v1.0.',
          ),
        );
      }
      rejectForbiddenClientKeys(tr, "interaction.text", problems);
    }

    if (ir.clientContext !== undefined) {
      validateClientContext(ir.clientContext, problems);
    }

    const allowedInteractionKeys = [
      "kind",
      "clientRequestId",
      "conversationId",
      "text",
      "clientContext",
    ];
    for (const key of Object.keys(ir)) {
      if (!allowedInteractionKeys.includes(key)) {
        problems.push(
          problem(
            "CONTRACT_FIELD_INVALID",
            `interaction.${key}`,
            "interaction carries an unknown field (additionalProperties=false).",
          ),
        );
      }
    }
  }

  const allowedTopKeys = ["protocolVersion", "interaction"];
  for (const key of Object.keys(record)) {
    if (!allowedTopKeys.includes(key)) {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", key, "The request carries an unknown top-level field."),
      );
    }
  }

  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }

  const ir = interaction as Record<string, unknown>;
  const tr = ir.text as Record<string, unknown>;
  const clientContext = validateClientContext(ir.clientContext, []);
  return Object.freeze({
    protocolVersion: record.protocolVersion as string,
    interaction: Object.freeze({
      kind: "text" as const,
      clientRequestId: ir.clientRequestId as string,
      ...(ir.conversationId !== undefined
        ? { conversationId: ir.conversationId as string }
        : {}),
      text: Object.freeze({ content: tr.content as string, format: "plain" as const }),
      ...(clientContext !== null ? { clientContext: Object.freeze(clientContext) } : {}),
    }),
  });
}

// ---------------------------------------------------------------------------
// Canonical InteractionEvent
// ---------------------------------------------------------------------------

/** The canonical, versioned domain event both clients converge on. */
export interface InteractionEvent {
  readonly protocolVersion: "1.0";
  readonly eventId: string;
  readonly kind: "text";
  readonly conversationId: string;
  readonly turnId: string;
  /** Echo of the client idempotency key. */
  readonly requestId: string;
  readonly traceId: string;
  /** Server-verified identity, injected during normalization. */
  readonly actor: Readonly<ActorContext>;
  /** Server-decided entry point (transport), never claimed by the client. */
  readonly ingress: IngressKind;
  readonly text: {
    readonly content: string;
    readonly format: "plain";
    /** Code-point count, for audit without re-reading content. */
    readonly charCount: number;
  };
  readonly occurredAt: string;
}

/** Options for normalizeInteractionRequest — all server-supplied. */
export interface NormalizeInteractionOptions {
  /** Verified actor; the client cannot influence this value. */
  readonly actor: Readonly<ActorContext>;
  /** Server-decided ingress (transport path), NOT the client's claim. */
  readonly ingress: IngressKind;
  /** Server-generated ids and timestamp. */
  readonly eventId: string;
  /** Canonical conversation id; used as-is when the request starts a new one. */
  readonly conversationId: string;
  readonly turnId: string;
  readonly traceId: string;
  readonly occurredAt: string;
  /**
   * Conversations the verified actor is authorized to use. When provided,
   * a client-supplied conversationId outside this set is rejected with
   * CONTRACT_CROSS_CONVERSATION. A request without one starts a new
   * conversation and is assigned `conversationId` by the server.
   */
  readonly boundConversationIds?: readonly string[];
}

export interface NormalizeInteractionResult {
  /** Canonical event; deeply frozen through the domain intake guard. */
  readonly event: Readonly<InteractionEvent>;
  /** Validated advisory client context (never part of the canonical event). */
  readonly advisory: { readonly clientContext: Readonly<InteractionClientContext> | null };
}

/**
 * Normalize a validated request + server-side verification results into the
 * canonical InteractionEvent. This is the single convergence point that
 * makes a Web request and a future Voice Adapter request produce the same
 * standard event (issue #13 acceptance criterion 2).
 */
export function normalizeInteractionRequest(
  request: Readonly<InteractionRequest>,
  options: NormalizeInteractionOptions,
): NormalizeInteractionResult {
  const problems: ContractProblem[] = [];
  const interaction = request.interaction;

  assertCanSubmitTextInteraction(options.actor);

  validateContractId("eventId", options.eventId, "options.eventId", problems);
  validateContractId("conversationId", options.conversationId, "options.conversationId", problems);
  validateContractId("turnId", options.turnId, "options.turnId", problems);
  validateContractId("traceId", options.traceId, "options.traceId", problems);
  validateTimestamp(options.occurredAt, "options.occurredAt", problems);
  if (!(INGRESS_KINDS as readonly string[]).includes(options.ingress)) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        "options.ingress",
        `options.ingress must be one of: ${INGRESS_KINDS.join(" | ")}.`,
      ),
    );
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }

  // Conversation binding: a client-supplied conversation id must belong to
  // the verified actor's authorized set, otherwise this is a cross-
  // conversation correlation attempt.
  if (interaction.conversationId !== undefined && options.boundConversationIds !== undefined) {
    if (!options.boundConversationIds.includes(interaction.conversationId)) {
      // Neither the submitted id nor the bound list is echoed.
      throw new ContractValidationError([
        problem(
          "CONTRACT_CROSS_CONVERSATION",
          "interaction.conversationId",
          "The submitted conversation is not bound to the verified actor.",
        ),
      ]);
    }
  }
  // Coherence rule: when the client continues a conversation, the canonical
  // conversation of the produced event must BE that conversation. A server
  // that silently re-points a bound conversation to another canonical id
  // would itself create a cross-conversation correlation, so it fails here.
  if (
    interaction.conversationId !== undefined &&
    interaction.conversationId !== options.conversationId
  ) {
    throw new ContractValidationError([
      problem(
        "CONTRACT_CROSS_CONVERSATION",
        "interaction.conversationId",
        "The submitted conversation does not match the canonical conversation of this request.",
      ),
    ]);
  }

  const content = interaction.text.content;
  const charCount = [...content].length;

  const event: InteractionEvent = {
    protocolVersion: "1.0",
    eventId: options.eventId,
    kind: "text",
    conversationId: options.conversationId,
    turnId: options.turnId,
    requestId: interaction.clientRequestId,
    traceId: options.traceId,
    actor: parseActorContext(options.actor),
    ingress: options.ingress,
    text: { content, format: "plain", charCount },
    occurredAt: options.occurredAt,
  };

  // Every admitted domain fact passes the legacy intake guard (freeze +
  // legacy shape scan) — the single domain entry point.
  return {
    event: ingestDomainFact(event) as Readonly<InteractionEvent>,
    advisory: {
      clientContext: interaction.clientContext
        ? Object.freeze({ ...interaction.clientContext })
        : null,
    },
  };
}

/**
 * Re-validate a previously produced (e.g. persisted) canonical event.
 * Defensive parse used when events cross process boundaries.
 */
export function parseInteractionEvent(value: unknown): Readonly<InteractionEvent> {
  const problems: ContractProblem[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "event", "InteractionEvent must be an object."),
    ]);
  }
  const record = value as Record<string, unknown>;
  assertSupportedProtocolVersion(record.protocolVersion, "protocolVersion");
  validateContractId("eventId", record.eventId, "eventId", problems);
  validateContractId("conversationId", record.conversationId, "conversationId", problems);
  validateContractId("turnId", record.turnId, "turnId", problems);
  validateContractId("requestId", record.requestId, "requestId", problems);
  validateContractId("traceId", record.traceId, "traceId", problems);
  validateTimestamp(record.occurredAt, "occurredAt", problems);
  if (record.kind !== "text") {
    problems.push(problem("CONTRACT_FIELD_INVALID", "kind", 'kind must be "text".'));
  }
  if (
    typeof record.ingress !== "string" ||
    !(INGRESS_KINDS as readonly string[]).includes(record.ingress)
  ) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "ingress", `ingress must be one of: ${INGRESS_KINDS.join(" | ")}.`),
    );
  }
  try {
    parseActorContext(record.actor);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      for (const p of error.problems) {
        problems.push(problem(p.code, `actor.${p.path}`, p.message, p.detail));
      }
    } else {
      throw error;
    }
  }
  const text = record.text;
  if (text === null || typeof text !== "object" || Array.isArray(text)) {
    problems.push(problem("CONTRACT_FIELD_MISSING", "text", "text is required."));
  } else {
    const tr = text as Record<string, unknown>;
    if (typeof tr.content !== "string") {
      problems.push(problem("CONTRACT_FIELD_MISSING", "text.content", "text.content is required."));
    } else if ([...tr.content].length > TEXT_LIMITS.maxChars) {
      problems.push(
        problem(
          "CONTRACT_TEXT_TOO_LONG",
          "text.content",
          `text.content exceeds the ${TEXT_LIMITS.maxChars} code-point limit.`,
          { limit: TEXT_LIMITS.maxChars },
        ),
      );
    }
    if (tr.format !== "plain") {
      problems.push(problem("CONTRACT_FIELD_INVALID", "text.format", 'text.format must be "plain".'));
    }
    if (typeof tr.charCount !== "number" || !Number.isInteger(tr.charCount) || tr.charCount < 0) {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", "text.charCount", "text.charCount must be a non-negative integer."),
      );
    }
  }
  const allowedKeys = [
    "protocolVersion",
    "eventId",
    "kind",
    "conversationId",
    "turnId",
    "requestId",
    "traceId",
    "actor",
    "ingress",
    "text",
    "occurredAt",
  ];
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      problems.push(problem("CONTRACT_FIELD_INVALID", key, "InteractionEvent carries an unknown field."));
    }
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return Object.freeze(record as unknown as InteractionEvent);
}

/**
 * Content-free 64-bit FNV-1a digest of the canonical semantic payload
 * (issue #21 review round 1 P0-1): the fingerprint is STORED in the
 * server-side idempotency ledger, so it must never embed the child's
 * verbatim text — the ledger stores only this bounded digest plus ids.
 * FNV-1a is pure JS (the domain layer imports no node builtins; same
 * algorithm family as lib/domain/safety/trace.ts) and deterministic, so
 * the #13 idempotency semantics are unchanged: both sides of the
 * replay-vs-409 comparison are computed by this same function. The
 * digest is a client-bug guard (request-id reuse), not a security
 * control; a 64-bit collision would only make one actor's own
 * different-payload retry replay its own earlier ack.
 */
function fnv1a64Hex(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Fingerprint of a request's semantic payload for idempotency decisions:
 * the 64-bit FNV-1a digest (16 lowercase hex chars) of the canonical JSON
 * of {protocolVersion, kind, conversationId, text{content, format}} —
 * content-free by construction (no verbatim text survives anywhere it is
 * stored).
 */
export function fingerprintInteractionRequest(request: Readonly<InteractionRequest>): string {
  return fnv1a64Hex(
    canonicalJson({
      protocolVersion: request.protocolVersion,
      kind: request.interaction.kind,
      conversationId: request.interaction.conversationId ?? null,
      text: { content: request.interaction.text.content, format: request.interaction.text.format },
    }),
  );
}
