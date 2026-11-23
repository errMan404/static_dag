// Deterministic page capture: opens each page of .dag/pages.json on one device and saves its layout dumps.
// No model is involved. Problems are reported as execution errors, never as layout findings.
import {execFile} from 'node:child_process';
import {mkdir, mkdtemp, readFile, rm, writeFile, copyFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {parsePages} from './prepare.js';

const run = promisify(execFile);
const sleep = ms => new Promise(done => setTimeout(done, ms));
export class CaptureError extends Error {
  constructor(type, message, detail) { super(message); this.type = type; this.detail = detail; }
}

// ---- pure helpers -------------------------------------------------------------------------------------------------

const rect = text => { const m = String(text ?? '').match(/-?\d+/g); return m?.length === 4 ? m.map(Number) : null; };
const windowsOf = dump => (Array.isArray(dump) ? dump : dump?.attributes?.bundleName ? [dump] : dump?.children ?? [])
  .filter(root => root?.attributes?.bundleName);
function flatten(node, out = [], depth = 0) {
  const a = node.attributes ?? {}, bounds = rect(a.bounds);
  out.push({type: a.type ?? '', id: a.id || a.key || '', text: a.text ?? '', bounds, depth});
  for (const child of node.children ?? []) flatten(child, out, depth + 1);
  return out;
}

// The app's components as plain lines, positions in vp, nested by indentation. For a task that needs to know where
// something ended up or whether it was laid out at all, without printing debug text on the screen or measuring
// pixels in a screenshot. Wrappers that only repeat the box of the line above are left out.
export function layoutText(nodes, density, limit = 500) {
  const vp = px => Math.round(px / density);
  const lines = [];
  let last = null, base = 0;
  for (const n of nodes) {
    if (!n.bounds || n.bounds[2] <= n.bounds[0] || n.bounds[3] <= n.bounds[1]) continue;
    const box = n.bounds.join(','), text = n.text.trim();
    if (box === last && !text && !n.id) continue;
    last = box;
    if (!lines.length) base = n.depth;
    lines.push(`${'  '.repeat(Math.min(n.depth - base, 20))}${n.type || '?'}${n.id ? ` #${n.id}` : ''}${text ? ` "${text.slice(0, 30)}"` : ''}` +
      ` · 左 ${vp(n.bounds[0])} 上 ${vp(n.bounds[1])} 宽 ${vp(n.bounds[2] - n.bounds[0])} 高 ${vp(n.bounds[3] - n.bounds[1])}`);
  }
  return [`单位 vp（1vp = ${density}px），缩进表示嵌套；只列出占有面积的组件。`, ...lines.slice(0, limit),
    ...(lines.length > limit ? [`……其余 ${lines.length - limit} 行省略`] : [])].join('\n') + '\n';
}

// Splits a merged dump into the app's nodes and the visible texts of every other window.
export function inspect(dump, bundle) {
  const app = [], others = [];
  for (const root of windowsOf(dump)) {
    if (root.attributes.bundleName === bundle) flatten(root, app);
    else others.push(...flatten(root).filter(n => n.text.trim()).map(n => n.text.trim()));
  }
  return {present: app.length > 0, nodes: app, otherTexts: others};
}

// A signature entry matches when it is contained in some text or equals some component id.
export const missingSignatures = (nodes, signature) =>
  signature.filter(wanted => !nodes.some(n => n.text.includes(wanted) || n.id === wanted));

// Returns the nodes a click target selects; only nodes with a visible area count.
export const clickTargets = (nodes, target) => nodes.filter(n => n.bounds && n.bounds[2] > n.bounds[0] && n.bounds[3] > n.bounds[1] &&
  (target.text === undefined || n.text === target.text) && (target.id === undefined || n.id === target.id) &&
  (target.type === undefined || n.type === target.type));

export function parseDisplay(text) {
  const density = Number(text.match(/^Density:\s+([\d.]+)/m)?.[1]);
  const size = text.match(/^Bounds<L,T,W,H>:\s+-?\d+,\s*-?\d+,\s*(\d+),\s*(\d+)/m);
  if (!Number.isFinite(density) || density <= 0 || !size) throw new CaptureError('dump-failed', '读不到屏幕密度或尺寸');
  return {density, width: Number(size[1]), height: Number(size[2]), foldStatus: text.match(/^DisplayFoldStatus:\s+(\w+)/m)?.[1] ?? null};
}

// "device=127.0.0.1:5557 config=wide-open PageA PageB" -> options. Bare words are page names.
export function parseCaptureArgs(input = '') {
  const options = {pages: []};
  for (const word of input.trim().split(/\s+/).filter(Boolean)) {
    const pair = word.match(/^(device|config)=(.+)$/);
    if (pair) options[pair[1]] = pair[2]; else options.pages.push(word);
  }
  if (options.config && !/^[\w.-]+$/.test(options.config)) throw new Error('config 只能包含字母、数字、点、下划线和连字符');
  return options;
}

export const safeName = name => name.replace(/[^\w.-]+/g, '_');

// ---- device access ------------------------------------------------------------------------------------------------

async function findHdc() {
  const candidates = [process.env.HDC, 'hdc',
    '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc',
    process.env.DEVECO_SDK_HOME && join(process.env.DEVECO_SDK_HOME, 'default/openharmony/toolchains', process.platform === 'win32' ? 'hdc.exe' : 'hdc'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await run(candidate, ['version']); return candidate; } catch { /* try the next location */ }
  }
  throw new CaptureError('dump-failed', '找不到 hdc，请把它加入 PATH 或设置环境变量 HDC');
}

// Every connected device with its screen, for stages that were not told which devices to use.
export async function connectedDevices() {
  const hdc = await findHdc();
  const targets = (await run(hdc, ['list', 'targets'])).stdout.split(/\r?\n/).map(s => s.trim()).filter(s => s && !/^\[?empty/i.test(s));
  const out = [];
  for (const serial of targets)
    out.push({serial, display: parseDisplay((await run(hdc, ['-t', serial, 'shell', 'hidumper -s DisplayManagerService -a -a'], {maxBuffer: 64 << 20})).stdout)});
  return out;
}

// The only place that talks to the device; tests replace it with a fake.
export async function hdcDevice(serial) {
  const hdc = await findHdc();
  const targets = (await run(hdc, ['list', 'targets'])).stdout.split(/\r?\n/).map(s => s.trim()).filter(s => s && !/^\[?empty/i.test(s));
  if (!targets.length) throw new CaptureError('dump-failed', '没有已连接的设备');
  if (serial && !targets.includes(serial)) throw new CaptureError('dump-failed', `设备 ${serial} 未连接；已连接：${targets.join('、')}`);
  if (!serial && targets.length > 1) throw new CaptureError('dump-failed', `连接了多台设备，请用 device= 指定一台：${targets.join('、')}`);
  serial ??= targets[0];
  return {
    serial,
    shell: async command => (await run(hdc, ['-t', serial, 'shell', command], {maxBuffer: 64 << 20})).stdout,
    pull: async (remote, local) => { await run(hdc, ['-t', serial, 'file', 'recv', remote, local]); await access(local); },
  };
}

// ---- capture ------------------------------------------------------------------------------------------------------

const REMOTE = '/data/local/tmp/dag-capture';

// `manifestRoot` and `outDir` let a task worktree capture with the main checkout's page list into its own folder.
// A freshly installed app asks for its permissions the first time a page needs them, and that system dialog
// hides the page. Nobody is there to answer it, so grant everything the app declares up front. Best effort:
// permissions the system grants by itself, or a device without `atm`, simply leave things as they were.
export async function grantPermissions(dev, bundle) {
  try {
    const info = await dev.shell(`bm dump -n ${bundle}`);
    const token = info.match(/"accessTokenId"\s*:\s*(\d+)/)?.[1];
    const names = [...new Set(info.match(/ohos\.permission\.[A-Z0-9_]+/g) ?? [])];
    if (!token) return [];
    const granted = [];
    for (const name of names) if (/success/i.test(await dev.shell(`atm perm -g -i ${token} -p ${name}`))) granted.push(name);
    return granted;
  } catch { return []; }
}

export async function capturePages({root, manifestRoot = root, outDir, sourceCommit, device, config, pages: wanted = [], connect = hdcDevice, timeoutMs = 12000, pollMs = 400, log = () => {}}) {
  root = resolve(root);
  let manifest;
  try { manifest = parsePages(await readFile(join(resolve(manifestRoot), '.dag/pages.json'), 'utf8')); }
  catch (error) { throw new Error(error.code === 'ENOENT' ? '找不到 .dag/pages.json，请先运行 /prepare' : error.message); }
  const unknown = wanted.filter(name => !manifest.pages.some(page => page.name === name));
  if (unknown.length) throw new Error(`页面清单里没有：${unknown.join('、')}；可选：${manifest.pages.map(p => p.name).join('、')}`);
  const selected = manifest.pages.filter(page => !wanted.length || wanted.includes(page.name));

  const dev = await connect(device), scratch = await mkdtemp(join(tmpdir(), 'dag-capture-'));
  try {
    const displayText = await dev.shell('hidumper -s DisplayManagerService -a -a');
    const display = parseDisplay(displayText);
    config ??= `${display.width}x${display.height}`;
    const outRoot = outDir ? resolve(outDir) : join(root, '.dag/captures', config);
    await mkdir(outRoot, {recursive: true});
    await grantPermissions(dev, manifest.bundle);

    const dump = async (mode, name) => {
      const remote = `${REMOTE}-${name}.json`, local = join(scratch, `${name}.json`);
      const output = await dev.shell(`uitest dumpLayout ${mode} -p ${remote}`.replace('  ', ' '));
      if (!/saved to/i.test(output)) throw new CaptureError('dump-failed', `导出组件树失败：${output.trim().slice(0, 200)}`);
      await dev.pull(remote, local);
      try { return {local, tree: JSON.parse(await readFile(local, 'utf8'))}; }
      catch { throw new CaptureError('dump-failed', '导出的组件树不是合法 JSON'); }
    };
    // Polls the fast merged dump until `ready` returns a value; a missing app window is diagnosed as a system dialog.
    const waitFor = async (bundle, ready, describe) => {
      const deadline = Date.now() + timeoutMs;
      let seen;
      for (;;) {
        seen = inspect((await dump('', 'poll')).tree, bundle);
        const result = seen.present ? ready(seen.nodes) : undefined;
        if (result !== undefined) return result;
        if (Date.now() >= deadline) break;
        await sleep(pollMs);
      }
      if (!seen.present) throw new CaptureError(seen.otherTexts.length ? 'system-dialog' : 'page-not-reached',
        `应用窗口不在屏幕上${seen.otherTexts.length ? `，屏幕上的文字：${seen.otherTexts.slice(0, 6).join(' / ')}` : ''}`);
      throw describe(seen.nodes);
    };

    // What the app itself logged while this page was open (console.info and hilog of its own process). Best effort.
    const appLog = async pid => {
      if (!/^\d+$/.test(pid ?? '')) return '';
      try { return (await dev.shell(`hilog -x -t app -P ${pid}`)).split(/\r?\n/).filter(Boolean).slice(-400).join('\n'); } catch { return ''; }
    };
    const results = [];
    for (const page of selected) {
      const dir = join(outRoot, safeName(page.name)), started = Date.now();
      let pid;
      try {
        if (page.uri === null) { results.push({page: page.name, status: 'skipped', reason: page.reason}); continue; }
        log(`${page.name} · 冷启动`);
        await dev.shell(`aa force-stop ${manifest.bundle}`);
        const launch = await dev.shell(`aa start -U '${page.uri.replaceAll("'", '')}'`);
        if (!/start ability successfully/i.test(launch)) {
          await dev.shell('uitest uiInput keyEvent Back').catch(() => {});
          throw new CaptureError('page-not-reached', `网址没有被应用接收：${launch.trim().split('\n')[1]?.trim() ?? launch.trim().slice(0, 160)}`);
        }
        pid = (await dev.shell(`pidof ${manifest.bundle}`).catch(() => '')).trim().split(/\s+/)[0];
        for (const [index, step] of (page.steps ?? []).entries()) {
          const [x, y] = await waitFor(manifest.bundle, nodes => {
            const hits = clickTargets(nodes, step.click);
            return hits.length === 1 ? [(hits[0].bounds[0] + hits[0].bounds[2]) >> 1, (hits[0].bounds[1] + hits[0].bounds[3]) >> 1] : undefined;
          }, nodes => new CaptureError('step-failed',
            `第 ${index + 1} 步的点击目标 ${JSON.stringify(step.click)} 匹配到 ${clickTargets(nodes, step.click).length} 个节点，需要恰好 1 个`));
          log(`${page.name} · 点击 ${JSON.stringify(step.click)}`);
          await dev.shell(`uitest uiInput click ${x} ${y}`);
        }
        await waitFor(manifest.bundle, nodes => missingSignatures(nodes, page.signature).length ? undefined : true,
          nodes => new CaptureError('page-not-reached', `没有出现识别特征：${missingSignatures(nodes, page.signature).join('、')}`,
            {visibleTexts: nodes.filter(n => n.text.trim()).slice(0, 12).map(n => n.text.trim().slice(0, 20))}));
        // Wait out transitions: capture only after two consecutive fast dumps are identical.
        let previous = await readFile((await dump('', 'poll')).local, 'utf8'), stable = false;
        for (let attempt = 0; attempt < 6 && !stable; attempt++) {
          await sleep(pollMs);
          const current = await readFile((await dump('', 'poll')).local, 'utf8');
          stable = current === previous; previous = current;
        }
        const full = await dump('-a', 'a'), unmerged = await dump('-i', 'i');
        const after = inspect(full.tree, manifest.bundle);
        if (!after.present || missingSignatures(after.nodes, page.signature).length)
          throw new CaptureError('page-not-reached', '导出期间页面已离开目标状态');
        await dev.shell(`uitest screenCap -p ${REMOTE}.png`);
        await dev.pull(`${REMOTE}.png`, join(scratch, 'screen.png'));
        await mkdir(dir, {recursive: true});
        await copyFile(full.local, join(dir, 'dump.a.json'));
        await copyFile(unmerged.local, join(dir, 'dump.i.json'));
        await copyFile(join(scratch, 'screen.png'), join(dir, 'screen.png'));
        await writeFile(join(dir, 'layout.txt'), layoutText(after.nodes, display.density));
        await writeFile(join(dir, 'log.txt'), await appLog(pid) + '\n');
        const meta = {page: page.name, uri: page.uri, steps: page.steps ?? [], config, device: dev.serial, bundle: manifest.bundle,
          display, stable, capturedAt: new Date().toISOString(), manifestCommit: manifest.commit, ...(sourceCommit && {sourceCommit})};
        await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
        results.push({page: page.name, status: 'captured', stable, dir, ms: Date.now() - started});
      } catch (error) {
        if (!(error instanceof CaptureError)) throw error;
        // A stale capture must not survive a failed run and be mistaken for the current state.
        await rm(dir, {recursive: true, force: true});
        // The last lines the app logged often say why the page never appeared (an exception, a missing route).
        const log = (await appLog(pid)).split('\n').filter(Boolean).slice(-15);
        results.push({page: page.name, status: 'error', error: error.type, message: error.message, ...(error.detail && {detail: error.detail}), ...(log.length && {log}), ms: Date.now() - started});
      }
      log(`${page.name} · ${results.at(-1).status}`);
    }
    await dev.shell(`aa force-stop ${manifest.bundle}`).catch(() => {});
    const count = status => results.filter(r => r.status === status).length;
    const summary = {config, device: dev.serial, display, outRoot, ...(sourceCommit && {sourceCommit}), captured: count('captured'), errors: count('error'), skipped: count('skipped'), results};
    // A partial run (selected pages) updates only its own entries; other pages keep their last result.
    let earlier = [];
    try { earlier = JSON.parse(await readFile(join(outRoot, 'summary.json'), 'utf8')).results ?? []; } catch { /* first run for this config */ }
    const merged = manifest.pages.map(page => results.find(r => r.page === page.name) ?? earlier.find(r => r.page === page.name)).filter(Boolean);
    const total = status => merged.filter(r => r.status === status).length;
    await writeFile(join(outRoot, 'summary.json'), JSON.stringify({...summary, captured: total('captured'), errors: total('error'),
      skipped: total('skipped'), results: merged}, null, 2) + '\n');
    return summary;
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
}

export function formatCapture(summary) {
  const lines = [`采集配置 ${summary.config} · 设备 ${summary.device} · ${summary.display.width}x${summary.display.height} 密度 ${summary.display.density}` +
    (summary.display.foldStatus ? ` · ${summary.display.foldStatus}` : ''),
    `成功 ${summary.captured}，执行错误 ${summary.errors}，跳过 ${summary.skipped}。输出目录：${summary.outRoot}`];
  for (const r of summary.results) lines.push(r.status === 'captured' ? `- ${r.page}：已采集${r.stable ? '' : '（界面一直在变化，取了最后一帧）'}`
    : r.status === 'skipped' ? `- ${r.page}：跳过（${r.reason}）` : `- ${r.page}：${r.error} · ${r.message}`);
  return lines.join('\n');
}
