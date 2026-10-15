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
| `turn.prompt` | `session_key, turn_id, epoch, prompt_text(瞬态,≤512字), fingerprint, idempotency_key`（v2，issue #51） | Orchestrator 确认当前代且空闲时再入队，回 `accepted`；`prompt_text` 是授权瞬态转写，只服务本轮受保护的模型请求 |
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
| **R1-V2** Cordis Bridge POC | **合成 POC 已交付**（issue #29）| `prompt/cancel/stream/close` 合同、唯一所有权、真实 live Delta / 取消、进程重启、Profile 白名单与隐私门禁 |
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

## 12. R1-V2 实现落点（issue #29）

Cordis Runtime Bridge 的**合成 POC** 实现于 `lib/domain/voice/bridge/`（无依赖领域层）与 `lib/server/voice-bridge-ipc.ts` / `voice-bridge-composition.ts`（本地 IPC 传输与编排组合）。R0 的 `poc/dsh-child` 与既有 SDK 路线**原样保留**，根工程仍零 `@deepseek-ai/dsh-*` 依赖：

- **Profile 唯一所有权**（§8）：`profile.ts` 定义独立的 `lumi-dsh-runtime-bridge` Profile 合同——工具白名单 DERIVE 自 R1-15 `SAFE_TOOL_REGISTRY` 单一事实源，telemetry/sessionLog/crashReporting 必须 `off`，egress 仅 loopback；`mock-cordis.ts` 以独占注册表承载 `ctx.agents create/resume` 语义，同 Session 二次创建在端口层被结构性拒绝（`bridge_ownership_conflict`），Bridge 服务层再拒绝一次（`session_conflict`）。
- **IPC 合同**（§3）：`ipc-contract.ts` 以 fail-closed 解析器固化 `session.open / turn.prompt / turn.cancel / turn.stream / session.close` 五命令与 `turn.accepted / assistant.delta / attempt.ended / turn.settled / session.idle / session.closed / runtime.error` 事件词表、协议版本、鉴权 token 语法与帧长上限；除 `assistant.delta` 的瞬态 `text` 外全部字段内容无关（schema 测试断言字段 allow-list）。`voice-bridge-ipc.ts` 承载字节层：4 字节长度前缀 JSON 帧、硬性字节上限、首帧版本+鉴权握手、单连接租约、滑窗限速、POSIX UDS `0600` 文件权限（Windows 开发环境以同名协议跑命名管道，仅为开发/测试形态）。
- **真取消与实时 Delta**（§1/§6）：`agent-port.ts` 抽象锁定版本进程内 `cancel({kind:'user'})`/`whenIdle()`/`dispose()`/`agent/assistant-stream` 面；Bridge 只转发 text 通道瞬态 chunk（绑定 `attempt_id/step_id/index/turn_id/epoch`），tool_call/thinking 通道计数丢弃，durable `assistant/message` 仅作结算通知（只带 messageId，正文永不过界）。`stream-gate.ts` 在 Orchestrator 侧对每条 delta 复核当前可信 epoch（`fenceOutput(text_delta)`），按 attempt 严格单调校验 index，短句缓冲后逐句过**真实 R1-15 儿童 Output Gate**，通过后才 `fenceOutput(tts_queue)` 准入 TTS。
- **打断顺序**（§4）：组合层 `bargeInCancel` 严格执行 fence 先行（可信存储原子递增 epoch、旧轮全体翻转 CANCELLING）→ Bridge `turn.cancel`（进程内真取消 + `whenIdle` 复核，未停稳即隔离 Worker）→ `confirmStop` 落 CANCELLED → 同批被栅栏的排队旧轮一并 CANCELLED → 之后才调度新 turn；Bridge 侧对携带 ≤ 出轮 epoch 的 cancel 请求以 `stale_turn_rejected` 拒绝（fence-first 纵深防御）。
- **隔离恢复**（§7）：Worker 崩溃或 `whenIdle` 返回未停稳 → quarantined（`runtime.error(worker_crashed)`，受影响 turn 终态 FAILED，绝不复活）；仅显式 `session.open` 重建 Worker（`recovered`），恢复只绑定确认的会话身份，不重放任何 Side Effect；Bridge 拒绝派发时可信侧将对应 turn 落 FAILED，保证调度器活性。
- **候选基线**（§9，仅采集不达标）：取消 ACK、`whenIdle` 停稳、首段安全文字、Worker 回收四项延迟在 Bridge/Gate 指标快照中分别采集（`baselineMetrics()`），测试明确标注为候选值。
- **竞态证据**：`tests/domain/voice/bridge/race.spec.ts` 100 个种子场景（抢话、重复取消、迟到 delta 风暴、崩溃恢复、非法 IPC 注入五族），不变量断言：交付 TTS 全部当前 epoch（旧 TTS 交付 = 0）、终态 turn 的栅栏写入全部拒绝（旧记忆写入 = 0）、被栅栏 delta > 0、非 text 通道丢弃 > 0、每轮取消的进程内 cancel 恰好一次；取消 ACK/idle/首段安全文字/回收耗时作为候选基线输出。真实 UDS 传输路径由 `tests/server/voice-bridge-ipc.spec.ts` 与 `voice-bridge-composition.spec.ts` 在 POSIX CI 上行使（Windows 开发沙箱禁止开 socket，规格测试在 POSIX 上运行）。
- **边界声明**：本 POC 的"上游运行时"是合成 Mock，未接入真实 DSH 进程；live/cancel 证据针对合成 Mock 的源级语义（取消即源头停止派发、durable 消息不参与 delta），不等于实机验收。实机 R5 是单独阶段。

## 13. R1-V3 实现落点（issue #30）

