import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPanel } from '../src/dag_run/tui-controller.js';
import { viewFromPart, workflowTreeRows } from '../src/dag_run/panel-model.js';
import { Progress } from '../src/dag_run/progress.js';

test('工作流树纵向展开历史轮次，折叠不丢同号节点和设备结论', () => {
  const workflow = {phase: 'evaluating', round: 2, checkCount: 2, targets: ['Pura X Max', '三折叠'], rounds: [
    {round: 1, commit: '1'.repeat(40), change: 'done', result: {action: 'repair'},
      changeTasks: [{id: 1, title: '开发商城', status: 'done', session: 'dev-1', pr: 1}],
      evaluationTasks: [{id: 1, target: 'Pura X Max', itemCount: 1, status: 'done', session: 'eval-1', verdict: {failed: 1}}]},
    {round: 2, commit: '2'.repeat(40), change: 'done',
      changeTasks: [{id: 1, title: '修复商城', status: 'done', session: 'dev-2', pr: 2}],
      evaluationTasks: [{id: 1, target: '三折叠', itemCount: 1, status: 'running', session: 'eval-2'}]}
  ]};
  const view = {status: 'running', workflow};
  const rows = workflowTreeRows(view);
  assert.deepEqual(rows.filter(row => row.type === 'round').map(row => row.label), ['第 1 轮 · 首次开发', '第 2 轮 · 修复']);
  assert.equal(rows[0].summary, '验收清单已固定 · 2 项');
  const historical = rows.find(row => row.task?.session === 'eval-1');
  assert.equal(historical.prefix, '│     └─ ');
  assert.equal(historical.task.status, 'done');
  assert.equal(historical.status, 'failed');
  assert.match(historical.summary, /1 失败/);
  const folded = workflowTreeRows(view, new Set(['round:1']));
  assert.equal(folded.find(row => row.key === 'round:1').expanded, false);
  assert.deepEqual(folded.filter(row => row.task).map(row => row.task.session), ['dev-2', 'eval-2']);
  assert.notEqual(historical.key, rows.find(row => row.task?.session === 'eval-2').key);
  assert.equal(rows.find(row => row.key === 'round:2:plan').status, 'done');
});

test('修复规划中的树提前展示下一轮，暂停状态覆盖未完成阶段', () => {
  const view = {status: 'running', workflow: {phase: 'repairing', round: 1, checkCount: 1, rounds: [
    {round: 1, change: 'done', result: {action: 'repair'}}
  ]}};
  const repairing = workflowTreeRows(view);
  assert.equal(repairing.find(row => row.key === 'round:2:plan').status, 'running');
  const paused = workflowTreeRows({status: 'paused', workflow: {...view.workflow, phase: 'finished'}});
  assert.equal(paused.find(row => row.key === 'round:1').status, 'paused');
  assert.ok(!paused.some(row => row.key === 'round:2:plan'));
});

test('首次规划节点显示清单、工具进度和规划会话', () => {
  const planning = {round: 1, status: 'running', session: 'first-plan', checkCount: 15,
    activity: {tool: 'read', startedAt: 1}};
  const workflow = {phase: 'planning', round: 1, planning, rounds: []};
  const view = {status: 'running', workflow};
  const row = () => workflowTreeRows(view).find(candidate => candidate.key === 'initial-plan');
  assert.equal(row().task.session, planning.session);
  assert.equal(row().status, 'running');
  assert.equal(row().summary, '验收清单已固定 · 15 项 · 读取文件中');

  delete planning.activity;
  assert.match(row().summary, /等待模型响应/);

  const finishedAt = new Date(2026, 10, 20, 1, 20, 30).getTime();
  Object.assign(planning, {taskCount: 7, activity: {tool: 'submit_plan', startedAt: finishedAt - 10, finishedAt}});
  assert.equal(row().summary, '验收清单已固定 · 15 项 · 已提交 7 个任务 · 等待模型响应 · 最近提交 DAG 01:20:30');

  workflow.phase = 'developing';
  workflow.rounds = [{round: 1, planning: {...planning, status: 'done'}}];
  delete workflow.planning;
  assert.equal(row().task.session, planning.session);
  assert.equal(row().status, 'done');
  assert.equal(row().summary, '验收清单已固定 · 15 项 · 已提交 7 个任务');
});

