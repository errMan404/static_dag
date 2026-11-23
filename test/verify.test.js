import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, rm, writeFile, readFile, access, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {withLock} from '../src/device-lock.js';
import {verifyPages, formatVerify, loadDevices, captureResult, builtPackages, hostExec} from '../src/verify.js';
import {reviewPages, formatReview, verdictOf} from '../src/review.js';
import {guardWorker, registry} from '../src/dag_run/index.js';
import plugin from '../src/plugin.js';

const BUNDLE = 'com.example.app';
const screen = text => ({attributes: {}, children: [{attributes: {bundleName: BUNDLE, type: 'root', bounds: '[0,0][1000,2000]'},
  children: [{attributes: {type: 'Text', text: 'home', bounds: '[0,0][100,50]'}, children: []}, {attributes: {type: 'Text', text, bounds: '[0,60][100,110]'}, children: []}]}]});
const DISPLAY = 'Density:                      2\nBounds<L,T,W,H>:              0, 0, 1000, 2000, \n';
const sleep = ms => new Promise(done => setTimeout(done, ms));
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8'}).trim();

// A main checkout with one linked worktree. "Installing" a directory makes the fake devices show that
// directory's ui.txt, so a capture reflects whichever package was installed last on that device.
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'dag-verify-test-')));
  t.after(() => rm(base, {recursive: true, force: true}));
  const main = join(base, 'main'), task = join(base, 'task');
  await mkdir(join(main, '.dag'), {recursive: true});
  await writeFile(join(main, 'ui.txt'), 'old');
  await writeFile(join(main, '.gitignore'), 'build/\n');   // as in a real project: build output is never tracked
  git(main, 'init', '-q'); git(main, 'add', 'ui.txt', '.gitignore'); git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  git(main, 'worktree', 'add', '-q', '-b', 'task', task);
  await writeFile(join(main, '.dag/pages.json'), JSON.stringify({version: 1, bundle: BUNDLE, ability: 'EntryAbility', scheme: 'shop', commit: 'a'.repeat(40),
    pages: [{name: 'home', uri: 'shop://test/home', signature: ['home'], status: 'verified'}]}));
  await writeFile(join(main, '.dag/devices.json'), JSON.stringify({version: 1, devices: [{config: 'phone', device: 'p1'}, {config: 'wide', device: 'w1'}]}));
  const installed = {}, events = [], remote = new Map();
  const exec = async (command, args, options) => {
    if (command === 'git') return hostExec(command, args, options);
    events.push([command, ...args, options.cwd].join(' '));
    const out = join(options.cwd, 'entry/build/default/outputs/default');
    if (args[0] === 'build') { await sleep(5); await mkdir(out, {recursive: true}); await writeFile(join(out, 'entry-default-unsigned.hap'), ''); return 'BUILD SUCCESSFUL'; }
    if (args.slice(0, 3).join(' ') === 'device app install') { installed[args[4]] = await readFile(join(options.cwd, 'ui.txt'), 'utf8'); return 'ok'; }
    throw new Error(`unexpected ${command}`);
  };
  const connect = async serial => ({serial,
    async shell(command) {
      if (command.startsWith('hidumper')) return DISPLAY;
      if (command.startsWith('aa start')) return 'start ability successfully.';
      const dump = command.match(/^uitest dumpLayout .*-p (\S+)$/);
      if (dump) { remote.set(serial + dump[1], JSON.stringify(screen(installed[serial]))); return `DumpLayout saved to:${dump[1]}`; }
      if (command.startsWith('uitest screenCap')) remote.set(serial + command.split(' ').at(-1), 'png');
      return 'ok';
    },
    async pull(from, to) { await writeFile(to, remote.get(serial + from)); }});
  const verify = (codeDir, extra = {}) => verifyPages({codeDir, pages: ['home'], exec, connect, lock: {pollMs: 2}, ...extra});
  return {main, task, events, verify, exec, connect};
}

