# P1-05 实现记录 — Task Manager 接入真实 DSH Worker 与 Runtime 租约（issue #87）

- 日期: 2026-10-26
- 分支: `feature/p1-05-dsh-worker-runtime-lease`（base: main @ df915fd5c4b91110032e16a7763eb2f6b50fbba0）
- Issue: https://github.com/lybym/LumiThink/issues/87
- ADR: docs/adr/0016-a2a-dsh-worker-runtime-lease.md
- 口径: 全部合成数据；真实子进程机制 + 合成供应商内容（Issue 正文允许）；不切 UDS、不用真实儿童数据、不发布、不宣称真实执行 Gate（P1-10/#92）通过。

## 交付内容

| 组件 | 内容 |
| --- | --- |
| `services/a2a-server/src/runtime/worker-protocol.ts` | Runtime Bridge 行级 JSON 契约（v1）：hello/ready/output/heartbeat/result 事件、start/cancel 控制、`internal-executor`/`external-companion` kind、帧解析与 1 MiB 上限 |
| `src/runtime/dsh-worker-entry.mjs` | 真实子进程入口（Node 直接运行）：注册、心跳、输出、退出码；测试行为剖面（crash/no-hello/silent/heartbeat-forever/stop-on-cancel/flood-after-cancel/external-kind/bad-proto/exit-failed） |
| `src/runtime/dsh-worker-runtime.ts` | 子进程运行时：spawn、hello 校验（协议版本+kind+workerId，fail-closed）、会话表（taskId→session）、四类 watchdog（hello 超时/失联/执行截止/取消宽限）、kill 与退出证据、`dispose()` |
| `src/runtime/dsh-worker-executor.ts` | `executeWithLease`（租约键透传）：hello→`registerExecutionWorker`、ready→WORKING、output→`admitChunk`（归属/租约/准入）→artifactUpdate、result→原始结果、终结→`settleExecution` + 仅当任务非终态才发布公开终态 |
| `src/acceptance/dispatch-lease-executor.ts` | `DispatchLeaseInfo`/`LeaseAwareExecutor` 透传；执行器返回/异常后的**结算兜底**（review #103 P2-2 收口，SYNTHETIC 与真实路径统一）；cancelTask 在意图持久化后 `markExecutionStopRequested` |
| `src/task-manager/sqlite-task-manager.ts` | `settleExecution`（幂等、lease 出示、结果分离）、`registerExecutionWorker`、`markExecutionStopRequested`；`AdmitChunkResult` 附字节区间+摘要；`getTaskDetail` 执行行暴露 `result` 诊断（body-free） |
| `src/config.ts` / `src/a2a-service.ts` / `src/main.ts` | `runtimeMode`（缺省 synthetic；dsh-worker 要求 SQLite 仓储，fail-closed）+ dsh-worker 调优参数；装配/关闭顺序（dispose 先于关库）；入口横幅如实标注运行时 |

## 验收对照

- **AC1 官方请求经真实 DSH 子进程产生准入结果**：`tests/dsh-worker-runtime.spec.ts` AC1 用例——官方 JSON-RPC → 受理门 → 派发租约 → 真实子进程 spawn/hello/心跳/退出 → 两片段经 `admitChunk` 准入 → COMPLETED。worker 为独立 OS 进程（非 fake worker）。
- **AC2 归属/租约/会话映射可核对；崩溃/启动失败/失联各有状态与清理**：注册写回执行行 + lease 落行 + 会话表三方可查；crash→`crashed`（异常退出证据）、startup（no-hello/注册拒绝）→`startup_failed`、失联→`lost_contact`、超时→`timeout`，各清理会话并有测试断言；外部工作 DSH kind 注册被拒（`bad_registration`）。
- **AC3 执行结果与公开 Task 结算分离；迟到结果受 epoch/状态版本约束**：执行行 `result_json` 原始证据 vs 公开状态仅经条件更新纪律；取消后迟到输出被 `output_admission_closed` 拒绝且不发布（AC3 用例）；结算与输出准入的租约语义分离（过期不阻结算、过期拒绝输出）在 ADR-0016 记录。
- **AC4 最小诊断**：`getTaskDetail().turns[].executions[].result` 含 outcome/reason/exitCode/signal/时间戳；测试断言证据不含消息正文/凭据。

## 前序 Issue 移交收口

- **P2-2（review #103）执行行永不结算**：本 PR 交付 `settleExecution` + 派发装饰器兜底结算；live 路径（SYNTHETIC 与 dsh-worker）执行行均以 `state='settled'`+`settled_at_ms` 收口，`tests/dsh-worker-runtime.spec.ts` 与全量套件断言之。`abandoned` 状态保留给 P1-08 恢复扫描（有意不用）。
- **Test gap：live 路径执行行状态无断言**：新 spec 直接断言服务级执行行状态（settled/stop_requested 转移由单元用例覆盖）。
- **Test gap：canceled_pre_dispatch 缺门级验证**：新 spec 经完整服务链（quotaGate 同步持久化取消意图 → claim 拒绝 → CANCELED，无执行行、无 Worker 进程）补齐。

## 边界与未决

- 合成供应商内容：进程机制为真，模型出口未接（P1-10/#92 Gate）；本记录不构成真实执行 Gate 证据。
- 中断执行的重启恢复扫描、删除台账、清理编排 = P1-08/#90；shutdown 用例显式断言"任务保持 working、行已结算"的边界。
- 取消完成竞态族、非协作停止细则 = P1-07/#89；本 PR 只做最小真实停止证据链。
- 持久化 schema **无变化**（v2 复用 result_json/state/settled_at_ms），无迁移。

## 本地验证

```powershell
pnpm --dir services/a2a-server run typecheck   # PASS
pnpm --dir services/a2a-server run test        # 130/130 PASS（含新 spec 12 例）
```

锁定面不变：`@a2a-js/sdk@1.3.0`、express 5.1.0、Node 24、TS 5.9.3。
