# LumiThink Harness 合同（HARNESS.md v0 草案）

> 版本：v0（草案）｜ 日期：2026-10-13 ｜ 状态：**合同草案，无实现**——本文描述 2.0 Harness 的执行图与接口契约，作为 R1-03/R1-07 的实施输入；除 `poc/dsh-child` 的 R0 SDK 证据外，本文件描述的能力均未实现。  
> 对应：[PRD §5 Harness 行为契约](./PRD.md) ｜ [ADR-001](./adr/0001-deepseek-harness.md) ｜ [ARCHITECTURE](./ARCHITECTURE.md) ｜ [R0 DSH PoC](./R0_DSH_POC.md) ｜ [TECH_STACK](./TECH_STACK.md)  
> R1-00 交付说明：本文由 Issue #12 建立 v0；执行图/接口为稳定合同候选，供评审，不代表可用功能。

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

## 2. State / Context（v0 草案字段）

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

- 契约：`complete(request: ModelRequest): AsyncIterable<ModelDelta> | ModelResult`；`ModelRequest` 含 `model_id`、`messages`、`tool_schema`、`timeout_ms`、`budget`、`trace_id`。
- 可替换性（PRD FR-004）：Mock Provider（R0 已验证的合成路线）与真实 Provider 实现同一契约；`model_id` 与供应商版本写入审计。
- 失败模式：超时 → 取消并返回结构化错误；供应商不可用 → 明确降级文案（不虚构回答）；预算超限 → 拒绝并审计。
- v0 现状：**未实现**；R0 的 `poc/dsh-child` 仅验证了 SDK/Mock 路由与最小权限 Profile，根工程基线无任何模型出网。

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

## 6. 评测契约（v0）

- 固定合成场景集（复用 [R0_DSH_POC §0](./R0_DSH_POC.md) 四场景的合成标识 `child_demo_001`，并扩展 R1-11/R1-12 双 Skill 适用/无效/拒绝/危机/过度介入用例）。
- 断言以**确定性规则**为主（工具白名单、数据隔离、记忆修订、权限、超时/取消）；语言质量以人工评估为主，LLM Judge 仅辅助（Roadmap 技术路线表）。
- 每次规则/Persona/Skill 变更可生成与基线的对比报告；报告记录 DSH 版本、插件/Persona/Skill 版本与脱敏结果。
- 严重儿童安全/隐私用例零 SKIP、零未解决失败（延续 R0-02 门禁精神）。

## 7. 与 DSH 的集成边界（v0）

- LumiThink 领域能力（Persona/Evidence/Memory/Safety/协议）通过 SDK + 自定义 Cordis 插件接入，**不修改 DSH 上游核心**；版本锁定与升级审查按 [DSH_UPSTREAM](./DSH_UPSTREAM.md)。
- 业务持久化不依赖 DSH 私有事件格式；DSH Session 与 Lumi 长期记忆、审计 Trace 分离存储。
- 进程拓扑：独立长驻 Node 进程持有 SDK（见 [TECH_STACK §2](./TECH_STACK.md)）；Serverless/短生命周期 Handler 不得托管 DSH 生命周期。

## 8. 未决问题（进入实现前必须回答）

1. Input Gate 的监护人/儿童鉴权载体（R1-06 未实现；v0 仅定义 `actor` 语义）。
2. Context Builder 的记忆检索排序与预算分配算法（依赖 R1-14 受控记忆落地）。
3. Orchestrator 对双 Skill 冲突请求的仲裁规则（R0-C 场景 3 的实现细节）。
4. Output Gate 的规则清单与误报处理流程（需要 R1-07 评测集支撑）。
5. Recorder 的最小审计字段与脱敏规则（与 R1-08 日志治理合并决策）。
