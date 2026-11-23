import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile, readFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {capturePages, formatCapture, parseCaptureArgs, parseDisplay, inspect, clickTargets, missingSignatures, grantPermissions, layoutText} from '../src/capture.js';
import plugin from '../src/plugin.js';

const BUNDLE = 'com.example.app';
const node = (type, text, bounds = '[0,0][100,50]', id = '') => ({attributes: {type, text, bounds, id}, children: []});
const screen = (...nodes) => ({attributes: {}, children: [{attributes: {bundleName: BUNDLE, type: 'root', bounds: '[0,0][1000,2000]'}, children: nodes}]});
const dialog = text => ({attributes: {}, children: [{attributes: {bundleName: 'com.ohos.sceneboard', type: 'WindowScene'}, children: [node('Text', text)]}]});
const DISPLAY = 'DisplayFoldStatus:            EXPAND\nDensity:                      2.75\nBounds<L,T,W,H>:              0, 0, 2584, 1828, \n';
const page = (name, extra = {}) => ({name, uri: `shop://test/${name}`, signature: [name], status: 'verified', ...extra});

// A scripted device: `screens[uri]` is the layout shown after that URI opens; `afterClick` replaces it on click.
async function fixture(t, pages, {screens = {}, afterClick = {}, startOutput = () => 'start ability successfully.'} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dag-capture-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, '.dag'));
  await writeFile(join(root, '.dag/pages.json'), JSON.stringify({version: 1, bundle: BUNDLE, ability: 'EntryAbility', scheme: 'shop', commit: 'a'.repeat(40), pages}));
  const calls = [], remote = new Map();
  let uri = null, current = null;
  const connect = async serial => ({serial: serial ?? 'dev-1',
    async shell(command) {
      calls.push(command);
      if (command.startsWith('hidumper')) return DISPLAY;
      if (command.startsWith('aa force-stop')) { current = null; return 'ok'; }
      const start = command.match(/^aa start -U '(.+)'$/);
      if (start) { const output = startOutput(start[1]); if (/successfully/.test(output)) { uri = start[1]; current = screens[uri] ?? null; } return output; }
      const click = command.match(/^uitest uiInput click (\d+) (\d+)$/);
      if (click) { current = afterClick[uri] ?? current; return 'No Error'; }
      const dump = command.match(/^uitest dumpLayout .*-p (\S+)$/);
      if (dump) { remote.set(dump[1], JSON.stringify(current ?? dialog(''))); return `DumpLayout saved to:${dump[1]}`; }
      if (command.startsWith('pidof')) return current ? '4321\n' : '';
      if (command === 'hilog -x -t app -P 4321') return `11-22 18:58:30.802  4321  4321 I A03D00/${BUNDLE}/JSAPP: opened ${uri}\n`;
      if (command.startsWith('uitest screenCap')) { remote.set(command.split(' ').at(-1), 'png'); return 'ScreenCap saved'; }
      return '';
    },
    async pull(from, to) { await writeFile(to, remote.get(from)); }});
  const capture = (options = {}) => capturePages({root, connect, timeoutMs: 30, pollMs: 1, ...options});
  return {root, calls, capture};
}


test('采集前把应用声明的权限都授予，避免系统授权弹窗挡住页面；授不了时不影响采集', async () => {
  const sent = [];
  const dev = {async shell(command) { sent.push(command);
    if (command.startsWith('bm dump')) return '{"accessTokenId": 537411066, "reqPermissions": ["ohos.permission.LOCATION", "ohos.permission.INTERNET"], "x": {"name": "ohos.permission.LOCATION"}}';
    return command.endsWith('LOCATION') ? 'Success' : 'Failure'; }};
  assert.deepEqual(await grantPermissions(dev, 'com.example.app'), ['ohos.permission.LOCATION']);
  assert.deepEqual(sent, ['bm dump -n com.example.app', 'atm perm -g -i 537411066 -p ohos.permission.LOCATION', 'atm perm -g -i 537411066 -p ohos.permission.INTERNET']);
  assert.deepEqual(await grantPermissions({async shell() { throw new Error('no atm'); }}, 'x'), []);
  assert.deepEqual(await grantPermissions({async shell() { return 'error: failed to get information'; }}, 'x'), []);
});

