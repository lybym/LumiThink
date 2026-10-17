import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import type { ActorContext } from "../../lib/domain/contract/actor.ts";
import {
  CONTRACT_ID_PREFIXES,
  type ContractIdKind,
} from "../../lib/domain/contract/core.ts";
import type { InteractionAck } from "../../lib/domain/contract/idempotency.ts";
import { parseStreamEvent } from "../../lib/domain/contract/response.ts";
import {
  CURRENT_GUARDIAN_DISCLOSURE_VERSION,
} from "../../lib/domain/guardian/authorizations.ts";
import { GUARDIAN_DEMO_ACCESS_CODE } from "../../lib/server/guardian-service.ts";
import { resolveWebMvpActor, WEB_MVP_ACTOR_ID } from "../../lib/server/interaction-service.ts";
import { createWebMvpRuntime, type WebMvpRuntime } from "../../lib/server/web-mvp-runtime.ts";

/**
 * E2E-10 (issue #60) — parent-console governance journey acceptance over the
 * REAL composed serving runtime with REAL credential digests: 登录 → 告知 →
 * 授权/撤权 → 记录开关 → 查看/导出 → 清除 → 儿童会话实际生效，未授权一律拒绝.
 *
 * This is the automatable face of the 监护人端 acceptance journey: the same
 * service calls the /parent console's routes perform. The physical
 * click-through (真实浏览器逐项点击) and the voice-device legs are operator
 * items (deploy/xiaozhi/runbook.md §13); this suite proves every operation
 * REALLY lands on the child's serving session.
 *
 * All content synthetic; the access codes here are test-only throwaways.
 */

const GUARDIAN_CODE = "e2e10-guardian-code";
const ADMIN_CODE = "e2e10-admin-code-01";

const NOW = "2026-10-14T08:00:00.000Z";

let idCounter = 0;
function nextId(kind: ContractIdKind): string {
  idCounter += 1;
  return `${CONTRACT_ID_PREFIXES[kind]}${String(idCounter).padStart(8, "0")}`;
}

function childActor(): Readonly<ActorContext> {
  return resolveWebMvpActor(NOW);
}

function submitBody(text: string, requestId?: string): Record<string, unknown> {
  return {
    protocolVersion: "1.0",
    interaction: {
      kind: "text",
      clientRequestId: requestId ?? nextId("requestId"),
      text: { content: text, format: "plain" },
      clientContext: { client: "web", clientVersion: "2.0.0-web" },
    },
  };
}

async function drainEvents(
  runtime: WebMvpRuntime,
  ack: Readonly<InteractionAck>,
): Promise<void> {
  const opened = runtime.service.openEventStream({ actor: childActor(), traceId: ack.traceId });
  assert.equal(opened.kind, "stream");
  if (opened.kind !== "stream") {
    throw new Error("unreachable");
  }
  for await (const frame of opened.events) {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    assert.ok(dataLine !== undefined);
    parseStreamEvent(JSON.parse(dataLine.slice("data: ".length)) as unknown);
  }
}

async function runTurn(
  runtime: WebMvpRuntime,
  text: string,
  requestId?: string,
): Promise<Readonly<InteractionAck>> {
  const result = await runtime.service.submitInteraction({
    body: submitBody(text, requestId),
    actor: childActor(),
  });
  assert.equal(result.kind, "ack");
  if (result.kind !== "ack") {
    throw new Error("unreachable");
  }
  await drainEvents(runtime, result.body);
  return result.body;
}

function newRuntime(): WebMvpRuntime {
  return createWebMvpRuntime({
    credentialDigests: {
      guardian: createHash("sha256").update(GUARDIAN_CODE, "utf8").digest("hex"),
      admin: createHash("sha256").update(ADMIN_CODE, "utf8").digest("hex"),
    },
  });
}

function login(runtime: WebMvpRuntime, code: string): string {
  const loginResult = runtime.guardian.sessionLogin({
    body: { protocolVersion: "1.0", accessCode: code },
  });
  assert.equal(loginResult.kind, "ok", "the correct access code verifies");
  if (loginResult.kind !== "ok") {
    throw new Error("unreachable");
  }
  return `Bearer ${(loginResult.body as { sessionToken: string }).sessionToken}`;
}

