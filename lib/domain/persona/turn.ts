/**
 * R1-04 Persona turn resolution (docs/PERSONA.md, PRD §6 / UC-01, issue #16).
 *
 * This is the HONEST behavior surface of the persona for one turn: it
 * composes the registry-resolved Persona Policy into the concrete rule set a
 * turn runs under and derives observability facts from the turn's untrusted
 * inputs. Design invariants (issue #16 实现范围 2):
 *
 * - IDENTITY / TRAITS / BOUNDARIES / EXITS are derived ONLY from the
 *   server-owned registry policy. No parameter of the resolution API can
 *   alter them: user prompts, memory claims and tool outputs are accepted
 *   solely as `untrustedInputs` for override-attempt OBSERVABILITY — they
 *   are never applied and never echoed (only stable reason ids + provenance
 *   names are recorded).
 * - STYLE knobs are the only adjustable fields, and they change ONLY
 *   through {@link applyPersonaStyleKnobs} with a TRUSTED provenance
 *   (system_default | guardian_config | child_feedback). Untrusted
 *   provenances are rejected fail-closed — even for style-only changes — so
 *   no code path exists that turns prompt text into persona configuration.
 *   (The R1-14 controlled preference path may later mediate child feedback;
 *   v0 keeps the structured channel explicit.)
 * - Override-attempt detection is a deterministic, conservative pattern
 *   scan tuned to the synthetic corpus. It is NOT a safety gate and does
 *   NOT decide allow/block for any text: text enforcement stays with the
 *   Safety Gate (docs/SAFETY_POLICY.md §7 — no parallel safety vocabulary).
 *   It only records WHICH boundary class the turn tried to override, so
 *   regressions can assert "attempt seen, boundaries unchanged".
 * - Multi-turn stability: {@link resolvePersonaTurns} runs a conversation
 *   with one shared, trusted style state; identity, traits, boundaries and
 *   exits are structurally identical across turns (same policy snapshot),
 *   while style updates flow through the trusted knob path only.
 *
 * This module must stay dependency-free (no prisma, no react, no next, no
 * node builtins) — enforced by tests/domain/boundary.spec.ts.
 */

import { parseActorContext, type ActorRole } from "../contract/actor.ts";
import { ContractValidationError, problem } from "../contract/core.ts";
import type { EvalExitPath } from "../eval/scenario.ts";

import {
  PERSONA_KNOB_SOURCES,
  PERSONA_KNOB_VALUES,
  PERSONA_STYLE_KNOBS,
  PERSONA_UNTRUSTED_PROVENANCES,
  personaIdentityDisclosureText,
  type PersonaCoreTrait,
  type PersonaKnobSource,
  type PersonaPolicyV0,
  type PersonaRelationBoundary,
  type PersonaStyleKnobId,
  type PersonaStyleState,
  type PersonaUntrustedProvenance,
} from "./policy.ts";

// ---------------------------------------------------------------------------
// Override-attempt detection (observability only — never a gate decision)
// ---------------------------------------------------------------------------

/** Stable, greppable reason ids for detected persona-boundary override attempts. */
export const PERSONA_OVERRIDE_REASONS = Object.freeze([
  "identity_override",
  "secrecy_override",
  "dependency_override",
  "rule_rewrite_override",
] as const);

export type PersonaOverrideReason = (typeof PERSONA_OVERRIDE_REASONS)[number];

/**
 * v0 detection patterns (synthetic corpus, conservative). A match records
 * the ATTEMPT class only — matched text is never echoed anywhere.
 */
