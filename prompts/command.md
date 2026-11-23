请为以下用户需求生成开发任务 DAG：

{{requirement}}

当前项目目录：{{directory}}
当前 worktree 根目录：{{worktree}}
唯一允许写入的文件：{{dag_path}}

直接在当前 Agent 会话分析和规划，用原生 write 工具提交完整 JSON 到指定路径（没有 write 工具的模型改用 apply_patch：整个补丁只含一段 `*** Add File: <路径>`，内容是完整 JSON，校验方式相同）。没有指定任务数量。任务依赖通过 dependencies 表达。
