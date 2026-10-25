# P0-02 A2A、SDK 与 DSH 兼容矩阵（issue #80；2026-10-25）

> 关联 Epic：[#78](https://github.com/lybym/LumiThink/issues/78)；上游输入：[P0-01 源码清单冻结矩阵](2026-10-25-p0-01-source-freeze-matrix.md)、[A2A v1.0 数据模型 Fixtures](../fixtures/a2a-v1.0/README.md)。
>
> **口径与边界**：本矩阵是 P0-02 的仓库侧收敛记录，全部证据来自隔离目录的合成数据样例（`poc/a2a-compat`，自含锁文件，与根工作区完全隔离），**不触碰本机运行服务、部署目录与 UDS，不含任何儿童资料、音频、声纹或凭据**。`LOCKED`＝精确版本已固定且有完整性校验；`VERIFIED`＝有真实执行的编解码/线级运行证据；`PENDING_*`＝未完成，标注负责人与联动任务。**不宣称 P0 Gate、互通验收或正式发布已通过；不切换现有 UDS；本任务不批准正式发布。**
> 依据：[P0/P1 计划 §P0-02](../P0_P1_PLAN.md)、[整体方案 §9/§12](../A2A_DESIGN.md)、[Task 契约](../TASK_LIFECYCLE.md)、[A2A v1.0.1 规范](https://github.com/a2aproject/A2A/blob/v1.0.1/docs/specification.md)。

## 1. 版本 / 包完整性 / 来源矩阵

| 维度 | 锁定值与权威位置 | 完整性 / 来源证据 | 状态 | 负责人 / 联动 |
| --- | --- | --- | --- | --- |
| A2A 规范基线 | `v1.0.1`（a2aproject/A2A tag，规范 commit `3303592588e388e62e0f69f701af531d2f4e3991`） | tag 经 GitHub API 核验；JSON-RPC 方法名、错误码表、`A2A-Version` 行为均以该 commit 的 specification.md 为准 | **LOCKED** | P1 实现（#83 起）按此基线 |
| 协议交互版本 | `A2A-Version: 1.0`（Major.Minor；Agent Card `supportedInterfaces[].protocolVersion: "1.0"`，JSONRPC binding） | 规范 §3.6/§9/§14.2.1：客户端必须发送；缺失按 `0.3` 处理；不支持返回 `-32009`。官方 JS/Python 客户端实测每请求均发送 `1.0`（§3/§4） | **LOCKED + VERIFIED** | LumiThink 服务端中间件显式校验（R7） |
| 官方 JS SDK（服务端/客户端） | `@a2a-js/sdk@1.3.0`（精确版本；`poc/a2a-compat/package.json` + `poc/a2a-compat/pnpm-lock.yaml`） | npm tarball `https://registry.npmjs.org/@a2a-js/sdk/-/sdk-1.3.0.tgz`，integrity `sha512-OpK4nygUnLKlpTFZlM2IrYu7f3c/B7c4u4Z14+vgMq24lEINTVCxH/BqZx+GL92rNf7CoBL5oTP5UhNsl75yyg==`；engines `node>=20`；上游 repo tag `v1.3.0`（2026-09-29）；本地安装经 pnpm content-addressable store 校验 | **LOCKED + VERIFIED** | P1-01/#83 沿用；升级需重跑 §6 全部验证 |
| JS 隔离包 express | `express@5.1.0`（`poc/a2a-compat` devDependency） | SDK peerDependencies 声明 `^4.21.2 || ^5.1.0`；仅用于隔离验证，不进根依赖 | **LOCKED**（验证面） | — |
| 官方 Python SDK（小智客户端） | `a2a-sdk==1.2.3`（PyPI） | wheel `a2a_sdk-1.2.3-py3-none-any.whl` SHA-256 `a89529ab7d026900170aefc1515f35c68d9a14b6a9133f8cc775c8fe598f8ae7`；sdist `a2a_sdk-1.2.3.tar.gz` SHA-256 `a28bc40b010d088ea4a10d05a5ba021d183f02cacab15929072ea5b34cde3fe6`；`requires_python >= 3.10`；仅安装 base 依赖（无 grpc/telemetry/fastapi extras） | **LOCKED + VERIFIED**（base 面） | extras（gRPC、签名、telemetry）PENDING_VERIFICATION（§7） |
| Node 运行时 | 仓库 pin：`24.x`（根 `package.json` engines）；CI 与本次验证运行时：`v24.21.0` | 与 #79 矩阵「服务端运行时/工具链」行一致；验证在 DSH 捆绑 runtime Node v24.21.0 实跑 | **LOCKED**（沿用 #79） | #82 Gate 复核 |
| pnpm | 仓库 pin：`pnpm@10.34.7`（根 packageManager）；隔离包锁文件由 pnpm `11.28.5` 生成（DSH runtime 自带 pnpm） | 根工作区不受影响（`poc/a2a-compat` 完全隔离，自带 `pnpm-workspace.yaml` 关闭根配置继承） | **RECORDED** | — |
| Python 运行时 | 部署侧（小智服务端）：`3.10`（`deploy/xiaozhi/version.env`，#79 矩阵）；本次验证运行时：`3.12.14`（DSH 捆绑） | `a2a-sdk` `requires_python>=3.10`，两者均满足；**部署侧实际互通验证归 P0-03/#81 隔离环境** | **LOCKED（验证面）/ PENDING_VERIFICATION（部署面）** | #81（隔离重建）；#82（Gate） |
| 内部 DSH Runtime | `@deepseek-ai/dsh` 系列 `0.2.0-rc.2`（`poc/dsh-child/package.json` + `runtime-manifest.json`，沿用既有锁定） | 未变更；本 Issue 不动内部 DSH 版本 | **LOCKED**（沿用） | P1-05/#87 接真实 Worker |
| 候选插件 @ryubyte/dsh-a2a | `0.3.1`；源码锁定 main HEAD `748c79317c0eee72b2a3f0636050d036c0b15b55`（2026-09-30，“fix: support DSH 0.2.0-rc.1 in v0.3.1 (#13)”） | GitHub API 核验 commit 与 package.json（peer: cordis ^4.0.4、dsh-host-webserver/dsh-tools `^0.1.7-rc.2 || ^0.2.0-rc.1`、engines node `^22.19.0 \|\| >=24.0.0`）；未安装、未运行（P2 才接入） | **SOURCE_FROZEN**（记录态） | P2 修补/复测或改用官方 SDK 轻量插件（§4 R1–R3） |

> 规范与 SDK 版本号解耦：`v1.0.1` 是规范 tag，`1.3.0`/`1.2.3` 是包版本；互通以实际编解码与线级行为为准（§2–§4），不以“声称兼容”为准。

## 2. 实测证据 A：官方 SDK 编解码（fixtures 01–04）

隔离验证位置：`poc/a2a-compat`（Node v24.21.0；Python 3.12.14 + 依赖图 sha256 校验直装，见 §6）。输入为 [`docs/fixtures/a2a-v1.0`](../fixtures/a2a-v1.0/README.md) 01–04。

| 检查 | JS 官方 SDK（`@a2a-js/sdk@1.3.0`，`Task/TaskArtifactUpdateEvent.fromJSON→toJSON`） | Python 官方 SDK（`a2a-sdk==1.2.3`，`google.protobuf.json_format.Parse→MessageToDict`） |
| --- | --- | --- |
| 01/02 事件 Parse→重编码 round-trip | ✅ 语义等价（`proto3` 默认值省略后逐字段一致） | ✅ 语义等价（同上） |
| `append`/`lastChunk` 归属 | ✅ 在更新事件；Artifact 无此二字段（类型层 + 运行时 JSON 双重断言） | ✅ 描述符层断言 `Artifact fields=[artifact_id, description, extensions, metadata, name, parts]`；事件拥有 `append`/`last_chunk` |
| `proto3` 默认值省略 | ✅ 实测：`toJSON` 省略 `append:false`/`lastChunk:false` 键（真值保留） | ✅ 实测：`MessageToDict` 同样省略 false 值键 |
| 自定义 metadata 存活 | ✅ `lumithinkOutput`/`lumithinkContent`/`lumithinkResult` 全部 round-trip | ✅ 同左 |
| UTF-8 半开字节区间 + 每片段 SHA-256 | ✅ chunk-1 `[0,9)` 9 字节、chunk-2 `[9,27)` 18 字节，摘要逐一匹配 | ✅ 同左 |
| 聚合语义 | ✅ 01+02 拼接 == 03 快照正文「你好。我们开始吧。」（27 UTF-8 字节） | ✅ 同左 |
| 03/04 Task 快照 + `lumithinkResult` 旗标 | ✅ `outputSuppressedAfterCancel`/`answerComplete` 两分支均 round-trip；终态保持 `TASK_STATE_COMPLETED`，无自定义状态 | ✅ 同左 |
| 枚举面 | `fromJSON` 解析为数值枚举、`toJSON` 输出枚举名；无 `TASK_STATE_CANCELLING` | upb 构建中枚举以 int 暴露、JSON 输出枚举名；无 `TASK_STATE_CANCELLING` |

- 执行证据：`poc/a2a-compat/src/codec-verify.mjs`（13/13 PASS）、`poc/a2a-compat/py/codec_verify.py`（14/14 PASS）；两者同时固化为 `node --test` 套件（`pnpm run test:a2a-compat`，2/2 PASS）。
- 关键结论：**「append/lastChunk 不出现在 Artifact」在两个官方 SDK 的编解码路径上均成立**；客户端解析必须把线上缺失的 `append`/`lastChunk` 当 `false`（fixtures README 与 §3 线级证据一致记录）。

## 3. 实测证据 B：官方 SDK 线级行为（JSON-RPC / SSE / 错误 / 取消 / 版本头）

隔离回环：`@a2a-js/sdk@1.3.0` 服务端（`DefaultRequestHandler` + `InMemoryTaskStore` + scripted executor + express 5.1.0 `jsonRpcHandler`）↔ 同版本官方客户端，`127.0.0.1` 临时端口。证据文件：`poc/a2a-compat/src/wire-verify.mjs`（套件内断言）与运行产物 `reports/wire-evidence.json`（本地，不入库）。

| 行为 | 实测结果（锁定 SDK） | 与规范 v1.0.1 对照 |
| --- | --- | --- |
| JSON-RPC 请求/响应外壳 | `{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{...}}` → `result.task{...}` oneof；`GetTask` result 为 Task 对象 | 符合 §9（PascalCase 方法名、`application/json`） |
| Task-only 应用策略 | executor 首发事件为 Task 时，blocking `SendMessage` 的 `result` 只含 `task` oneof；官方客户端直接返回 Task 对象（`SendMessageResult` 无 oneof 包装，R9） | 符合设计 §9.2「统一返回 Task」需应用侧保证（SDK 允许 message-only，R4 附带记录） |
| SSE 外壳 | `Content-Type: text/event-stream`；帧格式 `data: {"jsonrpc":"2.0","id":3,"result":{...}}`；四帧 `task → artifactUpdate → artifactUpdate → statusUpdate` | 符合 §9.4.2 |
| 线上 append/lastChunk | 首片段帧无 `append`/`lastChunk` 键（proto3 默认值省略）；次片段帧 `append:true,lastChunk:true`；artifact 对象任何帧都不含二字段 | 与 §2 编解码结论一致 |
| 取消语义 | `TASK_STATE_SUBMITTED` 任务 `CancelTask` → executor 收到取消 → 任务转 `TASK_STATE_CANCELED`，`GetTask` 确认 | 符合 §9.4.5；取消以状态结算为准 |
| 重复 CancelTask（已 CANCELED） | **幂等成功**：再次 `CancelTask` 返回当前任务（`result`，非错误） | 规范未明文；SDK 选择幂等。LumiThink Task Manager 按 TASK_LIFECYCLE 幂等结算语义实现（fixtures 09） |
| CancelTask（COMPLETED） | JSON-RPC 错误 `-32002`，`error.data=[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"TASK_NOT_CANCELABLE","domain":"a2a-protocol.org"}]` | 符合 §3.3.2/§9.5 |
| 终态订阅 `SubscribeToTask` | JSON-RPC 错误 `-32004`（UNSUPPORTED_OPERATION，消息含终态原因） | 符合 §9.4.6（终态任务必须改用 `GetTask`，设计 §9.2 一致） |
| 未知任务 `GetTask` | JSON-RPC 错误 `-32001`（TASK_NOT_FOUND） | 符合 §3.3.2 |
| `A2A-Version` 头（客户端） | 官方 JS 客户端对卡片发现与每个 JSON-RPC 请求都发送 `A2A-Version: 1.0`（拦截 fetch 实测记录） | 符合 §3.6.1 客户端义务 |
| `A2A-Version` 头（服务端） | `9.9` → `-32009`；**缺失头 → 按 `0.3` 处理 → `-32009`**（服务端只声明 1.0）。返回形态：HTTP 200 + JSON-RPC error 体；SDK 内部对该错误打印 `Unhandled error in JSON-RPC POST handler` 日志（响应仍为合法 JSON-RPC error，属日志噪音，R7） | 符合 §3.6.2（缺失按 0.3）；**LumiThink 必须显式声明 1.0 并拒绝 0.3，不得静默接受** |
| SDK TaskStore 面 | `InMemoryTaskStore` 原型方法 = `load, save, list`（加构造器） | LumiThink SQLite Store 适配这三方法 + 事务 Outbox（R6） |
| SDK 事件总线输入形态 | **执行器必须发布运行时对象形态**（Part oneof `{content:{$case:'text',value}}`、数值枚举）；直接发布线上形态 JSON 会被静默序列化成 `UNRECOGNIZED` 状态与空 part，不报错（R4） | 实现/调试陷阱，非规范问题；已写入 fixtures README 与 server-lib 注释 |

## 4. 实测证据 C：跨 SDK 互通（官方 Python 客户端 × 官方 JS 服务端）

隔离回环：`poc/a2a-compat/src/interop-server.mjs`（与 §3 相同的 JS 服务端）↔ `poc/a2a-compat/py/interop_probe.py`（`a2a-sdk==1.2.3` 官方客户端，httpx JSON-RPC 传输）。

- Agent Card 解析：`supportedInterfaces[0] = {protocolBinding: JSONRPC, protocolVersion: "1.0"}` ✅。
- Python 客户端每请求发送 `A2A-Version: 1.0`（httpx 客户端默认头实测）✅。
- `SendStreamingMessage` 全流消费：`task → artifact_update(append=false) → artifact_update(append=true,last_chunk=true) → status_update(TASK_STATE_COMPLETED)` ✅；两个 artifact_update 的 Artifact 字段面均无 append/lastChunk ✅。
- `GetTask` 快照：1 个 Artifact、2 个 part，按序拼接 = 「你好。我们开始吧。」✅（SDK 默认 store 保留分片 parts，聚合为单 part 是 LumiThink 应用契约，见 R5）。
- 对 COMPLETED 任务 `CancelTask`：Python 侧收到 `TaskNotCancelableError` → JSON-RPC `-32002` ✅（类→码映射 `JSON_RPC_ERROR_CODE_MAP`）。
- 证据产物：`C:/CODE/_a2a-compat-verify/py-interop-evidence.json`（本地运行产物，不入库）；探针脚本与断言入库可复跑。

## 5. 不兼容点与适配风险登记

| 编号 | 发现 | 证据 | 判定与处置 | 联动 |
| --- | --- | --- | --- | --- |
| R1 | 候选插件 Abort 不传播：`sendAndWait` 轮询中仅 `if (options.signal?.aborted) throw new A2AError(408, 'Task wait aborted')`，**不调用远端 `cancelTask`** | 锁定源码 `src/client.ts@748c7931`（§1 提交） | 与设计 §12.1 观察一致；**不得把本地 Abort 当作真实取消验收**；P2 修正 `Tool Abort → CancelTask → Task Manager → Runtime Bridge` 或改用官方 SDK 轻量插件 | P2（#80 矩阵冻结，接入前置条件已在设计 §12.1） |
| R2 | 候选插件 context 驻内存、每次工具新 messageId：无持久请求记录/稳定重试 ID | 同上（`sendAndWait`/`sendMessage` 源码路径） | 首响应丢失恢复不可依赖候选插件；P2 需持久化记录与稳定重试 ID | P2 |
| R3 | 候选插件凭据按 Profile 配置；且 peerDeps 声明 DSH `^0.1.7-rc.2 || ^0.2.0-rc.1`，修复提交仅声称支持 `0.2.0-rc.1`，仓库内部 DSH 锁定 `0.2.0-rc.2` | `package.json@748c7931` + `poc/dsh-child/package.json` | 首期限定个人 Profile；`rc.2` 兼容性未经声明与验证；P2 接入前必须固定插件提交 + 补丁并在隔离环境互通复测 | P2 |
| R4 | `@a2a-js/sdk` 事件总线要求运行时对象形态：直接发布线上形态 JSON → 静默损坏为 `UNRECOGNIZED`/空 part | §3 表（wire-verify 调试实录；`server-lib.mjs` 注释） | P1 服务端实现必须用 SDK 运行时形态构造事件（或在边界统一 `fromJSON`），并加守卫测试 | P1-01/#83、P1-06/#88 |
| R5 | SDK 默认 store：`append:true` 按 **parts 数组追加**（快照保留分片）；`artifactUpdate.metadata` 以 last-write-wins 合入 `Task.metadata`（分片级 metadata 在快照上必然丢失） | §3/§4 实测（GetTask 2 parts；`applyArtifactUpdate`/`mergeArtifacts` 源码） | 与设计一致：片段级 `lumithinkOutput` 落 Outbox，快照只存聚合正文；「聚合单 part」由 LumiThink Task Manager 应用层完成（fixtures 03）；SQLite TaskStore 适配需覆盖 `load/save/list` 并保持事务边界（R6） | P1-02/#84、P1-06/#88 |
| R6 | `InMemoryTaskStore` 为进程内存实现（`load/save/list`） | §3 TaskStore 面实测 | 不能用于 LumiThink 持久化；P1-02 SQLite 统一仓储 + 事务 Outbox 承接 | P1-02/#84 |
| R7 | `A2A-Version` 服务端行为：缺失头按 `0.3` → 仅声明 1.0 的服务返回 `-32009`；错误以 HTTP 200 + JSON-RPC error 体返回；SDK 对该路径打印 "Unhandled error" 日志（噪音） | §3 实测 + fixtures 12 | LumiThink 中间件必须显式校验 `A2A-Version`、只声明 `1.0`、不静默接受空缺；客户端适配不得依赖空缺头默认值 | P1-01/#83 |
| R8 | 终态订阅返回 `-32004`；SSE 断开不自动取消 | §3 实测（规范 §9.4.6） | 客户端恢复路径必须走 `GetTask` 快照 + 新订阅；与设计 §9.2/§10.3 一致 | P1-06/#88、P1-07/#89 |
| R9 | 官方 JS 客户端 blocking `sendMessage` 返回值是 Task/Message 对象本身（无 `result.task` 包装）；Python 客户端 `send_message` 返回 `AsyncIterator[StreamResponse]` | §3/§4 实测 | 各端适配层按各自 SDK 形态处理；线级契约以 JSON-RPC 外壳为准（fixtures 05–12） | 渠道适配（P2 小智 Provider） |

## 6. 可复现命令（隔离目录）

```powershell
# JS 侧（隔离包，自含锁文件；node v24.21.0 / pnpm runtime 11.28.5）
pnpm --dir poc/a2a-compat install            # 按 pnpm-lock.yaml 精确安装 @a2a-js/sdk@1.3.0
pnpm --dir poc/a2a-compat run verify:codec   # fixtures 01–04 编解码 round-trip（13 checks）
pnpm --dir poc/a2a-compat run verify:wire    # 回环 JSON-RPC/SSE/错误/取消/版本头（写 reports/wire-evidence.json）
pnpm run test:a2a-compat                     # node:test 套件（codec + wire，2/2）

# Python 侧（Python 3.12.14；a2a-sdk==1.2.3 base 依赖，见 §1 完整性）
# 常规环境：python -m venv <dir> && <dir>/Scripts/pip install a2a-sdk==1.2.3
# 本沙箱 pip tempfile 受限时的等价路径：按 PyPI 元数据 sha256 校验逐 wheel 解包（C:/CODE/_a2a-compat-verify，本地）
set PYTHONPATH=<pylibs>; set PYTHONIOENCODING=utf-8
python poc/a2a-compat/py/codec_verify.py     # fixtures 01–04 编解码 round-trip（14 checks）

# 跨 SDK 互通（两个终端，或后台 + 探针）
node poc/a2a-compat/src/interop-server.mjs          # 打印 READY <base>
python poc/a2a-compat/py/interop_probe.py <base> [evidence.json]
```

局限：验证为脚本/合成口径（Mock executor + 回环 HTTP），**不代表真实儿童数据、语音设备、真实模型或 A2A 实机验收**；未安装/未验证 `a2a-sdk` 的 gRPC、签名、telemetry、fastapi extras；REST（HTTP+JSON）绑定未验证（本期绑定 JSONRPC）；Agent Card 签名（`verifyAgentCardSignature`）与 push notification 未验证。

## 7. PENDING（不得宣称完成）

| 项 | 状态 | 负责人 / 联动 |
| --- | --- | --- |
| 部署侧 Python 3.10 环境的 SDK 互通复验（含小智客户端链路） | PENDING_VERIFICATION | #81 隔离环境重建；#82 Gate |
| `a2a-sdk` extras（gRPC、签名、telemetry）与 REST 绑定 | PENDING_VERIFICATION（P1 不依赖，按需验证） | P1-01/#83 起按需 |
| xiaozhi 服务端版本选型（v0.9.7 vs v0.9.8，#79 矩阵 D1）与 v0.9.8 TTS 可重建交付（D5） | 本 Issue **不裁决**部署基线选型：#80 的矩阵范围是 A2A/SDK/DSH 侧锁定；部署基线选型与迁移归 P0-03/P0-04 链条 | #81（重建/迁移）；#82（Gate 判定）；见 #79 矩阵 D1/D5 的阻断判定（仍然有效） |
| 候选插件 dsh-a2a 接入（含 R1–R3 修正验证） | PENDING（P2 前不得接入正式实现） | P2；接入前置条件=设计 §12.1 |
| SQLite TaskStore / 事务 Outbox、消息幂等、真实取消结算 | PENDING（设计已冻结，实现未开始） | P1-02/#84、P1-07/#89 |
| 本文档与 fixtures 的后续维护 | fixtures/poc 由 CI 的根测试 + `test:a2a-compat` 守护；SDK 升级必须重跑 §6 全部命令并更新本矩阵 | 后续 Issue |

## 8. 验收条件（AC）覆盖

| Issue #80 AC | 证据 |
| --- | --- |
| 提供可复现版本/包完整性/来源矩阵，包声称兼容不能代替实际编解码结果 | §1 矩阵（tag/commit、npm integrity、PyPI SHA-256、来源 URL）+ §2/§3/§4 实际执行证据 + §6 复现命令 |
| 官方 SDK 解析并重编码 Task、Artifact 事件及 metadata；append/lastChunk 不出现在 Artifact | §2（JS 13/13、Python 14/14，双 SDK round-trip 与归属断言）；`poc/a2a-compat` 套件常驻可重跑 |
| 明确 JSON-RPC 请求/响应与 SSE 外壳、标准错误和重复 CancelTask 行为；保存无敏感内容的 Fixtures | §3 实测 + [`docs/fixtures/a2a-v1.0`](../fixtures/a2a-v1.0/README.md) 05–12（JSON-RPC 外壳、SSE 帧、-32001/-32002/-32004/-32009、重复 CancelTask 幂等）；内容全部合成；根测试 `tests/server/a2a-fixtures.spec.ts` 守护 |
| 验证 header 1.0、终态订阅错误、Task-only 应用策略与 SDK Store/handler 的适配风险 | §3/§4（双客户端 `A2A-Version: 1.0` 实测、缺失头按 0.3 拒绝、`SubscribeToTask` 终态 `-32004`、blocking send `result.task` oneof、TaskStore `load/save/list` 面）+ §5 R4–R9 风险登记 |

## 9. 覆盖声明

- **仓库侧已完成**：A2A 规范/协议头/官方双 SDK/运行时/内部 DSH/候选插件提交的精确锁定与完整性记录；双 SDK 编解码、线级行为、跨 SDK 互通的隔离实测；fixtures 05–12 与守卫测试；不兼容点与适配风险登记（R1–R9）。
- **PENDING（不得宣称完成）**：§7 全部条目；部署侧复现、extras、插件接入、SQLite Store、真实取消闭环均未开始或未验证。
- 本任务不批准正式发布，不切换现有 UDS，不触碰真实儿童数据/音频/声纹/凭据；所有公开 Issue/PR/CI 内容均为合成样例。
