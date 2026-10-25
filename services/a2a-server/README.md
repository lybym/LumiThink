# @lumithink/a2a-server — LumiThink A2A 验证服务（P1-01/P1-02/P1-03，issue #83/#84/#85）

独立服务入口：官方 `@a2a-js/sdk@1.3.0` 服务端 + Agent Card + JSON-RPC over HTTPS/SSE + 标准错误映射 + Task-only 业务适配边界。**全部为合成口径**：合成执行器仅验证协议与传输，不代表真实 DSH 执行（真实执行 Gate 归 P1-10/#92）。

P1-02（issue #84）交付 SQLite 统一仓储 + Task Manager 状态机 + 事务 Outbox（`src/task-manager/`）：SDK handler 只接一个权威 store（`SqliteTaskManager`），不再使用 InMemory stand-in；旧 Prisma schema 保持冻结，无 SDK Store 双写。

P1-03（issue #85）交付家庭租户 + Client/Principal 双层认证 + 集中授权（`src/identity/`，ADR-0014）：所有 JSON-RPC 请求先经身份解析（客户端 + 操作主体，一个 Bearer 凭据两级绑定），任务归属在受理时绑定、读取/取消/订阅/续接按归属校验，撤销（凭据/成员关系/短期授权）对缓存、SSE 长流、工具提交与旧上下文即时生效，并记录最小审计。消息内 `userId/householdId/role`、A2A `tenant`/`contextId` 不参与授权（防伪造）。

本包完全隔离于根工作区（自带 `pnpm-workspace.yaml` / `pnpm-lock.yaml`，根依赖面零变更），理由与边界见 [docs/adr/0013](../../docs/adr/0013-a2a-server-isolated-package.md)。

## 运行

