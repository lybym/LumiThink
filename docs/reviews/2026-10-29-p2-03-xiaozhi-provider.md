# P2-03 XiaozhiA2AProvider 接入 实现记录（issue #115；2026-10-29）

> 关联：Epic P2；前置：[P1-11 Python SDK 补验](2026-10-29-p1-11-python-sdk-interop-verification.md)（a2a-sdk==1.2.3 客户端用法权威参考）、[P2-02 DSH A2A Client](2026-10-29-p2-02-dsh-client-integration.md)（隔离包 + CI job 先例）、[ADR-0014](../adr/0014-a2a-identity-authorization.md)（xiaozhi_device grant 面）、[A2A_DESIGN §9.3/§10](../A2A_DESIGN.md)、[TASK_LIFECYCLE §7.4](../../TASK_LIFECYCLE.md)。
>
> **口径与边界**：交付物是 `services/xiaozhi-a2a-provider/`（Python 隔离包，官方 `a2a-sdk==1.2.3`，stdlib unittest，零 SKIP）。全部内容合成、全部凭据合成、仅 loopback；**不切 UDS**（`deploy/xiaozhi/gateway_bridge/` 现有文件零改动，lumithink_llm.py 仅作只读形状参考）；Provider 不含任何直连模型供应商路径（AST 级测试断言守住）。**"挂进真实小智服务端（WSLc）"属运营者面 P4，如实列 PENDING（§8），不冒充已实装。**

## 1. 基线与交付物

