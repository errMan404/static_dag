import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Progress } from '../src/dag_run/progress.js';
import { acquireRunLock } from '../src/dag_run/lock.js';
import plugin from '../src/plugin.js';
import { evaluationTasks, guardEvaluationDevEcoCli } from '../src/one-duo/evaluation.js';
import { parseOneDuoArgs } from '../src/one-duo/planning.js';
import { devicesForTargets, nextStep, validateChecklist, validateEvaluation, validateTargetNames } from '../src/one-duo/contracts.js';

const targets = ['phone', 'widefold'];
const items = [
  {id: 'PHONE-1', target: 'phone', steps: ['打开商城'], expected: '列表正常显示'},
  {id: 'WIDE-1', target: 'widefold', steps: ['切换折叠状态'], expected: '保留已选分类'},
  {id: 'WIDE-2', target: 'widefold', steps: ['展开后打开商城'], expected: '商品列完整可见'}
];
const checklist = validateChecklist(items, targets);

test('续跑只回收同一工作流已确认退出的运行锁', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dag-resume-lock-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, '.dag'));
  const path = join(root, '.dag/run.lock');
  const original = JSON.stringify({pid: 23456, workflowId: 'saved-workflow'});
  await writeFile(path, original);
  await assert.rejects(acquireRunLock(root, {workflowId: 'other'}, {resume: true}), /\.dag\/run\.lock/);
  const check = t.mock.method(process, 'kill', () => true);
  await assert.rejects(acquireRunLock(root, {workflowId: 'saved-workflow'}, {resume: true}), /\.dag\/run\.lock/);
  assert.equal(await readFile(path, 'utf8'), original);
  check.mock.mockImplementation(() => { throw Object.assign(new Error('No such process'), {code: 'ESRCH'}); });
  const lock = await acquireRunLock(root, {workflowId: 'saved-workflow'}, {resume: true});
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {pid: process.pid, workflowId: 'saved-workflow'});
  await lock.release();
  assert.deepEqual(await readdir(join(root, '.dag')), []);
});

test('Workspace 未启用时在规划和写入运行记录前拒绝启动', {skip: process.platform === 'win32'}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'one-duo-no-workspace-'));
  const old = process.env.OPENCODE_EXPERIMENTAL_WORKSPACES;
  process.env.OPENCODE_EXPERIMENTAL_WORKSPACES = 'false';
  t.after(async () => {
    if (old === undefined) delete process.env.OPENCODE_EXPERIMENTAL_WORKSPACES;
    else process.env.OPENCODE_EXPERIMENTAL_WORKSPACES = old;
    await rm(root, {recursive: true, force: true});
  });
  const toasts = [];
  const hooks = await plugin({directory: root, worktree: root, client: {tui: {showToast: async ({body}) => toasts.push(body)}}});
  t.after(() => hooks.dispose());
  const expected = /未启用 Workspace.*OPENCODE_EXPERIMENTAL_WORKSPACES=true/;
  await assert.rejects(hooks['command.execute.before']({command: 'one_duo', arguments: '适配宽屏', sessionID: 'fixture'}, {parts: []}), expected);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].variant, 'error');
  assert.match(toasts[0].message, expected);
  assert.deepEqual(await readdir(root), []);
});

function evaluated(commit, statuses) {
  const results = Object.fromEntries(checklist.items.map((item, index) => [item.id, {
    target: item.target,
    status: statuses[index],
    actual: '本轮观察结果',
    evidence: statuses[index] === 'unverified' ? [] : ['evidence/result.png']
  }]));
  return validateEvaluation(checklist, commit, {checklistId: checklist.id, commit, results});
}