function authzAction(
  runtime: WebMvpRuntime,
  authorization: string | null,
  body: Record<string, unknown>,
): "ok" | "error" {
  const result = runtime.guardian.postAuthorizations({ authorization, body });
  return result.kind;
}

// ---------------------------------------------------------------------------

test("E2E-10 监护人旅程: 登录 → 告知 → 撤权拒轮（含重放）→ 复权恢复 → 记录开关影响会话正文 → 导出 → 清除 → 会话映射关闭", async () => {
  const runtime = newRuntime();

  // 未授权拒绝（前置）：无令牌读授权状态即拒绝。
  assert.equal(runtime.guardian.getAuthorizations({ authorization: null }).kind, "error");

  // 错误口令：拒绝（真实摘要模式下 demo 常量口令同样是错误口令）。
  assert.equal(
    runtime.guardian.sessionLogin({ body: { protocolVersion: "1.0", accessCode: GUARDIAN_DEMO_ACCESS_CODE } }).kind,
    "error",
    "the disclosed demo constant is NOT a credential when real digests are configured",
  );

  // 登录（guardian / admin 双 principal，服务端解析身份）。
  const guardianAuth = login(runtime, GUARDIAN_CODE);
  const adminAuth = login(runtime, ADMIN_CODE);
  assert.equal(runtime.guardian.getAuthorizations({ authorization: guardianAuth }).kind, "ok");

  // 告知确认（幂等）：监护人先完成告知，之后的使能操作才被接受。
  assert.equal(
    authzAction(runtime, guardianAuth, {
      protocolVersion: "1.0",
      action: "acknowledge_disclosure",
      disclosureVersion: CURRENT_GUARDIAN_DISCLOSURE_VERSION,
    }),
    "ok",
  );

  // 撤权 → 儿童轮被拒（含撤权前 requestId 的重放也拒绝）。
  assert.equal(
    authzAction(runtime, guardianAuth, {
      protocolVersion: "1.0",
      action: "revoke_consent",
      consentId: "child_model_interaction",
    }),
    "ok",
  );
  const preRevokeRequestId = nextId("requestId");
  const revokedTurn = await runtime.service.submitInteraction({
    body: submitBody("[synthetic] 撤权期间的轮次", preRevokeRequestId),
    actor: childActor(),
  });
  assert.equal(revokedTurn.kind, "error", "revoked family consent rejects new family turns");
  const revokedReplay = await runtime.service.submitInteraction({
    body: submitBody("[synthetic] 撤权期间的轮次", preRevokeRequestId),
    actor: childActor(),
  });
  assert.equal(revokedReplay.kind, "error", "even the pre-revoke requestId replay stays rejected");

  // 复权 → 同一 requestId 立即可执行（撤权期间不烧号）。
  assert.equal(
    authzAction(runtime, guardianAuth, {
      protocolVersion: "1.0",
      action: "grant_consent",
      consentId: "child_model_interaction",
    }),
    "ok",
  );
  const restoredTurn = await runTurn(runtime, "[synthetic] 复权后的第一轮", preRevokeRequestId);
  assert.equal(restoredTurn.status, "accepted", "the SAME requestId executes fresh after re-grant");

  // 记录开关默认关闭：轮次执行但正文不保留（最小化采集的诚实代价）。
  const defaultOffTurn = await runTurn(runtime, "[synthetic] 记录关闭时的轮次");
  const snapshotOff = runtime.service.childDataSnapshot(WEB_MVP_ACTOR_ID);
  assert.equal(snapshotOff.turnStreams.total, 0, "ended turn buffers purge immediately when OFF");
  const ownConversation = snapshotOff.conversations.find(
    (conversation) => conversation.conversationId === defaultOffTurn.conversationId,
  );
  assert.ok(ownConversation !== undefined);
  assert.equal(ownConversation.history.length, 0, "no conversation text is retained while OFF");

  // 开启记录（需要已确认的告知版本）：后续轮次正文保留。
  assert.equal(
    authzAction(runtime, guardianAuth, {
      protocolVersion: "1.0",
      action: "set_feature_switch",
      switchId: "conversation_recording",
      enabled: true,
    }),
    "ok",
  );
  const onTurn = await runTurn(runtime, "[synthetic] 记录开启后的轮次内容");
  const snapshotOn = runtime.service.childDataSnapshot(WEB_MVP_ACTOR_ID);
  const onConversation = snapshotOn.conversations.find(
    (conversation) => conversation.conversationId === onTurn.conversationId,
  );
  assert.ok(onConversation !== undefined);
  assert.ok(onConversation.history.length >= 2, "recording ON retains the turn content");
  assert.ok(
    onConversation.history.some((entry) => entry.content.includes("记录开启后的轮次内容")),
    "the retained history carries the submitted turn text",
  );

  // 导出（guardian 专属）带出已保存正文；admin 只读：可看清单，不可导出/清除。
  const exportGuardian = runtime.guardian.exportChildData({ authorization: guardianAuth });
  assert.equal(exportGuardian.kind, "ok");
  const exportAdmin = runtime.guardian.exportChildData({ authorization: adminAuth });
  assert.equal(exportAdmin.kind, "error", "independent admin cannot export child content");
  assert.equal(runtime.guardian.getChildDataInventory({ authorization: adminAuth }).kind, "ok");
  const eraseAdmin = await runtime.guardian.eraseChildData({
    authorization: adminAuth,
    body: { protocolVersion: "1.0", action: "erase_child_data" },
  });
  assert.equal(eraseAdmin.kind, "error", "independent admin cannot erase child data");

  // 清除（guardian）：正文、缓冲清空，儿童会话的 DSH 映射关闭——变更实际
  // 影响设备端会话（旧会话无法继续），台账与审计落地。
  const sessionId = snapshotOn.conversations.find(
    (conversation) => conversation.conversationId === onTurn.conversationId,
  )?.sessionId;
  assert.ok(sessionId !== undefined && sessionId.length > 0);
  const erase = await runtime.guardian.eraseChildData({
    authorization: guardianAuth,
    body: { protocolVersion: "1.0", action: "erase_child_data" },
  });
  assert.equal(erase.kind, "ok");
  const snapshotAfterErase = runtime.service.childDataSnapshot(WEB_MVP_ACTOR_ID);
  assert.equal(snapshotAfterErase.conversations.length, 0, "subject-wide erase removes all conversations");
  assert.equal(snapshotAfterErase.turnStreams.total, 0);
  assert.equal(
    runtime.pipeline.sessionMapper.describe(sessionId)?.state,
    "closed",
    "the erased child session's DSH mapping is closed",
  );

  // 审计闭环：本次旅程的每一步都是结构化审计事实（无正文）。种子状态
  // 披露为 seed；重复确认告知是幂等 unchanged，不再产生新条目。
  const kinds = runtime.guardian.auditEntries().map((entry) => entry.kind);
  for (const kind of [
    "seed",
    "login_success",
    "consent_revoke",
    "consent_grant",
    "switch_change",
    "data_view",
    "data_export",
    "data_erase",
  ] as const) {
    assert.ok(kinds.includes(kind), `the journey is audited: ${kind}`);
  }
});

test("E2E-10 未授权拒绝: 儿童身份无监护人面、伪造 session 令牌一律同等拒绝且不泄露存在性", async () => {
  const runtime = newRuntime();
  const guardianAuth = login(runtime, GUARDIAN_CODE);

  // 儿童自身没有任何监护人面可走（儿童通过记忆域既有路径行使个体权利）。
  const childNoToken = runtime.guardian.getChildDataInventory({ authorization: null });
  assert.equal(childNoToken.kind, "error");

  // 伪造/未知令牌与缺失令牌得到同等拒绝（无存在性泄露）。
  const forged = runtime.guardian.getAuthorizations({
    authorization: "Bearer AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  assert.equal(forged.kind, "error");
  assert.equal(forged.kind, childNoToken.kind);

  // 登出后令牌立即失效。
  const logout = runtime.guardian.sessionLogout({ authorization: guardianAuth });
  assert.equal(logout.kind, "ok");
  assert.equal(runtime.guardian.getAuthorizations({ authorization: guardianAuth }).kind, "error");
});
