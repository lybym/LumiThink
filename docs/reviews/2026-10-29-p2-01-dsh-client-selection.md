# P2-01 DSH A2A Client 选型评估记录（issue #113；2026-10-29）

> 关联：Epic P2；输入：[P0-02 兼容矩阵 R1–R3](2026-10-25-p0-02-a2a-sdk-compat-matrix.md)、[A2A_DESIGN §12/§12.1](../../A2A_DESIGN.md)、[TASK_LIFECYCLE §5.3/§7.3/§7.4](../../TASK_LIFECYCLE.md)、[ADR-0018](../adr/0018-dsh-a2a-client-selection.md)（结论承载）。
>
> **口径与边界**：本记录是 P2-01 的评估过程留痕（命令、commit、实验结果、局限）；选型结论、六点评估表与 P2-02 设计骨架以 ADR-0018 为准。全部证据来自隔离目录的合成数据实验与只读源码抓取，**不安装插件进根工作区、不触碰生产 DSH 会话、不含任何真实凭据或儿童资料；公开内容全合成**。

## 1. 输入与基线核验

| 项 | 值 | 核验方式 |
| --- | --- | --- |
| Issue 状态 | #113 OPEN（`[P2-01][A2A] DSH A2A Client 适配选型…`） | `gh issue view` |
| 基线分支 | `main`，本地 HEAD = `origin/main` = `a0dd02e40d7f1377441fd1824d01940fc171804a` | `git fetch origin --prune` → `git switch main` → `git pull --ff-only` → 双 `git rev-parse` 比对 |
| 工作树 | 干净（`git status --porcelain` 为空） | 同上 |
| 既有 PR | 无开放 PR，main 上无 `docs/adr/0018-*` | `gh pr list --state open`、`git grep 0018 -- docs/`、`Get-ChildItem docs/adr` |
| feature 分支 | `feature/p2-01-dsh-client-selection`（自 main 切出） | `git switch -c` |
| 仓库规范 | 无 `AGENTS.md`（glob 核验）；遵循 A2A_DESIGN/TASK_LIFECYCLE/DSH_UPSTREAM 既有约束 | — |
| 插件上游 | `ryubyte/dsh-a2a` main HEAD 仍为 `748c79317c0eee72b2a3f0636050d036c0b15b55`（2026-09-30，v0.3.1）——与 P0-02 冻结点一致，无移动 | Lead 2026-10-29 GitHub API 核验 + 本 Issue `gh api` 独立抓取同 SHA 复核；npm registry：dist-tags.latest=0.3.1（published 2026-09-30T06:09:51Z，integrity `sha512-C4icH5QlYfxtr0PW1rcLpOKvW680XC7rwNiga36reEmU4yVhzZS1YJLyxcloFNvRCPb5qGtAK/GHFi6TbN1wYQ==`） |

## 2. 源码证据（`gh api` 独立抓取 @748c7931）

```powershell
$sha = "748c79317c0eee72b2a3f0636050d036c0b15b55"
gh api -H "Accept: application/vnd.github.raw" "repos/ryubyte/dsh-a2a/contents/<path>?ref=$sha"
# path ∈ src/client.ts, src/outbound.ts, src/jsonrpc.ts, src/protocol.ts, src/index.ts, src/errors.ts, src/card.ts, package.json
```

关键行级依据（全文见 ADR-0018 六点表）：