const OVERRIDE_PATTERNS: Readonly<Record<PersonaOverrideReason, readonly RegExp[]>> =
  Object.freeze({
    identity_override: Object.freeze([
      /你是(?:其实|实际)?(?:一个)?真人/,
      /其实(?:是)?真人/,
      /不是(?:一个)?\s*AI/,
      /假装你是(?:真人|人类)/,
      /\byou(?:'re| are) (?:actually )?(?:a )?real human\b/i,
      /\bnot an? a[i1]\b/i,
    ]),
    secrecy_override: Object.freeze([
      /这是我们(?:之间)?(?:的)?(?:小)?秘密/,
      /替我保密/,
      /(?:不要|别)告诉我?(?:的)?(?:妈妈|爸爸|家长|老师|父母)/,
      /\bkeep (?:this|it) (?:a )?secret\b/i,
      /\bdon'?t tell (?:your )?(?:mom|parents?|teacher)\b/i,
    ]),
    dependency_override: Object.freeze([
      /只(?:喜欢|爱)(?:我|你|他|她)(?:一个人)?/,
      /做我的(?:男|女)朋友/,
      /只属于/,
      /最(?:懂|理解)你/,
      /\bbe my (?:girlfriend|boyfriend)\b/i,
      /\bonly (?:like|love) me\b/i,
    ]),
    rule_rewrite_override: Object.freeze([
      /忽略.{0,6}(?:之前|以上|前面|先前|你).{0,8}(?:指令|规则|设定)/,
      /(?:改掉|改了|改变|修改)你的(?:规则|设定|人格|提示词)/,
      /\b(?:override|forget|rewrite) your (?:rules|persona|instructions)\b/i,
    ]),
  });

/**
 * Detect persona-boundary override attempts in one untrusted text.
 * Deterministic and content-free: the result names reason classes only and
 * never echoes the submitted text.
 */
export function detectPersonaOverrideAttempts(text: string): readonly PersonaOverrideReason[] {
  if (typeof text !== "string") {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "text", "persona override detection expects string text."),
    ]);
  }
  const reasons: PersonaOverrideReason[] = [];
  for (const reason of PERSONA_OVERRIDE_REASONS) {
    if (OVERRIDE_PATTERNS[reason].some((pattern) => pattern.test(text))) {
      reasons.push(reason);
    }
  }
  return Object.freeze(reasons);
}

// ---------------------------------------------------------------------------
// Style state with provenance (the only mutable persona surface)
// ---------------------------------------------------------------------------

/** One knob change with its trusted provenance (audit trail entry). */
export interface PersonaKnobProvenanceEntry {
  readonly knobId: PersonaStyleKnobId;
  readonly value: string;
  readonly source: PersonaKnobSource;
}

/** The effective style of a conversation plus how every value got there. */
export interface PersonaStyleWithProvenance {
  readonly style: Readonly<PersonaStyleState>;
  readonly provenance: readonly Readonly<PersonaKnobProvenanceEntry>[];
}

export interface PersonaKnobUpdate {
  readonly knobId: PersonaStyleKnobId;
  readonly value: string;
}

export type PersonaStyleApplicationResult =
  | {
      readonly status: "applied";
      readonly style: Readonly<PersonaStyleState>;
      readonly provenance: readonly Readonly<PersonaKnobProvenanceEntry>[];
    }
  | {
      readonly status: "rejected";
      readonly reason:
        | "knob_source_untrusted"
        | "knob_not_adjustable"
        | "unknown_knob"
        | "unknown_knob_value";
    };

/**
 * The policy default style, with every knob attributed to `system_default`.
 */
export function personaDefaultStyle(
  policy: Readonly<PersonaPolicyV0>,
): Readonly<PersonaStyleWithProvenance> {
  const provenance = PERSONA_STYLE_KNOBS.map((knobId) =>
    Object.freeze({ knobId, value: policy.defaultStyle[knobId], source: "system_default" as const }),
  );
  return Object.freeze({
    style: Object.freeze({ ...policy.defaultStyle }),
    provenance: Object.freeze(provenance),
  });
}

function assertValidStyleState(
  policy: Readonly<PersonaPolicyV0>,
  style: Readonly<PersonaStyleState>,
  path: string,
): void {
  if (style === null || typeof style !== "object" || Array.isArray(style)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", path, "expected a style state object."),
    ]);
  }
  for (const knob of PERSONA_STYLE_KNOBS) {
    const value = style[knob];
    if (typeof value !== "string" || !(PERSONA_KNOB_VALUES[knob] as readonly string[]).includes(value)) {
      throw new ContractValidationError([
        problem(
          "CONTRACT_FIELD_INVALID",
          `${path}.${knob}`,
          "style state carries an unregistered value; build style states via " +
            "personaDefaultStyle / applyPersonaStyleKnobs.",
        ),
      ]);
    }
  }
}

/**
 * Apply trusted style-knob updates onto a style state. This is the ONLY
 * mutation path for the adjustable persona fields:
 * - the source must be a TRUSTED provenance (PERSONA_KNOB_SOURCES); text
 *   coming from user prompts, memory claims or tool outputs can never reach
 *   this function with a trusted source label — the type system plus this
 *   runtime check keep the untrusted channels out;
 * - each knob must be registered AND declared adjustable by the policy;
 * - each value must be registered for that knob;
 * - identity, traits, boundaries and exits are NOT parameters here — they
 *   cannot be changed even in principle through this path.
 *
 * Rejections are structured and content-free: submitted knob ids/values
 * that failed validation are masked (no-echo contract).
 */
