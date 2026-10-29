# P1-13 a2a-server 多轮续接收口 — INPUT_REQUIRED 生产场景决策与实现记录（issue #124；2026-10-30）

> 关联 Epic：[#112](https://github.com/lybym/LumiThink/issues/112)；联动：[#114](https://github.com/lybym/LumiThink/issues/114)（G1 剩余项随本决策收口）、[#121](https://github.com/lybym/LumiThink/issues/121)（P1-12 先行收口）。
>
> 来源：[P2-02 实现记录 §7/§8](2026-10-29-p2-02-dsh-client-integration.md)（服务端能力缺口归属 a2a-server）与 [Issue #124](https://github.com/lybym/LumiThink/issues/124) 现状核实。权威设计：[TASK_LIFECYCLE.md](../../TASK_LIFECYCLE.md) §3（状态机）、§5.2（补充输入语义）、§9（重启恢复）。
>
> **口径**：全部公开内容合成、全程 loopback、无真实凭据、无儿童资料、不切 UDS、不做部署动作；**不放宽幂等/权限语义；零 `src/` 改动**（纯契约测试 + 本决策记录）。`@a2a-js/sdk@1.3.0` 精确 pin 不升级。

## 1. 决策（Issue #124 AC-1）

**决策：首期（P1/P2 阶段）不接线 `appendTurn` 生产路径；Issue #124 按 AC-3 路径缩窄为服务端级契约测试层。**

理由（本记录为第三次独立核实，与前两次结论一致）：

1. **`appendTurn` 全仓零生产调用方**。全仓 grep：命中仅四处性质——仓储层定义（`services/a2a-server/src/task-manager/sqlite-task-manager.ts:756`）、仓储级测试（`tests/task-manager-repository.spec.ts` 两处调用，属测试面）、文档记录（P1-02/P1-10/P1-11/P2-02 四篇 review）与 Python 探针注释（`py/python_sdk_interop_probe.py:19`，明确"线上不可达"）。`src/` 请求路径（a2a-service、受理门、执行器）零调用。
2. **请求路径无 INPUT_REQUIRED / AUTH_REQUIRED 生产者**。`src/` grep `input_required|auth_required|TASK_STATE_INPUT_REQUIRED|TASK_STATE_AUTH_REQUIRED`：命中仅状态机转换表（`state-machine.ts:23-24,54-56,70-71`）、schema CHECK 约束（`schema.ts:56`）与恢复扫描的保留语义（`recovery/startup-recovery.ts:19,358`——"无执行行的等待任务保留等待"，是消费而非生产）。SyntheticExecutor 与 dispatch-lease-executor 均不产生这两个状态。
3. **首期业务全部只读**，不存在"等待补充输入/等待同主体授权"的真实业务路径；多轮现仅"同 Context 新 Task"形态（[P1-11 记录](2026-10-29-p1-11-python-sdk-interop-verification.md)：新 messageId + 原 contextId → 同 Context 新 Task；逐 Turn 补充输入 `appendTurn` 为仓储层 API，线上不可达、未断言）。

三次独立核实溯源：① [#114 独立 Review（P2-02 记录 §7）](2026-10-29-p2-02-dsh-client-integration.md)——"真实服务器上无法端到端演示 INPUT_REQUIRED → 补充输入 → 同 Task 新 Turn"，缺口归属 a2a-server；② [#124 正文现状核实](https://github.com/lybym/LumiThink/issues/124)——appendTurn 零调用方、请求路径无 INPUT_REQUIRED 生产者；③ 本记录上述 1–3 的独立 grep 复核（基线 `af7e4ef`）。**本代理独立核查后同意该判断，未发现首期真实生产场景，无需反向决定。**

**保留语义**（不因不接线而弱化）：状态机 8 状态与转换表（含 INPUT_REQUIRED/AUTH_REQUIRED → WORKING/CANCELED/FAILED 全部转换）、受理门幂等/权限/配额语义、执行归属四元组锚、终态不可逆、§9 恢复保留等待——本次零 `src/` 改动，全部语义原样在库；INPUT_REQUIRED/AUTH_REQUIRED 的服务端级契约由本记录 §3 的新增 spec 钉死。

**接线触发条件**：出现第一个真实生产场景（如学习查询缺少必要参数时的结构化追问）时接线 `appendTurn`（受理门 → 同 Task 新 Turn → 执行派发），保持幂等键/指纹/权限复查/配额语义与 §5.2 一致（新 messageId 独立去重后关联原 Task）。

**接线后的首个验收项**：`dsh-a2a-client` 的 `sendFollowUp`（P2-02 已交付、mock 层线级验证）对接服务端的集成测试——INPUT_REQUIRED 生产 → `sendFollowUp` → 同 Task 新 Turn → WORKING → 终态，全链真实测试（含权限复查与幂等负例）；零 SKIP。在本决策生效前**不做**该集成测试（无生产场景可驱动）。

## 2. #114 G1 剩余项收口口径

P2-02 记录 §9 的 G1 残留 = "多轮的 INPUT_REQUIRED 段为 mock 级（服务端缺口）"。本决策按 Issue #124 联动条款收口：**缺口以"正式决策记录（本文 §1）+ 服务端级契约测试（§3）"收口**——服务端能力（状态机转换、`appendTurn` 仓储原语、条件更新与终态不可逆）已由契约测试钉死且零回退；真实链路的"多轮"演示继续以同 Context 会话续接形态成立（与 P2-02 记录口径一致）。`sendFollowUp` 的真实链路集成验证转为接线触发后的首个验收项（§1），不再作为 #114 的未决项挂账。

## 3. 缩窄后的工程范围与契约清单（Issue #124 AC-3 路径）

新增 `services/a2a-server/tests/input-required-contract.spec.ts`（9 测试，全部合成、零 SKIP），经 **SqliteTaskManager 唯一权威写入路径**（ADR-0013）构造等待态任务并钉死组合级契约；单元级转换表已有 `tests/task-manager-state-machine.spec.ts` 锚定，本 spec 补齐服务端持久化组合面：

| # | 测试 | 钉死的契约 | TASK_LIFECYCLE 锚 |
| --- | --- | --- | --- |
| 1 | `working → input_required` 带执行归属提交；`load()` 暴露 `TASK_STATE_INPUT_REQUIRED` 线格式；Outbox `statusUpdate` 含 from/to/reason/四元组 | 等待态构造 = 权威路径条件更新 + 执行归属验证 | §3、§4.2 |
| 2 | `working → auth_required` 同构构造；错租约/虚构执行行/过期租约三类归属失败均 fail-closed 且权威行不动 | 授权验证面的归属守卫（含租约到期上限） | §3、§4.2 |
| 3 | 等待任务上补充输入：`appendTurn` 新 messageId → Turn 2/epoch 2 独立去重关联原任务；`INPUT_REQUIRED → WORKING` 合法续行；同键同指纹重投 → duplicate 指回原任务；同键异指纹 → `message_id_conflict`；重复 requestKey → rejected | §5.2 补充输入行全语义（新 messageId 独立去重后关联原 Task） | §3、§5.2 |
| 4 | 等待态条件更新纪律：错期望态/错版本 → stale 且版本不动；同版本双写竞态恰一胜者 | 竞态输家重读重决，不无条件覆盖 | §4.2 |
| 5 | 到期失败：`INPUT_REQUIRED → FAILED`（运行时 transitionTask，稳定 reason）；`AUTH_REQUIRED → FAILED`（恢复扫描 settleRecoveredTask，`source: startup-recovery`）；`input_required → completed/auth_required/submitted` 全部 `illegal_transition` | 两个权威结算入口 + 等待态禁走终态捷径 | §3、§9 |
| 6 | 到期失败后终态不可逆：FAILED 无出边、迟到 Turn 拒（`task_terminal`）、迟到正文拒（`task_terminal`）、原键幂等重投读 FAILED 快照不重开、终态取消为 no-op | §1.4 终态不可逆的组合级证据 | §1.4、§3、§5.2 |
| 7 | 等待态取消：意图先关正文准入（`output_admission_closed` 负例）→ 条件更新结算 CANCELED；重复取消 no-op；`AUTH_REQUIRED → CANCELED` 同构 | 取消从等待态确认的完整次序 | §3、§7.1 |
| 8 | 恢复扫描：等待任务在有效期限内保留为非终态（状态/准入原样、不误判为中断执行）；到期结算后移出非终态扫描 | §9 恢复语义（保留等待；到期则失败） | §9 |
| 9 | SDK 快照桥：合法 `working → input_required` 快照提交（唯一现存"生产者形态"入口）；等待态快照谎报 COMPLETED 被丢弃且版本不动；终态行拒绝快照复活 | 桥级守卫：非法快照不覆盖权威行 | §1.4、§3 |

接线面说明：`package.json` 的 `test` 枚举追加新 spec（同 P1-12 先例，非 `src/`）；其余零改动——`git diff --stat main -- services/a2a-server/src` 为空。

## 4. 验证

| 项 | 值 |
| --- | --- |
| 基线 | `main` @ `af7e4ef146c86f97c628aea9f301c7e15f565119`（fetch → switch → `pull --ff-only`，本地 HEAD = `origin/main`） |
| 分支 | `feature/p1-13-input-required-contract`（自基线切出） |
| 工具链 | Node v24.21.0（DSH 捆绑 runtime）、pnpm（DSH 捆绑）、TypeScript 5.9.3、`@a2a-js/sdk@1.3.0`（精确 pin 不变） |
| 新 spec | 9/9 pass，0 fail，0 skipped（零 SKIP 设计，见 §6 命令一） |
| 全量套件 | 200 tests：198 pass / 2 fail / 0 skipped——唯二失败为 `python-sdk-interop` 两例（本机无带 `a2a-sdk` 的 Python 解释器，ZERO-SKIP 设计的显式失败；与本次改动无关——`git diff` 未触及该 spec 及其依赖；CI 由 setup-python 3.12 + `a2a-sdk==1.2.3` 执行同套件会绿，以 PR checks 为准） |
| 类型检查 | `services/a2a-server` `tsc --noEmit` exit 0；根 `pnpm run typecheck` exit 0（根 tsconfig `exclude: services/`，与本次变更正交，仍复验） |
| 回归面 | 既有 191 测试零回退（唯二失败与 P1-12 记录 §4.3 所载本机基线完全一致）；锁文件零变化 |

## 5. 局限（如实）

1. **等待到期上限是策略层语义，无持久化 deadline 列**：§3"等待时间有上限"的上限值属应用配置/决策层；仓储与状态机提供的是"到期失败的权威结算通道"（`transitionTask` / `settleRecoveredTask` 的条件更新 + 终态不可逆）。等待任务的扫描兜底（"有效期限届满自动失败"的定时决策）属接线时的服务端编排面，本次不做。
2. **后续 Turn 的执行租约路径在仓储层尚无入口**：`claimExecution` 仅受理 `submitted` 首领；补充输入（Turn 2+）的执行派发租约登记需接线时扩展（新 Turn 的 claim 语义）。因此 spec 中"合法补充输入"的 `INPUT_REQUIRED → WORKING` 以纯条件更新钉死（无执行归属参数），四元组归属守卫以 Turn 1 构造面与负例钉死。
3. **快照桥是当前唯一的"生产者形态"入口**（spec #9 钉死其合法/非法两面），但首期无执行器使用它产生等待态——这正是"无生产者"判断的组成部分，不是附加能力。
4. `python-sdk-interop` 两例在本机为设计性 FAIL（无带 `a2a-sdk` 的解释器），CI 会绿；本记录以 PR checks 为最终口径。
5. 本决策不改变 #124 的"非目标"：不改状态机语义、不做部署动作、不放宽幂等/权限。

## 6. 复现与验证命令

```powershell
# ① 新 spec（零 SKIP）
node --test --test-isolation=none tests/input-required-contract.spec.ts
# ② a2a-server 全量（python-interop 两例在无 a2a-sdk 解释器的本机为显式 FAIL=ZERO-SKIP 设计；CI 带 Python 会绿）
pnpm --dir services/a2a-server test
# ③ 类型检查
pnpm --dir services/a2a-server run typecheck
pnpm run typecheck   # 仓库根
```

## 7. 联动

- #114 G1 剩余项：随本决策收口（§2）；PR body 同步注明。
- Epic #112 / P2-05 联合回归：多轮"同 Context 续接"形态不受影响；等待态契约已入库，接线触发时无需重新设计。
- 后续接线 Issue 的工程起点 = §1 接线触发条件 + §5.1/§5.2 两项扩展（到期决策编排、Turn 2+ 派发租约）+ `sendFollowUp` 集成测试（首个验收项）。
