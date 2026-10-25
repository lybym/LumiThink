# TTS 分支整理与部署差异预核对（2026-10-25）

状态：本地成果已保全，进入 PR #76 评审；**暂缓合并该 PR，P0-01 #79 保持开放**。本记录不表示 P0 Gate、真实设备或发布验收通过。

## 已完成的保存与清理

- 本地原 TTS HEAD 为 `e6a5813051d72d23adf7f88254fb9bcc50a2c1e2`，远端 PR HEAD 为 `038ea58ff44eb1dea60ea9e8d4a8c517e5861981`；二者 tree 均为 `d79bfc33fc34879859d43ab4b91d7ab9d01dd8e2`。属于提交历史不同、已提交内容相同，没有强推覆盖远端历史。
- 9 个源码、测试、运维记录和忽略规则文件保存至远端 `backup/tts-local-20261025`，提交 `3ea17ee8e0834a242958784a7d4e546d841ab0a4`。该分支用于恢复，不能当作已审阅基线。
- 旧设计草稿保存为本地独立文件副本和具名 stash；正式设计保留 main 版本。`.next/`、`*.tsbuildinfo`、依赖目录等生成内容未提交。
- 本地 main 已快进到 A2A 文档基线 `8dcc22abc85bef3fe9b855078247d1b1c653d78b`。24 个已合并分支经 PR 的 head SHA 匹配后清理；资料库拆分旧分支也已归档删除。两条已合并文档远端分支已清理。
- 完整 Git bundle、原始文件 SHA-256 清单、patch、运行代码快照和清理清单位于本地 `C:/CODE/_backups/LumiThink/20261025-branch-cleanup/`。删除的分支可由 bundle 恢复。

## 纳入评审的源码增量

| 增量 | 当前处理 |
| --- | --- |
| 桥接只 yield 正文，由小智原生 chat 管理 FIRST/TEXT/LAST | 保存并补充队列所有权回归，进入 PR #76 评审 |
| 取消检查使用有界轮询，文本结束保留原 turn 直到播放统计完成 | 保存并验证；不将停止本地等待当成真实 Runtime 取消成功 |
| Worker 等 ready 后发送 create/followup，停止验证仍有短截止时间 | 保存并验证；不是 A2A Task 生命周期实现 |
| CI 加入桥接行为测试、Worker ready 测试 | 保存，并覆盖新增 Python 测试路径触发 |
| 旧 Research Library README 拆分说明 | 只归档；不把旧知识包接入描述合并到新 ChildEvidence 只读方案 |

这些增量从远端 PR HEAD 建立的干净工作目录整理，未覆盖运行目录。

## 验证证据与边界

| 检查 | 本次结果 |
| --- | --- |
| `tests/deploy/test_gateway_bridge_tts.py` | 3 PASS；仅标准库，合成输入 |
| `worker-ready.spec.ts` + `real-agent-port-failure-guard.spec.ts` | 8 PASS，0 SKIP；真实父进程适配器 + 脚本测试 Worker |
| `tests/deploy/xiaozhi-gateway-bridge.spec.ts` | 4 PASS，0 SKIP |
| dsh-child TypeScript 检查 | PASS |
| gateway-host 限定范围 TypeScript 检查 | PASS |

共 15 项行为/部署断言和两项 TypeScript 检查。本机 Node 为 24.22.1；复用已安装依赖，未升级锁文件。官方工程工具链为 Node 24.21.0 / pnpm 10.34.7，最终 CI 以锁定版本为准。Windows 检出配置模板产生 CRLF，使旧测试的原始 `\n` 字符串切片首次失败；仅在隔离工作目录还原该模板的 LF 后，4 项通过，配置内容没有变更。

当前测试不证明真实 DSH 模型完整链路、ASR、人声、设备扬声器、房间 AEC 或 A2A 互通。原 PR HEAD 的历史 CI 成功不能自动覆盖新增提交；新增提交仍需自己的 CI。

## 暂缓合并的阻断项

1. **版本与安装路径不一致。** 仓库 `deploy/xiaozhi/version.env` 仍为 v0.9.7 / `27399a2fb64b5910196f438a256ce0a9f868481f`。运行目录的 10 月 25 日维护记录为 v0.9.8 / `8f2dda09cf18f1c1ece0f906eee4cc2fabb7fb58`。不能仅修改版本号；需把扩展点、installer、覆盖注册表、回滚和完整接线测试一起核对。
2. **Bridge 仍有运行补丁。** 部署版保存 hello 参数，在 `connection_unknown` 时重注册并重试一次；仓库候选没有该逻辑。需验证凭据有效性、会话生命周期、重复重启和重试范围后决定收敛实现，不能无条件复制。
3. **Worker 回收策略不同。** 运行中源码将空闲回收设为 Infinity，并保留回收时的 fault 通知；仓库仍为 120 秒。需用有限资源、长闲置续问和重建测试确定统一策略；不能把关闭回收直接作为新多用户基线。
4. **网关全局异常策略未审阅。** 原 PR 中 `uncaughtException` / `unhandledRejection` 直接输出错误堆栈并继续运行，既不能保证状态完整，也不能证明日志不含私人内容。需改为明确的停止接单、清理、脱敏诊断和受控重启策略并测试；本次保存不等于批准该行为。
5. **当前 TTS 覆盖尚未形成仓库可复现交付。** 10 月 25 日运行记录已恢复官方双流会话及延迟首字建会话，旧逐文本项独立会话实现已被替代。相关覆盖文件、上游夹具、维护测试和安装入口仍在部署目录，需单独审阅并明确版本归属。

运行目录中还有顶层备用 `gateway-host.ts` / `real-agent-port.ts`；launcher 实际切到 `data/lumithink-runtime/lumithink` 启动脚本。备用副本不能作为当前执行代码的权威。所有所选文件已按路径和 SHA-256 留本地核对清单。

## 与最新运行记录的关系

维护记录 `overrides/README.md` 与 `deploy/docs/overrides重整与验证-v0.9.8-20261025.md` 报告 31 项覆盖回归和三项真实 TTS 接口场景通过。本次仅核对其结果文件、源码及哈希，未重跑、未重启服务或调用真实供应商。

当前火山覆盖文件 SHA-256 为 `471a726c66a46b0bee606e7aa689597f1c75997e2372dbfb58841a03c36a4723`。这些历史运行证据不能迁移成仓库候选或实机听感的通过结论。

## 后续处理

上述五项纳入 [P0-01 #79](https://github.com/lybym/LumiThink/issues/79)，版本矩阵由 [P0-02 #80](https://github.com/lybym/LumiThink/issues/80) 承接，重建和回滚由 [P0-03 #81](https://github.com/lybym/LumiThink/issues/81) 验证。全部有明确决定和证据后再判定 PR #76 是否可合并。

整体设计以 [A2A_DESIGN](../A2A_DESIGN.md) 和 [TASK_LIFECYCLE](../TASK_LIFECYCLE.md) 为准；本记录仅完成分支整理与预核对，不关闭上述工程任务。
