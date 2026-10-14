# LumiThink × DSH：语音打断与 Agent 生命周期管理（R1-V 设计合同）

> 版本：0.1-draft ｜ 2026-10-13 ｜ **目标设计，非当前已实现/验收能力**  
> [ADR-002](./adr/0002-voice-runtime-bridge.md) · [系统架构](./ARCHITECTURE.md) · [硬件](./VOICE_HARDWARE.md) · [Roadmap](./ROADMAP.md)

## 1. 判定与事实基线

锁定的 `dsh-v0.2.0-rc.2`：

| 功能 | DSH 进程内部 | 官方 TypeScript SDK 对外 |
| --- | --- | --- |
| 中断当前执行 | `agent.cancel({kind:'user'})` | **无轮次中取消 wire method** |
| 是否保留旧排队输入 | 默认清空；`cancel(cause,{keepInbox:true})` 可保留 | 无对应开关 |
| 等待 Agent 停稳 | `agent.whenIdle()` | `run()` 等到下一次 idle，非独立取消等待 |
| 关闭 Agent | `AgentHandle.dispose()` | `client.close()` 回收整运行时 |
| 实时文本增量 | `agent/assistant-stream` 中瞬态 `chunk`/`text-delta` | SDK 主要返回持久 `assistant/message` 与 `finalResponse`；不视为实时 Token 合同 |

依据：固定 Tag 的 [Agent README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/core/agent/README.md) / [SDK README](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/sdk/client/README.md) / [Cordis Cookbook](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/docs/cookbook/extension-cookbook.md)。流事件来自**一次 Agent attempt**，不是已持久化消息；必须明确完成/中断语义、重复与重试边界。

DSH 内部具备取消，但普通 SDK 尚未暴露；**不需要因此放弃 DSH**。也不能把“模型生成后从日志拆成 SSE 片段”冒充实时降低首包时延。

## 2. 目标架构

```text
ESP32-S3 + XVF3800 (小智适配固件)
  └── WebSocket/Opus ─→ xiaozhi-esp32-server
                            ├── VAD/ASR/TTS/停止播放/client_abort
                            └── Voice Adapter (标识映射/鉴权)
                                 └── Turn Orchestrator
                                      ├── epoch fencing
                                      ├── turn scheduler + state
                                      ├── output safety/sentence buffer
                                      ├── TTS / audio send guards
                                      └── Unix Domain Socket (private)
                                           └── lumi-dsh-runtime-bridge (Cordis 同进程)
                                                ├── AgentHandle (唯一所有者)
                                                ├── followup / cancel / whenIdle / dispose
                                                ├── agent/assistant-stream (live)
                                                └── session/event (durable)
                                                     └── DSH Agent Loop + approved Tools
                                                           └── Lumi Domain (Memory/Evidence/Safety/Audit)
```

R0 的 `poc/dsh-child` + TypeScript SDK 继续保留为独立**合成环境**；正式语音 Session **只能**由 Bridge 负责创建/恢复/释放。不要使用 SDK Server 创建 Agent 再由 Bridge 侧信道取消：这会使同一个 Session 出现两个生命周期所有者及事件归属竞态。

## 3. IPC 合同草案（待实现及 Schema 测试）

首选同主机 Unix Domain Socket；仅 Orchestrator↔Bridge 可以访问，限制 Socket 文件权限/用户与容器挂载，跨进程输入做鉴权、长度和频率限制，不转发未经信任的设备 `child_id`。通信格式可选择 length-prefixed JSON 帧或可验证的本地流；**不把以下草案当成现有 DSH RPC 方法**。

| 命令 | 示例字段 | 行为 |
| --- | --- | --- |
| `session.open` | `session_key, actor_id, conversation_id` | Bridge 创建/恢复一个自有 AgentHandle，检查租约与唯一所有者 |
| `turn.prompt` | `session_key, turn_id, epoch, text, idempotency_key` | Orchestrator 确认当前代且空闲时再入队，回 `accepted` |
| `turn.cancel` | `session_key, turn_id, epoch, reason` | 首先在 Orchestrator 失效旧 epoch；Bridge 调 `cancel` 并等 `whenIdle` |
| `turn.stream` | `session_key, turn_id, epoch` | 实时 Delta、状态及结算事件；支持背压和过滤 |
| `session.close` | `session_key, reason` | 停止调度、`dispose` 并等资源回收；保持调用幂等 |

推荐事件：`turn.accepted`、`assistant.delta`（`attempt_id/step_id/index`）、`turn.settled`、`turn.cancelled`、`session.idle`、`session.closed`、`runtime.error`。所有事件带 `trace_id`、`conversation_id`、`turn_id`、`epoch`；乱序和重复必须可检测。流 `end` 不等于内容安全审核通过，也不等于远程副作用已撤销。不要将 SDK 的 `messageId`/`turn/end` 简单假定为一一对应的用户提示词响应：上游明确不保证此因果关系。

