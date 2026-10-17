# 语音硬件和私有化接入选型

> 更新：2026-10-17（§2.5 增补 issue #62） ｜ 状态：**目标硬件与语音平台已选；首版产品发布候选 1.0.0-rc.1 已组装；板级适配/实机验收未完成**  
> [总体架构](./ARCHITECTURE.md) · [实时语音设计](./VOICE_RUNTIME.md)

## 1. 当前确定选择

| 层 | 选择 | 状态 |
| --- | --- | --- |
| 麦克风阵列/DSP | **XMOS XVF3800 四麦克风阵列** | 目标硬件，待样机验证 |
| 主控 | **ESP32-S3**（可选 Seeed XIAO ESP32-S3 或自有板） | 目标硬件，具体引脚/PSRAM/Flash 待实测锁定 |
| 端侧协议/固件 | [78/xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) 小智主线 + XVF3800 板级适配 | 待移植与版本锁定 |
| 云端语音平台 | [xinnan-tech/xiaozhi-esp32-server](https://github.com/xinnan-tech/xiaozhi-esp32-server) 自建 Linux Server | 选型完成、部署联调未完成 |
| 认知引擎 | Lumi DSH Runtime Bridge → DeepSeek Harness | 设计选定，待验证 |
| ASR/TTS/LLM | 授权后可使用第三方 API | 供应商、外发与保留策略待审查 |

**术语**：芯片型号是 **XVF3800**，不是 XV3800。硬件芯片型号与固件软件协议应分别追踪。

## 2. 板级适配与固件

- XVF3800 的 AEC/波束形成/降噪工作在 XMOS 音频前处理侧；ESP32-S3 通过 **I2S** 收/送 PCM 音频，视板卡需要用 **I2C** 控制 DSP。服务端收到的是小智 WebSocket/Opus 流，不需要新增 XVF3800 识别逻辑。
- 公共示例：[Seeed-Projects/Xiaozhi_Esp32S3_reSpeaker](https://github.com/Seeed-Projects/Xiaozhi_Esp32S3_reSpeaker) 包含 `ReSpeakerAudioCodec`、I2S 输入/输出和 I2C 探测示例，**属于移植参考，不代表最新小智固件或任意 ESP32-S3 板卡已通过验证**。
- ESP32-S3 的具体 I2S GPIO、时钟主从关系、数据位宽/采样率、功放与喇叭反馈回路需根据实际板卡和 **XVF3800 使用的 I2S DSP 固件**确认；不能套用 XIAO 引脚到任意板。
- 当前已有机芯盒刷入的小智官方 v2.5.2 **不能推断**直接支持新 XVF3800 组合；须单独构建/烧录并记录小智提交 SHA、ESP-IDF 版本、DSP 固件版本及板级配置。
- **AEC 关键联调**：对消回声需要正确的播放参考信号及音频时序，验证播报中说话、跨声道串音、唤醒/打断识别；硬件提供降噪/AEC ≠ 已具备可用自定义唤醒词。
- 使用自建 OTA 和鉴权 WebSocket 接入，不应在正常激活、升级及会话中依赖 `xiaozhi.me` 或非自有 IoT 平台。

### 2.1 测试固件差异记录（E2E-04，issue #54——只记录，不改写固件）

现有测试固件 **`v2.5.2_nulllab-ai-vox-v3`** 与官方 v2.5.2 基线的来源级核验（2026-10-17 查阅，完整记录见 [deploy/xiaozhi/runbook.md §10](../deploy/xiaozhi/runbook.md)）：

- `78/xiaozhi-esp32` tag `v2.5.2` 树内即含官方板级 `main/boards/nulllab-ai-vox-v3/`（nulllab 官方说明确认 AI-VOX3 已并入上游官方版本）——该固件是**官方基线 + 官方树内板级配置**的构建，不是协议分叉；`main/ota.cc`、WebSocket 协议与激活流程不在其差异面内（差异仅板级文件/构建配置）。
- 板级要点：ESP32-S3 + ES8311，I2S 24 kHz；`CONFIG_USE_DEVICE_AEC` 端侧 AEC 可选（nulllab 默认开）；ML307 4G 备用网络。
- OTA 差异：v2.5.2 编译期默认 OTA URL 为 `https://api.tenclass.net/xiaozhi/ota/`；指向私有服务端需构建期覆盖 `OTA_URL`（**本 issue 不改写固件**，烧录与验证归 #E2E-08）。
- 激活差异：v2.5.2 设备侧 OTA 契约含可选 `activation{code,challenge}`（xiaozhi.me 六位码/HMAC 挑战流）；钉死的自建服务端单模块 OTA 只返回 `firmware` + `websocket`（HMAC token），**不返回 `activation` 对象**——私有部署不走 xiaozhi.me 激活链路，设备鉴权走 token。
- 未验证项（不提前宣称）：盒内实际烧录版本串、编译期 OTA_URL 实际值、`Activation-Version` 头形态、实机行为——归 #E2E-08 checklist。

### 2.2 E2E-08 实机接入状态（issue #58——自动化面闭环，物理项待实机）

- **自动化面已由 CI 证明**（`e2e-07-gateway-wiring-gate.yml`，E2E-08 起）：真实锁定版 DSH worker 子进程在接线环内应答 10 连轮全链路（`LUMITHINK_GATEWAY_AGENT=real` 换档，#57 review P1-1 清零）；有效 token 但无监护人绑定的设备在服务端边缘被拒（DoD 3 自动化面）；服务端重启续接；网关宿主启动器 scoped 静态类型检查（P1-2 清零）。执行与复现命令见 [runbook §11](../deploy/xiaozhi/runbook.md)。
- **物理面待实机**（runbook §11.2–§11.4 的记录表与实验协议）：盒内固件版本串/来源 SHA/ESP-IDF/AEC 配置/Opus 帧时长实记、构建期 `OTA_URL` 覆盖 + 烧录 + 激活、重启自动重连、近场唤醒→收音→ASR→真实 DSH→Safety→真实 TTS→播放闭环、成人测试语音 10 轮逐轮记录、冷启动/再配网/断网恢复留证。**未执行前不得标注任何实机 PASS**；不创建 Tag/Release。
- 不引入 XVF3800/四麦阵列/新板级移植；现有固件 AEC 的效果验收与打断可靠性归 E2E-09（issue DoD 4）——E2E-09 状态见 §2.3。

### 2.3 E2E-09 现有固件 AEC 打断实测状态（issue #59——自动化面闭环，物理项待实机）

- **自动化面已由 CI 证明**（`e2e-07-gateway-wiring-gate.yml`，E2E-09 起）：接线环多轮打断测量（`deploy/xiaozhi/probe_e2e09.py`：打断→停播→**零迟到帧**→恢复轮必达真实音频——上游 [xinnan-tech issue #743](https://github.com/xinnan-tech/xiaozhi-esp32-server/issues/743) 的服务端半边复核；连续抢话/延迟打断/无播放空闲 abort 变体；synthetic 与 real 档各一组）；Node 回归套件 `tests/server/voice-gateway-barge-in.spec.ts` 证明可信 epoch 零漏出（打断轮 CANCELLED 结算、旧轮 0 句 0 旧 epoch 帧过传输、恢复轮新 epoch 完成）与无播放 abort 的枚举化良性语义。打断时延 P50/P95/P99 为**客观服务端测量、候选基线**（非 SLA、非实机数值）。执行与复现命令见 [runbook §12.1/§12.7](../deploy/xiaozhi/runbook.md)。
- **服务端 AEC 代码事实（@ pinned commit，2026-10-17 逐字核验）**：hello `features.aec=true` → `conn.client_aec`（`core/handle/helloHandle.py`）→ 播放中（非 manual 模式）VAD 出人声即自动 `handleAbortMessage`（`core/handle/receiveAudioHandle.py`）；**WebSocket 直连路径的下行参考缓存仅用于 MQTT 网关分支，普通 WS 下行无服务端回声对消——回声对消只能来自设备侧 `CONFIG_USE_DEVICE_AEC`**（其效果验收归本节物理面）。
- **物理面待实机**（[runbook §12](../deploy/xiaozhi/runbook.md) 的记录表/冻结门限/≥100 轮矩阵/对照证据）：固件 binary/commit/配置与 AEC 启用链路实录（含扬声器参考信号是否存在）、成人测试语音 ≥100 次播报中打断试验（成功率/误打断率/P50/P95/P99/失败类别）、AEC 回声抑制对照录音/转写、三时间点（人声触发→设备停播→服务端取消 ACK→whenIdle 停稳）实测、未达门限时按 runbook §12.8 走"阻止 Release 或显式按键降级"决定。**未执行前不得标注任何实机 PASS**；不创建 Tag/Release。
- 不采购 XVF3800、不做远场阵列/板级改造（issue 非目标）；本 Issue 预期在实机验收完成前保持 OPEN（沿用 #58 先例）。

### 2.4 E2E-11 实机可靠性回归状态（issue #61——自动化面闭环，物理项待实机）

- **自动化面已由 CI 证明**（`e2e-07-gateway-wiring-gate.yml` + `r1-baseline-gate.yml`，E2E-11 起）：接线环可靠性回归探针 `deploy/xiaozhi/probe_e2e11.py`（真实 agent 运行时档：长稳轮次逐轮时延分解 `stt_echo_ms`/`first_sentence_ms`/`first_audio_ms`/`turn_total_ms` 候选基线 + `wifi_drop` 播放中硬断→重连→恢复轮必达 + `cancel_flood` abort 洪泛→停→零迟到帧→恢复轮必达 + `server_restart` 运营者重启命令播放中注入→连接必断→重连→恢复轮必达）；组合栈回归 `tests/server/e2e11-reliability.spec.ts`（模型挂起→超时清扫 TIMED_OUT→设备恰一次 stop→迟到流完全良性无复活；取消洪泛恰一次 fence/轮、零旧帧泄漏；真实 SQLite 栅栏存储洪泛下持久化/恢复一致性——epoch 单调、不复活、post-fence 写入拒绝）。执行与复现命令见 [runbook §14.1](../deploy/xiaozhi/runbook.md)。
- **物理面待实机**（[runbook §14](../deploy/xiaozhi/runbook.md) 的故障注入矩阵 F1–F10/≥100 轮记录表/门限冻结/安全核验 S1–S5/重建-回滚-控制面留证）：真实设备 Wi-Fi 断开重连、WS 重绑、服务进程重启、DSH/ASR/TTS/LLM 不可用、取消洪泛、重复设备会话、OTA 失败/回退（若已配置）的实机注入与恢复实测；≥100 轮成人/合成对话（成功率/失败类别/P50/P95/恢复时间/费用）；唤醒→ASR→首安全短句→TTS 首音→播报的实机时延分解与停止响应；激活凭据轮换/安全 WSS-IPC/外发白名单/清理策略 fail-closed 核验；空环境重建、健康检查、受控回滚与生产控制面记录。**未执行前不得标注任何实机 PASS**；不创建 Tag/Release；本 Issue 预期在实机执行前保持 OPEN（沿用 #58/#59/#60 先例）。

### 2.5 E2E-12 首版产品验收门禁状态（issue #62——候选已组装，物理/人工项待执行）

- **自动化面**：发布候选 **1.0.0-rc.1** 已组装（package.json ↔ [release manifest](../release/release-manifest.json) ↔ [验收注册表](../release/release-candidate.json) 三方一致，CI 强制）；冻结首版产品范围（纳入现有 ESP32-S3 整机 + `v2.5.2_nulllab-ai-vox-v3` + 现有固件 AEC/打断 + 私有化小智 + 真实 DSH/LLM/ASR/TTS + 双 Skill + 家长 Web；排除 XVF3800/四麦改版与真实儿童数据联调）；逐条 DoD 证据登记（automated 行 gate/proof 必须真实存在，human 行 pending 不得代领 PASS）与发布纪律 invariant（Go 需六维全 go + 全 human 行 recorded；`release.state=created` 需 Go + 用户显式批准）由 `scripts/release-gate/acceptance.ts` + `tests/release/release-candidate.spec.ts` fail-closed 强制；发行说明与已知限制见 [docs/RELEASE_NOTES.md](./RELEASE_NOTES.md)。
- **物理/人工面待执行**（[runbook §15](../deploy/xiaozhi/runbook.md)）：完整演示流程（§15.4，汇编 §11.4/§12.4/§13.2/§14.3 记录表）、独立验收人六维 Go/No-Go（§15.5）、用户显式发版批准（§15.6）。**未执行前不得标注任何实机 PASS、不创建 Tag/Release；本 Issue 预期保持 OPEN（沿用 #58–#61 先例）。**

## 3. 语音平台部署原则

初期一台 Linux 云服务器，优先小智**单模块 Server** 加独立 LumiThink Orchestrator、DSH Bridge Worker；可由 Docker Compose/受控进程编排。VAD/ASR/TTS 由小智处理，领域 Agent 和记忆由 LumiThink 管理；不引入第二个 Agent 的工具或记忆真相来源。

**部署基线已随 E2E-04（issue #54）交付**：xinnan-tech/xiaozhi-esp32-server 钉死 commit、gateway-minimal 档位（仅本地 VAD；ASR/LLM/TTS 显式缺省 = 明确禁用，不悄然接外部服务）、与 LumiThink 服务共存的进程/端口/Caddy/启动顺序/回滚——见 [deploy/xiaozhi/runbook.md](../deploy/xiaozhi/runbook.md) 与 CI 门禁 `e2e-04-xiaozhi-deployment-gate.yml`。**口径：私有服务端已验证，真实设备仍待 #E2E-08。**

私有部署不表示所有数据留在本机：向云端 ASR/TTS/LLM 请求前必须做告知、同意、供应商安全与数据保留评估。对音频默认不落盘，日志最小化。

**首个真实流式 ASR 供应商已随 E2E-05（issue #55）交付配置/评审门禁面**（[ADR-0009](./adr/0009-real-asr-provider-transient-channel.md)、runbook §3.5）：`gateway-asr-real` 档位在钉死 commit 的 `selected_module.ASR` 扩展点接入阿里云百炼 Paraformer 实时（duplex WebSocket，评审锚点端点逐字校验；上行 Opus 16 kHz → PCM 16 kHz）；转写不落盘三闸（`delete_audio: true` / 上报队列结构性关闭 / `log_level: WARNING` 抑制转写日志）与"服务端可禁用 ASR 外发"（重渲染 gateway-minimal 档位）由模板/CI 强制。**口径：配置面与合成证据已验证；供应商告知同意流程、真实数据评审与实机行为未完成，儿童数据外发保持 `not_performed` 常量闸门。**

## 4. 必须完成的实机验收

| 类别 | 检查点 |
| --- | --- |
| 信号链 | 双向 I2S、DSP 初始化、I2C、采样率/左右声道、功放与回声参考 |
| 书桌/床边 | 近场及约 2–3 米拾音、环境噪声、音量、背向说话 |
| 端侧唤醒 | 固定/自定义唤醒词的可用性与误触发；离线能力需实测 |
| 云端连接 | 自建 OTA、TLS/网络安全、WebSocket/Opus、丢包/断线恢复 |
| DSH 闭环 | ASR → Gateway → DSH Bridge → 安全短句流 → TTS |
| 打断 | 播放中止、思考中止、旧轮次 TTS 和记忆无漏出 |
| 回归 | 固件版本、DSP 固件、服务器版本及接线参数可复现 |

没有这些结果前，本文件只能视为技术选型与验收合同，不能写“XVF3800 已与小智服务端实机兼容”。

## 5. 替代路线

若验证发现小智语音协议无法满足全双工、性能或持续维护需求，可评估 LiveKit Agents / 自有轻量音频网关；为避免多次迁移，**不在当前 POC 阶段更换**。设备协议与 Domain Service 通过 Voice Adapter 解耦。
