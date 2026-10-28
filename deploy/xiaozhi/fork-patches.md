# LumiThink Gateway Bridge — 上游 fork patch 登记（E2E-07，issue #57）

> 服务端基线：`xinnan-tech/xiaozhi-esp32-server` @ `8f2dda09cf18f1c1ece0f906eee4cc2fabb7fb58`
>（= tag v0.9.8，2026-10-28 D1 选型决定；单一事实源 `deploy/xiaozhi/version.env`）。
> 本文件是 fork patch 的评审记录；机器强制的镜像在
> `deploy/xiaozhi/gateway_bridge/install_bridge.py`（逐字锚点、恰好一次、
> 漂移即拒绝）。任何 patch 更换锚点 = 更换基线 = 必须重跑
> docs/VOICE_GATEWAY_PROTOCOL.md §3 兼容矩阵评审。

## 设计原则

1. **能走扩展点就不改核心**：LLM 路径完全走上游 LLM 扩展点
   （`core/utils/llm.py` 按 `selected_module.LLM` 的 `type` 加载
   `core/providers/llm/<type>/<type>.py` 并实例化 `LLMProvider`）——
   `selected_module.LLM = LumithinkBridgeLLM(type: lumithink)` 是唯一选中的
   LLM，**内置 AI 第二路径（其他 LLM 模块 / 远端配置切换）在结构上不可达**；
   `read_config_from_api: false` + 档位模板显式覆盖全部模块键阻止远端漂移。
2. **必要的事件 tap 全部 try/except 包裹**：桥接层故障绝不破坏设备侧
   hello/abort/音频路径（fail-open 的只是可观测性 tap；模型调用本身
   fail-closed——桥不可达即本轮无回答，绝不回退内置 LLM）。
3. **补丁数量最小**：LLM 扩展点之外仅 5 个单点 hook，无逻辑改写、无删除。

## Patch 清单（install_bridge.py 的机器镜像）

| # | 文件（pinned commit 内路径） | 锚点（逐字） | 注入内容 | 语义 |
| --- | --- | --- | --- | --- |
| 1/5 | `core/handle/helloHandle.py` | `    await conn.websocket.send(json.dumps(conn.welcome_msg))` | `lumi_on_hello(conn, "conn-"+device_id去冒号+"-"+session_id前8位)` | 设备 WS 连接注册到网关桥（网关侧由此发起真实 `Device-Id/Client-Id/Authorization` 的鉴权映射与租约）；connId 按**设备+连接级 session_id** 唯一派生（同一设备的第二条连接必须拿到不同 connId——租约拒绝与 `device_drop` 才能精确关闭第二条而不是第一条）；放置在 welcome 发送之后（session_id 已铸造） |
| 2/5 | `core/handle/abortHandle.py` | `    conn.clearSpeakStatus()` | `lumi_on_abort(conn)` | 设备 abort（线协议 `abort` → 内部 `client_abort=True` → `clear_queues()` → 端侧 `tts stop`）完成后通知网关：epoch 栅栏提升 + 计账冲销。放置在 native 清理之后，网关通知失败不影响设备侧打断 |
| 3/5 | `core/handle/sendAudioHandle.py` | `    flow_control["packet_count"] = packet_index + 1\n    flow_control["sequence"] = sequence + 1`（`_do_send_audio` 内） | `lumi_on_audio_frame(conn, opus_packet)` | **真实音频到账记账**：每个实际发往设备的 Opus 包计数 + SHA-256 摘要（内容无关）。解决 Adapter 合同只有 `frameCount/audioDigest` 占位的问题——网关侧 Adapter v1.4 记录真实帧数与真实字节摘要 |
| 4/5 | `core/handle/sendAudioHandle.py` | `    # 发送消息到客户端\n    await conn.websocket.send(json.dumps(message))`（`send_tts_message` 内） | `lumi_on_tts_state(conn, state)` | 话语停止（`state=="stop"`）时冲销音频记账（合成 `audio_delivered` 上报帧数+摘要） |
| 5/5 | `core/connection.py` | `    async def _save_and_close(self, ws):\n        """保存记忆并关闭连接"""` | `lumi_on_device_closed(self)` | 设备连接关闭（连接 finally 路径）→ 网关侧连接租约与一次性会话映射同步释放 |

