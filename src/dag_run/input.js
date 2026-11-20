import {readFileSync} from 'node:fs';
import {checkIdsInTask} from '../one-duo/contracts.js';
import {uxInput} from './ux.js';

const template = readFileSync(new URL('./task.md', import.meta.url), 'utf8').trim();

function workflowContext(task, workflow) {
  const sections = [
    `本轮目标设备\n${workflow.targets.join('、')}`,
    '开发中只做本地构建、静态检查和离线测试。禁止启动、部署或操作模拟器与真机，设备评测在所有 PR 合并之后执行。'
  ];
  if (workflow.report) {
    const failed = workflow.checklist.items.filter(item => workflow.report.results[item.id]?.status === 'failed');
    const ids = checkIdsInTask(task);
    const assigned = failed.filter(item => ids.has(item.id));
    const checks = (assigned.length ? assigned : failed).map(({id, target, steps, expected}) => {
      const {actual, evidence} = workflow.report.results[id];
      return {id, target, steps, expected, actual, evidence};
    });
    sections.push([
      '修复依据',
      `被测提交：${workflow.report.commit}`,
      workflow.reportPath && `评测报告：${workflow.reportPath}\n证据路径相对于报告所在目录。`,
      assigned.length ? '本节点负责的失败项' : '任务未标明失败项编号。请结合本节点范围参考下列失败项。',
      JSON.stringify(checks, null, 2)
    ].filter(Boolean).join('\n'));
  }
  return '\n\n' + sections.join('\n\n');
}

// Explicitly select business fields. Runtime state stays in state.json/registry.
export function taskInput(task, predecessors = [], inherited = false, workflow) {
  const goal = task.description?.trim();
  const details = task.details?.trim();
  const values = {
    id: task.id,
    title: task.title,
    goal: goal && goal !== task.title.trim() ? `目标\n${goal}\n\n` : '',
    details: details && details !== goal && details !== task.title.trim() ? `实施说明\n${details}\n\n` : '',
    testStrategy: task.testStrategy,
    worktree: task.worktree,
    // A native Fork already contains its predecessor's conversation and final
    // report. Fresh sessions at joins receive the direct predecessors' reports.
    predecessors: !inherited && predecessors.length ? '\n\n前置任务结果\n' + predecessors.map(item =>
      `任务 ${item.id}：${item.title}\n${item.report?.trim() || '已完成，代码已合入当前工作目录。'}`).join('\n\n') : ''
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(values[key] ?? '')) + uxInput(task.ux) +
    (workflow ? workflowContext(task, workflow) : '');
}
