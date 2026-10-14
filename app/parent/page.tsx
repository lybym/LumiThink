"use client";

/**
 * R1-06 Guardian console (issue #18; PRD UC-06 基础能力; Roadmap R1-06;
 * docs/API_CONTRACT.md §12).
 *
 * Replaces the frozen legacy prototype page (docs/LEGACY_AUDIT.md flagged
 * its old "cognitive diagnosis" copy as 2.0-incompatible). The console:
 *
 * - logs the guardian/admin in with the demo access code (SYNTHETIC demo
 *   credential, clearly labeled; the token is held in memory only — never
 *   in a cookie or storage — so a refresh simply requires re-login);
 * - renders the server-owned disclosure (AI usage scope, third-party
 *   LLM/ASR/TTS egress & retention explanation, monitoring boundary) with
 *   explicit 待核实 markers where facts are not yet verified;
 * - performs acknowledge / grant / revoke / feature-switch / persona style
 *   actions and reflects the live status (consents, switches, vendor
 *   request counts, usage counts, audit tail);
 * - never renders raw server error envelopes: failures map to fixed,
 *   guardian-appropriate copy (same leak rule as the kid chat client), and
 *   an auth failure drops the in-memory token back to the login screen.
 */

import { useCallback, useEffect, useState } from "react";

interface DisclosureSection {
  sectionId: string;
  heading: string;
  body: string;
  pendingVerification: boolean;
}

interface StatusSnapshot {
  disclosure: {
    document: { version: string; sections: DisclosureSection[] };
    acknowledgedVersion: string | null;
  };
  consents: { consentId: string; active: boolean }[];
  switches: { switchId: string; enabled: boolean }[];
  egress: {
    providerRequestCounts: Record<string, number>;
    thirdPartyProviderRequestCount: number;
  };
  usage: { conversationCount: number };
  style: {
    values: Record<string, string>;
    provenance: { knobId: string; value: string; source: string }[];
  };
  activeSessions: number;
  auditTail: { seq: number; at: string; kind: string; actorRole: string | null; target: string | null }[];
}

interface AuditEntry {
  seq: number;
  at: string;
  kind: string;
  actorRole: string | null;
  target: string | null;
  detail: string | null;
}

type UiError = "auth" | "rejected" | "invalid" | "network";

const ERROR_COPY: Record<UiError, string> = {
  auth: "鉴权失败或会话已失效，请重新登录。",
  rejected: "请求被拒绝，请确认当前状态后重试。",
  invalid: "请求无效，请检查输入。",
  network: "服务暂不可用，请稍后重试。",
};

/** Demo access codes (synthetic demo material; real secret management is R1-08). */
const DEMO_GUARDIAN_CODE = "lumithink-guardian-demo";
const DEMO_ADMIN_CODE = "lumithink-admin-demo";

const KNOB_LABELS: Record<string, string> = {
  language_level: "语言难度",
  answer_length: "回答长度",
  humor: "幽默程度",
  question_density: "提问密度",
};

const KNOB_OPTIONS: Record<string, string[]> = {
  language_level: ["simple", "standard", "advanced"],
  answer_length: ["brief", "balanced", "detailed"],
  humor: ["none", "light", "playful"],
  question_density: ["low", "medium", "high"],
};

function errorKindForStatus(status: number): UiError {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 409 || status === 413) {
    return "rejected";
  }
  if (status >= 500) {
    return "network";
  }
  return "invalid";
}

