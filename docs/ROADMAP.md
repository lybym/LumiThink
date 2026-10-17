# LumiThink 2.0 产品路线图（ROADMAP）

> 版本：2.0.1-draft ｜ 日期：2026-10-17 ｜ 状态：讨论稿（R1-V 生命周期先导与 XVF3800 最终硬件选型已更新）  
> 上游需求：[PRD.md](./PRD.md)  
> 本文是 **按能力和验收门槛推进的里程碑计划**，不是已完成清单，也不是开发工期承诺。

## 0. 路线图总原则

- **R1 首发就要有循证专业支持能力：日常情绪支持和学习习惯/困难任务启动两项 Skill；不先交付通用聊天空壳。**
- **先打通一条垂直闭环，再扩展其他场景**；每一个阶段都要有端到端使用价值。
- **设备、固件、模型与 UI 是可替换的边缘能力**，不能成为儿童成长平台的核心依赖。
- **单用户、单 Linux 云服务器、模块化单体优先**；不因“未来可能有千台设备”而预先上微服务、IoT 平台和消息总线。
- **主 Harness 已选型为 DeepSeek Harness（DSH）**：一切皆插件、最小权限自定义 Profile、SDK 集成、版本锁定；LangGraph 和其他候选不再是默认路线。
- **跟踪上游但不自动升级**：官方 RC / Stable 出现时进行变更审查，发布 LumiThink 兼容性评估后才可人工升级。
- **评测、安全和数据治理从 R1 开始，不是交付末期补丁。**
- R0–R2 用合成测试数据开发；未完成隐私/权限验收之前，不导入真实的儿童历史对话、录音或敏感家庭信息。
- 研发可重排，但任何被后置的 P0 安全门槛不能因此绕开。

## 1. 总览

| 阶段 | 主题 | 可演示成果 | 退出门槛 |
| --- | --- | --- | --- |
| **R0 · Product Reset** | 新产品定义与遗留资产审计 | PRD、Roadmap、架构决策清单、迁移台账 | 产品边界和首场景经审阅 |
| **R1 · Professional Harness MVP** | 文本 Agent + 双专业 Skill + 受控最小记忆 | 能在日常情绪困扰和困难任务启动中提供有依据的支持 | 证据、人格、安全、权限、记忆和基础评测通过 |
| **R2 · Memory Expansion** | 观察/假设/策略反馈的分层长期记忆 | 在 R1 偏好/事实记忆基础上安全扩展 | 来源、冲突、修订、删除和审批实测通过 |
| **R3 · Evidence & Skills Expansion** | 强化两项首发 Skill 并扩展专业能力 | Reading Coach 等新增 Skill 和证据审查流程 | 有来源的策略选择、边界测试 + 回归报告 |
| **R4 · Visual Interaction** | 场景引擎与可操作 Web 画布 | 一个可点选/拖动的互动场景 | 前端即时操作与 Agent 语义事件贯通 |
| **R1-V · Voice Runtime Lifecycle（并行技术先导）** | Turn Fencing + Cordis Runtime Bridge | 合成环境真取消、实时 Delta 与安全输出栅栏 | R1-V1/V2 通过；不等同于设备已交付 |
| **R5 · Voice & Multimodal** | 私有化语音实机集成 | XVF3800 + ESP32-S3 / 自建小智 → DSH | 小智私有接入、真实打断/重连与隐私通过 |
| **R6 · Continuous Improvement** | 个体化评估和受控进化 | 可解释的策略变更建议与版本回退 | 线上/离线效果记录和治理闭环有效 |

**阶段依赖：** R0 → R1 → R2；**R1-V 是从 R1 时期并行启动的语音基础设施先导**（不改变 R1 的文字双 Skill 首发目标），R5 需要 R1-V2 的完整门禁再做实机上线；R3 与 R4 可在 R2 基础能力具备后部分并行；R5 不必等待 R4 的高级动画，R6 的评测基础从 R1 开始。

## 2. R0 · Product Reset（文档与存量审查）

