/**
 * R1-06 guardian authorizations domain (issue #18, PRD FR-005 / UC-06,
 * Roadmap R1-06, docs/API_CONTRACT.md §12).
 *
 * Server-owned semantics for the single-family first phase:
 * - the versioned guardian disclosure registry (AI usage scope, third-party
 *   LLM/ASR/TTS data egress & retention explanation) — static, human-governed
 *   content like the persona/safety registries; unverified jurisdiction or
 *   vendor facts are explicitly flagged `pendingVerification`, never asserted
 *   as verified (honest-observation rule);
 * - consent + feature-switch state with strict, idempotent transitions
 *   (grant / revoke / toggle) that REQUIRE the current disclosure version to
 *   be acknowledged first — except revocation, which is always allowed
 *   (fail-safe direction);
 * - fail-closed request parsing for the guardian API payloads (unknown
 *   protocol versions, unknown fields, unregistered ids and malformed shapes
 *   are rejected; submitted values that failed validation are NEVER echoed);
 * - the structured audit-event vocabulary for security-relevant changes
 *   (issue #18 实现范围 4: 安全变更审计).
 *
 * There is deliberately NO API shape here that could grant or elevate a role:
 * role assignment is server-side configuration (the family registry), and
 * every parser below rejects unknown fields, so a client cannot smuggle a
 * role/child_id past any guardian surface (issue #18 实现范围 3).
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
import {
  PERSONA_KNOB_VALUES,
  PERSONA_STYLE_KNOBS,
  type PersonaStyleKnobId,
} from "../persona/policy.ts";

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

/** Supported guardian API payload versions; unknown versions fail closed. */
export const GUARDIAN_API_PROTOCOL_VERSIONS = Object.freeze(["1.0"] as const);

export type GuardianApiProtocolVersion = (typeof GUARDIAN_API_PROTOCOL_VERSIONS)[number];

/** No-echo mask for any submitted value that failed validation. */
export const GUARDIAN_MASKED_VALUE = "[masked]" as const;

function requireProtocolVersion(value: unknown, problems: ContractProblem[]): void {
  if (value === undefined || value === null || value === "") {
    problems.push(problem("CONTRACT_FIELD_MISSING", "protocolVersion", "protocolVersion is required."));
    return;
  }
  if (!(GUARDIAN_API_PROTOCOL_VERSIONS as readonly string[]).includes(value as string)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "protocolVersion", "protocolVersion is not a supported version."),
    );
  }
}

/**
 * Reject unknown top-level fields (no-echo: only the field COUNT is named,
 * never the attacker-controlled key text — same discipline as the safety
 * trace parser's masked unknown-field fingerprint).
 */