## 4. Turn Orchestrator 状态机与顺序

状态：`CREATED → QUEUED → RUNNING → COMPLETED`；`QUEUED/RUNNING → CANCELLING → CANCELLED`；任意非终态可进入 `FAILED/TIMED_OUT`（超时也必须阻断输出并回收）。`COMPLETED/CANCELLED/FAILED/TIMED_OUT` 为终态，不能恢复运行；后续输入创建**新的** `turn_id`。

每个会话的单调 `epoch` 由可信 Orchestrator 持久或原子维护；客户端只能触发行为不能指定下一代数。`device_id`、`child_id`、`conversation_id`、`dsh_session_id`、`turn_id` 是不同概念。

**有效打断时的严格先后关系：**

1. 收到设备侧确认的有效打断信号，**在可信 Session 存储中原子递增 epoch 并拒绝旧 turn 的写权限**；此步先于接收新流或开始写 TTS。
2. 小智 `client_abort` → 停止设备播放/清 TTS 与已排队音频；同时对所有下游发送/记忆入口激活栅栏。
3. 向 Bridge 发 `turn.cancel`，默认调用 `agent.cancel({kind:'user'})`，**不要**用 `keepInbox:true` 保留可能含旧轮次的积压消息。
4. 等待 `agent.whenIdle()` 并核实根 Agent 已停稳；若启用 Subagent，必须另检全部后代与工具。停止前不得把新文本推进**同一 Agent Loop**。
5. 新语音的 ASR 识别可以与步骤 2–4 **并行**进行，输出缓存在 Orchestrator；只有旧任务停稳并再次确认 epoch，才调度新 `turn.prompt`。
6. 旧响应即便迟到，`turn_id/epoch` 不匹配即丢弃；不可“恢复旧任务”或向新对话重新注入旧 token。
7. 操作超时则将 Worker 隔离，终止进程、受控重建，并只从已确认的业务快照/合法 Session 记录恢复。

必须限制`取消排队`、`重复请求`、`连续语音端点误判` 的竞态。将“有效打断”的音频/VAD 阈值和误打断率纳入实机测试，不是每一帧 VAD 都提升 epoch。

## 5. Turn Fencing：业务与媒体的原子边界

任何 `memory.propose`、`memory.commit`、学习状态、场景操作、TTS 排队和音频发送都携带 `session_key, turn_id, epoch, idempotency_key`。

业务写入使用数据库事务/条件写入，而不是非原子的“先 SELECT 再 INSERT”：

```sql
BEGIN IMMEDIATE; -- SQLite 单写者示意；其他数据库用等价事务/行锁
SELECT epoch FROM conversation_epoch WHERE conversation_id = :conversation_id;
-- 若与 :request_epoch 不一致，ROLLBACK 并返回 STALE_TURN_REJECTED。
-- 一致时，在同一事务中校验授权、幂等键并写入合法的领域事件。
COMMIT;
```

服务端实现应检查**会话归属、授权、版本和幂等**，不可只校验 epoch 数字。取消之前已经成功提交或执行的远程 API 调用不自动回滚；需要 Side Effect 审计、幂等键、必要补偿。被打断的候选记忆不得自动晋升为确定儿童事实。TTS 文本队列、音频发送器都进行二次栅栏校验，确保旧音频不再排队/下发。对于已到达设备缓冲区的数据，依赖独立 stop 指令并做实机泄漏测试。

## 6. Live Stream 与儿童输出安全

订阅 `agent/assistant-stream` 的 `start/chunk/end`，按 `attempt_id + step_id + index` 校验顺序，接收 `text-delta`。为每个 attempt 建立独立缓存：

- 只消费当前 `epoch` 且来自合法 Agent/attempt 的增量；取消即停止继续读取该代业务输出。
- 使用短句边界与最大等待上限做增量分块，经**儿童安全输出 Gate** 审核后再送 TTS；不能未经校验直接播放原始 token。
- 标记 `assistant/message`/`assistant/attempt` 等持久事件，仅用于最终结算/审计/恢复，**不重放**已经播放的 live delta。
- Tool Call JSON、模型推理内容、非用户可见事件不得直接路由到 TTS；临时失败/模型重试也不应重复播报前一个 attempt。
- 限制缓冲队列上限和背压；安全模型响应慢时应降级为简短安全提示或静默，不能为了 P95 绕过 Gate。
- 首字、首个**可安全播报短句**、首个设备音频包分别埋点；“事后回放分词”不算真正实时输出。

## 7. 真实取消、超时和隔离恢复

