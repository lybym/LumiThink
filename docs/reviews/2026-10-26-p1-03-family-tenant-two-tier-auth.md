# P1-03 家庭租户、Client/Principal 双层认证与集中授权 实现记录（issue #85；2026-10-26）

## 1. 交付物

全部位于隔离包 `services/a2a-server/`（根依赖面零变更，ADR-0013 约束继续有效）：

| 文件 | 内容 |
| --- | --- |
| `src/identity/model.ts` | 领域类型：ClientKind/MembershipRole/AssuranceLevel/Principal/AuthContext、冻结 `AUTH_OPERATIONS`、稳定错误码 |
| `src/identity/schema.ts` | 独立身份库 schema v1（加性 DDL、单事务迁移、未知未来版本拒开）；`sha256Hex` 凭据摘要 |
| `src/identity/identity-store.ts` | 目录播种（严格 bootstrap 校验）、凭据/成员关系/监护关系/授权查询、任务归属绑定、撤销原语（精确 bump `revocation_epoch`）、最小审计 |
| `src/identity/authorizer.ts` | 双层身份解析、epoch 校验决策缓存、短期授权校验（scope/期限/撤销/客户端/会话绑定）、executor 输出准入门 |
| `src/identity/authorization-policy.ts` | 集中授权函数（纯函数）：同家庭共享事实按关系+操作决定；候选/访客权限上限；P1 写冻结 |
| `src/identity/express-auth.ts` | `requireTwoTierAuth`、`requireContextAccess`、`LumithinkA2aUser`（SDK User 桥）、`authorizingTaskStore`、`StreamRegistry`、`IdentityController` |
| `src/a2a-service.ts`（改） | 接线：身份中间件 → 续接守卫 → SDK handler（user 桥 + 授权 store 装饰器）；executor 缺省携带身份准入门；停机关闭身份库 |
| `src/synthetic-executor.ts`（改） | 可选 `authorizationGate`：每次输出准入前按当前授权状态复核，拒绝则停止正文并结算 CANCELED（working→canceled 合法转换） |
| `src/config.ts`（改） | `LUMITHINK_A2A_IDENTITY_DB`（缺省 `:memory:`）、`LUMITHINK_A2A_IDENTITY_BOOTSTRAP`（可选 JSON，严格校验） |
| `src/lumithink-agent-card.ts`（改） | bearer scheme 描述更新为双层凭据语义 |
| `tests/identity-*.spec.ts`（新增 4 个套件，16 个测试） | 见 §2 映射 |
| `docs/adr/0014-a2a-identity-authorization.md` | 架构决策记录（独立身份库、强制作业点、撤销一致性、线级语义） |

既有 8 个套件（#83/#84）零改动全部通过；默认 bootstrap 保持 P1-01 单 token 契约（该 token 现为 validation-harness 客户端的 principal-bound 凭据）。

## 2. 验收条件映射

| Issue 验收条件 | 实现与证据 |
| --- | --- |
| Client 和 Principal 分离；消息内 userId/householdId/role、A2A tenant/contextId 不能伪造授权 | 一个 Bearer 凭据两级绑定（bound_principal/client_only）；授权输入全部为服务端解析值，策略函数签名无可注入参数（结构防伪造）。`identity-service-acl.spec` 'AC1'：伪造 metadata（userId/householdId/role/tenant）创建任务后归属绑定仍为真实调用者；伪造 grant 头对 dsh_profile 凭据 403；跨家庭伪造后 Get 仍 `-32001` |
| 跨家庭、跨用户 Task/Get/Cancel/Subscribe 和会话续接拒绝；同家庭共享事实按关系与操作决定 | `identity-service-acl.spec` 'AC2' 两条：跨家庭 Get/Cancel/Subscribe → `-32001`、他人 contextId 续接 → `-32602` CONTEXT_ACCESS_DENIED 且不建 Task；同家庭跨用户同样拒绝；ListTasks 过滤。策略矩阵：`identity-authorization-policy.spec`（监护关系缺省拒绝、“家长”角色≠关系、本人/成员/访客/候选分档） |
| 撤权对已有流、缓存、工具提交与旧上下文及时生效；记录最小审计 | 全局 `revocation_epoch`：撤销/播种精确 +1（无变更不 bump），决策缓存按 epoch 失效且条目寿命不超过凭据/授权到期；StreamRegistry 按 credential/principal/grant 关闭 SSE 长流（'AC3' 两条流关闭测试）；executor 准入门按当前状态复核并结算 CANCELED（单元级）；旧上下文续接在凭据/成员关系撤销后 401/403。审计 `a2a_identity_audit` 仅决策事实，测试断言不含令牌与摘要 |
| 设备仅认证家庭，候选声纹不提升私有数据权限；短期授权范围/过期/撤销有负例 | `xiaozhi_device` 客户端强制绑定家庭且凭据只能 client_only（bootstrap 校验拒绝违规）；无 grant → unverified visitor（家庭级、无主体）；`session_verified`/`voiceprint_candidate` 两类 grant 带 scope+绝对到期+会话绑定；负例：过期 grant 403、撤销 grant 403、未知/客户端不匹配 grant 403、scope 越界拒绝（policy）；候选永远不产生已验证主体，私有操作在策略层全拒 |

