# P0-01 D1 版本选型决定与部署差异矩阵更新（issue #79；2026-10-28）

> 关联：Epic [#78](https://github.com/lybym/LumiThink/issues/78)；[P0-01 冻结矩阵（2026-10-25）](2026-10-25-p0-01-source-freeze-matrix.md)；[TTS 可重建交付（tts_overlay/，2026-10-28）](../../deploy/xiaozhi/tts_overlay/OVERLAY.md)。
>
> **口径与边界**：本文记录 **D1 版本选型的仓库侧收敛决定**（Feature PR：`feature/p0-01-d1-version-selection`，`Refs #79`）与五项部署差异（D1–D5）的当日状态，并对 P0 Gate（#82）维度 B 做再评估。**不宣称部署收敛、P0 Gate 或实机验收通过**；运行目录（`C:\CODE\lumithink-data\**`）只读取证，本 PR 不修改任何运行文件、不切换 UDS；不含密钥、原始日志或儿童资料，公开内容全部为合成数据或结构化事实。
> 依据：[P0/P1 计划 §P0-01](../P0_P1_PLAN.md)、[VOICE_GATEWAY_PROTOCOL §1/§3](../VOICE_GATEWAY_PROTOCOL.md)（§3 已补 2026-10-28 复评条目）、[Task 契约](../TASK_LIFECYCLE.md)。

## 1. D1 选型决定（2026-10-28）

**决定**：自建服务端基线收敛至官方 `xinnan-tech/xiaozhi-esp32-server` tag **`v0.9.8`** @ commit `8f2dda09cf18f1c1ece0f906eee4cc2fabb7fb58`。回滚基线 = v0.9.7 @ `27399a2fb64b5910196f438a256ce0a9f868481f`（git 历史可复原；runbook §8 版本回滚口径不变）。

单一事实源 [`deploy/xiaozhi/version.env`](../../deploy/xiaozhi/version.env) 已更新；`XIAOZHI_GATEWAY_BASELINE`（`lib/domain/voice/adapter/protocol.ts`）同步收敛，一致性由 `tests/deploy/xiaozhi-deployment.spec.ts` 机器强制。**实机正式验收仍归 P0 Gate（#82）运营者窗口；`deviceVerified: false` 维持。**

### 1.1 证据链（选型依据）

1. **运行侧基线记录**：运行宿主镜像覆盖记录（`overrides/README.md`）载明官方基线 = `xinnan-tech/xiaozhi-esp32-server` tag `v0.9.8` @ `8f2dda09`；`helloHandle.py` 含官方 v0.9.8 唤醒音频修复；`huoshan_double_stream.py` 为官方双流重整 + 运营侧语义（首个有效文本建会话，S1）。运行记录自 2026-10-25 起即为 v0.9.8（[预核对记录](2026-10-25-tts-baseline-reconciliation.md)、[机器面记录 §2026-10-25 基线整理说明](../../deploy/xiaozhi/record-e2e08-machine-face.md)）。
2. **运行时 TTS 覆盖工件哈希**：`overrides/huoshan_double_stream.py` 实测 SHA-256 = `471a726c66a46b0bee606e7aa689597f1c75997e2372dbfb58841a03c36a4723`，与仓库 `deploy/xiaozhi/tts_overlay/install_tts_overlay.py::RUNTIME_OVERLAY_SHA256` pin **完全一致**（2026-10-28 复核）——运行工件与仓库 pin 的对应关系当日仍成立。
3. **上游 requirements.txt 差异**（v0.9.7 `27399a2f` → v0.9.8 `8f2dda09`，经 `gh api` 核对原文）：`aiohttp 3.13.2→3.14.5`、`requests 2.32.5→2.34.2`、`cnlunar 0.2.4→0.2.5`、`markitdown 0.1.3→0.1.8`、`mcp 1.22.0→2.3.0`（主版本升级，见 §1.3 风险注记）、`PyJWT 2.10.1→2.15.1`、`psutil 7.1.3→7.2.2`、`edge_tts 7.2.8→7.3.1`、`dashscope 1.25.2→1.27.7`、`ormsgpack 1.12.0→1.12.2`、`google-generativeai 0.8.5→0.8.6`；上游 v0.9.8 起将 `Jinja2==3.1.6` 直接列入 requirements（本仓库相应从"部署补齐"移入上游 pin 段）。`silero_vad/funasr/transformers/modelscope/sherpa_onnx/mem0ai/powermem` 等重量级模型栈**继续排除**（维持"上游子集"纪律）。
4. **仓库侧重建交付已在 PR #110 入库**（`deploy/xiaozhi/tts_overlay/`：上游合同夹具 + 维护测试 `tests/deploy/test_tts_overlay_rebuild.py` + 哈希钉死显式 opt-in 安装入口）；其 opt-in 闸门语义随本 PR 更新为"选型已决、重放仍是运营者显式行为"（§2 D5）。
5. **2026-10-25 机器面记录**（[record-e2e08-machine-face.md](../../deploy/xiaozhi/record-e2e08-machine-face.md)）：v0.9.8 运行下批次 #6 3/3 轮干净（每轮 `stt_echo=1`+`audio_frames>0`+`tts_stop=1`）、LANE-1 GREEN、abort-fence PASS；v0.9.8 重整回归套件在运行侧 `deploy/tests/overrides_v098/` 留有记录。**历史运行结果不自动视为候选验收**（口径不变）。
6. **本 PR 仓库侧一致性收敛 diff**（见 §1.2）：version.env / Adapter 基线常量 / requirements 子集 / 档位模板与 runbook 引用 / fork patch 锚点复核 / 测试同步。

### 1.2 换基线机器核验（runbook §1"升级 = 换基线"纪律）

| 核验项 | 结果（2026-10-28，本 PR） |
| --- | --- |
| `XIAOZHI_GATEWAY_BASELINE` ↔ `version.env` | 动态一致性断言保持（`tests/deploy/xiaozhi-deployment.spec.ts`；commit/tag 双向核对） |
| `requirements-gateway-minimal.txt` 子集 | 按上游 v0.9.8 `main/xiaozhi-server/requirements.txt` **原文**重排 §1.1 第 3 条所列 11 个 pin；上游注释语义（websockets<15.0.0、portalocker 3.x 约束）原样保留 |
| fork patch 锚点（5/5） | 对 `8f2dda09` 上游原文逐字复核：`abortHandle.py`、`sendAudioHandle.py`、`connection.py`、`aliyunbl_stream.py`、`alibl_endpoint.py`、`alibl_stream.py`、`tts/base.py` 在 v0.9.7→v0.9.8 间**无改动**（上游 compare 文件清单核对）；唯一改动的 `helloHandle.py`（官方唤醒音频修复）内锚点 `await conn.websocket.send(json.dumps(conn.welcome_msg))` 仍逐字存活（[fork-patches.md 复核注记](../../deploy/xiaozhi/fork-patches.md)） |
| 评审锚点端点 | `wss://dashscope.aliyuncs.com/api-ws/v1/inference`（ASR 硬编码）与 `.../inference/`（TTS 默认值，含尾斜杠）未变（上游文件无改动） |
| gateway-* 档位模板 | 仅头注释引用的钉版本号同步（`8f2dda09…`）；模板活跃面形状零改动（既有机械 diff 断言保持绿） |

### 1.3 风险注记（如实披露）

- `mcp 1.22.0 → 2.3.0` 为**主版本升级**（上游原文如此）：本档位不选中 MCP 依赖 Provider，但 e2e-04 部署门会在干净环境对新 pin 做安装/启动冒烟——若启动可达导入链需要补 pin，按仓库纪律对照上游 requirements 补最小集并在 PR 记录。
- 上游 v0.9.8 同时改动了 `core/providers/tts/edge.py`、`core/utils/util.py`、`config/logger.py`、`server_mcp/mcp_client.py`（compare 文件清单）：`edge.py` 属未选中 Provider（懒加载）；`logger.py`/`util.py` 若有行为变化由 CI 冒烟承担首验，本文不预判。
- D1 收敛只解决**仓库侧**一致性；部署侧重放/迁移（§2）未执行前，"影响复现 → 阻断 P0 Gate"的判定对部署侧成分仍然成立。

## 2. 部署差异矩阵更新（D1–D5，2026-10-28 状态）

> 与[冻结矩阵 §3](2026-10-25-p0-01-source-freeze-matrix.md) 的增量对账：D1 仓库侧状态更新见冻结矩阵 §1/§3 对应行；本表为五项偏差的当日完整快照。**运行目录只读取证，以下"运行副本"结论均为结构化事实核对，不含原始日志/正文。**

| 编号 | 偏差 | 2026-10-28 状态 | 阻断判定 | 负责人/联动 |
| --- | --- | --- | --- | --- |
| **D1** | 仓库 pin vs 运行记录版本分裂 | **仓库侧 CONVERGED（本 PR）**：选型已决 v0.9.8 @ `8f2dda09`，version.env / Adapter 基线 / requirements / 锚点一致性入库并机器强制；**运行侧重放/迁移 PENDING**（部署副本尚未按新 pin 重建） | 仓库侧阻断解除；**部署侧重放/迁移收敛前仍阻断 P0 Gate** | #81（迁移与重建）；#82（Gate） |
| **D2** | 部署 Worker 关闭回收 vs 仓库有限回收（PR #94 补丁 7） | 运行副本**无回收实现**（部署侧回收保持关闭）；**待运行侧统一配置证据**：长闲置恢复、容量与多用户行为未测 | **仍阻断 P0 Gate**（统一配置 + 恢复证据缺失） | #81（验证）；#82（Gate 判定） |
| **D3** | Bridge 重注册补丁（部署侧独有，冻结矩阵 §2 补丁 8） | 补丁已定位：运行副本 `overrides/lumithink/lumithink.py:421` 附近——`announce_args` 保存（hello 参数留存）/ `connection_unknown` 时重注册 / `_reannounced` 幂等一次；四要素（凭据语义、会话归属、重复网关重启、幂等重试）**行为验证 BLOCKED-运营者**（需运营者窗口/隔离环境） | **仍阻断 P0 Gate**（验证通过前不得并入统一实现） | #81（隔离环境先行验证）；运营者 |
| **D4** | 运行目录未采纳网关致命异常退出/日志最小化（PR #94 补丁 5/6） | 运行副本**确认未采纳**：无 `lib/server/gateway-host-shutdown.ts`；运行侧 `gateway-host.ts` 与仓库版本哈希不一致 → **迁移验证 PENDING** | **仍阻断 P0 Gate**（现网行为与仓库语义不一致；未收敛前不得宣称基线一致） | #81 |
| **D5** | v0.9.8 TTS 重整的仓库可重建交付（冻结矩阵 §2 补丁 9） | 重建链已入库（PR #110）；运行工件哈希与 pin **一致**（§1.1 第 2 条，2026-10-28 复核）；**部署侧重放 PENDING**——opt-in 闸门已随本 PR 更新为"选型已决（v0.9.8，2026-10-28）"，重放仍是运营者显式行为（`--acknowledge-selection-v0.9.8`） | 仓库侧缺口已关闭；**重放/迁移收敛前仍阻断 P0 Gate** | #81（重放/迁移）；#82（Gate） |

## 3. P0 Gate（#82）维度 B 再评估

**结论：仍 NO-GO（2026-10-28）。** 依据：

- D1 仓库侧收敛消除了"版本选型未决"这一复现阻断的**仓库侧成分**；但维度 B（部署差异收敛）依赖的运行侧迁移/验证——D1 部署副本重建与重放、D2 统一配置与长闲置证据、D3 四要素行为验证、D4 致命退出/日志最小化迁移——**均未执行**。
- 实机正式验收（三态复核之"正式实机验收"态）仍属运营者物理面（runbook §11.3 步 4 / §11.4），未执行项不标 PASS。
- Gate 判定权归 #82；本文与冻结矩阵均不代领、不宣称通过。D1–D5 中任一部署侧成分收敛前，维度 B 维持 NO-GO。

## 4. 运营者可执行命令清单（含预期结果与证据要求）

> 纪律：**不提供任何密钥/令牌值、不含儿童资料、不粘贴原始日志正文**；证据只保留命令、退出码、哈希、计数与内容无关时延。以下命令在部署宿主/运营者窗口执行；`/opt/xiaozhi-esp32-server` 为 runbook §2 部署路径（运营者笔记本容器拓扑按实际 target 替换）。

| # | 目的 | 命令（部署宿主） | 预期结果 | 证据留存要求 |
| --- | --- | --- | --- | --- |
| 1 | 确认部署副本当前 pin（D1 现状） | `git -C /opt/xiaozhi-esp32-server rev-parse HEAD` | 重建前如实记录（当前可能仍为旧基线）；重建后应为 `8f2dda09cf18f1c1ece0f906eee4cc2fabb7fb58` | 输出 SHA 原样 + 日期 |
| 2 | 按 v0.9.8 重建部署面（D1 迁移第一步，#81） | `sudo env "PATH=$PATH" bash deploy/xiaozhi/bootstrap.sh --target /opt/xiaozhi-esp32-server --env-file /etc/xiaozhi/xiaozhi.env`（env 文件为运营者既有本地文件，值不入证据） | 钉死检出 `8f2dda09` + venv + gateway-minimal 渲染成功，无 fail-closed 拒绝 | bootstrap 终态行 + 渲染成功摘要（不含 env 值） |
| 3 | 健康与协议面冒烟（D1 重建后） | `sudo XIAOZHI_AUTH_KEY="$(sudo grep -oP '(?<=^XIAOZHI_AUTH_KEY=).*' /etc/xiaozhi/xiaozhi.env)" deploy/xiaozhi/healthcheck.sh` | OTA 200 + 回环绑定断言 + hello/abort 探针通过 | 终态摘要（**不含 token 值**） |
| 4 | TTS 覆盖重放（D5/D1，显式 opt-in） | `python3 deploy/xiaozhi/tts_overlay/install_tts_overlay.py --target /opt/xiaozhi-esp32-server --overlay-file <运营者本地备份>/huoshan_double_stream.py --acknowledge-selection-v0.9.8` | `installed core/providers/tts/huoshan_double_stream.py (sha256 471a726c…)` + receipt 写入 | stdout + `<target>/lumi-tts-overlay-receipt.json`（无时间戳/无绝对路径）；覆盖文件本身不入库 |
| 5 | 只读核验（重放后随时可跑） | `python3 deploy/xiaozhi/tts_overlay/install_tts_overlay.py --target /opt/xiaozhi-esp32-server --verify-only` | `verify: … hash matches pin`（退出 0） | stdout |
| 6 | 回滚演练（验证回滚点语义） | `python3 deploy/xiaozhi/tts_overlay/install_tts_overlay.py --target /opt/xiaozhi-esp32-server --rollback`，随后重复 #5 | 回滚幂等（退出 0）；回滚后 verify 失败（未安装）为**预期** | stdout 两段 |
| 7 | D2 统一配置证据（运营者窗口） | 比对运行副本 Worker 回收限额与仓库默认（120 s 有限回收）的差异；随后在**非生产窗口**做 ≥120 s 长闲置恢复试验 | 如实记录现值（预期为关闭/无限）与试验结果（闲置后新请求可服务、Bridge quarantine 通知可见、活动任务不受影响） | 配置项名 + 现值（脱敏）+ 试验计数/时延 |
| 8 | D3 补丁证据导出（四要素验证前置） | 对运行副本 `overrides/lumithink/lumithink.py` 计算 SHA-256，并导出 421 行附近补丁形态的**结构化摘要**（announce_args 保存 / connection_unknown 重注册 / `_reannounced` 幂等一次——不贴原始代码正文） | 哈希 + 行号 + 三要素行为摘要 | 哈希原样 + 摘要；四要素行为验证按 #81 隔离环境计划执行 |
| 9 | D4 迁移差异确认 | `ls /opt/…/lib/server/gateway-host-shutdown.ts`（运行副本对应路径）；对运行侧与仓库 `gateway-host.ts` 各算一次 SHA-256 并比对 | 运行副本无该文件、哈希不一致（与本记录 §2 D4 结论一致）；迁移采纳后翻转 | 两个哈希值 + 文件存在性结论 |
| 10 | 实机正式验收（Gate 物理面，未执行不标 PASS） | runbook §11.3 步 4（3×断电重连）+ §11.4（唤醒 + 10 轮成人语音逐轮记录） | 待运营者执行 | 逐轮记录（触发方式/成败/时延/异常），内容脱敏 |

## 5. 本记录的边界

- 本记录随 Feature PR（`feature/p0-01-d1-version-selection`，`Refs #79`）提交；正式 Review 由 sequential-issues Step 04 独立执行，本文不预支 Review 结论。
- 历史评审记录（2026-10-25 系列）**不改写**；冻结矩阵的 D1 相关行状态更新与文末"2026-10-28 D1 收敛更新"小节为**增量**记录。
- 本 PR 不关闭 #79（`Refs` 而非 `Closes`）；P0 Gate 判定归 #82，部署侧迁移归 #81，UDS 不切换，不批准正式发布。
