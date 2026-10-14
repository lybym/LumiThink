# ADR-0004: Child Memory v0 — 受控最小记忆（候选→确认→检索→更正→删除）

- 状态：Accepted（随 R1-14 / issue #26 交付 v0）
- 日期：2026-10-14
- 关联：[PRD §7](../PRD.md)（Child Memory 与学习证据）· [HARNESS §5.1](../HARNESS.md) · [TECH_STACK §3](../TECH_STACK.md) · [ADR-0003](./0003-guardian-auth-v0.md) · R1-09（数据生命周期，独立 Issue）

## 1. 背景

R1-14 要求最小受控记忆：经确认的偏好/必要事实、跨会话检索、儿童更正与永久删除；禁止自动写入心理/人格/诊断标签；所有写入服务端鉴权与审计；DSH 暂存会话与 Memory 库分开审计、清理。R1-15 以来 `memory.propose` 在工具注册表中就是 **candidate-only** 契约（候选永不直写），本 ADR 给出候选之后路径的首个实现决策。

## 2. 决策

### 2.1 词表即防线（无标签类型可写）

记忆类型只有两个：`confirmed_preference`（经确认偏好）与 `necessary_fact`（必要事实）。心理/人格/能力/诊断/分数类型**在词表中不存在**——写入它们不是"被规则拦截"，而是结构上不可能；提交此类类型得到区分性结构化拒绝（`memory.type_not_allowed`），便于审计与测试（issue #26 AC 2）。

在此之上，自动路径（`agent_proposal`，即 `memory.propose` 工具来源）另有**确定性标签词屏**（`MEMORY_LABEL_SCREEN_TERMS`，临床/人格词表的子串匹配，`memory.label_screen_block`）作为第二层防御。**边界声明**：该词屏只针对自动化生成；儿童陈述与监护人输入是显式、可审计的人为确认，不做正文词屏（类型词表对所有人适用）。

### 2.2 生命周期：候选 → 确认 → 检索 → 更正 → 删除

1. **候选**（`proposeCandidate`）：任何来源（agent 工具路径 = system 角色、儿童本人、监护人）只产生 candidate；角色矩阵拒绝 voice_device，儿童只能就本人 subject 提议。
2. **确认**（`confirmCandidate`）：唯一的"人明确点头"时刻——仅儿童本人或监护人；**system/agent 永远不能自我确认**（提议者与确认者分离，杜绝自动写入闭环）。重复（归一化 claim 相同的激活候选/事实）与冲突（同 subject+type 已有不同激活事实）均拒绝；过期候选拒绝确认。
3. **检索**（`retrieveForContext`）：最小必要——仅确认条目、排除过期与待复核（reviewAt）、默认排除敏感项（仅监护人/系统显式 `includeSensitive`）、新→旧排序、硬上限 8 条、返回 id+版本（正文不进上下文装配面，与 HarnessContext `context_refs` 纪律一致）。
4. **更正**（`correctMemory`）：不原地改写——新条目以 `supersedes` 指向旧条目，旧条目标记 superseded 并**永久退出检索**（不回放、不Checkpoint再灌入）；来源改为更正者的显式陈述（child_statement / guardian_input）。
5. **删除**（`deleteMemory`）：**硬删除**整个 `supersedes` 谱系（含祖先与后代），检索即 0；仅余结构化审计事实。不设 "deleted" 状态——不存在软删除残留。

### 2.3 冲突模型（确定性，无 NLP）

v0 冲突判定 = 同一 (subject, type) 仅允许一条激活事实；不同事实必须走更正（supersede）路径，事实历史保持线性、可追溯。这避免任何"语义矛盾"NLP 判定，同时保证 AC 1 的单偏好叙事（新偏好 = 更正，旧偏好失效）与 AC 2 的"冲突记忆拒绝"都有确定性语义。

### 2.4 鉴权与审计

- 每个操作经服务端 `parseActorContext` 重新验证（与合同一致：身份永不来自客户端自报）；儿童仅限本人 subject，voice_device 全拒绝，system 仅限提议/检索/清理，永不确认/更正/删除。
- **Memory 审计环**是独立结构（有界、`purgeAudit` 可独立清理），与 DSH Session / 运行时 Trace 分开（AC 3）；审计条目只含结构化事实（action/outcome/rule ids/ids），词表上不存在承载 claim 或儿童正文的字段（测试强制）。
- 失败路径零暗写：所有拒绝只落审计，不产生任何候选或条目（测试逐路径断言）。

### 2.5 运行时接线

- `memory.propose` / `memory.lookup` 工具在 Web 组合根绑定真实服务：提议 → 候选（候选不变式端到端保持，工具结果只报 id）；subject 由服务端钉定（v0 单一演示儿童，防 subjectRef 重定向）。
- pipeline 新增可选 `memoryContext` 钩子（R1-14）：每轮对绑定儿童的 actor 检索一次，refs（id+版本）并入 `context_refs`；提供者抛错或返回畸形条目 → 可观测降级为 0 refs（`memory.context` trace，`memory_context_failed`），读失败绝不中断回合、也绝不虚构数据。无钩子时行为与 R1-13 完全一致（零回归面）。

## 3. 与其他约束的关系

- **R1-09（数据生命周期）不吸收**：本 ADR 的删除 = Memory 库内的谱系硬删除 + 审计事实；跨存储的删除传播（DSH Session JSONL、Checkpoint、备份、导出物）属于 R1-09 的记录开关/查看/清除/审计范围。
- **旧数据隔离**：entry 词表无任何分数字段，旧 prisma CognitiveProfile 量化分数无法被正式模型继承（legacy intake guard 在 intake 处拒绝 legacy 形状）。
- **安全 Gate 不变**：`tool.memory_write_unauthorized`（直接写入权限请求）仍由工具层无条件阻断（#19 基线场景保持）；本 ADR 不新增任何工具注册项。

## 4. 持久化边界（诚实披露）

v0 的 Memory 库是**进程内内存**（与 #17 交互状态、#18 监护人会话/授权同纪律），按 subject 键控——确认的事实对**同进程内的新会话**可见（AC 1 的"新 Session 正确引用"即此语义）。**跨进程重启的持久化未做**：按 [TECH_STACK §3](../TECH_STACK.md)，新领域持久化选型待数据建模任务决策，prisma schema 保持零改动（无迁移、无迁移测试要求）；服务接口（`createMemoryService`）即未来的存储端口，持久化适配器可在不动领域语义的前提下替换。本边界已在 Issue #26 的 PR 中披露。

## 5. 后果

- 正面：标签自动写入结构上不可能；提议者/确认者分离；删除即真删除；审计与数据分离可独立清理；确定性冲突模型无需 NLP；零 prisma 改动。
- 代价/限制：单类型单激活事实（多偏好共存需 R2 词表扩展）；进程内持久化边界（见 §4）；`agent_proposal` 词屏是子串匹配（防自动化误记，不是语义理解）；更正继承原条目的 type/sensitivity（如需变更 sensitivity 属 R1-09/R2 治理面）。
