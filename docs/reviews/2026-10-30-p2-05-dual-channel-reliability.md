# P2-05 双渠道可靠性及权限回归 — 工作 DSH × 小智联合验证记录（issue #117；2026-10-30）

> 关联 Epic：P2 Epic；前置：[#114](https://github.com/lybym/LumiThink/issues/114)（P2-02 DSH 客户端在位）、[#115](https://github.com/lybym/LumiThink/issues/115)（P2-03 小智 provider 在位）、[#116](https://github.com/lybym/LumiThink/issues/116)（P2-04 交付水位在位）、[#121](https://github.com/lybym/LumiThink/issues/121)（P1-12 重订阅 teardown 收口，SSE 断流用例可覆盖重订阅路径）。
>
> 本记录对应 [Issue #117](https://github.com/lybym/LumiThink/issues/117) 的回归报告交付物（AC-3）：版本、命令、结果、局限。
>
> **口径**：全部公开内容合成、全程 loopback、无真实凭据/音频/儿童资料、不切 UDS、不触碰 `lumithink-data/**`；**零 `src/` 行为代码改动**（`git diff main -- services/a2a-server/src services/dsh-a2a-client/src services/xiaozhi-a2a-provider/xiaozhi_a2a_provider` 为空）；关键测试零 SKIP。

## 1. 结论

**Issue #117 的 9 组用例全部在双渠道联合条件下真实执行且有证据锚点，零 SKIP；未发现需要缺陷归属的服务端/客户端行为缺陷。** 联合 harness 以**一个共享真实服务端栈**（`startA2aService` 全组合：真实 express+官方 SDK HTTP、文件 SQLite、`DshWorkerRuntime` 真实 worker 子进程、合成身份 bootstrap 同时注入 `dsh_profile` 与 `xiaozhi_device` 凭据）承载两个**独立客户端**：

- **A 渠道（工作 DSH）**：真实 P2-02 `DshA2aClient`（`services/dsh-a2a-client`，官方 `@a2a-js/sdk@1.3.0` + 持久 ledger 文件），跨包动态加载（见 §5 安装面说明）。
- **B 渠道（小智）**：真实 P2-03 `XiaozhiA2AProvider`（官方 `a2a-sdk==1.2.3` 客户端在其内），经 JSON-lines runner 子进程（`services/xiaozhi-a2a-provider/tests/p2_05_runner.py`）驱动，provider 行为代码零改动。

**不得以两渠道各自单独测试通过代替联合测试**——每个用例的时序交错点由 Node 编排侧驱动（同 tick 并发受理、交错取消/完成、同刻双渠道断流、重启切点前后双渠道观察），并在断言中绑定渠道归属证据（taskId、执行行 worker_id、按会话隔离的交付水位、线错误码）。

## 2. 用例锚点矩阵（9 组 → 11 测试）

新增 `services/a2a-server/tests/p2-05-dual-channel.spec.ts`（11 测试）。worker 行为档位沿用 P1-05/07 的既有测试机制（`LUMITHINK_A2A_WORKER_BEHAVIOR`），每组独立服务实例（文件 SQLite 隔离）。

| # | Issue #117 用例组 | 测试锚点 | 渠道组合与时序交错 | 关键证据（终态/断言锚） |
| --- | --- | --- | --- | --- |
| G1 | 权限隔离：双 Principal 并发 + 跨主体拒绝 + 撤权即时生效（含 SSE 长流关闭） | `G1 权限隔离: 双 Principal 并发受理、跨主体拒绝、撤权即时生效（双渠道 SSE 长流仅撤权方关闭）`（never-stops） | 并发同刻受理（两任务即两条 SSE 长流）→ 双向跨主体 wire 探针（GetTask/CancelTask 各自 -32001/not_found）→ 伪造 metadata 受理（第三任务被容量拒绝，绑定仍归 alpha）→ 依次撤销 `cred-dsh-alpha`、`cred-xiaozhi-device` 两条凭据 | 任务绑定（hh-alpha-01+principal / hh-xiaozhi-01+principalless）；撤权仅关闭对应主体的 SSE 流（另一渠道流存活）；撤销后 wire 立即 401（AUTHENTICATION_REQUIRED）；provider 侧 `disconnected=true` + content-free error |
| G2 | 并发 Task：双渠道同时受理执行；家庭/全局限额与背压 | `G2 并发 Task: 双渠道同刻受理执行；家庭与全局容量压力下双渠道一致获得显式即时拒绝（不搁置、不执行）`（never-stops + 收缩限额 2/1/2/1） | 双渠道同 tick 受理 → 两真实 worker 并行 → alpha/小智先后施压饱和面 | 两任务同刻 working（各自执行行 + worker_id）；容量满载请求**即时显式 REJECTED**（落在 submitted、零执行行，P1-09 review-P0 纪律）；既有任务不受拒绝影响；`executions==2` |
| G3a | 取消×完成竞争（完成获胜） | `G3a 取消×完成竞争: 双渠道并发 cancel-after-work 交错 → COMPLETED+抑制旗标，终态不可被迟到回调改写`（complete-after-cancel） | A 渠道 cancel 与 B 渠道设备 abort 在同一窗口发出，两渠道同跑同一竞争 | CancelTask 响应携带**竞争后终态**（already_terminal/COMPLETED，§7.2 不谎报 CANCELED）；双渠道 COMPLETED + `outputSuppressedAfterCancel=true/answerComplete=false`；迟到收尾 chunk 不入公开 artifact；迟到取消 -32002；终态复读不变 |
| G3b | 取消×完成竞争（取消获胜） | `G3b 取消×完成竞争: 取消获胜 → 双渠道真实停止证据 + 迟到输出不进入公开正文`（flood-after-cancel） | A 渠道 cancel + B 渠道 abort 交错；两 worker 取消后刷迟到输出 | A：`confirmed_canceled` + 执行行 settled outcome=canceled + cancelIntent 持久；B：presentation=canceled；双渠道 artifact 均只含取消前 chunk（`你好。`）；400ms 后终态复读不变 |
| G4 | 服务端重启：受理/执行/交付切点；不重复执行、无孤儿正文 | `G4 服务端重启: 执行/交付切点真实 SIGKILL → abandoned+FAILED 不重复执行无孤儿正文；受理切点重派；双渠道恢复`（spawned fixture never-stops → in-process 重启 complete） | spawn 真实服务（同端口、组合 bootstrap）→ 双渠道任务各自进入执行+首 chunk 交付（执行+交付切点）→ **SIGKILL 服务进程** → 同库同端口 in-process 重启 → 双渠道恢复 → 优雅停止后种子化受理切点任务再重启 | 恢复报告 `abandonedExecutions==2`、不重排队；双任务 FAILED + 执行行 `abandoned/restart_interrupted_unknown_outcome`；chunk 数前后一致（无孤儿正文/无重复）；Outbox 未发布行存活；DSH `resumePending→query_or_reattach` + 幂等重试同 Task 零重执行；小智侧 wire 读 FAILED + 新轮正常完成；受理切点重派恰一次新执行 |
| G5a | Worker 崩溃（自 SIGKILL） | `G5a Worker 崩溃: 真实 worker 子进程自 SIGKILL（crash-after-ready）→ 双渠道 FAILED 结算各自成立` | 双渠道任务并发，两 worker 在 ready 后各自 `process.kill(pid,'SIGKILL')` | 双执行行 settled outcome=crashed + 异常退出证据（exitCode/signal）；两 worker id 独立；双渠道各见 FAILED（provider presentation=failed） |
| G5b | Worker 崩溃（外部定点 SIGKILL，另一渠道不受影响） | `G5b Worker 崩溃: 外部 SIGKILL 单个 worker → 结算正确，另一渠道 worker 与任务不受影响`（never-stops） | 双 worker 停驻 → 按执行行 worker_id 提取 pid **外部 SIGKILL 仅 alpha worker** | A 任务 FAILED + crashed 证据；B 任务保持 working（执行行未结算）→ B 渠道 abort → CANCELED + 执行行 settled（真实停止证据） |
| G6 | SSE 断流：双渠道同时断流重连（含重订阅路径）；水位独立互不串流 | `G6 SSE 断流: 双渠道同刻断流（传输接缝切断）→ 各自重订阅恢复；水位独立、互不串流`（stop-on-cancel + 双侧传输接缝切断，见 §5） | 双渠道各持停驻 SSE 流（已交付首 chunk）→ **同一 orchestrated 瞬时切断双渠道打开的流**（时间点语义：仅切断当时已存在的流）→ DSH 侧 resubscribe 重挂、provider 自动快照重建+SubscribeToTask 恢复 → 双渠道各自取消 → 重订阅流交付终态 | 双渠道断流被诚实记录（provider `disconnected=true/resubscribed=true`）；重订阅流交付 CANCELED 终态帧；A 流所有帧 taskId 恒等于自身（互不串流）；`delivered_fragments≥1、duplicate_fragments==0`（水位恢复不重放）；未使用会话无水位（按会话独立）；alpha artifact 仅含切断前 chunk |
| G7 | 重复提交：同键同指纹/同键异指纹，跨渠道不混淆 | `G7 重复提交: 同键同指纹→原 Task；同键异指纹→-32602；跨渠道请求键作用域不混淆`（complete） | A 渠道同键重发 × 设备凭据原样重放（同 messageId+同内容）× provider 渠道自然轮次 | 同键同指纹 → 原任务 + `executions==1`；同键异指纹 → **-32602**；设备凭据同键重放 → **不同任务**（请求键按完整认证绑定作用域，跨渠道不混淆）；provider messageId 结构性唯一（`xz-*`） |
| G8 | 限额与背压（G10）：单渠道耗尽资源不阻断另一渠道的查询与取消 | `G8 限额与背压(G10): 容量饱和窗口内 xiaozhi 渠道的查询与取消全程可用；alpha 施压被显式即时拒绝`（never-stops + 全局 2 槽饱和） | B0+A1 占满两全局槽 → alpha 施压 A2 被拒 → 饱和窗口内 B 查询（own/被拒任务/越权负例）→ B 取消 B0（真实停止证据）→ 释放后 A3 正常受理 | 饱和中 B 查询 WORKING ✓；越权 -32001 ✓；A2/B2 显式 REJECTED 且被拒任务 B 侧可查 ✓；B0 取消 → CANCELED + 执行行 settled ✓；释放后 alpha 新任务 working ✓ |
| G9 | 数据删除及撤权：purge 后仅墓碑；另一渠道可见性按授权收敛 | `G9 数据删除及撤权: 删除后仅墓碑、另一渠道可见性按授权收敛；撤权后 403 而设备渠道不受影响`（complete） | 双渠道各自完成任务（a1/a2 走 wire 面便于同指纹重试、b1 走 provider）→ delete-first（先记台账后 purge）→ 单任务 purge + 家庭 scope purge → 撤销 alpha guardian 成员资格 | purge 后 DSH 侧读到清洁 shell（终态、零 artifact）；同键重试 `-32000/RESULT_PURGED` 且不重执行；越权侧前后一致 -32001；scope purge 覆盖 a2 且 b1 正文原样（`chunks==2` 仅剩小智任务）；撤权后 alpha 403 PERMISSION_DENIED、设备渠道 200 |

## 3. 复现命令

```bash
# 前置：Node 24.x + services/a2a-server 依赖（pnpm --dir services/a2a-server install --frozen-lockfile）
# CI 的 a2a-server gate job 已装 Python 3.12 + a2a-sdk==1.2.3；本地需指向带 a2a-sdk 的解释器：
export LUMITHINK_P2_05_PYTHON_BIN=<python-with-a2a-sdk>     # 本地；CI 用 PATH 上的 python/python3
export PYTHONPATH=<a2a-sdk 所在路径>                          # 本地；CI 由 pip 安装覆盖
export LUMITHINK_A2A_PYTHON=<python-with-a2a-sdk>           # python-sdk-interop 两例本地复验用

# 单 spec（11 测试，~30s）
node --test --test-isolation=none tests/p2-05-dual-channel.spec.ts    # 在 services/a2a-server 下

# a2a-server 全量（含新 spec；python-interop 两例在 CI 由 setup-python 覆盖）
pnpm --dir services/a2a-server run test

# 小智 provider 既有套件（回归面，118 tests OK）
python -m unittest discover -s services/xiaozhi-a2a-provider/tests -t services/xiaozhi-a2a-provider -v
```

## 4. 验证结果（本记录证据）

| 项 | 值 |
| --- | --- |
| 基线 | `main` @ `19e0a25cac9ba3be6c8dc8afa281033840235665`（fetch → switch → `pull --ff-only`，本地 HEAD = `origin/main`） |
| 分支 | `feature/p2-05-dual-channel-regression`（自基线切出） |
| 工具链 | Node v24.21.0（DSH 捆绑 runtime）、Python 3.12（DSH 捆绑 runtime，`a2a-sdk==1.2.3`）、TypeScript 5.9.3、`@a2a-js/sdk@1.3.0`（两隔离包精确 pin 一致） |
| 新 spec | **11/11 pass，0 fail，0 skipped**；连跑 3 遍稳定（run + 2 次重复） |
| a2a-server 全量 | **211 tests：209 pass / 2 fail / 0 skipped**——唯二失败为 `python-sdk-interop` 两例的**本地环境显式失败**（本机 PATH 无 `python3` 且未设 `LUMITHINK_A2A_PYTHON`；ZERO-SKIP 设计的预期失败面，与 P1-13 记录 §4 同性质）。设 `LUMITHINK_A2A_PYTHON` 后单独复跑该 spec：**2/2 pass**（即全套等效 211/211）。CI 由 setup-python 3.12 + `a2a-sdk==1.2.3` 覆盖，以 PR checks 为准 |
| 小智 provider 套件 | **118 tests OK**（零失败零 SKIP；runner 新文件不参与 unittest discover） |
| 类型检查 | `services/a2a-server` `tsc --noEmit` exit 0；根 `tsc --noEmit` exit 0 |
| 变更面 | `package.json` test 枚举 +1 行、新增 1 个 spec、新增 1 个 Python runner（tests 面）；`git diff main` 对三包 `src/` 均为空 |

失败归属：**无**。调查中全部失败均归因于 harness 自身并当场修复（见 §5），未发现需要登记缺陷任务的服务端/客户端行为问题。

## 5. harness 决策与发现（如实记录）

1. **安装面（a2a-server gate 只装本包）**：两个隔离包（ADR-0013）pin 同一 `@a2a-js/sdk@1.3.0`。当兄弟包 `services/dsh-a2a-client` 无 node_modules（gate job 1）时，spec 在运行期以 **junction（Windows）/symlink（POSIX）** 将兄弟包 node_modules 指向本包 node_modules，使客户端源码的唯一依赖可解析；`node_modules/` 全局 gitignore，进程退出时清理，提交面零变化。类型检查面以动态 import + 抑制注释承载（运行期 junction 后解析才是真实保证）。
2. **撤权/删除无 wire API**：`services/a2a-server` 仅暴露 `/ops/load-report`；撤权（revokeCredential/revokeMembership，含 SSE 即时关闭）与 purge（`purgeTaskBody`/`purgeProcessingScope`）是 in-process 权威面。因此默认形态用 **in-process `startA2aService` 全组合真实栈**（P1-05/07/08 service-level 先例；worker 仍是真实子进程、HTTP 仍是真实 wire）。G4 的服务端崩溃用 **spawn 真实服务 + SIGKILL**（P1-08 真实 crash-restart 先例），重启 in-process 同库同端口。
3. **G6 断流注入的三段演进（harness 发现）**：① 透明 TCP 代理被 **agent-card 路由击败**——两个官方 SDK 客户端都会改用 card 内宣告的绑定 URL 发起后续请求，绕过本地代理（provider 日志实证：A2AClientError 后经 card.url 直连恢复）；② 流包装只在「下一个事件边界」生效，对**静默停驻流**永不触发；③ 终态实现为**双侧传输接缝的时间点切断**：DSH 客户端经其官方 `fetchImpl` 注入缝包装 SSE body（切即 error 打开的流，无字节也生效）；provider 经其官方 `client_factory` 构造缝注入流包装（跨线程 future 竞速杀静默流）。时间点语义（只杀切断瞬间已存在的流）使 provider 的自动恢复（快照重建+重订阅）天然落在健康传输上，消除竞态。期间修复一个并发缺陷：取消等待任务会级联取消共享 future（被取消任务在 `asyncio.wait` 亦算完成），已改为跨迭代共享单一等待任务。
4. **容量语义（对齐实现而非假设）**：派发路径带 `capacityPreflight`（`wouldRejectNowForCapacity`）——容量/队列压力**即时显式拒绝**（REJECTED 落在 submitted、零执行行；有界队列只兜底瞬态竞态）。G2/G8 的断言按该真实语义钉死（G10 的"不阻断查询与取消"为独立断言面）。
5. **Windows 本地化坑（harness 修复）**：runner 的 stdin 管道默认按 ANSI 代码页解码，UTF-8 中文提示词产生代理字符并使 provider 请求体编码崩溃（UnicodeEncodeError）。runner 侧三流 reconfigure UTF-8 + orchestrator 侧 `PYTHONUTF8=1/PYTHONIOENCODING=utf-8` 双保险。
6. **provider 构造契约**：`XiaozhiA2AProvider` 的 `auth_token`/`client_factory` 为构造器 keyword-only 参数（config dict 不收）；runner 以 kwarg 注入。

## 6. 局限（PENDING，如实标注）

1. **真实设备/真实模型/生产部署**：沿用 P1/P2 口径（合成 provider 内容、loopback、验证 profile）——真实小智设备链路、真实模型推理与生产部署形态不在本回归范围（P1-10/#92 与 P5 资源实测）。
2. **G4 受理切点的观察面**：受理切点（confirmed-never-started → 重派）由存储层种子化驱动（P1-08 AC1 同构先例）；种子任务无身份绑定，故无 wire 可见性——该切点的**双渠道实时观察**以「执行/交付切点全 wire + 受理切点存储级证据」组合覆盖，已在测试头注释与本记录声明。
3. **G9 的上下文维度**：删除后"旧上下文不可访问"以墓碑重试（RESULT_PURGED）+ 绑定面断言覆盖；purge 后跨任务的 contextId 续接负例由 identity-service-acl 既有 spec 承载（-32602 面），本 spec 未重复构造。
4. **性能/吞吐**：非目标（P5）；本记录的时长数字仅为稳定性证据，不构成容量承诺。
5. **G6 断流的注入层级**：传输接缝切断在失败模式上与「静默 socket 断开」等价（打开的流无终态地终止），但不是字节级 socket 抓断；TCP 代理路径被 agent-card 路由绕过的发现已记录（§5.3），如需字节级验证可后续在服务端侧加注入面（不在本 Issue 范围）。

## 7. 变更清单

- `services/a2a-server/tests/p2-05-dual-channel.spec.ts`（新增，11 测试：联合 harness + G1–G9）
- `services/xiaozhi-a2a-provider/tests/p2_05_runner.py`（新增：小智渠道 JSON-lines runner，零 provider 行为改动）
- `services/a2a-server/package.json`（test 枚举 +1 行）
- 本记录
