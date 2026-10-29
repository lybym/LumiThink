# P2-02 DSH A2A Client 正式接入 实现记录（issue #114；2026-10-29）

> 关联：Epic P2；前置：[P2-01 选型评估](2026-10-29-p2-01-dsh-client-selection.md)、[ADR-0018](../adr/0018-dsh-a2a-client-selection.md)（五条硬约束 + Appendix B 骨架）、[ADR-0013](../adr/0013-a2a-server-isolated-package.md)（隔离包先例）、[TASK_LIFECYCLE §5.3/§7.3/§7.4](../../TASK_LIFECYCLE.md)。
>
> **口径与边界**：交付物是官方 `@a2a-js/sdk@1.3.0` 轻量 DSH A2A Client 隔离包 `services/dsh-a2a-client/`（根依赖面零变更）。全部内容合成、全部凭据合成、仅 loopback；不切 UDS；不触碰 `poc/dsh-child`；不修改 a2a-server 服务端语义。**"注册进真实工作 DSH 实例"属运营者面，如实列 PENDING（见 §8），不冒充已实装。**

## 1. 基线与交付物

| 项 | 值 |
| --- | --- |
| Issue | [#114](https://github.com/lybym/LumiThink/issues/114) OPEN（`gh issue view` 核验，AC 六组全量读取） |
| 基线 | `main`，本地 HEAD = `origin/main` = `07f780768c6dbd1cd5531df60013538404691000`（fetch → switch → `pull --ff-only` 后双 `git rev-parse` 比对一致） |
| 工作树 | 干净（`git status --porcelain` 为空）；无既有开放 PR（`gh pr list --state open` 为空） |
| 分支 | `feature/p2-02-dsh-client-integration`（自 main 切出） |
| 仓库规范 | 无 `AGENTS.md`；遵循 A2A_DESIGN/TASK_LIFECYCLE/ADR-0013/ADR-0018 |
| 新增包 | `services/dsh-a2a-client/`：`package.json` + 自有 `pnpm-workspace.yaml`（`nodeLinker: hoisted`）+ `pnpm-lock.yaml`（lockfileVersion 9.0）+ `tsconfig.json` + `README.md`；根工作区依赖面零变更（根 `package.json` 仅新增 script `test:dsh-a2a-client`） |
| 工具链 | Node v24.21.0、pnpm 11.28.5（DSH 捆绑 runtime；CI 侧 pin 10.34.7，lockfileVersion 9.0 与该 pin 兼容——同 a2a-server 先例）、TypeScript 5.9.3、`@a2a-js/sdk@1.3.0`（精确，Version lock 不变） |

## 2. 实现（按 ADR-0018 五条硬约束逐条落点）

| ADR-0018 约束 | 实现落点 |
| --- | --- |
| 1. 凭据绑定 | 官方 `createAuthenticatingFetchWithRetry` + `AuthenticationHandler`（`headers`/`shouldRetryWithHeaders`/`onSuccessfulRetry`）回调面（`src/dsh-a2a-client.ts`）；凭据来自内存配置/env（`loadDshA2aClientConfig` 缺 token/URL/ledger 即拒绝构造，fail-closed）；401/403 → provider 重签，重签失败抛 `credential_renewal_failed`（§7.4 清理未完成必须可见）；凭据零落盘（ledger 写入前做 bearer 形态守卫，负例测试锚定）、零日志、零错误消息 |
| 2. taskId 持久化 | `send()` 第一步 `saveBeforeSend`（稳定 messageId + 原请求 + `returnImmediately` 模式元数据，wire 请求前 flush 到磁盘）；响应含 Task 即刻 `saveTaskId`（messageId ↔ taskId ↔ contextId）再进入轮询（§7.4 逐句映射与 ADR Appendix B 表一致） |
| 3. 独立取消上下文 | `cancelThroughTaskId`：自建 `AbortController` + §7.3 超时（缺省 2000ms）发 `client.cancelTask`；工具 signal 只停本地等待（`TaskWaitAbortedError`），清理请求绝不携带已 aborted signal（负例可证：若携带则 CancelTask 观测不到）；超时 → `unconfirmed_timeout` + 「取消结果未确认，可查询任务」+ 意图持久保留；无 taskId 时 `recoverTaskByResend` 按 §5.3 原消息重发找回同一 Task 再取消，两步均入账（resend 计数 + 意图状态） |
| 4. 重试语义 | 网络瞬时失败有限重试（`maxSendRetries`，缺省 2，仅匹配 fetch failed/ECONN*/socket 类）；错误分类以官方语义类为准：`TaskNotFoundError` → `task_not_found`（明确 "NOT an input request"）、`TaskNotCancelableError` → `already_terminal`（§7.2 竞态行），不自造错误码 |
| 5. input-required | `waitUntilTerminal` 对 INPUT_REQUIRED/AUTH_REQUIRED 结构化早退：handle 携带 `taskId + contextId + statusMessage + inputRequired/authRequired` 独立布尔（不降级为纯文本）；`sendFollowUp` 以新稳定 messageId + 同 contextId + 原 taskId/`referenceTaskIds` 指回原任务（mock 层线级断言逐字段验证） |

持久化（`src/ledger.ts`）：`FileTaskLedger` 单 JSON 文档 + tmp/rename 原子替换；损坏文件/未知未来版本 fail-closed 拒运行；`resumePending()` 重启扫描产出 `query_or_reattach / recover_via_resend / reconfirm_cancel / nothing_pending` 分类。**对 ADR-0018 Appendix B 的一处显式适配**：原骨架注记"映射与 ADR-0013 权威 Task Store 同库（SQLite）"，但本包是工作 DSH 的**外部客户端**（A2A_DESIGN §3.2：不访问家庭数据库/内部 Runtime），服务端 SQLite 不可共享；按派发 Handoff 的"轻量存储（node:sqlite 或原子写 JSON 文件，按 ADR 骨架决定）"采用原子写 JSON 文件，进程内 Map 禁止作为唯一副本的约束不变，服务端存储保持唯一权威不动。另：包位置按派发 Handoff 取 `services/dsh-a2a-client/`（ADR Appendix B 建议名 `services/a2a-client/`）——两处偏离均为显式提出，非静默。

## 3. 测试架构

两层，全部可重复执行、全合成：

1. **单元/契约层（8 个 spec，39 测试，进程内 mock A2A v1.0 服务器）**：mock 按 ADR-0018 附录 A 方法论手写（`tests/helpers.ts`），线级形状用锁定 SDK 自有 codec（`Task.toJSON`/`MessageCodec.fromJSON`）产出，官方客户端解析即验；方法日志只记凭据**存在性**。覆盖：发送前落盘/取得即落盘/跨重启恢复/账本损坏 fail-closed/凭据材料拒入账（ledger）；配置 fail-closed（config）；发送/查询/凭据面（client-send）；ADR 验收锚点四件套——工具 abort → mock 观测到 CancelTask、taskId 未取得时 abort → §5.3 重发找回同 Task → CancelTask、终态任务取消 → 标准不可取消映射、§7.3 超时 → unconfirmed + 意图保留，另含独立清理上下文负例（client-cancel）；INPUT_REQUIRED/AUTH_REQUIRED 结构化句柄与多轮字段（client-multiturn）；§5.3 丢失恢复 + 重启扫描 + 待取消意图复确认（client-recovery）；401 重签/重签失败可见/静态凭据 401 不静默重试（client-auth）；SSE 消费 + 断流不取消 + 重订阅（client-stream）。
2. **集成层（真实 a2a-server 独立子进程，`tests/integration/`）**：`src/main.ts` 以 `--experimental-strip-types` 真实子进程启动，`dsh-worker` 运行时 + 文件 SQLite（task/identity 分库）+ 双凭据合成 bootstrap（alpha/beta 两家庭两主体）+ 合成指纹密钥 + 紧凑但稳定的 worker watchdog 调参；worker 行为剖面经服务器 env 继承注入（`stop-on-cancel`/`complete`）。断言证据跨进程直读文件 DB（`a2a_executions`/`a2a_tasks`/`a2a_identity_task_bindings`，只读连接）。

## 4. 六组验收证据（对应 #114「必须验证」）

| # | 组 | 真实链路证据（集成 spec 断言） |
| --- | --- | --- |
| 1 | 创建/查询/多轮 | `sendAndConsume` → COMPLETED；`getTask` 快照一致；多轮 = 新 messageId + 同 contextId + `referenceTaskIds` 指回原任务 → 同会话续接成功（**注**：INPUT_REQUIRED 句柄与"同 Task 后续 Turn"的客户端契约在 mock 层全量验证；真实服务器当前无 INPUT_REQUIRED 生产者、`appendTurn` 仓储原语未接入请求路径——服务端能力缺口，见 §7/§8） |
| 2 | 真实 Worker 执行 | 受理门 → 派发租约 → 真实 worker 子进程：执行行 `settled` + `worker_id` 非空 + settlement `outcome=completed`/exitCode 0 + 公开 artifact 两片段；任务行 `completed` |
| 3 | 取消真实传播 | 工具 Abort（首片段已产出、执行活跃）→ 独立 CancelTask → **服务端停止证据**：任务行 `canceled` + `cancel_intent=1`；执行行 `settled` + `outcome=canceled`（worker 自报）+ `worker_id` + `exitCode 0` + 无 `killedByRuntime`（协作停止）；客户端账本 `confirmed_canceled`。**不以"客户端停止等待"冒充** |
| 4 | 响应丢失幂等恢复 | 注入 fetch 在服务器受理后丢弃首响应 → 客户端有限重试**同一原 messageId** → 同一 Task（`a2a_task_history` 该 messageId 恰 1 行）→ 执行行恰 1 条（不重复推理） |
| 5 | 认证与跨主体 | 伪造 `metadata.userId/householdId/tenant` 请求成功但归属绑定仍为**认证主体**（identity 库 `task_bindings.principal_user_id = user-alpha-guardian`）；beta 凭据 GetTask/CancelTask alpha 任务 → 标准 `-32001`（客户端映射 `task_not_found`/`not_found`），任务状态不受影响；凭据过期重签：首 token 401 → provider 重签 → 重试成功（真实 401 线级语义） |
| 6 | 失败与重连 | 服务器进程重启（同 DB 文件复用）：终态任务原 taskId/状态保留可查；中断任务由启动恢复扫描如实结算（执行行 `abandoned`/公开 `FAILED`，**不重复执行**）；客户端账本跨重启（新实例同文件）`resumePending` 分类正确。SSE 断流：本地 abort 不取消远端（任务保持 working）→ GetTask 恢复真实状态 → 重订阅附着（真实服务器为切点流：投递切点后事件）→ 显式取消后恢复流观测到终态 CANCELED |

Wire 级样例（结构示意，脱敏；`A2A-Version: 1.0` 与 `Authorization: Bearer <synthetic>` 头由锁定 SDK 注入）：

```jsonc
// POST /a2a  method=SendMessage（returnImmediately 模式元数据在线上可见）
{ "jsonrpc":"2.0", "id":1, "method":"SendMessage",
  "params":{ "tenant":"", "message":{ "messageId":"<stable-uuid>", "contextId":"", "taskId":"",
    "role":"ROLE_USER", "parts":[{"mediaType":"text/plain","content":{"text":"合成业务文本"}}],
    "metadata":{ "…":"…" }, "extensions":[], "referenceTaskIds":[] },
    "configuration":{ "returnImmediately":true, "acceptedOutputModes":["text/plain"] }, "metadata":undefined } }
// result: { "task": { "id":"<server-uuid>", "contextId":"…", "status":{ "state":"TASK_STATE_…" }, … } }
// CancelTask：method=CancelTask，params={ "id":"<taskId>" } → result 为 Task 快照（CANCELED）或 -32002
```

## 5. 命令与结果（本地，2026-10-29）

```powershell
# 客户端包（根 script，等价于包内 install+typecheck+test+test:integration）
pnpm run test:dsh-a2a-client
#   → frozen install（a2a-server + dsh-a2a-client 各自锁文件）OK
#   → tsc --noEmit exit 0
#   → 单元/契约：39/39 pass，0 fail 0 skipped（34.1s）
#   → 集成（真实 a2a-server + dsh-worker 子进程）：5/5 pass（5.5s）
pnpm run test:a2a-server      # 回归：187 tests，185 pass / 0 skipped / 2 fail（见下注）
pnpm run test:a2a-compat      # 回归：2/2 pass（wire/codec 套件）
pnpm run typecheck            # 根工作区类型检查 exit 0（根 tsconfig exclude services/ 不受新包影响）
```

> **test:a2a-server 本地结果注**：187 测试中 185 pass、0 skip，唯二失败为 P1-11 python-interop 两个用例——本机无可用的 Python ≥3.10 解释器（该 spec 为 ZERO-SKIP 契约，缺解释器必须失败并给出补救指引；捆绑 runtime 的 Python 3.12.14 存在但无 `a2a-sdk`，且本环境 pip 无网络出口）。`git diff --stat main -- services/a2a-server` 为空（本改动零触及服务端），该结果与本次变更无关；CI 的 a2a-server gate 安装 Python 3.12 + `a2a-sdk==1.2.3` 后全量执行（PR checks 为准）。

CI 承载：`.github/workflows/p1-a2a-server-gate.yml` 新增 `dsh-a2a-client` job（同 pinned 工具链 24.21.0/10.34.7；两个隔离包各自 frozen install，安装面互不混合；clean-environment 契约同服务端 job——无 DATABASE_URL、无供应商凭据；单元 + 真实链路集成两步）；触发 paths 增加 `services/dsh-a2a-client/**`。

## 6. 提交与 CI

- `feat(a2a): DSH A2A client package — official SDK adapter with durable ledger, §7.4 cancel propagation, §5.3 recovery (Refs #114)`（内容：services/dsh-a2a-client/**、根 package.json script、CI job）
- `feat(a2a): P2-02 implementation record (Refs #114)`（docs/reviews）
- `fix(a2a): integration restart test uses true crash stop (SIGKILL) — graceful stop settles sessions 'service_shutdown' before the scan (Refs #114)`（重启恢复用例的平台语义修正：优雅停机会先以 service_shutdown 结算会话，启动扫描无行可弃；真崩溃语义才能测到 §9 恢复路径——本地 Windows TerminateProcess 恰为崩溃语义，Linux CI 的 SIGTERM 不是，故显式 SIGKILL）

CI（PR checks，HEAD 全绿）：`p1-a2a-server-gate.yml` 两个 job 全过——`A2A validation service`（含 Python 3.12 + `a2a-sdk==1.2.3` 的 python-interop 全量，本地环境缺口由此闭环）与新增 `DSH A2A client gate`（frozen install × 2 → typecheck → 单元 39 → 真实链路集成 5）；其余根回归 job（Root baseline / Release evals / Upgrade-rollback / Web mock E2E / Deployment / Linux smoke）全过。

## 7. 局限（如实）

- **多轮"同 Task 后续 Turn"的服务端缺口**：a2a-server 状态机/仓储支持 input_required 与 `appendTurn`，但当前无线请求路径产生 INPUT_REQUIRED、`appendTurn` 未接入受理门——真实服务器上无法端到端演示"INPUT_REQUIRED → 补充输入 → 同 Task 新 Turn"。客户端契约（结构化句柄 + 指回原任务的多轮字段）已实现并经 mock 线级验证；真实链路以"同 context 会话续接"演示。缺口归属 a2a-server（建议后续 Issue 承接：INPUT_REQUIRED 生产场景 + appendTurn 受理接线），不阻塞其余五组。
- 真实 Worker 内容为合成（P1 口径不变）；真实模型验证归 P1-10/#92。
- 凭据"过期重签"以合成 token 轮换驱动真实 401 线级语义验证；真实凭据分发/到期策略属 P2-P3 运营面。
- `FileTaskLedger` 为单进程单文件模型（原子写、损坏 fail-closed）；多进程并发写同一账本文件未在范围内（工作 DSH 单实例假设，嵌入宿主可注入自有 `TaskLedger` 实现）。
- 集成环境为 loopback + 自签无 TLS 的 HTTP；HTTPS/TLS 终端属部署面（deploy/validation），不在本 Issue。

## 8. PENDING（运营者面，不冒充已实装）

1. **注册进真实工作 DSH 实例**（DSH 工具接线 + composition/profile 配置 + 真实凭据分发）——按 ADR-0018/DSH_UPSTREAM 纪律由运营者/后续 Issue 实施；本 Issue 交付的是可注册的客户端包本体与验证证据。
2. 真实凭据（个人 Profile Bearer）分发流程与到期轮换策略落地（P2-P3）。
3. 服务端 INPUT_REQUIRED/同 Task 多轮接线（§7 缺口归属）。

## 9. AC 覆盖对照（#114 验收条件）

| AC | 状态 | 证据 |
| --- | --- | --- |
| 六组场景全部有隔离环境真实执行证据；取消以 Worker 停止证据结算 | 五组全量真实链路；G1 多轮的 INPUT_REQUIRED 段为 mock 级（服务端缺口 §7），真实链路以同会话续接演示 | §4 表 + `tests/integration/dsh-client-integration.spec.ts` 5/5 |
| 集成测试入库并可重复执行 | `pnpm run test:dsh-a2a-client` 一键可重复；CI job 承载 | §5 |
| 实现记录（commit、版本、命令、结果、局限） | 本文 | §1/§5/§7/§8 |
| 不削弱既有安全语义；既有套件零回退 | a2a-server 服务端零改动；`test:a2a-server`/`test:a2a-compat`/根 typecheck 本地全绿；凭据/账本 fail-closed 契约有负例测试 | §5 |