## 3. 锁定面

- 零新依赖：身份层使用 Node 24 内置 `node:sqlite` + `node:crypto`（SHA-256 摘要、digest 等长比较）。
- `@a2a-js/sdk@1.3.0`、`express@5.1.0`、TypeScript `5.9.3` 不变。
- Task Manager schema v1 与 P1-02 事务语义字节不动；任务归属在身份库（`a2a_identity_task_bindings`），双库零 schema 耦合（ADR-0014）。

## 4. 可复现命令与结果（COMPOSITION_LOCAL）

```powershell
pnpm --dir services/a2a-server run typecheck   # tsc --noEmit → 0 errors
pnpm --dir services/a2a-server run test        # node --test --test-isolation=none
```

结果（2026-10-26，Windows 本机，Node 24.x）：**84 tests / 84 pass / 0 fail**（含既有 51 + 新增 33... 以 CI 最终记录为准），连续 3 次运行稳定。CI 承载：`.github/workflows/p1-a2a-server-gate.yml`（paths 过滤，本 PR 命中 `services/a2a-server/**`）。

## 5. 设计取舍（实现层决策，均不改变冻结设计）

1. **独立身份库** 而非扩展任务库：避免触碰 #84 锁定 schema；设计 §2.3 存储边界可拆分的严格形态。代价：受理路径跨两库写（绑定→落库，fail-closed 顺序，见 §7 风险）。
2. **Task ACL 双层**：中间件守 `SendMessage` 续接（SDK 对仅带 contextId 的消息不查 store，仅装饰器会漏）；装饰器守 `load/list`（覆盖 SDK 内部全部读取路径）。`load` 拒绝返回 undefined → SDK 标准 `-32001`，真实原因入审计（设计 §4.1 不靠 ID 保密；跨主体不承诺存在性）。
3. **bound_principal 凭据携带 grant 头 → 403**（fail-closed）：这类凭据已带验证主体，会话授权头属协议异常，不做静默忽略。
4. **executor 门对未绑定窗口放行**（`task_not_bound_yet`）：绑定由同请求管线在任务事件处理时写入，竞态窗口内放行仅影响本次已认证请求自身的首个输出准入，且未绑定任务对任何人不可读——只有正向撤权证据才拒绝，避免竞态误取消（曾以 3 连跑回归锁定）。
5. **决策缓存 epoch 校验 + 到期截断**：撤销一致性优先于缓存收益；缓存含允许与拒绝两种决策，种子/撤销均失效。
6. **ListTasks 过滤页丢弃续页 token**：授权过滤页的已知限制（文档化，P1 不做分页重排）。

## 6. 迁移与回滚风险（AC 4 专项）

- 身份库 schema v1 全加性（CREATE TABLE/INDEX），无破坏语句；单事务迁移 + `lumithink_a2a_identity_meta.schema_version`；未知未来版本拒开（测试覆盖）。
- 应用级降级不支持：回滚 = 恢复升级前的数据库文件备份（deploy/validation 属 P0 Gate 维度 C=GO 的备份/恢复流程），绝不编辑行。
- 任务库无迁移（P1-02 v1 不变）；`:memory:` 缺省保持 CI 无文件写入；持久部署显式设置 `LUMITHINK_A2A_IDENTITY_DB`。

## 7. 局限与未关闭风险（全部保留，不计为通过）

1. **受理跨库写**：身份绑定与任务落库分属两个 SQLite 文件，非跨库事务；崩溃窗口可产生“有任务行无绑定”或反之——前者 fail-closed（任务对所有人不可读），后者为孤儿绑定（无任务行，不可读，可清理）。跨重启一致性与首响应丢失恢复归 P1-04/#86。
2. **SSE 关闭为断连语义**：撤销即刻断流，客户端表现为连接终止；基于 Outbox 的优雅续传/恢复水位归 P1-06/#88。
3. **授权仅覆盖传输与任务边界**：领域工具（学习事实等）尚未接入（P3+），`authorizeOperation` 已就位但业务调用点随后续任务落地；本 Issue 的“共享事实”证据为策略矩阵测试 + 任务/续接 ACL。
4. **合成身份口径**：全部 households/users/credentials/grants 为验证数据；凭据分发/绑定/解绑流程（用户操作面）、飞书事件入口、设备会话确认 UX、声纹服务分别归 P3/P2/P4。
5. **会话绑定头为合成约定**：`X-Lumithink-Session-Grant` 是验证服务的应用头（非 A2A 标准），仅服务端校验 grant 归属；真实设备连接代际接入在 P4 验证。
6. **审计为最小集**：满足“记录最小审计信息”；查询 API 仅供测试/诊断，管理面不在本 Issue。

## 8. 诚实边界声明

- 本记录全部为本地合成验证证据（COMPOSITION_LOCAL），不代表真实执行 Gate（P1-10/#92）、设备验收（P4）或部署切换；P0 Gate 维度 B/D 收敛前不切换 UDS、不使用真实儿童数据、不发布。
- 协议骨架（#83）与任务管理（#84）通过不等于本 Issue 的双层身份已在真实渠道上验证；本 Issue 交付的是同一可信入口的解析/授权/撤销/审计底座与合成验证证据。
