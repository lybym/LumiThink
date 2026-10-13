# LumiThink Model Gateway 合同（MODEL_GATEWAY.md v1.0）

> 版本：`1.0` ｜ 日期：2026-10-14 ｜ 状态：**R1-02 域层已交付**——Provider 契约、Mock/真实 Provider 适配器、预算/熔断/超时/取消与审计由 `lib/domain/gateway/` + `tests/domain/gateway/` 实现；HTTP 端点接线（R1-05）与真实供应商的独立数据外发评审**尚未发生**（见 §7）。
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
| `models[]` | `modelId ↔ providerId` 一对一绑定 + `maxOutputTokens` + 可选 `pricing`（每百万 token 的微美元整数价） |
| `budget` | `maxRequestsPerDay / maxCostMicroUsdPerDay / maxTotalTokensPerDay`——**必填**，没有隐式无限额 |
| `retry` | `maxAttempts`（1–5）+ `backoffBaseMs`（指数退避 `base·2^k`） |
| `breaker` | `failureThreshold` + `cooldownMs`（半开探测见 §5） |
| `requestTimeoutMs` | 默认单次尝试超时（请求可携带更小的 `timeoutMs`，上限 120s） |

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

- **重试**：仅 `rate_limited / server_error / unavailable` 且尚未向消费者产出任何 delta 时重试（**可见输出后绝不重试**——流已部分消费，重试会拼出重复/混乱文本）；`auth/protocol/bad_request/invalid` 永不重试；**超时永不自动重试**。重试次数严格 = `maxAttempts`（重试风暴注入测试证明精确停止）。
- **预算**：UTC 日键（`YYYY-MM-DD`，`dayKeyOf`）。预检：请求数、累计费用、累计 token 超限 → 联系前拒绝（审计 `budget.rejected` + 快照）。**事后窗口**（已记录在案）：单次响应把累计值推过上限时照常记账并审计 `budget.overshoot`，下一次请求被拒——进程内账本以 `UsageLedger` 接口注入，R1-08/R1-09 持久化时替换实现即可，语义不变。
- **熔断**：每 Provider 独立的 `closed → open → half_open` 状态机；只有**可用性失败**（timeout/unavailable/rate_limited/server_error）计数，auth/protocol/budget/cancel 一律不参与（它们不代表 Provider 健康，测试强制）。冷却期满允许**恰好一个**半开探测：成功 → closed，失败 → 重新 open 并重置冷却。
- **费用**：整数微美元数学（`ceil(tokens × price / 1e6)`，双侧分别取顶），无浮点记账。

## 6. 与统一契约（R1-01）的映射

| Gateway 码 | 契约码（`GATEWAY_TO_CONTRACT_ERROR_CODE`） |
| --- | --- |
| `GATEWAY_INVALID_REQUEST` | `CONTRACT_FIELD_INVALID`（400，不可重试） |
| 其余全部 | `CONTRACT_INTERNAL`（500），gateway code 以结构化 details.reason 传递 |

`GATEWAY_CANCELLED` 不进入错误包：端点层将其转换为 `turn.cancelled` 事件（契约 §6），late 结果由 `suppressLateAgentResponse` 降级——Gateway 的取消语义与该规则对齐：**取消后的输出在 Gateway 内部就被截断，根本不会产生"迟到结果"**。

## 7. 真实 Provider 激活门槛（当前：未激活）

`http_messages` Provider 的构造要求**同时满足**（缺一即构造失败）：

1. 显式 `baseURL`（必须 https；明文 http 仅限 loopback 测试服务器）；
2. 显式 `keySource` 回调——凭据在**请求时**由部署方解析，启动路径（`lib/env.ts`）不读取任何 Provider 密钥（R1-00 规则不变，`tests/env/startup-env.spec.ts` 继续守卫）；
3. 显式 `DataEgressReviewAcknowledgement { acknowledgeDataEgressReview: true, reviewer, reason }`——独立数据外发评审的显式确认，仿照 legacy migration acknowledgement 的"字面 true"惯例。

**状态声明（不得改写为已完成）**：Issue #14 要求的独立数据外发评审**尚未进行**；因此本 PR 交付适配器代码与 loopback 合成 E2E（不产生任何真实出网），不提供任何启用真实供应商的配置。启用前必须：完成该评审 → 在部署配置中登记 reviewer/reason → 按 §9 回归。CI 默认全 Mock（根 `pnpm test` 仅 Mock + loopback 合成服务器，无外部出网）。

## 8. 与 DSH 的边界（R1-V2 预留）

- Gateway 的取消是**模型请求/传输层**取消（abort HTTP 流、停止消费 delta）。DSH SDK 的文本停止**不得**被宣称为取消了进程内 Agent Loop；真正的 Agent Loop 取消、轮次所有权与 epoch 栅栏属 R1-V2（[VOICE_RUNTIME](./VOICE_RUNTIME.md)、[ARCHITECTURE §5](./ARCHITECTURE.md)）。R1-03 接线时：Orchestrator 调 Gateway 取消 ≠ 调 DSH Bridge cancel，两者各自验收。
- 工具（`tool_schema`）v0 仅承载受限声明（名称/描述，数量上限 16）；工具执行白名单由 Safety Gate/Tool Gate（R1-15/R1-03）负责，Gateway 不引入工具执行面。

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
