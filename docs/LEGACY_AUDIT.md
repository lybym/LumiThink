# 旧原型资产审计（LEGACY_AUDIT）

> 版本：v1.0 ｜ 日期：2026-10-13 ｜ 审计范围：根工程 `app/`、`components/`、`lib/`、`prisma/`、既有测试 ｜ 
> 对应：[Issue #12 · R1-00](https://github.com/lybym/LumiThink/issues/12) ｜ [Roadmap R0 交付清单](./ROADMAP.md) ｜ [PRD §1/§7/§13](./PRD.md) ｜ [TECH_STACK](./TECH_STACK.md)  
> 处置图例：**可复用**（保留并继续编译）/ **需重写**（保留外壳或语义，2.0 阶段替换实现）/ **废弃·冻结**（保留文件作历史参照；禁止在新代码中调用或扩展；不删除以便追溯与 R2 迁移）

## 0. 审计结论（TL;DR）

1. 旧原型的 **UI 外壳可复用**，其“数学能力分数 / AI 认知诊断”语义**全部冻结**，不得移植为 2.0 业务事实（强制守卫：`lib/domain/legacy-guard.ts` + 测试）。
2. 旧 `prisma/schema.prisma` 的 `RawEvent` / `CognitiveProfile` 是**废弃·冻结**资产：任何进入新领域模型（`lib/domain/`）的旧形状记录都会被 `LegacyDomainIntakeError` 拒绝；只有显式确认的迁移才会产出**不含分数、不含 payload 内容**的归档工件。
3. R1-00 未修改任何持久化 schema；R2 迁移工具（批量、带审计）仍待建立。

## 1. 逐文件处置清单

### app/

| 文件 | 处置 | 说明 |
| --- | --- | --- |
| `app/layout.tsx` | 可复用 | 全局外壳 + ModeHeader；2.0 文案/元信息在 R1-05 更新；本次仅使其随基线可编译 |
| `app/page.tsx` | 可复用 | Parent/Kid 模式入口；R1-05 重新设计 |
| `app/kid/page.tsx` | 可复用（外壳） | “Math Playground” 属旧数学原型文案；页面**不含**能力分数逻辑；R1-05 以 2.0 儿童端替换 |
| `app/parent/page.tsx` | 需重写 | 文案“AI-powered cognitive diagnosis reports”是旧诊断产品语义，违反 2.0 定位；R1-06 监护人端重做；本次仅保持可编译，不改语义 |
| `app/globals.css` | 可复用 | Tailwind v3 指令；配套新增 `tailwind.config.ts` / `postcss.config.mjs` |
| `app/actions/db-init.ts` | **废弃·冻结** | 创建含 4 项能力分数的 `CognitiveProfile` 种子 = 旧业务事实；无任何 UI 引用；禁止在新代码调用；R2 由领域迁移策略替代 |
| `app/actions/userActions.ts` | **废弃·冻结** | 同上（嵌套创建 Child + CognitiveProfile）；禁止在新代码调用 |
| `app/actions/userActions.utils.js` | 可复用 | 纯函数（合成演示邮箱生成），无业务语义；其 node:test 继续纳入 `pnpm test` |
| `app/actions/userActions.utils.test.mjs` | 可复用 | 既有测试，保留并纳入根工程测试命令 |
| `app/api/health/route.ts` | 新增（R1-00） | 最小健康检查：无需密钥/儿童数据/数据库；环境错误 → 503，只暴露变量名不暴露值 |

### components/

| 文件 | 处置 | 说明 |
| --- | --- | --- |
| `components/kid/visual-math-tool.tsx` | 可复用（占位） | 纯展示（framer-motion + lucide），无数值逻辑；R4 Scene Engine 时评估替换 |
| `components/navigation/mode-header.tsx` | 可复用 | 模式切换导航；R1-05 调整 |

### lib/

| 文件 | 处置 | 说明 |
| --- | --- | --- |
| `lib/db.ts` | **废弃·冻结**（Prisma 单例） | 指向冻结 schema；基线运行时无引用；新领域持久化选型（R1/R2）落定前不得扩散使用 |
| `lib/env.ts` | 新增（R1-00） | 启动环境校验：`NODE_ENV`/`PORT` 白名单；`DATABASE_URL` 仅允许 SQLite `file:`；模型密钥永不被读取或要求 |
| `lib/domain/legacy-guard.ts` | 新增（R1-00） | 新领域模型唯一 intake 边界（详见 §2） |

### prisma/

| 文件 | 处置 | 说明 |
| --- | --- | --- |
| `prisma/schema.prisma` | **废弃·冻结** | `RawEventType`/`RawEvent`/`CognitiveProfile` 为旧数学诊断语义；本次未修改 schema（无 DATA_MODEL 变更、无 migration 需求）；R2 前任何迁移必须经 §2 守卫，且**不得复制无校准浮点分数**（PRD §13、Roadmap R2） |

### 测试资产

| 位置 | 处置 | 说明 |
| --- | --- | --- |
| `tests/domain/legacy-guard.spec.ts` | 新增（R1-00） | 验收标准“旧 CognitiveProfile 分数/RawEvent 不能未经显式迁移进入新领域模型”的直接证据 |
| `tests/domain/boundary.spec.ts` | 新增（R1-00） | 目录边界强制：`lib/domain/` 禁止 import prisma/react/next/`lib/db` |
| `tests/env/startup-env.spec.ts` | 新增（R1-00） | 启动环境校验与“首启零外部要求”证据 |
| `poc/dsh-child/**` | 独立（未触碰） | R0 资产保持隔离；本次改动后 `pnpm run test:r0` 仍为 35/35 PASS、0 SKIP |

## 2. 旧数据进入新领域模型的唯一通道（强制）

```text
旧 CognitiveProfile / RawEvent
        │
        ├─ 直接进入 ingestDomainFact / assertFreeOfLegacyShapes
        │        → LegacyDomainIntakeError（测试强制拒绝，含嵌套走私路径）
        │
        └─ archiveLegacyCognitiveProfile / archiveLegacyRawEvents
                 ├─ 必须显式 acknowledgeLegacyScoresDrop: true + actor + reason
                 ├─ 输出不含任何能力分数字段 / 不含 RawEvent payload 内容（仅计数）
                 ├─ 保留 provenance（来源 schema、childRef 伪匿名引用、actor、时间）
                 └─ 产物自身必须再次通过 intake 守卫（自检）
```

- `childRef` 只允许伪匿名引用；真实儿童姓名/学校/住址/录音/对话**不得**进入公开仓库、Issue、CI 或日志（既有仓库规则，本守卫不放松）。
- `lib/domain/` 依赖冻结由 `tests/domain/boundary.spec.ts` 强制，防止经持久化层或框架层绕过守卫。

## 3. R0 / R1 未完成风险

- 旧 server actions（`db-init.ts`、`userActions.ts`）仍是可编译代码：**废弃但未物理删除**。风险：被后续开发者误用；缓解：本文件 + 路由零引用 + R2 迁移任务应将其删除或替换为迁移脚本（届时删除属于 R2 工作项，不在 R1-00 范围）。
- `prisma generate` 仍会为冻结 schema 生成 client（服务旧 actions 的类型检查）；新领域不得引用 `@prisma/client`（边界测试强制）。
- 本审计不改变任何运行时行为：页面为旧原型外壳，仅达成“可编译、可构建、可启动、健康检查通过”。
- 迁移工具（把冻结库中的历史记录安全导出为归档工件）未实现，属 R2 数据迁移工作项。
