# 小智私有服务端部署 Runbook（E2E-04，issue #54）

> 状态：随 E2E-04 交付 ｜ 日期：2026-10-17 ｜ 对应 [Issue #54](https://github.com/lybym/LumiThink/issues/54) · [VOICE_GATEWAY_PROTOCOL §1](../../docs/VOICE_GATEWAY_PROTOCOL.md) · [VOICE_HARDWARE §2/§3](../../docs/VOICE_HARDWARE.md) · [R1-08 Runbook](../runbook.md)
>
> 本文把 [xinnan-tech/xiaozhi-esp32-server](https://github.com/xinnan-tech/xiaozhi-esp32-server) 钉死版本部署到与 LumiThink 同一台 Linux 主机，建立可复现的单机启动/健康/鉴权/配置基础。**验收口径：私有服务端已验证，真实设备仍待 #E2E-08** —— 本 runbook 与 CI 不宣称实机语音可用。

## 1. 版本钉死与拓扑（单一事实源 `deploy/xiaozhi/version.env`）

| 层 | 钉死值 | 溯源 |
| --- | --- | --- |
| 自建服务端 | `xinnan-tech/xiaozhi-esp32-server` @ `27399a2fb64b5910196f438a256ce0a9f868481f`（评估时最新 tag `v0.9.7`） | VOICE_GATEWAY_PROTOCOL §1 评估基线；非浮动 tag |
| 固件协议基线 | `78/xiaozhi-esp32` tag `v2.5.2`（commit `49b4380b…`） | 同上；适配层合同钉死于 `XIAOZHI_GATEWAY_BASELINE` |
| 测试固件 | `v2.5.2_nulllab-ai-vox-v3`（AI-VOX3 机芯盒；本 issue 只记录差异，不改写固件） | §7 |
| 运行时 | Python `3.10`；依赖 pin 见 `deploy/xiaozhi/requirements-gateway-minimal.txt`（上游 requirements 的子集 + onnxruntime 显式补齐） | 上游 requirements.txt @ pinned commit |

升级 = 换基线：改 `version.env` → 重跑 VOICE_GATEWAY_PROTOCOL §3 兼容矩阵评审 → 同步 `XIAOZHI_GATEWAY_BASELINE`（`tests/deploy/xiaozhi-deployment.spec.ts` 强制一致）→ 再部署。

```text
Internet
   │ 443/tcp (HTTPS/WSS, TLS 终止)      80/tcp 仅 ACME 挑战/跳转
   ▼
┌─────────────────────────── Linux 单机（与 LumiThink 同主机）─────────────────┐
│  Caddy（TLS 反向代理，两个站点块）                                            │
│   ├─ lumithink.example.com → 127.0.0.1:3000   (deploy/caddy/Caddyfile, #20)  │
│   └─ xiaozhi.example.com                                      (本 runbook)   │
│        ├─ /xiaozhi/v1/*      → 127.0.0.1:8000  设备 WS（v2.5.2 线协议）      │
│        └─ /xiaozhi/ota/*     → 127.0.0.1:8003  OTA（固件检查/ws+token 下发） │
│  xiaozhi-server.service（受限进程，gateway-minimal 档位）                     │
│  lumithink.service（R1-08，独立 systemd 单元，无顺序依赖）                    │
└───────────────────────────────────────────────────────────────────────────────┘
```

| 端口 | 暴露面 | 说明 |
| --- | --- | --- |
| 443/80 | 公网 | 唯一公网入口 = Caddy；小智域名与 LumiThink 域名互不相干 |
| 8000/tcp | **仅 127.0.0.1** | 设备 WS；`server.ip: 127.0.0.1` 模板强制 + healthcheck `ss` 断言 |
| 8003/tcp | **仅 127.0.0.1** | OTA HTTP；同上 |
| 3000/tcp | 仅 127.0.0.1 | LumiThink（R1-08 既有，未改动） |

`/mcp/vision/explain`（8003）**不由 Caddy 代理**：gateway-minimal 档位显式禁用视觉模块（模板 `VLLM: ""`，上游 vision_handler 对 falsy 模块名请求即 raise），公网不存在该路由（fail-closed）。

## 2. 首次部署（干净 Linux 主机）

前提：Ubuntu 22.04+/Debian 12（systemd）、Python 3.10、git、Caddy（与 R1-08 同机已有）。

```bash
# 0. 运行身份与目录
sudo useradd --system --home /var/lib/xiaozhi-esp32-server --shell /usr/sbin/nologin xiaozhi-server
sudo mkdir -p /var/lib/xiaozhi-esp32-server && sudo chown xiaozhi-server:xiaozhi-server /var/lib/xiaozhi-esp32-server

# 1. Secrets（root:root 0600；模板 shapes only）
sudo install -m 600 -o root -o root /dev/null /etc/xiaozhi/xiaozhi.env   # 先 mkdir /etc/xiaozhi
sudo vi /etc/xiaozhi/xiaozhi.env          # 依 deploy/xiaozhi/env/gateway-minimal.example 填写
#    XIAOZHI_AUTH_KEY=<openssl rand -hex 32>
#    XIAOZHI_DEVICE_WS_URL=wss://<真实域名>/xiaozhi/v1/
#    XIAOZHI_PUBLIC_DOMAIN=<真实域名>

# 2. 钉死安装（clone pinned commit + venv + 最小依赖 + 渲染配置，全部 fail-closed）
sudo env "PATH=$PATH" bash deploy/xiaozhi/bootstrap.sh \
  --target /opt/xiaozhi-esp32-server --env-file /etc/xiaozhi/xiaozhi.env

# 3. 服务（受限进程单元）
sudo cp deploy/xiaozhi/xiaozhi-server.service /etc/systemd/system/xiaozhi-server.service
#    data/、tmp/ 与渲染产物的属主由 bootstrap.sh 以 root 执行时自动回填
#    （render_config.py --owner + chown -R xiaozhi-server），每次重渲染都保持，
#    无需手工 chown（review R1 P1-1）。
sudo systemctl daemon-reload && sudo systemctl enable --now xiaozhi-server

# 4. 健康检查（OTA + 回环绑定 + 模拟设备 hello/abort）
sudo XIAOZHI_AUTH_KEY="$(sudo grep -oP '(?<=^XIAOZHI_AUTH_KEY=).*' /etc/xiaozhi/xiaozhi.env)" \
  deploy/xiaozhi/healthcheck.sh

# 5. 公网入口（并入既有 /etc/caddy/Caddyfile，域名替换为真实值后 reload）
sudo sh -c 'cat deploy/xiaozhi/caddy/Caddyfile.xiaozhi >> /etc/caddy/Caddyfile'   # 改域名！
sudo systemctl reload caddy

# 6. 外部负例复核（运维 vantage，CI 不可证明）：nmap -p- <host> 期望仅 80/443（22 按运维网段）
```

**启动顺序**：两个 systemd 单元相互独立（不同回环端口），无 `After=` 依赖；Caddy reload 在两个单元启动后执行即可。重启主机由 systemd `WantedBy=multi-user.target` 自然拉起双方。

## 3. Secrets 与鉴权（最小权限）

| Slot | 注入 | 语义 |
| --- | --- | --- |
| `XIAOZHI_AUTH_KEY` | `/etc/xiaozhi/xiaozhi.env`（0600） | HMAC-SHA256 设备 token 签名密钥（上游 `core/auth.py`）；轮换 = 改值 → 重渲染 → 重启（重渲染用 §6 的 bootstrap 命令，属主自动回填给服务用户），期间旧 token 全部失效（fail-closed）。env 文件只是渲染期输入：systemd 单元**不**把它注入进程环境（上游运行时无 env 插值，review R1 P2-3） |
| 设备 token | 设备 POST `/xiaozhi/ota/` 换取 | 7 天有效（`expire_seconds: 604800`）；含签名+时间戳，不含明文设备标识 |
| 设备白名单 | 模板固定 `allowed_devices: []` | **无 token 旁路**：白名单机制存在但保持为空（最小权限；上游默认示例含白名单，本部署显式关闭） |
| 供应商 ASR/TTS/LLM Key | **不存在于本档位** | 启用 = 档位变更 + `docs/VOICE_HARDWARE.md §3` 供应商评审；Key 永不入 Git/普通日志 |

纪律：渲染由 `render_config.py` 执行——缺 key/占位值拒绝（报错只给变量名）、产物 0600、值永不回显、root 执行时属主回填服务用户（`--owner`，每次渲染都保持）。审计面：小智服务端是**领域外发边界之前**的语音入口，儿童会话正文不经过它（gateway-minimal 档位连 ASR 都未配置）。

## 3.5 gateway-asr-real 档位：真实流式 ASR 供应商（E2E-05，issue #55）

> 启用本档位 = 在小智已钉版本（§1，`27399a2f…`）的 Provider 扩展点（`selected_module.ASR`）接入**一个评审过的真实流式 ASR 供应商**。本节与 [docs/adr/0009-real-asr-provider-transient-channel.md](../../docs/adr/0009-real-asr-provider-transient-channel.md)、[VOICE_HARDWARE §3](../../docs/VOICE_HARDWARE.md) 共同构成启用前提；**未完成评审 = 保持 gateway-minimal 档位**（fail-closed：模板/env 缺任何一项渲染即拒绝）。

**首供应商（唯一评审路径）**：`ASR: AliyunBLStreamASR`（`type: aliyunbl_stream`，阿里云百炼 Paraformer 实时）。钉死 commit 的该 provider 硬编码 `wss://dashscope.aliyuncs.com/api-ws/v1/inference`（duplex WebSocket 流式）；上行合同 = 设备 Opus 16 kHz 单声道 → 服务端解码 PCM 16 kHz（模板 `sample_rate: 16000`、`format: pcm`）；端点检测 = 本地 SileroVAD + 供应商侧 `max_sentence_silence: 200`（VAD 断句；手动模式上游自动放宽 6000 ms）。钉死版本升级若改动该硬编码端点/provider 形状 = 换基线（§1）+ **重跑外发评审**（CI 合并后扫描会因形状漂移失败）。

| 政策面 | 值 | 载体（模板强制，CI/测试断言） |
| --- | --- | --- |
| 鉴权 | API Key 渲染期注入 `${XIAOZHI_ASR_API_KEY}`；systemd 单元不注入进程环境 | `env/gateway-asr-real.example`（0600）+ `render_config.py` fail-closed |
| 数据外发 | 仅 ASR 音频流 → dashscope（评审锚点端点）；LLM/TTS/VLLM 零外发不变 | 模板活跃面扫描 + 合并后有效配置扫描 |
| 保留（本机） | `delete_audio: true`（不落音频文件）；`read_config_from_api: false`（**ASR/TTS 上报队列结构性 never enqueue**，原始转写不进消息队列/无 manager-api 可上报） | 上游 `asr/base.py` / `reportHandle.py` @ pinned commit；模板断言 |
| 保留（日志） | `log_level: WARNING`：钉死 commit 以 INFO 打印"识别文本/识别到文本"（`asr/base.py`、`asr/aliyunbl_stream.py`），WARNING 全部抑制 | 上游 `config/logger.py` 按 `log.log_level` 过滤 |
| 残留（如实披露） | WARNING 以上异常路径可能携带供应商侧错误详情（连接/鉴权失败等，不含本地转写正文）；上游 `loguru` 文件 handler `diagnose=True` 为钉死代码，异常堆栈可能含变量值——日志按敏感面对待（journald 权限 + 轮转 + 运维 vantage），本机转写正文不进常规日志 | 本节；ADR-0009"约束/后果" |
| 供应商侧保留 | 由运营者在激活时的外发评审记录中登记（reviewer/reason；LumiThink 侧激活记录 `LUMITHINK_ASR_*` 校验锚点端点一致）；儿童数据闸门 = `CHILD_DATA_EGRESS_REVIEW_STATUS = not_performed` 常量，本档位仅覆盖**成人合成/公开测试音频对照路径** | `lib/server/real-asr-composition.ts`（fail-closed） |

**激活步骤**（在 §2 完成的基础上）：

```bash
# 1. env 追加供应商键（模板 shapes 见 deploy/xiaozhi/env/gateway-asr-real.example）
sudo vi /etc/xiaozhi/xiaozhi.env          # + XIAOZHI_ASR_API_KEY=<百炼 API-KEY>

# 2. 以真实 ASR 档位重渲染（--template 显式选档；缺省仍是 gateway-minimal）
sudo env "PATH=$PATH" bash deploy/xiaozhi/bootstrap.sh \
  --target /opt/xiaozhi-esp32-server --env-file /etc/xiaozhi/xiaozhi.env \
  --skip-clone --template deploy/xiaozhi/config/gateway-asr-real.yaml

# 3. 重启并复核
sudo systemctl restart xiaozhi-server
sudo XIAOZHI_AUTH_KEY="$(sudo grep -oP '(?<=^XIAOZHI_AUTH_KEY=).*' /etc/xiaozhi/xiaozhi.env)" \
  deploy/xiaozhi/healthcheck.sh
```

**禁用开关（服务端可禁用 ASR 外发）**：重渲染缺省档位即回到零外发形态——`bootstrap.sh --skip-clone`（不带 `--template`）→ 重启。运营商侧还可直接停用百炼 Key（fail-loud：ASR 请求失败，协议面存活）。

**对照样例与证据流程（DoD 1/3）**：仓库内证据 = 合成流式源驱动真实 LumiThink 组合栈（`tests/domain/voice/adapter/real-asr-stream.spec.ts`：final 逐字进受控 Core + 内容无关时延/端点指标 + 零泄漏扫描）；**成人合成/公开测试音频 → 远程 ASR** 的服务器端对照为**运营者 opt-in**：以成人/合成样本音频经设备 WS（或真机）触发，激活时登记 reviewer/reason，证据只保留内容无关事实（时延、端点/去重计数、通过/失败）；**真实儿童音频不在本档位授权范围内**（儿童数据闸门为常量），任何实机验收归 #E2E-08 且需独立评审。

**诚实边界**：私有服务端配置面已验证（CI 渲染/合并后扫描），**真实供应商转写质量、实机打断/重连行为未实机验证**；供应商置信度不在钉死 commit 的设备线协议上暴露（`stt` 只带文本），证据记录如实标注 `confidence.onWire=false`，不合成数值。

## 4. gateway-minimal 档位：明确的"禁用"语义（AC 2）

`deploy/xiaozhi/config/gateway-minimal.yaml`（渲染进 `data/.config.yaml`）。

**关键前提（上游行为，已实证）**：上游将覆盖层与仓库内 `config.yaml` 做**递归合并**——覆盖层省略的 `selected_module` 键会保留上游默认（FunASR/ChatGLM/EdgeTTS 等供应商形状）。因此**"省略 = 禁用"不成立**，本模板显式覆盖全部模块键：

- `VAD: SileroVAD`——唯一真实启用的模块（纯本地：模型随上游仓库内 `models/snakers4_silero-vad/` 提供，onnxruntime CPU 推理，零外发）。
- `ASR: FunASRServer`、`LLM: OllamaLLM`、`TTS: CustomTTS`——认知层全部显式指向**回环死端口**（`127.0.0.1:10096` / `:11434` / `:9`）：初始化仅建对象（服务可正常启动、协议面可用），任何真实音频/推理/合成请求连接即拒绝——**大声失败，零外发、零供应商、零模型下载**。
- `Memory: nomem`、`Intent: nointent`——记忆与意图识别显式关闭。
- `VLLM: ""`——视觉模块**显式禁用**（review R1 P2-1；R2 P1-1 措辞订正）：上游 `config.yaml` 自带**外部** VLLM 供应段（`ChatGLMVLLM{url: https://open.bigmodel.cn/api/paas/v4/}`、`QwenVLVLLM{url: https://dashscope.aliyuncs.com/...}` 等，@pinned commit L746 起），递归合并后这些段在合并后有效配置中**仍然存在但绝不被选中**——`""` 为 falsy，`selected_module.VLLM` 不指向任何供应段，上游 `core/api/vision_handler.py` 在实例化任何 provider（即任何外发）之前直接 raise"您还未设置默认的视觉分析模块"（multipart 请求体读取发生在 raise 之前，但读取本身不产生外发；fail-loud、零外发）。若改写为上游默认 ChatGLMVLLM，视觉请求体会出网。CI 合并后有效配置扫描断言的是：selection 面无 VLLM + **活跃 provider 面**全回环 + 上游默认外部 VLLM 段形状钉死（防未来 pin 变更使本安全动机失义）。
- 鉴权强制开启且 `allowed_devices: []`（无 token 旁路），HMAC token 7 天。
- "未启用供应商 ASR/TTS 时悄然接外部服务"被两层否定：本模板自身所有具体 URL 均为回环（模板结构断言 + Node 回归测试，活跃行级）；**合并后有效配置**扫描另断言活跃 provider 面全回环（未选中的上游默认段可合法携带外部 URL——永不实例化，见上条 R2 P1-1 订正）；行为层回环端点不存在，任何外发语义都退化为本地 fail-loud。
- 畸形/垃圾二进制音频：入口按协议拒绝（无内容回显、服务端不崩溃——CI 负例断言 OTA 健康随后复验）。
- 上游 `config.yaml` 的第三方占位（qweather key、Home Assistant 等）位于上游文件的 `plugins` 段且只在对应插件被意图调用时使用；本档位 `Intent: nointent` 且无 LLM 链路。CI 泄漏扫描断言**本仓库**模板零真实凭据。

## 5. CI 证据（`.github/workflows/e2e-04-xiaozhi-deployment-gate.yml`）

在干净 ubuntu runner 上执行（即 AC 1 的"干净 Linux/独立环境"自动化面）：

1. **artifacts**：`bash -n` 全部脚本、`python -m py_compile` 全部 python、`systemd-analyze verify`（沿用 R1-08 的 denylist 仲裁）、模板 YAML 解析、模板/env 零真实凭据、`version.env` 与 `XIAOZHI_GATEWAY_BASELINE` 钉死一致性（由 Node 回归测试承担）。
2. **deployment smoke**：读取 `version.env` → 浅克隆 pinned commit（SHA 校验）→ venv + gateway-minimal 依赖（含 `libopus0`/`ffmpeg` 系统依赖核验）→ 渲染配置 → **合并后有效配置扫描**（镜像上游 `merge_configs` 递归合并上游 `config.yaml` + 渲染层，断言 `selected_module` 七键显式且 `VLLM: ""`、活跃 provider 面全部回环、上游默认外部 VLLM 段形状钉死——R2 P1-1 自校验）→ 启动服务端 → `healthcheck.sh`（OTA POST 200 + websocket 下发面 + **OTA 签发 token 重放 WSS 被接受** + `ss` 回环断言 + hello/abort 探针）→ **负例**：无 token 连接被明文拒绝并关闭（`--expect-auth-failure`）、无 ASR 时二进制音频被静默丢弃且协议面存活（`--expect-silent-binary`）→ **重启恢复**：TERM 后重启，OTA 200，**同一 device-id** 重连 hello 重新成功且 session_id 变化（per-connection 会话，排除设备映射复用）→ **损坏配置负例**：写入非法 YAML 后进程必须非零退出（fail-fast，不得带病启动）→ **重渲染幂等**：`--skip-clone` 重跑 bootstrap 修复损坏配置（§6 补救回路的机器面）且产物恢复合法 YAML。

本地等价复现（Linux）：`bash deploy/xiaozhi/bootstrap.sh --target <dir> --env-file <env>` → 手动启动 → `deploy/xiaozhi/healthcheck.sh`。冒烟失败时日志只保留终态摘要（不进 artifact，避免存储配额类失败）。

## 6. 故障模式（diagnostics / failure modes）

| 症状 | 语义 | 处置 |
| --- | --- | --- |
| 启动即退（非零退出 + YAML 解析错误） | `data/.config.yaml` 损坏/半渲染 | 重新渲染再启动：`sudo env "PATH=$PATH" bash deploy/xiaozhi/bootstrap.sh --target /opt/xiaozhi-esp32-server --env-file /etc/xiaozhi/xiaozhi.env --skip-clone`；**不得**手工改渲染产物了事 |
| 启动即退，日志含读取 `data/.config.yaml` 的 `Permission denied`/EACCES | 渲染产物属主不是 `xiaozhi-server`（root 渲染未回填属主即 crash-loop，review R1 P1-1） | 用当前版本 bootstrap 重新渲染（命令同上，`--owner` 自动回填属主并保持；R2 P2-1 修复后，root 直跑与"目标父级不可写→内部逐条 sudo"两条调用路径都会回填属主）；CI artifacts job 有"二次渲染后属主/可读性"回归防复发；勿以手工 chown 渲染产物替代 |
| `render_config.py` 拒绝：missing/placeholder | env 缺 key 或占位值 | 补真实值；报错只含变量名（无值回显） |
| 连接被拒 `认证失败` | 无/过期/签名不符 token | 设备重新 POST `/xiaozhi/ota/` 换 token；近期轮换过 auth_key 则全部设备需重取 |
| 每连接日志 `connect call failed`（10096/11434/9 回环拒绝） | gateway-minimal 档位预期（认知层回环占位 fail-loud） | 非故障（§4）；消除它 = 启用对应真实模块 = 档位变更 + 评审 |
| `ASR识别失败`/上游 `任务失败`（仅 WARNING+，含供应商错误码） | gateway-asr-real 档位：供应商连接/鉴权/配额失败（fail-loud，协议面存活） | 核对 `XIAOZHI_ASR_API_KEY` 与百炼控制台状态；轮换 = 改值 → 重渲染 → 重启（§3.5）；设备侧重连按协议处理 |
| 真实 ASR 档位下日志出现"识别文本"字样 | `log_level` 被改回 INFO（模板被手改/旧渲染产物） | **不得**手工改渲染产物；用 §3.5 命令重渲染（WARNING 抑制转写日志面） |
| OTA 200 但设备连不上 WSS | `XIAOZHI_DEVICE_WS_URL` 与真实域名/TLS 不符（上游注释亦警告 docker/公网部署需手工核对） | 核对 Caddy 站点块域名与该值逐字符一致；`curl -sSI https://<domain>/xiaozhi/ota/` 复核 |
| `healthcheck` 报端口越界 | 8000/8003 绑定了非回环地址 | 配置被改（模板外覆盖）；恢复 `server.ip: 127.0.0.1` |
| onnxruntime/libopus 加载失败 | 系统依赖缺失 | `apt-get install libopus0`；ffmpeg 缺失同理由上游启动检查拦截 |
| 磁盘满 → tmp/ 日志失败 | journald/文件写失败 | 按 §7 日志保留策略清理；数据面（快照）不受影响（无儿童数据经小智服务端） |

## 7. 日志与审计脱敏

- 服务端日志：`tmp/server.log` + stdout→journald（`journalctl -u xiaozhi-server -f`）；上游日志格式含 `selected_module` 标签，**不含**音频与转写文本（本档位无 ASR）。
- 访问日志：Caddy JSON（`/var/log/caddy/xiaozhi-access.log`，滚动 10MiB×10）；OTA POST 无敏感 query；WS 流量不入访问日志正文。
- 红线沿用 R1-08：任何儿童正文、原始音频、设备凭据不入 Git/CI/普通日志；CI 泄漏扫描断言模板与产物零凭据形状。
- 保留策略：`tmp/` 随部署目录（建议 logrotate 或 journald `SystemMaxUse` 同机统一）；OTA 固件缓存 `data/bin/` 仅 `{model}_{version}.bin` 命名文件。

## 8. 回滚

1. **版本回滚**：`/opt/xiaozhi-esp32-server` 是 pinned checkout（detached HEAD）；回滚 = `git fetch origin <旧 SHA> && git checkout --detach <旧 SHA>` → 重渲染（bootstrap `--skip-clone` 命令见 §6，模板随 LumiThink 仓库版本走、属主自动回填）→ 重启 → healthcheck。**换 SHA 必须先过兼容矩阵评审**（§1），紧急回滚后补评审记录。
2. **配置回滚**：渲染前留存 `/etc/xiaozhi/xiaozhi.env`（`cp` 0600）；恢复上一份 env → 重渲染（同 §6 命令）→ 重启。
3. **停用**：`systemctl disable --now xiaozhi-server` + 从 `/etc/caddy/Caddyfile` 移除小智站点块并 reload。无持久化数据依赖（无数据库、无快照、无儿童数据），停用即净退出。
4. **凭证应急**：轮换 `XIAOZHI_AUTH_KEY` → 重渲染（同 §6 命令，属主自动回填）→ 重启（旧 token 全失效，设备重新走 OTA 换取）。

## 9. CI 无法证明、由运维执行的部分（诚实披露）

- 真实公网 vantage 的端口扫描（§2 步骤 6）、真实域名 ACME/HSTS/WSS 握手（Caddyfile 仅语法/结构断言）；
- systemd 沙箱在真实内核上的拦截效果（建议 `systemd-analyze security xiaozhi-server` 复核）；
- systemd 单元**运行时面**（`User=xiaozhi-server` + 沙箱指令的启动/拦截效果）不在 CI 中启动（CI 仅 `systemd-analyze verify` 语法面）：运维首次 `systemctl start xiaozhi-server` 后应**立即**执行 §2 步骤 4 的 healthcheck 并留存输出作为运行时证据（R2 review test-gap）；
- OTA **固件下载面**（`data/bin`）的真实升级流：本档位只验证接口契约（200 + 版本协商形状），不放置真实固件；
- **真实设备接入**（hello 实发、激活、OTA 指向私有服务端、打断/重连）：全部归 #E2E-08；本项验收标注为 **"私有服务端已验证，真实设备仍待 #E2E-08"**。

**上游旁路与接受理由（review R1 P2-1 披露；R2 P1-1 措辞订正）**：钉死 commit 的上游 `core/api/vision_handler.py` 存在 `client_id == "web_test_client"` 的**免 token 旁路**（上游内置测试客户端语义，L37）。本部署对该旁路的收口是双重的：① `/mcp/vision/explain` 端点只绑 `127.0.0.1:8003` 且 Caddy 刻意不代理（远程不可达，触发面仅限本机回环进程）；② 模板 `VLLM: ""` 使视觉路径在实例化任何 provider/任何外发之前 fail-loud（multipart 请求体读取发生在 raise 之前，但读取不产生外发；合并后有效配置仍含上游默认外部 VLLM 供应段但绝不被选中——CI 扫描断言 selection 无 VLLM + 活跃面回环 + 上游默认形状钉死）。接受理由 = 端点网络边界 + 模块显式禁用；两者任一失效即需重新评审。

## 10. 测试固件差异记录（实施范围 4：只记录，不改写固件）

测试固件 `v2.5.2_nulllab-ai-vox-v3` 与官方 v2.5.2 基线的差异核验（来源级，2026-10-17 查阅）：

- **板级在官方基线内**：`78/xiaozhi-esp32` tag `v2.5.2` 的树内即存在 `main/boards/nulllab-ai-vox-v3/`（nulllab 官方说明亦确认 AI-VOX3 已并入上游官方版本，"版本会随官方版本自动升级"）。因此该固件**是官方 v2.5.2 基线 + 官方树内板级配置的构建**，不是协议分叉。
- **协议/OTA/激活代码路径零改动**：与官方基线对照，该板的差异面只有板级文件（`boards/ai-vox3/*`、`config.h`、`config.json`、板 README）与构建脚本/文档；`main/ota.cc`、WebSocket 协议实现、激活流程不在改动清单内。命名解析：`v2.5.2`（官方 tag）+ `nulllab-ai-vox-v3`（官方树内 board type）。
- **板级配置要点**（`main/boards/nulllab-ai-vox-v3/config.h` @ v2.5.2）：ESP32-S3 + ES8311 codec，I2S 采样 **24 kHz**（输入/输出同率，与 hello 协商面一致）；`CONFIG_USE_DEVICE_AEC` 可选开启端侧 AEC（nulllab 默认开启 `CONFIG_USE_DEVICE_AEC=y`，影响上行参考信号，属 R5 打断联调项）；ML307 4G 模块备用网络（默认 WiFi）。
- **OTA 差异（需配置项）**：v2.5.2 固件编译期默认 OTA URL 为 `https://api.tenclass.net/xiaozhi/ota/`（`main/Kconfig.projbuild`）。指向私有服务端 = 构建期覆盖 `OTA_URL` 为 `https://<私有域名>/xiaozhi/ota/`——**本 issue 不改写固件**，该步骤与烧录验证归 #E2E-08。
- **激活配置差异（如实记录）**：v2.5.2 设备侧 OTA 契约含可选 `activation{code,challenge}` 对象（xiaozhi.me 的六位码/HMAC 挑战激活流，`Activation-Version: 1/2` 头区分）；**钉死的服务端单模块 OTA 只返回 `firmware` + `websocket`（含 HMAC token），不返回 `activation` 对象**——私有部署不依赖、也不复现 xiaozhi.me 激活链路，设备鉴权走 token（§3）。该差异对协议面（hello/abort）无影响，已在 VOICE_GATEWAY_PROTOCOL §3 兼容矩阵语义内（设备激活/OTA 一行标注"未实机验证"）。
- **未验证项（不提前宣称）**：盒内实际烧录版本串、编译期 OTA_URL 实际值、设备 `Activation-Version` 头形态、实机 hello/abort/OTA 行为——记入 #E2E-08 checklist（对照 VOICE_GATEWAY_PROTOCOL §6 既有清单）。