test('修复规划提前显示会话并在轮次建好或失败后保留规划节点', () => {
  const firstRound = {round: 1, change: 'done', result: {action: 'repair'}};
  const repair = {round: 2, status: 'running'};
  const workflow = {phase: 'repairing', round: 1, checkCount: 15, planning: repair, rounds: [firstRound]};
  const view = {status: 'running', workflow};
  const row = () => workflowTreeRows(view).find(candidate => candidate.key === 'round:2:plan');
  assert.equal(row().summary, '正在创建 Agent 会话');
  assert.equal(row().task, undefined);
  repair.session = 'repair-planner';
  assert.equal(row().task.session, 'repair-planner');
  assert.equal(row().summary, '等待模型响应');

  workflow.phase = 'finished';
  view.status = 'failed';
  Object.assign(repair, {status: 'failed', error: '修复规划失败'});
  assert.equal(row().status, 'failed');
  assert.equal(row().task.error, repair.error);

  workflow.phase = 'developing';
  workflow.round = 2;
  view.status = 'running';
  workflow.rounds.push({round: 2, planning: {...repair, status: 'done', error: undefined, taskCount: 2}});
  delete workflow.planning;
  assert.equal(workflowTreeRows(view).filter(candidate => candidate.key === 'round:2:plan').length, 1);
  assert.equal(row().task.session, 'repair-planner');
  assert.equal(row().status, 'done');
  assert.equal(row().summary, '已提交 2 个任务');
});

test('看板从工作流快照显示设备排队和残留锁原因', () => {
  const progress = new Progress({}, '/project', 'parent');
  const deviceLockError = 'TripleFold_API_26 的设备锁所属进程 1234 已退出';
  progress.workflow = {state: {status: 'running', phase: 'evaluating', round: 1, checkCount: 2,
    targets: ['Pura X Max', '三折叠'], rounds: [{round: 1, change: 'done', evaluationTasks: [
      {id: 1, target: 'Pura X Max', status: 'running', session: 'eval-1', itemCount: 1, waitingDevice: {device: 'WideFold_API_26', pid: 4321},
        activity: {tool: 'reserve_evaluation_device', startedAt: 1}},
      {id: 2, target: '三折叠', status: 'done', session: 'eval-2', itemCount: 1, verdict: {unverified: 1}, deviceLockError}
    ]}]} };
  const tasks = workflowTreeRows(progress.view()).filter(row => row.task);
  assert.match(tasks[0].summary, /等待设备 WideFold_API_26（PID 4321）/);
  assert.doesNotMatch(tasks[0].summary, /reserve_evaluation_device/);
  assert.match(tasks[1].summary, /1 未验证 · 设备锁残留/);
  assert.equal(tasks[1].task.error, deviceLockError);
});

test('设备评测展示已提交检查和工具活动，最终报告展示结论', () => {
  const progress = new Progress({}, '/project', 'parent');
  const finishedAt = new Date(2026, 10, 19, 22, 17, 9).getTime();
  const tasks = [
    {id: 1, target: 'Pura X Max', status: 'running', session: 'eval-1', itemCount: 5,
      checkProgress: {submitted: 1, lastId: 'PX-01', results: {hidden: true}},
      activity: {tool: 'devecocli', startedAt: finishedAt, input: {hidden: true}}},
    {id: 2, target: '三折叠', status: 'running', session: 'eval-2', itemCount: 6,
      checkProgress: {submitted: 2, lastId: 'TF-02'},
      activity: {tool: 'devecocli', startedAt: finishedAt - 1000, finishedAt}}
  ];
  progress.workflow = {state: {status: 'running', phase: 'evaluating', round: 1, checkCount: 11,
    targets: ['Pura X Max', '三折叠'], rounds: [{round: 1, change: 'done', evaluationTasks: tasks}]}};
  const rows = workflowTreeRows(progress.view());
  const deviceRows = rows.filter(row => row.task);
  assert.equal(rows.find(row => row.key === 'round:1:evaluation').summary, '3/11 已提交');
  assert.equal(deviceRows[0].summary, '1/5 已提交 · devecocli 执行中');
  assert.equal(deviceRows[1].summary, '2/6 已提交 · 最近 devecocli 22:17:09');
  assert.deepEqual(deviceRows[0].task.checkProgress, {submitted: 1, lastId: 'PX-01'});
  assert.equal(deviceRows[0].task.activity.input, undefined);

  progress.workflow.state.phase = 'finished';
  Object.assign(tasks[0], {status: 'done', verdict: {passed: 4, failed: 1}});
  Object.assign(tasks[1], {status: 'done', verdict: {passed: 6}});
  const finished = workflowTreeRows(progress.view());
  assert.equal(finished.find(row => row.key === 'round:1:evaluation').summary, '10 通过 · 1 失败');
  assert.equal(finished.find(row => row.task?.session === 'eval-1').summary, '5 项 · 4 通过 · 1 失败');
});

