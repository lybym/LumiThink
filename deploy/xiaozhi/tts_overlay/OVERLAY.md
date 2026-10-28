# v0.9.8 TTS 双流覆盖 — 仓库可重建交付（P0-01，issue #79）

> 状态口径：本目录交付的是冻结矩阵 §2 补丁 9 要求的**仓库侧可重建交付**
> （上游夹具、维护测试与安装入口）。**版本选型已决（2026-10-28：v0.9.8 @ `8f2dda09`，
> D1 决定记录见 [docs/reviews/2026-10-28-p0-01-d1-decision-and-matrix-update.md](../../../docs/reviews/2026-10-28-p0-01-d1-decision-and-matrix-update.md)）**；
> 部署侧采纳/重放仍 **PENDING**：迁移与重放验证归 #81，重放仍是运营者显式行为；
> **历史运行结果不自动视为候选验收**。本文不含密钥、原始日志或儿童资料；
> 凭据值一律不入库。依据：[P0-01 冻结矩阵](../../../docs/reviews/2026-10-25-p0-01-source-freeze-matrix.md)、
> [TTS 备份分支集成与部署差异](../../../docs/reviews/2026-10-25-tts-baseline-reconciliation.md)、
> [机器面记录 §2026-10-25](../record-e2e08-machine-face.md)。

## 1. 组成与来源（provenance）

| 部分 | 来源与位置 | 标识 | 状态 |
| --- | --- | --- | --- |
| 运行时覆盖工件（厂商双流模块 + 官方 v0.9.8 重整） | 运营者运行目录/本地备份（2026-10-25 预核对记录） | SHA-256 `471a726c66a46b0bee606e7aa689597f1c75997e2372dbfb58841a03c36a4723`（单一 pin，镜像于 `install_tts_overlay.py::RUNTIME_OVERLAY_SHA256`） | **不入库**（仓库不含任何厂商覆盖文件——既定边界）；重建时由运营者本地提供，安装入口逐字节哈希核对 |
| 上游接口合同（夹具镜像依据） | `core/providers/tts/base.py` @ `27399a2fb64b5910196f438a256ce0a9f868481f`（blob `34b20a626ec5a9d3cb24557a0a665df529401700`）；`core/utils/tts.py::create_instance` 按 type 平铺加载 `core.providers.tts.<type>` 并实例化 `.TTSProvider` | 2026-10-28 逐字核验 | 该文件在 v0.9.7 ↔ v0.9.8 两钉点间**无改动**（2026-10-28 上游 compare 复核），核验对两基线同时成立；仓库 pin 已收敛 v0.9.8（D1 决定） |
| 官方 v0.9.8 重整语义（合同来源） | `core/providers/tts/huoshan_double_stream.py` @ `8f2dda09cf18f1c1ece0f906eee4cc2fabb7fb58`（blob `0e5c7d2e147f80574c0a9cfcc1bddcb0808dfbd1`） | 2026-10-28 核验：`tts_text_priority_thread`（FIRST 重置流状态；TEXT 项经**同一会话** `send_text`；LAST 触发 `finish_session` 且残留前缀先发；abort 走 cancel 路径）；`start_session` 先关闭未结束的激活会话（`activate_session` guard）。**核验范围注记（review P1-1）**：`8f2dda09` 与 v0.9.7 基线 `27399a2f`（2026-10-28 选型决定前的仓库 pin，git 历史可复原）的 FIRST 分支均**无条件调用 `start_session`**（上游为 FIRST 即建会话，无空/无效文本门控）；S1 的懒建+有效性门控语义**不在**任何被钉死上游版本中，仅来自运营侧记录（见 §2 注记） | 语义级来源；本交付仍不代运营者重放 |
| 可执行合同夹具（上游夹具） | 本目录 `tts_dual_stream_contract.py`（脚本化 vendor stub，零外发、零凭据、零音频） | 语义承载 S1–S6：**S2–S5 逐字核验自上游两个被钉版本**；**S1 依运营侧记录重建**（上游不可核验，见 §2 注记） | **已交付**（维护测试锁定） |
| 维护测试 | `tests/deploy/test_tts_overlay_rebuild.py`（stdlib unittest；installer 演练 + 合同断言） | CI：`e2e-07-gateway-wiring-gate.yml` | **已交付** |
| 安装入口 | 本目录 `install_tts_overlay.py` | 哈希钉死、显式 opt-in、备份一次/回滚、确定性 receipt | **已交付**（不接入 bootstrap） |

## 2. 语义合同（维护测试锁定）

