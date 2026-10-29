# P1-12 SSE 静默断开后终止重订阅生成器 — 实现记录（issue #121；2026-10-29）

> 关联 Epic：[#112](https://github.com/lybym/LumiThink/issues/112)；来源：[P1-11 互通补验记录](2026-10-29-p1-11-python-sdk-interop-verification.md) §3.9（review id 5692103052）；上游版本基线：`@a2a-js/sdk@1.3.0`（精确 pin，本轮未升级）。
>
> **口径**：全部公开内容合成、全程 loopback（127.0.0.1）、无真实凭据、无儿童资料、不切 UDS、不做部署侧动作。修复 = SSE 客户端静默断开时终止该请求的流交付生成器（resubscribe 路径全额终止 + 总线订阅立即释放）+ 拒绝流 task-first 成形；**不放宽**上游流序守卫，**不改**幂等/取消语义，**不升级** `@a2a-js/sdk`。上游 issue 仅在本记录 §7 成文（草稿），不代用户向第三方仓库发帖。

## 1. 结论速览

| 项 | 结果 |
| --- | --- |
| 复现顺序修复（流 A → 重订阅 B → 弃 B → 新流 C 同会话） | ✅ C 得到协议合法 SSE 流（task 首帧 + 显式 `TASK_STATE_REJECTED` 结算帧），不再出现不透明 `-32004` 守卫错误 |
| 断开即终止（本 Issue 标题义务） | ✅ resubscribe 生成器在 `res.close` 即终止，`ExecutionEventQueue.stop()` 立即释放总线订阅；**send 路径刻意保持 SDK 原样直通**（见 §3.1 持久化泵发现——终止 send 交付循环会饿死任务终态落库） |
| 语义不回退 | ✅ stream-resilience / acceptance-idempotency / protocol-errors / p1-07-cancel 等既有断言零削弱（全量套件见 §4.3）；断流≠取消（R8）、慢客户端有界交付、终态订阅 -32004、GetTask 恢复全部保持 |
| 验证 | 新 spec 4/4 绿（红→绿见 §4）；根 `pnpm run typecheck` exit 0 |
| 版本边界 | `@a2a-js/sdk@1.3.0`；仅使用其公共导出面（`@a2a-js/sdk/server` 的 `ExecutionEventQueue` / `ExecutionEventBusManager`、`@a2a-js/sdk/errors` 的公共错误类） |

## 2. 根因分析（SDK 源码行级证据，node:services/a2a-server/node_modules/@a2a-js/sdk@1.3.0）

调查先行结论：**§3.9 的初始归属需要修正**——被遗弃的重订阅生成器**并不持有任何"流序位"**；`-32004` 的直接触发者是 C 自己新 bus 上的**首事件形态**（裸 `statusUpdate`），而决定性变量是**被泊住的活动任务 A 仍占着该会话的唯一执行槽**（断流≠取消，R8）。4-way 矩阵（A 泊住/结算 × B 存在/不存在 × C 同会话/新会话，§4.1）表明 B 的存在与否不影响 C 的结果。以下按证据链展开。

### 2.1 流序守卫是"每流"状态机，首事件必须是 Task/Message

`dist/server/index.js` `DefaultRequestHandler.sendMessageStream`（L3139–3181）：每个新流创建自己的 `ResultManager`（L3147）、经 `eventBusManager.createOrGetByTaskId(taskId, context)` 拿总线（L3151）、新建 `ExecutionEventQueue`（L3152），随后在 `for await (const event of eventQueue.events())` 循环里逐事件推进**本流私有**的 `streamPattern`（L3159–3162）：

```js
// L3159-3162
let streamPattern = "undetermined" /* UNDETERMINED */;
try {
  for await (const event of eventQueue.events()) {
    streamPattern = this._advanceStreamPattern(event, streamPattern);
```

`_advanceStreamPattern`（L3475–3492）：`UNDETERMINED` 态收到 `statusUpdate` 直接抛 `UnsupportedOperationError("Received ${event.kind} before initial 'Message'/'Task' event.")`（L3480–3482）——即 `-32004`。守卫状态随流而建、随流而灭，**不在 bus 上，也不在订阅队列上**。因此"遗留的 B 队列阻塞 C"在机制上不成立；成立的是：**C 作为新流，其 bus 的第一个事件若为裸 `statusUpdate`，C 自己的守卫就拒绝 C**。

### 2.2 首拉异常 → 非 SSE JSON 错误体（RED 现象的成形路径）

`dist/server/express/index.js` `jsonRpcHandler`（L3404–3524）：非 legacy 流式路径在**提交 SSE 头之前**先拉第一事件（L3463–3466 `firstResult = await iterator.next()`），首拉抛错则以 `res.status(200).json(errorResponse)` 回**非 SSE JSON 错误体**（L3467–3475）。复现中 C 的响应体即 `{"error":{"code":-32004,"message":"Received statusUpdate before initial 'Message'/'Task' event."}}`——守卫错误被 `mapToJSONRPCError`（`toJsonRpcError`，server/index.js L649–664：`instanceof A2AError` 按 `error.name` 查 `JSON_RPC_ERROR_CODE`）映成 `-32004`。

### 2.3 被遗弃消费的真实代价：订阅挂到结算为止

`ExecutionEventQueue`（server/index.js L2146–2201）：构造即 `eventBus.on("event"/"finished")` 订阅；`handleEvent` 对事件**无界缓冲**（L2158 `this.eventQueue.push(event)`）；唯一的释放路径是 `stop()`（L2192–2200：置 stopped、唤醒挂起等待、退订）。SDK 内部只在两处调用：生成器 `finally`（`sendMessageStream` L3178–3180 / `resubscribe` L3380–3382）与 bus `finished`。express 写循环对已销毁 socket 的 `res.write()` 被 Node 静默丢弃（`OutgoingMessage._writeRaw` 对 destroyed 连接返回 false、不让写循环报错；实测：被弃消费者存活到任务结算，P1-11 §3.9 两次独立复现）——**SDK 在此路径既无断开钩子也不接受 abort signal**（对 1.3.0 bundle 全量核验）。于是：静默断开 → 写循环继续等下一事件 → 生成器与其 `ExecutionEventQueue` 挂到任务结算。对 resubscribe 而言该队列是**纯消费侧**（无 ResultManager），泄漏窗口 = 任务剩余生命期。

### 2.4 C 的首事件为何是裸 statusUpdate（组合面缺口）

A 泊住（`cancel-test` 场景：任务已领取、`working`、断流不取消）→ 同会话新流 C（新任务、同 contextId）→ 受理门放行创建 → 派发租约执行器的 **§13.4 容量预检**拒绝（会话内活跃执行槽被 A 占用）→ 修复前的拒绝路径直接 `eventBus.publish(statusUpdate(...REJECTED))`——**C 新 bus 的第一个事件**是裸 `statusUpdate` → 2.1 的守卫以 `-32004` 掩盖了真实的容量原因。这也解释了 §3.9"对照组不受影响"的观测：对照的新流在**新会话**（无占用槽）→ 正常受理 → 首事件是 task → 守卫合法。既有套件从未组合"泊住任务 + 同会话拒绝流"顺序，故未暴露。

## 3. 修法

### 3.1 断开即终止（`src/stream-teardown.ts`，本 Issue 标题义务）

三层接线（composition root 单点装配，`src/a2a-service.ts`）：

1. `attachStreamTeardownMiddleware` —— 挂在受理门之后、SDK handler 之前：对 `SendStreamingMessage`/`SubscribeToTask` 请求在 `res.once('close')` 上装断开把手（`StreamTeardownHandle`：`disconnected` promise + `fired` + `detach()`）；
2. `lumithinkUserBuilder`（`src/identity/express-auth.ts`）—— 把把手经 `req.lumithinkStreamTeardown` 带进 SDK `ServerCallContext.user`（SDK 在该路径上唯一的相关性通道）；
3. `withStreamTeardown(handler, counters, deps)` —— 以 `Object.create(handler)` + resubscribe 自有方法包装 `DefaultRequestHandler`，其余方法（含 sendMessageStream）全部走原型委托（SDK handler 仍只收到一个对象）：

   - **resubscribe：自有队列 + 断开竞速 = 真终止**。对锁定 SDK `resubscribe`（L3335–3382）做**逐行为 1:1** 的忠实重实现：同一 guarded task store、同一 `eventBusManager.getByTaskId`（tenant 作用域一致）、缺任务 → `TaskNotFoundError`(-32001)、终态 → `UnsupportedOperationError`(-32004，同文案)、首帧恒为 store 任务快照、无活动 bus → 仅快照即止、`statusUpdate`/`artifactUpdate`/`task` 按 taskId 过滤转发、`message` 跳过、未知 kind 抛同文案 `Error`。差异只有生命周期：**队列由本层持有**，断开竞速命中即 `return`，`finally` 里 `eventQueue.stop()`——被弃消费者的总线订阅**立即**释放。错误类取自公共子路径 `@a2a-js/sdk/errors`（`A2AError` 品牌为 `Symbol.for` 全局符号，跨 bundle `instanceof` 语义不变），线上错误码与 SDK 原生抛出完全一致。resubscribe 无 ResultManager（纯事件转发），终止它**不可能**影响持久化——这正是收口面安全且充分的原因。
   - **sendMessageStream：刻意直通（不收口）**。锁定 SDK 中 send 的交付循环不只是交付：每请求的 `ResultManager.processEvent` 就跑在生成器 `for await` 循环内（server/index.js L3163），而 ResultManager 是 taskStore 的任务态迁移写者；express 写循环挂起的 `next()` 正是把总线事件"泵"过 ResultManager 的持久化泵。断开时终止客户端侧流 = 饿死该泵 = **执行器在客户端离开后才发布的终态（如 COMPLETED）永不离库，任务永卡 `working`**。这不是推演——本 PR 中间版本（断开竞速泵）连续两轮 CI 在 `xiaozhi-a2a-provider` 真实链路门精确触发（`test_damaged_ledger_fails_closed_without_replay`：断开后等服务端任务行落 `completed` 15s 超时，provider 侧断言全过），随后以直通修正。send 路径被弃流的订阅仍按 SDK 原生语义在任务结算时释放（断流≠取消，生命期有界）。

**关键工程发现（为什么不是 `yield*` + `it.return()`）**：委派式包装（`yield* inner`，teardown 里 `it.return()`）只在 wrapper **停在 yield 点**时立即穿透；真实流程中 express 写循环写完一帧立刻再拉下一帧，断开时刻 wrapper 处于**执行态**（正在 await 内层 `next()`），return 请求排在未决 `next()` 之后——Node 探针实测：yield 点 `return()` 即刻落定（true），执行态 300ms 内不落定（false，内层泊死时永不落定）。因此委派式 teardown 只会推高计数器，对"泊死任务"这一本 Issue 场景**零效果（假绿）**；这正是 resubscribe 必须自有队列的直接原因。

### 3.2 拒绝流 task-first 成形（守卫合法，语义不回退）

- `src/acceptance/dispatch-lease-executor.ts`：新增 `taskSnapshotLoader`（读当前持久化任务快照）与 `onPreDispatchRefusal`（结构化日志汇，内容不含正文）两个注入点。四类"结果前拒绝"（quota 拒绝、容量预检拒绝、派发前已持久化取消意图、派发后执行许可撤销）在终态 `statusUpdate` **之前**先发布持久化任务快照（`publishTaskFirst`：快照不可得时保持历史裸 `statusUpdate` 形态的异常回退——绝不虚构 store 里不存在的状态）。派发前拒绝只发生在新派发流上（claim 要求 submitted→working），接收流 pattern 必为 `UNDETERMINED`，task-first 恒为守卫合法。
- `src/limits/admission.ts`：`limitsAwareExecutor` 的调度拒绝回退路径同样先发布快照再发 FAILED 终态（同守卫契约）。
- `src/a2a-service.ts`：装配两处注入点 + 暴露 `streamLifecycle` 计数器（`registered` / `tornDown` / `completed`，内容无关，作回归证据与运营泄漏信号）。

**语义保持清单**：拒绝仍以显式终态结算并持久化（`GetTask` 恢复读 `REJECTED`）；断流≠取消（R8）——teardown 只收口交付侧，执行侧继续走自身结算路径；慢客户端有界交付、终态订阅 `-32004`、跨户订阅 `-32001`、`-32602` 形态全部原样；不放宽守卫、不改幂等/取消语义。

## 4. 验证

### 4.1 4-way 矩阵（归因修正的证据）

| # | A（活动任务） | B（重订阅弃置） | C（新流） | 修复前行为 |
| --- | --- | --- | --- | --- |
| 1 | 泊住 | 有 | 同会话 | `-32004`（JSON 体）——Issue 复现序 |
| 2 | 泊住 | **无** | 同会话 | **同样 `-32004`**（决定性变量是 A 的会话槽，不是 B） |
| 3 | 泊住 | 有 | 新会话 | 正常受理（对照：§3.9 的"对照组"实为新会话口径） |
| 4 | 已结算 | 有 | 同会话 | 正常受理（bus 已 finished/cleanup） |

矩阵 1/2 同结果 + 2.1 的"每流守卫"源码证据 ⇒ §3.9 初始归属（"遗留队列占用流序位"）修正为"泊住任务的会话执行槽 × 拒绝流首事件形态"；遗留队列的真实代价是 2.3 的订阅泄漏（仍然必须修，即本 Issue 标题义务）。

### 4.2 新 spec 红→绿（`tests/p1-12-sse-resubscribe-teardown.spec.ts`）

- **RED**（基线 `c6cc32d`，独立 worktree，仅跑复现序用例）：C 以 `application/json` 回 `{"error":{"code":-32004,"message":"Received statusUpdate before initial 'Message'/'Task' event."}}` —— 断言 `C must be answered with a protocol-valid SSE stream` 失败。测试本体为纯 Node fetch 线形对照（无 Python 参与），与 §3.9 复现口径同构。〔实测 2026-10-29：独立 worktree @ `c6cc32d265760632208cae4da80d8dfddbe4dd74` + 主树同 lockfile 依赖，仅跑复现序用例 —— **FAIL (exit 1)**：`AssertionError: C must be answered with a protocol-valid SSE stream, not the opaque -32004 guard error`；服务端日志同帧佐证：`Pre-stream error for request 3: UnsupportedOperationError: Received statusUpdate before initial 'Message'/'Task' event.`（express L3467–3475 首拉异常 → 非 SSE JSON 体，与 §2.2 机制一致）。测试本体为纯 Node fetch 线形对照（无 Python 参与），与 §3.9 复现口径同构。〕
- **GREEN**（本树）：4/4 通过——
  1. 复现序：C 得 SSE 流，帧 0 = task（同 contextId），帧 1 = 显式 `TASK_STATE_REJECTED` 结算，无错误帧，`GetTask` 恢复读 `REJECTED`；
  2. 新会话对照：新任务正常派发至 `COMPLETED`；
  3. teardown 计时：`registered=1`、`tornDown=1` 于 `res.close` 后 250ms 内成立（**任务仍 `working`**，结算不可能解释该终止——终止发生在断开时刻而非结算时刻），`completed=0`（计数面仅 resubscribe——send 路径为刻意直通，见 §3.1）；任务保持 `WORKING`（断流≠取消）；同任务重新订阅仍交付快照；
  4. 慢消费者（附着不弃）：逐帧收齐直至 `COMPLETED`，`tornDown` 不变、`completed` 计入——慢≠断开，不误杀。
- **spec 自身修正（如实记录）**：前任留下的 spec 从未跑绿，含两处与类型标注不符的实现 bug——`openParkAndDrop` 声明返回 `{ taskId, contextId }` 实际 `return task`（形状 `{ id, contextId, state }`），导致后续 `params: { id: undefined }` 在线上序列化为 `params:{}`（`-32602 Task ID is required`）；两处把 `rpcPost` 的 fetch `Response` 当已解析 JSON body 读（`.body` 实为 ReadableStream）。已分别改为显式重 shaping 与 `rpcResultOf`。Node `--experimental-strip-types` 不做类型检查，故未被 tsc 拦截。

### 4.3 全量套件与类型检查

〔实测 2026-10-29：`pnpm --dir services/a2a-server test` —— **191 tests / 189 pass / 2 fail / 0 skipped / 0 cancelled**；唯二失败即 `python-sdk-interop` 两例（本机无 ≥3.10 Python 解释器：`No Python interpreter found for the official a2a-sdk interop probe`——ZERO-SKIP 设计的显式失败，非本次改动引入；CI 由 setup-python 3.12 + `pip install a2a-sdk==1.2.3` 执行同一套件会绿）。其余 189 例含 stream-resilience、acceptance-idempotency、protocol-errors、p1-07-cancel、official-client-roundtrip、identity-service-acl 等全部既有断言全绿。〕类型检查：**`services/a2a-server` `tsc --noEmit` exit 0**（CI 门）与**根 `pnpm run typecheck` exit 0** 双绿（首推曾因服务级 tsconfig 的提升函数声明不继承控制流收窄报 TS18048，已修复并复验——见 git 历史 fix(a2a) CI typecheck 提交）。锁文件无变化（`@a2a-js/sdk` 未升级；仅 `services/a2a-server/package.json` 的 test 枚举追加新 spec）。

## 5. 版本边界与局限

- `@a2a-js/sdk@1.3.0` 锁定未升级；仅使用公共导出面（`@a2a-js/sdk/server`：`ExecutionEventQueue`、`ExecutionEventBusManager`、类型；`@a2a-js/sdk/errors`：公共错误类）。若未来 SDK 提供断开钩子/abort 注入点或队列停止把手，应回归 SDK 原生路径并删除本层重实现。
- **send 路径为刻意直通**：send 的交付循环兼任任务态持久化泵（§3.1），终止它会饿死终态落库（CI 两轮实证）；send 被弃流的队列与 express 请求对象按 SDK 原生语义存活到任务结算（断流≠取消，生命期有界）。若未来要在 send 路径收口客户端侧，正确形态是"断开即向写循环交付 done + 后台继续泵送内层生成器至结算"（既释放客户端资源又不饿死持久化）——留作后续精化，不在本 Issue 最小面内。
- **resubscribe 重实现的等价性维护**：与 SDK 行为等价由既有套件锚定（stream-resilience fixture 10、protocol-errors fixture 10、official-client-roundtrip、identity-service-acl 跨户 `-32001`）；SDK 若变更 resubscribe 语义需人工同步（已列于上游跟踪项 §7）。
- teardown 中间件按 `req.body.method` 识别收口对象（现仅 `SubscribeToTask`），挂在受理门之后（此时 `body.method` 已为最终形态）；重复请求由受理门直接短路，不经过本中间件，无需把手。
- 计数器为进程生命期累计，不做重置；仅含计数、无任何正文/ID 内容；现只覆盖 resubscribe 面。

## 6. 复现与验证命令

```powershell
# 全量 Node 侧套件（python-interop 两例在无 a2a-sdk 解释器的本机为显式 FAIL=ZERO-SKIP 设计；CI 带 Python 会绿）
pnpm --dir services/a2a-server test
# 单跑本 Issue 回归
node --test --test-isolation=none tests/p1-12-sse-resubscribe-teardown.spec.ts
# 根类型检查
pnpm run typecheck
```

## 7. 上游 issue 草稿（仅入文档，未代用户发帖）

> **Title**: Server SSE streaming path lacks a disconnect hook; abandoned response generators keep their ExecutionEventQueue subscribed until task settlement
>
> **Package / version**: `@a2a-js/sdk` server (express JSON-RPC binding), 1.3.0
>
> **Summary**: In `jsonRpcHandler`, the SSE write loop keeps `res.write()`-ing into a silently disconnected socket (Node drops the writes without erroring the loop), so the response generator — and the `ExecutionEventQueue` it subscribed to the task's event bus — stays alive (and keeps buffering every subsequent bus event, unboundedly) until the task settles. A client that abandons a resubscribe stream (or the initial streaming send) therefore leaks a bus consumer for the remaining task lifetime. There is no disconnect hook on this path and `ServerCallContext` accepts no abort signal.
>
> **Suggested direction**: propagate response close (or a caller-supplied `AbortSignal` via `ServerCallContext`) into the stream generators created by `DefaultRequestHandler.sendMessageStream/resubscribe`, so the generator's `finally` (which already calls `eventQueue.stop()`) runs at disconnect time. Note for implementers: a delegating `yield*` wrapper cannot deliver `generator.return()` while the express loop is parked awaiting the next event (the return request queues behind the pending `next()`); the queue must be stopped directly (or the parked wait resolved) for prompt teardown.
>
> **Workaround we shipped** (server-side, no guard relaxation): own the resubscribe `ExecutionEventQueue` via the public `@a2a-js/sdk/server` exports and stop it in a `res.once('close')` race. IMPORTANT scope note: only the RESUBSCRIBE path can be torn down this way — resubscribe runs no ResultManager (pure event forwarding), so terminating it never starves persistence. The SendStreamingMessage delivery loop MUST keep the SDK's own disconnect behavior: its per-request `ResultManager.processEvent` runs inside the generator's `for await` loop, and the express write loop's pending `next()` is the pump that persists task-state transitions — terminating it on disconnect leaves the task stuck in its last non-terminal state (verified: our first attempt did exactly that and failed a real-link consumer gate). First-class disconnect support upstream should therefore drain-or-forward events after client close (or expose a queue-stop injection point), not merely `generator.return()`.

## 8. 联动

- P2-02（DSH Client）/ P2-03（小智 Provider）/ P2-05（双渠道联合回归）的长生命周期 SSE 客户端在本收口之后不再踩 §3.9 顺序；P2-05 前置达成。
- 记录锚：P1-11 §3.9（初始发现与复现）→ 本记录 §2（归因修正 + 机制）→ §4（红→绿）。