function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  problems: ContractProblem[],
): void {
  const unknownCount = Object.keys(record).filter((key) => !allowed.includes(key)).length;
  if (unknownCount > 0) {
    problems.push(
      problem(
        "CONTRACT_FIELD_INVALID",
        path,
        `payload carries ${unknownCount} unknown field(s); unknown fields are rejected without echo.`,
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Server-owned family registry (synthetic demo values, issue #18 实现范围 1)
// ---------------------------------------------------------------------------

/** The single demo family of the first-phase web MVP (synthetic, disclosed). */
export const GUARDIAN_FAMILY_CHILD_REF = "chd_demo_001" as const;
export const GUARDIAN_ACTOR_ID = "act_guardian_demo01" as const;
export const ADMIN_ACTOR_ID = "act_admin_demo01" as const;

// ---------------------------------------------------------------------------
// Disclosure registry (server-owned versioned content)
// ---------------------------------------------------------------------------

export const GUARDIAN_DISCLOSURE_ID = "guardian_ai_usage_disclosure" as const;

export interface GuardianDisclosureSection {
  readonly sectionId: string;
  readonly heading: string;
  readonly body: string;
  /**
   * True when the statement depends on a jurisdiction/vendor fact that is NOT
   * yet verified (e.g. hotline channels, vendor retention windows). Such
   * sections must stay visibly flagged — never presented as verified.
   */
  readonly pendingVerification: boolean;
}

export interface GuardianDisclosureDocument {
  readonly disclosureId: typeof GUARDIAN_DISCLOSURE_ID;
  readonly version: string;
  readonly language: "zh";
  readonly sections: readonly GuardianDisclosureSection[];
}

/**
 * v0 disclosure: what the AI is used for, what third-party processing exists
 * today (none — the in-process mock), what would change if it were enabled,
 * and the monitoring boundary (no default verbatim surveillance). Vendor
 * retention/jurisdiction facts carry explicit pending-verification flags
 * (carried #27 review caveat: unverified external facts must not be
 * presented as verified).
 */
/**
 * Versioned guardian disclosure registry. v1.1.0 (R1-09, issue #21) is the
 * first version that governs SAVED child content: it adds the guardian-
 * visible save explanation (家长可见保存说明) and replaces the 1.0.0
 * monitoring-boundary wording (which pre-dated any guardian data surface).
 * 1.0.0 stays registered so its historical acknowledgments remain auditable.
 */
export const GUARDIAN_DISCLOSURES: Readonly<
  Record<string, GuardianDisclosureDocument>
> = Object.freeze({
  "1.0.0": Object.freeze({
    disclosureId: GUARDIAN_DISCLOSURE_ID,
    version: "1.0.0",
    language: "zh",
    sections: Object.freeze([
      Object.freeze({
        sectionId: "ai_usage_scope",
        heading: "AI 的使用范围",
        body:
          "Lumi 是一个面向儿童的学习与情绪支持 AI 伙伴。它只在孩子发起对话时处理当轮文本与最小必要上下文，" +
          "不用于临床诊断、心理治疗或能力评分。孩子随时可以退出或拒绝建议，AI 身份始终明示。",
        pendingVerification: false,
      }),
      Object.freeze({
        sectionId: "third_party_processing_current",
        heading: "当前第三方数据处理状态",
        body:
          "当前演示部署仅使用进程内 Mock 模型：模型调用不经过任何第三方网络服务，外部数据外发为零。" +
          "「第三方数据外发」功能开关默认关闭。",
        pendingVerification: false,
      }),
      Object.freeze({
        sectionId: "third_party_processing_if_enabled",
        heading: "若启用第三方模型/语音服务（LLM/ASR/TTS）",
        body:
          "启用后，对话文本将发送给所配置的模型供应商处理；语音路径（未来版本）还可能涉及 ASR/TTS 供应商。" +
          "各供应商的数据用途、存储地域、保留期限与日志行为必须在启用前逐一完成独立数据外发评审；" +
          "本说明中的供应商保留/地域描述为占位说明，未经核实前不作为已验证事实。",
        pendingVerification: true,
      }),
      Object.freeze({
        sectionId: "monitoring_boundary",
        heading: "家长可见范围与监控边界",
        body:
          "默认不提供对儿童对话的逐字监控。家长可查看的是必要摘要与计数（会话数、模型调用次数等），" +
          "以及授权/开关/审计记录；逐字聊天内容不属于本版本的家长面。孩子知道自己与 AI 的互动会被如何记录。",
        pendingVerification: false,
      }),
      Object.freeze({
        sectionId: "crisis_channels_placeholder",
        heading: "危机求助渠道（占位）",
        body:
          "安全策略中的紧急渠道（110/120、青少年热线 12355）目前是面向中文部署的公开占位值；" +
          "生产启用前必须按部署地域核实并配置正确渠道。",
        pendingVerification: true,
      }),
    ]),
  }),
  /**
   * R1-09 (issue #21) disclosure: adds the data-lifecycle save explanation
   * and rewrites the monitoring boundary to match the new guardian
   * view/export/delete surface (explicit opt-in via the recording switch —
   * never a default verbatim feed). Vendor facts stay pending verification.
   */
  "1.1.0": Object.freeze({
    disclosureId: GUARDIAN_DISCLOSURE_ID,
    version: "1.1.0",
    language: "zh",
    sections: Object.freeze([
      Object.freeze({
        sectionId: "ai_usage_scope",
        heading: "AI 的使用范围",
        body:
          "Lumi 是一个面向儿童的学习与情绪支持 AI 伙伴。它只在孩子发起对话时处理当轮文本与最小必要上下文，" +
          "不用于临床诊断、心理治疗或能力评分。孩子随时可以退出或拒绝建议，AI 身份始终明示。",
        pendingVerification: false,
      }),
      Object.freeze({
        sectionId: "third_party_processing_current",
        heading: "当前第三方数据处理状态",
        body:
          "当前演示部署仅使用进程内 Mock 模型：模型调用不经过任何第三方网络服务，外部数据外发为零。" +
          "「第三方数据外发」功能开关默认关闭。",
        pendingVerification: false,
      }),
      Object.freeze({
        sectionId: "third_party_processing_if_enabled",
        heading: "若启用第三方模型/语音服务（LLM/ASR/TTS）",
        body:
          "启用后，对话文本将发送给所配置的模型供应商处理；语音路径（未来版本）还可能涉及 ASR/TTS 供应商。" +
          "各供应商的数据用途、存储地域、保留期限与日志行为必须在启用前逐一完成独立数据外发评审；" +
          "本说明中的供应商保留/地域描述为占位说明，未经核实前不作为已验证事实。供应商侧的删除能力无法由本系统担保，" +
          "撤销授权后本系统不再向供应商发起新请求，但已外发数据的供应商侧保留以各供应商评审结论为准。",
        pendingVerification: true,
      }),
      Object.freeze({
        sectionId: "data_lifecycle_saving",
        heading: "对话保存说明（记录开关）",
        body:
          "默认最小化采集：对话记录开关默认关闭，系统只保留运行必需的操作元数据（会话数、审计事实等），" +
          "不保存完整聊天正文。开启「对话记录」后，每个会话最多保留最近 40 条对话文本，仅用于在会话内延续上下文；" +
          "数据只在本进程内存中，进程重启即清空。无论开关状态如何，音频一律不采集、不存储（当前部署没有语音采集路径）。" +
          "监护人可在数据生命周期区按授权身份查看、导出或删除已保存内容；删除为立即硬删除，并同步清除会话与临时工件。",
        pendingVerification: false,
      }),
      Object.freeze({
        sectionId: "monitoring_boundary",
        heading: "家长可见范围与监控边界",
        body:
          "默认不提供对儿童对话的逐字监控；家长默认可见的是必要摘要与计数（会话数、模型调用次数等）、" +
          "授权/开关/审计记录。仅当监护人显式开启「对话记录」后，家长才能按授权身份查看/导出已保存的对话文本，" +
          "同一入口提供立即删除。开启记录属于显式选择而非默认行为；孩子知道自己与 AI 的互动会被如何记录。",
        pendingVerification: false,
      }),
      Object.freeze({
        sectionId: "crisis_channels_placeholder",
        heading: "危机求助渠道（占位）",
        body:
          "安全策略中的紧急渠道（110/120、青少年热线 12355）目前是面向中文部署的公开占位值；" +
          "生产启用前必须按部署地域核实并配置正确渠道。",
        pendingVerification: true,
      }),
    ]),
  }),
});

/** The current disclosure version every mutation is validated against. */
export const CURRENT_GUARDIAN_DISCLOSURE_VERSION = "1.1.0" as const;

export function currentGuardianDisclosure(): Readonly<GuardianDisclosureDocument> {
  // Registry lookups use Object.hasOwn only (carried #25/#15 review lesson):
  // prototype-chain keys like "constructor" can never resolve as a version.
  if (!Object.hasOwn(GUARDIAN_DISCLOSURES, CURRENT_GUARDIAN_DISCLOSURE_VERSION)) {
    // Registry corruption is a server bug: fail closed.
    throw new ContractValidationError([
      problem("CONTRACT_INTERNAL", "disclosure", "the guardian disclosure registry is misconfigured."),
    ]);
  }
  return GUARDIAN_DISCLOSURES[CURRENT_GUARDIAN_DISCLOSURE_VERSION];
}

// ---------------------------------------------------------------------------
// Consents and feature switches (registries + state transitions)
// ---------------------------------------------------------------------------

export const GUARDIAN_CONSENT_IDS = Object.freeze(["child_model_interaction"] as const);
export type GuardianConsentId = (typeof GUARDIAN_CONSENT_IDS)[number];

/**
 * Feature switch registry. `third_party_data_egress` (R1-06) gates vendor
 * transport BEFORE any request. `conversation_recording` (R1-09, issue #21)
 * gates whether the serving surface RETAINS conversation text: the default
 * is DISABLED — 默认最小化采集 (docs/MEMORY_POLICY.md) — so full chats are
 * stored only when a guardian explicitly opts in (which requires the current
 * disclosure to be acknowledged, same as every other enabling switch).
 */
export const GUARDIAN_FEATURE_SWITCH_IDS = Object.freeze([
  "third_party_data_egress",
  "conversation_recording",
] as const);
export type GuardianFeatureSwitchId = (typeof GUARDIAN_FEATURE_SWITCH_IDS)[number];

export interface GuardianConsentState {
  readonly consentId: GuardianConsentId;
  readonly active: boolean;
  readonly changedAt: string | null;
}

export interface GuardianSwitchState {
  readonly switchId: GuardianFeatureSwitchId;
  readonly enabled: boolean;
  readonly changedAt: string | null;
}

/** Server-owned authorization state of the family (in-memory MVP). */
export interface GuardianAuthorizationState {
  readonly disclosureAckVersion: string | null;
  readonly disclosureAckAt: string | null;
  readonly consents: Readonly<Record<GuardianConsentId, GuardianConsentState>>;
  readonly switches: Readonly<Record<GuardianFeatureSwitchId, GuardianSwitchState>>;
}

/**
 * Seed state of the demo family (disclosed in the PR/docs): the synthetic
 * demo guardian has acknowledged the demo disclosure and the base
 * child-model-interaction consent is ACTIVE so the existing web MVP child
 * chat keeps working; the third-party egress switch defaults to DISABLED
 * (fail-closed). Every seeded element is recorded as an audit `seed` entry.
 */
export function initialGuardianAuthorizationState(nowIso: string): Readonly<GuardianAuthorizationState> {
  const consents = {} as Record<GuardianConsentId, GuardianConsentState>;
  for (const consentId of GUARDIAN_CONSENT_IDS) {
    consents[consentId] = Object.freeze({
      consentId,
      active: consentId === "child_model_interaction",
      changedAt: nowIso,
    });
  }
  const switches = {} as Record<GuardianFeatureSwitchId, GuardianSwitchState>;
  for (const switchId of GUARDIAN_FEATURE_SWITCH_IDS) {
    switches[switchId] = Object.freeze({ switchId, enabled: false, changedAt: nowIso });
  }
  return Object.freeze({
    disclosureAckVersion: CURRENT_GUARDIAN_DISCLOSURE_VERSION,
    disclosureAckAt: nowIso,
    consents: Object.freeze(consents),
    switches: Object.freeze(switches),
  });
}

export function isConsentActive(
  state: Readonly<GuardianAuthorizationState>,
  consentId: GuardianConsentId,
): boolean {
  return state.consents[consentId]?.active === true;
}

export function isSwitchEnabled(
  state: Readonly<GuardianAuthorizationState>,
  switchId: GuardianFeatureSwitchId,
): boolean {
  return state.switches[switchId]?.enabled === true;
}

// ---------------------------------------------------------------------------
// Action parsing (fail-closed, no-echo)
// ---------------------------------------------------------------------------

export type GuardianAuthorizationAction =
  | { readonly kind: "acknowledge_disclosure"; readonly disclosureVersion: string }
  | { readonly kind: "grant_consent"; readonly consentId: GuardianConsentId }
  | { readonly kind: "revoke_consent"; readonly consentId: GuardianConsentId }
  | {
      readonly kind: "set_feature_switch";
      readonly switchId: GuardianFeatureSwitchId;
      readonly enabled: boolean;
    }
  | {
      readonly kind: "set_persona_style";
      readonly updates: readonly { readonly knobId: PersonaStyleKnobId; readonly value: string }[];
    };

const ACTION_KINDS = Object.freeze([
  "acknowledge_disclosure",
  "grant_consent",
  "revoke_consent",
  "set_feature_switch",
  "set_persona_style",
] as const);

/**
 * Parse one POST /api/v1/guardian/authorizations body. Unknown protocol
 * versions, unknown actions, unregistered ids, malformed values and unknown
 * fields all fail closed; submitted ids/values that failed validation are
 * never echoed (masked).
 */
export function parseGuardianAuthorizationAction(body: unknown): Readonly<GuardianAuthorizationAction> {
  const problems: ContractProblem[] = [];
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "body", "authorizations body must be an object."),
    ]);
  }
  const record = body as Record<string, unknown>;
  requireProtocolVersion(record.protocolVersion, problems);
  rejectUnknownFields(
    record,
    ["protocolVersion", "action", "disclosureVersion", "consentId", "switchId", "enabled", "updates"],
    "body",
    problems,
  );

  const action = record.action;
  if (action === undefined || action === null || action === "") {
    problems.push(problem("CONTRACT_FIELD_MISSING", "action", "action is required."));
  } else if (!(ACTION_KINDS as readonly string[]).includes(action as string)) {
    problems.push(
      problem("CONTRACT_FIELD_INVALID", "action", "action is not a registered guardian action."),
    );
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }

  switch (action as GuardianAuthorizationAction["kind"]) {
    case "acknowledge_disclosure": {
      const version = record.disclosureVersion;
      if (typeof version !== "string" || version.length === 0 || version.length > 32) {
        throw new ContractValidationError([
          problem(
            "CONTRACT_FIELD_INVALID",
            "disclosureVersion",
            "disclosureVersion must be a bounded version string.",
          ),
        ]);
      }
      if (!Object.hasOwn(GUARDIAN_DISCLOSURES, version)) {
        // Unregistered version: rejected without echoing the submitted value.
        throw new ContractValidationError([
          problem(
            "CONTRACT_FIELD_INVALID",
            "disclosureVersion",
            `disclosureVersion must be a registered version (${GUARDIAN_MASKED_VALUE}).`,
          ),
        ]);
      }
      return Object.freeze({ kind: "acknowledge_disclosure", disclosureVersion: version });
    }
    case "grant_consent":
    case "revoke_consent": {
      const consentId = record.consentId;
      if (typeof consentId !== "string" || !(GUARDIAN_CONSENT_IDS as readonly string[]).includes(consentId)) {
        throw new ContractValidationError([
          problem(
            "CONTRACT_FIELD_INVALID",
            "consentId",
            `consentId must be a registered consent id (${GUARDIAN_MASKED_VALUE}).`,
          ),
        ]);
      }
      return Object.freeze(
        action === "grant_consent"
          ? { kind: "grant_consent", consentId: consentId as GuardianConsentId }
          : { kind: "revoke_consent", consentId: consentId as GuardianConsentId },
      );
    }
    case "set_feature_switch": {
      const switchId = record.switchId;
      if (
        typeof switchId !== "string" ||
        !(GUARDIAN_FEATURE_SWITCH_IDS as readonly string[]).includes(switchId)
      ) {
        throw new ContractValidationError([
          problem(
            "CONTRACT_FIELD_INVALID",
            "switchId",
            `switchId must be a registered feature switch id (${GUARDIAN_MASKED_VALUE}).`,
          ),
        ]);
      }
      if (typeof record.enabled !== "boolean") {
        throw new ContractValidationError([
          problem("CONTRACT_FIELD_INVALID", "enabled", "enabled must be a boolean."),
        ]);
      }
      return Object.freeze({
        kind: "set_feature_switch",
        switchId: switchId as GuardianFeatureSwitchId,
        enabled: record.enabled,
      });
    }
    case "set_persona_style": {
      const updates = record.updates;
      if (!Array.isArray(updates) || updates.length === 0 || updates.length > PERSONA_STYLE_KNOBS.length) {
        throw new ContractValidationError([
          problem(
            "CONTRACT_FIELD_INVALID",
            "updates",
            "updates must be a non-empty list of at most one entry per registered knob.",
          ),
        ]);
      }
      const seen = new Set<string>();
      const parsed: { knobId: PersonaStyleKnobId; value: string }[] = [];
      for (const entry of updates) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
          throw new ContractValidationError([
            problem("CONTRACT_FIELD_INVALID", "updates[]", "each update must be an object."),
          ]);
        }
        const entryRecord = entry as Record<string, unknown>;
        rejectUnknownFields(entryRecord, ["knobId", "value"], "updates[]", problems);
        const knobId = entryRecord.knobId;
        if (
          typeof knobId !== "string" ||
          !(PERSONA_STYLE_KNOBS as readonly string[]).includes(knobId) ||
          seen.has(knobId)
        ) {
          throw new ContractValidationError([
            problem(
              "CONTRACT_FIELD_INVALID",
              "updates[].knobId",
              `updates[].knobId must be a registered, non-duplicated knob id (${GUARDIAN_MASKED_VALUE}).`,
            ),
          ]);
        }
        seen.add(knobId);
        const value = entryRecord.value;
        if (
          typeof value !== "string" ||
          !(PERSONA_KNOB_VALUES[knobId as PersonaStyleKnobId] as readonly string[]).includes(value)
        ) {
          throw new ContractValidationError([
            problem(
              "CONTRACT_FIELD_INVALID",
              "updates[].value",
              `updates[].value must be a registered value for the knob (${GUARDIAN_MASKED_VALUE}).`,
            ),
          ]);
        }
        parsed.push({ knobId: knobId as PersonaStyleKnobId, value });
      }
      return Object.freeze({ kind: "set_persona_style", updates: Object.freeze(parsed) });
    }
    default: {
      // Unreachable (action validated above); kept fail-closed.
      throw new ContractValidationError([
        problem("CONTRACT_FIELD_INVALID", "action", "action is not a registered guardian action."),
      ]);
    }
  }
}

