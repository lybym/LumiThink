# LumiThink — 发光的思考

循证、儿童优先、隐私优先的家庭智能体。通过小智语音、工作 DSH 和飞书访问同一套 LumiThink，由统一用户体系决定能读取、写入哪些家庭事实。

**2026-10-25：设计评审通过（Design GO）。P0/P1 获准开展，协议互通、真实取消、设备验收和部署切换仍受各阶段 Gate 约束。** 文档通过不代表 A2A 服务、SDK 互通或设备迁移已经交付。

## 正式设计基线

- [A2A 整体方案 V1.1](docs/A2A_DESIGN.md)：单 Agent、家庭租户、双层身份与三端接入。
- [Task 生命周期与运行时执行契约 V1.0](docs/TASK_LIFECYCLE.md)：唯一 Task Manager、SQLite 原子持久化、取消与恢复。
- [P0/P1 执行计划](docs/P0_P1_PLAN.md)：任务范围、依赖、验收与解决顺序。
- [架构](docs/ARCHITECTURE.md) · [路线图](docs/ROADMAP.md) · [文档索引](docs/README.md) · [ADR-0012](docs/adr/0012-a2a-family-agent.md)。

## 目标架构

```text
小智（设备 / VAD / ASR / TTS / 立即止播） ─ A2A Client ─┐
工作 DSH（工具插件，独立工作会话）       ─ A2A Client ─┼─ LumiThink A2A Server
飞书（消息事件与用户绑定）               ─ A2A Client ─┘   A2A v1.0.1 / HTTPS JSON-RPC + SSE
                                                        │
                        Client + Principal → 家庭 / 用户 / 数据关系授权
                                                        │
                       Task Manager → Persona / Safety / Memory / Learning
                              │                         │
                  SQLite Task / Ledger / Outbox    Runtime Bridge → 专属 DSH Worker
```

只有一套 Agent。共享家庭业务事实不等于所有成员都能读取全部记录，也不等于共用聊天历史。工作 DSH 是外部客户端，内部 DSH 是受控执行引擎，两者不共享会话或文件系统。XVF3800 声纹用于选择候选用户，不能单独授予私有学习记录的读取权。

Task Manager 管理任务状态，Runtime Bridge 管理真实执行，渠道适配器管理发送和播放。SSE 断开不自动取消 Task；显式 CancelTask、内部 epoch fencing、真实 Runtime 停止和设备止播共同构成打断闭环。

## 当前实现与迁移边界

| 层面 | 已有基础 | 下一阶段 |
| --- | --- | --- |
| 运行时 | 现有 DSH Bridge、真实 Worker、取消及合成竞态测试 | 接入统一 Task Manager，验证标准客户端到真实执行闭环 |
| 小智 | 既有 UDS Provider 和语音队列；10 月 24 日交接记录包含 XVF3800 对话与打断，也记录 hello 异常 | P0 核对实际补丁与配置；P2 预验证，P4 完整迁移 |
| 家庭业务 | 已有 Persona、安全、受控记忆与 Evidence 领域基础 | 同一 Agent 下的多用户授权，正式事实接入与来源核验 |
| 外部访问 | DSH 插件、飞书均为新接入路线 | P1 官方客户端核心互通；P2 DSH；P3 飞书 |
| 发布 | 历史候选 1.0.0-rc.1 已组装，保留原证据 | A2A Design GO 不变更版本、不替代发布批准 |

TTS 备份分支已通过集成修订保留有效代码，原 PR #76 的候选由该集成收敛；运行目录与仓库仍有待 P0 核对的版本及覆盖补丁，详见 [集成记录](docs/reviews/2026-10-25-tts-baseline-reconciliation.md)。设备仍使用测试 profile 的交接记录，不能作为真实学习记录已接通的证据。历史成功、当前持续稳定和正式验收是不同结论。

## 开发与验证

原仓库工具链为 Node 24.21.0 / pnpm 10.34.7，P0 将记录完整版本矩阵；本次没有更新依赖。以下命令验证既有 Web/领域工程，不会启动尚未实现的 A2A 服务：

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
pnpm run start --port 3123
```

DSH 既有隔离基线见 [R0 验收记录](poc/dsh-child/docs/R0-02_ACCEPTANCE.md)，旧设备部署见 [runbook](deploy/xiaozhi/runbook.md)。A2A 的启动、迁移及测试命令由 P0/P1 随实现交付，不在文档中预设已经可用。

## 安全与数据

家庭共享底座按主体、关系、用途和操作授权；原始儿童对话另设策略。默认不长期保存原始音频，真实儿童正文、声纹材料和凭据不进入公开 Issue、CI 或普通日志。使用合成数据验证门禁。

删除个人数据和撤回相应处理授权优先于 Task 常规留存。查询、流订阅、缓存和恢复均执行当前权限与删除台账；必要幂等墓碑不得还原正文。学习摘要保留来源、周期、覆盖情况和不确定性，不用模型编造事实。

LumiThink 帮助儿童逐步独立，不作临床诊断，不塑造与亲子关系竞争的排他依赖。
