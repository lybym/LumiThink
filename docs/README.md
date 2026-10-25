# LumiThink 文档索引

**设计评审通过（Design GO）。P0/P1 获准开展，协议互通、真实取消、设备验收和部署切换仍受各阶段 Gate 约束。**

| 文档 | 用途 |
| --- | --- |
| [A2A_DESIGN](A2A_DESIGN.md) | V1.1 正式整体方案，含两轮评审结论 |
| [TASK_LIFECYCLE](TASK_LIFECYCLE.md) | V1.0 生命周期、事务、取消与恢复规范 |
| [ARCHITECTURE](ARCHITECTURE.md) | 组件、身份、家庭事实与运行时边界 |
| [ROADMAP](ROADMAP.md) / [P0_P1_PLAN](P0_P1_PLAN.md) | 阶段 Gate、Issue 拆分及依赖 |
| [JSON Fixtures](fixtures/a2a-v1.0/README.md) | 事件字段归属、聚合结果与取消抑制示例 |
| [ADR-0012](adr/0012-a2a-family-agent.md) | 新决策与历史 ADR 的关系 |
| [TECH_STACK](TECH_STACK.md) / [DSH_UPSTREAM](DSH_UPSTREAM.md) | 工具链与兼容性冻结 |
| [PRD](PRD.md) / [PERSONA](PERSONA.md) / [SAFETY_POLICY](SAFETY_POLICY.md) | 业务目标、人格与安全 |
| [PRIVACY_DATA_FLOW](PRIVACY_DATA_FLOW.md) / [MEMORY_POLICY](MEMORY_POLICY.md) / [EVIDENCE_POLICY](EVIDENCE_POLICY.md) | 授权、数据生命周期与来源 |
| [HARNESS](HARNESS.md) / [RELEASE_GATE](RELEASE_GATE.md) / [RELEASE_NOTES](RELEASE_NOTES.md) | 验证与发布边界 |

API_CONTRACT、VOICE_RUNTIME、VOICE_GATEWAY_PROTOCOL 保留已交付 Web/内部 IPC/旧 UDS 说明；各页开头标注新阶段变更。旧 R0/R1/E2E 记录和 ADR 是历史证据，不是 A2A Gate 已通过的依据。协议细节以锁定的官方 A2A v1.0.1 为准，应用生命周期以 TASK_LIFECYCLE 为准；发现实现不一致时提交修订记录，不能静默改变约束。
