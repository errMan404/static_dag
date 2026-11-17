# 完整 UX 卡片资产

Richard，此目录保存迁入 static_dag 主仓的现有资产，执行测试直接使用完整卡片包。

| 文件 | 内容 |
| --- | --- |
| [full-app-cards.json](full-app-cards.json) | 全应用卡片包，12 张，涵盖资讯、媒体、窗口状态、商城、详情、选择面板、购车、服务、站点、账户和公共导航 |
| [manifest.json](manifest.json) | 原始来源相对路径和 SHA256，用于核对迁移完整性 |

卡片包逐字节保留原始内容，迁移时已核对哈希。原资讯试点的三张卡片与全应用包对应内容完全一致，已去除重复子包。原资产中的本地来源路径属于历史出处记录，不表示主仓已迁入相应工具或历史试验工程。

`full-app-cards.json` 用于当前 DAG 节点注入。主仓不收录此前独立理财 case 的知识资产。

## 配置节点资产

复制 `full-app-cards.json` 到目标工程的 `ux-assets/full-app-cards.json`。在工程的 `.dag/ux.json` 中声明：

```json
{
  "version": 1,
  "cardsFile": "ux-assets/full-app-cards.json",
  "device": null,
  "requirements": ["保留原有业务与状态"],
  "nodes": [
    {"taskId": 1, "cardIds": ["UX.APP.SHELL"], "requirements": []}
  ]
}
```

`taskId` 应与真实 `.dag/dag.json` 对应，每个节点都须显式分配卡片。资产保存完整，每个节点只显式注入本次分配的内容。`device: null` 表示本轮不提供设备，代码任务继续，UX 保持 `unverified/no-device`。填写设备标识也不能自动通过验收，本版尚未接入设备执行器和独立证据验证器。

本轮资产内容及摘要保存在 `.dag/runs/<runId>/ux-input.json`，结果写入同目录的 `ux-report.json` 和 `ux-report.md`。布局计划先于改码目前通过提示词要求，尚不是工具层强制门禁。

## 运行流程测试

在主仓根目录执行：

```powershell
npm ci --ignore-scripts
npm install --prefix .test-tmp/host --ignore-scripts --no-audit --no-fund opencode-ai@1.19.5
npm run test:ux
```

测试使用真实 OpenCode 1.19.5 和 Git、本地确定性测试模型及模拟 Gitea API，检查节点资产注入、并行分叉与汇合、冲突修复、取消和无设备分支。结果保存在 `.test-tmp/ux-flow-result.json`；这不是实际应用的 UX 质量验收。

本次范围仅为当前全应用卡片包迁移。源码扫描、布局规划、规则求值、验收工具、单 Agent 启动器、浏览器工作台和技能资料的迁移，待方案确认后实施；现有 B 方案最小融合代码保留。
