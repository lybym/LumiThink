# ADR-0003: R1-06 监护人鉴权与授权的部署模型（v0）

> 状态：已接受（随 R1-06 交付）｜ 日期：2026-10-14 ｜ 对应：[Issue #18](https://github.com/lybym/LumiThink/issues/18)、[PRD FR-005 / UC-06](../PRD.md)、[Roadmap R1-06](../ROADMAP.md)、[API_CONTRACT §12](../API_CONTRACT.md)、[TECH_STACK §3/§6](../TECH_STACK.md)

## 背景

R1-05 交付的 Web MVP 以服务端注入的固定合成演示儿童身份运行（#17 评审披露：监护鉴权属 R1-06）。R1-06 要求首期单家庭 Child/Guardian/Admin 的可信服务端身份关系、家长鉴权、角色分权、会话隔离、服务端权限判定，以及"会话、Cookie、安全头、防 CSRF/重放、敏感配置存储按同一部署模型审查"并留审计。

## 决策

1. **部署模型与 #17 一致**：单进程、进程内内存状态（会话、授权、审计、风格状态）。不引入持久化 schema——新领域持久化选型仍按 TECH_STACK §3 待定，本 PR 保持 prisma schema 零差异。代价（进程重启复位监护人会话/授权状态）在 PR 与 API_CONTRACT §12.5 书面披露。
2. **会话 = 服务端不透明 Bearer 令牌，不引入 Cookie**：256-bit 随机令牌仅存服务端（绝对 TTL 8h、可撤销、上限 32 个），仅经 `Authorization` 头传输。无 Cookie 即无环境凭据，CSRF 对监护人路由无攻击面；防重放沿用交互路径 (verifiedActor, requestId) 幂等台账 + 授权变更幂等转移。此决策在真实浏览器部署引入 Cookie 需求（如"保持登录"）时复议。
3. **登录验证**：单家庭两个服务端配置账户（监护人 / 独立管理员），SHA-256 摘要 + 常数时间比较；5 次失败全局锁定 15 分钟（单家庭 MVP 下全局锁定的可用性代价可接受，审计可见）。**演示访问码是公开合成常量**（`GUARDIAN_DEMO_ACCESS_CODE` / `ADMIN_DEMO_ACCESS_CODE`），在 UI 明示为演示材料——真实凭据的存储/轮换/哈希属 R1-08（Secrets 管理），届时替换为本 ADR 的唯一变更点。
4. **安全头**：`next.config.ts` 全路由追加 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: strict-origin-when-cross-origin`。完整部署加固（HTTPS/HSTS/CSP nonce）属 R1-08。
5. **审计**：追加式有界环记录全部安全变更（登录成败/锁定/注销/告知确认/授权与开关变更/风格变更/拒绝访问/监护取消）；条目仅结构化事实，凭据与提交文本结构性排除（测试强制）。
6. **撤销即生效的强制点**：家庭 consent `child_model_interaction` 撤销 → 交互服务 submit-time 钩子在幂等台账之前拒绝新家庭轮次（含重放）；开关 `third_party_data_egress` 关闭 → 供应商 `dataEgressAuthorized` 动态置 false，网关在传输前拒绝（供应商请求数 0）。
7. **独立管理员 ≠ 合同新角色**：管理员以合同 `system` 角色 + 独立 actorId 验证（childRef null），可读状态/审计、**不可**变更家庭授权（监护授权是家长职责，维护者不得绕开——PRD 角色边界）。

## 备选方案（未采用）

- **Cookie 会话 + CSRF 令牌**：为单家庭 MVP 引入 Cookie 语义、SameSite/CSRF 双重提交等面，收益仅"刷新保持登录"，拒绝。
- **持久化账户/授权表（prisma 迁移）**：触发 TECH_STACK §3 的持久化选型决策（该决策属于独立的数据建模任务），并要求 DATA_MODEL + migration + migration test；R1-06 的 AC 全部可在进程内模型下满足，拒绝在本 PR 内扩大范围。
- **引入 401/新错误码**：9 码注册表稳定优先；无有效会话 = 不可信身份（403 `CONTRACT_UNTRUSTED_IDENTITY`），语义一致。

## 后果与回滚

- 监护人状态为进程内：重启后需重新登录；种子状态（告知已确认 + 基础 consent 有效 + 外发开关关闭）随之复位——这是有意的 fail-closed 默认。
- 回滚：还原本 PR（Git revert）即可整体撤销鉴权面；无数据迁移、无 schema 变更。
- 后续：R1-08 替换演示访问码为真实 Secret 管理并补部署加固；R1-09 数据生命周期 UI 复用本会话/角色面。
