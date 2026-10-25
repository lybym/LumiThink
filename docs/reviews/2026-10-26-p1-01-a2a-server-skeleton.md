# P1-01 A2A 验证服务协议骨架实现记录（issue #83；2026-10-26）

> 关联 Epic：[#78](https://github.com/lybym/LumiThink/issues/78)；阶段：P1-01；前置：[P0 Gate #82 验收索引](2026-10-25-p0-04-p0-gate-acceptance-index.md)（维度 A/C=GO，P1 隔离开发入口已冻结）。
>
> **口径**：全部证据为**合成数据 + 127.0.0.1 回环**（`COMPOSITION_LOCAL`＝本机隔离实跑；`CI`＝Linux runner 工作流）。不含儿童正文、音频、声纹或凭据；不切换现有 UDS；不宣称真实 DSH 执行 Gate（P1-10/#92）通过。依据：[整体方案 §4/§9](../A2A_DESIGN.md)、[Task 契约 §4](../TASK_LIFECYCLE.md)、[P0-02 矩阵 R4/R5/R6/R7](2026-10-25-p0-02-a2a-sdk-compat-matrix.md)、[P0/P1 计划 §P1-01](../P0_P1_PLAN.md)、[ADR-0013](../adr/0013-a2a-server-isolated-package.md)。

## 1. 交付物

| 项 | 内容 |
| --- | --- |
| 服务包 | `services/a2a-server/`（完全隔离 pnpm 包：自带 package.json / pnpm-workspace.yaml / pnpm-lock.yaml；根依赖面与根锁文件零变更，ADR-0013） |
| 服务源 | `src/lumithink-agent-card.ts`（单 Agent `lumithink` 卡）、`src/config.ts`（3312 缺省 + loopback 锁 + fail-closed token）、`src/error-map.ts`（A2A-Version 显式校验 R7、401 bearer 门、-32700 解析错误）、`src/synthetic-executor.ts`（SYNTHETIC 执行器，Task-first + 只追加分片 + lumithinkOutput 元数据）、`src/task-manager-port.ts`（单一 Task Store 权威边界，P1-02 接入点）、`src/a2a-service.ts`（组合根）、`src/main.ts`（独立入口） |
| 测试 | 服务套件 5 spec / 24 用例（官方客户端往返、错误映射、SSE 韧性、契约、独立入口子进程启动）；根守卫 `tests/server/a2a-server-skeleton.spec.ts`（静态：锁定面/隔离文件/合成与 loopback 标注） |
| CI | `.github/workflows/p1-a2a-server-gate.yml`（ubuntu：frozen install → typecheck → 协议套件） |
| 文档 | [services/a2a-server/README.md](../../services/a2a-server/README.md)、[ADR-0013](../adr/0013-a2a-server-isolated-package.md)、[deploy/validation](../../deploy/validation/README.md)（3312 交付状态与 token 模板） |

## 2. 验收条件映射

| Issue #83 AC | 证据（spec/用例） |
| --- | --- |
| 官方独立客户端：发现 Agent Card、发送/流式、GetTask、CancelTask、订阅基本往返 | `official-client-roundtrip.spec.ts` 4 用例（`@a2a-js/sdk/client` ClientFactory 发现卡、阻塞发送返回 Task、流式 task 首帧 + append/lastChunk 事件语义 + COMPLETED、GetTask 分片拼接、CancelTask CANCELED）；`stream-resilience.spec.ts`（活动任务 `resubscribeTask` 订阅） |
| 成功受理关联 Task；参数/认证失败标准错误；Skill 非授权依据 | `protocol-errors.spec.ts`：Task-only 线形（`result` 仅含 `task` oneof）；无效参数 -32602 且 store 计数为 0；认证失败 HTTP 401 + JSON-RPC error（`reason: AUTHENTICATION_REQUIRED`，`domain: lumithink.a2a`）且不建 Task；未知/任意 skill 与已声明 skill 接受结果一致、无凭据时 skill 不授予 |
| SSE 断开不默认取消；终态订阅按标准返回；客户端 GetTask 恢复 | `stream-resilience.spec.ts`：断开 250 ms 后任务保持非终态（未取消）、显式 CancelTask 才结算；终态订阅 -32004（fixture 10）+ GetTask 快照恢复；R8 一致 |
| SDK handler/Task Store 接入 Task Manager 边界；合成通过≠真实 Gate | `src/task-manager-port.ts` 单一 store 接线 + `protocol-errors.spec.ts` RecordingTaskStore 证明 handler 只经该实例写入；执行器显式 SYNTHETIC 标注 + 根守卫静态断言；不宣称 #92 Gate |

## 3. 锁定面

| 项 | 值 | 依据 |
| --- | --- | --- |
| A2A 规范 / SDK | v1.0.1；`@a2a-js/sdk@1.3.0`（npm 精确 pin） | P0-02 矩阵 §1（升级必须重跑该矩阵） |
| 服务端框架 | `express@5.1.0`（peer，精确 pin）；TypeScript `5.9.3`；Node `24.x` | 仓库工具链 pin |
| 协议版本 | Agent Card `supportedInterfaces[].protocolVersion: "1.0"`；`A2A-Version: 1.0` 显式校验（缺失按 0.3 拒绝 → `-32009`，fixture 12 语义，R7） | fixtures README |
| 端口/绑定 | `127.0.0.1` 硬锁；缺省 3312（`deploy/validation` 预留） | #81 §P0-03、#82 §7 |
| 错误码 | -32001/-32002/-32004/-32009/-32602/-32700 由锁定 SDK + 中间件产生；认证失败 -32000（JSON-RPC 实现定义段）+ `AUTHENTICATION_REQUIRED`，真实双层身份映射归 P1-03/#85 | fixtures 08–12、本文 §5 |

## 4. 可复现命令与结果（COMPOSITION_LOCAL，本 PR 工作树）

| # | 命令（仓库根） | 结果 |
| --- | --- | --- |
| 1 | `services/a2a-server`: `pnpm install --frozen-lockfile`（生成/校验自带锁文件，lockfileVersion 9.0，pnpm 10.34.7 兼容） | OK（82 包） |
| 2 | `node node_modules/typescript/bin/tsc --noEmit -p services/a2a-server/tsconfig.json`（等价 `pnpm --dir services/a2a-server run typecheck`） | exit 0 |
| 3 | `node --experimental-strip-types --test --test-isolation=none --test-timeout=60000 services/a2a-server/tests/official-client-roundtrip.spec.ts services/a2a-server/tests/protocol-errors.spec.ts services/a2a-server/tests/stream-resilience.spec.ts services/a2a-server/tests/service-contract.spec.ts services/a2a-server/tests/service-entry.spec.ts`（等价 `pnpm --dir services/a2a-server run test`） | **24/24 pass / 0 fail / 0 skip（≈1 s）** |
| 4 | 服务入口冒烟：`LUMITHINK_A2A_VALIDATION_TOKEN=<synthetic>` + `LUMITHINK_A2A_VALIDATION_PORT=3312` 启动 `src/main.ts` | 监听 `127.0.0.1:3312`；`GET /.well-known/agent-card.json` → 200 `lumithink`；无凭据 `POST /` → HTTP 401 + JSON-RPC error `AUTHENTICATION_REQUIRED`；SIGTERM 干净退出（同一行为已由 `service-entry.spec.ts` 子进程用例自动化） |
| 5 | 根侧本机复跑：全量 `pnpm test`（106 spec，含新守卫）、`tsc --noEmit`、`next build` | **998 tests / 990 pass / 0 fail / 8 skip（既有 skip）/ exit 0**；tsc exit 0；build 见本 PR Checks（CI 全量承担） |

## 5. 设计取舍（实现层决策，均不改变冻结设计）

1. **载体**：`services/` 隔离包而非根 `lib/`——根依赖面冻结（release 演练 fail-closed）与 SDK 锁定面独立演进；见 ADR-0013。根 `tsconfig.json` 增加 `services` exclude（与 `poc` 同待遇）。
2. **认证错误形态**：A2A v1.0.1 JSON-RPC 无专用未授权错误码；P1-01 采用 HTTP 401 + JSON-RPC error `-32000`（标准 server-error 段）+ `google.rpc.ErrorInfo(reason=AUTHENTICATION_REQUIRED, domain=lumithink.a2a)`。该形态为合成验证门约定，P1-03/#85 落地双层身份时可修正映射，不构成协议扩展。
3. **`AgentCard` 形态**：SDK 1.3.0 类型为 proto 生成风格（字段全必填、oneof `$case`、数值枚举）；服务端按运行时形态构造（`Role.ROLE_USER` 数值枚举、Part `$case` oneof），与 P0-02 R4 一致；测试经官方客户端再解码，静默损坏会显式失败。
4. **停机语义**：`stopA2aService` 在 `server.close()` 前调用 `closeAllConnections()`——验证服务为临时进程，被客户端半途放弃的 SSE 流不承诺跨停机恢复（持久化 Outbox/重连归 P1-06/#88）。
5. **SDK 日志噪音**：终态订阅 -32004 路径 SDK 内部打印 `Pre-stream error ...`（与 P0-02 R7 记录的 "Unhandled error" 同类日志噪音）；响应仍是标准 JSON-RPC error，行为正确，噪音治理不阻塞。
6. **入口测试平台差异**：`service-entry.spec.ts` 对 SIGTERM 的"exit 0"断言仅在 POSIX 可交付（Windows 无可投递 SIGTERM，Node 无条件终止子进程）；Windows 上断言终止事件本身，Linux CI（`p1-a2a-server-gate`）证明干净退出路径。

## 6. 局限与未关闭风险（全部保留，不计为通过）

| 项 | 状态 | 责任 |
| --- | --- | --- |
| 合成执行器仅证明协议/传输 | 明确边界，不代表真实 DSH 执行 | P1-02/#84（Task Manager）→ P1-05/#87（真实 Worker）→ #92 Gate |
| 任务状态仅进程内存（SDK InMemoryTaskStore） | 无持久化；重启即失 | P1-02/#84 SQLite 统一仓储 + 事务 Outbox |
| 认证为单凭据合成门（HTTP 401/-32000） | 无 Client/Principal 双层、无租户/属主隔离 | P1-03/#85 |
| 无持久 Outbox/重连水位；分片聚合为应用契约未实现 | 快照保留 SDK 默认分片 parts（R5 记录的行为） | P1-06/#88 |
| CancelTask 竞态族（取消×派发/完成、重复取消幂等、超时结算）仅覆盖 fixture 08/09 分支 | 完整语义族与真实取消证据 | P1-07/#89 |
| Python 官方客户端互通未在本 PR 重跑 | P0-02 已实测（JS 服务端 × Python 客户端）；服务形态与 P0-02 同一 SDK 版本 | P1-10/#92 汇总验收可复跑 |
| 验证环境 3312 实际启动 | 仓库交付入口已就绪；环境内启动属运营动作 | 运营者（deploy/validation） |

## 7. 诚实边界声明

- 本 PR **不宣称**：A2A 服务"可运行于生产"、真实 DSH 执行闭环、Task Manager 持久化、真实取消通过、P1 Gate 通过。
- 本 PR **不修改**：现有 UDS 链路、根依赖面、`prisma/schema.prisma`、既有 100 次竞态基线、fixtures 01–12。
- 所有公开内容为合成样例；Mock / 真实 Worker / 真实模型 / 实机证据分级互不代领。
