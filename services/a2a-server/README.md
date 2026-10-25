# @lumithink/a2a-server — LumiThink A2A 验证服务（P1-01…P1-05，issue #83/#84/#85/#86/#87）

独立服务入口：官方 `@a2a-js/sdk@1.3.0` 服务端 + Agent Card + JSON-RPC over HTTPS/SSE + 标准错误映射 + Task-only 业务适配边界。执行运行时双模式：`synthetic`（缺省，协议/传输验证）与 `dsh-worker`（P1-05：真实 DSH 子进程机制 + 合成供应商内容；真实模型另验，Gate 归 P1-10/#92）。

P1-02（issue #84）交付 SQLite 统一仓储 + Task Manager 状态机 + 事务 Outbox（`src/task-manager/`）：SDK handler 只接一个权威 store（`SqliteTaskManager`），不再使用 InMemory stand-in；旧 Prisma schema 保持冻结，无 SDK Store 双写。

P1-03（issue #85）交付家庭租户 + Client/Principal 双层认证 + 集中授权（`src/identity/`，ADR-0014）：所有 JSON-RPC 请求先经身份解析（客户端 + 操作主体，一个 Bearer 凭据两级绑定），任务归属在受理时绑定、读取/取消/订阅/续接按归属校验，撤销（凭据/成员关系/短期授权）对缓存、SSE 长流、工具提交与旧上下文即时生效，并记录最小审计。消息内 `userId/householdId/role`、A2A `tenant`/`contextId` 不参与授权（防伪造）。

P1-04（issue #86）交付持久幂等受理、首响应丢失恢复与执行派发租约（`src/acceptance/`，ADR-0015）：`SendMessage`/`SendStreamingMessage` 在进入 SDK handler 前经受理门中间件——作用域化请求键（agent+家庭+主体+客户端+channel+messageId，全部来自服务端认证绑定）+ 版本化 HMAC 请求指纹，与 Task/Turn/history/Outbox 在同一 `BEGIN IMMEDIATE` 事务内原子受理；重复原消息直接返回原任务快照（执行器不再运行，不重复推理），同键不同内容返回 `-32602` + `MESSAGE_ID_CONFLICT`（不泄漏其他主体），墓碑键返回 `RESULT_PURGED` 且永不复活正文。派发侧由派发租约装饰器执行：配额复查（拒绝 → REJECTED）→ 事务性 `claimExecution` 领取租约（已持久化取消意图 → `canceled_pre_dispatch`，无 Worker 启动）→ 当前状态授权复查（拒绝 → CANCELED）→ Worker 启动；取消意图先本地持久化再补发远端取消。保留窗口初值 24h 重试 / 7d 结果 / ≥30d 墓碑（可配置，墓碑下限硬性 30 天）。

本包完全隔离于根工作区（自带 `pnpm-workspace.yaml` / `pnpm-lock.yaml`，根依赖面零变更），理由与边界见 [docs/adr/0013](../../docs/adr/0013-a2a-server-isolated-package.md)。

## 运行

```powershell
pnpm --dir services/a2a-server install --frozen-lockfile
$env:LUMITHINK_A2A_VALIDATION_TOKEN = '<>=16 chars synthetic token>'
$env:LUMITHINK_A2A_VALIDATION_PORT = '3312'   # 缺省即 3312（deploy/validation 预留）
$env:LUMITHINK_A2A_VALIDATION_DB   = '<sqlite file path>'  # 缺省 ':memory:'（进程内、无文件写入）
$env:LUMITHINK_A2A_IDENTITY_DB     = '<sqlite file path>'  # 缺省 ':memory:'；身份库（P1-03）
$env:LUMITHINK_A2A_IDENTITY_BOOTSTRAP = '<json>'          # 可选：额外合成客户端/凭据/授权（严格校验）
$env:LUMITHINK_A2A_FINGERPRINT_KEY    = '<hmac key>'      # 可选：请求指纹 HMAC 密钥（P1-04；持久部署应设置自己的密钥，合成缺省见 config.ts）
$env:LUMITHINK_A2A_DISPATCH_LEASE_TTL_MS = '300000'        # 可选：派发租约 TTL（P1-04，缺省 5 分钟）
$env:LUMITHINK_A2A_RETENTION_RETRY_HOURS    = '24'        # 可选：重试窗口（≥1）
$env:LUMITHINK_A2A_RETENTION_RESULT_DAYS    = '7'         # 可选：结果留存天数（≥1）
$env:LUMITHINK_A2A_RETENTION_TOMBSTONE_DAYS = '30'        # 可选：墓碑最少留存天数（硬下限 30，低于拒绝启动）
pnpm --dir services/a2a-server run start
```

