# ADR-002：自定义 Cordis Runtime Bridge 承载实时语音

> 决策日期：2026-10-13 ｜ 状态：**已采纳为目标架构；实现与正式语音上线待 POC / 安全验收**  
> 补充 [ADR-001：DSH 主 Runtime](./0001-deepseek-harness.md) · [VOICE_RUNTIME](../VOICE_RUNTIME.md) · [ARCHITECTURE](../ARCHITECTURE.md)

## 背景

LumiThink 的 DSH R0 SDK 基线 `dsh-v0.2.0-rc.2` 已验证合成文本多轮/事件/关闭；SDK 当前协议**没有轮次中取消 API**，且已提交的 `assistant/message` 不能替代低时延可播报的实时 Delta。儿童语音需要同时解决：

1. **True Cancellation**：打断后尽可能停止 DSH 内部 Agent Loop，而不总是杀进程。
2. **Live Stream**：实时接收模型生成阶段的瞬态文本增量，经过短句和儿童输出安全门禁后播放。
3. **Turn Fencing**：即使取消执行有竞态，也不能发生旧轮次文本、TTS、音频或记忆的越界写入。

已核对固定上游基线的 [Agent API](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/core/agent/README.md)、[SDK 限制](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/sdk/client/README.md)、[Cordis Cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/docs/cookbook/extension-cookbook.md)：进程内 `agent.cancel()`、`agent.whenIdle()`、`agent/assistant-stream` 在上游存在；官方 SDK 未暴露等价轮次取消，且其结果来自持久化完成事件。**这些是扩展点依据，不是 LumiThink Bridge 已通过的 E2E 证据**。

## 决策

选择 **D. 自定义 Cordis Runtime Bridge** 作为目标语音架构：

- LumiThink **Turn Orchestrator** 拥有 `turn_id`、单调递增 `epoch`、业务允许的提交窗口、状态机和故障恢复。
- DSH **同进程 Cordis Bridge** 独占目标 Voice Session 的 `AgentHandle`，负责 `prompt / cancel / stream / close`，禁止 SDK Server 或旁路通道对同一 Session 并行执行。
- Bridge 经**最小权限 Linux Unix Domain Socket** 连接 Orchestrator，不公开公网 Agent 控制端口；IPC 请求鉴权、版本化与严格 Schema 校验。
- 正常打断默认 `agent.cancel({ kind: 'user' })`（不保留旧 Inbox），等待 `whenIdle()` 再调度同 Session 新输入；取消超时隔离回收 Worker。
- 订阅 `agent/assistant-stream` 做实时表现，同时订阅持久 `session/event` 作为审计/结算依据，**瞬态 Token 不当作已确认的业务事实**。
- 任何下游 Side Effect（记忆、学情、音频发送等）受 `turn_id + epoch` 栅栏保护，原子校验和幂等/补偿。
- 不 Fork DSH Agent Loop；使用受审查的自定义 Cordis Profile/插件，继续坚持 ADR-001 最小权限和版本锁定。

## 备选取舍

| 路线 | 取舍 |
| --- | --- |
| A. TypeScript SDK + 轮次隔离 | 作为短期合成 POC 的逻辑安全过渡；无进程内真正取消，不解决原生实时 Delta |
| B. ACP | 可研究已有停止/状态语义，但不是当前实时 Delta 链路的首选；不能仅凭 ACP 假设达到语音实时性 |
| C. Patch SDK 协议 | 理论可行；同时实现 cancel 和 live stream 需改动线协议与协议端，增加跟踪维护成本 |
| **D. 自定义 Cordis Bridge** | **选择**；复用上游内部能力，无需长期 Fork，但必须证明扩展点、IPC、进程恢复及安全真实可行 |

如果 POC 证明 Cordis Bridge 无法在锁定版本下提供安全可取消/低时延流式输出，暂停真实儿童语音上线，形成新 ADR 复议（包括上游官方新能力、ACP、替代平台）。**不把 DSH 整体选型直接判为失败**。

## 约束 / 后果

1. 必须有独立的生命周期控制面和设备停播链路：打断 = **撤销旧轮次输出权 + 尽可能取消计算 + 阻断业务副作用**。
2. 录音原文、儿童真实档案与第三方凭据不得进入 Bridge 日志、CI、公开测试；新 Profile 必须重复验证关闭默认危险工具、上传/遥测和未知网络外发。
3. 单用户可先以一 Worker/一 Agent 实现；多用户需要 Worker 隔离以避免“回收一个异常 Worker 影响全部 Session”。
4. R0 SDK 合成 POC 保持不变；Bridge 是**单独新代码和 Profile**，不能破坏 R0 的白名单与零 SKIP CI。
5. 阶段 1 实现 Orchestrator/Fencing，阶段 2 证明 Bridge `prompt/cancel/stream/close`，阶段 3 真实 ESP32-S3/小智/DSH 集成；见 [执行合同](../VOICE_RUNTIME.md)。

## 已知风险

- `cancel` 是协作式：对已提交远端工具、副作用和阻塞 IO 不提供时间旅行式回滚。
- `whenIdle` 是 Agent 级停稳，不自动证明所有外部服务已终止；新增 Subagent 必须先增补后代回收和栅栏策略。
- `agent/assistant-stream` 的生命周期和瞬态 chunk 必须在锁定版本核验；输出不得跳过安全短句缓存直接进入 TTS。
- 必须在每个业务写入端原子检查 epoch，简单的“取消后忽略结果”不够。

## 决策复核条件

当 DSH 官方提供等价原生 `session/cancel` + 安全实时 `delta` API，或上游 Cordis 事件语义有破坏性变化，触发对 Bridge 的替换/迁移评估；不得自动升级生产版本。
