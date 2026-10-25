# E2E-08 实机机器面执行记录（issue #58；runbook §11；运营者笔记本拓扑）

> 口径：本文记录 2026-10-18 实机机器面（服务端侧）执行与判定。**真实设备物理面
>（§11.3 步 4 / §11.4）由运营者另行执行留证，未执行项不标 PASS。** Raw 串口/
> 音频/密钥永不入 Git（运营者证据目录 `C:\CODE\lumithink-data\AI-VOX3\`）。

## §11.2 设备侧记录表（串口实测，esptool 硬复位触发全新启动捕获）

| 记录项 | 实测值 | 取得方式 |
| --- | --- | --- |
| 固件版本串 | `Ota: Current version: 2.5.2`（本地重编 v2.5.2_nulllab-ai-vox-v3，构建记录见会话交接） | 串口启动日志（COM4 115200 USB CDC） |
| MAC / 芯片 | `28:84:85:5a:2a:94`；ESP32-S3 QFN56 rev v0.2 | esptool chip_id + 启动日志 |
| ESP-IDF | v6.1（构建方记录；五段哈希校验烧录 2026-10-14） | 构建记录 |
| 麦克风/扬声器/编解码 | 1 mic + 1 playback ref @16 kHz；I2S TX/RX 24 kHz 16-bit mono；Adev_Codec OK | 串口 AFE/I2S 行 |
| AEC 配置 | **AFE 管线实机确认**：`AEC(FD_LOW_COST, NLP_VERY_AGGRESSIVE)`（CONFIG_USE_DEVICE_AEC=y） | 串口 AFE Pipeline 行 |
| 唤醒词 | wn9_nihaoxiaozhi_tts（你好小智） | 串口 |
| 音频协议/Opus 帧时长 | 设备 hello 经 LAN OTA 桥 `http://192.168.1.66:8002` → 容器 OTA :8003（200）；`Activation done`；OTA 响应含 websocket 段（鉴权链路 §11.3 已核实签发） | 串口 + OTA 端点实测 |
| 网络环境 | WiFi RL_HOME_2.4G，设备 IP 192.168.1.79；boot→idle ≈1.8 s | 串口 |

## 机器面判定：GREEN-WITH-RECORDED-DEVIATION（批次 #6，3/3 轮干净）

探针判据（本拓扑口径，CI stub 契约保持不变）：每轮 `stt_echo=1` + `audio_frames>0`
+ `tts_stop=1`；`TTS_SESSION_FAILED` 零新增；`agent fault` 零；网关
`turn.settled finalState=COMPLETED`、`ttsAdmissions` 累计 61、`ttsBlocked=0`、
`deliveryFailures=0`；real 锁定版 DSH worker 存活。批次 #6 实测：r1 252 帧 /
r2 548 帧 / r3 162 帧，全部 tts_stop=1，零新增供应商失败。

## 交付与修复链（批次 #1–#6；PR #76 同分支逐头 SHA 核验）

1. **网关宿主真实模型路由**（E2E-03 契约复用）：`LUMITHINK_MODEL_ROUTE=real` +
   全量激活记录 → `parseRealProviderActivation → buildRealProviderGateway →
   gateway-egress-proxy`（环回）→ `workerEnv.DSH_BRIDGE_MODEL_BASE_URL`；供应商
   凭证仅在宿主侧 keySource 闭包，worker 子进程恒持钉死占位符密钥。
2. **容器接线**（live 容器 §3.7）：五个注册 fork patch 经 `install_bridge.py`
   对容器实际文件逐字锚点应用（镜像与 pin 27399a2 对 auth/ota_handler 哈希相等；
   运营者 connection.py/helloHandle.py 覆盖内锚点恰一次存活，无语义合成）；
   auth.enabled=true（OTA 签发 HMAC token，设备侧安全已核实）；log WARNING。
3. **Lead 修复前向**（批次 #2）：重建命令按 inspect.json 程序化重建（批次的
   PowerShell 逗号优先级产生空参数 + wslc inspect.json 无 HostConfig.PortBindings）；
   gateway.env 单引号 + LF（dash 不吃裸括号/CR）；BINDINGS 用容器路径；探针
   deviceId 语法修正 `aabbccddee07`；`gw-sweep.sh` argv[0] 扫清（容器无 pkill）；
   容器内原生重装（Windows node_modules 携带 `node-addon-require-builtin-
   linux-x64-gnu` 不可用绑定 → `pnpm-install-dsh-child.sh` 冻结锁安装 534 包）。
4. **句子准入反压**：固定 4 s 间隔不足（句子音频长于间隔仍重叠会话 → 火山
   55000000）→ 改为**音频完成反压**：准入 N+1 等待上一句真实 Opus 帧到账
   （0.32 s/字 估速、180 s 封顶、abort 即出）；批次 #4 起零新增供应商失败。
