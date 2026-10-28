# P0-01 源码清单冻结矩阵（issue #79；2026-10-25）

> 关联 Epic：[#78](https://github.com/lybym/LumiThink/issues/78)；上游输入：[TTS 备份分支集成与部署差异预核对](2026-10-25-tts-baseline-reconciliation.md)。
>
> **口径与边界**：本矩阵是 P0-01 的仓库侧收敛记录。部署/实机侧状态**只读取证、如实标注**：
> `MERGED`＝已入库并有测试与 CI 证据；`REPO_FROZEN`＝仓库钉死且机器强制；`RUNTIME_RECORDED`＝仅有运行侧记录，未在仓库核对收敛；
> `PENDING_*`＝未完成（决策/验证/重建交付），均标注负责人与联动任务；**不宣称部署收敛、P0 Gate 或实机验收已通过**。
> 不含密钥、原始日志、儿童资料；供应商仅记录名称与协议形态，凭据值一律不入库。
> 依据：[P0/P1 计划 §P0-01](../P0_P1_PLAN.md)、[整体方案](../A2A_DESIGN.md)、[Task 契约](../TASK_LIFECYCLE.md)。

## 1. 版本矩阵（仓库 pin vs 运行记录）

| 维度 | 仓库侧（冻结值与权威位置） | 运行侧记录 | 状态 | 负责人/联动 |
| --- | --- | --- | --- | --- |
| 自建服务端 | `xinnan-tech/xiaozhi-esp32-server` @ `27399a2fb64b5910196f438a256ce0a9f868481f`（评估 tag `v0.9.7`，非浮动）；单一事实源 [`deploy/xiaozhi/version.env`](../../deploy/xiaozhi/version.env)，与 Adapter 合同 `XIAOZHI_GATEWAY_BASELINE`（`lib/domain/voice/adapter/protocol.ts`）的一致性由 `tests/deploy/xiaozhi-deployment.spec.ts` 机器强制 | 运行记录为 `v0.9.8` / `8f2dda09cf18f1c1ece0f906eee4cc2fabb7fb58`（来源：预核对记录） | **RUNTIME_RECORDED → PENDING_DECISION**：版本选型（v0.9.7 vs v0.9.8）未决；迁移必须一并核对 installer、覆盖注册表、协议扩展点与回滚，不能只改版本号 | #80（选型与兼容矩阵）；#81（迁移与重建）；#82（Gate 汇总） |
| 端侧固件 | `78/xiaozhi-esp32` @ `v2.5.2` / `49b4380b3faa0ceadd28a3e78aaf0f311c46c57e`；测试固件 `v2.5.2_nulllab-ai-vox-v3`（AI-VOX3 机芯盒，只记录不改写）（version.env） | 2026-10-18 串口实测 `2.5.2`、AFE AEC 开启、hello ack 正常（[机器面记录](../../deploy/xiaozhi/record-e2e08-machine-face.md)） | **REPO_FROZEN**（仓库/实机记录一致；正式实机验收仍归 P0 Gate 之后） | #82（Gate）；运营者实机窗口 |
| TTS 供应商与覆盖 | 仓库模板唯一评审路径 `alibl_stream`（阿里云百炼 CosyVoice 双流，[runbook §3.6](../../deploy/xiaozhi/runbook.md)）；仓库**不含**任何厂商覆盖文件；v0.9.8 双流重整的**仓库可重建交付已形成**（[tts_overlay/](../../deploy/xiaozhi/tts_overlay/OVERLAY.md)：上游夹具 + 维护测试 + 哈希钉死安装入口，2026-10-28） | 运行目录另有火山 seed-tts-2.0 双流覆盖模块，SHA-256 `471a726c66a46b0bee606e7aa689597f1c75997e2372dbfb58841a03c36a4723`（该 pin 已被 tts_overlay 安装入口镜像）；其上叠有官方 v0.9.8 TTS 双流重整（见 §2 补丁 9） | **REPO_DELIVERED → 部署采纳 PENDING**：重建链（夹具/测试/安装入口）已入库；部署侧重放与迁移验证未执行（选型未决前不得先行重放）；历史运行结果不能自动视为候选验收 | #81（重放/迁移）；#80（版本选型先行） |
| 运行配置来源 | 仓库侧权威：`version.env`（版本）、`render_config.py` + `config/gateway-*.yaml` 模板（配置形状）、`env/*.example`（凭据 shapes only，值不入库）、[runbook](../../deploy/xiaozhi/runbook.md)（操作合同） | launcher 实际在 `data/lumithink-runtime/lumithink` 启动；`gateway.env` 单引号 + LF、BINDINGS 用容器路径；密钥/令牌仅宿主侧文件与进程 env；运行目录顶层同名备用 `gateway-host.ts` / `real-agent-port.ts` **不是**执行代码权威（勿与仓库 `scripts/xiaozhi/gateway-host.ts` 混淆） | **RUNTIME_RECORDED**：选定文件的路径与哈希清单保存在本地备份（见 §5），仓库侧未重放核对 | #81（隔离目录重建核对） |
| 服务端运行时/工具链 | Python 3.10（version.env）；Node 24.x / pnpm 10.34.7 锁定（package.json；本机 Node 24.22.1 未升锁文件） | CI 锁定 Node 24.21.0 / pnpm 10.34.7（预核对记录） | **REPO_FROZEN**（一致性已核对） | — |
| 安装与回滚 | 仓库侧 `bootstrap.sh`（钉死安装、fail-closed）+ [runbook §8 回滚](../../deploy/xiaozhi/runbook.md)；v0.9.7 基线安装器语义已评审 | v0.9.8 运行目录的安装器、覆盖注册表与回滚路径未核对 | **PENDING_VERIFICATION** | #81（重建与回滚演练）；#82（Gate） |

## 2. 源码/补丁去向矩阵（10 月 24–25 日 TTS、hello 与 Worker 补丁）

**入库通道**：本地原 TTS HEAD `e6a58130…` 与原 PR #76 HEAD `038ea58f…` 同 tree（`d79bfc33…`）；未提交成果保存为备份提交 `3ea17ee…`，经修订与安全修复整合后以 **PR #94** 正式集成（`59a6649` 调合 → `83b22dd` 保序 → `c889dc9` 收口 → `8d7786d` 文档修正），merge commit `eb3c6db8c7f8e9c2921b6349f15c2fbcea5dd851`，CI 14/14 @ `8d7786d`。

| # | 补丁 | 仓库去向 | 证据 | 部署侧状态 | 负责人/联动 |
| --- | --- | --- | --- | --- | --- |
| 1 | 桥接正文单一入队方（Provider 只 yield 准入正文；小智原生 chat 管理 FIRST/TEXT/LAST） | **MERGED**（PR #94） | 预核对记录 §进入仓库的有效改动；桥接回归（本地 23 项之 3 项） | 运行目录仍为旧逐文本项实现，迁移采纳 PENDING | #81 |
| 2 | 有界取消检查和交付统计（等待中可退出；播放统计完成前保留 gateway turn） | **MERGED**（PR #94） | 同上 | 迁移采纳 PENDING | #81 |
| 3 | Worker 启动握手（create/followup 等 ready；独立启动超时；停止验证保留短截止） | **MERGED**（PR #94） | `poc/dsh-child/tests/bridge/worker-ready.spec.ts`；Worker 启动/失败/空闲回收 10 项本地验证 | 迁移采纳 PENDING | #81 |
| 4 | 真实模型出口接线（默认 Mock；真实供应商需显式激活 + 预算 + 数据外发门禁） | **MERGED**（PR #94） | `tests/server/gateway-model-route.spec.ts` 等既有回归 | 部署已按 real 档运行（2026-10-18 机器面）；配置一致性核对 PENDING | #81 |
| 5 | 网关致命异常退出（停止接入、清理资源、5 秒截止非零退出交 supervisor 重启） | **MERGED**（PR #94，`c889dc9`） | `lib/server/gateway-host-shutdown.ts` + `tests/server/gateway-host-shutdown.spec.ts`；网关进程退出 6 项本地验证 | 运行目录未采纳；**现网迁移需独立验证** | #81 |
| 6 | 日志最小化（致命异常只记固定原因；不打印异常正文/堆栈/控制回复/Worker stderr 正文） | **MERGED**（PR #94） | 同上（子进程错误带合成私人标记的泄漏断言） | 运行目录未采纳；迁移验证 PENDING | #81 |
| 7 | 有限空闲回收（120 s 默认限额；排除启动中/控制请求中/活动执行；quarantine 通知 Bridge，允许同逻辑会话重建） | **MERGED**（PR #94，`c889dc9`） | 空闲回收验证（重建成功且不杀静默活动轮次） | 部署仍关闭回收（Infinity）；**统一配置决策 PENDING**：需先验证部署侧长闲置、容量与多用户行为 | #81（验证）；#82（Gate 判定） |
| 8 | Bridge 重注册补丁（部署侧独有：保存 hello 参数，`connection_unknown` 时重注册、重试一次） | **未入库** | 仅运行侧记录；四要素（凭据、会话归属、重复网关重启、幂等重试）**未验证** | **PENDING_VERIFICATION**：验证通过前不得并入统一实现 | #81（隔离环境先行验证）；运营者提供部署侧补丁证据 |
| 9 | 官方 v0.9.8 TTS 双流重整（部署侧独有：恢复双流会话 + 首个有效文本触发建会话，取代 v20 逐文本项独立会话） | **REPO_DELIVERED（2026-10-28）**：可重建交付入库 [deploy/xiaozhi/tts_overlay/](../../deploy/xiaozhi/tts_overlay/OVERLAY.md)——上游合同夹具（对官方 v0.9.8 源码逐字核验后重建的可执行规格）+ 维护测试（`tests/deploy/test_tts_overlay_rebuild.py`，CI 接入 e2e-07 gate）+ 哈希钉死显式 opt-in 安装入口（备份一次/回滚/确定性 receipt）；厂商覆盖工件本身仍不入库 | 运行目录重整记录（[机器面记录 §2026-10-25 基线整理说明](../../deploy/xiaozhi/record-e2e08-machine-face.md)）；18 项维护测试本地通过 | **PENDING_ADOPTION**：部署侧重放/迁移未执行；版本选型未决前不得先行重放（安装入口默认拒绝，需显式确认） | #81（重放/迁移）；#80（版本选型先行） |

> 补丁 1–7 的本地验证基线：23 项针对性验证（桥接 3、部署合同 4、Worker 启动/失败/空闲回收 10、网关进程退出 6）+ 根回归 980 PASS / 0 FAIL / 8 SKIP（POSIX 场景由 Linux CI 覆盖）+ TypeScript 检查；均为脚本 Worker 与合成供应商证据，**不代表真实儿童数据、语音设备或 A2A 验收**。

## 3. 已知偏差台账（含 P0 Gate 阻断判定）

| 编号 | 偏差 | 现状 | 判定 | 联动 |
| --- | --- | --- | --- | --- |
| D1 | 仓库 pin v0.9.7 vs 运行记录 v0.9.8 | 选型未决 | **影响复现 → 阻断 P0 Gate** 直至选型与迁移收敛 | #80 → #81 → #82 |
| D2 | 部署 Worker 关闭回收 vs 仓库有限回收 | 配置分裂 | **影响复现 → 阻断 P0 Gate** 直至统一配置并留长闲置恢复证据 | #81、#82 |
| D3 | Bridge 重注册补丁未验证（补丁 8） | 仅部署侧 | **影响 hello 恢复路径复现 → 阻断 P0 Gate** 直至四要素验证 | #81 |
| D4 | 运行目录未采纳致命异常退出/日志最小化（补丁 5/6） | 现网行为与仓库语义不一致 | 迁移验证 PENDING；未收敛前不得宣称基线一致 | #81 |
| D5 | v0.9.8 TTS 重整无仓库可重建交付（补丁 9） | 重建链已形成（2026-10-28：[tts_overlay/](../../deploy/xiaozhi/tts_overlay/OVERLAY.md) 夹具/维护测试/安装入口入库）；部署侧采纳与重放未执行 | 仓库侧缺口已关闭；**部署侧重放未收敛前仍阻断 P0 Gate**（选型 #80 → 迁移 #81 → Gate #82） | #81、#80 |
| D6 | `sentence_start` 拓扑偏差（真实双流路径不外显逐句 DTO；CI stub 保持完整契约） | 已记录（机器面记录） | 不阻断本轮；历史验证只适用当时版本 | E2E-09/§14 加固 |
| D7 | teardown 重叠限制（探针超时拆除后残留供应商会话可撞并发限额） | 批次 #6 以 45 s settle 规避 | 归打断可靠性加固，不阻断本轮 | E2E-09/§14 |
| D8 | 同 API Key 的 ASR/TTS 并发实验不覆盖高并发与长时配额 | 局限已记录（v20 节） | 诚实局限，P1-09 资源项另行测量 | #87 以后的 P1-09 |
| D9 | "厂商强制 ONE-SHOT" 旧结论 | 已被 v20 节推翻（非已证明协议事实） | 不得引用为当前实现或厂商协议结论 | — |

## 4. hello 异常与当前可用状态（三态复核）

| 口径 | 状态 | 证据 |
| --- | --- | --- |
| **历史跑通**（已留证） | hello/abort 协议面在 CI 与 2026-10-18 实机机器面通过 | E2E-04 CI deployment smoke（`probe_hello` hello/abort，[runbook §5](../../deploy/xiaozhi/runbook.md)）；E2E-07 CI 接线环（hello→session→loop）；E2E-08 机器面：LAN OTA 桥 hello ack（含 session_id）、批次 #6 3/3 轮干净、LANE-1 GREEN（[机器面记录](../../deploy/xiaozhi/record-e2e08-machine-face.md)） |
| **当次冒烟**（2026-10-25 本轮） | 通过，但**仅脚本/合成口径** | PR #94：23 项本地针对性验证 + 根回归 980 PASS + TypeScript 检查；CI 14/14 @ `8d7786d`。模拟设备协议探针、脚本 Worker、合成供应商——非真实设备/真实模型冒烟 |
| **正式实机验收** | **未执行** | 待运营者物理面：[runbook §11.3 步 4](../../deploy/xiaozhi/runbook.md)（3×断电重连）与 §11.4（唤醒 + 10 轮成人语音逐轮记录）；受 P0 Gate #82 约束，不因文档/CI/代码合并宣称通过 |

**hello 异常专项**：当前唯一未收敛的 hello 相关偏差是部署侧 Bridge 重注册补丁（§2 补丁 8）——保存 hello 参数、`connection_unknown` 时重注册并重试一次；其凭据语义、会话归属、重复网关重启与幂等重试四要素未经验证，**不能据此统一实现**。仓库侧语义保持 fail-closed：hello 未注册 → 模型调用拒绝（patch 1/5 + `gateway_bridge/lumithink_llm.py`）；网关传输不可用 → 告警且本轮 fail closed，不回退内置 LLM。

## 5. PR #76 处置记录（不因本任务视为已批准）

- **处置：CLOSED（已由 #94 替代）**。#76 快进追加的待审阅 TTS/Worker 修复**未**经其自身正式 Review 合并。
- 其内容经备份分支 `3ea17ee` → 修订与安全修复 → **PR #94 正式集成路径**承接：正式 Review + CI 14/14 @ `8d7786d` + merge commit `eb3c6db…`。
- 有效性判定以 #94 的 review 结论与测试为准；#76 自身不获得"已批准"效力。备份与候选完整历史保留于 main；原始文件另有本地 Git bundle 恢复包（`C:/CODE/_backups/LumiThink/20261025-branch-cleanup/`，含 SHA-256 清单与补丁；该本地路径不入库、不提交其中原始材料）。

## 6. 运行 Profile / 供应商 / 数据路径脱敏摘要（Issue 范围项）

- **档位**：`gateway-minimal`（缺省，明确禁用语义）/ `gateway-asr-real` / `gateway-tts-real` / `gateway-bridge`（`auth.enabled=true`，OTA HMAC token）；网关宿主 agent 运行时 `LUMITHINK_GATEWAY_AGENT=synthetic`（CI 证据）| `real`（运营者 opt-in，锁定版 DSH worker 子进程）。
- **供应商**：仓库模板唯一评审路径为阿里云百炼 CosyVoice 双流 TTS（`alibl_stream`，WSS 推理端点为外发评审锚点）；运行侧另有火山 seed-tts-2.0 双流覆盖（哈希见 §1）与 Anthropic 兼容端点形态记录。凭据值不入库、不进本矩阵。
- **数据路径（脱敏）**：运行 launcher `data/lumithink-runtime/lumithink`；本地证据目录（E2E-08 证据与 TTS 恢复记录）与本地备份目录仅存于运营者主机，不入库；原始串口/音频/密钥永不进 Git（机器面记录口径）。
- **复用与边界**：复用 #51–#58 既有实现与验收记录（E2E-04 #54 版本钉死、E2E-07 #57 补丁登记、E2E-08 #58 机器面证据仅作输入）；不混入未审阅改动，不把测试 Profile 当正式学习业务。

## 7. 本矩阵的覆盖声明

- **仓库侧已完成**：版本矩阵、补丁去向矩阵、偏差台账、hello 三态复核、PR #76 处置记录（本文档）；备份分支集成与生命周期加固（PR #94）；v0.9.8 TTS 双流重整的仓库可重建交付（2026-10-28：[tts_overlay/](../../deploy/xiaozhi/tts_overlay/OVERLAY.md) 上游夹具 + 维护测试 + 显式 opt-in 安装入口，补丁 9 的 D5 仓库侧缺口关闭）。
- **PENDING（不得宣称完成）**：版本选型与迁移（#80/#81）、部署侧采纳 v0.9.8 TTS 重整与重放验证（#81，选型 #80 先行；tts_overlay 安装入口默认拒绝静默重放）、部署 Worker 回收统一配置（#81）、Bridge 重注册验证（#81）、运行目录采纳致命退出/日志最小化（#81）、隔离重建与回滚演练（#81）、P0 Gate 判定（#82）。
- 每项 PENDING 均标注负责人联动；影响复现的未解决偏差（D1–D3、D5）在收敛前**阻断 P0 Gate**。本任务不批准正式发布，不切换现有 UDS。
