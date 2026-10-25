# P1-04 持久幂等受理、首响应丢失恢复与执行派发租约 实现记录（issue #86；2026-10-26）

## 1. 交付物

全部位于隔离包 `services/a2a-server/`（根依赖面零变更，ADR-0013 约束继续有效）：

| 文件 | 内容 |
| --- | --- |
| `src/acceptance/request-key.ts` | 作用域化请求键（JSON 数组编码，成分全部来自服务端认证绑定：agent/家庭/主体/客户端/clientKind channel/messageId）+ 版本化 HMAC 指纹 `fpv1:`（canonical JSON 递归键排序、数组序保留、排除传输模式/JSON-RPC id/令牌/历史长度） |
| `src/acceptance/acceptance-gate.ts` | 受理门中间件：新请求 → 先写归属绑定（预分配 taskId）→ `acceptInput` 原子受理 → 同一 taskId 交给 SDK handler；重复 → ACL 复核 + 原任务快照直答（JSON-RPC result / 单帧 SSE）；同键不同内容 → `-32602` MESSAGE_ID_CONFLICT（不泄漏其他主体）；墓碑 → `-32000` RESULT_PURGED；`write_lock_busy` → 可安全重试错误 |
| `src/acceptance/dispatch-lease-executor.ts` | 派发租约装饰器：配额复查（拒绝 → REJECTED）→ 事务性 `claimExecution`（取消意图先到 → `canceled_pre_dispatch`，无 Worker 启动）→ 当前状态授权复查（拒绝 → CANCELED）→ 内层执行；`cancelTask` 先 `recordCancelIntent` 持久化再补发远端取消 |
| `src/task-manager/schema.ts`（改） | 任务库 schema **v2**：`a2a_request_ledger.tombstoned_at_ms`（加性 ALTER，单事务迁移，v1→v2 重迁移有测试） |
| `src/task-manager/sqlite-task-manager.ts`（改） | `acceptInput` 支持预分配 taskId；`claimExecution` 取消意图检查（`canceled_pre_dispatch`）；租约持有者强制出示（review #101 ⑤）；bridge save 按消息身份派生 Turn/history（review #101 ⑥）+ 追加前输出准入复核（review #101 ①）；`purgeTaskBody`（正文清除 + 账本墓碑，重放/重试不复活正文） |
| `src/task-manager/errors.ts`（改） | 新稳定错误码 `output_admission_closed` |
| `src/config.ts`（改） | `LUMITHINK_A2A_FINGERPRINT_KEY`（合成缺省见常量）、`LUMITHINK_A2A_DISPATCH_LEASE_TTL_MS`（缺省 5 分钟）、保留窗口 `LUMITHINK_A2A_RETENTION_RETRY_HOURS/RESULT_DAYS/TOMBSTONE_DAYS`（24h/7d/30d 初值；墓碑 30 天硬下限，低于拒绝启动） |
| `src/a2a-service.ts`（改） | 接线：受理门中间件（context 守卫后、SDK handler 前）+ 派发租约装饰器（包住内层执行器）；自定义 TaskStore 时两者整体旁路 |
| `src/identity/authorizer.ts`（改） | 移除零引用死代码 `grantScopeOf`（review #102 决策：清理） |
| `tests/acceptance-idempotency.spec.ts`（新 10 测试） | #86 AC1–AC4 服务级证据 |
| `tests/request-key.spec.ts`（新 6 测试） | 键分域/防碰撞、指纹模式无关/键序无关/内容敏感/HMAC |
| `tests/config-retention.spec.ts`（新 4 测试） | 保留窗口初值/覆盖/硬下限/非法值 fail-closed |
| `tests/task-manager-repository.spec.ts`（追加 5 测试） | `canceled_pre_dispatch`、租约持有者、purge/墓碑、窗口化同步、bridge 准入守卫、schema v1→v2 重迁移 |
| `tests/identity-authorizer.spec.ts`（追加 2 测试） | review #102 收口：`task_not_attributable`（pre-v2 NULL 归因行）与 `credential_expired`（过期≠撤销）独立负例直达断言 |
| `docs/adr/0015-a2a-idempotent-acceptance-dispatch-lease.md` | 架构决策记录（受理点选择、键/指纹规范、先绑定后落库、派发租约语义、墓碑原语） |

既有 12 个套件全部保留通过；3 处既有断言随新契约演进（见 §5）。

## 2. 验收条件映射