每个 hook 的注入体均为：

```python
    try:
        _lumi_provider = getattr(conn, "llm", None)   # patch 5 为 self
        if _lumi_provider is not None and hasattr(_lumi_provider, "lumi_on_<hook>"):
            _lumi_provider.lumi_on_<hook>(...)
    except Exception:
        pass
```

## 已核验的上游事实（2026-10-17，逐字核验 @ 27399a2）

> **2026-10-28 D1 换基线复核**：仓库 pin 收敛至 v0.9.8 @ `8f2dda09` 后，5 个登记
> 锚点已对 `8f2dda09` 的上游原文**逐字复核**——`abortHandle.py` /
> `sendAudioHandle.py` / `connection.py` / `aliyunbl_stream.py` /
> `alibl_endpoint.py` / `alibl_stream.py` / `tts/base.py` 在 v0.9.7→v0.9.8 间
> **无改动**（上游 compare 核对）；唯一改动的 `helloHandle.py`（官方 v0.9.8 唤醒
> 音频修复）内锚点 `    await conn.websocket.send(json.dumps(conn.welcome_msg))`
> 仍逐字存活。以下 2026-10-17 核验记录按当时 pin 原样保留。

- `core/utils/llm.py::create_instance`：按 `type` 加载
  `core/providers/llm/<class_name>/<class_name>.py` 并实例化 `LLMProvider(config)`
  （`config` = `LLM.<selected>` 段）——本桥即按此接入，无核心改动。
- `core/connection.py`：`self.session_id = str(uuid.uuid4())`（连接级铸造）；
  `chat()` 以 `self.llm.response(self.session_id, dialogue)` 消费同步生成器，
  每个 chunk 进 `tts_text_queue`；`if self.client_abort: break` 打断流。
- `core/handle/abortHandle.py`：`conn.client_abort = True` → `conn.clear_queues()`
  → 发送 `{"type":"tts","state":"stop","session_id":...}` → `conn.clearSpeakStatus()`。
- `core/handle/sendAudioHandle.py`：`_do_send_audio` 逐包
  `await conn.websocket.send(opus_packet)`（60ms/帧流控）；`send_stt_message`
  发送 `{"type":"stt",...}` + `tts start`；`send_tts_message(stop)` 结束话语。
- `core/auth.py::AuthManager`：token = `{urlsafe_b64_nopad(HMAC-SHA256(auth_key,
  f"{client_id}|{username}|{ts}"))}.{ts}`；LumiThink 网关侧以同 scheme 逐字复算
  （`lib/server/voice-gateway-wiring.ts::verifyDeviceAuthorization`）——
  **凭证不得仅凭 MAC 派生**：MAC 之外必须持共享密钥签名 + 新鲜时间戳。

## 与 TTS 音频发送栅栏的关系

- 句子进入 `tts_text_queue` 之前已过 LumiThink Output Gate + `tts_queue` 栅栏
  （stream gate 准入即投递）；设备 abort → 网关 epoch 提升 → 旧 epoch 句子在
  stream gate 结构性不再产生。
- 已入服务端队列的句子由上游 native `clear_queues()` 清空（patch 2 之后的
  `lumi_on_abort` 使网关侧队列清理帧为 belt-and-braces）。
- `tts_end(reason=interrupted|failed)` → 桥清队列；`failed` 补发端侧 stop。

## 未验证边界（如实声明）

- 以上 patch 锚点基于钉死 commit 逐字核验；真实设备（固件）联调未进行
  （E2E-08 边界）。
- 服务端 AEC / 二进制协议 v2/v3 路径未验证（POC 固定 v1 契约面）。
- 多设备并发（同一服务端实例多台设备同时对话）在网关侧受
  `binding_capacity` 租约约束，桥侧行为已实现但 CI 只验证单设备 +
  双连接拒绝场景。
