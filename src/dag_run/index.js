import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { parseDag, validateDag } from '../dag.js';
import { git, clean } from './git.js';
import { Gitea } from './gitea.js';
import { resolveGiteaToken } from './credentials.js';
import { loadRunnerConfig, requireWorkspaces } from '../runtime/local-gitea.js';
import { taskInput } from './input.js';
import { ModelGate, rateLimit, retryDelay } from './rate-limit.js';
import { loadUx, nodeUx, writeUxReport } from './ux.js';
import { acquireRunLock } from './lock.js';
import { schedule } from './schedule.js';

export const registry = globalThis[Symbol.for('static-dag.execution')] ??= { runs: new Map(), workers: new Map(), roots: new Map() };
registry.workflows ??= new Map();
export const DEFAULT_MAX_CONCURRENCY = 20;
const unwrap = value => { const error = value.error ?? value.data?.info?.error; if (error || !value.data) throw new Error(JSON.stringify(error ?? '宿主返回空结果'), {cause: error}); return value.data; };

export async function assertLocal(root, branch, commit) {
  if (await git(root, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('主 worktree 被修改，拒绝自动同步');
  if (await git(root, ['branch', '--show-current']) !== branch) throw new Error('启动 worktree 的目标分支已变化，停止运行');
  if (await git(root, ['rev-parse', 'HEAD']) !== commit) throw new Error('启动 worktree 的 HEAD 已被外部移动，停止运行；不会自动覆盖本地回退或提交');
}

export class DagRun {
  constructor() {
    this.active = new Map();
    this.integrationTail = Promise.resolve();
    this.saveTail = Promise.resolve();
    this.modelGate = new ModelGate();
    this.completedTaskIds = new Set();
  }
  integrate(operation) {
    const next = this.integrationTail.then(operation);
    this.integrationTail = next.catch(() => {});
    return next;
  }
  static async start(root, parent, client, options = {}) {
    root = resolve(root);
    if (registry.roots.has(root)) throw new Error('当前 worktree 已有 DAG 在执行');
    const workflow = registry.workflows.get(root);
    if (workflow !== options.workflow) throw new Error('当前 worktree 的运行权归活动工作流');
    if (workflow && workflow.parent !== parent) throw new Error('当前会话没有工作流运行权');
    const dag = workflow ? validateDag(options.dag) : parseDag(await readFile(join(root, '.dag/dag.json'), 'utf8'));
    const ux = workflow ? undefined : await loadUx(root, dag.tasks);
    await requireWorkspaces();
    const branch = await git(root, ['branch', '--show-current']);
    if (await git(root, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('主 worktree 有已跟踪文件的未提交修改，请先提交');
    if (!branch) throw new Error('请在目标主 worktree 的分支上运行 /dag_run，不能使用 detached HEAD');
    const {config, token} = await loadRunnerConfig(root);
    config.maxConcurrency ??= DEFAULT_MAX_CONCURRENCY;
    if (!Number.isSafeInteger(config.maxConcurrency) || config.maxConcurrency < 1) throw new Error('maxConcurrency 必须为正整数');
    if (config.modelRequestsPerMinute !== undefined && (!Number.isSafeInteger(config.modelRequestsPerMinute) || config.modelRequestsPerMinute < 1)) throw new Error('modelRequestsPerMinute 必须为正整数');
    config.baseBranch ??= branch;
    if (branch !== config.baseBranch) throw new Error('请在目标主 worktree 的 baseBranch 分支执行 /dag_run');
    const provider = new Gitea(config.gitea, token ?? await resolveGiteaToken(root, config.gitea));
    const initialCommit = await git(root, ['rev-parse', 'HEAD']);
    if (workflow && initialCommit !== options.baseCommit) throw new Error('开发基线与工作流绑定的提交不一致');
    const completed = new Map((workflow ? options.completedTasks ?? [] : []).map(task => [task.id, task]));
    const tasks = dag.tasks.map(task => {
      const prior = completed.get(task.id);
      if (!prior) return task;
      const {pr, commit, mergeCommit, session, report, startedAt, finishedAt} = prior;
      return {...task, status: 'done', pr, commit, mergeCommit, session, report, startedAt, finishedAt};
    });
    const run = new DagRun();
    Object.assign(run, { root, parent, client, config, provider,
      state: { id: randomUUID(), status: 'running', startedAt: Date.now(), localBranch: branch, initialCommit,
        syncedCommit: initialCommit, maxConcurrency: config.maxConcurrency, tasks }, controller: new AbortController() });
    run.completedTaskIds = new Set(completed.keys());
    run.workflow = options.workflow;
    run.workflowInput = options.input;
    // Each active worker and its HTTP request observes this per-run signal.
    setMaxListeners(0, run.controller.signal);
    run.modelGate = new ModelGate(config.modelRequestsPerMinute);
    run.state.integrationBranch = `dag/${run.state.id}/integration`;
    run.state.gitRemote = `dag-run-${run.state.id}`;
    run.state.integrationRef = `refs/remotes/${run.state.gitRemote}/${run.state.integrationBranch}`;
    run.state.gitea = {url: provider.url, owner: config.gitea.owner,
      repo: `${config.gitea.repoPrefix ?? config.gitea.repo}-${run.state.id}`};
    run.dir = join(root, '.dag/runs', run.state.id);
    if (ux) {
      run.state.ux = {version: ux.version, manifestDigest: ux.manifestDigest, cardsDigest: ux.cardsDigest,
        device: ux.device, acceptance: 'unverified', reason: ux.device === null ? 'no-device' : 'device-evidence-not-reviewed'};
      for (const task of run.state.tasks) task.ux = nodeUx(ux, task.id);
    }
    if (!workflow) run.lock = await acquireRunLock(root, {runId: run.state.id});
    registry.roots.set(root, run); registry.runs.set(parent, run);
    try {
      await run.save();
      if (ux) await writeFile(join(run.dir, 'ux-input.json'), JSON.stringify(ux, null, 2) + '\n');
    } catch (error) { await run.release(); throw error; }
    return run;
  }
  save() {
    const snapshot = JSON.stringify(this.state, null, 2);
    const next = this.saveTail.then(() => this.writeSnapshot(snapshot));
    this.saveTail = next.catch(() => {});
    return next;
  }
  async writeSnapshot(snapshot) {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `state.${randomUUID()}.tmp`), file = join(this.dir, 'state.json');
    await writeFile(tmp, snapshot);
    for (let n = 0; ; n++) {
      try { await rename(tmp, file); break; }
      catch (error) { if (n >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) { await unlink(tmp).catch(() => {}); throw error; } await new Promise(r => setTimeout(r, 10 * 2 ** n)); }
    }
  }
  async release() {
    if (registry.roots.get(this.root) === this) registry.roots.delete(this.root);
    if (this.lock) { const lock = this.lock; this.lock = null; await lock.release(); }
  }
  assertLocal() {
    return assertLocal(this.root, this.state.localBranch, this.state.syncedCommit);
  }
  async initializeIntegration() {
    await this.assertLocal();
    if (this.state.repositoryCreated) throw new Error('本轮仓库已存在，拒绝重复初始化');
    this.state.gitea = await this.provider.createRunRepository(this.state, this.controller.signal);
    this.state.repositoryCreated = true;
    // Persist the repository before Git setup so a failed/cancelled bootstrap is traceable.
    await this.save();
    this.controller.signal.throwIfAborted();
    await this.assertLocal();
    await git(this.root, ['remote', 'add', this.state.gitRemote, this.state.gitea.cloneUrl], this.controller.signal);
    const ref = `refs/heads/${this.state.integrationBranch}`;
    if (await git(this.root, ['ls-remote', this.state.gitRemote, ref], this.controller.signal)) throw new Error('本轮集成分支已存在，拒绝覆盖');
    await git(this.root, ['push', this.state.gitRemote, `${this.state.initialCommit}:${ref}`], this.controller.signal);
    await this.assertLocal();
    this.state.integrationInitialized = true;
    await this.save();
  }
  async sync(mergeCommit) {
    await this.assertLocal();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(mergeCommit ?? '')) throw new Error('PR 已合并，但 Gitea 未返回有效合并提交，拒绝同步未经确认的代码');
    await git(this.root, ['fetch', '--no-tags', this.state.gitRemote,
      `refs/heads/${this.state.integrationBranch}:${this.state.integrationRef}`]);
    // Apply the confirmed PR commit, not any later/unrelated commit on the remote.
    await git(this.root, ['merge-base', '--is-ancestor', mergeCommit, this.state.integrationRef])
      .catch(() => { throw new Error('Gitea 返回的 PR 合并提交不属于本轮集成分支，拒绝同步'); });
    await git(this.root, ['merge-base', '--is-ancestor', this.state.syncedCommit, mergeCommit])
      .catch(() => { throw new Error('PR 合并提交无法从本轮已同步提交快进，拒绝回退或改写本地分支'); });
    await this.assertLocal();
    await git(this.root, ['merge', '--ff-only', mergeCommit]);
    const head = await git(this.root, ['rev-parse', 'HEAD']);
    if (head !== mergeCommit) throw new Error('本地同步结果与已确认的 PR 提交不一致，停止运行');
    this.state.syncedCommit = head;
    await this.save();
  }
  async execute() {
    try {
      this.controller.signal.throwIfAborted();
      await this.progress?.update(`以启动提交 ${this.state.initialCommit.slice(0, 8)} 创建独立仓库 ${this.state.gitea.repo}`);
      await this.initializeIntegration();
      await schedule({tasks: this.state.tasks, maxConcurrency: this.config.maxConcurrency, signal: this.controller.signal,
        active: this.active, runTask: (task, abort) => this.runTask(task, {abort, metadata() {}}),
        onError: error => {
          if (!this.controller.signal.aborted) {
            this.failure = error;
            this.controller.abort(error);
          }
        }});
      await this.complete();
    } catch (error) {
      if (this.state.status === 'running') {
        if (!this.controller.signal.aborted) {this.failure = error; this.controller.abort(error);}
        // Do not release the worktree lock while sibling sessions or an already
        // accepted PR merge can still be writing to the integration worktree.
        await Promise.allSettled([...this.active.values()]);
        await this.integrationTail;
        this.state.status = this.failure ? 'failed' : 'cancelled';
        this.state.error = (this.failure ?? error).message;
        for (const task of this.state.tasks) if (task.status === 'pending') task.status = 'blocked';
        try { await writeUxReport(this); }
        catch (reportError) { this.state.ux.reportError = reportError.message; }
        await this.save(); await this.release();
        await this.progress?.finish(this.state.error);
      }
    }
    return this.state;
  }
  async cancel() {
    if (this.state.status !== 'running') return;
    this.controller.abort(new Error('用户取消 DAG 运行'));
    await this.progress?.update('已请求取消，正在停止所有活动 Agent；已合入的提交会保留');
  }
  async complete() {
    if (this.active.size) throw new Error('仍有活动 Agent，不能结束 DAG');
    const status = this.state.tasks.every(task => task.status === 'done') ? 'done' : 'blocked';
    await writeUxReport({dir: this.dir, state: {...this.state, status}});
    this.state.status = status;
    await this.save(); await this.release();
    await this.progress?.finish(this.state.status === 'done' ? '所有节点已完成并合并到主分支' +
      (this.state.ux ? `；UX 未验证（${this.state.ux.reason}），交付部分完成` : '') : '没有可执行节点，DAG 已阻塞');
    return this.state;
  }
  async promptTask(task, query, headers, prompt, signal) {
    let first = true;
    for (;;) {
      signal.throwIfAborted();
      try {
        const parts = first ? [{type: 'text', text: prompt}] : [{type: 'text', text: '继续当前节点',
          synthetic: true, ignored: true, metadata: {dagRetry: true}}];
        first = false;
        const result = unwrap(await this.client.session.prompt({path: {id: task.session}, query, headers,
          body: {agent: 'dag-worker', parts}, signal}));
        if (task.retry) task.retry.waiting = false;
        return result;
      } catch (error) {
        const limited = rateLimit(error);
        if (!limited || signal.aborted) throw error;
        const attempt = (task.retry?.attempt ?? 0) + 1;
        const delayMs = retryDelay(limited.headers, attempt);
        task.retry = {attempt, waiting: true, statusCode: 429, nextRetryAt: Date.now() + delayMs};
        this.modelGate.deferUntil(task.retry.nextRetryAt);
        await this.save();
        await this.progress?.update(`节点 ${task.id} · 模型限流 429，等待至少 ${Math.ceil(delayMs / 1000)} 秒后在原会话重试（第 ${attempt} 次）`, task.session);
        await this.modelGate.wait(signal);
      }
    }
  }
  async runTask(task, context) {
    let stop, stopping;
    try {
      context.abort.throwIfAborted();
      await this.progress?.update(`节点 ${task.id} · 正在创建 worktree 和子会话`);
      await this.integrate(async () => {
        context.abort.throwIfAborted();
        await this.assertLocal();
        task.baseCommit = this.state.syncedCommit;
        task.branch = `dag/${this.state.id}/task-${task.id}`;
        task.worktree = join(dirname(this.root), '.dag-worktrees', basename(this.root), this.state.id, `task-${task.id}`);
        await mkdir(dirname(task.worktree), { recursive: true });
        await git(this.root, ['worktree', 'add', '-b', task.branch, task.worktree, task.baseCommit]);
      });
      context.abort.throwIfAborted();
      const source = task.dependencies.length === 1
        ? this.state.tasks.find(t => t.id === task.dependencies[0] && t.session && !this.completedTaskIds.has(t.id))
        : undefined;
      const workspace = unwrap(await this.client._client.post({ url: '/experimental/workspace', query: { directory: this.root },
        body: { type: 'dag-task', branch: task.branch, extra: { directory: task.worktree } }, headers: { 'Content-Type': 'application/json' } }));
      task.workspaceID = workspace.id;
      const query = { directory: task.worktree, workspace: workspace.id };
      const headers = { 'x-opencode-directory': encodeURIComponent(task.worktree) };
      const session = source ? unwrap(await this.client.session.fork({ path: { id: source.session }, query, headers, body: {} }))
        : unwrap(await this.client.session.create({ query, headers, body: { title: `DAG ${task.id}: ${task.title}`, parentID: this.parent } }));
      unwrap(await this.client._client.post({ url: '/sync/steal', query, body: { sessionID: session.id }, headers: { 'Content-Type': 'application/json' } }));
      const bound = unwrap(await this.client.session.get({ path: { id: session.id }, query, headers }));
      if (bound.workspaceID !== workspace.id) throw new Error('宿主未将 Fork 会话迁移到新 Workspace，停止执行');
      unwrap(await this.client.session.update({ path: { id: session.id }, query, headers, body: { title: `DAG ${task.id}: ${task.title}`, metadata: { dagRunId: this.state.id, taskId: task.id, coordinatorSession: this.parent } } }));
      task.session = session.id; task.forkedFrom = source?.session ?? null; task.status = 'running';
      registry.workers.set(session.id, { run: this, task }); await this.save();
      await this.progress?.update(`节点 ${task.id} · Agent 正在执行任务`, session.id);
      context.metadata({ title: `任务 ${task.id}: ${task.title}`, metadata: { sessionId: session.id, worktree: task.worktree, taskId: task.id } });
      stop = () => { stopping = this.client.session.abort({ path: { id: session.id }, query, headers }).catch(() => {}); };
      context.abort.addEventListener('abort', stop, { once: true }); context.abort.throwIfAborted();
      const predecessors = this.state.tasks.filter(t => task.dependencies.includes(t.id));
      const prompt = taskInput(task, predecessors, Boolean(source), this.workflowInput);
      const result = await this.promptTask(task, query, headers, prompt, context.abort);
      if (task.retry) task.retry.waiting = false;
      task.report = result.parts?.filter(p => p.type === 'text').map(p => p.text).join('\n') ?? '';
      if (task.status !== 'done') throw new Error('节点会话已结束，但 submit_task 尚未完成 PR 合并');
      task.finishedAt = Date.now();
      await this.save(); await this.progress?.update(`节点 ${task.id} 已完成并合并 PR #${task.pr}`);
      return { id: task.id, status: task.status, pr: task.pr, session: task.session, report: task.report };
    } catch (error) {
      const status = context.abort.aborted ? 'cancelled' : 'failed';
      if (task.status !== 'done') task.status = status;
      task.error = error.message; task.finishedAt = Date.now();
      if (!this.controller.signal.aborted) {this.failure = error; this.controller.abort(error);}
      await this.save(); throw error;
    } finally {
      if (stop) context.abort.removeEventListener('abort', stop);
      if (stopping) await stopping;
    }
  }
  async submit(task, summary) {
    if (task.submitting) return { status: 'blocked', message: '已有提交正在处理，请勿并发调用' };
    if (task.status === 'done') return { status: 'merged', pr: task.pr };
    task.submitting = true;
    try {
      return await this.integrate(async () => {
        this.controller.signal.throwIfAborted();
        if (this.state.status !== 'running') throw new Error('DAG 已结束，不能提交新 PR');
        await this.progress?.update(`节点 ${task.id} · 检查提交并推送任务分支`);
        await this.assertLocal();
        await clean(task.worktree);
        if (await git(task.worktree, ['branch', '--show-current']) !== task.branch) throw new Error('任务分支被切换，拒绝提交');
        const head = await git(task.worktree, ['rev-parse', 'HEAD']);
        if (head === task.baseCommit) throw new Error('请先完成代码并 git commit，再调用 submit_task');
        await git(task.worktree, ['push', '-u', this.state.gitRemote, `HEAD:refs/heads/${task.branch}`]);
        this.controller.signal.throwIfAborted();
        await this.assertLocal();
        const result = await this.provider.submit(task, this.state.integrationBranch, summary, head);
        if (result.status === 'conflict') {
          const repairRef = `refs/dag/${this.state.id}/task-${task.id}/integration`;
          result.repairCommands = [
            ['fetch', '--no-tags', this.state.gitRemote, `refs/heads/${this.state.integrationBranch}:${repairRef}`],
            ['merge', repairRef, '--no-edit']
          ];
          result.action = '用 git 工具逐条执行 repairCommands 的参数数组，解决冲突、测试、git commit 后再调用 submit_task，复用本次 PR。';
        }
        task.lastSubmission = result; task.commit = head;
        await this.save();
        if (result.status === 'merged') { await this.sync(result.mergeCommit); task.status = 'done'; task.mergeCommit = result.mergeCommit; }
        await this.save(); await this.progress?.update(`节点 ${task.id} · PR ${result.pr ?? ''} · ${result.status}${result.message ? ': ' + result.message : ''}`); return result;
      });
    } catch (error) { await this.progress?.update(`节点 ${task.id} · 提交受阻：${error.message}`); return { status: 'blocked', message: error.message }; }
    finally { task.submitting = false; }
  }
}

export function guardWorker(session, tool, args) {
  const worker = registry.workers.get(session); if (!worker) return;
  const { run, task } = worker;
  if (task.status !== 'running') throw new Error('节点已结束，禁止继续修改');
  const inside = path => { const rel = relative(task.worktree, resolve(path)); return !rel.startsWith('..') && !isAbsolute(rel); };
  const roots = [run.root, ...run.state.tasks.filter(t => t.worktree && t.id !== task.id).map(t => t.worktree)].sort((a, b) => b.length - a.length);
  for (const key of ['filePath', 'path', 'workdir']) {
    if (typeof args[key] !== 'string') continue;
    const value = resolve(task.worktree, args[key]);
    if (inside(value)) { args[key] = value; continue; }
    if (run.workflow && ['read', 'glob', 'grep'].includes(tool)) {
      const artifact = relative(run.workflow.dir, value);
      if (!artifact.startsWith('..') && !isAbsolute(artifact)) { args[key] = value; continue; }
    }
    const old = roots.find(root => { const rel = relative(root, value); return !rel.startsWith('..') && !isAbsolute(rel); });
    if (old) args[key] = resolve(task.worktree, relative(old, value));
    if (['write', 'edit', 'multiedit'].includes(tool) && !inside(args[key])) throw new Error('禁止写入本任务 worktree 之外的路径');
  }
  if (tool === 'bash') {
    if (run.workflow && /(?:^|[\s/\\'";&|])(?:hdc(?:\.exe)?|devecocli(?:\.cmd|\.exe)?\s+(?:emulator|device|run|debug|ui|testing|verify))(?=$|[\s'";&|])/i.test(args.command)) {
      throw new Error('开发节点禁止直接运行设备命令，请在合并后评测阶段执行');
    }
    args.workdir = args.workdir ?? task.worktree;
    if (!inside(args.workdir) || roots.some(root => String(args.command).toLowerCase().includes(root.toLowerCase()) || String(args.command).toLowerCase().includes(root.replaceAll('\\', '/').toLowerCase()))) throw new Error(`命令仍引用旧工作区，请改为在 ${task.worktree} 使用相对路径运行`);
  }
}