Voice Gateway Adapter 的**合同 + 合成故障注入 POC** 实现于 `lib/domain/voice/adapter/`（无依赖领域层）与 `lib/server/voice-gateway-composition.ts`（把 Adapter 绑到 R1-V1 Orchestrator + R1-V2 Bridge 栈的设备边缘组合）。协议与兼容矩阵固定于 `docs/VOICE_GATEWAY_PROTOCOL.md`（小智官方固件 **v2.5.2** 线协议 + 自建 `xinnan-tech/xiaozhi-esp32-server` 评估基线，来源差异如实记录：线协议报文名为 `abort`，`client_abort` 是自建服务端内部状态标志；矩阵与私有 OTA 均标注未实机验证）：

- **设备可信绑定**（§8 延伸）：`binding.ts` 只接受监护人激活摘要的绑定；变更 device_id、未绑定设备、伪造/跨会话 session_id 全部枚举拒绝；每设备至多一条连接租约。小智连接 `session_id` 只是连接级一次性映射句柄，**永不作为儿童身份**——身份始终来自受信绑定（actorId/conversationId），重连续接同一受信会话而 session_id 重新铸造。
- **ASR final/partial**（§5 延伸；**E2E-01（issue #51）修订**）：瞬态转写不再降为裸 FNV-1a 摘要充当隐私保障——授权 final（长度受限、过真实 Input Safety Gate）以受保护单轮调用携逐字文本进入 Core，经 Bridge IPC `turn.prompt.promptText` 到达受信 Agent；详见 §14。

## 14. E2E-01 实现落点：ASR 瞬态文本通道（issue #51）

授权范围内的瞬态 ASR 明文通道实现于既有栈（`lib/domain/voice/adapter/gateway-adapter.ts` → `lib/server/voice-gateway-composition.ts` → `voice-bridge-composition.ts` → `ipc-contract.ts`/`bridge.ts` → `agent-port.ts`）：

- **贯通路径**：`asr_final` 文本在 Adapter 单个调用帧内过**真实 R1-15 Input Safety Gate**（`evaluateInputGate`，entrance `voice`；block/escalate_crisis 一律以 `input_gate_blocked` fail-closed 拒绝）→ 以 `transientText` 进入受保护单轮调用 `submitPrompt` → 组合层**瞬态 prompt vault**（有界 64 条、纯内存、不导出/不落盘）暂存 QUEUED 轮 → 派发时随 `turn.prompt`（协议 **v2**）的 `promptText`（≤512 字）跨 IPC → Bridge 传给 `handle.runPrompt({promptText})` → 受信 Fake Agent 逐字收到。partial 仍只计数/候选，永不触发推理。
- **密钥化去重**（不再使用裸 FNV-1a 充当短句隐私保障）：转写去重指纹为组合层注入的 **HMAC-SHA256**（64 hex）；密钥生命周期 = 进程内 `randomBytes(32)`、不落盘不打日志、随进程销毁；重启换钥后跨进程重放一律 `idempotency_conflict` fail-closed（可重放测试可显式注入固定测试密钥，生产必须省略）。FNV-1a（`gatewayContentDigest`）仅保留给非隐私用途：会话键派生、帧批摘要、重放指纹。
- **生命周期与失败销毁**：明文只存在于受保护单轮调用、必要 IPC 与获批模型请求；vault 条目在派发时取用即毁（成功或失败都毁）、fence 取消/Worker 崩溃/终态结算时销毁；丢失 vault 条目的轮次派发即 `prompt_text_lost` fail-closed（宁可 FAILED，绝不让摘要冒充模型输入）；超长文本在协议解析层（512 字）即拒。全程不入普通日志/审计/快照/错误包（schema 测试断言字段 allow-list + 泄漏扫描断言零出现）。
- **证据**：`tests/domain/voice/adapter/transient-channel.spec.ts`（逐字到达、partial/Gate/超长/伪造会话 fail-closed、泄漏扫描、HMAC 指纹形态、打断后旧文本不回流）+ `adapter.spec.ts` / `ipc-contract.spec.ts` / `bridge.spec.ts` / `voice-bridge-composition.spec.ts` 相应修订。实机 R5 仍未验证，不写 PASS。
- **client_abort → fence 先行**（§4）：`abort` 事件经 `GatewayCorePort.bargeIn`（组合层 fence→真取消→`whenIdle`→CANCELLED→调度下一轮）后才发端侧 `tts.stop{interrupted}`（每 turn 恰一次）与 `tts.clear{droppedStale}`；无播放中的 abort 是枚举 no-op（连续抢话无第二次 epoch bump）。
- **Opus 发送合同**（§5）：`drainTts` 只交付当前 epoch → 每批再过 `fenceOutput(kind:"audio_send")` → `tts.frames{frameCount,audioDigest}`——协议面不存在音频字节字段，真实编解码与 AEC 时钟对齐属 R5。
- **合成故障注入**（§9 延伸）：`mock-xiaozhi.ts`（确定性 pump/flush 驱动、逐字节可重放）+ `fixtures.ts` 七族命名 fixture（迟到 ASR、连续 abort、服务重启、乱序输出、断网重连、重复连接、身份伪造）在真实组合栈上跑 56 场景：旧响应泄漏 0、全部 turn 终态无死锁、审计环联合无文本泄漏；设备侧对停后/旧 epoch 帧批的拒绝可观测。
- **竞争性证据**：`tests/domain/voice/adapter/`（protocol/binding/adapter/fault-injection/fixtures 五套件）；R0 与 R1-V1/V2 回归保持不变（全量本地 818 tests，0 FAIL，5 SKIP 为既有 POSIX-only 真 socket 用例）。实机 R5 验收清单与硬件板级 TODO 见 `docs/VOICE_GATEWAY_PROTOCOL.md` §6/§7。
