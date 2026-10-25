# P0-04 P0 基线验收 Gate 与 P1 开发入口冻结（issue #82；2026-10-25）

> 关联 Epic：[#78](https://github.com/lybym/LumiThink/issues/78)；上游输入：[P0-01 源码清单冻结矩阵](2026-10-25-p0-01-source-freeze-matrix.md)、[P0-02 A2A/SDK/DSH 兼容矩阵](2026-10-25-p0-02-a2a-sdk-compat-matrix.md)、[P0-03 隔离验证环境与可复现部署/备份/回滚基线](2026-10-25-p0-03-isolated-baseline-restore.md)。
>
> **口径与边界**：本文是 P0-04 的 Gate 记录——汇总源码冻结、运行补丁、兼容矩阵、隔离环境、资源参数和回滚记录，形成**可重放 P0 验收索引**，并给出按维度的 GO/NO-GO 判定。本任务以汇总与索引为主，**未做新的实机操作**；本轮新增复核仅为只读/隔离验证（本地合成口径重跑 + CI 等价取证）。证据分级沿用前三篇：`COMPOSITION_LOCAL`＝本机隔离合成实跑；`CI`＝Linux runner 全量证据；`RUNTIME_RECORDED`＝仅有运行侧记录、未在仓库收敛；`PENDING_*`＝未完成，标注责任任务。**PENDING 项一律不计为通过；不宣称部署收敛、A2A 已可运行或实机验收通过；不含儿童正文、音频、声纹或凭据。**
> 依据：[P0/P1 计划 §P0-04](../P0_P1_PLAN.md)、[整体方案 §13/§17](../A2A_DESIGN.md)、[Task 契约 §7](../TASK_LIFECYCLE.md)、[证据策略](../EVIDENCE_POLICY.md)。

## 1. P0 验收索引：前三项交付逐项定位（AC1）

### 1.1 P0-01 源码清单冻结矩阵（#79）

| 项 | 内容 |
| --- | --- |
| 交付物 | [docs/reviews/2026-10-25-p0-01-source-freeze-matrix.md](2026-10-25-p0-01-source-freeze-matrix.md) |
| 定位 commit | `c3b282fa5f20b236177541af734b6c10aeb4d4e5`（PR [#95](https://github.com/lybym/LumiThink/pull/95) squash merge，2026-10-25T05:45:22Z MERGED，已入 main） |
| 关键内容 | 版本矩阵 6 维（version.env 单一事实源）；补丁去向矩阵 9 项（补丁 1–7 经 PR #94 MERGED，补丁 8/9 未入库）；偏差台账 D1–D9；hello 三态复核；PR #76 处置（CLOSED，由 #94 替代）；运行 Profile/供应商/数据路径脱敏摘要 |
| 定位/复核命令 | `git log -- docs/reviews/2026-10-25-p0-01-source-freeze-matrix.md`；机器强制一致性：`node --test tests/deploy/xiaozhi-deployment.spec.ts`（version.env ↔ `XIAOZHI_GATEWAY_BASELINE`） |
| 本轮 Gate 复核 | §5：`xiaozhi-deployment.spec.ts` 重跑通过（31/31 三 spec 合并计数）；§2 表抽查 version.env SHA-256 与 #81 §9 一致 |
| 局限 | 运行侧记录为 RUNTIME_RECORDED（v0.9.8 运行目录未在仓库收敛，D1）；补丁 8/9 未入库未验证（D3/D5）；正式实机验收未执行（#79 §4 第三态） |

### 1.2 P0-02 A2A/SDK/DSH 兼容矩阵（#80）

| 项 | 内容 |
| --- | --- |
| 交付物 | [docs/reviews/2026-10-25-p0-02-a2a-sdk-compat-matrix.md](2026-10-25-p0-02-a2a-sdk-compat-matrix.md) + [docs/fixtures/a2a-v1.0](../fixtures/a2a-v1.0/README.md)（01–12）+ `poc/a2a-compat`（自含锁文件隔离包） |
| 定位 commit | `031282a10e7b31db6a34b7055cbee547a904bc62`（PR [#96](https://github.com/lybym/LumiThink/pull/96) squash merge，2026-10-25T08:09:39Z MERGED，已入 main） |
| 锁定面 | A2A 规范 `v1.0.1`（spec commit `3303592588e388e62e0f69f701af531d2f4e3991`）；`@a2a-js/sdk@1.3.0`（npm integrity `sha512-OpK4nyg…`）；`a2a-sdk==1.2.3`（wheel SHA-256 `a89529ab…`）；`A2A-Version: 1.0`；Node 24.x / pnpm 10.34.7；内部 DSH `0.2.0-rc.2`；候选插件 source frozen `748c7931…` |
| 实测证据 | JS 编解码 13/13、Python 编解码 14/14；线级行为（JSON-RPC 外壳、SSE 帧、标准错误 −32001/−32002/−32004/−32009、重复 CancelTask 幂等、缺失头按 0.3 拒绝）；跨 SDK 互通（Python 客户端 × JS 服务端）；适配风险 R1–R9 登记 |
| 定位/复核命令 | 该矩阵 §6 全部命令；本仓库守护：`node --test tests/server/a2a-fixtures.spec.ts`；隔离套件：`pnpm --dir poc/a2a-compat run test`（本沙箱等价：`node --test --test-isolation=none tests/codec.spec.mjs tests/wire.spec.mjs`） |
| 本轮 Gate 复核 | §5：compat 套件 2/2 PASS（wire 实测 `missing A2A-Version → −32009`，与矩阵 §3/R7 一致）；`a2a-fixtures.spec.ts` 重跑通过 |
| 局限 | 部署侧 Python 3.10 环境互通复验 PENDING_VERIFICATION（#80 §7；#81 后续）；extras（gRPC/签名/telemetry）与 REST 绑定未验证；全部为隔离回环合成口径，不代表真实设备/模型/儿童数据验收 |

### 1.3 P0-03 隔离验证环境与部署/备份/回滚基线（#81）

| 项 | 内容 |
| --- | --- |
| 交付物 | [docs/reviews/2026-10-25-p0-03-isolated-baseline-restore.md](2026-10-25-p0-03-isolated-baseline-restore.md) + [deploy/validation/README.md](../../deploy/validation/README.md) + [validation.env.example](../../deploy/validation/validation.env.example) |
| 定位 commit | `4b41d46a8792bf6c7a4d9e2f1a147d0450043858`（PR [#97](https://github.com/lybym/LumiThink/pull/97) squash merge，2026-10-25T09:39:57Z MERGED，已入 main） |
| 关键内容 | 隔离环境定义（回环端口 3311/3312 预留、数据卷、`lumithink-validation` 受限账户规格、启停说明）；冻结基线隔离重建（9/9 关键文件 SHA-256 MATCH、`tsc --noEmit` 0、回归 986 tests / 978 pass / 0 fail / 8 skip）；脱敏启动/停止证据（组合级 4 boot + SIGTERM 停机冲刷）；备份范围与 AES-256-GCM 加密核对（T0 归档 `ea76563266c86f84` 全程不变）；隔离恢复演练（旧档恢复不复活已删数据、一次性重放、标记自清）；回滚矩阵；资源预算初值（无一默认无限）；删除/撤权台账保管与恢复开放前六步；CI 等价取证（6 workflow × head SHA，check-runs 19/19 success/completed，run 例 [40177804023](https://github.com/lybym/LumiThink/actions/runs/40177804023)） |
| 定位/复核命令 | 该记录 §12 全部命令；关键校验值：`Get-FileHash -Algorithm SHA256`（对照 §9 表） |
| 本轮 Gate 复核 | §2：抽查 `deploy/backup.sh` / `restore.sh` / `healthcheck.sh` / `start.sh` / `scripts/snapshot-cli.ts` / `version.env` 六项 SHA-256，与 #81 §9 逐一 MATCH；§5：`tsc --noEmit` 重跑 exit 0 |
| 局限 | §10 PENDING 全部保留：应用进程级本机启动（CI 承载）、xiaozhi 隔离目录完整重建（部署侧 Python 3.10）、D3 四要素验证、D2 统一配置、D5 重建交付、台账完全独立化（PENDING_ARCH → #90，联动 #88）、日预算/磁盘实测修订（→ #91）、A2A 服务 3312 监听（→ #83） |

### 1.4 关键复现阻断项清单（诚实披露；AC1 判定输入）

- **仓库冻结基线复现：无阻断项**。三份交付的全部仓库侧命令（fixtures 守护、compat 套件、隔离重建、部署合同 spec、SHA-256 清单）均可重放；本轮 Gate 抽样重跑全绿（§5）。
- **部署基线复现：存在 4 项关键阻断（沿 #79 台账，未收敛）**：
  - **D1**（xiaozhi v0.9.7 仓库 pin vs v0.9.8 运行记录，选型未决）；
  - **D2**（部署 Worker 关闭回收 vs 仓库 120 s 有限回收，配置分裂）；
  - **D3**（Bridge 重注册补丁仅运行侧存在，四要素未验证）；
  - **D5**（v0.9.8 TTS 双流重整无仓库可重建交付）。
  按 #79 矩阵判定，这四项在收敛前**阻断 P0 Gate 的部署基线维度**（→ §4 维度 B NO-GO）。本 Gate 不粉饰、不宣布其收敛。

## 2. 锁定版本 vs 实际运行目录一致性核对（AC2）

运行目录状态一律采用既有归档记录（RUNTIME_RECORDED），本轮零实机操作、未读取/枚举运行目录。

| 维度 | 仓库锁定值（权威位置） | 实际运行目录记录 | 一致性判定 | 联动 |
| --- | --- | --- | --- | --- |
| xiaozhi 服务端 | `27399a2…`（评估 tag v0.9.7，非浮动；`deploy/xiaozhi/version.env`，spec 机器强制） | `v0.9.8` / `8f2dda09…`（预核对记录，RUNTIME_RECORDED） | **不一致（D1）** | 选型+迁移 → #80 兼容面已冻结 / #81 后续 / 运营者 |
| 端侧固件 | `v2.5.2` / `49b4380b…`（version.env） | 2026-10-18 串口实测 `2.5.2`（机器面记录） | **一致**（REPO_FROZEN；正式实机验收仍未执行） | 实机窗口归运营者（#79 §4） |
| TTS 供应商与覆盖 | 仓库无厂商覆盖文件；唯一评审路径模板 `alibl_stream`（runbook §3.6） | 运行目录另有火山 seed-tts-2.0 双流覆盖（SHA-256 `471a726c…`）+ 官方 v0.9.8 TTS 双流重整 | **不一致（D5：重整无仓库可重建交付）** | #80/#81/运营者 |
| Worker 空闲回收 | 仓库默认 120 s（PR #94 固化；`validation.env.example` 同值） | 部署关闭回收（Infinity） | **不一致（D2）** | 统一配置判定权在本 Gate（§4/§7）；部署侧证据 → 运营者 |
| 运行配置来源 | 仓库模板（`render_config.py` + `config/gateway-*.yaml` + `env/*.example` + runbook） | 运行目录 `gateway.env` 等（哈希清单仅存本地备份，未在仓库收敛） | **未收敛（RUNTIME_RECORDED）** | #81 后续核对 |
| Node / pnpm | `24.x` / `pnpm@10.34.7`（package.json engines/packageManager） | 验证运行时 Node `v24.21.0`（DSH 捆绑；满足 24.x pin） | **一致（验证面）** | — |
| Python | 部署侧 `3.10`（version.env）；`a2a-sdk` `requires_python>=3.10` | 验证运行时 `3.12.14`（满足 >=3.10） | **验证面可接受；部署面互通复验 PENDING** | #81 后续；#80 §7 |
| A2A/SDK/DSH 锁定 | `@a2a-js/sdk@1.3.0`、`a2a-sdk==1.2.3`、DSH `0.2.0-rc.2`（P0-02 §1） | 隔离环境按锁文件精确安装，构造性一致 | **一致（隔离环境内）** | 升级必须重跑 #80 §6 |

**隔离验证可接受范围（明确声明）**：

1. 隔离验证环境（`deploy/validation/` 定义 + `C:/CODE/_p0-03-isolated-81/` 演练）以**仓库冻结基线**为唯一重建对象；运行目录的 v0.9.8 / 火山 TTS 覆盖 / Infinity 回收 / Bridge 重注册补丁等偏差**不进入、也不要求**隔离环境复刻。
2. 验证运行时偏差可接受：Node `v24.21.0`（满足仓库 `24.x` pin）；Python `3.12.14`（满足 `a2a-sdk>=3.10`；部署侧 3.10 的 SDK 互通复验仍 PENDING）；Windows 沙箱以 PowerShell 逐步等价执行 `backup.sh`/`restore.sh`（脚本本体零改动、SHA-256 留档，Linux 生产入口不变）。
3. **不能假称当前生产基线相同**：生产运行目录（v0.9.8 + 火山 TTS 覆盖 + Infinity 回收 + Bridge 重注册补丁 + 未采纳致命退出/日志最小化）与仓库冻结基线的差异以 #79 台账 D1–D5 为准，在选型与迁移收敛前**持续有效**；任何"P0 基线=生产现状"的表述都不成立。

## 3. 既有 100 次竞态证据复核（可复用面与 P1 新增项）

### 3.1 证据定位与本轮 Gate 实测复跑（COMPOSITION_LOCAL，合成口径）

| 证据 | 位置 | 本轮 Gate commit 重跑结果 |
| --- | --- | --- |
| R1-V1 竞态基线（issue #28 验收） | `tests/domain/voice/race.spec.ts`（常驻 `pnpm test`） | **PASS**（100+ 种子化打断竞态，0 旧输出 / 0 旧写入 / 0 死锁；fence 实际触发断言成立）。本轮 report：`iterations=120, prompts=847, cancelAttempts=621, effectiveInterruptions=193, duplicateCancelsBlocked=89, terminalCancelsBlocked=137, outputFenceAttempts=567, lateOutputBlocked=195, writeAttempts=731, staleWritesBlocked=165, forgedWritesBlocked=109, ttsDrains=300, staleTtsDropped=1, restarts=185` |
| R1-V2 Bridge 竞态基线（issue #29 验收） | `tests/domain/voice/bridge/race.spec.ts`（常驻 `pnpm test`） | **PASS**（100 种子场景五族：抢话、重复取消、迟到 delta 风暴、崩溃恢复、非法 IPC 注入）。本轮：`scenarios=100 staleTtsDelivered=0 staleWritesAccepted=0 deltasFenced=25 toolDropped=178 cancelAckMaxMs=0ms whenIdleMaxMs=2ms firstSafeTextMaxMs=5ms workerRecoveryMaxMs=16ms`（候选基线，仅采集不达标） |
| 历史记录锚点 | [VOICE_RUNTIME §R1-V1 表](../VOICE_RUNTIME.md)、[VOICE_GATEWAY_PROTOCOL R1-V2 竞态回归](../VOICE_GATEWAY_PROTOCOL.md)、两 spec 头注释 | 与本轮重跑口径一致（`bridge` spec 头注释明示 issue #29"100 次竞态无旧流/旧 TTS/旧记忆写入"） |

复跑命令（仓库根；node=DSH 捆绑 runtime）：

```powershell
node --experimental-strip-types --test-isolation=none --test tests/domain/voice/race.spec.ts tests/domain/voice/bridge/race.spec.ts
```

口径边界：两者均为**脚本/合成口径**（确定性种子调度、进程内/组合级传输）；真实 UDS 传输路径由 `tests/server/voice-bridge-ipc.spec.ts` 与 `voice-bridge-composition.spec.ts` 在 POSIX CI 行使；实机打断门限归 runbook §12（Mock/探针毫秒数永不充当实机门限）。

### 3.2 可复用部分（P1 直接复用，本 Gate 冻结为入口基线）

- 两个 race spec 常驻 `pnpm test`（CI `r1-baseline-gate` 全量执行），作为 **P1-07/#89 的既有竞态基线**：保留不变，P1 在其上叠加，不重写、不削弱既有断言。
- `lib/domain/voice/` 的 epoch fencing / Turn Orchestrator 语义与 `fenceWrite`/`fenceOutput`/`drainTtsQueue` 原子条件提交：P1-07 输出 fencing 的复用面。
- 既有测试命令入口：`pnpm test`（全量）、`node --test <spec>`（定点）。

### 3.3 P1 新增项（不属于既有基线；本 Gate 后由对应 Issue 承接）

- **A2A CancelTask 语义族**：取消先于派发 / 领取租约中 / 首响应丢失 / 完成竞争 / 重复取消 / 非协作 Worker（#89；P0_P1_PLAN §P1-07）。
- **SQLite 故障场景**：写锁竞争、Outbox 积压、事务切点重启（#84/#88/#89）。
- **身份场景**：跨主体拒绝、撤权即时生效（#85/#88）。
- **官方客户端标准 Fixture 对照**：重复取消/已完成/已取消/已清理返回按已冻结 fixtures 05–12 验证（#89 消费，不自创状态或错误码）。
- **候选 dsh-a2a 插件 Abort 传播**：P2 单独验收（P0-02 R1–R3），不并入 P1 基线。
- **诚实边界**：既有 100 次竞态证据只证明既有语音编排面；**不代表 A2A Task Manager 取消/竞态语义已验证**——该代码尚不存在（#83 起实现），P1 新增场景无任何"已通过"可宣称。

## 4. GO/NO-GO Gate 判定（AC3）

判定规则：每个维度只依据已归档证据与可重放命令；PENDING 项不计为通过；文档评审不替代可执行证据。

| 维度 | 判定 | 证据（可执行/已归档） | 阻断项与开启条件 |
| --- | --- | --- | --- |
| **A. 仓库冻结基线复现**（源码冻结、兼容锁定、隔离重建） | **GO** | 本轮 §5 抽样重跑全绿（竞态 5/5、守护/合同 31/31、compat 2/2、`tsc` 0）；#81 §2 重建（9/9 SHA、回归 986/978/8）；#80 §6 命令可重放；CI 19/19 check-runs（#97 run [40177804023](https://github.com/lybym/LumiThink/actions/runs/40177804023)）；本 PR head CI 等价取证（§5） | 无未关闭复现阻断项 |
| **B. 部署基线收敛**（xiaozhi 版本选型/迁移、回收配置统一、Bridge 重注册验证、TTS 重建交付） | **NO-GO** | D1/D2/D3/D5 全部 PENDING（#79 §3 台账；§1.4）；本轮零实机操作、无新增部署侧证据 | 开启条件：① D1 选型收敛且迁移验证（installer/覆盖注册表/协议扩展点/回滚一并核对）；② D2 取得部署侧长闲置/容量/多用户证据后统一配置并留恢复证据；③ D3 四要素（凭据、会话归属、重复网关重启、幂等重试）验证通过；④ D5 形成仓库可重建交付（上游夹具+维护测试+安装入口）。责任链：#80（兼容面已冻结）→ #81 后续 → 运营者 |
| **C. 隔离验证环境 / 备份 / 回滚 / 资源初值**（验证基线口径） | **GO** | #81 §5 隔离恢复演练实跑（旧档恢复不复活已删数据、重放恰好一次、标记自清）；§6 回滚矩阵齐备；§7 资源初值无一默认无限（`validation.env.example`）；[deploy/validation/README](../../deploy/validation/README.md) 命令可执行 | PENDING 照列不阻断 P1 合成验证：应用进程级本机启动（CI 承载）、部署侧重建、台账完全独立化（PENDING_ARCH → #90，联动 #88）、实测修订（→ #91）、A2A 监听（→ #83） |
| **D. 正式实机验收**（hello 正式态、打断门限、真实儿童数据） | **NO-GO（未执行）** | #79 §4 三态复核：正式实机验收未执行；runbook §11.3/§11.4、§12 待运营者物理面 | 开启条件：运营者按 runbook 执行并留证（3×断电重连、唤醒+10 轮成人语音、≥100 次播报中打断试验、门限冻结）；未执行前不得标注任何实机 PASS |

**总判定**：

1. **P0 基线验收 Gate 整体：NO-GO**——维度 B/D 未收敛；#79 台账 D1–D3/D5 对 P0 Gate 的阻断判定持续有效。不得宣称"P0 基线验收已通过"。
2. **P1 开发入口：冻结并开启**（维度 A/C 的 GO 效力）——P1 核心验证自 [#83](https://github.com/lybym/LumiThink/issues/83) 起可以开工，其对象是**仓库冻结基线**（main `4b41d46a8792bf6c7a4d9e2f1a147d0450043858` + 本索引）与锁定版本、fixtures、资源初值、100 次竞态基线；**不是**生产运行基线。维度 B 的 NO-GO 不阻断仓库侧 P1 开发，但阻断任何"部署基线已收敛/一致"的表述。

## 5. 本轮 Gate 复核的实际执行证据（COMPOSITION_LOCAL，合成口径；Gate commit `4b41d46a` 工作树）

| # | 复核 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 100 次竞态基线复跑 | `node --experimental-strip-types --test-isolation=none --test tests/domain/voice/race.spec.ts tests/domain/voice/bridge/race.spec.ts` | **5/5 PASS，0 fail / 0 skip**（§3.1 明细） |
| 2 | A2A fixtures 守护 + 部署合同 | `node --experimental-strip-types --test-isolation=none --test tests/server/a2a-fixtures.spec.ts tests/deploy/xiaozhi-deployment.spec.ts tests/deploy/xiaozhi-gateway-bridge.spec.ts` | **31/31 PASS**（07 SSE 外壳、错误表、无敏感标记断言、version.env↔协议合同、桥档模板） |
| 3 | compat 锁定套件 | `node --test --test-isolation=none tests/codec.spec.mjs tests/wire.spec.mjs`（`poc/a2a-compat`；等价于 `pnpm --dir poc/a2a-compat run test`，本沙箱 pnpm lifecycle spawn 受限，按 #81 §12 等价路径直跑） | **2/2 PASS**；wire 证据：缺失 `A2A-Version` → `−32009`（与 #80 §3/R7 一致） |
| 4 | 类型检查 | `node node_modules/typescript/bin/tsc --noEmit` | **exit 0** |
| 5 | 冻结文件校验值抽查 | `Get-FileHash -Algorithm SHA256`（backup.sh / restore.sh / healthcheck.sh / start.sh / snapshot-cli.ts / version.env） | **6/6 与 #81 §9 MATCH**（前 16 位逐一一致） |
| 6 | CI 等价取证 | push/pull_request 触发异常不产生 runs（既有记录口径）；以 workflow_dispatch 对全部 6 个 workflow（e2e-04/e2e-07/r0/r1-baseline/r1-deployment/r1-release）派发本 PR head SHA，`gh api repos/lybym/LumiThink/commits/<HEAD_SHA>/check-runs` 核验 | **COMPLETED（内容 commit `953c65a4` 口径）**：check-runs **14/14 success/completed**（run 例：[40182862818](https://github.com/lybym/LumiThink/actions/runs/40182862818)、[40182865421](https://github.com/lybym/LumiThink/actions/runs/40182865421)、[40182867138](https://github.com/lybym/LumiThink/actions/runs/40182867138)、[40182868964](https://github.com/lybym/LumiThink/actions/runs/40182868964)、[40182871126](https://github.com/lybym/LumiThink/actions/runs/40182871126)、[40182873271](https://github.com/lybym/LumiThink/actions/runs/40182873271)，含 `Linux deployment smoke` 与 `Upgrade/rollback drill`——即本机沙箱缺失的构建/启动/进程级烟测在 ubuntu 全部通过）；本 PR 每个 push 的 head SHA 均按同法取证，最终 head 结果见 PR Checks |

环境披露：本机 `core.autocrlf=true` 工作树需按 #81 §2.1 既定方法将字节级 LF 断言文件（`docs/fixtures/a2a-v1.0/07-message-stream-sse.txt`、`deploy/xiaozhi/config/gateway-bridge.yaml`）重刷为 LF 后运行（仓库 blob 恒为 LF，Linux CI 无此环境项）；重刷后 `git status --porcelain` 保持为空，仓库内容零变更。

## 6. GO 效力边界（AC4）

本 Gate 的 GO **仅开启 P1 核心验证**（#83–#92 的开发与合成验证）。以下均**不**被本 Gate 批准：

1. **不批准切换现有 UDS**：旧 UDS 链路原配置不动；A2A 验证服务 3312 端口仅为预留（当前无监听进程），归 #83 实现且仅限隔离验证环境。
2. **不批准正式儿童数据**：一切验证仅使用合成数据；公开 Issue/PR/CI 不含儿童正文、音频、声纹或凭据；Mock、真实 Worker、真实模型与实机证据按分级标记分开，互不代领。
3. **不批准发布**：发布资格归 RELEASE_GATE 与 P1-10/#92；本 Gate 不产生 Tag/Release，不批准任何生产切线。
4. **不宣称 A2A 已可运行**：P0-02 互通证据为隔离回环合成口径；A2A 服务本体尚未实现。
5. **不改变 D1–D5 的阻断效力**：部署基线收敛前，不得宣称生产基线与仓库冻结基线一致，不得引用运行目录行为作为仓库语义的验收证据。

## 7. 未关闭风险与处理任务映射

| 风险/偏差 | 来源 | 当前状态 | 责任任务 |
| --- | --- | --- | --- |
| D1 xiaozhi 版本选型（v0.9.7 vs v0.9.8） | #79 §3 | 阻断维度 B（PENDING_DECISION） | 选型+迁移 → #80/#81 链条 + 运营者；Gate 复核 #82（后续） |
| D2 Worker 回收配置分裂（120 s vs Infinity） | #79 §3；`validation.env.example` 注记判定权 #82 | **本 Gate 如实登记为未决**：无部署侧长闲置/容量/多用户证据可依，不代决；阻断维度 B | 运营者提供证据 → #81 后续统一配置；Gate 复核 #82（后续） |
| D3 Bridge 重注册补丁四要素未验证 | #79 §2 补丁 8 / §3 | 阻断维度 B（PENDING_VERIFICATION） | 运营者提供部署侧补丁证据 → #81 后续隔离验证 |
| D5 v0.9.8 TTS 双流重整无仓库可重建交付 | #79 §2 补丁 9 / §3 | 阻断维度 B（PENDING_DELIVERY） | #80（选型先行）/#81（重建）/运营者 |
| D4 运行目录未采纳致命退出/日志最小化；D6–D9 已记录项 | #79 §3 | 迁移验证 PENDING / 不阻断本轮 | #81 后续迁移验证 |
| 部署侧 Python 3.10 SDK 互通复验 | #80 §7 | PENDING_VERIFICATION | #81 后续；#82 Gate 已复核登记（本文 §2） |
| P0-02 适配风险 R1–R9 | #80 §5 | 已登记 | R4/R5/R6/R7 → #83/#84/#88；R1–R3 → P2 |
| 删除/撤权台账完全独立于快照 | #81 §8.2 | PENDING_ARCH（现状=快照内嵌+一次性重放） | [#90](https://github.com/lybym/LumiThink/issues/90)（P1-08）；联动 [#88](https://github.com/lybym/LumiThink/issues/88)（P1-06 输出与 Outbox） |
| 资源预算实测修订（日预算/磁盘/吞吐） | #81 §7 | 初值已冻结，PENDING_MEASUREMENT | [#91](https://github.com/lybym/LumiThink/issues/91)（P1-09）；生产值运营者 |
| A2A 验证服务 3312 监听 | #81 §10.9 | PENDING（预留） | [#83](https://github.com/lybym/LumiThink/issues/83)（P1-01） |
| 应用进程级本机（非沙箱）启动证据 | #81 §10.2 | CI 承载；本机 PENDING_VERIFICATION | 运营者非沙箱复跑 |
| 正式实机验收（hello 正式态/打断门限） | #79 §4 | NO-GO（未执行） | 运营者窗口（runbook §11/§12） |

## 8. 验收条件（AC）覆盖

| Issue #82 AC | 证据 |
| --- | --- |
| 前三项交付逐项可定位 commit、命令、结果与局限，无关键复现阻断项 | §1 索引逐项（commit/命令/结果/局限）；§1.4 诚实披露：仓库侧无阻断项，部署侧 D1–D3/D5 阻断未收敛 → 映射 §4 维度 B NO-GO（不隐藏、不粉饰、不宣称收敛） |
| 明确锁定版本和实际运行目录一致；如不一致，列出隔离验证可接受范围且不能假称当前生产基线相同 | §2 逐项核对表（4 项不一致如实标注 D1/D2/D5/未收敛）+ 隔离验证可接受范围三条 + "不能假称生产基线相同"显式声明 |
| 给出明确 GO/NO-GO、未关闭风险及处理任务；禁止以文档评审替代该 Gate | §4 按维度判定（每个判定点指向可执行证据/命令）+ 总判定两条 + §5 本轮实测复跑 + §7 风险任务映射（#83/#88/#91、D1/D2/D3/D5 等全量链接） |
| GO 仅开启 P1 核心验证，不批准切换现有 UDS、正式儿童数据或发布 | §6 GO 效力边界五条（UDS/儿童数据/发布/可运行宣称/D1–D5 效力） |
| 证据与完成定义（合成数据、分级标记、UDS 不切换、不批准发布） | 全文口径声明 + 证据分级标记（COMPOSITION_LOCAL/CI/RUNTIME_RECORDED/PENDING_*）+ §3 分级标注 + §6 |

## 9. 覆盖声明

- **本任务已完成**：可重放 P0 验收索引（前三项交付逐项定位）；锁定版本 vs 运行目录逐项一致性核对与隔离可接受范围声明；既有 100 次竞态证据复核与 Gate commit 实测复跑（可复用面与 P1 新增项拆分）；按维度 GO/NO-GO 判定（每判定点指向可执行证据）；未关闭风险与责任任务全量映射；GO 效力边界冻结。
- **本任务不宣称**：部署基线收敛（D1/D2/D3/D5 仍阻断）、A2A 服务可运行、实机验收通过、发布资格、生产基线与仓库冻结基线一致。
- **PENDING 项全部保留原状态并标注责任任务**；本 Gate 未以文档评审替代任何可执行证据点，未把任何 PENDING 计为通过；不切换现有 UDS，不触碰真实儿童数据/音频/声纹/凭据，公开内容全部为合成样例与结构化事实。
