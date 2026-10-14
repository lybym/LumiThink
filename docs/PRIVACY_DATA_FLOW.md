# LumiThink 2.0 隐私数据流（PRIVACY_DATA_FLOW v0）

> 版本：v0 ｜ 日期：2026-10-14 ｜ 状态：**随 R1-09（issue #21）交付**
> 对应：[MEMORY_POLICY.md](./MEMORY_POLICY.md)（分类与保留策略）｜ [PRD §7 / §10](./PRD.md) ｜ [ADR-0005](./adr/0005-child-data-lifecycle-v0.md)
> 代码侧源头：`lib/domain/lifecycle/policy.ts`。**新数据种类进入系统前必须更新本矩阵（issue #21 AC 3）并随 PR 审查。**

## 1. 数据流（文本轮次，当前部署）

```
儿童浏览器 (Web 文本)
   │  POST /api/v1/interactions  ← 身份全部服务端注入，请求体无身份字段
   ▼
交互服务 (lib/server/interaction-service)
   ├─ 合同解析 → 授权门禁（家庭 consent，撤销即拒，含重放）
   ├─ 幂等台账 (verifiedActor, requestId)        [进程内存，仅结构]
   ├─ 会话记录 conversation record                [进程内存：id 映射；正文仅记录开关开启时保留]
   │
   ▼
Cordis 管线 (lib/domain/runtime)
   ├─ Input Gate（不落正文，只出结构化判定）
   ├─ 上下文装配（会话历史[记录开关] + 记忆 refs[id+版本，无正文]）
   ├─ Model Gateway → 进程内 Mock（本地无外发）   [审计 value-free]
   │     └─ （未来第三方供应商：受 third_party_data_egress 开关传输前门禁；数据流向 vendor_side）
   ├─ Tool Gate / memory.propose（候选直写禁止）/ memory.lookup
   ├─ Output Gate（完整草稿审定后才 emit）
   └─ Trace（value-free：规则/计数/id，无正文）
   │
   ▼
SSE 事件缓冲（临时工件）→ 输出 Gate 批准后的短句片段 → 儿童
（记录开关关闭：终态即清；开启：随进程生命周期或清除）
```

旁路结构：记忆域（候选→确认→检索→更正→删除）、监护人审计环、记忆审计环、删除台账——各自独立生命周期（分开审计、分开清理）。

## 2. 存储与保留矩阵（与 MEMORY_POLICY §2 同源）

| 数据种类 | 采集点 | 存储位置 | 键控 | 保留 | 删除路径 | 审计 |
| --- | --- | --- | --- | --- | --- | --- |
| 会话历史正文 | 儿童文本轮次 | 进程内存 | conversationId | 仅记录开关开启；每会话 40 条上限 | 主体级 erase | data_erase 计数 |
| 轮次事件缓冲（临时工件） | 每轮输出 | 进程内存 | traceId | 关闭时终态即清；开启时进程生命周期 | 主体级 erase（先取消在途） | data_erase 计数 |
| 会话/轮次 id 映射 | 服务分配 | 进程内存 | actorId/conversationId/sessionId | 进程生命周期 | 主体级 erase | — |
| DSH 会话映射 | 管线会话绑定 | 进程内存 | lumiSessionId | 会话生命周期 | 主体级 erase（关闭映射） | — |
| 领域记忆条目 | 儿童陈述/监护人输入/agent 提议（候选） | 进程内存 | subjectRef + memoryId | 记忆域规则 | 逐条 deleteMemory（谱系）+ 主体级 erase | memory.* + data_erase |
| 监护人审计环 | 安全相关事件 | 进程内存 | seq | 500 条有界 | 随进程生命周期 | 自身即审计 |
| 记忆审计环 | 记忆操作 | 进程内存 | seq | 256 条有界 | purgeAudit | 自身即审计 |
| 运行时 Trace | 每轮 | 进程内存 | traceId | 进程生命周期（value-free） | 随进程生命周期 | — |
| 网关审计 | 每次模型调用 | 进程内存 | requestId | 进程生命周期（value-free） | 随进程生命周期 | — |
| 删除台账 | erase/replay | 进程内存 | recordId | 100 条有界 | 随进程生命周期 | data_erase_replay |
| 音频 | — | **无采集路径** | — | 不采集不存储 | 不适用 | — |
| 供应商侧数据 | 第三方外发开启时 | 供应商侧 | 供应商控制 | 供应商评审结论（待核实） | **不可由本系统担保** | 传输前门禁计数 |

## 3. 角色可见性矩阵（actor-scoping）

| 数据 | 儿童（本人） | 监护人 | 独立管理员（admin） | system | voice_device |
| --- | --- | --- | --- | --- | --- |
| 自己的会话正文（记录开启时） | 经 SSE 实时流 | 经**授权导出**（data_export，仅 guardian） | 不可见（只读监督面无正文） | 工具路径最小 refs（无正文） | 全拒绝 |
| 他人会话正文 | 不可见（actor-scoped SSE） | 不适用（单家庭） | 不可见 | 不可见 | 全拒绝 |
| 记忆条目（正文/claim） | 本人 subject 读写（确认/更正/删除） | 家庭 subject 全操作 + 导出 | 不可经数据面查看（inventory 无正文） | 仅提议（候选）与检索 refs | 全拒绝 |
| 数据清单（计数与 id） | — | 可读（data_read） | 可读（data_read，只读监督） | — | — |
| 主体级导出 | — | 仅 guardian | **拒绝**（CONTRACT_WRONG_ROLE） | — | — |
| 主体级删除/重放 | — | 仅 guardian | **拒绝** | — | — |
| 审计环内容 | — | 可读（结构化事实） | 可读 | — | — |

跨主体访问一律得到与"不存在"不可区分的结构化拒绝（无存在性泄露）；所有身份由服务端验证后构造，客户端无法自报任何角色。

## 4. 跨存储删除传播（AC 1）

一次主体级 erase 的传播顺序（`lib/server/data-lifecycle-service.ts`）：

1. 取该儿童的会话/轮次快照（此刻是 sessionId ↔ conversationId 配对的唯一可见点）；
2. 取消在途轮次（输出永不触达儿童）；
3. 硬删除全部会话记录与历史正文、全部轮次事件缓冲；
4. 记忆域逐条谱系硬删除（检索同源同存 → 跨 Session 检索为 0）；
5. 关闭被删会话的 DSH 会话映射（被删会话无法恢复进入旧 DSH 会话）；
6. 写入结构化 tombstone（删除台账），供恢复后重放删除。

value-free 结构（Trace / 网关审计 / 各审计环）不携带正文，因此不属于"清除后可恢复儿童正文"的暴露面；它们的清理边界各自独立（MEMORY_POLICY §2）。

## 5. 变更审查规则（AC 3）

- 新数据种类：先加 `DATA_KIND_POLICIES` 行 + 本矩阵行 + 数据流图节点，随 PR 审查；正文类种类必须有删除路径（测试强制）。
- 新存储位置（如引入 SQLite/持久化）：按 [TECH_STACK §3](./TECH_STACK.md) 数据建模决策 + DATA_MODEL 更新 + 迁移/迁移测试，并复审本矩阵（当前全部为进程内存，零 prisma 差异）。
- 新供应商：独立数据外发评审前不接通；供应商保留/地域事实一律 pendingVerification。
