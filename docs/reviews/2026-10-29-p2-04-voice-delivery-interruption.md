# P2-04 语音交付与打断语义 实现记录（issue #116；2026-10-29）

> 关联：Epic P2；前置：[P2-03 XiaozhiA2AProvider](2026-10-29-p2-03-xiaozhi-provider.md)（本 Issue 在其 §10.1 集成面之上补齐"交付水位与恢复"层，不重写）、[P2-02 DSH A2A Client](2026-10-29-p2-02-dsh-client-integration.md)（FileTaskLedger 原子写纪律 + 服务端唯一权威边界声明）、[A2A_DESIGN §9.3/§10](../A2A_DESIGN.md)、[TASK_LIFECYCLE §6/§7](../../TASK_LIFECYCLE.md)、既有竞态基线 `tests/domain/voice/race.spec.ts` + `bridge/race.spec.ts`（保持绿，不重写、不削弱）。
>
> **口径与边界**：交付物仍为 `services/xiaozhi-a2a-provider/`（Python 隔离包，stdlib unittest，零 SKIP）。渠道交付水位层只做渠道侧记录；**服务端 SQLite 仍是唯一任务生命周期权威**（对照 P2-02 边界声明，未创建第二套任务生命周期权威）。变更范围：`services/xiaozhi-a2a-provider/**` + 本文；根工作区其余零变更（未触碰 `lib/domain/voice/**`、`services/a2a-server` 语义、根 `package.json`、CI workflow——xiaozhi-a2a-provider job 的 unittest discover 自动覆盖新测试）。全部内容合成、全部凭据合成、仅 loopback；不碰 `lumithink-data`；不切 UDS。

## 1. 基线与交付物