test('设备锁：同一设备串行，持有者进程消失或超时后可接管', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dag-lock-test-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const order = [];
  const job = name => withLock(dir, '127.0.0.1:5557', async () => { order.push(`${name}+`); await sleep(15); order.push(`${name}-`); return name; }, {pollMs: 2});
  assert.deepEqual(await Promise.all([job('a'), job('b'), job('c')]), ['a', 'b', 'c']);
  assert.equal(order.join(' ').match(/(\w)\+ \1-/g).length, 3, '没有交叠');
  await assert.rejects(withLock(dir, 'x', () => { throw new Error('boom'); }), /boom/);
  assert.equal(await withLock(dir, 'x', () => 'free'), 'free', '出错后锁已释放');
  const held = join(dir, 'dead'); await mkdir(held);
  await writeFile(join(held, 'owner.json'), JSON.stringify({pid: 2 ** 22 + 12345, at: Date.now(), holder: 'gone'}));
  assert.equal(await withLock(dir, 'dead', () => 'taken', {pollMs: 2}), 'taken');
  await mkdir(held); await writeFile(join(held, 'owner.json'), JSON.stringify({pid: process.pid, at: Date.now() - 5000}));
  assert.equal(await withLock(dir, 'dead', () => 'stale', {pollMs: 2, staleMs: 1000}), 'stale');
  await mkdir(held); await writeFile(join(held, 'owner.json'), JSON.stringify({pid: process.pid, at: Date.now(), holder: 'task-3'}));
  await assert.rejects(withLock(dir, 'dead', () => 1, {pollMs: 2, waitMs: 20}), /仍被占用（持有者：task-3）/);
});

test('收尾检查：编译主工作目录，全部页面截到 .dag/result，只把适配前能打开、现在打不开的页面算作问题', async t => {
  const f = await fixture(t);
  await mkdir(join(f.main, '.dag/captures/phone'), {recursive: true});
  await writeFile(join(f.main, '.dag/captures/phone/summary.json'), JSON.stringify({device: 'p1', results: [{page: 'home', status: 'captured'}]}));
  const ok = await captureResult({mainRoot: f.main, exec: f.exec, connect: f.connect, lock: {pollMs: 2}});
  assert.deepEqual(ok.devices.map(d => [d.config, d.captured, d.lost, d.unseen]), [['phone', 1, [], []], ['wide', 1, [], []]]);
  await access(join(f.main, '.dag/result/wide/home/screen.png'));
  assert.equal(f.events.filter(e => e.startsWith('devecocli build')).length, 1, '只编译一次');
  // The page no longer shows its signature: lost on the device that had it before, merely unseen on the other.
  const broken = await captureResult({mainRoot: f.main, exec: f.exec, lock: {pollMs: 2}, connect: async serial => {
    const device = await f.connect(serial);
    return {...device, shell: async command => { const dump = command.match(/^uitest dumpLayout .*-p (\S+)$/); if (!dump) return device.shell(command);
      await device.shell(command); return `DumpLayout saved to:${dump[1]}`; }, pull: async (from, to) => writeFile(to, from.endsWith('.json') ? JSON.stringify({attributes: {}, children: []}) : 'png')};
  }});
  assert.deepEqual(broken.devices.map(d => [d.config, d.captured, d.lost.map(p => p.page), d.unseen]), [['phone', 0, ['home'], []], ['wide', 0, [], ['home']]]);
});

test('安装包取自各模块的编译产物：有签名包时不用未签名包，共享库排在应用之前', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dag-packages-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const out = module => join(root, module, 'build/default/outputs/default');
  for (const [module, files] of [['entry', ['entry-default-unsigned.hap', 'entry-default-signed.hap', 'pack.info']], ['features/lib', ['lib-default-unsigned.hsp']], ['oh_modules/x', ['x.hap']]]) {
    await mkdir(out(module), {recursive: true});
    for (const file of files) await writeFile(join(out(module), file), '');
  }
  assert.deepEqual(await builtPackages(root), [join(out('features/lib'), 'lib-default-unsigned.hsp'), join(out('entry'), 'entry-default-signed.hap')]);
  assert.deepEqual(await builtPackages(join(root, 'features')), [join(out('features/lib'), 'lib-default-unsigned.hsp')]);
});

