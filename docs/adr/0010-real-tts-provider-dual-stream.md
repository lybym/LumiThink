# ADR-0010：真实 TTS Provider——钉死小智扩展点接入、双流合成与内容无关 TTS 证据

> 决策日期：2026-10-17 ｜ 状态：**已采纳（部署配置 + 合成验证范围；实机/服务器端解码播放验证未完成）**
> 关联：[Issue #56](https://github.com/lybym/LumiThink/issues/56) · [Issue #55](https://github.com/lybym/LumiThink/issues/55) · [Issue #54](https://github.com/lybym/LumiThink/issues/54) · [Issue #53](https://github.com/lybym/LumiThink/issues/53) · [ADR-0009](./0009-real-asr-provider-transient-channel.md) · [VOICE_GATEWAY_PROTOCOL §2.4](../VOICE_GATEWAY_PROTOCOL.md) · [deploy/xiaozhi/runbook §3.6](../../deploy/xiaozhi/runbook.md) · 父 Epic [#50](https://github.com/lybym/LumiThink/issues/50)

## 背景

E2E-05（Issue #55，ADR-0009）交付了真实流式 ASR 的部署档位与激活门禁；TTS 侧仍是 gateway-minimal 的回环占位（`CustomTTS` 指向 discard 死端口，fail-loud）。Issue #56 要求在自建小智服务端接入**真实 TTS**，交付可播放的语音字节流，而非 R1-V 合成 POC 的帧数/摘要占位。约束：

- 合成、Opus 下行编码与流式下发全部发生在**钉死 commit 的小智服务端内部**（其 `selected_module.TTS` Provider 扩展点）；LumiThink 协议面不存在音频字节字段（`tts.frames{frameCount,audioDigest}`，VOICE_GATEWAY_PROTOCOL §2.4）；
- 上游以 INFO 打印合成句文本（`tts/alibl_stream.py` @ `27399a2f…`："句子语音生成成功： {tts_text}"）——**默认不得在日志/异常/消息队列保存合成正文**必须由配置达成，且残余如实披露；
- 打断/取消后旧 epoch 音频必须 0 送出（fence + 队列清空已由 R1-V1/V3 承载）；慢 TTS/乱序/解码错误不得漏出旧轮；
- 真实儿童数据的外发评审未做（沿用 Issue #53 常量闸门）；CI 不得产生真实供应商出网。

## 决策

1. **供应商路径 = 钉死小智扩展点，LumiThink 不新增供应商客户端。** 首供应商 `AliBLStreamTTS`（`type: alibl_stream`，阿里云百炼 CosyVoice 双流 TTS，`InterfaceType.DUAL_STREAM`；与 #55 的真实 ASR 同供应商族——安全/保留/外发评审、dashscope 锚点与 API-Key 生命周期同源延伸）。新档位 `deploy/xiaozhi/config/gateway-tts-real.yaml`（gateway-minimal 安全骨架 + 仅 TTS 变更；**ASR/LLM 保持回环占位——TTS 评审不隐含 ASR/LLM 评审**，组合档位留待后续 Issue 显式评审），由 `bootstrap.sh --template` 显式选档，**禁用 = 重渲染缺省档位**。
2. **评审锚点 = 上游硬编码默认端点（逐字核验）。** 模板刻意省略 `ws_url` → 上游 `core/utils/alibl_endpoint.py` 的 `DEFAULT_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/"`（尾斜杠为钉死默认值原样；与 #55 ASR 锚点同主机族，ASR 硬编码无尾斜杠——两者都逐字记录、绝不归一化）。上游 `resolve_ws_url` 同时 fail-closed 校验只接受阿里云官方 WSS 推理端点；任何模板覆盖 `ws_url` = 重跑外发评审（CI/测试断言模板无 `ws_url` 覆盖）。供应商事实逐字核验 @ pinned commit：`model` 默认 `cosyvoice-v2`、`voice` 默认 `longxiaochun_v2`、`format` 默认 `pcm`、`api_key` 缺失即 raise（fail-loud）、请求携带 `sample_rate: self.conn.sample_rate`（下行协商值，永不供应商侧改写——16/24 kHz 协商语义见 VOICE_GATEWAY_PROTOCOL §1）。
3. **音频/文本不落盘三闸（模板强制，CI/测试断言）**：`delete_audio: true`（上游 TTS base 的双流分支不写 tmp 音频文件；文件分支不进入）；`read_config_from_api: false`（上游 `reportHandle` 的 ASR/TTS 上报队列结构性 never enqueue）；`log_level: WARNING`（INFO 合成句日志全部抑制）。**残留（接受并披露）**：WARNING 以上异常路径可能携带供应商侧错误详情（连接/鉴权失败，不含合成正文）；loguru 文件 handler `diagnose=True` 为钉死代码——日志按敏感面对待（journald 权限/轮转），见 runbook §3.6。
4. **激活记录 fail-closed（`lib/server/real-tts-composition.ts`）**：`LUMITHINK_TTS_ROUTE=mock|real`（缺省 mock；CI 显式断言为空）；`real` 要求完整供应商记录——评审锚点端点（必须逐字等于钉死默认值，漂移即拒绝）、模型 id、音色、下行协商采样率（16000|24000）、外发评审记录（reviewer/reason）；问题只列变量名。**Key 不是本模块的输入**：凭据只存在于部署档位渲染期（`XIAOZHI_TTS_API_KEY` → `render_config.py`，0600 产物），永不进入 LumiThink 运行时环境。
5. **设备侧 TTS 指标内容无关（Adapter v1.3）**：首音时延（final 接受 → 该 turn 首个帧批送达）、句间间隙、turn/句/帧计数、停止生效时延（abort 到达 → 端侧 stop 下发，含 fence 时间）、取消后残余音频抑制计数（fence 拒绝 + 队列丢弃，旧 epoch 送出结构上为 0）、hello 协商下行采样率。全部为计数/时延/枚举，零音频内容（schema 断言 + 泄漏扫描）；`GATEWAY_ADAPTER_VERSION` 1.2 → 1.3。
6. **证据记录内容无关（`buildRealTtsEvidenceRecord`，`voice-tts-real/1`）**：上述指标 + 零泄漏扫描结果；**服务器端"真实 TTS→Opus 可解码/播放、音色清楚"为运营者 opt-in（仅成人/合成样例）**——证据如实标注 `serverPlaybackVerification.performed=false`，绝不由 CI/本记录代领；`childDataEgressReviewStatus` 沿用 `not_performed` 常量。Mock 路由不调用任何外部 TTS。
7. **CI 零真实出网**：`e2e-04-xiaozhi-deployment-gate.yml` 对真实 TTS 档位只做解析、缺 key fail-closed 渲染与**合并后有效配置扫描**——不启动该档位、不连供应商；解码/播放与音色证据属运营者 opt-in 运行。

## 备选取舍

| 方案 | 取舍 |
| --- | --- |
| LumiThink 侧直连 TTS 供应商 API | 合成本属钉死小智服务端；LumiThink 再建一路 = 第二条不受控外发路径 + 协议面被迫引入音频字节；否决 |
| 选 EdgeTTS（免费无凭据） | 端点是钉死 commit 对 edge-tts 库的临时 monkey-patch（"临时把 WSS_URL 顶住"），锚点脆弱且无凭据生命周期可评审；选与已评审 ASR 同族的百炼 CosyVoice；否决 |
| gateway-tts-real = asr-real + TTS（累积档位） | 启用 TTS 会隐式启用真实 ASR，违背"档位 = 单一显式评审变更"；否决，组合档位留待后续 Issue |
| 在 gateway-minimal 上用 env 开关切换 TTS | "省略 = 禁用不成立"的递归合并语义下开关放大误配置面；否决（同 ADR-0009） |
| 证据记录采集音频时长/能量等客观音质指标 | 协议面无音频字节，任何"客观指标"都是合成值；解码/播放与音色判断属服务器端 opt-in 人工证据；改为如实标注 `performed=false`；否决 |
| 指标聚合进 metrics 快照的单一标量下行采样率 | 多设备可能协商不同采样率；按设备记录于 mapping 快照，证据源显式取值；否决强行聚合 |

## 约束 / 后果

- 真实 TTS 的服务器端解码/播放验证、音色主观确认、慢 TTS/乱序/解码错误的实机行为**未验证**（`serverPlaybackVerification.performed=false` 常量）；本决策交付部署配置、fail-closed 门禁、合成回归与内容无关证据合同；DoD 1 的服务器实测与样例属运营者 opt-in，实机验收归 #E2E-08/#E2E-09。
- `LUMITHINK_TTS_ROUTE=real` 的激活/证据记录当前仅被测试与证据路径消费；生产组合根接线与 E2E-03/05 同类（ADR-0008"约束/后果"已登记同类任务）——本记录的持有点是部署档位（`gateway-tts-real.yaml`）与评审锚点，而非主应用运行时开关。
- 首音/句间间隙/停止生效时延为**候选基线**（虚拟时钟可测），非 SLA；实机标定后按 VOICE_RUNTIME §9 口径另行采集。
- 真实儿童音频/文本外发在专项评审 + 监护人授权完成前**结构上不可用**（常量闸门）；本决策不宣告任何"真实 TTS 实机验收已完成"。
