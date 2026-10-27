# P1-10 A2A 验收 Gate — 官方双 SDK × SQLite × 真实 DSH 核心（Issue #92）

批次：sequential-issues iss-83–92。基线：main 835e7429446898b688d63700f3417e9167447848（P1-01..09 全部合并）。
锁定版本：@a2a-js/sdk **1.3.0**；任务库 schema **v3**、身份库 schema **v2**；node v24.21.0；门禁脚本 services/a2a-server/package.json `scripts.test`（19 spec 文件，用例 **185/185 pass、0 fail、0 skipped** @ 本报告 commit 的前置 HEAD），另 CI A2A validation service gate。

本文档为 AC 证据索引：每行引用**真实存在的测试与结果**（不跳过、不以假执行器替代关键验证）；Mock / 真实 DSH Worker 子进程 / 真实模型 / 设备证据分开标记。Python 端官方 a2a-sdk 本机不可得（python/pip 缺失），如实 NOT_RUN——不冒充。

## 一、AC 覆盖矩阵（Issue #92 正文逐条）

### AC-1 Task 创建/多 Turn/查询/流式/终态订阅错误/显式取消/重复取消/首响应丢失/并发幂等/跨主体拒绝 —— **GO**

| 域 | 测试锚点（tests/…spec.ts） | 结果 |
|---|---|---|
| Task 创建+受理幂等 | acceptance-idempotency.spec.ts（27.9KB：作用域请求键+fpv1 指纹+原子受理 ledger）、request-key.spec.ts | PASS |
| 多 Turn/追加正文受限 | task-manager-repository.spec.ts（appendTurn/准入窗口）、acceptance-idempotency（补充输入语义） | PASS |
| 查询/GetTask/列取 | task-manager-sdk-bridge.spec.ts、official-client-roundtrip.spec.ts（官方 JS client GetTask） | PASS |
| 流式（SSE）断开恢复 | stream-resilience.spec.ts（SSE 断开≠取消、重订阅、GetTask 恢复）、official-client-roundtrip（流式往返） | PASS |
| 终态订阅错误码 | protocol-errors.spec.ts（-32001/-32002/-32004/-32009/-32602/-32700 冻结 fixtures 映射） | PASS |
| 显式取消/重复取消/取消后语义 | p1-07-cancel-semantics.spec.ts（标准取消族 fixtures 08/09/11 + 新增 13/14；取消受理后真实完成→COMPLETED+抑制旗标；never-stops 非协作 Worker→SIGKILL 证据落行后才 CANCELED；重复取消无副作用） | PASS |
| 首响应丢失恢复 | p1-08-restart-recovery-deletion.spec.ts（五切点重启扫描；confirm-never-started 经真 lease 重派；REAL crash-restart：SIGKILL 真子进程 mid-execution→abandoned+FAILED、零重派/孤儿收养） | PASS |
| 并发幂等 | acceptance-idempotency.spec.ts（同键异内容 -32602 MESSAGE_ID_CONFLICT 不泄漏主体；重复原消息快照直答不重复推理）+ p1-04 起全套回归 | PASS |
| 跨主体拒绝（身份隔离） | identity-service-acl.spec.ts（两层认证+集中授权+X-Lumithink-Session-Binding 强校验+跨家庭负例）、identity-authorizer.spec.ts（准入门完整受理链复核：凭据→客户端→主体→grant→策略） | PASS |

### AC-2 真实 Worker 停止、取消完成竞争、快照增量、重启无重复执行、删除/撤权、满载控制 —— 关键路径 **零 SKIP → GO**

| 域 | 锚点 | 结果 |
|---|---|---|
| 真实 Worker 停止（非协作/超时/崩溃） | dsh-worker-runtime.spec.ts（spawn 真子进程、四类 watchdog、SIGKILL 退出证据 killedByRuntime）+ p1-08（forced-stop 证据记录 OBSERVED signal） | PASS |
| 取消×完成竞争 | p1-07（§7.2 分支补齐：worker 真实完成后取消→COMPLETED+outputSuppressedAfterCancel:true 元数据经权威 save 落库；条件更新唯一赢家） | PASS |
| 快照增量/Outbox 重放 | task-manager-repository（getReplayCutpoint 单事务一致性切点/readOutboxAfter 游标）、stream-resilience | PASS |
| 重启无重复执行 | p1-08（REAL crash-restart 断言 executions===1、no re-dispatch、reclaimable 空） | PASS |
| 删除/撤权优先 | p1-08（DeletionLedger record-first 重放、restore-simulation 复活正文再清除、purgeProcessingScope 家庭范围撤销逐条记账、身份库孤儿绑定释放） | PASS |
| 满载控制（资源限额） | p1-09-resource-limits.spec.ts（capacity_full 明确拒绝、queue_full_global/household、queue_wait_timeout 有界、控制面保留槽+deadline、**容量拒绝不悬挂 working（真实 wire 三并发回归）**、泄漏诊断面 doubleReleases/liveModelGrants） | PASS |

