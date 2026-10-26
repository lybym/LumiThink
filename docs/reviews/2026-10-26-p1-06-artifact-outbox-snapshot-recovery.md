# P1-06 实现记录 — 稳定 Artifact、Outbox 重放与快照恢复（issue #88）

- 日期：2026-10-26
- 分支：`feature/p1-06-artifact-outbox-snapshot-recovery`（base: main @ 75c69b91fe6c990b340cbca2b2db5c52881097ec）
- Issue: https://github.com/lybym/LumiThink/issues/88
- 依据文档：docs/A2A_DESIGN.md §9.3（REVIEW2-01）、docs/TASK_LIFECYCLE.md §6/§9、docs/P0_P1_PLAN.md P1-06、ADR-0015（本 PR 收口 §5.2 口径与 fpv1 密钥强制）、ADR-0014
- 口径：全部合成数据（COMPOSITION_LOCAL）；不切现有 UDS、不使用真实儿童数据、不发布；本任务不含渠道生产迁移。

## 交付内容

| 组件 | 内容 |
| --- | --- |
| `src/task-manager/sqlite-task-manager.ts` | ① `admitChunk` 幂等语义补全：同 `chunkId` + 字节相同内容 → `duplicate`（原 seq/区间/摘要不变、无新 Outbox 行）；同 ID 不同内容 → **拒绝**（新原因码 `chunk_content_mismatch`），公开前缀绝不改写。② 新重放原语 `getReplayCutpoint(taskId)`（单 deferred 读事务内返回聚合 Task 快照 + 已提交事件最大 seq——订阅建立的一致性切点，TASK_LIFECYCLE §6.2）与 `readOutboxAfter(taskId, afterSeq)`（游标之后全部有序事件；消费水位由调用方持有）。③ `purgeTaskBody` 追加删除该任务全部 Outbox 行（删除后停止事件交付：既无正文也无任何重放来源）。④ 无 schema 变更（表结构已足够承载本契约；任务库仍为 v2） |
| `src/acceptance/acceptance-gate.ts` | 每个非 created 受理结果（duplicate/conflict/tombstoned/write_lock_busy/其他错误）立即释放本次预绑定（P2-1 孤儿收敛，见下）；文件头契约说明同步更新 |
| `src/identity/identity-store.ts` | 新增 `unbindTask(taskId, reason)`：删除受理前预写的归属绑定并记审计动作 `task_binding_released`（独立事务）。仅用于"未 created"的补偿释放；已受理任务的绑定不受影响 |
| `src/config.ts` | fpv1 指纹密钥强制（review #103 r1 P2-4）：`LUMITHINK_A2A_FINGERPRINT_KEY` 未设置时，配置加载显式 `console.warn` 告警；`LUMITHINK_A2A_RUNTIME_MODE=dsh-worker` 且未设置专属密钥 → **拒绝启动**（公开缺省密钥上的持久化指纹可被字典枚举，违反 TASK_LIFECYCLE §5.4） |
| `docs/adr/0015-…` | §决策第 2/3 条追加收口说明；§边界与后续中"阻塞式重复请求"偏差转为最终口径（快照直答不等待，含测试锚指引） |
| `services/a2a-server/README.md` | 新增 P1-06 契约小节；锁定面/覆盖表/环境变量注释更新 |

## 验收对照（Issue #88）

- **AC1 append/lastChunk 在事件、片段 metadata 在事件、Artifact metadata 仅稳定属性；Outbox 可重放而快照聚合正文**：既有路径已按 REVIEW2-01 落地（`dsh-worker-executor.ts` / `synthetic-executor.ts` 事件携带 `lumithinkOutput{version,chunkId,startByte,endByte,sha256}` 与 `append/lastChunk`，Artifact metadata 仅 `lumithinkContent` 稳定属性；快照 `loadArtifacts` 聚合正文、parts 不含逐片段 metadata）。本 PR 补齐"Outbox 可重放"的原语层：`getReplayCutpoint` + `readOutboxAfter`；测试：`tests/task-manager-repository.spec.ts` "#88 AC 1/AC 3: snapshot/cursor cutpoint joins WITHOUT gap…"。
- **AC2 重复事件保持同 ID；同 ID 不同内容拒绝，合法重复词句保留；替换已公开前缀被拒绝**：同 ID 同内容幂等命中且零副作用；同 ID 异内容拒绝（`chunk_content_mismatch`，运行时执行器照常围栏——`output_rejected_chunk_content_mismatch` 已复用既有拒绝路径）；相同文本不同 chunkId 各自入库、区间无缝（测试断言按内容去重不成立）；bridge 改写已发布分片的快照被忽略（公开前缀不可通过 save 替换）。测试：repository spec 三个新增用例。
- **AC3 快照与增量接合无缺口，SSE 重连不重新执行；终态用 GetTask**：切点读在单事务内完成，并发准入不可能落在快照与游标之间（无缺口、无重复）；首个增量恰好在 `cutpoint+1`（测试断言）；SSE 重连（重复原消息）不触发新执行/新 Turn 为既有受理门语义（#86 用例 + 本 PR 处理中态流式重复用例）；终态客户端直接 GetTask 读聚合快照（`getReplayCutpoint.found` 语义与 ADR 注释明确"标准不保证历史游标"）。
- **AC4 撤权/删除后停止事件交付；没有可靠水位时适配器不得自动从头补播**：撤权 = 既有 StreamRegistry 关长流 + 准入门关闭输出 + `executorGate` 结算 CANCELED（P1-03/#85 用例，本 PR 未改动其语义）；删除 = `purgeTaskBody` 现在**同时删除 Outbox**——删除后 `readOutboxAfter(afterSeq=0)` 为空、切点 seq 归零，仓储层面不存在任何交付/重放来源（测试："#88 AC 4: purgeTaskBody deletes the Outbox…"）。适配器契约：仓储**不提供**从零自动补播原语（`readOutboxAfter` 必须显式给游标；README/注释/实现记录三处声明"无可靠水位禁止自动从头补播"，与设计 §9.3 一致）。

