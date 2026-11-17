import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadUx, nodeUx} from '../src/dag_run/ux.js';
import {taskInput} from '../src/dag_run/input.js';
import {DagRun} from '../src/dag_run/index.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dag-ux-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, '.dag'));
  const config = {version: 1, cardsFile: 'cards.json', device: null, requirements: ['保留导航状态'],
    nodes: [{taskId: 1, cardIds: ['shop'], requirements: ['保存商品选择']}, {taskId: 2, cardIds: ['car'], requirements: []}]};
  const save = () => writeFile(join(root, '.dag/ux.json'), JSON.stringify(config));
  await writeFile(join(root, 'cards.json'), JSON.stringify({version: '1', cards: [{id: 'shop', intent: '商品重复布局'}, {id: 'car', intent: '车型浏览'}]}));
  await save();
  return {root, config, save, tasks: [{id: 1}, {id: 2}]};
}

test('每个节点只显式注入分配的完整卡片，冻结摘要且缺设备不推定通过', async t => {
  const f = await fixture(t), ux = await loadUx(f.root, f.tasks);
  await writeFile(join(f.root, 'cards.json'), '{}');
  const task = {id: 1, title: '商城', dependencies: [], testStrategy: '构建', worktree: f.root, ux: nodeUx(ux, 1)};
  const input = taskInput(task);
  assert.match(input, /商品重复布局/); assert.doesNotMatch(input, /车型浏览/);
  assert.match(input, /保留导航状态/); assert.match(input, /保存商品选择/);
  assert.match(input, /no-device/); assert.equal(task.ux.acceptance, 'unverified');
  assert.match(task.ux.cardsDigest, /^[a-f0-9]{64}$/);
});

test('无设备分支允许依赖任务完成，单独生成部分交付报告', async t => {
  const f = await fixture(t), ux = await loadUx(f.root, f.tasks), run = new DagRun();
  Object.assign(run, {dir: f.root, config: {maxConcurrency: 2}, controller: new AbortController(),
    state: {id: 'test-run', status: 'running', syncedCommit: 'final-code', ux: {acceptance: 'unverified', reason: 'no-device'},
      tasks: f.tasks.map((task, i) => ({...task, dependencies: i ? [1] : [], status: 'pending', ux: nodeUx(ux, task.id)}))},
    async initializeIntegration() {}, async save() {}, async release() {}, async runTask(task) {task.status = 'done';}});
  await run.execute();
  const report = JSON.parse(await readFile(join(f.root, 'ux-report.json'), 'utf8'));
  assert.equal(run.state.status, 'done'); assert.equal(report.delivery, 'partial');
  assert.equal(report.acceptance, 'unverified'); assert.ok(report.tasks.every(task => task.execution === 'done' && task.reason === 'no-device'));
});

test('清单缺节点、错卡片、重复分配、未知字段和越界路径均拒绝', async t => {
  const f = await fixture(t), valid = structuredClone(f.config);
  for (const mutate of [c => c.nodes.pop(), c => c.nodes[0].cardIds = ['missing'],
    c => c.nodes.push(c.nodes[0]), c => c.version = 2, c => c.cardsFile = '../outside.json', c => c.surprise = true]) {
    Object.assign(f.config, structuredClone(valid));
    delete f.config.surprise; mutate(f.config); await f.save();
    await assert.rejects(loadUx(f.root, f.tasks));
  }
});

test('报告写入失败时不显示完成，保存错误并释放运行锁', async t => {
  const f = await fixture(t), ux = await loadUx(f.root, f.tasks), run = new DagRun();
  Object.assign(run, {dir: join(f.root, 'missing'), config: {maxConcurrency: 1}, controller: new AbortController(),
    state: {status: 'running', ux: {acceptance: 'unverified', reason: 'no-device'},
      tasks: f.tasks.map(task => ({...task, dependencies: [], status: 'done', ux: nodeUx(ux, task.id)}))},
    async initializeIntegration() {}, async save() {}, async release() {this.released = true;}});
  await run.execute();
  assert.equal(run.state.status, 'failed'); assert.equal(run.released, true);
  assert.match(run.state.ux.reportError, /ENOENT/);
});

test('提供设备标识仍不能代替设备验收；未启用 UX 的 DAG 不注入资产', async t => {
  const f = await fixture(t); f.config.device = 'test-emulator'; await f.save();
  const node = nodeUx(await loadUx(f.root, f.tasks), 1);
  assert.equal(node.acceptance, 'unverified'); assert.equal(node.reason, 'device-evidence-not-reviewed');
  await rm(join(f.root, '.dag/ux.json'));
  assert.equal(await loadUx(f.root, f.tasks), undefined);
});
