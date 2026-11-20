export const labels = { pending: '待执行', running: '执行中', done: '已完成', blocked: '阻塞', failed: '失败', cancelled: '已取消', paused: '已停止' };
export function isDagTransportPart(part) {
  return part?.type === 'text' && (part.metadata?.dagProgress === true || part.metadata?.dagRetry === true ||
    (['start', 'status', 'cancel', 'resume-one-duo'].includes(part.metadata?.dagControl?.action) && typeof part.metadata.dagControl.root === 'string'));
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

const decisionLabels = {finish: '验收通过', repair: '需要修复', pause: '暂停'};
const decisionStates = {finish: 'done', repair: 'failed', pause: 'paused'};
const verdictLabels = {passed: '通过', failed: '失败', unverified: '未验证'};
const activityClock = new Intl.DateTimeFormat('zh-CN', {hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
const planningTools = {
  read: '读取文件', glob: '查找文件', grep: '搜索代码', skill: '加载技能', devecocli: '运行 DevEco CLI',
  submit_plan: '提交 DAG', submit_checklist: '提交验收清单'
};

function verdictSummary(verdict) {
  return Object.entries(verdictLabels).flatMap(([key, label]) => verdict?.[key] ? [`${verdict[key]} ${label}`] : []).join(' · ');
}

function activitySummary(task, kind) {
  const {waitingDevice, activity} = task;
  if (waitingDevice) return `等待设备 ${waitingDevice.device}${waitingDevice.pid ? `（PID ${waitingDevice.pid}）` : ''}`;
  if (task.retry?.waiting) return '等待重试';
  if (kind !== 'evaluation' || task.status !== 'running') return '';
  if (!task.session) return '准备设备';
  if (!activity) return '';
  return Number.isFinite(activity.finishedAt) ? `最近 ${activity.tool} ${activityClock.format(activity.finishedAt)}` : `${activity.tool} 执行中`;
}

function planningActivity({session, activity}) {
  if (!session) return '正在创建 Agent 会话';
  if (!activity?.tool) return '等待模型响应';
  const action = planningTools[activity.tool] ?? activity.tool;
  if (!Number.isFinite(activity.finishedAt)) return `${action}中`;
  return `等待模型响应 · 最近${action} ${activityClock.format(activity.finishedAt)}`;
}

function planningNode(key, label, status, plan, checkCount) {
  const checks = plan?.checkCount ?? checkCount;
  const summary = [checks ? `验收清单已固定 · ${checks} 项` : '', plan?.taskCount ? `已提交 ${plan.taskCount} 个任务` : ''].filter(Boolean);
  if (status === 'running' && plan) summary.push(planningActivity(plan));
  else if (status !== 'done' || !summary.length) summary.push(labels[status] ?? status);
  return {key, type: 'plan', label, status, summary: summary.filter(Boolean).join(' · '),
    ...(plan?.session || plan?.error ? {task: plan} : {})};
}

function taskRows(round, kind) {
  const tasks = kind === 'change' ? round.changeTasks : round.evaluationTasks;
  return (tasks ?? []).map(task => {
    const verdict = kind === 'evaluation' && task.status === 'done' ? task.verdict : undefined;
    const status = verdict?.failed ? 'failed' : verdict?.unverified ? 'unverified' : task.status;
    const submitted = !verdict && task.itemCount && task.checkProgress ? `${task.checkProgress.submitted}/${task.itemCount} 已提交` : '';
    const notes = kind === 'change'
      ? [task.dependencies?.length ? `依赖 ${task.dependencies.join(', ')}` : '', task.pr ? `PR #${task.pr}` : '']
      : [submitted || (task.itemCount ? `${task.itemCount} 项` : ''), verdictSummary(verdict), task.deviceLockError ? '设备锁残留' : ''];
    return {
      key: `round:${round.round}:${kind}:task:${task.id}`, label: kind === 'change' ? `#${task.id} ${task.title}` : task.target ?? task.title,
      status, summary: [...notes, activitySummary(task, kind) || (verdict ? '' : labels[task.status])].filter(Boolean).join(' · '), task
    };
  });
}

function stageStatus(tasks, active) {
  if (tasks.some(task => task.status === 'failed')) return 'failed';
  if (tasks.some(task => task.status === 'running') || active) return 'running';
  if (tasks.length && tasks.every(task => task.status === 'done')) return 'done';
  if (tasks.some(task => task.status === 'cancelled')) return 'cancelled';
  if (tasks.some(task => task.status === 'blocked')) return 'blocked';
  return 'pending';
}

function roundNode(round, workflow, workflowStatus) {
  const change = taskRows(round, 'change'), evaluation = taskRows(round, 'evaluation');
  const active = workflow.round === round.round;
  const evaluationTasks = round.evaluationTasks ?? [];
  const checkStatus = stageStatus(evaluationTasks, active && workflow.phase === 'evaluating');
  const total = evaluationTasks.reduce((counts, task) => {
    for (const key of Object.keys(counts)) counts[key] += task.verdict?.[key] ?? 0;
    return counts;
  }, {passed: 0, failed: 0, unverified: 0});
  const codeStatus = round.change ?? stageStatus(change, active && workflow.phase === 'developing');
  const evaluationStatus = checkStatus === 'done' ? total.failed ? 'failed' : total.unverified ? 'unverified' : 'done' : checkStatus;
  const submitted = evaluationStatus === 'running' && workflow.checkCount && evaluationTasks.some(task => task.checkProgress)
    ? `${evaluationTasks.reduce((count, task) => count + (task.checkProgress?.submitted ?? 0), 0)}/${workflow.checkCount} 已提交` : '';
  const decision = round.result?.action;
  const terminal = active && workflow.phase === 'finished' && ['failed', 'cancelled', 'paused'].includes(workflowStatus)
    ? workflowStatus : undefined;
  const busy = active && ['developing', 'evaluating'].includes(workflow.phase);
  const stopped = ['failed', 'cancelled', 'blocked'].includes(codeStatus);
  const status = terminal ?? decisionStates[decision] ?? (stopped ? codeStatus : busy ? 'running' : 'pending');
  const planning = round.planning ?? (workflow.planning?.round === round.round ? workflow.planning : undefined);
  return {
    key: `round:${round.round}`, type: 'round', label: `第 ${round.round} 轮 · ${round.round === 1 ? '首次开发' : '修复'}`,
    status,
    summary: [round.commit ? `提交 ${round.commit.slice(0, 8)}` : '', decisionLabels[decision]].filter(Boolean).join(' · '),
    children: [
      ...(round.round > 1 ? [planningNode(`round:${round.round}:plan`, '修复规划', planning?.status ?? 'done', planning)] : []),
      {key: `round:${round.round}:change`, label: round.round === 1 ? '开发与合并' : '修复与合并',
        status: codeStatus, summary: change.length ? `${change.filter(task => task.status === 'done').length}/${change.length} 已合并` : labels[codeStatus], children: change},
      {key: `round:${round.round}:evaluation`, label: '设备评测', status: evaluationStatus,
        summary: verdictSummary(total) || submitted || labels[evaluationStatus], children: evaluation}
    ]
  };
}

export function workflowTreeRows(view, collapsed = new Set()) {
  const workflow = view?.workflow;
  if (!workflow) return [];
  const rounds = workflow.rounds ?? [];
  const initial = workflow.planning?.round === 1 ? workflow.planning : rounds.find(round => round.round === 1)?.planning;
  const planningStatus = initial?.status ?? (workflow.checkCount ? 'done' : view.status);
  const nodes = [planningNode('initial-plan', '首次规划', planningStatus, initial, workflow.checkCount)];
  for (const round of rounds) nodes.push(roundNode(round, workflow, view.status));
  const repair = workflow.planning?.round > 1 ? workflow.planning : undefined;
  const nextRound = repair?.round ?? (workflow.phase === 'repairing' ? workflow.round + 1 : undefined);
  if (nextRound && !rounds.some(round => round.round === nextRound)) {
    const status = repair?.status ?? 'running';
    nodes.push({key: `round:${nextRound}`, type: 'round', label: `第 ${nextRound} 轮 · 修复`, status, children: [
      planningNode(`round:${nextRound}:plan`, '根据评测报告规划修复', status, repair)
    ]});
  }
  const rows = [];
  function visit(entries, indent, parent) {
    for (const [index, node] of entries.entries()) {
      const last = index === entries.length - 1;
      const branch = Boolean(node.children?.length);
      const expanded = branch && !collapsed.has(node.key);
      rows.push({...node, children: undefined, branch, expanded, parent, prefix: indent + (last ? '└─ ' : '├─ ')});
      if (expanded) visit(node.children, indent + (last ? '   ' : '│  '), node.key);
    }
  }
  visit(nodes, '', undefined);
  return rows;
}
