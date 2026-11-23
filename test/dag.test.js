import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDag, parseDag } from '../src/dag.js';
import plugin from '../src/plugin.js';

const task = (id, dependencies = []) => ({ id, title: `Task ${id}`, description: '目标和边界', details: '实现说明', testStrategy: '运行相关测试并验证结果', dependencies });
test('任务依赖表达并行，规范化状态/优先级，不限制任务数量', () => {
  const result = validateDag({ tasks: [task(1), task(2, [1]), task(3, [1]), task(4, [2, 3])] });
  assert.deepEqual(result.tasks[3].dependencies, [2, 3]);
  assert.equal(result.tasks[0].priority, 'medium'); assert.equal(result.tasks[0].status, 'pending');
  assert.equal(validateDag({ tasks: Array.from({ length: 250 }, (_, i) => task(i + 1)) }).tasks.length, 250);
});
test('拒绝非法JSON、空图、编号错误、缺失/重复/自依赖/环和缺少验收方法，不静默删除边', () => {
  assert.throws(() => parseDag('```json\n{}\n```'), /合法 JSON/);
  for (const tasks of [[], [task(2)], [task(1), task(1)], [task(1, [2])], [task(1, [1])],
    [task(1, [2]), task(2, [1])], [task(1), task(2, [1, 1])], [{ ...task(1), testStrategy: '' }]]) {
    assert.throws(() => validateDag({ tasks }), /校验失败/);
  }
});
test('原地修改slash消息、仅允许worktree目标、无效内容不落盘、写后确认，不影响普通会话', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dag-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'nested'); await mkdir(directory);
  const hooks = await plugin({ client: {}, directory, worktree: root });
  t.after(() => hooks.dispose());
  const config = {}; await hooks.config(config);
  assert.equal(config.command.dag.agent, 'dag-planner');
  assert.ok(!config.agent['dag-planner'].prompt.includes('numTasks'));
  assert.deepEqual(await plugin({ client: {}, directory, worktree: root }), {});
  const parts = [{ type: 'text', text: 'original' }];
  await hooks['command.execute.before']({ command: 'dag', sessionID: 's', arguments: '三折叠适配' }, { parts });
  const target = join(root, '.dag', 'dag.json');
  assert.equal(parts[0].text, '/dag 三折叠适配'); assert.ok(parts[1].text.includes(target));
  const before = args => hooks['tool.execute.before']({ sessionID: 's', tool: 'write', callID: 'w' }, { args });
  await assert.rejects(before({ filePath: join(directory, '.dag', 'dag.json'), content: '{}' }), /唯一允许/);
  await assert.rejects(before({ filePath: target, content: '{}' }), /校验失败/);
  await assert.rejects(readFile(target), /ENOENT/);
  await assert.rejects(hooks['tool.execute.before']({ sessionID: 's', tool: 'bash' }, { args: {} }), /仅允许/);
  const args = { filePath: target, content: JSON.stringify({ tasks: [task(1)] }) };
  await before(args); await mkdir(join(root, '.dag')); await writeFile(target, args.content);
  const output = { title: '', output: 'written', metadata: {} };
  await hooks['tool.execute.after']({ sessionID: 's', tool: 'write', callID: 'w' }, output);
  assert.equal(output.metadata.dagValidated, true);
  // The same submission from a model that has apply_patch instead of write; it replaces the file already there.
  const patch = (path, text) => ({ patchText: `*** Begin Patch\n*** Add File: ${path}\n+${text}\n*** End Patch` });
  const patching = args => hooks['tool.execute.before']({ sessionID: 's', tool: 'apply_patch', callID: 'p' }, { args });
  await assert.rejects(patching(patch('src/a.js', 'x')), /唯一允许/);
  await assert.rejects(patching(patch(target, '{}')), /校验失败/);
  const good = patch(target, JSON.stringify({ tasks: [task(1), task(2)] }));
  await patching(good);
  await assert.rejects(readFile(target), /ENOENT/);
  await writeFile(target, good.patchText.split('\n').filter(l => l.startsWith('+')).map(l => l.slice(1)).join('\n'));
  const patched = { title: '', output: 'written', metadata: {} };
  await hooks['tool.execute.after']({ sessionID: 's', tool: 'apply_patch', callID: 'p' }, patched);
  assert.equal(patched.metadata.taskCount, 2);
  await hooks['chat.message']({ sessionID: 's', agent: 'build' });
  await hooks['tool.execute.before']({ sessionID: 's', tool: 'bash' }, { args: {} });
});
