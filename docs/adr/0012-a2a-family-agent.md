# ADR-0012：单 Agent、家庭多用户与 A2A Task 权威

- 日期：2026-10-25
- 状态：Accepted（Design GO）；实现及阶段门禁待完成。
- 依据：[整体方案 V1.1](../A2A_DESIGN.md)、[Task 契约 V1.0](../TASK_LIFECYCLE.md)。

## 决策

采用一个 LumiThink Agent，经 A2A v1.0.1 / JSON-RPC HTTPS + SSE 服务工作 DSH、飞书及小智。家庭是业务租户，共享事实但按用户、关系和操作授权；会话与上下文独立。Client 认证与 Principal 认证分开，A2A tenant 和 contextId 不作为授权凭据。声纹只提供候选用户。

Task Manager 唯一写入公开任务及 Artifact；SQLite 事务包含状态、请求账本与 Outbox。Task 与 Turn 一对多，Execution 与 epoch 有明确租约。SSE 断开不取消；取消意图、真实停止和最终结算分开。公开正文只追加，片段元数据属于更新事件；取消后不完整结果必须显式标明。删除优先于常规留存，恢复执行当前删除/撤权记录。

## 与既有决策的关系

保留 ADR-0001/0002 的内部 DSH 与 Runtime Bridge；补充 Task Manager 为外部状态权威。取代 ADR-0011 中将专用 Gateway UDS 作为未来公共接入的拓扑目标，但旧链路在迁移验收前仍运行。扩展 ADR-0003 的单监护人认证为家庭多主体，保留最小权限与凭据保护；补充 ADR-0004/0005/0006 的 Task/Outbox 删除与恢复要求。其余安全、ASR、TTS、模型出口决策继续有效。历史 ADR 不回写成“已实现 A2A”。

## 代价与验收

需要实现身份委托、Task 仓储事务、客户端取消与交付适配；不能只换 URL。P0 固定版本与回滚，P1 以官方客户端和真实 Worker 验证。候选 DSH 插件需 P2 补足远端取消与会话恢复。此决策不批准上线、Tag 或 Release。
