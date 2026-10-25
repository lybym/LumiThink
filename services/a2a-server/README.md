# @lumithink/a2a-server — LumiThink A2A 验证服务（P1-01，issue #83）

独立服务入口：官方 `@a2a-js/sdk@1.3.0` 服务端 + Agent Card + JSON-RPC over HTTPS/SSE + 标准错误映射 + Task-only 业务适配边界。**全部为合成口径**：合成执行器仅验证协议与传输，不代表真实 DSH 执行（真实执行 Gate 归 P1-10/#92）。

本包完全隔离于根工作区（自带 `pnpm-workspace.yaml` / `pnpm-lock.yaml`，根依赖面零变更），理由与边界见 [docs/adr/0013](../../docs/adr/0013-a2a-server-isolated-package.md)。

## 运行

```powershell
pnpm --dir services/a2a-server install --frozen-lockfile
$env:LUMITHINK_A2A_VALIDATION_TOKEN = '<>=16 chars synthetic token>'
$env:LUMITHINK_A2A_VALIDATION_PORT = '3312'   # 缺省即 3312（deploy/validation 预留）
pnpm --dir services/a2a-server run start
```

- 只绑定 `127.0.0.1`（硬编码，`src/config.ts`）；无 token 拒绝启动（fail-closed）。
- 验证环境归属：[deploy/validation/README.md](../../deploy/validation/README.md)（3311=验证应用，3312=A2A 验证服务）。

## 测试

```powershell
pnpm --dir services/a2a-server run typecheck
pnpm --dir services/a2a-server run test
# 或仓库根：pnpm run test:a2a-server（install + typecheck + test）
```

CI 承载：`.github/workflows/p1-a2a-server-gate.yml`（ubuntu，frozen install → typecheck → 协议套件）。

## 套件覆盖（对应 Issue #83 验收条件）

| spec | 覆盖 |
| --- | --- |
| `tests/official-client-roundtrip.spec.ts` | AC1：官方独立客户端发现 Agent Card、阻塞/流式发送（task 首帧、append/lastChunk 只在更新事件）、GetTask 快照恢复、CancelTask |
| `tests/protocol-errors.spec.ts` | AC2：标准错误映射（-32001/-32002/-32004/-32009，冻结 fixtures 08–12 语义）、认证/参数失败不建 Task、Task-only 线形、Skill 声明不作授权依据、单一权威 store 接线 |
| `tests/stream-resilience.spec.ts` | AC3：SSE 断开不默认取消、终态订阅标准错误 + GetTask 恢复、活动任务重订阅 |
| `tests/service-contract.spec.ts` | 配置契约（3312 缺省、loopback 锁、fail-closed token）、Agent Card 单 Agent 契约、A2A-Version 显式校验（R7） |
| `tests/service-entry.spec.ts` | 独立入口子进程启动（banner SYNTHETIC 标注、卡发现、bearer 门、SIGTERM 干净退出） |

## 边界（本包不做）

- 不接真实 DSH Runtime / Runtime Bridge / 模型；执行器为 `src/synthetic-executor.ts`（显式 SYNTHETIC 标注）。
- 不做 OpenAI-compatible 入口；不拆 Companion/Learning（单 Agent `lumithink`）。
- 不做 SQLite Task Manager / 请求账本 / Outbox（P1-02/#84 从 `src/task-manager-port.ts` 边界接入）；不做双层身份（P1-03/#85）；持久化输出 Outbox 与重连（P1-06/#88）；CancelTask 语义族与真实取消证据（P1-07/#89）。
- 不切换现有 UDS 链路；不使用真实儿童数据；不发布。

## 锁定面

- `@a2a-js/sdk@1.3.0`、`express@5.1.0`、Node `24.x`、TypeScript `5.9.3`（与 P0-02 矩阵一致；升级必须重跑该矩阵验证）。
- Agent Card `protocolVersion: '1.0'`；`A2A-Version` 头显式校验：缺失按 0.3 拒绝 → `-32009`（fixture 12，R7）。
