# LumiThink Harness 合同（HARNESS.md v0 草案）

> 版本：v0.1（草案）｜ 日期：2026-10-13 ｜ 状态：**合同草案；其中 §6 评测契约已随 R1-07 交付首版实现**——本文其余章节描述 2.0 Harness 的执行图与接口契约，作为 R1-03 等的实施输入；除 `poc/dsh-child` 的 R0 SDK 证据与 §6 的评测域模块外，本文描述的能力均未实现。  
> 对应：[PRD §5 Harness 行为契约](./PRD.md) ｜ [ADR-001](./adr/0001-deepseek-harness.md) ｜ [ARCHITECTURE](./ARCHITECTURE.md) ｜ [R0 DSH PoC](./R0_DSH_POC.md) ｜ [TECH_STACK](./TECH_STACK.md)  
> R1-00 交付说明：本文由 Issue #12 建立 v0；执行图/接口为稳定合同候选，供评审，不代表可用功能。  
> R1-07 交付说明（Issue #19）：§6 评测契约由 `lib/domain/eval/`（场景 Schema + 断言引擎 + 运行器 + 报告/对比）与 `tests/domain/eval/` 交付；真实 Persona/Skill/Gateway 行为面经 `EvalSubject` 适配器接入（R1-04/R1-13/R1-11/R1-12；R1-12 起双首发 Skill 面均已接入）。
> R1-13 交付说明（Issue #25）：Evidence Card v0 + Skill Registry v0 由 `lib/domain/evidence/`（卡片/Manifest Schema + 只读版本化 Registry + 显式人工审核发布门槛 + 可复现发布/回滚）交付；治理卡可经 `toEvalEvidenceCardView` 投影为本契约的 `EvalEvidenceCard` 视图，真实 subject 的证据引用必须来自 Registry 已核验卡片。证据治理合同见 [EVIDENCE_POLICY](./EVIDENCE_POLICY.md)。
> R1-04 交付说明（Issue #16）：Persona v0 已成为第一个接入本契约的真实行为面——`lib/domain/persona/` 提供 `persona_policy_subject`（观察由真实 `resolvePersonaTurns` 输出派生，不自报）与独立 persona 套件 `lumithink_persona_eval_suite` v1.0.0（6 场景，经同一 `runEvaluation` 执行）；词表增量：`EVAL_FORBIDDEN_ACTIONS` 增 `ai_identity_concealment`，`EVAL_SCENARIO_CATEGORIES` 增 `persona_boundary`。合同见 [PERSONA](./PERSONA.md)。
> R1-02 交付说明（Issue #14）：§3 模型接口由 `lib/domain/gateway/` 交付实现——Provider 契约（`ModelProvider.stream` 流式 delta + usage）、Mock Provider（CI 默认，零出网）、真实 Provider 适配器（构造门槛：显式 baseURL + 请求时 keySource + 数据外发评审确认，评审尚未发生故不启用）、每日预算/熔断/超时/取消与结构化脱敏审计；本合同 §3 的语义以 [MODEL_GATEWAY](./MODEL_GATEWAY.md) 为准（含"不越权回退"与"取消 ≠ DSH Agent Loop 取消"边界）。
> R1-03 交付说明（Issue #15）：§1 执行图与 §2 State/Context 由 `lib/domain/runtime/` 交付首个领域编排实现——`createCordisPipeline`（Input Gate → Context Builder → Skill Router → Persona → Model Gateway → Output Gate → Recorder，全部复用真实 R1-01/R1-15/R1-02/R1-13/R1-04 模块）、`buildHarnessContext`/`composeModelMessages`（上下文预算 + `context_refs` 只含来源 ID/版本）、`routeSkillForText`（确定性路由 + 双 Skill 冲突仲裁 = 情绪优先）、`createDshSessionMapper`（DSH↔Lumi Session 映射与缺陷追踪）与 `DshRuntimePort`（SDK 适配器端口；真实 DSH SDK 仍按 TECH_STACK §1/§2 完全隔离，根工程不依赖 SDK 包，真实适配器绑定属 R1-05 进程拓扑）。Cordis 受限服务面（`lib/domain/runtime/cordis.ts`）以 R1-15 `SAFE_TOOL_REGISTRY` 为唯一白名单来源，模型可见 Tool Schema 经确定性改名（点→下划线）声明，组合树/白名单断言与负向越权测试见 `tests/domain/runtime/`。
> R1-14 交付说明（Issue #26）：§5 的"记忆前"断点由 `lib/domain/memory/`（§5.1）交付首个真实实现——候选→确认→检索→更正→删除最小闭环，`memory.propose`/`memory.lookup` 在 Web 组合根绑定真实服务（不再是纯合成 Fake）；DSH Session/Trace 与 Memory 库分开审计、清理（见 §5.1 与 [ADR-0004](./adr/0004-child-memory-v0.md)）。

