import { viewFromPart, isDagTransportPart } from './panel-model.js';
export async function installPanel(api, renderDashboard, renderDetailReturn) {
    const prefix = 'static-dag.panel.v1';
    const taskLink = () => api.route.current.name === 'session'
      ? api.kv.get(prefix + ':task:' + api.route.current.params.sessionID) : undefined;
    const root = () => {
      if (api.route.current.name === 'static-dag.dashboard' && api.route.current.params?.root) return api.route.current.params.root;
      const sessionID = api.route.current.name === 'session' ? api.route.current.params.sessionID : undefined;
      // Native Fork retains the source session.directory. Map by session identity,
      // never by the footer's historical path when returning from a worktree.
      return taskLink()?.root || (sessionID && api.kv.get(prefix + ':session:' + sessionID)) ||
        (api.state.path.worktree && api.state.path.worktree !== '/' ? api.state.path.worktree : api.state.path.directory);
    };
    const current = () => {
      const route = api.route.current;
      const runId = route.name === 'static-dag.dashboard' ? route.params?.runId : taskLink()?.runId;
      if (runId) return api.kv.get(prefix + ':run:' + runId);
      const sessionID = route.name === 'session' ? route.params.sessionID : route.name === 'static-dag.dashboard' ? route.params?.parent : undefined;
      if (!sessionID) return;
      const bound = api.kv.get(prefix + ':parent:' + sessionID);
      if (bound) return bound;
      // Read old per-worktree caches only when their owner matches this session.
      const legacy = api.kv.get(prefix + ':' + root().toLowerCase());
      if (legacy?.parent === sessionID || legacy?.tasks?.some(task => task.session === sessionID)) return legacy;
    };
    const remember = view => {
      api.kv.set(prefix + ':' + view.root.toLowerCase(), view);
      if (view.id) api.kv.set(prefix + ':run:' + view.id, view);
      const previous = api.kv.get(prefix + ':parent:' + view.parent);
      if (!previous || (view.startedAt ?? 0) >= (previous.startedAt ?? 0)) api.kv.set(prefix + ':parent:' + view.parent, view);
      for (const id of [view.parent, ...(view.tasks ?? []).map(task => task.session)].filter(Boolean)) {
        api.kv.set(prefix + ':session:' + id, view.root);
      }
      for (const task of view.tasks ?? []) if (task.session) api.kv.set(prefix + ':task:' + task.session,
        {root: view.root, runId: view.id, parent: view.parent, taskId: task.id});
      for (const task of view.tasks ?? []) for (const review of task.reviews ?? []) if (review.session) {
        api.kv.set(prefix + ':session:' + review.session, view.root);
        api.kv.set(prefix + ':task:' + review.session, {root: view.root, runId: view.id, parent: view.parent, taskId: task.id});
      }
    };
    const unsubscribe = api.event.on('message.part.updated', event => {
      const view = viewFromPart(event.properties.part);
      if (view?.root?.toLowerCase() === root().toLowerCase()) remember(view);
    });
    api.lifecycle.onDispose(unsubscribe);

    const hiding = new Set();
    async function hideTransport(part) {
      if (!isDagTransportPart(part) || part.synthetic || hiding.has(part.id)) return;
      hiding.add(part.id);
      try {
        const result = await api.client.part.update({sessionID: part.sessionID, messageID: part.messageID, partID: part.id,
          directory: root(), part: {...part, synthetic: true, ignored: true,
            metadata: {...part.metadata, ...(part.metadata?.dagControl ? {dagControlHandled: true} : {})}}});
        if (result.error) throw new Error('隐藏 DAG 控制消息失败');
      } catch { hiding.delete(part.id); }
    }

    async function restore() {
      const sessionID = current()?.parent ?? (api.route.current.name === 'session' ? api.route.current.params.sessionID : api.route.current.params?.parent);
      if (!sessionID) return;
      const result = await api.client.session.messages({sessionID, directory: root()});
      await Promise.all((result.data ?? []).flatMap(message => message.parts).map(hideTransport));
      const knownId = taskLink()?.runId ?? (api.route.current.name === 'static-dag.dashboard' ? api.route.current.params?.runId : undefined);
      const view = viewFromPart(result.data?.flatMap(message => message.parts).findLast(part => part.metadata?.dagView &&
        (!knownId || part.metadata.dagView.id === knownId)));
      if (view?.root?.toLowerCase() === root().toLowerCase()) remember(view);
    }

    function open(task) {
      if (!task?.session) {api.ui.toast({message: task?.kind === 'stage' && task.status !== 'pending' ? '这个节点由程序直接执行，没有 Agent 会话' : '此节点尚未创建 Agent 会话', variant: 'info'}); return;}
      api.route.navigate('session', {sessionID: task.session});
    }
    function panel() {
      const ownerRoot = root(), view = current(), link = taskLink();
      api.ui.dialog.clear();
      const parent = view?.parent ?? (api.route.current.name === 'session' ? api.route.current.params.sessionID : api.route.current.params?.parent);
      api.route.navigate('static-dag.dashboard', {root: ownerRoot, parent, runId: view?.id, focusTask: link?.taskId});
    }
    const isTaskDetail = () => api.route.current.name === 'session' &&
      !!current()?.tasks?.some(task => task.session === api.route.current.params.sessionID ||
        task.reviews?.some(review => review.session === api.route.current.params.sessionID));
    api.keymap.registerLayer({ mode: 'base', priority: 10,
      enabled: () => isTaskDetail() && !api.ui.dialog.open,
      commands: [{name: 'static-dag.detail.back', title: '返回 DAG 看板', run: panel}],
      bindings: [{key: 'up', cmd: 'static-dag.detail.back', desc: '返回 DAG 看板'}]
    });
    if (renderDetailReturn) api.slots.register({order: 200, slots: {
      app_bottom: () => renderDetailReturn({api, active: isTaskDetail, back: panel, hideTransport})
    }});
    async function control(action) {
      let view = current();
      if (action !== 'start' && action !== 'one_duo' && !view?.parent) { api.ui.toast({message: '当前 session 没有关联 DAG', variant: 'info'}); return; }
      let sessionID = (action === 'start' || action === 'one_duo') && api.route.current.name === 'session'
        ? api.route.current.params.sessionID : view?.parent ?? api.route.current.params?.parent;
      if (view?.tasks?.some(task => task.session === sessionID)) sessionID = view.parent;
      if (!sessionID) {
        const created = await api.client.session.create({directory: root(), title: 'DAG 运行'});
        if (created.error || !created.data) throw new Error('无法创建 DAG 主会话');
        sessionID = created.data.id;
      }
      if (action === 'start' || action === 'one_duo') {
        const ownerRoot = root();
        remember({root: ownerRoot, parent: sessionID, status: '启动检查', detail: '正在检查运行条件', tasks: []});
        api.route.navigate('static-dag.dashboard', {root: ownerRoot, parent: sessionID});
      }
      const result = await api.client.session.prompt({ sessionID, directory: root(), noReply: true,
        parts: [{type: 'text', synthetic: true, ignored: true, text: action === 'one_duo' ? '/one_duo' : `/dag_${action === 'start' ? 'run' : action}`,
          metadata: {dagControl: {action, root: root(), requestId: crypto.randomUUID(), issuedAt: Date.now()}}}] });
      if (result.error) throw new Error('DAG 控制请求失败');
    }
    const safe = fn => async () => { try { await fn(); } catch (error) { api.ui.toast({message: error.message, variant: 'error'}); } };
    api.route.register([{name: 'static-dag.dashboard', render: () => renderDashboard({
      api, view: current, root, open, focusTask: api.route.current.params?.focusTask,
      back() {const parent = current()?.parent ?? api.route.current.params?.parent; api.route.navigate(parent ? 'session' : 'home', parent ? {sessionID: parent} : undefined);},
      refresh: safe(() => control('status')), cancel: safe(() => control('cancel'))
    })}]);
    api.keymap.registerLayer({ commands: [
      {name: 'static-dag.one-duo', title: '一多适配：准备、规划并执行', category: 'DAG', namespace: 'palette', slashName: 'one_duo', run: safe(async () => {await control('one_duo'); panel();})},
      {name: 'static-dag.run', title: '运行 DAG', category: 'DAG', namespace: 'palette', slashName: 'dag_run', run: safe(async () => {await control('start'); panel();})},
      {name: 'static-dag.panel', title: 'DAG 任务面板', category: 'DAG', namespace: 'palette', slashName: 'dag_panel', run: safe(async () => {await restore(); panel();})},
      {name: 'static-dag.status', title: '刷新 DAG 状态', category: 'DAG', namespace: 'palette', slashName: 'dag_status', run: safe(async () => {await control('status'); panel();})},
      {name: 'static-dag.cancel', title: '取消 DAG 运行', category: 'DAG', namespace: 'palette', slashName: 'dag_cancel', run: safe(async () => {await control('cancel'); panel();})}
    ], bindings: [] });
}