test('面板随事件更新；只进入已创建的原生会话；从子会话取消仍作用于主 DAG', async () => {
  const store = new Map(), commands = [], navigation = [], controls = [], toasts = [], layers = [];
  let handler, props, route;
  const view = {id: 'run-1', root: 'D:\\repo', parent: 'parent', status: 'running', tasks: [
    {id: 1, title: '基础模块', dependencies: [], status: 'running', session: 'worker-1'},
    {id: 2, title: '后续模块', dependencies: [1], status: 'pending'}]};
  const api = {
    state: {path: {worktree: 'D:\\repo'}}, kv: {get: key => store.get(key), set: (key, value) => store.set(key, value)},
    event: {on(type, fn) {handler = fn; return () => {}; }}, lifecycle: {onDispose() {}},
    keymap: {registerLayer(input) {layers.push(input); commands.push(...input.commands);}},
    route: {current: {name: 'session', params: {sessionID: 'parent'}}, register(routes) {route = routes[0];}, navigate(...args) {navigation.push(args); api.route.current = {name: args[0], params: args[1]};}},
    ui: {toast: value => toasts.push(value), DialogSelect(input) {props = input;}, dialog: {replace(render) {render();}, setSize() {}, clear() {}}},
    client: {session: {async messages() {return {data: [{parts: [{metadata: {dagView: view}}]}]};}, async prompt(input) {controls.push(input); return {data: {}};}}}
  };
  await installPanel(api, input => {props = input;});
  await commands.find(command => command.slashName === 'dag_panel').run();
  assert.equal(api.route.current.name, 'static-dag.dashboard');
  route.render();
  assert.equal(props.view().tasks.length, 2); assert.deepEqual(props.view().tasks[1].dependencies, [1]);
  const before = navigation.length;
  props.open(props.view().tasks[1]); assert.equal(navigation.length, before); assert.match(toasts.at(-1).message, /尚未创建/);
  props.open(props.view().tasks[0]); assert.deepEqual(navigation.at(-1), ['session', {sessionID: 'worker-1'}]);
  const returnLayer = layers.find(layer => layer.bindings.some(binding => binding.cmd === 'static-dag.detail.back'));
  assert.equal(returnLayer.mode, 'base'); assert.ok(returnLayer.enabled());
  const taskView = props.view();
  // A newer run in the same repository must not steal an older Agent's return path.
  handler({properties: {part: {metadata: {dagView: {...view, id: 'run-2', tasks: [{id: 1, session: 'other-worker', dependencies: []}]}}}}});
  assert.equal(props.view().id, 'run-1');
  commands.find(command => command.name === 'static-dag.detail.back').run();
  assert.deepEqual(navigation.at(-1), ['static-dag.dashboard', {root: 'D:\\repo', parent: 'parent', runId: 'run-1', focusTask: 1}]);
  assert.equal(returnLayer.enabled(), false);
  props.open(taskView.tasks[0]);
  api.state.path.worktree = 'D:\\repo-worktrees\\old-source-path';
  await commands.find(command => command.slashName === 'dag_cancel').run();
  assert.equal(controls.at(-1).sessionID, 'parent'); assert.equal(controls.at(-1).noReply, true);
  assert.equal(controls.at(-1).parts[0].metadata.dagControl.action, 'cancel');
  handler({properties: {part: {metadata: {dagView: {...view, status: 'done', tasks: view.tasks.map(task => ({...task, status: 'done'}))}}}}});
  assert.equal(props.view().status, 'done'); assert.ok(props.view().tasks.every(task => task.status === 'done'));
  props.back(); assert.deepEqual(navigation.at(-1), ['session', {sessionID: 'parent'}]);
  assert.equal(returnLayer.enabled(), false, '主会话保持原生方向键行为');
  api.route.current = {name: 'session', params: {sessionID: 'unrelated-agent'}};
  assert.equal(returnLayer.enabled(), false, '普通 Agent 保持原生方向键行为');
  api.state.path.worktree = 'D:\\repo';
  api.route.current = {name: 'session', params: {sessionID: 'fresh-session'}};
  assert.equal(props.view(), undefined, '同一工作区的新 session 不得继承旧 DAG');
  const calls = controls.length;
  await commands.find(command => command.slashName === 'dag_status').run();
  assert.equal(controls.length, calls, '新 session 查询状态不得向旧主会话发控制消息');
  assert.equal(api.route.current.params.parent, 'fresh-session');
  assert.equal(props.view(), undefined);
  await commands.find(command => command.slashName === 'dag_run').run();
  assert.equal(controls.at(-1).sessionID, 'fresh-session');
  assert.equal(controls.at(-1).parts[0].synthetic, true);
  assert.equal(props.view().parent, 'fresh-session');
  api.route.current = {name: 'session', params: {sessionID: 'worker-1'}};
  assert.equal(props.view().id, 'run-1', '旧任务仍能回到自己所属的运行批次');
});