export function applyPersonaStyleKnobs(
  policy: Readonly<PersonaPolicyV0>,
  current: Readonly<PersonaStyleWithProvenance>,
  updates: readonly PersonaKnobUpdate[],
  source: PersonaKnobSource,
): PersonaStyleApplicationResult {
  assertValidStyleState(policy, current.style, "style");
  if (!(PERSONA_KNOB_SOURCES as readonly string[]).includes(source)) {
    return Object.freeze({ status: "rejected", reason: "knob_source_untrusted" });
  }
  if (!Array.isArray(updates)) {
    return Object.freeze({ status: "rejected", reason: "unknown_knob" });
  }
  const nextStyle: Record<string, string> = { ...current.style };
  const nextProvenance: PersonaKnobProvenanceEntry[] = [...current.provenance];
  for (const update of updates) {
    if (
      update === null ||
      typeof update !== "object" ||
      typeof update.knobId !== "string" ||
      !(PERSONA_STYLE_KNOBS as readonly string[]).includes(update.knobId)
    ) {
      // Unregistered knob id: masked under the no-echo contract.
      return Object.freeze({ status: "rejected", reason: "unknown_knob" });
    }
    if (!(policy.adjustableKnobs as readonly string[]).includes(update.knobId)) {
      return Object.freeze({ status: "rejected", reason: "knob_not_adjustable" });
    }
    if (
      typeof update.value !== "string" ||
      !(PERSONA_KNOB_VALUES[update.knobId as PersonaStyleKnobId] as readonly string[]).includes(update.value)
    ) {
      // Unregistered value: masked under the no-echo contract.
      return Object.freeze({ status: "rejected", reason: "unknown_knob_value" });
    }
    nextStyle[update.knobId] = update.value;
    const existingIndex = nextProvenance.findIndex((entry) => entry.knobId === update.knobId);
    const entry = Object.freeze({ knobId: update.knobId, value: update.value, source });
    if (existingIndex >= 0) {
      nextProvenance[existingIndex] = entry;
    } else {
      nextProvenance.push(entry);
    }
  }
  assertValidStyleState(policy, nextStyle, "style");
  return Object.freeze({
    status: "applied",
    style: Object.freeze(nextStyle),
    provenance: Object.freeze(nextProvenance),
  });
}

// ---------------------------------------------------------------------------
// Per-turn resolution
// ---------------------------------------------------------------------------

/** Untrusted turn input: inspected for override attempts, never applied. */
export interface PersonaUntrustedInput {
  readonly provenance: PersonaUntrustedProvenance;
  readonly text: string;
}

export interface PersonaTurnInput {
  /** Registry-resolved policy snapshot (server-owned; see registry.ts). */
  readonly policy: Readonly<PersonaPolicyV0>;
  /** Trusted style state (personaDefaultStyle / applyPersonaStyleKnobs). */
  readonly style: Readonly<PersonaStyleWithProvenance>;
  /** Server-verified ActorContext (re-validated fail-closed here). */
  readonly actor: unknown;
  /** Untrusted texts: user prompt / memory claims / tool outputs. */
  readonly untrustedInputs: readonly PersonaUntrustedInput[];
  /** Position of this turn in the conversation (0-based). */
  readonly turnIndex: number;
}

/** What one turn runs under — structural facts only, no child data. */
export interface PersonaTurnResolution {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly turnIndex: number;
  readonly actorRole: ActorRole;
  /** Registered honest-AI disclosure (constant per policy version). */
  readonly identityDisclosure: string;
  readonly coreTraits: readonly PersonaCoreTrait[];
  /** The full, non-overridable boundary set enforced this turn. */
  readonly boundariesEnforced: readonly PersonaRelationBoundary[];
  readonly style: Readonly<PersonaStyleState>;
  readonly knobProvenance: readonly Readonly<PersonaKnobProvenanceEntry>[];
  /** Detected attempts: {provenance, reason} pairs only — never text. */
  readonly overrideAttempts: readonly Readonly<{
    provenance: PersonaUntrustedProvenance;
    reason: PersonaOverrideReason;
  }>[];
  /** Child-selectable exits incl. the trusted-adult help path. */
  readonly exitPaths: readonly EvalExitPath[];
}