test('解析参数、屏幕信息和节点匹配', () => {
  assert.deepEqual(parseCaptureArgs(' device=127.0.0.1:5557  config=wide-open A B.Sheet '), {device: '127.0.0.1:5557', config: 'wide-open', pages: ['A', 'B.Sheet']});
  assert.deepEqual(parseCaptureArgs(''), {pages: []});
  assert.throws(() => parseCaptureArgs('config=../x'), /config/);
  assert.deepEqual(parseDisplay(DISPLAY), {density: 2.75, width: 2584, height: 1828, foldStatus: 'EXPAND'});
  assert.throws(() => parseDisplay('nothing'), /密度/);
  const {nodes, present} = inspect(screen(node('Text', '2s跳过'), node('Button', '确定', '[0,0][0,0]'), node('Button', '确定'), node('Stack', '', '[0,0][9,9]', 'map')), BUNDLE);
  assert.equal(present, true);
  assert.deepEqual(missingSignatures(nodes, ['跳过', 'map', '没有']), ['没有']);
  assert.equal(clickTargets(nodes, {text: '确定'}).length, 1, '零面积节点不算');
  assert.equal(inspect(dialog('暂无可用打开方式'), BUNDLE).present, false);
});

test('每页冷启动后导出两份组件树、截图和元数据', async t => {
  const f = await fixture(t, [page('home'), page('detail'), {name: 'gone', uri: null, status: 'failed', reason: '到不了'}],
    {screens: {'shop://test/home': screen(node('Text', 'home')), 'shop://test/detail': screen(node('Text', 'detail'))}});
  const summary = await f.capture({config: 'wide-open', pages: ['home', 'gone']});
  assert.deepEqual(summary.results.map(r => [r.page, r.status]), [['home', 'captured'], ['gone', 'skipped']]);
  const dir = join(f.root, '.dag/captures/wide-open/home');
  for (const file of ['dump.a.json', 'dump.i.json', 'screen.png']) await access(join(dir, file));
  // Two plain-text aids next to the screenshot: where each component is (in vp), and what the app logged.
  assert.match(await readFile(join(dir, 'layout.txt'), 'utf8'), /Text "home" · 左 0 上 0 宽 36 高 18/);
  assert.match(await readFile(join(dir, 'log.txt'), 'utf8'), /JSAPP: opened shop:\/\/test\/home/);
  const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
  assert.equal(meta.display.density, 2.75); assert.equal(meta.stable, true); assert.equal(meta.device, 'dev-1');
  const stop = f.calls.indexOf(`aa force-stop ${BUNDLE}`), start = f.calls.indexOf("aa start -U 'shop://test/home'");
  assert.ok(stop >= 0 && stop < start, '启动前先强制停止');
  assert.ok(f.calls.some(c => c.includes('dumpLayout -a')) && f.calls.some(c => c.includes('dumpLayout -i')));
  assert.match(formatCapture(summary), /成功 1，执行错误 0，跳过 1/);
  await f.capture({config: 'wide-open', pages: ['detail']});
  const merged = JSON.parse(await readFile(join(f.root, '.dag/captures/wide-open/summary.json'), 'utf8'));
  assert.deepEqual(merged.results.map(r => r.page), ['home', 'detail', 'gone'], '只采一页时保留其他页的结果');
  assert.equal(merged.captured, 2);
  assert.equal((await f.capture()).config, '2584x1828', '未指定时用屏幕尺寸作配置名');
  await assert.rejects(f.capture({pages: ['nope']}), /页面清单里没有：nope/);
});