5. **worker 会话 boot-epoch**：`dshSessionId = ${sessionKey}#w${n}e${PORT_BOOT_EPOCH}`
   （每端口进程随机盐）——持久 dshHome 跨网关重启时 `#w<n>` 与 DSH 持久会话
   存储冲突（worker_error "session already exists"），批次 #5 起零 agent fault。
6. **判据演变**：`sentence_pace_min_interval_s`（0=CI 不变）→
   `sentence_pace_audio_s_per_char` 反压；探针 deviceId 语法对齐 CI。

## 如实偏差与已知限制

- **sentence_start 拓扑偏差**：钉死 sendAudioHandle 仅在 TTS 管线携带逐句文本
  DTO（SentenceType.FIRST）时发 `sentence_start`；火山 double-stream 路径在本
  部署不外显（真实音频流内 sentence_starts=0），CI stub 路径保持完整探针契约。
- **teardown 重叠限制**：探针超时拆除（ws 断）后残留供应商会话可与下一轮会话
  撞并发限额（02:06:35/02:08:25/02:09:10 实证）；属钉死 TTS 拆除路径，归
  E2E-09（打断可靠性）/§14 加固；批次 #6 以 45 s 轮间 settle 规避。
- **运营者拓扑**：笔记本容器（非 §2 systemd）；LAN http OTA（NVS 不变）；网关
  宿主容器内 Linux（桥客户端仅 AF_UNIX）；百炼 Anthropic 兼容端点
  （`/apps/anthropic` 形态根）；密钥/令牌仅宿主侧文件 + 进程 env（0600 意图，
  icacls 语法待修：默认 ACL，dev box）。
- **真机物理面**：§11.3 步 4（3×断电重连）与 §11.4（唤醒 + 10 轮成人语音逐轮
  记录、冷启动/重连/再配网/断网恢复）待运营者执行；设备自 00:24Z 起待机属预期。

## 2026-10-18 LANE-1 收口：v8.2 sid-filter 对齐 = 修复链最终解（GREEN）

**判定：LANE-1 GREEN。** 证据：3/3 自定义文本轮真实音频（26/197/212 帧）+
`tts_stop=1` + settled COMPLETED；TASKREQ 时间线显示每轮独立 uuid sid 且
回答文本在 FinishSession 之前提交；abort-fence PASS（stop 生效、零迟到帧）；
`TTS_SESSION_FAILED` 计数全程稳定 18（零供应商失败）；零 agent fault。

**最终一行根因（v8.2）**：监控器的 sid 过滤仍在比较 `conn.sentence_id`，而
线上 sid 自 v4 起已是每轮 vendor uuid —— **供应商的每一帧都被该过滤器静默
丢弃**；对齐到 `_vendor_sid` 后整条管线打开。（`sentence_starts=0` 断言保持
为已记录拓扑偏差。）

### 完整修复叙事（v1→v8.2；每步帧证据；诊断方法论 = 帧级仪表 + 同类独立烟雾对照）
监控竞态（TTS_SESSION_END 后 ws 未清）→ 反向竞态（close 误杀后继连接）→
烟雾语义（移除连接级冗余流事件）→ 每会话新鲜 sid（v4；后被 v5 证明每轮一次
为正确粒度）→ 轮级生命周期 TurnCtx（单连接+单会话/轮、句间零 churn、
pending 门文本提交恢复）→ 监控器 TTS_SESSION_END 兜底竞态（文本队列排空即关）→
监控器重绑定（每连接重 spawn，旧监听阻塞在旧 ws 的 recv 上）→ pending-flush
定时器（2.5s：滑窗确认依赖下一片段到来，轮末短答无后继 → 滞留至 vendor 空闲
超时；**时序策略而非内容放宽**，防合成文本语义零改动）→ **v8.2 sid-filter
对齐（最终解）**。结构性失配（滑窗 × per-call 生命周期 × 轮级语义）由
TurnCtx 单遍重写消除（用户批准；原始模块备份 `.before-fix`，脏态备份
`.before-turnctx`）。

### 运营者侧模块变更清单（用户 V3 覆盖文件 huoshan_double_stream.py；全部有备份）
备份链（backups\e2e08-bridge-20261018\）：.before-fix（原始）→ .before-fix2 →
.before-fix3 → .before-v6 → .before-v7 → .before-v8 → .before-turnctx →
.before-v51/.before-v53/.before-diag2/.before-diag3/.before-framelog（诊断态）。
最终态 = v5.3+TurnCtx+monitor-rebind+v8.2+永久 TTSFRAME 诊断行。变更要点：
监控竞态修复、每轮连接+会话生命周期、conn.loop 执行模型、FinishSession 去重、
供应商 sid 解耦、pending-flush 定时器（2.5s）、sid-filter 对齐、TTSFRAME 永久
诊断。回滚 = 恢复任一备份 + wslc restart。
运营参数：`sentence_pace_min_interval_s=4.0`、`sentence_pace_audio_s_per_char=
0.32`（v5.3 后由 TurnCtx 反压取代）、`turn_timeout_s=900`、`enable_ws_reuse=
False`（用户约束，结构性满足）、auth.enabled=true（OTA HMAC token）。