| 项 | 值 |
| --- | --- |
| Issue | [#116](https://github.com/lybym/LumiThink/issues/116) OPEN（`gh issue view` 核验，8 项验收全量读取） |
| 基线 | `main`，本地 HEAD = `origin/main` = `2d5438b59bb0909ed61f8ba0dd49471364402cbb`（fetch → switch → `pull --ff-only` 后双 `git rev-parse` 比对一致） |
| 工作树 | 干净；无既有开放 PR（`gh pr list --state open` 为空） |
| 分支 | `feature/p2-04-voice-delivery`（自 main 切出） |
| 仓库规范 | 无 `AGENTS.md`；遵循 A2A_DESIGN/TASK_LIFECYCLE/ADR-0013/ADR-0014 |
| 新增 | `xiaozhi_a2a_provider/delivery_ledger.py`（渠道交付水位账本，纯 stdlib）；`tests/test_delivery_ledger.py`、`tests/test_delivery_provider.py`、`tests/test_delivery_race.py`（确定性种子竞态）、`tests/test_delivery_full_chain.py`（真实链路） |
| 修改 | `xiaozhi_a2a_provider/provider.py`（交付门控/止播标记/恢复闸门/代际/统计面 + P2-⑤ 收口 + 账本协议异常围栏后备，Step 05）、`output_contract.py`（`IngestResult` 携带片段稳定 ID 元数据，增量字段）、`__init__.py`（导出）、`README.md` |
| 已知约束 #121 | 恢复模式保持 P2-03 的 GetTask 快照重建 + 新订阅（不引入会触发上游守卫的顺序，P1-12 收口前） |

## 2. 交付水位层设计（对照 A2A_DESIGN §10.2/§10.3 与 TASK_LIFECYCLE §6.2）

- **持久化**：`FileDeliveryLedger` 单 JSON 文档（version=1）+ tmp 同目录写 + `os.replace` 原子替换（P2-02 `FileTaskLedger` 纪律的 Python 对应实现）；损坏文件或**版本不匹配**（过旧或过新——打开与完整性闸门同为精确版本匹配，Step 05 对称化）构造期拒绝（fail-closed）。记录内容**内容无关**：稳定 ID、UTF-8 字节区间、SHA-256 摘要、计数、状态——账本 API 无正文参数，落盘文档 ASCII-only（测试断言钉死）。
- **交付点（诚实口径）**：文本离开 `response()` 生成器（真正交给消费方）时经 `_gate_channel_delivery` 记录；队列滞留未消费的文本不计入水位（§10.2：发送帧数不能直接认定"用户听到"）。止播标记前**已入队**（已移交消费方）的片段在消费侧仍被交付并记录——已发入内容不能撤回，由渠道清空自己的队列（§10.3/§6.2，消费侧行为已契约化钉死）。
- **代际隔离（旧轮隔离）**：每会话单调 `generation`；`begin_turn` 提升代际并使旧 turn 记录 `superseded`；旧代际到达的片段被 `STATUS_STALE_GENERATION` 拦截，计数 `stale_generation_fragments`，永不进入新轮水位。turn 记录键为 `generation@taskId`，杜绝跨轮同 task 覆盖。
- **取消止播关联**：`lumi_on_abort` 顺序 = ①本地立即止播标记（`stop_playback`，§10.3 step 1）→ ②账本持久 stop 标记（reason=`device_abort`，deliveryState=`partial_stopped`）→ ③turn worker 经独立短超时客户端发 CancelTask（§7.4，P2-03 既有）。止播/围栏/取消意图三者任一命中即进入迟到过滤分支：片段计数 `filtered_after_stop_fragments` + 账本 `record_filtered`，永不交付。
- **重连恢复闸门（fail-closed）**：`_recover_from_stream_loss` 在快照重建之后、新订阅之前执行 `verify_integrity`（全新读盘，绕过内存缓存；in-memory "tracked" 标志在锁内快照读取）；账本**损坏/丢失/版本异常/不再包含被跟踪 session**（外部剪除或改写历史——消费水位无法对持久副本举证，按 fail-closed 语义拒绝并给专用 reason `session_missing_from_durable_ledger`，Step 05 钉死）→ `ProviderTurnError(delivery_watermark_unreliable)`，**不自动从头补播、不发取消**——显式恢复态，返回"需要人工/上层恢复"信号（TASK_LIFECYCLE §6.2：没有可靠消费水位时停止自动续播）。恢复失败不静默改写损坏的持久账本（人工恢复入口保留，测试钉死）。
- **账本协议异常的围栏后备（Step 05）**：`_gate_channel_delivery` 按 reason 区分账本异常——`same_id_different_delivery`（同稳定 ID 不同区间/摘要、水位回退）升级为 §9.3 围栏（拒绝交付 + `contract_reasons` 留痕 + 本轮 fenced，持久层后备纪律）；`ledger_unwritable` 等磁盘写失败保持降级交付但计数 `watermark_write_failures` 留痕（§10.2 交付不确定）。fenced 轮的结算观察位如实落 `uncertain`（fenced ≠ complete）。
- **播放完成 ≠ Task 完成**：账本将 Task 终态与 `lumithinkResult` 旗标作为**只读观察位**（`taskStateObserved`/`answerCompleteObserved`/`outputSuppressedAfterCancelObserved`）与交付态（`deliveryState`：complete / partial_stopped / uncertain）分离记录；播放失败/止播不改写任务认知，也永不回写任何 Task 权威。
- **无可靠水位的降级路径**：未配置 `delivery_ledger_path` 时使用 `MemoryDeliveryLedger`（进程内一致、无重启故事，构造日志提示）；`verify_integrity` 为 no-op（进程内一致性由锁保证，行为有钉死测试）。`delivery_summary()` 暴露 §10.2 的可选交付摘要面（缺失 = 未知，不阻塞 Agent）。

## 3. 八项验收 × 测试锚点矩阵（#116 验收条件）

| # | 验收项 | 实现落点 | 测试锚点 |
| --- | --- | --- | --- |
| 1 | Artifact 稳定 ID + 片段记录 → 已交付水位（原子写） | `delivery_ledger.FileDeliveryLedger`（tmp+rename 原子写、精确版本校验、损坏 fail-closed；`record_delivery` 按稳定 ID 记录片段与区间） | `test_delivery_ledger`（持久化/ASCII-only/重载保留/损坏拒绝/版本对称拒绝共 30 项）；`test_delivery_provider.test_gate_records_and_counts_delivery`；真实链路 `test_delivery_full_chain.test_reconnect_recovery_restores_watermark_from_persistent_ledger`（跨进程读账本 JSON：恰 2 片段、水位 27 字节、交付态 complete） |
| 2 | SSE 重连恢复：快照重建边界 + 已交付水位去重 + 新订阅续读；无可靠水位不自动补播 | P2-03 恢复序（GetTask→重建→resubscribe）+ 新增 `verify_integrity` 闸门（锁内 tracked 快照 + 全新读盘；剪除 session 的合法文档同样拒绝，Step 05 钉死）→ `delivery_watermark_unreliable` 显式恢复态 | 单测 `test_reconnect_with_healthy_ledger_resubscribes_and_dedups`（不补播/零取消/账本 2 片段）、`test_reconnect_with_damaged_ledger_fails_closed_without_replay`（前缀零补播、不取消、不静默改写损坏文件）；账本 `test_pruned_session_on_disk_fails_closed`（`session_missing_from_durable_ledger`）、`test_valid_disk_document_still_containing_session_passes`；竞态 `reconnect` 族（快照水位 ≥ 交付前缀）；真实链路 `test_reconnect_recovery_restores_watermark_from_persistent_ledger`（真实断流注入 + 真实恢复 + `cancel_intent=0`）与 `test_damaged_ledger_fails_closed_without_replay`（真实损坏注入 → 显式失败，文本恰为已交付前缀） |
| 3 | 取消止播关联：打断 → 本地立即止播 → CancelTask（独立上下文）→ 旧轮片段不再交付；迟到分片被水位/代际过滤 | `lumi_on_abort`：`stop_playback`（先于 CancelTask）+ 账本 stop 标记 + P2-03 独立客户端 CancelTask；`_handle_payload` 迟到过滤分支（fenced/cancel/止播三条件） | 单测 `test_abort_sets_local_stop_marker_and_persists_stop`（止播标记先落地 + 独立客户端 + 账本 stop/部分交付）、`test_late_fragment_after_stop_is_filtered_and_recorded`（白盒驱动迟到片段）、`test_fenced_turn_counts_late_valid_fragments_as_filtered`、`test_already_queued_fragment_still_delivered_after_stop_marker`（消费侧边界契约）；竞态 `interrupt` op + `interrupt×交付` 定名用例；真实链路 `test_device_interrupt_delivery_race_records_partial_watermark`（止播信号/账本 partial_stopped/服务端 `cancel_intent=1`） |
| 4 | 播放完成 ≠ Task 完成：交付水位与 Task 状态分离记录；播放失败/止播不改写任务认知 | 账本只读观察位 + 交付态分离；`_record_settlement_observation` 单点落账（fenced 轮如实落 `uncertain`，Step 05）；水位层无任何写回路径 | 账本 `test_task_observation_is_separate_from_delivery_state`；单测 `test_suppressed_completion_recorded_without_replay`、`test_failed_task_leaves_delivery_uncertain_not_failed_task_rewrite`、`test_ledger_anomaly_fences_turn_but_settlement_stays_honest`（fenced ≠ complete 且结算诚实）；真实链路 reconnect 用例（`taskStateObserved` 与 `deliveryState` 同证） |
| 5 | 旧轮隔离：新轮开始使旧轮交付水位作废，旧内容不进新轮 | `begin_turn` 代际提升 + `superseded` 标记 + `STATUS_STALE_GENERATION` 门 | 账本 `test_begin_turn_bumps_and_supersedes`、`test_old_generation_delivery_is_stale_never_recorded`；单测 `test_gate_blocks_stale_generation_fragments`、`test_each_turn_bumps_the_delivery_generation`；竞态 `stale_blocked` op（60 种子全量过门）+ `重连×新轮` 定名用例 |
| 6 | 取消后部分结果：COMPLETED + `outputSuppressedAfterCancel` 呈现"未完整交付、不补播"（P2-03 既有）+ 水位层与端到端断言 | P2-03 呈现映射不动；水位层补 `partial_stopped` 交付记录与观察位分离 | 单测 `test_suppressed_completion_recorded_without_replay`（呈现 + 账本分离字段 + 仅 1 片段）；账本 `test_full_delivery_state_complete`/`test_uncertain_default_for_unsettled_turn` |
| 7 | 竞态回归：确定性种子竞态用例（打断×交付、断流×取消、重连×新轮），风格对齐 race.spec.ts；零 SKIP | `tests/test_delivery_race.py`：mulberry32 种子 PRNG、逐操作不变量（7 条）、种子重放字节稳定指纹；驱动**真实** FileDeliveryLedger + AnswerStreamAccumulator | `test_60_seeded_delivery_races_all_invariants_hold`（60 种子 × 30 操作，互异历史）、`test_the_same_seed_replays_the_exact_audit_timeline`（种子 1/7/42/60 重放）、3 个定名族用例；连跑 3 遍全绿（本机 2026-10-29）；既有 TS 竞态基线未触碰（`git status` 零变更） |
| 8 | 顺带收口 P2-03 Review P2-⑤：push_end/push_error 队列满静默丢弃 → 计数/留痕 | `_push_critical`：有界重试（2s）→ 计数 `queue_full_drops` + ERROR 级内容无关日志；生成器 worker 退出检测仍为兜底 | `test_push_end_drop_is_counted_and_logged`、`test_push_error_drop_is_counted_and_logged`、`test_push_end_succeeds_when_consumer_drains` |

## 4. 测试与验证（本机，2026-10-29；Step 05 后逐模块实跑重算）

stdlib unittest 两层，**118 测试 0 失败 0 跳过**（P2-03 基线 58 + 新增 60；逐模块数字为 `-m unittest tests.<module>` 实跑输出，非估算）：

1. **契约/单元/竞态层（105）**：`test_output_contract`（19）+ `test_provider_unit`（24）+ `test_delivery_ledger`（30）+ `test_delivery_provider`（22）+ `test_delivery_race`（5，其中 60×30 随机竞态 + 种子重放）+ `test_structure_redline`（5，AST 守卫对新文件同扫——import 白名单/endpoint 黑名单/独立导入，全过）。非网络部分连跑 3 遍全绿（竞态确定性稳定）。
2. **真实链路层（13）**：`test_full_chain`（4）+ `test_identity_negatives`（6，P2-03 原样）+ `test_delivery_full_chain`（3，新增：重连恢复持久水位 / 打断竞态部分交付 / 账本损坏 fail-closed）；真实 a2a-server（Node 子进程 dsh-worker 模式）+ 跨进程 SQLite 证据。

```powershell
# 全套（本机 bundled Python 3.12.14 + P0-02 验证树 + bundled Node 24.x）
$env:PYTHONPATH='C:\CODE\_a2a-compat-verify\pylibs'
$env:LUMITHINK_XIAOZHI_PROVIDER_NODE_BIN='<node.exe>'
python -m unittest discover -s services/xiaozhi-a2a-provider/tests -t services/xiaozhi-a2a-provider -v
#   → Ran 118 tests ... OK（0 skipped）
pnpm run test:a2a-server   # 回归：187 tests，187 pass / 0 fail / 0 skipped（零回退）；根 typecheck exit 0
```

CI 承载：`p1-a2a-server-gate.yml` 的 `xiaozhi-a2a-provider` job 已存在（触发 paths 含 `services/xiaozhi-a2a-provider/**`），unittest discover 自动覆盖 4 个新测试模块——**本 Issue 未改 workflow**。

## 5. 行为矩阵补充（对照 A2A_DESIGN §10.2/§10.3 逐条）

| §10 冻结规则 | 实现落点 |
| --- | --- |
| 生成完成（Task Manager）/渠道交付（Channel Delivery）/实际播放（渠道记录）三态分离 | 账本 `taskStateObserved`（只读）/`deliveryState`/`stopReason` 三字段分离；`delivery_summary()` 为 §10.2 可选摘要面 |
| 发送帧数不能直接认定用户听到；反馈不足记录"交付不确定" | 水位在文本真正离开生成器时记录；队列滞留/消费离开不计数；`uncertain` 交付态 + `watermark_write_failures` 计数 |
| Channel Delivery 独立存储，不成为 Task 状态机依赖 | 独立 JSON 文件（非 SQLite 共库）；无任何写回 Task 权威的代码路径（结构红线扫描同扫新文件） |
| 打断：小智立即止播、清理旧轮队列 → 显式 CancelTask → 拒收旧轮后续 | `stop_playback` 先于 CancelTask；迟到片段三条件过滤 + 账本 `filteredAfterStop`；旧代际 stale 门 |
| SSE 断开 ≠ 取消；无可靠水位停止自动续播走明确恢复 | 恢复序无取消（含恢复失败路径）；`verify_integrity` fail-closed → `delivery_watermark_unreliable` |
| 取消后到达的迟到片段 / 旧代际片段不交付 | `_handle_payload` 过滤分支 + `_gate_channel_delivery` stale 门（双层） |

## 6. 局限（如实）

- **实机项 PENDING**：真实 ESP32 设备打断门限、VAD/回声、止播→TTS 队列清空的设备侧时延，均未实机执行——归 #59 / runbook §12（运营者窗口）。本 Issue 的"打断"为设备协议面信号（abort 钩子），音频面按 Issue 阻断条款以探针级证据呈现。
- 账本为单进程单文件模型（原子写、损坏 fail-closed）；多进程并发写同一账本文件未在范围内（与 P2-02 口径一致）。单文档随轮次累积增长；完整性闸门对"合法但被剪除 session 的磁盘文档"按 **fail-closed 拒绝**钉死（`session_missing_from_durable_ledger`，Step 05）——归档/滚动清理必须整文件迁移或与 Provider 生命周期协同（直接删 session 会触发显式恢复态），运营者面决策。
- 恢复闸门覆盖"重连续读"场景；进程重启后的跨重启任务续读不在本轮范围（Provider 进程重启即无在途 turn；重启后新 turn 以新代际开始，账本代际单调延续）。
- `MemoryDeliveryLedger`（未配置 `delivery_ledger_path`）无跨重启水位：重连门在进程内有效，跨重启恢复依赖显式恢复态语义（不自动补播）。
- 取消未确认（§7.3 超时）时 Provider 不轮询复核终态（P2-03 口径不变）；账本如实记录 `cancel_confirmed=False` 的观察。
- 竞态套件的随机调度为 60 种子 × 30 操作（本机 ~2.5s）；未做 100+ 种子全量矩阵——种子重放 + 定名族用例保证可复现与家族覆盖，扩容为纯参数调整。

## 7. AC 覆盖对照（#116 验收条件 → 状态）

| AC | 状态 | 证据 |
| --- | --- | --- |
| 8 项各有隔离环境真实执行证据（合成设备协议面 + 真实 a2a-server + dsh-worker） | ✅ | §3 矩阵；文本面全部隔离执行；音频面按阻断条款降级为探针级并如实标注（§6 PENDING） |
| 取消后部分结果：终态事件 + GetTask metadata 一致；客户端解释正确；不补播 | ✅ | 单测 suppressed 三断言（呈现/观察位/仅前缀）；P2-03 全链取消证据保持 |
| 重放/重连零重复整段朗读；合法重复词句不被误删 | ✅ | 单测 + 竞态 `repeat_text` op（同文本新 chunkId 照常交付）+ 真实链路重连（texts == [CHUNK_1, CHUNK_2]） |
| 既有 100 次竞态基线 + 新增渠道场景竞态用例全过、零 SKIP | ✅ | TS 基线未触碰（零 diff）；Python 新增 118 项 0 skip（本地 + CI job 承载） |
| 实现记录与证据入库 | ✅ | 本文 |

## 8. PENDING（运营者面，不冒充已实装）

1. 真实 ESP32/小智设备侧打断门限标定与止播时延实测（#59、runbook §12）。
2. "挂进真实小智服务端（WSLc）"接线（P4，P2-03 遗留口径不变）——挂载时**必须**配置 `delivery_ledger_path` 持久文件。
3. 账本归档/滚动策略（生产挂载前决策；须遵循 §6 的剪除 fail-closed 语义）。

## 9. Step 05 修复记录（PR Review id 5694800131，REQUEST_CHANGES @ 6c9559e）

| 项 | 修复 | 证据 |
| --- | --- | --- |
| P1 记录计数失实 | 全文计数按实跑重算：总 118（P2-03 基线 58 + 新增 60）；契约/单元/竞态层 105 = 19（output_contract）+ 24（provider_unit）+ 30（delivery_ledger）+ 22（delivery_provider）+ 5（delivery_race）+ 5（structure_redline）；真实链路层 13 = 4（full_chain）+ 6（identity_negatives）+ 3（delivery_full_chain）。§3 全部锚点名逐一 `grep "def <name>("` 核对存在 | 本文 §3/§4/§7；`python -m unittest tests.<module>` 逐模块实跑输出 |
| P2-① 门控异常按 reason 区分 | `_gate_channel_delivery`：`same_id_different_delivery`（同稳定 ID 不同区间/摘要、水位回退）升级为 §9.3 围栏（拒绝交付 + 留痕 + fenced，持久层后备）；`ledger_unwritable` 等磁盘写失败保持降级交付 + `watermark_write_failures` 计数。fenced 轮结算观察位如实落 `uncertain`（fenced ≠ complete） | `test_gate_fences_on_ledger_protocol_anomaly`（拒绝交付/围栏/零队列）、`test_ledger_anomaly_fences_turn_but_settlement_stays_honest`（终态锚定：fenced 轮零交付、呈现=complete 不变、账本 uncertain）、既有 `test_ledger_write_failure_keeps_delivery_and_counts` 保持（降级路径不回归） |
| P2-② 完整性闸门收口 | ①剪除 session：合法、版本正确的磁盘文档若不再含被跟踪 session → 拒绝（`session_missing_from_durable_ledger`，fail-closed 语义如实钉死并记录于 §2/§6）；②版本严格性对称：`_load` 与闸门同为精确版本匹配（过旧/过新同样拒绝）；③`verify_integrity` 的 in-memory tracked 标志改为锁内快照读（文件本体无锁重读——本进程原子替换保证读者只见旧或新整档） | `test_pruned_session_on_disk_fails_closed`、`test_valid_disk_document_still_containing_session_passes`（正反两面钉死）、`test_older_version_refuses_to_open`；既有 `test_version_downgrade_or_shape_break_fails_closed`、`test_healthy_file_passes` 保持 |
| Test gap 收口（有余力项） | abort 前在途队列片段的消费侧行为契约化：止播标记只过滤"来源侧迟到"片段，已入队（已移交消费方）片段仍被交付并记录——渠道自清队列（§10.3/§6.2）。Memory 账本 no-op 闸门已有钉死测试（`test_memory_ledger_gate_is_process_local_noop`） | `test_already_queued_fragment_still_delivered_after_stop_marker` |

修复后验证（本机 2026-10-29）：全量 `unittest discover` **118 项 OK 0 skipped**；非网络部分连跑 3 遍全绿；`pnpm run test:a2a-server` 187 pass / 0 fail / 0 skipped（零回退）；根 typecheck exit 0。
