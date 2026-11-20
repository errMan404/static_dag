# deveco-dag

UX 最小融合版：支持按 DAG 节点注入版本化 UX 资产，无设备时单独记录 UX 未验证，不阻塞代码任务。配置与复现步骤见 [UX 资产说明](assets/ux/README.md)。

当前卡片资产保存在 [assets/ux](assets/ux/README.md)：全应用 12 张卡片（已含原资讯 3 张）。其他 UX 工具能力的迁移待方案确认后实施。

适用于 macOS（Apple Silicon、Intel）和 Windows x64 的 OpenCode DAG 插件，默认在本机运行 Gitea 28.3.0。

- `/dag 需求描述`：探索当前工程，生成并校验 `.dag/dag.json`。
- `/dag_run`：按依赖自动执行任务，每节点独立 worktree，通过本机 Gitea PR 提交、合并；冲突交回原 Agent 修复。
- `/one_duo 需求描述`：从规划和开发开始，按需求中指定的设备评测同一集成版本，并在有进展时自动修复和复测。
- `/one_duo_resume`：从当前项目和分支最近可用的一多适配断点继续。
- `/dag_panel`：任务看板，点击任务进入原生 Agent 会话；按 ↑ 返回看板。
- `/dag_status`、`/dag_cancel`：刷新状态、取消运行。

## 安装

适配 **OpenCode 1.19.5**。需要已安装 Git、配置 Git 提交身份，并在 OpenCode 中配置模型。此版未适配 OpenCode V2。

```sh
opencode plugin --global deveco-dag
```

