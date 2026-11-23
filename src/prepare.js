// The page manifest written by /prepare (.dag/pages.json) and read by later stages.
const fail = message => { throw new Error(`页面清单校验失败：${message}`); };
const text = value => typeof value === 'string' && value.trim() !== '';
const statuses = ['verified', 'unverified', 'failed'];

// Steps run after the URI opens, for states that only in-page interaction can reach (sheets, dialogs, keyboard).
function validateSteps(page) {
  if (page.steps === undefined) return [];
  if (!Array.isArray(page.steps) || !page.steps.length) fail(`页面 ${page.name} 的 steps 必须为非空数组，不需要时删除该字段`);
  for (const step of page.steps) {
    const target = step?.click;
    if (step === null || typeof step !== 'object' || Object.keys(step).length !== 1 || target === null || typeof target !== 'object')
      fail(`页面 ${page.name} 的每个步骤必须是 {"click": {...}}`);
    const keys = Object.keys(target);
    if (!keys.length || keys.some(key => !['text', 'id', 'type'].includes(key) || !text(target[key])))
      fail(`页面 ${page.name} 的 click 只能用非空的 text/id/type 指定目标`);
  }
  return page.steps;
}

export function validatePages(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || input.version !== 1) fail('需要 version=1 的对象');
  for (const key of ['bundle', 'ability', 'scheme']) if (!text(input[key])) fail(`${key} 必须为非空字符串`);
  if (!/^[a-z][a-z0-9+.-]*$/.test(input.scheme) || /^(ohos|https?$|file$)/.test(input.scheme)) fail('scheme 必须小写，且不能是 http/https/file 或以 ohos 开头');
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.commit ?? '')) fail('commit 必须是入口提交的完整哈希');
  if (!Array.isArray(input.pages) || !input.pages.length) fail('pages 必须为非空数组');
  const names = new Set(), uris = new Map();
  for (const page of input.pages) {
    if (page === null || typeof page !== 'object' || !text(page.name)) fail('每个页面必须有 name');
    if (names.has(page.name)) fail(`页面名重复：${page.name}`);
    names.add(page.name);
    if (!statuses.includes(page.status)) fail(`页面 ${page.name} 的 status 必须是 ${statuses.join('/')}`);
    if (page.status !== 'verified' && !text(page.reason)) fail(`页面 ${page.name} 未验证或失败，必须写 reason`);
    if (page.uri === null) {
      if (page.status !== 'failed') fail(`页面 ${page.name} 没有 uri，status 只能是 failed`);
      if (page.steps !== undefined) fail(`页面 ${page.name} 没有 uri，不能有 steps`);
      continue;
    }
    if (!text(page.uri) || !page.uri.startsWith(`${input.scheme}://`)) fail(`页面 ${page.name} 的 uri 必须以 ${input.scheme}:// 开头`);
    if (/\s/.test(page.uri)) fail(`页面 ${page.name} 的 uri 含空白字符，需要 URL 编码`);
    // Several entries may share a URI as long as the steps after it differ (a page and the sheets opened from it).
    const route = page.uri + JSON.stringify(validateSteps(page));
    // Two entries with the same URI and steps open the same screen and would be captured twice as one.
    if (uris.has(route)) fail(`页面 ${uris.get(route)} 和 ${page.name} 的网址与到达步骤完全相同（${page.uri}），打开的是同一个界面；` +
      '请合并成一条（进入页面就已展开的弹层不单列，写进所在页面的 note），或给其中一条补上 steps');
    uris.set(route, page.name);
    if (!Array.isArray(page.signature) || !page.signature.length || !page.signature.every(text)) fail(`页面 ${page.name} 需要至少一个 signature`);
  }
  return input;
}

export function parsePages(source) {
  let input;
  try { input = JSON.parse(source); } catch { fail('不是合法 JSON'); }
  return validatePages(input);
}

export const summarizePages = manifest => Object.fromEntries(statuses.map(status =>
  [status, manifest.pages.filter(page => page.status === status).length]));
