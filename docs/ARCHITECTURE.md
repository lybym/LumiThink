# LumiThink 2.0 系统架构（目标架构）

> 更新：2026-10-13 ｜ 状态：**已选择技术路线，语音及 Cordis Bridge 尚未实现和验收**  
> 产品：[PRD](./PRD.md) · [Roadmap](./ROADMAP.md) · [DSH ADR-001](./adr/0001-deepseek-harness.md) · [Voice ADR-002](./adr/0002-voice-runtime-bridge.md)  
> 详设：[Voice Runtime](./VOICE_RUNTIME.md) · [语音硬件](./VOICE_HARDWARE.md) · [DSH R0 POC](./R0_DSH_POC.md)

## 1. 目标与约束

LumiThink 是面向**单一儿童初期用户**的、循证的陪伴与学习支持平台，核心覆盖日常情绪支持、困难任务启动、阅读探索，以及后续视觉交互。保持设备无关、模型无关、单一 Persona、最小权限和可更正的记忆。首期部署：**一台受控 Linux 云服务器，模块化部署，不引入非必要 IoT 平台**。

本文件描述目标架构，不表示已运行。当前可运行证据仅限 `poc/dsh-child/` 的 DSH `0.2.0-rc.2` **合成数据 SDK POC**（35 项通过、零 SKIP）；未完成真实语音设备联调、Bridge、生产儿童隐私审查。

## 2. 目标链路

```text
[XVF3800 四麦阵列 / XMOS DSP]
       | I2S 音频 / I2C 控制 (板级验证待做)
[ESP32-S3 / 小智板级适配固件]
       | WebSocket + Opus; OTA 由自有服务提供
[xinnan-tech/xiaozhi-esp32-server (自建)]
       | VAD / ASR / TTS / 中断停止 / 设备连接
[Voice Gateway Adapter]
       | 身份绑定与协议标准化
[LumiThink Turn Orchestrator]
       | turn_id + epoch / 权限 / backpressure / 状态机 / 输出安全
       | 受保护的本地 IPC（首选 Linux UDS）
[Lumi DSH Runtime Bridge (自定义 Cordis 插件)]
       | 单一会话执行所有者 / followup / cancel / whenIdle
[DSH Agent Loop + Session + 合规 Tool Profile]
       | 经审核的模型适配器 / 只读 Evidence / 受限 Skill
[LumiThink Domain Services]
       | Child Memory / Evidence / Safety / Audit / Eval
       | 写入边界必须原子验证 epoch，默认不存原始音频

[Next.js Web/触屏] ──→ [统一 LumiThink API/Turn Orchestrator]
```

**控制面与媒体面解耦**：XVF3800 只负责端侧音频前处理，服务端看到的是小智协议的音频，不直接识别 XVF3800 硬件。小智不保存 LumiThink 领域事实；DSH 不直接拥有儿童身份、长期记忆和下游播放权限。语音输入与 Web 输入映射到一致的可信身份和领域 Schema。

## 3. 技术边界与权属

| 模块 | 拥有 | 不应拥有 |
| --- | --- | --- |
| XVF3800 + ESP32-S3 | 采音、阵列 DSP/AEC、唤醒/播放/止播、Wi-Fi/Opus | 云端儿童画像与 DSH 会话密钥 |
| xiaozhi-esp32-server | 设备协议、VAD/ASR/TTS、TTS 队列和基础 OTA | 教育规则、长期记忆真相来源、DSH 生命周期 |
| Voice Adapter + Turn Orchestrator | `device_id → child_id` 可信绑定、`turn_id/epoch`、安全拦截、任务顺序与下游栅栏 | 直接重写 DSH Agent Loop |
| Lumi DSH Bridge | 单实例 AgentHandle/Session 执行所有权、`prompt/cancel/stream/close` IPC 映射 | 任意网络监听、业务事实落库 |
| DSH Agent Runtime | 推理、上下文、受控工具执行、模型调用、内部 Session | 不受控的 Shell/FS/网络和儿童真实记忆直接写入 |
| Domain Services | Evidence/Skill/Memory/Safety/Audit，可信原子提交 | 依赖 DSH 私有事件作为唯一持久化格式 |
| Next.js | 文字、触屏、家长界面和必要授权 | 直接访问 Cordis 内部进程 IPC |