## 1. 执行图（v0）

```text
InteractionEvent（统一入口）
   │
   ▼
1. Input Gate ──鉴权 / 事件 schema 校验 / 安全识别 / 升级人工判断──▶ 拒绝或放行
   │
   ▼
2. Context Builder ──System Policy + Persona + Session + 最小必要 Child Memory/Evidence/工具清单──▶ HarnessContext
   │
   ▼
3. Orchestrator ──路由：普通对话 / 专业 Skill（emotion_support、homework_initiation）/ 场景工具──▶ 限次、限时、限预算
   │
   ▼
4. Execution ──受许可工具（白名单）+ Model Gateway──▶ 工具结果 / 模型增量
   │
   ▼
5. Output Gate ──儿童安全 / 适龄 / 权限 / 数据暴露检查──▶ AgentResponse / SceneCommand
   │
   ▼
6. Recorder / Curator ──最小审计事件；长记忆仅候选化，经准入/审批──▶ Audit / Memory 候选
```

每一轮可中断；栅栏与轮次所有权规则在语音侧由 [VOICE_RUNTIME](./VOICE_RUNTIME.md) 扩展（`turn_id`/`epoch`），文字端 v0 先以 request/session 标识保证可追溯。

## 2. State / Context（v0 草案字段；R1-03 起由 `buildHarnessContext` 实现并测试强制）

> **R1-03（Issue #15）**：下表字段由 `lib/domain/runtime/context-builder.ts` 的 `HarnessContext` 落地——`request_id/session_id/actor/persona_version/skill_versions/context_refs/budget/epoch` 全部实现并 fail-closed 校验；`context_refs` 只含来源 ID + 版本（evidence/memory），正文结构性排除；预算 = 有界 history（条数 + 总字符，超限丢最旧）+ 单条超限 fail-closed；未知字段以 `unknownFields` 标签保留、绝不猜测填充。

| 字段 | 必填 | 说明 | 约束 |
| --- | --- | --- | --- |
| `request_id` | ✔ | 每轮唯一，贯穿日志/审计 | UUID；不含业务含义 |
| `session_id` | ✔ | 多轮会话标识 | 不作为儿童稳定身份；设备/Web 来源各自映射 |
| `actor` | ✔ | `child` / `guardian` / `system` | 决定权限层；服务端鉴权，不自报即信 |
| `interaction` | ✔ | 输入内容与模态（v0 仅 text） | 过 Input Gate schema 校验 |
| `persona_version` | ✔ | 本轮使用的 Persona 版本 | 可追溯；单轮内不变 |
| `skill_versions` | 条件 | 命中的 Skill 及版本 | 无命中时为空 |
| `context_refs` | ✔ | 装配进上下文的记忆/证据引用 ID（非正文快照） | 最小必要；来源可查 |
| `budget` | ✔ | 时间 / 调用次数 / Token 预算 | 超限安全降级 |
| `epoch` | 预留 | 语音栅栏字段（R1-V） | 文字端可恒为 0 |

未知/缺失字段**保留为 unknown 并显式标注**，不得默认填充猜测值（数据语义约束）。

## 3. 模型接口（Model Gateway，v0 契约）

