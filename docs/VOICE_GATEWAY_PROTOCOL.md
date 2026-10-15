# Voice Gateway Adapter：小智 v2.5.2 协议兼容矩阵与合同（R1-V3）

> 版本：1.1 ｜ 2026-10-15 ｜ Issue [#30](https://github.com/lybym/LumiThink/issues/30)，1.1 修订 Issue [#51](https://github.com/lybym/LumiThink/issues/51) ｜ **合同 + 合成验证；固件/服务端兼容与私有 OTA 均【未实机验证】**
> [VOICE_RUNTIME](./VOICE_RUNTIME.md) · [ADR-002](./adr/0002-voice-runtime-bridge.md) · [ADR-007](./adr/0007-asr-transient-text-channel.md) · [硬件选型](./VOICE_HARDWARE.md) · [Roadmap R1-V3](./ROADMAP.md)

## 1. 固定评估基线（版本/契约钉死）

| 层 | 固定基线 | 依据（2026-10-15 查阅） |
| --- | --- | --- |
| 端侧固件协议 | `78/xiaozhi-esp32` tag **`v2.5.2`**，WebSocket 协议文档（该 tag 内 `docs/websocket.md`） | <https://github.com/78/xiaozhi-esp32/blob/v2.5.2/docs/websocket.md> |
| 自建服务端 | `xinnan-tech/xiaozhi-esp32-server`，评估时 main 提交 **`27399a2fb64b5910196f438a256ce0a9f868481f`**（最新 tag `v0.9.7`）；适配层语义核对 `abortHandle.py` / `helloHandle.py` / `connection.py` | <https://github.com/xinnan-tech/xiaozhi-esp32-server> |
| 上行音频 | Opus，16 kHz，单声道，60 ms 帧（firmware hello `audio_params`） | 同上协议文档 §1/§8 |
| 下行音频 | Opus，**由服务端 hello 协商**（文档注明服务端可用 24 kHz）——适配层不写死采样率 | 同上协议文档 §8.3 |
| 代码内钉死 | `XIAOZHI_GATEWAY_BASELINE`（`lib/domain/voice/adapter/protocol.ts`），schema 测试断言版本/提交不可漂移 | `tests/domain/voice/adapter/protocol.spec.ts` |

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
- **零泄漏不变量**：文本不入普通日志/审计/快照/错误包/制品；审计 detail 只有枚举码或 64-hex 密钥化摘要；schema 测试断言字段 allow-list，泄漏扫描断言合成标记在全部内容无关表面零出现（唯一允许位置 = Fake Agent 收到的获批模型请求）。

### 2.4 播放停止 / TTS 队列清空 / Opus 发送（验收 1）

- `abort` → **fence 先行**（`core.bargeIn` = 组合层 `bargeInCancel`：原子 epoch 递增 → Bridge 进程内真取消 + `whenIdle` 复核 → CANCELLED）→ 才发 `tts.stop{reason:"interrupted"}`（每 turn 恰好一次）→ `drainTts` 丢弃全部旧 epoch 队列项并回执 `tts.clear{droppedStale}`。
- 连续抢话：无播放中的 abort 是枚举化 no-op（`no_active_playback` 语义，无第二次 epoch bump、无重复 stop——"不是每一帧 VAD 都提升 epoch"）。
- 出站帧批：`drainTts` 只交付当前 epoch 队列项 → 每批再过 `fenceOutput(kind:"audio_send")` 深度防御 → `tts.frames{frameCount, audioDigest}`（**帧数 + 十六进制摘要，协议内不存在音频字节字段**，真实编解码属 R5）。

## 3. 兼容矩阵（v2.5.2 线协议 × Adapter 合同）

状态含义：`合同+合成已验` = 本 PR 的 schema/行为测试覆盖（纯合成数据）；`未实机验证` = 需要 R5 硬件/真实服务端才能确认，本 PR 不写 PASS。

| v2.5.2 报文 | 方向 | Adapter 合同映射 | 状态 |
| --- | --- | --- | --- |
| `hello`（version=1, features, audio_params） | 设备→服务端 | 握手头鉴权（Authorization/Protocol-Version/Device-Id/Client-Id 归传输层，叠加防御）**+ 合同内持有凭证**：hello 携带激活摘要与绑定记录比对，缺失/不符 `device_possession_denied`；hello 事件驱动绑定 + 连接租约 | 合同+合成已验；实机握手 未实机验证 |
| `hello` ack（含 `session_id`） | 服务端→设备 | `session_issued` → 连接级映射铸造 | 合同+合成已验；未实机验证 |
| `listen` start/stop/detect（mode auto/manual/realtime） | 设备→服务端 | 语音状态计数；**播放中 detect 仅计为打断候选，不栅栏** | 合同+合成已验；未实机验证 |
| `abort`（reason: wake_word_detected/manual/vad_detected）——即 issue 所称 client_abort | 设备→服务端 | fence 先行打断：epoch 递增 → 端侧 `tts.stop(interrupted)` → 队列清空 | 合同+合成已验（56 场景）；实机打断 未实机验证 |
| ASR partial（自建服务端流式 ASR 内部事件） | 服务端内部 | `asr_partial` 有界瞬态事件：只计数/候选，不产生 prompt | 合同+合成已验；真实流式 ASR 行为 未实机验证 |
| `stt`（text，ASR 终稿） | 服务端→设备 | `asr_final`：长度受限 + Input Safety Gate → 授权瞬态明文走 §2.3 通道（vault → `turn.prompt` v2 `promptText` → 受信 Agent）；去重指纹为 HMAC-SHA256（§2.3） | 合同+合成已验（`transient-channel.spec.ts`）；未实机验证 |
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

- [ ] 单模块服务端部署与版本钉死（评估基线 `27399a2`，升级需重跑本矩阵）。
- [ ] 第三方 ASR/TTS/LLM 供应商安全与保留评估、告知同意流程（[VOICE_HARDWARE §3](./VOICE_HARDWARE.md)）。
- [ ] 私有 OTA 激活/升级/回滚演练；断网-重连-重激活全链路。
- [ ] 真实无线环境下断线重连、重复连接、session_id 轮换行为复核（对照 §5 合成结论）。
- [ ] Adapter 组合层真实 IPC 传输冒烟（POSIX-only，沿用 `voice-bridge-ipc.spec.ts` 的 SKIP 模式）：当前 5 个适配层套件固定 `transport:"in_process"`，`ipc` 路径由 R1-V2 Bridge 套件间接覆盖，Adapter 组合层自身无 IPC 用例（评审登记项，非本 PR 阻塞）。

## 7. R5 验收基线（本 PR 之后的状态声明）

以下为 R5 实机验收入口清单（**当前全部未开始、未验证**）：思考中打断、播放中打断、连续抢话、服务重启、断网恢复、私有化设备激活/OTA、完整语音闭环（ASR → Gateway → DSH Bridge → 安全短句流 → TTS）。本 PR 交付的是这些项的**合同、可重放合成证据与拒绝路径**；通过本 POC 不代表正式儿童语音可用，任何一项在实机验证前不得标注 PASS。
