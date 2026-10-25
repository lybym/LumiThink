# P0-03 隔离验证环境与可复现部署/备份/回滚基线（issue #81；2026-10-25）

> 关联 Epic：[#78](https://github.com/lybym/LumiThink/issues/78)；上游输入：[P0-01 源码清单冻结矩阵](2026-10-25-p0-01-source-freeze-matrix.md)、[P0-02 A2A/SDK/DSH 兼容矩阵](2026-10-25-p0-02-a2a-sdk-compat-matrix.md)。
>
> **口径与边界**：本文是 P0-03 的仓库侧收敛记录。全部演练在**新建隔离目录**（本机 `C:/CODE/_p0-03-isolated-81/`，冻结 commit `031282a10e7b31db6a34b7055cbee547a904bc62` 的独立检出）中以**合成数据**执行；主运行目录、现网部署目录、既有 UDS socket、计划任务/自启动项**零接触**（未启动/停止/修改任何运行中服务）。数据分级：`COMPOSITION_LOCAL`＝本机隔离目录组合级实跑证据；`CI`＝Linux CI 证据（ubuntu runner 全量构建/启动/烟测）；`PENDING_*`＝未完成，标注负责人与联动。**不宣称 A2A 已可运行、不宣称部署基线选型已收敛、不批准正式发布；P0/P1 Gate 前不切换现有 UDS。** 本文档不含凭据、密钥值、儿童资料、音频或声纹；快照密钥仅记录存在性与指纹，命令一律以 `<KEY>` 占位。
> 依据：[P0/P1 计划 §P0-03](../P0_P1_PLAN.md)、[整体方案 §11.2/§13](../A2A_DESIGN.md)、[Task 契约 §恢复](../TASK_LIFECYCLE.md)、[R1-08 部署 Runbook](../../deploy/runbook.md)、[ADR-0005](../adr/0005-child-data-lifecycle-v0.md)、[ADR-0006](../adr/0006-deployment-secrets-backup-v0.md)、[隐私数据流](../PRIVACY_DATA_FLOW.md)。

## 1. 隔离验证环境定义（配置、端口、数据卷、受限账户、启动说明）

权威操作文档：[deploy/validation/README.md](../../deploy/validation/README.md)（本节为矩阵摘要；两者不一致以 README 为准并修本表）。

### 1.1 端口分配（回环专用；生产端口与本环境隔离）

| 端口 | 用途 | 依据 | 隔离环境取值 |
| --- | --- | --- | --- |
| 127.0.0.1:3000 | LumiThink 应用（生产基线） | [runbook §1](../../deploy/runbook.md)、[production.example](../../deploy/env/production.example) | **不占用**（本环境不用 3000） |
| 127.0.0.1:8000 / 8003 | 小智网关 WS / HTTP（旧 UDS 链路同侧） | [gateway-minimal.yaml](../../deploy/xiaozhi/config/gateway-minimal.yaml)（`ip: 127.0.0.1, port: 8000, http_port: 8003`） | **不占用**；旧 UDS 链路配置原样保留，未改动 |
| 127.0.0.1:3312 | **A2A 验证服务预留端口**（P1-01/#83 实现后监听；本期无监听进程） | 本 Issue 新增约定（[validation.env.example](../../deploy/validation/validation.env.example)） | 预留，未监听 |
| 127.0.0.1:3311 | 本期隔离演练应用端口（如需进程级启动时使用） | 本期约定 | 演练采用组合级驱动，无监听 |
| 临时回环端口 | 模型出口代理（port 0 = 内核分配） | [gateway-egress-proxy.ts](../../lib/server/gateway-egress-proxy.ts)（仅绑 127.0.0.1/::1） | 每次启动独立分配，无固定端口冲突面 |

- 公网端口（443/80，Caddy）与设备侧端口（10096 FunASR、11434 本地模型端点）均属部署侧既有拓扑，隔离环境一律不绑定、不代理、不改写。
- 旧 UDS 链路（`LUMITHINK_GATEWAY_SOCKET` 指向的既有 socket）**原配置不动**；隔离环境不创建、不连接、不删除任何 UDS socket。

### 1.2 数据卷（隔离目录布局；主运行目录零影响）

| 路径（本机隔离环境） | 内容 | 对应生产布局（Linux） |
| --- | --- | --- |
| `C:/CODE/_p0-03-isolated-81/app/` | 冻结 commit 的独立检出（`git worktree`，工作树文件独立物化） | `/opt/lumithink`（release，root 只读） |
| `C:/CODE/_p0-03-isolated-81/data/state/snapshot.bin` | AES-256-GCM 加密运行时快照（本次演练数据卷） | `/var/lib/lumithink/snapshot.bin` |
| `C:/CODE/_p0-03-isolated-81/data/backups/` | 加密快照归档（密文端到端，`snapshot-<UTC>.bin`） | `/var/backups/lumithink/` |
| `C:/CODE/_p0-03-isolated-81/data/config/` | 隔离 env 文件与快照密钥文件（0600 语义；值不入库） | `/etc/lumithink/` |

- 主运行目录（`data/lumithink-runtime/lumithink`，#79 矩阵 RUNTIME_RECORDED 记录）**未读取、未写入、未枚举**；证据中所有路径均为上表隔离路径。
- 隔离演练的快照密钥为**演练专用新生成值**（32 字节，`snapshot.key`），仅存在于隔离 config 目录；证据仅记录 `keyFileWritten=true / keyPrinted=false`。

### 1.3 受限账户与进程约束

| 项 | 生产基线（仓库已固化） | 隔离验证环境 | 状态 |
| --- | --- | --- | --- |
| 运行身份 | systemd `User=lumithink`（nologin 系统用户，[lumithink.service](../../deploy/lumithink.service)） | Linux 验证环境建议 `lumithink-validation`（同规格：nologin、独立 home、目录 0750） | Linux 规格 **已定义**；实际建户归部署侧运营者 **PENDING_OPERATOR** |
| 文件系统沙箱 | `ProtectSystem=strict` + `ReadWritePaths=/var/lib/lumithink` + `ProtectHome=tmpfs` + `NoExecPaths` | 验证单元同规格，路径替换为隔离目录 | 规格 **已定义**（README §4）；实机验证 PENDING_OPERATOR |
| 资源限额 | `MemoryMax=1G`、`TasksMax=128`、`LimitNOFILE=4096`（unit 已固化） | 同值沿用 | **COMPOSITION_LOCAL 记录 + CI 覆盖**（实机 systemctl 复核归运营者） |
| Windows 本机 | 不适用 | 沙箱内以当前受限用户执行，无建户权限 | **PENDING_OPERATOR**（环境受控项） |

### 1.4 启动/停止说明（摘要；完整命令见 README）

- **生产/Linux 语义**：`deploy/start.sh`（preflight：env 0600 校验 + `BUILD_ID` 在位 + `check-startup-env.ts` fail-closed → `next start -H 127.0.0.1 -p $PORT`）；停止 = `systemctl stop lumithink`（SIGTERM → 停机冲刷：最终加密快照 → 退出，[web-mvp-runtime.ts](../../lib/server/web-mvp-runtime.ts) `registerShutdownSnapshotFlush`，unit `TimeoutStopSec=30`）。
- **本期隔离演练（组合级）**：以 `createWebMvpRuntime({ snapshot: { path, keyHex } })` 组合运行时（与测试同源 API），确认变更即时落盘 + SIGTERM 停机冲刷实测通过（§5）。
- **应用进程级启动/停止证据**：本机沙箱无法执行 `next build`/`next start`（spawn EPERM，见 §10 局限）；该级证据由本 PR 的 `r1-deployment-gate`（ubuntu：干净安装 → typecheck → build → 合成数据启动 → 健康检查 → 安全头/回环绑定 → 变更快照 → 重启恢复）承载，并保持既有 CI 语义不变。

## 2. 从冻结清单在隔离目录重建现有基线（实际执行证据，COMPOSITION_LOCAL）

冻结输入 = [#79 冻结矩阵](2026-10-25-p0-01-source-freeze-matrix.md)（仓库 pin）+ [version.env](../../deploy/xiaozhi/version.env) 单一事实源。基线冻结 commit：`031282a10e7b31db6a34b7055cbee547a904bc62`（= origin/main，含 #95/#96）。

### 2.1 重建步骤与结果

| 步骤 | 命令（隔离目录） | 结果 |
| --- | --- | --- |
| 1. 物化隔离检出 | `git worktree add --detach C:/CODE/_p0-03-isolated-81/app 031282a` | HEAD=`031282a`，`git status --porcelain` 为空 |
| 2. 冻结文件一致性 | 对 9 个冻结关键文件逐一 SHA-256 对比主检出 | **9/9 MATCH**（§9 表） |
| 3. 依赖恢复 | `<node> <pnpm.mjs> install --frozen-lockfile`（node v24.21.0 / pnpm 10.34.7） | 依赖树安装成功；`prisma generate` 以直接调用完成（exit 0）；pnpm 派发 lifecycle 的路径受沙箱 spawn 限制（见 §10） |
| 4. 类型检查 | `tsc --noEmit` | **exit 0** |
| 5. 全量回归 | `node --experimental-strip-types --test-isolation=none --test <103 个 spec>` | **986 tests / 978 pass / 0 fail / 8 skip**（终跑 [test-run-final.log]；见下方偏差说明） |
| 6. A2A 兼容包 | `pnpm --dir poc/a2a-compat install --frozen-lockfile && pnpm --dir poc/a2a-compat test` | 锁文件精确安装 + 套件通过（#80 锁定面复核） |
| 7. 生产构建 | `next build` | **本机未执行成功**：Next.js worker spawn 在沙箱内 EPERM（既有 `build-out.log` 先例一致）；构建/启动证据由 CI 承载（§1.4），不作为本机缺口掩饰 |

- **排除说明**：`tests/server/gateway-host-shutdown.spec.ts`（唯一以子进程方式 spawn 被测进程的 spec）在沙箱内无法运行（spawn EPERM），本地排除 1 文件；该 spec 由 Linux CI 全量运行覆盖（r1-baseline-gate 的 `pnpm test`）。
- **CRLF 环境偏差（已根因 + 已修复）**：本机 `core.autocrlf=true` 使 2 个断言字节级 LF 内容的用例失败（`a2a-fixtures` 07 SSE 外壳、`xiaozhi-gateway-bridge` 桥档模板）。在隔离树内以 `git -c core.autocrlf=false checkout` 重刷为 LF 后 **10/10 通过**，终跑全量 0 fail。两用例在本 PR 改动集之外，Linux CI 历来通过（#96 CI 14/14）。

### 2.2 基线一致性判定

- 仓库侧（版本 pin、配置模板、部署脚本、fixtures、锁文件）在隔离检出与主检出**字节级一致**（SHA-256，§9）。
- 运行侧基线（v0.9.8 记录 vs 仓库 pin v0.9.7 的 D1 偏差、部署 Worker 回收配置 D2、Bridge 重注册补丁 D3、运行目录未采纳致命退出/日志最小化 D4、v0.9.8 TTS 重建交付 D5）**仍未收敛**——本 Issue 只重建**仓库冻结基线**并验证其可复现性，不裁决部署侧选型（见 §10 PENDING；判定权在 #82 Gate）。

## 3. 启动/停止证据（脱敏；标注隔离路径）

以下全部为隔离目录 `C:/CODE/_p0-03-isolated-81/` 内的合成数据执行记录（原始日志留存于本机隔离目录 `drill/`，不入库；入库的为本节脱敏摘录）。

**启动证据（组合级 boot，4 次独立 boot + 1 次停机前 boot）**：

```json
{"phase":"init","isolatedStateDir":"C:/CODE/_p0-03-isolated-81/data","recordingOn":true,"conversations":1,"memories":1,"replayCount":0,"t0SnapshotCounts":{"conversations":1,"historyEntries":2,"memories":1,"tombstones":0},"keyFileWritten":true,"keyPrinted":false}
{"phase":"final.boot3-replaying-boot","markerConsumed":true,"lastDeletionAction":"replay_child_deletions","conversations":0,"memories":0,"replayCount":1,"recordingRestored":true,"snapshotRestoredInAudit":true}
{"phase":"final.boot4-normal-restart","survivingMemoryPresent":true,"conversations":0,"replayCount":1,"recordingOn":true}
{"phase":"stop.boot5-pre-signal","conversations":0,"memories":1,"snapshotOnDisk":true}
```

**停止证据（SIGTERM 停机冲刷）**：向 boot5 进程发送 SIGTERM 后，进程即时退出（处理器按设计 `exit(0)`；Windows 信号模拟路径由宿主 shell 报告为 exit 1，以冲刷产物为准），停机冲刷重写快照并落盘：

```json
{"format":"lumithink.runtime-snapshot/v1","source":"boot-restore","createdAt":"2026-10-25T08:34:08.464Z","counts":{"conversations":0,"historyEntries":0,"memories":1,"tombstones":1,"auditEntries":17},"fingerprint":"02178051e5b9"}
```

- 快照 `source=boot-restore`、`createdAt` 为停机时刻 → **最终冲刷真实发生**（非既有文件残留）；`restore-replay.pending` 标记不存在（早已被重放 boot 消费）。
- 主运行目录零影响：上述所有路径均为隔离路径；演练期间本机 3000/8000/8003/3311/3312 端口无任何监听进程（启动前经 `Get-NetTCPConnection` 核验为空闲）。

## 4. 备份范围与加密备份核对

**备份对象**（[ADR-0006 §4](../adr/0006-deployment-secrets-backup-v0.md) + [PRIVACY_DATA_FLOW §2](../PRIVACY_DATA_FLOW.md)，与代码一致）：

- **包含**：授权/告知/开关、风格、监护人审计环（有界 500）、已保存会话历史+记忆条目（记录开关开启时）、内容无关删除台账（墓碑，有界）、幂等台账（防重放延续）。
- **排除**：活跃 Bearer 会话（重启后需重新登录，演练 boot3 实证：T0 的登录态不恢复）、锁定计数器、网关当日预算计数、观测用 Trace/记忆审计环、DSH 会话映射。
- **加密**：整档 AES-256-GCM（`LUMITHINK_SNAPSHOT_KEY(_FILE)`，0600）；明文快照不存在；备份副本保持密文端到端（backup.sh 仅 `cp`）。

**核对结果（隔离演练，snapshot-cli 结构化输出，无内容外泄）**：

| 对象 | fingerprint | tombstones | 计数（conv/hist/mem） | SHA-256（前 16 位） |
| --- | --- | --- | --- | --- |
| T0 归档 `snapshot-20261025T083123Z.bin`（演练前状态） | `a11420b8a373` | 0 | 1/2/1 | `ea76563266c86f84` |
| T1 现行快照（erase 后） | `2c3b5ceb968b` | 1 | 0/0/0 | —（即时重写） |
| 停机冲刷最终快照 | `02178051e5b9` | 1 | 0/0/1 | —（停机重写） |

- T0 归档 SHA-256 在 erase 与恢复全程**保持不变**（`ea765632…`），证明归档未被现行状态污染。
- 归档 ACL：Windows 证据副本上 `icacls` 收紧被沙箱拒绝（如实记录）；**POSIX 0600 语义由真实 `deploy/backup.sh`（`umask 077` + `chmod 600`）在 Linux 生产/CI 强制**，脚本本体未改（SHA-256 见 §9）。

## 5. 隔离恢复演练（合成数据；COMPOSITION_LOCAL，实际执行）

演练命题：**恢复早于删除的旧归档时，已删数据不得复活**（[TASK_LIFECYCLE 恢复契约](../TASK_LIFECYCLE.md)：恢复先重放删除/撤权、清理缓存及待发事件，再开放服务；[ADR-0005](../adr/0005-child-data-lifecycle-v0.md)）。

| 步骤 | 动作 | 可复现命令（隔离目录内执行；`<KEY>`=隔离密钥占位） | 结果 |
| --- | --- | --- | --- |
| 1 | boot1：监护人演示登录 + 记录开关 ON + 1 次合成轮次 + 1 条合成确认记忆 | `node --experimental-strip-types p0-03-restore-drill.ts init` | T0 状态落盘；快照即时写入（确认变更自动落盘语义实测成立） |
| 2 | **真实备份工具**：归档 T0 快照 | Linux：`LUMITHINK_*` env 覆盖 + `deploy/backup.sh --verify`；本机等价：`Copy-Item` + `snapshot-cli verify <archive> --key-file <KEY_FILE>` | 归档通过解密+结构校验（`a11420b8a373`，tombstones=0）；[phase2 日志] |
| 3 | 合成删除：subject 级 erase（监护人 API 语义） | `node --experimental-strip-types p0-03-restore-drill.ts erase` | purge conv=1/hist=2/mem=1；墓碑 `del_…` 落账；T1 快照 tombstones=1、内容全零；[phase3 日志] |
| 4 | **真实恢复工具语义**：校验归档 → 保留现行文件为回滚点 → 原子落位归档 → 落一次性重放标记 | Linux：`deploy/restore.sh <archive>`；本机等价：`snapshot-cli verify` + `Copy-Item`+`Move-Item -Force` + 新建 `restore-replay.pending` | 归档校验通过；`snapshot.bin.pre-restore` 回滚点在位；标记就位；[phase4 日志] |
| 5 | boot3（重放启动）：恢复 T0 归档 + 一次性重放删除台账 | `node --experimental-strip-types p0-03-restore-drill.ts final` | **标记被消费**；末条删除记录=`replay_child_deletions`，purge conv=1/hist=2/mem=1（复活内容被再次清除）；conv=0/mem=0（**已删数据未复活**）；记录开关=ON（T0 监护人状态恢复）；审计环含 `snapshot_restored`；[phase5 日志] |
| 6 | boot4（普通重启）：重放后新建数据存活、无二次重放 | 同上 | 幸存记忆在位；`replayCount` 恒为 1；记录开关保持 ON |
| 7 | boot5 + SIGTERM：停机冲刷 + 退出 | `node --experimental-strip-types p0-03-restore-drill.ts stop` | 最终快照重写（`02178051e5b9`，tombstones=1，mem=1）；标记不存在；§3 停止证据 |

- **重放语义要点（与代码一致）**：`restoreLedger` 仅入空台账（重启后新进程）；`replayDeletions` 按 subject 重放（宁过删、不复活），重放自身再落一枚墓碑保持台账连续性；标记文件为一次性自清（`<snapshot-dir>/restore-replay.pending`），恢复 boot 的 restore→replay→持久化成功后才消费——该三态（成功/持久化失败保留重试/无快照的陈旧标记立即消费）由 [runtime-snapshot.spec.ts](../../tests/server/runtime-snapshot.spec.ts) 常驻守护，本演练为文件级实跑面。
- **诚实边界**：确认变更与快照写入之间的毫秒级原子写窗口（runbook §5）在本演练粒度不可测，语义由 CI 的 `r1-deployment-gate` 重启恢复步骤与 unit 测试覆盖。
- **偏差披露**：① 本机沙箱禁止 MSYS bash（signal pipe EPERM），步骤 2/4 以 PowerShell 逐步等价执行 `backup.sh`/`restore.sh` 的每一步（脚本本体零改动、SHA-256 留档，Linux 生产入口不变）；② 沙箱无法执行 `next build`/`next start`，应用进程级启动-恢复证据由 CI 承载（§1.4）。

## 6. 回滚步骤（齐备性核对）

| 场景 | 步骤（来源） | 本期状态 |
| --- | --- | --- |
| LumiThink 应用版本回滚 | release 目录按版本保留 → `systemctl stop` → 切回上一版目录 → `systemctl start` → `deploy/healthcheck.sh`；快照格式 v1 兼容边界：回滚到 R1-08 前需先停用快照变量（[runbook §7](../../deploy/runbook.md)） | 步骤齐备（仓库固化）；隔离树验证了脚本与快照 CLI 面 |
| 小智服务端版本回滚 | pinned checkout 切回旧 SHA → 重渲染 → 重启 → healthcheck；换 SHA 必须先过兼容矩阵评审（[xiaozhi runbook §8](../../deploy/xiaozhi/runbook.md)） | 步骤齐备；**版本选型未决（D1）→ 实际回滚目标待 #80→#82 链条收敛** |
| 配置回滚 | env 改动前 `cp` 留存（0600）→ 恢复上一份 env → 重渲染/重启 | 齐备 |
| 数据回滚 | `deploy/restore.sh <归档>`（校验→回滚点→原子落位→一次性重放标记）→ 重启 → 健康检查；恢复语义见 §5（不复活已删数据） | **齐备且已隔离实跑**（§5）；真实部署演练归 P5/#61 |
| 凭据泄露应急 | 轮换两个访问码 + `snapshot-cli rotate-key`（原子替换）+ 重启；审计留痕 | 步骤齐备；rotate-key CLI 在位（[snapshot-cli.ts](../../scripts/snapshot-cli.ts)） |
| 旧归档隔离与过期 | 旧备份按保留策略过期或密钥销毁；恢复开放前清理步骤见 §8.3 | 已记录（运维策略项，PENDING_OPERATOR 定窗口） |

## 7. 资源预算初值（逐项数值；无一默认无限）

来源：[A2A_DESIGN §13.4](../A2A_DESIGN.md)（设计冻结的初始保护配置）+ 仓库已固化 unit 限额 + 本期显式补齐的部署占位值。**全部为单机验证环境初值，非吞吐承诺；调整必须留痕（P1-09/#91 实测后修订）。**

| 资源 | 初值（具体数值） | 权威位置 | 超限处理 | 测量/调整负责人 |
| --- | --- | --- | --- | --- |
| 单会话并发 | 每私人会话 1 个执行中 Turn + 1 个待处理输入 | A2A_DESIGN §13.4（冻结） | 明确打断策略或拒绝 | #91（P1-09 实测） |
| Worker/模型并发 | 全局最多 **2** 活动 Worker + **2** 模型请求；单家庭 ≤ 全局上限 | A2A_DESIGN §13.4（冻结） | 有界等待；任务隔离 | #91 |
| 排队任务 | 每家庭最多 **4**、全局最多 **8** 待调度 | A2A_DESIGN §13.4（冻结） | 受理前明确容量错误 | #91 |
| 执行时限 | 单次活动执行 **120 s**；等待输入/授权 **10 min** | A2A_DESIGN §13.4（冻结） | 到期内部取消/失败结算 | #91 |
| 单 Task 模型预算 | 最多 **8** 次模型请求；累计输入输出 **32,000 token** | A2A_DESIGN §13.4（冻结） | 调用前预留，超限停止 | #91 |
| **家庭日预算** | **200,000 token/家庭/日**（验证环境显式初值；生产部署必须在 env 显式填写，缺失不得进入正式运行） | [validation.env.example](../../deploy/validation/validation.env.example)（本期新增）；设计要求"部署时必须填写" | 当日拒绝新执行；查询/取消保留 | 初值 #81；实测修订 #91；生产值运营者 |
| Worker 内存限额 | **`MemoryMax=1G`**（unit 已固化）+ `TasksMax=128` + `LimitNOFILE=4096` | [lumithink.service](../../deploy/lumithink.service)（冻结） | 失控 Worker 隔离，不影响其他用户 | #91（进程内限额与实测） |
| 磁盘预警线 | 使用率 **80%** 预警 / 剩余 **<2 GB** 告警（部署侧初值，随验证环境配置下发） | [validation.env.example](../../deploy/validation/validation.env.example)（本期新增占位） | 预警后停止自动扩容类操作并告警 | 初值 #81；生产值运营者 |
| SQLite 写入 | 有界写入队列；锁等待+重试总时长 **≤ 5 s** | A2A_DESIGN §13.4（冻结） | 受理事务失败不派发 Worker | #84/#91 |
| 空闲回收 | 仓库默认 **120 s**（排除启动中/控制请求中/活动执行） | PR #94 固化默认 | quarantine 通知 Bridge | **统一配置决策 PENDING**：部署侧现关闭（Infinity）→ D2，判定 #82 |
| 外部证据服务 | 每次调用必须有超时/分页/结果大小上限 | A2A_DESIGN §13.4 + §4.1（冻结原则） | 来源不可用或截断说明 | 具体数值 PENDING（P3/#85 接入时落地） |

- 网关当日预算计数**有意不进快照**（每日 UTC 窗口重置，ADR-0006 排除项）——重启不清空"今天已用多少"以外的持久账，日预算不因重启绕过。
- 无一资源项缺省为无限；`PENDING` 项均为"具体数值待实测/待部署填写"，且设计已冻结"缺配置不允许进入正式运行"（A2A_DESIGN §13.4 末段）。

## 8. 删除/撤权台账：保管位置、独立性与恢复开放前清理

### 8.1 当前保管位置（如实核对）

| 要素 | 当前实现 | 位置/机制 |
| --- | --- | --- |
| 删除台账（墓碑） | 内容无关结构化记录（动作/时间/操作者/purge 计数/recordId），有界 | **随加密快照持久化**（快照 `tombstones` 段，AES-256-GCM 内）；进程内活跃副本有界 |
| 撤权/权限撤销 | 授权与开关状态（监护人授权面） | 同上（快照 `guardian`/`childData` 段）；撤销即时阻断后续查询/订阅/交付（P1 语义，设计冻结） |
| 一次性重放请求 | `restore-replay.pending` 空文件（0600 语义） | **快照目录内、快照文件之外**（`deploy/restore.sh` 落位；恢复 boot 成功后自清） |
| 台账恢复 | `restoreLedger` 仅入空台账 + `replayDeletions` 按 subject 重放 | [data-lifecycle-service.ts](../../lib/server/data-lifecycle-service.ts)；旧档恢复时复活内容被再次清除（§5 实证） |

### 8.2 独立性判定（对照 [TASK_LIFECYCLE 恢复契约](../TASK_LIFECYCLE.md)）

- **现状**：台账随快照走（快照内嵌墓碑段）+ 一次性 subject 级重放补偿（宁可过删）+ 旧档恢复强制重放标记。该组合在"恢复旧档"场景下**实测不复活已删数据**（§5），但**台账尚不是独立于可回退快照的持久存储**——若快照文件整体丢失且无归档，墓碑与之一并丢失。
- **结论**：符合 ADR-0005/R1-08 语义；与 P0-03 验收词"台账独立于可回退快照"的完全形态尚有差距。**完全独立的台账存储（快照外 append-only 持久化）为 P1-08/#88 的实现项**，本 Issue 如实登记，不宣称已达成（PENDING_ARCH → 负责人 #88；Gate 复核 #82）。

### 8.3 恢复开放前清理步骤（固定顺序；缺一不可开放服务）

1. `snapshot-cli verify <归档>`（解密+结构校验，失败即中止，不落位）；
2. 现行快照留存回滚点（`snapshot.bin.pre-restore`）→ 归档原子落位；
3. 落一次性重放标记（`restore-replay.pending`）；
4. 重启：boot 恢复 → **先重放删除/撤权**（清理复活正文、缓存与待发事件）→ 持久化成功 → 消费标记（失败则保留标记下次整体重试）；
5. 审计环 `snapshot_restored` 披露后，才恢复对外查询/交付；
6. 旧归档按保留策略隔离过期或密钥销毁（`rotate-key` 后旧档不可解）；窗口策略 **PENDING_OPERATOR**（运维定值并留痕）。

### 8.4 凭据红线核对

- 凭据/密钥不进镜像、不进 Git、不进普通日志（[secrets-registry](../../lib/server/secrets-registry.ts) 唯一枚举点 + 脏标记测试）；快照只存访问码摘要；env 校验失败只报变量名不回显值。
- 本期证据：快照密钥仅存在性记录（`keyFileWritten=true/keyPrinted=false`）；演示访问码为仓库公开常量（CI 合成数据口径），非凭据；本评审文档与 PR 不含任何真实凭据、儿童正文、音频或声纹。

## 9. 版本配置与校验值（冻结清单核对）

- 基线 commit：`031282a10e7b31db6a34b7055cbee547a904bc62`（origin/main；含 #95/#96）。
- 版本事实源：[version.env](../../deploy/xiaozhi/version.env)（xiaozhi server pin `27399a2…`/评估 tag v0.9.7；固件 v2.5.2；Python 3.10）；Node 24.x / pnpm 10.34.7（[package.json](../../package.json)）；A2A/SDK 锁定沿用 [#80 矩阵 §1](2026-10-25-p0-02-a2a-sdk-compat-matrix.md)。
- 关键冻结文件 SHA-256（隔离检出 vs 主检出 **9/9 MATCH**；此处记录前 16 位，全值由命令 `Get-FileHash -Algorithm SHA256` 复算）：

| 文件 | SHA-256（前 16） | 文件 | SHA-256（前 16） |
| --- | --- | --- | --- |
| `pnpm-lock.yaml` | `7846522bb9fd8831` | `deploy/backup.sh` | `9818fe4f5de5d5bb` |
| `package.json` | `e25868b680f1c2be` | `deploy/restore.sh` | `f87ccfcba0d50887` |
| `deploy/xiaozhi/version.env` | `335cf7a13da9c637` | `deploy/start.sh` | `6061acd7db3f588a` |
| `deploy/xiaozhi/requirements-gateway-minimal.txt` | `f227de79b498acc5` | `deploy/healthcheck.sh` | `9cea26515e5bdcd5` |
| `deploy/xiaozhi/config/gateway-minimal.yaml` | `2d4c683606fa1ecb` | `deploy/lumithink.service` | `50ee7dea8e56e05f` |
| `deploy/xiaozhi/config/gateway-asr-real.yaml` | `5b509738d22821f0` | `deploy/caddy/Caddyfile` | `e31a0ccc17800c6e` |
| `deploy/xiaozhi/config/gateway-tts-real.yaml` | `f055ceea3c3ac7c2` | `scripts/snapshot-cli.ts` | `ff2fb48805c58678` |
| `deploy/xiaozhi/config/gateway-bridge.yaml` | `9c20cb377306c600` | `poc/a2a-compat/pnpm-lock.yaml` | `07eab296d97ca2c2` |
| `deploy/xiaozhi/render_config.py` / `bootstrap.sh` | `9fbfecb2994752a2` / `9187442f4a391a33` | `deploy/env/production.example` | `4dea751de30bea55` |

- 应用 `BUILD_ID`：本机构建未执行（§2 步骤 7），构建产物校验值由 CI 的 `r1-deployment-gate` 构建步骤生成并承担；本机**不以无构建冒充有构建**。

## 10. 局限与 PENDING（不得宣称完成）

| # | 项 | 状态 | 负责人 / 联动 |
| --- | --- | --- | --- |
| 1 | 本机沙箱 spawn EPERM：`next build`/`next start`、子进程类 spec（gateway-host-shutdown）、MSYS bash 均不可执行 | 环境受限（如实披露）；构建/启动/进程级烟测由本 PR CI（ubuntu）承载 | CI 已配置；本机复跑归运营者非沙箱环境 |
| 2 | 应用进程级隔离启动证据（本机 3311 端口 `next start` + healthcheck） | **PENDING_VERIFICATION**（依赖 #1 解除或运营者实机） | 运营者；#82 Gate 复核 |
| 3 | xiaozhi 服务端（pin `27399a2…`/v0.9.7）在隔离目录的完整重建 | **PENDING_VERIFICATION**：部署侧 Python 3.10 + venv 全链路未在本机执行（#80 §7 已登记）；版本选型未决（D1） | 运营者 + #81 后续 + #82 |
| 4 | Bridge 重注册补丁（#79 §2 补丁 8）四要素验证 | **PENDING_VERIFICATION**（D3，阻断 P0 Gate） | 运营者提供部署侧补丁证据；#81 后续 |
| 5 | 部署 Worker 回收统一配置（D2：120 s vs Infinity） | **PENDING_DECISION**（判定权 #82） | #82 |
| 6 | v0.9.8 TTS 双流重整可重建交付（D5） | **PENDING_DELIVERY** | #80/#81/#82 链条 |
| 7 | 删除台账完全独立于快照的持久存储 | **PENDING_ARCH**（现状=快照内嵌+一次性重放，§8.2） | #88（P1-08 实现）；#82 复核 |
| 8 | 日预算/磁盘预警实测修订值 | 初值已给（§7），**PENDING_MEASUREMENT** | #91（P1-09）；生产值运营者 |
| 9 | A2A 验证服务实际监听（3312 端口） | **PENDING**（P1-01/#83 实现；本期仅预留端口/配置/说明，不声称可运行） | #83 |
| 10 | 本 PR 的 CI 取证（6 workflow × head SHA check-runs 全绿） | 见 PR 描述与 CI 状态（push/pull_request 触发异常不产生 runs 时以 workflow_dispatch 等价取证） | #81（本 PR 内完成） |

## 11. 验收条件（AC）覆盖

| Issue #81 AC | 证据 |
| --- | --- |
| 从冻结清单在隔离目录重建现有基线并留脱敏启动/停止证据；主运行目录不受影响 | §1（隔离定义）+ §2（重建步骤、9/9 校验和、typecheck 0、回归 986/978/8、a2a-compat 复核）+ §3（脱敏启动/停止证据，全部标注隔离路径）+ §10#1/#2（本机无法执行的进程级证据如实 PENDING，CI 承载） |
| 回滚步骤、备份范围、版本配置及校验值齐备，并完成隔离恢复演练 | §6（回滚矩阵）+ §4（备份范围/加密核对）+ §9（版本与校验值）+ §5（隔离恢复演练全程实跑：旧档恢复不复活已删数据、重放恰好一次、标记自清） |
| 记录有限 Worker、队列、模型并发、超时、内存和日预算初值；缺值不能默认为无限 | §7 资源预算表逐项数值（含显式初值的日预算与磁盘预警）；`PENDING` 项均标注负责人且设计冻结"缺配置不得正式运行" |
| 明确删除/撤权台账独立于可回退快照，恢复开放前执行清理；凭据不进入镜像/仓库 | §8（保管位置、独立性判定与 PENDING_ARCH 登记、恢复开放前六步、凭据红线核对）+ §5 实证 |

## 12. 可复现命令（隔离目录；合成数据）

```powershell
# 前置：node/pnpm = DSH 捆绑 runtime；隔离目录 C:/CODE/_p0-03-isolated-81/app
git worktree add --detach C:/CODE/_p0-03-isolated-81/app 031282a10e7b31db6a34b7055cbee547a904bc62
<node> <pnpm.mjs> install --frozen-lockfile            # 冻结锁文件
<node> node_modules/prisma/build/index.js generate     # 沙箱内绕开 pnpm lifecycle spawn
<node> node_modules/typescript/bin/tsc --noEmit        # 类型检查
<node> --experimental-strip-types --test-isolation=none --test <tests 列表，除 gateway-host-shutdown.spec.ts>
<node> <pnpm.mjs> --dir poc/a2a-compat install --frozen-lockfile; <node> <pnpm.mjs> --dir poc/a2a-compat test

# 演练驱动（驱动脚本为本期本地工具，不入库；证据 JSON 落隔离 drill/ 目录）
node --experimental-strip-types p0-03-restore-drill.ts init|erase|final|stop
# 备份/恢复：Linux 用 deploy/backup.sh --verify / deploy/restore.sh <archive>；
# 本沙箱等价步骤见本文 §5 表（snapshot-cli verify + 原子落位 + restore-replay.pending）
```

## 13. 覆盖声明

- **仓库侧已完成**：隔离环境定义（端口/数据卷/账户/启动说明，[deploy/validation/](../../deploy/validation/)）；冻结基线隔离重建与一致性核验（SHA-256、typecheck、全量回归、a2a-compat）；脱敏启动/停止证据；真实备份/恢复语义的隔离实跑（含旧档恢复不复活、一次性重放、停机冲刷）；回滚/备份范围/版本校验值矩阵；资源预算逐项初值；删除/撤权台账保管与恢复开放前清理契约。
- **PENDING（不得宣称完成）**：§10 全部条目；部署侧（WSLc/实机）重建与实机验证、版本选型收敛（D1/D2/D3/D5）、台账完全独立化（#88）、A2A 服务监听（#83）、日预算实测（#91）。
- 本任务不批准正式发布，不切换现有 UDS，不触碰真实儿童数据/音频/声纹/凭据；所有公开 Issue/PR/CI 内容均为合成数据与结构化事实。
