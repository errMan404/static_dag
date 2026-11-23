# DAG 执行器第一版

Windows x64 npm 版本默认使用包内 Gitea。没有 `.dag/runner.json` 或其中未指定 gitea.url 时，自动启动用户目录下的本机实例并配置 URL 专属的 Git 凭据助手；无需预先部署服务。根 README 说明安装和自动初始化。以下外部服务配置仅在需要自定义服务时使用。

自定义服务时，在目标主 worktree 创建 `.dag/runner.json`，参考本目录 `runner.example.json`。填写 gitea.url、owner、repoPrefix；当前分支必须是 baseBranch，已跟踪文件须提交干净。需要已有 Git 身份和该 Gitea 地址的推送凭据。无需预先创建 Gitea 项目仓库，也无需配置 origin 指向 Gitea。

## 本地基线与 Gitea PR

每次 `/dag_run` 创建新的私有 Gitea 仓库 `<repoPrefix>-<runId>`，auto_init=false，不复用旧仓库。首个任务 PR 从 #1 开始，后续任务在本轮仓库中继续编号。使用新的 Git remote `dag-run-<runId>`，已有 origin 和其他 remote 不变。旧配置中的 gitea.repo 兼容作为命名前缀；remote 字段不再用于任务推送。repoPrefix 为 1–60 位字母、数字、点、下划线或连字符，首位为字母或数字。

以启动 worktree 当前分支的 HEAD 为本轮唯一初始基线。`baseBranch` 仅约束本地集成分支，省略时使用当前分支。启动时记录 initialCommit、localBranch 和 syncedCommit，在新仓库创建 `dag/<runId>/integration` 分支并推送 initialCommit。新一轮不会复用前轮任务状态或 PR，但代码基线仍是当前本地 HEAD，包含当前已存在的提交；需要重复验证同一初始代码时，由用户先回退到所需提交。没有 fetch/merge 旧 origin main/master 的步骤。

每个任务从本地当前已同步的 HEAD 创建分支和 worktree；submit_task 仍然 push、创建 Gitea PR 并请求合并，但 PR 的 base 统一为本轮 integration 分支。Gitea 确认 merged 后，框架只 fetch 本轮目标，校验 merge_commit_sha 确实属于该分支、能从已同步提交快进，再把这个确切提交合入本地目标分支。不会顺便合入 PR 完成之后远端新增的其他提交。PR 合入、同步成功且子会话结束后，自动执行下一节点。

运行期间本地目标分支、HEAD 或已跟踪文件发生外部变化时停止，保留用户现场；不会自动覆盖手动回退、切换分支或提交。Gitea 未返回有效合并提交时也不猜测同步结果。建仓失败或名称冲突时直接失败，不回退到共享仓库。运行结束、失败或取消后保留本轮仓库、PR、remote 和 worktree，便于追溯，不自动删除历史。代码结果保留在本地目标分支，原有 origin 的分支不变。

Workspace 开关需要在 OpenCode 启动前设置。可一次性保存为当前用户的环境变量，重启终端后生效：

```powershell
[Environment]::SetEnvironmentVariable('OPENCODE_EXPERIMENTAL_WORKSPACES', 'true', 'User')
```

Token 优先读取 `GITEA_TOKEN`，未设置时非交互读取当前仓库的 Git credential helper（Windows 通常为 Credential Manager）。个人仓库的 owner 必须为令牌所属用户，令牌需要 write:user（建仓）和 write:repository（PR），允许访问新建仓库；只授权某个已有仓库的令牌不适用。Git push/fetch 仍使用原生 Git 凭据，API 环境变量不能代替 Git 推送凭据。该地址保存的密码必须为 API 令牌，而不是网页登录密码。组织仓库可配置 ownerType: "organization"，还需 write:organization 和组织建仓权限。无需将 Token 写入项目。本机加密凭据和 Windows Credential Manager 已更新为支持建仓的令牌；使用旧终端中手动设置的 GITEA_TOKEN 时，需自行更新或移除该旧值。

在目标仓库正常运行 `opencode`，然后输入 `/dag_run`，读取 `.dag/dag.json`，缺失则直接提示。原有 `/dag 需求` 保持只生成。使用当前宿主模型，不在工具内部额外调用模型规划。

本机 Gitea 部署附带的启动器仍可选用，会自动加载加密 Token 并开启 Workspace：
`& 'D:\0_DAG_SandBox\Gitea\Open-Dag.ps1' '你的业务仓库路径'`。
已有终端不会自动刷新新保存的用户环境变量，需关闭终端应用后重新打开。缺少 Workspace 开关或 Token 时，执行尚未开始。