export default function ParentPage() {
  const [token, setToken] = useState<string | null>(null);
  const [principal, setPrincipal] = useState<"guardian" | "admin" | null>(null);
  const [accessCode, setAccessCode] = useState("");
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<UiError | null>(null);
  const [busy, setBusy] = useState(false);

  const authedFetch = useCallback(
    async (path: string, init?: { method?: string; body?: unknown }) => {
      if (token === null) {
        setError("auth");
        return null;
      }
      try {
        const response = await fetch(path, {
          method: init?.method ?? "GET",
          headers: {
            authorization: `Bearer ${token}`,
            ...(init?.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
        if (!response.ok) {
          setError(errorKindForStatus(response.status));
          return null;
        }
        return (await response.json()) as unknown;
      } catch {
        setError("network");
        return null;
      }
    },
    [token],
  );

  const refresh = useCallback(async () => {
    const snapshot = await authedFetch("/api/v1/guardian/authorizations");
    if (snapshot !== null) {
      setStatus(snapshot as StatusSnapshot);
      const auditBody = await authedFetch("/api/v1/guardian/audit");
      if (auditBody !== null) {
        setAudit((auditBody as { entries: AuditEntry[] }).entries);
      }
    }
  }, [authedFetch]);

  useEffect(() => {
    if (token !== null) {
      void refresh();
    }
  }, [token, refresh]);

  async function login(code: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/v1/guardian/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocolVersion: "1.0", accessCode: code }),
      });
      if (!response.ok) {
        setError(errorKindForStatus(response.status));
        return;
      }
      const body = (await response.json()) as { sessionToken: string; principal: string };
      setToken(body.sessionToken);
      setPrincipal(body.principal === "admin" ? "admin" : "guardian");
    } catch {
      setError("network");
    } finally {
      setBusy(false);
    }
  }

  async function logout(): Promise<void> {
    if (token !== null) {
      await fetch("/api/v1/guardian/session/logout", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    }
    setToken(null);
    setPrincipal(null);
    setStatus(null);
    setAudit([]);
  }

  async function act(body: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await authedFetch("/api/v1/guardian/authorizations", {
      method: "POST",
      body: { protocolVersion: "1.0", ...body },
    });
    setBusy(false);
    if (result !== null) {
      await refresh();
    }
  }

  if (token === null) {
    return (
      <section className="mx-auto max-w-xl space-y-6">
        <header>
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Parent Mode</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">监护人控制台</h1>
          <p className="mt-3 text-sm text-slate-600">
            家长鉴权、告知阅读、授权/撤销与功能开关（R1-06）。会话令牌仅保存在本页内存中，刷新页面后需重新登录。
          </p>
        </header>

        <form
          className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
          onSubmit={(event) => {
            event.preventDefault();
            void login(accessCode);
          }}
        >
          <label className="block text-sm font-medium text-slate-700" htmlFor="access-code">
            访问码
          </label>
          <input
            id="access-code"
            type="password"
            autoComplete="off"
            value={accessCode}
            onChange={(event) => setAccessCode(event.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            placeholder="输入监护人访问码"
          />
          <button
            type="submit"
            disabled={busy || accessCode.length === 0}
            className="w-full rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            登录
          </button>
          {error !== null ? (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{ERROR_COPY[error]}</p>
          ) : null}
          <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            演示环境说明：本部署使用<b>合成演示访问码</b>（非真实凭据）——监护人：
            <code className="mx-1">{DEMO_GUARDIAN_CODE}</code>；独立管理员：
            <code className="mx-1">{DEMO_ADMIN_CODE}</code>
            。真实密钥管理与轮换属于 R1-08。
          </div>
        </form>
      </section>
    );
  }

  const consent = status?.consents.find((entry) => entry.consentId === "child_model_interaction");
  const egressSwitch = status?.switches.find((entry) => entry.switchId === "third_party_data_egress");
  const acknowledged = status?.disclosure.acknowledgedVersion === status?.disclosure.document.version;
  const isGuardian = principal === "guardian";

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">Parent Mode</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">监护人控制台</h1>
          <p className="mt-2 text-sm text-slate-600">
            {isGuardian ? "监护人" : "独立管理员（只读监督）"} · 会话内令牌 · 退出后立即失效
          </p>
        </div>
        <button
          type="button"
          onClick={() => void logout()}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400"
        >
          退出登录
        </button>
      </header>

      {error !== null ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{ERROR_COPY[error]}</p>
      ) : null}

      {/* 告知（AI 使用范围 / 第三方数据外发与保留说明 / 监控边界） */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-900">
            隐私与 AI 使用告知 <span className="text-sm font-normal text-slate-500">v{status?.disclosure.document.version}</span>
          </h2>
          {isGuardian ? (
            <button
              type="button"
              disabled={busy || acknowledged}
              onClick={() => void act({ action: "acknowledge_disclosure", disclosureVersion: status?.disclosure.document.version })}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
            >
              {acknowledged ? "已阅读并确认当前版本" : "我已阅读并确认"}
            </button>
          ) : (
            <span className="text-sm text-slate-500">
              {status?.disclosure.acknowledgedVersion === status?.disclosure.document.version
                ? "监护人已确认当前版本"
                : "监护人尚未确认当前版本"}
            </span>
          )}
        </div>
        <div className="mt-4 space-y-4">
          {status?.disclosure.document.sections.map((section) => (
            <div key={section.sectionId} className="rounded-xl bg-slate-50 p-4">
              <p className="text-sm font-semibold text-slate-800">
                {section.heading}
                {section.pendingVerification ? (
                  <span className="ml-2 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                    待核实
                  </span>
                ) : null}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-slate-600">{section.body}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 授权 / 撤销 + 功能开关 */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">授权管理</h2>
          <div className="mt-4 flex items-center justify-between rounded-xl bg-slate-50 p-4">
            <div>
              <p className="text-sm font-semibold text-slate-800">儿童模型交互（child_model_interaction）</p>
              <p className="mt-1 text-xs text-slate-500">
                撤销后，新的对话轮次将被拒绝（已开始的轮次正常结束）。
              </p>
            </div>
            <span
              className={`ml-4 rounded px-2 py-1 text-xs font-semibold ${
                consent?.active ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700"
              }`}
            >
              {consent?.active ? "已授权" : "已撤销"}
            </span>
          </div>
          {isGuardian ? (
            <div className="mt-4 flex gap-3">
              <button
                type="button"
                disabled={busy || consent?.active === true}
                onClick={() => void act({ action: "grant_consent", consentId: "child_model_interaction" })}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
              >
                授权
              </button>
              <button
                type="button"
                disabled={busy || consent?.active === false}
                onClick={() => void act({ action: "revoke_consent", consentId: "child_model_interaction" })}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
              >
                撤销
              </button>
            </div>
          ) : null}
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">功能开关</h2>
          <div className="mt-4 rounded-xl bg-slate-50 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-800">第三方数据外发（third_party_data_egress）</p>
                <p className="mt-1 text-xs text-slate-500">
                  默认关闭。关闭时第三方供应商请求数为 0（网关在传输前拒绝）。当前部署未接入任何第三方供应商。
                </p>
              </div>
              <span
                className={`ml-4 rounded px-2 py-1 text-xs font-semibold ${
                  egressSwitch?.enabled ? "bg-amber-100 text-amber-800" : "bg-slate-200 text-slate-700"
                }`}
              >
                {egressSwitch?.enabled ? "已开启" : "已关闭"}
              </span>
            </div>
            {isGuardian ? (
              <div className="mt-4">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act({
                      action: "set_feature_switch",
                      switchId: "third_party_data_egress",
                      enabled: !egressSwitch?.enabled,
                    })
                  }
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-40"
                >
                  {egressSwitch?.enabled ? "关闭" : "开启"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* 人格风格配置（guardian_config 可信渠道） */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">人格风格配置</h2>
        <p className="mt-1 text-xs text-slate-500">
          经可信渠道 <code>guardian_config</code> 生效，每次变更记录审计轨迹（knob/value/source）。
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-4">
          {Object.keys(KNOB_OPTIONS).map((knobId) => (
            <label key={knobId} className="block text-sm">
              <span className="font-medium text-slate-700">{KNOB_LABELS[knobId] ?? knobId}</span>
              <select
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm disabled:opacity-50"
                value={status?.style.values[knobId] ?? ""}
                disabled={!isGuardian || busy}
                onChange={(event) =>
                  void act({ action: "set_persona_style", updates: [{ knobId, value: event.target.value }] })
                }
              >
                {KNOB_OPTIONS[knobId].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        {status !== null ? (
          <p className="mt-3 text-xs text-slate-500">
            当前来源：{status.style.provenance.map((entry) => `${entry.knobId}=${entry.value}(${entry.source})`).join("，")}
          </p>
        ) : null}
      </div>

      {/* 状态核对 + 摘要（计数，不含聊天内容） */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">状态核对</h2>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between rounded-lg bg-slate-50 px-3 py-2">
              <dt className="text-slate-600">会话数（最小摘要，非聊天内容）</dt>
              <dd className="font-semibold text-slate-900">{status?.usage.conversationCount ?? "—"}</dd>
            </div>
            <div className="flex justify-between rounded-lg bg-slate-50 px-3 py-2">
              <dt className="text-slate-600">活跃会话令牌</dt>
              <dd className="font-semibold text-slate-900">{status?.activeSessions ?? "—"}</dd>
            </div>
            <div className="flex justify-between rounded-lg bg-slate-50 px-3 py-2">
              <dt className="text-slate-600">第三方供应商请求数</dt>
              <dd className="font-semibold text-slate-900">{status?.egress.thirdPartyProviderRequestCount ?? "—"}</dd>
            </div>
            {Object.entries(status?.egress.providerRequestCounts ?? {}).map(([providerId, count]) => (
              <div key={providerId} className="flex justify-between rounded-lg bg-slate-50 px-3 py-2">
                <dt className="text-slate-600">供应商请求数 · {providerId}</dt>
                <dd className="font-semibold text-slate-900">{count}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">安全审计（最近 {status?.auditTail.length ?? 0} 条）</h2>
          <ul className="mt-4 max-h-64 space-y-1 overflow-y-auto text-xs text-slate-600">
            {status?.auditTail
              .slice()
              .reverse()
              .map((entry) => (
                <li key={entry.seq} className="rounded bg-slate-50 px-3 py-1.5">
                  <span className="font-mono">#{entry.seq}</span> · {entry.at} ·{" "}
                  <span className="font-semibold">{entry.kind}</span>
                  {entry.actorRole !== null ? ` · ${entry.actorRole}` : ""}
                  {entry.target !== null ? ` · ${entry.target}` : ""}
                </li>
              ))}
          </ul>
          <p className="mt-2 text-xs text-slate-400">完整审计共 {audit.length} 条（GET /api/v1/guardian/audit）。</p>
        </div>
      </div>
    </section>
  );
}
