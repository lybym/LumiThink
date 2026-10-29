# ADR-0018: DSH A2A Client 选型 — 官方 `@a2a-js/sdk` 轻量 Client 适配，放弃接入 `@ryubyte/dsh-a2a`

Status: accepted (P2-01, issue [#113](https://github.com/lybym/LumiThink/issues/113))
Date: 2026-10-29
Supersedes: none. 收敛 [A2A_DESIGN](../A2A_DESIGN.md) §12「工作 DSH」行的开放选型与 §12.1 接入前置条件；消费 [P0-02 兼容矩阵](../reviews/2026-10-25-p0-02-a2a-sdk-compat-matrix.md) R1–R3。

## Context

P2 Epic 要求 DSH 工作端具备**出站 A2A Client**能力（把远端 Agent 的 skill 作为 DSH 工具调用）。候选是 `@ryubyte/dsh-a2a` 插件的 client 半区；备选是基于官方 `@a2a-js/sdk` 自写轻量 Client 适配。P0-02 已将候选插件源码冻结于 `748c7931` 并登记风险 R1–R3；[A2A_DESIGN §12.1](../A2A_DESIGN.md) 规定：补丁成本或兼容性不可控时改用官方 SDK 编写轻量 Client 插件，不将问题转移给非标准 RPC。

本 ADR 按 issue #113 的六点逐项给出源码证据（`gh api` 独立抓取 @748c7931）与隔离可执行实验证据（`C:\CODE\_p2-01-probe`，仓库外隔离，全部合成数据），并按 Issue 明示的决策规则收敛选型。

## Decision

**放弃接入/修补 `@ryubyte/dsh-a2a`，采用官方 `@a2a-js/sdk@1.3.0`（P0-02/P1 已全链验证的同一客户端库）实现 LumiThink 自有的轻量 DSH A2A Client 适配（P2-02 实施）。** 取消传播、taskId 持久化、凭据绑定、重试与多轮句柄按 TASK_LIFECYCLE §5.3/§7.3/§7.4 在适配层显式实现——这些本来就是应用层职责；官方 SDK 提供正确且已被验证的传输/编解码/错误语义/first-class `cancelTask`，插件则要求跨仓 fork 级结构改造才能达到同等约束。

## 六点评估（源码证据 + 实验证据 + 改造成本 + 风险）

插件源码证据均来自 `gh api repos/ryubyte/dsh-a2a/contents/...?ref=748c79317c0eee72b2a3f0636050d036c0b15b55`（与 P0-02 冻结点一致；Lead 2026-10-29 复核 main HEAD 无移动，npm latest 仍为 0.3.1，发布于 2026-09-30）。

| # | 评估点 | 插件现状（源码证据 @748c7931） | 实验/交叉证据 | 若选插件所需改造与成本 | 风险 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | DSH 版本兼容（R3） | `package.json` L59–65：peer `@deepseek-ai/cordis ^4.0.4`、`dsh-host-webserver`/`dsh-tools` `^0.1.7-rc.2 \|\| ^0.2.0-rc.1`；devDeps 测试面 pin `0.2.0-rc.1`（L71–72）；engines node `^22.19.0 \|\| >=24.0.0`（L100–102） | probe-03（semver 7.8.5）：`satisfies('0.2.0-rc.2', '^0.1.7-rc.2 \|\| ^0.2.0-rc.1') = true`（经 `^0.2.0-rc.1` 臂，`>=0.2.0-rc.1 <0.3.0`；`^0.1.7-rc.2` 单独 = false）。即 rc.2 在 semver 意义上被接纳，但上游从未声明或测试 rc.2（修复提交仅声称 rc.1；devDeps rc.1） | 隔离环境互通复测 rc.2 + 固定插件提交 + 打补丁；`dsh.bundle.patch`（cordis.patch.yml）与 DSH 版本强耦合，后续每个 rc 重放一遍 | 非声明兼容面随 rc 演进漂移；升级内部 DSH 版本须走 DSH_UPSTREAM 纪律，不在本链路授权范围 | 可勉强满足但有持续维护税；**非决定性单点，叠加 #2/#3 后不可接受** |
| 2 | AbortSignal → 远端 CancelTask 传播（R1） | `src/client.ts` L109–140 `sendAndWait` 轮询；L136 仅 `if (options.signal?.aborted) throw new A2AError(408, 'Task wait aborted')`，**全程无 `cancelTask` 调用**（`cancelTask` 存在于 L98–103 但未被等待路径使用）；`src/jsonrpc.ts` L57–63 把 signal 链入 fetch、L85–87 将 AbortError 映射为 408 "timed out"（**abort 与超时共用同一错误码，无法区分取消意图与超时**） | probe-01（冻结源码直跑，10/10 PASS）：场景 A（轮询中 abort）→ A2AError 408、mock 收到 **0 次 CancelTask**、任务孤儿 WORKING；场景 B（taskId 送达前 abort）→ 408、远端任务已创建但调用方永远拿不到 taskId、0 次 CancelTask | 结构性改造：`sendAndWait` 需内建独立清理上下文（独立 AbortController、§7.3 的 2s 上限）、taskId 未取得时按持久化映射恢复后取消（§7.4），且轮询循环的返回结构/错误特判需同步修改——即跨仓 fork + 上游协商 | fork 永久维护；上游 0.x 阶段 API 演进无兼容承诺 | **不可接受（fork 级改造）** |
| 3 | Context/Task 持久映射（R2） | `src/outbound.ts` L102–112：`contextByAgent` 进程内 Map，`a2a-out-${crypto.randomUUID()}`（重启/重连即丢）；L177–182：每次工具调用 `messageId: crypto.randomUUID()`（L178）；无任何持久请求记录/稳定重试 ID/taskId 落盘点 | probe-01 场景 B 直接实证"taskId 未持久化时无法恢复"——§7.4 的恢复语义在插件数据面上无处安放 | 持久化 messageId→task 映射、taskId 取得即落盘、跨重启恢复——需让插件理解 LumiThink 仓储（SQLite/Outbox），等于重写 outbound 状态面 | fork-rewrite；与 LumiThink 单一权威 Task Store（ADR-0013）边界冲突 | **不可接受（重写级改造）** |
| 4 | 首响应丢失与重试 | `client.ts` L114 强制 `returnImmediately: true` 后轮询；无原消息重发恢复语义；`outbound.ts` L206–208 将 `-32001` + message 含 "interrupted" 特判为 "requires input"，而 **-32001 在 v1.0.1 基线是 TASK_NOT_FOUND**（官方 SDK `A2A_ERROR_CODE`、fixtures 11、P0-02 §3 实测一致）；`src/protocol.ts` L292–308 错误码表与 v1.0.1 官方映射不一致（-32004 标为 AGENT_CARD_NOT_FOUND、-32009/‑32010/‑32011 vs 官方 VERSION_NOT_SUPPORTED=-32009 / UNSUPPORTED_OPERATION=-32004 / PUSH_NOTIFICATION_NOT_SUPPORTED=-32003） | probe-02 场景 C：官方 SDK 对 -32002 抛语义类 `TaskNotCancelableError`（`envelopeCode` 可编程判别）——适配层可直接按语义类映射 LumiThink 内部错误 | 修正错误码表 + 重发恢复语义 + 稳定 messageId（与 #3 改造叠加） | 基于错误码的错误分类会系统性误判（例如把 TASK_NOT_FOUND 当"需要输入"），影响重试与取消决策的正确性 | **不可接受（协议偏差需成表修正）** |
| 5 | 身份凭据隔离 | `src/index.ts` L427–431：出站 `bearerToken` 按 agent 明文持久化进 profile 目录 `a2a.json`（注释自述 "Persist … (token included)"；README 明示"均明文存于 a2a.json"）；无 Profile→client_id 绑定面（`exec.agent?.id` 仅用于 context 映射，outbound.ts L104–112/L180）；好的一面：错误消息只含 URL 不含 token（jsonrpc.ts L74/L142），Bearer 只进 `authorization` 头（jsonrpc.ts L45） | — | 凭据注入改为回调/内存面、去掉 a2a.json 持久化——又是插件核心配置面改造 | LumiThink 凭据纪律（A2A_DESIGN §13.1：真实凭据不进源码/普通日志/评审制品）不允许第二份明文凭据落盘文件 | **不可接受（凭据面需改造）** |
| 6 | `input-required` 多轮语义 | `client.ts` L133–135：INPUT_REQUIRED/AUTH_REQUIRED 返回 task（不抛错，方向正确）；`outbound.ts` L197–203：把两者都降级为文本 `[remote agent TASK_STATE_INPUT_REQUIRED] …` 交回模型；**再次调用工具 = 新 messageId + 仅复用 contextId（L177–182），从不携带原 taskId/`referenceTaskIds`**（Message 类型支持二者，protocol.ts L58–68） | — | 任务句柄（taskId/contextId）需搬进适配层并改 makeTool 契约——fork 级 | AUTH_REQUIRED 与 INPUT_REQUIRED 同文本化，模型无法区分"补充输入"与"需要授权"，存在把授权请求当普通问答的社会工程面风险 | **部分可用但语义不完整；适配层自持即可正确实现** |

**汇总**：#2/#3/#4/#5 均为跨仓 fork 或重写级改造，#1 叠加未声明兼容复测，#6 语义缺口。按 Issue 决策规则（修复成本或协议偏差不可接受 → 官方 SDK 轻量 Client），结论为**官方 SDK**。注意：官方 SDK 的 abort 同样只是传输层本地中断（probe-02 场景 A：blocking send abort 后 0 次 CancelTask、任务孤儿 WORKING）——但这不是放弃官方 SDK 的理由，而是确认了取消传播本来就应按 TASK_LIFECYCLE §7.4 由适配层显式实现；官方 SDK 为此提供了 first-class `client.cancelTask(params, { signal })`（probe-02 场景 B 实证可用）、语义化错误类与 `AuthenticationHandler` 凭据注入面，插件则没有任何一处可以承载这些职责的扩展点。

## Rejected: 接入 `@ryubyte/dsh-a2a`

- 需要同时完成 4 项结构改造（取消传播、持久化、凭据注入、多轮句柄）+ 错误码表修正 + rc.2 兼容复测，全部落在跨仓 fork 上；后续每个上游 rc/版本都要重放验证。
- 无支持承诺：个人仓库，latest 0.3.1（2026-09-30），无 roadmap/SLA。
- 并非插件质量否定：其 client 半区（5 个文件约 1.1k 行）与官方 SDK 传输层高度重叠，入站服务与 dashboard 不在本需求范围；冻结提交保留为评估引用（见版本锁定），未来若上游补齐取消传播与持久化面可重新评估，但不构成本期依赖。

## Version lock

| 对象 | 锁定值 | 完整性/来源证据 |
| --- | --- | --- |
| 出站 Client SDK | `@a2a-js/sdk@1.3.0`（精确版本） | P0-02 §1：npm tarball + integrity `sha512-OpK4nygUnLKlpTFZlM2IrYu7f3c/B7c4u4Z14+vgMq24lEINTVCxH/BqZx+GL92rNf7CoBL5oTP5UhNsl75yyg==`；上游 tag v1.3.0（2026-09-29）；P1 服务端 + 官方 JS/Python 客户端互通全链验证。**升级必须重跑 P0-02 §6 全部验证并更新矩阵** |
| 候选插件（仅评估引用，不接入） | `ryubyte/dsh-a2a` main `748c79317c0eee72b2a3f0636050d036c0b15b55`（2026-09-30，"fix: support DSH 0.2.0-rc.1 in v0.3.1 (#13)"；npm `@ryubyte/dsh-a2a@0.3.1`，integrity `sha512-C4icH5QlYfxtr0PW1rcLpOKvW680XC7rwNiga36reEmU4yVhzZS1YJLyxcloFNvRCPb5qGtAK/GHFi6TbN1wYQ==`，published 2026-09-30T06:09:51Z） | Lead 2026-10-29 经 GitHub API 复核 main HEAD 无移动；本 Issue 执行时 `gh api` 独立抓取同 SHA 源文件复核 |
| 协议基线 | A2A v1.0.1（`A2A-Version: 1.0`） | 沿用 P0-02 §1 锁定；probe-02 实测官方客户端对 card 发现与每个 JSON-RPC 请求均发送 `A2A-Version: 1.0` |
| 仓库内部 DSH | `@deepseek-ai/*` `0.2.0-rc.2`（`poc/dsh-child/package.json`，精确 pin） | 沿用既有锁定，不变更；插件 peer 对 rc.2 的"事实接纳"（probe-03）不改变"未经上游声明与验证"的定性 |

## 对 P2-02 的实现约束（硬约束，ADR-0018 附件 B 为骨架）

1. **凭据绑定**：凭据注入只经官方 SDK `AuthenticationHandler`（`headers()` / `shouldRetryWithHeaders()` / `onSuccessfulRetry()`）回调面，由 LumiThink 配置层在内存中供给；**不落任何插件自有 JSON/明文文件**（插件路径的反面教训：index.ts L427–431）。首期限定个人 Profile；`shouldRetryWithHeaders` 是 401/403 后凭据续签的规范挂点，续签失败按 §7.4"清理未完成必须显示/记录"处理。
2. **taskId 持久化时机**：工具发起请求**前**保存稳定 messageId + 原请求 + 本地调用映射；**取得 taskId 后立即持久化**（§7.4 第一段）。映射与 LumiThink 单一权威 Task Store（ADR-0013）同库存放，禁止进程内 Map 作为唯一副本。
3. **独立取消上下文**：工具 Abort → 先停止本地呈现 → 以**独立 AbortController/超时**发送 `client.cancelTask({ id })`（§7.3：CancelTask 响应最多等 2 秒，超时返回标准内部错误映射 + "取消结果未确认，可查询任务"，持久取消意图仍有效）；清理请求**不得携带已 aborted 的工具 signal**（§7.4）。taskId 未取得时按 §5.3 以原 messageId 重发（returnImmediately 模式）找回任务后再取消，恢复与取消结果均记录。
4. **重试语义**：网络失败按有限重试；错误分类以官方 SDK 语义类/`envelopeCode` 为准（`TaskNotFoundError`≠"需要输入"）；重试计入模型调用预算（A2A_DESIGN §13.4）。
5. **input-required 处理**：`INPUT_REQUIRED`/`AUTH_REQUIRED` 返回结构化句柄（taskId + contextId + status.message）而非纯文本；补交输入走"新消息 + 同 contextId + 原taskId/`referenceTaskIds`"指向原任务；`AUTH_REQUIRED` 必须与普通输入区分呈现，不得降级为普通问答文本（插件路径 L197–203 的反面教训）。

## Consequences

- P2-02 只实现适配层（预计远小于插件的 fork-rewrite 成本），传输/编解码/版本头/错误语义复用已验证 SDK 面。
- 官方 SDK abort 的传输层边界（本地中断、不自动远端取消）成为适配层的**必须覆盖项**（上述约束 3），并列入 P2-02 验收：工具 abort 必须在 mock 上观察到 CancelTask。
- 候选插件从"接入候选"降级为"评估引用"；若未来上游补齐 §12.1 前置条件可重开评估，需重跑本 ADR 六点表。

## Appendix A: 隔离实验记录（C:\CODE\_p2-01-probe，仓库外，全部合成数据）

**环境**：Node v24.21.0（DSH 捆绑 runtime，与 P0-02 记录一致）、pnpm 11.28.5、`@a2a-js/sdk@1.3.0`（精确）、semver 7.8.5、tsx 4.23.15；隔离包自带锁文件，与根工作区零关联。合成凭据 `synthetic-probe-token-P2-01`；mock 仅记录 Authorization 头**存在性**，不记录值。

**方法**：进程内 mock A2A v1.0 JSON-RPC server（`mock-a2a-server.mjs`）：`GET /.well-known/agent-card.json`；`POST /a2a` 分发 `SendMessage`（支持 `returnImmediately` 立即返回与默认 blocking-hold）/`GetTask`/`CancelTask`（记录每次调用），记录方法级日志（方法、messageId/taskId、`A2A-Version`、auth 存在性、blocking 断连事件）。三个探针脚本（`probe-01-plugin-abort.ts`、`probe-02-official-abort.ts`、`probe-03-semver.mjs`）本体留存于探针目录、**不入仓库**；运行命令与结果如下，可按本附录复现。

**运行命令**（探针目录内）：

```powershell
pnpm install                                    # 按 pnpm-lock.yaml 精确安装
node --import tsx probe-01-plugin-abort.ts      # 冻结插件 client @748c7931 → mock
node --import tsx probe-02-official-abort.ts    # 官方 @a2a-js/sdk 1.3.0 → 同一 mock
node probe-03-semver.mjs                        # R3 peer-range semver 判定
```

**probe-01（插件冻结 client，10/10 PASS）**：

| 断言 | 结果 |
| --- | --- |
| A: 轮询中 abort（800ms，interval 120ms）→ `sendAndWait` 拒绝 | PASS：`A2AError code=408 "Task wait aborted"` |
| A: mock 收到 CancelTask | PASS：**0 次** |
| A: 任务终态 | PASS：`task-001` 孤儿 `TASK_STATE_WORKING` |
| B: taskId 送达前 abort（sendDelay 500ms，abort 120ms）→ 拒绝 | PASS：`A2AError code=408 "A2A JSON-RPC call \"SendMessage\" timed out"`（abort/超时同码实证） |
| B: 远端任务已创建但调用方未获得 taskId | PASS：`task-002` 已创建、孤儿 `WORKING` |
| B: mock 收到 CancelTask | PASS：**0 次** |
| B: 插件确实发送了 Authorization 头 | PASS（证明实验链路真实通过凭据面） |

**probe-02（官方 SDK 1.3.0，10/10 PASS）**：

| 断言 | 结果 |
| --- | --- |
| A: blocking send + signal abort（800ms）→ 本地拒绝 | PASS：以 `tool-abort-simulated` reason 拒绝 |
| A: 客户端自动发出 CancelTask | PASS：**0 次**（官方 SDK abort 同样是传输层本地中断——这是适配层必须覆盖的边界，非插件独有缺陷） |
| A: 任务终态 | PASS：孤儿 `WORKING`；mock 记录 `CLIENT_DISCONNECTED_DURING_BLOCKING_SEND`（blocking-hold 语义交叉验证） |
| A/B/C: 每个请求携带 `A2A-Version: 1.0` | PASS（card 发现与 SendMessage/CancelTask 均实测） |
| B: `returnImmediately` 请求透传到线上 | PASS（methodLog `returnImmediately: true`）；客户端返回**运行时形态 Task**（数值枚举 state=2，P0-02 R4/R9 同族行为） |
| B: 显式 `client.cancelTask({ id })` | PASS：线上 1 次 CancelTask、任务结算 `CANCELED`（first-class 取消路径可用） |
| C: 对已 CANCELED 任务再 cancel | PASS：`TaskNotCancelableError`、`envelopeCode=-32002`（语义错误类可编程判别） |

**probe-03（semver，4/4 PASS）**：

| `satisfies(version, range)` | 结果 |
| --- | --- |
| `0.2.0-rc.2` vs `^0.1.7-rc.2 \|\| ^0.2.0-rc.1` | **true**（经 `^0.2.0-rc.1` 臂） |
| `0.2.0-rc.2` vs `^0.1.7-rc.2` | false（同元组比较器无 prerelease 则不接纳 prerelease） |
| `0.2.0-rc.2` vs `^0.2.0-rc.1` | true |
| `0.2.0-rc.1` vs 全 range | true（上游唯一声明并测试过的版本） |

**局限**：mock 为按规范手写的最小服务端（AgentCard/SendMessage/GetTask/CancelTask 面），非官方 `DefaultRequestHandler`（其 blocking-hold 语义经 probe-02 A 的断连事件交叉验证）；未测 SSE 流式路径的 abort 行为与 `SubscribeToTask`/`resubscribeTask`（P2-02 接入时须补流式取消实验）；REST/gRPC 绑定未测（本期锁定 JSONRPC）；插件 dashboard/入站半区不在评估范围；实验为合成回环，不代表真实远端 Agent 或实机验收。

## Appendix B: P2-02 最小设计骨架（官方 SDK 轻量 Client）

**模块位置建议**：`services/a2a-client/`（与 `services/a2a-server`（ADR-0013 隔离包先例）对称的独立包：自含 `package.json`/锁文件、Node 24.x、`@a2a-js/sdk@1.3.0` 精确依赖、不进根工作区依赖）。对外暴露 `createA2aClientTools(config)`：读 AgentCard → 按 skill 注册 DSH 工具（沿用候选插件证明可用的 `a2a__<agent>__<skill>` 命名契约，但句柄管理换为下述自有面）。DSH 侧接线（composition/profile 配置、工具注册）归 P2-02 按 DSH_UPSTREAM 纪律实施，本 ADR 只锁接口形态。

**组件面**（全部薄层，可单测）：

1. `a2aClientFactory`：`ClientFactory` + `JsonRpcTransportFactory`（probe-02 已验证的创建路径）；`AuthenticationHandler` 由配置层注入（约束 1）。
2. `taskLedger`（持久映射）：`saveBeforeSend({ stableMessageId, originalRequest, agentRef })` → `saveTaskId(stableMessageId, taskId, contextId)`（**取得即落盘**，约束 2）→ `restore(stableMessageId)`。与 ADR-0013 权威 Task Store 同库（SQLite，事务边界一致）。
3. `sendAndWaitUntilTerminal(taskId, toolSignal)`：轮询 `getTask`（interval 可配）；**工具 signal 只控制"停止等待/呈现"**；terminal 判定含 `INPUT_REQUIRED`/`AUTH_REQUIRED` 早退（返回结构化句柄，约束 5）。
4. `cancelThrough(taskId, reason)`：独立 `AbortController`（2s 上限，§7.3）→ `client.cancelTask({ id })`；超时/失败 → 标准内部错误映射 + "取消结果未确认，可查询任务"，**写待清理记录**（进程退出后由重启恢复扫描 + 服务端执行期限兜底，§7.4 末段）。
5. `resumeOrphan(stableMessageId)`：taskId 缺失时按 §5.3 原 messageId 重发（`returnImmediately: true`）找回任务 → 转 `cancelThrough`；两步结果均记录。
6. `errorMapper`：SDK 语义类/`envelopeCode` → LumiThink 内部错误（`TaskNotFoundError`≠需输入；`TaskNotCancelableError`→§7.2 竞态表"保持非终态/不可取消"分支）。

**与 TASK_LIFECYCLE §7.4 的一致点（逐句映射）**：

| §7.4 原文要求 | 骨架落点 |
| --- | --- |
| 发起请求前保存稳定 messageId、原请求和本地调用映射 | `taskLedger.saveBeforeSend`（工具 execute 第一步） |
| 收到 Task ID 后立即持久化，随后轮询 | `sendRes`/首个 GetTask 命中后同步 `saveTaskId` 再进 `sendAndWaitUntilTerminal` |
| 工具 Abort：先停本地呈现，再以独立清理请求发 CancelTask；清理请求独立 AbortController/超时，不携带已 aborted 的 signal | 工具 signal 仅触发本地 early-return；`cancelThrough` 自建 controller（2s） |
| Task ID 未取得时按 §5.3 恢复原请求映射并取消；恢复与取消结果均记录 | `resumeOrphan` → `cancelThrough`，全程写 ledger 审计 |
| 网络失败/凭据过期：有限重试 + 授权续签；清理未完成须显示/记录 | `errorMapper` 有限重试 + `AuthenticationHandler.shouldRetryWithHeaders` 续签；失败写待清理记录并上抛可读状态 |
| 插件进程退出后由已保存待清理记录及服务端执行期限兜底 | ledger 持久行 + 重启恢复扫描（§9 表"取消意图已保存"行） |

**验收锚点（P2-02 必测，mock 复用本 ADR 附录 A 的方法）**：工具 abort → mock 观察到 CancelTask；taskId 未取得时 abort → 原 messageId 重发找回 → CancelTask；重启后待清理记录生效；`AUTH_REQUIRED` 不降级为普通文本；对已终态任务的取消返回标准不可取消映射。