### LANE-2（进行中）
人声→ASR→LumiThink→TTS→设备：串口捕获 + 服务端日志由 lead 于设备窗口运行；
§11.4 逐轮编译（触发方式/成败/首音时延/端到端时延/异常）随设备窗口后产出。

## 2026-10-18 下午追加：LANE-1 机器面深入修复（v1→v5.3）与结构性失配发现

> 背景：用户重定义验收为双通道——LANE 1（文本→LumiThink→TTS→设备发声，可全自动）
> / LANE 2（人声→ASR→…→设备）。LANE 1 的 text→LumiThink→real-model→sentences
> 半链全程帧证据证明健康（turn.accepted→assistant.delta→tts_sentence→tts_end→
> settled COMPLETED，real worker live）；阻塞集中在服务端 TTS 模块（用户 V3
> 覆盖文件）的会话生命周期。

### 修复链（每步帧证据；备份/回滚纪律全程；批次 #7–#15）
- v1 监控竞态：TTS_SESSION_END 后 `self.ws` 未清 → 后续会话打到已完成流
  （vendor "rpc 13 the stream is done"）→ close+清引用。
- v2 反向竞态：close 在 await 后作用于 self.ws → 可能杀死后继新连接 →
  引用捕获 + `self.ws is ws_done` 判定（保留为正确卫生）。
- v3 烟雾语义：对照 `volc_v3_smoke_test.py`（~100% 成功，同类同凭据）——
  烟雾从不发连接级 StartConnection/FinishConnection → 移除模块中两大额外
  流事件（监控 SessionFinished 分支 + _ensure_connection 重连分支）。
- v4 每会话新鲜 uuid sid：与 conn.sentence_id 解耦（帧证据：同 sid 跨会话被
  vendor 判 done）——后被 v5 证明"每轮一次"才是正确粒度（v4 的每句新开是
  一次错误转向，责任在实现者与指令链，已如实记录）。
- v5/v5.1/v5.3 轮级生命周期：单连接+单会话 per 轮、句间零 churn（H1 续流守卫、
  H2 移除 close-prior、H3 LAST 收口）、文本提交恢复（pending 门吞掉短答）、
  **移除监控器 TTS_SESSION_END 关闭分支**（该分支在文本队列排空即触发，孤儿化
  刚被 TaskRequest 触发的合成——v2–v5 间所有"过早关闭"的真身）。
- 诊断方法论：批 #10v2 帧级仪表（TTSFRAME：连接/收发事件/毫秒偏移，内容无关）
  + 同类独立烟雾对照 → 一次定位机制；批 #12 修复了仪表自身的 f-string 插值缺陷。

### 结构性失配（当前状态；重构提案待用户决策）
v5.3 后仍 audio_frames=0：**滑窗 pending/confirmed 文本流（儿童保护，不可削弱）×
上游 base 的 per-call 连接生命周期（全 pending 短句的连接在 confirmed 前已死）×
轮级会话语义** 三者互斥。重构提案（TurnCtx：轮作用域连接跨
pending→confirmed→submitted→audio-drained 存活；收口=供应商 SessionFinished
音频后/轮终宽限/abort 三选一；close() 延迟语义为唯一上游接触面）已交
lead+用户决策：`C:\CODE\lumithink-data\xiaozhi-e2e08\redesign-proposal-tts-text-flow.md`。
**未获用户方向前不部署任何补丁。**

### 今日已证明（与 TTS 模块无关的既得事实）
- text→LumiThink→real worker→real model→fence-stamped sentences 全链健康。
- 协议级 INTERRUPT fence 经桥干净（零迟到帧，abort-fence 探针 PASS）。
- v1–v3 供应商失败修复真实且必要（"stream is done"/55000000 类失败归零后
  才暴露出更深的生命周期问题）。
- LANE-1 判据（本拓扑）：每轮 TaskRequest(s) + audio_frames>0 + tts_stop=1 +
  settled COMPLETED + 零新增供应商失败 + fence 干净；句子级 sentence_start
  为拓扑偏差（见上）。内容级文本证明通道：gateway assistant.delta/tts_sentence
  流（`句子语音生成成功` 仅在字幕 resource_type 路径输出，DEBUG 级被
  log_level=WARNING 敏感文本纪律抑制）。