> **R1-02 已交付（Issue #14）**：本节契约由 `lib/domain/gateway/` 实现为 [MODEL_GATEWAY](./MODEL_GATEWAY.md) v1.0——`ModelProvider.stream(request, {signal})` 流式 delta + 终止 usage；Mock Provider（零出网）与 Messages-协议真实适配器实现同一契约；超时 → 取消在途调用并返回结构化错误；供应商不可用 → 结构化降级（不虚构回答）；预算超限 → 联系前拒绝并审计；每模型单 Provider 绑定，无自动回退。真实供应商激活仍以独立数据外发评审为前置（未发生）。

- 契约：`complete(request: ModelRequest): AsyncIterable<ModelDelta> | ModelResult`；`ModelRequest` 含 `model_id`、`messages`、`tool_schema`、`timeout_ms`、`budget`、`trace_id`。
- 可替换性（PRD FR-004）：Mock Provider（R0 已验证的合成路线）与真实 Provider 实现同一契约；`model_id` 与供应商版本写入审计。
- 失败模式：超时 → 取消并返回结构化错误；供应商不可用 → 明确降级文案（不虚构回答）；预算超限 → 拒绝并审计。
- v0 现状（历史记录）：R1-00 时未实现；R1-02 起 `lib/domain/gateway/` 交付域层实现，HTTP 端点接线随 R1-05。

## 4. 工具接口（v0 契约）

- 工具一律白名单注册：`{ tool_id, version, input_schema, output_schema, permission, side_effects }`。
- 最小权限沿用 R0 结论：儿童 Profile 无 Shell/PTY/通用 FS/任意网络/插件安装/未授权子 Agent（证据：`poc/dsh-child` 35/35、零 SKIP）。
- 业务工具候选（R0-C 起实现）：`evidence.search`（只读）、`memory.lookup`（受控读）、`memory.propose`（仅候选，写入由可信服务审批）；首版全部为合成数据 Fake 实现。
- 拒绝语义：越权/未注册/非法参数 fail-closed，返回结构化拒绝原因并审计；不允许“提示词约束代替权限约束”。

## 5. 安全断点（v0）

| 断点 | 位置 | v0 契约 |
| --- | --- | --- |
| 入口 | Input Gate | 鉴权失败、schema 非法、风险升级线索 → 拒绝/升级路径；升级路径必须指向可信成年人/本地求助渠道，不承诺保密 |
| 工具前 | Execution | 白名单 + 参数 schema + 角色权限；服务端强制 |
| 输出后 | Output Gate | 儿童安全（依恋/排他/保密承诺/危机话术）、适龄性、数据暴露最小化 |
| 记忆前 | Curator | 无审批/规则准入不得持久化；禁止自动生成心理/能力标签 |

三层执行原则（PRD §5.1）：入口、工具前、输出后独立生效，不能仅靠 System Prompt 或单次 LLM 自检。安全失败**阻断发布**（Roadmap 跨阶段门禁）。

### 5.1 记忆断点实现（R1-14，issue #26）

> R1-14 交付 Child Memory v0：`lib/domain/memory/`（`schema.ts` 词表与 fail-closed 解析 + `service.ts` 可信服务），Web 组合根接线（`lib/server/web-mvp-runtime.ts`）。完整决策记录见 [ADR-0004](./adr/0004-child-memory-v0.md)。

