# LumiThink 儿童 Safety Gate 策略（SAFETY_POLICY v0）

> 版本：`v0` ｜ 策略版本：`1.0`（`SAFETY_POLICY_VERSIONS`）｜ 状态：**策略定义与领域层强制随 R1-15 交付；HTTP/UI/DSH 接线由 R1-03/R1-05 承接。本文件不将未接线部分描述为已可用的端到端功能，且全部证据均基于合成数据。**
> 对应：[Issue #27](https://github.com/lybym/LumiThink/issues/27) ｜ [PRD FR-005 / FR-002 / FR-007、§5.1、§10.1](./PRD.md) ｜ [Roadmap R1](./ROADMAP.md) ｜ [架构](./ARCHITECTURE.md) ｜ [Harness 合同](./HARNESS.md) ｜ [API 合同](./API_CONTRACT.md)
> 代码：`lib/domain/safety/`（策略注册表 + 三层 Gate + 危机分支 + Trace + 轮次流水线）｜ 测试：`tests/domain/safety/`

## 1. 目的与信任模型

Safety Gate 是儿童交互的强制安全边界：每一条进入编排的文本、每一次工具调用、每一段将要呈现给儿童的输出都必须通过对应层级的检查。

- **规则由服务端拥有**：全部规则、策略版本与决策语义只存在于 `lib/domain/safety/` 的注册表中。用户消息、检索文档、工具结果与模型输出一律视为不可信攻击面（PRD §10.1），不能新增、删除或改写任何规则、策略版本或决策。
- **fail-closed 默认**：未知策略版本、未知规则 ID、未知入口、未知决策或原因码一律拒绝；不存在"暂时放行"路径（issue #27 验收标准 2）。Output Gate 自身不可用、抛错或返回不可用结果时，本轮输出被阻断（`output.gate_unavailable`）。
- **不回显原则**：Gate 结果与 Trace 只包含结构化事实（规则 ID、风险级别、决策、再验证过的关联 ID），永不包含提交文本、工具参数、被拦截内容或任何原始敏感内容。未知字段（含 `refs` 内未知字段）被解析器拒绝，杜绝借道夹带。
- **独立防线不替代**：模型供应商数据审核（PRD §10.1–10.3）与工具 Side Effect 授权（HARNESS §4、R1-03a 最小权限）是本 Gate 之外的独立防线；本策略不声称已覆盖这两项。

## 2. 三层强制边界

三层独立生效，不能只依赖 System Prompt 或一次 LLM 自检（PRD §5.1 安全分层、HARNESS §5 安全断点）：

| 层 | 执行位置 | 模块 | 拦截对象 |
| --- | --- | --- | --- |
| `input` | 进入编排之前 | `lib/domain/safety/input-gate.ts` | 提示注入、家长/职员身份伪造、隐私越权请求、危机线索 |
| `tool` | 工具执行之前 | `lib/domain/safety/tool-gate.ts` | 危险类目/权限、未注册工具、schema 伪造、越权记忆写入、角色越权 |
| `output` | 输出呈现给儿童之前 | `lib/domain/safety/output-gate.ts` | 排他依恋、保密施压、临床诊断伪装、代写作业、不适龄内容、数据泄漏、危机漏转介 |

## 3. 规则注册表（策略版本 1.0）

规则 ID 是稳定、可检索的结构化标识；Trace 只能引用本注册表内的 ID，未知 ID fail-closed（`SAFETY_RULES` / `SAFETY_RULE_IDS`）。摘要只描述结构，不内嵌攻击载荷或真实数据。

| 规则 ID | 层 | 风险级别 | 结构性定义 |
| --- | --- | --- | --- |
| `input.prompt_injection` | input | high | 提交文本试图覆盖或探测受信系统指令 |
| `input.role_forgery` | input | high | 提交文本伪造家长/监护人/管理员/系统身份或自报验证 |
| `input.privacy_overreach` | input | high | 请求他人/其他儿童的隐私数据或受保护系统数据 |
| `input.crisis_signals` | input | high | 自伤/虐待/严重危险线索触发危机分支（§5） |
| `tool.dangerous_category` | tool | high | 请求禁止类目或权限（shell/PTY、任意 FS/网络、插件安装、子 Agent、裸数据库） |
| `tool.unregistered` | tool | high | 调用未在白名单注册的工具 |
| `tool.schema_forgery` | tool | high | 声明的类目/版本与注册描述符不符 |
| `tool.memory_write_unauthorized` | tool | high | 请求直接记忆写入而非仅候选提议路径 |
| `tool.privacy_overreach` | tool | high | 验证角色无权调用该工具，或请求儿童数据导出/原始音频 |
| `output.exclusive_dependency` | output | high | 宣称排他关系或鼓励情感依赖 |
| `output.secrecy_pressure` | output | high | 要求儿童保密或承诺向家长/监护人保密 |
| `output.diagnosis_claim` | output | high | 给出临床诊断或治疗性断言（伪装临床咨询） |
| `output.ghostwriting` | output | medium | 表示代替儿童完成作业 |
| `output.age_inappropriate` | output | high | 含不适龄的色情或暴力内容 |
| `output.data_leak` | output | high | 泄漏凭据/密钥、受保护环境数据或非本会话儿童引用 |
| `output.crisis_referral_missing` | output | high | 危机升级轮次的输出不是确定性危机安全回应（漏转介即阻断） |
| `output.gate_unavailable` | output | high | Output Gate 自身故障，本轮 fail-closed（验收标准 2） |

## 4. 决策语义

决策枚举只有 `allow | block | escalate_crisis`，没有"暂时放行"。决策优先级固定：**escalate_crisis > block > allow**；风险级别由命中规则的最高严重度计算得出，永不由调用方提供。

### 4.1 Input Gate（入口层）

- v0 使用确定性模式规则（合成语料调校），朝安全方向保守：高严重度模糊线索宁可误拦。
- 命中注入/伪造/越权模式 → `block`；命中危机线索 → `escalate_crisis`。危机优先于其余决策，但共同出现的攻击规则仍全部记入 Trace。
- `escalate_crisis` 表示**常规建议脚本暂停**：不再进入正常编排与工具调用，唯一可输出的是 §5 的确定性危机安全回应。

### 4.2 Tool Gate（工具前层）

- 正向白名单：v0 仅注册 `evidence.search`（只读）、`memory.lookup`（受控读）、`memory.propose`（仅候选）；新工具只能在此注册并通过 Gate 测试。
- 调用方声明的类目/版本必须与注册描述符一致（防 schema 伪造）；未注册工具拒绝且不回显提交 ID。
- 危险类目/权限（shell、任意 FS/网络、插件安装、子 Agent、裸 SQL、`memory.direct_write`、`child_data.export`、`raw_audio.read`）无条件拒绝；记忆只存在候选提议路径。
- 调用角色必须在该工具的允许角色列表内（`voice_device` 在 v0 无文本轮工具权限）。所有拒绝结构化并可审计，不以提示词约束代替权限约束（HARNESS §4）。

### 4.3 Output Gate（输出后层）

- **每轮文本输出必须通过 Output Gate**（issue #27 交付范围 5）；检查排他依恋、保密施压、诊断伪装、代写、不适龄内容、凭据/密钥与外部儿童引用泄漏。
- 输出上限 4000 code points，与合同响应上限对齐（API_CONTRACT §4/§5）；非字符串或超限属于结构化失败。
- 危机升级轮次只允许输出确定性危机安全回应：内容与必需回应不一致、或调用方无法给出必需回应时，按危机漏转介阻断。
- **fail-closed 包装（验收标准 2）**：`runOutputGateSafely` 保证 Gate 抛错、不可用或返回不可用结果时，返回确定性的 `block` + `output.gate_unavailable`，不存在放行路径。
- R1-V 的增量短句播报复用本策略（同一规则、同一决策语义），语音流接线在 R1-V2 另行交付。

## 5. 危机转介分支

自伤、虐待、严重危险线索触发危机分支（`crisis.ts`）：

- 类目固定为 `self_harm | abuse | severe_danger`，判定优先级固定：self_harm > abuse > severe_danger，保证确定性。
- 危机回应为**固定模板拼接的确定性文本**，契约由测试断言：非诊断（无临床标签与判断断言）、暂停常规建议、明确鼓励立即联系可信任的大人、给出本地紧急渠道（110/120、青少年热线 12355）、绝不承诺保密、明确说明 AI 无法独自处理危机、适龄平实语言。
- 模板中的紧急渠道是面向 zh 部署的公开占位值；**生产启用前必须按部署地域核实并配置正确渠道**。仓库、Issue、CI 与一般日志中不出现真实儿童资料（仅 `[synthetic]` 语料）。
- 危机回应本身也经过 Output Gate 复检（§4.3），保证"输出必须过 Gate"对危机分支同样成立。

## 6. 结构化 Trace

每个 Gate 决策产生一条结构化记录（`trace.ts`），字段固定：`policyVersion`、`layer`、`decision`、`ruleIds`、`riskLevel`、`reason`、`entrance?`、`refs`、`decidedAt`。

- `riskLevel` 由命中规则计算，不允许调用方指定；`allow` ⇔ 规则列表为空 ⇔ `low`；`escalate_crisis` 仅在 input 层合法。
- `reason` 只能取 `rule_hit | crisis_escalation | gate_unavailable`。
- `refs` 仅允许 `requestId/traceId/turnId` 三种关联 ID，且必须通过合同 ID 词汇再验证（未验证值丢弃）；未知字段（顶层与 `refs` 内）一律拒绝，原始敏感内容无法借道写入。
- `decidedAt` 为 ISO-8601 UTC 时间戳；解析器对未知策略版本、未注册规则、不一致的决策/规则关系 fail-closed。

## 7. 三条强制入口

Issue #27 验收标准 3 要求 UI、API、DSH Tool 三条入口均强制有效：

| 入口 | 枚举值 | 接线责任 |
| --- | --- | --- |
| Web UI 文本轮 | `ui_web` | R1-05 最小 Web 儿童端 |
| 文本 API | `api_text`（`POST /api/v1/interactions`） | R1-02+/R1-03 |
| DSH 工具调用 | `dsh_tool` | R1-03 DSH/Cordis 插件组合 |

- 三条入口共用同一策略注册表与同一 Gate 语义；后续接线层**必须**调用 `evaluateTurnSafety` 流水线（或各层 Gate），不得绕行或自建平行安全词汇。
- 每条 Trace 记录产生它的入口（`entrance`），保证任意决策可归因到入口、策略版本与规则。

## 8. 轮次流水线

`evaluateTurnSafety`（`pipeline.ts`）是三条入口共用的组合点，顺序固定：

1. **Input Gate** 作用于提交文本：`block` → 本轮中止（不执行工具、不产出输出）；`escalate_crisis` → 切换危机分支，忽略常规草稿，仅输出危机安全回应。
2. **Tool Gate** 逐个评估工具候选：任一 `block` → 本轮中止，不再进入输出生成。
3. **Output Gate** 通过 fail-closed 包装评估草稿输出：被阻断的草稿不产生最终输出。

只要发生阻断，`finalOutput` 为 `null`；Trace 按决策顺序排列（input → tool → output）。`lib/domain/` 边界约束（无 prisma/react/next/db 导入）由既有边界测试继续强制。

## 9. 版本化、变更与回滚

- 策略版本注册表 `SAFETY_POLICY_VERSIONS`（当前 `["1.0"]`）是接受新版本的唯一途径；未知版本 fail-closed。新增规则/版本只能修改注册表并通过全部 Gate 测试，不接受运行时注入。
- 每条 Trace 携带 `policyVersion`，策略变更后历史决策仍可归因到当时的规则集。
- **回滚说明**：策略变更走独立 PR；回滚即还原该 PR 的注册表/规则改动（Git revert），Gate 语义随注册表恢复，无需数据迁移。安全失败阻断发布（PRD FR-007、Roadmap R1 退出门槛）；R0 的 35/35 零 SKIP 门禁不受本策略影响。
- v0 模式规则面向合成语料调校；召回率/误报的持续调优与基线对比由 R1-07 Evaluation Harness 承接，调参同样走"注册表 + 测试 + 回归"路径。

## 10. 非目标

- 不声称系统提供临床咨询或心理治疗，不替代现实救援与监护职责（issue #27 非目标）。
- v0 是确定性结构规则，不是生产级 NLP 分类器；不承诺覆盖全部绕过手法。
- 不含语音流接线（R1-V2）、不含模型供应商数据审核与工具 Side Effect 授权（独立防线）、不含 R1-06 监护人鉴权载体。
- 全部语料与示例为合成数据；禁止加入真实儿童资料、录音或密钥。

## 11. 验收标准 → 测试映射

| Issue #27 验收标准 | 测试 |
| --- | --- |
| 合成提示注入、家长角色伪造、工具 schema 伪造、越权记忆写入、排他关系/保密/不当诊断/危机漏转介：高严重度 0 漏过 | `tests/domain/safety/input-gate.spec.ts`、`tool-gate.spec.ts`、`output-gate.spec.ts`、`pipeline.spec.ts`（三入口 × 攻击类目零穿透） |
| 模拟 Output Gate 不可用时 fail-closed | `output-gate.spec.ts`（"AC 2" 用例）、`pipeline.spec.ts`（gate outage 阻断整轮） |
| 结构化 Trace 记录策略版本与拒绝原因；UI/API/DSH Tool 三入口均强制有效 | `trace.spec.ts`、`input-gate.spec.ts`（AC 3）、`pipeline.spec.ts`（AC 3 三入口全序列） |
| 危机分支：暂停常规建议、确定性安全回应、鼓励联系可信成年人与本地支持 | `crisis.spec.ts`（回应契约 + 复检过 Gate）、`pipeline.spec.ts`（危机轮次） |
| Trace 不记录原始敏感内容（含 refs 侧信道） | `trace.spec.ts`（未知字段/未知 refs 字段拒绝且不回显）、各 Gate spec 的不回显用例 |