- 运维修复前向（lead）：容器重建参数程序化重建、gateway.env 引号/LF/容器路径、
  探针 deviceId 语法、gw-sweep.sh、容器内原生重装（linux-x64 绑定发现）。

## 最终交付设计（v11）：原始逐句生命周期 + pending-flush 定时器（LANE-1 GREEN）

**判定：LANE-1 GREEN。** 证据：3/3 探针轮真实音频（101/104/101 帧）+ tts_stop=1，
**轮间 90s 暂停**（vendor 空闲丢弃场景被逐句生命周期结构性消除），零新增
`TTS_SESSION_FAILED`（计数 18 全程不变）。

**供应商协议发现（根本性）**：火山 seed-tts-2.0 双流端点为 **ONE-SHOT** ——
一个会话只接受一次 StartSession+TaskRequest+音频；同一会话的第二个 TaskRequest
被静默忽略。今日全部症状（"the stream is done"/55000000/空闲静默关闭）皆为其
表现。用户配置注释 `enable_ws_reuse: False（必须保持！）` 早已记录该约束——
其直连链的逐句连接从未触雷。

**最终实现**：完全回退到原始用户 V3 模块（`.before-fix`，直连链验证过的逐句
生命周期）+ 唯一增量 = **1.2s pending-flush 定时器**（序号守卫、conn.loop、
经 text_to_speak 走原始逐句生命周期提交 pending 前缀——桥链轮末短答无后继
片段时，滑窗确认不会到来，定时器在 vendor 空闲窗口内补交；**时序策略而非
内容放宽**）。LAST-flush 保持（原始已有）。TurnCtx 链 = investigated-and-
rejected（证据链完整保留于上文；v4/v8.2 的 sid 发现与监控重绑定发现仍然
真实，只是在 one-shot 语义下不需要）。
配置差量：`sentence_pace_*` 两键移除；`close_connection_no_voice_time: 600`
保留（长答案期间设备连接存活）；`turn_timeout_s: 900` 保留（桥轮仍覆盖整个
多句回答）。回滚：`.before-revert`（TurnCtx 态）或 `.before-fix`（原始）+
wslc restart。

## 2026-10-19 恢复验证（v20，取代前文的当前状态判定）

主进程内异步 TTS 已恢复，真实模型文本经厂商合成、Opus 编码和设备协议探针交付完成。
发现桥接层 `_enqueue_sentence` 与 `yield text` 同时写入原生 chat 的 TTS 队列；
改为原生 chat 唯一管理 FIRST/TEXT/LAST，删除旧播放时长估算和重复入队。
实际厂商覆盖模块移除同步 subprocess 调用，逐项异步排空，补齐字幕 FIRST、
尾帧 flush、设备 LAST，并用捕获的 turn id 防止打断和换轮串音。
交付统计在实际 audio stop 后再清除 gateway turn id。

重启验证还发现 create/followup 在工作进程 ready 前发送会出现 control_timeout，
该回合 ttsAdmissions=0、根本未到 TTS。现等待 ready 后发送并启动回复计时，
保留独立启动超时及停止验证的短截止时间；脚本工作进程复现覆盖通过。

本轮证据：连续三轮 60/56/59 帧；同一连接空闲 90 s 后续问成功；
静夜思 187 帧/5 段字幕；打断后 3 s 零迟到音频，下一轮故事 393 帧/5 段字幕/1 stop。
后一轮 Opus 在内存解码的 PCM 峰值 13692，确为非静音。
同 API Key 的 ASR 初始化并持续发送合成静音时，三次 TTS 均有约 96 KB PCM，
不支持“ASR 一连着就必然阻断 TTS”的旧假设；本实验不覆盖高并发和长时配额。
18 项针对性检查通过（桥接 3、TTS 3、工作进程 8、部署 4），另两处 TypeScript 检查通过。

**前文的“厂商强制 ONE-SHOT、一会话第二个 TaskRequest 必然被忽略”不是已证明的
协议事实。** 逐文本项独立会话是本次本地生命周期实现策略。
历史 1011 尚未逐条归因，不能再把所有音频投递失败解释成厂商/SSL/进程污染。
本轮没有绕过内容安全门、购买配额、修改 ASR 串行规则或合并发布。

完整证据与复跑入口：本地 `C:/CODE/lumithink-data/xiaozhi-e2e08/TTS-RECOVERY-V3.md`。
实际 TTS 覆盖和 v20 前备份保存在 lumithink-data；源码中的桥接/ready 修复及行为测试
已同步，尚未提交。当前验收为文本协议链；实体设备扬声器和人声 ASR 仍需真机验收。