> **执行入口：** [R0 DSH PoC 实施与验收合同](./R0_DSH_POC.md)。第一张开发任务已完成：[Issue #6 · DSH SDK + 儿童最小权限 Profile](https://github.com/lybym/LumiThink/issues/6)（[PR #7](https://github.com/lybym/LumiThink/pull/7)）；零 SKIP CI 门禁见 [Issue #8](https://github.com/lybym/LumiThink/issues/8)（[PR #9](https://github.com/lybym/LumiThink/pull/9)）。


### 目标

让所有开发工作对准 2.0 的新定位，避免旧版数学认知诊断数据模型悄悄成为新的产品假设。

### 交付

- [ ] 审阅并批准 `docs/PRD.md` 和 `docs/ROADMAP.md`。
- [ ] 明确首个用户旅程及 MVP 范围（文字探索、阅读支持或困难任务启动，三者不能无差别同时做）。
- [ ] 建立 `docs/ARCHITECTURE.md`：云端运行边界、数据流、身份与授权、故障回退、客户端 Adapter。
- [ ] 建立 `docs/HARNESS.md`、`docs/PERSONA.md`、`docs/MEMORY_POLICY.md` 的 v0 草案。
- [x] 审查现有 Next.js 页面、Prisma `RawEvent` 与 `CognitiveProfile`；标记为“可迁移 / 重写 / 废弃”。（R1-00：[LEGACY_AUDIT](./LEGACY_AUDIT.md) 逐文件处置 + `lib/domain/legacy-guard.ts` 强制守卫，Issue [#12](https://github.com/lybym/LumiThink/issues/12)）
- [ ] 更新 README 以正确指向 2.0（现有 README 描述旧版产品，尚未更新）。
- [ ] 发布 `ADR`：设备无关、模型无关、循证优先、模块化单体、隐私规则。
- [x] 确定主 Harness：DSH / Cordis（架构决策见 [ADR-001](./adr/0001-deepseek-harness.md)）；下一步验收其儿童环境可用性。
- [x] 审核 DSH `web` / `sdk` / `sdk-minimal` 默认功能及 Session/遥测数据流；生成最小权限 `lumithink-child` Profile，并证明不暴露 Shell、文件系统和未经批准的外部网络访问。（PR #7/#9：`poc/dsh-child`，35/35 PASS、零 SKIP）
- [ ] 验证 TypeScript SDK 与 Next.js/Fastify/Node API 之间的流式请求、取消、会话恢复、工具权限和隔离策略。（SDK 契约与隔离已验（PR #7/#9，Mock 模型）；与 Web 服务进程集成待做）
- [x] 锁定 DSH 精确版本及 Cordis 插件兼容矩阵；实现不修改上游核心的覆写和注入。（PR #7：`runtime-manifest.json` 固定 `dsh-v0.2.0-rc.2`，覆写经 `cordis.patch.yml`）
- [x] 建立 [DSH_UPSTREAM.md](./DSH_UPSTREAM.md) 的版本监控、评估、发布与回退制度。（本 PR 建立；RC/Stable 提醒由监控任务执行，不自动升级）
- [x] 确立私有开发数据边界：真实儿童信息不得进入公开示例、Issue、日志和 CI 工件。（本 PR 立规；PR #7/#9 PoC 与 CI 以合成数据 `child_demo_001` 和脱敏工件执行）

### 退出门槛

- 产品目标、明确非目标、角色权限、一个 MVP 场景和最低安全要求均有书面决策。
- 历史数据模型不再被误认为生产级“认知评分”；有迁移清单。
- 核心技术路线决定项有记录（即使决定延后，也说明何时复议）。

## 3. R1 · Professional Harness MVP（第一优先级）

### 目标

完成 `Web Text → Safety Gate → Agent Harness → Evidence-backed Skill → Model Gateway → Response → Eval/Audit` 的闭环。**第一天就能在明确范围内进行专业的情绪与学习支持，不将大模型伪装成儿童心理医生，不保证对话必然改善情绪或习惯。**

### 功能与工程任务

| 编号 | 工作项 | 验收依据 |
| --- | --- | --- |
| R1-01 | 统一 `InteractionEvent` / `AgentResponse`、Session、request_id（合同见 [API_CONTRACT](./API_CONTRACT.md)） | JSON Schema/类型契约测试；错误输入被拒绝 |
| R1-02 | Model Gateway（Provider、Mock、超时、取消、预算） | 可替换模型；故障时清晰降级 |
| R1-03 | DSH/Cordis 插件组合：Input Gate / Context Builder / Skill Router / Tool Gate / Output Gate | Trace 可见规则、模型、工具和时间；未改上游 Agent Loop |
| R1-03a | 专用 `lumithink-child` Profile 的最小权限与 SDK 接入 | 实测无 Shell/PTY/任意读写、无非必要会话/反馈上传；白名单工具越权被拒绝 |
| R1-04 | Persona v0：身份、表达风格与儿童关系边界 | Persona 稳定性场景回归 |
| R1-05 | 最小 Web 儿童端：文字输入、流式回复、停止、清空本轮 | 电脑和触屏浏览器可完成完整交互 |
| R1-06 | 监护人最小权限与隐私告知、功能开关 | 未授权访问和跨角色访问被拒绝 |
| R1-07 | Evaluation Harness：功能、专业、记忆预留、安全与对抗案例 | 可生成基线测试报告和失败用例 |
| R1-08 | 脱敏日志、配置与 Secrets 管理、基本部署与备份 | 公网 HTTPS；秘密不入代码/日志；可恢复 |
| R1-09 | 数据生命周期最小实现：记录开关、查看、清除和审计 | 删除测试通过，默认最小化 |
| R1-10 | CI 检查、环境一致性、发布版本和回退说明 | 干净环境能部署；回退可执行 |
| R1-11 | `Emotion Regulation Support`：日常情绪识别、倾听、共情、选择性调节策略和危机升级 | 愤怒、委屈、拒绝继续与涉及成人矛盾的场景差异化回应；不诊断 |
| R1-12 | `Homework Initiation`：确认学习难点、协商最小第一步、渐退支持 | 面对“难题导致回避全部作业”时不催逼、威胁、代写 |
| R1-13 | Evidence Card v0、Skill Registry v0：绑定已核验 EEF 等研究指导 | 双 Skill 都有适用/禁忌、来源、局限、版本和回归案例 |
| R1-14 | 受控最小记忆：确认事实/偏好、跨会话检索、更正和删除 | 可纠正已确认偏好；禁止自动写入心理/人格/诊断标签 |

### 不在 R1 的内容

临床诊断和心理治疗、自动心理画像、长期学习能力打分、论文大规模自动采集、云端模型微调、PixiJS 世界、语音硬件联调、复杂多 Agent 和云原生集群。

### 退出门槛（Release Gate）

1. 情绪支持与困难任务启动两种专业场景均可从 Web 完成多轮演示；Mock 跑同样接口，包含儿童拒绝与不适用策略。
2. 安全策略有入口/工具/输出三层执行；高严重度安全场景零未解决失败。
3. 每轮可审计策略和模型版本，而不把敏感对话写进普通日志。
4. 模型超时、请求取消、工具拒绝、鉴权失败均有测试。
5. 有人工审核的情绪/学习双专业合成测试用例，覆盖适用、无效、拒绝、危机升级和过度介入；每次路由追踪到已核验 Evidence Card。
6. 能完成偏好记忆“确认 → 跨会话引用 → 更正 → 删除”闭环，且不需要真实儿童数据。

> **R1 发布 Gate 收口核验（Epic #11 关闭记录，2026-10-17）**：Epic #11 的 8 项发布 Gate 在 main `05eff7d` 全量核验通过——16 张 R1 子 Issue（#12–#27）均随 Feature PR 合并关闭，逐 Gate 证据映射与收口时点本地/CI 验证记录见 [R1_EPIC_CLOSURE](./R1_EPIC_CLOSURE.md)。收口范围仍限于合成数据与 Mock/受审真实 Provider；实机/人工验收面归 Epic #50（#58–#62，runbook §11–§15），不含在本记录内。Epic #11 随收口记录 PR 合并关闭；后续路线见 §4。
>
> **E2E-12 首版产品验收门禁已组装（issue #62）**：发布候选 **1.0.0-rc.1**（package.json ↔ [release manifest](../release/release-manifest.json) ↔ [验收注册表](../release/release-candidate.json) 三方一致，CI 强制）；冻结首版产品范围（现有 ESP32-S3 + `v2.5.2_nulllab-ai-vox-v3` AEC/打断 + 私有化小智 + 真实 DSH/LLM/ASR/TTS + 双 Skill + 家长 Web；排除 XVF3800/四麦改版与真实儿童数据联调）；逐条登记验收证据（自动化面由既有门禁 CI 持续证明，物理/人工面按 [runbook §15](../deploy/xiaozhi/runbook.md) 留证）；发行说明与已知限制见 [RELEASE_NOTES](./RELEASE_NOTES.md)。**独立验收人六维 Go/No-Go（技术安全/产品体验/隐私授权/专业 Skill/运维/回退）与用户显式发版批准为人工面，未执行前 issue 保持 OPEN；Go + 用户批准前不创建 Tag/Release**（注册表 invariant 由 CI fail-closed 强制）。
>
> **E2E MVP 进度（issue #61 / E2E-11）**：实机可靠性回归的自动化面已交付（接线环故障注入探针 `probe_e2e11.py`——真实 agent 档长稳轮次逐轮时延分解候选基线 + `wifi_drop`/`cancel_flood`/`server_restart` 硬不变量；组合栈 `tests/server/e2e11-reliability.spec.ts`——模型挂起超时清扫与迟到流良性、取消洪泛恰一次 fence/零泄漏、真实 SQLite 栅栏存储洪泛下持久化/恢复一致性；既有 #48 whenIdle 有界超时/#49 server_restart 鉴权清理/tts.clear epoch/真 IPC 联测专项回归复核在列，见 [deploy/xiaozhi runbook §14.1](../deploy/xiaozhi/runbook.md)）。**实机故障注入矩阵 F1–F10、≥100 轮成人/合成对话实测（成功率/失败类别/P50/P95/恢复时间/费用）、安全核验 S1–S5 与空环境重建/回滚/控制面留证**由运营者按 [runbook §14](../deploy/xiaozhi/runbook.md) 执行留证（#58/#59/#60 同模式），未执行前 issue 保持 OPEN，不代领 PASS。
>
> **E2E-10 已交付（issue #60）**：儿童专业场景端到端验收面（自动化面由 CI 证明：双 Skill 多轮专业场景与逐轮 Persona/Skill/Evidence 版本追溯、危机确定性转介、专业边界自动化卡——幻觉/角色诱导/设备旁路/无效策略、受控记忆"确认→跨会话引用→修订→删除"全环与禁止自动沉淀心理诊断/人格标签、快照恢复不复活已删除内容、监护人治理旅程——撤权/记录开关/导出/清除对儿童会话实际生效与未授权拒绝）。**真实 LLM + 真实设备多轮样例、监护人端逐项点击、专业边界测试卡人工审阅与真实调用记录**由运营者按 [deploy/xiaozhi runbook §13](../deploy/xiaozhi/runbook.md) 执行留证（#58/#59 同模式），未执行前 issue 保持 OPEN，不代领 PASS。

## 3.5 R1-V · Voice Runtime Lifecycle（跨阶段先导、当前计划）

> 详见 [Voice Runtime 设计合同](./VOICE_RUNTIME.md) / [ADR-002](./adr/0002-voice-runtime-bridge.md) / [硬件选型](./VOICE_HARDWARE.md)。**这是提前解除语音架构阻断项的技术先导，不表示提前完成 R5 设备交付。**

- [ ] **R1-V1：Turn Orchestrator + Fencing**。创建独立 `turn_id`、单调 `epoch`、终态不可逆状态机；合成 100 次 ASR 迟到/重复取消/记忆提交竞态无串轮、旧 TTS 和过期写入 0。
- [ ] **R1-V2：自定义 Cordis Runtime Bridge**。单一 Bridge 独占 Voice Session 生命周期；内部 `agent.cancel()`、`agent.whenIdle()`、`agent/assistant-stream`，实现 `prompt/cancel/stream/close` 和 Unix Domain Socket 受限控制面；支持安全短句增量 TTS、异常 Worker 回收与最小权限验证。
- [ ] **R1-V3：跨组件接口合同**。与小智 `client_abort`/TTS 队列/Stop 协议的接口契约、版本管理和合成故障注入。实机最后验收留在 R5。**进度（E2E MVP，父 Epic #50）**：合同与合成验证（#30/#51/#55/#56，Adapter v1.3）、服务端部署与真实 ASR/TTS 档位（#54/#55/#56）、**服务端接线联测（#57，ADR-0011：LLM 扩展点桥 + 受保护内部传输 + 设备鉴权映射 + 真实 Opus 下行全链路）已交付**；**#58（E2E-08）已清零 #57 review P1-1/P1-2（real 档 10 连轮接线环 CI 证明 + 未绑定设备负例 + 启动器 scoped typecheck + 注入面回归守卫）**；**#59（E2E-09）已交付打断实测面（协议文档 §9：接线环多轮打断→停播→零迟到帧→恢复测量探针 + 可信 epoch 零漏出回归 + 上游 #743 服务端半边复核；物理 AEC/打断 ≥100 轮实测协议归 [runbook §12](../deploy/xiaozhi/runbook.md)）**；实机（真实固件/真实音频上行/实机打断时延/AEC 效果）留 R5/#E2E-08/#E2E-09 实机执行（[runbook §11/§12](../deploy/xiaozhi/runbook.md)）。
- **No-Go**：无法保证旧轮次禁止输出/写入、取消/流式接口绕过儿童安全 Gate，或 Bridge 引入默认危险插件/额外未授权外发时，禁止真实儿童语音上线。
- **R0 维持不变**：`poc/dsh-child` 继续用 SDK 合成 Mock，35/35 PASS 零 SKIP 基线是独立回归，不因 Voice Bridge 设计选择而重构。

## 4. R2 · Memory Expansion（可修正的长期了解）

### 目标

将 R1 的受控偏好/事实记忆扩展为带来源的长期观察、可反驳假设与策略反馈；不把一次互动上升为恒久人格、心理或能力标签。

### 交付

- [ ] `MemoryItem` 类型与来源、时间、敏感级别、状态、复核日期和修订链。
- [ ] 明确区分 `InteractionEvent`、`Observation`、`Hypothesis`、`LearningEvidence`、`StrategyTrial`。
- [ ] `Memory Curator`：提取候选 → 去重/冲突 → 规则准入 → 必要时监护人审批。
- [ ] 任务相关记忆检索，禁止无关的个人细节泛滥进上下文。
- [ ] 儿童反馈“不是这样”“我现在不喜欢了”能进入更正流程。
- [ ] 监护人查看、更正、禁用个性化、导出与删除。
- [ ] 明确保留和清理周期；禁止无限累积完整聊天与原始语音。
- [ ] 从旧 `CognitiveProfile` 迁移时不复制无校准的浮点“能力分数”。

### 退出门槛

- 用合成数据复现：记住偏好 → 正确引用 → 用户纠正 → 下次不再重复旧偏好。
- 冲突记忆不被强行合并成一个确定结论；记忆都能追踪来源。
- 用户删除请求可清除对应业务数据；备份恢复和保留边界有明确规则。
- 审批/拒绝的敏感候选不会偷偷写入长期模型。

## 5. R3 · Evidence & Skills（专业能力）

### 目标

在 R1 已有两个可验证的专业 Skill 基础上扩展证据治理、案例覆盖和阅读等新专业场景；不将“LLM 自称心理学专家”视为专业能力。

### 交付

- [ ] `EVIDENCE_POLICY.md`：证据等级、适用范围、审阅、过期与冲突。
- [ ] Evidence Card 注册表，能够链接原始研究与限制。
- [ ] Skill Registry：适用信号、禁忌、引导步骤、工具、退出与评价。
- [ ] 深化首发 `Emotion Regulation Support` 与 `Homework Initiation`，引入至少一个新增专业 Skill（候选 Reading Coach）。
- [ ] 其他专业 Skill 逐项经过证据审查、人工审核、场景回归，不并行铺开几十项。
- [ ] Skill Router 依据儿童当前请求与限制选择，不以既有假设硬套策略。
- [ ] 正确性、适龄表达和反事实失败场景加入 Eval 套件。
- [ ] 家长反馈策略效果可成为下一版修订候选；不得直接自动修改规则。

### 退出门槛

- 同一 Skill 在“适合/不适合/儿童拒绝/证据冲突”场景作出合理差异化处理。
- 输出能追溯具体 Skill 版本及 Evidence Card；没有来源时不声称“研究证明”。
- 至少一次策略修订演示：提案 → 回归对比 → 审批 → 发布/回滚。

## 6. R4 · Visual Interaction（互动场景）

### 目标

建设浏览器中的交互式活动画布，而不是在聊天气泡里贴静态图片。

### 交付

- [ ] `SceneSpec`、`SceneEvent`、版本、动作权限和状态转换契约。
- [ ] 一个真实视觉场景：互动阅读 / 数轴或积木 / 情节排序（三选一）。
- [ ] Web/PWA 响应式布局，支持触摸、鼠标、键盘或替代操作。
- [ ] 场景内操作本地即时反馈、撤销/重做，语义事件异步交给 Agent。
- [ ] Agent 发起或更新受信任的场景组件，不执行动态生成的任意 JS。
- [ ] 本地交互和 Agent 事件可重放测试，失败时不会丢失儿童当前工作。
- [ ] 评估 PixiJS 引入收益：只有 DOM/SVG 达不到目标时才作为正式依赖。

### 退出门槛

- 一次完整“Agent 提议活动 → 儿童点击/拖拽 → 状态变化 → Agent 获得语义事件 → 提供下一步引导”闭环可稳定运行。
- 高频拖拽不逐帧调用 LLM；无障碍替代操作和退出路径有效。
- 单个视觉场景可在更换模型后继续运行。

## 7. R5 · Voice & Multimodal（设备无关的语音）

### 目标

设备只是输入/输出端；验证至少一种自托管协议适配器，不把固件引入 Core。

### 交付

- [ ] `Voice Adapter` 接入自建 xinnan-tech/xiaozhi-esp32-server 的 WebSocket/Opus 协议，完成 R1-V2 → R5 实机贯通。
- [ ] 协议握手、可信设备身份绑定、音频转码、ASR/TTS、`turn_id`/`epoch` 映射与真取消；**不能把小智连接 `session_id` 当作稳定儿童身份**。
- [ ] **目标实机为 XVF3800 + ESP32-S3**（小智板级固件适配）；已有 AI-VOX3 可作为早期对照/调试设备，但不是最终选型。
- [ ] 语音与文本的 persona、记忆、策略与安全判定一致。
- [ ] 端侧 I2S/AEC、私有化 OTA/握手、断线重连与播放中/思考中/连续打断通过实机故障注入，并验证不存在旧轮次文本/TTS/记忆写入。
- [ ] 不默认保存原始录音；第三方语音供应商的儿童数据处理受授权约束。
- [ ] 可选：浏览器画布与语音设备加入同一 Session（若超范围可延至 R6）。

### 退出门槛

- 没有 IoT 管理平台也能完成双向对话；Adapter 与 Core 可独立测试。
- 相同文本意图通过文字与语音入口得到同等安全策略。
- 打断、断网重连和数据最小化有设备实测记录，不声称未测通过。

## 8. R6 · Continuous Improvement（长期进化）

### 目标

让 Lumi 更了解孩子并提高专业支持质量，同时防止记忆、人格和规则逐渐失控。

### 交付

- [ ] 每轮事件、定期候选记忆整理、阶段复盘与人工确认的变更流。
- [ ] 可追溯版本：Persona、Skill、Evidence、Memory Policy、模型与评测集。
- [ ] 形成“无效策略、负面反馈、记忆冲突、过度引导”的诊断报告。
- [ ] 家长端呈现支持性趋势，避免无依据的认知能力排行榜。
- [ ] N-of-1 小规模观察：结合真实任务表现、儿童自述和家长观察，不夸大因果结论。
- [ ] 模型更换、提示词修改、工具升级都跑相同安全/专业回归。
- [ ] 验证儿童自主性增加，而不是只增加平均对话时长。

### 退出门槛

完成一个真实的迭代案例：发现问题 → 归因 → 改 Persona/Skill/Context → 评测比较 → 人工批准 → 发布与回滚 → 观察后续效果。

## 9. 跨阶段的非功能与发布门禁

每个阶段均满足以下共通 Definition of Done：

| 维度 | 强制门禁 |
| --- | --- |
| 隐私 | 合成测试优先；密钥与真实儿童数据不进入 Git、CI、日志和公开演示 |
| 安全 | 严重儿童安全回归失败即阻断发布；变更不能绕过 Gate |
| 测试 | 单元测试 + 契约测试 + 至少一条端到端场景；附失败项 |
| 可回退 | 数据 schema 迁移有演练；发布能撤销；升级步骤文档化 |
| 可观测 | 版本、Trace ID、模型成本、错误分类可查；日志最小化 |
| 稳定性 | 外部依赖超时、网络断开和模型不可用都有安全降级 |
| 文档 | 所有对外新能力有接口、限制、配置与验收说明 |

**不要把里程碑完成度与代码文件是否存在混为一谈。** 只有可运行、通过验收才可以标记完成。

## 10. 建议的工作拆分顺序（起始两个迭代）

### Iteration A · 决策与工程脚手架

**输入：** R0 文档与既有代码。  
**输出：** 可运行的基础工程、接口草案、安全用例与 Mock 模型。

1. 确认两个首发专业场景（情绪支持、困难任务启动）、部署环境、后端语言、身份认证方式。
2. 确认原有 Next.js 是否直接升级复用或迁移新目录；保存历史原型。
3. 定义 `InteractionEvent` / `AgentResponse`、`Session` 和错误码。
4. 建立 Mock Provider 与事件回放测试，不依赖实际模型 API。
5. 建立 Persona / Safety / 两个专业 Skill 的第一版合成评测用例和 CI，人工核验初始 Evidence Cards。
6. 确认日志、儿童数据授权、外发数据、备份与删除规则。

**演示：** 使用 Mock 模型从 Web 输入情绪困扰或学习困难，得到受控 Skill 路由结果、查看 Trace 且不泄露输入正文。

### Iteration B · 真实模型与首个对话闭环

**输入：** Iteration A 的契约和用例。  
**输出：** 一条真实的文本对话链路。

1. 接入一个真实 LLM Provider，配置超时、重试界限和成本上限。
2. 实现受控 Context Builder 与最小 Orchestrator。
3. Web 端支持多轮文字交互、停止与继续。
4. 输入、工具和输出安全检查，以及两项专业 Skill 的适用/禁忌条件回归均已自动化测试。
5. 实现最小监护人鉴权、可见告知与数据清理。
6. 跑回归并形成首次 R1 验收报告。

**演示：** 在日常情绪与困难任务启动场景中给予非诊断、尊重自主、专业依据明确的支持；拒绝/超时/取消有一致行为。

> Iteration A/B 是工作包，而不是固定“每两周交付”的日程承诺；具体工期以后依据实际开发环境和可用时间估算。

## 11. 首阶段技术路线：先讨论、再冻结

### 已确定主架构及待验证的实现细节（ADR-001）

| 主题 | 当前倾向 | 尚待确认 |
| --- | --- | --- |
| 架构 | Linux 云服务器 + Next.js Web + Node/TypeScript DSH Runtime | API/SDK 进程与部署拓扑仍需 PoC |
| 儿童 Web | 复用 Next.js + TypeScript | 现有目录复用程度与升级成本 |
| 数据存储 | SQLite 作为首期事实源 | 版本、迁移、备份和并发边界 |
| Agent | **DeepSeek Harness（DSH）+ Cordis 插件**，复用 Agent Loop/Session/SDK/Tool Pipeline | 固定精确版本，使用自定义儿童最小权限 Profile；R0 进行实机安全与插件集成验收 |
| Harness 扩展 | 自建 LumiThink Cordis 插件 + 经审核的 MCP/Skill | 不开放 Shell、通用文件写入、自动插件安装、未授权子 Agent；插件版本锁定 |
| Evaluation | TypeScript 测试（Vitest）+ 合成场景回放 + 人工审核；DeepEval 视兼容性选用 | 安全断言与权限测试不可仅依赖 LLM Judge |
| Tracing | DSH Session/Trace + 本地脱敏审计；非必要遥测禁用 | Session JSONL/Checkpoint/备份的保留和删除须独立验收；Langfuse 非首期必需 |
| 接口 | Schema-first JSON / HTTP，按需 SSE/WS | 事件定义和流式传输细节 |
| Eval | 固定合成场景、策略断言、模型辅助评估 | 人工校验标准及基线 |
| 部署 | 单台 Linux + 容器或受控进程 | 访问域名、TLS、监控和备份 |
| 多模态 | 先文本；Web 画布与语音分阶段 | 第一可视化场景何时插入 |

### 下一轮优先作出的 5 项产品/技术决定

1. **R1 第一个儿童体验究竟是什么？** 普通陪伴式探索对话、阅读理解，还是困难任务启动支持。
2. **首版是否需要长期记忆？** 推荐只做明确授权的偏好示范与纠错预留，不自动形成人格判断。
3. **DSH 如何安全落地？** 已选 DSH + TypeScript；PoC 检查 Cordis 插件、SDK Profile、版本锁定、模型兼容、Session/遥测最小化、工具白名单与授权。
4. **模型服务的选择与数据边界？** 中国境内可用的 API、成本、留存、敏感儿童信息的外发策略。
5. **首发验收基线怎样制定？** 先挑选可人工审核的合成对话样例，并明确不能出现的行为。

## 12. 风险、依赖与不做事项

- **个人数据不能进入公开仓库**：首期单儿童不等于风险低。
- **不为“看起来智能”而开放数据库写入**：长期记忆、技能与 Persona 由独立规则治理。
- **不为了演示效果就使用游戏引擎**：交互质量需要真实活动验证。
- **不为一块 ESP32 设计 IoT 平台**：设备管理属于外部端能力，可复用既有成熟固件。
- **不以每日聊天轮数考核儿童成长**：需关注真实自主性及负面体验。
- **不让 R6 的自动化机制绕过人工审查**：持续改进必须受评测与审批约束。
- **文档与实际状态分离**：未完成的功能不打勾；每个 PR 明确对应 FR、验收证据与阶段。

## 13. 变更记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| 2.0.0-draft | 2026-10-12 | 从单一数学诊断工具重构为儿童成长 Agent 平台；引入 Harness、Memory、Evidence、Persona、安全评估和多模态路线 |
| 2.0.0-draft.2 | 2026-10-12 | 冻结 DSH/Cordis 主 Harness 架构与插件化理念；引入上游 RC/Stable 版本治理与最小权限 Profile 验收 |

**下一步讨论主题：R0 收口与 R1 MVP 的具体需求、后端语言、模型/API、数据结构及第一批验收测试。**
