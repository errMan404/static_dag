import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateDag } from '../dag.js';
import { git } from '../dag_run/git.js';
import { validateChecklist, validateEvaluation, validateTargetNames } from './contracts.js';

const workflowKey = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const commitKey = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const record = value => value && typeof value === 'object' && !Array.isArray(value);

function requireValid(condition, message) {
  if (!condition) throw new Error(message);
}

async function existsAs(path, kind) {
  try {
    const stat = await lstat(path);
    requireValid(kind === 'file' ? stat.isFile() : stat.isDirectory(), `断点路径必须是普通${kind === 'file' ? '文件' : '目录'}：${path}`);
    return stat;
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

async function readCheckpoint(path) {
  if (!await existsAs(path, 'file')) return;
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { throw new Error(`无法读取断点文件：${path}`, {cause: error}); }
}

function validateStoredChecklist(artifact, targets) {
  requireValid(record(artifact), '断点缺少固定验收清单');
  const checklist = validateChecklist(artifact.items, targets);
  requireValid(artifact.id === checklist.id, '断点验收清单摘要不匹配');
  return checklist;
}

function validatePlan(artifact, baseline, targets, checklist) {
  requireValid(record(artifact) && artifact.baseline === baseline && isDeepStrictEqual(artifact.targets, targets)
    && isDeepStrictEqual(validateStoredChecklist(artifact.checklist, targets), checklist), '保存的 DAG 与分支基线或验收清单不匹配');
  return validateDag(artifact.dag);
}

function validateRunTasks(tasks, dag) {
  requireValid(Array.isArray(tasks) && tasks.every(record), '开发断点缺少任务结果');
  const definitions = tasks.map(({id, title, description, details, testStrategy, dependencies, priority}) =>
    ({id, title, description, details, testStrategy, dependencies, priority}));
  requireValid(isDeepStrictEqual(validateDag({tasks: definitions}), dag), '开发结果的任务与原始 DAG 不一致');
  return [...tasks].sort((a, b) => a.id - b.id);
}

async function requireAncestor(root, ancestor, head) {
  requireValid(commitKey.test(ancestor), '断点包含无效的 Git 提交');
  await git(root, ['merge-base', '--is-ancestor', ancestor, head]).catch(() => {
    throw new Error(`当前 HEAD 不包含断点提交 ${ancestor.slice(0, 8)}`);
  });
}

async function completedDevelopment(root, tasks, head) {
  const completed = tasks.filter(task => task.status === 'done');
  const ids = new Set(completed.map(task => task.id));
  for (const task of completed) {
    requireValid(task.dependencies.every(id => ids.has(id)), `已合并节点 ${task.id} 缺少已完成的前置节点`);
    if (task.pr !== undefined) requireValid(Number.isSafeInteger(task.pr) && task.pr > 0, `已合并节点 ${task.id} 的 PR 编号无效`);
    for (const commit of [task.commit, task.mergeCommit]) {
      if (commit !== undefined) await requireAncestor(root, commit, head);
    }
  }
  return completed;
}

async function readReport(directory, checklist, commit) {
  const path = join(directory, 'results.json');
  const raw = await readCheckpoint(path);
  if (raw === undefined) return;
  const report = validateEvaluation(checklist, commit, raw);
  const canonical = await realpath(directory);
  for (const file of new Set(Object.values(report.results).flatMap(result => result.evidence))) {
    const parts = file.split(/[\\/]/);
    requireValid(parts.every(part => part && part !== '.' && part !== '..') && !/^[A-Za-z]:/.test(file), '评测证据必须使用轮次目录内的相对路径');
    const local = join(canonical, ...parts);
    requireValid(await existsAs(local, 'file'), `找不到评测证据：${file}`);
    const rel = relative(canonical, await realpath(local));
    requireValid(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep), '评测证据不在轮次目录内');
  }
  return {report, path};
}

async function loadRound(root, dir, state, round, checklist, previous, fallbackDag, head) {
  const baseline = previous?.report.commit ?? state.initialCommit;
  requireValid(round.baseCommit === baseline, `第 ${round.round} 轮与上一断点的基线不一致`);
  const directory = join(dir, `round-${round.round}`);
  const present = await existsAs(directory, 'directory');
  const input = present ? await readCheckpoint(join(directory, 'inputs.json')) : undefined;
  const raw = present ? await readCheckpoint(join(directory, 'change-dag.json')) : undefined;
  if (input !== undefined) {
    requireValid(record(input) && input.requirement === state.requirement && isDeepStrictEqual(input.targets, state.targets)
      && input.baseline === baseline && isDeepStrictEqual(validateStoredChecklist(input.checklist, state.targets), checklist)
      && isDeepStrictEqual(input.report, previous?.report), `第 ${round.round} 轮输入与工作流记录不一致`);
  }
  const dag = raw !== undefined && input !== undefined ? validateDag(raw) : fallbackDag;
  requireValid(dag, `第 ${round.round} 轮缺少完整的开发 DAG 与输入记录`);
  if (raw !== undefined) requireValid(isDeepStrictEqual(validateDag(raw), dag), '开发 DAG 与规划断点不一致');
  if (fallbackDag) requireValid(isDeepStrictEqual(dag, fallbackDag), '开发 DAG 与规划断点不一致');

  let synced = round.commit;
  let tasks = validateRunTasks(round.changeTasks ?? dag.tasks, dag);
  if (round.changeRunId !== undefined) requireValid(workflowKey.test(round.changeRunId), '无效的开发运行编号');
  if (round.changeRunId !== undefined && round.change !== 'done') {
    const runs = join(root, '.dag', 'runs');
    const runDir = join(runs, round.changeRunId);
    const run = await existsAs(runs, 'directory') && await existsAs(runDir, 'directory')
      ? await readCheckpoint(join(runDir, 'state.json')) : undefined;
    if (run !== undefined) {
      requireValid(run.id === round.changeRunId && run.localBranch === state.branch &&
        run.initialCommit === (round.changeAttemptBase ?? baseline) && commitKey.test(run.syncedCommit), '开发运行记录与工作流断点不匹配');
      synced = run.syncedCommit;
      tasks = validateRunTasks(run.tasks, dag);
      // Gitea confirms the exact PR before sync updates the local branch. A
      // process can stop after the fast-forward but before saving task.done.
      const syncedTask = head && tasks.find(task => task.status !== 'done' && task.lastSubmission?.status === 'merged' &&
        task.lastSubmission.mergeCommit === head && Number.isSafeInteger(task.pr) && task.pr > 0 && task.pr === task.lastSubmission.pr);
      if (syncedTask) {
        await requireAncestor(root, synced, head);
        syncedTask.status = 'done';
        syncedTask.mergeCommit = head;
        synced = head;
      }
    }
  }
  round.changeTasks = tasks;
  if (tasks.every(task => task.status === 'done')) {
    requireValid(commitKey.test(synced) && synced !== baseline, '所有开发节点已结束，但没有可评测的集成提交');
    round.change = 'done';
    round.commit = synced;
  } else requireValid(round.change !== 'done', '开发结果缺少已完成节点');
  const report = present ? await readReport(directory, checklist, round.commit) : undefined;
  if (report) requireValid(round.change === 'done', '开发尚未合并，评测报告无法作为断点');
  return {dag, report, synced, directory};
}

async function loadWorkflow(root, base, id, branch, head) {
  const dir = join(base, id);
  requireValid(await existsAs(dir, 'directory'), `找不到工作流 ${id}`);
  const state = await readCheckpoint(join(dir, 'state.json'));
  requireValid(record(state) && state.id === id && state.branch === branch && typeof state.requirement === 'string' && state.requirement.trim()
    && commitKey.test(state.initialCommit) && Array.isArray(state.rounds), '工作流断点缺失或与当前 Git 分支不匹配');
  requireValid(state.status !== 'done', '工作流已经验收通过');
  const plan = await readCheckpoint(join(dir, 'plan.json'));
  const firstDirectory = join(dir, 'round-1');
  const firstInput = !state.rounds.length && plan === undefined && await existsAs(firstDirectory, 'directory')
    ? await readCheckpoint(join(firstDirectory, 'inputs.json')) : undefined;
  const targets = state.targets?.length
    ? validateTargetNames(state.targets)
    : validateTargetNames((plan ?? firstInput)?.targets, state.requirement);
  const artifact = await readCheckpoint(join(dir, 'checklist.json')) ?? plan?.checklist;
  const checklist = validateStoredChecklist(artifact, targets);
  requireValid(state.checklistId === undefined || state.checklistId === checklist.id, '工作流记录的验收清单摘要不匹配');
  state.targets = targets;
  state.checklistId = checklist.id;
  state.checkCount = checklist.items.length;
  let fallbackDag = plan === undefined ? undefined : validatePlan(plan, state.initialCommit, targets, checklist);
  if (!state.rounds.length) state.rounds.push({round: 1, baseCommit: state.initialCommit, change: 'pending'});

  let previous;
  for (const [index, round] of state.rounds.entries()) {
    requireValid(record(round) && round.round === index + 1, '工作流轮次编号不连续');
    const latest = index === state.rounds.length - 1;
    const {dag, report, synced, directory} = await loadRound(root, dir, state, round, checklist, previous, fallbackDag, latest ? head : undefined);
    const savedRepair = report ? await readCheckpoint(join(directory, 'repair-plan.json')) : undefined;
    const repairDag = savedRepair === undefined ? undefined : validatePlan(savedRepair, report.report.commit, targets, checklist);
    if (!latest) {
      requireValid(report, `第 ${round.round} 轮缺少上一轮评测报告`);
      previous = report;
      fallbackDag = repairDag;
      continue;
    }

    const stage = report ? 'report' : round.change === 'done' ? 'evaluate' : 'develop';
    const checkpointCommit = synced ?? round.baseCommit;
    requireValid(head === checkpointCommit, `当前 HEAD 与第 ${round.round} 轮断点提交不一致`);
    await requireAncestor(root, state.initialCommit, head);
    const completedTasks = await completedDevelopment(root, round.changeTasks, head);
    if (stage === 'develop' && head !== round.baseCommit) {
      requireValid(completedTasks.some(task => task.mergeCommit === head), '当前提交没有对应已合并节点，无法安全续跑剩余任务');
    }
    requireValid(!completedTasks.length || head !== round.baseCommit, '已合并节点与当前轮的基线提交不一致');
    state.round = round.round;
    return {id, dir, state, checklist, round, stage, dag, previous, report, repairDag, completedTasks};
  }
}

export async function loadOneDuoCheckpoint({root, branch, head, workflowId}) {
  requireValid(typeof branch === 'string' && branch && commitKey.test(head), '续跑需要当前 Git 分支和有效的 HEAD');
  const dagRoot = join(root, '.dag');
  const base = join(dagRoot, 'one-duo');
  requireValid(await existsAs(dagRoot, 'directory') && await existsAs(base, 'directory'), '没有可续跑的 /one_duo 断点');
  if (workflowId !== undefined) {
    requireValid(workflowKey.test(workflowId), '工作流 ID 必须是 UUID');
    return loadWorkflow(root, base, workflowId, branch, head);
  }
  const candidates = await Promise.all((await readdir(base, {withFileTypes: true}))
    .filter(dir => dir.isDirectory() && workflowKey.test(dir.name)).map(async ({name}) => ({name,
      updated: (await lstat(join(base, name, 'state.json')).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      }))?.mtimeMs ?? 0})));
  let newestError;
  for (const {name} of candidates.sort((a, b) => b.updated - a.updated || a.name.localeCompare(b.name))) {
    try { return await loadWorkflow(root, base, name, branch, head); }
    catch (error) { newestError ??= error; }
  }
  throw new Error(`没有可续跑的 /one_duo 断点${newestError ? '：' + newestError.message : ''}`);
}