## 前序 Issue 移交收口

- **#103 r1 P2-4（fpv1 缺省固定公钥未强制）**：本 PR 落地 fail-closed/告警策略（见上）；测试：`tests/config-retention.spec.ts` 两个 #88 用例。ADR-0015 决策第 2 条同步标注。
- **#103 r1 ADR-0015 §5.2 记录偏差（阻塞式重复请求改为"快照直答不等待"）**：转为**最终口径**——不实现阻塞等待；一致性切点/Outbox 重放原语随本 PR 落地，客户端按 GetTask/Subscribe 重附着。测试锚：`tests/acceptance-idempotency.spec.ts` "streaming duplicate of a WORKING task answers IMMEDIATELY from the snapshot — it never waits for the original execution"（parked 执行器验证：处理中任务的重试在原执行被阻塞期间即返回 `TASK_STATE_WORKING` 单帧快照，随后原执行正常完成、未被扰动）。ADR-0015 边界条目已就地更新。
- **#86 r1 P2-1（duplicate/conflict/tombstone 受理产生随机 taskId 孤儿绑定）**：本 PR 收敛**按键重试的无界增长**——每个非 created 结果立即释放本次预绑定；测试：`tests/acceptance-idempotency.spec.ts` "#88 / review #103 P2-1: … NO orphan task bindings behind"（5 轮 duplicate+conflict 循环与墓碑重试后，context 下绑定数恒为 1）。**残余**：bindTask 与 acceptInput 之间的崩溃窗口孤儿（无害、指向不存在任务）为 P1-03 有意设计，保留给 P1-08/#90 启动扫描清理；PR body 与 ADR-0015 均已交代去向。

## 设计取舍

- **不做通用 Outbox→SSE 服务端重放端点**：P1 的 SSE 增量由锁定 SDK 的事件总线承担；跨重连的历史重放需要通道侧消费水位与止播协议（Channel Delivery 域，设计 §2/§6.2），不属于本服务仓储边界。本 PR 提供的是切点一致性与游标重放的**权威原语**，"自定义方法替代标准操作"禁令（设计 §9.4）不受影响。
- **purge 删除 Outbox 而非保留"天然无正文"的事件行**：P1-02 曾以"载荷只含 id/位置/摘要"为由保留；#88 AC4 要求"删除后停止事件交付"。删除是更强且更简单的停止语义——不再存在"重放路径绕过访问层"的可能（§10 删除行：输入/正文/Outbox 不可访问）。代价是该任务的事件审计历史随之消失，与"仅剩最小墓碑"口径一致；此变更写入 README 与本记录，P1-08/#90 编排以此为基线。
- **同 ID 异内容返回 rejected 而非静默 duplicate**：静默吸收会把协议异常伪装成成功应答（客户端无从察觉内容分叉）；拒绝与执行器围栏统一走既有 `rejected` 路径，与"同标识不同内容视为协议异常"（设计 §9.3）对齐。
- **撤销（非删除）场景不改 Outbox 保留**：撤权要求阻断交付但保留数据待授权恢复重放（TASK_LIFECYCLE §5.4/§8）；交付阻断由身份层（长流关闭 + ACL 复核）+ 准入门（admission closed）承担，均为既有 P1-03 行为并有服务级负例。

## 验证与证据（可复现命令）

```powershell
pnpm --dir services/a2a-server install --frozen-lockfile
pnpm --dir services/a2a-server run typecheck
pnpm --dir services/a2a-server run test   # 全量套件（node:test，--test-isolation=none）
```

本地结果（Node 24.21.0，Windows checkout）：typecheck 通过；重点 spec 先行验证——config-retention 6/6、task-manager-repository 29/29、acceptance-idempotency 12/12；全量结果与 CI gate 记录于 PR。证据全部为合成数据；Mock（SYNTHETIC executor）/ 真实 DSH Worker（P1-05，未在本 Issue 变更）/ 真实模型（未涉及）分开标注，本 Issue 未触碰运行时进程机制。

## 局限与未关闭风险

- Outbox 重放原语目前只在仓储层 + 测试中消费；把"游标重放"暴露为正式传输契约（例如跨连接续传握手）需要先冻结 Channel Delivery 水位语义（P2 渠道接入时另议）。
- `getReplayCutpoint` 的 deferred 读事务假定本仓储的单连接/同步访问纪律（与全仓一致）；多进程共库场景归 P1-08/P1-09 之前的多实例议题（首期单调度权威实例）。
- 崩溃窗口孤儿绑定的启动清理（P1-08/#90）仍未实现——本 PR 只收敛了按键重试的增长面。
- `subscribeToTask(resubscribe)` 对**活动任务**的行为由锁定 SDK 事件总线决定（stream-resilience 用例维持）；本 PR 未扩展其历史游标能力（标准亦不保证）。