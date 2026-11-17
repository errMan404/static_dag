/** @jsxImportSource @opentui/solid */
import { For, Show, createSignal, createEffect, onCleanup } from 'solid-js';
import { labels } from './panel-model.js';

export function Dashboard(props) {
  const api = props.api;
  const theme = () => api.theme.current;
  const [selected, setSelected] = createSignal(Math.max(0, props.view()?.tasks?.findIndex(task => task.id === props.focusTask) ?? 0));
  const [now, setNow] = createSignal(Date.now());
  const observedAt = Date.now();
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));
  const view = () => props.view();
  const tasks = () => view()?.tasks ?? [];
  const done = () => tasks().filter(t => t.status === 'done').length;
  const percent = () => tasks().length ? Math.round(done() * 100 / tasks().length) : 0;
  const running = () => view()?.status === 'running';
  const status = () => labels[view()?.status] ?? view()?.status ?? '未运行';
  const color = state => state === 'done' ? theme().success : state === 'running' ? theme().primary : ['failed', 'blocked', 'cancelled', '启动失败'].includes(state) ? theme().error : theme().textMuted;
  const elapsed = () => {
    const seconds = Math.floor(((running() ? now() : view()?.updatedAt ?? observedAt) - (view()?.startedAt ?? observedAt)) / 1000);
    return seconds < 60 ? `${Math.max(0, seconds)} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  };
  const open = () => props.open(tasks()[selected()]);
  const unregister = api.keymap.registerLayer({
    get enabled() { return api.route.current.name === 'static-dag.dashboard'; },
    commands: [
      { name: 'static-dag.page.up', run() { setSelected(i => Math.max(0, i - 1)); } },
      { name: 'static-dag.page.down', run() { setSelected(i => Math.min(Math.max(0, tasks().length - 1), i + 1)); } },
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
      <text fg={theme().text}><b>DAG 任务看板</b></text>
      <text fg={color(view()?.status)}>{status()}</text>
    </box>
    <text fg={theme().textMuted} truncate>{view()?.root ?? props.root()}</text>
    <Show when={view()?.gitea?.repo}><text fg={theme().textMuted} truncate>本轮仓库：{view()?.gitea?.owner}/{view()?.gitea?.repo}</text></Show>
    <Show when={view()?.ux}><text fg={theme().textMuted}>UX 未验证 · {view()?.ux?.reason === 'no-device' ? '未提供设备' : '设备证据未核验'} · 代码完成不代表 UX 通过</text></Show>
    <box backgroundColor={theme().backgroundPanel} padding={1} flexDirection="column" gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text}>{done()} / {tasks().length} 个任务已完成 · 执行中 {tasks().filter(task => task.status === 'running').length} · 并发上限 {view()?.maxConcurrency ?? 1}</text>
        <text fg={theme().textMuted}>{elapsed()}</text>
      </box>
      <text fg={theme().primary}>{'━'.repeat(Math.round(percent() / 5))}<span fg={theme().textMuted}>{'─'.repeat(20 - Math.round(percent() / 5))}</span> {percent()}%</text>
      <text fg={view()?.status === '启动失败' ? theme().error : theme().textMuted} wrapMode="word">{view()?.detail ?? '使用 /dag_run 启动当前工作区的 DAG。'}</text>
    </box>
    <box flexDirection="row" paddingLeft={1} paddingRight={1} gap={2}>
      <text width={4} fg={theme().textMuted}>编号</text>
      <text flexGrow={1} fg={theme().textMuted}>任务</text>
      <text width={10} fg={theme().textMuted}>状态</text>
      <text width={12} fg={theme().textMuted}>前置依赖</text>
      <text width={8} fg={theme().textMuted}>PR</text>
    </box>
    <scrollbox flexGrow={1}>
      <For each={tasks()}>{(task, index) =>
        <box flexDirection="row" gap={2} paddingLeft={1} paddingRight={1} height={2} backgroundColor={index() === selected() ? theme().backgroundElement : theme().background}
          onMouseUp={() => {setSelected(index()); props.open(task);}}>
          <text width={4} fg={theme().textMuted}>{task.id}</text>
          <text flexGrow={1} flexShrink={1} fg={theme().text} truncate>{task.title}</text>
          <text width={10} fg={color(task.status)}>{task.retry?.waiting ? '等待重试' : labels[task.status] ?? task.status}</text>
          <text width={12} fg={theme().textMuted}>{task.dependencies.length ? task.dependencies.join(', ') : '—'}</text>
          <text width={8} fg={task.pr ? theme().primary : theme().textMuted}>{task.pr ? '#' + task.pr : '—'}</text>
        </box>
      }</For>
      <Show when={!tasks().length}><text fg={theme().textMuted}>暂无任务</text></Show>
    </scrollbox>
    <Show when={tasks()[selected()]?.error}><text fg={theme().error} wrapMode="word">{tasks()[selected()]?.error}</text></Show>
    <box flexDirection="row" justifyContent="space-between">
      <text fg={theme().textMuted}>↑↓ 选择 · Enter / 点击 查看 Agent · Esc 返回会话</text>
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
