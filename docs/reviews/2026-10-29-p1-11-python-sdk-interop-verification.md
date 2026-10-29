# P1-11 Python 官方 SDK 互通补验记录（issue #111；2026-10-29）

> 关联 Epic：[#78](https://github.com/lybym/LumiThink/issues/78)；关联 Gate：[#92](https://github.com/lybym/LumiThink/issues/92)；上游版本基线：[P0-02 A2A/SDK/DSH 兼容矩阵](2026-10-25-p0-02-a2a-sdk-compat-matrix.md)。
>
> **本记录的口径**：这是 **#111 的独立补验记录**，是对 #92 证据链的**追加**（#92 验收报告 `docs/reviews/2026-10-27-p1-10-a2a-acceptance-gate.md` 中"Python 官方 SDK 端 NOT_RUN"的结论**保持原样，不改写**——当时本机无 python/pip 是事实；本记录是其后用隔离 Python 环境补齐的新证据，不代表"#92 当时已通过 Python 半边"）。全部数据合成、全程 loopback（127.0.0.1），无真实凭据、无儿童资料、无 UDS 切换、无生产切线；不宣称部署面互通已验证。
> 依据：docs/A2A_DESIGN.md §9、docs/TASK_LIFECYCLE.md、docs/reviews/2026-10-25-p0-02-a2a-sdk-compat-matrix.md、docs/reviews/2026-10-27-p1-10-a2a-acceptance-gate.md §三.1。

## 1. 版本 / 环境矩阵

| 维度 | 本补验锁定值 | 完整性 / 来源 |
| --- | --- | --- |
| 官方 Python SDK | `a2a-sdk==1.2.3`（base 依赖，无 extras） | wheel `a2a_sdk-1.2.3-py3-none-any.whl` SHA-256 `a89529ab7d026900170aefc1515f35c68d9a14b6a9133f8cc775c8fe598f8ae7`（P0-02 §1 逐 wheel 校验后解包，`C:/CODE/_a2a-compat-verify/pylibs`，`importlib.metadata` 实测导入 1.2.3）；CI 面为 `pip install a2a-sdk==1.2.3`（setup-python 3.12） |
| Python 运行时（验证面） | 3.12.14（DSH 捆绑；`requires_python>=3.10` 满足） | 探针代码按 3.10 兼容书写（无 3.12-only 语法）；**部署面 3.10 复验仍 PENDING**（§6） |
| 官方 JS SDK（对照基线） | `@a2a-js/sdk@1.3.0`（`services/a2a-server` 依赖，精确 pin） | P0-02 §1 integrity 记录沿用；本轮未升级 |
| A2A 协议基线 | `A2A-Version: 1.0`；Agent Card `supportedInterfaces[0] = {JSONRPC, "1.0"}` | 实测每请求头（§3 组 1） |
| 被测服务端 | `services/a2a-server` @ main `c52838c5ad27d38f29071e283a28a2342c014a39`（真实独立进程：SQLite Task Manager + 双层身份 + 受理幂等门 + 派发租约 + Outbox + 独立删除台账） | 由 `tests/python-sdk-interop.spec.ts` 以 `src/main.ts` 子进程启动（临时目录文件 SQLite + 合成 token + `LUMITHINK_A2A_FINGERPRINT_KEY` 显式设置 + 双凭据 bootstrap） |
| 执行体（证据分级） | 轮 1 `synthetic`（协议探针执行器）；轮 2 `dsh-worker`（**真实 worker 子进程机制** + 合成供应商内容） | 两轮均为真实执行证据；dsh-worker 轮不代表真实模型（P1-10/#92 口径不变） |

## 2. 固化套件与 CI

- 探针：`services/a2a-server/py/python_sdk_interop_probe.py`（独立可执行：`--base-url/--token/--token-b/--evidence-out/--runtime-label/--profile`；逐检查项输出机器可读 evidence JSON，任何失败非零退出；**无 SKIP 路径**——缺解释器/a2a-sdk 不可导入均为显式失败，exit 3）。
- 驱动：`services/a2a-server/tests/python-sdk-interop.spec.ts`——两轮（synthetic/full + dsh-worker/worker-completion）各启动一次真实服务端子进程、各跑一遍探针、抽查 evidence 关键锚点，并在**服务端 SQLite 仓储层**复核黑盒观测（首响应丢失重试 → 恰 1 Turn/1 Execution/1 台账行；重复取消 → 恰 1 条持久化 cancelCommand），对照 `tests/acceptance-idempotency.spec.ts` 的语义锚。
- 入口：`services/a2a-server/package.json` `test`（全量枚举追加）+ `test:python-interop`；根 `pnpm run test:a2a-python`。
- CI：`.github/workflows/p1-a2a-server-gate.yml` 增设 `actions/setup-python@v5`（3.12）+ `pip install a2a-sdk==1.2.3`，随既有 `pnpm test` 门执行（ubuntu，无需任何真实凭据——全部凭据由测试合成）。

## 3. 覆盖矩阵（#111 七组 × Python 官方客户端 × JS 对照）

本地实测（2026-10-29，轮 1 synthetic/profile=full）：**33/33 checks PASS**（discovery 6、messaging 4、recovery 4、streamResilience 5、cancel 8、identity 6），28 个请求全部携带 `A2A-Version: 1.0`；轮 2 dsh-worker/profile=worker-completion 同样全绿（差异点见 §3.9）。检查项 id 与下表「Python 锚点」一一对应，evidence JSON 逐项 pass/fail。

### 3.1 组 1 — Agent Card 发现与 A2A-Version 头

| 检查 | Python 结果 | JS 对照（锚点） | 一致性 |
| --- | --- | --- | --- |
| 卡发现（name=lumithink、JSONRPC/1.0、streaming、card URL=绑定地址；第二凭据同样解析成功） | ✅ `card.discovery` | official-client-roundtrip §1 | 一致 |
| 每请求 `A2A-Version: 1.0`（卡发现 + 全部 JSON-RPC/SSE 请求，httpx event hook 逐请求记录） | ✅ `a2aVersion.perRequest`（28/28） | official-client-roundtrip（fetch 拦截） | 一致 |
| 缺失版本头 → 按 0.3 → `-32009` + `VERSION_NOT_SUPPORTED@a2a-protocol.org`（fixture 12） | ✅ `version.missingHeaderRefused`（raw 线形） | protocol-errors fixture 12 | 逐字段一致 |
| `A2A-Version: 9.9` → `-32009` | ✅ `version.unsupported9_9Refused` | protocol-errors | 一致 |
| 无凭据 → HTTP 401 + `-32000/AUTHENTICATION_REQUIRED`，不建任务 | ✅ `auth.unauthenticated401`（raw） | protocol-errors | 一致 |

### 3.2 组 2 — 阻塞与流式 SendMessage / GetTask / 多轮续接

| 检查 | Python 结果 | JS 对照 | 一致性 |
| --- | --- | --- | --- |
| 阻塞 SendMessage（Python `ClientConfig(streaming=False)` → `SendMessage`）→ Task-only oneof、COMPLETED、artifacts≥1 | ✅ `blocking.taskOnlyCompleted` | official-client-roundtrip §1 | 一致 |
| 流式：首帧 task、两段 artifact_update（append false→true、lastChunk 于末段）、Artifact 字段面无 append/lastChunk（描述符层 + 线形双重断言）、终帧 COMPLETED、无 CANCELLING 状态 | ✅ `streaming.taskFirstAndChunkOwnership` | official-client-roundtrip §2 / P0-02 §2 | 一致 |
| GetTask 快照：1 artifact、parts 按序拼接 = 「你好。我们开始吧。」、artifact 无 append/lastChunk、history 恰 1 条 | ✅ `getTask.snapshotAggregation` | official-client-roundtrip §3 | 一致（快照按 chunk 保留 parts，聚合语义与 JS 观测一致） |
| 多轮续接：新 messageId + 原 contextId → **同 Context 新 Task**（设计 §9.2「已终结任务的后续提问在相同 Context 内创建新任务」；逐 Turn 补充输入 `appendTurn` 为仓储层 API，**线上不可达，未断言**——不发明服务端没有的行为） | ✅ `multiTurn.contextContinuation` | identity-service-acl（续接负例面） | 一致（同口径） |

### 3.3 组 3 — SSE 断开 / 重订阅 / 恢复（断开≠取消）

| 检查 | Python 结果 | JS 对照 | 一致性 |
| --- | --- | --- | --- |
| 官方客户端首帧后断开（generator break → 连接关闭）→ 任务仍 WORKING（非终态） | ✅ `disconnect.officialClientEarlyBreakNotCanceled` | stream-resilience §1 | 一致 |
| 裸传输层显式断开（raw SSE 首帧后 `aclose()`）→ 仍 WORKING | ✅ `disconnect.explicitCloseNotCanceled` | stream-resilience §1 | 一致 |
| 活动任务重订阅（官方 `client.subscribe`）→ 首帧为 Task | ✅ `resubscribe.activeTaskDeliversTask` | stream-resilience §3 | 一致 |
| 已取消任务 settles CANCELED（恢复路径终点） | ✅（并入 §3.4 cancel 组） | stream-resilience §1 | 一致 |

### 3.4 组 4 — 取消语义族

| 检查 | Python 结果 | JS 对照 | 一致性 |
| --- | --- | --- | --- |
| 活动任务 CancelTask → CANCELED（typed 返回任务快照） | ✅ `cancel.activeTaskToCanceled` | p1-07 AC4 / official-client-roundtrip §4 | 一致 |
| 已取消任务重复取消 → **幂等成功**（result 非 error，返回 CANCELED 快照，fixture 09） | ✅ `cancel.duplicateIdempotentSuccess`（服务端复核：恰 1 条 cancelCommand） | p1-07 AC4(a) / acceptance-idempotency | 一致 |
| COMPLETED 任务取消 → typed `TaskNotCancelableError` = `-32002`（fixture 08） | ✅ `cancel.onCompletedTaskNotCancelable` | p1-07 AC4(b) | 一致 |
| 同上 raw 线形：`-32002 + TASK_NOT_CANCELABLE@a2a-protocol.org` | ✅ `cancel.onCompletedWireShape` | p1-07 AC4(b)（ErrorInfo reason） | 逐字段一致 |
| 未知任务取消 → typed `TaskNotFoundError` = `-32001`（fixture 11） | ✅ `cancel.unknownTaskNotFound` | p1-07 AC4(c) | 一致 |
| 未知任务 GetTask → `-32001 + TASK_NOT_FOUND`（raw） | ✅ `getTask.unknownTaskNotFound` | protocol-errors fixture 11 | 一致 |
| 终态订阅 → typed `UnsupportedOperationError` = `-32004`（fixture 10）+ raw 线形 | ✅ `subscribe.terminalTaskUnsupported` / `subscribe.terminalWireShape` | stream-resilience §2 | 一致 |

### 3.5 组 5 — 首响应丢失恢复与 MESSAGE_ID_CONFLICT

| 检查 | Python 结果 | JS 对照 | 一致性 |
| --- | --- | --- | --- |
| 首响应丢失：原消息（同 messageId、字节级同内容、新 JSON-RPC id）重发 → **同一 taskId**、COMPLETED | ✅ `firstResponseLoss.sameTaskIdRetry` | acceptance-idempotency AC2(a) | 一致 |
| 同键流式重发（SendStreamingMessage）→ **恰 1 帧**携带原任务快照（ADR-0015 §5.2 快照直答） | ✅ `firstResponseLoss.streamingDuplicateSingleFrame` | acceptance-idempotency（streaming duplicate of COMPLETED） | 一致 |
| **执行器不重复运行**：服务端 SQLite 复核恰 1 Turn / 1 Execution / 1 台账行（spec 内 `assertServerSideFacts`） | ✅ | acceptance-idempotency AC2（in-process 同断言） | 一致 |
| 同键不同内容 → typed `InvalidParamsError` = `-32602` | ✅ `conflict.sameKeyDifferentContent` | acceptance-idempotency AC1 | 一致 |
| raw 线形：`-32602 + MESSAGE_ID_CONFLICT@lumithink.a2a`，错误体不携带原 taskId/原文（不泄漏） | ✅ `conflict.wireReasonAndNoLeak` | acceptance-idempotency AC1 | 一致 |

### 3.6 组 6 — 身份隔离（第二凭据经 `LUMITHINK_A2A_IDENTITY_BOOTSTRAP` 注入）

| 检查 | Python 结果 | JS 对照 | 一致性 |
| --- | --- | --- | --- |
| 跨主体 Get/Cancel/Subscribe → 全部 `-32001`（TaskNotFound，typed；不泄漏主体） | ✅ `identity.crossGetDenied` / `crossCancelDenied` / `crossSubscribeDenied` | identity-service-acl AC2 | 一致 |
| ListTasks 过滤：B 凭据列表不含 A 的任何任务 | ✅ `identity.listTasksFiltered` | identity-service-acl AC2 | 一致 |
| 伪造 metadata（userId/householdId/tenant 指向 hh-beta）→ 服务端按凭据绑定归属，B 仍不可读 | ✅ `identity.forgedMetadataIgnored` | identity-service-acl AC1 | 一致 |
| 跨主体同 messageId = 不同请求键：B 用同 messageId 取得**自己的**任务（不冲突、不可见 A 任务） | ✅ `identity.crossPrincipalSameMessageIdDistinctKey` | acceptance-idempotency AC1 cross-subject | 一致 |

### 3.7 组 7 — 异常路径与错误形状跨 SDK 对照

相同请求在官方 JS 客户端（既有 spec）与官方 Python 客户端下的 JSON-RPC 结果/错误形状**逐字段一致**：`-32009`（fixture 12 形）、`-32002`（fixture 08 形，`@type` ErrorInfo + reason + domain）、`-32001`（fixture 11 形）、`-32004`、`-32602 MESSAGE_ID_CONFLICT`（domain `lumithink.a2a`）、`-32000 AUTHENTICATION_REQUIRED`（HTTP 401）、Task-only 结果 oneof、SSE 帧序（task → statusUpdate → artifactUpdate ×2 → statusUpdate）与 `A2A-Version` 头。线形锚点为 `docs/fixtures/a2a-v1.0/05–12`。

**SDK 表面差异（非协议差异）**：Python 客户端将 JSON-RPC 错误映射为类型化异常（`JSON_RPC_ERROR_CODE_MAP`：TaskNotFoundError/TaskNotCancelableError/UnsupportedOperationError/InvalidParamsError…），但**不在异常对象上暴露 ErrorInfo 的 reason/domain**（该信息仅在线形 body 上）；JS 客户端则在语义错误上携带 reason。适配层需按各自 SDK 形态取用；协议线形不受影响（P0-02 R9 同类记录）。

### 3.8 dsh-worker 轮（轮 2）与 synthetic 轮的差异面

dsh-worker 模式下真实 worker 子进程在数百毫秒内自行完成，parked-cancel 语义由 `LUMITHINK_A2A_WORKER_BEHAVIOR`（本套件用默认 `complete`）驱动，因此轮 2 的探针 profile 为 `worker-completion`，仅以下三处按**真实执行器语义**分支（均为主张不变的诚实断言，详见探针注释）：

1. 断开检查：断开后的不变量为「**任务绝无 CANCELED/FAILED**」，终态收敛为 WORKING 或正常 COMPLETED（`observe_disconnect_state` 轮询记录观测序列）；
2. 重订阅：已终态任务的重订阅走标准 `-32004` 分支（`resubscribe.terminalTaskRefused`）；活动任务则交付 Task 帧（与轮 1 同锚点）；
3. 活动取消：取消在首 Task 帧后**立即发出**（协作窗口）；若窗口真实丢失（worker 先完成 → `-32002`），场景以新任务重排而非放宽断言，3 次窗口全失才判失败。轮 2 其余 29 项检查与轮 1 完全同锚点、全部通过。

### 3.9 本补验新发现：被遗弃的重订阅流对下一条新流的瞬态影响（如实记录，非 Python 侧问题）

**现象**：在**活动**任务上的重订阅 SSE 流被客户端单方面断开后，同一凭据的**下一条新 `SendStreamingMessage`** 会被锁定 SDK 的流序守卫拒绝（`UnsupportedOperationError: Received statusUpdate before initial 'Message'/'Task' event.`）或无首帧；一旦该任务被结算（终态 → bus finished/cleanup），后续新流恢复正常。该现象用 **raw fetch（无任何 Python 参与）即可复现**，归属为**上游 `@a2a-js/sdk@1.3.0` 流生命周期处理与 LumiThink 服务端组合面的交互缺陷**（服务端 express 路由在客户端静默断开后不会终止服务端 resubscribe 生成器；被遗弃的 `ExecutionEventQueue` 挂在活动任务 bus 上，影响同用户作用域内的下一条新流的首事件排序），**不是 Python 客户端缺陷**。既有 JS 套件从未在"重订阅断开后再发新流"的顺序下测试，故此前未暴露。

**处置**：本套件场景顺序为「重订阅 → 立即结算该任务（即活动取消锚点）→ 后续流」，不放宽任何断言、不掩盖该行为；缺陷以本节如实登记。**建议后续任务**：向 #84/#88 证据链追加（或新开 Issue）——服务端在 SSE 连接关闭时终止对应 resubscribe 生成器/事件队列（或上游 SDK 修复），并补一条"重订阅断开 → 新流不受影响"的回归测试。

## 4. 复现命令

```powershell
# Node 侧套件（含两轮 Python 互通）
pnpm --dir services/a2a-server install --frozen-lockfile
pnpm --dir services/a2a-server run typecheck
$env:LUMITHINK_A2A_PYTHON = "<python>=3.10 可执行文件>"        # CI 由 setup-python 提供
$env:PYTHONPATH = "C:\CODE\_a2a-compat-verify\pylibs"          # 本机沙箱路径；常规环境 pip install a2a-sdk==1.2.3 后无需
pnpm --dir services/a2a-server run test          # 全量（含 python-sdk-interop 两轮）
pnpm run test:a2a-python                         # 仅 Python 互通套件

# 单独手跑探针（先起服务端，再对探针传 base/两个合成 token）
node --experimental-strip-types src/main.ts      # services/a2a-server 目录下；banner 给出 base
python py/python_sdk_interop_probe.py --base-url http://127.0.0.1:<port> `
  --token <cred-A> --token-b <cred-B> --evidence-out evidence.json --runtime-label synthetic --profile full
```

CI：`P1 A2A server gate` workflow 在 ubuntu 上以 setup-python 3.12 + `pip install a2a-sdk==1.2.3` 自动执行同一套件（全部凭据由测试合成，无真实凭据）。

## 5. 结论

- **GO（验证面）**：官方 Python 客户端 `a2a-sdk==1.2.3` × 真实 `services/a2a-server` 的 #111 七组场景**全部有真实执行证据且全部通过**（synthetic 33/33 + dsh-worker 33/33，**零 SKIP**），与官方 JS SDK 行为逐项一致（§3 差异仅为 SDK 表面形态，非协议差异）。
- #92 的既有验收记录保持原样；本记录为其 Python 半边的追加证据。
- 新发现 §3.9 的瞬态交互缺陷已登记归属与复现路径，建议后续 Issue 收口。

## 6. 局限与 PENDING（不得宣称完成）

| 项 | 状态 | 说明 / 联动 |
| --- | --- | --- |
| 部署侧 Python 3.10 互通复验 | **PENDING_VERIFICATION**（非本 Issue 目标） | 本轮验证面为 3.12.14；探针代码按 3.10 兼容书写但未在 3.10 实跑；归部署面（#81 链条口径） |
| `a2a-sdk` extras（gRPC、签名、telemetry、fastapi）与 REST 绑定 | PENDING_VERIFICATION | P0-02 §7 口径沿用；本期仅 base + JSONRPC 绑定 |
| 真实模型 / 真实设备 / 真实儿童数据 | 非目标 | P1-10/#92 口径不变；dsh-worker 轮为真实子进程机制 + 合成供应商内容 |
| §3.9 瞬态交互缺陷的修复与回归测试 | **OPEN**（建议新 Issue） | 归属：上游 SDK 流生命周期 × 服务端组合；复现见 §3.9 |
| Agent Card 签名 / push notification | 未验证 | P0-02 §6 局限沿用 |
| Python 客户端异常对象不暴露 ErrorInfo reason/domain | 记录为 SDK 表面差异（§3.7） | 适配层按线形/类型化异常各自取用；不影响协议一致性 |
