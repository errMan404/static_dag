// Lets a task look at its own change on the devices: build its working directory, then for each device
// queue for it, install, capture the requested pages and release. The agent never holds a device itself.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {access, appendFile, cp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {capturePages, connectedDevices, inspect, safeName} from './capture.js';
import {parsePages} from './prepare.js';
import {withLock} from './device-lock.js';

const json = async file => JSON.parse(await readFile(file, 'utf8'));
const exists = async file => { try { await access(file); return true; } catch { return false; } };
const NAME = /^[\w.-]+$/;

// The only place that runs host commands; tests replace it.
const run = promisify(execFile);
export const hostExec = async (command, args, {cwd}) => (await run(command, args, {cwd, maxBuffer: 64 << 20, timeout: 30 * 60_000})).stdout;

const tail = (error, lines = 25) => [error.stdout, error.stderr, error.message].filter(Boolean).join('\n').trim().split('\n').slice(-lines).join('\n');
async function step(what, work) {
  try { return await work(); } catch (error) { throw new Error(`${what}失败：\n${tail(error)}`); }
}

// A task works in a linked git worktree; the page list, device list, baseline and locks live in the main checkout.
export async function mainCheckout(codeDir, exec = hostExec) {
  try {
    const common = (await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {cwd: codeDir})).trim();
    return {mainRoot: basename(common) === '.git' ? dirname(common) : resolve(codeDir), gitDir: common};
  } catch { return {mainRoot: resolve(codeDir), gitDir: null}; }
}

// .dag/devices.json: {"version": 1, "devices": [{"config": "phone", "device": "127.0.0.1:5555"}, …]}.
// Without it, the devices of the existing captures are used.
export async function loadDevices(mainRoot, {detect = connectedDevices} = {}) {
  const file = join(mainRoot, '.dag/devices.json');
  let devices;
  if (await exists(file)) {
    const input = await json(file);
    if (input.version !== 1 || !Array.isArray(input.devices)) throw new Error('.dag/devices.json 需要 version=1 和 devices 数组');
    devices = input.devices;
  } else {
    devices = [];
    let configs = [];
    try { configs = (await readdir(join(mainRoot, '.dag/captures'), {withFileTypes: true})).filter(e => e.isDirectory()).map(e => e.name); } catch { /* no captures yet */ }
    for (const config of configs.sort()) {
      const summary = join(mainRoot, '.dag/captures', config, 'summary.json');
      if (await exists(summary)) devices.push({config, device: (await json(summary)).device});
    }
    if (!devices.length) {
      // Nothing recorded yet: take every connected device, name each configuration after its screen size, and
      // record the choice so that later stages (baseline folders, locks) keep using the same names.
      let found = [];
      try { found = await detect(); } catch { /* no hdc or no device: fall through to the explanation below */ }
      for (const d of found) {
        const base = `${d.display.width}x${d.display.height}`;
        let config = base;
        for (let n = 2; devices.some(x => x.config === config); n++) config = `${base}-${n}`;
        devices.push({config, device: d.serial});
      }
      if (!devices.length) throw new Error(`不知道要在哪些设备上验证：没有已连接的设备，也没有 ${file}。请连接设备，或创建该文件，例如：\n` +
        '{"version": 1, "devices": [{"config": "phone", "device": "127.0.0.1:5555"}, {"config": "wide-open", "device": "127.0.0.1:5557"}]}');
      await mkdir(dirname(file), {recursive: true});
      await writeFile(file, JSON.stringify({version: 1, devices}, null, 2) + '\n');
    }
  }
  for (const d of devices) if (!d || !NAME.test(d.config ?? '') || typeof d.device !== 'string' || !d.device) throw new Error('设备列表的每一项需要 config（字母、数字、点、下划线、连字符）和 device（序列号）');
  if (new Set(devices.map(d => d.config)).size !== devices.length) throw new Error('设备列表里的 config 不能重复');
  if (new Set(devices.map(d => d.device)).size !== devices.length) throw new Error('设备列表里的 device 不能重复');
  return devices;
}

const build = (dir, exec) => step('编译', () => exec('devecocli', ['build'], {cwd: dir}));

