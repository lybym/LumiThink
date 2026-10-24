# LumiThink 2.0 统一交互 API 合同（Contract v1.0）

## 2026-10-25 A2A 设计基线更新

设计评审通过（Design GO）。P0/P1 获准开展，协议互通、真实取消、设备验收和部署切换仍受各阶段 Gate 约束。

新外部 Agent 接口统一采用 A2A，不再用本页 Web MVP 的 requestId、进程内台账或自定义 cancel 端点作为三端接入规范。成功受理业务统一 Task；contextId 映射独立 Conversation，Task 可包含多个顺序 Turn。下文仍描述已交付 Web 接口，迁移需单独实施。新通路的撤权立即阻断订阅、读取、工具提交和后续输出，不能沿用“在途授权一直有效”的旧假设。详见 Task 契约与协议 JSON 示例；本页不声明旧路由已被替换。

以 [整体方案](A2A_DESIGN.md)、[Task 契约](TASK_LIFECYCLE.md) 和 [P0/P1 计划](P0_P1_PLAN.md) 为新阶段依据。以下保留既有实现/历史范围说明；冲突处以本节明确的目标约束为准，不能据此宣称代码已完成迁移。

## 既有实现与历史基线


> 版本：`1.0` ｜ 状态：**合同定义与契约测试随 R1-01 交付；端点层自 R1-05 起为 Web MVP 接线（进程内内存态、单进程拓扑，见下方交付说明）；R1-06 起新增 §12 监护人鉴权、授权与功能开关（解析级 fail-closed，Bearer 会话，无 Cookie）**
> R1-05 交付说明（Issue #17）：§4/§5/§6 三条路由由 `app/api/v1/interactions/*`（薄传输层）+ `lib/server/interaction-service.ts`（服务语义）为 Web MVP 接线——服务端验证身份注入（R1-06 鉴权落地前为固定合成演示儿童，客户端无法影响任何身份字段）、幂等台账按 **(verifiedActor, requestId)** 隔离（评审硬前置：全局台账会让重放的 requestId 返回他人会话）、请求体字节上限（超限映射 `CONTRACT_TEXT_TOO_LONG` 413）、SSE 流把 **Gate 批准后的完整输出**按有界短片段节流发出（合同 §5 语义"短句片段，非原始模型 token"；未过 Output Gate 的模型增量永远不可达儿童）、取消 = 网关调用者取消 + 迟到结果抑制。会话/台账/在途轮次状态为进程内内存（单进程 MVP），持久化选型仍按 TECH_STACK §3 待定。
> 对应：[Issue #13](https://github.com/lybym/LumiThink/issues/13) ｜ [PRD FR-001](./PRD.md) ｜ [Roadmap R1-01](./ROADMAP.md) ｜ [架构](./ARCHITECTURE.md)
> 代码：`lib/domain/contract/`（类型 + 解析器 + JSON Schema + fixtures）｜ 测试：`tests/domain/contract/`
> 本合同只定义协议语义与验证规则，不包含 HTTP handler、鉴权实现或持久化；这些由后续 Issue（R1-02+）交付。

## 1. 版本化

- 每个合同载荷都携带 `protocolVersion`。当前唯一支持版本：`"1.0"`（`SUPPORTED_PROTOCOL_VERSIONS`）。
- 未知/未来版本 **fail-closed 拒绝**，错误码 `CONTRACT_UNKNOWN_VERSION`；新增版本的唯一方式是在版本注册表中登记并经过契约测试。
- JSON Schema 发布物使用 URN 标识：`urn:lumithink:contract:1.0:<name>`（draft 2020-12）。

## 2. 统一 ID 词汇（request_id / trace_id / conversation_id / turn_id）

所有合同 ID 共享语法 `^[a-z][a-z0-9]{2,15}_[A-Za-z0-9][A-Za-z0-9_-]{7,63}$`（`<前缀>_<不透明主体>`），并按用途固定前缀：

| 种类 | 前缀 | 语义 |
| --- | --- | --- |
| `requestId` | `req_` | 客户端幂等键；重试必须复用同一值 |
| `traceId` | `trc_` | 一次已受理请求的事件流追踪 ID |
| `conversationId` | `conv_` | 会话（多轮共享）；服务端分配 |
| `turnId` | `trn_` | 一次交互轮次 |
| `sessionId` | `ses_` | 服务端会话绑定 |
| `agentResponseId` | `rsp_` | 一轮的 Agent 输出 |
| `eventId` | `evt_` | 规范化事件实例 |
| `actorId` | `act_` | 服务端验证过的主体 |
| `childRef` | `chd_` | 服务端解析的儿童引用（伪名） |

ID 由服务端生成；错误回显只允许通过同一语法**再验证**的 ID（未验证的客户端值一律不回显）。

## 3. 身份与 Session（ActorContext / SessionRef）

- 四种身份：`child | guardian | system | voice_device`。
- `ActorContext`（role / actorId / childRef / verifiedBy / verifiedAt）**只能由服务端在验证后构造注入**；`child`/`guardian`/`voice_device` 必须带 `childRef`，`system` 必须为 `null`。
- 请求体**不携带任何身份字段**。客户端提交 `actor`、`actorContext`、`childId`、`childRef`、`role`、`sessionId`、`traceId` 等（即使为空/null）一律 `CONTRACT_UNTRUSTED_IDENTITY`（403）拒绝——客户端自报的 actor/child_id 不构成授权。
- 文本交互 API 允许 `child | guardian | system`；`voice_device` 走未来 R1-V 语音路径，不得调用文本 API（`CONTRACT_WRONG_ROLE`）。
- `SessionRef`（sessionId ↔ conversationId ↔ actorId ↔ role）是服务端拥有的绑定。

## 4. POST /api/v1/interactions（文本 R1）

请求（Schema：`urn:…:interaction-request`）：

```json
{
  "protocolVersion": "1.0",
  "interaction": {
    "kind": "text",
    "clientRequestId": "req_...",
    "conversationId": "conv_...",
    "text": { "content": "…", "format": "plain" },
    "clientContext": { "client": "web", "clientVersion": "2.0.0-web" }
  }
}
```

- `conversationId` 缺省 = 开启新会话（服务端分配）；提供时必须**绑定到已验证主体**且与事件 canonical conversation 一致，否则 `CONTRACT_CROSS_CONVERSATION`（403）。
- 文本限制：1–4000 Unicode code points（非 UTF-16 单位），纯白文本拒绝；`format` 仅 `plain`。
- `clientContext` 仅为**建议性**自述（`web | voice_adapter`），永不参与授权或 canonical 事件；未知 `clientVersion` 被容忍（升级兼容），但格式必须合法；厂商/设备协议名不属于合同。
- 事件 ingress 由服务端传输路径决定，客户端声明不生效。

**幂等规则**（`lib/domain/contract/idempotency.ts`，纯语义、无存储）：

- 同 `clientRequestId` + 同语义 fingerprint → **replay**：返回原 turn/trace 的 ack（`status:"duplicate"`），不重复执行。
- 同 `clientRequestId` + 不同 fingerprint（含改内容或指向其他会话）→ `CONTRACT_DUPLICATE_REQUEST`（409）。
- fingerprint 为 canonical JSON 语义载荷的 64-bit FNV-1a **摘要**（16 位十六进制，不嵌正文——幂等台账因此 content-free，#21 评审 P0-1 修复），**排除** `clientContext`（客户端升级后重试语义不变）。

响应（ack，Schema：`urn:…:interaction-ack`）：`{ protocolVersion, requestId, conversationId, turnId, traceId, status: "accepted" | "duplicate", streamUrl, cancelUrl, acceptedAt }`。

## 5. 事件流 GET /api/v1/interactions/{traceId}/events（SSE）

- 事件种类：`stream.started` / `agent.delta` / `agent.completed` / `turn.cancelled` / `stream.error` / `stream.end`。
- 每帧 `event: <kind>` + `data: <canonical json>`；`seq` 从 0 起严格单调；关联 ID 必须与 turn 一致。
- 单个 delta ≤ 1000 code points（短句片段，非原始模型 token）。

## 6. 取消 / 忽略（文本 R1）

- `POST /api/v1/interactions/{turnId}/cancel`，body：`{ protocolVersion, turnId, conversationId, reason }`；reason：`user_stop | client_disconnect | guardian_stop | system_policy`。
- 允许角色：`child | guardian | system`。
- 结果三种安全终态：`cancelled | already_final | unknown_turn`（后两者为安全 no-op；unknown_turn 同时覆盖他人轮次——不泄露存在性）。
- **取消/忽略规则**：已取消轮次迟到到达的结果被降级为 `ignored` 且 content 丢弃（`suppressLateAgentResponse`），关联 ID 保留供审计——取消后的输出永远不会到达儿童。
- **真取消能力边界（R1-05 书面说明，不得误宣称）**：Web MVP 的"停止"由三层真实生效的机制构成——(1) 客户端立即撤销输出消费权（reducer 层丢弃该轮次全部迟到 delta）；(2) 服务端经 pipeline `AbortSignal` 触发网关调用者取消（对在途模型调用是真实取消，Mock Provider 可观测）；(3) 轮次取消/忽略语义（取消后片段停止发出）。**`DshRuntimePort` 没有轮次中途取消面**（官方 SDK 无此能力，属 R1-V2 Voice Bridge），因此本 MVP 不宣称"Agent Loop 级真取消"；DSH 适配器仅承担会话生命周期。

## 7. 统一错误模型 ErrorEnvelope

任何错误对外**不得**输出堆栈、凭据或原始私人上下文（Issue #13 验收标准 3）：

- `toSafeErrorEnvelope()` 是唯一合法的错误出口：`ContractValidationError` → 首个 problem 的 code + 结构化 details（字段路径、上限、计数）；**degenerate 情形（problems 为空）fail-closed 归入 `CONTRACT_INTERNAL`（R1-02 修复 R1-01 评审 P2-b：错误出口自身不得 fail-open）**；其他任何抛出 → `CONTRACT_INTERNAL`，原 message/stack/derived 字符串一律不序列化。
- 关联 ID 仅在通过 ID 语法再验证后回显；未验证值被丢弃。
- 结构：`{ protocolVersion, error: { code, message, retriable, details?, requestId?, traceId?, conversationId?, turnId? }, occurredAt }`。

| code | HTTP | retriable | 场景 |
| --- | --- | --- | --- |
| `CONTRACT_FIELD_MISSING` | 400 | 否 | 必填字段缺失 |
| `CONTRACT_FIELD_INVALID` | 400 | 否 | 字段未通过验证 |
| `CONTRACT_UNKNOWN_VERSION` | 400 | 否 | 未登记的 protocolVersion |
| `CONTRACT_UNTRUSTED_IDENTITY` | 403 | 否 | 客户端提交服务端拥有的身份字段 |
| `CONTRACT_WRONG_ROLE` | 403 | 否 | 已验证角色无权执行该操作 |
| `CONTRACT_DUPLICATE_REQUEST` | 409 | 否 | requestId 被复用于不同载荷 |
| `CONTRACT_CROSS_CONVERSATION` | 403 | 否 | 会话不属于该主体或 canonical 不一致 |
| `CONTRACT_TEXT_TOO_LONG` | 413 | 否 | 文本超过长度上限 |
| `CONTRACT_INTERNAL` | 500 | 是 | 内部错误（对外仅通用信息） |

## 8. JSON Schema 发布物与解析器分工

- `lib/domain/contract/schemas.ts` 以数据形式发布 16 份 draft-2020-12 文档（interaction-request / interaction-ack / interaction-event / actor-context / session-ref / agent-response / stream-event + 6 份 per-kind stream payload / error-envelope / turn-cancel-request / turn-cancel-result），可确定性序列化发布。
- Schema 文档承载**无条件**的线上结构；解析器（`parseInteractionRequest` 等）承载**条件**语义规则（如仅 completed 携带 content、按 kind 区分 payload）、值不回显与角色授权。两者以同一组 fixtures 交叉验证。
- 仓库内置最小 JSON Schema 验证器仅支持合同实际使用的关键字子集；schema 引入未支持关键字时测试会显式失败。

## 9. Fixtures 与合成数据

- `lib/domain/contract/fixtures.ts` 提供确定性 Mock 请求/响应/事件流/错误 fixtures；儿童引用固定为演示值 `chd_demo_001`，文本带 `[synthetic]` 前缀。**禁止**加入真实儿童资料、录音或密钥（Issue #13 合并要求）。
- 多轮兼容：turn 1 开启会话、turn 2 续接同一 `conversationId` 并获得全新 `turnId`/`traceId`/`requestId`。
- 升级兼容：语义 fingerprint 排除 `clientContext`，旧/新客户端版本对同一领域载荷产生一致事件。

## 10. 非目标

不让协议绑定小智 `session_id`、DSH 内部 JSONL 或任何厂商模型格式；`clientContext.client` 只接受 `web | voice_adapter`，厂商名在契约测试中被显式拒绝。

## 11. 验收标准 → 测试映射

| Issue #13 验收标准 | 测试 |
| --- | --- |
| 正反测试：字段缺失、未知版本、错误角色、重复 request_id、恶意长文本、跨会话关联 | `tests/domain/contract/interaction.spec.ts`、`actor.spec.ts`、`core.spec.ts`、`idempotency.spec.ts`、`schemas.spec.ts`、`response.spec.ts` |
| 相同领域请求从 Web 与 Voice Adapter 产生一致标准事件 | `interaction.spec.ts`（normalize 一致性、ingress 由服务端决定、语义 fingerprint） |
| 任何错误不得输出堆栈、凭据或原始私人上下文 | `errors.spec.ts`（dirty error → CONTRACT_INTERNAL、ID 回显再验证、fixture 无 stack 字段） |

## 12. 监护人鉴权、授权与功能开关（R1-06）

> 对应：[Issue #18](https://github.com/lybym/LumiThink/issues/18) ｜ [PRD FR-005 / UC-06](./PRD.md) ｜ [Roadmap R1-06](./ROADMAP.md) ｜ [ADR-0003](./adr/0003-guardian-auth-v0.md)
> 代码：`lib/domain/guardian/`（授权语义 + 权限规则 + 会话载荷）、`lib/server/guardian-service.ts`（验证/会话/审计）、`lib/server/provider-egress-gate.ts`（供应商外发门）｜ 测试：`tests/domain/guardian/`、`tests/server/guardian-endpoint.spec.ts`、`tests/server/guardian-wiring.spec.ts`

### 12.1 身份模型（首期单家庭）

- 可信服务端身份关系由**家庭注册表**定义（服务端常量，合成演示值）：`chd_demo_001`（儿童，沿用 #17 服务端注入演示身份）、`act_guardian_demo01`（监护人）、`act_admin_demo01`（独立管理员，PRD"维护者"——以合同 `system` 角色验证，`childRef` 为 null）。
- 登录 `POST /api/v1/guardian/session`：body `{ protocolVersion, accessCode }`；**请求 schema 拒绝一切身份字段**（role/actorId/child_id 提交即 `CONTRACT_FIELD_INVALID`），身份全部由服务端解析——伪造 child_id 与自报角色无入口。演示访问码为公开合成演示值（真实凭据管理属 R1-08）；比对使用 SHA-256 摘要 + 常数时间比较；连续 5 次失败全局锁定 15 分钟（审计可见，探测方只见统一拒绝文案）。
- 会话：服务端铸造 256-bit 不透明令牌（base64url，43 字符），仅存服务端，绝对 TTL 8h，可显式撤销；客户端仅经 `Authorization: Bearer` 头携带。**不引入 Cookie**——无环境凭据即无 CSRF 面；同一权衡的互补残余如实记录：Bearer 令牌在活动会话期间可被 XSS 读取（内存持有仅缩小而非消除该面，CSP 属 R1-08——见 ADR-0003 决策 2/4）。响应：`{ protocolVersion, sessionToken, principal: "guardian"|"admin", role, actorId, childRef, expiresAt }`。
- 鉴权失败（无/坏/过期/已撤销令牌）映射既有错误注册表的 `CONTRACT_UNTRUSTED_IDENTITY`（403）——本版本不新增 401 错误码，保持 9 码注册表稳定；已验证但角色越权 → `CONTRACT_WRONG_ROLE`（403）。

### 12.2 路由与载荷（解析级校验；JSON Schema 发布物 v0 不含本节载荷，见 12.5）

| 路由 | 方法 | 角色 | 语义 |
| --- | --- | --- | --- |
| `/api/v1/guardian/session` | POST | 匿名 | 登录（见 12.1） |
| `/api/v1/guardian/session/logout` | POST | 已登录 | 撤销当前会话；此后该令牌对所有监护人面失效 |
| `/api/v1/guardian/authorizations` | GET | guardian / admin | 状态核对快照：告知文档+确认态、授权态、开关态、供应商请求计数、最小使用计数（无聊天内容）、活跃会话数、审计尾部 |
| `/api/v1/guardian/authorizations` | POST | **仅 guardian** | `{ action }`：`acknowledge_disclosure` / `grant_consent` / `revoke_consent` / `set_feature_switch` / `set_persona_style` |
| `/api/v1/guardian/audit` | GET | guardian / admin | 安全变更审计（见 12.4） |

- 授权注册表 v0：consent `child_model_interaction`；功能开关 `third_party_data_egress`（**默认关闭**）与 `conversation_recording`（R1-09，**默认关闭**，见 §12.6）。
- **告知先行**：`grant_consent` / `set_feature_switch(开启)` / `set_persona_style` 要求当前告知版本已被确认；`revoke_consent` 是 fail-safe 方向，**永远允许**。状态转移幂等：重复授权/撤销/同值开关返回 `unchanged` 且不产生重复审计；`set_persona_style` 同值重复提交（解析后风格与 provenance 均不变）同样返回 `unchanged` 且不产生重复审计——首次将默认值显式设为同值会重归属 provenance（`system_default` → `guardian_config`），仍按 `applied` 审计。
- `set_persona_style` 经 persona 域唯一可信变更路径（`applyPersonaStyleKnobs`，source `guardian_config`）应用，携带 `{knobId, value, source}` 审计轨迹；未注册 knob/值 fail-closed 拒绝且不回显。

### 12.3 强制点（撤销即生效）

- **撤销后调用模型被拒绝**：交互服务新增 submit-time 授权钩子（`authorizeTurn`，位于合同解析之后、幂等台账之前）——家庭 consent 撤销期间，本家庭**新**文本轮次（含被撤销前 requestId 的重放）一律 `CONTRACT_WRONG_ROLE` 403；已开始轮次正常结束。
- **禁用第三方外发 = 供应商请求数 0**：`third_party_data_egress` 关闭时，第三方类供应商的 `dataEgressAuthorized` 动态置 false，模型网关既有 fail-closed 门在**任何传输前**拒绝（`GATEWAY_NO_PROVIDER`）；供应商请求计数（provider `stream()` 调用数）暴露于状态快照供核对。
- **家庭取消**：合同 §6 允许 `guardian` 以 `guardian_stop` 取消——R1-06 以家庭策略接通：验证监护人可取消**同 childRef**家庭成员的轮次（`turn.cancelled.by` 如实标注取消者角色）；异家庭一律 `unknown_turn`（无存在性泄露）。**R1-06 范围注记**：家庭取消策略已在服务层接通并有测试固定，但本版本 HTTP 取消路由（`POST /api/v1/interactions/{turnId}/cancel`）仅服务端注入演示儿童身份、不解析监护人会话——监护取消在本版本**不可经 HTTP 触发**（PR 如实披露；带会话的监护人取消入口属 R1-09+）。
- **儿童不可自提权**：角色只来自服务端家庭注册表 + 登录验证；监护人路由全部拒绝 child/voice_device；无任何载荷可携带角色字段（解析器拒绝未知字段）。

### 12.4 安全变更审计（实现范围 4）

追加式有界环（500 条）：`seed / login_success / login_failed / login_locked_out / logout / disclosure_ack / consent_grant / consent_revoke / switch_change / style_change / access_denied / guardian_cancel`。`seed` 条目由服务构造时写入（服务路径每进程恰好一次，`getWebMvpRuntime` 单例），以 `actorRole: null` 披露预置状态：已确认的告知版本（`acknowledged`）、激活的 consent（`active`）、关闭的开关（`disabled`）。条目仅含结构化事实（seq/at/kind/actorRole/actorId/target/detail）——**访问码、会话令牌、提交文本永不进入审计**（测试强制）。部署模型审查（会话/Cookie/安全头/防重放/敏感配置）见 ADR-0003；`next.config.ts` 追加 nosniff / DENY framing / referrer-policy 安全头。

### 12.5 非目标与诚实边界

- 不构建多租户 IAM；不默认提供全量儿童原始聊天追踪——监护人状态面只有计数与注册表内容。
- 状态为进程内内存（单进程 MVP，同 §3 交付说明）；监护人会话/授权/审计随进程重启复位——持久化选型仍按 TECH_STACK §3 待定。
- 告知文档中供应商保留/地域与危机渠道（110/120/12355）为**待核实占位**（承 #27 评审 caveat），在 UI 以"待核实"标记呈现。
- 本节载荷为解析级 fail-closed 校验（`lib/domain/guardian/`），JSON Schema 发布物（§8 的 16 份）v0 不扩展到监护人载荷——扩展留待监护人载荷进入正式合同时一并登记。

### 12.6 数据生命周期（R1-09）

> 对应：[Issue #21](https://github.com/lybym/LumiThink/issues/21) ｜ [PRD FR-006 / FR-008 / §7.2](./PRD.md) ｜ [Roadmap R1-09](./ROADMAP.md) ｜ [MEMORY_POLICY](./MEMORY_POLICY.md) ｜ [PRIVACY_DATA_FLOW](./PRIVACY_DATA_FLOW.md) ｜ [ADR-0005](./adr/0005-child-data-lifecycle-v0.md)
> 代码：`lib/domain/lifecycle/`（保留矩阵 + fail-closed 载荷）、`lib/server/data-lifecycle-service.ts`（跨存储组合）、`lib/server/guardian-service.ts`（授权面）｜ 测试：`tests/domain/lifecycle/policy.spec.ts`、`tests/server/data-lifecycle.spec.ts`

**记录开关**：功能开关注册表新增 `conversation_recording`（**默认关闭** = 默认最小化采集）。关闭时轮次照常执行但会话正文不保留、已结束轮次的事件缓冲（临时工件）终态即清（SSE 迟到订阅者与外部 trace 得到同样的不可用应答）；开启需当前告知版本已确认（同 §12.2 幂等语义）。告知文档当前版本升级为 **1.1.0**（新增"对话保存说明"、改写监控边界；1.0.0 保留注册供历史确认审计）。

**新增路由**（主体固定为服务端家庭注册表的 `chd_demo_001`，任何载荷都没有 subject 字段——清除无法被重定向到别的孩子）：

| 路由 | 方法 | 角色 | 语义 |
| --- | --- | --- | --- |
| `/api/v1/guardian/data` | GET | guardian / admin | 结构化清单：会话 id + 保留正文条数、轮次缓冲、DSH 会话映射、记忆条目分状态、删除台账记录数、记录开关态——**无正文** |
| `/api/v1/guardian/data/export` | GET | **仅 guardian** | 已保存内容导出：会话历史正文 + 完整记忆条目 + 诚实排除清单（value-free 审计、供应商侧、音频） |
| `/api/v1/guardian/data/erase` | POST | **仅 guardian** | `{ protocolVersion, action: "erase_child_data" \| "replay_child_deletions" }`：主体级硬删除（会话历史、临时工件[先取消在途轮次]、记忆谱系、DSH 映射关闭）/ 删除重放（备份恢复后重删）；结果仅结构化计数 + tombstone id |

- **删除语义**（AC 1）：erase 后跨 Session 记忆检索为 0、被删会话不可恢复进入旧 DSH 会话、被删轮次事件流不可重放；正文类删除不可回滚。
- **审计**（交付范围 4）：`data_view / data_export / data_erase / data_erase_replay` 进监护人审计环（target=childRef，detail=有界计数）；删除台账为独立结构。**审计与台账结构上没有承载被删除正文的字段**（emit 校验拒绝未知字段，测试强制）；`memory.expire_cleanup` 的未授权拒绝从静默变为可观测 rejected 审计事实（承 #26 P2-4）。
- **诚实边界**：删除台账与全部状态为进程内存（跨进程恢复台账不随行——持久化台账属 TECH_STACK §3 待定项；当前部署无离线备份，故该边界暂无实际暴露面）；供应商侧删除不可由本系统担保，撤销授权后仅保证不再发起新请求（§12.3 门禁不变）。
- **范围注记维持**：§12.3 的"带会话的监护人取消入口属 R1-09+"**未被 #21 吸收**（issue #21 交付范围无取消项），注记保持原样留给后续 Issue。

### 12.7 部署硬化（R1-08）

> 对应：[Issue #20](https://github.com/lybym/LumiThink/issues/20) ｜ [Roadmap R1-08](./ROADMAP.md) ｜ [ADR-0006](./adr/0006-deployment-secrets-backup-v0.md) ｜ [deploy/runbook.md](../deploy/runbook.md)

**无新增端点、无合同版本变更**。R1-08 的 API 面变化：

- **登录凭据**：`POST /api/v1/guardian/session` 的验证材料改为可注入——配置 `LUMITHINK_GUARDIAN_ACCESS_CODE` / `LUMITHINK_ADMIN_ACCESS_CODE`（成对，服务端仅持 SHA-256 摘要）时验真实码、公开演示码被拒；未配置保持披露的演示模式。拒绝语义不变（统一 `CONTRACT_UNTRUSTED_IDENTITY`，锁定仍为全局 15 分钟统一拒绝——按账户锁定留作显式后续，ADR-0006 §2.2）。`seed` 审计新增 `credential_mode` 条目披露本进程模式。
- **审计 kind**：追加 `snapshot_restored`（启动恢复披露：来源 + 有界计数；`actorRole: null`）。
- **安全头**：全路由追加每请求 nonce CSP（`script-src 'nonce-…' 'strict-dynamic'`；残余披露见 ADR-0006 §2.3）；既有 nosniff / DENY framing / referrer-policy 不变；HSTS 属 TLS 代理层。
- **快照恢复**：纯部署层（`LUMITHINK_SNAPSHOT_*` + deploy/ 脚本），无 API 面；恢复后活跃会话不随行（fail-closed 重登录），删除台账重放语义见 §12.6 与 MEMORY_POLICY 备份边界（R1-08 更新）。
