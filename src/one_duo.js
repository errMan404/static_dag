// /one_duo: the whole multi-device adaptation as one run. Stages execute in order — register page entries,
// capture the "before" screenshots, plan per-page tasks, run them — and every stage and task is one node of the
// view the dashboard draws. A stage whose result is already on disk is skipped, so the command can be re-issued.
import {readFile, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {Progress} from './dag_run/progress.js';
import {DagRun, registry} from './dag_run/index.js';
import {git} from './dag_run/git.js';
import {parsePages} from './prepare.js';
import {parseDag} from './dag.js';
import {loadDevices, ensureBaseline, captureResult} from './verify.js';

const STAGES = [
  {id: 'prepare', title: '准备：为全部页面注册直达入口', dependencies: []},
  {id: 'baseline', title: '采集改动前的截图', dependencies: ['prepare']},
  {id: 'plan', title: '规划：按页面拆分适配任务', dependencies: ['baseline']},
  // Drawn below the tasks: it runs once all of them are merged.
  {id: 'check', title: '收尾：编译合并结果并截取全部页面', dependencies: ['plan'], last: true},
];
const MARKER = 'UI_VERIFY_DEEPLINK_BEGIN';

// One progress part for the whole pipeline: stage nodes first, then the tasks of the DAG run once it exists.
class PipelineProgress extends Progress {
  constructor(client, root, sessionID, pipeline) { super(client, root, sessionID); this.pipeline = pipeline; this.detail = '正在启动一多适配流程'; }
  text() { return ['一多适配进度', `状态：${this.pipeline.status}`, this.detail, '/dag_panel 查看节点和 Agent 详情 · /dag_cancel 取消'].join('\n'); }
  view() {
    const base = super.view(), stages = this.pipeline.stages;
    const roots = base.tasks.filter(task => !task.dependencies.length).map(task => task.id);
    const tasks = base.tasks.map(task => ({...task, kind: 'task', dependencies: task.dependencies.length ? task.dependencies : ['plan']}));
    const node = stage => ({...stage, kind: 'stage'});
    // The closing check hangs under every task nothing else depends on, so it sits at the bottom of the tree.
    const leaves = base.tasks.filter(task => !base.tasks.some(other => other.dependencies.includes(task.id))).map(task => task.id);
    return {...base, pipeline: true, status: this.pipeline.status, id: base.id ?? this.pipeline.id, roots,
      tasks: [...stages.filter(stage => !stage.last).map(node), ...tasks,
        ...stages.filter(stage => stage.last).map(stage => node({...stage, dependencies: leaves.length ? leaves : stage.dependencies}))]};
  }
}

export class OneDuo {
  constructor({root, parent, client, exec, connect, detect, startRun = DagRun.start, check = captureResult}) {
    Object.assign(this, {root: resolve(root), parent, client, exec, connect, detect, startRun, check, id: `one-duo-${Date.now()}`, status: 'running',
      stages: STAGES.map(stage => ({...stage, status: 'pending'})), controller: new AbortController()});
    this.progress = new PipelineProgress(client, this.root, parent, this);
  }
  stage(id) { return this.stages.find(stage => stage.id === id); }

  // Runs one stage and records its outcome on the node. `work` may return a note shown next to the node.
  async step(id, work) {
    const stage = this.stage(id);
    this.controller.signal.throwIfAborted();
    stage.status = 'running'; stage.startedAt = Date.now();
    await this.progress.update(`${stage.title} · 进行中`);
    try {
      const note = await work(stage);
      stage.status = 'done'; stage.detail = note ?? stage.detail; stage.finishedAt = Date.now();
      await this.progress.update(`${stage.title} · 完成${note ? `（${note}）` : ''}`);
    } catch (error) {
      stage.status = this.controller.signal.aborted ? 'cancelled' : 'failed'; stage.error = error.message; stage.finishedAt = Date.now();
      throw error;
    }
  }

  // A stage that needs a model runs as a slash command in its own child session, so it shows up as a node the
  // user can open, and so it goes through the same hooks as when a person types the command.
  async command(stage, command, args, agent) {
    const query = {directory: this.root};
    const check = value => { const error = value.error ?? value.data?.info?.error; if (error || !value.data) throw new Error(typeof error === 'string' ? error : error?.data?.message ?? JSON.stringify(error ?? '宿主返回空结果')); return value.data; };
    const session = check(await this.client.session.create({query, body: {title: stage.title, parentID: this.parent}}));
    stage.session = session.id;
    await this.progress.update(`${stage.title} · Agent 正在执行`);
    const stop = () => { void this.client.session.abort({path: {id: session.id}, query}).catch(() => {}); };
    this.controller.signal.addEventListener('abort', stop, {once: true});
    try {
      check(await this.client._client.post({url: `/session/${session.id}/command`, query, headers: {'Content-Type': 'application/json'},
        body: {command, arguments: args, ...(agent && {agent})}, signal: this.controller.signal}));
    } finally { this.controller.signal.removeEventListener('abort', stop); }
  }

  async pages() { try { return parsePages(await readFile(join(this.root, '.dag/pages.json'), 'utf8')); } catch { return undefined; } }
  // The entry is usable when the manifest's commit is in this branch and its marked code is still in the tree
  // (a finished run reverts the entry, which leaves the commit an ancestor but removes the code).
  async entryReady() {
    const manifest = await this.pages();
    if (!manifest) return false;
    try { await git(this.root, ['merge-base', '--is-ancestor', manifest.commit, 'HEAD']); await git(this.root, ['grep', '-q', MARKER, '--', '*.ets']); return true; }
    catch { return false; }
  }

  async run({pages = ''} = {}) {
    registry.pipelines ??= new Map();
    registry.pipelines.set(this.parent, this);
    await this.progress.open();
    this.progress.timer = setInterval(() => { void this.progress.update(); }, 10000);
    this.progress.timer.unref?.();
    try {
      await this.step('prepare', async stage => {
        if (await this.entryReady()) return '入口和页面清单已存在，沿用';
        await this.command(stage, 'prepare', '', 'dag-stage');
        if (!await this.entryReady()) throw new Error('准备阶段结束，但没有得到可用的 .dag/pages.json 和入口提交');
      });
      await this.step('baseline', async () => {
        const devices = await loadDevices(this.root, this.detect && {detect: this.detect});
        const captured = await ensureBaseline({mainRoot: this.root, devices, exec: this.exec, connect: this.connect,
          log: message => { void this.progress.update(`采集改动前的截图 · ${message}`); }});
        return captured.length ? `已采集 ${captured.join('、')}` : `已有 ${devices.map(d => d.config).join('、')} 的截图，沿用`;
      });
      await this.step('plan', async stage => {
        const started = Date.now();
        await this.command(stage, 'dag_pages', pages);
        const file = join(this.root, '.dag/dag.json');
        if ((await stat(file).catch(() => ({mtimeMs: 0}))).mtimeMs < started - 1000) throw new Error('规划阶段结束，但没有写出新的 .dag/dag.json');
        return `${parseDag(await readFile(file, 'utf8')).tasks.length} 个任务`;
      });
      this.controller.signal.throwIfAborted();
      const run = this.dag = await this.startRun(this.root, this.parent, this.client);
      run.progress = this.progress; this.progress.run = run;
      await this.progress.update(`任务图已加载，共 ${run.state.tasks.length} 个任务，最多 ${run.state.maxConcurrency} 个同时执行`);
      await run.execute();
      if (run.state.status !== 'done') { this.status = run.state.status; await this.finish(run.state.error ?? '任务执行未完成'); return this; }
      let shots = '';
      await this.step('check', async () => {
        const result = await this.check({mainRoot: this.root, exec: this.exec, connect: this.connect, detect: this.detect,
          log: message => { void this.progress.update(`收尾 · ${message}`); }});
        shots = result.devices.map(d => d.dir).join('、');
        const lost = result.devices.flatMap(d => d.lost.map(p => `${d.config} 上的 ${p.page}（${p.error}）`));
        if (lost.length) throw new Error(`合并后有页面打不开了，适配前它们可以打开：${lost.join('；')}。其余页面的截图在 ${shots}`);
        return result.devices.map(d => `${d.config} ${d.captured} 页`).join('，');
      });
      this.status = 'done';
      await this.finish(`全部任务完成，合并后的截图在 ${shots}。直达入口仍保留在代码里，交付前对入口提交执行 git revert 去除。`);
    } catch (error) {
      this.status = this.controller.signal.aborted ? 'cancelled' : 'failed';
      await this.finish(this.status === 'cancelled' ? '已取消；已完成的阶段和已合入的提交会保留' : error.message);
      if (this.status === 'failed') await this.progress.toast(error.message, 'error');
    } finally {
      if (registry.pipelines.get(this.parent) === this) registry.pipelines.delete(this.parent);
    }
    return this;
  }
  async finish(detail) { clearInterval(this.progress.timer); await this.progress.update(detail); }
  async cancel() {
    if (this.status !== 'running') return;
    this.controller.abort(new Error('用户取消一多适配'));
    await this.dag?.cancel();
    await this.progress.update('已请求取消，正在停止当前阶段');
  }
}