test('首次验证自动采集基准，结果存到任务自己的目录并与基准对比', async t => {
  const f = await fixture(t);
  await writeFile(join(f.task, 'ui.txt'), 'new');
  const report = await f.verify(f.task);
  assert.deepEqual(report.baselineCaptured, ['phone', 'wide']);
  assert.equal(report.mainRoot, f.main);
  assert.match(report.commit, /\+uncommitted$/);
  // Baseline: one build of the main checkout, one install per device, captured from the main checkout's code.
  // Devices are served at the same time: the build comes first, the installs in either order.
  const ordered = events => [events[0], ...events.slice(1).sort()];
  assert.deepEqual(ordered(f.events.slice(0, 3)), [`devecocli build ${f.main}`, `devecocli device app install --device p1 --replace ${f.main}/entry/build/default/outputs/default/entry-default-unsigned.hap ${f.main}`, `devecocli device app install --device w1 --replace ${f.main}/entry/build/default/outputs/default/entry-default-unsigned.hap ${f.main}`]);
  assert.deepEqual(ordered(f.events.slice(3)), [`devecocli build ${f.task}`, `devecocli device app install --device p1 --replace ${f.task}/entry/build/default/outputs/default/entry-default-unsigned.hap ${f.task}`, `devecocli device app install --device w1 --replace ${f.task}/entry/build/default/outputs/default/entry-default-unsigned.hap ${f.task}`]);
  const baseline = JSON.parse(await readFile(join(f.main, '.dag/captures/wide/home/meta.json'), 'utf8'));
  assert.equal(baseline.sourceCommit, git(f.main, 'rev-parse', 'HEAD'));
  for (const d of report.devices) {
    const [r] = d.results;
    assert.equal(r.dir, join(f.task, '.dag/verify', d.config, 'home'));
    assert.equal(r.baselineDir, join(f.task, '.dag/verify/baseline', d.config, 'home'));
    assert.deepEqual(r.compare, {same: false, baselineNodes: 3, nodes: 3});
    assert.match(await readFile(join(r.dir, 'dump.a.json'), 'utf8'), /"new"/);
    assert.match(await readFile(join(r.baselineDir, 'dump.a.json'), 'utf8'), /"old"/);
    await access(join(r.dir, 'screen.png'));
  }
  assert.equal(git(f.task, 'status', '--porcelain', '--untracked-files=all'), 'M ui.txt', '采集结果不出现在 git status 里');
  const text = formatVerify(report);
  assert.match(text, /改动前的截图此前不存在，已从主工作目录采集：phone、wide/);
  assert.match(text, /phone · 设备 p1 · 1000x2000 · 参照设备[\s\S]*与改动前逐元素对比：不一致/);
  assert.match(text, /wide · 设备 w1 · 1000x2000 · 目标设备/);
  assert.equal(text.match(/逐元素对比/g).length, 1, '只对参照设备给出对比结论');
  assert.ok(text.includes(join(f.task, '.dag/verify/wide/home/screen.png')) && text.includes(join(f.task, '.dag/verify/baseline/wide/home/screen.png')));
  assert.ok(!/dump|组件树/.test(text), '返回给 agent 的内容只面向截图');

  // Second call: the baseline is reused, and an unchanged page compares as identical.
  f.events.length = 0;
  await writeFile(join(f.task, 'ui.txt'), 'old');
  const again = await f.verify(f.task);
  assert.deepEqual(again.baselineCaptured, []);
  assert.ok(!f.events.some(e => e.endsWith(f.main)), '不再编译或安装主工作目录');
  assert.ok(again.devices.every(d => d.results[0].compare.same));
  assert.match(formatVerify(again), /与改动前逐元素对比：完全一致/);
  await assert.rejects(f.verify(f.task, {pages: ['nope']}), /页面清单里没有：nope/);
  await assert.rejects(f.verify(f.task, {pages: []}), /至少一个页面名/);
});

