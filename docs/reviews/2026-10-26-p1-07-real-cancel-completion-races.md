# P1-07 实现记录 — 真实取消、完成竞态及取消后不完整答案语义（issue #89）

- 日期：2026-10-26
- 分支：`feature/p1-07-real-cancel-completion-races`（base: main @ c9e6ab1a5b7dc00a3751a0634f058cd85bf3c175）
- Issue: https://github.com/lybym/LumiThink/issues/89
- 依据文档：docs/A2A_DESIGN.md §8.4/§9.3/§10.3、docs/TASK_LIFECYCLE.md §7（取消契约）、docs/P0_P1_PLAN.md P1-07、ADR-0015/0016、锁定 Fixtures 03/04/08/09/11
- 口径：全部合成数据（COMPOSITION_LOCAL）；进程机制为真（P1-05 dsh-worker 真实子进程），供应商内容合成；真实模型归 P1-10/#92。不切现有 UDS、不使用真实儿童数据、不发布。

## 交付内容

| 组件 | 内容 |
| --- | --- |
| `src/runtime/dsh-worker-executor.ts`（改） | **公开结算表（TASK_LIFECYCLE §7.2）补齐完成竞争分支**：① 真实完成但剩余正文被输出准入围栏抑制时（取消已受理、admissionBlockReason=`output_admission_closed`）→ 结算 **COMPLETED**，终态事件携带可读说明"执行已完成，后续输出因取消被抑制。"与事件级 metadata `lumithinkResult{version:1, outputSuppressedAfterCancel:true, answerComplete:false}`（锁定 fixture 04）；此前该分支既不发终态也不留证据（任务悬挂 working）。② 所有真实完成（含无竞争路径）统一携带 fixture 03 契约旗标 `{outputSuppressedAfterCancel:false, answerComplete:true}`——SDK handler 将事件级 metadata 合并进 Task 并经权威仓储 save 落库（GetTask/SSE 与快照一致）。③ canceled/failed/rejected 结算不带旗标（fixtures 只定义于完成分支）。④ 执行行结算 evidence 增加 `killedByRuntime` 标记（实际停止有证据，body-free） |
| `src/runtime/worker-protocol.ts` + `dsh-worker-entry.mjs`（改） | 新增两个测试行为剖面：`complete-after-cancel`（取消控制到达后仍发迟到候选分片 + 自报 completed——完成竞争的 worker 侧事实）与 `never-stops`（忽略取消控制、心跳不断——非协作 Worker，只能被取消宽限 watchdog 强停终止） |
| `src/task-manager/sqlite-task-manager.ts`（改） | ① `claimExecution` 显式 epoch 必须匹配目标 Turn 的 epoch，否则 typed `execution_attribution`（四字段锚在 claim 时点即核验，review #84 r1 P2-②③ 收口；继承（未显式给出）epoch 仍取 Turn 权威值）。② `admitChunk` 防御性 UNIQUE 回退原因码保真（review #105 r1 P2-3）：约束冲突且**无同 chunkId 行**时以新原因码 `chunk_write_conflict` 失败，不再误报 `chunk_content_mismatch`（该码严格保留给"同 ID 不同内容"协议异常）。③ 无 schema 变更（任务库仍 v2）；`ExecutionSettlement` 加可选 `killedByRuntime` 字段（加性，诊断用） |
| `src/runtime/dsh-worker-runtime.ts`（改） | `startExecution` 重复会话防御守卫（review #87 r1 P2-⑤ 收口）：taskId 已有活会话时不再 spawn 第二个进程，直接以 `protocol_violation` finalize（一任务一活动执行在派发簿记侧 fail-closed） |
| `docs/adr/0016-…` | 补记（review #87 r1 P2-③）：租约过期只关输出准入、从不映射公开 CANCELED（长跑执行仍可合法结算 completed）；取消宽限到期 = SIGKILL 强停（同步硬终止即"实际停止有确认"）→ 之后才发布 CANCELED；`execution_stop_unconfirmed`（§7.2 FAILED 分支）在当前强停设计下不可达，引入不可 kill 外部执行器时再启用 |
| `docs/fixtures/a2a-v1.0/13/14 + README` | P1-07 按锁定 SDK 在真实实现上实测归一补充标准 CancelTask 响应 Fixture：`13-cancel-working-success.json`（活动任务取消成功 → CANCELED 快照）与 `14-error-cancel-not-found.json`（未知任务 → -32001）；08（不可取消）/09（已取消幂等成功）形状不变 |
| `services/a2a-server/README.md` + 本记录 | P1-07 契约小节、覆盖表与边界更新 |

