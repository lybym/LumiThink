# 语音硬件和私有化接入选型

> 更新：2026-10-13 ｜ 状态：**目标硬件与语音平台已选；板级适配/实机验收未完成**  
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

## 3. 语音平台部署原则

初期一台 Linux 云服务器，优先小智**单模块 Server** 加独立 LumiThink Orchestrator、DSH Bridge Worker；可由 Docker Compose/受控进程编排。VAD/ASR/TTS 由小智处理，领域 Agent 和记忆由 LumiThink 管理；不引入第二个 Agent 的工具或记忆真相来源。

**部署基线已随 E2E-04（issue #54）交付**：xinnan-tech/xiaozhi-esp32-server 钉死 commit、gateway-minimal 档位（仅本地 VAD；ASR/LLM/TTS 显式缺省 = 明确禁用，不悄然接外部服务）、与 LumiThink 服务共存的进程/端口/Caddy/启动顺序/回滚——见 [deploy/xiaozhi/runbook.md](../deploy/xiaozhi/runbook.md) 与 CI 门禁 `e2e-04-xiaozhi-deployment-gate.yml`。**口径：私有服务端已验证，真实设备仍待 #E2E-08。**

私有部署不表示所有数据留在本机：向云端 ASR/TTS/LLM 请求前必须做告知、同意、供应商安全与数据保留评估。对音频默认不落盘，日志最小化。

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
