import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, rm, writeFile, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OneDuo} from '../src/one_duo.js';
import {registry} from '../src/dag_run/index.js';
import {treeRows} from '../src/dag_run/panel-model.js';
import {installPanel} from '../src/dag_run/tui-controller.js';
import {runnerHooks} from '../src/dag_run/plugin.js';

const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8'}).trim();
const DAG = {tasks: [
  {id: 1, title: '公共基础', description: 'd', testStrategy: 't', dependencies: []},
  {id: 2, title: '商城页', description: 'd', testStrategy: 't', dependencies: [1]},
  {id: 3, title: '登录页', description: 'd', testStrategy: 't', dependencies: [1]}]};

// A project where /prepare has already run and both devices have "before" screenshots.
async function fixture(t, {entry = true, captures = true} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'one-duo-test-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(join(root, 'Entry.ets'), entry ? '// UI_VERIFY_DEEPLINK_BEGIN\n// UI_VERIFY_DEEPLINK_END\n' : '// app\n');
  git(root, 'init', '-q'); git(root, 'add', '.'); git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'entry');
  await mkdir(join(root, '.dag/captures/wide'), {recursive: true});
  await writeFile(join(root, '.dag/pages.json'), JSON.stringify({version: 1, bundle: 'com.example.app', ability: 'EntryAbility', scheme: 'shop', commit: git(root, 'rev-parse', 'HEAD'),
    pages: [{name: 'Mall', uri: 'shop://test/mall', signature: ['Mall'], status: 'verified'}]}));
  await writeFile(join(root, '.dag/devices.json'), JSON.stringify({version: 1, devices: [{config: 'wide', device: 'w1'}]}));
  if (captures) await writeFile(join(root, '.dag/captures/wide/summary.json'), JSON.stringify({device: 'w1', display: {width: 2584, height: 1828, density: 2.75}, results: []}));
  const views = [], commands = [], toasts = [], aborted = [];
  let onCommand = async () => {};
  const client = {
    session: {
      async create({body}) { return {data: {id: `ses-${body.title}`}}; },
      async prompt({body}) { views.push(body.parts[0].metadata.dagView); return {data: {parts: [{type: 'text', id: 'part', messageID: 'msg', metadata: {}}]}}; },
      async abort({path}) { aborted.push(path.id); return {data: true}; },
    },
    _client: {
      async patch({body}) { views.push(body.metadata.dagView); return {data: body}; },
      async post({url, body}) { commands.push([url, body.command, body.arguments, body.agent]); await onCommand(body); return {data: {parts: []}}; },
    },
    tui: {async showToast({body}) { toasts.push(body.message); }},
  };
  const run = {state: {id: 'run-1', status: 'running', maxConcurrency: 20, tasks: DAG.tasks.map(task => ({...task, status: 'pending'}))},
    async execute() { for (const task of this.state.tasks) task.status = 'done'; this.state.status = 'done'; return this.state; }, async cancel() { this.cancelled = true; }};
  const checks = [];
  const check = async input => { checks.push(input.mainRoot); return {commit: 'c', devices: [{config: 'wide', dir: join(root, '.dag/result/wide'), captured: 1, lost: [], unseen: []}]}; };
  const pipeline = extra => new OneDuo({root, parent: 'parent', client, startRun: async () => run, detect: async () => [], check, ...extra});
  return {root, client, views, commands, toasts, aborted, run, pipeline, checks, plan(dag = DAG) { onCommand = async body => { if (body.command === 'dag_pages') await writeFile(join(root, '.dag/dag.json'), JSON.stringify(dag)); }; }, set onCommand(fn) { onCommand = fn; }};
}