## 验收对照（Issue #89）

- **AC1 取消窗口全覆盖、实际停止有证据**：
  - 取消先于派发：#87 已交付门级用例（`canceled_pre_dispatch`，无执行行/无 Worker 启动）；
  - 领取租约中/首响应丢失：条件更新纪律裁决（#86/#87 用例锚定）+ 本 PR 仓储层显式 epoch 锚核验收口；
  - **非协作 Worker**：新增 `never-stops` 门级用例——取消命令不产生任何公开终态；宽限到期后运行时 SIGKILL 强停，执行行以 `outcome=canceled, reason=cancel_grace_expired, killedByRuntime=true` 结算、会话表清理，随后才发布 CANCELED。全部场景的停止证据都是 body-free 进程证据（退出码/信号/killedByRuntime/settled 行）。
- **AC2 仅凭取消命令或 whenIdle 不认定停止；限期未停止不能假成功；终态不可被迟到回调覆盖**：`recordCancelIntent` + stop_requested 围栏均不改公开状态——新用例在强停宽限窗口内轮询断言任务恒为 working 且无任何终态出现；CANCELED 只在强停证据落行之后发布。终态不可逆由 #84（状态机+触发器）与 #87（迟到回调拒绝）既有测试锚定，本 PR 未削弱。
- **AC3 真实完成但正文被抑制 → COMPLETED + 抑制旗标 + 明确部分结果且不补播**：新 `complete-after-cancel` 门级用例——取消受理后 worker 真实完成、迟到分片被准入围栏拒绝（Outbox 无其投递事件、公开快照无其正文）、任务按 §7.2 结算 **COMPLETED**，`Task.metadata.lumithinkResult={version:1,outputSuppressedAfterCancel:true,answerComplete:false}` 与可读状态说明齐备；正常完整完成携带 fixture 03 旗标。SYNTHETIC 协议路径不受影响（roundtrip 既有断言仍成立：旗标是应用契约，非 store 自动生成）。
- **AC4 重复取消/已完成/已取消/已清理的标准返回（锁定官方客户端）**：官方独立客户端门级用例钉死四个面——已取消任务重复取消幂等成功返回 CANCELED 快照且无第二条持久化取消命令（fixture 09）；COMPLETED 任务取消 → 标准 `TASK_NOT_CANCELABLE`（fixture 08，线级 -32002）且终态不被覆盖；未知任务 → `TASK_NOT_FOUND`（fixture 11，线级 -32001）；已清理（purged）任务的请求键保持墓碑（#88 既有重放/重试不复活正文用例继续锚定），任务行保持终态口径（清理编排归 P1-08/#90）。不自创状态或错误码。

## 前序 Issue 移交收口

- **#88 r1 P2-3（admitChunk 防御性 UNIQUE 回退可能对不存在的行误报 chunk_content_mismatch）**：按本 Issue（竞态语义接线）落地原因码保真——回退现在三分：同 ID 同内容=duplicate / 同 ID 异内容=chunk_content_mismatch / 无同 ID 行=新 `chunk_write_conflict`（运行时执行器对一切 rejected 一视同仁围栏）。测试边界：单写者事务纪律下该分支经公共 API 不可构造（spec 内有注释说明），修复以代码审查保证；不制造伪造存储接缝测试。
- **#84 r1 P2-②③（transitionTask 四字段锚可选归属 / claimExecution 不校验显式 epoch 与 turn 对应）**：`claimExecution` 现在在 claim 时点核验显式 epoch 与 Turn 锚一致性（typed `execution_attribution`）；transitionTask 的可选归属保持现状（无归属的纯状态推进仍是合法调用面，带归属时逐项核验语义已有 #87 测试）——取消/完成竞态的所有真实回调路径都携带四字段归属并被核验，豁免理由：纯状态推进路径（SDK bridge 快照收敛）不承载执行归属。测试：repository 用例（错锚抛错/对锚可领）。
- **#87 r1 P2-③（租约过期围栏映射公开 CANCELED 的口径需 ADR-0016 补记）**：已在 ADR-0016 补记（见上交付表）；要点：租约过期≠公开 CANCELED，强停才有 kill 证据链。
- **#87 r1 P2-⑤（startExecution 缺重复会话守卫）**：防御守卫已加（重复 taskId 直接 protocol_violation finalize，不 spawn 第二进程）。
- **#86 关闭评论 test gap（WRITE_LOCK_BUSY 门级映射无直接测试）**：新增门级负例——外部连接持有排它锁超过 busy_timeout → HTTP 200 + `-32000` + ErrorInfo `WRITE_LOCK_BUSY/lumithink.a2a`，释放锁后同消息重试恰好一个任务（受理幂等使重试安全）。

