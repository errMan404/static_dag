为当前 HarmonyOS 工程的全部页面注册自定义网址直达入口，供后续阶段逐页打开并验证界面。本阶段只加入口，不改任何业务逻辑和界面。

补充要求（可为空）：$ARGUMENTS

## 依据

先加载 skill `ui-verification-with-deeplink`，改 `.ets` 前加载 `hmos-arkui-develop-skill`。任一 skill 加载不到就停止并说明，不要凭记忆替代。

入口的设计与实现遵循 `ui-verification-with-deeplink` 的第 1、3、4、5 节和“实现后必查项”：网址格式、参数只走 query 并在唯一解析层校验、固定白名单映射、`module.json5` 中独立的 skill、冷启动与 `onNewWant` 共用一个解析入口、界面就绪后再跳转、不在 `loadContent` 回调里同步跳转。临时代码仍用 `UI_VERIFY_DEEPLINK_BEGIN` / `UI_VERIFY_DEEPLINK_END` 成对标记包住。

与该 skill 不同的地方，以本文为准：

- 入口不在本阶段还原。它作为一次独立提交保留，全部验证结束后由后续阶段对该提交执行 `git revert`。所以跳过 skill 的第 2 节（工程外快照）、第 9、10 节（还原）。
- 本阶段不调用 `verify_ui`，跳过第 7、8 节。只确认每个网址能打开对应页面。
- 覆盖全量页面，而不是某一个验证单元所需的页面。

## 步骤

1. 确认 `git status --porcelain --untracked-files=no` 为空；不为空就停止，请用户先提交。记录当前 HEAD。
2. 盘点页面。读 `module.json5`、`main_pages.json`、入口 Ability、所有 `@Entry`、`Navigation` 的路由表或 `route_map.json`、`NavDestination`。以下每一项都算一个页面：
   - 每个 Router 页面、每个 `NavDestination`；
   - 首页 `Tabs` 的每一个页签；
   - 由页面内状态打开、占据整屏或大半屏的界面：半模态、全屏模态、对话框、展开后的筛选面板。逐个页面查 `bindSheet`、`bindContentCover`、`CustomDialog`、`openCustomDialog` 及控制它们显示的状态变量，确认各由哪个操作打开。
   如实列出，包括启动页、隐私协议页、登录页。不臆造页面。
3. 为每个页面设计网址：`<scheme>://test/<path>?<query>`。scheme 取自应用业务名，小写；path 用稳定的业务名，不暴露文件路径。页面需要参数（如商品编号）时，从工程自带的数据里选一个确定存在的值写进 query，并记入清单。
   进入页面时就已经自动展开、不需要任何点击的弹层，与它所在的页面是同一个界面，不单独列一条：在所在页面的 `note` 里写明，并把它的特征文字并入该页面的 `signature`。清单里不允许两条的网址和 `steps` 完全相同。
   只给能通过导航栈到达的页面注册网址。由页面内状态打开的界面不注册网址、不改它所在的业务页面：清单里 `uri` 填它所在页面的网址，另用 `steps` 写出打开它的点击操作（见清单格式）。这样入口提交只涉及入口壳文件，不与后续的适配改动冲突。