test('工作流切换轮次后仍能定位历史会话，并在正确的主会话发送控制请求', async () => {
  const root = 'D:\\repo', parent = 'workflow-parent', runId = 'workflow-1';
  const task = (session, title, status = 'done') => ({id: 1, session, title, status, dependencies: []});
  const firstChange = task('change-r1', '首轮开发');
  const firstEval = task('eval-r1', '首轮评测');
  const secondChange = task('change-r2', '第二轮修复');
  const secondEval = task('eval-r2', '第二轮评测', 'running');
  const firstPlanning = {round: 1, status: 'done', session: parent};
  const secondPlanning = {round: 2, status: 'done', session: 'plan-r2'};
  const early = {id: runId, root, parent, status: 'running', updatedAt: 1000, tasks: [firstChange],
    workflow: {phase: 'developing', round: 1, planning: firstPlanning, rounds: [{round: 1, changeTasks: [firstChange]}]}};
  const latest = {...early, updatedAt: 2000, tasks: [secondEval],
    workflow: {phase: 'evaluating', round: 2, rounds: [
      {round: 1, planning: firstPlanning, changeTasks: [firstChange], evaluationTasks: [firstEval]},
      {round: 2, planning: secondPlanning, changeTasks: [secondChange], evaluationTasks: [secondEval]}
    ]}};
  const kv = new Map(), layers = [], requests = [], navigation = [];
  let update, dashboard, props;
  const api = {
    state: {path: {worktree: root}}, kv: {get: key => kv.get(key), set: (key, value) => kv.set(key, value)},
    event: {on(type, handler) {update = handler; return () => {};}}, lifecycle: {onDispose() {}},
    keymap: {registerLayer(layer) {layers.push(layer);}},
    route: {
      current: {name: 'session', params: {sessionID: parent}},
      register(routes) {dashboard = routes[0];},
      navigate(name, params) {navigation.push({name, params}); api.route.current = {name, params};}
    },
    ui: {toast() {}, dialog: {clear() {}}},
    client: {session: {
      async create(input) {requests.push(input); return {data: {id: 'new-parent'}};},
      async messages(input) {requests.push(input); return {data: [{parts: [{metadata: {dagView: early}}]}]};},
      async prompt(input) {requests.push(input); return {data: {}};}
    }}
  };
  await installPanel(api, input => {props = input;});
  const command = name => layers.flatMap(layer => layer.commands).find(command => command.name === name).run;
  const detail = layers.find(layer => layer.mode === 'base');
  update({properties: {part: {metadata: {dagView: early}}}});
  assert.equal(detail.enabled(), false, '首次规划使用主会话，保留主会话原生按键');
  await command('static-dag.panel')();
  dashboard.render();
  update({properties: {part: {metadata: {dagView: latest}}}});
  assert.equal(props.view().workflow.round, 2);

  props.open(firstEval);
  api.state.path.worktree = 'D:\\old-worktree';
  assert.ok(detail.enabled(), '历史评测会话也应显示返回看板');
  await command('static-dag.panel')();
  assert.deepEqual(requests.at(-1), {sessionID: parent, directory: root});
  assert.deepEqual(navigation.at(-1), {name: 'static-dag.dashboard', params: {root, parent, runId, focusSession: firstEval.session}});
  dashboard.render();
  assert.equal(props.focusSession, firstEval.session);
  assert.equal(props.view().workflow.round, 2, '较旧的恢复记录不能覆盖已收到的新阶段');

  props.open(secondPlanning);
  assert.ok(detail.enabled(), '修复规划会话可以直接返回看板');
  command('static-dag.detail.back')();
  assert.deepEqual(navigation.at(-1).params, {root, parent, runId, focusSession: secondPlanning.session});
  props.open(firstEval);
  command('static-dag.detail.back')();

  await command('static-dag.status')();
  assert.equal(requests.at(-1).sessionID, parent);
  assert.equal(requests.at(-1).parts[0].metadata.dagControl.action, 'status');
  assert.equal(navigation.at(-1).params.focusSession, firstEval.session);
  props.open(firstChange);
  assert.ok(detail.enabled());
  command('static-dag.detail.back')();
  assert.deepEqual(navigation.at(-1).params, {root, parent, runId, focusSession: firstChange.session});
  props.open(firstEval);
  await command('static-dag.cancel')();
  assert.equal(requests.at(-1).sessionID, parent);
  assert.equal(requests.at(-1).directory, root);
  assert.equal(requests.at(-1).parts[0].metadata.dagControl.action, 'cancel');
  assert.equal(navigation.at(-1).params.focusSession, firstEval.session);

  const resume = layers.flatMap(layer => layer.commands).find(command => command.slashName === 'one_duo_resume');
  props.open(firstEval);
  await resume.run();
  assert.equal(requests.at(-1).noReply, true);
  assert.equal(requests.at(-1).parts[0].metadata.dagControl.action, 'resume-one-duo');
  assert.deepEqual(navigation.at(-1), {name: 'static-dag.dashboard', params: {root, parent}});

  api.route.current = {name: 'home'};
  api.state.path.worktree = root;
  await resume.run();
  assert.deepEqual(requests.at(-2), {directory: root, title: '一多适配续跑'});
  assert.equal(requests.at(-1).sessionID, 'new-parent');
  assert.equal(requests.at(-1).noReply, true);
});

