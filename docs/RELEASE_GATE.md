# LumiThink R1 发布门禁（RELEASE_GATE.md v0，issue #22）

## 2026-10-25 A2A 设计基线更新

设计评审通过（Design GO）。P0/P1 获准开展，协议互通、真实取消、设备验收和部署切换仍受各阶段 Gate 约束。

Design GO 仅批准开展 P0/P1，不表示允许上线。P0 Gate 需仓库/运行补丁/版本/回滚可复现；P1 Gate 需真实 DSH + SQLite + 官方独立客户端关键场景零跳过。P2–P5 渠道迁移、实机与发布继续各自验收；P0/P1 前不切换旧 UDS。下文候选注册表与旧 E2E Gate 继续作为历史发行证据，后续 #62 要求实际实现后更新注册表及重新生成证据，不能把本次文档变更当作发布批准。

以 [整体方案](A2A_DESIGN.md)、[Task 契约](TASK_LIFECYCLE.md) 和 [P0/P1 计划](P0_P1_PLAN.md) 为新阶段依据。以下保留既有实现/历史范围说明；冲突处以本节明确的目标约束为准，不能据此宣称代码已完成迁移。

## 既有实现与历史基线


> 状态：随 R1-10 交付 ｜ 日期：2026-10-14 ｜ 对应 [Issue #22](https://github.com/lybym/LumiThink/issues/22) · [PRD FR-007](./PRD.md) · [Roadmap R1-10](./ROADMAP.md) · [HARNESS §6](./HARNESS.md) · [TECH_STACK §1/§2/§3](./TECH_STACK.md) · [DSH_UPSTREAM](./DSH_UPSTREAM.md) · [ADR-0005](./adr/0005-child-data-lifecycle-v0.md) · [ADR-0006](./adr/0006-deployment-secrets-backup-v0.md)
>
> 本文定义 R1 的**发布门禁**：自动化部分由 `.github/workflows/r1-release-gate.yml` 承担（合成数据、Mock Provider、零真实凭据/真实儿童数据）；staging → 审批 → 发布 → 回退四道**手工门禁**由人执行。非目标：Kubernetes、服务网格、大规模 DevOps 流水线（issue 非目标）。

## 1. R1/R0 门禁地图（互不覆盖）

| 工作流 | 归属 | 职责 | 不做什么 |
| --- | --- | --- | --- |
| `r0-zero-skip-gate.yml` | R0（DSH SDK PoC） | `poc/dsh-child` 35/35 零 SKIP（ubuntu+windows）、越权负向、Egress Guard | 不触及根工程；R1-10 未改动它 |
| `r1-baseline-gate.yml` | R1 根基线 | frozen install、typecheck、unit/schema/contract 集成测试、build、干净环境 boot+health | 不做发布评测/演练 |
| `r1-deployment-gate.yml` | R1 部署（#20） | 部署物语法/模板、Linux 部署烟测（快照往返、重启恢复、安全头、回环绑定） | 不做发布门禁（#20 评审明确留给 R1-10） |
| `e2e-04-xiaozhi-deployment-gate.yml` | E2E-04（#54） | 小智私有服务端部署物语法/pinning/模板、干净环境部署冒烟（OTA 下发、回环绑定、模拟设备 hello+abort、鉴权拒绝/静默丢音频/重启/损坏配置负例） | 不做真实设备验收（归 #E2E-08）、不接供应商 ASR/TTS/LLM、不重跑 R1 基线 |
| `r1-release-gate.yml`（本 issue） | R1 发布 | ① 儿童专业与安全评测（4 套件过真实 harness）；② release manifest 漂移门禁；③ 泄漏扫描；④ Web Mock E2E（真实 HTTP）；⑤ N→N+1→N 升级回滚合成演练 | 不重跑基线单测（由 baseline gate 拥有）、不触碰 R0、不配置真实 Provider 凭据或真实儿童数据 |

互不覆盖的三条硬规则：(a) 每个 gate 的断言只增不改——本 PR 未修改既有三个 workflow；(b) R0 门禁路径过滤（`poc/dsh-child/**`、lockfile、workspace 文件）保持原样；(c) 发布判定以**全套门禁同时绿**为准，任何单个 gate 无权豁免另一个。

## 2. 发布清单（release manifest = 版本追溯记录）

`release/release-manifest.json` 是**经评审的版本基线**，逐项记录（schema v1.0）：

- 应用 `name`/`version`（package.json）与声明工具链（engines node / packageManager pnpm）；
- 评测面：报告 schemaVersion（1.1）、4 个发布套件版本、subject 版本（全部**从代码导入**生成，非手抄）；
- 领域版本：Safety Policy、协议、Persona Registry、Evidence/Skill Registry、Skill Router、Runtime Pipeline、Gateway 协议、Guardian Disclosure；
- **固定 DSH/插件锁**：`poc/dsh-child/package.json` 中全部 `@deepseek-ai/*` 精确 pin + 根/POC 两个 lockfile 的 SHA-256；
- 持久化事实：`prisma/schema.prisma` SHA-256（冻结）+ 运行时快照格式（`lumithink.runtime-snapshot/v1`）；
- 部署物摘要：`deploy/` 六个制品的 SHA-256。

**漂移 = 阻断（AC：版本/Schema 漂移、依赖版本变化自动 BLOCK）**：CI 用同一构建器从代码重建 live manifest，与基线逐键深比较；任何差异（含未知键/键缺失）`fail-closed`。**确认漂移的唯一方式**是再生成清单 → 人工评审 diff → 提交：这是发布审批的显式确认动作，不是可以绕过的绊脚石。每次运行的 per-run 记录（含 commit SHA）只进 CI artifact，绝不提交（commit 字段不可能稳定）。本仓库无 git tag，版本追溯 = manifest 基线 + per-run 记录中的精确 commit SHA + 各 gate 的 run URL。结构性保护（Round 1 评审 P2-2）：`.github/CODEOWNERS` 已将 `release/release-manifest.json` 指认给维护者（@lybym）；其强制生效需仓库设置开启 "Require review from Code Owners"（分支保护设置无法由 PR 设置），当前为记录在案的推荐项。

## 3. 手工门禁：staging → 审批 → 发布 → 回退

**Gate 1 — staging（准入）**：发布候选 = 一个 PR HEAD SHA。进入 staging 当且仅当：四个 R1/R0 workflow 在该 SHA（或其 PR merge commit）全绿；`r1-upgrade-rollback-drill-report-final` artifact（自含逐阶段执行结果 `phaseOutcomes`）已生成且 `allPhasesPassed`、`stateSchemaChanged` 与风险条目被读过；评测 artifact（内容无关报告 + per-run manifest）已归档。staging 环境部署按 `deploy/runbook.md` §2 在**合成数据**上执行（不对真实儿童开放）。

**Gate 2 — 审批（人工）**：具备 `approve` 权限的评审人对 PR 完成独立 review（本工作流中由独立 REVIEW_AGENT + 人工复核执行）。审批必须显式覆盖：manifest diff（若有漂移）、状态 schema 变化（若有）、评测报告中的 `pendingHumanReview` 清单（人类评审项只记录、不打分、不阻断——由人判断是否可发布）、安全/隐私回归。审批动作 = PR approve；无 approve 的发布是违规操作。

**Gate 3 — 发布**：merge 到 main 后，按 runbook §2 以**同一 commit SHA** 部署目标主机（release 目录按 SHA 保留）；部署后运行 `deploy/healthcheck.sh` 并核对 `/api/health` 与 manifest 的应用版本一致。发布**不自动升级 DSH RC/Stable**：`@deepseek-ai/*` pin 与 lockfile 摘要被 manifest 锁定，任何 DSH 升级都是"隔离测试 → 兼容性/安全/隐私回归 → manifest 再生成 → 人工审批"的独立 PR（DSH_UPSTREAM.md 纪律）。

**Gate 4 — 回退**：按 runbook §7 执行（应用目录切回上一 SHA / 配置回滚 / 快照归档恢复）。补充约束见 §5 风险登记册：**回退前必须确认目标版本能读当前快照**（演练持续证明这一点的自动化面）；若状态 schema 在两个版本间变化且演练判 rollback 风险高，回退需先评估数据兼容性或选择前向修复。

## 4. 演练（AC 2：空主机部署 N → 升级 N+1 → 回滚 N）

每个 PR 上，`upgrade-rollback-drill` job 执行合成演练并产出 `r1-upgrade-rollback-drill-report` artifact：

1. **依赖漂移守卫**（fail-closed）：N 与 N+1 的 `package.json`/两个 lockfile/workspace/poc manifest 必须逐字节一致，否则演练直接失败（依赖版本变化必须走 manifest 确认，不能在演练中蒙混）；
2. **Phase N — 空主机部署基版本**：`git switch --detach` 到 N（PR 场景 = main 基点），frozen install、build、以全新快照目录 + 随机快照密钥 boot，健康检查通过，监护人登录（公开合成演示码），断言演示默认态后确认 `conversation_recording=true`，快照落盘并输出摘要；
3. **Phase N+1 — 同状态升级**：切到 N+1，重建、以**同一**快照路径/密钥 boot，断言 N 时代状态存活、审计环含 `snapshot_restored`，再确认 `conversation_recording=false`；
4. **Phase N — 回滚**：切回 N，重建、同快照 boot，断言 N 能读回 N+1 时代的最终状态（双向兼容、无复活、无静默丢失、无格式墙），审计环含 `snapshot_restored`；
5. **风险报告**：drill report JSON 记录三个阶段、两个 SHA、依赖/状态 schema 漂移评估与不可回退迁移风险条目；泄漏扫描后上传 artifact。每个阶段完成后向最终报告（`r1-upgrade-rollback-drill-report-final`）追加**实际执行结果**（`phaseOutcomes`：逐阶段 outcome + 快照 digest，内容无关）——artifact 自含过程证据，缺失的 outcome 行即代表该阶段未完成（Round 1 评审 P2-1）。

诚实边界：演练证明的是**单机快照状态面**的升级/回滚兼容行为；真实主机运维（公网暴露、离机备份、systemd 内核差异）仍按 runbook §9 由运维执行，CI 无法证明。

## 5. 不可回退数据迁移风险登记册（随演练报告复述）

| # | 风险 | 约束 |
| --- | --- | --- |
| 1 | 快照格式 `lumithink.runtime-snapshot/v1` 升级 | 任何格式 bump 必须让上一版本仍能读旧状态（或显式声明该版本回退不受支持并记录于此）；演练在 N 读不出 N+1 状态时立即失败 |
| 2 | 确认变更 → 快照写入的原子窗口 | 崩溃恰落窗口内回退该笔变更（runbook §5 披露）；属回滚语义边界，非数据迁移 |
| 3 | 恢复时删除台账重放 | 有意不可逆：恢复旧档后重放删除，绝不复活已删数据（ADR-0005；restore.sh 自清标记） |
| 4 | prisma schema 冻结 | 摘要被 manifest 锁定；SQLite 持久化延后（TECH_STACK §3）。任何 schema 变更 = 新数据建模决策，须附 migration + migration test 后方可入 release |
| 5 | 状态 schema（`lib/server/snapshot/`）变化 | 演练自动标记 `stateSchemaChanged=true` 并在报告中要求 PR 评审复核回滚兼容性 |

## 6. 泄漏告警与权限越权（自动 BLOCK）

- **泄漏扫描**（`scripts/release-gate/` `scanForLeaks`）：对评测报告、manifest、drill report 及其最终版扫描 Provider 凭据形状（`sk-…`/`gh*_…`/`github_pat_…`/`AKIA…`/`xox…`，逐规则单测钉住）、私钥块与一切非 `chd_demo_` 语法子域的儿童引用；命中即阻断发布。深度防御：报告本身内容无关（fail-closed 解析器拒绝任何载荷字段），扫描覆盖的是清单与其余 artifact 类别；匹配内容永不回显（no-echo）。CI 环境守卫断言 `DATABASE_URL` 与全部 Provider key 未设置——日志与 CI 里不存在真实儿童记录/密钥/原始音频。**范围边界（显式披露）**：扫描对象是 gate 产物文件，不含 CI/步骤日志（日志只承载值无关的状态行与失败摘要；报告内容无关构造 + 环境守卫使日志天然不携带扫描对象内容）。
- **零出网观测（Web Mock E2E）**：E2E 步骤以 10 Hz 对 `ss -tnpH` 全程采样（覆盖整个流量窗口 + 结束后补扫），检测器按**精确 pid 集合**匹配应用进程树（服务端 + 全部后代），回环集合 = `127.0.0.0/8` + `::1` + IPv4-mapped `::ffff:127.0.0.0/8`；检测器内嵌自测把固定违规样本钉进 CI（树内真实出网线必须被抓到、回环/外来 pid 线必须保持干净）。机制为**观测**而非 runner 级 nftables/iptables 阻断（hosted runner 的 agent 与 job 同 uid，uid 级 OUTPUT 阻断会切断 runner 自身控制/制品通道）；残余盲区：两个采样点之间打开并关闭的连接、或结束后才收集前退出的树内 pid——Mock Provider 本身 `local_no_egress` by construction，本步为其上的 runner 级观测证据（Round 1 评审 P1-1 修复）。
- **权限越权**：评测套件含未注册工具、注册工具越界、隐私越权导出与 Prompt 注入场景（`safety_failure`/`unreviewed_evidence`/关键 SKIP 触发器直接套件 FAIL）；域边界测试（`tests/domain/boundary.spec.ts`、legacy guard）与 Web E2E 的伪造身份 403 断言在 CI 中逐层自动阻断。安全高危失败没有人工放行通道。

## 7. CI 无法证明的部分（诚实披露）

- 真实模型 Provider 出网行为（真实凭据按 MODEL_GATEWAY 纪律从未进入 CI）；
- 真实主机运维面（公网扫描、ACME/HSTS、离机备份介质、异地容灾演练、内核级 systemd 沙箱效果）；
- 人工审批的实际执行（CI 只能要求 approve 存在，不能代替人判断 `pendingHumanReview` 清单）；
- artifact 存储配额类基础设施失败（不是业务失败，但按外层规则不得据此放行）。

## 8. 首版产品验收门禁（E2E-12，issue #62——随 1.0.0-rc.1 候选交付）

本文件 §1–§7 定义 R1 的自动化发布门禁与四道手工门禁；首版产品验收在其上叠加**产品级 Go/No-Go 层**（[Issue #62](https://github.com/lybym/LumiThink/issues/62)），只增不改 §1–§7 的任何断言：

- **候选注册表** [`release/release-candidate.json`](../release/release-candidate.json)：冻结首版产品范围、逐条登记 DoD 证据（`automated` = CI 门禁证明；`human` = 实机/人工，pending 时不得代领 PASS）。其 invariant 由 `scripts/release-gate/acceptance.ts` + `tests/release/release-candidate.spec.ts` fail-closed 强制（`r1-baseline-gate.yml` 的 `pnpm test`）：pending 决定不得有 recorded human 行；Go 需六维 verdict 全 go、无 blockedItems 且全部 human 行 recorded（**未通过的必做项不可降级成文字说明后发版**）；`release.state=created` 需 Go + 用户显式批准 + release record；`requiresExplicitUserApproval` 为硬常量。
- **版本 1.0.0-rc.1**：package.json ↔ manifest `app.version` ↔ 注册表三方一致；manifest 随候选 PR 再生成并评审（§2 的显式确认动作），漂移照常 BLOCK。
- **发行说明与已知限制**：[RELEASE_NOTES](./RELEASE_NOTES.md)；**实机执行与判定流程**：[deploy/xiaozhi runbook §15](../deploy/xiaozhi/runbook.md)（演示脚本、六维 Go/No-Go 记录、用户发版批准与回退）。
- 口径不变：未走完"实机留证 + Go + 用户批准"前不创建任何 Tag/Release；本节不改变发布判定仍以**全套门禁同时绿**为准的规则。