| 文件:行 | 发现 |
| --- | --- |
| `src/client.ts:109-140` | `sendAndWait` 轮询；L114 强制 `returnImmediately: true` |
| `src/client.ts:136` | abort 仅 `throw new A2AError(408, 'Task wait aborted')`，无 `cancelTask` 调用（R1 源码层确认） |
| `src/client.ts:98-103` | `cancelTask` 存在但等待路径不使用 |
| `src/client.ts:133-135` | INPUT_REQUIRED/AUTH_REQUIRED 返回 task（非错误） |
| `src/jsonrpc.ts:57-63,85-87` | signal 链入 fetch；AbortError → 408 "timed out"（abort/超时同码） |
| `src/outbound.ts:102-112` | `contextByAgent` 进程内 Map + `a2a-out-${randomUUID()}`（R2） |
| `src/outbound.ts:177-184` | 每次工具调用新 `messageId`（L178）；L184 传 `exec.signal` |
| `src/outbound.ts:197-208` | INPUT_REQUIRED/AUTH_REQUIRED 文本化；`-32001`+"interrupted" 特判为 "requires input"（v1.0.1 中 -32001= TaskNotFound，误分类） |
| `src/outbound.ts:174` | `execute` 签名接收 `exec.signal`（取消传播唯一入口即此，且行为如 R1） |
| `src/protocol.ts:58-68` | `Message` 支持 `taskId?`/`referenceTaskIds?` 但 outbound 从不使用 |
| `src/protocol.ts:292-308` | 插件 v1.0 错误码表与官方 SDK/实测基线不一致（-32004/-32009/-32010/-32011 映射漂移） |
| `src/index.ts:427-431` | 出站 bearerToken 明文持久化进 profile 目录 `a2a.json`（自述注释 "token included"；README 明示明文存储） |
| `src/index.ts:810-887` | 入站 authToken 面板"不回传 token 值"（好的一面，但属入站半区，不在本选型范围） |
| `package.json:59-65,71-72,100-102` | peer `cordis ^4.0.4`、`dsh-host-webserver/dsh-tools ^0.1.7-rc.2 \|\| ^0.2.0-rc.1`；devDeps 测试面 pin `0.2.0-rc.1`；engines node `^22.19.0 \|\| >=24.0.0` |
| `poc/dsh-child/package.json`（仓库内） | 内部 DSH 锁定 `@deepseek-ai/dsh`/`dsh-sdk-client`/`dsh-subprocess` 精确 `0.2.0-rc.2` |

官方 SDK 1.3.0 客户端面（`node_modules/@a2a-js/sdk/dist/*.d.ts` 类型核对）：`RequestOptions.signal?: AbortSignal` 为所有方法一等参数；`Client.cancelTask(params, options)` first-class；`AuthenticationHandler`（`headers`/`shouldRetryWithHeaders`/`onSuccessfulRetry`）凭据注入面；`ClientConfig.polling` 显式把轮询职责交给调用方。

## 3. 隔离实验（C:\CODE\_p2-01-probe，仓库外）

**环境**：Node v24.21.0、pnpm 11.28.5（均 DSH 捆绑 runtime，与 P0-02 记录一致）；`@a2a-js/sdk@1.3.0`（精确）、semver 7.8.5、tsx 4.23.15；隔离包自带 `pnpm-lock.yaml`，与根工作区零关联（根依赖零变更）。

**构件**：

- `mock-a2a-server.mjs`：进程内合成 A2A v1.0 JSON-RPC server——AgentCard 发现、`SendMessage`（`returnImmediately` 立即返回 / 默认 blocking-hold + 断连记录）、`GetTask`、`CancelTask`（逐次记录）、方法级日志（`A2A-Version`、auth 头存在性——**不记录 token 值**）。
- `plugin-frozen/`：冻结源码直跑副本（client/jsonrpc/protocol/errors/card，取自 §2 抓取物，SHA 已核）。
- `probe-01-plugin-abort.ts` / `probe-02-official-abort.ts` / `probe-03-semver.mjs`：三个探针（**脚本本体不入仓库**，留存于探针目录；ADR 附录 A 记录了完整复现命令与结果表）。

**运行**：

```powershell
pnpm install
node --import tsx probe-01-plugin-abort.ts      # 10/10 PASS
node --import tsx probe-02-official-abort.ts    # 10/10 PASS
node probe-03-semver.mjs                        # 4/4 PASS
```

**结果摘要**（详表见 ADR-0018 Appendix A）：

