# TTS 备份分支集成与部署差异（2026-10-25）

本记录区分仓库代码合并与现网迁移：备份分支的有效修复经修订和回归纳入仓库；实际 v0.9.8 部署的差异继续由 P0-01 #79 核对。本次不变更仓库钉死的版本，不切换服务，不将代码合并视为 P0 Gate、A2A 或实机验收。

## 保存与集成来源

本地原 TTS HEAD e6a5813051d72d23adf7f88254fb9bcc50a2c1e2 与原远端 PR #76 HEAD 038ea58ff44eb1dea60ea9e8d4a8c517e5861981 的 tree 均为 d79bfc33fc34879859d43ab4b91d7ab9d01dd8e2。提交历史不同，已提交内容相同。

原未提交成果保存为备份提交 3ea17ee8e0834a242958784a7d4e546d841ab0a4。备份分支先合入 PR #76 的修订候选和最新 main，再补充下述安全修复，通过正式 PR 集成。运维记录冲突采用包含原全部正文及最新说明的版本，没有丢弃旧记录。

完整 Git bundle、原始11个文件、SHA-256清单、补丁、运行源码快照及分支清理清单位于本地 C:/CODE/_backups/LumiThink/20261025-branch-cleanup/。旧设计草稿另存副本和具名 stash；生成内容和依赖未提交。清理后的分支仍可由 bundle 恢复。

## 进入仓库的有效改动

| 改动 | 结果 |
| --- | --- |
| 桥接正文只有一个入队方 | Provider 只 yield 准入正文，小智原生 chat 管理 FIRST/TEXT/LAST |
| 有界取消检查和交付统计 | 等待中可退出；实际播放统计完成前保留原 gateway turn |
| Worker 启动握手 | create/followup 等待 ready；独立启动超时，停止验证保留短截止时间 |
| 真实模型出口接线 | 默认 Mock；真实供应商配置仍受显式激活、预算和数据外发门禁约束 |
| 网关致命异常退出 | 停止接入、清理资源、5秒截止时间内非零退出，交由 supervisor 重启 |
| 日志最小化 | 致命异常只记固定原因；不打印异常正文、堆栈、控制回复 message 或 Worker stderr 正文 |
| 有限空闲回收 | 保留120秒默认限额，排除启动中、控制请求中和活动执行；回收通过 quarantine 通知 Bridge，允许同一逻辑会话重建 |

没有复制部署侧关闭回收的 Infinity 设置，也没有未经验证自动加入重注册补丁。旧 Research Library README 拆分分支只归档，其知识包接入描述没有覆盖新 ChildEvidence 只读方案。

## 验证

本次本地针对性验证为23项：桥接3项、部署合同4项、Worker启动/失败/空闲回收10项、网关进程退出6项。覆盖致命异常、未处理拒绝、清理挂起/失败、重复错误和信号退出；子进程错误带合成私人标记，断言输出不泄漏该标记。空闲回收验证重建成功且不杀死静默的活动轮次。

根工程、dsh-child 和 gateway-host TypeScript 检查通过。完整根工程回归为980 PASS、0 FAIL、8 SKIP；8项为Windows上预期跳过的POSIX套接字场景，必须由Linux CI验证。锁定工具链上的 CI 结果以合并 PR 对应提交为准，不得引用旧 HEAD 的成功代替新增提交验证。本机 Node 为24.22.1，锁定 CI 为24.21.0 / pnpm10.34.7，未升级锁文件。

Windows本地使用 LF 检出内容匹配 Linux CI，避免旧测试按原始换行切片时受 CRLF 影响；不改变配置语义。脚本 Worker 与合成供应商不代表真实儿童数据、语音设备或 A2A 已验收。

## 继续由 P0 关闭的部署差异

1. 仓库版本仍为 v0.9.7 / 27399a2fb64b5910196f438a256ce0a9f868481f；运行记录为 v0.9.8 / 8f2dda09cf18f1c1ece0f906eee4cc2fabb7fb58。迁移时必须一起核对安装器、覆盖注册表、协议扩展点和回滚，不仅改版本号。
2. 部署 Bridge 保存 hello 参数，并在 connection_unknown 时重注册、重试一次。仍需验证凭据、会话归属、重复网关重启和幂等重试，再决定统一实现。
3. 部署 Worker 关闭空闲回收；仓库已修复有限回收与会话恢复，需再验证部署侧长闲置、容量和多用户行为后统一配置。
4. 运行目录尚需在独立部署步骤采纳本次致命异常退出策略；本次仅合并源码。
5. 10月25日官方双流 TTS 重整、上游夹具、维护测试及安装入口仍在部署目录，尚需形成仓库可重建交付。

launcher 实际在 data/lumithink-runtime/lumithink 启动；顶层备用 gateway-host.ts / real-agent-port.ts 不能作为执行代码权威。选定文件的路径与哈希已保存，不读取或提交配置凭据。

维护记录报告31项覆盖回归和三项真实TTS接口场景通过；本次只核对结果、源码和哈希，没有重跑或调用真实供应商。当前火山覆盖文件 SHA-256 为 471a726c66a46b0bee606e7aa689597f1c75997e2372dbfb58841a03c36a4723。旧逐文本项独立会话已被后续官方双流重整替代，不能作为当前实现或厂商强制协议结论。

后续：[P0-01 #79](https://github.com/lybym/LumiThink/issues/79) 汇总差异（矩阵见 [P0-01 源码清单冻结矩阵](2026-10-25-p0-01-source-freeze-matrix.md)）；[P0-02 #80](https://github.com/lybym/LumiThink/issues/80) 锁定版本矩阵；[P0-03 #81](https://github.com/lybym/LumiThink/issues/81) 验证重建及回滚。这些工程任务保持开放，设计仍以 [A2A_DESIGN](../A2A_DESIGN.md) 和 [TASK_LIFECYCLE](../TASK_LIFECYCLE.md) 为准。
