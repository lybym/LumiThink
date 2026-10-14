# LumiThink 2.0 技术栈与工程基线（TECH_STACK）

> 版本：v0.1 ｜ 日期：2026-10-13 ｜ 状态：**基线已建立（R1-00）**；标注“待定”的项仍未决策  
> 对应：[Issue #12 · R1-00 工程基线与旧原型审计](https://github.com/lybym/LumiThink/issues/12) ｜ [PRD](./PRD.md) ｜ [Roadmap](./ROADMAP.md) ｜ [ADR-001](./adr/0001-deepseek-harness.md) ｜ [架构](./ARCHITECTURE.md) ｜ [旧资产审计](./LEGACY_AUDIT.md)

本文书面确认 R1-00 建立的工程基线。**“已确认”表示基线代码可安装、可编译、可构建、可启动并通过健康检查（Linux CI 演练）；不表示 2.0 产品能力已实现。**

## 1. 已确认的技术栈（本次基线冻结）

| 层 | 选型 | 版本 | 确认证据 |
| --- | --- | --- | --- |
| Web 框架 | Next.js（App Router） | `15.5.27` | 根工程 `next build` + `next start` + `/api/health` 通过（本地 Windows + Linux CI） |
| UI 运行时 | React / React DOM | `19.3.0` | 旧原型页面（儿童/监护人）可编译、可渲染 |
| 语言 | TypeScript（strict） | `5.9.3` | `pnpm run typecheck`（`tsc --noEmit`）通过 |
| 运行时 | Node.js | `24.21.0`（24.x 线） | 与 R0 门禁一致（`engines.node = 24.x`，CI 精确断言） |
| 包管理 | pnpm | `10.34.7`（10.x 线） | 与 R0 门禁一致（`packageManager` 字段 + CI 精确断言；pnpm 11 锁文件语义不同，明确不使用） |
| 样式 | Tailwind CSS v3 + PostCSS + Autoprefixer | `3.4.19` | 旧 `app/globals.css` 使用 v3 指令；v3 行与现有原型兼容，v4 迁移留给 R1-05 UI 重做时评估 |
| 交互动画 | framer-motion | `12.43.0` | `components/kid/visual-math-tool.tsx` 可编译 |
| 图标 | lucide-react | `1.56.0` | `components/navigation/mode-header.tsx` 可编译 |
| 持久化 | SQLite（经 Prisma，**仅冻结的旧 schema**） | `prisma` / `@prisma/client` `6.19.3` | 见 §3；新领域持久化待定，基线启动**不需要**数据库 |
| Agent Runtime | DeepSeek Harness（DSH）SDK | `0.2.0-rc.2`（锁定） | R0 POC（`poc/dsh-child`，35/35 PASS、0 SKIP），保持完全隔离，根工程不依赖 |

## 2. API / DSH SDK 拓扑（书面确认）

**已确认的基线方向：DSH TypeScript SDK 由独立的、长生命周期的 Node 进程持有；Next.js Web 与该进程通过受限 API 交互。**

- 依据：[R0 DSH PoC](./R0_DSH_POC.md) §5 的结论——DSH SDK 会启动子进程，独立长驻进程可避免重复启动、Serverless 短生命周期 API Handler 误起多份 Agent 等问题；R0 的 `poc/dsh-child` 已在独立进程中验证 SDK 行为。
- **同进程方案（Next.js API 内直接管理 SDK 生命周期）记录为备选**，只有当 R1 集成 PoC 证明独立进程带来不必要的运维复杂度时才复议；切换前必须有新的 PoC 证据与本文档修订。
- 实时语音的 Cordis Runtime Bridge 拓扑由 [ADR-002](./adr/0002-voice-runtime-bridge.md) 约束，与上述文字端 API 进程**不共享** Agent 生命周期所有权；两者最终进程部署图在 R1-V/R5 落地时补充。
- 本基线尚未实现任何 API→DSH 集成代码；拓扑确认仅指方向与约束，不表示已验证生产部署形态。

## 3. 数据持久化现状与边界

- `prisma/schema.prisma`（SQLite）是**冻结的旧原型 schema**：`RawEvent` / `CognitiveProfile` 语义不得作为 2.0 业务事实，详见 [LEGACY_AUDIT](./LEGACY_AUDIT.md) 与 `lib/domain/legacy-guard.ts` 的强制守卫。
- 新领域模型（R1 受控记忆、Evidence、Skill 等）的持久化选型（SQLite 直用 / Prisma 新 schema / 其他）**待定**，由 R1/R2 的数据建模任务决策；决策前不得复用旧 schema 表达新语义。
- R1-08（issue #20）引入**加密运行时快照**作为部署层备份（`lib/server/snapshot/`：AES-256-GCM 整档加密 + 原子写；选定事实源 = 进程内组合态）：这是部署基础设施而非新领域 schema，**prisma schema 保持零差异**，无 DATA_MODEL/migration 触发（决策与边界见 [ADR-0006](./adr/0006-deployment-secrets-backup-v0.md) §2.5）。
- 本次基线**未修改**任何持久化 schema，因此无 DATA_MODEL 变更、无迁移、无迁移测试要求（守卫测试即为“旧数据不得进入新领域”的迁移门禁证据）。
- 首次启动不需要 `DATABASE_URL`、真实模型密钥或儿童数据：`lib/env.ts` 校验启动环境，`/api/health` 在空环境下返回 `ok`（CI 以“未设置任何密钥/数据库 URL”的干净环境证明）。

## 4. 目录边界（基线约定）

| 目录 | 归属 | 边界规则 |
| --- | --- | --- |
| `app/` | Next.js 路由与 UI（旧原型外壳 + 新增 `app/api/health`） | 不直接依赖 DSH 内部类型；不得新增对冻结旧 server actions 的调用 |
| `components/` | 旧原型 UI 组件（可复用，待 2.0 重验收） | 不承载业务事实；R4 Scene Engine 时再评估 |
| `lib/domain/` | **2.0 新领域模型唯一入口** | 依赖冻结（测试强制）：禁 import `@prisma/client`、`react`、`next`、`lib/db`；一切进入领域的事实必须经 `ingestDomainFact` / 显式迁移 |
| `lib/`（其余） | 冻结的旧支撑代码（`lib/db.ts`）+ 新增基础设施（`lib/env.ts`、R1-05 起 `lib/server/` 服务端组合根与交互服务，框架无关） | 旧 `lib/db.ts` 不被基线运行时引用；不得在新代码中扩散；`lib/server/` 不得反向进入 `lib/domain` 之外的业务语义 |
| `prisma/` | 冻结旧 schema（历史审计参照） | 修改 schema 必须同步 DATA_MODEL + migration + migration test（本次未触碰） |
| `tests/` | 根工程测试（node:test + TS strip types） | 与 `poc/dsh-child` 的测试体系互不依赖 |
| `poc/dsh-child/` | **完全隔离的 R0 DSH PoC** | 独立 package.json/pnpm-lock/tsconfig/CI 门禁；根工程与其无依赖关系；根 tsconfig 显式排除 |
| `docs/` | 2.0 方案、审计、合同 | 与代码状态分离：未实现的能力不得写为已完成 |

## 5. 根工程命令（本地与 CI 一致）

```bash
# 依赖恢复（postinstall 自动执行 prisma generate；无需 DATABASE_URL）
pnpm install --frozen-lockfile

# 类型检查 / 测试 / 构建
pnpm run typecheck
pnpm test          # 领域守卫 + 环境校验 + 旧工具函数测试（node:test）
pnpm run build

# 最小启动与健康检查（首次启动无需密钥/儿童数据/数据库）
pnpm run start --port 3123
# → GET http://127.0.0.1:3123/api/health 返回 {"status":"ok",...}

# R0 回归（完全独立，保持 35/35 PASS、0 SKIP）
pnpm run test:r0   # 等价于在 poc/dsh-child 内运行原有 test:r0
```

CI 门禁：`.github/workflows/r1-baseline-gate.yml`（Ubuntu：干净环境断言 → frozen install → typecheck → test → build → 启动 + 健康检查）；R0 门禁 `.github/workflows/r0-zero-skip-gate.yml` 保持原样。

## 6. R0 / R1 未完成风险（本次书面标注）

| 风险 | 状态 | 归属 |
| --- | --- | --- |
| R0 容器/部署层最小权限边界（进程外文件系统、网络出口、数据库密钥隔离）未做 | **R1-08 已交付部署层最小权限面**（issue #20）：systemd 受限进程（专用用户/ProtectSystem/无能力集/系统调用过滤/环回绑定）+ Caddy TLS 唯一公网入口 + 端口白名单（[deploy/runbook.md](../deploy/runbook.md)）；DSH 进程内适配器无对外 socket；数据库密钥隔离不适用（SQLite 未启用，启用时随持久化选型重审） | R1-08（已交付）/ R1-10（环境一致性、发布回退） |
| R0-C（双 Skill 纵向闭环）、R0-D（Session/Memory 治理）未开始 | 未完成 | R0 → R1 |
| HARNESS.md 仅为 v0 草案，无实现 | 未完成 | R1-03/R1-07 |
| 新领域持久化选型未定；旧 schema 与新领域之间的数据迁移策略只有“拒绝 + 显式归档”守卫，尚无批量迁移工具 | 未完成 | R1/R2 |
| 真实模型接入、流式、取消、成本控制：R1-02 已交付域层 Model Gateway（`lib/domain/gateway/`：Provider 契约 + Mock + 预算/熔断/超时/取消 + 审计，见 [MODEL_GATEWAY](./MODEL_GATEWAY.md)）；R1-05 已把 Web MVP 文本端点接线到该域层（合同 v1.0 三路由 + SSE 流式 + 取消，Mock 为服务默认，零出网）；真实供应商激活（独立数据外发评审前置）仍未完成 | 部分完成 | R1-02（域层已交付）/ R1-05（Web MVP 接线已交付）/ Iteration B（真实供应商） |
| 真实 DSH SDK 适配器绑定（独立进程拓扑）未完成：R1-05 以确定性进程内适配器绑定 `DshRuntimePort` 支撑 Web MVP 服务（仅会话生命周期面，消除 `no_port_bound` 缺陷窗口），根工程仍零 SDK 依赖；SDK 适配器与其独立验收待进程拓扑工作 | 未完成 | Iteration B / R1-05 后续 |
| 监护人端、鉴权、隐私治理未实现；旧 parent 页面文案仍是旧产品语义 | 部分完成（R1-06 已交付最小监护人鉴权/授权/告知/功能开关与安全审计：`lib/domain/guardian/` + `lib/server/guardian-service.ts` + `/parent` 控制台 + API_CONTRACT §12 + ADR-0003；R1-09 已交付数据生命周期最小实现：记录开关（默认关闭）+ 数据清单/导出/删除/重放 API 与控制台区 + MEMORY_POLICY/PRIVACY_DATA_FLOW 矩阵 + ADR-0005，`lib/domain/lifecycle/` + `lib/server/data-lifecycle-service.ts`；全部进程内内存态。R1-08 已交付部署硬化（issue #20）：真实访问码注入（服务端仅持 SHA-256 摘要）+ Secrets 注册表/审计脱敏 + 每请求 nonce CSP + 加密运行时快照（ADR-0006）；全局锁定语义维持，按账户锁定留作显式后续） | R1-06（最小面已交付）/ R1-09（数据生命周期已交付）/ R1-08（部署硬化已交付）/ 持久化选型（R1/R2） |
| 旧页面在 R1-05 之前仅保证“可编译可启动”，不承诺 2.0 体验；R1-05 已将儿童页重建为 Lumi 对话 MVP（正式交互 API + 流式 + 停止 + 退出路径），旧数学工具移至 `/kid/playground`，parent 页面保持冻结原型 | 部分完成（儿童端已重建） | R1-05（儿童端）/ R1-06（监护人端） |

> 变更本表前先更新对应 Roadmap/Issue；未完成项不得标记为完成。
