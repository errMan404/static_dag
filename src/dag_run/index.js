import { mkdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { dirname, basename, join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setMaxListeners } from 'node:events';
import { parseDag } from '../dag.js';
import { git, clean } from './git.js';
import { Gitea } from './gitea.js';
import { resolveGiteaToken } from './credentials.js';
import { loadRunnerConfig, enableWorkspaces } from '../runtime/local-gitea.js';
import { taskInput } from './input.js';
import { ModelGate, rateLimit, retryDelay } from './rate-limit.js';
import { loadUx, nodeUx, writeUxReport } from './ux.js';
import { patchFiles } from '../patch.js';

export const registry = globalThis[Symbol.for('static-dag.execution')] ??= { runs: new Map(), workers: new Map(), roots: new Map() };
export const DEFAULT_MAX_CONCURRENCY = 20;
const unwrap = value => { const error = value.error ?? value.data?.info?.error; if (error || !value.data) throw new Error(JSON.stringify(error ?? '宿主返回空结果'), {cause: error}); return value.data; };
export class DagRun {
  constructor() {
    this.active = new Map();
    this.integrationTail = Promise.resolve();
    this.saveTail = Promise.resolve();
    this.modelGate = new ModelGate();
  }
  integrate(operation) {
    const next = this.integrationTail.then(operation);
    this.integrationTail = next.catch(() => {});
    return next;
  }
  static async start(root, parent, client) {
    root = resolve(root);
    if (registry.roots.has(root)) throw new Error('当前 worktree 已有 DAG 在执行');
    const dag = parseDag(await readFile(join(root, '.dag/dag.json'), 'utf8'));
    const ux = await loadUx(root, dag.tasks);
    if (process.env.OPENCODE_EXPERIMENTAL_WORKSPACES !== 'true' && process.env.OPENCODE_EXPERIMENTAL_WORKSPACES !== '1') {
      await enableWorkspaces();
      throw new Error('已为当前 Windows 用户保存 Workspace 开关。OpenCode 1.19.5 在启动时读取它，请关闭并重新打开终端应用后再运行 /dag_run。也可在当前终端设置 $env:OPENCODE_EXPERIMENTAL_WORKSPACES="true" 后启动 OpenCode。');
    }
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
    const run = new DagRun();
    Object.assign(run, { root, parent, client, config, provider,
      state: { id: randomUUID(), status: 'running', startedAt: Date.now(), localBranch: branch, initialCommit,
        syncedCommit: initialCommit, maxConcurrency: config.maxConcurrency, tasks: dag.tasks.map(t => ({ ...t, status: 'pending' })) }, controller: new AbortController() });
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
    try { run.lock = await open(join(root, '.dag/run.lock'), 'wx'); await run.lock.writeFile(JSON.stringify({ pid: process.pid, runId: run.state.id })); }
    catch (error) { throw new Error(error.code === 'EEXIST' ? '存在 .dag/run.lock；请确认无其他运行后再处理残留锁。' : error.message); }
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
    if (this.lock) { await this.lock.close(); this.lock = null; await unlink(join(this.root, '.dag/run.lock')); }
  }
  async assertLocal() {
    if (await git(this.root, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('主 worktree 被修改，拒绝自动同步');
    if (await git(this.root, ['branch', '--show-current']) !== this.state.localBranch) throw new Error('启动 worktree 的目标分支已变化，停止运行');
    if (await git(this.root, ['rev-parse', 'HEAD']) !== this.state.syncedCommit) throw new Error('启动 worktree 的 HEAD 已被外部移动，停止运行；不会自动覆盖本地回退或提交');
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
      while (this.state.status === 'running') {
        this.controller.signal.throwIfAborted();
        for (const task of this.ready()) {
          if (this.active.size >= this.config.maxConcurrency) break;
          task.status = 'running'; task.startedAt = Date.now();
          const pending = this.runTask(task, {abort: this.controller.signal, metadata() {}})
            .catch(error => {
              if (!this.controller.signal.aborted) {
                this.failure = error;
                this.controller.abort(error);
              }
            }).finally(() => this.active.delete(task.id));
          this.active.set(task.id, pending);
        }
        if (!this.active.size) {
          await this.complete();
          break;
        }
        await Promise.race(this.active.values());
      }
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
  ready() {
    return this.state.tasks.filter(task => task.status === 'pending' && task.dependencies.every(id =>
      this.state.tasks.find(item => item.id === id).status === 'done' && !this.active.has(id)));
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
      // A task starts in a session of its own and learns about its predecessors from their reports. Forking the
      // predecessor's session ("forkSession": true in .dag/runner.json) hands over its whole conversation instead,
      // which made every task begin with tens of thousands of tokens it never needed and slowed each step.
      const source = this.config.forkSession === true && task.dependencies.length === 1 ? this.state.tasks.find(t => t.id === task.dependencies[0]) : undefined;
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
      const prompt = taskInput(task, this.state.tasks.filter(t => task.dependencies.includes(t.id)), Boolean(source));
      const result = await this.promptTask(task, query, headers, prompt, context.abort);
      if (task.retry) task.retry.waiting = false;
      task.report = result.parts?.filter(p => p.type === 'text').map(p => p.text).join('\n') ?? '';
      if (task.status !== 'done') throw new Error('节点会话已结束，但 submit_task 尚未完成 PR 合并');
      task.finishedAt = Date.now();
      await this.save(); await this.progress?.update(task.noChange ? `节点 ${task.id} 已完成（无代码改动）` : `节点 ${task.id} 已完成并合并 PR #${task.pr}`);
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
        // A task may legitimately end with nothing to change (a page that already fits, a regression pass that
        // finds no regression). The tree is clean and has no commit of its own, so there is nothing to merge.
        if (head === task.baseCommit) {
          task.status = 'done'; task.noChange = true; task.commit = head;
          await this.save(); await this.progress?.update(`节点 ${task.id} · 没有代码改动，记为完成`);
          return { status: 'merged', noChange: true, message: '本任务没有代码改动，已记为完成，无需合并。请在交付摘要里说明为什么不需要改动。' };
        }
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

const DEVICE_COMMAND = /(^|[\s;&|('"/\\])(hdc(\.exe)?|uitest|aa\s+(start|force-stop)|devecocli\s+(run|device|emulator))(\s|$)/;
const DEVICE_TOOLS = ['verify_ui', 'save_ui_screenshot', 'capture_pages'];

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
    const old = roots.find(root => { const rel = relative(root, value); return !rel.startsWith('..') && !isAbsolute(rel); });
    if (old) args[key] = resolve(task.worktree, relative(old, value));
    if (['write', 'edit', 'multiedit'].includes(tool) && !inside(args[key])) throw new Error('禁止写入本任务 worktree 之外的路径');
  }
  if (tool === 'apply_patch') for (const file of patchFiles(args.patchText))
    if (!inside(resolve(task.worktree, file.path))) throw new Error(`禁止写入本任务 worktree 之外的路径：${file.path}`);
  // Other plugins' device tools (and our own whole-project capture) drive a device without queueing for it:
  // they would stop the app under another task's capture, or inspect whichever task's package was installed last.
  if (DEVICE_TOOLS.includes(tool)) throw new Error(`任务里不能使用 ${tool}：设备由所有任务共用。需要在设备上看界面时调用 verify_page 工具，它负责排队、安装本任务的包并导出截图和组件树`);
  if (tool === 'bash') {
    args.workdir = args.workdir ?? task.worktree;
    // Devices are shared by all tasks; only verify_page may use them, because it queues.
    if (DEVICE_COMMAND.test(String(args.command))) throw new Error('设备由所有任务共用，不能直接执行 hdc、uitest、aa 或 devecocli run/device/emulator；需要在设备上看界面时调用 verify_page 工具');
    if (!inside(args.workdir) || roots.some(root => String(args.command).toLowerCase().includes(root.toLowerCase()) || String(args.command).toLowerCase().includes(root.replaceAll('\\', '/').toLowerCase()))) throw new Error(`命令仍引用旧工作区，请改为在 ${task.worktree} 使用相对路径运行`);
  }
}
