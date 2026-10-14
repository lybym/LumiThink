# LumiThink 2.0 统一交互 API 合同（Contract v1.0）

> 版本：`1.0` ｜ 状态：**合同定义与契约测试随 R1-01 交付；端点层自 R1-05 起为 Web MVP 接线（进程内内存态、单进程拓扑，见下方交付说明）**
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
- fingerprint 用 canonical JSON 计算，**排除** `clientContext`（客户端升级后重试语义不变）。

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