test('目标设备来自显式总输入，清单必须覆盖且编号唯一', () => {
  const requirement = '已知这个工程是直板屏的鸿蒙工程,将项目迁移适配到以下多设备屏幕:Pura X Max,三折叠。';
  assert.deepEqual(parseOneDuoArgs(requirement), {requirement});
  const withProse = '适配到以下设备：工程平板，优化页面布局。';
  assert.deepEqual(parseOneDuoArgs(withProse), {requirement: withProse});
  assert.deepEqual(devicesForTargets({'pura x max': 'pura-1', '三折叠': 'triple-1', '直板屏': 'phone-1'},
    ['Pura X Max', '三折叠']), {'Pura X Max': 'pura-1', '三折叠': 'triple-1'});
  assert.throws(() => validateTargetNames(['Pura X Max', '平板'], requirement), /用户原文/);
  assert.throws(() => validateTargetNames(['Pura X Max', 'Ｐｕｒａ X Max'], requirement), /不重复/);
  assert.deepEqual(parseOneDuoArgs('--targets phone,widefold 适配商城'), {targets, requirement: '适配商城'});
  assert.equal(parseOneDuoArgs('将商城适配到三折叠屏').requirement, '将商城适配到三折叠屏');
  assert.throws(() => parseOneDuoArgs(' '), /用法/);
  assert.throws(() => parseOneDuoArgs('--targets phone,PHONE 适配商城'), /不重复/);
  assert.throws(() => validateChecklist(items.slice(0, 1), targets), /widefold/);
  assert.throws(() => validateChecklist([...items, items[0]], targets), /唯一/);
  assert.throws(() => validateChecklist([...items, {...items[0], id: 'TABLET-1', target: 'tablet'}], targets), /指定/);
  assert.equal(validateChecklist(structuredClone(items), targets).id, checklist.id);
});

test('评测任务按这轮实际目标创建，显式目标保留大小写和空格', () => {
  const {targets: selected} = parseOneDuoArgs('--targets "Slate Pro,横屏终端,WatchX" 适配列表');
  assert.deepEqual(selected, ['Slate Pro', '横屏终端', 'WatchX']);
  for (const group of [selected.slice(0, 1), selected]) {
    const checks = group.map((target, index) => ({id: `CHECK-${index}`, target, steps: ['打开列表'], expected: '内容可读'}));
    const tasks = evaluationTasks(validateChecklist(checks, group), {});
    assert.deepEqual(tasks.map(task => task.target), group);
    assert.ok(tasks.every(task => task.device === undefined && task.dependencies.length === 0));
  }
});

test('评测通过 DevEco CLI 操作已占用的设备', () => {
  const device = {id: 'local-instance', serial: '127.0.0.1:12345'};
  assert.doesNotThrow(() => guardEvaluationDevEcoCli({}, ['device', 'list', '--format', 'json']));
  assert.throws(() => guardEvaluationDevEcoCli({device}, ['run', '--device', device.id]), /先查找并占用/);
  const session = {device, lease: {}};
  assert.doesNotThrow(() => guardEvaluationDevEcoCli(session, ['emulator', 'start', device.id]));
  assert.doesNotThrow(() => guardEvaluationDevEcoCli(session, ['run', '--device', device.serial]));
  assert.throws(() => guardEvaluationDevEcoCli(session, ['run']), /显式指定/);
  assert.throws(() => guardEvaluationDevEcoCli(session, ['run', '--device=other']), /显式指定/);
  assert.throws(() => guardEvaluationDevEcoCli(session, ['emulator', 'start', device.id, 'other']), /显式指定/);
});

test('评测报告绑定固定清单及确切提交，漏测、错设备和无证据的结论不会被当作通过', () => {
  const commit = 'a'.repeat(40);
  const report = evaluated(commit, ['passed', 'passed', 'passed']);
  assert.throws(() => validateEvaluation(checklist, 'b'.repeat(40), report), /不属于/);
  assert.throws(() => validateEvaluation(checklist, commit, {...report, checklistId: 'stale'}), /不属于/);
  const damaged = structuredClone(report);
  delete damaged.results['WIDE-1'];
  assert.throws(() => validateEvaluation(checklist, commit, damaged), /没有覆盖/);
  assert.throws(() => validateEvaluation(checklist, commit, {...report,
    results: {...report.results, 'WIDE-1': {...report.results['WIDE-1'], target: 'phone'}}}), /不合法/);
  assert.throws(() => validateEvaluation(checklist, commit, {...report,
    results: {...report.results, 'WIDE-1': {...report.results['WIDE-1'], evidence: []}}}), /不合法/);
});