test('按 steps 点击唯一目标的中心点，目标不唯一时报 step-failed', async t => {
  const sheet = page('sheet', {uri: 'shop://test/detail', steps: [{click: {text: '加入购物车'}}], signature: ['选择规格']});
  const base = {'shop://test/detail': screen(node('Text', '加入购物车', '[100,200][300,260]'))};
  const ok = await fixture(t, [sheet], {screens: base, afterClick: {'shop://test/detail': screen(node('Text', '选择规格'))}});
  assert.equal((await ok.capture()).results[0].status, 'captured');
  assert.ok(ok.calls.includes('uitest uiInput click 200 230'));
  const twice = await fixture(t, [sheet], {screens: {'shop://test/detail': screen(node('Text', '加入购物车'), node('Text', '加入购物车'))}});
  const result = (await twice.capture()).results[0];
  assert.equal(result.error, 'step-failed'); assert.match(result.message, /匹配到 2 个/);
  assert.ok(!twice.calls.some(c => c.startsWith('uitest uiInput click')), '不点击不唯一的目标');
});

test('没到达、系统对话框、网址未被接收都报执行错误，并清掉该页的旧采集', async t => {
  const f = await fixture(t, [page('home'), page('blocked'), page('unregistered')], {
    screens: {'shop://test/home': screen(node('Text', '别的页面')), 'shop://test/blocked': dialog('暂无可用打开方式')},
    startOutput: uri => uri.endsWith('unregistered') ? 'error: failed to start ability.\nError Code:10103101  Error Message:Failed to find a matching application' : 'start ability successfully.'});
  const stale = join(f.root, '.dag/captures/c/home');
  await mkdir(stale, {recursive: true}); await writeFile(join(stale, 'dump.a.json'), '{}');
  const summary = await f.capture({config: 'c'});
  assert.deepEqual(summary.results.map(r => r.error), ['page-not-reached', 'system-dialog', 'page-not-reached']);
  assert.match(summary.results[0].message, /识别特征：home/);
  assert.deepEqual(summary.results[0].detail.visibleTexts, ['别的页面']);
  assert.match(summary.results[0].log.at(-1), /JSAPP: opened shop:\/\/test\/home/, '没到达的页面带上应用最后输出的日志');
  assert.match(summary.results[1].message, /暂无可用打开方式/);
  assert.match(summary.results[2].message, /10103101/);
  await assert.rejects(access(stale), /ENOENT/);
  assert.equal(JSON.parse(await readFile(join(f.root, '.dag/captures/c/summary.json'), 'utf8')).errors, 3);
});

test('没有页面清单时提示先运行 /prepare；/capture 注册为只转调工具的命令', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dag-capture-cmd-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await assert.rejects(capturePages({root, connect: async () => { throw new Error('不应连接设备'); }}), /先运行 \/prepare/);
  const hooks = await plugin({client: {}, directory: root, worktree: root});
  t.after(() => hooks.dispose());
  const config = {}; await hooks.config(config);
  assert.ok(config.command.capture.template.includes('capture_pages') && config.command.capture.template.includes('$ARGUMENTS'));
  assert.ok(hooks.tool.capture_pages && hooks.tool.submit_task, '原有工具保留');
  await assert.rejects(hooks.tool.capture_pages.execute({input: ''}, {}), /先运行 \/prepare/);
});

test('组件位置文本：换算成 vp，按嵌套缩进，略去不占面积和只重复上一行外框的组件', () => {
  const tree = screen({attributes: {type: 'Column', bounds: '[0,0][1000,2000]', id: ''}, children: [
    {attributes: {type: 'Row', bounds: '[0,0][1000,2000]', id: ''}, children: [node('Text', '标题', '[20,40][220,100]', 'title'), node('Image', '', '[0,0][0,0]')]}]});
  const text = layoutText(inspect(tree, BUNDLE).nodes, 2);
  assert.deepEqual(text.trim().split('\n').slice(1), ['root · 左 0 上 0 宽 500 高 1000', '      Text #title "标题" · 左 10 上 20 宽 100 高 30']);
  assert.match(layoutText(inspect(screen(...Array.from({length: 5}, (_, i) => node('Text', `t${i}`, `[0,${i}][10,${i + 9}]`))), BUNDLE).nodes, 1, 3), /其余 3 行省略/);
});
