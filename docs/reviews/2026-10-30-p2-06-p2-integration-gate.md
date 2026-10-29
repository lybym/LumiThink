# P2-06 P2 集成验收 Gate — 八维度独立证据与 Go/No-Go（issue #118；2026-10-30）

> 关联 Epic：[#112](https://github.com/lybym/LumiThink/issues/112)；对应 Issue：[#118](https://github.com/lybym/LumiThink/issues/118)；前置：P2-01…P2-05（[#113](https://github.com/lybym/LumiThink/issues/113)/[#114](https://github.com/lybym/LumiThink/issues/114)/[#115](https://github.com/lybym/LumiThink/issues/115)/[#116](https://github.com/lybym/LumiThink/issues/116)/[#117](https://github.com/lybym/LumiThink/issues/117)，均 CLOSED）与 P1 遗留收口（[#121](https://github.com/lybym/LumiThink/issues/121)/[#124](https://github.com/lybym/LumiThink/issues/124)，均 CLOSED）。
>
> **本 Gate 口径**：本记录只汇总既有证据并逐维度判定，**未新增任何实机操作、未激活真实模型供应商、未触碰生产链路**。全部公开内容合成、全程 loopback（127.0.0.1）、无真实凭据/音频/儿童资料、不切 UDS、不碰 `lumithink-data/**`。证据分级沿用 [P0-04 Gate 索引](2026-10-25-p0-04-p0-gate-acceptance-index.md)：`COMPOSITION_LOCAL`＝本机隔离合成实跑；`CI`＝Linux runner 全量证据；`PENDING_*`＝未完成。**PENDING/NO-GO 项不计为通过，也不影响已有独立证据维度的判定；Mock、合成、真实 Worker、真实模型与实机证据分开标记，互不代领。**

## 1. 基线与变更面

| 项 | 值 |
| --- | --- |
| 基线 | `main`，本地 HEAD = `origin/main` = `6e51dfaf3cfd2709dc06140c5776b762755c054d`（fetch → switch → `pull --ff-only` 后双 `git rev-parse` 比对一致；该 commit 即 PR #129 squash merge，P2-05 收尾） |
| 工作树 | 干净（`git status --porcelain` 为空）；无既有开放 PR（`gh pr list --state open` 为空） |
| 分支 | `feature/p2-06-integration-gate`（自 main 切出） |
| 仓库规范 | 无 `AGENTS.md`（glob 核验）；遵循 A2A_DESIGN/TASK_LIFECYCLE/EVIDENCE_POLICY 及既有 review 先例 |
| 本 Gate 变更面 | **仅本文档（新增）+ Epic #112 任务勾选（GitHub 侧回写）**；仓库代码零变更（`git diff main` 仅含本文件）；P2 五项交付物（a2a-server / dsh-a2a-client / xiaozhi-a2a-provider / fixtures / reviews）全部已在 main |

## 2. 八维度判定表（每维度：判定 + 证据索引 + 开启条件）

| # | 维度 | 判定 | 证据索引（全部可重放） | 开启条件 / 责任任务 |
| --- | --- | --- | --- | --- |
| 1 | **A2A 协议验证** | **GO**（隔离开发面：合成凭据、loopback、验证 profile） | [P1-11](2026-10-29-p1-11-python-sdk-interop-verification.md)（PR [#120](https://github.com/lybym/LumiThink/pull/120)）双 SDK 探针 synthetic 33/33 + dsh-worker 33/33，`A2A-Version: 1.0` 28/28 逐请求；`services/a2a-server` `protocol-errors` / `official-client-roundtrip` / `stream-resilience` / `acceptance-idempotency` / `p1-12-sse-resubscribe-teardown` / `input-required-contract` 套件；线形守卫 `docs/fixtures/a2a-v1.0/01–14`；P2-05 G7 wire 级重复提交形状。**本轮 Gate 复核：a2a-server 全量 211/211（COMPOSITION_LOCAL，§5）** | 持续条件：`@a2a-js/sdk` 或 `a2a-sdk` 升级必须重跑 [P0-02](2026-10-25-p0-02-a2a-sdk-compat-matrix.md) §6 全部验证（ADR-0018 Version lock） |
| 2 | **JS/Python SDK 验证** | **GO**（验证面 3.12.14）；部署面子项 PENDING | P1-11 对比矩阵（官方 `a2a-sdk==1.2.3` × 官方 `@a2a-js/sdk@1.3.0` 七组场景逐字段一致，§3.7 仅 SDK 表面差异）；官方 JS SDK 客户端包 [P2-02](2026-10-29-p2-02-dsh-client-integration.md)（PR [#123](https://github.com/lybym/LumiThink/pull/123)）`services/dsh-a2a-client` 39 单元 + 5 真实链路集成；官方 Python SDK [P2-03](2026-10-29-p2-03-xiaozhi-provider.md)（PR [#125](https://github.com/lybym/LumiThink/pull/125)）`services/xiaozhi-a2a-provider` 118 项。**本轮 Gate 复核：dsh-a2a-client typecheck 0 + 39/39 + 5/5；xiaozhi 118 OK 0 skip（COMPOSITION_LOCAL，§5）** | PENDING_VERIFICATION：① 部署面 Python 3.10 互通复验（P1-11 §6，本轮验证面为 3.12.14）；② `a2a-sdk` extras（gRPC/签名/telemetry/fastapi）与 REST 绑定（P0-02 §7 口径）。责任：部署面 #81 链条 + 运营者 |
| 3 | **真实 DSH Worker 验证** | **GO**（真实 worker 子进程机制 + 合成供应商内容） | `dsh-worker-runtime` / `p1-07-cancel-semantics` / `p1-08-restart-recovery-deletion` 套件（受理门 → 派发租约 → 真实子进程 → 结算四元组）；P2-02 集成 5/5（执行行 `settled` + `worker_id` + 取消以 **worker 停止证据**结算 `outcome=canceled`/exitCode 0）；P2-03/04 全链（正文逐字回吐、真实断流注入、真实协作停止）；P2-05 G2/G3a/G3b/G5a/G5b（真实并行 worker、取消×完成竞争、SIGKILL 双向）。**本轮 Gate 复核含上述全部 spec（211/211 内，COMPOSITION_LOCAL，§5）** | 局限（不阻断）：worker 内容为合成——真实模型推理归维度 4；不因"子进程机制真实"而宣称"真实模型已验证" |
| 4 | **真实模型供应商验证** | **PENDING**（刻意冻结——从未激活） | 无任何真实供应商证据：外发门禁评审未发生（[ADR-0008](../adr/0008-real-provider-egress-topology.md)/[ADR-0009](../adr/0009-real-asr-provider-transient-channel.md)/[ADR-0010](../adr/0010-real-tts-provider-dual-stream.md) 的供应商面评审未执行）；本轮全部 worker 内容合成；P1-10/#92 口径不变（dsh-worker 轮＝真实机制＋合成内容）。**无证据即 PENDING，不引用 CI/合成证据代领** | 开启条件：① 外发门禁评审通过（ADR-0008 拓扑 + 供应商凭据分发）；② `LUMITHINK_A2A_DEPLOYMENT_PROFILE=production` 前置值填实（§13.4 硬门禁，缺省即拒绝启动——本轮日志可见该门禁在位）；③ 真实供应商实测留证。责任：运营者 + #79 链条 |
| 5 | **小智服务端音频交付验证** | **GO**（隔离合成设备 harness 面）；真实挂载 PENDING | [P2-03](2026-10-29-p2-03-xiaozhi-provider.md)（58 项首版）+ [P2-04](2026-10-29-p2-04-voice-delivery-interruption.md)（PR [#126](https://github.com/lybym/LumiThink/pull/126)，累计 **118 项 0 失败 0 跳过**：交付水位账本 30、交付门控 22、种子竞态 5（60 种子×30 操作）、输出契约 19、真实链路 13——真实 a2a-server 子进程 + 跨进程 SQLite 证据）；[P2-05](2026-10-30-p2-05-dual-channel-reliability.md)（PR [#129](https://github.com/lybym/LumiThink/pull/129)）B 渠道＝真实 `XiaozhiA2AProvider` 经 runner 子进程，G1–G9 双渠道联合。**本轮 Gate 复核：xiaozhi 套件 118 OK（COMPOSITION_LOCAL，§5）** | 音频面为**设备协议面信号**（abort 钩子/cancel_check/止播标记），真实小智服务端（WSLc）挂载＝运营者 P4（P2-03 §8.1：Provider 本体与隔离验证已交付，接线未发生）；部署面 Python 3.10 安装面同维度 2 ①。责任：运营者 |
| 6 | **实际 ESP32 设备验证** | **NO-GO**（未执行） | 本 Gate 零实机操作；[#58](https://github.com/lybym/LumiThink/issues/58)（E2E-08 设备基线）与 [#59](https://github.com/lybym/LumiThink/issues/59)（E2E-09 AEC/打断/跨轮隔离）OPEN；实机规程见 `deploy/xiaozhi/runbook.md` §11/§12（3×断电重连、唤醒+10 轮、≥100 次播报中打断、门限冻结）；P2-04 §6 如实登记实机项 PENDING（打断门限、VAD/回声、止播时延） | 开启条件：运营者按 runbook §11/§12 执行并留证（#58/#59 窗口）；未执行前不得标注任何实机 PASS |
| 7 | **安全和权限验证** | **GO**（隔离面全量负例） | identity 四 spec（`identity-store` / `identity-authorizer` / `identity-authorization-policy` / `identity-service-acl`：双层认证、伪造 metadata 不改服务端裁定、跨户 -32001、撤权使缓存立即失效、设备 client_only 凭据 visitor 边界、grant 范围负例）；受理门 ACL（`executor admission gate re-checks CURRENT state`：凭据/成员资格撤销关闭在途提交）；P2-05 **G1**（双 Principal 并发、撤权仅关闭对应主体 SSE 长流、撤销后 wire 立即 401）+ **G9**（delete-first/purge 后仅墓碑、RESULT_PURGED 不重执行、撤权后 alpha 403 而设备渠道 200）；P2-03 identity negatives 6 项（真实服务端：无凭据 401/-32000、过期凭据、设备摸监护人私有任务 -32001）；[P1-13](2026-10-30-p1-13-input-required-decision.md)（PR [#128](https://github.com/lybym/LumiThink/pull/128)）input-required 契约 9 项（执行归属四元组守卫、终态不可逆、越权归属 fail-closed）。**本轮 Gate 复核含上述全部 spec（211/211 内，COMPOSITION_LOCAL，§5）** | 持续条件：真实凭据分发与家庭授权 UX 属运营面（P2-03 §8.3）；不宣称生产身份面已验收 |
| 8 | **失败恢复与回滚验证** | **GO**（仓库面故障注入 + 恢复证据）；实机演练 PENDING | P2-05 **G4**（真实 SIGKILL 服务端重启：`abandonedExecutions==2`、FAILED 结算、不重复执行、无孤儿正文、Outbox 未发布行存活、DSH `resumePending→query_or_reattach`、受理切点重派恰一次）+ **G5a/G5b**（worker 自 SIGKILL / 外部定点 SIGKILL，另一渠道不受影响）；`p1-08-restart-recovery-deletion` 套件（启动恢复扫描、delete-first、墓碑幂等）；P2-02 `FileTaskLedger` 与 P2-04 `FileDeliveryLedger` 损坏/版本漂移/剪除 fail-closed + 跨重启恢复（`resumePending` 分类、重连水位零补播）；deploy 侧 `deploy/backup.sh` + `deploy/restore.sh` 在位且本轮**零变更**。**本轮 Gate 复核含 G4/G5/p1-08（211/211 内，COMPOSITION_LOCAL，§5）** | PENDING：backup/restore **未实机演练**（演练归 [P5 #61](https://github.com/lybym/LumiThink/issues/61) E2E-11）；本维度不宣称部署面回滚已验证 |

**补充维度（P0 部署基线，非八维度但口径必须维持）**：[#82](https://github.com/lybym/LumiThink/issues/82) Gate 口径维持——**维度 B 部署基线收敛 NO-GO**（#79 §3 台账 D2/D3/D4/D5 运行侧 BLOCKED-运营者；D1 仓库侧已收敛 PR [#119](https://github.com/lybym/LumiThink/pull/119)，v0.9.8 @ 8f2dda09 pin）；**实机维度 D NO-GO（未执行）**。P2 全程在隔离开发前提下推进，未改变任何运行侧 BLOCKED 项。

## 3. 整体判定

1. **隔离开发口径：GO。** 八维度中 A2A 协议、JS/Python SDK、真实 DSH Worker、小智音频交付（隔离面）、安全权限、失败恢复共六维取得独立真实执行证据且零 SKIP；P2-01…P2-05 五个交付 Issue 与 P1-12/P1-13 两个收口 Issue 全部 CLOSED，其证据链（PR #120/#122/#123/#125/#126/#127/#128/#129）全部入 main。
2. **实机/生产/真实模型面：NO-GO/PENDING。** 真实模型供应商 PENDING（从未激活，刻意冻结）；实际 ESP32 设备 NO-GO（未执行）；真实小智服务端挂载 PENDING（运营者 P4）；backup/restore 实机演练 PENDING（#61）；P0 部署基线维度 B/D NO-GO 维持（#82）。
3. **不宣布完整 P2 产品验收通过。** 按 Epic #112 完成条件的反向条款——"只有全部必需维度取得独立证据才可宣布完整 P2 验收通过"——本 Gate 结论为：**隔离开发面证据闭环成立，完整产品验收未达成**。
4. **效力边界（冻结）：** 本 Gate 不批准生产切线、不批准切换现有 UDS 链路、不创建 Tag/Release、不使用真实儿童数据；P5 发布 Go/No-Go 归 [#62](https://github.com/lybym/LumiThink/issues/62)，不在本 Gate。
5. **证据分级声明：** 本 Gate 全部证据为 `COMPOSITION_LOCAL`（本轮四命令复核，§5）与各交付记录的 `CI`（Linux runner 同套件）；**无任何 RUNTIME_RECORDED 证据被用来冒充实机维度**；Mock/合成/真实 Worker/真实模型/实机五类证据互不代领。

## 4. 未关闭风险映射（未通过项责任任务）

| 风险 / 未关闭项 | 状态 | 责任任务 |
| --- | --- | --- |
| #79 部署台账 D2/D3/D4/D5 运行侧收敛 | OPEN，运行侧 BLOCKED-运营者 | 运营者提供部署侧证据 → [#79](https://github.com/lybym/LumiThink/issues/79) / #81 后续统一配置与迁移验证 |
| #58 E2E-08 设备基线核对与 A2A 实机接入验收 | OPEN，实机窗口未执行 | 运营者（runbook §11） |
| #59 E2E-09 XVF3800 AEC、语音打断与跨轮隔离实测 | OPEN，实机窗口未执行 | 运营者（runbook §12）；打断门限实机标定 |
| #60 E2E-10 家庭多用户专业场景、学习来源与权限验收 | OPEN，P3 | P3 阶段（P2 证据为其输入） |
| #61 E2E-11 多渠道实机可靠性、删除与备份恢复验收 | OPEN，P5 | 实机可靠性演练 + **backup/restore 实机演练**（本 Gate 维度 8 的 PENDING 尾项） |
| #62 E2E-12 A2A 多渠道发布验收与 Go/No-Go | OPEN，P5 | 发布 Gate（本 Gate 明确不批准发布） |
| P1-11 遗留：部署面 Python 3.10 互通复验 | PENDING_VERIFICATION | 部署面 #81 链条 + 运营者（验证面 3.12.14 已闭环） |
| P1-11 遗留：`a2a-sdk` extras（gRPC/签名/telemetry/fastapi）与 REST 绑定 | PENDING_VERIFICATION | P0-02 §7 口径；出现对应需求时先补验证再启用 |
| P1-11 遗留：Agent Card 签名 / push notification 未验证 | PENDING_VERIFICATION | P0-02 §6 口径沿用 |
| P2-01 ADR 遗留：REST/gRPC 绑定未测（SSE 流式 abort/取消、resubscribe 已由 P1-12/P2-05 G6 大幅覆盖） | PENDING_VERIFICATION | [ADR-0018](../adr/0018-dsh-a2a-client-selection.md) 局限 + [P2-01 记录](2026-10-29-p2-01-dsh-client-selection.md) §6；上游断开钩子仍缺失（P1-12 §5：send 路径刻意直通，上游 issue 草稿已成文） |
| P1-13 接线触发条件：出现首个真实生产场景时接线 `appendTurn` + `sendFollowUp` 全链集成测试 | OPEN（等待业务触发） | 接线 Issue（P1-13 §1/§7 已给出工程起点） |
| 服务端多进程写账本 / 账本归档滚动策略 | OPEN（设计边界，非缺陷） | 运营者挂载前决策（P2-02 §7 / P2-04 §6 口径） |

## 5. 本轮 Gate 复核的实际执行（COMPOSITION_LOCAL，2026-10-30，基线 `6e51dfa` 工作树）

> 抽样复核原则：对报告中**每个有证据维度至少独立执行 1 条代表性验证命令**，以下为本轮实跑结果（非转抄）。工具链：Node v24.x（DSH 捆绑 runtime）、Python 3.12.14（DSH 捆绑，`a2a-sdk==1.2.3` 经 P0-02 验证树 `C:\CODE\_a2a-compat-verify\pylibs` 注入）、TypeScript 5.9.3。

| # | 命令（工作目录见 §6） | 结果 | 覆盖维度 |
| --- | --- | --- | --- |
| 1 | `pnpm --dir services/a2a-server run test`（env：`LUMITHINK_A2A_PYTHON` + `LUMITHINK_P2_05_PYTHON_BIN` + `PYTHONPATH`） | **211 tests：211 pass / 0 fail / 0 skipped / 0 cancelled**（125.3s，exit 0）——含 P2-05 双渠道 G1–G9 全部 11 例与 python-sdk-interop 2 例（synthetic + dsh-worker 两轮探针） | 维度 1/2/3/7/8 |
| 2 | `python -m unittest discover -s services/xiaozhi-a2a-provider/tests -t services/xiaozhi-a2a-provider -v`（env：`PYTHONPATH` + `LUMITHINK_XIAOZHI_PROVIDER_NODE_BIN`） | **Ran 118 tests … OK**（17.4s，0 失败 0 跳过）——含 13 项真实链路（真实 a2a-server 子进程） | 维度 2/3/5/7 |
| 3 | `pnpm --dir services/dsh-a2a-client run typecheck` + `run test` + `run test:integration` | typecheck exit 0；**39/39 pass**（33.9s）；**5/5 pass**（5.1s，真实 a2a-server + 真实 dsh-worker 子进程，含 G3 worker 停止证据与 G6a 服务重启恢复） | 维度 2/3/8 |
| 4 | `pnpm run typecheck`（仓库根） | exit 0 | 全局回归 |

**首轮执行的环境变量缺口（如实留痕）**：首轮全量在漏设 `LUMITHINK_P2_05_PYTHON_BIN` 时为 **200 pass / 11 fail**——11 个失败**全部**为 P2-05 spec 的 xiaozhi runner 启动显式失败（本机 PATH 无 python，ZERO-SKIP 设计按预期把环境缺口变成显式失败而非跳过；错误信息自带补救指引），**非产品缺陷**；补齐该变量后重跑全量 211/211（上表 #1）。该现象本身印证了 P2-05 记录 §4 的 ZERO-SKIP 契约有效。

**CI 承载说明**：本 Gate 变更为纯 docs（先例 PR #122），CI 无适用 paths 触发（CI_STATUS=NONE）；本轮四命令即**本地等价验证**，且 P2 五项交付的既有 CI 门（`p1-a2a-server-gate.yml`：A2A validation service / DSH A2A client gate / xiaozhi-a2a-provider 三 job）在各自合并 PR 上已绿。

## 6. 复现命令索引（全部可直接执行）

```powershell
# 0) 基线（本 Gate 判定的 commit）
git fetch origin --prune; git switch main; git pull --ff-only origin main   # HEAD = 6e51dfa

# 1) a2a-server 全量（211 tests；维度 1/2/3/7/8）
$env:PATH = "<node24>\bin;$env:PATH"
$env:LUMITHINK_A2A_PYTHON       = "<python>=3.10 with a2a-sdk==1.2.3>"   # CI 由 setup-python 3.12 + pip 提供
$env:LUMITHINK_P2_05_PYTHON_BIN = "<同上>"                               # P2-05 双渠道 runner（漏设则该 11 例显式失败=ZERO-SKIP 设计）
$env:PYTHONPATH                 = "C:\CODE\_a2a-compat-verify\pylibs"    # 本机验证树；常规环境 pip install a2a-sdk==1.2.3 后无需
pnpm --dir services/a2a-server install --frozen-lockfile
pnpm --dir services/a2a-server run test

# 2) 小智 provider 全套（118 tests；维度 2/3/5/7）
$env:LUMITHINK_XIAOZHI_PROVIDER_NODE_BIN = "<node.exe>"
python -m unittest discover -s services/xiaozhi-a2a-provider/tests -t services/xiaozhi-a2a-provider -v

# 3) DSH A2A 客户端（typecheck + 39 单元 + 5 真实链路集成；维度 2/3/8）
pnpm --dir services/dsh-a2a-client install --frozen-lockfile
pnpm --dir services/dsh-a2a-client run typecheck
pnpm --dir services/dsh-a2a-client run test
pnpm --dir services/dsh-a2a-client run test:integration

# 4) 根工作区类型检查
pnpm run typecheck

# 单 spec 复跑（可选）
node --test --test-isolation=none tests/p2-05-dual-channel.spec.ts        # services/a2a-server 下（11 测试）
node --test --test-isolation=none tests/p1-12-sse-resubscribe-teardown.spec.ts
```

（CI 侧等价：`P1 A2A server gate` workflow 的三个 job 在 ubuntu + setup-python 3.12 + `pip install a2a-sdk==1.2.3` 下执行同一套件，全部凭据由测试合成。）

## 7. Issue #118 验收条件覆盖对照

| AC | 状态 | 证据 |
| --- | --- | --- |
| 八维度逐一有判定、证据索引与开启条件（未通过项写明责任任务） | ✅ | §2 判定表（维度 4/6 及各 PENDING 尾项均标注责任任务）；§4 风险映射 |
| 整体判定诚实（预期形态：隔离开发面 GO、实机面 NO-GO/PENDING） | ✅ | §3 整体判定（隔离开发口径 GO；完整产品验收**未**宣布通过；生产切线/UDS/发布均不批准）；§5 如实留痕首轮环境缺口与修正 |
| 报告入 main 后在 Epic 勾选对应任务并回链 | ✅（随本 PR 入 main 后生效） | Epic [#112](https://github.com/lybym/LumiThink/issues/112) 任务清单 P2-01…P2-06 与 P1-12 行勾选并附 PR 引用（本 PR 回链）；见 §8 |

## 8. Epic 勾选记录

随本 PR，Epic #112 的任务清单勾选：P2-01…P2-06 六行与 P1-12 行 `[ ] → [x]`，各行附 merge commit 或 PR 引用（P2-06 行引用本 PR）。**该勾选表示"任务完成且有证据记录入 main"，不表示 Epic 完成条件（完整 P2 产品验收）达成**——Epic 仍按 §3.3 保持开放，直至实机/真实模型维度收口。

## 9. 结论

P2-06 Gate 记录成立：八维度判定、证据索引、开启条件齐备；隔离开发口径 GO，实机/真实模型/生产面如实 NO-GO/PENDING；全部判定点指向可执行证据，复现命令可直接执行；未宣布完整 P2 产品验收通过。