| Issue 验收条件 | 实现与证据 |
| --- | --- |
| 并发同 messageId 同请求只有一个 Task/有效执行；同键不同内容明确拒绝且不泄漏其他主体 | `acceptance-idempotency.spec` 'AC1'：5 路并发同键发送 → 全部返回同一 taskId、`stats().tasks===1`、单 Turn 单 Execution、状态事件恰好 2 条（一次 claim + 一次完成）；同键不同内容 → `-32602` + ErrorInfo `MESSAGE_ID_CONFLICT`，线级错误不含原任务 id/原内容，无新任务行。键分域与防碰撞：`request-key.spec`（跨客户端/家庭/主体/设备互不碰撞、访客按设备稳定、JSON 编码单射） |
| 首响应丢失后重发原消息取得相同 taskId；取消意图先本地持久化，补发远端取消可测 | 'AC2' 两条：完成态与进行中（cancel-test 停泊）重试均恢复同 taskId，且跨 `SendMessage`/流式模式一致（指纹排除传输模式）；重试不建 Turn、不重复派发（单 Execution）。取消路径：`recordCancelIntent`（意图+Outbox cancelCommand 原子提交）先于内层远端取消；Outbox 恰好一条 cancelCommand；重复 CancelTask 无第二条（already-terminal），真实结算 CANCELED |
| 派发前复查权限/取消/限额；事务提交与 Worker 启动之间故障不盲目重试副作用 | 派发链三道复查：配额门（可注入，拒绝 → REJECTED，0 执行槽——'AC3' 测试钉死）、`claimExecution`（取消意图 → `canceled_pre_dispatch`，仓储级测试）、准入门按绑定归因当前状态复核（拒绝 → CANCELED）。Worker 启动失败：claim 已提交 → 执行记录保留 → SDK 结算 FAILED；重试同键返回同一 FAILED 任务，执行器 invocation 计数不变（不盲目重跑） |
| 24h 重试/7d 结果/至少30d最小墓碑为可配置初值；清理或重放不复活已删正文 | `config-retention.spec`：缺省值精确 24h/7d/30d，环境覆盖解析，墓碑 <30d 拒绝启动（硬下限），非法值 fail-closed。`purgeTaskBody` + 'AC4' 服务级：正文（history/chunks/artifacts/status message/turn 输入）全清除，Outbox 重放载荷无正文文本，墓碑键重试 → RESULT_PURGED 且执行计数不变，重放空快照不复活分片；`tombstoned_at_ms` 为 P1-08 清理编排提供保留基线 |

## 3. 锁定面

- 零新依赖：受理/指纹层使用 Node 24 内置 `node:crypto`（HMAC）；SDK 编解码使用 `@a2a-js/sdk` 公开导出的 `Message`/`Task` fromJSON/toJSON（线形与锁定 SDK 完全一致，不手写序列化）。
- `@a2a-js/sdk@1.3.0`、`express@5.1.0`、TypeScript `5.9.3` 不变。
- 身份库 schema v2 字节不动；任务库 schema v1→v2 纯加性（一个可空列）；旧 Prisma schema 冻结不变。

## 4. 可复现命令与结果（COMPOSITION_LOCAL）

```powershell
pnpm --dir services/a2a-server run typecheck   # tsc --noEmit → 0 errors
pnpm --dir services/a2a-server run test        # node --test --test-isolation=none
```

结果（2026-10-26，Windows 本机，Node 24.x）：**118 tests / 118 pass / 0 fail**（既有 90 + 新增 28：acceptance 10 + request-key 6 + config 4 + repository 5 + identity-authorizer 2 + 演进断言所在套件原样通过），多次运行稳定。CI 承载：`.github/workflows/p1-a2a-server-gate.yml`（paths 过滤，本 PR 命中 `services/a2a-server/**`）。

## 5. 设计取舍（实现层决策，均不改变冻结设计）

