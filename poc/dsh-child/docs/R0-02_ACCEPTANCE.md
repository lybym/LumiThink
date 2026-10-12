# R0-02 验收摘要 — DSH SDK E2E 零 SKIP 验收与 Windows/Linux CI 门禁

> Issue: <https://github.com/lybym/LumiThink/issues/8>
> 前置: [R0-01 PoC](../README.md) · [Issue #6](https://github.com/lybym/LumiThink/issues/6) · [PR #7](https://github.com/lybym/LumiThink/pull/7)
>
> **本文件属于 `poc/dsh-child` 隔离范围，只记录合成数据（`child_demo_001`）的运行证据。
> 禁止在此记录任何真实儿童数据、真实模型 API Key 或敏感载荷。**

## 1. 结论

| 项目 | 结果 |
| --- | --- |
| R0 验收套件总数 | **35** |
| PASS | **35** |
| FAIL | **0** |
| ERROR | **0** |
| SKIP | **0**（R0-01 遗留的 4 项测试全部实机执行） |
| 门禁 | PASS（报告基线 + 零 SKIP + 4 项必需测试 + 意外外发阻断） |

R0-01 在受限沙箱中因 piped stdio 不可用被 SKIP 的 4 项测试，本次在固定 Node/pnpm 与
隔离 `DSH_HOME` 下**全部实际执行并 PASS**：

| # | 测试 | 文件 |
| --- | --- | --- |
| 1 | completes synthetic multi-turn text with streamed events | `tests/contracts/sdk.e2e.spec.ts` |
| 2 | refuses further runs after close() and leaves no running subprocess | `tests/contracts/sdk.e2e.spec.ts` |
| 3 | routes every model request to the local synthetic mock only | `tests/contracts/sdk.e2e.spec.ts` |
| 4 | fails closed when the model requests the unmounted bash tool | `tests/security/negative-tool.spec.ts` |

## 2. 环境（本地证据）

| 项目 | 值 |
| --- | --- |
| 操作系统 | Windows（win32-x64） |
| Node | **v24.21.0**（固定，`package.json` `engines.node: "24.x"`） |
| pnpm | **10.34.7**（issue 要求的 pnpm 10 线；pnpm 11 会改变 lockfile/install 语义） |
| lockfile | `pnpm-lock.yaml`，`lockfileVersion: '9.0'`，`--frozen-lockfile` 安装通过（无改动） |
| DSH | `@deepseek-ai/dsh` / `-sdk-client` / `-subprocess` = **0.2.0-rc.2** |
| 模型路由 | 仅本机合成 Messages mock（`127.0.0.1:<临时端口>`），无任何真实 API Key |
| DSH_HOME | 每次运行使用**全新的临时目录**（`<tmp>/lumithink-child-home-*` 或显式的 `DSH_HOME`），从不读取开发者真实的 `~/.dsh` |

执行命令（仓库内 `poc/dsh-child`）：

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test:r0:run        # 生成 reports/r0-01-acceptance.xml
pnpm run test:r0:gate       # 写入报告合同 + 基线/零 SKIP/4 项必需测试门禁（fail-closed）
pnpm run test:r0:gate-tests # 证明门禁本身在缺失/空/不可解析/不一致/跳过报告上会 BLOCK
pnpm run test:r0:egress     # 意外外发（非 loopback 模型端点）阻断
```

`pnpm run test:r0` 串行执行上述四步（测试 → 合同+门禁 → 门禁自证 → 外发守卫）。

## 3. 35 项测试清单（本次本地运行）

| # | 结果 | 测试 | 文件 |
| --- | --- | --- | --- |
| 1 | PASS | completes synthetic multi-turn text with streamed events | `tests/contracts/sdk.e2e.spec.ts` |
| 2 | PASS | refuses further runs after close() and leaves no running subprocess | `tests/contracts/sdk.e2e.spec.ts` |
| 3 | PASS | routes every model request to the local synthetic mock only | `tests/contracts/sdk.e2e.spec.ts` |
| 4 | PASS | pins the exact verified DSH versions | `tests/manifest.spec.ts` |
| 5 | PASS | declares a zero-bundle explicit profile backed by a committed lockfile | `tests/manifest.spec.ts` |
| 6 | PASS | runs on a compliant Node and never touches real data | `tests/manifest.spec.ts` |
| 7 | PASS | pins the exact Node and pnpm builds the R0 evidence was produced with | `tests/manifest.spec.ts` |
| 8 | PASS | streams Anthropic-Messages-shaped SSE frames over /v1/messages | `tests/mock-model.spec.ts` |
| 9 | PASS | answers non-streaming requests with a complete message object | `tests/mock-model.spec.ts` |
| 10 | PASS | records every request sanitized and rejects unmocked paths | `tests/mock-model.spec.ts` |
| 11 | PASS | records the x-api-key credential in sanitized form only | `tests/mock-model.spec.ts` |
| 12 | PASS | pins DSH_HOME inside the isolated PoC work dir, never a real Harness home | `tests/privacy/child-env.spec.ts` |
| 13 | PASS | carries no real DeepSeek credentials | `tests/privacy/child-env.spec.ts` |
| 14 | PASS | opts the child out of telemetry | `tests/privacy/child-env.spec.ts` |
| 15 | PASS | never forwards secret-shaped variables from the parent | `tests/privacy/child-env.spec.ts` |
| 16 | PASS | routes the model adapter only to the local mock | `tests/privacy/child-env.spec.ts` |
| 17 | PASS | allows the loopback synthetic mock and the loopback discard fallback | `tests/security/egress-guard.spec.ts` |
| 18 | PASS | blocks the public DeepSeek and OpenAI model endpoints | `tests/security/egress-guard.spec.ts` |
| 19 | PASS | blocks a private-network or metadata endpoint that is not loopback | `tests/security/egress-guard.spec.ts` |
| 20 | PASS | blocks an empty, unparseable, or non-http route | `tests/security/egress-guard.spec.ts` |
| 21 | PASS | blocks https on loopback because the synthetic mock is plain http | `tests/security/egress-guard.spec.ts` |
| 22 | PASS | resolves the composed profile route to loopback and blocks a drifted literal | `tests/security/egress-guard.spec.ts` |
| 23 | PASS | blocks a child environment carrying a real credential | `tests/security/egress-guard.spec.ts` |
| 24 | PASS | accepts sanitized mock records and blocks a non-synthetic credential record | `tests/security/egress-guard.spec.ts` |
| 25 | PASS | throws a blocking violation instead of passing when any finding exists | `tests/security/egress-guard.spec.ts` |
| 26 | PASS | fails closed when the model requests the unmounted bash tool | `tests/security/negative-tool.spec.ts` |
| 27 | PASS | blocks an unmounted pwsh tool through the same fail-closed path | `tests/security/negative-tool.spec.ts` |
| 28 | PASS | keeps the piped-stdio probe fail-closed (a SKIP is never acceptable evidence) | `tests/security/negative-tool.spec.ts` |
| 29 | PASS | mounts exactly the explicit allowlist rows | `tests/security/profile-whitelist.spec.ts` |
| 30 | PASS | never mounts a dangerous, upload, telemetry, or plugin-management service | `tests/security/profile-whitelist.spec.ts` |
| 31 | PASS | mounts every required kernel row enabled | `tests/security/profile-whitelist.spec.ts` |
| 32 | PASS | keeps the agent loop free of subagents | `tests/security/profile-whitelist.spec.ts` |
| 33 | PASS | pins the model adapter to the synthetic mock route, never the public API | `tests/security/profile-whitelist.spec.ts` |
| 34 | PASS | persists sessions only under the isolated DSH_HOME | `tests/security/profile-whitelist.spec.ts` |
| 35 | PASS | materializes the profile into an empty home and dumps the allowlist | `tests/security/profile-whitelist.spec.ts` |

其中 #1–#3、#26 为 R0-01 曾 SKIP 的 4 项；#4–#7、#11、#27、#28、#17–#25 为本次新增。

## 4. 负向权限测试的副作用证据（Issue #8 AC-A 第 5 条）

`tests/security/negative-tool.spec.ts` 不再只断言输出中不出现某个字符串，而是同时给出三类独立证据：

1. **副作用金丝雀（物理证据）**：合成模型要求未挂载的 `bash` 执行
   `mkdir -p "<临时目录>" && echo compromised > "<临时目录>/pwned.sentinel"`。
   运行后断言该 sentinel 文件**不存在**、金丝雀目录**为空**；并额外证明该路径**可写**
   （测试自己写入再删除），使"文件不存在"不是空泛断言。
2. **注册表证据（能力证据）**：模型请求中 `advertisedTools` 始终为 `[]`；
   `--dump-config` 组合树中**不存在任何 tool / terminal / subprocess / mcp 提供者**，
   运行时没有任何可派发的目标。
3. **事件流证据（协议证据）**：运行时**记录**了未授权尝试的 `tool/call` 帧
   （审计轨迹），并对每次尝试返回**错误**帧
   `ToolNotFoundError` / `UNKNOWN_TOOL` / `isError: true` / `"Error: unknown tool "bash""`；
   不存在任何 `terminal/*`、`subprocess/*` 或输出帧，错误帧中不含命令输出。
   另有一项独立用例以 `pwsh`（另一族未挂载 shell）复现同一条 fail-closed 路径。

## 5. CI 门禁（GitHub Actions）

工作流：`.github/workflows/r0-zero-skip-gate.yml`

- 覆盖 `ubuntu-latest` **与** `windows-latest`（`fail-fast: false`）。
- 路径触发：`poc/dsh-child/**`、工作流自身、`pnpm-lock.yaml`、`pnpm-workspace.yaml`；
  在 `pull_request` 与 `main` push 上运行（另含 `workflow_dispatch`）。
- 精确安装 Node `24.21.0` 与 pnpm `10.34.7`，并在安装后**断言实际版本**与固定值一致。
- `pnpm install --frozen-lockfile` → `pnpm run typecheck` → R0 套件 → 报告合同 + 零 SKIP 门禁
  → 门禁自证 → 意外外发守卫。
- `permissions: contents: read`、`timeout-minutes: 30`、不使用任何真实模型/API Key
  （`DEEPSEEK_API_KEY=dsh-poc-synthetic-key`）、隔离 `DSH_HOME`。
- 成功与失败均上传**脱敏**报告与诊断工件（`if: always()`，保留 14 天）；
  上传工件失败不至于让必要检查通过（`Fail the job if any gate step failed` 统一判定）。
- 无产物 / 空报告 / 截断报告 / 不可解析报告 / 缺失必需测试 / 出现 skip 一律 fail-closed。

| 平台 | 状态 | Run URL |
| --- | --- | --- |
| ubuntu-latest | _待本次 PR HEAD 的 CI 结果回填_ | _回填_ |
| windows-latest | _待本次 PR HEAD 的 CI 结果回填_ | _回填_ |

PR 与最终 HEAD SHA：_待回填_。

## 6. 防回归与组合配置检查（`--dump-config` 组合树）

| 检查项 | 证据 |
| --- | --- |
| 完整 Cordis Profile 白名单 | `mounts exactly the explicit allowlist rows`（组合后只允许显式 10 行 + 伴生行） |
| 子代理禁用 | `keeps the agent loop free of subagents`（`agent-loop.config.agents === []`） |
| 上传插件禁用 | `never mounts a dangerous, upload, telemetry, or plugin-management service`（`dsh-session-log-deepseek` 不在组合树中） |
| 遥测/反馈插件禁用 | 同上（`*-telemetry-otel`、`message-feedback`、`command-feedback` 均不在组合树中） |
| Plugin Manager 禁用 | 同上（`dsh-plugin-manager`、`dsh-plugin-package-inventory-deepseek` 均不在组合树中） |
| 模型工具列表为空 | `advertisedTools === []`（SDK E2E 与负向权限测试断言） |
| 模型路由仅 loopback | `pins the model adapter to the synthetic mock route, never the public API` + 意外外发守卫 CLI |
| Shell/FS/Sandbox 未挂载 | 白名单断言：`sandbox-local`、`sandbox-policy`、`subprocess-local`、`terminal*`、`tool-bash*`、`tool-pwsh*`、`tool-fs*`、`tool-web`、`tool-subagent*` 均不在组合树中 |

组合树的模型适配器路由解析为
`process.env.DSH_POC_MOCK_BASE_URL ?? 'http://127.0.0.1:9'`：两个分支都是 loopback，
变量缺失时回落到必然失败的 discard 端口，**永远不会**回落到公网 API。

## 7. 失败分类（不因流程通过而放宽）

| 类别 | 判定 |
| --- | --- |
| 环境限制（如 piped stdio 不可用） | **FAIL**，不得以 SKIP 记成功；`keeps the piped-stdio probe fail-closed` 直接失败 |
| 测试问题（报告缺失/空/截断/不可解析/基线漂移） | fail-closed：`src/report-gate.ts` 抛 `ReportGateError`，`test:r0:gate` 退出码 1 |
| DSH SDK 缺陷（E2E 契约、关闭、事件流） | `tests/contracts/sdk.e2e.spec.ts` 失败即 BLOCK |
| 安全问题（未挂载工具被调用、意外外发、真实凭据） | `tests/security/*` 或 egress 守卫失败即 BLOCK，禁止接入真实儿童数据 |

## 8. 已知限制

- DSH 上游为 Developer Preview，未经安全审计；本次零 SKIP 验收 ≠ 儿童生产环境通过审计。
- 本机内核之外的文件系统/网络/凭据边界仍需在容器与部署层另行强制（R0 任务书 R0-B 末条）。
- 真实 provider 的数据传输不在 R0 范围内，接入前需单独授权审查。
- CI 与本地均在**合成**模型（loopback mock）下运行，不代表真实模型行为。