// ---------------------------------------------------------------------------
// State transitions (pure)
// ---------------------------------------------------------------------------

export type GuardianAuthorizationTransition =
  | { readonly status: "applied"; readonly next: Readonly<GuardianAuthorizationState> }
  | { readonly status: "unchanged"; readonly next: Readonly<GuardianAuthorizationState> }
  | {
      readonly status: "rejected";
      readonly reason:
        | "disclosure_not_acknowledged"
        | "unknown_disclosure_version";
    };

function withConsent(
  state: Readonly<GuardianAuthorizationState>,
  consentId: GuardianConsentId,
  active: boolean,
  nowIso: string,
): Readonly<GuardianAuthorizationState> {
  return Object.freeze({
    ...state,
    consents: Object.freeze({
      ...state.consents,
      [consentId]: Object.freeze({ consentId, active, changedAt: nowIso }),
    }),
  });
}

function withSwitch(
  state: Readonly<GuardianAuthorizationState>,
  switchId: GuardianFeatureSwitchId,
  enabled: boolean,
  nowIso: string,
): Readonly<GuardianAuthorizationState> {
  return Object.freeze({
    ...state,
    switches: Object.freeze({
      ...state.switches,
      [switchId]: Object.freeze({ switchId, enabled, changedAt: nowIso }),
    }),
  });
}

