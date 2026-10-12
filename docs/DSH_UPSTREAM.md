# DeepSeek Harness 上游版本管理与升级策略

> 生效日期：2026-10-12 ｜ 状态：已采用（需要 R0 技术验证和后续细化）  
> 适用：LumiThink DSH Runtime、`lumithink-child` Profile、Cordis 插件、SDK/依赖、会话数据。
>
> 相关：[ADR-001](./adr/0001-deepseek-harness.md) · [ROADMAP](./ROADMAP.md)

## 1. 官方版本基线（2026-10-12 核验）

官方渠道：[DeepSeek Harness Releases](https://github.com/deepseek-ai/deepseek-harness/releases)。

| 分类 | 版本 | 官方时间 | 说明 |
| --- | --- | --- | --- |
| 最新已发布任何预览版 | [dsh-v0.2.1-alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.2) | 2026-10-09 UTC | Alpha：仅技术追踪，默认不发自动提醒 |
| 最新 RC | [dsh-v0.2.0-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2) | 2026-09-29 UTC | 版本监控初始基线 |
| 正式 Stable | 截至此日尚无 | — | 官方发布列表中尚无标记为正式版的 Release |

**这是上游观察基线，不是 LumiThink 已安装/已经通过测试的版本声明。** 项目生产固定版本需要 R0 PoC 结束后记录在部署配置和 lockfile。

## 2. 版本监控规则

- 由对话内已创建的自动版本监控任务，每 **6 小时**检查一次官方 GitHub Releases。
- **提醒范围**：新 `-rc.N`（或同一 RC 系列后续 RC）与标记为正式版的 Release（`prerelease=false` 且无 `alpha/beta/rc/dev/nightly` 后缀）。忽略 Draft 和普通 Alpha/Beta。
- 与上次已提醒版本以及上方 2026-10-12 基线比较，**只有出现新目标版本才通知**。
- 通知包含：版本、时间、官方 URL、核心变更、破坏性变更、Cordis 插件/Profile/SDK/MCP/Session/工具权限/遥测影响、对 LumiThink 的升级建议。
- 监控任务**不提交 PR、不修改仓库、不自动安装、不触发生产部署**。

> 当开发者需要抢先验证 Alpha 修复时，可以手动查看最新 Alpha，但它不属于正常升级通知范围。

## 3. RC 与 Stable 的使用原则

| 阶段 | Alpha | RC | Stable |
| --- | --- | --- | --- |
| 上游跟踪 | 手动关注重大变化 | 自动提醒 | 自动提醒 |
| 隔离 PoC | 允许，有明确实验目的 | 优先评估 | 优先评估 |
| 真实儿童数据 | 默认禁止 | 仅经完整安全隐私审查后才可考虑 | 同样必须审查 |
| 自动进入生产 | 否 | 否 | 否 |
| 回退与版本锁定 | 必须 | 必须 | 必须 |

版本晋升先运行隔离合成数据，再通过相关回归，才讨论是否用于真实数据。官方 Stable 只代表其发布标签，不代表已经适配 LumiThink 或通过儿童安全审核。

## 4. 每个新版本的升级影响矩阵

新版本发布时至少评估下列模块：

| 检查域 | 重点 |
| --- | --- |
| Cordis/Core | 插件注入、生命周期、配置层叠、注册与卸载语义 |
| Agent Loop / Model | Context 组装、系统提示更新、取消语义、重试、工具调用 |
| Profile / SDK | `sdk` 与自定义 Profile 兼容性、初始化/JSON-RPC/流式返回 |
| Session | JSONL 版本/迁移/压缩/Checkpoint/恢复与删除语义 |
| 安全权限 | Tool allowlist、sandbox、HTTP 请求、Shell/FS、子 Agent、自动插件安装 |
| 隐私外发 | `session-log-deepseek`、OTel 反馈、网络端点及模型 API 行为 |
| 外部能力 | MCP、经过审核的 Cordis 插件、技能配置、Node/TypeScript 版本 |
| Lumi 专业层 | Persona、情绪支持/学习启动 Skill、Child Memory、Evidence 与 Eval |

升级流程：

1. 捕获 Release Notes、Git Tag、资产哈希和相关迁移说明。
2. 在独立的临时运行环境安装**精确版本**，保留旧环境不受影响。
3. 验证 Profile 最小权限（不得因为上游新增默认插件而悄悄增加工具）。
4. 跑 SDK/会话/API/Plugin/Schema/迁移兼容测试及儿童安全与隐私回归。
5. 形成兼容性报告：**Accept / Block / Defer**；有风险项必须说明应对。
6. 审阅通过后，人工提交依赖升级 PR，灰度验证并保留回滚版本。
7. 发布后记录运行的 DSH Tag、Lockfile、插件矩阵及测试证据。

## 5. 首次接入的高风险默认设置

官方 [SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md) 披露项目仍为 Developer Preview，未经安全审计。

- `sdk-minimal` 的默认组合仍含持久 Shell 与 `danger-full-access`。**“minimal” 不是“儿童安全最小权限”**。
- 官方 `session-log-deepseek` 文档载明默认 `enabled: true`，正常使用 DeepSeek 官方接口可能附加上传 Session 日志；必须验证关闭该功能。
- 官方 `dsh-base` 文档载明反馈遥测可以包含完整会话前缀；必须禁用不必要的上报。
- 对 Child Memory、Session 和模型 API 的数据处理各自执行授权、保留和删除政策；仅禁用 Telemetry **不等于**禁止模型正常请求携带文本。
- Profile 白名单不仅限制模型可见的 Tool Schema，还应在服务进程、文件系统、网络出口、凭据和数据库访问处实现权限隔离。

## 6. 首次兼容性台账（模板）

| DSH Tag | 类型 | 发现日期 | Profile/插件评估 | 安全测试 | 迁移测试 | 决策 |
| --- | --- | --- | --- | --- | --- | --- |
| dsh-v0.2.0-rc.2 | RC，监控基线 | 2026-10-12 | 待 R0 | 待 R0 | 待 R0 | 尚未升级或投入生产 |
| dsh-v0.2.1-alpha.2 | Alpha，仅参考 | 2026-10-12 | 未验证 | 未验证 | 未验证 | 不作为首选生产基线 |

后续每次升级评审在对应 PR/Issue 保留证据；本文件保留总体政策和经过确认的里程碑。若需要 CI 自动化检查，可后续增加 GitHub Actions 的版本检查，但**不与监控通知混同，也不设置自动生产升级**。
