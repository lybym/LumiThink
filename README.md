# LumiThink — 发光的思考

> **循证、儿童优先、隐私优先的个人 AI 陪伴与学习支持平台**  
> 当前状态：**LumiThink 2.0 研发 / DSH R0 合成数据 POC 已完成部分验收；语音端尚未交付**（2026-10-13）

LumiThink 目标不是无限陪聊或代写作业，而是帮助儿童理解困难、管理日常情绪、探索阅读与知识，并逐渐获得更多独立能力。初期只有一名儿童用户；正式接入真实数据前，必须通过儿童安全、隐私与技术权限门禁。

## 已确定技术选择（目标，不代表全部实现）

| 层 | 当前方案 | 状态 |
| --- | --- | --- |
| AI Runtime | [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) + 最小权限 Cordis Profile | **R0 SDK 合成 POC 已验证** |
| 实时语音控制 | **自定义 Cordis Runtime Bridge** + LumiThink Turn Orchestrator | **目标架构，尚未 POC** |
| 语音硬件 | **XMOS XVF3800 四麦阵列 + ESP32-S3** | **最终硬件选型，实机未验** |
| 设备固件 | [xiaozhi-esp32](https://github.com/78/xiaozhi-esp32) + XVF3800 板级移植 | 待移植/锁版本 |
| 语音平台 | [xinnan-tech/xiaozhi-esp32-server](https://github.com/xinnan-tech/xiaozhi-esp32-server)，Linux 云服务器私有化 | 选型确定，未联调 |
| Web / 触屏 | Next.js + TypeScript（已有历史原型） | 待按 2.0 PRD 重新验收 |
| 领域能力 | Child Memory / Evidence Cards / 情绪支持与困难任务启动 Skills / Safety Gate | 需求和设计已定义，待实现 |
| 模型/语音供应商 | 外部 LLM / ASR / TTS 可插拔，由自建服务管控调用 | 需逐一审查外发及保留 |

**架构原则**：小智负责设备接入、VAD/ASR/TTS 和停播；DSH 负责 Agent Loop 与受限推理/工具；LumiThink 拥有身份、轮次控制、长期记忆、教育证据与安全边界。更换语音平台或硬件**不得要求重写核心业务**。

### 目标端到端链路

```text
XVF3800 (DSP / AEC) + ESP32-S3 (xiaozhi firmware)
  → WebSocket + Opus
  → xiaozhi-esp32-server (自建：VAD/ASR/TTS/设备/停播)
  → LumiThink Voice Gateway Adapter
  → Turn Orchestrator (turn_id / epoch / fencing / safety)
  → Unix Domain Socket (仅本机受保护 IPC)
  → 自定义 Cordis Runtime Bridge (唯一 Agent 生命周期所有者)
  → DSH Agent / approved tools / LLM
  → 经校验的短句增量 → TTS → ESP32-S3

Next.js Web / 触屏 → 同一 LumiThink API / Domain Services
```

**打断三项强制条件**：**撤销旧轮次输出权限**、**尽可能取消 DSH 计算**、**阻止旧轮次产生新的业务副作用**。DSH 在固定的 `0.2.0-rc.2` 版本内部已有 `agent.cancel()`、`whenIdle()` 与 `agent/assistant-stream`；TypeScript SDK 尚无轮次内取消接口。因此采用自定义 Cordis Bridge，而不是长期依赖销毁整个进程；但 Bridge **还没有编写/验收**。参阅 [ADR-002](docs/adr/0002-voice-runtime-bridge.md)。

## 研发进度（区分已完成与计划）

- **已完成的 R0 技术证据**：`poc/dsh-child` 的隔离最小权限 Profile，固定 DSH `dsh-v0.2.0-rc.2`，合成多轮 SDK 事件流、关闭、安全和隐私回归；R0-02 记录 35/35 PASS、0 SKIP（Windows/Linux CI）。这**不等于**真实儿童或实时语音生产验收。
- **R1 文字端（进行中/待开发）**：统一请求接口、儿童 Persona、经证据约束的日常情绪和困难作业启动双 Skill、受控记忆与家长治理。
- **R1-V 语音运行时先导（计划）**：Turn Fencing、Cordis Bridge 真取消与实时 Delta、IPC 协议合同、故障注入和安全回归；不提前宣称已可用。
- **R5 实机语音（计划）**：XVF3800 + ESP32-S3 小智板级固件、自建服务端、Bridge 与 DSH 完整闭环、断网/多次打断/延迟验收。
- **后续**：Evidence/Skills 扩展、Web 交互场景与可审计的持续改进。

见完整 [Roadmap](docs/ROADMAP.md)；R1-V 与 R1 文字端是不同工作流，正式语音开放受 R1-V 和 R5 联合门禁限制。

## 关键文档

| 文档 | 用途 |
| --- | --- |
| [PRD](docs/PRD.md) | LumiThink 2.0 用户场景、安全约束、功能需求 |
| [Roadmap](docs/ROADMAP.md) | R0–R6 阶段与独立 R1-V 语音先导 |
| [系统架构](docs/ARCHITECTURE.md) | 当前所选硬件、服务端、Agent、数据边界 |
| [语音硬件选型](docs/VOICE_HARDWARE.md) | XVF3800 + ESP32-S3、小智固件/服务端与实机门禁 |
| [Voice Runtime / 打断设计](docs/VOICE_RUNTIME.md) | `turn_id`/`epoch`、Cordis Bridge、实时安全流、取消/恢复/验收 |
| [ADR-001](docs/adr/0001-deepseek-harness.md) | 采用 DSH 作为主 Agent Runtime |
| [ADR-002](docs/adr/0002-voice-runtime-bridge.md) | 采用自定义 Cordis Runtime Bridge |
| [R0 DSH PoC](docs/R0_DSH_POC.md) | 合成 POC 合同与安全门禁 |
| [DSH 上游版本治理](docs/DSH_UPSTREAM.md) | SDK/Cordis/插件版本锁定、升级审查 |

## 现有代码（尚有历史原型）

```text
LumiThink/
├── app/                      # 旧版 Next.js 数学/儿童/家长页面原型
├── components/               # 旧版可视化组件
├── lib/                      # 历史数据库模块
├── prisma/                   # 历史数据 Schema（不得直接认定为 2.0 正式模型）
├── poc/dsh-child/            # 已有 R0 SDK + 合成测试 + CI
├── docs/                     # 2.0 方案、设计和 ADR
└── .github/workflows/        # R0 Windows/Linux CI 门禁
```

原型以数学认知为起点，2.0 已扩展为循证儿童陪伴与学习支持平台；旧 README 的“数学能力分数”等说法**不代表新产品承诺**。本仓库主分支目前未提供可直接运行的根目录 `package.json`，请勿把旧原型视为即刻可执行的完整产品。

### 可复现的 R0 DSH 测试

需 Node **v24.21.0**、pnpm **10.34.7**（或先以锁定基线环境验证）；所有模型请求仅访问**本地合成 Mock**，不接入真实儿童资料，也不需要真实 API Key：

```bash
cd poc/dsh-child
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test:r0
```

验收记录：[poc/dsh-child/docs/R0-02_ACCEPTANCE.md](poc/dsh-child/docs/R0-02_ACCEPTANCE.md)。语音部署配置、模型真实外发与生产运行步骤尚待各自 POC 完成后编写，现阶段不提供无法验证的“一键儿童生产部署”声明。

## 安全与隐私

- 不将真实儿童姓名、学校、家庭地址、录音、对话或模型凭据上传公开仓库/Issue/CI/普通日志；默认不长期存原始音频。
- 自建小智平台**不等于**无第三方数据外发：ASR、TTS、LLM 请求必须有明示的数据处理评审与监护人授权。
- Tool 权限采取显式最小化白名单，受控容器/网络出口与业务数据库权限独立生效；儿童记忆可确认、更正、撤回与删除。
- 不能未经校验直接把实时 LLM token 送给 TTS；短句安全校验与 `epoch` 栅栏是生产语音阻断项。

> 目标是帮助儿童独立成长，不作临床诊断、心理治疗，不塑造与真实亲子关系竞争的排他依赖。