/**
 * Apply one parsed action to the authorization state. Rules:
 * - consent grants / switch changes require the CURRENT disclosure version
 *   to be acknowledged (告知阅读先行); revocation is always allowed (the
 *   fail-safe direction must never be blocked by a missing acknowledgment);
 * - acknowledgments must reference a registered disclosure version;
 * - transitions are idempotent: re-granting an active consent or re-setting
 *   an unchanged switch returns `unchanged` with the SAME state (no duplicate
 *   audit entry, no changedAt churn).
 */
export function applyGuardianAuthorizationAction(
  state: Readonly<GuardianAuthorizationState>,
  action: Readonly<GuardianAuthorizationAction>,
  nowIso: string,
): Readonly<GuardianAuthorizationTransition> {
  switch (action.kind) {
    case "acknowledge_disclosure": {
      if (!Object.hasOwn(GUARDIAN_DISCLOSURES, action.disclosureVersion)) {
        return Object.freeze({ status: "rejected", reason: "unknown_disclosure_version" });
      }
      if (state.disclosureAckVersion === action.disclosureVersion) {
        return Object.freeze({ status: "unchanged", next: state });
      }
      return Object.freeze({
        status: "applied",
        next: Object.freeze({
          ...state,
          disclosureAckVersion: action.disclosureVersion,
          disclosureAckAt: nowIso,
        }),
      });
    }
    case "grant_consent": {
      if (state.disclosureAckVersion !== CURRENT_GUARDIAN_DISCLOSURE_VERSION) {
        return Object.freeze({ status: "rejected", reason: "disclosure_not_acknowledged" });
      }
      if (isConsentActive(state, action.consentId)) {
        return Object.freeze({ status: "unchanged", next: state });
      }
      return Object.freeze({
        status: "applied",
        next: withConsent(state, action.consentId, true, nowIso),
      });
    }
    case "revoke_consent": {
      if (!isConsentActive(state, action.consentId)) {
        return Object.freeze({ status: "unchanged", next: state });
      }
      return Object.freeze({
        status: "applied",
        next: withConsent(state, action.consentId, false, nowIso),
      });
    }
    case "set_feature_switch": {
      if (action.enabled && state.disclosureAckVersion !== CURRENT_GUARDIAN_DISCLOSURE_VERSION) {
        return Object.freeze({ status: "rejected", reason: "disclosure_not_acknowledged" });
      }
      if (isSwitchEnabled(state, action.switchId) === action.enabled) {
        return Object.freeze({ status: "unchanged", next: state });
      }
      return Object.freeze({
        status: "applied",
        next: withSwitch(state, action.switchId, action.enabled, nowIso),
      });
    }
    case "set_persona_style": {
      // Style state lives outside the authorization state (persona domain);
      // the caller applies it through applyPersonaStyleKnobs. Requiring the
      // disclosure acknowledgment keeps every guardian mutation symmetric.
      if (state.disclosureAckVersion !== CURRENT_GUARDIAN_DISCLOSURE_VERSION) {
        return Object.freeze({ status: "rejected", reason: "disclosure_not_acknowledged" });
      }
      return Object.freeze({ status: "unchanged", next: state });
    }
    default: {
      return Object.freeze({ status: "rejected", reason: "unknown_disclosure_version" });
    }
  }
}

