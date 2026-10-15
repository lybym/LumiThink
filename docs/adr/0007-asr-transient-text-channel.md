# ADR-007：ASR 瞬态文本通道（授权明文进受信 Agent，废弃裸 FNV-1a 隐私 pretense）

> 决策日期：2026-10-15 ｜ 状态：**已采纳（合成 POC 范围）**
> 关联：[Issue #51](https://github.com/lybym/LumiThink/issues/51) · [ADR-002](./0002-voice-runtime-bridge.md) · [VOICE_RUNTIME §14](../VOICE_RUNTIME.md) · [VOICE_GATEWAY_PROTOCOL §2.3](../VOICE_GATEWAY_PROTOCOL.md) · 父 Epic [#50](https://github.com/lybym/LumiThink/issues/50)

## 背景

R1-V3 交付的 Voice Gateway Adapter 将 `asr_final` 文本在 Adapter 内即刻降为 **64-bit 裸 FNV-1a 摘要**，仅以该摘要作为 `fingerprint` 进入 `turn.prompt`。这带来两个问题：

1. **摘要不是对话输入**：受信 Agent 只能拿到摘要，无法把儿童的话当作真正的对话内容——E2E MVP（父 Epic #50）需要的"语音说 → Agent 答"闭环无法成立。
2. **伪隐私保障**：对短句而言 FNV-1a 可被字典枚举逆推；把它当作"文本已安全降级"的依据名不副实。同时完全丢弃文本意味着输入层安全（R1-15 Input Safety Gate）在语音路径上没有真实输入可审。

## 决策

建立**授权范围内的瞬态 ASR 明文通道**，并明确其生命周期边界：

1. **贯通路径（每层 fail-closed）**：`asr_final`（≤512 字，协议解析层**整条即拒** `gateway.parse_failed`，不做服务端截断）→ Adapter 调用帧内过**真实 R1-15 Input Safety Gate**（新增 entrance `voice`；`block`/`escalate_crisis` 一律 `input_gate_blocked` 枚举拒绝）→ 可信 Orchestrator 注册（turn_id/epoch 铸造 + 幂等键）→ 组合层**瞬态 prompt vault**（有界 64 条、纯内存、不导出）暂存 QUEUED 轮 → Bridge IPC `turn.prompt`（协议 **v1 → v2**）新增可选有界 `promptText` → 受信 Agent 的 `runPrompt({promptText})` 单轮模型请求。
2. **生命周期与销毁**：明文只存在于受保护单轮调用、必要 IPC 与获批模型请求；vault 条目派发时取用即毁（成功或失败都毁）、fence 取消/Worker 崩溃/终态结算时销毁；丢失条目的轮次派发即 `prompt_text_lost` fail-closed——宁可 FAILED，绝不让摘要冒充模型输入。
3. **去重指纹密钥化**：转写去重指纹改为**HMAC-SHA256**（64 hex），密钥由服务组合层持有：生产 = 进程内 `randomBytes(32)`，不落盘、不打日志、随进程销毁。重启换钥后跨进程重放**不再连续**：幂等键派生自当前密钥下的指纹，换钥后同一转写得到不同指纹与不同幂等键，账本 miss，重放作为**新 turn 重新执行**（与"约束/后果"节一致；`idempotency_conflict` 仅覆盖"同键不同指纹"，不覆盖该场景）。测试重放可显式注入固定密钥（生产禁止）。FNV-1a 仅保留非隐私用途（会话键派生、帧批摘要、重放指纹）。
4. **零泄漏不变量**：明文不入普通日志/审计/快照/错误包/制品；审计只出现枚举码或 64-hex 密钥化摘要；schema 测试断言字段 allow-list，泄漏扫描断言合成标记在全部内容无关表面零出现。
5. **数据外发审批**：本通道不新增授权子系统——外发审批链 = 监护人激活绑定 → hello 持有凭证 → 连接租约/会话映射 → Input Safety Gate → 可信 Orchestrator（epoch/幂等）→ Bridge → 受信 Agent；每一环都是既有已审计的检查点，缺一即 fail-closed。

## 备选取舍

| 方案 | 取舍 |
| --- | --- |
| 维持摘要-only，Agent 以摘要+"最近语音"缓存作输入 | 不满足 E2E 闭环；摘要仍可枚举；否决 |
| 把转写持久化入 Orchestrator 存储并随快照恢复 | 与"明文不入快照/存储"冲突，扩大持久化泄漏面；否决（vault 丢失即 fail-closed FAILED） |
| 在 Adapter 内手写纯 TS HMAC | 域层保持无 node builtins 的约束确实允许，但平台 `node:crypto` 更受审计；选择**注入式**：域层只定义契约，组合层提供 HMAC 实现 |
| 明文走独立旁路进程/队列 | 引入新传输与生命周期所有者，违背 ADR-002 单一所有权；否决 |

## 约束 / 后果

- 转写明文跨 Bridge IPC 是**本决策接受的暴露面**：本地私有 IPC（版本握手 + 鉴权 + 长度/频率限制 + UDS 0600）之内、有界 512 字、单轮消费；R5 实机阶段须复核 IPC 主机边界。
- 密钥随进程销毁意味着**跨重启的幂等重放不再连续**（fail-closed 方向）；对默认 in-memory 存储本就成立，对 SQLite 持久化部署是显式接受的行为变化。
- 真实 DSH 进程接入、实机验证、真实 ASR/模型外发审查均不在本决策范围（R5 门禁不变）；合成证据见 `tests/domain/voice/adapter/transient-channel.spec.ts`。