test('评审只拿到截图，按页计数并在上限后停止', async t => {
  const f = await fixture(t);
  await writeFile(join(f.main, '.dag/review-notes.md'), '面板靠左显示\n');
  await writeFile(join(f.task, 'ui.txt'), 'new');
  const asked = [];
  const answers = ['结论：需修改\n1. 位置：顶部轮播图\n问题：两侧大片空白', '没有按格式回答', '结论：需修改\n仍有空白'];
  const review = (extra = {}) => reviewPages({codeDir: f.task, pages: ['home'], ask: async request => { asked.push(request); return answers[asked.length - 1]; },
    verify: options => f.verify(options.codeDir, {pages: options.pages}), ...extra});
  assert.equal(verdictOf('结论：通过'), 'pass'); assert.equal(verdictOf('结论: 需修改'), 'revise'); assert.equal(verdictOf('看起来不错'), 'revise');

  const first = await review();
  assert.deepEqual(first.results.map(r => [r.page, r.verdict, r.rounds, r.referenceChanged]), [['home', 'revise', 1, true]]);
  // One request per target device; the reference device is shown for context but never reviewed on its own.
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].images.map(i => [i.label, i.path]), [
    ['改动前 · wide 1000x2000', join(f.task, '.dag/verify/baseline/wide/home/screen.png')],
    ['改动后 · wide 1000x2000', join(f.task, '.dag/verify/wide/home/screen.png')],
    ['同一页面在手机上 · phone 1000x2000', join(f.task, '.dag/verify/phone/home/screen.png')]]);
  assert.equal(asked[0].notes, '面板靠左显示');
  const text = formatReview(first);
  assert.match(text, /## home：需要修改（第 1\/3 次评审）[\s\S]*顶部轮播图[\s\S]*再次调用 review_page/);
  assert.match(text, /参照设备上与改动前不一致/);

  assert.equal(asked[0].earlier.length, 0);
  assert.equal((await review()).results[0].verdict, 'revise', '答非所问按需修改处理');
  // From the second round on the reviewer is told what it said before and shown what it looked at then.
  assert.deepEqual(asked[1].earlier, [{round: 1, verdict: 'revise', text: answers[0]}]);
  assert.deepEqual(asked[1].images.map(i => i.label), ['改动前 · wide 1000x2000', '上一轮评审时 · wide 1000x2000', '改动后 · wide 1000x2000', '同一页面在手机上 · phone 1000x2000']);
  assert.equal(asked[1].images[1].path, join(f.task, '.dag/verify/rounds/home/wide/1.png'));
  const third = await review();
  assert.deepEqual([third.results[0].verdict, third.results[0].rounds], ['revise', 3]);
  assert.deepEqual(asked[2].earlier.map(r => [r.round, r.text]), [[1, answers[0]], [2, answers[1]]]);
  assert.match(formatReview(third), /这是最后一次评审[\s\S]*写进交付摘要/);
  // The fourth request is refused without capturing or asking again.
  f.events.length = 0;
  const fourth = await review();
  assert.deepEqual(fourth.results, [{page: 'home', verdict: 'limit', rounds: 3}]);
  assert.equal(asked.length, 3); assert.equal(f.events.length, 0);
  assert.match(formatReview(fourth), /已评审 3 次，达到上限[\s\S]*写进交付摘要/);
  assert.equal(git(f.task, 'status', '--porcelain', '--untracked-files=all'), 'M ui.txt', '评审记录不出现在 git status 里');
  await assert.rejects(reviewPages({codeDir: f.task, pages: [], ask: async () => ''}), /至少一个页面名/);
});

