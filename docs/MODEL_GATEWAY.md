# LumiThink Model Gateway 合同（MODEL_GATEWAY.md v1.0）

> 版本：`1.0` ｜ 日期：2026-10-14 ｜ 状态：**R1-02 域层已交付**——Provider 契约、Mock/真实 Provider 适配器、预算/熔断/超时/取消与审计由 `lib/domain/gateway/` + `tests/domain/gateway/` 实现；HTTP 端点接线（R1-05）与真实供应商的独立数据外发评审**尚未发生**（见 §7）。
> **E2E-03（Issue #53）增补**：真实 Provider 的**激活机制与出网拓扑已交付**——`lib/server/real-provider-composition.ts`（fail-closed 激活记录：route 选择器 + 完整 Provider/价格/预算/评审字段）与 `lib/server/gateway-egress-proxy.ts`（DSH 运行时模型路由唯一出网口：回环代理 → Model Gateway → `http_messages` 供应商）；真实 DSH + 真实 LLM 的端到端证据链路由 E2E-03 零 SKIP 门禁在 CI 以回环合成 vendor 验证（`test:e2e03`），真实供应商调用仍是**显式运营者 opt-in**（`test:e2e03:real`，CI 永不携带真实密钥）。儿童数据处理评审保持 `not_performed`（见 §7）。
> R1-03 接线说明（Issue #15）：`requestTimeoutMs` 与 `models[].maxOutputTokens` 成为被实际消费的配置（默认值 + 上限）；`GATEWAY_NO_PROVIDER` 与尝试前取消补齐审计事件；重试退避 abort-aware；baseURL 语义修正为 origin-only（适配器自行拼接 `/v1/messages`）。见 §3/§5。
> 对应：[Issue #14](https://github.com/lybym/LumiThink/issues/14) ｜ [PRD FR-004/FR-006](./PRD.md) ｜ [Roadmap R1-02](./ROADMAP.md) ｜ [HARNESS §3](./HARNESS.md) ｜ [架构](./ARCHITECTURE.md) ｜ [TECH_STACK](./TECH_STACK.md)
> 合并要求遵循 Issue #14：一 Issue 一 PR；合成数据；R0 DSH 最小权限与零 SKIP CI 不变；新安全/隐私失败阻断合并。

## 1. 定位与不变量

Model Gateway 是 2.0 Harness（[HARNESS §3](./HARNESS.md)）中"模型调用"的唯一入口：Orchestrator（R1-03）通过它访问 Mock 或真实模型，业务契约（R1-01）不变。本合同就是 **模型适配/回退合同**：任何 Provider（Mock 或真实）实现同一 `ModelProvider` 接口，Gateway 保证下列不变量对一切 Provider 成立：

1. **Fail-closed 路由**：没有显式注册的 Provider/模型就没有任何出网路径；不存在默认 DeepSeek API、默认 baseURL、默认密钥或日志上传服务（`tests/domain/gateway/config.spec.ts` 以源码扫描 + 行为测试双重证明）。
2. **最小必要上下文**：`ModelRequest` 只含合同 ID（request/trace/turn）、modelId、受限 messages、可选工具声明、超时与输出上限；actor/childRef/session 等 identity 字段在结构上被拒绝（解析器 fail-closed）。
3. **不落正文/密钥**：错误与审计只含枚举、再验证过的 ID、计数与 token/费用整数；儿童正文、Provider 响应体、密钥材料结构性不可进入（负例测试用脏标记证明）。
4. **不越权回退**：一个模型只绑定一个 Provider；失败时结构化降级，**不存在任何自动切换 Provider 的代码路径**。
5. **区分用户中止 / 超时 / 服务器失败**：三种终态在 outcome 分类、错误码与审计事件中互不混淆。

## 2. Provider 契约（ModelProvider）

```text
provider.stream(request: ModelRequest, { signal }): AsyncIterable<ProviderStreamEvent>
  ProviderStreamEvent = { type: "delta", text }（≤ 1000 code points，非空）
                      | { type: "completed", usage: { inputTokens, outputTokens } }（终止事件，必须且仅一个）
```

- Provider 只允许抛 `ProviderFailure`（静态分类：`cancelled | timeout | auth | rate_limited | server_error | unavailable | protocol | bad_request`）或透传 abort；任意异常在适配器边界被折叠，原始 message 不得逃逸。
- Provider 必须 观察 `signal`（调用者取消与超时共用一个 per-attempt controller）；Gateway 另有 race 保护，Provider 忽略信号也不会让取消/超时失效。
- 内置实现：
  - `createMockModelProvider`（`mock`）：进程内确定性合成模型，无任何 socket/出网；输出只含结构事实（消息数、模型名），**从不回显输入正文**；注入脚本支持超时挂起、429/5xx/失效 Key、协议违规（超大 delta、空输出、缺终止事件、可见输出后失败）、按次数/永久失败。
  - `createHttpMessagesProvider`（`http_messages`）：DeepSeek/Anthropic Messages 线协议（与 R0 `poc/dsh-child/src/mock-model.ts` 同族协议，R0 证据可迁移），显式注入 transport；SSE 解析 → delta/completed；HTTP 状态静态分类（401/403→auth、429→rate_limited、5xx→server_error、其他 4xx→bad_request）。**构造即 fail-closed**，见 §7。

## 3. 配置与模型注册（可审查）

`parseModelGatewayConfig` fail-closed 解析（未知字段拒绝、整数范围校验、modelId/providerId 语法校验、重复注册拒绝）：

| 字段 | 语义 |
| --- | --- |
| `models[]` | `modelId ↔ providerId` 一对一绑定 + `maxOutputTokens` + 可选 `pricing`（每百万 token 的微美元整数价）。**R1-03 接线（issue #15）**：`maxOutputTokens` 现在被 Gateway 实际消费——它是该模型的输出上限**默认值与天花板**（请求未携带时取注册值；显式值被钳制到注册值），供应商可见请求永远不超过注册上限 |
| `budget` | `maxRequestsPerDay / maxCostMicroUsdPerDay / maxTotalTokensPerDay`——**必填**，没有隐式无限额 |
| `retry` | `maxAttempts`（1–5）+ `backoffBaseMs`（指数退避 `base·2^k`） |
| `breaker` | `failureThreshold` + `cooldownMs`（半开探测见 §5） |
| `requestTimeoutMs` | **R1-03 接线（issue #15）**：默认单次尝试超时——请求未携带 `timeoutMs` 时生效；请求可携带**更小**的超时，显式更大的值被钳制到该默认（解析上限 120s 不变） |

`describeGatewayConfig()` 产出**可审查视图**：baseURL 仅保留 origin、密钥回调仅保留存在布尔位、数据外发评审仅保留 reviewer/reason——密钥材料结构性排除（测试强制）。

## 4. 失败分类与取消语义（issue #14：区分用户中止、超时与服务器失败）

| 终态 | 错误码 | retriable | 语义 |
| --- | --- | --- | --- |
| `completed` | — | — | 正常完成（含 usage/费用记账） |
| `user_cancelled` | `GATEWAY_CANCELLED` | 否 | 调用方 abort；**映射为 turn.cancelled，不是错误包**；已产出 delta 截断，终止事件永不发出 |
| `timeout` | `GATEWAY_PROVIDER_TIMEOUT` | 是（但不自动重试） | 单次尝试超时：**先取消在途调用**再返回结构化错误；不会为超时账单两次 |
| `provider_failure` | `GATEWAY_PROVIDER_UNAVAILABLE / _RATE_LIMITED / _SERVER_ERROR / GATEWAY_AUTH_FAILED / _PROTOCOL` | 见注册表 | Provider 网络失败 / 429 / 5xx / 凭据被拒 / 线协议违规 |
| `budget_exhausted` | `GATEWAY_BUDGET_EXHAUSTED` | 否 | 当日预算耗尽：**在联系 Provider 之前拒绝**并审计 |
| `circuit_open` | `GATEWAY_CIRCUIT_OPEN` | 是 | 熔断打开：联系之前拒绝 |
| `rejected` | `GATEWAY_INVALID_REQUEST / GATEWAY_NO_PROVIDER` | 否 | 请求非法 / 路由缺失（fail-closed） |

取消归属规则：Gateway 对 abort 拥有最终解释权——超时计时器与调用方信号分别标记 `timeout`/`caller`，Provider 侧把同一 abort 归类为 `cancelled` 不会改变 Gateway 的终态（负例测试覆盖"Provider 先看到 abort"的竞态）。

## 5. 重试、预算与熔断

- **重试**：仅 `rate_limited / server_error / unavailable` 且尚未向消费者产出任何 delta 时重试（**可见输出后绝不重试**——流已部分消费，重试会拼出重复/混乱文本）；`auth/protocol/bad_request/invalid` 永不重试；**超时永不自动重试**。重试次数严格 = `maxAttempts`（重试风暴注入测试证明精确停止）。**R1-03（issue #15）**：重试退避是 abort-aware 的——调用方在退避期间中止会立即以 `GATEWAY_CANCELLED` 结束，不再睡完整个退避窗口。
- **预算**：UTC 日键（`YYYY-MM-DD`，`dayKeyOf`）。预检：请求数、累计费用、累计 token 超限 → 联系前拒绝（审计 `budget.rejected` + 快照）。**预算门禁按请求评估一次**：Gateway 内部的有界重试不重复预检（同一请求的重试共享一次准入；事后超限由 `budget.overshoot` 记录，下一次请求被拒）。进程内账本以 `UsageLedger` 接口注入，R1-08/R1-09 持久化时替换实现即可，语义不变。
- **熔断**：每 Provider 独立的 `closed → open → half_open` 状态机；只有**可用性失败**（timeout/unavailable/rate_limited/server_error）计数，auth/protocol/budget/cancel 一律不参与（它们不代表 Provider 健康，测试强制）。冷却期满允许**恰好一个**半开探测：成功 → closed，失败 → 重新 open 并重置冷却。
- **费用**：整数微美元数学（`ceil(tokens × price / 1e6)`，双侧分别取顶），无浮点记账。
- **审计完整性（R1-03，carried #37 note）**：`GATEWAY_NO_PROVIDER` 与"尝试开始前"的调用方取消现在都会留下结构化审计事件（`request.rejected` / `attempt.cancelled`）——每次传输前拒绝与取消均可复查。

## 6. 与统一契约（R1-01）的映射

| Gateway 码 | 契约码（`GATEWAY_TO_CONTRACT_ERROR_CODE`） |
| --- | --- |
| `GATEWAY_INVALID_REQUEST` | `CONTRACT_FIELD_INVALID`（400，不可重试） |
| 其余全部 | `CONTRACT_INTERNAL`（500），gateway code 以结构化 details.reason 传递 |

`GATEWAY_CANCELLED` 不进入错误包：端点层将其转换为 `turn.cancelled` 事件（契约 §6），late 结果由 `suppressLateAgentResponse` 降级——Gateway 的取消语义与该规则对齐：**取消后的输出在 Gateway 内部就被截断，根本不会产生"迟到结果"**。

## 7. 真实 Provider 激活门槛（E2E-03：激活机制已交付，CI 默认 Mock）

`http_messages` Provider 的构造要求**同时满足**（缺一即构造失败）：

1. 显式 `baseURL`（必须 https；明文 http 仅限 loopback 测试服务器）；
2. 显式 `keySource` 回调——凭据在**请求时**由部署方解析，启动路径（`lib/env.ts`）不读取任何 Provider 密钥（R1-00 规则不变，`tests/env/startup-env.spec.ts` 继续守卫）；
3. 显式 `DataEgressReviewAcknowledgement { acknowledgeDataEgressReview: true, reviewer, reason }`——独立数据外发评审的显式确认，仿照 legacy migration acknowledgement 的"字面 true"惯例。

**E2E-03（Issue #53）交付的激活机制**（`lib/server/real-provider-composition.ts`，测试 `tests/server/real-provider-composition.spec.ts`）：

- **路由选择器** `LUMITHINK_MODEL_ROUTE=mock|real`（缺省/mock 为一切默认路径；CI 不设置任何激活变量，`r0-zero-skip-gate.yml` 的 e2e03 job 显式断言这些变量为空）。`real` 模式要求**完整** Provider 记录——endpoint origin、modelId、输出上限、整数定价、显式日预算、超时、重试/熔断界限、以及 reviewer/reason 评审记录——缺任何一项即激活失败（错误只列变量名，不回显值）。
- **凭据请求时注入**：`LUMITHINK_MODEL_PROVIDER_KEY` 只由 keySource 闭包在请求时读取（secrets-registry slot `model_provider_api_key`）；无 Key 时每次请求 fail-closed 为 `GATEWAY_AUTH_FAILED`（可审计，供应商零接触）。
- **出网拓扑（唯一真实路径）**：真实 DSH 运行时（`poc/dsh-child` bridge worker）的模型适配器只能指向回环 `GatewayEgressProxy`（`lib/server/gateway-egress-proxy.ts`）——代理把每个 Messages 请求翻译成**一个** Model Gateway 请求（预算/重试/熔断/超时/取消/审计/单 Provider 路由全部由 Gateway 执行），不引入第二套不受控 Agent；供应商密钥永不进入 worker 进程（子进程保留其合成占位符凭据，仅用于回环代理鉴权）。非回环绑定在代理构造时即拒绝。
- **儿童数据边界（DoD 4）**：`CHILD_DATA_EGRESS_REVIEW_STATUS = "not_performed"` 是常量而非开关——真实儿童数据的处理评审与监护人授权未完成前，本组合在结构上不存在解锁路径。激活记录只覆盖合成/成人内容的验证路径（issue #53 DoD 1 的运营者 opt-in 证据运行：`poc/dsh-child` `test:e2e03:real`，产出经脱敏的 token/费用/耗时/型号证据 JSON）。
- **状态声明（不得改写为已完成）**：本 PR 交付的是**机制与门禁**；任何具体部署的供应商数据外发评审仍必须由运营者在激活时以 reviewer/reason 显式登记（激活解析不生成、不伪造该记录），CI 全套件保持 loopback-only（无任何真实出网路径）。

## 8. 与 DSH 的边界（R1-V2 预留；E2E-03 出网拓扑）

- Gateway 的取消是**模型请求/传输层**取消（abort HTTP 流、停止消费 delta）。DSH SDK 的文本停止**不得**被宣称为取消了进程内 Agent Loop；真正的 Agent Loop 取消、轮次所有权与 epoch 栅栏属 R1-V2（[VOICE_RUNTIME](./VOICE_RUNTIME.md)、[ARCHITECTURE §5](./ARCHITECTURE.md)）。R1-03 接线时：Orchestrator 调 Gateway 取消 ≠ 调 DSH Bridge cancel，两者各自验收。
- 工具（`tool_schema`）v0 仅承载受限声明（名称/描述，数量上限 16）；工具执行白名单由 Safety Gate/Tool Gate（R1-15/R1-03）负责，Gateway 不引入工具执行面。
- **E2E-03（Issue #53）模型路由**：真实 DSH bridge worker 的 llm 适配器指向回环 `GatewayEgressProxy`（`lib/server/gateway-egress-proxy.ts`；profile `lumi-dsh-runtime-bridge` 的 `DSH_BRIDGE_MODEL_BASE_URL → DSH_POC_MOCK_BASE_URL → 127.0.0.1:9` 失败关闭链）。代理无自有 Provider 逻辑：每个请求 = 一个 Model Gateway 请求，供应商错误体/密钥/提示词结构性地不进入代理响应（静态错误映射 + 脏标记测试）。拓扑决策见 [ADR-0008](./adr/0008-real-provider-egress-topology.md)。

## 9. 验收标准 → 测试映射（issue #14）

| Issue #14 验收标准 | 测试 |
| --- | --- |
| Mock E2E | `tests/domain/gateway/gateway.spec.ts`（happy path：delta 流、completed、费用记账、审计序列） |
| 超时注入 | `gateway.spec.ts`（timeout 取消在途调用、分类、熔断联动）+ `http-provider.spec.ts`（挂起服务器 abort） |
| 429/5xx 注入 | `gateway.spec.ts`（重试风暴精确 maxAttempts 次；重试后成功）+ `http-provider.spec.ts`（状态分类矩阵） |
| 失效 Key 注入 | `gateway.spec.ts`（401 不重试、不熔断）+ `http-provider.spec.ts`（无凭据 fail-closed、密钥不落错误/审计） |
| 预算耗尽 | `gateway.spec.ts`（联系前拒绝 + 审计快照 + UTC 日滚动）+ `budget.spec.ts`（账本/阈值/费用数学） |
| 请求取消 | `gateway.spec.ts`（用户中止为终态、无 completed、不熔断、预中止拒绝）+ `mock-provider.spec.ts`（chunk 间观察到 abort） |
| 未配置 Provider/密钥 fail-closed、不意外外发 | `config.spec.ts`（空注册 GATEWAY_NO_PROVIDER、未授权 Provider 视为缺失、**源码扫描无默认端点**、config 视图无密钥材料）+ `http-provider.spec.ts`（无 baseURL/无凭据/无评审确认构造失败） |
| 真实 Provider 仅显式授权、隔离环境；CI 全 Mock | §7 三重构造门槛测试 + 全套件 loopback-only（CI 无真实出网路径） |

## 10. 非目标

不开发多模型智能路由；不默认向第三方传输真实儿童数据；不做 Gateway 层持久化（账本内存态 + 注入接口）；不实现 HTTP 端点/R1-05 接线；不实现 DSH Agent Loop 取消（R1-V2）。
