import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, rm, writeFile, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pagesBrief, parseDagPagesArgs} from '../src/dag-pages.js';
import plugin from '../src/plugin.js';

const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8'}).trim();
const page = (name, source, extra = {}) => ({name, uri: `shop://test/${name}`, source, signature: [name], status: 'verified', ...extra});

async function fixture(t, {capture = true} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dag-pages-test-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(join(root, 'a.txt'), 'a');
  git(root, 'init', '-q'); git(root, 'add', 'a.txt'); git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'entry');
  const commit = git(root, 'rev-parse', 'HEAD');
  await mkdir(join(root, '.dag/captures/wide'), {recursive: true});
  await writeFile(join(root, '.dag/pages.json'), JSON.stringify({version: 1, bundle: 'com.example.app', ability: 'EntryAbility', scheme: 'shop', commit, pages: [
    page('Mall', 'features/mall/Mall.ets'), page('Detail', 'features/mall/Detail.ets'),
    page('Detail.Sheet', 'features/mall/Detail.ets', {steps: [{click: {text: '加入购物车'}}], note: '需冷启动'}),
    page('Splash', 'entry/Splash.ets'), {name: 'Gone', uri: null, source: 'entry/Gone.ets', signature: ['x'], status: 'failed', reason: '入口到不了'}]}));
  await writeFile(join(root, '.dag/devices.json'), JSON.stringify({version: 1, devices: [{config: 'phone', device: 'p1'}, {config: 'wide', device: 'w1'}]}));
  if (capture) await writeFile(join(root, '.dag/captures/wide/summary.json'), JSON.stringify({device: 'w1', display: {width: 2584, height: 1828, density: 2.75},
    results: [{page: 'Mall', status: 'captured'}, {page: 'Splash', status: 'error', error: 'page-not-reached', message: '导出期间页面已离开目标状态'}]}));
  return {root, commit};
}

test('页面名之外的词作为补充要求', () => {
  assert.deepEqual(parseDagPagesArgs(' Mall 只做阔折叠 Detail Mall ', ['Mall', 'Detail']), {pages: ['Mall', 'Detail'], extra: '只做阔折叠'});
  assert.deepEqual(parseDagPagesArgs('', ['Mall']), {pages: [], extra: ''});
  assert.deepEqual(parseDagPagesArgs('"Mall Detail"', ['Mall', 'Detail']), {pages: ['Mall', 'Detail'], extra: ''}, '整串被引号包住时仍能认出页面名');
});

test('按源文件分组，标出基准状态、采集失败和到不了的页面', async t => {
  const f = await fixture(t);
  const brief = await pagesBrief({root: f.root});
  assert.deepEqual(brief.groups.map(g => [g.source, g.pages.map(p => p.name)]),
    [['features/mall/Mall.ets', ['Mall']], ['features/mall/Detail.ets', ['Detail', 'Detail.Sheet']], ['entry/Splash.ets', ['Splash']]]);
  assert.deepEqual(brief.unreachable, [{name: 'Gone', reason: '入口到不了'}]);
  assert.match(brief.text, /- phone · p1 · 未知 · 尚未采集，任务里第一次调用 verify_page 时会自动采集/);
  assert.match(brief.text, new RegExp(`- wide · w1 · 2584x1828 密度 2\\.75 · 已采集，目录 ${join(f.root, '.dag/captures/wide')}`));
  assert.match(brief.text, /页面名 Detail\.Sheet（需点击 1 步才出现；需冷启动）/);
  assert.match(brief.text, /wide 上基准采集失败（page-not-reached：导出期间页面已离开目标状态）/);
  assert.match(brief.text, /无法在设备上查看的页面[\s\S]*- Gone：入口到不了/);
  const some = await pagesBrief({root: f.root, input: 'Detail.Sheet 侧边栏不超过 40%'});
  assert.deepEqual(some.groups.map(g => g.pages.map(p => p.name)), [['Detail.Sheet']]);
  assert.equal(some.extra, '侧边栏不超过 40%');
  await assert.rejects(pagesBrief({root: f.root, input: 'Gone'}), /没有可规划的页面/);
});

test('缺页面清单、当前分支不含入口提交时拒绝规划', async t => {
  const f = await fixture(t);
  git(f.root, 'checkout', '-q', '--orphan', 'other'); git(f.root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'unrelated', '--allow-empty');
  await assert.rejects(pagesBrief({root: f.root}), new RegExp(`不包含 /prepare 的入口提交 ${f.commit.slice(0, 8)}`));
  await rm(join(f.root, '.dag/pages.json'));
  await assert.rejects(pagesBrief({root: f.root}), /请先运行 \/prepare/);
});

test('/dag_pages 用规划 agent，把页面材料交给它，并沿用 dag.json 的写入校验', async t => {
  const f = await fixture(t);
  const toasts = [];
  const hooks = await plugin({client: {tui: {showToast: async ({body}) => toasts.push(body)}}, directory: f.root, worktree: f.root});
  t.after(() => hooks.dispose());
  const config = {}; await hooks.config(config);
  assert.equal(config.command.dag_pages.agent, 'dag-planner');
  const output = {parts: [{type: 'text', text: 'raw'}, {type: 'file', url: 'x'}]};
  await hooks['command.execute.before']({command: 'dag_pages', arguments: 'Mall 只做阔折叠', sessionID: 's1'}, output);
  assert.deepEqual(output.parts.map(p => p.type), ['text', 'file', 'text']);
  assert.equal(output.parts[0].text, '/dag_pages Mall 只做阔折叠');
  const prompt = output.parts[2].text;
  assert.ok(output.parts[2].synthetic);
  assert.match(prompt, /补充要求（可为空）：只做阔折叠/);
  assert.match(prompt, /1\. features\/mall\/Mall\.ets\n {3}- 页面名 Mall/);
  assert.ok(!prompt.includes('Detail.Sheet') && !/\{\{\w+\}\}/.test(prompt));
  assert.match(prompt, new RegExp(`唯一允许写入的文件：${join(f.root, '.dag/dag.json')}`));
  // The session is now a planning session: anything but the validated write of dag.json is refused.
  await assert.rejects(hooks['tool.execute.before']({tool: 'bash', sessionID: 's1', callID: 'c1'}, {args: {command: 'ls'}}), /仅允许只读探索/);
  await assert.rejects(hooks['tool.execute.before']({tool: 'write', sessionID: 's1', callID: 'c2'}, {args: {filePath: join(f.root, '.dag/dag.json'), content: '{"tasks":[]}'}}), /DAG 校验失败/);
  await rm(join(f.root, '.dag/pages.json'));
  await assert.rejects(hooks['command.execute.before']({command: 'dag_pages', arguments: '', sessionID: 's2'}, {parts: []}), /请先运行 \/prepare/);
  // The TUI shows nothing for a thrown hook error, so the reason must also arrive as a toast.
  assert.deepEqual(toasts.map(b => [b.variant, b.message]), [['error', '找不到 .dag/pages.json，请先运行 /prepare']]);
});
