# ADR-0009：真实流式 ASR Provider——钉死小智扩展点接入、瞬态通道衔接与重复 final 去重

> 决策日期：2026-10-17 ｜ 状态：**已采纳（部署配置 + 合成验证范围；实机/真实供应商转写质量未验证）**
> 关联：[Issue #55](https://github.com/lybym/LumiThink/issues/55) · [Issue #51](https://github.com/lybym/LumiThink/issues/51) · [Issue #53](https://github.com/lybym/LumiThink/issues/53) · [Issue #54](https://github.com/lybym/LumiThink/issues/54) · [ADR-007](./0007-asr-transient-text-channel.md) · [ADR-008](./0008-real-provider-egress-topology.md) · [VOICE_GATEWAY_PROTOCOL §2.3](../VOICE_GATEWAY_PROTOCOL.md) · [deploy/xiaozhi/runbook §3.5](../../deploy/xiaozhi/runbook.md) · 父 Epic [#50](https://github.com/lybym/LumiThink/issues/50)

## 背景

E2E-04（Issue #54）交付的小智私有服务端只有 `gateway-minimal` 档位：ASR/LLM/TTS 全部显式指向回环死端口（fail-loud、零外发），音频链路占位拒绝。Issue #55 要求在自建小智服务端接入**至少一个真实 ASR Provider**，使现有 ESP32-S3 的 Opus 音频得到可靠的流式/终稿转写，并复用 ADR-007 的受控明文通道。约束：

- 供应商调用发生在**钉死 commit 的小智服务端内部**（其 `selected_module.ASR` Provider 扩展点）；LumiThink 只经设备 WS 收到 `stt`（`asr_final`）；
- 上游以 INFO 打印"识别文本/识别到文本"（`asr/base.py`、`asr/aliyunbl_stream.py` @ `27399a2f…`）——**默认不得在日志/异常/消息队列保存原始转写**必须由配置达成，且残余如实披露；
- 流式 ASR 引入新失败模式：同一 utterance 的重复 final（端点双发、重连重投递）；
- 真实儿童数据的外发评审未做（沿用 Issue #53 的常量闸门）；CI 不得产生真实供应商出网。

## 决策

1. **供应商路径 = 钉死小智扩展点，LumiThink 不新增供应商客户端。** 首供应商 `AliyunBLStreamASR`（`type: aliyunbl_stream`，阿里云百炼 Paraformer 实时，duplex WebSocket；上游 @ pinned commit 硬编码 `wss://dashscope.aliyuncs.com/api-ws/v1/inference`——该端点是**评审锚点**，pin 变更 = 重跑评审）。上行合同：设备 Opus 16 kHz 单声道 → 服务端解码 PCM 16 kHz（模板 `sample_rate: 16000`/`format: pcm`）；端点检测 = 本地 SileroVAD + 供应商侧 `max_sentence_silence: 200`。新档位 `deploy/xiaozhi/config/gateway-asr-real.yaml`（gateway-minimal 安全骨架 + 仅 ASR 变更；LLM/TTS 回环占位、VLLM ""、Memory/Intent 关闭不变），由 `bootstrap.sh --template` 显式选档，**禁用 = 重渲染缺省档位**。
2. **转写不落盘三闸（模板强制，CI/测试断言）**：`delete_audio: true`（上游不写音频文件）；`read_config_from_api: false`（上游 `reportHandle` 的 ASR/TTS 上报队列**结构性 never enqueue**，转写/音频不进消息队列）；`log_level: WARNING`（INFO 转写日志全部抑制）。**残留（接受并披露）**：WARNING 以上异常路径可能携带供应商侧错误详情（连接/鉴权失败，不含本地转写正文）；上游 loguru 文件 handler `diagnose=True` 为钉死代码，异常堆栈可能含变量值——日志按敏感面对待（journald 权限/轮转）。
3. **激活记录 fail-closed（`lib/server/real-asr-composition.ts`）**：`LUMITHINK_ASR_ROUTE=mock|real`（缺省 mock；CI 显式断言为空）；`real` 要求完整供应商记录——评审锚点端点（必须逐字等于钉死端点，漂移即拒绝）、模型 id、16 kHz 上行合同、端点静音窗口（200..6000 ms）、外发评审记录（reviewer/reason）；问题只列变量名。**Key 不是本模块的输入**：凭据只存在于部署档位渲染期（`XIAOZHI_ASR_API_KEY` → `render_config.py`，0600 产物；secrets-registry 语义同 R1-00），永不进入 LumiThink 运行时环境。
4. **重复 final 窗口化去重（Adapter，v1.2）**：同一设备上一个**已接受** final 的 HMAC 指纹在**有界窗口（默认 2000 ms）**内再次到达且无新话语信号（`listen start`/`detect` 清除记忆）→ 枚举化 no-op（`gateway.asr_duplicate_suppressed` + 计数），不铸造第二个 turn。记忆**跨重连存活**（每设备）：断线后服务端重投递同一 final 不会在新连接上铸造错误轮（DoD"断线/重连无错轮"）。窗口过期后同文本按新话语接受。保守方向的显式接受：2 s 内、无 listen 信号的同文本重复话语被当作同一话语（宁可少执行一次，不可双执行/双播报）。
5. **证据记录内容无关（`buildRealAsrEvidenceRecord`）**：时延（final 事件到达 → 受保护单轮提交完成，ms）、端点/话语窗口计数、final 接受/去重抑制/Gate 拦截计数、零泄漏扫描结果；**供应商置信度不在钉死 commit 的设备线协议上暴露（`stt` 只带文本）**——证据如实标注 `confidence.onWire=false`，绝不合成数值；`childDataEgressReviewStatus` 沿用 `not_performed` 常量。仓库内证据 = 合成流式源驱动真实组合栈（`tests/domain/voice/adapter/real-asr-stream.spec.ts`）；**成人合成/公开测试音频 → 远程 ASR** 的服务器端对照为运营者 opt-in（激活登记 reviewer/reason，证据只留内容无关事实），不是 CI 前提。
6. **CI 零真实出网**：`e2e-04-xiaozhi-deployment-gate.yml` 对真实档位只做解析、缺 key fail-closed 渲染与**合并后有效配置扫描**——**不启动该档位、不连供应商**；boot/行为证据仍属 gateway-minimal 冒烟与运营者 opt-in 运行。

## 备选取舍

| 方案 | 取舍 |
| --- | --- |
| LumiThink 侧直连 ASR 供应商 API（像 E2E-03 的 Model Gateway 那样经回环代理） | 供应商调用本属钉死小智服务端；LumiThink 再建一路 = 第二条不受控外发路径 + 双重转写外发；否决 |
| 修改/替换钉死 commit 的 ASR provider 以接入 LumiThink 网关 | 违背"不改上游、版本钉死"（ADR-002/E2E-04）；否决 |
| 在 gateway-minimal 模板上用 env 开关切换 ASR | "省略 = 禁用不成立"的递归合并语义下，开关放大误配置面；档位文件 + 显式渲染 = 显式评审变更；否决 |
| 指纹去重不设时间窗（同话语指纹永久去重） | 合法重复话语（"是。"两次）会被永久吞掉；窗口化 + listen 信号 + 跨重连存活是可解释的折中；否决永久去重 |
| 证据记录带上"置信度"合成值凑指标 | 线协议结构上不暴露置信度；合成数值违背诚实证据纪律；改为如实标注 `onWire=false`；否决 |

## 约束 / 后果

- 真实供应商转写质量、实机打断/重连/长静音行为**未实机验证**；本决策交付部署配置、fail-closed 门禁、合成回归与内容无关证据合同，实机验收归 #E2E-08。
- 去重窗口（2 s）与"打断后立即同文本重述"场景的保守吞没是**显式接受的产品语义**；若 R5 实机标定显示误吞率不可接受，调 `asrDuplicateWindowMs`（组合层可注入）需重审 ADR-0007/0009。
- `LUMITHINK_ASR_ROUTE=real` 的激活/证据记录当前仅被测试与证据路径消费；生产组合根接线与 E2E-03 同类（ADR-0008"约束/后果"已登记同类任务）——本记录的持有点是部署档位（`gateway-asr-real.yaml`）与评审锚点，而非主应用运行时开关。
- 真实儿童音频外发在专项评审 + 监护人授权完成前**结构上不可用**（常量闸门）；本决策不宣告任何"真实 ASR 实机验收已完成"。