// ---------------------------------------------------------------------------
// Status snapshot (GET /api/v1/guardian/authorizations)
// ---------------------------------------------------------------------------

export interface GuardianUsageSummary {
  readonly conversationCount: number;
}

export interface GuardianEgressStatus {
  /** Provider request counts per registered provider id (vendor attempts). */
  readonly providerRequestCounts: Readonly<Record<string, number>>;
  /** Sum of request counts across third-party-classified providers. */
  readonly thirdPartyProviderRequestCount: number;
}

/** Serialized audit entry shape shared with the audit route. */
export interface GuardianAuditEntryView {
  readonly seq: number;
  readonly at: string;
  readonly kind: string;
  readonly actorRole: string | null;
  readonly actorId: string | null;
  readonly target: string | null;
  readonly detail: string | null;
}

export interface GuardianStatusSnapshot {
  readonly protocolVersion: GuardianApiProtocolVersion;
  readonly disclosure: {
    readonly document: Readonly<GuardianDisclosureDocument>;
    readonly acknowledgedVersion: string | null;
    readonly acknowledgedAt: string | null;
  };
  readonly consents: readonly Readonly<GuardianConsentState>[];
  readonly switches: readonly Readonly<GuardianSwitchState>[];
  readonly egress: Readonly<GuardianEgressStatus>;
  readonly usage: Readonly<GuardianUsageSummary>;
  readonly style: {
    readonly values: Readonly<Record<string, string>>;
    readonly provenance: readonly { readonly knobId: string; readonly value: string; readonly source: string }[];
  };
  readonly activeSessions: number;
  readonly auditTail: readonly Readonly<GuardianAuditEntryView>[];
}