test('评审通过后代码没变就不再重评，改过代码才重新评审', async t => {
  const f = await fixture(t);
  await writeFile(join(f.task, 'ui.txt'), 'new');
  const answers = ['结论：通过\n宽度利用充分。', '结论：需修改\n新的改动把按钮挤出了屏幕'];
  let asked = 0;
  const review = () => reviewPages({codeDir: f.task, pages: ['home'], ask: async () => answers[asked++], verify: options => f.verify(options.codeDir, {pages: options.pages})});
  const first = await review();
  assert.deepEqual([first.results[0].verdict, first.results[0].rounds], ['pass', 1]);
  assert.match(formatReview(first), /评审通过（第 1\/3 次评审）[\s\S]*没有再改动它的代码就不要重复评审/);
  // Same code: the pass stands. Nothing is built, captured or asked, and no round is spent.
  f.events.length = 0;
  const again = await review();
  assert.deepEqual(again.results, [{page: 'home', verdict: 'settled', rounds: 1}]);
  assert.equal(asked, 1); assert.equal(f.events.length, 0);
  assert.match(formatReview(again), /## home：已通过评审[\s\S]*不需要重新评审，可以提交/);
  // The code changed after the pass, so the page is reviewed again and may now fail.
  await writeFile(join(f.task, 'ui.txt'), 'newer');
  const changed = await review();
  assert.deepEqual([changed.results[0].verdict, changed.results[0].rounds], ['revise', 2]);
});

test('多个任务同时验证时，同一台设备上的安装和采集不交叠', async t => {
  const f = await fixture(t);
  const second = join(f.main, '..', 'task2');
  git(f.main, 'worktree', 'add', '-q', '-b', 'task2', second);
  await f.verify(f.main); // baseline first, so the two tasks below only contend for the devices
  await writeFile(join(f.task, 'ui.txt'), 'one'); await writeFile(join(second, 'ui.txt'), 'two');
  const [a, b] = await Promise.all([f.verify(f.task), f.verify(second)]);
  // Had the two overlapped, one task would have captured the other's package.
  for (const d of a.devices) assert.match(await readFile(join(d.results[0].dir, 'dump.a.json'), 'utf8'), /"one"/);
  for (const d of b.devices) assert.match(await readFile(join(d.results[0].dir, 'dump.a.json'), 'utf8'), /"two"/);
});

test('主工作目录有未提交修改时不采基准；编译失败时给出输出', async t => {
  const f = await fixture(t);
  await writeFile(join(f.main, 'ui.txt'), 'dirty');
  await assert.rejects(f.verify(f.task), /未提交的修改，无法把它当作改动前的基准/);
  git(f.main, 'checkout', '-q', 'ui.txt');
  const failing = async (command, args, options) => {
    if (command === 'git') return hostExec(command, args, options);
    throw Object.assign(new Error('exit 1'), {stdout: 'ERROR: ArkTS:ERROR File: Index.ets:12'});
  };
  await assert.rejects(f.verify(f.task, {exec: failing}), /编译失败：[\s\S]*Index\.ets:12/);
});

test('设备列表：缺省时取已有采集的设备，都没有时给出示例', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dag-devices-test-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await assert.rejects(loadDevices(root, {detect: async () => []}), /没有已连接的设备[\s\S]*"config": "phone"/);
  await assert.rejects(loadDevices(root, {detect: async () => { throw new Error('no hdc'); }}), /没有已连接的设备/);
  const screen = (width, height) => ({display: {width, height, density: 3}});
  const found = [{serial: 'p1', ...screen(1320, 2232)}, {serial: 'w1', ...screen(2584, 1828)}, {serial: 'w2', ...screen(2584, 1828)}];
  const detected = [{config: '1320x2232', device: 'p1'}, {config: '2584x1828', device: 'w1'}, {config: '2584x1828-2', device: 'w2'}];
  assert.deepEqual(await loadDevices(root, {detect: async () => found}), detected);
  assert.deepEqual(await loadDevices(root, {detect: async () => []}), detected, '识别结果已记入 devices.json，之后沿用');
  await rm(join(root, '.dag/devices.json'));
  await mkdir(join(root, '.dag/captures/wide-open'), {recursive: true});
  await writeFile(join(root, '.dag/captures/wide-open/summary.json'), JSON.stringify({device: '127.0.0.1:5557'}));
  assert.deepEqual(await loadDevices(root), [{config: 'wide-open', device: '127.0.0.1:5557'}]);
  await writeFile(join(root, '.dag/devices.json'), JSON.stringify({version: 1, devices: [{config: 'a', device: 'x'}, {config: 'a', device: 'y'}]}));
  await assert.rejects(loadDevices(root), /config 不能重复/);
});

test('任务会话不能直接操作设备；插件注册 verify_page', async t => {
  const worktree = join(tmpdir(), 'dag-guard-device'), task = {id: 1, worktree, status: 'running'};
  registry.workers.set('device-guard', {task, run: {root: join(tmpdir(), 'dag-guard-main'), state: {tasks: [task]}}});
  try {
    for (const command of ['hdc -t 127.0.0.1:5557 shell uitest dumpLayout', 'cd entry && devecocli run --skip-build', 'devecocli device app install --device x a.hap', '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc list targets', 'echo ok; aa start -U x'])
      assert.throws(() => guardWorker('device-guard', 'bash', {command}), /verify_page/, command);
    for (const tool of ['verify_ui', 'save_ui_screenshot', 'capture_pages']) assert.throws(() => guardWorker('device-guard', tool, {device: '127.0.0.1:5557'}), /不能使用.*verify_page/, tool);
    assert.doesNotThrow(() => guardWorker('device-guard', 'verify_page', {input: 'home'}));
    for (const command of ['devecocli build', 'git status', 'grep -r hdcDevice src', 'cat docs/uitest-notes.md'])
      assert.doesNotThrow(() => guardWorker('device-guard', 'bash', {command}), command);
  } finally { registry.workers.delete('device-guard'); }
  const root = await mkdtemp(join(tmpdir(), 'dag-verify-plugin-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const hooks = await plugin({client: {}, directory: root, worktree: root});
  t.after(() => hooks.dispose());
  await assert.rejects(hooks.tool.verify_page.execute({input: ''}, {directory: root}), /至少一个页面名/);
  await assert.rejects(hooks.tool.verify_page.execute({input: 'home'}, {directory: root}), /请先运行 \/prepare/);
  await assert.rejects(hooks.tool.review_page.execute({input: 'home'}, {directory: root}), /请先运行 \/prepare/);
  const config = {}; await hooks.config(config);
  assert.deepEqual(config.agent['dag-reviewer'].permission, {'*': 'deny'});
  assert.match(config.agent['dag-reviewer'].prompt, /结论：通过\n结论：需修改/);
});