| 项 | 值 |
| --- | --- |
| Issue | [#115](https://github.com/lybym/LumiThink/issues/115) OPEN（`gh issue view` 核验，验收条件全量读取） |
| 基线 | `main`，本地 HEAD = `origin/main` = `ea738d06cb7480a673a987b0808fa8c2a6a13d0e`（fetch → switch → `pull --ff-only` 后双 `git rev-parse` 比对一致） |
| 工作树 | 干净；无既有开放 PR（`gh pr list --state open` 为空） |
| 分支 | `feature/p2-03-xiaozhi-provider`（自 main 切出） |
| 仓库规范 | 无 `AGENTS.md`；遵循 A2A_DESIGN/TASK_LIFECYCLE/ADR-0013/ADR-0014 |
| 新增包 | `services/xiaozhi-a2a-provider/`：`requirements.txt`（锁定 `a2a-sdk==1.2.3`）+ `xiaozhi_a2a_provider/`（`output_contract.py` + `provider.py`）+ `tests/`（5 个模块 + harness）+ README |
| 根工作区 | 零依赖变更：根 `package.json` 仅新增 script `test:xiaozhi-a2a-provider`；`.github/workflows/p1-a2a-server-gate.yml` 新增 job + 触发 paths；`docs/reviews/` 新增本文 |
| 版本矩阵 | Python 3.12.14（本机 bundled / CI setup-python 3.12）；`a2a-sdk==1.2.3`（锁定，P0-02 兼容矩阵验证树 PYTHONPATH 注入）；服务端 `@a2a-js/sdk@1.3.0`（不变）；Node 24.21.0 / pnpm 10.34.7（CI pin） |

## 2. 行为矩阵（对照 A2A_DESIGN §10.1 逐条）

| §10.1/§9.3 冻结规则 | 实现落点 | 测试锚点 |
| --- | --- | --- |
| `语音 → ASR → 身份与权限 → A2A 流式任务 → 准入正文 → TTS` | `response(session_id, dialogue, cancel_check)` 同步生成器；只取最后一条用户文本；内部经官方 SDK 客户端调真实服务端 | `test_full_chain.test_voice_turn_completes_through_real_worker`（真实 server + 真实 dsh-worker 子进程，正文两片段逐字回吐） |
| Provider 关联消息、Task、取消意图与渠道身份句柄 | `_TurnController`（thread-safe）：messageId（每轮新 uuid）/taskId/contextId/取消事件/结果快照；`lumi_on_hello` 注册（未注册 fail-closed 拒轮）；会话 contextId 跨轮续接（§9.2：新 messageId + 旧 contextId → 同 context 新 Task） | 单测 `test_context_continuation_*`、`test_unregistered_session_*`；全链身份归属读 identity 库 |
| 只交付新增正文；`taskId+artifactId+chunkId` 去重；不做文本内容去重 | `output_contract.AnswerStreamAccumulator`：同键同内容重发过滤；同键不同内容 = `same_id_different_content` 异常；同文本新 chunkId 照常交付 | 契约单测 19 项；全链 `delivered_fragments=2, duplicate_fragments=0` |
| 字节区间连续性 + SHA-256 | 每个 chunk 校验 `[startByte,endByte)` 接续水位 + UTF-8 SHA-256；违反即 `non_contiguous_range`/`sha256_mismatch`/`bad_output_metadata`（fail-closed 不播放） | 契约单测（gap/rewind/digest/浮点 JSON 数值形态） |
| 替换已公开前缀的事件拒绝并记录 | `published_prefix_replacement`（append=false 覆盖已发布 artifact 或回退区间）→ 契约异常计数 + 内容无关日志 + 本轮播放围栏（fenced），任务继续走到终态以保结算诚实 | 单测 `test_same_id_different_content_fences_playback`、`test_replacement_event_after_snapshot_rebuild_rejected` |
| 打断：小智立即止播 + 显式 `CancelTask`（§7.4 独立清理上下文） | abort 钩子/`cancel_check` → 取消意图（线程安全）→ 独立短超时客户端（§7.3 缺省 2s）发 CancelTask；Task ID 未取得时保持意图、取得即补发（§10.4）；取消未确认 ≠ 意图丢失（记录 `cancel_unconfirmed_timeout`）；取消竞态失败（-32002）→ 以 GetTask 真实终态呈现，不谎报已取消 | 单测 4 项（独立 client 断言/早打断/已终态竞态）；全链 `test_device_interrupt_cancels_real_worker`：任务行 `canceled` + `cancel_intent=1` + 执行行 `settled` + `outcome=canceled` + worker_id 非空（真实协作停止证据） |
| SSE 断开 ≠ 取消；恢复走 GetTask 快照重建 + 新订阅，不自动补播 | 流异常 → 不发取消 → GetTask 快照重建水位（§9.3：快照不作为新增量，不回放）→ 活动任务则**新** SubscribeToTask 续读（#121 安全模式：绝不发新流式 send）；重订阅预算 1 次；断流后经真实 HTTP 验证任务仍 WORKING | 全链 `test_stream_disconnect_recovers_without_cancel_or_replay`（真实断流注入 + 真实恢复协议）；单测恢复族 4 项 |
| 首响应丢失恢复（§5.3） | 首帧未达即断 → 同 messageId 字节级重发 1 次 → 原任务；重发仍败 → 显式失败 | 单测 `test_first_response_loss_recovers_via_identical_resend` |
| 播放完成 ≠ Task 完成；COMPLETED + `outputSuppressedAfterCancel=true` 呈现"执行完成但回答未完整交付" | 终态经 GetTask 读 `lumithinkResult` 旗标确认（§7.2：不凭状态事件推断完整回答）；呈现映射：complete / completed_but_suppressed / canceled / failed；旗标 suppressed 时绝不回放 | 单测 `test_suppressed_completion_presented_without_replay`；全链 `answer_complete=true` 经真实快照旗标 |
| 服务不可达/超时/取消失败模式有明确行为与日志（无正文泄漏） | 枚举 reason：`server_unreachable`（卡发现失败）/`turn_timeout`（不取消、交由服务端截止）/`credential_rejected`（401/403 与 -32000，遍历 SDK 异常链识别）/`recovery_exhausted`；日志只含 id 与 reason；token 不落日志/异常/盘（捕获式断言） | 单测 `test_turn_timeout_never_cancels`、`test_token_never_reaches_logs`；全链 `test_server_unreachable_is_explicit` |
| 设备断连 ≠ 取消 | `lumi_on_device_closed` 只停本地消费记账，绝不发取消 | 单测行为断言（device_closed 路径） |
| 结构红线：零直连模型供应商路径 | AST 全包扫描：import 白名单 = stdlib ∪ {`a2a`,`httpx`,`google`}；URL/密钥常量黑名单；核心模块在屏蔽三方 import 下独立可导入；缺 SDK = 显式 `official_sdk_missing`（附补救指引），绝不静默跳过 | `test_structure_redline` 5 项 |

## 3. 身份面（对照 ADR-0014 / identity-service-acl 语义）

- 设备凭据：`xiaozhi_device` client 绑定家庭 + `client_only` credential（`LUMITHINK_XIAOZHI_DEVICE_TOKEN` env 或显式注入，缺省 fail-closed）；可选 session grant/binding 头（env 成对出现否则拒构造）。
- Provider 消息体**结构上不含任何身份字段**——伪造 `userId/householdId/role/tenant` 从客户端面即不可能；真实服务端负例证明即使线上伪造也被忽略：任务绑定 `client_id=xiaozhi-dev-01`、`principal_user_id=NULL`。
- 负例全走真实服务端（synthetic 运行时）：无凭据 → 构造期拒绝 + 线上 401/-32000；过期凭据 → `credential_rejected`；设备 → 监护人私有任务 Get/Cancel/Subscribe 全 `-32001`（对调用者任务不存在，无存在性泄漏），监护人侧任务不受影响；设备自身轮次完成于家庭 visitor 范围。

## 4. 测试架构与结果（本地，2026-10-29）

两层，stdlib unittest，**56 测试 0 失败 0 跳过（8.8s）**：

1. **契约/单元层（46）**：`test_output_contract`（19，纯 stdlib）+ `test_provider_unit`（22，注入式 fake 客户端，锁定 SDK runtime 形状构造事件）+ `test_structure_redline`（5，AST 守卫 + 独立导入 + 缺 SDK 显式失败）。
2. **真实链路层（10）**：`tests/server_harness.py` 以真实 Node 子进程启动 `services/a2a-server/src/main.ts`（dsh-worker 模式 + 文件 SQLite + xiaozhi_device 三凭据 bootstrap：设备/监护人/过期）；`test_full_chain`（4：完成链/打断取消/断流恢复/不可达）+ `test_identity_negatives`（6）。断言证据跨进程直读 SQLite（`a2a_tasks`/`a2a_executions`/`a2a_identity_task_bindings`，只读连接）。

```powershell
# 全套（本机 bundled Python 3.12.14 + P0-02 验证树 + bundled Node）
$env:PYTHONPATH='C:\CODE\_a2a-compat-verify\pylibs'
$env:LUMITHINK_XIAOZHI_PROVIDER_NODE_BIN='<node.exe>'
python -m unittest discover -s services/xiaozhi-a2a-provider/tests -t services/xiaozhi-a2a-provider -v
#   → Ran 56 tests ... OK（0 skipped）
pnpm run test:a2a-server   # 回归：187 tests，187 pass / 0 fail / 0 skipped（125s；LUMITHINK_A2A_PYTHON+PYTHONPATH 注入后 python-interop 全过）
pnpm run typecheck         # 根工作区 typecheck exit 0
```

CI 承载：`p1-a2a-server-gate.yml` 新增 `xiaozhi-a2a-provider` job（Node/pnpm pin + a2a-server frozen install + setup-python 3.12 + `pip install a2a-sdk==1.2.3` + unittest 全量；clean-environment 契约同前两个 job）；触发 paths 增加 `services/xiaozhi-a2a-provider/**`。

## 5. 部署面兼容性（如实）

- 代码按 **Python ≥3.10 兼容**写法交付（`from __future__ import annotations`、无 match/TaskGroup/asyncio.timeout/Self/StrEnum/tomllib，已 grep 核验；`.py` 内零三方模块级 import，SDK 全 lazy）。
- 本仓库验证环境与 CI 均为 **3.12**；未在真实 3.10 解释器上执行过全套件（本机无 3.10 解释器，不冒充已验证）。`a2a-sdk==1.2.3` 官方声明支持 ≥3.10（P0-02 矩阵口径）；部署面实测归运营者窗口（P4）。

## 6. 局限（如实）

- 真实 Worker 内容为合成（P1 口径不变）；真实模型验证归 P1-10/#92。
- 断流后若任务在恢复窗口内**自行终态**，快照重建按 §9.3"不作为新增量"处理：已交付前缀之外的尾部**不补播**，以 `answer_complete` 旗标如实呈现（单测 `test_terminal_snapshot_after_disconnect_delivers_no_new_text` 钉死）——语音尾部丢失是设计取舍，非缺陷。
- 会话 contextId 续接依赖服务端 context 保留期；context 被清理/被拒时显式报 `context_access_denied`，不静默重建。
- 取消未确认（§7.3 超时）时 Provider 不轮询复核终态（意图 + 服务端执行截止兜底）；运营者面可按 taskId 查询。
- `push_text` 队列上限 64 片段：消费端（小智 TTS 队列）长时间停滞会停止投递并按超时收轮，不阻塞上游。

## 7. AC 覆盖对照（#115 验收条件）

| AC | 状态 | 证据 |
| --- | --- | --- |
| 合成设备链路：语音轮次 → A2A Task 创建 → 真实 Worker 执行 → 准入正文回填 TTS 生成器，全链证据 | ✅ | `test_full_chain.test_voice_turn_completes_through_real_worker`（正文逐字回吐 + 执行行 settled/worker_id/scan + 任务行 completed + 绑定行设备归属） |
| 身份负例：无凭据/过期凭据拒绝；伪造用户字段不提权；设备主体不获得监护人私有数据 | ✅ | `test_identity_negatives` 6 项（真实服务端）+ 构造期 fail-closed 单测 |
| Provider 不含任何直连模型供应商路径（源码级检查 + 测试断言） | ✅ | `test_structure_redline`（AST import 白名单 + endpoint/密钥常量黑名单 + 独立导入证明） |
| 隔离环境运行证据 + 可重复测试入口；实现记录入库 | ✅ | `pnpm run test:xiaozhi-a2a-provider` / unittest discover 一键可重复；CI job 承载；本文 |
| Task/Artifact/chunkId 行为样例；失败模式（不可达/超时/取消）各有明确行为与日志（无正文泄漏） | ✅ | §2 行为矩阵逐条 + 枚举 reason 词汇表 + token 卫生断言 |

## 8. PENDING（运营者面，不冒充已实装）

1. **挂进真实小智服务端（WSLc）**：把 `XiaozhiA2AProvider` 作为 LLM 扩展点 Provider 注册（config 接线：`base_url`/`auth_token_env` + 设备凭据分发），替换/并行于现有 UDS 链路由运营者决策——本 Issue 交付可挂载的 Provider 本体与隔离验证证据，验收前不接生产流量。
2. 部署面 Python 3.10 实测（§5）与 WSLc 内 `a2a-sdk==1.2.3` 依赖安装面。
3. 真实设备凭据分发与 session grant（家庭确认 UX）接线（P2-P3）。
4. 打断门限实机标定（#59）与 TTS 双流重整（#79 D5）——非本 Issue 范围。