// The packages the last build left behind: every module's build/default/outputs/default/*.hap|hsp, signed ones
// preferred where both exist, shared libraries (hsp) before the apps that need them.
const SKIP = new Set(['oh_modules', 'node_modules', 'build']);
export async function builtPackages(dir, depth = 3) {
  const found = [];
  const visit = async (at, left) => {
    let files = [];
    try { files = (await readdir(join(at, 'build/default/outputs/default'))).filter(name => /\.(hap|hsp)$/.test(name)); } catch { /* not a module */ }
    const signed = files.filter(name => !name.includes('-unsigned.'));
    found.push(...(signed.length ? signed : files).map(name => join(at, 'build/default/outputs/default', name)));
    if (!left) return;
    for (const entry of await readdir(at, {withFileTypes: true}))
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name)) await visit(join(at, entry.name), left - 1);
  };
  await visit(dir, depth);
  return found.sort((a, b) => Number(a.endsWith('.hap')) - Number(b.endsWith('.hap')) || a.localeCompare(b));
}

// Install only. `devecocli run` would also launch the app, which flashes its start page on the device and then
// gets closed again by the capture; the capture opens each page itself.
const install = (dir, serial, exec) => step(`在 ${serial} 上安装`, async () => {
  const files = await builtPackages(dir);
  if (!files.length) throw new Error(`编译后在 ${dir} 下没有找到 .hap 或 .hsp 安装包`);
  return exec('devecocli', ['device', 'app', 'install', '--device', serial, '--replace', ...files], {cwd: dir});
});

// Devices do not depend on each other, so work on all of them at once. Everything is allowed to finish (and
// release its device) before the first failure is reported.
async function eachDevice(devices, work) {
  const settled = await Promise.allSettled(devices.map(work));
  const failed = settled.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return settled.map(result => result.value);
}

