# A2A v1.0 数据模型 JSON 示例

依据 [v1.0.1 a2a.proto](https://github.com/a2aproject/A2A/blob/v1.0.1/specification/a2a.proto)。这是协议数据对象示例，不含 JSON-RPC / SSE 外壳，不是服务运行抓包或 SDK 互通通过声明。状态及角色使用规范枚举名称，属性按 ProtoJSON lowerCamelCase。HTTP 协议版本为 1.0。

- [01-artifact-event.json](01-artifact-event.json)：首次 TaskArtifactUpdateEvent。
- [02-artifact-event.json](02-artifact-event.json)：同一 Artifact 的追加末片段。
- [03-completed-task.json](03-completed-task.json)：聚合后的完整 Task 快照。
- [04-completed-suppressed-task.json](04-completed-suppressed-task.json)：另一条取消竞态分支，只收到第一片段，实际执行完成但答案不完整；不接续 02 示例。

append、lastChunk、metadata.lumithinkOutput 在更新事件；Artifact metadata 只保存稳定内容属性。片段 ID、UTF-8 半开字节区间和 SHA-256 随事件保存在 Outbox，快照不复制全部片段记录。SHA-256 用于传输完整性，不用作删除后的隐私墓碑；随正文删除。幂等请求指纹另用版本化 HMAC。

Task metadata.lumithinkResult 是应用契约，不是新状态。终态 COMPLETED 反映实际执行；outputSuppressedAfterCancel 为 true、answerComplete 为 false 时，客户端必须显示回答不完整，不能自动补播。状态事件的可读说明与最终 GetTask 必须一致；如果只收到状态事件而没有完整结果标记，适配器在显示“完整回答”前查询已授权的最终 Task。未知/未读取标记不得推断完整。

本次静态校验 JSON 可解析、字段层级、字节区间、摘要和聚合正文一致。P0-02/P1-01 需以锁定官方 SDK 验证编解码及传输外壳；P1-06 验证持久化与重连，P1-07 补充标准 CancelTask 成功/不可取消/未找到的真实响应 Fixture。终态订阅按标准错误处理，改用 GetTask；不承诺 A2A 核心提供任意历史 SSE 回放游标。