test('节点按步骤排布：每步有标题说明并行数和等待谁，依赖不一致时写在节点上，评审缩进在任务下并标明设备', () => {
  const view = {tasks: [
    {id: 'prepare', kind: 'stage', title: '准备', status: 'done', dependencies: []},
    {id: 'plan', kind: 'stage', title: '规划', status: 'done', dependencies: ['prepare']},
    {id: 1, title: '公共基础', status: 'done', dependencies: ['plan']},
    {id: 5, title: '启动页', status: 'done', dependencies: ['plan']},
    {id: 2, title: '商城页', status: 'running', dependencies: [1], reviews: [{page: 'Mall', config: 'wide', session: 'r1', round: 1, verdict: 'revise'}, {page: 'Mall', config: 'tri', session: 'r2', round: 1}]},
    {id: 3, title: '登录页', status: 'pending', dependencies: [1]},
    {id: 4, title: '商城子页', status: 'pending', dependencies: [2]},
    {id: 6, title: '登录子页', status: 'pending', dependencies: [3]},
    {id: 'check', kind: 'stage', title: '收尾', status: 'pending', dependencies: [4, 5, 6]}]};
  const rows = treeRows(view);
  assert.deepEqual(rows.map(row => `${row.prefix}${row.label}${row.kind === 'header' ? '' : '|' + row.node.status}`), [
    '第 1 步', '  准备|done',
    '第 2 步', '  规划|done',
    '第 3 步 · 2 个节点同时执行', '  1. 公共基础|done', '  5. 启动页|done',
    '第 4 步 · 2 个节点同时执行 · 等 1 完成后开始', '  2. 商城页|running',
    '      评审 Mall · wide · 第 1 次 · 需修改|revise', '      评审 Mall · tri · 第 1 次 · 进行中|running', '  3. 登录页|pending',
    '第 5 步 · 2 个节点同时执行', '  4. 商城子页（等 2 完成后开始）|pending', '  6. 登录子页（等 3 完成后开始）|pending',
    '第 6 步 · 全部任务完成后开始', '  收尾|pending']);
  assert.equal(rows[9].node.session, 'r1', '评审行可以打开它自己的会话');
  // A blank line ends every step and every task that has reviews under it.
  assert.deepEqual(rows.filter(row => row.gap).map(row => row.key), ['prepare', 'plan', '5', '2/review-1', '3', '6', 'check']);
  assert.deepEqual(treeRows({tasks: []}), []); assert.deepEqual(treeRows(undefined), []);
});

test('/one_duo 依次执行各阶段：已有的入口和截图沿用，规划后运行任务图，全程是一张节点图', async t => {
  const f = await fixture(t); f.plan();
  const pipeline = await f.pipeline().run({pages: 'Mall'});
  assert.equal(pipeline.status, 'done');
  // Only planning needed an agent; it ran as the dag_pages command in its own child session.
  assert.deepEqual(f.commands, [['/session/ses-规划：按页面拆分适配任务/command', 'dag_pages', 'Mall', undefined]]);
  const view = f.views.at(-1);
  assert.equal(view.pipeline, true); assert.equal(view.status, 'done');
  assert.deepEqual(view.tasks.map(node => [node.id, node.kind, node.status, node.dependencies]), [
    ['prepare', 'stage', 'done', []], ['baseline', 'stage', 'done', ['prepare']], ['plan', 'stage', 'done', ['baseline']],
    [1, 'task', 'done', ['plan']], [2, 'task', 'done', [1]], [3, 'task', 'done', [1]], ['check', 'stage', 'done', [2, 3]]]);
  assert.match(view.tasks[0].detail, /沿用/); assert.match(view.tasks[1].detail, /已有 wide 的截图/); assert.equal(view.tasks[2].detail, '3 个任务');
  // The closing check ran once on the merged checkout, needed no agent, and says where the screenshots are.
  assert.deepEqual(f.checks, [f.root]); assert.equal(view.tasks.at(-1).detail, 'wide 1 页'); assert.equal(view.tasks.at(-1).session, undefined);
  assert.match(view.detail, /合并后的截图在 .*\.dag\/result\/wide/);
  assert.equal(view.tasks[2].session, 'ses-规划：按页面拆分适配任务');
  assert.match(view.detail, /全部任务完成/);
  assert.ok(f.views.some(v => v.tasks.find(node => node.id === 'plan').status === 'running'), '阶段进行中时界面能看到');
  assert.equal(registry.pipelines.has('parent'), false);
});

test('缺入口时由无人值守的阶段 agent 执行 /prepare；阶段没有产出则整条流程失败并说明原因', async t => {
  const f = await fixture(t, {entry: false});
  f.onCommand = async body => { if (body.command === 'prepare') { await writeFile(join(f.root, 'Entry.ets'), '// UI_VERIFY_DEEPLINK_BEGIN\n');
    git(f.root, 'add', '.'); git(f.root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'entry2'); } };
  const first = await f.pipeline().run();
  assert.deepEqual(f.commands[0].slice(1), ['prepare', '', 'dag-stage']);
  // /prepare restored the entry, then planning wrote nothing: the run stops there and later nodes stay pending.
  assert.equal(first.status, 'failed');
  const view = f.views.at(-1);
  assert.deepEqual(view.tasks.map(node => node.status), ['done', 'done', 'failed', 'pending']);
  assert.match(view.tasks[2].error, /没有写出新的 \.dag\/dag\.json/); assert.match(f.toasts.at(-1), /dag\.json/);

  const g = await fixture(t, {entry: false});
  const second = await g.pipeline().run();
  assert.equal(second.status, 'failed'); assert.match(g.views.at(-1).tasks[0].error, /没有得到可用的 \.dag\/pages\.json 和入口提交/);
  assert.deepEqual(g.views.at(-1).tasks.map(node => node.status), ['failed', 'pending', 'pending', 'pending']);
});