命令与进度通过 synthetic:true、ignored:true 的内部消息传递，不显示为聊天气泡、不进入模型上下文、不调用模型。看板读取 metadata 并随事件更新，每 10 秒更新耗时。启动检查失败在看板和 TUI 提示中显示原因。打开旧会话时，只将带插件 metadata 标记的旧控制/进度消息隐藏，原文、ID 和运行数据保留，普通用户消息不改动。看板按当前 session 关联运行，不能因为同一个工作区存在旧记录就把新 session 关联到旧 DAG。

OpenCode 1.19.5 的 Fork 路由优先绑定源会话 Workspace，单独指定新 directory 无效。本模块注册原生 `dag-task` Workspace adapter，通过 Workspace API 注册已创建的 Git worktree，Fork 后使用 `/sync/steal` 迁移归属并检查 Workspace ID；git 工具核对实际 ToolContext.directory。必须开启上述实验选项。本实现针对 1.19.5，不宣称兼容 2.x。

`/dag_run` 是 TUI 插件命令，直接向服务器发送 noReply 控制消息，不调用模型启动。框架的 execute 循环按就绪队列并发调度，runner.json 中 maxConcurrency 为正整数，默认 20，设为 1 可串行执行。前置 PR 合并并同步且 Agent 最终回复结束后才可启动后继；有空位时立即调度，不等待整个批次。没有协调 Agent 或 dag_next 工具。主会话 idle 不会打断调度。默认每个节点创建新 session 并接收直接前置报告；runner.json 设 forkSession 为 true 时，单依赖改用 session.fork。每个节点独立 worktree/分支，所有节点使用相同 `worker.md`。多依赖新会话接收直接前置报告。代码来自启动 worktree 的本轮基线及此前已确认合入的任务结果。

任务开发并发，但 worktree 基线创建与 submit_task 的 push/PR 合并/主工作区同步共用串行集成队列，避免 HEAD 校验和 Git 引用互相干扰。状态快照也按调用顺序写入。各 Agent 解决冲突时使用自己的修复引用，不争用主工作区的跟踪引用。取消或任一节点失败时，停止所有活动 Agent，等待已开始的集成操作收尾后再释放运行锁，未执行节点标为 blocked；已确认合并的提交保留。

429 不进入上述整轮失败路径：保留 OpenCode 原生重试，其耗尽后由框架在同一个 session/worktree 继续。优先遵循 retry-after-ms、Retry-After 秒数或 HTTP 日期，无有效头时指数退避并抖动（2 秒起、最长 60 秒），不限制 429 重试次数，等待支持立即取消。重试只追加 ignored/synthetic 继续标记，不重复发送任务说明或创建 worktree；已完成工具结果留在原会话。等待次数与时间保存在任务 retry 字段，看板显示等待重试。相同 DAG 的新模型请求共享冷却期；runner.json 可用正整数 modelRequestsPerMinute 限制该轮总请求速率，不配置时不假设各服务的额度。此节流作用于本服务器这轮 DAG，不涵盖其他程序或其他服务器对同一个 API Key 的调用。

worker 可使用原生文件工具、bash 和额外 git 工具。在开发、测试并 git add/commit 后调用 `submit_task({summary})`；工具检查工作区干净、分支正确、有新 commit，然后 push、创建/复用 PR、请求合并并重新查询确认。只有启动 worktree 成功同步本轮 PR 的确切合并提交后才 done。测试由 Agent 执行报告，本版无独立强制机器验收器。开发输入使用 task.md 的可读模板，只传当前任务的标题、目标、实施说明、验收要求和一份工作目录。session、workspaceID、分支、提交、Gitea URL、remote 等运行状态保留在框架内。单依赖 Fork 不重复拼接前置报告；多依赖新会话仅附直接前置任务的报告。

HTTP 409 冲突作为 submit_task 的 JSON 结果返回原 Agent，同时在 repairCommands 中提供本轮正确的 fetch/merge 参数数组，按需传递修复目标。Agent 逐条调用 git 工具、处理冲突、重新测试和 commit，再调用同一个工具重试同一个 PR。其他权限/CI/审核问题返回 blocked，不强制合并。会话结束而未成功合并时运行失败，未执行节点 blocked。下一节点必须等待当前会话结束、PR 已合入、主工作区同步完成。

