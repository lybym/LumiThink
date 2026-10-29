# XiaozhiA2AProvider（P2-03，issue #115；交付水位与恢复层 P2-04，issue #116）

小智服务端作为 A2A Client 接入 LumiThink A2A Server 的语音 Provider（Python 隔离包，ADR-0013 先例）。
内部使用**官方 `a2a-sdk==1.2.3`** 客户端；对外暴露与既有 UDS 链路
`deploy/xiaozhi/gateway_bridge/lumithink_llm.py` 同型的集成面（hello 注册通知 / 文本生成器 yield /
取消检查回调 / 设备打断钩子），便于 P4/运营者把它作为替代 Provider 挂进小智服务端。

**边界（冻结）**：小智保留设备连接、VAD、ASR、TTS、音频队列与即时止播；LumiThink 负责身份映射、
Task、执行编排、安全门禁与输出契约。本 Provider **不含任何直连模型供应商的代码路径**
（无 ASR/TTS/LLM 厂商 SDK import、无模型 endpoint 常量——由 `tests/test_structure_redline.py` 用
AST 级断言守住）。既有 UDS 链路原样保留，本包为新增并行实现，验收前不接生产流量、不切 UDS。
渠道交付水位（P2-04）只做渠道侧记录，**服务端 SQLite 仍是唯一任务生命周期权威**（对照 P2-02 边界声明）。

## 模块

| 文件 | 职责 |
| --- | --- |
| `xiaozhi_a2a_provider/output_contract.py` | A2A_DESIGN §9.3 输出契约：`taskId+artifactId+chunkId` 去重、UTF-8 字节区间连续性、SHA-256 校验、已公开前缀替换拒绝、快照水位重建。纯 stdlib，可独立导入 |
| `xiaozhi_a2a_provider/provider.py` | `XiaozhiA2AProvider`：同型集成面 + 官方 SDK 客户端 + 取消（独立超时上下文，TASK_LIFECYCLE §7.4）+ 断流恢复（GetTask 快照重建 + 新订阅，#121 安全模式）+ 交付门控/止播标记/恢复闸门（P2-04） |
| `xiaozhi_a2a_provider/delivery_ledger.py` | 渠道交付水位账本（P2-04）：`(taskId, artifactId, chunkId)` 已交付片段 + UTF-8 区间持久化（tmp+rename 原子写，复用 P2-02 FileTaskLedger 纪律）、每会话交付代际（旧轮隔离）、止播标记、只读 Task 观察位、损坏/丢失 fail-closed 恢复闸门。纯 stdlib |

## 行为契约（与 docs/A2A_DESIGN.md §9.3/§10 逐条对应）

- 只交付新增正文：重发同 `chunkId` 过滤；同 ID 不同内容 = 契约异常拒绝（不播放）；不做文本内容去重。
- 取消：设备打断（abort 钩子或 `cancel_check`）→ **本地立即止播标记**（先于 CancelTask）→ 显式
  `CancelTask`（独立客户端 + §7.3 超时）；止播后到达的迟到分片被计数/留痕、不再交付；
  SSE 断开 ≠ 取消；恢复走 GetTask 快照重建 + 新订阅，不自动补播整段。
- **交付水位（P2-04）**：文本离开生成器（真实交付点）时持久化 `(taskId, artifactId, chunkId)` +
  字节区间 + 摘要——账本 API 不接收正文，文件内容 ASCII-only；同一会话新轮开始提升交付代际，
  旧轮片段被代际门拦截（旧内容不进新轮）。
- **恢复闸门（P2-04）**：重连续读前 `verify_integrity` 全新读盘校验；账本损坏/丢失 →
  显式恢复态（`delivery_watermark_unreliable`），不自动从头补播，不发取消，需要人工/上层恢复。
- 播放完成 ≠ Task 完成：`COMPLETED + outputSuppressedAfterCancel=true` 呈现为
  `completed_but_suppressed`（执行完成但回答未完整交付），不补播；账本中 Task 终态只作为
  只读观察位（`taskStateObserved`）与交付态（`deliveryState`）分离记录，播放失败/止播不改写任务认知。
- `delivery_summary(session_id)`：内容无关的渠道交付摘要（§10.2 可选摘要面；缺失 = 未知，不阻塞）。
- 凭据：仅 env / 显式注入（设备客户端凭据，`xiaozhi_device` grant 面），fail-closed；
  token 不落日志、不落盘。
- 部署面：`delivery_ledger_path` 必须指向持久文件才有跨重启水位；缺省使用进程内账本（进程生命周期内诚实，
  无重启故事，构造时打日志提示）。账本在构造期损坏即拒绝启动（`delivery_ledger_unusable`，fail-closed）。

## 运行测试

```bash
pip install -r requirements.txt          # a2a-sdk==1.2.3（锁定）
python -m unittest discover -s tests -t . -v
```

全链隔离验证（真实 a2a-server + dsh-worker 子进程）需要 Node ≥24 与
`services/a2a-server` 依赖安装（见 `tests/server_harness.py`；缺任一前置时测试**显式失败**，
绝不 SKIP）。CI 在 `.github/workflows/p1-a2a-server-gate.yml` 的 `xiaozhi-a2a-provider` job 承载。

## 局限

- 部署面（WSLc，Python 3.10）兼容性以代码层 3.10 兼容写法保障，未在 3.10 解释器实测（登记于实现记录）。
- "挂进真实小智服务端（WSLc）"属运营者面（P4），本包只交付可挂载的 Provider 本体与隔离验证证据。
