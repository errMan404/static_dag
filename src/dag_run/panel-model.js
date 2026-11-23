export const labels = { pending: '待执行', running: '执行中', done: '已完成', blocked: '阻塞', failed: '失败', cancelled: '已取消', paused: '已停止' };
export function isDagTransportPart(part) {
  return part?.type === 'text' && (part.metadata?.dagProgress === true || part.metadata?.dagRetry === true ||
    (['start', 'status', 'cancel', 'one_duo'].includes(part.metadata?.dagControl?.action) && typeof part.metadata.dagControl.root === 'string'));
}
export function viewFromPart(part) {
  const view = part?.metadata?.dagView;
  if (!view) return;
  // Older progress records stored elapsed time only in their visible text.
  const elapsed = part.text?.match(/耗时 (\d+) 秒/)?.[1];
  return !view.updatedAt && elapsed && view.startedAt
    ? {...view, updatedAt: view.startedAt + Number(elapsed) * 1000} : view;
}
export function panelRows(view) {
  return (view?.tasks ?? []).map(task => ({
    title: `${task.id}. [${labels[task.status] ?? task.status}] ${task.title}`,
    value: task.id,
    description: `${task.dependencies.length ? '依赖 ' + task.dependencies.join(', ') : '无前置依赖'}${task.pr ? ' · PR #' + task.pr : ''}`,
    footer: task.error || (task.session ? '进入 Agent 会话' : '尚未创建会话'),
    task
  }));
}

const reviewLabels = { pass: '通过', revise: '需修改', unseen: '未截到' };
// Lays the nodes out as steps, top to bottom. A step is everything that may run at the same time: a node belongs
// to the step after its deepest dependency. Each step gets a heading that says how many nodes it holds and what
// they wait for, so the order never has to be read off connector lines (a graph with shared dependencies cannot
// be drawn honestly as a tree). Reviews of a task are indented rows right under it; each is its own agent session.
export function treeRows(view) {
  const nodes = view?.tasks ?? [], byId = new Map(nodes.map(node => [node.id, node])), depth = new Map();
  const depthOf = (node, seen = new Set()) => {
    if (depth.has(node.id)) return depth.get(node.id);
    if (seen.has(node.id)) return 0;
    seen.add(node.id);
    const value = Math.max(-1, ...(node.dependencies ?? []).filter(id => byId.has(id)).map(id => depthOf(byId.get(id), seen))) + 1;
    depth.set(node.id, value); return value;
  };
  nodes.forEach(node => depthOf(node));
  // What a node waits for, in words. Stages follow one another anyway, so only dependencies on tasks are named.
  const waits = node => {
    const ids = (node.dependencies ?? []).filter(id => byId.has(id) && byId.get(id).kind !== 'stage');
    return !ids.length ? '' : node.kind === 'stage' ? '全部任务完成后开始' : `等 ${ids.join('、')} 完成后开始`;
  };
  const rows = [];
  [...new Set(depth.values())].sort((a, b) => a - b).forEach((level, step) => {
    const group = nodes.filter(node => depth.get(node.id) === level);
    const shared = group.every(node => waits(node) === waits(group[0])) ? waits(group[0]) : null;
    rows.push({key: `step-${step + 1}`, kind: 'header', depth: level, prefix: '', node: {id: `step-${step + 1}`, dependencies: []},
      label: [`第 ${step + 1} 步`, group.length > 1 && `${group.length} 个节点同时执行`, shared].filter(Boolean).join(' · ')});
    for (const node of group) {
      const own = shared === null && waits(node);
      rows.push({key: String(node.id), node, depth: level, prefix: '  ', kind: node.kind ?? 'task',
        label: (node.kind === 'stage' ? node.title : `${node.id}. ${node.title}`) + (own ? `（${own}）` : '')});
      (node.reviews ?? []).forEach((review, index) => rows.push({key: `${node.id}/review-${index}`, depth: level + 1, kind: 'review', prefix: '      ',
        node: {id: `${node.id}/review-${index}`, title: `评审 ${review.page}`, session: review.session,
          status: review.verdict === 'pass' ? 'done' : review.verdict ? 'revise' : 'running', dependencies: []},
        // A page is reviewed once per target device, so the device is part of what tells two rows apart.
        label: [`评审 ${review.page}`, review.config, review.round && `第 ${review.round} 次`, review.verdict ? reviewLabels[review.verdict] ?? review.verdict : '进行中'].filter(Boolean).join(' · ')}));
    }
  });
  // A blank line ends each step, and each task that has reviews under it.
  rows.forEach((row, index) => { const next = rows[index + 1]; row.gap = !next || next.kind === 'header' || (row.kind === 'review' && next.kind !== 'review'); });
  return rows;
}