`child_id` 和 `device_id` 不得按来路自报即信；一个网络连接的 `session_id` 不等于稳定身份。DSH 短期 Session、长期 Child Memory 和审计记录必须分离。

## 4. DSH Runtime 的两条入口

- **R0 / 离线分析 / 测试**：保留现有 `@deepseek-ai/dsh-sdk-client` 与 `lumithink-child` 合成最小权限 Profile；零 SKIP、安全测试维持原样。
- **目标实时语音**：新增受限 Cordis Bridge Profile/插件。Bridge **在同一 DSH 进程内**直接控制 `ctx.agents`，订阅瞬态 `agent/assistant-stream`，且是本语音 Session **唯一生命周期所有者**。不得同时允许 SDK Server 与 Bridge 控制同一个 Agent/Session。

Bridge 是已选择的架构路线，但仍需对**锁定版本和最终组合后插件树**做可执行 POC；不能把上游扩展示例直接视为已交付。上游 SDK 现无轮次中取消接口，但核心 Agent 的取消与流式事件确实存在，参见 [Voice Runtime 设计](./VOICE_RUNTIME.md)。

## 5. 数据和安全边界

1. **儿童真实数据默认禁入 R0/R1V POC**：合成标识、合成语音/对话；不在公开仓库、Issue、CI 和一般日志上传真实儿童姓名、原始音频、学校/住址、模型密钥。
2. ASR、TTS、LLM 可以调用第三方服务，**自建小智平台 ≠ 数据不外发**；必须在监护人告知/同意后按模型供应商独立审查数据流、保留和地域。
3. 内部 Bridge 优先 Unix Domain Socket（文件权限 + 进程身份核验），不暴露公网取消或 Session 操作接口。Web/设备只访问鉴权后的 Lumi API/小智入口。
4. 出口按工具/模型服务做强制白名单，DSH Child Profile 不安装默认上传遥测、插件安装、通用 Shell/FS/MCP；容器、凭据、网络出口、数据库权限独立执行防护。
5. 实时模型 Delta 必须进入**短句缓存 → 儿童输出安全检查 → TTS**，不可将未校验 token 直送设备。
6. 新 `epoch` 使旧轮次在**文本事件、TTS 排队、Opus 发送、业务写入**全部失去权限。业务提交用数据库事务原子比对，并对外部副作用使用幂等与补偿机制。
7. 设备端停播、DSH Agent 真正取消、旧轮次副作用阻断是三项独立验收，不得混为一个标记。

## 6. 阶段与验收

- **R0**：保留 SDK 合成测试和权限基线，不修改上游内核。
- **R1-V / 阶段 1**：Turn Orchestrator + Fencing；证明错误结果和记忆不会跨轮。
- **R1-V / 阶段 2**：自定义 Cordis Bridge `prompt/cancel/stream/close`，验证真取消、实时 Delta 和单一所有权。
- **R5 / 实机语音**：XVF3800 + ESP32-S3 小智固件、私有化服务端、真实网络中断/设备重连、延迟和长期稳定性联调。

文字端 R1 和 R1-V 设计可并行，**正式儿童语音开放必须同时满足 Bridge 生命周期与隐私门禁**。记录指标目标与故障注入计划见 [VOICE_RUNTIME](./VOICE_RUNTIME.md)。

## 7. 决策与替代方案

平台端首选 [xinnan-tech/xiaozhi-esp32-server](https://github.com/xinnan-tech/xiaozhi-esp32-server) 私有部署；短期采用单模块 Server，设备管理复杂度上升后再考虑全模块。更换设备/平台不应修改 LumiThink Domain API。若实测音频全双工、打断或时延长期不达标，再评估 LiveKit 或轻量自研语音网关；**当前不迁移**。