/**
 * Build + re-validate the status snapshot at emit time (fail-closed out,
 * like the interaction ack). The snapshot carries counts, registry content
 * and ids only — no chat text, no session tokens, no credential material.
 */
export function buildGuardianStatusSnapshot(parts: {
  readonly state: Readonly<GuardianAuthorizationState>;
  readonly egress: Readonly<GuardianEgressStatus>;
  readonly usage: Readonly<GuardianUsageSummary>;
  readonly style: {
    readonly values: Readonly<Record<string, string>>;
    readonly provenance: readonly { readonly knobId: string; readonly value: string; readonly source: string }[];
  };
  readonly activeSessions: number;
  readonly auditTail: readonly Readonly<GuardianAuditEntryView>[];
}): Readonly<GuardianStatusSnapshot> {
  return ingestDomainFact({
    protocolVersion: "1.0",
    disclosure: {
      document: currentGuardianDisclosure(),
      acknowledgedVersion: parts.state.disclosureAckVersion,
      acknowledgedAt: parts.state.disclosureAckAt,
    },
    consents: GUARDIAN_CONSENT_IDS.map((consentId) => parts.state.consents[consentId]),
    switches: GUARDIAN_FEATURE_SWITCH_IDS.map((switchId) => parts.state.switches[switchId]),
    egress: parts.egress,
    usage: parts.usage,
    style: parts.style,
    activeSessions: parts.activeSessions,
    auditTail: parts.auditTail,
  }) as Readonly<GuardianStatusSnapshot>;
}

