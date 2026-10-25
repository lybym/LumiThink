# P1-02 SQLite 统一仓储、Task Manager 状态机与事务 Outbox 实现记录（issue #84；2026-10-26）

> 关联 Epic：[#78](https://github.com/lybym/LumiThink/issues/78)；阶段：P1-02；前置：[P1-01 实现记录](2026-10-26-p1-01-a2a-server-skeleton.md)（#83，main 697d440）。P0 Gate #82 结论：整体 NO-GO + 维度拆分（A/C=GO；B/D=NO-GO）——本任务按冻结仓库基线隔离开发，全部证据为**合成数据 + 127.0.0.1 回环**（`COMPOSITION_LOCAL` 本机实跑；`CI` 由 PR Checks 承担），不含儿童正文、音频、声纹或凭据；不切换现有 UDS；不发布。
>
> 依据：[整体方案 §6/§9](../A2A_DESIGN.md)、[Task 契约 §2–§7](../TASK_LIFECYCLE.md)、[P0/P1 计划 §P1-02](../P0_P1_PLAN.md)、[ADR-0013](../adr/0013-a2a-server-isolated-package.md)。

## 1. 交付物

| 项 | 内容 |
| --- | --- |
| 仓储模块 | `services/a2a-server/src/task-manager/`：`state-machine.ts`（§3 状态机表 + SDK 状态双向映射）、`schema.ts`（版本化 SQLite schema v1 + 迁移 + 终态不可逆触发器）、`sqlite-task-manager.ts`（统一仓储 + SDK `TaskStore` 桥接）、`errors.ts`（稳定应用错误码） |
| 组合根接入 | `src/a2a-service.ts` 默认 store 换为 `SqliteTaskManager`（单一权威写路径，无 InMemory stand-in、无双写）；`src/config.ts` 新增 `LUMITHINK_A2A_VALIDATION_DB`（缺省 `:memory:`）；`src/synthetic-executor.ts` 补 SUBMITTED→WORKING 合法推进；`src/main.ts` 横幅标注 |
| 驱动 | Node 24 内置 `node:sqlite`（`DatabaseSync`）——**零新依赖**，包锁文件不变，根依赖面零变更 |
| 测试 | 服务套件 8 spec / **51 用例**（新增 3 spec / 27 用例：状态机 4、仓储 18、SDK 桥接 5）；根守卫 `tests/server/a2a-server-skeleton.spec.ts` 复跑通过（4/4） |
| 文档 | [services/a2a-server/README.md](../../services/a2a-server/README.md)（Task Manager 章节 + 套件覆盖表）、本文 |

## 2. 验收条件映射

| Issue #84 AC | 证据（spec/用例） |
| --- | --- |
| Task 可关联多个顺序 Turn，Execution 与 epoch/租约可追溯；标准状态和终态不可逆有约束 | schema：`a2a_turns` PK(task,turn_seq)+UNIQUE(task,epoch)、`a2a_executions` UNIQUE(task,epoch)+lease 列；`task-manager-repository.spec.ts`（补充输入 → turn 2/epoch 2；claim 执行登记可追溯）；终态不可逆双层约束：状态机终态无出边（`task-manager-state-machine.spec.ts`）**且** 数据库触发器 `trg_a2a_tasks_terminal_immutable` 拒绝原生 UPDATE（repository spec 用 `DatabaseSync` 直改证伪） |
| 输入受理、任务状态/结果与 Outbox 在对应事务中原子提交；任何失败点无半写 | `acceptInput` 在单个 `BEGIN IMMEDIATE` 内提交 ledger+Task+Turn+history+Outbox；5 个失败注入点（afterLedger/afterTask/afterTurn/afterOutbox/beforeCommit）逐一注入后全表为 0；重复键同指纹返回原任务（零写入）、同键异指纹稳定 `message_id_conflict`（TASK_LIFECYCLE §5.2）；`admitChunk`/`transitionTask`/`recordCancelIntent` 同一事务纪律（artifact+chunk+Outbox 原子） |
| 并发状态版本竞争只允许一个合法提交，迟到回调不能改终态或追加正文 | `(expected_state, state_version)` 条件更新：同版本双写竞争仅一赢家，失败者 outcome `stale` + 新状态 re-read，输家零 Outbox 写入；取消×派发竞争走同一条件更新（取消结算后 claim → stale 且无 execution 行）；迟到回调：终态后 `admitChunk` → `task_terminal` 拒绝且 stats/Outbox 不变、stale epoch/lease → `execution_attribution`、取消关闭准入 → `output_admission_closed`；桥接路径终态后新 body 分片直接失败事务 |
| 数据库迁移/回滚风险有说明；不在数据库写事务内等待模型/网络，验证写锁竞争 | 迁移：版本化 v1（`lumithink_a2a_meta`），未知未来版本 fail-closed 拒开；风险见 §5；无等待：事务体强制同步（Promise 体即失败）+ fetch 守卫测试（拦截 `globalThis.fetch` 全操作成功）；写锁竞争：第二连接持写锁 → `write_lock_busy` 类型化错误、耗时有界（<1.5 s 实测 ≈0.38 s）、释放后同转换提交 |

## 3. 锁定面

| 项 | 值 | 变化 |
| --- | --- | --- |
| A2A SDK / express | `@a2a-js/sdk@1.3.0`、`express@5.1.0`（不变） | 无 |
| SQLite 驱动 | Node 24 内置 `node:sqlite`（`@types/node@24.19.2` 自带类型） | 新增零依赖使用（与根 `lib/server/voice-turn-sqlite-store.ts` 同先例） |
| 数据库 | 服务自有 SQLite 文件/`:memory:`（`LUMITHINK_A2A_VALIDATION_DB`）；旧 Prisma schema 冻结不动 | 新增 |
| schema 版本 | v1（`lumithink_a2a_meta.schema_version=1`）；未知未来版本拒开 | 新增 |

## 4. 可复现命令与结果（COMPOSITION_LOCAL）

| # | 命令（services/a2a-server） | 结果 |
| --- | --- | --- |
| 1 | `pnpm install --frozen-lockfile` | OK（锁文件未变化，零新依赖） |
| 2 | `pnpm run typecheck` | exit 0 |
| 3 | `pnpm test`（8 spec：协议套件 + 3 个新 Task Manager spec） | **51/51 pass / 0 fail / 0 skip（≈1.5 s）** |
| 4 | 仓库根 `node --experimental-strip-types --test-isolation=none --test tests/server/a2a-server-skeleton.spec.ts` | 4/4 pass（锁定面/隔离/合成与 loopback 契约不变） |
| 5 | 全量根套件 / build | 由本 PR CI 承担（仓库 gate workflow 覆盖全量；改动仅落在隔离包与 docs） |

## 5. 设计取舍（实现层决策，均不改变冻结设计）

1. **载体**：仓储落在本隔离包内（`src/task-manager/`），不迁移目录——ADR-0013 的隔离约束继续有效，根 `tsconfig` exclude、根依赖面、根锁文件零变化。
2. **双写禁令的实现**：SDK handler 只接一个 store；`SqliteTaskManager.save/load/list` 与 Task-Manager API（accept/transition/claim/admit/cancel/appendTurn）写同一组表、同一事务原语。handler 快照是投影：陈旧/非法快照不移动权威行（保留现状、不 bump 版本），终态行由触发器兜底。
3. **受理链边界**：请求账本/派发租约的**仓储 API 与事务语义**在本 Issue 交付并测试；把账本/租约接入 handler 受理链（持久幂等受理、首响应丢失恢复）归 P1-04/#86（依赖 P1-03 身份）。`requestKey` 组合规范（agent+household+principal+client+channel+messageId）由 P1-03/P1-04 固化，本仓储按不透明键处理。
4. **Outbox 事件来源**：桥接路径的 Outbox 行由快照 diff 生成（新分片/状态变更入同一事务），分片 id/位置/摘要按内容确定性派生并可稳定重放；分片级 wire 事件 metadata（`lumithinkOutput`）与快照归属的完整交付契约归 P1-06/#88。
5. **Turn 与 history 的映射**：SDK handler 会把带 message 的 statusUpdate 也追加进 `task.history`，故 Turn 仅按 USER 角色消息派生（agent 消息属当前 Turn 输出），history 全量按序持久化。
6. **`:memory:` 缺省**：独立启动/CI 不产生文件写入（p1-a2a-server-gate 的 clean-environment 契约保持）；持久化部署显式设 DB 路径。跨重启持久化以文件库测试证明。
7. **synthetic executor 补 WORKING**：使桥接路径每次持久化状态变更都经过严格状态机（submitted→working→completed 全合法）；cancel-test 场景保持 SUBMITTED→CANCELED（同样合法），不影响 #83 的任何协议断言（roundtrip/errors/SSE 全绿）。

## 6. 迁移与回滚风险（AC 4 专项）

- v1 全部为 `CREATE ... IF NOT EXISTS` + 触发器，单事务应用并记录版本；对同版本重开是 no-op。
- **不支持应用级降级**：低版本代码遇新版本库 fail-closed（`schema_version_not_supported`），已测试；回滚唯一支持路径是恢复升级前的数据库文件备份（deploy/validation 的备份/回滚演练域，P0 Gate 维度 C=GO）。
- v1 无破坏性语句；未来版本必须走"新增表/列 + 迁移测试"的增量路径，禁止原地改语义。
- WAL 模式下 `-wal`/`-shm` 随连接关闭回收；进程崩溃后由 SQLite 自身恢复事务一致性（本设计不依赖进程内状态）。

## 7. 局限与未关闭风险（全部保留，不计为通过）

| 项 | 状态 | 责任 |
| --- | --- | --- |
| 执行器仍为 SYNTHETIC | 协议+持久化骨架证明，不代表真实 DSH 执行 | P1-05/#87（真实 Worker）→ #92 Gate |
| 账本/租约未接 handler 受理链 | 仓储 API 与事务语义已交付；受理链接线与恢复流程 | P1-04/#86 |
| 多实例调度竞争 | 单进程单写者假设（TASK_LIFECYCLE §4.2 首期单权威实例）；条件更新是正确性基础，多实例验证 | P1-04/#86 起逐项验证 |
| 取消语义族（超时结算、隔离代际提升、强制终止） | 本 Issue 仅交付取消意图持久化 + 准入关闭；完整族 | P1-07/#89 |
| 分片级 Outbox 交付契约/重连水位/删除清理 | 结构已备（稳定 id 重放）；交付语义 | P1-06/#88、P1-08/#90 |
| 真实儿童数据 | 永不进入本库（合成口径；P1 Gate 前不切换 UDS） | #92 Gate |

## 8. 诚实边界声明

- 本 PR **不宣称**：真实执行闭环、多实例竞争已验证、生产可部署、P1 Gate 通过。
- 本 PR **不修改**：现有 UDS 链路、根依赖面与根锁文件、`prisma/schema.prisma`、既有 fixtures、#83 的协议行为（51/51 含全部 24 个既有用例回归）。
- 所有持久化内容为合成样例与 id/状态/摘要；Mock / 真实 Worker / 真实模型 / 实机证据分级互不代领。
