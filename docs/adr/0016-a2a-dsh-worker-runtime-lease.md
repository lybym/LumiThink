# ADR-0016: A2A 验证服务的真实 DSH Worker 子进程运行时与执行租约

- 状态: Accepted（P1-05 实现，issue #87）
- 日期: 2026-10-26
- 关联: ADR-0013（隔离包）、ADR-0014（身份与授权）、ADR-0015（幂等受理与派发租约）、docs/A2A_DESIGN.md（Runtime Bridge 契约）、docs/TASK_LIFECYCLE.md（§2 回归归属、§4 调度）

## 背景

P1-04（ADR-0015）交付了事务性派发租约（`claimExecution`）与受理幂等，但执行器仍是进程内 SYNTHETIC：Worker 注册、租约/会话核对、超时与退出证据都没有真实来源；执行行也从未结算（review #103 P2-2）。Issue #87 要求"官方 A2A 请求可经真实 DSH 子进程产生准入结果"，并区分外部工作 DSH 与内部执行进程。

## 决策

1. **真实子进程，合成内容**。验证服务新增 `dsh-worker` 运行模式：内部执行进程用 `node:child_process.spawn` 启动真实 OS 子进程，经 stdin/stdout 行级 JSON 复用 Runtime Bridge 的"控制+事件"契约（docs/A2A_DESIGN.md）；供应商内容为合成（Issue 正文："模型可采用合成供应商验证进程机制，需明确真实模型另验"）。真实模型/真实生产 Runtime 的验证归 P1-10/#92；不切 UDS、不用真实儿童数据、不发布。
2. **内部/外部 DSH 分离 fail-closed**。Worker hello 携带 `kind`；只有 `internal-executor` 可被派发，`external-companion`（外部工作 DSH 是 LumiThink 的客户端）注册即拒绝（`bad_registration`）。
3. **归属三方可核对**。派发租约键（task/turn/epoch/executionId/leaseId）经装饰器透传给运行时；Worker 注册后以自报 id 写回执行行（`registerExecutionWorker`）；运行时会话表按 taskId 建立映射；三者与 `getTaskDetail` 诊断互相印证。
4. **执行行结算路径**（review #103 P2-2 收口）。新增 `settleExecution`：归属（task/turn/epoch+lease 出示）校验后置 `state='settled'`、`settled_at_ms` 与 body-free `result_json`（outcome/reason/exitCode/signal/时间戳）。幂等（先到先结）；租约**过期**不阻止结算（过期只守公开输出准入 `admitChunk`）；`state='abandoned'` 保留给 P1-08 恢复扫描。派发装饰器在执行器返回/异常后兜底结算，SYNTHETIC 与真实路径统一收口。
5. **结果与结算分离（AC 3）**。执行行记录原始执行证据；公开 Task 状态只经条件更新纪律移动。执行器在会话终结时：任务仍非终态才发布对应终态事件；迟到输出被仓储拒绝（归属/租约/输出准入/终态守卫）后围栏运行，不发布任何公开正文。
6. **失败即清理路径**。启动失败（spawn 错误/hello 超时/注册拒绝）、崩溃（异常退出码/信号）、失联（心跳静默）、执行超时、限期强停（取消宽限后 kill）各自产生稳定 reason 与退出证据；会话表清理；服务关闭 `dispose()` 先于关库，无孤儿进程。中断执行的启动恢复扫描归 P1-08/#90。
7. **模式缺省 synthetic**。`LUMITHINK_A2A_RUNTIME_MODE` 缺省 `synthetic`，既有协议套件行为不变；`dsh-worker` 模式要求 SQLite Task Manager（运行时租约是仓储语义），自定义 Task Store 拒绝启动（fail-closed）。

## 后果

- 执行状态机全部状态（registered/running/stop_requested/settled + abandoned 保留）首次有真实写路径与断言；live 路径不再残留永久 registered 行。
- 取消语义仍是最小接线（意图持久化 → stop_requested 标记 → 协作停止/限期强停 + 停止证据）；完成竞态族、非协作停止细则归 P1-07/#89。
- 新增配置面：`LUMITHINK_A2A_RUNTIME_MODE` 与 `LUMITHINK_A2A_DSH_WORKER_*`（entry/timeout/hello/lost-contact/cancel-grace）；全部缺省保持合成与 CI 无文件写入。

## 补记（P1-07/#89 实现时的语义口径）

review #87 r1 P2-③ 要求补记的口径，随 P1-07 实现（2026-10-26）冻结：

- **租约过期围栏与公开结算分离**。`admitChunk` 在租约过期时拒绝后续正文（`lease_invalid`），但这只是**输出准入围栏**，不是任务结算依据；公开 Task 结算只看执行证据：worker 自报结果 / 进程退出证据 / watchdog 判定。因此"租约过期"本身从不直接映射 CANCELED——租约过期的执行仍可由其 holder 合法结算（例如长跑执行完成后结算 completed）。
- **取消宽限到期的语义**：协作窗口（`cancel_grace_ms`，初始 5s）内 worker 未停止时，运行时 SIGKILL 强停并以 `cancel_grace_expired` 记录执行行结算（outcome=canceled + killedByRuntime=true）。因为 SIGKILL 是同步硬终止，强停即"实际停止有确认"，公开任务在** kill 之后**才发布 CANCELED——不会像 TASK_LIFECYCLE §7.2 的 `execution_stop_unconfirmed`（截止时间到仍无法确认停止→FAILED）那样假成功；该 FAILED 分支在当前"强停必有 kill 证据"的运行时设计下不可达，如未来引入无法 kill 的外部执行器再启用。被抑制的完成分支（取消已受理但 worker 真实完成）按 fixture 04 结算 COMPLETED + `outputSuppressedAfterCancel=true`/`answerComplete=false`，见 ADR-0015 移交说明。
