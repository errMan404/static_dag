import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { validateDag } from '../dag.js';
import { assertLocal, DagRun, registry } from '../dag_run/index.js';
import { git } from '../dag_run/git.js';
import { acquireRunLock } from '../dag_run/lock.js';
import { Progress } from '../dag_run/progress.js';
import { requireWorkspaces } from '../runtime/local-gitea.js';
import { devicesForTargets, loadOneDuoConfig, nextStep, validateChecklist, validateEvaluation, validateTargetNames } from './contracts.js';
import { evaluate, evaluationTasks } from './evaluation.js';
import { loadOneDuoCheckpoint } from './checkpoint.js';

const pauseReasons = {
  unverified: '部分必验项未验证',
  regression: '之前通过的验收项出现回归',
  'no-progress': '失败清单没有缩小'
};

async function writeJson(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(data, null, 2) + '\n', {flag: 'wx'});
    await rename(temp, path);
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

async function ensureDirectory(path) {
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error(`运行记录目录必须是普通目录：${path}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(path, {recursive: true});
  }
}

export function startOneDuo(options) {
  return launchOneDuo(options);
}

export function resumeOneDuo(options) {
  return launchOneDuo({...options, resume: true});
}

async function launchOneDuo({root, directory, parent, client, requirement, targets, planRepair, abortInitial, resume, workflowId}) {
  if (registry.roots.has(root) || registry.workflows.has(root)) throw new Error('当前 worktree 已有任务在执行');
  if (registry.workers.has(parent)) throw new Error('请在项目主会话启动工作流');
  await requireWorkspaces();
  const branch = await git(root, ['branch', '--show-current']);
  if (!branch) throw new Error('请在 Git 分支上启动工作流');
  const commit = await git(root, ['rev-parse', 'HEAD']);
  await assertLocal(root, branch, commit);
  const base = join(root, '.dag/one-duo');
  const selection = resume ? await loadOneDuoCheckpoint({root, branch, head: commit, workflowId}) : undefined;
  await ensureDirectory(join(root, '.dag'));
  const id = selection?.id ?? randomUUID();
  const lock = await acquireRunLock(root, {workflowId: id}, {resume});
  try {
    await assertLocal(root, branch, commit);
    const checkpoint = selection && await loadOneDuoCheckpoint({root, branch, head: commit, workflowId: id});
    const config = await loadOneDuoConfig(root);
    const state = checkpoint?.state ?? {id, status: 'running', phase: 'planning', round: 1, requirement, targets: targets ?? [],
      initialCommit: commit, branch, rounds: [], planning: {round: 1, session: parent, status: 'running'}};
    const dir = checkpoint?.dir ?? join(base, id);
    if (checkpoint) {
      state.status = 'running';
      state.phase = {develop: 'developing', evaluate: 'evaluating', report: 'repairing'}[checkpoint.stage];
      delete state.detail;
      requirement = state.requirement;
      targets = checkpoint.targets ?? state.targets;
    } else {
      await ensureDirectory(base);
      await mkdir(dir);
    }
    const progress = new Progress(client, root, parent);
    const workflow = Object.assign(new OneDuo(), {root, directory, parent, client, requirement, targets, config, state,
      lock, dir, progress, planRepair, abortInitial, checkpoint, resumeCommit: commit,
      controller: new AbortController(), firstPlan: Promise.withResolvers()});
    progress.workflow = workflow;
    progress.detail = checkpoint ? '已读取断点，正在恢复工作流' : '正在规划首次开发并固定验收清单';
    await workflow.save();
    await progress.open();
    registry.workflows.set(root, workflow);
    workflow.background = workflow.execute().catch(error => progress.toast(`工作流收尾失败：${error.message}`, 'error'));
    return workflow;
  } catch (error) {
    await lock.release();
    throw error;
  }
}

class OneDuo {
  updatePlanning(round, change) {
    if (this.state.planning?.round !== round || this.state.planning.status !== 'running') return;
    this.state.planning = {...this.state.planning, ...change};
    void this.save().catch(() => {});
    void this.progress.update().catch(() => {});
  }

  completePlanning(round, taskCount, checkCount) {
    const previous = this.state.planning?.round === round ? this.state.planning : undefined;
    this.state.planning = {round, session: previous?.session, activity: previous?.activity, status: 'done', taskCount, checkCount};
  }

  savePlan({dag, checklist, targets}, commit = this.state.initialCommit, repairedRound) {
    const path = repairedRound === undefined ? join(this.dir, 'plan.json') : join(this.dir, `round-${repairedRound}`, 'repair-plan.json');
    return writeJson(path, {baseline: commit, targets, checklist, dag});
  }

  save() {
    const snapshot = structuredClone(this.state);
    const next = (this.pendingSave ?? Promise.resolve()).catch(() => {}).then(() => writeJson(join(this.dir, 'state.json'), snapshot));
    this.pendingSave = next;
    return next;
  }

  async phase(phase, detail, round = this.state.round) {
    this.state.phase = phase;
    await this.save();
    await this.progress.update(`第 ${round} 轮 · ${detail}`);
  }

  async cancel() {
    if (this.state.status !== 'running' || this.controller.signal.aborted) return;
    const error = new Error('用户取消工作流');
    this.controller.abort(error);
    if (!this.checkpoint) this.firstPlan.reject(error);
    await this.background;
  }

  async initialPlan() {
    const timeout = setTimeout(() => this.firstPlan.reject(new Error('首轮规划超时')), this.config.timeoutMs);
    timeout.unref?.();
    try { return await this.firstPlan.promise; }
    catch (error) {
      await this.abortInitial?.().catch(() => {});
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async change(dag, baseCommit, input, round, completedTasks) {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.config.timeoutMs)]);
    signal.throwIfAborted();
    const run = await DagRun.start(this.root, this.parent, this.client, {workflow: this, dag, baseCommit, input, completedTasks});
    round.changeRunId = run.state.id;
    if (baseCommit !== round.baseCommit) round.changeAttemptBase = baseCommit;
    round.change = 'running';
    round.changeTasks = run.state.tasks;
    this.progress.run = run;
    const update = (detail, worker) => this.progress.update(detail && `第 ${round.round} 轮 · ${detail}`, worker);
    run.progress = {update, finish: update};
    const stop = () => run.controller.abort(signal.reason);
    signal.addEventListener('abort', stop, {once: true});
    if (signal.aborted) stop();
    try {
      await this.save();
      const result = await run.execute();
      round.change = result.status;
      round.commit = result.syncedCommit;
      await this.save();
      signal.throwIfAborted();
      if (result.status !== 'done') throw new Error(result.error ?? '代码阶段没有合并全部开发节点');
    } finally {
      signal.removeEventListener('abort', stop);
      await run.release();
    }
  }

  async evaluate(checklist, round, directory, resumed) {
    await assertLocal(this.root, this.state.branch, round.commit);
    const tasks = round.evaluationTasks;
    let attempt = directory;
    if (resumed) {
      const attempts = join(directory, 'evaluation-attempts');
      await ensureDirectory(attempts);
      attempt = join(attempts, randomUUID());
      await mkdir(attempt);
    }
    await writeJson(join(attempt, 'evaluation-dag.json'), {tasks});
    this.progress.run = {dir: attempt, state: {tasks, maxConcurrency: this.config.maxConcurrency}};
    await this.phase('evaluating', `代码已合并，评测 ${tasks.length} 种设备`);
    const report = await evaluate({
      root: this.root, client: this.client, parent: this.parent, commit: round.commit, checklist, round: round.round, directory: attempt,
      tasks, signal: this.controller.signal, timeoutMs: this.config.timeoutMs,
      maxConcurrency: this.config.maxConcurrency, onTask: async task => {
        await this.save();
        await this.progress.update(`第 ${round.round} 轮 · 正在评测本轮集成提交`, task.session);
      }
    });
    await assertLocal(this.root, this.state.branch, round.commit);
    if (resumed) {
      const prefix = relative(directory, attempt).split(sep).join('/');
      for (const result of Object.values(report.results)) result.evidence = result.evidence.map(path => `${prefix}/${path}`);
    }
    const validated = validateEvaluation(checklist, round.commit, report);
    for (const task of tasks) {
      const counts = {passed: 0, failed: 0, unverified: 0};
      for (const item of task.items) counts[validated.results[item.id].status]++;
      task.verdict = counts;
    }
    return validated;
  }

  async execute() {
    const signal = this.controller.signal;
    try {
      let checkpoint = this.checkpoint;
      const first = checkpoint ?? await this.initialPlan();
      let dag = validateDag(first.dag);
      this.targets = this.targets
        ? validateTargetNames(this.targets)
        : validateTargetNames(first.targets, this.requirement);
      this.state.targets = this.targets;
      const checklist = validateChecklist(first.checklist.items, this.targets);
      this.state.checklistId = checklist.id;
      this.state.checkCount = checklist.items.length;
      if (!checkpoint || checkpoint.stage === 'develop') {
        const round = checkpoint?.round.round ?? 1;
        this.completePlanning(round, dag.tasks.length, round === 1 ? checklist.items.length : undefined);
      }
      await writeJson(join(this.dir, 'checklist.json'), checklist);
      const devices = devicesForTargets(this.config.devices, this.targets);
      let baseCommit = checkpoint?.round.baseCommit ?? this.state.initialCommit;
      let previous = checkpoint?.previous;
      for (let round = checkpoint?.round.round ?? 1; ; round++) {
        signal.throwIfAborted();
        const directory = join(this.dir, `round-${round}`);
        await ensureDirectory(directory);
        this.state.round = round;
        const current = checkpoint?.round ?? {round, baseCommit, change: 'pending', changeTasks: dag.tasks};
        if (!checkpoint) this.state.rounds.push(current);
        if (this.state.planning?.round === round && this.state.planning.status === 'done') current.planning = this.state.planning;
        const input = {requirement: this.requirement, targets: this.targets, baseline: baseCommit,
          checklist, ...(previous ? {report: previous.report, reportPath: previous.path} : {})};
        if (!checkpoint || checkpoint.stage === 'develop') {
          current.evaluationTasks = evaluationTasks(checklist, devices);
          await writeJson(join(directory, 'inputs.json'), input);
          await writeJson(join(directory, 'change-dag.json'), dag);
          this.progress.run = {dir: directory, state: {tasks: current.changeTasks}};
          await this.phase('developing', checkpoint ? '从已保存的 DAG 继续开发' : round === 1 ? '执行首次开发' : '执行本轮修复');
          await this.change(dag, checkpoint ? this.resumeCommit : baseCommit, input, current, checkpoint?.completedTasks);
        }
        if (current.commit === baseCommit) { this.stop('paused', '没有产出新的集成提交'); break; }
        const reportPath = join(directory, 'results.json');
        let report = checkpoint?.report?.report;
        const retryEvaluation = report && nextStep(report, previous?.report).reason === 'unverified';
        if (!report || retryEvaluation) {
          current.evaluationTasks = evaluationTasks(checklist, devices);
          delete current.result;
          report = await this.evaluate(checklist, current, directory, Boolean(checkpoint));
          await writeJson(reportPath, report);
        }
        signal.throwIfAborted();
        const decision = nextStep(report, previous?.report);
        current.result = decision;
        if (decision.action === 'finish') { this.stop('done', '所有必验项均通过'); break; }
        if (decision.action === 'pause') {
          this.stop('paused', `${pauseReasons[decision.reason]}：${decision.ids.join('、')}`);
          break;
        }
        if (round >= this.config.maxRounds) { this.stop('paused', '达到轮数上限，仍有必验项失败'); break; }
        if (checkpoint?.repairDag && !retryEvaluation) dag = checkpoint.repairDag;
        else {
          this.state.planning = {round: round + 1, status: 'running'};
          await this.phase('repairing', '根据评测报告规划下一轮修复', round + 1);
          dag = validateDag(await this.planRepair(this, {targets: this.targets, commit: current.commit, report, reportPath, checklist}));
        }
        this.completePlanning(round + 1, dag.tasks.length);
        await assertLocal(this.root, this.state.branch, current.commit);
        baseCommit = current.commit;
        previous = {report, path: reportPath};
        checkpoint = undefined;
      }
    } catch (error) {
      this.stop(signal.aborted ? 'cancelled' : 'failed', error.message);
    } finally {
      this.state.phase = 'finished';
      try {
        await this.save();
        await this.progress.finish(this.state.detail);
        await this.progress.toast(this.state.detail, this.state.status === 'done' ? 'success' : 'warning');
      } finally {
        try { await this.lock.release(); }
        finally { registry.workflows.delete(this.root); }
      }
    }
    return this.state;
  }

  stop(status, detail) {
    if (this.state.planning?.status === 'running' && (status === 'failed' || status === 'cancelled')) {
      this.state.planning = {...this.state.planning, status, error: detail};
    }
    this.state.status = status;
    this.state.detail = detail;
  }
}
