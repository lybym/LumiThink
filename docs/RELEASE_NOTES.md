# LumiThink 发行说明（Release Notes）

## 2026-10-25 A2A 设计基线更新

设计评审通过（Design GO）。P0/P1 获准开展，协议互通、真实取消、设备验收和部署切换仍受各阶段 Gate 约束。

本次仅发布正式设计与实施计划：单 Agent 家庭多用户 A2A、统一 Task Manager、三项第二轮复评细节和 P0/P1 清单。未升级软件版本、依赖、发布注册表或部署配置。下文 1.0.0-rc.1 属于已有候选记录，不代表 A2A 已实现或已发布。

以 [整体方案](A2A_DESIGN.md)、[Task 契约](TASK_LIFECYCLE.md) 和 [P0/P1 计划](P0_P1_PLAN.md) 为新阶段依据。以下保留既有实现/历史范围说明；冲突处以本节明确的目标约束为准，不能据此宣称代码已完成迁移。

## 既有实现与历史基线


> **v1.0.0-rc.1** ｜ 日期：2026-10-17 ｜ 对应 [Issue #62](https://github.com/lybym/LumiThink/issues/62)（[E2E-12][P0] 首版产品验收门禁）· [RELEASE_GATE](./RELEASE_GATE.md) · [验收注册表](../release/release-candidate.json) · [实机验收 runbook](../deploy/xiaozhi/runbook.md)
>
> 状态：**发布候选（Release Candidate），不是已发布版本**。本串行流程未创建任何 git Tag 或 GitHub Release；Go 判定与用户显式发版批准见 §5 发布纪律。

## 1. 本候选包含什么（冻结的首版产品范围）

| 范围项 | 状态 |
| --- | --- |
| 现有普通麦克风 ESP32-S3 整机（nulllab AI-VOX3 机芯盒） | 冻结纳入 |
| 测试固件 `v2.5.2_nulllab-ai-vox-v3`（官方 v2.5.2 基线 + 官方树内板级） | 冻结纳入 |
| 现有固件 AEC 与播报中打断（设备侧 `CONFIG_USE_DEVICE_AEC` + 服务端 abort 线协议） | 冻结纳入 |
| 私有化小智服务端（钉死 commit，gateway-bridge + 真实 ASR/TTS 档位） | 冻结纳入 |
| 真实 DSH Runtime / LLM / ASR / TTS Provider（经评审档位；凭据仅运营者侧，默认关） | 冻结纳入 |
| 专业 Skill（emotion_support / homework_initiation，Evidence 绑定与受控记忆） | 冻结纳入 |
| 家长 Web（鉴权/授权/导出/清理）与语音端权限联动 | 冻结纳入 |
| XVF3800 / 四麦克风阵列 / 远场阵列 / DSP 板级改版 | **明确排除**（issue 非目标） |
| 真实儿童个人数据参与联调或验收 | **明确排除**（数据红线） |

## 2. 版本与可追溯性

- 应用版本：`package.json` → **1.0.0-rc.1**；`release/release-manifest.json` 的 `app.version` 已随本候选**重新生成并经 PR 评审**（RELEASE_GATE §2 的"再生成 → 人工评审 diff → 提交"确认动作）。
- Manifest 逐项锁定（schema v1.0）：声明工具链（node 24 / pnpm 10.34.7）、评测面（报告 schemaVersion 1.1 + 4 套件 + subject 版本，全部从代码导入）、领域版本（Safety Policy、协议、Persona、Evidence/Skill Registry、Skill Router、Runtime Pipeline、Gateway 协议、Guardian Disclosure）、`@deepseek-ai/*` 精确 pin 与两个 lockfile 的 SHA-256、冻结的 prisma schema SHA-256、六个部署物 SHA-256。
- 仓库无 git tag：版本追溯 = manifest 基线 + per-run 记录中的精确 commit SHA（仅进 CI artifact）+ 各门禁 run URL。

## 3. 验收状态（诚实边界）

- **自动化面已由 CI 证明**（候选注册表 `release/release-candidate.json` 逐条登记，含 gate 与证明文件指针）：真实 DSH 接线环 10 连轮、多轮打断零迟到帧、儿童专业场景与受控记忆全环、监护人治理旅程、Web Mock E2E、升级回滚演练、故障注入回归、泄漏扫描与 manifest 漂移门禁。
- **物理/人工面待实机执行**（runbook §11–§15 的记录表与实验协议）：真实设备完整演示（§15.4）、AEC/打断 ≥100 轮实测（§12.3/§12.4）、故障注入矩阵与 ≥100 轮实测（§14.2/§14.3）、家长端逐项点击（§13.3）、独立验收人 Go/No-Go（§15.5）。**未执行前不标注任何实机 PASS。**
- Go/No-Go 判定：**pending**（六个维度：技术安全、产品体验、隐私/授权、专业 Skill、运维、回退）。

## 4. 已知限制

1. **实机验收未执行**：本候选的全部真实设备项（演示、AEC/打断、可靠性、家长 Web 实机清单）在 runbook §11–§15 协议执行前均为 pending；合成/探针指标只是候选基线，不是 SLA、不冒充实机数值。
2. **硬件范围**：不含 XVF3800/远场阵列/DSP 板级改版；打断交互以现有固件 AEC 实测结果为准，未达冻结门限时按 runbook §12.8 阻止发版或由用户显式决定按键降级。
3. **儿童数据**：`third_party_data_egress` 默认关闭；真实儿童数据外发评审为 `not_performed` 闸门，供应商告知/同意与监护人授权必须先于任何真实儿童试用；正常儿童数据不进排障（合成 `chd_demo_` 语料专用）。
4. **运营边界**：单用户、单 Linux 云服务器、受控进程编排；SQLite 持久化延后（prisma schema 冻结）；快照格式 `lumithink.runtime-snapshot/v1` 的升级回滚兼容由演练持续证明。
5. **专业边界**：不作临床诊断/心理治疗、不塑造排他依赖、不承诺保密；证据外推边界 `school_practice_only`。
6. **CI 无法证明的面**（RELEASE_GATE §7）：真实模型供应商出网行为、真实主机运维面、人工审批的实际执行、artifact 存储配额类基础设施失败。

## 5. 发布纪律（不可绕过）

1. 全套自动化门禁在候选 SHA 全绿（R0/R1/Voice/E2E 各 gate 互不覆盖、同时绿）；
2. 实机验收按 runbook §11–§15 执行留证，物理面逐项 recorded；
3. 独立验收人六维 Go/No-Go 判定留证——**未通过的必做项不可降级成文字说明后发版**；
4. **用户显式批准**后才能创建首个产品 GitHub Release（`release/release-candidate.json` 的 `release.requiresExplicitUserApproval` 为硬常量，注册表 invariant 由 CI 强制：`release.state=created` 必须同时存在 Go 决定与用户批准记录）；
5. 发布后回退按 deploy/runbook §8 与 RELEASE_GATE Gate 4（回退前确认目标版本能读当前快照）。
