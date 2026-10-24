# LumiThink Evidence & Skill 证据治理（EVIDENCE_POLICY.md v0）

## 2026-10-25 A2A 设计基线更新

设计评审通过（Design GO）。P0/P1 获准开展，协议互通、真实取消、设备验收和部署切换仍受各阶段 Gate 约束。

ChildEvidence 及其他事实系统是受控只读适配器的候选来源，P3 验证实际可用性；当前测试 Profile 不证明已接入真实学习记录。输出含来源引用、统计周期、记录覆盖、更新时间及证据不足项；来源不可用时明确缺失，不用生成结果冒充事实。读取前授权、返回前再查当前权限；来源撤回/删除使关联缓存失效，禁止无来源第二份事实库。

以 [整体方案](A2A_DESIGN.md)、[Task 契约](TASK_LIFECYCLE.md) 和 [P0/P1 计划](P0_P1_PLAN.md) 为新阶段依据。以下保留既有实现/历史范围说明；冲突处以本节明确的目标约束为准，不能据此宣称代码已完成迁移。

## 既有实现与历史基线


> 版本：v0.1 ｜ 日期：2026-10-14 ｜ 状态：**Evidence Card v0 + Skill Registry v0 已随 R1-13 交付首版实现**——代码 `lib/domain/evidence/`（Schema + Registry + 加载/发布/回滚），测试 `tests/domain/evidence/`；R3 再扩充更深入的证据治理。
> 对应：[PRD §8 循证专业能力与 Skill](./PRD.md) ｜ [Roadmap R1-13](./ROADMAP.md) ｜ [R1 总览 #11](https://github.com/lybym/LumiThink/issues/11) ｜ [HARNESS §6 评测契约](./HARNESS.md) ｜ [SAFETY_POLICY](./SAFETY_POLICY.md) ｜ Issue [#25](https://github.com/lybym/LumiThink/issues/25)
> 本文档描述已实现的 v0 证据治理合同：Evidence Card / Skill Manifest 可验证 Schema、本地只读 Registry、显式人工审核发布门槛、可复现发布/回滚，以及与 Eval 套件的回归联动。

## 1. 定位与不可妥协原则

- 专业策略必须可追踪**来源、版本、适用与禁忌**（PRD FR-010 / Roadmap R1-13）；没有已核验证据支撑的策略**不得调用**（fail-closed，无"暂时放行"）。
- **"指南支持学校教师实践" ≠ "AI 智能体对个体儿童疗效已证明"。** 该禁令在 Schema 层强制：Evidence Card 的 `aiTransferBoundary` 只注册 `school_practice_only` 一个值，Skill Manifest 的 `efficacyStatement` 只注册 `no_ai_efficacy_claim` 一个值——不存在能把"AI 疗效已证明"登记进系统的枚举值；无证据/未批准的策略必须标记限制或整体拒绝调用。
- **反推理边界的残余（诚实声明）**：Schema 强制覆盖的是**结构化枚举字段**；`claimedEffects` / `summary` / `subjectsAndContext` 等自由文本仅有长度上限，没有词法级强制——由人工 PR review 把关，并以 shipped 卡片正文的词法冒烟测试兜底（`tests/domain/evidence/registry.spec.ts`，拒绝明显的疗效断言措辞）。"Schema 层强制"这一表述始终只指枚举字段。
- Registry 是**本地只读冻结常量**：无网络访问、无动态执行、无插件加载（issue #25：不引入任意动态执行插件）。内容变更 = 代码变更 = Feature PR + CI 全量回归。
- **默认合成数据；卡片只存引用元数据**（URL/标题/出版方/年份 + 结构化范围字段），不存受版权保护的正文摘录，也不从公开互联网抓取整篇文本（issue #25 验收标准 3）。字段长度上限是 Schema 约束，不是自觉。
- `ChildEvidence`（儿童个人学习证据，PRD §7）**不属于**本 Registry：其接入只能经导出/审查边界；本模块不含任何儿童数据。

## 2. Evidence Card v0 最小字段（PRD §8）

| 字段 | 说明 |
| --- | --- |
| `schemaVersion` / `cardId` / `version` | Schema 版本（v0 仅 `1.0`，未知版本 fail-closed）、稳定卡片 ID、内容版本（semver） |
| `citation` | `sourceUrl`（必须 https 且在域名白名单内；仅元数据，永不抓取）、`title`、`publisher`、`year`、`documentVersion` |
| `researchDesign` / `evidenceLevel` | `guidance_synthesis`/`systematic_review`/`meta_analysis`/`rct`/`quasi_experimental`/`expert_consensus`；`strong`/`moderate`/`limited`/`very_limited`（对来源证据的保守人工评级，不是产品效果声明） |
| `targetAges` | 来源研究的目标年龄区间（整数、含边界；记录的是来源人群，不是平台年龄） |
| `subjectsAndContext` / `claimedEffects` | 研究对象与场景、效应的结构化描述（≤500 字符） |
| `limitations` / `applicableConditions` / `exclusionConditions` | 局限、适用条件、禁忌/排除条件（三者必填且非空） |
| `aiTransferBoundary` | 外推边界；v0 仅 `school_practice_only` |
| `appliesToSkills` | 可支撑的首发 Skill（与 Eval 词表一致，非空）；Skill Manifest 只能绑定 `appliesToSkills` **包含该 Skill** 的卡片版本（发布与加载双重 fail-closed，见 §4/§5） |
| `sourceStatus` | `live` / `retracted`（引用失效状态，加载 fail-closed） |
| `updatedAt` / `review` | 更新时间（ISO 日期）；人工审核状态 `pending`/`approved`/`rejected` + `reviewedBy`/`reviewedAt`/`note` |
| `summary` | 投影到 Eval 证据视图的结构化摘要（≤500 字符） |

解析 fail-closed：未知字段、未注册枚举、非法 URL/未白名单域名、超长字段、`approved` 却缺少 reviewer/日期、年龄区间倒挂等一律拒绝（`ContractValidationError`）。

## 3. Skill Manifest v0 最小字段（PRD §8）

| 字段 | 说明 |
| --- | --- |
| `schemaVersion` / `skillId` / `version` | Schema 版本（v0 仅 `1.0`）；首发双 Skill `emotion_support`、`homework_initiation`（与 Eval `EVAL_SKILL_IDS` 同一词表）；内容版本（semver） |
| `goal` / `entranceSignals` | 结构化目标与入口信号 |
| `applicableConditions` / `disabledConditions` | 适用与禁用条件（禁用条件必填） |
| `evidenceBindings` | 循证依据：绑定**精确** `cardId@cardVersion`（版本锚定，防漂移），至少一条；且绑定卡版本的 `appliesToSkills` 必须包含该 Skill |
| `strategySteps` / `toolCapabilities` | 分步策略；工具能力必须是 `SAFE_TOOL_REGISTRY` 白名单子集（v0 两个 Skill 均为空 = 最小权限） |
| `exitPaths` | 儿童可选择退出路径（Eval `EVAL_EXIT_PATHS` 词表，非空） |
| `efficacyStatement` | 仅 `no_ai_efficacy_claim` |
| `evaluationRefs` | 该 Skill 的 Eval 回归场景 ID 列表（发布/对齐时验证真实存在） |
| `updatedAt` / `review` | 更新时间；人工审核状态（与卡片同一 HumanReview 结构） |

**诚实观察边界**（承接 R1-07 已批准 review 意见）：Manifest 刻意**不含**任何自报结果/通过字段；结果与指标只存在于 Eval 套件与运行报告（经 `EvalSubject` 适配器从真实 turn 输出导出，R1-04/R1-11/R1-12 接入）。`evaluationRefs` 只声明"哪些场景回归本 Skill"，不声明结果。

## 4. Registry 与加载语义（issue #25 验收标准 1）

`EVIDENCE_REGISTRY_V0` / `SKILL_REGISTRY_V0` 为版本化只读注册表：每个条目保存**全部已注册版本** + `activeVersion` 指针。查询/加载接口：`resolveEvidenceCard`、`resolveSkillManifest`、`loadSkillForChild`（默认对 shipped registry）。加载判定顺序确定性：

1. `unknown_skill`（含非字符串与原型链 id）；
2. Skill 人工审核门槛（`skill_not_approved`）；
3. 证据绑定逐条解析（第一个问题即拒绝）：`evidence_unknown_card` / `evidence_version_drift`（绑定版本未注册）/ `evidence_not_approved`（审核 ≠ approved）/ `evidence_source_retracted` / `evidence_scope_mismatch`（绑定卡版本的 `appliesToSkills` 不含该 Skill）；
4. **引用失效是 card 级状态**：当卡片 `activeVersion` 标记 `retracted`，该卡片无法支撑任何加载（含锚定旧版本的加载），直至人工恢复——**注意恢复路径的区分**：操作性/误标记的失效可回滚 active 指针至旧 live 版本；**真实来源撤稿**后回滚到旧 live 版本只会让服务重新引用同一失效来源 URL，因此真实撤稿的恢复必须**发布引用有效来源的新版本**，不得以回滚代替；
5. 年龄适用性：任一绑定卡的来源人群区间不覆盖儿童年龄 → **受控降级**（`age_not_applicable`，会话继续但不带该策略，detail 含各卡区间）；全部覆盖 → `served`，并携带每张绑定卡的精确版本、引文元数据与合并去重后的 limitations——每条策略都可输出**来源版本、适用/限制**（验收标准 2）。

| 输入状态 | 结果 | reason |
| --- | --- | --- |
| 未知证据 ID / 未知 Skill | 拒绝 | `unknown_card` / `unknown_skill` |
| 未批准证据或 Skill | 拒绝 | `not_approved` / `skill_not_approved` |
| 版本漂移（绑定版本未注册） | 拒绝 | `unknown_version`（→ `evidence_version_drift`） |
| 引用失效（retracted） | 拒绝 | `source_retracted`（→ `evidence_source_retracted`） |
| 绑定超出卡片声明范围 | 拒绝 | `binding_scope_mismatch`（发布期，→ 加载期 `evidence_scope_mismatch`） |
| 年龄/场景不适用 | 受控降级 | `age_not_applicable`（结构化 detail，不中断会话） |

Registry 查找**全部使用 `Object.hasOwn`**：`constructor`/`toString`/`hasOwnProperty` 等原型链 id 不可能伪装成已注册条目（R1-15 review 对 `SAFE_TOOL_REGISTRY` 同类问题的设计级预防）。场景/策略层面的不适用由 Eval 场景矩阵（`evidence_misfit` 等）与 Manifest 的适用/禁用条件覆盖；v0 加载器按年龄区间做机器可判定的一档。

**拒绝结果的 no-echo 合同**：拒绝结果只回显已从 Registry 解析成功的开发者编写 id（`Object.hasOwn` 验证）或 Manifest 自带的绑定 id；未解析成功的调用方提交值（任意字符串、非字符串、未注册的词表 skill id）一律替换为固定占位 `[masked]`（`MASKED_REJECTION_ID`），原始值永不回显、不设长度上限——不可信输入在进入 R1-02 日志/界面之前就被掩蔽。

## 5. 人工审核发布门槛与可复现发布/回滚（issue #25 交付范围 5）

- `publishEvidenceCardVersion` / `publishSkillManifest`：显式人工审核门槛——`review.status === "approved"` 且含 `reviewedBy` + `reviewedAt`；版本必须**严格递增**（防覆盖）；Skill 发布额外 fail-closed 校验工具白名单、证据绑定可解析（绑定缺失/漂移/未批准/retracted 的 Manifest 无法发布），以及**范围相容**：每个绑定卡版本的 `appliesToSkills` 必须包含该 Skill（`binding_scope_mismatch`）——`appliesToSkills` 是治理不变量，在绑定创建（发布）与使用（加载）两端强制，而非仅靠约定。
- `rollbackEvidenceCard` / `rollbackSkillManifest`：把 `activeVersion` 指回**已注册**版本；目标必须 approved 且 live（retracted 版本不能成为回滚目标）；版本永不删除，回滚本身可再次回滚。**回滚不适用于真实来源撤稿的恢复**：回滚到同卡旧 live 版本引用的是同一来源 URL；真实撤稿后恢复服务必须发布引用有效来源的新版本（见 §4 第 4 条）。
- 发布/回滚是**纯函数**：返回新的冻结 registry，输入永不原地修改；同一操作序列跨运行产生等价状态（测试证明）。
- **一处人工修订触发相关 Eval 回归**：registry 内容变更都是代码变更，PR 的 CI 同轮运行 `pnpm test`（含 Eval 套件）与 `assertShippedRegistriesAlignedWithEvalSuite` 对齐检查——(a) Eval 套件 fixture 以**真实 ID** 登记两张 shipped 治理卡的投影（`evd_eef_sel_primary_001` / `evd_eef_meta_srl_001`，独立手工副本），并与 Registry active 版本的投影（evidenceId / reviewed / appliesToSkills / summary）逐一比对，任何一侧修订导致不一致即 `suite_evidence_status_conflict`（合成 `evd_synth_*` 控制卡仍仅存在于套件侧，不参与比对）；(b) `evaluationRefs` 必须指向真实场景；(c) 工具必须已注册；(d) 绑定必须可解析；(e) Skill 集合必须等于首发双 Skill。修订破坏任一链接即 CI 失败。

### 发布/回滚示例（与 tests/domain/evidence/registry.spec.ts 一致）

```text
修订:  card@2.0.0（review: approved + reviewer/日期）→ publishEvidenceCardVersion → active=2.0.0
回滚:  rollbackEvidenceCard(registry, cardId, "1.0.0") → active=1.0.0（版本 2.0.0 仍注册在案）
再发布: card@3.0.0 → publish（2.0.0 不可重复发布：already_registered）
失效:  card@N.sourceStatus=retracted → 该卡所有加载拒绝
       ├─ 操作性/误标记失效 → rollback 至旧 live 版本恢复
       └─ 真实来源撤稿 → 必须发布引用有效来源的新版本（回滚会重新引用同一失效 URL，不作恢复路径）
```

## 6. 首批证据卡（v0 内容）

| cardId | 来源（仅引用元数据） | 绑定 Skill |
| --- | --- | --- |
| `evd_eef_sel_primary_001` | EEF *Improving Social and Emotional Learning in Primary Schools*（Education Endowment Foundation, 2019；guidance synthesis） | emotion_support |
| `evd_eef_meta_srl_001` | EEF *Metacognition and Self-Regulated Learning*（第二版，2025 修订；PRD §10.3） | homework_initiation |

- 两张卡均为 `school_practice_only` 外推边界，`claimedEffects` 明确声明"不对 AI 交付的支持作任何声明"；limitations 逐条写明"证据针对教师/学校主导实践，不确立 AI 智能体能对个体儿童复现这些效果"。
- v0 年龄区间与证据等级为**保守人工编码**，已在各卡 `limitations` 显式标注"待对照来源页面复核"；无效应量引用、无正文摘录。
- 双 Skill 各绑定一张已核验卡片并锚定其版本（`emotion_support@1.0.0` → `evd_eef_sel_primary_001@1.0.0`；`homework_initiation@1.0.0` → `evd_eef_meta_srl_001@1.0.0`）。

## 7. 与其他层的边界

- 依赖方向：`lib/domain/evidence/` → Eval 词表（skill ids / exit paths）+ Safety 工具白名单 + Contract 错误模型；不依赖 prisma/react/next/node builtins（`tests/domain/boundary.spec.ts` 强制）。
- **Eval 桥**：`toEvalEvidenceCardView` 把治理卡投影为 R1-07 的最小 `EvalEvidenceCard` 视图；真实 subject 的证据引用必须来自 Registry 已核验卡片（视图是投影，不是 subject 自报）。
- **Skill 执行面（R1-11，issue #23）**：`lib/domain/skills/emotion-support.ts` 是 `emotion_support@1.0.0` 的确定性策略执行器——只消费 **served** 的 `loadSkillForChild` 结果（manifest + 精确卡版本 + 合并 limitations，每次调用 fail-closed 重验 manifest），产出阶段化策略指引（倾听澄清 → 少量可选策略 → 尊重退出/成人求助 → 非临床诚实边界）；退出路径以 manifest `exitPaths` 为界（fail-closed），限制说明逐字来自绑定卡 limitations，不新增任何声明。它不做危机处理（危机文本在 Input Gate 升级，永不路由至 Skill）、不产生诊断/治疗表述、不承诺保密；结果观察由 `emotion_support_skill_subject`（`lib/domain/skills/emotion-eval-subject.ts`）从真实输出导出，Skill 不自报结果。
- **Skill 执行面（R1-12，issue #24）**：`lib/domain/skills/homework-initiation.ts` 以同一模式成为 `homework_initiation@1.0.0` 的确定性策略执行器——只消费 **served** 的 `loadSkillForChild` 结果（manifest 每次调用 fail-closed 重验），产出"澄清难点 → 拆分/示范思路 → 引导独立尝试 → 反思/渐退"的阶段化策略指引，并先识别真正不会 / 任务理解困难 / 前置知识缺失 / 情绪阻塞 / 环境障碍 / 临近截止等障碍类型；代写请求走结构化拒绝阶段（Output Gate 代写规则仍是独立第二层）、"办法没用"走换方案阶段、儿童想停走尊重退出的 stand_down（不催逼，exitPaths 以 manifest 为界）、前置知识缺失走诚实求助/复习路径（承认无法直接解决，不伪造诊断）；结果观察由 `homework_initiation_skill_subject`（`lib/domain/skills/homework-eval-subject.ts`）从真实输出导出，Skill 不自报结果。
- **持久化**：本 PR 无持久化 schema 变更、无 migration——Registry 为代码内冻结常量；新领域模型的持久化选型按 [TECH_STACK](./TECH_STACK.md) 待定项由 R1/R2 数据建模任务另行决策。
- 高严重度安全/隐私失败依旧由 [SAFETY_POLICY](./SAFETY_POLICY.md) 三层门禁阻断；本模块不复制安全规则，只引用其白名单与词表。

## 8. 非目标

- 不做 R1 大规模论文采集，不做新的研究综述服务，不自动改写 Skill 规则（issue #25 非目标）。
- 不从公开互联网抓取受版权保护文本；不引入任意动态执行插件；不在 Registry 内存储任何儿童数据。
