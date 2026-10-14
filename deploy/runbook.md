# LumiThink R1-08 单机部署 Runbook（issue #20）

> 状态：随 R1-08 交付 ｜ 日期：2026-10-14 ｜ 对应 [Issue #20](https://github.com/lybym/LumiThink/issues/20) · [PRD FR-006](../PRD.md) · [Roadmap R1-08](../ROADMAP.md) · [ADR-0006](../adr/0006-deployment-secrets-backup-v0.md) · [TECH_STACK §3/§6](../TECH_STACK.md)
>
> 本 runbook 描述**单台 Linux 云主机**上 LumiThink R1 模块化单体的部署、Secrets、日志、备份/恢复与回滚。R1 部署不含小智服务端与设备 OTA（issue 非目标），不对真实儿童开放。

## 1. 部署拓扑与端口白名单

```
Internet
   │ 443/tcp (HTTPS, TLS 终止)          80/tcp 仅 ACME 挑战/跳转
   ▼
┌─────────────────────────── Linux 单机 ───────────────────────────┐
│  Caddy（TLS 反向代理, deploy/caddy/Caddyfile）                    │
│      └─> 127.0.0.1:3000  Next.js 服务（lumithink.service，受限进程）│
│             ├─ 交互/监护人 API（合同 v1.0 路由）                   │
│             ├─ DSH Runtime：进程内适配器（无对外 socket）          │
│             ├─ 加密快照：/var/lib/lumithink/snapshot.bin（本地）    │
│             └─ SQLite：R1 未启用域持久化（保留 file: 约束）        │
└───────────────────────────────────────────────────────────────────┘
```

| 端口 | 暴露面 | 说明 |
| --- | --- | --- |
| 443/tcp | **公网** | 唯一公网入口；Caddy 强制 HTTPS + HSTS，仅绑定配置域名 |
| 80/tcp | 公网 | 仅 ACME HTTP-01 挑战与到 HTTPS 的跳转 |
| 22/tcp | 运维网段（建议限制来源 IP） | SSH 管理 |
| 3000/tcp | **仅 127.0.0.1** | 应用监听地址 `-H 127.0.0.1`（`deploy/start.sh`/unit 强制） |
| 数据库/DSH/内部管理 | **无公网端口** | DSH 为进程内适配器；SQLite 未启用；无内部管理端口 |

核验（AC 4 公网暴露扫描的机器部分）：

```bash
ss -ltnp | grep -E ':(80|443|3000)\b'   # 3000 必须只出现在 127.0.0.1:3000
# 从外部 vantage（运维侧执行，非 CI）：
nmap -p- <host>                          # 期望仅 80/443（22 按运维网段策略）
curl -sSI https://<domain>/api/health    # 校验安全头（见 §6）
```

## 2. 首次部署（干净 Linux 机器 → 合成数据启动）

前提：Ubuntu 22.04+/Debian 12（systemd）、Node 24.x、pnpm 10.34.7、Caddy。

```bash
# 1. 发布目录（release 归属 root，运行用户只读）
sudo mkdir -p /opt/lumithink && sudo chown root:root /opt/lumithink
#    将构建产物放入 /opt/lumithink（git clone + pnpm install --frozen-lockfile
#    + pnpm run build；或 CI 产物的 release tar），保持 owner root。
# 2. 运行身份
sudo useradd --system --home /var/lib/lumithink --shell /usr/sbin/nologin lumithink
sudo mkdir -p /var/lib/lumithink /etc/lumithink /var/backups/lumithink
sudo chown lumithink:lumithink /var/lib/lumithink && sudo chmod 750 /var/lib/lumithink
# 3. Secrets（受控挂载/env 注入；见 §3）
sudo install -m 600 -o root -o root /dev/null /etc/lumithink/lumithink.env
sudo vi /etc/lumithink/lumithink.env          # 依 deploy/env/production.example 填写
sudo sh -c 'umask 077 && openssl rand -hex 32 > /etc/lumithink/snapshot.key'
# 4. 服务
sudo cp deploy/lumithink.service /etc/systemd/system/lumithink.service
sudo systemctl daemon-reload && sudo systemctl enable --now lumithink
# 5. 健康检查（合成数据、无真实密钥/儿童数据 —— /api/health 首启契约不变）
deploy/healthcheck.sh
# 6. 公网入口
sudo cp deploy/caddy/Caddyfile /etc/caddy/Caddyfile   # 改为真实域名后 reload
```

首个合成启动：所有 `LUMITHINK_*` 变量缺省即为披露的演示模式（监护人控制台用公开演示码）；配置真实访问码后登录改验真实凭据（SHA-256 摘要、常数时间比较），演示码被拒绝。

## 3. Secrets 管理（交付范围 3）

| Slot | 注入源 | 最小授权 |
| --- | --- | --- |
| 监护人访问码 | `LUMITHINK_GUARDIAN_ACCESS_CODE`（env/受控挂载） | 家庭监护人角色；服务端仅存 SHA-256 摘要 |
| 独立管理员访问码 | `LUMITHINK_ADMIN_ACCESS_CODE`（两者必须成对设置） | 只读监督（system 角色），不可变更家庭授权 |
| 快照加密密钥 | `LUMITHINK_SNAPSHOT_KEY(_FILE)`（首选受控挂载文件） | 仅解密/加密单个快照文件（AES-256-GCM） |
| 模型 API Key | **不在启动环境**：请求时注入（MODEL_GATEWAY.md）；Mock 默认零出网 | 仅注册供应商的推理端点 |
| DSH Profile 凭据 | 未来 SDK 进程绑定（当前无）；白名单工具、无 Shell | 单一 `lumithink-child` profile |
| 外发目标 | 网关 provider 注册（显式 baseURL，数据外发评审前置） | 单一 host，无通配出口 |

纪律（测试强制）：Secret 不入 Git、不入普通日志/审计/错误（脏标记负向测试：伪 Key/姓名/家庭信息在全部审计面 0 命中）；`lib/server/secrets-registry.ts` 是唯一枚举点（`describeSlots()` 只给 presence + 指纹）；env 校验失败只报变量名不回显值。

轮换：改 env 两个访问码 → `systemctl restart lumithink`；快照密钥轮换用 `scripts/snapshot-cli.ts rotate-key <file> --from-file <old> --to-file <new>`（原子替换）。

## 4. 日志收集（交付范围 1）

- 应用进程写 stdout/stderr（Next.js + `lib/server` 的极少量结构化错误行）；systemd 收进 journald：
  `journalctl -u lumithink -f`；保留策略按主机 journald 配置（建议 `SystemMaxUse=500M`）。
- 访问日志在 Caddy（JSON 格式；`uri` 字段含 query string——凭据与儿童正文按 API 合同不出现于 query：凭据走 Authorization 头、API 拒绝 query 载荷），`/var/log/caddy/` 滚动保留。
- **红线**：应用侧审计（监护人审计环、运行时 Trace、网关审计）全部为 value-free 结构事实——不含儿童原文、原始音频、凭据（ADR-0005 §2.5 纪律 + R1-08 脏标记测试）。禁止向 stdout 打印任何请求正文。

## 5. 加密备份 / 恢复演练（交付范围 5）

**选定事实源**：R1 单进程部署的领域状态 = 进程内组合态（监护人授权/风格/审计环、保留的会话历史与记忆、删除台账、幂等台账）。快照子系统把该状态**整体序列化为一个 AES-256-GCM 加密文件**（`LUMITHINK_SNAPSHOT_PATH`），在每次已确认变更时立即原子写入，另加周期快照与停机冲刷。prisma schema 保持零差异（持久化选型仍是独立数据建模任务，TECH_STACK §3）。

**快照包含/排除**（ADR-0006 §4）：

- 包含：授权/告知/开关、风格、审计环（有界 500）、已保存会话历史+记忆条目（记录开关开启时）、内容无关删除台账、幂等台账（防重放延续）。
- 排除（fail-closed 披露）：活跃 Bearer 会话（重启后需重新登录）、锁定计数器（暴力尝试压力清零）、网关当日预算计数（每日 UTC 窗口）、观测用 Trace/记忆审计环。

**备份**（快照密文端到端加密，归档 0600）：

```bash
sudo LUMITHINK_APP_DIR=/opt/lumithink deploy/backup.sh --verify
# 输出 /var/backups/lumithink/snapshot-<UTC>.bin；建议另传至离机存储
```

**恢复**：

```bash
sudo systemctl stop lumithink
sudo deploy/restore.sh /var/backups/lumithink/snapshot-<UTC>.bin   # 校验→原子落位→落一次性重放标记（restore-replay.pending）
sudo systemctl start lumithink
deploy/healthcheck.sh
# 启动后运行时自动：恢复状态 → 一次性重放删除台账（旧档可能早于删除）→ 写新快照 → 审计 snapshot_restored
#   → 删除重放标记。此后每次普通重启不再重放：恢复后新建的数据照常保留，无需任何手动复位。
```

**语义（AC 2）**：正常重启恢复**当前**快照文件——已确认事件不丢（删除先于快照时内容已清 + 墓碑已在）；恢复**旧档**时重放保证被删数据不复活（`replay_child_deletions`，ADR-0005 的设计对应物）。诚实边界：确认变更与快照写入之间存在毫秒级原子写窗口，崩溃恰好落在窗口内会回退该笔变更（SQLite/WAL 级持久化随数据建模决策收口）。

## 6. 安全头与受限域名（AC 1 / AC 4）

应用层（全路由）：`Content-Security-Policy`（每请求 nonce + `strict-dynamic`，见 `lib/server/security-headers.ts` 与 ADR-0006 残余披露）、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: strict-origin-when-cross-origin`。代理层（Caddyfile）：`Strict-Transport-Security`（仅 TLS 面）。受限域名：Caddy 站点块只绑定运营域名；未匹配的 SNI/Host 在 TLS 握手层即被拒绝（无默认站点兜底、无显式 421 语义），不存在到达应用的未知 Host 路由。

CI 证据：`.github/workflows/r1-deployment-gate.yml` 在 ubuntu runner 上以合成数据启动、登录（演示模式）、变更开关、重启后断言开关状态恢复（Session 策略可恢复）、校验安全头与 127.0.0.1 绑定。

## 7. 部署回滚

1. **应用回滚**：release 目录按版本保留（`/opt/releases/<git-sha>`）；回滚 = 切回上一版目录（`systemctl stop` → 换软链/目录 → `systemctl start` → `deploy/healthcheck.sh`）。快照格式 v1 向后兼容仅由本版本引入——回滚到 R1-08 之前的版本前先停用快照变量（旧代码不读取快照文件，状态即进程内存默认态）。
2. **配置回滚**：`/etc/lumithink/lumithink.env` 改动前 `cp` 留存（0600）；误配启动失败时恢复上一份 env 重启。
3. **数据回滚**：恢复上一份快照归档（§5；若该档早于某次删除，restore.sh 已落一次性重放标记——恢复后首次启动自动重放并自清，无需手动复位，也不影响之后的普通重启）。
4. **凭证泄露应急**：轮换两个访问码（§3）+ 快照密钥（rotate-key）+ 重启；审计环留存 `login_failed`/`snapshot_restored` 事实。

## 8. 故障模式（diagnostics / failure modes）

| 症状 | 语义 | 处置 |
| --- | --- | --- |
| 启动即退出，`StartupEnvError`（仅变量名） | env 形状非法/半配对 | 修 env；校验器永不回显值 |
| 启动即退出，`snapshot auth_failed` | 快照密钥不符或文件被改 | 核对密钥来源；确认无篡改后再放行（不可静默弃用快照） |
| `[lumithink:snapshot] write failed`（stderr） | 磁盘/权限/原子写失败 | 检查 `/var/lib/lumithink` 权限与空间；确认变更未被持久化 |
| 崩溃残留 `snapshot.bin.tmp`（撕裂写：写在 rename 前中断） | tmp 不是活动状态（rename 才发布快照） | 下一次快照写入自动清除残留 tmp（自愈，不再 brick 写入）；若持续出现删除/权限错误，检查 `/var/lib/lumithink` 属主与权限 |
| `/api/health` 非 ok | 首启契约破坏或环境注入错误 | 对照 §2 首启约束（无密钥/无 DB 要求） |
| 登录锁定（`login_locked_out`） | 15 分钟全局锁定（统一拒绝语义，防枚举） | 等待窗口或重启（计数器为进程态，有意 fail-closed） |

## 9. CI 无法证明、由运维执行的部分（诚实披露）

- 真实公网 vantage 的暴露扫描（§1 nmap）、真实域名的 ACME/HSTS 生效；
- 离机备份介质与异地容灾演练；
- systemd 沙箱在特定内核上的实际拦截效果（建议 `systemd-analyze security lumithink` 复核）。
CI 已证明：ubuntu 干净环境构建+启动+健康检查、脚本语法（bash -n）、unit 文件语法（systemd-analyze verify）、重启恢复演练、安全头与回环绑定、快照往返+重放、日志脱敏负向测试。
