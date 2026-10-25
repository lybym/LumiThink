# A2A v1.0 数据模型 JSON 示例

依据 [v1.0.1 a2a.proto](https://github.com/a2aproject/A2A/blob/v1.0.1/specification/a2a.proto)。这是协议数据对象示例，不是服务运行抓包或 SDK 互通通过声明。状态及角色使用规范枚举名称，属性按 ProtoJSON lowerCamelCase。HTTP 协议版本为 1.0。

## 数据对象示例（01–04）

- [01-artifact-event.json](01-artifact-event.json)：首次 TaskArtifactUpdateEvent。
- [02-artifact-event.json](02-artifact-event.json)：同一 Artifact 的追加末片段。
- [03-completed-task.json](03-completed-task.json)：聚合后的完整 Task 快照。
- [04-completed-suppressed-task.json](04-completed-suppressed-task.json)：另一条取消竞态分支，只收到第一片段，实际执行完成但答案不完整；不接续 02 示例。

append、lastChunk、metadata.lumithinkOutput 在更新事件；Artifact metadata 只保存稳定内容属性。片段 ID、UTF-8 半开字节区间和 SHA-256 随事件保存在 Outbox，快照不复制全部片段记录。SHA-256 用于传输完整性，不用作删除后的隐私墓碑；随正文删除。幂等请求指纹另用版本化 HMAC。

Task metadata.lumithinkResult 是应用契约，不是新状态。终态 COMPLETED 反映实际执行；outputSuppressedAfterCancel 为 true、answerComplete 为 false 时，客户端必须显示回答不完整，不能自动补播。状态事件的可读说明与最终 GetTask 必须一致；如果只收到状态事件而没有完整结果标记，适配器在显示“完整回答”前查询已授权的最终 Task。未知/未读取标记不得推断完整。

## 线级外壳示例（05–12，P0-02 以锁定官方 SDK 实测生成）

以下 JSON-RPC / SSE 外壳来自 P0-02 对 `@a2a-js/sdk@1.3.0` 官方服务端+客户端的 127.0.0.1 回环实测，并把随机 task/context/message 标识与时间戳归一为上表的合成固定值；结构与字段序列化形态保持实测原样（证据与命令见 [P0-02 兼容矩阵](../../reviews/2026-10-25-p0-02-a2a-sdk-compat-matrix.md)）。内容全部合成，无真实用户、儿童、音频或凭据数据。

- [05-message-send-request.json](05-message-send-request.json)：`SendMessage` JSON-RPC 请求外壳（blocking 配置）。JSON-RPC 方法名为规范 §9 的 PascalCase。
- [06-message-send-response.json](06-message-send-response.json)：`SendMessage` 成功响应外壳；`result` 为 `task` oneof（Task-only 应用策略），Artifact 以 parts 数组保留两个追加片段。
- [07-message-stream-sse.txt](07-message-stream-sse.txt)：`SendStreamingMessage` 的 SSE 外壳（`Content-Type: text/event-stream`，每帧 `data:` 为完整 JSON-RPC 响应）。四帧依次为 task → artifactUpdate → artifactUpdate → statusUpdate。注意首片段帧线上**没有** `append`/`lastChunk` 键——官方编解码按 ProtoJSON 省略默认值 `false`（解析端必须按缺失即 false 处理）；第二片段帧显式携带 `append:true`/`lastChunk:true`。`append`/`lastChunk` 任何情况下不出现在 artifact 对象内。
- [08-error-cancel-completed.json](08-error-cancel-completed.json)：对 COMPLETED 终态任务发起 `CancelTask` 的标准错误 `-32002`（TaskNotCancelable），`error.data` 携带 `google.rpc.ErrorInfo`。
- [09-cancel-canceled-idempotent.json](09-cancel-canceled-idempotent.json)：对已 `TASK_STATE_CANCELED` 任务重复 `CancelTask` 的行为：官方 SDK 幂等返回当前任务（成功结果，非错误）；LumiThink 按同一幂等结算语义实现。
- [10-error-subscribe-terminal.json](10-error-subscribe-terminal.json)：对终态任务 `SubscribeToTask` 的标准错误 `-32004`（UnsupportedOperation），符合规范 §9.4.6。
- [11-error-task-not-found.json](11-error-task-not-found.json)：`GetTask` 未知任务的标准错误 `-32001`（TaskNotFound）。
- [12-error-version-not-supported.json](12-error-version-not-supported.json)：`A2A-Version` 头为不支持的 `9.9`，或**缺失**该头（规范按 0.3 处理而本服务仅声明 1.0）时，均返回 `-32009`（VersionNotSupported）。

官方 JS/Python 客户端均随每个请求发送 `A2A-Version: 1.0`（P0-02 实测）。服务端实现必须显式校验该头，不能静默接受空缺值。

本次静态校验 JSON 可解析、字段层级、字节区间、摘要和聚合正文一致；05–12 由 `poc/a2a-compat`（锁定 `@a2a-js/sdk@1.3.0`）与 `poc/a2a-compat/py/codec_verify.py`（锁定 `a2a-sdk==1.2.3`）自动复核。P1-01/P1-06 需在真实实现上继续验证编解码及传输外壳；P1-06 验证持久化与重连，P1-07 补充标准 CancelTask 成功/不可取消/未找到的真实响应 Fixture。终态订阅按标准错误处理，改用 GetTask；不承诺 A2A 核心提供任意历史 SSE 回放游标。
