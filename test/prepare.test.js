import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {validatePages, parsePages, summarizePages} from '../src/prepare.js';
import plugin from '../src/plugin.js';

const page = (name, extra = {}) => ({name, uri: `shop://test/${name}`, signature: [name], status: 'verified', ...extra});
const manifest = (pages = [page('home')], extra = {}) => ({version: 1, bundle: 'com.example.app', ability: 'EntryAbility',
  scheme: 'shop', commit: 'a'.repeat(40), pages, ...extra});

test('接受合法清单并按状态汇总', () => {
  const m = validatePages(manifest([page('home'), page('detail', {status: 'unverified', reason: 'no-device'}),
    {name: 'sheet', uri: null, status: 'failed', reason: '只能由页面内状态打开'}]));
  assert.deepEqual(summarizePages(m), {verified: 1, unverified: 1, failed: 1});
});

test('页面内状态打开的界面用同一网址加点击步骤表示', () => {
  const sheet = steps => page('sheet', {uri: 'shop://test/home', steps});
  validatePages(manifest([page('home'), sheet([{click: {text: '加入购物车'}}]), page('filter', {uri: 'shop://test/home', steps: [{click: {id: 'filter', type: 'Button'}}]})]));
  for (const steps of [[], [{}], [{click: {}}], [{click: {text: ''}}], [{click: {xpath: '//a'}}], [{tap: {text: 'a'}}], [{click: {text: 'a'}, wait: 1}], 'click'])
    assert.throws(() => validatePages(manifest([page('home'), sheet(steps)])), /页面清单校验失败/);
  assert.throws(() => validatePages(manifest([page('home'), sheet([{click: {text: 'a'}}]), page('again', {uri: 'shop://test/home', steps: [{click: {text: 'a'}}]})])), /和 again 的网址与到达步骤完全相同.*合并成一条/);
  assert.throws(() => validatePages(manifest([{name: 'x', uri: null, status: 'failed', reason: 'r', steps: [{click: {text: 'a'}}]}])), /不能有 steps/);
});

test('拒绝会让后续阶段出错的清单', () => {
  const bad = [
    manifest([page('a'), page('a')]),
    manifest([page('a'), page('b', {uri: 'shop://test/a'})]),
    manifest([page('a', {uri: 'other://test/a'})]),
    manifest([page('a', {uri: 'shop://test/a b'})]),
    manifest([page('a', {status: 'unverified'})]),
    manifest([page('a', {signature: []})]),
    manifest([page('a', {uri: null})]),
    manifest([page('a', {status: 'passed'})]),
    manifest([]),
    manifest(undefined, {commit: 'abc123'}),
    manifest(undefined, {scheme: 'https'}),
    manifest(undefined, {scheme: 'ohosapp'}),
    manifest(undefined, {version: 2}),
  ];
  for (const m of bad) assert.throws(() => validatePages(m), /页面清单校验失败/);
  assert.throws(() => parsePages('```json'), /合法 JSON/);
});

test('/prepare 注册为使用当前 Agent 的命令，提示词引用 skill 并保留参数占位', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dag-prepare-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const hooks = await plugin({client: {}, directory: root, worktree: root});
  t.after(() => hooks.dispose());
  const config = {}; await hooks.config(config);
  const command = config.command.prepare;
  assert.equal(command.agent, undefined);
  for (const needle of ['ui-verification-with-deeplink', '$ARGUMENTS', '.dag/pages.json', '插件在写入前校验', 'git revert'])
    assert.ok(command.template.includes(needle), needle);
  assert.ok(!command.template.includes('npx'), '项目里的 npx 解析不到本插件，不能靠它校验');

  // The gate: whatever session writes the page list, an invalid one never reaches disk.
  const before = (tool, args) => hooks['tool.execute.before']({tool, sessionID: 'any', callID: 'c'}, {args});
  const entry = (name, extra = {}) => ({name, uri: 'shop://test/station', signature: [name], status: 'verified', ...extra});
  const list = pages => JSON.stringify({version: 1, bundle: 'com.example.app', ability: 'EntryAbility', scheme: 'shop', commit: 'a'.repeat(40), pages});
  const file = join(root, '.dag/pages.json');
  await assert.rejects(before('write', {filePath: file, content: list([entry('Station'), entry('Station.Sheet')])}),
    /页面 Station 和 Station\.Sheet 的网址与到达步骤完全相同/);
  await assert.rejects(before('write', {filePath: '.dag/pages.json', content: 'not json'}), /不是合法 JSON/, '相对路径同样拦截');
  await assert.rejects(before('edit', {filePath: file, oldString: 'a', newString: 'b'}), /只能用 write 提交完整内容/);
  const ok = {filePath: file, content: list([entry('Station'), entry('Station.Sheet', {steps: [{click: {text: '筛选'}}]})])};
  await before('write', ok);
  assert.equal(JSON.parse(ok.content).pages.length, 2);
  await before('write', {filePath: join(root, 'src/other.json'), content: 'not json'});
  // Models given apply_patch have no write tool: an added file goes through the same gate.
  const add = (path, text) => ({patchText: ['*** Begin Patch', `*** Add File: ${path}`, ...text.split('\n').map(l => `+${l}`), '*** End Patch'].join('\n')});
  await assert.rejects(before('apply_patch', add('.dag/pages.json', 'not json')), /不是合法 JSON/);
  await assert.rejects(before('apply_patch', {patchText: '*** Begin Patch\n*** Update File: .dag/pages.json\n@@\n-a\n+b\n*** End Patch'}), /只能整份提交/);
  const patched = add('.dag/pages.json', ok.content);
  patched.patchText = patched.patchText.replace('*** Add File', '*** Add File: src/a.txt\n+hello\n*** Add File');
  await before('apply_patch', patched);
  assert.ok(patched.patchText.startsWith('*** Begin Patch\n*** Add File: src/a.txt\n+hello\n*** Add File: .dag/pages.json\n+{\n+  "version": 1,'), patched.patchText.slice(0, 120));
  assert.ok(patched.patchText.endsWith('+}\n*** End Patch'));
  await before('apply_patch', add('src/other.json', 'not json'));
  await assert.rejects(hooks.config({command: {prepare: {}}}), /已被其他配置占用/);
});

test('deveco-dag pages 校验清单文件并以退出码反映结果', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dag-pages-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url)), file = join(root, 'pages.json');
  const run = () => promisify(execFile)(process.execPath, [cli, 'pages', file]);
  await writeFile(file, JSON.stringify(manifest()));
  assert.match((await run()).stdout, /校验通过/);
  await writeFile(file, JSON.stringify(manifest([page('a', {signature: []})])));
  await assert.rejects(run(), error => error.code === 1 && /signature/.test(error.stderr));
});