## 设计取舍

- **抑制完成走 COMPLETED 而非 CANCELED**：§7.2 表与"不能谎报已停止推理"要求如实反映执行事实；客户端解释责任由 lumithinkResult 旗标 + 可读状态说明承担（标准客户端可忽略 metadata，LumiThink 渠道适配器必须实现解释——列入互通验收）。
- **元数据经锁定 SDK 的事件 metadata 通道落库**：SDK handler 将 statusUpdate 事件级 metadata 合并进 currentTask 并调用唯一权威 store.save——这仍是"Task Manager 唯一写入公开状态和结果"路径（save 即仓储写路径），无需额外仓储 API 与双重写入；本地以 SDK dist（`applyStatusUpdate` → metadata merge → saveCurrentTask）验证了该合并/持久化链。
- **非协作强停在"kill 之后"才发布 CANCELED**：SIGKILL 给出确定性停止确认，避免 §7.2 `execution_stop_unconfirmed` 的 FAILED 分支被滥用为对强停成功的伪装失败；审计分离原则不变（执行行记录原始证据，公开状态走条件更新纪律）。
- **不新增自定义 A2A 状态/错误码**：CANCELING 类中间状态与自造错误码均不引入；取消受理→实际停止之间公开状态停留在 working（标准可见状态），中间态只在执行行/意图列内部表达。

## 验证与证据（可复现命令）

```powershell
pnpm --dir services/a2a-server install --frozen-lockfile
pnpm --dir services/a2a-server run typecheck
pnpm --dir services/a2a-server run test   # 全量套件（node:test，--test-isolation=none）
```

本地结果（Node 24.21.0，Windows checkout）：typecheck 通过；全量 145/145 通过（含新增 `tests/p1-07-cancel-semantics.spec.ts` 6 个用例：非协作强停、完成竞争抑制、正常完成旗标、标准取消语义族、epoch 锚、写锁忙门级）。CI gate 记录于 PR（paths 过滤命中 `services/a2a-server/**`）。证据全部合成；Mock（SYNTHETIC）/ 真实 DSH Worker 子进程（dsh-worker 模式，供应商内容合成）/ 真实模型（未涉及，P1-10 另验）分开标注。100 次竞态基线与其余既有测试零改动通过。

## 局限与未关闭风险

- 取消响应时序以锁定 SDK 为准（活动任务的 CancelTask 返回语义由 SDK 决定）；对"暂维持原非终态 + cancel_pending 内部标记 + 2s 响应上限"的细粒度控制（TASK_LIFECYCLE §7.3 验证配置）需要 Channel Delivery 客户端协同后复核，当前 SDK 行为已是标准形态。
- 中断执行的重启恢复扫描（含 never-stops 场景在服务重启后的残留清理）归 P1-08/#90（`state='abandoned'` 保留态）；本 Issue 只覆盖进程存续期内的取消生命周期。
- 已清理任务（purge 后）的 GetTask/CancelTask 编排细节（墓碑键回包格式）归 P1-08/#90 清理编排；本 PR 锚定"墓碑不可复活"的既有语义未被取消路径削弱。
- DSH 插件 Abort 传播（客户端侧）按 Issue 正文归 P2 单独验收；本 Issue 只承诺服务端真实取消证据链。