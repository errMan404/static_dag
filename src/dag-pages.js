// Material for /dag_pages: checks that /prepare's output is usable and lays the pages out for the planner.
// Everything here is read from files; deciding the tasks is the planner's job.
import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {parsePages} from './prepare.js';
import {safeName} from './capture.js';
import {loadDevices} from './verify.js';
import {git} from './dag_run/git.js';

const optional = async file => { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } };

// Words that are page names select pages; everything else is passed to the planner as an extra requirement.
export function parseDagPagesArgs(input = '', names = []) {
  const pages = [], extra = [];
  // Some callers pass the whole argument string wrapped in quotes; a quote stuck to a page name must not hide it.
  for (const word of input.trim().replace(/^(["'])(.*)\1$/s, '$2').split(/\s+/).filter(Boolean)) (names.includes(word) ? pages : extra).push(word);
  return {pages: [...new Set(pages)], extra: extra.join(' ')};
}

export async function pagesBrief({root, input = '', detect}) {
  root = resolve(root);
  let manifest;
  try { manifest = parsePages(await readFile(join(root, '.dag/pages.json'), 'utf8')); }
  catch (error) { throw new Error(error.code === 'ENOENT' ? '找不到 .dag/pages.json，请先运行 /prepare' : error.message); }
  // Every task starts from the current branch; without the entry commit no page can be opened on its own.
  try { await git(root, ['merge-base', '--is-ancestor', manifest.commit, 'HEAD']); }
  catch { throw new Error(`当前分支不包含 /prepare 的入口提交 ${manifest.commit.slice(0, 8)}；请切到包含它的分支再规划`); }
  const devices = await loadDevices(root, detect && {detect});
  const {pages: wanted, extra} = parseDagPagesArgs(input, manifest.pages.map(p => p.name));

  const summaries = {};
  for (const d of devices) summaries[d.config] = await optional(join(root, '.dag/captures', d.config, 'summary.json'));
  const state = (page, config) => {
    const summary = summaries[config];
    if (!summary) return {status: 'no-baseline'};
    const entry = summary.results.find(r => r.page === page.name);
    return !entry ? {status: 'no-baseline'} : entry.status === 'captured' ? {status: 'captured', dir: join(root, '.dag/captures', config, safeName(page.name))}
      : {status: 'failed', reason: `${entry.error ?? entry.status}：${entry.message ?? entry.reason ?? ''}`};
  };

  // Pages sharing a source file must be changed by one task, or parallel tasks would edit the same file.
  const groups = new Map(), unreachable = [];
  for (const page of manifest.pages) {
    if (wanted.length && !wanted.includes(page.name)) continue;
    if (page.uri === null || page.status === 'failed') { unreachable.push({name: page.name, reason: page.reason ?? '入口无法到达'}); continue; }
    const key = page.source ?? `（清单未记录源文件）${page.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({name: page.name, steps: page.steps?.length ?? 0, note: page.note, unverified: page.status === 'unverified' ? page.reason : undefined,
      captures: Object.fromEntries(devices.map(d => [d.config, state(page, d.config)]))});
  }
  if (!groups.size) throw new Error('没有可规划的页面');

  const lines = [`应用包名：${manifest.bundle}`, `入口提交：${manifest.commit}`, '',
    '设备（配置名 · 序列号 · 屏幕 · 基准）：'];
  for (const d of devices) {
    const s = summaries[d.config];
    lines.push(`- ${d.config} · ${d.device} · ${s ? `${s.display.width}x${s.display.height} 密度 ${s.display.density}` : '未知'} · ` +
      (s ? `已采集，目录 ${join(root, '.dag/captures', d.config)}` : '尚未采集，任务里第一次调用 verify_page 时会自动采集'));
  }
  lines.push('', '页面（按源文件分组，同一组必须放进同一个任务）：');
  let index = 0;
  for (const [source, pages] of groups) {
    lines.push(`${++index}. ${source}`);
    for (const page of pages) {
      const marks = [page.steps ? `需点击 ${page.steps} 步才出现` : '', page.note ?? '', page.unverified ? `/prepare 未能确认：${page.unverified}` : ''].filter(Boolean);
      lines.push(`   - 页面名 ${page.name}${marks.length ? `（${marks.join('；')}）` : ''}`);
      for (const [config, c] of Object.entries(page.captures))
        if (c.status === 'failed') lines.push(`       ${config} 上基准采集失败（${c.reason}），这一页在该设备上很可能无法用 verify_page 查看`);
    }
  }
  if (unreachable.length) { lines.push('', '入口到不了、无法在设备上查看的页面（不要为它们安排需要设备确认的验收）：'); for (const p of unreachable) lines.push(`- ${p.name}：${p.reason}`); }
  return {text: lines.join('\n'), extra, groups: [...groups].map(([source, pages]) => ({source, pages})), unreachable, devices, manifest};
}