4. 实现。用工程现有的导航方式和参数模型打开目标页（Router 用 Router，`NavPathStack` 用 `NavPathStack`），默认保留 `[首页, 目标页]` 的返回栈。没有网址时启动路径与原来完全一致。只改入口所需的最少文件。
5. `devecocli build`。只修复本次入口引入的编译错误。
6. 有设备时：`devecocli run --skip-build` 部署（连着多台设备时用 `--device` 指定一台，`hdc` 用 `-t` 指定同一台；`hdc` 不在 PATH 时用 DevEco Studio SDK 里 `toolchains/hdc` 的完整路径）。一次只操作一台设备。然后逐项确认：
   - 冷启动：对每个网址先强制停止应用，再执行 `hdc shell "aa start -U '<网址>'"`，导出组件树确认到达的是目标页。
   - 热启动：不停止应用，把全部网址连续跳一遍，每次都确认到达。同名页面的实例在热启动时可能被复用而不再触发 `aboutToAppear`（例如连续切换首页页签），这类参数要用状态驱动，不能只在 `aboutToAppear` 里读一次。
   - 异常参数：对每个带参数的网址，分别用缺少参数、参数值不存在两种形式各跳一次，应用应停在原页面且不崩溃；之后查看 `/data/log/faultlog/faultlogger` 确认没有新增本应用的崩溃日志。SDK 声明返回 `null` 的接口在运行时可能返回 `undefined`，两者都要判。
   - 不带网址正常启动一次，确认启动路径与改动前一致。
   - 不要用 `aa start` 去试没有注册的网址：系统会弹出“暂无可用打开方式”对话框盖住应用。导出结果里应用窗口消失时，先检查是否有系统对话框，用返回键关掉。
   - 带 `steps` 的条目：打开网址后按 `steps` 逐步点击，确认 `signature` 出现。这类条目只要求冷启动确认：对话框一类的浮层挂在窗口上，热启动跳到别的网址后可能仍留在屏幕上，所以每个带 `steps` 的条目都要先强制停止应用再验证，并在 `note` 里写明“需冷启动”。点击目标要用界面上唯一的文字或 id，同一文字出现多处时换一个或加 `type` 限定。
   - 会自行跳走的页面（启动倒计时页、已同意过协议时的隐私页等）：到达后立即导出；仍确认不了的标 `unverified` 并写明原因，不要为了让它停住而改业务代码。
   没有设备时不要尝试其他途径，清单里一律标 `unverified`。
7. 只把入口相关的源码改动做成一次提交，提交信息固定为 `chore(prepare): register UI verification deeplinks`。不要把 `.dag/` 下的文件放进这次提交。
8. 用 write 工具把完整清单写到 `.dag/pages.json`（见下）。插件在写入前校验，不合格时 write 会报错并说明原因，文件不会被写入：按报错修正后重新 write，直到写入成功。没有 write 工具的模型改用 apply_patch：用一段 `*** Add File: <路径>`，内容是完整 JSON，校验方式相同。不要用 shell 命令或 edit 工具写这个文件，也不要因为没有 write 工具就只把清单贴在回复里。

## 清单格式

```json
{
  "version": 1,
  "bundle": "com.example.app",
  "ability": "EntryAbility",
  "scheme": "exampleapp",
  "commit": "<第 7 步提交的完整哈希>",
  "pages": [
    {
      "name": "OptimalStation",
      "uri": "exampleapp://test/optimal-station",
      "source": "features/service/src/main/ets/pages/OptimalStation.ets",
      "signature": ["附近充电站"],
      "status": "verified"
    },
    {
      "name": "CommodityDetail.SpecSheet",
      "uri": "exampleapp://test/commodity-detail?id=a",
      "steps": [{"click": {"text": "加入购物车"}}],
      "source": "features/shoppingMall/src/main/ets/pages/CommodityDetailPage.ets",
      "signature": ["选择规格"],
      "status": "verified"
    }
  ]
}
```

- `name`：页面的稳定名称，全清单唯一。
- `signature`：到达该页后界面上一定出现的 1~3 段文字或组件 id，后续阶段用它确认页面已打开。
- `steps`：可选。网址打开后还要做的点击，按顺序执行，每项为 `{"click": {"text": "…"}}`，目标可用 `text`、`id`、`type` 指定。只用于页面内状态才能打开的界面；`signature` 写的是全部步骤完成后出现的内容。多个条目可以共用同一个网址，只要 `steps` 不同。
- `status`：`verified`（已在设备上确认冷、热启动都能到达）、`unverified`（没有设备或未确认）、`failed`（入口无法到达该页）。后两种必须写 `reason`。
- 可选字段：`params`（网址里用到的参数及取值依据）、`note`（后续阶段打开该页时需要知道的事，如“数秒后自动跳走”“进入后面板默认展开”）。
- 盘点到但网址和 `steps` 都到不了的页面也要列出，`uri` 填 `null`，`status` 填 `failed` 并写明原因。

## 结束时报告

页面总数及三种状态各多少；在哪台设备上验证的；提交哈希；改动的文件；编译与部署结果；未能确认的页面及原因。没有在设备上确认过的，不得说成已验证。
