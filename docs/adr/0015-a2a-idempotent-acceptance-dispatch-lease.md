# ADR-0015：持久幂等受理、首响应丢失恢复与执行派发租约（P1-04）

- 日期：2026-10-26
- 状态：Accepted（P1-04/#86 实现依据）
- 依据：[整体方案 V1.1](../A2A_DESIGN.md)、[Task 契约 V1.0](../TASK_LIFECYCLE.md) §4/§5/§7、[ADR-0013](0013-a2a-server-isolated-package.md)、[ADR-0014](0014-a2a-identity-authorization.md)、P0 Gate #82 结论（隔离开发，不切 UDS、不用真实数据）。

## 决策

P1-04（#86）把原为进程内/测试面 API 的请求账本与派发租约接入真实受理链，全部位于隔离包 `services/a2a-server/`（根依赖面零变更）：

1. **受理点在锁定 SDK handler 之前**（express 中间件 `requireIdempotentAcceptance`，挂载于双层认证与会话续接守卫之后）：`SendMessage`/`SendStreamingMessage` 的幂等判定不能依赖 SDK 内部行为——SDK handler 对新消息自行生成 taskId 并直接派发执行器，重复请求在那里已无法拦截，executor 层也无法产生协议要求的 JSON-RPC 参数错误（executor 异常只会结算为 FAILED Task）。中间件持有唯一权威仓储的**具体** `SqliteTaskManager`；调用方自定义 TaskStore 时整体旁路（幂等/租约是仓储所有权语义，不做半套接线）。
2. **作用域化请求键 + 版本化 HMAC 指纹**（`src/acceptance/request-key.ts`）：键 = `agent + household + principal + client + channel(clientKind) + messageId` 的 JSON 数组编码（对字符串元组单射，分隔符碰撞不成立），成分全部来自服务端认证绑定——消息内身份字段与 A2A tenant 字段结构上不可参与去重（ADR-0014 防伪造原则的延伸）；访客以“客户端绑定”为稳定受限主体。指纹 = `fpv1:` + HMAC-SHA256(服务端持久密钥, canonical JSON(message))：递归键排序保证重序列化重试等价；数组序保留（parts 顺序有语义）；显式排除 JSON-RPC id、令牌、returnImmediately/阻塞模式、historyLength 与展示项（§5.1）——阻塞发送与其立即返回/流式重试指纹一致。密钥经 `LUMITHINK_A2A_FINGERPRINT_KEY` 配置，合成缺省仅用于 P1 合成口径（指纹只覆盖 id 与合成验证文本）；持久部署必须设置自己的密钥，存储侧不留无密钥可枚举摘要（§5.4）。
3. **先绑定、后落库（预分配 taskId）**：受理门预生成 taskId/contextId，先写身份库归属绑定（ADR-0014 的 fail-closed 顺序），再以同一 taskId 调 `acceptInput`（P1-04 扩展：接受预分配 id）。两库无跨库事务，该顺序使崩溃窗口只产生“指向不存在任务的孤儿绑定”（无害、可清理），而不是“无绑定的不可读任务 + 永久占用的账本键”。受理事务（账本+Task+Turn+history+Outbox）提交后，中间件把 taskId/contextId 注入请求消息再放行 SDK handler——SDK 以既有 taskId 加载任务并派发，不新建任务；taskId 在提交后尽早对客户端可见（§4.1 步骤 5）。
4. **重复消息 = 原任务快照，不重跑推理**：同键同指纹命中时，受理门复核任务 ACL（§5.2 权限已撤销 → 标准 `-32001`，真实原因入审计），然后直接以 `Task.toJSON` 快照应答——`SendMessage` 返回 JSON-RPC result；`SendStreamingMessage` 返回单帧 SSE（帧格式与 SDK 一致）。不做“等待原执行完成”的阻塞重连：客户端按 §5.2/§5.3 以 GetTask/Subscribe 恢复，P1 证据口径为“同 taskId、单执行、零重复推理”。
5. **同键不同内容 / 墓碑**：指纹不符 → JSON-RPC `-32602` + ErrorInfo `MESSAGE_ID_CONFLICT`（线级错误不携带原任务 id 或内容——同键必然同主体，仍按最小暴露原则不回显）；墓碑键 → `-32000` + ErrorInfo `RESULT_PURGED`，永不重跑。`write_lock_busy` 映射为显式可重试错误（受理按键幂等，重试安全）。
6. **派发租约装饰器**（`leaseDispatchExecutor`，包住任意内层执行器）：配额复查（可注入 `quotaGate`；拒绝 → 发布 REJECTED，submitted→rejected 合法，不占执行槽）→ 事务性 `claimExecution`（条件更新 submitted→working + 执行/租约行原子提交；**已持久化取消意图 → 新结果 `canceled_pre_dispatch`**，发布 CANCELED，无 Worker 启动——§7.1.4 取消×派发竞争以同一条件更新裁决）→ 当前状态授权复查（P1-03 准入门；拒绝 → CANCELED）→ 内层执行。claim 提交与 Worker 启动之间故障保留执行记录、不盲目重试：SDK 把执行器失败结算为 FAILED，重启恢复（P1-05/P1-08）以持久状态重新裁决。
7. **取消意图先本地持久化**：装饰器 `cancelTask` 先 `recordCancelIntent`（独立事务：意图 + 关闭输出准入 + Outbox cancelCommand），再补发远端取消（内层执行器）；重复取消命中 already-recorded/already-terminal，无新副作用——持久化意图 → 远端取消补发可测（AC 2）。
8. **仓储层收口（含前序 Review 移交项）**：任务库 schema v2（加性：`a2a_request_ledger.tombstoned_at_ms`）；`claimExecution` 取消意图检查；`admitChunk`/归属核验对**已持租执行要求出示租约**（review #101 ⑤：省略 leaseId 不再放行）；bridge save 的 Turn/history 派生改为按消息身份（review #101 ⑥：窗口化快照不丢消息、不重复建 Turn）；bridge 追加正文前复核输出准入（review #101 ①：取消意图/准入关闭后的新快照分片 → `output_admission_closed`）；`purgeTaskBody`（正文清除 + 账本墓碑 + `tombstoned_at_ms`，Outbox 载荷天然无正文，重放/重试不复活正文——P1-08 清理编排的仓储原语）。`Authorizer.grantScopeOf` 零引用死代码移除（review #102 决策：清理；P1-05 需要时再以真实调用点回归）；`task_not_attributable` 与 `credential_expired` 门分支补直接负例断言（review #102 测试收口）。
9. **保留窗口初值可配置**（AC 4）：24h 重试 / 7d 结果 / 墓碑 ≥30d（`LUMITHINK_A2A_RETENTION_*`，墓碑窗口有硬性 30 天下限，低于即拒绝启动）；派发租约 TTL（缺省 5 分钟）同样可配置。窗口的执行（清理作业、到期回收）归 P1-08/#90。