- 只绑定 `127.0.0.1`（硬编码，`src/config.ts`）；无 token 拒绝启动（fail-closed）。
- 缺省 `:memory:` 数据库保持独立启动/CI 无文件写入；持久化验证部署显式设置 DB 文件路径（任务库与身份库各自独立文件）。
- 缺省身份目录：`LUMITHINK_A2A_VALIDATION_TOKEN` 被播种为 validation-harness 客户端（`dsh_profile`）的 principal-bound 凭据（合成监护人，家庭 `hh-synthetic-01`）——P1-01 单 token 契约不变，但每次请求都经真实双层解析。bootstrap JSON 结构：`{ households, users, memberships, relationships, clients, credentials, grants }`，字段与校验规则见 `src/identity/identity-store.ts`（重复 token、悬空引用、`xiaozhi_device` 无家庭绑定等一律拒绝启动）。
- 验证环境归属：[deploy/validation/README.md](../../deploy/validation/README.md)（3311=验证应用，3312=A2A 验证服务）。

## Task Manager（P1-02，issue #84）

| 组件 | 内容 |
| --- | --- |
| `src/task-manager/state-machine.ts` | TASK_LIFECYCLE §3 状态机（8 个标准状态；终态不可逆，无出边）；SDK `TASK_STATE_*` 双向映射（UNSPECIFIED/UNRECOGNIZED fail-closed） |
| `src/task-manager/schema.ts` | 版本化 SQLite schema **v2**：Conversation / Task / Turn(epoch) / Execution(epoch+lease) / Request Ledger(含 v2 `tombstoned_at_ms` 墓碑时间戳) / Outbox / Artifacts(+chunks) / Task history；终态不可逆为**数据库触发器**；加性迁移（v1→v2 有重迁移测试）；未知未来版本拒开（fail-closed） |
| `src/task-manager/sqlite-task-manager.ts` | 统一仓储：`BEGIN IMMEDIATE` 单事务受理（账本+Task+Turn+history+Outbox 原子提交；P1-04 起支持预分配 taskId 的先绑定后落库顺序）、`(expected_state, state_version)` 条件更新（唯一赢家，失败者 re-read）、执行归属核验（task/turn/epoch/**lease 持有者必须出示**）、迟到回调拒绝改终态/追加正文、`claimExecution` 事务性派发租约领取（取消意图先到 → `canceled_pre_dispatch`）、`purgeTaskBody` 正文清除+账本墓碑（重放/重试不复活正文）、Outbox 事务内写入+事务外发布+稳定 id 重放；同一类实现 SDK `TaskStore`（save/load/list，bridge 按消息身份去重派生 Turn/history、追加前复核输出准入） |
| `src/task-manager/errors.ts` | 稳定应用错误码（`message_id_conflict` 等，TASK_LIFECYCLE §5.2） |

驱动为 Node 24 内置 `node:sqlite`（零新依赖）；事务体强制同步（Promise 体直接失败——写事务内等待模型/网络在结构上不可发生）；写锁竞争由有界 `busy_timeout` 承担并映射为 `write_lock_busy`。实现记录与证据：[docs/reviews/2026-10-26-p1-02-sqlite-task-manager.md](../../docs/reviews/2026-10-26-p1-02-sqlite-task-manager.md)。

## 身份与授权（P1-03，issue #85）

| 组件 | 内容 |
| --- | --- |
| `src/identity/schema.ts` | 独立身份库版本化 schema **v2**（households/users/memberships/relationships/clients/credentials(仅摘要)/grants/task_bindings(含受理凭据、提升授权、主体层级归因)/audit + 全局 `revocation_epoch`）；加性 DDL 单事务迁移；未知未来版本拒开（fail-closed）。**Task Manager schema 不动** |
| `src/identity/identity-store.ts` | 目录播种（严格 bootstrap 校验，含设备客户端 grant 家庭一致性）、凭据摘要查找、成员关系/监护关系查询、短期授权校验、任务归属绑定（受理时先绑定后落库，记录归因）、撤销原语（精确 bump epoch）、最小审计 |
| `src/identity/authorizer.ts` | 双层解析（client + principal/visitor/candidate）、epoch 校验决策缓存（撤销即失效，条目寿命不超过凭据/授权到期）、executor 输出准入门（按绑定归因全链复核：凭据→客户端→主体→grant→集中策略） |
| `src/identity/authorization-policy.ts` | 集中授权函数（经准入门接入请求路径）：同家庭共享事实按关系+操作决定；候选声纹仅共享设备低敏感允许清单；P1 冻结写操作与原始对话读取为拒绝 |
| `src/identity/express-auth.ts` | `requireTwoTierAuth`（401/403 线级语义）、`requireContextAccess`（会话续接守卫）、SDK user 桥、授权 TaskStore 装饰器（绑定/ACL/list 过滤）、StreamRegistry（撤销关闭长流）、IdentityController 门面 |

线级语义（全部标准错误，不新增 A2A 状态/方法）：未知/撤销/过期凭据 → HTTP 401 + `-32000` AUTHENTICATION_REQUIRED（与 P1-01 形状一致）；客户端有效但主体失效或 grant 被拒 → HTTP 403 + `-32000` PERMISSION_DENIED；跨主体任务访问 → SDK 标准 `-32001` TaskNotFound（真实原因入审计）；他人 contextId 续接 → `-32602` + ErrorInfo `CONTEXT_ACCESS_DENIED`。撤销（凭据/成员关系/授权）对缓存、SSE 长流、**工具提交（准入门按绑定归因复核完整受理链，Step 05 Review P1 修复）**与旧上下文即时生效；审计仅含决策事实，不含令牌与正文。设计依据 [ADR-0014](../../docs/adr/0014-a2a-identity-authorization.md)。

## 持久幂等受理与派发租约（P1-04，issue #86）

| 组件 | 内容 |
| --- | --- |
| `src/acceptance/request-key.ts` | 作用域化请求键（JSON 数组编码，成分全部来自服务端绑定：agent/家庭/主体/客户端/clientKind channel/messageId）+ 版本化 HMAC 指纹 `fpv1:`（canonical JSON 递归键排序；排除 JSON-RPC id/令牌/returnImmediately/historyLength/展示项；HMAC 密钥服务端持久，不留无密钥可枚举摘要） |
| `src/acceptance/acceptance-gate.ts` | 受理门中间件（auth/context 守卫之后、SDK handler 之前）：新请求 → 先写归属绑定（预分配 taskId，P1-03 fail-closed 顺序）→ `acceptInput` 原子受理 → 以同一 taskId 交给 SDK handler 派发（事务提交后才返回/派发，taskId 尽早发布）；重复 → ACL 复核后直接返回原任务快照（SendMessage JSON-RPC result / 流式单帧 SSE），执行器不再运行；同键不同内容 → `-32602` MESSAGE_ID_CONFLICT（线级错误不携带任何其他主体数据）；墓碑 → `-32000` RESULT_PURGED；`write_lock_busy` → 可安全重试的显式错误 |
| `src/acceptance/dispatch-lease-executor.ts` | 派发租约装饰器（包住任意内层执行器）：配额复查（拒绝 → REJECTED，不占执行槽）→ 事务性 `claimExecution`（已持久化取消意图 → `canceled_pre_dispatch`，发布 CANCELED，无 Worker 启动）→ 当前状态授权复查（拒绝 → CANCELED）→ 内层执行；`cancelTask` 先 `recordCancelIntent` 持久化再补发远端取消，重复取消无新副作用；claim 提交与 Worker 启动之间故障保留执行记录，不盲目重试（重启恢复归 P1-05/P1-08） |

自定义 TaskStore 接线时（`startA2aService({ taskStore })`）受理门与派发租约整体旁路——两语义都是仓储所有权语义，不做半套接线。设计依据 [ADR-0015](../../docs/adr/0015-a2a-idempotent-acceptance-dispatch-lease.md)。

## 真实 DSH Worker 运行时与执行租约（P1-05，issue #87）

`LUMITHINK_A2A_RUNTIME_MODE=dsh-worker` 启用真实子进程执行（缺省 `synthetic` 不变）：

| 组件 | 内容 |
| --- | --- |
| `src/runtime/worker-protocol.ts` | Runtime Bridge 行级 JSON 契约 v1（hello/ready/output/heartbeat/result + start/cancel；`internal-executor` 之外的 kind 一律拒注册——外部工作 DSH 是客户端，不是被派发执行器） |
| `src/runtime/dsh-worker-entry.mjs` | 真实子进程入口（注册、心跳、输出、退出码；行为剖面供测试驱动崩溃/启动失败/失联/挂起/迟到输出） |
| `src/runtime/dsh-worker-runtime.ts` | spawn + hello fail-closed 校验 + taskId 会话表 + 四类 watchdog（hello 超时/失联/执行截止/取消宽限）+ kill/退出证据 + `dispose()` |
| `src/runtime/dsh-worker-executor.ts` | 租约键透传执行器：`registerExecutionWorker`（归属落行）→ 输出经 `admitChunk`（归属/租约/准入）→ 终结 `settleExecution`（原始证据与公开结算分离） |
| 仓储新原语 | `settleExecution`（幂等、lease 出示；执行行结算路径 = review #103 P2-2 收口）、`registerExecutionWorker`、`markExecutionStopRequested`；`getTaskDetail` 暴露 body-free 执行诊断 |

配置：`LUMITHINK_A2A_DSH_WORKER_ENTRY`（缺省内置入口）、`LUMITHINK_A2A_DSH_WORKER_TIMEOUT_MS`（缺省 120s）、`..._HELLO_TIMEOUT_MS`（10s）、`..._LOST_CONTACT_MS`（15s）、`..._CANCEL_GRACE_MS`（5s）。`dsh-worker` 模式要求 SQLite Task Manager（自定义 Task Store 拒绝启动，fail-closed）。`state='abandoned'` 保留给 P1-08 恢复扫描。设计依据 [ADR-0016](../../docs/adr/0016-a2a-dsh-worker-runtime-lease.md)。

## 测试

```powershell
pnpm --dir services/a2a-server run typecheck
pnpm --dir services/a2a-server run test
# 或仓库根：pnpm run test:a2a-server（install + typecheck + test）
```

CI 承载：`.github/workflows/p1-a2a-server-gate.yml`（ubuntu，frozen install → typecheck → 协议套件）。

## 套件覆盖（对应 Issue #83/#84 验收条件）

| spec | 覆盖 |
| --- | --- |
| `tests/acceptance-idempotency.spec.ts` | #86 AC1–AC4 服务级：并发同键唯一 Task/执行（5 路竞争）；同键不同内容 MESSAGE_ID_CONFLICT 不泄漏主体；首响应丢失重发原消息恢复同 taskId（完成态 + 进行中态、跨 SendMessage/流式模式）且不重复推理；取消意图先持久化、补发远端取消无新副作用；配额拒绝 REJECTED、Worker 启动失败保留执行记录且重试不重跑；purge 墓碑后重试/重放不复活正文；流式重复单帧快照 |
| `tests/request-key.spec.ts` | #86：请求键按完整认证绑定分域（跨客户端/家庭/主体/设备互不碰撞、访客按设备稳定受限主体）；键编码防分隔符碰撞；指纹跨传输模式稳定（阻塞/立即返回/流式一致）、键序无关、内容变化即冲突、HMAC 密钥敏感 |
| `tests/config-retention.spec.ts` | #86 AC4：24h/7d/30d 缺省初值精确钉死；环境覆盖解析；墓碑 30 天硬下限拒绝启动；非法数值 fail-closed |
| `tests/official-client-roundtrip.spec.ts` | #83 AC1：官方独立客户端发现 Agent Card、阻塞/流式发送（task 首帧、append/lastChunk 只在更新事件）、GetTask 快照恢复、CancelTask |
| `tests/protocol-errors.spec.ts` | #83 AC2：标准错误映射（-32001/-32002/-32004/-32009，冻结 fixtures 08–12 语义）、认证/参数失败不建 Task、Task-only 线形、Skill 声明不作授权依据、单一权威 store 接线 |
| `tests/stream-resilience.spec.ts` | #83 AC3：SSE 断开不默认取消、终态订阅标准错误 + GetTask 恢复、活动任务重订阅 |
| `tests/service-contract.spec.ts` | 配置契约（3312 缺省、loopback 锁、fail-closed token）、Agent Card 单 Agent 契约、A2A-Version 显式校验（R7） |
| `tests/service-entry.spec.ts` | 独立入口子进程启动（banner SYNTHETIC 标注、卡发现、bearer 门、SIGTERM 干净退出） |
| `tests/task-manager-state-machine.spec.ts` | #84 AC1：状态机表逐条对照 TASK_LIFECYCLE §3、终态无出边、SDK 状态映射 fail-closed |
| `tests/task-manager-repository.spec.ts` | #84 AC2/AC3/AC4 + #86：迁移 v1/v2（含 v1→v2 加性重迁移、墓碑时间戳列）+ 未知未来版本拒开；原子受理（5 个失败注入点全回滚）；重复键/指纹冲突语义；状态版本竞争唯一赢家；终态不可逆（表+触发器）；取消×派发竞争（含 P1-04 `canceled_pre_dispatch`）；执行归属（epoch/**lease 持有者必须出示**，review #101 ⑤）与迟到回调拒绝；`purgeTaskBody` 正文清除+墓碑+重放不复活；bridge 按消息身份同步（review #101 ⑥ 窗口化不丢消息）与追加输出准入复核（review #101 ①）；Outbox 事务外发布+稳定重放；写锁有界竞争（busy_timeout）；无网络调用 + 异步事务体失败 |
| `tests/task-manager-sdk-bridge.spec.ts` | #84：组合根默认单一权威 store；官方客户端往返全程落库（合法转换链/分片/Outbox 流水）；文件库跨重启恢复（GetTask/list）；陈旧快照不移动权威行；终态后追加正文失败 |
| `tests/identity-store.spec.ts` | #85：身份库迁移 v1 + 未来版本拒开；凭据仅存摘要（明文不落盘）；bootstrap 严格校验负例；撤销精确 bump epoch（无变更不 bump）；任务归属 ACL（跨家庭/跨主体/候选上限/访客续接）；审计无令牌材料 |
| `tests/identity-authorizer.spec.ts` | #85：双层解析与 assurance 分级；epoch 决策缓存撤销即失效；过期/撤销凭据与授权负例（AC4）；grant 客户端绑定/会话绑定/提升不污染缓存；executor 门按当前状态复核；**review #102 收口：`task_not_attributable`（pre-v2 NULL 归因行）与 `credential_expired`（过期≠撤销）独立负例直达断言** |
| `tests/identity-authorization-policy.spec.ts` | #85：同家庭共享事实按关系+操作决定（监护关系缺省拒绝）；候选声纹/未识别访客私有数据全拒（AC4）；P1 写冻结；grant scope 越界负例；跨家庭目标恒拒 |
| `tests/identity-service-acl.spec.ts` | #85 AC1–AC4 服务级：伪造 metadata/tenant 不改授权；跨家庭与跨主体 Get/Cancel/Subscribe/续接拒绝且不建 Task；ListTasks 过滤；撤销关闭 SSE 长流 + 401/403 即时生效 + 审计；设备仅认证家庭、会话授权提升与撤销/过期负例；executor 门取消结算；默认 bootstrap 保持 P1-01 单 token 契约 |

## 边界（本包不做）

- 不接真实模型/生产 Runtime：`dsh-worker` 模式的进程机制为真（真实子进程、租约、超时与退出证据），供应商内容为合成（真实模型另验，P1-10/#92 Gate）。中断执行的重启恢复扫描、删除台账、清理编排归 P1-08/#90（`state='abandoned'` 是其保留态）。
- 不做 OpenAI-compatible 入口；不拆 Companion/Learning（单 Agent `lumithink`）。
- 幂等受理/派发租约已接入 handler 受理链（P1-04/#86）；仍归后续 Issue：分片级输出 Outbox 交付契约与重连水位（P1-06/#88）、CancelTask 完整语义族与真实取消证据（P1-07/#89）、启动扫描/删除台账/清理编排（P1-08/#90——`purgeTaskBody` 与墓碑时间戳是其仓储原语）、真实资源限额与背压（P1-09/#91——配额门挂钩已预留，缺省放行）。
- 身份层不含渠道身份入口本体：飞书事件验证、DSH Profile 凭据分发流程、设备会话确认 UX、声纹识别服务分别归 P3/P2/P4（本 Issue 只冻结共用解析/授权/撤销/审计接口，见 ADR-0014）；授权决策缓存按 epoch 失效，无 TTL 撤销窗口。
- 不切换现有 UDS 链路；不使用真实儿童数据；不发布。

## 锁定面

- `@a2a-js/sdk@1.3.0`、`express@5.1.0`、Node `24.x`、TypeScript `5.9.3`（与 P0-02 矩阵一致；升级必须重跑该矩阵验证）。
- Agent Card `protocolVersion: '1.0'`；`A2A-Version` 头显式校验：缺失按 0.3 拒绝 → `-32009`（fixture 12，R7）。
