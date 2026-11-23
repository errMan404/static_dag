/** @jsxImportSource @opentui/solid */
import { For, Show, createSignal, createEffect, createMemo, onCleanup } from 'solid-js';
import { labels, treeRows } from './panel-model.js';

export function Dashboard(props) {
  const api = props.api;
  const theme = () => api.theme.current;
  const first = treeRows(props.view());
  // Step headings are not nodes: the selection starts on, and moves between, real nodes only.
  const [selected, setSelected] = createSignal(Math.max(0, first.findIndex(row => row.node.id === props.focusTask), first.findIndex(row => row.kind !== 'header')));
  const [now, setNow] = createSignal(Date.now());
  const observedAt = Date.now();
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  const view = () => props.view();
  const tasks = () => view()?.tasks ?? [];
  // One heading per step and one row per node, top to bottom; reviews are rows under their task.
  const rows = createMemo(() => treeRows(view()));
  // The view is replaced on every progress update. Rendering by row key, and keeping the key list itself unchanged
  // while the set of rows is the same, lets the list keep its elements — and with them its scroll position.
  const keys = createMemo(() => rows().map(row => row.key), undefined,
    {equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index])});
  const blank = {key: '', kind: 'task', prefix: '', label: '', gap: true, node: {status: 'pending', dependencies: []}};
  const rowOf = key => rows().find(row => row.key === key) ?? blank;
  const label = state => state === 'revise' ? '需修改' : labels[state] ?? state;
  const glyph = state => state === 'done' ? '●' : state === 'running' ? '◉' : ['failed', 'blocked', 'cancelled', 'revise'].includes(state) ? '✕' : '○';
  const done = () => tasks().filter(t => t.status === 'done').length;
  const percent = () => tasks().length ? Math.round(done() * 100 / tasks().length) : 0;
  const running = () => view()?.status === 'running';
  const status = () => labels[view()?.status] ?? view()?.status ?? '未运行';
  const color = state => state === 'done' ? theme().success : state === 'running' ? theme().primary : state === 'revise' ? theme().warning : ['failed', 'blocked', 'cancelled', '启动失败'].includes(state) ? theme().error : theme().textMuted;
  const elapsed = () => {
    const seconds = Math.floor(((running() ? now() : view()?.updatedAt ?? observedAt) - (view()?.startedAt ?? observedAt)) / 1000);
    return seconds < 60 ? `${Math.max(0, seconds)} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  };
  const open = () => { const row = rows()[selected()]; if (row && row.kind !== 'header') props.open(row.node); };
  const move = by => setSelected(from => { for (let i = from + by; i >= 0 && i < rows().length; i += by) if (rows()[i].kind !== 'header') return i; return from; });
  const unregister = api.keymap.registerLayer({
    get enabled() { return api.route.current.name === 'static-dag.dashboard'; },
    commands: [
      { name: 'static-dag.page.up', run() { move(-1); } },
      { name: 'static-dag.page.down', run() { move(1); } },
      { name: 'static-dag.page.open', run: open },
      { name: 'static-dag.page.back', run: props.back },
      { name: 'static-dag.page.refresh', run: props.refresh },
      { name: 'static-dag.page.cancel', run() { if (running()) props.cancel(); } }
    ],
    bindings: [{key: 'up', cmd: 'static-dag.page.up'}, {key: 'down', cmd: 'static-dag.page.down'},
      {key: 'enter', cmd: 'static-dag.page.open'}, {key: 'escape', cmd: 'static-dag.page.back'},
      {key: 'r', cmd: 'static-dag.page.refresh'}, {key: 'c', cmd: 'static-dag.page.cancel'}]
  });
  if (typeof unregister === 'function') onCleanup(unregister);

  return <box width="100%" height="100%" backgroundColor={theme().background} padding={2} flexDirection="column" gap={1}>
    <box flexDirection="row" justifyContent="space-between">
      <text fg={theme().text}><b>{view()?.pipeline ? '一多适配' : 'DAG 任务看板'}</b></text>
      <text fg={color(view()?.status)}>{status()}</text>
    </box>
    <text fg={theme().textMuted} truncate>{view()?.root ?? props.root()}</text>
    <Show when={view()?.gitea?.repo}><text fg={theme().textMuted} truncate>本轮仓库：{view()?.gitea?.owner}/{view()?.gitea?.repo}</text></Show>
    <Show when={view()?.ux}><text fg={theme().textMuted}>UX 未验证 · {view()?.ux?.reason === 'no-device' ? '未提供设备' : '设备证据未核验'} · 代码完成不代表 UX 通过</text></Show>
    <box backgroundColor={theme().backgroundPanel} padding={1} flexDirection="column" gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text}>{done()} / {tasks().length} 个节点已完成 · 执行中 {tasks().filter(task => task.status === 'running').length}{view()?.maxConcurrency ? ` · 最多同时 ${view()?.maxConcurrency} 个` : ''}</text>
        <text fg={theme().textMuted}>{elapsed()}</text>
      </box>
      <text fg={theme().primary}>{'━'.repeat(Math.round(percent() / 5))}<span fg={theme().textMuted}>{'─'.repeat(20 - Math.round(percent() / 5))}</span> {percent()}%</text>
      <text fg={view()?.status === '启动失败' ? theme().error : theme().textMuted} wrapMode="word">{view()?.detail ?? '使用 /one_duo 启动一多适配，或用 /dag_run 运行已有的任务图。'}</text>
    </box>
    <box flexDirection="row" paddingLeft={1} paddingRight={1} gap={2}>
      <text flexGrow={1} fg={theme().textMuted}>节点（按步骤自上而下执行，同一步里的节点同时执行）</text>
      <text width={10} fg={theme().textMuted}>状态</text>
      <text width={8} fg={theme().textMuted}>PR</text>
    </box>
    <scrollbox flexGrow={1}>
      <For each={keys()}>{(key, index) => {
        const row = () => rowOf(key);
        return <box flexDirection="row" gap={2} paddingLeft={1} paddingRight={1} height={row().gap ? 2 : 1} backgroundColor={index() === selected() && row().kind !== 'header' ? theme().backgroundElement : theme().background}
          onMouseUp={() => { if (row().kind === 'header') return; setSelected(index()); props.open(row().node); }}>
          <text flexGrow={1} flexShrink={1} truncate fg={row().kind === 'review' || row().kind === 'header' ? theme().textMuted : theme().text}>
            <span fg={theme().textMuted}>{row().prefix}</span><Show when={row().kind !== 'header'}><span fg={color(row().node.status)}>{glyph(row().node.status)} </span></Show>{row().label}
          </text>
          <text width={10} fg={color(row().node.status)}>{row().kind === 'review' || row().kind === 'header' ? '' : row().node.retry?.waiting ? '等待重试' : row().node.noChange ? '无需改动' : label(row().node.status)}</text>
          <text width={8} fg={row().node.pr ? theme().primary : theme().textMuted}>{row().node.pr ? '#' + row().node.pr : ''}</text>
        </box>;
      }}</For>
      <Show when={!rows().length}><text fg={theme().textMuted}>暂无节点</text></Show>
    </scrollbox>
    <Show when={rows()[selected()]?.node.detail && !rows()[selected()]?.node.error}><text fg={theme().textMuted} wrapMode="word">{rows()[selected()]?.node.detail}</text></Show>
    <Show when={rows()[selected()]?.node.error}><text fg={theme().error} wrapMode="word">{rows()[selected()]?.node.error}</text></Show>
    <box flexDirection="row" justifyContent="space-between">
      <text fg={theme().textMuted}>↑↓ 选择节点 · Enter / 点击 打开该节点的 Agent · Esc 返回会话</text>
      <text fg={theme().textMuted}>r 刷新{running() ? ' · c 取消运行' : ''}</text>
    </box>
    <text fg={theme().textMuted}>Agent 详情中按 ↑ 或点击底部「返回 DAG 看板」回到这里。</text>
  </box>;
}

export function DetailReturn(props) {
  // Cosmetic migration: hide only this plugin's old transport messages. Keep
  // IDs, content and metadata intact; never hide normal user/assistant messages.
  createEffect(() => {
    const route = props.api.route.current;
    if (route.name !== 'session') return;
    for (const message of props.api.state.session.messages(route.params.sessionID)) {
      for (const part of props.api.state.part(message.id)) void props.hideTransport(part);
    }
  });
  return <Show when={props.active()}>
    <box flexDirection="row" paddingLeft={2} paddingRight={2} height={1}
      backgroundColor={props.api.theme.current.backgroundPanel} onMouseUp={props.back}>
      <text fg={props.api.theme.current.primary}>↑ 返回 DAG 看板</text>
      <text fg={props.api.theme.current.textMuted}>　按上方向键或点击这里</text>
    </box>
  </Show>;
}