// ---------------------------------------------------------------------------
// Audit events (security-change audit, issue #18 实现范围 4)
// ---------------------------------------------------------------------------

export const GUARDIAN_AUDIT_KINDS = Object.freeze([
  "seed",
  "login_success",
  "login_failed",
  "login_locked_out",
  "logout",
  "disclosure_ack",
  "consent_grant",
  "consent_revoke",
  "switch_change",
  "style_change",
  "access_denied",
  "guardian_cancel",
  // R1-09 (issue #21) data-lifecycle operations: structural facts only —
  // target is the pinned family childRef, detail carries bounded counts;
  // deleted content NEVER enters the audit (docs/MEMORY_POLICY.md).
  "data_view",
  "data_export",
  "data_erase",
  "data_erase_replay",
  // R1-08 (issue #20) encrypted runtime snapshot: the boot-time restore
  // discloses its structural result (source + bounded counts; never any
  // snapshot content or key material).
  "snapshot_restored",
] as const);

export type GuardianAuditKind = (typeof GUARDIAN_AUDIT_KINDS)[number];

export interface GuardianAuditEntry {
  readonly seq: number;
  readonly at: string;
  readonly kind: GuardianAuditKind;
  /** Known actor role or "anonymous" (no session) / null for seeds. */
  readonly actorRole: string | null;
  /** Server-generated actor id when known; never a credential. */
  readonly actorId: string | null;
  /** Registered target id (consent/switch/disclosure version) or null. */
  readonly target: string | null;
  /** Bounded structural detail; never submitted text or credentials. */
  readonly detail: string | null;
}