- 常态：`cancel()` + `whenIdle()`；监测取消延迟。
- 超时：Fence 先行（逻辑隔离仍有效），标记不可用 Worker，强制进程退出并等待资源回收，然后重新初始化 Profile/Session。
- 单用户 POC 可单 Worker；多用户时不得一个进程拥有所有儿童不可隔离的 Agent，否则强杀影响所有人。Worker 池/独立容器作为扩容条件，而不是首期基础设施。
- 恢复时绑定稳定逻辑会话，但只重建**已确认且未过期**状态；未完成 Tool Side Effect 不可无审计重放。DSH JSONL 与 Lumi 领域事实必须分开。
- 全程不承诺能撤回已经提交的外部动作；将补偿结果明示于审计。
- 紧急“停止播报”与 SDK Runtime 停止必须解耦：设备停止优先，不等待 DSH 算力释放。

## 8. 安全边界与数据隐私

`lumi-dsh-runtime-bridge` 需配置**独立、显式白名单** Cordis Profile，不得静默复用 R0 Profile 或官方默认 `sdk`/`sdk-minimal`。DSH 上游未经过儿童生产安全审计；运行时外层以受限容器/UID、只读文件系统、最小网络目的地、密钥隔离和短会话存储加强。

Bridge IPC 不可公网直连；强制 peer 权限、schema 校验、限速和最大消息体大小；避免将 `agent/assistant-stream` 原始内容写普通日志。第三方 ASR/TTS/LLM 数据外发必须独立告知与审查。原始儿童音频默认不持久化，日志/CI 全用合成样例；R0 回归保持零 SKIP。

## 9. 交付工作包与门禁

| 工作包 | 状态 | 交付/明确 PASS 条件 |
| --- | --- | --- |
| **R1-V1** Orchestrator/Fencing | **合成 POC 已交付**（issue #28）| 模拟迟到 ASR、重复取消、旧事件/TTS/记忆的 100 次竞态；旧输出和过期写入均为 0 |
| **R1-V2** Cordis Bridge POC | 未开始 | `prompt/cancel/stream/close` 合同、唯一所有权、真实 live Delta / 取消、进程重启、Profile 白名单与隐私门禁 |
| **R5-V3** 小智及 XVF3800 实机 | 未开始 | 思考中打断、播放中打断、连续抢话、服务重启、断网恢复；私有化设备激活/OTA，完整语音闭环 |

**建议的初始性能目标（候选值，必须用具体云环境/设备实测校准）**：

| 指标 | 初始目标 |
| --- | --- |
| 有效打断至设备停止播放 P95 | ≤ 200 ms |
| Bridge 对取消请求确认 P95（仅受理，非 Agent 停稳） | ≤ 500 ms |
| 正常 `whenIdle()` 停稳 | ≤ 1 s |
| 异常 Worker 回收 | ≤ 2 s |
| 旧轮次文本/TTS 错误输出 | **0** |
| 已失效 epoch 后的业务写入 | **0** |
| 100 次竞争性打断 | 无跨轮、死锁、重复写入 |

必须分别统计**本地播放停止**、**取消命令 ACK**、**内部 Agent idle**、**下一轮首段安全播报**。以上不是现有项目达到的指标。

## 10. 失败门槛与可替换性

任一安全用例中出现跨轮播报、过期记忆写入、未授权 Agent 工具、真实儿童数据被无授权外发，即 **BLOCK**，不得进入真实语音环境。若 Bridge 在当前固定版本不能提供安全的 live+cancel，则保留 R0 文本 SDK 路线，复议后续上游官方 API、ACP 或语音协议，不强行 Fork Agent Loop。

当 DSH 上游正式推出 cancel/stream 等价稳定 API 时，可用协议适配器替换 Bridge 内部实现，保持 Orchestrator/Domain API 不变。

## 11. R1-V1 实现落点（issue #28）

Turn Orchestrator 与 epoch fencing 的合成 POC 实现于 `lib/domain/voice/`（状态机/可信栅栏存储/Orchestrator/结构化审计，无依赖领域层）与 `lib/server/voice-turn-sqlite-store.ts`（同一存储端口的 SQLite `BEGIN IMMEDIATE` 事务实现，含版本化迁移门禁与重启幂等账本恢复）。§4 的严格先后关系由 `cancelTurn`（原子递增 epoch + 旧轮翻转 CANCELLING）与 `pumpScheduler`（旧任务停稳前不调度新 prompt）承载；§5 的原子条件提交由 `fenceWrite`/`fenceOutput`/`drainTtsQueue` 承载，全部携带 `session_key, turn_id, epoch, idempotency_key`，内容仅以十六进制摘要过界。确定性竞态证据（120 个种子场景、种子重放同审计同终态）见 `tests/domain/voice/race.spec.ts`。R1-V2 Bridge 之前不宣称 DSH 进程内已真取消。