1. **受理点在 SDK handler 之前的中间件**，而非 executor 层：SDK 对新消息自行生成 taskId 并直接派发，executor 层无法阻止重复请求产生第二个 Task，也无法为冲突/墓碑产生协议层 JSON-RPC 错误（executor 异常只会结算成 FAILED Task，违反 §5.2“不生成新任务”）。中间件持有具体 `SqliteTaskManager`；自定义 TaskStore 时受理门与派发租约整体旁路（仓储所有权语义不做半套接线）。
2. **先绑定、后落库（预分配 taskId）**：`acceptInput` 扩展接受预分配 id；身份库归属绑定先于任务行写入（P1-03 fail-closed 顺序），崩溃窗口只产生指向不存在任务的孤儿绑定（无害），而非不可读任务 + 永久占用账本键。
3. **重复请求快照直答**而非事件重放：阻塞式重复不等待原执行完成（客户端按 §5.2 以 GetTask/Subscribe 重附着）；Outbox 驱动的优雅续传归 P1-06/#88。流式重复以与 SDK 一致的单帧 SSE 应答（`Task.toJSON` 线形）。
4. **`canceled_pre_dispatch` 独立结果**而非复用 `stale`：调度器需要区分“输掉竞争（静默退出）”与“取消意图先到（由本路径发布 CANCELED）”，混用会双结算或漏结算。
5. **指纹 HMAC 密钥的合成缺省**：密钥经 `LUMITHINK_A2A_FINGERPRINT_KEY` 配置；固定合成缺省保证 CI/独立运行确定性，且指纹只覆盖 id 与合成文本（不是凭据材料）；持久部署必须设置自己的密钥（README/config 注明）。
6. **Step 05 语义演进断言（3 处，PR body 同步说明）**：停泊任务在派发租约领取后为 WORKING（原断言 SUBMITTED）——不变量“非终态、断开不取消”保持；组合根 schema 断言 1→2。3 处均为新契约的直接结果，测试意图原样保留。
7. **review #102 死代码决策**：`Authorizer.grantScopeOf` 零引用 → 移除；P1-05 接入真实 Worker 需要按 grant 区分 scope 时，以真实调用点重新引入（ADR-0014 策略接线规则约束新调用点）。

## 6. 迁移与回滚风险（AC 4 专项）

- 任务库 v1→v2 为单个 `ALTER TABLE ADD COLUMN`（可空、无默认值回填），加性、单事务、`lumithink_a2a_meta.schema_version` 记版本；v1 文件库重开自动迁移且数据保留（测试覆盖：建 v2 → 降列回 v1 → 重开迁移 → 数据保留 → purge 写入时间戳）。
- 应用级降级不支持：回滚 = 恢复升级前的数据库文件备份（deploy/validation 属 P0 Gate 维度 C=GO 的备份/恢复流程），绝不编辑行；未知未来版本依旧拒开（fail-closed）。
- `:memory:` 缺省保持 CI 无文件写入；持久部署显式设置 `LUMITHINK_A2A_VALIDATION_DB`。

## 7. 局限与未关闭风险（全部保留，不计为通过）

1. **受理跨库写**：归属绑定与任务落库分属两个 SQLite 文件（ADR-0014 既有边界）；先绑定后落库使崩溃窗口无害化，但两库非原子——跨重启一致性扫描归 P1-08/#90。
2. **重复阻塞请求不等待原执行**：快照直答 + 客户端重附着（GetTask/Subscribe）；阻塞语义的“按请求模式等待”完整实现归 P1-06 事件交付契约。
3. **重试窗口语义**：24h 重试窗口为可配置初值，服务端不在窗口边界强制拒绝（重试仍返回原任务/错误，幂等性不受影响）；窗口的到期清理作业归 P1-08/#90。
4. **多实例竞争**：单调度权威实例前提不变（TASK_LIFECYCLE §4.2）；`BEGIN IMMEDIATE` + 条件更新已消除进程内竞争，跨实例租约/竞争验证归 P1-05/#87（已声明边界）。
5. **配额门缺省放行**：真实资源限额/背压归 P1-09/#91；挂钩位置（claim 之前，拒绝即 REJECTED 不占槽）已由测试钉死。
6. **合成口径**：全部请求键/指纹/正文为合成验证数据；公开制品不含真实儿童内容（P0 Gate 约束继续有效）。

## 8. 诚实边界声明

- 本记录全部为本地合成验证证据（COMPOSITION_LOCAL），不代表真实执行 Gate（P1-10/#92）、真实 Worker 行为（P1-05/#87）或部署切换；P0 Gate 维度 B/D 收敛前不切换 UDS、不使用真实儿童数据、不发布。
- 幂等受理与派发租约通过不等于真实取消/真实恢复语义已验证（P1-07/#89、P1-08/#90）；协议骨架与仓储事务（#83/#84）通过也不代表本 Issue 的受理链已在真实渠道上验证。
