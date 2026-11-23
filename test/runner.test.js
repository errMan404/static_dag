import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runnerHooks } from '../src/dag_run/plugin.js';
import { guardWorker, registry } from '../src/dag_run/index.js';
import { Gitea } from '../src/dag_run/gitea.js';

test('/dag_run 启动失败写入可见进度并弹出具体错误，不调用模型', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dag-missing-')); t.after(() => rm(root, { recursive: true, force: true }));
  const patches = [], prompts = [], toasts = [];
  const client = { session: { async prompt(input) { prompts.push(input); return {data: {parts: [{id: 'prt-test', messageID: 'msg-test', sessionID: 'missing', type: 'text'}]}}; } },
    _client: {async patch(input) { patches.push(input); return {data: input.body}; }}, tui: {async showToast(input) {toasts.push(input);}} };
  const hooks = runnerHooks({ root, client });
  await assert.rejects(hooks.control({ sessionID: 'missing', action: 'start' }), /不存在 .dag\/dag.json/);
  assert.equal(prompts.length, 1); assert.equal(prompts[0].body.noReply, true); assert.equal(prompts[0].body.parts[0].ignored, true);
  assert.equal(prompts[0].body.parts[0].synthetic, true);
  assert.match(patches.at(-1).body.text, /启动失败/); assert.match(patches.at(-1).body.text, /不存在 .dag\/dag.json/);
  assert.equal(toasts.at(-1).body.variant, 'error');
});
test('重启后刷新保留完成记录，活动记录无调度器时标明历史状态', async () => {
  const root = join(tmpdir(), 'dag-status-history');
  const part = {id: 'history-part', messageID: 'history-message', type: 'text', ignored: true,
    metadata: {dagView: {root, status: 'done', tasks: [{id: 1, status: 'done'}]}}};
  const patches = [];
  const hooks = runnerHooks({root, client: {
    session: {async messages() {return {data: [{parts: [part]}]};}, async prompt() {throw new Error('刷新不得替换历史记录');}},
    _client: {async patch(value) {patches.push(value); return {data: value.body};}}
  }});
  await hooks.control({sessionID: 'history-fixture', action: 'status'});
  assert.equal(patches.length, 0);
  part.metadata.dagView.status = 'running';
  await hooks.control({sessionID: 'history-fixture', action: 'status'});
  assert.equal(patches.at(-1).body.metadata.dagView.status, '历史记录');
  assert.equal(patches.at(-1).body.metadata.dagView.tasks.length, 1);
});

test('控制请求先持久化已处理标记，历史编辑和进程重启不重放命令', async () => {
  const root = join(tmpdir(), 'dag-replay-fixture'), patches = [], calls = [];
  let dispatched;
  const done = new Promise(resolve => {dispatched = resolve;});
  const hooks = runnerHooks({root, client: {_client: {async patch(input) {patches.push(input); return {data: input.body};}}}});
  hooks.control = async input => {calls.push(input); dispatched();};
  const part = {id: 'replay-part', messageID: 'replay-message', sessionID: 'replay-session', type: 'text', ignored: true,
    metadata: {dagControl: {action: 'start', root, requestId: 'new-request', issuedAt: Date.now()}}};
  await hooks.event({type: 'message.part.updated', properties: {part}});
  await done;
  assert.equal(calls.length, 1); assert.equal(patches.length, 1);
  const persisted = patches[0].body;
  assert.equal(persisted.metadata.dagControlHandled, true);
  registry.controls.delete('replay-session:replay-part'); // simulate loss of process-local dedupe
  await hooks.event({type: 'message.part.updated', properties: {part: persisted}});
  const old = {...part, id: 'legacy-part', metadata: {dagControl: {action: 'start', root}}};
  await hooks.event({type: 'message.part.updated', properties: {part: old}});
  const expired = {...part, id: 'expired-part', metadata: {dagControl: {...part.metadata.dagControl, issuedAt: Date.now() - 3600000}}};
  await hooks.event({type: 'message.part.updated', properties: {part: expired}});
  assert.equal(calls.length, 1); assert.equal(patches.length, 1);
});

test('Fork历史路径映射到当前工作区，拒绝命令使用旧目录，结束后拒绝工具执行', () => {
  const root = join(tmpdir(), 'dag-old'), worktree = join(tmpdir(), 'dag-new');
  const task = { id: 2, worktree, status: 'running' };
  registry.workers.set('guard-fixture', { task, run: { root, state: { tasks: [task] } } });
  try {
    const args = { filePath: join(root, 'src/a.js') }; guardWorker('guard-fixture', 'write', args);
    assert.equal(args.filePath, join(worktree, 'src/a.js'));
    assert.throws(() => guardWorker('guard-fixture', 'bash', { command: `git -C "${root}" status` }), /旧工作区/);
    const bash = { command: 'git status' }; guardWorker('guard-fixture', 'bash', bash); assert.equal(bash.workdir, worktree);
    guardWorker('guard-fixture', 'apply_patch', { patchText: '*** Begin Patch\n*** Add File: src/b.js\n+x\n*** End Patch' });
    assert.throws(() => guardWorker('guard-fixture', 'apply_patch', { patchText: '*** Begin Patch\n*** Update File: ../outside.js\n@@\n-a\n+b\n*** End Patch' }), /worktree 之外/);
    task.status = 'done'; assert.throws(() => guardWorker('guard-fixture', 'write', args), /已结束/);
  } finally { registry.workers.delete('guard-fixture'); }
});
test('Gitea冲突以完整工具结果反馈，重试复用PR，不把未合并当成功', async () => {
  const api = new Gitea({ url: 'http://localhost', owner: 'fixture', repo: 'fixture' }, 'fixture');
  let creates = 0, merged = false, fail = true;
  api.request = async (path, method) => {
    if (path === '/pulls') { creates++; return { number: 7 }; }
    if (method === 'POST') {
      if (fail) throw Object.assign(new Error('conflict'), { status: 409, data: { message: 'conflict', files: ['a.js'] } });
      merged = true;
    }
    return { merged, merge_commit_sha: 'merged-sha' };
  };
  const node = { id: 1, branch: 'task-1', title: 'task' };
  const first = await api.submit(node, 'main', 'done', 'head');
  assert.equal(first.status, 'conflict'); assert.deepEqual(first.details.files, ['a.js']);
  fail = false; const second = await api.submit(node, 'main', 'fixed', 'new-head');
  assert.equal(second.status, 'merged'); assert.equal(creates, 1); assert.equal(second.pr, 7);
});