test('合并后有原本能打开的页面打不开：流程失败并指出页面；任务没跑完时不做收尾', async t => {
  const f = await fixture(t); f.plan();
  const lost = await f.pipeline({check: async () => ({commit: 'c', devices: [{config: 'wide', dir: '/shots/wide', captured: 0, lost: [{page: 'Mall', error: 'page-not-reached'}], unseen: ['Splash']}]})}).run();
  assert.equal(lost.status, 'failed');
  assert.equal(f.views.at(-1).tasks.at(-1).status, 'failed');
  assert.match(f.toasts.at(-1), /wide 上的 Mall（page-not-reached）/); assert.ok(!f.toasts.at(-1).includes('Splash'), '适配前就打不开的页面不算问题');

  const g = await fixture(t); g.plan();
  g.run.execute = async function () { this.state.status = 'failed'; this.state.error = '任务 2 失败'; return this.state; };
  const stopped = await g.pipeline().run();
  assert.equal(stopped.status, 'failed'); assert.deepEqual(g.checks, []); assert.equal(g.views.at(-1).tasks.at(-1).status, 'pending');
});

test('取消会停掉当前阶段的 agent；控制消息 one_duo 启动流程，cancel 作用于它', async t => {
  const f = await fixture(t);
  let pipeline;
  f.onCommand = async () => { await pipeline.cancel(); throw new Error('aborted'); };
  pipeline = f.pipeline();
  await pipeline.run();
  assert.equal(pipeline.status, 'cancelled');
  assert.deepEqual(f.aborted, ['ses-规划：按页面拆分适配任务']);
  assert.equal(f.views.at(-1).tasks[2].status, 'cancelled'); assert.match(f.views.at(-1).detail, /已取消/);

  // Through the plugin: the control part starts a pipeline for this session, and a second one is not started.
  const g = await fixture(t); g.plan();
  const started = [];
  g.client.session.messages = async () => ({data: []});
  const hooks = runnerHooks({client: g.client, root: g.root});
  const part = action => ({type: 'text', ignored: true, id: `p-${action}-${started.push(action)}`, sessionID: 'parent', messageID: 'm',
    metadata: {dagControl: {action, root: g.root, requestId: 'r', issuedAt: Date.now()}}});
  await hooks.event({type: 'message.part.updated', properties: {part: part('one_duo')}});
  for (let i = 0; i < 200 && !registry.pipelines?.has('parent'); i++) await new Promise(done => setTimeout(done, 5));
  const running = registry.pipelines.get('parent');
  assert.ok(running, '流程已登记在这个会话上');
  await hooks.control({sessionID: 'parent', action: 'cancel'});
  for (let i = 0; i < 400 && registry.pipelines.has('parent'); i++) await new Promise(done => setTimeout(done, 5));
  assert.equal(running.status, 'cancelled');
});

test('界面注册 /one_duo，并能从评审会话回到节点图', async () => {
  const store = new Map(), commands = [], controls = [], navigation = [];
  let handler;
  const api = {state: {path: {worktree: '/repo'}}, kv: {get: key => store.get(key), set: (key, value) => store.set(key, value)},
    event: {on(type, fn) { handler = fn; return () => {}; }}, lifecycle: {onDispose() {}}, keymap: {registerLayer(input) { commands.push(...input.commands); }},
    route: {current: {name: 'session', params: {sessionID: 'parent'}}, register() {}, navigate(...args) { navigation.push(args); api.route.current = {name: args[0], params: args[1]}; }},
    ui: {toast() {}, dialog: {clear() {}}}, slots: {register() {}},
    client: {session: {async messages() { return {data: []}; }, async prompt(input) { controls.push(input); return {data: {}}; }}}};
  await installPanel(api, () => {});
  await commands.find(command => command.slashName === 'one_duo').run();
  assert.equal(controls[0].parts[0].metadata.dagControl.action, 'one_duo'); assert.equal(controls[0].parts[0].text, '/one_duo');
  assert.equal(navigation.at(-1)[0], 'static-dag.dashboard');
  handler({properties: {part: {metadata: {dagView: {id: 'p1', root: '/repo', parent: 'parent', status: 'running', pipeline: true,
    tasks: [{id: 2, title: '商城页', status: 'running', dependencies: [], session: 'worker', reviews: [{page: 'Mall', session: 'review-1'}]}]}}}}});
  api.route.current = {name: 'session', params: {sessionID: 'review-1'}};
  commands.find(command => command.name === 'static-dag.detail.back').run();
  assert.deepEqual(navigation.at(-1), ['static-dag.dashboard', {root: '/repo', parent: 'parent', runId: 'p1', focusTask: 2}]);
});
