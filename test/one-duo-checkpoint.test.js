import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { validateDag } from '../src/dag.js';
import { git } from '../src/dag_run/git.js';
import { loadOneDuoCheckpoint } from '../src/one-duo/checkpoint.js';
import { validateChecklist } from '../src/one-duo/contracts.js';

const targets = ['折叠设备'];
const checklist = validateChecklist([{id: 'WIDE-1', target: targets[0], steps: ['打开页面'], expected: '内容正常'}], targets);
const dag = validateDag({tasks: [1, 2].map(id => ({id, title: `任务 ${id}`, description: '适配', testStrategy: '构建', dependencies: id === 1 ? [] : [1]}))});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dag-checkpoint-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']);
  await git(root, ['config', 'user.name', 'DAG fixture']);
  const commit = async () => {
    await git(root, ['commit', '--allow-empty', '-m', 'fixture']);
    return git(root, ['rev-parse', 'HEAD']);
  };
  const initialCommit = await commit();
  const id = randomUUID(), dir = join(root, '.dag', 'one-duo', id);
  const state = {id, branch: 'main', requirement: '适配折叠设备', status: 'running', phase: 'planning', round: 1,
    initialCommit, targets: [], rounds: []};
  async function write(path, object) {
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, JSON.stringify(object));
  }
  const load = async (options = {}) => loadOneDuoCheckpoint({root, branch: state.branch, head: await git(root, ['rev-parse', 'HEAD']), ...options});
  const plan = {baseline: initialCommit, targets, checklist, dag};
  const round = {round: 1, baseCommit: initialCommit, change: 'running', changeTasks: dag.tasks};
  async function roundFiles() {
    state.phase = 'developing';
    state.targets = targets;
    state.rounds = [round];
    await write(join(dir, 'state.json'), state);
    await write(join(dir, 'checklist.json'), checklist);
    await write(join(dir, 'round-1', 'inputs.json'), {requirement: state.requirement, targets, baseline: initialCommit, checklist});
    await write(join(dir, 'round-1', 'change-dag.json'), dag);
  }
  const runnerState = (id, syncedCommit, tasks, status = 'running') =>
    write(join(root, '.dag', 'runs', id, 'state.json'), {id, localBranch: 'main', initialCommit, syncedCommit, status, tasks});
  return {root, id, dir, state, plan, round, commit, load, roundFiles, runnerState, write};
}

test('首次规划刚写出检查点时，在同一 HEAD 继续开发', async t => {
  const f = await fixture(t);
  await f.write(join(f.dir, 'state.json'), f.state);
  await f.write(join(f.dir, 'plan.json'), f.plan);
  const saved = await f.load();
  assert.equal(saved.stage, 'develop');
  assert.deepEqual(saved.dag, dag);
  assert.deepEqual(saved.checklist, checklist);
  assert.equal(saved.round.round, 1);
  await assert.rejects(f.load({workflowId: '../out'}), /工作流 ID/);
  await f.commit();
  await assert.rejects(f.load({workflowId: f.id}), /HEAD 与/);
});

test('开发阶段恢复已合并节点，完整运行记录优先于较早的工作流状态', async t => {
  const f = await fixture(t);
  f.round.changeRunId = randomUUID();
  await f.roundFiles();
  const first = await f.commit();
  const task = {...dag.tasks[0], status: 'done', pr: 1, commit: first, mergeCommit: first};
  await f.runnerState(f.round.changeRunId, first, [task, dag.tasks[1]]);

  const partial = await f.load();
  assert.equal(partial.stage, 'develop');
  assert.equal(partial.round.baseCommit, f.plan.baseline);
  assert.deepEqual(partial.completedTasks, [task]);

  const second = await f.commit();
  await f.runnerState(f.round.changeRunId, second, [task, {...dag.tasks[1], status: 'done', pr: 2, commit: second, mergeCommit: second}], 'done');
  const completed = await f.load();
  assert.equal(completed.stage, 'evaluate');
  assert.equal(completed.round.commit, second);
  assert.equal(completed.round.change, 'done');
  assert.equal(completed.completedTasks.length, 2);
});

test('已合并的旧版工作流从评测断点续跑，保存的报告和修复 DAG 可继续使用', async t => {
  const f = await fixture(t);
  f.round.change = 'done';
  f.round.commit = await f.commit();
  f.round.changeTasks = dag.tasks.map(task => ({...task, status: 'done'}));
  await f.roundFiles();
  const checked = await f.load({workflowId: f.id});
  assert.equal(checked.stage, 'evaluate');

  const directory = join(f.dir, 'round-1');
  const report = {commit: f.round.commit, checklistId: checklist.id,
    results: {'WIDE-1': {target: targets[0], status: 'failed', actual: '需要修复', evidence: ['eval-attempt-1/evidence/1/result.json']}}};
  await f.write(join(directory, report.results['WIDE-1'].evidence[0]), {observed: '需要修复'});
  await f.write(join(directory, 'results.json'), report);
  await f.write(join(directory, 'repair-plan.json'), {...f.plan, baseline: f.round.commit});
  const saved = await f.load();
  assert.equal(saved.stage, 'report');
  assert.deepEqual(saved.report.report, report);
  assert.deepEqual(saved.repairDag, dag);
  report.results['WIDE-1'].evidence = ['../secret.json'];
  await f.write(join(directory, 'results.json'), report);
  await assert.rejects(f.load({workflowId: f.id}), /证据必须使用轮次目录内/);
});

test('本地已快进到 Gitea 确认的提交时，从写入状态前的中断恢复', async t => {
  const f = await fixture(t);
  f.round.changeRunId = randomUUID();
  await f.roundFiles();
  const merged = await f.commit();
  const task = {...dag.tasks[0], status: 'running', pr: 1, commit: merged,
    lastSubmission: {status: 'merged', pr: 1, mergeCommit: merged}};
  await f.runnerState(f.round.changeRunId, f.plan.baseline, [task, dag.tasks[1]]);
  const saved = await f.load();
  assert.equal(saved.stage, 'develop');
  assert.equal(saved.completedTasks[0].id, task.id);
  assert.equal(saved.completedTasks[0].mergeCommit, merged);
});

test('跳过不能续跑的历史候选，拒绝读取符号链接断点', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t);
  await f.roundFiles();
  const unsafe = randomUUID(), dir = join(f.root, '.dag', 'one-duo', unsafe);
  await mkdir(dir);
  await symlink(join(f.dir, 'state.json'), join(dir, 'state.json'));
  await assert.rejects(f.load({workflowId: unsafe}), /普通文件/);
  assert.equal((await f.load()).id, f.id);
});