**SKIP 清点：全量套件 skipped=0。关键路径零 SKIP 成立。**

### AC-3 第二轮 REVIEW2-01/02/03 与 P5 备份演练状态 —— **GO（含诚实 PENDING）**
- P0 批次第二轮评审记录：docs/reviews/2026-10-25-p0-0*.md（PR #95–#98 内）与验收索引（#82）收录完整。
- P1 批次两轮 Review 已成事实：#102（r1 CHANGES_REQUESTED→修复→r2 APPROVE）、#107（同形循环）、#108（CI 中断修复→r2 APPROVE）——各 PR 上均有 lybym-codex-reviewer[bot] 双轮记录（review id 见 Issue 关闭评论）。
- **P5 真实备份演练：PENDING（NOT RUN）**——维度 C 的备份/回滚脚本已具备（#90 恢复模块+预迁移测试），但真实演练依赖部署环境，仍待完成；本 Gate 不冒充该项。

### AC-4 版本/配置/命令/报告索引与 GO/NO-GO —— **本报告即交付物**；判定见下节。

## 二、复现命令（可复现性索引）

```powershell
cd services/a2a-server
& <node v24.21.0> <repo>/node_modules/typescript/bin/tsc --noEmit -p tsconfig.json   # typecheck, exit 0
& <node v24.21.0> --test --test-isolation=none tests/<spec>.spec.ts                  # 单 spec
$scriptLine = ((Get-Content package.json -Raw | ConvertFrom-Json).scripts.test) -replace '^node\s+',''
& <node v24.21.0> ($scriptLine -split '\s+' | Where-Object { $_ })                   # 全量 185/185
```
CI：run 40440081265 @ bb5d33e（gate success，paths 过滤语义）；分支级 run 40438073628 曾因测试卫生失败并已修复（bb5d33e 后绿）。

## 三、局限与未关闭风险（诚实清单）

1. **Python 官方 SDK 端：NOT_RUN**——本机无 python/pip；JS 端官方客户端覆盖协议半边，Python 半边的独立复跑维持 PENDING（继承自 #83/#90 记录）。
2. **真实模型/真实儿童数据：NOT_RUN（刻意冻结）**——B/D 收敛前不切换 UDS、不用真实数据、不发布；全部执行体为合成供应商内容（源码级 SYNTHETIC 守卫标注）。
3. **Worker 内存上限**：V8 heap flag（非 OS RSS 硬限）；synthetic 报告如实标注 not_configured/0（ADR-0017 limitations）。
4. **daily token 预算**：部署必填项缺失时检查惰性、load report limitations 显式声明（ADR-0017）。
5. 多实例扩展的 SQLite 争用需按 §13.4 重验（单进程内 busy_timeout 有界实测通过）。
6. r2 review 移交的五个非阻断质量项（stale docblock×2、acquireModelCall 生产接线、LeaseKeys 观测关联、/ops 正向回环、control counter 轮询）已登记（issue #91 关闭评论），建议随渠道验证排期。

## 四、GO/NO-GO（分维度 + 整体）

| 维度 | 判定 | 依据 |
|---|---|---|
| 协议与应用契约（官方 JS 客户端 × 合成执行） | **GO** | AC-1 全表 PASS、fixtures 08–14 冻结体系一致 |
| 持久仓储（SQLite 统一仓储/Outbox/恢复） | **GO** | AC-2 相关行全 PASS、schema v3 迁移+fail-closed |
| 身份隔离（租户/双层认证/授权/ACL） | **GO** | identity 四 spec 全 PASS、准入门受理链复核 |
| 真实 DSH Worker 核心路径 | **GO**（隔离/合成边界内） | spawn/watchdog/SIGKILL 证据、结算统一；不含真实模型 |
| 满载与背压 | **GO** | p1-09 全绿（容量拒绝合法落库+不悬挂回归） |
| Python 官方 SDK 半边 | **PENDING**（NOT_RUN：本机无解释器） | 诚实标注；不阻塞本 Gate 的隔离开发结论 |
| 维度 B 部署基线收敛 | **NO-GO**（未变） | #82 口径延续 |
| 维度 D 正式实机验收 | **NO-GO**（未变） | #82 口径延续 |
| P5 真实备份演练 | **PENDING** | 环境依赖，未冒充 |

**整体判定：GO（隔离开发口径）**——P1 隔离开发阶段的验收目标达成，可进入后续渠道验证准备；**明确不批准**生产切线、真实儿童资料使用或任何发布（维度 B/D 收敛或 P0/P1 Gate 整体通过前持续冻结）。

依据文档：docs/A2A_DESIGN.md、docs/TASK_LIFECYCLE.md、docs/P0_P1_PLAN.md、docs/adr/0013..0017、docs/reviews/2026-10-25-p0-04-p0-gate-acceptance-index.md、docs/reviews/2026-10-26-p1-0*.md 各实现记录。