- **S1 首个有效文本触发建会话（懒建会话）**：FIRST 项与空/纯空白文本项**不**产生任何会话事件；本回合第一条有效文本打开**恰好一个**会话。
  **来源注记（review P1-1）**：S1 是**运营侧 vendor 覆盖特有语义**——官方 v0.9.8（`8f2dda09`）与 v0.9.7 基线（`27399a2f`）的 `tts_text_priority_thread` 均在 FIRST 分支**无条件 `start_session`**（即 FIRST 携带的首个文本项即建会话、无空文本门控）；本条的懒建+有效性门控仅依据运营侧记录（机器面记录 §2026-10-25「恢复双流会话和首个有效文本触发建会话」）重建，**不可由仓库内上游源码重建核验**。下游消费纪律：**#81** 迁移 diffing 必须把 S1 与 vanilla 上游的差异视为 vendor 覆盖的预期签名（非异常）；**#80** 选型矩阵不得用 S1 的空回合会话开销模型去建模 vanilla v0.9.8（上游在 FIRST 即开会话、LAST 收口，与文本有效性无关）。
- **S2 每轮一个双流会话**：同 `session_id`（native `conn.sentence_id`，逐轮唯一）的后续 TEXT 项全部复用已开会话——v20 逐文本项独立会话在结构上不存在。
- **S3 LAST 收口**：滑动窗口残留前缀先发出，再 `finish_session`（恰好一次）；未建过会话的回合（全程无有效文本）不产生任何会话事件、无 finish。
- **S4 abort = cancel**：打断时 `cancel_session` 取代 `finish_session`；abort/finish 之后的迟到项被过滤，绝不重开会话。
- **S5 `activate_session` guard**：新回合的会话在旧会话仍激活时打开前，先关闭旧会话（close 事件严格先于新 `start_session`）。
- **S6 未决边界**：把本合同重放到部署（采纳官方 v0.9.8 重整）**选型已决**（2026-10-28：v0.9.8，D1 决定记录见文首），但**重放仍是运营者显式行为**——安装入口无确认旗标即拒绝（见 §3）；采纳/重放的迁移验证归 #81。

## 3. 安装入口（显式 opt-in；不接入 bootstrap）

```bash
# 安装（哈希核对 + 显式确认选型已决的重放 + 备份 + receipt）
python3 deploy/xiaozhi/tts_overlay/install_tts_overlay.py \
  --target /opt/xiaozhi-esp32-server \
  --overlay-file <运营者本地备份>/huoshan_double_stream.py \
  --acknowledge-selection-v0.9.8

# 只读核验 / 回滚（无需确认旗标）
python3 deploy/xiaozhi/tts_overlay/install_tts_overlay.py --target <target> --verify-only
python3 deploy/xiaozhi/tts_overlay/install_tts_overlay.py --target <target> --rollback
```

- **哈希钉死**：覆盖工件 SHA-256 必须等于 §1 的 pin；漂移即拒绝（fail-closed，写前核对，任何拒绝不落盘）。
- **opt-in 闸门**：不带 `--acknowledge-selection-v0.9.8` 的安装以退出码 2 拒绝——选型已决（v0.9.8，2026-10-28，D1 决定记录），**重放仍是运营者显式行为**（采纳/迁移验证归 #81）；本入口**永不**接入 `bootstrap.sh`（bootstrap 继续安装钉死基线）。
- **备份一次**：首次安装把被覆盖的原文件复制为 `<dest>.before-overlay`（首个回滚点；后续漂移态不覆盖原备份）。
- **原子写入**：dest/备份/receipt 均经同目录临时文件 + `os.replace` 落盘——半途中断不可能留下截断的目标（review P2-2）。
- **漂移留痕**：覆盖既有内容前把其 SHA-256 打进 stdout，并写入 receipt 的 `replacedSha256` 字段（全新安装为 `null`）——被丢弃的漂移态保持可审计（review P2-3）。
- **确定性 receipt**：`<target>/lumi-tts-overlay-receipt.json`（sort_keys、无时间戳、无绝对路径、**LF 钉死**），记录 `providerType`/`pinnedSha256`/`installedSha256`/`backup`/`replacedSha256`；幂等重装不重写既有 receipt（仅缺失时按当前状态重建）。
- **回滚幂等**：有备份 → 恢复并删除备份与 receipt；全新安装（无原文件）→ 删除已装文件与 receipt；无任何痕迹 → "nothing to roll back"（退出 0）。

## 4. 未验证边界（如实声明）

- 夹具是**记录语义的可执行规格**，不是厂商模块、不是厂商协议行为证据；厂商覆盖工件本身不入库，重建依赖运营者本地备份 + 哈希核对。
- 真实供应商路径、设备发声、长闲置/打断行为与 A2A/实机验收**未执行**；部署侧重放与迁移验证归 #81，P0 Gate 判定归 #82（选型 #80 先行）。
- 本交付对应的仓库钉死基线为 v0.9.8 / `8f2dda09`（2026-10-28 D1 选型决定，单一事实源 `deploy/xiaozhi/version.env`；回滚基线 v0.9.7 / `27399a2f` 可由 git 历史复原）；本目录交付本身不修改任何 gateway-* 档位模板，不切换现有 UDS，不批准正式发布。
