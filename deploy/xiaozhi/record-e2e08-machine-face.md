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
