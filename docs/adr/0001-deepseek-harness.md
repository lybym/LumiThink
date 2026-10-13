# ADR-001：采用 DeepSeek Harness（DSH）作为 LumiThink 主 Harness Runtime

> 决策日期：2026-10-12 ｜ 状态：**已采纳（框架选择已确定，生产可用性待 PoC 验证）**  
> 关联：[PRD](../PRD.md) · [Roadmap](../ROADMAP.md) · [DSH 上游管理](../DSH_UPSTREAM.md) · **[ADR-002 语音 Cordis Bridge](./0002-voice-runtime-bridge.md)**

## 背景与目标

LumiThink 2.0 是面向儿童的长期循证陪伴与学习支持平台，支持文本、互动视觉与未来语音。首期在 Linux 云服务器上运行，由现有 Next.js 前端接入。需求包括：

- 稳定而非无限自修改的 Persona，首日即可具备日常情绪支持和困难任务启动支持两项专业 Skill；
- 有来源、可更正、可删除的 Child Memory，并与短期会话日志分离；
- 受控工具权限、可观察性、回归评估、后续可接入多模态与 MCP；
- 最大程度复用活跃开源 Agent Harness，避免自研通用 Agent Loop、会话事件与插件系统。

经对 Mastra、Agno、LangGraph/Deep Agents、OpenClaw、Pydantic AI 和 DeepSeek Harness 的生态取舍，**主 Runtime 选择 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)**。

## 决策内容

1. **“Everything is a Plugin” 为系统扩展原则**：复用 DSH 基于 Cordis 的服务注入、配置 Profile、可卸载注册、Agent Loop、会话 Session、Prompt 拼装、工具与模型扩展点；不 fork 上游核心作为长期常态。
2. **TypeScript-first**：首期沿用 Next.js/TypeScript，LumiThink 专业领域代码首选 TypeScript；如果独立分析服务确有必要，再用 Python sidecar 而不是引入第二套核心 Agent Loop。
3. **LumiThink Domain 与 DSH 解耦**：Child Memory、Evidence Cards、专业 Skill 配置、Persona、安全策略、评估用例都以 LumiThink 自己的版本化 Schema / Repository 保存，DSH 插件只是 Adapter；严禁把关键儿童事实仅存放在 DSH 的上下文或普通插件内部。
4. **单一 Lumi Persona**：Skills 只改变本轮专业方法，不把角色切换成自称心理医生/老师的多个 Agent；每个重要策略调用关联 Evidence Card 和版本。
5. **专用 `lumithink-child` Profile**：从明确列举服务的最小 Cordis 组合出发，允许必需的 Agent Loop、模型 Adapter、受控 Session 与必要的业务工具。**不得直接复用官方默认 `web`、`sdk` 或 `sdk-minimal` 作为儿童生产 Profile**。
6. **运行时能力白名单**：默认不提供 Shell/PTY、通用文件读写/编辑、任意 HTTP Fetch、自动插件安装、无限制 MCP、操作系统权限或未授权子 Agent。每个插件限定可访问的服务、数据及网络目的地；在 DSH 外部的 API/DB 权限层再次执行强制鉴权。提示词不是权限边界。
7. **安全与隐私优先于“即插即用”**：官方明确声明 DSH 处于 Developer Preview、未经安全审计；LumiThink 必须先证明禁用不必要的 `session-log-deepseek` 上传及反馈 OTel 遥测，且对模型请求正常外发进行单独授权审查。DSH Session JSONL、其他持久化记录和备份也属于儿童数据生命周期。
8. **可选插件丰富，但生产插件少而精**：通过 MCP 与 Cordis 加载审核过的能力；新插件必须经过依赖审查、最小权限测试、数据流审查和回归测试才能加入 `approved-plugins`，禁止在儿童对话中自主安装第三方插件。
9. **版本锁定与审慎升级**：监控官方 RC 与 Stable；测试与生产固定准确 DSH 版本、插件版本及 lockfile。发现新版本并不触发自动升级；必须先执行 [DSH_UPSTREAM.md](../DSH_UPSTREAM.md) 的更新评审与回归门禁。

## 推荐逻辑架构（不预先规定必须使用独立微服务）

```text
LumiThink Web (Next.js) / future Voice Adapter
  → LumiThink API/Auth/Consent & Safety Gate
  → DSH SDK / Cordis runtime (lumithink-child profile)
     → Agent Loop + Context + Prompt + Tool Policy + Session
     → lumi-persona            (plugin)
     → lumi-skill-router       (plugin)
     → lumi-evidence           (restricted service/tool)
     → lumi-child-memory       (restricted read/propose tool)
     → lumi-scene-actions      (restricted semantic events)
  → LumiThink domain storage: Child Memory / Evidence / Eval / Audit
```

