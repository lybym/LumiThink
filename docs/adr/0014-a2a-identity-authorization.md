# ADR-0014：A2A 身份与集中授权层（家庭租户、Client/Principal 双层认证）

- 日期：2026-10-26
- 状态：Accepted（P1-03/#85 实现依据）
- 依据：[整体方案 V1.1](../A2A_DESIGN.md) §5–§7、[Task 契约 V1.0](../TASK_LIFECYCLE.md) §1/§7/§8、[ADR-0012](0012-a2a-family-agent.md)、[ADR-0013](0013-a2a-server-isolated-package.md)、P0 Gate #82 结论（隔离开发，不切 UDS、不用真实数据）。

## 决策

P1-03（#85）在 `services/a2a-server/src/identity/` 建立独立身份与集中授权模块，作为 DSH、飞书、设备授权共用的同一可信入口（P1 全部使用合成身份验证）：

1. **独立身份存储**：身份层拥有自己的 SQLite 数据库（`LUMITHINK_A2A_IDENTITY_DB`，缺省 `:memory:`），自带版本化迁移（`lumithink_a2a_identity_meta.schema_version`，当前 v1）与未知未来版本拒开的 fail-closed 契约。**Task Manager schema（P1-02，v1）保持字节不动**——任务归属记录在身份库的 `a2a_identity_task_bindings`，而非任务库；两个模块零 schema 耦合。
2. **双层身份、单凭据**：一个 Bearer 凭据同时绑定 Client Identity（已登记客户端：`dsh_profile` / `feishu_adapter` / `xiaozhi_device`）与 Principal Identity（已验证用户 / 受限访问者）；服务端只存 SHA-256 摘要。`xiaozhi_device` 客户端必须绑定家庭（设备仅认证家庭），且其凭据只能是 `client_only`（不得携带已验证用户）。
3. **集中授权函数**：`authorization-policy.ts` 的 `authorizeOperation` 是同家庭共享事实“按关系与操作决定”的唯一决策点；输入全部为服务端解析值（AuthContext、成员角色、监护关系），函数签名中不存在任何可由消息内容注入的身份参数——消息内 `userId/householdId/role`、A2A `tenant`/`contextId` 在结构上无法伪造授权。
4. **强制作业点**（全部位于 SDK handler 之前或之外，失败不建 Task）：
   - `requireTwoTierAuth`：凭据解析（未知/撤销/过期 → HTTP 401 + `-32000` AUTHENTICATION_REQUIRED；客户端有效但主体失效（成员关系撤销等）/grant 被拒 → HTTP 403 + `-32000` PERMISSION_DENIED）；
   - `requireContextAccess`：`SendMessage`/`SendStreamingMessage` 携带已绑定他人的 `contextId` 续接 → `-32602` + ErrorInfo `CONTEXT_ACCESS_DENIED`；
   - `authorizingTaskStore` 装饰器：受理时先写任务归属绑定再落库（fail-closed 顺序），`load` 按归属校验（拒绝 → 返回 undefined，由锁定 SDK 产生标准 `-32001` TaskNotFound——对调用者而言任务不存在；真实原因入审计），`list` 过滤为调用者授权范围内任务；
   - Synthetic executor 的 `authorizationGate`：每次输出准入前按服务端**当前**状态复核（权限撤销 → 停止正文准入并结算 CANCELED）。
5. **撤销一致性（epoch）**：身份库维护全局 `revocation_epoch`；凭据/成员关系/短期授权撤销及目录播种各精确 +1（无变更不 bump）。Authorizer 的决策缓存以 epoch 校验，且缓存条目寿命不超过其编码的凭据/授权到期时间——撤销对缓存、SSE 长流（StreamRegistry 按 credential/principal/grant 关闭连接）、工具提交（executor gate）与旧上下文续接即时生效，无 TTL 窗口。
6. **最小审计**：`a2a_identity_audit` 仅记录决策事实（action/decision/reason、credential/client/principal/household/task/context 标识、时间）；不落令牌（含摘要）、不落消息正文、不落儿童数据。
7. **短期授权**：`a2a_identity_grants` 承载设备会话确认（`session_verified`）与声纹候选（`voiceprint_candidate`）两类短期授权，均带 scope（冻结 `AUTH_OPERATIONS` 子集）、绝对到期时间与会话绑定；请求经 `X-Lumithink-Session-Grant` 头引用，服务端校验存在性/期限/撤销/客户端绑定/会话绑定，且 bound_principal 凭据携带该头一律拒绝（协议异常 fail-closed）。候选授权永不携带已验证用户，私有数据操作在策略层全部拒绝。

## 理由

- 独立身份库避免为身份表修改 P1-02 已锁定的任务 schema 与事务语义（模块边界 = ADR-0013 的隔离原则在模块间的延伸）；设计 §2.3 要求存储边界支持后续拆分，按模块分库是其最严格形态。
- Task/Context ACL 放在 TaskStore 装饰器 + 中间件双层，是因为 SDK 对“仅携带 contextId 的续接消息”不查询任务存储——仅装饰器会漏；仅中间件则覆盖不了 SDK 内部 `load` 路径。两层叠加且失败语义一致。
- `load` 拒绝返回 undefined（对调用者呈现 TaskNotFound）遵循设计 §4.1“逐条校验引用归属，不靠 ID 保密”：授权不依赖 ID 保密，但跨主体访问不承诺存在性；真实原因由审计承载。
- epoch 缓存失效替代 TTL：设计 §5.3 要求“每次请求检查凭据及绑定状态”，纯 TTL 缓存存在撤销窗口；epoch 方案把一致性成本压到每次一次整数比较。

## 边界与后续

- 本 ADR 不实现渠道身份入口本体：飞书事件验证、DSH Profile 凭据分发、设备会话确认 UX、声纹识别服务分别归 P3/P2/P4；本层只冻结它们共用的解析、授权、撤销与审计接口。
- ListTasks 过滤页丢弃续页 token（授权过滤页的已知限制）；持久 Outbox 驱动的优雅 SSE 恢复归 P1-06/#88；持久幂等受理与首响应丢失恢复归 P1-04/#86。
- 不切换现有 UDS 链路、不使用真实儿童数据、不发布；P0 Gate 维度 B/D 收敛前本层仅以合成身份在回环验证环境运行。