/**
 * Parse + re-validate one audit entry (fail-closed out). Values are limited
 * to bounded structural strings; the audit path must never carry submitted
 * text, tokens or credentials (tested).
 */
export function parseGuardianAuditEntry(value: unknown): Readonly<GuardianAuditEntry> {
  const problems: ContractProblem[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "auditEntry", "audit entry must be an object."),
    ]);
  }
  const record = value as Record<string, unknown>;
  rejectUnknownFields(record, ["seq", "at", "kind", "actorRole", "actorId", "target", "detail"], "auditEntry", problems);
  if (typeof record.seq !== "number" || !Number.isInteger(record.seq) || record.seq < 0) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "auditEntry.seq", "seq must be a non-negative integer."));
  }
  if (typeof record.at !== "string" || record.at.length === 0 || record.at.length > 40) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "auditEntry.at", "at must be a bounded timestamp."));
  }
  if (
    typeof record.kind !== "string" ||
    !(GUARDIAN_AUDIT_KINDS as readonly string[]).includes(record.kind)
  ) {
    problems.push(problem("CONTRACT_FIELD_INVALID", "auditEntry.kind", "kind must be a registered audit kind."));
  }
  for (const field of ["actorRole", "actorId", "target", "detail"] as const) {
    const raw = record[field];
    if (raw !== null && (typeof raw !== "string" || raw.length > 80)) {
      problems.push(
        problem("CONTRACT_FIELD_INVALID", `auditEntry.${field}`, `${field} must be null or a bounded string.`),
      );
    }
  }
  if (problems.length > 0) {
    throw new ContractValidationError(problems);
  }
  return ingestDomainFact({
    seq: record.seq,
    at: record.at,
    kind: record.kind,
    actorRole: record.actorRole ?? null,
    actorId: record.actorId ?? null,
    target: record.target ?? null,
    detail: record.detail ?? null,
  }) as Readonly<GuardianAuditEntry>;
}