独立 DAG 页面使用公开 route 插件接口和 OpenTUI/Solid 渲染，不使用搜索弹窗，没有聊天背景。页面显示完成数、固定/实时耗时、进度条和任务表格；每个任务一行，状态/依赖/PR 分列。鼠标点击或方向键加 Enter 进入该节点的原生会话。未启动的节点不可进入。`/dag_panel` 重新打开页面，`/dag_status` 刷新服务器状态，`/dag_cancel` 请求停止当前 Agent 并阻止后续节点。页内 r 刷新、c 取消（仅运行中有效）、Esc 返回主会话。DAG 任务详情中按 ↑ 或点击底部「返回 DAG 看板」直接返回所属运行批次并选中原任务，不再先返回父会话；普通会话不改动，弹窗打开时保持原生按键行为。Ctrl+p 选择「DAG 任务面板」仍可作为备用入口。取消不回滚已合入提交，离开页面不会取消后台运行。单依赖 Fork 可能以独立会话显示，不修改数据库伪造 parentID。

通过 `opencode plugin --global deveco-dag@0.5.1 --force` 安装时，会根据 npm 包的 ./server 和 ./tui 入口注册服务端与 TUI。在全局 opencode.json(c) 和 tui.json 的 plugin 数组中使用 `deveco-dag@0.5.1`；不需要源码路径或 plugins 目录下的本地 shim。本项目不再提供自动加载源码的项目入口，开发验证通过测试配置显式加载。没有修改 OpenCode 本体。

主聊天不显示控制或进度状态块，运行信息统一在独立页面。页面按 session 和运行批次关联主 DAG，进入 Fork 会话后仍能返回。完成后不再显示取消提示，耗时停止更新；兼容旧版进度记录的耗时。OpenCode 原生 Fork 会保留历史 session.directory，子会话的宿主路径提示可能显示来源路径；实际工具目录经 Workspace ID 和 git 工具上下文校验，任务消息中的 currentWorktree 为真实执行目录。

运行状态保存于 `.dag/runs/<runId>/state.json`，不修改原 DAG。worktree 位于主目录旁 `.dag-worktrees/<repo>/<runId>/task-<id>`；分支为 `dag/<runId>/task-<id>`。不自动删除现场。`.dag/run.lock` 阻止跨进程同时运行，异常退出后须确认无活动进程再处理残留锁。本版没有崩溃自动恢复；面板历史快照不代表任务仍在运行，使用 /dag_status 向当前服务器确认。

明确的 filePath/path/workdir 参数会从旧根映射到新 worktree，包含旧目录的 shell 命令拒绝后提示重写。通用提示词要求重新读取后编辑。这不是操作系统沙箱，不能证明任意脚本不会写入其他目录；需要硬隔离时另配宿主沙箱。

逻辑入口为 `index.js` 的 DagRun，Git 和 Gitea HTTP 分别在 git.js/gitea.js；当前由 plugin.js 适配器在 OpenCode 宿主内运行，不支持外部 Node 进程直接共享宿主 registry。开发系统提示词在 worker.md，修改后重启生效。无 TUI 客户端可以向主会话 POST /session/{id}/message，传 noReply:true 和一个 synthetic:true、ignored:true 的 text part，其 metadata 为 {dagControl:{action:"start"|"status"|"cancel",root:"主 worktree 绝对路径",requestId:"每次新请求的唯一ID",issuedAt:Date.now()}}。命令立即返回，通过进度消息事件和 state.json 观察完成。服务器先持久化 dagControlHandled:true 再执行请求；已处理、缺少请求时间/ID 或超过 5 分钟的控制消息不会执行。隐藏旧消息时同时标记已处理，防止历史编辑或重启后重放。

自测：`npm test`、`npm run test:integration`、`npm run test:run`。执行测试使用真实 OpenCode、真实 Git、本地测试模型及 **模拟 Gitea API**；合并由真实 Git 完成。远端 main 预先包含旧提交，本地实际 reset 后启动四节点；检查所有任务使用回退后的基线、所有 PR 只合入本轮目标、远端 main 不变，并验证零/单/多依赖、真实 Git 冲突、同会话修复和取消。连续两轮成功运行验证仓库、remote 独立，两轮首个 PR 均为 #1，前轮 PR 保留。baseline.test.js 另测只同步确认的提交及本地编辑、切分支、回退保护；gitea.test.js 验证私有空仓库、重名拒绝、账号与权限错误。测试不调用付费模型。

可选真实服务验证：`node test/gitea-baseline-smoke.mjs`。使用 GITEA_SMOKE_URL/GITEA_SMOKE_OWNER（默认本机服务和 dag-agent）、GITEA_TOKEN（支持建仓）及原生 Git 推送凭据。脚本连续执行两轮，真实创建两个私有仓库，各自创建、合并 PR #1 并精确同步本地；保留远端仓库/PR 供查验，成功后清理临时本地仓库。该测试不启动模型，不是正常运行 DAG 的前置要求。

每轮创建空仓库，不自动复制旧仓库的审批、Webhook 或 CI 保护规则；如需这些规则，应为新仓库另行配置，并覆盖 `dag/*/integration` PR 目标。