/**
 * Resolve the persona rule set for ONE turn. The identity disclosure, core
 * traits, relation boundaries and exit paths come ONLY from the policy
 * snapshot; the style state is validated (every knob present with a
 * registered value); the actor is re-validated through the contract's
 * `parseActorContext` (server-verified identity, never client-asserted);
 * untrusted inputs contribute nothing except recorded override attempts.
 */
export function resolvePersonaTurn(input: Readonly<PersonaTurnInput>): Readonly<PersonaTurnResolution> {
  const actor = parseActorContext(input.actor);
  const identityDisclosure = personaIdentityDisclosureText(input.policy);
  assertValidStyleState(input.policy, input.style.style, "style");

  const overrideAttempts: {
    provenance: PersonaUntrustedProvenance;
    reason: PersonaOverrideReason;
  }[] = [];
  for (const entry of input.untrustedInputs) {
    if (
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.text !== "string" ||
      typeof entry.provenance !== "string" ||
      !(PERSONA_UNTRUSTED_PROVENANCES as readonly string[]).includes(entry.provenance)
    ) {
      // Unknown provenance or shape: fail closed without echoing it.
      throw new ContractValidationError([
        problem(
          "CONTRACT_FIELD_INVALID",
          "untrustedInputs[]",
          "untrusted input must carry a registered provenance and string text.",
        ),
      ]);
    }
    for (const reason of detectPersonaOverrideAttempts(entry.text)) {
      overrideAttempts.push({ provenance: entry.provenance, reason });
    }
  }

  return Object.freeze({
    policyId: input.policy.policyId,
    policyVersion: input.policy.version,
    turnIndex: input.turnIndex,
    actorRole: actor.role,
    identityDisclosure,
    coreTraits: Object.freeze([...input.policy.coreTraits]),
    boundariesEnforced: Object.freeze([...input.policy.relationBoundaries]),
    style: Object.freeze({ ...input.style.style }),
    knobProvenance: Object.freeze(input.style.provenance.map((entry) => Object.freeze(entry))),
    overrideAttempts: Object.freeze(overrideAttempts.map((entry) => Object.freeze(entry))),
    exitPaths: Object.freeze([...input.policy.exitPaths]),
  });
}

// ---------------------------------------------------------------------------
// Multi-turn resolution (shared trusted style state; stability surface)
// ---------------------------------------------------------------------------

/** One scripted conversation step (developer-authored, synthetic only). */
export interface PersonaConversationStep {
  readonly untrustedInputs: readonly PersonaUntrustedInput[];
  /**
   * Trusted style update applied BEFORE this turn (e.g. structured child
   * feedback between turns). Rejections are fail-closed: a script that
   * tries to sneak an untrusted source or unknown knob throws.
   */
  readonly styleUpdate?: {
    readonly source: PersonaKnobSource;
    readonly updates: readonly PersonaKnobUpdate[];
  };
}

/**
 * Resolve a multi-turn conversation under one policy snapshot. Style
 * changes flow only through {@link applyPersonaStyleKnobs}; identity,
 * traits, boundaries and exits are structurally identical across turns —
 * this function IS the multi-turn persona stability surface the eval
 * subject drives (issue #16 AC 1).
 */
export function resolvePersonaTurns(
  policy: Readonly<PersonaPolicyV0>,
  actor: unknown,
  steps: readonly PersonaConversationStep[],
): readonly Readonly<PersonaTurnResolution>[] {
  let style = personaDefaultStyle(policy);
  const resolutions: Readonly<PersonaTurnResolution>[] = [];
  steps.forEach((step, index) => {
    if (step.styleUpdate !== undefined) {
      const applied = applyPersonaStyleKnobs(
        policy,
        style,
        step.styleUpdate.updates,
        step.styleUpdate.source,
      );
      if (applied.status !== "applied") {
        throw new ContractValidationError([
          problem(
            "CONTRACT_FIELD_INVALID",
            `steps[${index}].styleUpdate`,
            `trusted style update was rejected: ${applied.reason}.`,
          ),
        ]);
      }
      style = Object.freeze({
        style: applied.style,
        provenance: applied.provenance,
      });
    }
    resolutions.push(
      resolvePersonaTurn({
        policy,
        style,
        actor,
        untrustedInputs: step.untrustedInputs,
        turnIndex: index,
      }),
    );
  });
  return Object.freeze(resolutions);
}