test('只隐藏插件的控制及状态消息，保留内容、metadata 和普通用户消息', async () => {
  const updates = []; let detail;
  const api = {
    state: {path: {worktree: 'D:\\repo'}}, kv: {get() {}, set() {}},
    event: {on() {return () => {};}}, lifecycle: {onDispose() {}},
    route: {current: {name: 'session', params: {sessionID: 'old-parent'}}, register() {}},
    keymap: {registerLayer() {}}, ui: {dialog: {}},
    slots: {register(plugin) {plugin.slots.app_bottom();}},
    client: {part: {async update(input) {updates.push(input); return {data: input.part};}}}
  };
  await installPanel(api, () => {}, input => {detail = input;});
  const control = {type: 'text', id: 'control', sessionID: 'old-parent', messageID: 'm1', text: '/dag_run', metadata: {dagControl: {action: 'start', root: 'D:\\repo'}}};
  const progress = {type: 'text', id: 'progress', sessionID: 'old-parent', messageID: 'm2', text: 'DAG 已完成', metadata: {dagProgress: true, dagView: {status: 'done'}}};
  const user = {type: 'text', id: 'user', sessionID: 'old-parent', messageID: 'm3', text: '/dag_run'};
  await detail.hideTransport(control); await detail.hideTransport(progress); await detail.hideTransport(user);
  assert.equal(updates.length, 2);
  assert.ok(updates.every(input => input.part.synthetic && input.part.ignored));
  assert.equal(updates[0].part.text, control.text); assert.deepEqual(updates[1].part.metadata, progress.metadata);
  assert.equal(updates[0].part.metadata.dagControlHandled, true, '隐藏历史控制消息不得触发重放');
  assert.equal(control.synthetic, undefined, '不原地修改宿主 store 对象');
});

test('旧版完成记录恢复固定耗时，运行中的记录保留实时字段', () => {
  const old = {text: '状态：已完成 · 耗时 152 秒', metadata: {dagView: {startedAt: 1000, status: 'done'}}};
  assert.equal(viewFromPart(old).updatedAt, 153000);
  assert.equal(old.metadata.dagView.updatedAt, undefined);
  const live = {metadata: {dagView: {status: 'running', startedAt: 1000, updatedAt: 2000}}};
  assert.equal(viewFromPart(live), live.metadata.dagView);
});
