# ADR-008：真实 LLM Provider 出网拓扑——DSH 运行时唯一经回环 Model Gateway 代理出网

> 决策日期：2026-10-16 ｜ 状态：**已采纳（合成/成人内容验证路径；儿童数据评审保持未做）**
> 关联：[Issue #53](https://github.com/lybym/LumiThink/issues/53) · [Issue #14](https://github.com/lybym/LumiThink/issues/14) · [Issue #52](https://github.com/lybym/LumiThink/issues/52) · [MODEL_GATEWAY §7/§8](../MODEL_GATEWAY.md) · [ADR-001](./0001-deepseek-harness.md) · [ADR-002](./0002-voice-runtime-bridge.md) · 父 Epic [#50](https://github.com/lybym/LumiThink/issues/50)

## 背景

E2E-02（Issue #52）已让真实锁定版 DSH Cordis 运行时（`dsh-v0.2.0-rc.2`，Profile `lumi-dsh-runtime-bridge`）在 Bridge 后面跑起来，但其模型适配器仍只指向 `$DSH_POC_MOCK_BASE_URL`（回环合成 Messages mock）。Issue #53 要求为真实 DSH 建立**经明确评审和配置的远程大模型可用路径**，同时：

- 保持 Model Gateway 的错误分类、令牌/费用统计、超时、预算、取消与**单 Provider 路由**；
- **不引入第二套不受控 Agent**；
- 运行侧必须有明确的数据外发审批记录；无 Key/未审批 fail-closed；
- R0/PoC 出网守卫（`poc/dsh-child/src/egress.ts`：模型路由只许 loopback、子进程只许持有合成占位符凭据）**不可削弱**。

## 决策

**真实供应商出网只存在于宿主（host）侧，DSH 子进程保持回环边界不变。** 拓扑：

```text
DSH worker（子进程，仅合成占位符凭据）
  ──loopback HTTP──▶ GatewayEgressProxy（lib/server/gateway-egress-proxy.ts）
                       └─▶ ModelGateway（预算/重试/熔断/超时/取消/审计/单 Provider 路由）
                            └─▶ http_messages Provider（keySource 请求时注入真实密钥）
                                 └─▶ 已评审的远程供应商（https）
```

1. **单一路由面**：`lumi-dsh-runtime-bridge` Profile 的 llm 适配器 baseURL 解析链为 `DSH_BRIDGE_MODEL_BASE_URL → DSH_POC_MOCK_BASE_URL → http://127.0.0.1:9`（discard 端口，永远失败关闭）。`DSH_BRIDGE_MODEL_BASE_URL` 只能由宿主组合层指向回环代理；R0 egress 守卫扩展识别该变量并对其实际解析值继续执行 loopback 检查。
2. **代理无自有 Provider 逻辑**：每个 HTTP 请求被翻译成**恰好一个** Model Gateway 请求（服务端铸造 contract ID、最小必要上下文、无 identity 字段）；响应帧与错误码全部来自 Gateway 的结论（静态 Messages 错误映射，不回显供应商响应体/密钥/提示词）。首个 delta 到达才开启 SSE——预输出失败以干净状态码（401/429/502/503/504）映射，运行时可分类。
3. **密钥边界**：真实供应商凭据只存在于宿主 keySource 闭包（`LUMITHINK_MODEL_PROVIDER_KEY`，请求时解析，secrets-registry slot `model_provider_api_key`）；子进程永远只有合成占位符（egress 守卫语义不变）。代理自身的回环鉴权接受同一占位符——它守护的是网关路由而非供应商，泄漏的最坏后果被 Gateway 的预算/评审门禁兜住。
4. **激活三重门**（`lib/server/real-provider-composition.ts`）：`LUMITHINK_MODEL_ROUTE=real` + 完整 Provider 记录（endpoint/modelId/输出上限/整数定价/显式日预算/超时/重试/熔断）+ 数据外发评审记录（reviewer/reason）——缺一即激活失败（只列变量名）；Mock 为一切默认，CI 显式断言激活变量为空。
5. **儿童数据闸门为常量**：`CHILD_DATA_EGRESS_REVIEW_STATUS = "not_performed"`——本决策只覆盖合成/成人内容验证路径（Issue #53 DoD 1 的运营者 opt-in 证据运行 `test:e2e03:real`，产出脱敏 token/费用/耗时/型号证据）；真实儿童数据在外发评审 + 监护人授权完成前**结构上不可解锁**（DoD 4）。

## 备选取舍

| 方案 | 取舍 |
| --- | --- |
| 让 DSH 子进程直接指向供应商 API（env 注入真实 baseURL/key） | 绕过 Model Gateway 的预算/审计/单 Provider 路由；真实密钥进入子进程，违反 R0 egress 守卫；形成第二套不受控 Agent——否决 |
| 修改/替换 DSH 的 llm 适配器，把 ModelGateway 作为进程内 SDK 注入 | 需要修改上游运行时或逆向其 Provider SPI，违背 ADR-002"不改上游 Agent Loop"与版本锁定；否决 |
| 在 Orchestrator 侧拦截并自己调 Gateway，DSH 只做会话壳 | 等于放弃 DSH Agent Loop（工具/上下文/重试语义），重造第二套 Agent——正是 Issue #53 明令避免的；否决 |
| 代理在请求前即开 SSE 头 | 预输出失败无法映射为可分类的干净状态码；改为首个 delta 后开流（与真实供应商 API 行为一致）——已采纳 |

## 约束 / 后果

- 回环代理是**本决策接受的额外一跳**：本地回环延迟与一次协议翻译；作为交换，所有 Gateway 语义对真实 DSH 路径成立且全部可测（E2E-03 套件以真实 worker + 回环合成 vendor 在 CI 零 SKIP 验证）。
- 代理的回环鉴权使用仓库内已公开的合成占位符——**它不是安全边界**，边界是：回环绑定 + Gateway 预算/评审门禁 + 子进程无真实密钥。
- `test:e2e03:real` 是唯一允许真实出网的运行入口，需要显式 `LUMITHINK_E2E03_REAL=1`；其证据 JSON 只含结构化事实（token/费用/耗时/型号 + 评审记录 reviewer/reason），不含提示词与密钥。
- 具体供应商评审记录由运营者在激活时登记（激活解析不生成、不伪造）；本决策不宣告任何"实机模型验收已完成"。
- **生产组合根接线是后续任务**（issue #53 review r1 P2-3）：本决策交付的激活/组合模块（`parseRealProviderActivation` / `buildRealProviderGateway` / `createGatewayEgressProxy`）目前仅被 opt-in 证据 runner 与测试消费；主应用组合根仍为 mock-only，部署环境设置 `LUMITHINK_MODEL_ROUTE=real` 对主应用 no-op。把该拓扑接入生产部署（组合根、`deploy/env`、runbook）是独立的后续任务。