安装命令会根据包内 `./server` 和 `./tui` 注册两部分，重启 OpenCode 加载。Windows x64 的 Gitea 随 npm 包发放。macOS 首次启动本地 Gitea 时，从 [Gitea 官方发行目录](https://dl.gitea.com/gitea/28.3.0/) 下载匹配架构的版本，校验 SHA-256 后缓存，之后可离线复用。两端均无需 Docker 或管理员权限。

### 启用 Workspace（运行 DAG 必需）

`/dag_run` 和 `/one_duo` 需要 OpenCode 的原生 Workspace 功能，才能在不同 Git worktree 中创建和 Fork Agent 会话。OpenCode 1.19.5 在启动时读取环境变量 `OPENCODE_EXPERIMENTAL_WORKSPACES`。

macOS 从终端启动时启用：

```sh
OPENCODE_EXPERIMENTAL_WORKSPACES=true opencode
```

**推荐：为当前 Windows 用户永久保存，并立即在当前 PowerShell 窗口生效。** 无需管理员权限：

```powershell
[Environment]::SetEnvironmentVariable('OPENCODE_EXPERIMENTAL_WORKSPACES', 'true', 'User')
$env:OPENCODE_EXPERIMENTAL_WORKSPACES = 'true'
opencode
```

第一行保存用户级环境变量，第二行更新当前 PowerShell 进程，第三行启动已启用 Workspace 的 OpenCode。已有 OpenCode 进程需要退出后重新启动。

**仅本次启用：** 如果不需要永久保存，只在当前 PowerShell 窗口执行：

```powershell
$env:OPENCODE_EXPERIMENTAL_WORKSPACES = 'true'
opencode
```

可在启动前检查当前窗口的值，应输出 `true`：

```powershell
$env:OPENCODE_EXPERIMENTAL_WORKSPACES
```

Windows 上，插件会自动尝试保存用户级开关，OpenCode 会在下一次启动时读取它。如果首次运行提示需要启用 Workspace，请退出 OpenCode，在当前窗口执行上面的 `$env:...` 赋值后重新启动，或完全退出并重新打开终端应用。Windows Terminal 仅新建标签页可能仍继承旧环境。从 IDE 内置终端启动时，也可能需要重启 IDE。

此开关通过环境变量启用，不能用 `opencode.json` / `opencode.jsonc` 中的配置项代替。

## 使用

在已提交代码的 Git 仓库中启动 OpenCode：

```text
/dag 给当前项目添加一个有测试的 greeting 工具
/dag_run
```

首次 `/dag_run` 或 `/one_duo` 的开发阶段会自动初始化并后台启动本机 Gitea。它选择回环端口，创建 SQLite 数据库和专用账号，并为当前 Git 仓库注册仅作用于本机服务地址的凭据助手。默认使用本地 Gitea 时无需配置 `.dag/runner.json` 或设置 `GITEA_TOKEN`。

同一电脑上的同一用户共用一个 Gitea 实例。每轮创建独立私有仓库 `<项目前缀>-<runId>`，首个任务 PR 从 `#1` 开始。新一轮以启动 worktree 的当前 HEAD 为基线，已确认的 PR 合并提交同步回本地，保留原 origin 配置。

任务按依赖并发调度，默认最多同时运行 20 个节点。前置任务的 PR 已合并、本地已同步且 Agent 会话结束后，后续节点才进入就绪队列；有空闲名额就立即启动，无需等待同批次的其他分支。只有一个前置节点时 Fork 其原生会话；没有前置节点或多个前置节点时创建新会话。所有节点使用 `src/dag_run/worker.md` 通用提示词，完成开发、测试和 git commit 后调用 submit_task。PR 提交合并与主工作区同步通过串行队列处理，冲突返回原 Agent 解决后重试。一个节点失败时停止其他活动节点并阻止后续任务。

### 一多适配闭环

在需求里直接写出要适配的设备型号或屏幕形态。首轮规划会从需求中提取这些目标，并为各目标制定验收项。如果需要回归原设备，也请在需求里明确说明。

评测节点按需求中的型号或屏幕形态查看 DevEco 设备清单，匹配已连接的设备或可启动的模拟器实例，取得占用后再验证。独立设备可以并行评测，共用设备会排队并显示占用进程。确认占用进程已退出时，看板会提示残留锁，评测报告会记录受影响的未验证项和处理位置。

需要固定使用某台设备时，可选在工程的 `.dag/one-duo.json` 配置 `devices`。键使用需求中的目标名称，值使用评测节点列出的设备 ID。

```json
{
  "devices": {
    "Pura X Max": "pura-x-max-emulator-01",
    "三折叠": "triplefold-emulator-01"
  },
  "maxRounds": 8,
  "timeoutMs": 36000000
}
```

`timeoutMs` 以毫秒为单位，默认值和允许的最大值均为 10 小时。每次规划、每轮开发或修复、每个设备评测节点分别计时。

```text
/one_duo 已知这个工程是直板屏的鸿蒙工程,将项目迁移适配到以下多设备屏幕:Pura X Max,三折叠。
```

也可以用 `--targets` 显式指定逗号分隔的目标。设备名称含空格时，引号包住整个目标列表，例如 `/one_duo --targets "Model A,Model B" 需求描述`。

首次规划生成开发任务和一份验收清单。清单覆盖指定类型，每项包含唯一编号、操作步骤和通过条件。开发和修复阶段只做本地检查，设备验证留到代码合并后。评测按目标类型拆任务，在独立工作目录验证同一个合并提交，各项结果通过工具提交，并附实际观察和证据。

使用 `/one_duo_resume` 续跑中断的工作流。已保存 DAG 且代码阶段尚未完成时，使用原 DAG 继续未合并的节点。代码已合并时，从对应集成提交进入设备评测，未完成的评测会在新的工作目录开始并保留已有证据。正式报告及修复 DAG 已保存时，续跑会沿用这些产物和原有的停止条件。当前 Git 分支和 HEAD 须与断点一致，工作区中的已跟踪文件须保持干净。保存断点需要保留 `.dag/one-duo` 和 `.dag/runs` 下的运行记录。

各节点可按需加载 OpenCode 发现的全量技能。鸿蒙任务可用 `devecocli` 工具查询资料、构建或评测，具体操作按节点职责授权。开发节点接收节点任务和本地验证约束。修复节点另有相关失败项、复现步骤和证据。完整清单和报告保存在运行目录。

首次评测为修复建立基线。有明确的失败项且必验项均已评测时，先使用被测提交和报告规划修复。修复后复用相同清单评测新提交。全部通过即结束；失败项严格减少且没有回归才自动继续。目标类型找不到匹配或可用的设备时，该类型记为未验证。出现未验证项、回归、无进展、没有新提交或达到配置的轮次上限时，流程停止并记录原因。

使用 `/dag_panel` 查看流程树。树按轮次展开规划、开发与合并、设备评测，并保留之前的任务和结论。用上下键选择，按 Enter 或点击展开分支、进入任务会话。使用 `/dag_cancel` 取消。

查看 `.dag/one-duo/<id>/checklist.json`、`state.json` 和各轮的 `round-<n>/results.json` 可核对清单、提交和逐项结论。修复轮的 `inputs.json` 同时记录被测提交和报告路径。测试代码改动沿用开发任务的 PR 流程，评测节点交付结果和证据。单独运行 `/dag_run` 时使用原有的 `.dag/ux.json` 节点选卡配置。

## 本地数据

默认运行数据在 macOS 保存在 `~/Library/Application Support/DevecoDAG/gitea`，在 Windows 保存在 `%LOCALAPPDATA%\DevecoDAG\gitea`。其中包含数据库、仓库、日志和 Gitea 程序。macOS 令牌以仅当前用户可读写的文件保存（权限 `0600`），Windows 令牌使用 DPAPI 加密。Gitea 仅监听 `127.0.0.1`，关闭 OpenCode 后仍可运行。npm 更新或卸载不会清除历史数据。

以下命令可选用，用于提前初始化或查看服务状态：

```powershell
npx deveco-dag setup
npx deveco-dag status
```

运行状态保存在工程 `.dag/runs/<runId>/state.json`；worktree 保存在工程旁 `.dag-worktrees/<工程名>/<runId>/task-<id>`。完成、失败和取消均保留本轮仓库与 PR。取消不回滚已经合并的提交。本版不支持崩溃后自动恢复；不要在运行期间手动移动主 worktree 的 HEAD。

## 可选配置

需要指定命名前缀或限制本地目标分支时，创建 `.dag/runner.json`：

```json
{
  "maxConcurrency": 20,
  "modelRequestsPerMinute": 12,
  "baseBranch": "main",
  "gitea": {"repoPrefix": "my-project"}
}
```

maxConcurrency 是正整数，默认为 20；设为 1 时串行执行。也兼容通过 gitea.url、owner、repoPrefix 指定已有外部 Gitea，此时使用原生 Git 凭据和 GITEA_TOKEN/credential helper。旧 gitea.repo 字段仍可作为命名前缀。详见 src/dag_run/README.md。

modelRequestsPerMinute 可选，限制本轮 DAG 所有节点的模型调用速率，与节点并发数分别控制。示例 12 适用于 16 RPM 服务预留余量；不配置时不预设服务额度。OpenCode 原生重试结束后若仍返回 429，框架遵循 Retry-After（秒/HTTP 日期）或 retry-after-ms，在原 session/worktree 中持续重试并共享冷却期，不因 429 取消其他节点。没有重试次数耗尽后自动结束整轮的规则；可用 /dag_cancel 停止等待。看板显示“等待重试”。权限、鉴权和业务错误仍按失败处理。

## 开发

源码仓库为 https://github.com/errMan404/static_dag 。Git 仓库不保存大体积可执行文件。从源码构建 Windows 版本或打包 npm 之前，使用 `node scripts/prepare-gitea.mjs` 准备 Windows Gitea。macOS 从源码启动时会自行缓存匹配的 Gitea。

```powershell
npm install
node scripts/prepare-gitea.mjs
npm test
npm run test:integration
npm run test:run
npm run build
npm pack
```

要运行一多适配闭环的集成测试，将 `DAG_TEST_ONE_DUO` 设为 `1` 后执行 `npm run test:run`。`OPENCODE_BIN` 可指定 OpenCode 1.19.5 的路径。此测试使用真实 Git 和 OpenCode，以及模拟的模型、Gitea API 和设备评测。

提示词存放在 prompts 和 src/dag_run/worker.md。发布包包含编译后的 TUI、服务端源码、提示词、Windows x64 的 Gitea 二进制和 macOS 的下载校验清单。修改后需重启 OpenCode。

Gitea 的来源及许可见 THIRD_PARTY_NOTICES.md、vendor/gitea/LICENSE 和 vendor/gitea/THIRD_PARTY_LICENSES.txt。
