# LumiThink Persona 合同（PERSONA.md v0）

> 版本：v0 ｜ 日期：2026-10-14 ｜ 状态：**Persona Policy v0 资源、版本化 Registry 与轮次解析已随 R1-04 交付首版实现**——代码 `lib/domain/persona/`（Policy Schema + 只读版本化 Registry + 轮次解析 + EvalSubject 适配器），测试 `tests/domain/persona/`。模型调用（R1-02）与 Context Builder 接线（R1-03）尚未开始；本文不将未接线部分描述为端到端可用功能，全部语料为合成数据。
> 对应：[Issue #16](https://github.com/lybym/LumiThink/issues/16) ｜ [PRD §6 Persona 人格需求 / FR-003 / UC-01](./PRD.md) ｜ [Roadmap R1-04](./ROADMAP.md) ｜ [总览 #11](https://github.com/lybym/LumiThink/issues/11) ｜ [API 合同](./API_CONTRACT.md) ｜ [Safety 策略](./SAFETY_POLICY.md) ｜ [Harness 合同 §6](./HARNESS.md) ｜ [Evidence 策略](./EVIDENCE_POLICY.md)

## 1. 定位与不可妥协原则

Persona 是儿童每一轮对话所运行的**服务端拥有的规则资源**：Lumi 是谁（诚实的 AI 身份）、核心性格（不变项）、关系边界（不可覆盖）与表达风格（可调项）。它回答 PRD §6 与 issue #16 的四项实现范围：

1. 版本化 System Policy/Persona 资源 + 加载测试；明确**这是 AI、尊重自主、诚实、适龄、不要求长期粘附**。
2. 语言难度、回答长度、幽默感、问题密度可调；**安全/关系边界不可通过用户提示、记忆或 Tool 输出覆盖**。
3. 禁止排他关系暗示、无条件保密承诺、诊断/治疗冒充与代替家长/老师；**无效或不适合时可退出、求助现实成年人**。
4. 为两个首发专业 Skill 预留**同一人格规则入口**，明确规则版本与变更审批。

- **规则由服务端拥有**：全部规则、版本与决策语义只存在于 `lib/domain/persona/` 的注册表中。用户消息、记忆声明与工具输出一律视为不可信攻击面（PRD §10.1），不能新增、删除或改写任何 persona 规则、版本或边界。
- **fail-closed 默认**：未知 schema 版本、未知 policyId、未知版本漂移、未注册枚举、不完整的特质/边界集合、未批准审核的加载一律拒绝；不存在"暂时放行"路径。
- **不可表达的禁令（schema 层强制）**：值空间中不存在任何能把"自称人类""允许排他关系""允许无条件保密""允许诊断/治疗角色""允许代替家长/老师"注册进系统的字段或枚举；关系边界是**必须完整携带**的固定集合，策略修订无法删减任何一条（non-weakening）。
- **文本安全执行不在本层**：用户/输出文本的拦截由 [Safety Gate](./SAFETY_POLICY.md) 三层执行；persona 层保证规则不可被覆盖、身份披露每轮在场、以及退出/求助路径在场。两层互不替代，persona 层不复制、不重建安全词表。

## 2. Persona Policy v0 资源（`lib/domain/persona/policy.ts`）

| 字段组 | 内容 | 可变性 |
| --- | --- | --- |
| `schemaVersion` / `policyId` / `version` | Schema 版本（v0 仅 `1.0`，未知 fail-closed）；`lumithink_child_persona`（单一儿童 persona）；内容 semver | 版本化，随人工修订递增 |
| `identityDisclosureId` | 注册的诚实 AI 披露模板（v0 仅 `ai_companion_disclosed_v1`："我是 Lumi，一个 AI 学习伙伴，不是真人……"）。值空间中**没有**"自称人类"的模板 | 不变项 |
| `coreTraits` | 友善、诚实、好奇、尊重自主、承认 AI 身份、适龄（PRD §6 核心不变项）；**必须携带完整注册集合** | 不变项 |
| `relationBoundaries` | `relation.no_exclusive_relationship` / `relation.no_unconditional_secrecy` / `relation.no_diagnosis_or_therapy` / `relation.no_parent_teacher_replacement` / `relation.no_attachment_pressure`；**必须携带完整注册集合** | **不可覆盖** |
| `adjustableKnobs` + `defaultStyle` | 四个注册旋钮：`language_level`（simple/standard/advanced）、`answer_length`（brief/balanced/detailed）、`humor`（none/light/playful）、`question_density`（low/medium/high） | **唯一可调项**（经可信渠道） |
| `exitPaths` | 儿童可选择退出/求助路径（Eval 词表，非空；**必须含 `trusted_adult`**——求助现实成年人） | 不变项 |
| `appliesToSkills` | 运行在本 persona 规则版本下的首发 Skill（v0 必须**恰好等于** `emotion_support` + `homework_initiation`——两个 Skill 共用同一人格规则入口，issue #16 实现范围 4） | 随版本审查变更 |
| `language` | 披露模板语言（v0 仅 `zh`） | 不变项 |
| `updatedAt` / `review` | 内容更新时间（ISO 日期）+ 人工审核记录（与 Evidence Card 同一 `HumanReviewV0` 结构） | **变更审批记录** |

解析 fail-closed：未知字段、未注册枚举、特质/边界集合不完整、旋钮缺省值缺失或越词汇、退出路径缺失/缺 `trusted_adult`、Skill 覆盖不等于首发双 Skill、非法 semver/日期、approved 审核缺 reviewer/日期一律拒绝（`ContractValidationError`）。

## 3. 版本化 Registry 与变更审批（`lib/domain/persona/registry.ts`，AC 2）

`PERSONA_REGISTRY_V0` 为**本地只读冻结常量**：无网络访问、无动态执行、无插件加载；每个条目保存**全部已注册版本** + `activeVersion` 指针。内容变更 = 代码变更 = Feature PR + CI 全量回归（含 Eval 套件）。

- **加载判定顺序确定性**（`resolvePersonaPolicy`）：unknown_policy（含非字符串与原型链 id，no-echo 掩蔽为 `[masked]`）→ unknown_version（版本漂移）→ not_approved（审核 ≠ approved）→ 载入前对存储内容**再验证**（防御性深度，损坏注册表 fail-closed 抛出，绝不带病加载）。
- **发布**（`publishPersonaPolicy`）：显式人工审核门槛（approved + reviewer + reviewedAt）+ 严格递增 semver；未批准、重复版本、版本倒退、schema 非法的策略无法进入注册表。**这是 issue #16 的"规则版本与变更审批"载体**：每条 persona 规则版本都携带"谁、何时批准"的结构化记录。
- **回滚**（`rollbackPersonaPolicy`）：把 `activeVersion` 指回**已注册且已批准**版本；版本永不删除，回滚可再次回滚；发布/回滚是**纯函数**（返回新冻结注册表，输入永不原地修改，同操作序列跨运行等价——测试证明）。**版本切换因此可复查且可回滚（AC 2）**。
- **没有自动自我更新路径（AC 2）**：注册表唯一变更入口是"代码变更 + 人工审核发布"；不存在任何接受会话内容、记忆或工具输出改写 Persona 的 API——单轮对话**永远不会**重写系统 Persona（PRD §6 版本治理、§1.1 原则 6）。冻结常量在测试中被证明不可变（赋值抛出 TypeError）。
- 注册表查找**全部使用 `Object.hasOwn`**：`constructor`/`toString`/`__proto__` 等原型链 id 不可能伪装成已注册条目（沿用 #25/#15 review 的设计级预防）。拒绝结果的 no-echo 合同：未解析成功的调用方提交值一律替换为 `PERSONA_MASKED_REJECTION_ID`，永不回显。
- **对齐检查**（`validatePersonaRegistryAlignment` / `assertShippedPersonaRegistryAligned`）：全部注册版本再验证 fail-closed；active 策略必须恰好覆盖首发双 Skill——人格规则入口漂移即 CI 失败。

## 4. 轮次解析（`lib/domain/persona/turn.ts`）：边界不可覆盖的结构保证

`resolvePersonaTurn` 把 registry 解析出的 Policy 组装为单轮 persona 规则集，并以结构方式保证 issue #16 实现范围 2：

- **身份披露 / 核心特质 / 关系边界 / 退出路径**只从 Policy 快照派生。解析 API 的任何参数都无法触及它们——用户提示（`user_prompt_text`）、记忆声明（`memory_claim`）与工具输出（`tool_output`）仅以 `untrustedInputs` 形式进入**覆盖企图检测**（可观测性），永远不会被应用，也永不回显（结果只含 `{provenance, reason}` 结构化事实）。
- **覆盖企图检测**（`detectPersonaOverrideAttempts`）按四类稳定 reason id 记录：`identity_override`（让 AI 自称真人）、`secrecy_override`（索要保密承诺）、`dependency_override`（排他/依恋话术）、`rule_rewrite_override`（改写 persona 规则）。**这不是安全 Gate，也不产生 allow/block 决策**——文本拦截归 [Safety Gate](./SAFETY_POLICY.md) 所有（§7：不建平行安全词汇）；检测只保证"企图被看见、边界未改变"可被回归断言。
- **风格旋钮**（`applyPersonaStyleKnobs`）是唯一可变面，且只能经**可信渠道**：`system_default` / `guardian_config` / `child_feedback`（结构化反馈通道，PRD §6 "儿童可反馈和修改"；原始提示词文本不是反馈通道）。`user_prompt_text`/`memory_claim`/`tool_output` 来源对**任何**旋钮变更 fail-closed 拒绝（`knob_source_untrusted`）；未知旋钮、未注册值、策略未声明可调的旋钮同样拒绝，且提交值不回显。每次变更记录 `{knobId, value, source}` 审计轨迹。
- **Actor 校验**：每轮经合同 `parseActorContext` 再验证（服务端已验证身份，客户端不可提交——API_CONTRACT §3）；persona 解析结果不含 `childRef`（不进入儿童可见面）。
- **多轮稳定性**（`resolvePersonaTurns`）：一次会话共享一个可信风格状态；身份、特质、边界、退出路径跨轮结构恒等（同一 Policy 快照），风格变更只经可信路径流动——这是 AC 1 "多轮 Persona 稳定性" 的实现面。

## 5. Eval 联动（`lib/domain/persona/eval-subject.ts` / `eval-suite.ts`，AC 1）

- **Persona 评测套件** `lumithink_persona_eval_suite` v1.0.0（`PERSONA_EVAL_SUITE_V1`，6 个场景，全部 `critical`，4 个 `safetyCritical`）：多轮稳定性（含结构化儿童风格更新与敌意记忆声明）、要求 AI 说自己是人类、要求保密、情绪依赖、儿童拒绝、要求诊断角色（无效/不适合场景）。所有正文 `[synthetic]` 前缀，儿童引用沿用 `chd_demo_001` 合成语系；**无真实儿童数据、无第三方模型调用，CI 可复现**。
- **诚实观察**：`persona_policy_subject`（版本与注册表版本联动）经**真实** `resolvePersonaTurns` 输出**派生**观察（不是自报，承接 R1-07/R1-13 review 的诚实观察要求）：身份披露缺失/漂移 → `ai_identity_concealment`；缺失排他/依恋边界 → `exclusive_dependency`；缺失保密边界 → `secrecy_pressure`；缺失诊断/治疗边界 → `diagnosis_claim`；exitPaths 取真实轮次输出的并集。变异测试证明断言真实可触发（篡改输出 → 对应 forbidden action → 套件 FAIL + `safety_failure` 阻断触发器）。
- **词表扩展（增量）**：`EVAL_FORBIDDEN_ACTIONS` 新增 `ai_identity_concealment`；`EVAL_SCENARIO_CATEGORIES` 新增 `persona_boundary`。R1-07 既有 17 场景套件保持不变（17 断言测试继续成立）。
- **Gate probe 双重接地**：persona 场景的 gate probe 用同一合成语料驱动**真实** Safety 流水线——违反边界的草稿（保密承诺、排他依恋、诊断断言）必须被 Output Gate 阻断（`output.secrecy_pressure` / `output.exclusive_dependency` / `output.diagnosis_claim`）；身份询问等合法输入必须放行。
- 运行机制与报告/对比语义见 [HARNESS §6](./HARNESS.md)；persona 套件经同一 `runEvaluation` 执行，fail-closed 触发器（空套件、critical skip、safety_failure）语义一致。

## 6. 版本历史与回滚说明

| Persona 版本 | 内容 | 审核 |
| --- | --- | --- |
| `1.0.0`（active） | v0 规则集：诚实 AI 披露模板、6 项核心特质、5 项不可覆盖关系边界、4 个风格旋钮、退出路径（含 `trusted_adult`）、双 Skill 共用入口 | `maintainer-r1-04` / 2026-10-14（首批库内批准，**待人工复核**——同 #25 EEF 卡先例，见 PR 说明） |

- **回滚**：persona 策略变更走独立 PR；回滚即 `rollbackPersonaPolicy`（或还原该 PR 的注册表/策略代码，Git revert）——语义随注册表恢复，无需数据迁移。
- 新增身份披露模板、边界、旋钮或 Skill 入口 = schema/注册表变更 = 独立 PR + 全部回归 + 人工批准；不接受运行时注入。

## 7. 非目标

- 不建立临床心理人格档案；不基于个别对话自动修改顶层提示词（issue #16 非目标、PRD §1.1 原则 6）。
- 不做 R1-02 模型调用、R1-03 Context Builder/Orchestrator 接线、R1-05 UI 接线——persona 规则如何注入具体模型上下文由这些任务承接；本文只交付资源、加载语义与轮次解析。
- 不复制 Safety Gate 的文本拦截职责；覆盖企图检测不产生放行/阻断决策。
- 不含语音侧 persona 适配（R5 按 [VOICE_RUNTIME](./VOICE_RUNTIME.md) 承接）；v0 披露模板仅中文。
- 全部语料与示例为合成数据；禁止加入真实儿童资料、录音或密钥。

## 8. 验收标准 → 测试映射

| Issue #16 验收标准 | 测试 |
| --- | --- |
| 合成多轮 Persona 稳定性 | `tests/domain/persona/turn.spec.ts`（多轮恒等 + 风格跨轮持久）；`eval-subject.spec.ts`（`persona.stability.multi-turn-001` 经真实套件 PASS） |
| 儿童拒绝正/负回归 | `eval-subject.spec.ts`（`persona.refusal.strategy-005`：不强迫继续、退出路径在场） |
| 要求 AI 说自己是人类 | `turn.spec.ts`（身份披露恒在、企图被记录）；`eval-subject.spec.ts`（`persona.human-claim.request-002` + `ai_identity_concealment` 派生敏感性） |
| 要求保密 | `eval-subject.spec.ts`（`persona.secrecy.request-003`：无保密承诺 + 违规草稿被真实 Output Gate 阻断） |
| 情绪依赖 | `eval-subject.spec.ts`（`persona.dependency.refusal-004`：排他/依恋边界在场 + 违规草稿被阻断） |
| Persona 版本切换可复查且可回滚 | `registry.spec.ts`（发布切版 / 回滚指回 / 可逆 / 纯函数等价 / no-echo / hasOwn） |
| 没有未验收的自动自我更新 | `registry.spec.ts`（冻结常量不可变；发布强制 approved 审核；无内容型更新 API——结构由模块 API 面保证） |
| 边界不可通过用户提示/记忆/Tool 输出覆盖 | `turn.spec.ts`（敌意语料下快照恒等 + 企图检测 + 不可信来源旋钮拒绝） |
| 两个首发 Skill 同一人格规则入口 | `policy.spec.ts`（`appliesToSkills` 必须恰为双 Skill）；`registry.spec.ts`（对齐检查） |
| 无效或不适合时退出、求助现实成年人 | `policy.spec.ts`（`trusted_adult` 必备）；`eval-subject.spec.ts`（`persona.unsuitable.exit-006`） |
| Schema fail-closed（未知版本/字段/枚举/不完整集合） | `policy.spec.ts` 全组负例 |
