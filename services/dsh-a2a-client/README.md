# @lumithink/dsh-a2a-client — LumiThink DSH A2A Client（P2-02，issue #114）

工作 DSH（外部客户端）调用 LumiThink A2A Server 的正式接入适配层，按
[ADR-0018](../../../docs/adr/0018-dsh-a2a-client-selection.md) 的五条硬约束与最小设计骨架实现，
传输/编解码/版本头/错误语义复用锁定的官方 `@a2a-js/sdk@1.3.0`（P0-02 全链验证的同一客户端库）。

**边界**：外部客户端边界（A2A_DESIGN §3.2）——不访问家庭数据库、不进入内部 Runtime、不共享内部
DSH 会话与文件系统；全合成内容；不含真实凭据；不宣称工作 DSH 生产实装（注册进真实工作 DSH
实例属运营者面，见实现记录）。

## 能力面

| 能力 | 契约 |
| --- | --- |
| 发送前持久化 | `saveBeforeSend` 在 wire 请求前落盘：稳定 messageId + 原请求 + returnImmediately 模式元数据（§7.4 第一句） |
| taskId 取得即落盘 | 服务器返回 Task 的瞬间写 `saveTaskId`（messageId ↔ taskId ↔ contextId），随后才进入轮询/订阅 |
| 阻塞等待 | 线上恒为 `returnImmediately: true` + 客户端轮询（interval/超时可配）；INPUT_REQUIRED / AUTH_REQUIRED 结构化早退 |
| 流式消费 | `consumeStream`（SSE）与 `resubscribe`（断流重附着）；taskId 与状态推进逐帧入账 |
| 取消（§7.4） | 工具 Abort 先停本地呈现 → `cancel()` 以**独立 AbortController/超时**（缺省 2000ms，§7.3）发 CancelTask，绝不携带已 aborted 的 signal |
| 首响应丢失恢复（§5.3） | 无 taskId 时按原 messageId 重发原请求（returnImmediately）取回同一 Task 再取消/续用；`resumePending()` 扫描待恢复项 |
| 多轮句柄（约束 5） | `sendFollowUp` = 新稳定 messageId + 同 contextId + 原 taskId/`referenceTaskIds`；AUTH_REQUIRED 与普通输入区分呈现 |
| 凭据 | 仅经官方 `AuthenticationHandler` 回调面注入（内存/环境），缺失即拒绝启动（fail-closed）；401/403 触发 provider 重签；凭据不写日志、不写账本 |
| 持久化 | `FileTaskLedger`：单 JSON 文档原子写（tmp + rename），跨重启恢复；未知未来版本与损坏文件 fail-closed；记录含 bearer 形态内容即拒绝落盘 |

## 配置

```powershell
$env:LUMITHINK_A2A_CLIENT_URL = 'http://127.0.0.1:3312'
$env:LUMITHINK_A2A_CLIENT_TOKEN = '<>=16 chars synthetic token>'
$env:LUMITHINK_A2A_CLIENT_LEDGER_PATH = '<durable json file>'
# 可选：_POLL_MS（默认 250）/ _POLL_TIMEOUT_MS（默认 120000）/
#       _CANCEL_TIMEOUT_MS（默认 2000 = §7.3）/ _MAX_SEND_RETRIES（默认 2）
```

或显式构造 `new DshA2aClient({ baseUrl, credential, ledger, ... })`；`ledger` 可传文件路径
（默认 `FileTaskLedger`）或宿主自有的 `TaskLedger` 实现（进程内 Map 不允许作为唯一副本）。

## 测试

```powershell
pnpm --dir services/dsh-a2a-client install --frozen-lockfile
pnpm --dir services/dsh-a2a-client run typecheck
pnpm --dir services/dsh-a2a-client run test                # 单元/契约（进程内 mock，ADR-0018 附录 A 方法论）
pnpm --dir services/dsh-a2a-client run test:integration    # 真实 a2a-server 子进程（dsh-worker + 文件 SQLite + 双凭据）
# 或仓库根：pnpm run test:dsh-a2a-client（install + typecheck + 单元 + 集成）
```

集成组（对应 #114 六组验收）：G1 创建/查询/多轮；G2 真实 Worker 执行；G3 取消真实传播
（CANCELED + 执行行 settled/outcome=canceled + worker_id + 退出证据，非"客户端停止等待"）；
G4 首响应丢失幂等恢复（同 messageId 同 Task、唯一执行行）；G5 认证与跨主体拒绝 + 凭据重签；
G6 服务端重启恢复 + SSE 断流重订阅。

## 锁定面

- `@a2a-js/sdk@1.3.0`（精确）、Node `24.x`、TypeScript `5.9.3`（与 P0-02 矩阵一致；升级必须重跑矩阵验证）。
- 隔离包：自带 `pnpm-workspace.yaml`/`pnpm-lock.yaml`，根依赖面零变更（ADR-0013 先例）。
