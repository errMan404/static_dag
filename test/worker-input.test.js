import {test} from 'node:test';
import assert from 'node:assert/strict';
import {taskInput} from '../src/dag_run/input.js';

const task = {id: 3, title: '实现 greeting', description: '导出 greet(name)', details: '使用 ES module',
  testStrategy: '测试 greet("DAG") 的返回值', worktree: 'D:/work/task-3', dependencies: [1, 2],
  status: 'running', session: 'internal-session', workspaceID: 'internal-workspace', branch: 'internal-branch',
  baseCommit: 'internal-commit', gitea: {cloneUrl: 'internal-clone-url'}};

test('开发输入只传任务和当前目录，不序列化调度状态或重复路径', () => {
  const input = taskInput(task);
  assert.match(input, /任务 3：实现 greeting/);
  for (const field of ['导出 greet(name)', '使用 ES module', '测试 greet("DAG") 的返回值']) assert.ok(input.includes(field));
  assert.equal(input.split(task.worktree).length - 1, 1);
  assert.doesNotMatch(input, /internal-|workspaceID|baseCommit|cloneUrl|"status"/);
  assert.ok(!input.trim().startsWith('{'));
});

test('Fork 不重复注入前置报告，汇合新会话保留直接依赖结果', () => {
  const predecessors = [{id: 1, title: 'API', report: 'API 已测试', commit: 'internal-one'},
    {id: 2, title: 'UI', report: 'UI 已测试', pr: 123}];
  const fork = taskInput(task, [predecessors[0]], true);
  assert.doesNotMatch(fork, /API 已测试|前置任务结果/);
  const join = taskInput(task, predecessors);
  assert.match(join, /任务 1：API\nAPI 已测试/); assert.match(join, /任务 2：UI\nUI 已测试/);
  assert.doesNotMatch(join, /internal-one|123/);
});

const firstRound = {
  requirement: '原始需求全文', targets: ['折叠屏', '平板'], baseline: 'initial-commit',
  checklist: {id: 'initial-checklist', items: [
    {id: 'UI-1', target: '折叠屏', steps: ['展开详情页'], expected: '详情页不溢出'},
    {id: 'UI-10', target: '平板', steps: ['打开商品列表'], expected: '商品列表可横向滚动'},
    {id: 'UI-20', target: '平板', steps: ['确认导航'], expected: '导航显示'}
  ]}
};

const repair = {...firstRound, reportPath: '/workflow/round-1/results.json', report: {
  commit: 'evaluated-commit', results: {
    'UI-1': {status: 'failed', actual: '详情标题溢出', evidence: ['evidence/1/observation-1.json']},
    'UI-10': {status: 'failed', actual: '列表显示异常', evidence: ['evidence/2/list.png']},
    'UI-20': {status: 'passed', actual: '导航可见', evidence: ['evidence/2/nav.png']}
  }
}};

test('一多适配开发任务附上目标设备和阶段约束，省去完整需求与设备检查清单', () => {
  const input = taskInput(task, [], false, firstRound);
  assert.match(input, /折叠屏、平板/);
  assert.match(input, /禁止启动、部署或操作模拟器与真机/);
  assert.doesNotMatch(input, /原始需求全文|initial-commit|initial-checklist|展开详情页|工作流输入/);
});

test('修复任务按精确编号携带失败详情、被测提交和证据', () => {
  const input = taskInput({...task, details: '修复 UI-10'}, [], false, repair);
  for (const field of ['evaluated-commit', repair.reportPath, '打开商品列表', '商品列表可横向滚动', '列表显示异常', 'evidence/2/list.png']) {
    assert.ok(input.includes(field));
  }
  assert.doesNotMatch(input, /展开详情页|详情标题溢出|导航可见|evidence\/2\/nav\.png|initial-checklist/);
});

test('未关联编号的修复任务仍收到失败项作为定位线索', () => {
  const input = taskInput(task, [], false, repair);
  assert.match(input, /任务未标明失败项编号/);
  assert.match(input, /详情标题溢出/);
  assert.match(input, /列表显示异常/);
  assert.doesNotMatch(input, /导航可见/);
});
