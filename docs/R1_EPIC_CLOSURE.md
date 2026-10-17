# LumiThink R1 Epic 收口审计（R1_EPIC_CLOSURE.md）

> 状态：R1 发布 Gate 收口核验记录 ｜ 日期：2026-10-17 ｜ 对应 Epic [#11](https://github.com/lybym/LumiThink/issues/11) · [RELEASE_GATE](./RELEASE_GATE.md) · [Roadmap §3](./ROADMAP.md) · [RELEASE_NOTES](./RELEASE_NOTES.md)
>
> **结论**：Epic #11 的 8 项 R1 发布 Gate 在 main `05eff7d8ec9277545347eb3bb4055bba92b3aab0` 全部满足（逐条证据见 §2，收口时点验证记录见 §3）；16 张 R1 子 Issue（#12–#27）与 3 张 R1-V 先导 Issue（#28–#30）均已随 Feature PR 合并关闭（§1）。本记录是纯文档收口，不引入任何代码、架构、持久化 Schema 或产品行为变化。

## 1. 子 Issue → 合并 PR 台账

| 子 Issue | 工作项 | 合并 PR |
| --- | --- | --- |
| #12 | R1-00 工程基线/历史资产审计/根工程可运行 | [#31](https://github.com/lybym/LumiThink/pull/31) |
| #13 | R1-01 InteractionEvent / AgentResponse / Session 契约 | [#32](https://github.com/lybym/LumiThink/pull/32) |
| #14 | R1-02 Model Gateway（Mock/真实、预算、超时、取消） | [#37](https://github.com/lybym/LumiThink/pull/37) |
| #15 | R1-03 DSH SDK 集成与 Cordis 领域 Pipeline | [#38](https://github.com/lybym/LumiThink/pull/38) |
| #16 | R1-04 Persona v0 | [#36](https://github.com/lybym/LumiThink/pull/36) |
| #17 | R1-05 儿童 Web MVP | [#39](https://github.com/lybym/LumiThink/pull/39) |
| #18 | R1-06 监护人鉴权/授权/功能开关 | [#42](https://github.com/lybym/LumiThink/pull/42) |
| #19 | R1-07 Evaluation Harness | [#34](https://github.com/lybym/LumiThink/pull/34) |
| #20 | R1-08 Linux 部署/Secrets/脱敏审计/备份 | [#45](https://github.com/lybym/LumiThink/pull/45) |
| #21 | R1-09 数据生命周期（导出/删除/审计） | [#44](https://github.com/lybym/LumiThink/pull/44) |
| #22 | R1-10 CI/发布/回滚门禁 | [#46](https://github.com/lybym/LumiThink/pull/46) |
| #23 | R1-11 情绪支持 Skill | [#40](https://github.com/lybym/LumiThink/pull/40) |
| #24 | R1-12 困难任务启动 Skill | [#41](https://github.com/lybym/LumiThink/pull/41) |
| #25 | R1-13 Evidence Card / Skill Registry | [#35](https://github.com/lybym/LumiThink/pull/35) |
| #26 | R1-14 受控最小 Child Memory | [#43](https://github.com/lybym/LumiThink/pull/43) |
| #27 | R1-15 Input/Tool/Output Safety Gate | [#33](https://github.com/lybym/LumiThink/pull/33) |
| #28 | R1-V1 Turn Orchestrator / epoch fencing | [#47](https://github.com/lybym/LumiThink/pull/47) |
| #29 | R1-V2 自定义 Cordis Runtime Bridge | [#48](https://github.com/lybym/LumiThink/pull/48) |
| #30 | R1-V3 小智协议 Adapter 合同与故障注入 | [#49](https://github.com/lybym/LumiThink/pull/49) |

台账说明：#21 与 #28 的 Issue 时间线未自动记录 closing reference（PR body 未使用关闭关键字），但两者均以 `COMPLETED` 关闭，关闭说明/合并 PR 中有对应证据（#21 关闭评论引用 PR #44 的 squash merge SHA 与独立 review 记录；#28 的工作由 PR #47 交付并在 tests/domain/voice/orchestrator.spec.ts 落地为回归）。其余 17 张均由对应 PR 以关闭关键字自动关联。

## 2. 发布 Gate 逐条核验（Epic #11 checklist → 证据）

以下 8 项即 Epic #11"R1 发布 Gate（全部满足才可关闭本 Epic）"清单。"CI 绿"指 main 最近推送（`05eff7d`，2026-10-17）触发的 workflow 全部 success（见 §3）。

| # | Gate（#11 原文摘要） | 交付来源 | 自动化证据（main 上存在且被 CI 执行） |
| --- | --- | --- | --- |
| 1 | Web 多轮文字闭环可演示**情绪支持**与**困难任务启动**双 Skill，可用 Mock、不依赖真实第三方服务 | #17/#23/#24/#19 | `tests/server/e2e-10-child-scenario.spec.ts`（双 Skill 多轮专业场景）、`tests/domain/skills/*.spec.ts`（emotion/homework 执行器+评测 subject）、`tests/server/interaction-endpoint.spec.ts`、`tests/server/turn-client.spec.ts`；CI `r1-release-gate` ④ Web Mock E2E（真实 HTTP） |
| 2 | Input/Tool/Output 三层安全 Gate 自动化验证；儿童高严重度失败 **0**；服务端强制而非 Prompt 自我保证 | #27/#19 | `tests/domain/safety/{input-gate,tool-gate,output-gate,pipeline,crisis,policy,trace}.spec.ts`；CI `r1-release-gate` ① 儿童专业与安全评测（4 套件过真实 harness） |
| 3 | 双 Skill Evidence Card 含来源/适用/禁忌/局限/人工审核/版本，覆盖适用、拒绝、升级、无效多轮 | #25 | `tests/domain/evidence/{card,skill-manifest,registry}.spec.ts`、`tests/domain/skills/{emotion,homework}-eval-subject.spec.ts`；[EVIDENCE_POLICY](./EVIDENCE_POLICY.md)；Evidence Registry 只读加载 + 人工发布门槛 |
| 4 | Persona 稳定：明确 AI 身份、不鼓励排他依赖、不承诺保密/诊断/治疗/代写 | #16 | `tests/domain/persona/{policy,registry,turn,eval-subject}.spec.ts`；[PERSONA](./PERSONA.md)；Persona 版本随每轮可审计 |
| 5 | 最小受控记忆：确认 → 跨 Session 引用 → 更正 → 删除可重现；敏感心理/人格标签禁止自动写入 | #26 | `tests/domain/memory/{schema,service,lifecycle}.spec.ts`、`tests/server/e2e-10-memory-governance.spec.ts`（全环 + 禁止自动沉淀 + 快照恢复不复活已删内容）；ADR-0004 |
| 6 | 监护人鉴权、告知/授权、数据清除/恢复演练、模型外发评审均通过；此前不使用真实儿童数据 | #18/#21/#20 | `tests/domain/guardian/*.spec.ts`、`tests/server/{guardian-endpoint,guardian-wiring,guardian-credentials,data-lifecycle,snapshot-store,runtime-snapshot,gateway-egress-proxy,secrets-registry,audit-rollup}.spec.ts`、`tests/server/e2e-10-guardian-governance.spec.ts`（撤权/记录开关/导出/清除实际生效与未授权拒绝）；CI `r1-release-gate` ⑤ N→N+1→N 升级回滚演练、③ 泄漏扫描；ADR-0003/0005/0006/0008 |
| 7 | Mock 与受审查的真实 Provider 两条执行路径可回归；超时、停用、故障、拒绝有明确行为；日志不含凭据/原始对话/私人信息 | #14（真实档位另见 #52/#53/#55/#56） | `tests/domain/gateway/{request,config,mock-provider,http-provider,budget,gateway,wiring}.spec.ts`、`tests/server/{real-provider-composition,real-asr-composition,real-tts-composition,e2e11-reliability,csp}.spec.ts`（超时清扫/取消洪泛/内容无关审计/CSP）、`tests/domain/voice/adapter/fault-injection.spec.ts`；真实 Provider 默认关、唯一经回环 egress proxy 出网 |
| 8 | 干净 Linux 可部署、CI 可复现、版本固定、安全/隐私/权限失败 fail-closed；R0 35/35 0 SKIP 不回退 | #20/#22/#8 | `tests/deploy/{xiaozhi-deployment,xiaozhi-gateway-bridge}.spec.ts`、`tests/release/{release-gate,release-candidate}.spec.ts`、`tests/env/startup-env.spec.ts`；workflows `r0-zero-skip-gate`（ubuntu+windows 矩阵）/`r1-baseline-gate`（frozen install+typecheck+tests+build+干净环境 boot+health）/`r1-deployment-gate`/`r1-release-gate`（manifest 漂移 fail-closed）；`release/release-manifest.json` 逐项锁版本与 SHA-256 |

R1-V 先导（#28/#29/#30 → PR #47/#48/#49）按 Epic #11 定义**不计入 R1 文本 MVP 发布条件**，已作为技术先导交付，不阻塞本收口；实机语音验收归 R5 / Epic #50（见 §4）。

## 3. 收口时点验证记录（2026-10-17，base = `05eff7d8ec9277545347eb3bb4055bba92b3aab0`）

**CI（main `05eff7d` 推送触发，全部 success）**：`r1-baseline-gate`（frozen install、typecheck、全套测试、build、干净环境 boot+health）、`r1-release-gate`（安全/专业评测、manifest 漂移、泄漏扫描、Web Mock E2E、升级回滚演练）、`r1-deployment-gate`、`e2e-04-xiaozhi-deployment-gate`、`e2e-07-gateway-wiring-gate`。`r0-zero-skip-gate` 因路径过滤未在该推送触发（见下）。

**本地复验（Windows 开发环境，DSH 受限沙箱）**：

- `pnpm typecheck` → 0 错误。
- `pnpm test`（根工程全套）→ **979 tests / 971 pass / 0 fail / 8 skipped**。8 个 skip 全部为语音网关 REAL socket 用例，用例名自带原因：socket 级测试仅 POSIX CI 目标执行（本沙箱禁止开 socket），CI ubuntu 上执行并通过。
- `pnpm test:r0` → 31/6 套件后 **gate BLOCKED，这是受限环境的预期 fail-closed 行为，不是回归**：R0 的 `tests/contracts/sdk.e2e.spec.ts` 与 `tests/security/negative-tool.spec.ts`（即 4 个"曾 SKIP"必测用例）需要以 piped stdio 派生 DSH runtime 子进程；本沙箱按策略禁止 piped-stdio 子进程派生，两套件带明确原因 skip，零 SKIP 门禁按合同**必须 BLOCK 而非放行**（该合同自身由 `tests/gate/report-gate.spec.ts` 与 `negative-tool` 内置探针回归覆盖）。CI 无此限制：`r0-zero-skip-gate` 最近一次 run（`b51ba310`，ubuntu+windows）全绿，37/37/0 SKIP；且 `b51ba310..05eff7d` 之间 `poc/dsh-child/**` 与两个 lockfile **零变化**（仅根 `package.json` 版本行变动，不在 R0 门禁路径过滤内），R0 证据链对当前 main 成立。
- `pnpm build` → 本地受同一 piped-stdio spawn 沙箱边界阻断（Next.js worker spawn `EPERM`），属环境边界而非代码失败；build + 干净环境 boot 由 CI `r1-baseline-gate`（ubuntu）在 main 持续证明，并在本 PR 的 CI 于 PR HEAD 再次执行。
- `pnpm install --frozen-lockfile` 的 postinstall（prisma generate）受同一 spawn 边界阻断，但 `node_modules/.prisma/client` 已生成且与冻结 lockfile 一致，依赖面完整。

**本 PR HEAD（docs-only，收口 PR #75）**：本仓库全部六个门禁 workflow 的触发路径过滤均不含 `docs/**`，docs-only PR 按设计不触发任何门禁检查（先例：docs-only PR [#10](https://github.com/lybym/LumiThink/pull/10) 同样零检查）。收口 PR 的代码内容与 main `05eff7d` 完全一致，因此上列 main 门禁绿记录 + 本地复验即为本收口的验证面；后续任何代码路径变更由对应 PR 的门禁在该新 HEAD 重跑。

## 4. 诚实边界（收口不代领的面）

- 本记录仅覆盖 Epic #11 的 **R1 发布 Gate**（合成数据、Mock/受审真实 Provider 档位）。
- 实机/物理/人工面（真实设备完整演示、AEC/打断 ≥100 轮实测、故障注入矩阵实测、家长端逐项点击、独立验收人六维 Go/No-Go、用户显式发版批准）属于首版产品验收范畴（Epic #50，issues #58–#62，[runbook §11–§15](../deploy/xiaozhi/runbook.md)），**不在本记录范围内**，未执行前不标注任何 PASS。
- 真实儿童数据外发评审保持 `not_performed` 闸门：R1 全程仅合成儿童身份/对话/语音，`third_party_data_egress` 默认关闭；启用真实数据前必须先完成监护人告知/授权与外发评审（ADR-0008、[RELEASE_NOTES §4](./RELEASE_NOTES.md)）。

## 5. 收口动作

- 本记录与 [Roadmap §3](./ROADMAP.md) 收口注随 Feature PR 合并；PR 合并即满足 Epic #11"发布 Gate 全部满足才可关闭本 Epic"的条件，Epic #11 随之关闭（Closes #11）。
- 后续路线见 [Roadmap §4](./ROADMAP.md)（R2 Memory Expansion）；R1-V 先导状态已在 Roadmap §3.5 记录，实机语音交付条件不变（R5）。
