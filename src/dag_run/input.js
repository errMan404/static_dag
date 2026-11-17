import {readFileSync} from 'node:fs';
import {uxInput} from './ux.js';

const template = readFileSync(new URL('./task.md', import.meta.url), 'utf8').trim();

// Explicitly select business fields. Runtime state stays in state.json/registry.
export function taskInput(task, predecessors = [], inherited = false) {
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
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(values[key] ?? '')) + uxInput(task.ux);
}