```powershell
pnpm --dir services/a2a-server install --frozen-lockfile
$env:LUMITHINK_A2A_VALIDATION_TOKEN = '<>=16 chars synthetic token>'
$env:LUMITHINK_A2A_VALIDATION_PORT = '3312'   # 缺省即 3312（deploy/validation 预留）
$env:LUMITHINK_A2A_VALIDATION_DB   = '<sqlite file path>'  # 缺省 ':memory:'（进程内、无文件写入）
$env:LUMITHINK_A2A_IDENTITY_DB     = '<sqlite file path>'  # 缺省 ':memory:'；身份库（P1-03）
$env:LUMITHINK_A2A_IDENTITY_BOOTSTRAP = '<json>'          # 可选：额外合成客户端/凭据/授权（严格校验）
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
| `src/task-manager/schema.ts` | 版本化 SQLite schema v1：Conversation / Task / Turn(epoch) / Execution(epoch+lease) / Request Ledger / Outbox / Artifacts(+chunks) / Task history；终态不可逆为**数据库触发器**；未知未来版本拒开（fail-closed） |
| `src/task-manager/sqlite-task-manager.ts` | 统一仓储：`BEGIN IMMEDIATE` 单事务受理（账本+Task+Turn+history+Outbox 原子提交）、`(expected_state, state_version)` 条件更新（唯一赢家，失败者 re-read）、执行归属核验（task/turn/epoch/lease）、迟到回调拒绝改终态/追加正文、Outbox 事务内写入+事务外发布+稳定 id 重放；同一类实现 SDK `TaskStore`（save/load/list） |
| `src/task-manager/errors.ts` | 稳定应用错误码（`message_id_conflict` 等，TASK_LIFECYCLE §5.2） |

驱动为 Node 24 内置 `node:sqlite`（零新依赖）；事务体强制同步（Promise 体直接失败——写事务内等待模型/网络在结构上不可发生）；写锁竞争由有界 `busy_timeout` 承担并映射为 `write_lock_busy`。实现记录与证据：[docs/reviews/2026-10-26-p1-02-sqlite-task-manager.md](../../docs/reviews/2026-10-26-p1-02-sqlite-task-manager.md)。

## 身份与授权（P1-03，issue #85）

| 组件 | 内容 |
| --- | --- |
| `src/identity/schema.ts` | 独立身份库版本化 schema v1（households/users/memberships/relationships/clients/credentials(仅摘要)/grants/task_bindings/audit + 全局 `revocation_epoch`）；加性 DDL 单事务迁移；未知未来版本拒开（fail-closed）。**Task Manager schema 不动** |
| `src/identity/identity-store.ts` | 目录播种（严格 bootstrap 校验，fail-closed）、凭据摘要查找、成员关系/监护关系查询、短期授权校验、任务归属绑定（受理时先绑定后落库）、撤销原语（精确 bump epoch）、最小审计 |
| `src/identity/authorizer.ts` | 双层解析（client + principal/visitor/candidate）、epoch 校验决策缓存（撤销即失效，条目寿命不超过凭据/授权到期）、executor 输出准入门（按当前状态复核） |
| `src/identity/authorization-policy.ts` | 集中授权函数：同家庭共享事实按关系+操作决定；候选声纹仅共享设备低敏感允许清单；P1 冻结写操作与原始对话读取为拒绝 |
| `src/identity/express-auth.ts` | `requireTwoTierAuth`（401/403 线级语义）、`requireContextAccess`（会话续接守卫）、SDK user 桥、授权 TaskStore 装饰器（绑定/ACL/list 过滤）、StreamRegistry（撤销关闭长流）、IdentityController 门面 |

线级语义（全部标准错误，不新增 A2A 状态/方法）：未知/撤销/过期凭据 → HTTP 401 + `-32000` AUTHENTICATION_REQUIRED（与 P1-01 形状一致）；客户端有效但主体失效或 grant 被拒 → HTTP 403 + `-32000` PERMISSION_DENIED；跨主体任务访问 → SDK 标准 `-32001` TaskNotFound（真实原因入审计）；他人 contextId 续接 → `-32602` + ErrorInfo `CONTEXT_ACCESS_DENIED`。撤销（凭据/成员关系/授权）对缓存、SSE 长流、工具提交与旧上下文即时生效；审计仅含决策事实，不含令牌与正文。设计依据 [ADR-0014](../../docs/adr/0014-a2a-identity-authorization.md)。

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
| `tests/official-client-roundtrip.spec.ts` | #83 AC1：官方独立客户端发现 Agent Card、阻塞/流式发送（task 首帧、append/lastChunk 只在更新事件）、GetTask 快照恢复、CancelTask |
| `tests/protocol-errors.spec.ts` | #83 AC2：标准错误映射（-32001/-32002/-32004/-32009，冻结 fixtures 08–12 语义）、认证/参数失败不建 Task、Task-only 线形、Skill 声明不作授权依据、单一权威 store 接线 |
| `tests/stream-resilience.spec.ts` | #83 AC3：SSE 断开不默认取消、终态订阅标准错误 + GetTask 恢复、活动任务重订阅 |
| `tests/service-contract.spec.ts` | 配置契约（3312 缺省、loopback 锁、fail-closed token）、Agent Card 单 Agent 契约、A2A-Version 显式校验（R7） |
| `tests/service-entry.spec.ts` | 独立入口子进程启动（banner SYNTHETIC 标注、卡发现、bearer 门、SIGTERM 干净退出） |
| `tests/task-manager-state-machine.spec.ts` | #84 AC1：状态机表逐条对照 TASK_LIFECYCLE §3、终态无出边、SDK 状态映射 fail-closed |
| `tests/task-manager-repository.spec.ts` | #84 AC2/AC3/AC4：迁移 v1 + 未知未来版本拒开；原子受理（5 个失败注入点全回滚）；重复键/指纹冲突语义；状态版本竞争唯一赢家；终态不可逆（表+触发器）；取消×派发竞争；执行归属（epoch/lease）与迟到回调拒绝；Outbox 事务外发布+稳定重放；写锁有界竞争（busy_timeout）；无网络调用 + 异步事务体失败 |
| `tests/task-manager-sdk-bridge.spec.ts` | #84：组合根默认单一权威 store；官方客户端往返全程落库（合法转换链/分片/Outbox 流水）；文件库跨重启恢复（GetTask/list）；陈旧快照不移动权威行；终态后追加正文失败 |
| `tests/identity-store.spec.ts` | #85：身份库迁移 v1 + 未来版本拒开；凭据仅存摘要（明文不落盘）；bootstrap 严格校验负例；撤销精确 bump epoch（无变更不 bump）；任务归属 ACL（跨家庭/跨主体/候选上限/访客续接）；审计无令牌材料 |
| `tests/identity-authorizer.spec.ts` | #85：双层解析与 assurance 分级；epoch 决策缓存撤销即失效；过期/撤销凭据与授权负例（AC4）；grant 客户端绑定/会话绑定/提升不污染缓存；executor 门按当前状态复核 |
| `tests/identity-authorization-policy.spec.ts` | #85：同家庭共享事实按关系+操作决定（监护关系缺省拒绝）；候选声纹/未识别访客私有数据全拒（AC4）；P1 写冻结；grant scope 越界负例；跨家庭目标恒拒 |
| `tests/identity-service-acl.spec.ts` | #85 AC1–AC4 服务级：伪造 metadata/tenant 不改授权；跨家庭与跨主体 Get/Cancel/Subscribe/续接拒绝且不建 Task；ListTasks 过滤；撤销关闭 SSE 长流 + 401/403 即时生效 + 审计；设备仅认证家庭、会话授权提升与撤销/过期负例；executor 门取消结算；默认 bootstrap 保持 P1-01 单 token 契约 |

## 边界（本包不做）

- 不接真实 DSH Runtime / Runtime Bridge / 模型；执行器为 `src/synthetic-executor.ts`（显式 SYNTHETIC 标注）。
- 不做 OpenAI-compatible 入口；不拆 Companion/Learning（单 Agent `lumithink`）。
- 不把请求账本/派发租约接入 handler 受理链（持久幂等受理、首响应丢失恢复归 P1-04/#86）；分片级输出 Outbox 交付契约与重连水位（P1-06/#88）；CancelTask 完整语义族与真实取消证据（P1-07/#89）。
- 身份层不含渠道身份入口本体：飞书事件验证、DSH Profile 凭据分发流程、设备会话确认 UX、声纹识别服务分别归 P3/P2/P4（本 Issue 只冻结共用解析/授权/撤销/审计接口，见 ADR-0014）；授权决策缓存按 epoch 失效，无 TTL 撤销窗口。
- 不切换现有 UDS 链路；不使用真实儿童数据；不发布。

## 锁定面

- `@a2a-js/sdk@1.3.0`、`express@5.1.0`、Node `24.x`、TypeScript `5.9.3`（与 P0-02 矩阵一致；升级必须重跑该矩阵验证）。
- Agent Card `protocolVersion: '1.0'`；`A2A-Version` 头显式校验：缺失按 0.3 拒绝 → `-32009`（fixture 12，R7）。
