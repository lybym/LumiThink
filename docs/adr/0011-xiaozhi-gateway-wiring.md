# ADR-0011：小智服务端 Voice Gateway 接线——LLM 扩展点桥、受保护内部传输与服务端可信映射

> 决策日期：2026-10-17 ｜ 状态：**已采纳（接线 + 真实进程联测范围；实机验收未完成）**
> 关联：[Issue #57](https://github.com/lybym/LumiThink/issues/57) · [Issue #54](https://github.com/lybym/LumiThink/issues/54) · [Issue #55](https://github.com/lybym/LumiThink/issues/55) · [Issue #56](https://github.com/lybym/LumiThink/issues/56) · [Issue #52](https://github.com/lybym/LumiThink/issues/52) · [ADR-0009](./0009-real-asr-provider-transient-channel.md) · [ADR-0010](./0010-real-tts-provider-dual-stream.md) · [VOICE_GATEWAY_PROTOCOL §8](../VOICE_GATEWAY_PROTOCOL.md) · [deploy/xiaozhi/fork-patches.md](../../deploy/xiaozhi/fork-patches.md) · 父 Epic [#50](https://github.com/lybym/LumiThink/issues/50)

## 背景

E2E-04/05/06（#54/#55/#56）交付了钉死小智服务端的部署与真实 ASR/TTS 供应商档位，但 LumiThink 的 Voice Gateway Adapter 与服务端之间**没有真实接线**：设备音频 → ASR → （内置 LLM）→ TTS → Opus 的服务端内部路径仍是小智自带 AI；Adapter 合同的音频面只有 `frameCount/audioDigest` 合成占位；设备鉴权握手材料从未映射到监护人绑定。Issue #57 要求把 `xiaozhi-esp32-server` 的**实际内部消息/音频路径**对接 Voice Gateway Adapter、Turn Orchestrator 与真实 DSH（锁定版 Cordis runtime，#52），并满足：

- ASR final、hello/session、abort、TTS start/stop/队列清空与回流音频的双向桥接；
- 设备鉴权握手与服务端可信映射：真实 `Device-Id/Client-Id/Authorization` → 监护人绑定/activation proof，凭证不得仅凭 MAC 派生；连接令牌绑定受保护的内部传输；
- 真实事件到既有 `GatewayCorePort`、Bridge UDS（禁止 in-process mock）、TTS 音频发送栅栏；解决 Adapter 音频占位；
- 特别修补/测量 server_restart 会话鉴权清理、内部监听访问限制、`abort`/`client_abort` 语义、断网续接，并屏蔽默认内置 AI 第二路径；
- 尽量不改上游核心并登记必要 fork patch。

## 决策

1. **桥接点 = 上游 LLM 扩展点（零核心改动的认知路径）+ 5 个登记的 fork hook。** 钉死 commit 的 `core/utils/llm.py` 按 `selected_module.LLM` 的 `type` 加载 `core/providers/llm/<type>/<type>.py` 并实例化 `LLMProvider(config)`。新模块 `deploy/xiaozhi/gateway_bridge/lumithink_llm.py`（安装为 `core/providers/llm/lumithink/lumithink.py`）实现该接口：`response(session_id, dialogue)` 只取**最后一条 user 消息**（设备 ASR final），经受保护内部传输提交给 LumiThink，把返回的 Output-Gate 句子逐个 yield 回上游（上游自己的 TTS 引擎→Opus→设备路径保持不动）。`selected_module.LLM = LumithinkBridgeLLM` 是唯一选中的 LLM、`read_config_from_api: false`——**内置 AI 第二路径在结构上不可达**。事件 tap（hello/abort/音频记账/设备关闭）为 5 个最小 fork hook（逐字锚点、try/except 包裹、机器镜像 `install_bridge.py`，登记于 `fork-patches.md`）。
2. **受保护内部传输 = UDS/named pipe + 长度前缀 JSON 帧 + 令牌首帧认证；无 TCP 选项。** `lib/server/voice-gateway-internal-transport.ts`（镜像 R1-V2 Bridge IPC 的纪律：字节上限、fail-closed 解析、单桥租约、0600 socket）。**连接令牌绑定受保护的内部传输**：per-deployment 令牌（render/env 注入、按 env 名引用）仅在 UDS/管道上被接受——没有文件系统访问权即令牌无效。全部外发帧经**单一 FIFO 控制线程**：上游 abort 流程严格先于下一轮 chat 提交，因此 abort 帧必然先于下一轮 `turn_prompt` 到达网关（新轮不被旧 abort 误栅栏）。
3. **设备鉴权握手与服务端可信映射 = 网关侧逐字复算上游 AuthManager 方案。** 桥把服务端**已核验连接**的真实 `Device-Id/Client-Id/Authorization` 原样转交（`device_hello` 帧）；网关侧 `verifyDeviceAuthorization` 按 `core/auth.py @ 27399a2` 逐字重算（HMAC-SHA256 over `client_id|device_id|ts`，共享 `auth_key`，新鲜度窗口，constant-time 比较）。**凭证不得仅凭 MAC 派生**：MAC 之外必须持共享密钥签名 + 未过期时间戳 + 监护人绑定记录；通过验证后，绑定记录的 activation digest 才作为 Adapter 合同层的持有凭证（§2.1 的"传输层把设备激活材料映射为 hello 凭证"）。鉴权失败/未绑定 → 枚举拒绝帧 + `device_drop`（桥关闭该设备 WS——服务端边缘强制 Adapter 租约）。
4. **TTS 音频发送栅栏 = 准入即投递 + epoch 结构性不可达。** 句子交付挂在 stream gate 准入点（Output Gate + `tts_queue` fence 之后；`onAdmittedSentence` 为**可选**增量，缺省合成合同逐字节不变）：fence 通过的句子才进 `tts_sentence` 帧。设备 abort → 网关 fence-first（epoch 提升，接线态由组合层对无 playback 绑定的 RUNNING 轮强制 barge-in——合成合同"无播放 abort=no-op"只假设 pump 时投递）→ 旧 epoch 句子在 gate 处结构性不再产生；已入服务端队列的由上游 native `clear_queues()` 清空（patch 2 之后网关 `queue_clear` 帧为 belt-and-braces）。`tts_end(completed|interrupted|failed)` 保证桥侧流终止（含零句输出轮）；`failed` 补发端侧 stop。
5. **解决音频占位 = 真实字节记账回流（协议面仍无音频字节）。** fork patch 3/5 在 `_do_send_audio` 逐包计数 + SHA-256 实际发往设备的 Opus 字节；utterance stop/abort 时 `audio_delivered {frames, digest}` 上报，Adapter v1.4 记录为 `realAudioFramesDelivered`/`realAudioDeliveries` + 审计（内容无关）。LumiThink 协议面不存在音频字节字段的不变量保持不变——"占位"由**真实到账观测**解决，而非把音频字节引入合同。
6. **Node 侧接线组合（`lib/server/voice-gateway-wiring.ts`）**：既有 `VoiceGatewayStack`（真实 Bridge IPC，`transport:"ipc"`）+ 注入 REAL agent port（`poc/dsh-child` 锁定版 DSH worker 子进程，#52 模式）+ 内部传输服务器；帧路由 fail-closed，快照/审计全部内容无关。CI 宿主 `scripts/xiaozhi/gateway-host.ts` 打印就绪行后常驻。联测纪律：**禁止 in-process mock**——内部传输在 POSIX CI 用真实 UDS，Windows 开发沙箱（socket 打开被 OS 拒绝的文档边界）才回退到服务端帧入口注入，字节层由独立套件 + POSIX CI 承担。
7. **CI = 新增 `e2e-07-gateway-wiring-gate.yml`（PR body"CI 变更"披露）**：artifacts 档（py_compile、档位模板断言、env 无真实值、fork 登记一致性、版本钉死单源、安装器合成树演练）+ `wiring-e2e` 档（干净 Linux：bootstrap gateway-bridge 档位 → 装桥 + patch → 起 TTS stub + 网关宿主（真实 UDS 0600 + 真实 Bridge IPC）→ 起服务端 → 协议模拟设备**全链路**：hello→session→detect(text)→stt 回显→tts start→sentence_start→**真实二进制 Opus 下行**→tts stop；重复设备连接拒绝；播放中 abort → stop 且零迟到帧；服务重启 → 重连 → 同一受信会话续接）。**agent 运行时分层（宿主 `LUMITHINK_GATEWAY_AGENT` 选择器）**：CI 联测用 LumiThink **合成 Cordis 运行时**（确定性、pump 驱动——接线面全部真实：受保护传输/鉴权映射/租约/fence/帧序/记账）；**锁定版 DSH runtime 的 CI 证明由 E2E-02 gate（poc/dsh-child，同 HEAD，随本 PR 每轮 CI 均绿）承担**，`real` 档为运营者显式 opt-in（同 job 内 E2E-02 规格演练通过，worker 机制已证）。零真实凭据、零外发（ASR 保持回环占位、TTS 为回环 stub、LLM 路径即本地受保护传输）。超时 = 接线失败，绝无静默回退。

## 备选取舍

| 方案 | 取舍 |
| --- | --- |
| 反向：小智把音频字节推给 LumiThink、由 Adapter 下发设备 | 违反"协议面无音频字节"不变量 + 第二条音频路径绕过服务端流控/流控器；否决 |
| Patch 上游 textHandle 直接转发 stt（不经 LLM 扩展点） | 需要重接 TTS 触发链（tts_text_queue/sentence_id/流控），改动面大且与上游 chat/abort 状态机重复；LLM 扩展点是上游官方 seam，零核心改动；否决 |
| 网关侧开 TCP + TLS 取代 UDS | 内部传输仅限本机同宿主；TCP 扩大监听面且 UDS 文件权限已提供认证；`bridge_auth` 令牌叠加防御；无 TCP 选项（同 Bridge IPC）；否决 |
| 设备直连 LumiThink（旁路小智） | 设备协议/OTA/ASR/TTS 全在钉死服务端，绕过即丢失 #54-#56 全部已验证面；否决 |
| fork hook 直接 import 桥模块 | 事件循环内阻塞风险 + 双向依赖；hook 一律 `getattr(conn.llm, "lumi_on_*")` 反射（桥未装时为 no-op）；否决硬依赖 |
| 监听事件（listen start/detect）也转网关 | 再加 patch 6/7 只服务于 ASR 去重窗口的边缘语义（2s 窗内同文本保守并轮，ADR-0009 已接受方向）；失败安全方向正确；本 Issue 不引入，登记为未验证边界 |

## 约束 / 后果

- **已验证（真实 Linux 进程联测，CI 可复现）**：桥模块经上游扩展点被唯一选中；受保护 UDS 传输 + 令牌 + 租约；设备鉴权映射（含伪造/未绑定/重复连接拒绝）；全链路 hello→文字轮→Output Gate 句子→服务端 TTS→**真实 Opus 下行**→stop；abort 栅栏（零迟到帧）；服务重启续接同一受信会话；真实音频字节到账记账。**agent 运行时口径**：CI 联测轮次由 LumiThink 合成 Cordis 运行时应答（接线面全部真实）；锁定版 DSH runtime 的 CI 证明 = E2E-02 gate（同 HEAD 绿），`LUMITHINK_GATEWAY_AGENT=real` 为运营者 opt-in 路径。
- **未验证（如实边界）**：真实固件设备（#E2E-08）、真实 ASR 音频上行（本档位 ASR 为回环占位；detect+text 路径与 ASR final 共用同一 `startToChat→chat` 入口，但"麦克风音频→转写→网关"整段未联测）、真实供应商 LLM/ASR/TTS 组合档位（各自单独评审）、断网-续接的实机时延、服务端 AEC/二进制协议 v2/v3。本 Issue 不创建 Tag/Release，不标注实机 PASS。
- `GATEWAY_ADAPTER_VERSION` 1.3 → 1.4（新增真实音频记账字段 + `asr_final` 结果带出 turnId；既有语义零变化，合成合同逐字节不变）。
- 上游升级（pin bump）必须重跑 `fork-patches.md` 锚点核验（`install_bridge.py` 漂移即拒绝）与 §3 兼容矩阵评审。
- 桥侧"一个 connId = 一条设备连接"与上游"同设备多 WS 并存"的差异由网关租约裁决（第二连接被服务端边缘关闭）；`server_restart` 由桥重连语义触发（新桥连接 = 新服务实例 → 全部旧租约失效 + 播放挂起）。
