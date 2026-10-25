# ADR-0013：A2A 验证服务的隔离包载体

- 日期：2026-10-26
- 状态：Accepted（P1-01/#83 实现依据）
- 依据：[整体方案 V1.1](../A2A_DESIGN.md)、[Task 契约 V1.0](../TASK_LIFECYCLE.md)、[P0-02 兼容矩阵](../reviews/2026-10-25-p0-02-a2a-sdk-compat-matrix.md)、[P0-04 验收索引](../reviews/2026-10-25-p0-04-p0-gate-acceptance-index.md)、[ADR-0012](0012-a2a-family-agent.md)。

## 决策

P1 阶段的 LumiThink A2A 验证服务（P1-01/#83 起，后续 P1-02 Task Manager 等承接）以**完全隔离的 pnpm 包**为载体：`services/a2a-server/`，自带 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`，不进入根工作区；根 `package.json` 只允许 script 级引用（`test:a2a-server`），根依赖面（dependencies/devDependencies/engines/packageManager）与根锁文件保持不变。

服务本体只绑定 `127.0.0.1`，缺省端口为 `deploy/validation` 预留的 3312（`LUMITHINK_A2A_VALIDATION_PORT`/`LUMITHINK_A2A_VALIDATION_TOKEN` 环境配置，无 token 拒绝启动）。

## 理由

1. **CI 依赖面冻结是既有硬约束**：`r1-release-gate` 的升级/回滚演练对根依赖面与根锁文件在 N→N+1 之间做 fail-closed 字节比较；根 `tsconfig.json` 的 `include: **/*.ts` 需要显式 exclude 才能不把隔离包纳入根类型检查。P0-02（`poc/a2a-compat`）已用同一隔离先例合入 main。
2. **SDK 锁定面**：`@a2a-js/sdk@1.3.0`、`express@5.1.0` 在 P0-02 完成编解码/线级/跨 SDK 互通实测并登记 R1–R9 适配风险；隔离包让该锁定面独立演进，升级时单独重跑矩阵验证。
3. **P1 合成口径边界**：P0 Gate（#82）仅开启 P1 合成验证；A2A 验证服务在真实执行 Gate（#92）前不得进入生产拓扑。隔离包使"验证服务"与生产应用（Next.js 根）的部署、审计与回滚边界保持物理分离，服务被显式标注 SYNTHETIC。

## 边界与后续

- P1-02/#84 的 SQLite Task Manager 通过 `services/a2a-server/src/task-manager-port.ts` 声明的单一 Task Store 边界接入（SDK handler 只接一个权威 store，不双写）；是否迁移目录由该任务评估，本 ADR 的隔离约束继续有效。
- 服务监听 3312 属隔离验证环境；生产部署、域名、TLS 终端与 systemd 单元不在本 ADR 范围。
- 此决策不批准上线、Tag 或 Release；不改变 ADR-0012 的任务权威与取消语义。