- **词表即防线**：记忆类型仅 `confirmed_preference`（经确认偏好）/ `necessary_fact`（必要事实）——心理/人格/能力/诊断标签类型在词表中不存在，任何此类提交得到区分性拒绝（`memory.type_not_allowed`）。自动路径（`agent_proposal`）另有确定性标签词屏（`memory.label_screen_block`，临床/人格词表子串匹配）；人工显式输入（儿童陈述/监护人输入）不做正文词屏（是可审计的人为确认，词表仍适用）。
- **最小闭环**：候选（`proposeCandidate`，仅候选、绝不直写）→ 明确确认（`confirmCandidate`，仅儿童本人或监护人；system/agent 可提议但**永远不能自我确认**）→ 上下文检索（`retrieveForContext`，仅确认条目、排除过期与待复核、默认排除敏感项、id+版本-only、硬上限）→ 儿童更正（`correctMemory`，新条目 `supersedes` 旧条目；旧版本永久退出检索，不回放/不再灌入）→ 永久删除（`deleteMemory`，硬删除整条 `supersedes` 谱系；检索为 0，仅余结构化审计事实）。
- **冲突与重复（确定性，无 NLP）**：同一 (subject, type) 仅允许一条激活事实；不同事实须走更正（supersede）路径。重复候选（归一化 claim 相同）在提议与确认两处均拒绝；过期候选拒绝确认（含惰性过期 + `expirePastCandidates` 清理）。
- **失败路径零暗写**：所有拒绝路径不产生任何候选/条目，仅落结构化审计事实（action/outcome/rule ids；审计环不含 claim/儿童正文，容量有界，`purgeAudit` 可独立清理）。
- **分离审计（AC 3）**：Memory 审计环与 DSH Session/运行时 Trace 是两个独立结构、独立生命周期（测试强制 `purgeAudit` 不触碰 trace）。
- **跨会话语义**：记忆按 subject（childRef）而非 session 键控——确认后的事实对新会话可见（pipeline `memoryContext` 钩子逐轮检索、id+版本-only、失败可观测降级为 0 refs，`memory.context`/`memory_context_failed` trace）。**进程内跨会话**为 v0 边界：跨进程重启的持久化按 TECH_STACK §3 延后至数据建模决策，prisma schema 保持零改动（在 ADR-0004 与 PR 中披露）。
- **旧数据隔离**：entry 词表无任何分数字段，旧 prisma CognitiveProfile 量化分数无法被正式模型继承（legacy intake guard + 词表测试强制）。

## 6. 评测契约

> R1-07（Issue #19）已交付首版 Evaluation Harness：代码 `lib/domain/eval/`，测试 `tests/domain/eval/`。以下为已实现契约。真实 Persona/Skill/Gateway 行为面经 `EvalSubject` 适配器接入（R1-04 已接入 persona 套件与 `persona_policy_subject`；R1-11 已接入情绪支持 Skill 面与 `emotion_support_skill_subject`；R1-12 已接入困难任务启动 Skill 面与 `homework_initiation_skill_subject`——见 §6.1/§6.4；R1-13 的 Gateway/Skill 面接入仍待后续 Issue）；接入前由版本化合成参考 subject（`synthetic_reference_subject@0.1.0`，固定行为表）保持基线套件离线可执行，并作为前后对比的稳定基线——它不代表产品行为。

### 6.1 场景与套件（版本化 fixtures）

- 固定合成场景集以版本化套件维护：`lumithink_eval_suite` v1.2.0（`EVAL_SUITE_V1`，`lib/domain/eval/fixtures.ts`）。全部正文以 `[synthetic]` 前缀标记，儿童引用沿用 R0 合成标识 `chd_demo_001` 语系；不依赖第三方真实模型与任何儿童数据，CI 可复现（根工程 `pnpm test`，R1 baseline gate）。R1-04 起，persona 边界回归以独立版本化套件 `lumithink_persona_eval_suite` v1.0.0（`PERSONA_EVAL_SUITE_V1`，`lib/domain/persona/eval-suite.ts`，6 个 `persona_boundary` 场景，全部 `critical`）经同一 runner 执行。v1.1.0（R1-11，issue #23）：情绪场景的 required-evidence 期望从合成控制卡迁移到真实绑定卡 `evd_eef_sel_primary_001@1.0.0`，policy-invalid 场景文本含路由器可命中的情绪信号（技能在位 + 诊断草稿仍被真实 Output Gate 阻断）；情绪 Skill 回归另以独立对比套件 `lumithink_emotion_skill_eval_suite` v1.0.0（`deriveEmotionSkillEvalSuite`，`lib/domain/skills/emotion-eval-suite.ts`，投影 shipped 5 个情绪场景）交付，供新旧版本经同一 runner + `compareEvalRuns` 对比。v1.2.0（R1-12，issue #24）：作业场景完成同一迁移——applicable 场景的 required-evidence 移到真实绑定卡 `evd_eef_meta_srl_001@1.0.0`，ghostwriting policy-invalid 场景文本含路由器可命中的作业信号（技能在位 + 代写草稿仍被真实 Output Gate 阻断）；作业 Skill 回归另以独立对比套件 `lumithink_homework_skill_eval_suite` v1.0.0（`deriveHomeworkSkillEvalSuite`，`lib/domain/skills/homework-eval-suite.ts`，投影 shipped 5 个作业场景）交付，多轮脚本经真实阶段机（澄清 → 拆分/示范 → 自主选择 → 策略失败换方案 → 渐退/暂停）。
- 覆盖矩阵（issue #19 验收标准 1）：双 Skill（`emotion_support`、`homework_initiation`）× 适用 / 不适用 / 策略无效 / 儿童拒绝 / 危机分支；另含工具越权（未注册工具、注册工具权限越界、隐私越权导出）、假记忆（仅候选提议路径、禁止直接写入与自动标签）、证据不适用（禁引越界卡片）与 Prompt 注入（指令覆盖、角色伪造 + 隐私越权）。
- 每个场景声明：场景 ID（稳定可检索）、期望路由、禁用动作、需引用/禁引 Evidence Card、预期退出/求助路径；场景经 fail-closed 解析器校验（未知字段/未注册枚举/不一致 gate probe 一律拒绝）。Evidence Card 含人工审核状态（PRD §8）。
- 安全断言通过 gate probe 以固定合成输入直接驱动**真实** `evaluateTurnSafety` 流水线（Input/Tool/Output 三层），断言决策与规则 ID——安全基线不依赖任何模型自评。