test('只有失败集合严格缩小时继续修复；回归、卡住、未验证均暂停', () => {
  const original = evaluated('a'.repeat(40), ['passed', 'failed', 'failed']);
  assert.deepEqual(nextStep(original), {action: 'repair', ids: ['WIDE-1', 'WIDE-2']});
  const following = statuses => nextStep(evaluated('b'.repeat(40), statuses), original);
  assert.deepEqual(following(['passed', 'passed', 'failed']), {action: 'repair', ids: ['WIDE-2']});
  assert.deepEqual(following(['passed', 'passed', 'passed']), {action: 'finish'});
  assert.deepEqual(following(['failed', 'passed', 'passed']), {action: 'pause', reason: 'regression', ids: ['PHONE-1']});
  assert.equal(following(['passed', 'failed', 'failed']).reason, 'no-progress');
  assert.equal(following(['passed', 'passed', 'unverified']).reason, 'unverified');
});

test('看板快照保留前轮开发和评测，任务状态与验收结论各自显示', () => {
  const progress = new Progress({}, '/project', 'parent');
  const change = {id: 1, title: '开发商城', status: 'done', dependencies: [], session: 'build-1',
    retry: {waiting: false, attempt: 1}, pr: 4, report: '不进入看板的原始工作报告'};
  const evaluation = {id: 1, title: '设备评测 · widefold', status: 'done', dependencies: [], session: 'evaluate-1',
    target: 'widefold', device: 'wide-emulator', itemCount: 2, items, verdict: {passed: 1, failed: 1, unverified: 0}};
  progress.run = {state: {tasks: [evaluation]}};
  assert.equal(Object.hasOwn(progress.view(), 'workflow'), false, '独立 DAG 使用原有视图');
  const decision = {action: 'repair', ids: ['WIDE-1']};
  const state = {phase: 'developing', round: 2, targets: [...targets], checkCount: items.length, rounds: [
    {round: 1, commit: 'a'.repeat(40), change: 'done', changeTasks: [change], evaluationTasks: [evaluation], result: decision},
    {round: 2, change: 'pending', evaluationTasks: [{...evaluation, session: undefined, status: 'pending', verdict: undefined}]}
  ]};
  progress.workflow = {state};
  const view = progress.view();
  assert.deepEqual(view.workflow.targets, targets);
  assert.equal(view.workflow.checkCount, 3);
  assert.deepEqual(view.workflow.rounds[1].changeTasks, []);
  assert.equal(view.workflow.rounds[1].evaluationTasks[0].status, 'pending');
  assert.equal(view.workflow.rounds[1].evaluationTasks[0].verdict, undefined);
  const old = view.workflow.rounds[0];
  assert.equal(old.changeTasks[0].session, 'build-1');
  assert.equal(old.changeTasks[0].pr, 4);
  assert.equal(old.changeTasks[0].report, undefined);
  assert.equal(old.evaluationTasks[0].items, undefined);
  assert.equal(old.evaluationTasks[0].status, 'done');
  assert.deepEqual(old.evaluationTasks[0].verdict, {passed: 1, failed: 1, unverified: 0});
  change.dependencies.push(2);
  change.retry.waiting = true;
  evaluation.verdict.failed = 2;
  decision.ids.push('WIDE-2');
  state.targets.push('tablet');
  assert.deepEqual(old.changeTasks[0].dependencies, []);
  assert.equal(old.changeTasks[0].retry.waiting, false);
  assert.equal(old.evaluationTasks[0].verdict.failed, 1);
  assert.deepEqual(old.result.ids, ['WIDE-1']);
  assert.deepEqual(view.workflow.targets, targets);
});