// The baseline is every page as it looked before any adaptation: captured once from the main checkout into
// .dag/captures/<config>/, on whichever task asks first. Other tasks wait on the same lock and then reuse it.
export async function ensureBaseline({mainRoot, devices, exec = hostExec, connect, log = () => {}, lock = {}}) {
  const summary = d => join(mainRoot, '.dag/captures', d.config, 'summary.json');
  const missing = async () => { const out = []; for (const d of devices) if (!await exists(summary(d))) out.push(d); return out; };
  if (!(await missing()).length) return [];
  return withLock(join(mainRoot, '.dag/locks'), 'baseline', async () => {
    const need = await missing();
    if (!need.length) return [];
    if ((await exec('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: mainRoot})).trim())
      throw new Error(`主工作目录 ${mainRoot} 有未提交的修改，无法把它当作改动前的基准；请先提交或还原`);
    const commit = (await exec('git', ['rev-parse', 'HEAD'], {cwd: mainRoot})).trim();
    log(`基准缺失（${need.map(d => d.config).join('、')}），从主工作目录 ${commit.slice(0, 8)} 采集`);
    await build(mainRoot, exec);
    await eachDevice(need, d => withLock(join(mainRoot, '.dag/locks'), d.device, async () => {
      await install(mainRoot, d.device, exec);
      const result = await capturePages({root: mainRoot, device: d.device, config: d.config, sourceCommit: commit, connect, log: message => log(`${d.config} · ${message}`)});
      if (!result.captured) throw new Error(`基准采集在 ${d.config} 上没有采到任何页面，请检查入口是否已装到设备上`);
    }, {...lock, holder: 'baseline', log}));
    return need.map(d => d.config);
  }, {...lock, holder: basename(mainRoot), waitMs: 40 * 60_000, staleMs: 40 * 60_000, log});
}

// After every task is merged: build the main checkout once and capture every page on every device into
// .dag/result/<config>/. No model and no comparison of pictures — it answers only "does the merged app build, and
// does every page that could be opened before still open". The screenshots are what the user looks at afterwards.
export async function captureResult({mainRoot, exec = hostExec, connect, detect, log = () => {}, lock = {}}) {
  mainRoot = resolve(mainRoot);
  const devices = await loadDevices(mainRoot, detect && {detect});
  log('编译合并后的代码');
  await build(mainRoot, exec);
  const commit = (await exec('git', ['rev-parse', 'HEAD'], {cwd: mainRoot})).trim();
  const out = await eachDevice(devices, async d => {
    const outDir = join(mainRoot, '.dag/result', d.config);
    await rm(outDir, {recursive: true, force: true});
    const summary = await withLock(join(mainRoot, '.dag/locks'), d.device, async () => {
      log(`${d.config} · 安装`);
      await install(mainRoot, d.device, exec);
      return capturePages({root: mainRoot, outDir, sourceCommit: commit, device: d.device, config: d.config, connect, log: message => log(`${d.config} · ${message}`)});
    }, {...lock, holder: 'result', log});
    let before = [];
    try { before = (await json(join(mainRoot, '.dag/captures', d.config, 'summary.json'))).results ?? []; } catch { /* no baseline for this device */ }
    const missed = summary.results.filter(r => r.status !== 'captured');
    // A page that could not be captured before the adaptation either (it leaves by itself, say) is not a loss.
    const lost = missed.filter(r => before.find(b => b.page === r.page)?.status === 'captured');
    return {config: d.config, dir: outDir, captured: summary.results.length - missed.length, lost: lost.map(r => ({page: r.page, error: r.error ?? '未知'})),
      unseen: missed.filter(r => !lost.includes(r)).map(r => r.page)};
  });
  return {commit, devices: out};
}

const layout = async (dir, bundle) => inspect(await json(join(dir, 'dump.a.json')), bundle).nodes.map(n => `${n.type}|${n.id}|${n.text}|${n.bounds}`);

export async function verifyPages({codeDir, pages, exec = hostExec, connect, detect, log = () => {}, lock = {}}) {
  codeDir = resolve(codeDir);
  if (!pages?.length) throw new Error('需要至少一个页面名');
  const {mainRoot, gitDir} = await mainCheckout(codeDir, exec);
  let manifest;
  try { manifest = parsePages(await readFile(join(mainRoot, '.dag/pages.json'), 'utf8')); }
  catch (error) { throw new Error(error.code === 'ENOENT' ? `找不到 ${join(mainRoot, '.dag/pages.json')}，请先运行 /prepare` : error.message); }
  const unknown = pages.filter(name => !manifest.pages.some(page => page.name === name));
  if (unknown.length) throw new Error(`页面清单里没有：${unknown.join('、')}；可选：${manifest.pages.map(p => p.name).join('、')}`);
  const devices = await loadDevices(mainRoot, detect && {detect});
  const baselineCaptured = await ensureBaseline({mainRoot, devices, exec, connect, log, lock});

  // Captures are written inside the task's own directory; keep them out of `git status` so the task can still submit.
  if (gitDir) {
    // .homegraph/ is an index the DevEco tooling drops into every directory it builds; it would block a submit too.
    const exclude = join(gitDir, 'info/exclude');
    let current = '';
    try { current = await readFile(exclude, 'utf8'); } catch { await mkdir(dirname(exclude), {recursive: true}); }
    for (const line of ['/.dag/verify/', '.homegraph/']) {
      if (current.split(/\r?\n/).includes(line)) continue;
      await appendFile(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
      current += `\n${line}\n`;
    }
  }

  log('编译当前工作目录');
  await build(codeDir, exec);
  let commit = 'unknown';
  try {
    commit = (await exec('git', ['rev-parse', 'HEAD'], {cwd: codeDir})).trim();
    if ((await exec('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: codeDir})).trim()) commit += '+uncommitted';
  } catch { /* not a git checkout */ }

  const out = await eachDevice(devices, async d => {
    const outDir = join(codeDir, '.dag/verify', d.config);
    const summary = await withLock(join(mainRoot, '.dag/locks'), d.device, async () => {
      log(`${d.config} · 安装`);
      await install(codeDir, d.device, exec);
      return capturePages({root: codeDir, manifestRoot: mainRoot, outDir, sourceCommit: commit, device: d.device, config: d.config, pages, connect, log: message => log(`${d.config} · ${message}`)});
    }, {...lock, holder: basename(codeDir), log});

    const results = [];
    for (const result of summary.results) {
      const source = join(mainRoot, '.dag/captures', d.config, safeName(result.page));
      const baselineDir = join(codeDir, '.dag/verify/baseline', d.config, safeName(result.page));
      await rm(baselineDir, {recursive: true, force: true});
      const hasBaseline = await exists(join(source, 'dump.a.json'));
      // Copied next to the new capture: a task may only read inside its own directory.
      if (hasBaseline) await cp(source, baselineDir, {recursive: true});
      const entry = {...result, baselineDir: hasBaseline ? baselineDir : null};
      if (result.status === 'captured' && hasBaseline) {
        const before = await layout(baselineDir, manifest.bundle), now = await layout(result.dir, manifest.bundle);
        entry.compare = {same: before.length === now.length && before.every((line, i) => line === now[i]), baselineNodes: before.length, nodes: now.length};
      }
      results.push(entry);
    }
    return {config: d.config, device: d.device, display: summary.display, results};
  });
  markReference(out, devices);
  return {codeDir, mainRoot, commit, baselineCaptured, devices: out};
}

// The device whose interface must not change: the one marked "reference" in .dag/devices.json, else the narrowest screen.
function markReference(devices, declared) {
  const named = declared.find(d => d.reference)?.config;
  const narrowest = [...devices].sort((x, y) => x.display.width / x.display.density - y.display.width / y.display.density)[0]?.config;
  for (const d of devices) d.reference = d.config === (named ?? narrowest);
}

// The agent judges by the screenshots. Next to each one are two plain-text files for finding the cause when a
// screenshot looks wrong: where every component ended up, and what the app logged. Without them tasks printed
// debug text onto the screen and counted pixels, one build-and-capture round per question.
export function formatVerify(report) {
  const lines = [`已验证 ${report.commit.slice(0, 8)}${report.commit.endsWith('+uncommitted') ? '（含未提交修改）' : ''} · 工作目录 ${report.codeDir}`];
  if (report.baselineCaptured.length) lines.push(`改动前的截图此前不存在，已从主工作目录采集：${report.baselineCaptured.join('、')}`);
  for (const d of report.devices) {
    lines.push('', `${d.config} · 设备 ${d.device} · ${d.display.width}x${d.display.height}${d.reference ? ' · 参照设备（这台设备上的界面应与改动前保持一致）' : ' · 目标设备'}`);
    for (const r of d.results) {
      if (r.status !== 'captured') {
        lines.push(`- ${r.page}：没有截到（${r.error ?? r.status} · ${r.message ?? r.reason ?? ''}）`);
        if (r.log?.length) lines.push('    应用在这期间输出的最后几行日志：', ...r.log.map(line => `      ${line}`));
        // Pages that leave on their own (countdowns, one-time agreements) cannot be captured before the change either.
        if (!r.baselineDir) lines.push('    这一页在改动前同样没有截到，属于无法在设备上查看的页面。不要反复重试：按代码判断并完成修改，在交付摘要里注明“未能在设备上确认”。');
        continue;
      }
      lines.push(`- ${r.page}${r.stable ? '' : '（界面一直在变化，取了最后一帧）'}`);
      lines.push(`    改动后截图：${join(r.dir, 'screen.png')}`);
      if (r.baselineDir) lines.push(`    改动前截图：${join(r.baselineDir, 'screen.png')}`);
      lines.push(`    排查用：组件位置 ${join(r.dir, 'layout.txt')} · 应用日志 ${join(r.dir, 'log.txt')}`);
      if (d.reference && r.compare) lines.push(r.compare.same ? '    与改动前逐元素对比：完全一致' :
        '    与改动前逐元素对比：不一致。这台是参照设备，请对照两张截图找出变化；只有页面自身随机或随时间变化的内容才算正常。');
    }
  }
  lines.push('', '请直接查看截图判断效果，并与改动前的截图对比。提交前调用 review_page 取得独立评审意见。',
    '截图看起来不对、需要找原因时，读“排查用”的两个文件（文件较长，先用 grep 找相关组件或关键字）：组件位置列出每个组件的左、上、宽、高；应用日志是这一页打开期间应用自己输出的内容，代码里临时加的 console.info 会出现在其中。不要把调试文字显示到界面上，也不要裁剪截图数像素。');
  return lines.join('\n');
}