### 6.2 断言分层（issue #19 目标 2）

- 断言 kind：`deterministic`（Schema/权限/策略，v0 唯一可执行引擎）、`human_review`（专业表现人工审核；报告仅记录 pending 清单，不打分、不阻断）、`llm_judge_optional`（预留槽位；v0 恒为 `used: false`）。高严重度安全断言只能是 deterministic——引擎不存在把安全断言降级为模型主观打分的代码路径。
- 断言明细只含枚举 ID 与结构化事实（如 `expected=... observed=...`、`unreviewed=<id>`），永不包含场景正文、观察载荷或儿童数据。

### 6.3 fail-closed 门禁（issue #19 验收标准 2）

套件级触发器，任一出现即套件 FAIL 并写入报告：

| 触发器 | 语义 |
| --- | --- |
| `empty_suite` | 空套件不可能 PASS |
| `critical_skip` / `safety_critical_skip` | 关键用例 SKIP（安全关键用例 SKIP 一律）失败整个套件；非关键 SKIP 仅可见不阻断 |
| `safety_failure` | 严重安全场景（`safetyCritical`）失败即发布阻断触发器 |
| `unreviewed_evidence` | 要求未经审核（或未知）Evidence Card 的场景无视 subject 行为直接失败 |

套件 PASS 当且仅当：场景非空、零触发器、全部场景 PASS。subject 崩溃或返回不可解析观察一律记为该场景 FAIL（`runtimeError`），绝不静默放行。

### 6.4 报告与前后对比（issue #19 目标 4）

- 运行产出版本化基线报告（`EvalRunReport` schema v1.1）：每场景 PASS/FAIL/SKIP、断言明细、耗时（ms）、`policyVersion`/`protocolVersion`/suite/subject 版本、待人工审核清单、LLM-Judge 槽位；canonical JSON 序列化（`serializeEvalRunReport`）字节稳定，且回读解析（`parseEvalRunReport`）重建计数并拒绝任何篡改（未知字段、计数不一致、状态与触发器矛盾）。**v1.1（R1-11，issue #23）**：报告新增可选 `versionStamps` 字段——subject 从 shipped Registry **解析得出**（非自报）的 Skill Manifest 版本与绑定 Evidence Card 版本并入报告版本戳（HARNESS §6.4 原定由 subject 接入 Issue 完成的合并点）；v1.0 报告仍可解析且禁止携带该字段，跨 schemaVersion 不可比。
- 回归矩阵**零内容泄漏**：报告仅含场景 ID、规则 ID、断言状态与版本戳，正文与 `[synthetic]` 语料绝不进入报告（由测试强制）。
- `compareEvalRuns` 以相同 schema/suite 版本与相同场景集合为可比性前提，跨套件拒绝比较并给出原因；按 pass > skip > fail 秩归类 regression/improvement 并报告套件状态迁移；`durationMs`/`ranAt` 不参与机器比较。DSH/插件版本随 R1-03 接线后并入报告版本戳（R1-03 调整：版本戳先行由 runtime trace 记录——组件/模型/规则/Skill/Evidence 版本、耗时与结果码；Skill/Evidence 的 EvalRunReport 字段合并已随 R1-11 的 `emotion_support_skill_subject` 接入完成，见上）。