## 理由

- 受理点选择中间件而非 executor：只有 handler 之前才能 (a) 阻止 SDK 为重复请求生成第二个 taskId，(b) 对冲突/墓碑产生协议层 JSON-RPC 错误（executor 异常只能结算成 FAILED Task，违反 §5.2“不生成新任务”），(c) 在提交后才派发（§4.1 步骤 5）。
- 快照直答而非事件重放：P1 的 Outbox 交付契约（消费水位、切点）归 P1-06/#88；快照 + GetTask/Subscribe 已满足“恢复原任务、不重复推理”，且不预支 P1-06 的交付语义。
- 指纹用 HMAC 而非无密钥哈希：账本将长期保留（≥30 天墓碑），无密钥短句摘要在库泄露场景下可被字典枚举（§5.4 明文/可枚举摘要禁令）。
- `canceled_pre_dispatch` 作为独立结果而非复用 `stale`：调度器需要区分“输掉竞争（他人已领取，静默退出）”与“取消意图先到（由本路径发布 CANCELED 结算）”，两者的事件行为不同，混用会造成双结算或漏结算。
- lease 持有者强制出示：原实现“未出示即跳过持有者比对”使租约退化为可选项；租约的存在意义就是把回调归因到持有所，缺出示即归属失败。

## 边界与后续

- 真实 DSH Worker、Worker 注册/租约核对与重启恢复扫描归 P1-05/#87 与 P1-08/#90；本 ADR 的执行记录（execution/lease/worker_id）为其保留归属键，派发装饰器内层可替换。
- 阻塞式重复请求的“等待原执行完成”未实现（快照直答 + 客户端重附着）；Outbox 驱动的流式恢复水位归 P1-06/#88；CancelTask 完整语义族（取消×完成竞争结算表、outputSuppressedAfterCancel）归 P1-07/#89。
- 配额门缺省放行，真实资源限额/背压归 P1-09/#91；`purgeTaskBody` 的跨表编排（缓存/渠道待发/启动扫描）归 P1-08/#90。
- 不切换现有 UDS 链路、不使用真实儿童数据、不发布；本 ADR 全部证据为合成口径（COMPOSITION_LOCAL）。
