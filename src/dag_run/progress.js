const labels = { pending: '待执行', running: '执行中', done: '已完成', blocked: '阻塞', failed: '失败', cancelled: '已取消', paused: '已停止' };

// Synthetic, ignored transport parts persist dashboard data without rendering
// user chat bubbles or entering model context. Update one part throughout a run.
export class Progress {
  constructor(client, root, sessionID) {
    Object.assign(this, { client, root, sessionID, started: Date.now(), detail: '正在检查 DAG、运行配置及工作区', status: '启动检查', chain: Promise.resolve() });
  }
  text() {
    const state = this.run?.state;
    return ['DAG 运行进度', `状态：${state ? labels[state.status] ?? state.status : this.status} · 耗时 ${Math.floor((Date.now() - this.started) / 1000)} 秒`,
      state ? `任务：${state.tasks.filter(task => task.status === 'done').length}/${state.tasks.length} 已完成` : '',
      this.detail, '/dag_panel 查看任务和 Agent 详情 · /dag_cancel 取消', this.run ? `运行记录：${this.run.dir}` : ''].filter(Boolean).join('\n');
  }
  async open() {
    try {
      const result = await this.client.session.prompt({ path: { id: this.sessionID }, query: { directory: this.root },
        body: { noReply: true, parts: [{ type: 'text', text: this.text(), synthetic: true, ignored: true, metadata: { dagProgress: true, dagView: this.view() } }] }, signal: AbortSignal.timeout(5000) });
      if (result.error) throw new Error(JSON.stringify(result.error));
      this.part = result.data?.parts?.find(p => p.type === 'text');
      if (!this.part) throw new Error('宿主没有返回进度消息');
    } catch { await this.toast('DAG 正在检查启动条件'); }
  }
  view() {
    return { root: this.root, parent: this.sessionID, id: this.run?.state.id, status: this.run?.state.status ?? this.status,
      localBranch: this.run?.state.localBranch, initialCommit: this.run?.state.initialCommit, integrationBranch: this.run?.state.integrationBranch,
      gitea: this.run?.state.gitea,
      maxConcurrency: this.run?.state.maxConcurrency,
      ux: this.run?.state.ux,
      detail: this.detail, directory: this.run?.dir, startedAt: this.started, updatedAt: Date.now(),
      tasks: (this.run?.state.tasks ?? []).map(({ id, title, status, dependencies, session, workspaceID, pr, error, retry }) =>
        ({ id, title, status, dependencies, session, workspaceID, pr, error, retry })) };
  }
  async toast(message, variant = 'info') {
    try { await this.client.tui.showToast({ body: { title: 'DAG', message, variant }, signal: AbortSignal.timeout(3000) }); } catch { /* Headless hosts may have no TUI. */ }
  }
  update(detail, worker) {
    if (detail) this.detail = detail;
    if (worker) this.worker = worker;
    const text = this.text(), dagView = this.view();
    this.chain = this.chain.catch(() => {}).then(async () => {
      if (!this.part) return;
      try {
        const part = { ...this.part, text, synthetic: true, ignored: true, metadata: { ...this.part.metadata, dagProgress: true, dagView } };
        const result = await this.client._client.patch({
          url: `/session/${this.sessionID}/message/${part.messageID}/part/${part.id}`,
          query: { directory: this.root }, body: part, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(3000)
        });
        if (result.error) throw new Error(JSON.stringify(result.error));
      } catch { if (!this.warned) { this.warned = true; await this.toast('进度消息更新失败，请查看 .dag/runs 下的运行记录', 'warning'); } }
    });
    return this.chain;
  }
  attach(run) {
    this.run = run; run.progress = this;
    this.timer = setInterval(() => { void this.update(); }, 10000);
    this.timer.unref?.();
  }
  async finish(detail) { clearInterval(this.timer); await this.update(detail); }
}