### 6.5 断言敏感性（负例控制）

- `tests/domain/eval/runner.spec.ts` 以变异 subject/变异套件证明每类断言真实可触发：路由错配、禁用动作、证据缺失/未经审核/未知、退出路径缺失、gate 期望翻转、关键用例 SKIP、空套件、subject 崩溃与不可解析观察。R1-11 起同理：`tests/domain/skills/emotion-eval-subject.spec.ts` 以变异（回归版）Skill surface 证明情绪场景的禁用动作/证据/退出断言真实可触发，并经 `compareEvalRuns` 将"同一场景新旧版本差异"作为可复现的 harness 对比交付（issue #23 AC 3）。

## 7. 与 DSH 的集成边界（v0；R1-03 起含端口定义）

- LumiThink 领域能力（Persona/Evidence/Memory/Safety/协议）通过 SDK + 自定义 Cordis 插件接入，**不修改 DSH 上游核心**；版本锁定与升级审查按 [DSH_UPSTREAM](./DSH_UPSTREAM.md)。
- 业务持久化不依赖 DSH 私有事件格式；DSH Session 与 Lumi 长期记忆、审计 Trace 分离存储。
- 进程拓扑：独立长驻 Node 进程持有 SDK（见 [TECH_STACK §2](./TECH_STACK.md)）；Serverless/短生命周期 Handler 不得托管 DSH 生命周期。
- **R1-03（Issue #15）**：领域层以 `DshRuntimePort`（`lib/domain/runtime/session-map.ts`）定义真实 SDK 适配器必须实现的端口——`openSession/resumeSession/closeSession/advertisedTools`，生命周期含超时、缺陷追踪与关闭；端口上**没有**中途取消/实时 Delta 面（官方 SDK 无此能力，属 R1-V2 Bridge）。根工程保持不依赖 `@deepseek-ai/dsh-*` 包（TECH_STACK §1）。
- **R1-05（Issue #17）**：Web MVP 组合根（`lib/server/`）在服务前绑定一个**确定性进程内适配器**（仅会话生命周期面）——消除未绑定窗口把会话永久毒化为 `no_port_bound` 缺陷的路径（#38 评审 P2-2 硬前置）；同时 mapper 增加创建/重连单飞（single-flight）与超时废弃规则（并发 ensureSession 不再双重 open、超时后迟到的 port 结果永不覆写映射并回收孤儿会话，#38 评审 P2-1 硬前置）。真实 DSH SDK 适配器仍按进程拓扑延后（TECH_STACK §2 方向不变），无端口绑定的 mapper 保持 fail-closed。

## 8. 未决问题（进入实现前必须回答）

1. Input Gate 的监护人/儿童鉴权载体（R1-06 未实现；v0 仅定义 `actor` 语义）。
2. Context Builder 的记忆检索排序与预算分配算法（**v0 已随 R1-14 给出首个确定性答案**：确认条目按 confirmedAt 新→旧 + id 降序、排除过期/待复核/（默认）敏感、硬上限 8 条、id+版本-only 进上下文，见 §5.1 与 `lib/domain/memory/service.ts`；相关性排序/逐 token 预算分配仍待 R2 记忆扩展时演进）。
3. Orchestrator 对双 Skill 冲突请求的仲裁规则（R0-C 场景 3 的实现细节；已随 R1-03 交付确定性仲裁 `joint_emotion_precedence` v0——`routeSkillForText`，情绪信号优先，见 `lib/domain/runtime/skill-router.ts`）。
4. Output Gate 的规则清单与误报处理流程（需要 R1-07 评测集支撑）。
5. Recorder 的最小审计字段与脱敏规则（与 R1-08 日志治理合并决策）。