- probe-01（插件冻结 client @748c7931）：轮询中 abort → `A2AError 408 "Task wait aborted"`、mock **0 次 CancelTask**、任务孤儿 `WORKING`；taskId 送达前 abort → 408 `"SendMessage timed out"`（abort/超时同码实证）、远端任务已创建但调用方未获 taskId、0 次 CancelTask；Authorization 头确认真实发送。
- probe-02（官方 SDK 1.3.0）：blocking send + signal abort → 本地拒绝（携带 abort reason）、**0 次 CancelTask**、任务孤儿 `WORKING`、mock 记录 `CLIENT_DISCONNECTED_DURING_BLOCKING_SEND`；`returnImmediately` 透传、客户端返回运行时形态 Task（数值枚举）；显式 `cancelTask` → 线上 1 次、任务结算 `CANCELED`；对已终态任务再 cancel → `TaskNotCancelableError`（`envelopeCode=-32002`）；每个请求 `A2A-Version: 1.0`。
- probe-03（semver）：`0.2.0-rc.2` 被 `^0.1.7-rc.2 || ^0.2.0-rc.1` **事实接纳**（经 `^0.2.0-rc.1` 臂），但不被旧臂 `^0.1.7-rc.2` 接纳；上游唯一声明并测试过的版本是 `0.2.0-rc.1`。

**过程中的两次修正（留痕）**：① 初版 mock 把 `GetTask`/`CancelTask` 的 result 误包 `{task:…}` oneof 外壳，probe-01 首跑暴露 `TypeError`——按 v1.0 规范改为返回 Task 对象本身后复跑通过；② probe-02 首跑按 `{task}` 取值落空——即 P0-02 R9 已记录的"官方 Client 直接返回 Task/Message 对象本身"，修正取值后通过，并新增记录：官方 Client 返回**数值枚举**的运行时形态 Task（与 R4 同族），P2-02 适配层需归一。两处修正均强化而非削弱结论。

## 4. 判定

六点逐项判定与决策规则推导见 [ADR-0018](../adr/0018-dsh-a2a-client-selection.md)「六点评估」与「Decision」：**放弃接入 `@ryubyte/dsh-a2a`（R1/R2/R3/R4/R5/R6 六点中四点为跨仓 fork/重写级改造、一点未声明兼容、一点语义缺口），采用官方 `@a2a-js/sdk@1.3.0` 实现轻量 Client 适配（P2-02）**。R1–R3 的处置结论已追加至 P0-02 矩阵 §5 的更新注记（不改写原表）。

## 5. Issue #113 验收条件覆盖

| AC | 证据 |
| --- | --- |
| 六点逐项有源码证据与（可行的）实验证据，形成 GO/NO-GO 选型结论 | ADR-0018 六点表（源码行级 + probe-01/02/03 实验列）+ §1–§3 本记录；结论 NO-GO（插件）/ GO（官方 SDK 轻量 Client） |
| ADR 入库：选定方案、锁定版本/commit、放弃方案理由、风险与边界 | ADR-0018 Decision / Rejected / Version lock / Consequences / Appendix A（实验命令、版本、SHA、结果与局限） |
| 选官方 SDK：给出轻量 Client 最小设计（凭据绑定、taskId 持久化、取消传播、重试语义） | ADR-0018「对 P2-02 的实现约束」（五条硬约束）+ Appendix B（模块骨架、§7.4 逐句映射、P2-02 验收锚点） |

## 6. 局限与不宣称

- mock 为按规范手写的最小服务端，非官方 `DefaultRequestHandler`；其 blocking-hold 语义经 probe-02 A 的断连事件交叉验证，但不等同官方服务端全套行为。
- 未测：SSE 流式路径的 abort/取消、`SubscribeToTask`/`resubscribeTask`、REST/gRPC 绑定、AgentCard 签名、push notification；插件 dashboard 与入站半区不在本选型范围。
- 本 Issue 不实现正式接入（P2-02）、不修改 LumiThink 服务端、不触碰生产 DSH 会话与真实凭据；实验全程合成数据（合成 token 仅记录存在性）。
- 不宣称 P2 Gate 或互通实机验收通过；`@a2a-js/sdk` 升级必须重跑 P0-02 §6 全部验证（ADR-0018 Version lock 行）。

## 7. 本地验证

- 文档引用的文件/行号经抽查与 §2 抓取物一致（client.ts L136/L114/L133、outbound.ts L102-112/L178/L197-208、jsonrpc.ts L45/L85-87、index.ts L427-431、protocol.ts L58-68/L292-308、package.json L59-65）。
- probe 结果 JSON（`results-probe-0*.json`，仓库外）与本记录/ADR 数值一致。
- 纯 docs 变更：`pnpm run typecheck` 须 exit 0（见 PR checks 与本地复跑）。
