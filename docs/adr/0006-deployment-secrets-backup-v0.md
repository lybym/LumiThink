# ADR-0006: R1-08 单机部署、Secrets、脱敏审计与加密备份恢复（v0）

- 状态：Accepted（随 R1-08 / issue #20 交付 v0）
- 日期：2026-10-14
- 关联：[Issue #20](https://github.com/lybym/LumiThink/issues/20) · [PRD FR-006](../PRD.md) · [Roadmap R1-08](../ROADMAP.md) · [TECH_STACK §3/§6](../TECH_STACK.md) · [ADR-0003](./0003-guardian-auth-v0.md)（决策 2/3/4 的 R1-08 处置）· [ADR-0005](./0005-child-data-lifecycle-v0.md)（§2.3 备份保留边界的兑现）· [MEMORY_POLICY](../MEMORY_POLICY.md) · [PRIVACY_DATA_FLOW](../PRIVACY_DATA_FLOW.md) · [deploy/runbook.md](../../deploy/runbook.md)

## 1. 背景

R1-08 交付单台 Linux 云主机的部署方案、Secrets 管理、脱敏审计 Trace 与加密备份/恢复（issue #20 交付范围与 AC）。此前状态：全进程内存（#17/#18/#26/#21 同纪律）、无离线备份（#21 披露）、监护人用公开合成演示码、全局登录锁定、CSP 缺位（ADR-0003 决策 2/3/4 显式移交 R1-08）、删除台账已为"备份引入之日"备好重放（ADR-0005 §2.3）。

## 2. 决策

### 2.1 部署模型：受限进程 + TLS 反向代理（单机模块化单体）

单台 Linux 主机：**systemd 受限进程**（`deploy/lumithink.service`：专用系统用户、ProtectSystem=strict、无能力集、系统调用过滤、环回绑定 `-H 127.0.0.1`）+ **Caddy TLS 反向代理**（唯一公网入口 443，HSTS，受限域名）。端口白名单与暴露扫描核验见 runbook §1。DSH Runtime 为进程内适配器（无对外 socket）；SQLite 未启用；内部管理面不存在公网路由。最小容器备选留待 R1-10 环境一致性时按需评估（issue 允许"受限进程或最小容器"二选一）。

### 2.2 Secrets：环境/受控挂载注入，注册表枚举 + 审计脱敏

- 真实监护人/管理员访问码经 `LUMITHINK_GUARDIAN_ACCESS_CODE` / `LUMITHINK_ADMIN_ACCESS_CODE` 注入（**必须成对**，12–128 字符，禁用公开演示码）；组合根只把 **SHA-256 摘要**交给监护人服务（常数时间比较不变），原文仅注册进 Secrets 注册表用于脱敏。未配置 = 披露的演示模式（CI/本地不变）。
- `lib/server/secrets-registry.ts` 是唯一枚举点：六个 slot（模型 API Key / DSH Profile / 监护人码 / 管理员码 / 快照密钥 / 外发目标）各带来源与最小授权说明；`describeSlots()` 只给 presence + 4 位指纹，任何方法不返回原文。`redact()` 接入监护人审计发射路径（纵深防御）。env 校验失败只报变量名（继承 #12 no-echo）。
- **ADR-0003 决策 3 处置（诚实披露）**：真实凭据已支持，但登录锁定**仍为全局统一拒绝**（防枚举语义不变）。按账户锁定需要登录请求携带账户提示（合同 v1.0 变更）或引入可归因信号——issue #20 范围不含该合同变更，留待显式后续任务；演示码公开导致的"平凡 DoS"随真实凭据部署消除（失败计数仍可被匿名请求推高，代价为 15 分钟窗口，runbook §8 披露）。

### 2.3 安全头：CSP nonce 兑现（ADR-0003 决策 4）

`middleware.ts` 每请求铸造 nonce，CSP 以 `script-src 'nonce-…' 'strict-dynamic'` 授权脚本（生产无 unsafe-eval）；`style-src 'unsafe-inline'`（React style 属性 + framer-motion 注入 `<style>` 的既知残余，只能污染不能执行）；`frame-ancestors 'none'`、`object-src 'none'`、`base-uri/form-action 'self'`。HSTS/TLS 属代理层。**残余**：行内样式仍允许；nonce 随 dev 模式含 unsafe-eval（仅 development）。

### 2.4 审计 Trace 增强：Token 成本入 Trace

运行时 Trace 新增 `model.completed` 事件（request_id、model/provider、attempts、inputTokens/outputTokens/costMicroUsd、durationMs），与既有 `persona.resolved`（policyVersion）、`skill.routed`（skillVersion/evidenceRefs）、`model.failed`（gatewayCode/contractErrorCode/resultCode）一起，单轮即可回答"谁、哪个模型、什么版本、花了多少、错在哪类"。全部 value-free（正文结构性排除，既有纪律不变）。错误分类的失败路径由 pipeline AC2 测试覆盖。

### 2.5 加密备份/恢复：选定事实源 = 进程内组合态，AES-256-GCM 快照

- **选型**：TECH_STACK §3 的持久化选型仍是独立数据建模任务；R1 部署的**选定事实源**为单进程组合态。快照子系统把该状态序列化为一个**强制加密**的文件（AES-256-GCM，magic+iv+tag+密文；`lib/server/snapshot/`），原子写（tmp+rename）。**prisma schema 保持零差异**——快照是部署基础设施而非新领域 schema，无 DATA_MODEL/migration 触发。
- **触发**：确认型监护人变更（授权/开关/风格/擦除/重放）**立即**原子写入；周期快照（默认 60s）；SIGTERM/SIGINT 停机冲刷；启动时若有快照文件则恢复。
- **包含**：授权/告知/开关、风格+溯源、监护人审计环（有界 500 + seq 连续性）、已保存会话历史+完整记忆条目（复用生命周期导出面）、内容无关删除台账（seq 连续）、幂等台账（防重放延续）。**排除（fail-closed 披露）**：活跃 Bearer 会话（恢复后必须重新登录）、锁定计数、网关当日预算计数（每日窗口）、观测用 Trace/记忆审计环、DSH 会话映射（新进程按需新建）。
- **恢复语义（AC 2 的两半）**：恢复**当前**快照 = 已确认事件不丢（删除先于快照 ⇒ 内容已清 + 墓碑已在）。恢复**旧档** = `deploy/restore.sh` 自动置 `LUMITHINK_SNAPSHOT_RESTORE_REPLAY=1`，启动恢复后**一次性重放删除台账**（`replay_child_deletions`，ADR-0005 §2.3 的设计对应物）——恢复永不复活被删数据。恢复完成写入 `snapshot_restored` 审计（结构性计数）并落一份恢复后新快照。
- **诚实边界**：确认变更与原子写之间存在毫秒级窗口（崩溃恰好落入 ⇒ 该笔回退）；快照为整体覆盖非增量日志（SQLite/WAL 级持久化随数据建模决策收口）；快照损坏/密钥不符 = 启动即拒绝（fail-closed，不可静默弃用）。
- **回滚**：release 目录切版 + env 留存 + 快照归档恢复（runbook §7）；快照格式 v1 由本版本引入，回滚到更早版本时旧代码不读快照文件。

## 3. 备选方案（未采用）

- **Prisma/SQLite 持久化领域状态后再备份**：触发 TECH_STACK §3 独立选型决策（数据建模任务），牵动全部已交付域的面；R1-08 的 AC 可在加密快照下完整满足，拒绝扩大范围。
- **增量事件日志/WAL**：更强的断电语义，但引入日志回放引擎与格式演进负担；v0 以原子整档 + 披露窗口满足 AC，升级路径已写明。
- **按账户锁定（本 PR 内）**：需登录合同变更（principal 提示）且在无归因信号下退化为全局锁定；披露为显式后续任务（§2.2）。
- **Caddy 之外自建 Nginx/TLS**：Caddy 自动 ACME/续期减少运维面；Nginx 等价配置留作运维偏好。

## 4. 后果

- 正面：单机部署/端口白名单/TLS 可执行可核验；Secret 有唯一枚举与脱敏纪律；审计 Trace 补齐成本维度；备份/恢复/回滚有 CI 证明的演练路径；R1-08 交付范围与四条 AC 全部有自动化或 runbook 级证据。
- 代价/限制：状态仍为进程内存 + 单加密文件（持久化选型未动）；恢复排除活跃会话（重登录）；全局锁定维持（§2.2 披露）；CSP 行内样式残余；CI 只能证明脚本级/单机模拟面，公网扫描与离机容灾由运维执行（runbook §9 披露）。
