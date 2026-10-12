# R0-01 PoC — DSH TypeScript SDK × `lumithink-child` 最小权限 Profile

> Issue: <https://github.com/lybym/LumiThink/issues/6>
> 任务书: [R0 DSH PoC 任务书](https://github.com/lybym/LumiThink/blob/docs/v2-product-roadmap-20261012/docs/R0_DSH_POC.md) · 架构决策: [ADR-001](https://github.com/lybym/LumiThink/blob/docs/v2-product-roadmap-20261012/docs/adr/0001-deepseek-harness.md)
>
> **只使用合成数据（`child_demo_001`）。禁止导入任何真实儿童数据。**

本目录是 LumiThink 首个可隔离的 DSH 运行时 PoC：用固定版本的官方 TypeScript SDK
（`@deepseek-ai/dsh-sdk-client@0.2.0-rc.2`）驱动一个完全隔离的 DSH 子进程，其
Cordis 服务树由**显式白名单**（`profiles/lumithink-child/cordis.patch.yml`）决定。

## 这个 PoC 验证什么

1. **版本可复现**（R0-A）：`runtime-manifest.json` 锁定 `dsh-v0.2.0-rc.2`
   （npm `next` dist-tag 与 GitHub Tag 一致），`pnpm-lock.yaml` 固定依赖树；
   `tests/manifest.spec.ts` 即 CI 可复跑的版本探测命令。
2. **自定义显式 Profile**（R0-B）：不运行官方 `sdk` / `sdk-minimal` / `web`
   Profile。`lumithink-child` 声明 **零 bundle**，全部服务行显式列出：
   SDK JSON-RPC、Agent 内核（agent loop、提示拼装、模型适配、Session）、
   安全 invariants、空工具注册表。
3. **危险能力不挂载**：以下服务**故意缺失**（用 `--dump-config` 的组合结果断言，
   而非源码声明）：
   `session-log-deepseek`（会话日志上传，上游默认 `enabled: true`）、
   `plugin-package-inventory-deepseek`（插件自动安装）、
   `sandbox-local` / `sandbox-policy`（上游默认 `danger-full-access`）、
   `subprocess-local` / `terminal` / `terminal-bash`（PTY/Shell）、
   `tool-bash-persistent` / `tool-pwsh-persistent`、
   `tool-fs*` / `tool-web` / `tool-subagent*`、
   `mcp-resources` / `mcp-client`、全部 feedback / OTel 遥测插件、`hmr`、
   `plugin-manager`。`agent-loop.agents: []` 禁止子 Agent。
4. **数据外发边界**：模型适配器 `baseURL` 只指向 `$DSH_POC_MOCK_BASE_URL`
   （本机合成 Messages mock，`src/mock-model.ts`）；变量缺失时回落到
   `http://127.0.0.1:9`（discard 端口，必然失败关闭），**永远不会**回落到
   公网 DeepSeek API。mock 记录每一次请求（脱敏后）作为外发证据。
   子进程环境通过 `DSH_TELEMETRY_DISABLED=1` 显式关闭遥测。
5. **隔离 DSH_HOME**：子进程 `DSH_HOME` 指向 `<poc>/.r0/dsh-home`（或测试临时
   目录），父环境经 `scrubbedParentEnv` 清洗后只保留 OS 基础变量；不读取开发者
   本机的 `~/.dsh`、插件与凭据。
6. **SDK 契约**：合成多轮文本、流式事件收集、进程关闭（stdin EOF → SIGTERM →
   SIGKILL 阶梯，`close()` 幂等）。

## 运行

```bash
cd poc/dsh-child
pnpm install          # 固定 lockfile 安装；不运行任何依赖构建脚本
pnpm run typecheck    # TypeScript 严格检查
pnpm test             # 完整 PoC 验收套件
pnpm run test:r0      # 同上，并生成 reports/r0-01-acceptance.xml（机器可读 PASS/FAIL）
```

要求：Node >= 22.6.0（`--experimental-strip-types` 的最低版本；验证基线 v24.21.0，win32-x64），pnpm >= 10，能访问 npm registry。
模型请求全部指向本机 mock，**不需要也不使用**任何真实 API Key
（子进程内的 `DEEPSEEK_API_KEY` 是固定占位符 `dsh-poc-synthetic-key`）。

## 清理

```bash
# 删除全部 PoC 运行时状态（隔离 DSH_HOME、mock 记录、验收报告）
rm -rf .r0 reports
# Windows PowerShell:
# Remove-Item -Recurse -Force .r0, reports
```

## 失败时的阻断规则（NO-GO）

任一安全/隐私测试失败即视为 **BLOCK/NO-GO**：

- `tests/security/profile-whitelist.spec.ts` 失败 → 组合后的 Profile 出现了
  白名单之外的服务（危险工具挂载或白名单漂移）。禁止接入真实儿童数据。
- `tests/security/negative-tool.spec.ts` 失败 → 未挂载的工具被模型成功调用。
  禁止接入真实儿童数据，并立即提交架构复议。
- `tests/privacy/child-env.spec.ts` 失败 → 隔离/遥测环境策略失效。
- `tests/contracts/sdk.e2e.spec.ts` 失败 → SDK 契约不可用；先修复再评估。
- `tests/manifest.spec.ts` 失败 → DSH 版本漂移；按 `docs/DSH_UPSTREAM.md`
  的升级评审流程处理，不得自动升级。

不修改 DSH 上游核心；本 PoC 只通过 Profile/Patch 组合能力。若未来需要侵入
上游 Agent Loop 才能实现权限边界，按任务书立即 **BLOCK**。

## 目录结构

```text
poc/dsh-child/
├── profiles/lumithink-child/   # 零 bundle 显式 Profile（package.json + cordis.patch.yml）
├── src/
│   ├── child-env.ts            # 子进程环境清洗与合成路由
│   ├── child-runtime.ts        # SDK 启动封装（隔离 DSH_HOME + Profile）
│   ├── dump-config.ts          # --dump-config 运行/解析（组合树取证）
│   └── mock-model.ts           # 本地合成 Messages mock + 外发记录
├── tests/
│   ├── contracts/              # SDK 多轮/流式/关闭契约
│   ├── security/               # 白名单断言 + 负向工具调用
│   ├── privacy/                # 环境隔离与遥测关闭
│   └── manifest.spec.ts        # 版本锁定探测（CI 可复跑）
├── runtime-manifest.json       # 精确版本 manifest
└── pnpm-lock.yaml              # 依赖锁文件
```

## 已知边界（不因本 PoC 通过而消失）

- DSH 上游为 Developer Preview，未经安全审计；本 PoC 通过 ≠ 儿童生产环境通过审计。
- 本机内核外的文件系统/网络/凭据边界需在容器与部署层另行强制（任务书 R0-B 末条）。
- 正式模型请求的数据传输（真实 provider）不在本 PoC 内；接入前需单独授权审查。
