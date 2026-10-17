# Voice Gateway Adapter：小智 v2.5.2 协议兼容矩阵与合同（R1-V3）

> 版本：1.4 ｜ 2026-10-15（1.4 修订 2026-10-17；1.4 增补 §10 issue [#61](https://github.com/lybym/LumiThink/issues/61)）｜ Issue [#30](https://github.com/lybym/LumiThink/issues/30)，1.1 修订 Issue [#51](https://github.com/lybym/LumiThink/issues/51)，1.2 修订 Issue [#55](https://github.com/lybym/LumiThink/issues/55)，1.3 修订 Issue [#56](https://github.com/lybym/LumiThink/issues/56)，1.4 修订 Issue [#57](https://github.com/lybym/LumiThink/issues/57)，1.4 增补 Issue [#59](https://github.com/lybym/LumiThink/issues/59)（打断实测面 §9——测量与验收合同，不改 Adapter 合同），1.4 增补 Issue [#61](https://github.com/lybym/LumiThink/issues/61)（可靠性回归面 §10——测量与验收合同，不改 Adapter 合同） ｜ **合同 + 合成验证 + 服务端接线联测；固件/服务端兼容与私有 OTA 均【未实机验证】；真实 ASR/TTS 供应商行为未实机验证；真实设备验收未开始**
> [VOICE_RUNTIME](./VOICE_RUNTIME.md) · [ADR-002](./adr/0002-voice-runtime-bridge.md) · [ADR-007](./adr/0007-asr-transient-text-channel.md) · [ADR-0009](./adr/0009-real-asr-provider-transient-channel.md) · [ADR-0010](./adr/0010-real-tts-provider-dual-stream.md) · [ADR-0011](./adr/0011-xiaozhi-gateway-wiring.md) · [硬件选型](./VOICE_HARDWARE.md) · [Roadmap R1-V3](./ROADMAP.md)

## 1. 固定评估基线（版本/契约钉死）

| 层 | 固定基线 | 依据（2026-10-15 查阅） |
| --- | --- | --- |
| 端侧固件协议 | `78/xiaozhi-esp32` tag **`v2.5.2`**，WebSocket 协议文档（该 tag 内 `docs/websocket.md`） | <https://github.com/78/xiaozhi-esp32/blob/v2.5.2/docs/websocket.md> |
| 自建服务端 | `xinnan-tech/xiaozhi-esp32-server`，评估时 main 提交 **`27399a2fb64b5910196f438a256ce0a9f868481f`**（最新 tag `v0.9.7`）；适配层语义核对 `abortHandle.py` / `helloHandle.py` / `connection.py` | <https://github.com/xinnan-tech/xiaozhi-esp32-server> |
| 上行音频 | Opus，16 kHz，单声道，60 ms 帧（firmware hello `audio_params`） | 同上协议文档 §1/§8 |
| 下行音频 | Opus，**由服务端 hello 协商**（文档注明服务端可用 24 kHz）——适配层不写死采样率 | 同上协议文档 §8.3 |
| 代码内钉死 | `XIAOZHI_GATEWAY_BASELINE`（`lib/domain/voice/adapter/protocol.ts`），schema 测试断言版本/提交不可漂移 | `tests/domain/voice/adapter/protocol.spec.ts` |
| 私有部署钉死（E2E-04，issue #54） | 服务端部署钉死单一事实源 `deploy/xiaozhi/version.env`（与 `XIAOZHI_GATEWAY_BASELINE` 一致性由 `tests/deploy/xiaozhi-deployment.spec.ts` 强制）；部署 runbook 见 [deploy/xiaozhi/runbook.md](../deploy/xiaozhi/runbook.md) | [Issue #54](https://github.com/lybym/LumiThink/issues/54) |

**术语澄清（来源间差异，如实记录）**：Issue 与 [VOICE_RUNTIME §4](./VOICE_RUNTIME.md) 所称 `client_abort` 在 v2.5.2 **线协议中的报文名是 `{"type":"abort","reason":…}`**；`client_abort` 是自建服务端处理 abort 报文时置位的**内部状态标志**（`abortHandle.py`：`conn.client_abort = True` → `clear_queues()` → 下发 `{"type":"tts","state":"stop"}`）。本合同以线名 `abort` 为入站事件、以 `client_abort` 语义命名打断行为。

**其他如实记录的来源差异/风险**：

1. 官方协议文档自述"based on the current code — cross-check with the actual implementation"——文档不构成兼容承诺，以下矩阵一律以合同 + 合成验证为准，实机项全部标注未验证。
2. 自建服务端存在"打断后收不到后续语音二进制"的已报告问题（[xinnan-tech issue #743](https://github.com/xinnan-tech/xiaozhi-esp32-server/issues/743)）；LumiThink 侧以端侧 stop 指令 + epoch 栅栏纵深防御，R5 实机必须复核该场景。
3. 上行 16 kHz 与下行可协商（至 24 kHz）并存；二进制分帧有 v1/v2/v3 三版（v2 携带时间戳、服务端 AEC 用）。POC 固定 v1 契约面，R5 随 XVF3800 AEC 联调再锁版本。

## 2. Adapter 合同（设备边缘 → 可信 Core）

实现：`lib/domain/voice/adapter/`（protocol / binding / gateway-adapter / mock-xiaozhi / fixtures，无依赖领域层）；组合：`lib/server/voice-gateway-composition.ts`（把 Adapter 绑到 R1-V1 Orchestrator + R1-V2 Bridge 栈上）。Adapter 只通过 Core 端口（`GatewayCorePort`）触达 Orchestrator/Bridge，不绕过任何安全边界。

```text
xiaozhi 设备/自建服务端 (v2.5.2 线协议)
  └── Voice Gateway Adapter（设备可信绑定/标识映射/鉴权；纯合成可重放）
       ├── 受信绑定注册表：activation digest → (deviceId → actorId, conversationId)；hello 强制比对持有凭证（device_possession_denied）
       ├── 连接租约：每设备至多 1 条连接；重复连接拒绝 device_connection_conflict；容量耗尽拒绝 binding_capacity_exceeded
       ├── 会话映射：(connectionId, xiaozhi session_id[一次性]) → sessionKey
       ├── ASR final（v1.1，issue #51）：长度受限 + Input Safety Gate 通过的授权
       │    final 以受保护单轮调用携逐字瞬态文本进 Core（瞬态 vault → turn.prompt
       │    v2 `promptText` → 受信 Agent）；去重指纹为进程内 HMAC-SHA256；
       │    partial 仍只计数/候选
       ├── abort（client_abort）：fence 先行（epoch 原子递增）→ 端侧 stop → TTS 队列清空
       └── Opus 发送合同：drain → audio_send 二次栅栏 → tts.frames（帧数+摘要，无音频字节）
            └── Turn Orchestrator（R1-V1，turn/epoch 唯一信任锚）
                 └── Cordis Bridge（R1-V2，prompt/cancel/stream/close + Output Gate）
```

### 2.1 设备可信绑定与身份（验收 1）

- **绑定只由监护人激活产生**：`bindDevice({deviceId, actorId, conversationId, activationDigest})`，注册表只存激活摘要。**变更 device_id 而无对应激活摘要 → `device_rebinding_denied`**；未绑定设备连接 → `device_unbound`。冒用他人 `session_id` → `session_forged`；跨会话引用 → `cross_session_rejected`（`binding.ts`，测试 `binding.spec.ts`）。
- **连接时刻强制持有凭证（hello possession proof）**：hello 必须携带设备持有的激活摘要（`clientDigest`），`openConnection` 将其与绑定记录比对，**缺失/不符 → `device_possession_denied`**（先于重复连接冲突判定）。deviceId（MAC）是公开广播的，**仅凭 MAC 冒用已绑定设备永远拿不到租约/会话映射/儿童会话授权**——传输层鉴权是叠加防御层，不再是 `handleDeviceEvent` 的隐式前置契约。v2.5.2 线协议本身无此字段：R5 传输层负责把设备激活/授权材料映射为 hello 凭证；线路重放防护归 TLS（R5 可升级为挑战-应答）。测试：`binding.spec.ts`（缺失/畸形/错误凭证）+ `fault-injection.spec.ts` `forged_identity`（已绑定 deviceId 二连接冒用，缺失与错误凭证两变体）。
- **每设备至多一条连接租约**：第二条并发连接 → `device_connection_conflict`（重复设备连接故障注入的防死锁基础）。
- **小智 `session_id` 不是儿童永久身份**：它由服务端按连接生成（`connection.py`：`self.session_id = str(uuid.uuid4())`），只作为连接级映射校验句柄记录（`binding.ts` 的 `GatewaySessionMapping`），断线/重启即失效，重连重新铸造；儿童身份始终来自受信绑定（actorId/conversationId）。测试断言：重连后 sessionKey/身份不变、session_id 必变、旧 session_id 复用被拒。

### 2.2 Session / turn / epoch 映射

| 小智侧 | LumiThink 侧 | 归属 |
| --- | --- | --- |
| `Device-Id`（握手头，MAC） | 绑定注册表 `deviceId` → (actorId, conversationId) | 受信绑定 |
| `session_id`（服务端按连接铸造） | 连接级映射句柄（`mappingSnapshot` 暴露，内容无关） | 一次性，**非身份** |
| —（设备不可指定） | `sessionKey = ses_gw<digest(deviceId|conversationId)>` | Orchestrator 会话 |
| —（设备不可指定） | `turnId = trn_*`（Orchestrator 铸造）、单调 `epoch`（可信存储独占） | R1-V1 |

设备永远不能指定 epoch/turnId；打断 = 受信存储原子递增 epoch 并翻转旧轮，晚到的旧轮 delta/TTS/写请求在 Orchestrator/Adapter 双层栅栏拒绝。

### 2.3 ASR 瞬态文本通道（v1.1，issue #51 / E2E-01）

v1.0 中 `asr_final` 文本在 Adapter 内即刻降为 FNV-1a 摘要并丢弃——该摘要无法作为 Agent 真正的对话输入，且裸 FNV-1a 不能承担短句隐私保障。v1.1 建立授权范围内的**瞬态明文通道**：

- **外发审批链**（每层缺一不可，fail-closed）：监护人激活绑定（activation digest）→ hello 持有凭证比对 → 连接租约 + 会话映射授权 → **真实 R1-15 Input Safety Gate**（`evaluateInputGate`，entrance `voice`；`block`/`escalate_crisis` 一律 `input_gate_blocked` 拒绝，枚举码进审计，文本不留痕）→ 可信 Orchestrator 注册（turn_id/epoch 铸造 + 幂等键）→ Bridge `turn.prompt`（协议 **v2**）→ 受信 Agent 的单轮模型请求。
- **明文生命周期**：文本只存在于 Adapter 单个调用帧、组合层瞬态 prompt vault（QUEUED 轮暂存；有界 64 条、纯内存、不导出不落盘）、必要 IPC 与获批模型请求。vault 条目派发时取用即毁（成功或失败都毁）、fence 取消/Worker 崩溃/终态结算时销毁；丢失条目的轮次派发即 `prompt_text_lost` fail-closed（宁可 FAILED，不让摘要冒充模型输入）。长度上限 512 字符，在协议解析层即拒。
- **密钥化去重**：转写去重指纹为 HMAC-SHA256（64 hex），密钥 = 进程内 `randomBytes(32)`，不落盘不打日志、随进程销毁。密钥随进程销毁意味着跨进程重放**不再被幂等账本识别**：幂等键派生自当前密钥下的指纹（`idem-gw<指纹前 8 位>t<计数>`），重启换钥后同一转写产生**不同指纹 → 不同幂等键 → 账本 miss → 铸造新 turn 重新执行**（fail-closed 方向的显式接受语义，见 ADR-0007"约束/后果"；`idempotency_conflict` 仅覆盖"同键不同指纹"，跨进程重放不会持有旧键，不适用）。可重放测试可注入固定测试密钥（`asrFingerprintKeyHex`，生产必须省略）。FNV-1a 仅保留非隐私用途（会话键派生、帧批摘要、重放指纹）。
- **重复 final 窗口化去重（v1.2，issue #55 / ADR-0009）**：真实流式 ASR 会产生同一话语的重复 final（端点双发、重连重投递）。Adapter 对**已接受** final 的 HMAC 指纹做**每设备、有界窗口（默认 2000 ms）**去重：窗口内同指纹、且无 `listen start`/`detect` 新话语信号 → 枚举化 no-op（`gateway.asr_duplicate_suppressed`，无第二 turn/无第二次模型请求/无文本残留）。记忆**跨重连存活**（每设备）：断线后重投递同一 final 不会在新连接上铸造错误轮；新话语信号或窗口过期后同文本按新话语接受。保守方向（2 s 内同文本快速重述被并作同一话语）为显式接受语义，R5 实机标定可经 `asrDuplicateWindowMs` 调整。
- **内容无关 ASR 指标（v1.2）**：`asrEndpointWindows`（listen start/detect 开窗数）、`asrDuplicateFinalsSuppressed`、`asrFinalAcceptMs{count,maxMs}`（final 事件到达 → 受保护单轮提交完成的候选时延）进入 metrics/证据快照（`buildRealAsrEvidenceRecord`，`voice-asr-real/1`）；钉死 commit 的 `stt` 线协议不携带供应商置信度，证据如实标注 `confidence.onWire=false`。
- **零泄漏不变量**：文本不入普通日志/审计/快照/错误包/制品；审计 detail 只有枚举码或 64-hex 密钥化摘要；schema 测试断言字段 allow-list，泄漏扫描断言合成标记在全部内容无关表面零出现（唯一允许位置 = Fake Agent 收到的获批模型请求）。

### 2.4 播放停止 / TTS 队列清空 / Opus 发送（验收 1）

- `abort` → **fence 先行**（`core.bargeIn` = 组合层 `bargeInCancel`：原子 epoch 递增 → Bridge 进程内真取消 + `whenIdle` 复核 → CANCELLED）→ 才发 `tts.stop{reason:"interrupted"}`（每 turn 恰好一次）→ `drainTts` 丢弃全部旧 epoch 队列项并回执 `tts.clear{droppedStale}`。
- 连续抢话：无播放中的 abort 是枚举化 no-op（`no_active_playback` 语义，无第二次 epoch bump、无重复 stop——"不是每一帧 VAD 都提升 epoch"）。
- 出站帧批：`drainTts` 只交付当前 epoch 队列项 → 每批再过 `fenceOutput(kind:"audio_send")` 深度防御 → `tts.frames{frameCount, audioDigest}`（**帧数 + 十六进制摘要，协议内不存在音频字节字段**，真实编解码属 R5）。
- **内容无关 TTS 指标（v1.3，issue #56 / ADR-0010）**：Adapter 记录 `ttsTurnsPlayed`（按**投递 episode** 计数：turn 中途断连→重连恢复投递会对同一 turnId 再次计数并重发 `tts.start`，first-audio 锚点对每次 final 接受只计一次；候选基线指标，审计口径 = 投递 episode 而非去重 turn 数）/`ttsSentencesSent`/`ttsFramesSent`、`ttsFirstAudioMs`（final 接受 → 该 turn 首个帧批）、`ttsInterSentenceGapMs`（同 turn 帧批间隙）、`ttsStopEffectiveMs`（abort 到达 → 端侧 stop）与 `ttsStaleAudioSuppressed`（fence 拒绝 + 队列丢弃；旧 epoch 送出结构上为 0）；mapping 快照按设备记录 hello 协商下行采样率。真实供应商合成由钉死服务端的 `gateway-tts-real` 档位承载；服务器端解码/播放验证为运营者 opt-in，协议面不变。

## 3. 兼容矩阵（v2.5.2 线协议 × Adapter 合同）

状态含义：`合同+合成已验` = 本 PR 的 schema/行为测试覆盖（纯合成数据）；`未实机验证` = 需要 R5 硬件/真实服务端才能确认，本 PR 不写 PASS。

| v2.5.2 报文 | 方向 | Adapter 合同映射 | 状态 |
| --- | --- | --- | --- |
| `hello`（version=1, features, audio_params） | 设备→服务端 | 握手头鉴权（Authorization/Protocol-Version/Device-Id/Client-Id 归传输层，叠加防御）**+ 合同内持有凭证**：hello 携带激活摘要与绑定记录比对，缺失/不符 `device_possession_denied`；hello 事件驱动绑定 + 连接租约 | 合同+合成已验；实机握手 未实机验证 |
| `hello` ack（含 `session_id`） | 服务端→设备 | `session_issued` → 连接级映射铸造 | 合同+合成已验；未实机验证 |
| `listen` start/stop/detect（mode auto/manual/realtime） | 设备→服务端 | 语音状态计数；**播放中 detect 仅计为打断候选，不栅栏** | 合同+合成已验；未实机验证 |
| `abort`（reason: wake_word_detected/manual/vad_detected）——即 issue 所称 client_abort | 设备→服务端 | fence 先行打断：epoch 递增 → 端侧 `tts.stop(interrupted)` → 队列清空 | 合同+合成已验（56 场景）；实机打断 未实机验证 |
| ASR partial（自建服务端流式 ASR 内部事件） | 服务端内部 | `asr_partial` 有界瞬态事件：只计数/候选，不产生 prompt。**E2E-05 注**：钉死 commit 的 STREAM provider（aliyunbl_stream 等）在服务端内部消费流式 partial，设备线协议不转发 partial 文本——partial 面保持防御性合同 | 合同+合成已验；真实流式 ASR 行为 未实机验证 |
| `stt`（text，ASR 终稿） | 服务端→设备 | `asr_final`：长度受限 + Input Safety Gate → 授权瞬态明文走 §2.3 通道（vault → `turn.prompt` v2 `promptText` → 受信 Agent）；去重指纹为 HMAC-SHA256（§2.3）；v1.2 起窗口化重复 final 去重（§2.3）。**E2E-05**：真实供应商路径由钉死小智服务端的 `gateway-asr-real` 档位承载（ADR-0009），线协议不变 | 合同+合成已验（`transient-channel.spec.ts` / `real-asr-stream.spec.ts`）；真实供应商转写 未实机验证 |
| `tts` start / sentence_start / stop | 服务端→设备 | `tts.start` / `tts.frames`（帧数+摘要）/ `tts.stop`（completed/interrupted/failed，每 turn 恰一次） | 合同+合成已验；未实机验证 |
| 二进制 Opus 帧（v1 裸帧；v2/v3 带元数据） | 双向 | POC 固定 v1 契约面；帧批以 frameCount+digest 表示；v2/v3 与 AEC 时钟对齐留 R5 | 契约固定；未实机验证 |
| `mcp`（JSON-RPC 2.0 IoT 控制） | 双向 | **本阶段不开放**：设备工具必须走 R1-15 SAFE_TOOL_REGISTRY/工具栅栏，禁止设备 MCP 旁路安全 Gate | 拒绝（fail-closed 解析器不接受该类型） |
| `system`（reboot）/ `alert` / `custom` | 服务端→设备 | 不处理：解析器对未知 kind/未知字段 fail-closed 拒绝 | 拒绝（枚举拒绝） |
| OTA / 设备激活（自建） | HTTPS | 合同外：见 [VOICE_HARDWARE §2/§4](./VOICE_HARDWARE.md)，**未实机验证** | 未实机验证 |
| 断线/重连/服务重启 | 传输 | 连接租约关闭 + 映射失效 + 播放挂起；重连凭受信绑定续接同一 sessionKey | 合同+合成已验（§5 故障注入） |

## 4. Mock 协议 fixture（可重放）

`mock-xiaozhi.ts`：确定性、pump/flush 驱动（无定时器/无随机数）的合成设备+服务端；调度日志 + 设备侧应用日志构成逐字节可重放证据（`fingerprint()`）。设备侧自带 epoch 校验：stop 之后或 epoch 不符的帧批被 `stale_epoch`/`after_stop` 拒绝——乱序输出因此可观测且无需任何音频字节。

命名 fixture 家族（`fixtures.ts`，全部纯合成、儿童安全样例文本）：

| 家族 | 注入故障 | 期望（已由测试断言） |
| --- | --- | --- |
| `late_asr` | 迟到 ASR（栅栏前/后两变体） | 栅栏前排队者随旧 epoch 一并 CANCELLED；栅栏后者在新 epoch 正常完成；旧播放 0 |
| `consecutive_abort` | 连续抢话/无播放 abort | 每个播放 turn 恰一次栅栏；无播放 abort 为枚举 no-op；无重复 stop |
| `server_restart` | 服务重启、session_id 全失效 | 映射失效、播放挂起；重连以新 session_id 续接同一受信会话与身份；旧句柄拒绝 |
| `out_of_order_output` | 帧批被延迟/乱序应用 | 设备拒绝全部过期/停后帧批（stale_epoch/after_stop） |
| `network_drop_reconnect` | 播放中断网后重连 | 断连期间 0 帧下发；受信会话与身份不变；重连后续播 |
| `duplicate_connection` | 同设备第二条连接 | 租约拒绝 `device_connection_conflict`；原连接不受影响 |
| `forged_identity` | 未绑定设备/伪造 session_id/换绑/已绑定 deviceId 二连接冒用（缺失+错误凭证） | 全部枚举拒绝（含 `device_possession_denied`）；儿童会话授权不可迁移 |

## 5. 脱敏测试报告（本地实跑，2026-10-15）

命令（仓库根目录）：

```bash
pnpm run typecheck                      # 通过
pnpm test                               # 全量域/服务器/发布套件
# 仅本 Issue 适配层（确定性、无外部依赖）：
node --experimental-strip-types --test-isolation=none --test \
  tests/domain/voice/adapter/protocol.spec.ts tests/domain/voice/adapter/binding.spec.ts \
  tests/domain/voice/adapter/adapter.spec.ts tests/domain/voice/adapter/fault-injection.spec.ts \
  tests/domain/voice/adapter/fixtures.spec.ts
```

结果（合成数据；候选值，不是达成 SLA）：

- 适配层 5 个套件 **45/45 PASS, 0 SKIP**；全仓回归 **824 tests：0 FAIL，5 SKIP**（SKIP 均为既有 `voice-bridge-ipc.spec.ts` 真 socket 用例，仅 POSIX CI 执行——与 R1-V2 交付时一致，非本 PR 引入）。
- 故障注入：**56 场景**（7 家族 × 8 种子，虚拟时钟 + 固定 turn-id 工厂，逐字节可重放）：`staleFramesPlayed=0`（旧响应泄漏 0）、`staleFramesRefused=19`（设备侧拒绝过期帧批）、`abortsFenced=26`、`abortsWithoutPlayback=16`（连续抢话 no-op，含 abort 命中已终态回合的 race 分支——不再计入拒绝）、`forgedRefused=8`、`possessionRefused=16`（每种子"已绑定 deviceId 二连接冒用"缺失+错误凭证两变体）、`dupRefused=8`、`suspensions=8`、`deadlocks=0`（全部 turn 终态）。审计环联合 JSON 不含任何样例句文本（schema 断言）。
- 候选时延（`candidateLatency`）**真采集自 `stack.baselineMetrics()`**（全部场景逐场景取最大值；确定性虚拟时钟，非挂钟、非硬编码）：`cancelAckMaxMs=1ms`、`whenIdleMaxMs=1ms`、`firstSafeTextMaxMs=4ms`（候选基线，仅采集不达标）。
- R1-V2 竞态回归未受影响：`scenarios=100 staleTtsDelivered=0 staleWritesAccepted=0 deltasFenced=25 toolDropped=178 cancelAckMaxMs=0ms whenIdleMaxMs=1ms firstSafeTextMaxMs=3ms workerRecoveryMaxMs=17ms`（候选基线，仅采集不达标）。
- 固件/服务端兼容、私有 OTA、实机打断时延：**未实机验证**，无任何 PASS 声明。

### 5.1 v1.1 修订证据（issue #51 / E2E-01，本地实跑 2026-10-15）

- `pnpm run typecheck` 通过；全仓回归 **837 tests：0 FAIL，5 SKIP**（SKIP 同上，既有 POSIX-only 用例；基线 824 + 本修订新增 13 例）。
- 新增 `tests/domain/voice/adapter/transient-channel.spec.ts`（6 例，真实组合栈 in_process）：合成转写**逐字**到达受信 Fake Agent（唯一允许位置 = 获批模型请求记录）；partial / Input-Gate 命中 / 超长（>512）/ 伪造会话 / 无租约连接全部 fail-closed 且 Agent 收到 0 条；泄漏扫描（adapter/orchestrator/bridge 审计与指标、mapping、exportState 快照、gate、设备出站指令）合成标记零出现；`asr_final` 审计 detail 为 **64-hex HMAC-SHA256**；打断后旧文本不回流。
- fixture 重放（`fixtures.spec.ts`）以显式固定测试密钥保持逐字节可重放（生产省略该参数 = 进程内随机密钥）。
- 修订语义：`asr_final` 不再"摘要化即丢弃"；裸 FNV-1a 不再承担转写隐私角色；Bridge IPC 协议 **v1 → v2**（`turn.prompt` 新增可选有界 `promptText`；旧 v1 帧被版本门禁拒绝）。

回滚说明（v1.0）：本 PR 为纯增量（新目录 `lib/domain/voice/adapter/` + 新组合 `lib/server/voice-gateway-composition.ts` + 测试/文档），不改 Orchestrator/Bridge 既有端口与语义、无持久化 schema/migration、未接入 app 页面；回滚即 revert 该 PR，不影响 R0 SDK 合成环境与既有 Bridge 路径。
回滚说明（v1.1 / issue #51）：改动集中在 voice 栈内部（adapter/composition/bridge/ipc 合同 + 测试/文档/ADR），无持久化 schema/migration、未接入 app 页面；回滚即 revert 该 PR，恢复 v1.0"摘要即丢弃"合同，不影响 R0 与既有回归。

## 6. 硬件板级适配待验证清单（R5 前置，均未开始）

**现有 ESP32-S3 机芯盒（调试盒，刷小智官方 v2.5.2）**

- [ ] 记录盒内固件构建：小智提交 SHA、ESP-IDF 版本、`OPUS_FRAME_DURATION_MS`、二进制协议版本设置（v1/v2/v3）。
- [ ] 将 WebSocket/OTA 指向自建服务端（脱离 `xiaozhi.me`），验证激活与升级流（私有 OTA **未实机验证**）。
- [ ] 抓取真实握手头（Device-Id/Client-Id/Authorization 形态）与本合同的设备/摘要语法对齐。
- [ ] 实测 `abort` 三种 reason 的触发路径（唤醒词/手动/VAD）与本合同映射一致性；复核服务端 [issue #743](https://github.com/xinnan-tech/xiaozhi-esp32-server/issues/743) 场景（打断后音频流恢复）。

**未来 XVF3800 + ESP32-S3 终版（不采购/不烧录，仅记录前置）**

- [ ] I2S/I2C 引脚、时钟主从、位宽/采样率、功放与回声参考信号联调（[VOICE_HARDWARE §2](./VOICE_HARDWARE.md)）。
- [ ] XVF3800 DSP 固件版本钉死 + 板级适配固件构建（记录小智提交 SHA/ESP-IDF/DSP 版本）。
- [ ] AEC 下选择二进制协议 v2（时间戳）并复测打断时延与误打断率（候选 P95 ≤ 200 ms，实测定标）。
- [ ] 下行 24 kHz 协商路径验证（采样率转换、帧时长）。

**Linux 自建服务端 / ASR / TTS / OTA（R5 前置）**

- [x] 单模块服务端部署与版本钉死（评估基线 `27399a2`，升级需重跑本矩阵）——**E2E-04（issue #54）已交付部署面**：钉死 checkout、gateway-minimal 档位（VAD 仅本地、ASR/LLM/TTS 显式缺省）、healthcheck + 模拟设备 hello/abort 探针、鉴权/重启/损坏配置负例与干净环境 CI 冒烟（`deploy/xiaozhi/`、`e2e-04-xiaozhi-deployment-gate.yml`）。**口径：私有服务端已验证，真实设备仍待 #E2E-08**；本行不标注供应商接入与实机 OTA 完成。
- [x] 首个真实流式 ASR Provider 的钉死扩展点配置与评审门禁——**E2E-05（issue #55）已交付配置/评审/证据面**（[ADR-0009](./adr/0009-real-asr-provider-transient-channel.md)）：`gateway-asr-real` 档位（AliyunBLStreamASR @ pinned commit 扩展点、16 kHz 上行、duplex 流式、转写不落盘三闸、`bootstrap.sh --template` 显式选档/禁用）、fail-closed 激活记录（评审锚点端点逐字校验）+ 内容无关证据合同（置信度如实标注不上线）、重复 final 窗口化去重与五族流式故障回归（`real-asr-stream.spec.ts`）、CI 渲染/合并后扫描（不启动、零真实出网）。**口径：部署配置面与合成证据已验证，真实供应商转写质量/实机行为/儿童数据评审未完成**——告知同意流程与真实数据评审仍以下行未勾选项为准。
- [ ] 第三方 ASR/TTS/LLM 供应商安全与保留评估、告知同意流程（[VOICE_HARDWARE §3](./VOICE_HARDWARE.md)）——E2E-05 交付了首供应商（百炼 Paraformer 实时）的配置面与评审锚点/激活门禁；E2E-06 交付了首 TTS 供应商（百炼 CosyVoice 双流，[ADR-0010](./adr/0010-real-tts-provider-dual-stream.md)）的配置面与评审锚点/激活门禁；**监护人告知同意流程、真实数据评审与供应商侧保留核实仍未完成**。
- [ ] 私有 OTA 激活/升级/回滚演练；断网-重连-重激活全链路。
- [ ] 真实无线环境下断线重连、重复连接、session_id 轮换行为复核（对照 §5 合成结论）。
- [x] Voice Gateway ↔ 服务端接线（LLM 扩展点桥 + 受保护内部传输 + 设备鉴权映射 + 真实 Opus 下行全链路）——**E2E-07（issue #57）已交付**（[ADR-0011](./adr/0011-xiaozhi-gateway-wiring.md)，见 §8）：真实 Linux 服务端 + 真实网关/DSH 进程的协议模拟设备全链路、鉴权/重复连接/打断/重启负例与真实音频到账记账（`e2e-07-gateway-wiring-gate.yml`）。**口径：服务端接线已验证；真实固件设备/真实音频上行/真实供应商组合仍待 #E2E-08**。
- [ ] Adapter 组合层真实 IPC 传输冒烟（POSIX-only，沿用 `voice-bridge-ipc.spec.ts` 的 SKIP 模式）：当前 5 个适配层套件固定 `transport:"in_process"`，`ipc` 路径由 R1-V2 Bridge 套件间接覆盖，Adapter 组合层自身无 IPC 用例（评审登记项，非本 PR 阻塞）。

## 7. R5 验收基线（本 PR 之后的状态声明）

以下为 R5 实机验收入口清单（**当前全部未开始、未验证**）：思考中打断、播放中打断、连续抢话、服务重启、断网恢复、私有化设备激活/OTA、完整语音闭环（ASR → Gateway → DSH Bridge → 安全短句流 → TTS）。本 PR 交付的是这些项的**合同、可重放合成证据与拒绝路径**；通过本 POC 不代表正式儿童语音可用，任何一项在实机验证前不得标注 PASS。

## 8. 服务端接线（v1.4，issue #57 / E2E-07 / ADR-0011）

v1.4 把本合同的 Adapter 从"纯合成可重放"接入**真实服务端消息/音频路径**。拓扑：

```text
设备（v2.5.2 线协议）→ 钉死小智服务端（WS 鉴权/VAD/ASR/TTS/Opus）
  → 桥接 LLM 模块（唯一选中 LLM，上游扩展点 core/providers/llm/lumithink/lumithink.py）
    → 受保护内部传输（UDS + 令牌首帧认证，无 TCP 选项）
      → 接线组合（voice-gateway-wiring.ts）→ 既有 Adapter（GatewayCorePort）
        → Orchestrator → 真实 Bridge IPC（UDS）→ 锁定版 DSH runtime（#52）
      ← fence 后安全句子（Output Gate 准入即投递）
    ← tts_text_queue → 上游 TTS 引擎 → Opus → 设备（上游原生路径不动）
```

### 8.1 鉴权握手与服务端可信映射（验收 2）

- 桥把服务端**已核验连接**的真实 `Device-Id/Client-Id/Authorization` 原样转交 `device_hello` 帧；网关侧按钉死 commit `core/auth.py` **逐字复算**上游 AuthManager 方案（HMAC-SHA256 over `client_id|device_id|ts`、共享 `auth_key`、新鲜度、constant-time 比较）。**凭证不得仅凭 MAC 派生**：MAC 之外必须持共享密钥签名 + 未过期时间戳 + 监护人绑定；验证通过后绑定 activation digest 才成为 Adapter 层持有凭证（§2.1 预告的"传输层映射"落点）。
- 失败路径全部枚举化：令牌缺失/坏签名/过期 → `device_possession_denied`；未绑定 → `device_unbound`；重复连接 → `device_connection_conflict`（第二连接被服务端边缘关闭，第一连接不受影响——§5 `duplicate_connection` 合成结论的实进程复核）；伪造 session → `session_forged`；全部附 `device_drop` 帧。
- 连接令牌绑定受保护内部传输：per-deployment 传输令牌只在 UDS/管道上被接受（0600 socket、无 TCP 选项、单桥租约），没有文件系统访问权令牌即无效。内部监听不暴露任何网络端口。

### 8.2 事件与音频桥接（验收 1/3）

- `turn_prompt`（ASR final，瞬态文本 ≤512）→ Input Safety Gate → 瞬态通道（§2.3）→ Orchestrator 轮；`turn_started{connId,turnId,epoch}` 供桥侧关联，`prompt_rejected{code}` 为枚举拒绝（输入门命中是**结果**而非传输故障，连接保持）。
- TTS 发送栅栏：句子仅在 stream gate 准入（Output Gate + `tts_queue` fence）后交付；`abort` → fence-first epoch 提升（接线态对无 playback 绑定的 RUNNING 轮由组合层强制 barge-in——合成合同"无播放 abort=no-op"只假设 pump 时投递）→ 旧 epoch 句子结构性不可达；已入服务端队列由上游 native `clear_queues()` 清空 + 网关 `queue_clear` 帧 belt-and-braces；`tts_end{completed|interrupted|failed}` 保证桥侧流终止（零句输出轮也交付）；`failed` 补发端侧 stop。
- **真实音频记账（解决 frameCount/audioDigest 占位）**：fork patch 3/5 在 `_do_send_audio` 逐包计数 + SHA-256 实际发往设备的 Opus 字节；utterance stop/abort 时 `audio_delivered {frames, digest}` 上报 → Adapter v1.4 `realAudioFramesDelivered`/`realAudioDeliveries` + 审计（内容无关）。**协议面不存在音频字节字段的零泄漏不变量保持不变**——占位由真实到账观测解决。
- 帧序保证：全部外发帧经单一 FIFO 控制线程（上游 abort 流程严格先于下一轮 chat 提交 → abort 帧必然先于下一轮 `turn_prompt`）。
- server_restart：桥重连（新连接 = 新服务实例）→ 网关关闭全部旧租约 + 播放挂起（§3 断线行语义的真实触发面）；重连凭受信绑定续接同一 sessionKey。

### 8.3 已验证 / 未验证边界（如实声明）

| 项 | 状态 |
| --- | --- |
| 桥 LLM 经上游扩展点唯一选中、内置 AI 第二路径不可达 | **已验证**（真实服务端进程联测，`e2e-07-gateway-wiring-gate.yml`；超时=接线失败，无回退） |
| 受保护 UDS 传输 + 令牌 + 单桥租约 + 0600 | **已验证**（真实 UDS；Windows 开发沙箱按文档边界回退帧注入，字节层另测） |
| 设备鉴权映射（未绑定/伪造/重复连接/坏令牌拒绝） | **已验证**（真实进程 + 契约级单测） |
| hello→session→detect(text)→stt→Output Gate 句子→TTS→**真实 Opus 下行**→stop | **已验证**（协议模拟设备，本地 TTS stub；合成样例文本） |
| **agent 运行时口径**：接线面（传输/鉴权/租约/fence/帧序/记账）在合成 Cordis 运行时档全部真实；**E2E-08（issue #58）起 real 档接入 CI 接线环**——同一钉死服务端换档 `LUMITHINK_GATEWAY_AGENT=real` 重跑全链路，锁定版 DSH worker 子进程在环内应答（装配/piped-child 守卫/存活记账在环内执行；注入 `agentPort` 的组合层转发由"占据 Bridge 上游座位"回归测试守卫）；worker 机制二分锚仍为 E2E-02 gate（同 HEAD） | **已验证（分层如实声明）** |
| 播放中 abort → stop 零迟到帧；服务重启续接同一受信会话 | **已验证**（真实进程） |
| 真实音频字节到账（frames+digest）进 Adapter v1.4 指标 | **已验证**（内容无关记账） |
| 真实固件设备端到端（实机） | **未验证**（#E2E-08） |
| 真实 ASR 音频上行→转写→网关（本档位 ASR 为回环占位；detect+text 与 ASR final 共用同一 `startToChat→chat` 入口） | **未验证** |
| 真实供应商 LLM/ASR/TTS 组合档位（各自单独评审） | **未验证** |
| 服务端 AEC / 二进制协议 v2/v3 / 断网实机时延 | **未验证** |

本 Issue 不创建 Tag/Release；Mock 与合成数据验证不标注为真实设备验收。

## 9. 打断实测面（1.4 增补，issue #59 / E2E-09）

本节不改 §2 的 Adapter 合同——它把 §2.4 的"播放停止/打断"从**单次负例证明**（§5 `consecutive_abort` 合成族、E2E-07 单发 abort fence）升级为**多轮客观测量 + 实机验收合同**。载体：`deploy/xiaozhi/probe_e2e09.py`（协议模拟设备测量仪器）、`tests/server/voice-gateway-barge-in.spec.ts`（接线栈回归）、[runbook §12](../deploy/xiaozhi/runbook.md)（物理面）。

### 9.1 测量合同（自动化面）

- **每轮打断试验的可观测序列**（v2.5.2 线协议，内容无关）：`listen detect` → 真实 Opus 下行 → 线协议 `abort`（§1 术语即 client_abort）→ `tts stop` → **stop 后零音频/零 sentence_start**（迟到帧结构性为 0）→ 恢复 `listen detect` → `stt` 回显 + 真实 Opus 下行 + `tts stop`（completed）。恢复轮必达音频是对上游 [xinnan-tech issue #743](https://github.com/xinnan-tech/xiaozhi-esp32-server/issues/743)（"打断后收不到后续语音二进制"）的**服务端半边**复核；设备半边（扬声器实际恢复发声）归 runbook §12.4。
- **变体**：同连接连续抢话（连续两轮打断后恢复——每轮恰好一次 stop，无重复 epoch 提升）、延迟打断（若干音频帧后才发出 abort——网络抖动代理）、空闲 abort（无播放打断——误打断的协议代理；服务端是否回 stop **只记录不判定**）。
- **指标（候选基线，非 SLA）**：`abort_to_stop_ms`（abort 发出 → tts stop 到达）、`recovery_first_audio_ms`（恢复 detect → 恢复轮首个音频帧）；P50/P95/P99 只**采集打印**不作门禁。**硬门禁**是结构不变量：每轮必达 stop、零迟到帧、恢复轮必达音频、失败按枚举类别（`no_stop_after_abort` / `late_frames_after_stop` / `recovery_no_audio` / `recovery_timeout` / `connection_lost` / `no_playback_start`）。
- **接线栈零漏出回归**（Node 套件）：打断轮结算 **CANCELLED**；abort 之后传输上不出现旧 turn 的句子、不出现旧 epoch 的任何句子帧（§2.2 "晚到的旧轮 delta/TTS 在双层栅栏拒绝"的接线面回归）；无播放 abort 保持枚举化良性（无 epoch 提升）；恢复轮在提升后的 epoch 上完成。旧轮记忆写入为 0 由 CANCELLED 结算在 R1-V1 Orchestrator 合同下结构性成立（`tests/domain/voice/race.spec.ts` 既有证明）。
- **agent 运行时口径**：synthetic 与 real 档（真实锁定版 DSH worker）各跑一组打断测量——打断/恢复路径依赖的 Bridge cancel 语义在 real 档接线环内执行。

### 9.2 实机验收合同（物理面，归 runbook §12）

- 真实固件 AEC 的**效果**（回声抑制对照录音/转写）与**打断可靠性**（≥100 次播报中打断试验：成功率/误打断率/P50/P95/P99/失败类别/可复现步骤）只能在真机上产生，CI 与本文档**不代领、不标 PASS**；门限在试验前冻结（runbook §12.3），Mock/探针毫秒数永不充当实机门限。
- 服务端 AEC 链路的代码事实（@ pinned commit）：hello `features.aec=true` → `conn.client_aec` → 播放中 VAD 出人声自动 abort；**普通 WebSocket 下行无服务端回声对消（参考缓存仅 MQTT 网关分支）——回声对消只能来自设备侧**。设备 hello 的 `features.aec`/`audio_params` 实际取值随 runbook §12.2 实录。
- 未达冻结门限时按 runbook §12.8：阻止 Release 或用户显式决定按键中断降级；不虚构全双工能力。

## 10. 可靠性回归面（1.4 增补，issue #61 / E2E-11）

本节不改 §2/§8 的 Adapter 合同——它把 §3 兼容矩阵的合成故障族与 §9 打断测量升级为**接线环故障注入矩阵 + 组合栈挂起/洪泛回归 + 实机可靠性验收合同**。载体：`deploy/xiaozhi/probe_e2e11.py`（协议模拟设备可靠性探针）、`tests/server/e2e11-reliability.spec.ts`（组合栈回归）、[runbook §14](../deploy/xiaozhi/runbook.md)（物理面）。

### 10.1 测量与注入合同（自动化面）

- **长稳轮次时延分解**（候选基线，非 SLA）：`stt_echo_ms`（detect → `stt` 回显）、`first_sentence_ms`（detect → 首个 `sentence_start`——**LLM 首安全短句代理**，句子已过儿童 Output Gate）、`first_audio_ms`（detect → 首个真实 Opus 下行帧）、`turn_total_ms`（detect → `tts stop`）。唤醒→ASR 无线上等价物，归物理面（§14.4）。P50/P95/P99 只采集打印不作门禁。
- **故障注入（设备传输面，真实 agent 档接线环内）**：`wifi_drop`（播放中**硬断连**——无 abort 的非自愿掉线代理 → 重连重试 → 恢复轮必达音频与 stop；重连后自身 detect 之前的音频**只记录不判定**——当前 epoch 续播语义如实披露）、`cancel_flood`（播放中 abort + 洪泛 burst → 恰一次 stop → **零迟到帧** → 空闲洪泛 recorded → 恢复轮必达；§9 单发 abort 的洪泛升级）、`server_restart`（探针在播放中执行**运营者提供**的重启命令 → 连接必断（若轮次先完成即 `restart_no_disconnect` 失败——命令必须真实生效）→ 重连重试 → 恢复轮必达）。重复设备会话不重复探——`probe_e2e07.py --expect-duplicate-refusal` 既有证明（§8.1）。
- **组合栈回归**（Node 套件，`pnpm test`）：模型挂起 → 网关超时清扫 `TIMED_OUT`（`sweepTimeouts` 语义：`RUNNING`/`CANCELLING` 超预算即终态）→ 设备恰一次 stop → **迟到流完全良性**（`fenceOutput` 对终态轮 `turn_terminal` 拒绝——迟到 delta/队列/audio_send 全部栅栏，无复活、无迟到帧）；取消洪泛每播放轮恰一次 fence；**真实 SQLite 栅栏存储**洪泛下重启单调（epoch 不重置不分叉、已取消轮不复活、post-fence 写入 `stale_turn_rejected`/`turn_terminal` 枚举拒绝、陈旧 TTS 队列 `droppedStale` 清空）。
- **失败类别枚举**：`no_stt_echo` / `turn_incomplete` / `no_playback_start` / `no_stop_after_abort` / `late_frames_after_stop` / `recovery_no_audio` / `recovery_timeout` / `connection_lost` / `reconnect_timeout` / `restart_no_disconnect`。
- **agent 运行时口径**：探针在 CI 的真实档（`LUMITHINK_GATEWAY_AGENT=real`）接线环内执行——故障注入穿越真实桥接重连路径（bridge 模块每轮 `ensure_connected`）。

### 10.2 实机验收合同（物理面，归 runbook §14）

- 真实设备的故障矩阵（Wi-Fi 断开/重连、WS 重绑、服务进程重启、DSH/ASR/TTS/LLM 不可用、取消洪泛、重复设备会话、OTA 失败/回退若已配置）、≥100 轮成人/合成对话（成功率/失败类别/P50/P95/恢复时间/费用）、安全核验（激活凭据轮换/安全 WSS-IPC/外发白名单/清理策略）与空环境重建/回滚/控制面留证只能实机产生，CI 与本文档**不代领、不标 PASS**（runbook §14.2–§14.6）；门限冻结纪律沿用 §12.3。
- 未执行前 issue 保持 OPEN（#58/#59/#60 先例）；合成/Mock 指标不得冒充真模型/真实硬件性能。
