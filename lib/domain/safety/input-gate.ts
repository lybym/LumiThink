/**
 * R1-15 Input Gate (docs/SAFETY_POLICY.md §4.1, HARNESS §5 入口断点).
 *
 * First enforced boundary of every turn: the submitted text is screened for
 * trusted-boundary attacks (prompt injection, forged identities, privacy
 * overreach) and crisis cues. All rules are server-owned; submitted content
 * is attack surface and can never relax them.
 *
 * Decision precedence (docs/SAFETY_POLICY.md §4): escalate_crisis > block >
 * allow. A crisis escalation means the normal advice script is suspended and
 * the deterministic crisis-safe response is used; the turn MUST NOT continue
 * into normal orchestration.
 */

import { ContractValidationError, problem } from "../contract/core.ts";

import { assessCrisisSignals, type CrisisAssessment } from "./crisis.ts";
import type { SafetyEntrance, SafetyRuleHit, SafetyRuleId } from "./policy.ts";
import { buildSafetyTrace, type SafetyTraceRecord, type SafetyTraceRefs } from "./trace.ts";

export interface InputGateResult {
  readonly decision: "allow" | "block" | "escalate_crisis";
  readonly hits: readonly SafetyRuleHit[];
  readonly trace: Readonly<SafetyTraceRecord>;
  /** Present exactly when the decision is "escalate_crisis". */
  readonly crisis: Readonly<CrisisAssessment> | null;
}

export interface InputGateOptions {
  readonly entrance?: SafetyEntrance;
  readonly refs?: Readonly<SafetyTraceRefs>;
  readonly decidedAt?: string;
}

/**
 * v0 input-layer detection patterns (synthetic corpus, deterministic).
 * Conservative in the safe direction: ambiguous high-severity cues block.
 */
const INJECTION_PATTERNS: readonly RegExp[] = Object.freeze([
  /忽略.{0,4}(?:之前|以上|前面|先前).{0,8}(?:指令|规则|设定|指示)/,
  /无视.{0,6}(?:指令|规则|设定)/,
  /(?:你现在是|从现在(?:起|开始)).{0,16}(?:没有|不受|无)(?:任何)?(?:限制|约束|规则)/,
  /你是.{0,8}(?:DAN|越狱|无限制|不受限)/,
  /越狱模式/,
  /开发者模式/,
  /(?:系统|初始|隐藏)(?:提示词|指令)/,
  /\b(?:ignore|disregard|forget)\b.{0,24}\b(?:previous|prior|above|earlier|all)\b.{0,24}\b(?:instructions?|rules?|prompts?|constraints?)\b/i,
  /\bsystem\s*prompt\b/i,
  /\bsystem\s*message\b/i,
  /\bdeveloper\s*mode\b/i,
  /\bdo\s+anything\s+now\b/i,
  /\bDAN\s+mode\b/i,
  /\bjailbreak\b/i,
]);

const ROLE_FORGERY_PATTERNS: readonly RegExp[] = Object.freeze([
  /我是(?:你)?(?:的)?(?:妈妈|爸爸|家长|监护人|老师|管理员|系统管理员|开发者|运维)/,
  /以(?:家长|监护人|管理员|老师|开发者)(?:的)?(?:身份|权限|名义)/,
  /已(?:通过)?(?:家长|监护人|身份|管理员)?验证/,
  /(?:I am|this is)\s+(?:your\s+)?(?:mom|mother|dad|father|parent|guardian|administrator|admin|developer)\b/i,
  /\bparent(?:al)?\s+(?:approval|verification|consent)\s+(?:is\s+)?(?:granted|verified|given)\b/i,
]);

const PRIVACY_OVERREACH_PATTERNS: readonly RegExp[] = Object.freeze([
  /(?:告诉我|发给我|给我|查一下|查询|帮我找|找到|读取|读|看一下|看|导出|获取).{0,8}(?:同学|朋友|别人|他人|其他(?:孩子|小朋友))(?:的)?(?:住址|家庭住址|家庭地址|身份证|密码|电话号码|电话|聊天记录|日记|隐私)/,
  /(?:同学|朋友|别人|他人|其他(?:孩子|小朋友))的(?:住址|家庭住址|家庭地址|身份证(?:号码|号)?|密码|电话号码|聊天记录|日记)/,
  /(?:读|看|查|导出|删除).{0,8}(?:其他|别的)(?:孩子|儿童)(?:的)?(?:记忆|数据|档案|记录)/,
  /(?:把|将).{0,10}(?:系统|数据库|后台)(?:里|中|里面)?(?:的)?(?:所有)?(?:密码|密钥|凭据|数据|记录).{0,6}(?:给|发|告诉|打印)我/,
  /(?:passwords?|api\s*keys?|secrets?)\s+of\s+(?:other|my\s+classmate|another)/i,
]);

function hitsFrom(layer: "input", ruleId: SafetyRuleId): SafetyRuleHit {
  return Object.freeze({ ruleId, layer, severity: "high" as const });
}

function firstMatch(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Evaluate one submitted text against the input layer.
 * Never echoes the submitted text in results (structured rule ids only).
 */
export function evaluateInputGate(text: string, options: InputGateOptions = {}): InputGateResult {
  if (typeof text !== "string") {
    throw new ContractValidationError([
      problem("CONTRACT_FIELD_INVALID", "text", "input gate expects string text."),
    ]);
  }

  const hits: SafetyRuleHit[] = [];

  // Crisis assessment first: crisis escalation dominates the decision.
  const crisis = assessCrisisSignals(text);
  if (crisis !== null) {
    hits.push(hitsFrom("input", "input.crisis_signals"));
  }

  if (firstMatch(text, INJECTION_PATTERNS)) {
    hits.push(hitsFrom("input", "input.prompt_injection"));
  }
  if (firstMatch(text, ROLE_FORGERY_PATTERNS)) {
    hits.push(hitsFrom("input", "input.role_forgery"));
  }
  if (firstMatch(text, PRIVACY_OVERREACH_PATTERNS)) {
    hits.push(hitsFrom("input", "input.privacy_overreach"));
  }

  const decision: InputGateResult["decision"] =
    crisis !== null ? "escalate_crisis" : hits.length > 0 ? "block" : "allow";

  const trace = buildSafetyTrace({
    layer: "input",
    decision,
    ruleIds: hits.map((hit) => hit.ruleId),
    reason: crisis !== null ? "crisis_escalation" : "rule_hit",
    entrance: options.entrance,
    refs: options.refs,
    decidedAt: options.decidedAt,
  });

  return Object.freeze({
    decision,
    hits: Object.freeze(hits),
    trace,
    crisis,
  });
}