架构图中的 `lumi-*` 是**计划设计的模块名称**，不是已经存在的 DSH 官方插件，也不是已验证的包名。Child Memory 真正的写入/审查应在独立的受信任服务执行，模型只可提议符合 Schema 的修改。

## 关键工程约束

- **Context 与长记忆分离**：Session Event Log 用于短期交互和故障回放；长期学习/偏好证据有来源、审批和纠错链。删除需求必须覆盖 DSH Session、缓存、归档与备份保留规则。
- **API 与模型无关**：外部客户端只依赖 LumiThink Schema，例如 `InteractionEvent` / `AgentResponse` / `SceneCommand`，不直接暴露 Cordis 内部类型或未经审查的 DSH Web UI。
- **专业能力可审计**：R1 交付 `Emotion Regulation Support` 和 `Homework Initiation`，每个具有 Evidence Card、适用与禁忌、人工审核案例、退出/转介路径。
- **失败必须安全降级**：模型超时、流断开、插件异常、会话不一致不得绕过权限/安全 Gate；可停止并提示儿童寻找可信成年人。
- **可运行但不宣称生产就绪**：只有 R0/R1 安全、隐私和儿童场景验收通过后，才能导入真实儿童交互数据。

## 备选与退出机制

- Mastra、Agno 和 LangGraph 不作为并行主运行时，避免制造两个 Session 真相来源。
- 如果 DSH 的最小权限、数据删除、SDK/流式接入或会话日志外发无法在**不侵入核心源码**的前提下解决，则暂停儿童生产数据接入，提交 ADR 修订并重新评估替代框架。
- DSH 上游发生破坏性变更时，继续运行最后一版已验证版本；不得在儿童生产环境自动滚动升级。

## 2026-10-13 语音扩展决策补充（ADR-002）

ADR-001 的 **“DSH 是主 Harness Runtime、避免 Fork Agent Loop、儿童专用最小权限 Profile”** 保持不变。新增的 [ADR-002](./0002-voice-runtime-bridge.md) 决定：实时语音采用**同进程自定义 Cordis Runtime Bridge**，Bridge 单独持有语音 Session 的 AgentHandle，通过受保护的本地 IPC 暴露受限的 `prompt/cancel/stream/close`。

锁定的 DSH `0.2.0-rc.2` 进程内 Agent 存在 `cancel()`、`whenIdle()` 和 `agent/assistant-stream`；**官方 TypeScript SDK 尚无 mid-turn cancel**，也不能将 `assistant/message` 的重建误称为实时 Token。保留现有 SDK R0 合成基线，正式语音另设 R1-V 技术先导；Cordis Bridge 的功能/最小权限/恢复仍**待实施与验收**，不代表已通过 DSH-02 的真取消。

终端选择 XVF3800 + ESP32-S3、小智固件和自建 `xiaozhi-esp32-server`；设备侧负责音频，小智负责 ASR/TTS/Stop，LumiThink Turn Orchestrator 负责 `turn_id/epoch`、TTS/音频/记忆栅栏，DSH 执行认知推理。详见 [ARCHITECTURE](../ARCHITECTURE.md) 和 [VOICE_RUNTIME](../VOICE_RUNTIME.md)。

## R0 必须完成的 DSH PoC

| ID | 验收项 | 必须看到的结果 |
| --- | --- | --- |
| DSH-01 | 启动独立 `lumithink-child` Profile | 运行服务树及工具列表与明确白名单完全一致 |
| DSH-02 | SDK 文本多轮/事件/关闭；后续 Bridge 中途取消和 Session 恢复 | R0 已验 SDK Mock 多轮/close；**SDK 不支持轮次内取消**，真取消/恢复由 R1-V 单独验收 |
| DSH-03 | 权限测试 | Shell、文件系统、任意外网、安装插件、越权记忆操作均无法从模型调用 |
| DSH-04 | 隐私数据流 | 非必要 Session 上传/反馈遥测关闭，网络抓包与配置证明外发边界 |
| DSH-05 | 会话删除与备份 | 被删除的测试对象不再能通过常规会话、缓存或业务存储被检索 |
| DSH-06 | 插件版本与 SDK 兼容 | 固定 DSH Tag、依赖锁文件，Mock/真实模型都完成首场景 |
| DSH-07 | 安全回归 | 严重儿童安全用例失败阻断发布，插件异常后仍安全降级 |

## 参考

- [DeepSeek Harness 主仓库](https://github.com/deepseek-ai/deepseek-harness)
- [DSH Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [DSH Developer Preview / Safety](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
- [DSH SDK Profile 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/python-sdk.md)
- [Session Log 上传机制](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-log-deepseek/README.md)
