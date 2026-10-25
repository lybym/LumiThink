# @lumithink/a2a-server — LumiThink A2A 验证服务（P1-01/P1-02，issue #83/#84）

独立服务入口：官方 `@a2a-js/sdk@1.3.0` 服务端 + Agent Card + JSON-RPC over HTTPS/SSE + 标准错误映射 + Task-only 业务适配边界。**全部为合成口径**：合成执行器仅验证协议与传输，不代表真实 DSH 执行（真实执行 Gate 归 P1-10/#92）。

P1-02（issue #84）交付 SQLite 统一仓储 + Task Manager 状态机 + 事务 Outbox（`src/task-manager/`）：SDK handler 只接一个权威 store（`SqliteTaskManager`），不再使用 InMemory stand-in；旧 Prisma schema 保持冻结，无 SDK Store 双写。

本包完全隔离于根工作区（自带 `pnpm-workspace.yaml` / `pnpm-lock.yaml`，根依赖面零变更），理由与边界见 [docs/adr/0013](../../docs/adr/0013-a2a-server-isolated-package.md)。

## 运行

```powershell
pnpm --dir services/a2a-server install --frozen-lockfile
$env:LUMITHINK_A2A_VALIDATION_TOKEN = '<>=16 chars synthetic token>'
$env:LUMITHINK_A2A_VALIDATION_PORT = '3312'   # 缺省即 3312（deploy/validation 预留）
$env:LUMITHINK_A2A_VALIDATION_DB   = '<sqlite file path>'  # 缺省 ':memory:'（进程内、无文件写入）
pnpm --dir services/a2a-server run start
```

- 只绑定 `127.0.0.1`（硬编码，`src/config.ts`）；无 token 拒绝启动（fail-closed）。
- 缺省 `:memory:` 数据库保持独立启动/CI 无文件写入；持久化验证部署显式设置 DB 文件路径。
- 验证环境归属：[deploy/validation/README.md](../../deploy/validation/README.md)（3311=验证应用，3312=A2A 验证服务）。

## Task Manager（P1-02，issue #84）

| 组件 | 内容 |
| --- | --- |
| `src/task-manager/state-machine.ts` | TASK_LIFECYCLE §3 状态机（8 个标准状态；终态不可逆，无出边）；SDK `TASK_STATE_*` 双向映射（UNSPECIFIED/UNRECOGNIZED fail-closed） |
| `src/task-manager/schema.ts` | 版本化 SQLite schema v1：Conversation / Task / Turn(epoch) / Execution(epoch+lease) / Request Ledger / Outbox / Artifacts(+chunks) / Task history；终态不可逆为**数据库触发器**；未知未来版本拒开（fail-closed） |
| `src/task-manager/sqlite-task-manager.ts` | 统一仓储：`BEGIN IMMEDIATE` 单事务受理（账本+Task+Turn+history+Outbox 原子提交）、`(expected_state, state_version)` 条件更新（唯一赢家，失败者 re-read）、执行归属核验（task/turn/epoch/lease）、迟到回调拒绝改终态/追加正文、Outbox 事务内写入+事务外发布+稳定 id 重放；同一类实现 SDK `TaskStore`（save/load/list） |
| `src/task-manager/errors.ts` | 稳定应用错误码（`message_id_conflict` 等，TASK_LIFECYCLE §5.2） |

驱动为 Node 24 内置 `node:sqlite`（零新依赖）；事务体强制同步（Promise 体直接失败——写事务内等待模型/网络在结构上不可发生）；写锁竞争由有界 `busy_timeout` 承担并映射为 `write_lock_busy`。实现记录与证据：[docs/reviews/2026-10-26-p1-02-sqlite-task-manager.md](../../docs/reviews/2026-10-26-p1-02-sqlite-task-manager.md)。

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

## 边界（本包不做）

- 不接真实 DSH Runtime / Runtime Bridge / 模型；执行器为 `src/synthetic-executor.ts`（显式 SYNTHETIC 标注）。
- 不做 OpenAI-compatible 入口；不拆 Companion/Learning（单 Agent `lumithink`）。
- 不把请求账本/派发租约接入 handler 受理链（持久幂等受理、首响应丢失恢复归 P1-04/#86，本 Issue 只交付仓储 API 与事务语义）；不做双层身份（P1-03/#85）；分片级输出 Outbox 交付契约与重连水位（P1-06/#88）；CancelTask 完整语义族与真实取消证据（P1-07/#89）。
- 不切换现有 UDS 链路；不使用真实儿童数据；不发布。

## 锁定面

- `@a2a-js/sdk@1.3.0`、`express@5.1.0`、Node `24.x`、TypeScript `5.9.3`（与 P0-02 矩阵一致；升级必须重跑该矩阵验证）。
- Agent Card `protocolVersion: '1.0'`；`A2A-Version` 头显式校验：缺失按 0.3 拒绝 → `-32009`（fixture 12，R7）。
