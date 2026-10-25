# LumiThink A2A 验证服务隔离环境（P0-03，issue #81）

> 状态：随 P0-03 交付 ｜ 日期：2026-10-25 ｜ 对应 [Issue #81](https://github.com/lybym/LumiThink/issues/81) · [P0/P1 计划 §P0-03](../../docs/P0_P1_PLAN.md) · [整体方案 §13](../../docs/A2A_DESIGN.md) · [R1-08 部署 Runbook](../runbook.md) · [P0-03 评审记录](../../docs/reviews/2026-10-25-p0-03-isolated-baseline-restore.md)
>
> 本目录定义 **A2A 验证服务的独立配置、端口、数据卷、受限账户与启动说明**，与生产基线（旧 UDS 链路、3000 应用端口、小智网关 8000/8003）完全隔离。**边界：本 Issue 只验证现有基线的可复现性与新环境隔离，不声称 A2A 已可运行**（A2A 服务本体由 P1-01/#83 实现）；本任务不批准正式发布，P0/P1 Gate 前不切换现有 UDS。

## 1. 与生产基线的隔离边界

| 维度 | 生产基线（不动） | A2A 验证环境（本目录） |
| --- | --- | --- |
| 应用端口 | `127.0.0.1:3000`（[runbook §1](../runbook.md)） | `127.0.0.1:3311`（验证应用，如需进程级启动） |
| A2A 服务端口 | 无（未实现） | `127.0.0.1:3312`（**预留**；P1-01/#83 实现后监听，本期无监听进程） |
| 小智网关 | `127.0.0.1:8000/8003` + 既有 UDS socket（原配置不动） | **不占用、不代理、不创建任何 UDS socket** |
| 公网入口 | Caddy 443/80（部署侧） | 无公网绑定；全部回环 |
| 数据卷 | `/var/lib/lumithink/snapshot.bin`、`/var/backups/lumithink/` | `/var/lib/lumithink-validation/snapshot.bin`、`/var/backups/lumithink-validation/`（Windows 隔离演练为 `C:/CODE/_p0-03-isolated-81/data/…`，见评审记录 §1.2） |
| env 文件 | `/etc/lumithink/lumithink.env`（root 0600） | `/etc/lumithink-validation/lumithink.env`（root 0600） |
| 运行账户 | `lumithink`（系统用户，nologin） | `lumithink-validation`（同规格独立账户，见 §4） |
| systemd 单元 | `lumithink.service`（仓库固化） | `lumithink-validation.service`（复制同规格 unit，路径/端口/账户替换；`MemoryMax=1G`、`TasksMax=128`、`LimitNOFILE=4096` 保持同值） |

未匹配的端口/路径一律不绑定；隔离环境启动前先核验目标端口空闲（Linux：`ss -ltnp | grep -E ':(3311|3312)\b'` 期望无输出；Windows：`Get-NetTCPConnection -State Listen -LocalPort 3311,3312` 期望为空）。

## 2. 版本与构建（与冻结基线一致，不另起版本）

- 基线 = origin/main 冻结 commit（P0-03 评审记录 §9：`031282a10e7b31db6a34b7055cbee547a904bc62` 及其后续 Gate 版本）；Node 24.x + pnpm 10.34.7（`package.json` engines/packageManager）；依赖一律 `pnpm install --frozen-lockfile`。
- 构建产物：`pnpm run build` → `.next/BUILD_ID` 在位是启动前置（`deploy/start.sh` preflight）。
- A2A SDK 锁定沿用 [P0-02 矩阵 §1](../../docs/reviews/2026-10-25-p0-02-a2a-sdk-compat-matrix.md)（`@a2a-js/sdk@1.3.0`、`a2a-sdk==1.2.3`）；升级必须重跑该矩阵全部验证。

## 3. 首次部署（干净 Linux 验证主机或隔离容器）

```bash
# 0. 运行身份与目录（与生产同规格、不同名字与路径）
sudo useradd --system --home /var/lib/lumithink-validation --shell /usr/sbin/nologin lumithink-validation
sudo mkdir -p /var/lib/lumithink-validation /etc/lumithink-validation /var/backups/lumithink-validation
sudo chown lumithink-validation:lumithink-validation /var/lib/lumithink-validation
sudo chmod 750 /var/lib/lumithink-validation
# 1. 发布目录（release 归 root，运行用户只读）：/opt/lumithink-validation
#    git clone + pnpm install --frozen-lockfile + pnpm run build，保持 owner root。
# 2. Secrets（受控挂载/env 注入；shapes 见 validation.env.example；值绝不入库）
sudo install -m 600 -o root -o root /dev/null /etc/lumithink-validation/lumithink.env
sudo vi /etc/lumithink-validation/lumithink.env
sudo sh -c 'umask 077 && openssl rand -hex 32 > /etc/lumithink-validation/snapshot.key'
# 3. systemd 单元：复制 deploy/lumithink.service 同规格 → 替换 User/Group、
#    WorkingDirectory、EnvironmentFile、ExecStart 端口为 3311（ReadWritePaths 同步隔离路径）
# 4. 启动与健康检查
sudo systemctl daemon-reload && sudo systemctl enable --now lumithink-validation
LUMITHINK_HEALTH_URL=http://127.0.0.1:3311 deploy/healthcheck.sh
# 5. 合成数据纪律：首个验证启动全部使用演示/合成数据；不配置真实访问码以外的凭据；
#    模型 API Key 不在启动环境（Mock 默认零出网，production.example §Not-here 同款红线）。
```

## 4. 受限账户规格（`lumithink-validation`）

- 系统用户、nologin、独立 home（即其数据卷）；release 目录只读（root 属主）。
- systemd 沙箱与生产同款：`ProtectSystem=strict` + `ReadWritePaths=/var/lib/lumithink-validation` + `ProtectHome=tmpfs` + `NoNewPrivileges` + `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`（完整面以 [lumithink.service](../lumithink.service) 为准复制）。
- Windows 宿主无法创建等价账户（环境受控项）：本机隔离演练以沙箱受限用户执行并如实标注（评审记录 §1.3）；实机建户归运营者 **PENDING_OPERATOR**。

## 5. 启动 / 停止（验证环境）

```bash
# 启动（二选一）
sudo systemctl start lumithink-validation                     # 生产语义
LUMITHINK_APP_DIR=/opt/lumithink-validation \
LUMITHINK_ENV_FILE=/etc/lumithink-validation/lumithink.env \
PORT=3311 deploy/start.sh                                     # 前台语义（preflight + loopback 绑定）

# 健康检查（status=ok + legacyDomainGuard=armed + 回环绑定）
LUMITHINK_HEALTH_URL=http://127.0.0.1:3311 deploy/healthcheck.sh
ss -ltnp | grep 3311        # 必须只出现在 127.0.0.1:3311

# 停止（SIGTERM → 停机冲刷最终加密快照 → 退出；TimeoutStopSec=30 兜底）
sudo systemctl stop lumithink-validation
```

A2A 验证服务本体（3312）**当前不存在监听进程**——P1-01/#83 交付后才在本环境以独立 systemd 单元或独立进程启动；在那之前任何"验证服务已可运行"的表述都不成立。

## 6. 备份 / 恢复 / 回滚（复用既有工具，仅路径不同）

```bash
# 备份（密文端到端；0600；--verify 用隔离密钥核验）
sudo LUMITHINK_APP_DIR=/opt/lumithink-validation \
     LUMITHINK_SNAPSHOT_PATH=/var/lib/lumithink-validation/snapshot.bin \
     LUMITHINK_SNAPSHOT_KEY_FILE=/etc/lumithink-validation/snapshot.key \
     LUMITHINK_ARCHIVE_DIR=/var/backups/lumithink-validation \
     deploy/backup.sh --verify

# 恢复（校验→回滚点→原子落位→一次性删除台账重放标记；恢复后重启自动：恢复→重放→自清标记）
sudo LUMITHINK_SNAPSHOT_PATH=/var/lib/lumithink-validation/snapshot.bin \
     LUMITHINK_SNAPSHOT_KEY_FILE=/etc/lumithink-validation/snapshot.key \
     LUMITHINK_ENV_FILE=/etc/lumithink-validation/lumithink.env \
     LUMITHINK_APP_DIR=/opt/lumithink-validation \
     deploy/restore.sh /var/backups/lumithink-validation/snapshot-<UTC>.bin
sudo systemctl restart lumithink-validation && LUMITHINK_HEALTH_URL=http://127.0.0.1:3311 deploy/healthcheck.sh
```

- 回滚步骤、备份范围、台账保管与恢复开放前清理顺序：见 [P0-03 评审记录 §6/§4/§8](../../docs/reviews/2026-10-25-p0-03-isolated-baseline-restore.md)（恢复演练证据同篇 §5）。
- 资源预算初值（无一默认无限）：[validation.env.example](validation.env.example) 与评审记录 §7。

## 7. 凭据与数据红线（测试与评审强制）

- 本目录文件只描述**形状**，绝不携带真实值；快照密钥仅存于受控挂载文件（0600）。
- 验证环境只使用合成数据：公开 Issue/CI/证据不含儿童正文、音频、声纹或凭据；Mock、真实 Worker、真实模型与实机证据分开标记。
- 删除/撤权台账、一次性重放标记、旧归档隔离与过期策略照评审记录 §8 执行；恢复开放前先重放再开放服务。
