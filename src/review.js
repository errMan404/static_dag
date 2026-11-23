// Independent review of a task's pages. The task that changed the code asks for it, but the verdict comes from a
// separate model call that sees only screenshots (before, after, reference device), never the task's own account.
import {readFile, writeFile, mkdir, copyFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyPages, formatVerify, hostExec} from './verify.js';
import {safeName} from './capture.js';

const optional = async (file, parse = JSON.parse) => { try { return parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } };

// "结论：通过" passes; anything else (including an unparseable answer) counts as needing work.
export const verdictOf = text => /结论\s*[:：]\s*通过/.test(text) ? 'pass' : 'revise';

// Identifies the code a review looked at: the commit plus every uncommitted change. null when it cannot be told.
async function codeState(codeDir, exec) {
  try {
    const parts = await Promise.all([['rev-parse', 'HEAD'], ['status', '--porcelain'], ['diff', 'HEAD']].map(args => exec('git', args, {cwd: codeDir})));
    return createHash('sha256').update(parts.join('\n--\n')).digest('hex').slice(0, 16);
  } catch { return null; }
}

// `ask({page, config, images: [{label, path}], notes, earlier})` returns the reviewer's text. Each page may be
// reviewed `maxRounds` times per task: a reviewer never repeats itself exactly, so without a limit the loop has no end.
// Every call is a new reviewer that remembers nothing. Left alone it asked for the opposite of what it had asked a
// round before (narrower, then wider), so from the second round on it gets `earlier`: what was said about this page
// on this device in each earlier round, plus the screenshot the last round looked at.
export async function reviewPages({codeDir, pages, ask, maxRounds = 3, verify = verifyPages, exec = hostExec, log = () => {}, ...verifyOptions}) {
  if (!pages?.length) throw new Error('需要至少一个页面名');
  const historyFile = join(codeDir, '.dag/verify/reviews.json');
  const history = await optional(historyFile) ?? {};
  // A page that passed keeps its pass while the code stays the same: asking again would only spend a round and
  // invite a different answer about an identical screen.
  const state = await codeState(codeDir, exec);
  const settled = pages.filter(page => state && history[page]?.at(-1)?.verdict === 'pass' && history[page].at(-1).state === state);
  const exhausted = pages.filter(page => !settled.includes(page) && (history[page]?.length ?? 0) >= maxRounds);
  const fresh = pages.filter(page => !settled.includes(page) && !exhausted.includes(page));
  const out = [...settled.map(page => ({page, verdict: 'settled', rounds: history[page].length})),
    ...exhausted.map(page => ({page, verdict: 'limit', rounds: history[page].length}))];
  if (!fresh.length) return {maxRounds, verification: null, results: out};

  // Always review a new capture of the code as it is now, never whatever was captured earlier.
  const report = await verify({codeDir, pages: fresh, log, exec, ...verifyOptions});
  const notes = await optional(join(report.mainRoot, '.dag/review-notes.md'), text => text.trim());
  const reference = report.devices.find(d => d.reference);
  // The screenshots are all taken by now; the reviews themselves only wait on the model, so ask for them together.
  out.push(...await Promise.all(fresh.map(async page => {
    const refShot = reference?.results.find(r => r.page === page && r.status === 'captured');
    const reviews = [];
    for (const device of report.devices.filter(d => !d.reference)) {
      const now = device.results.find(r => r.page === page);
      if (now?.status !== 'captured') { reviews.push({config: device.config, verdict: 'unseen', text: `没有截到这一页（${now?.error ?? '未知'}）`}); continue; }
      const earlier = (history[page] ?? []).map((round, index) => ({round: index + 1, ...round.reviews?.find(r => r.config === device.config)})).filter(r => r.text);
      const lastShot = earlier.at(-1)?.shot;
      const images = [
        ...(now.baselineDir ? [{label: `改动前 · ${device.config} ${device.display.width}x${device.display.height}`, path: join(now.baselineDir, 'screen.png')}] : []),
        ...(lastShot && await optional(lastShot, () => true) ? [{label: `上一轮评审时 · ${device.config} ${device.display.width}x${device.display.height}`, path: lastShot}] : []),
        {label: `改动后 · ${device.config} ${device.display.width}x${device.display.height}`, path: join(now.dir, 'screen.png')},
        ...(refShot ? [{label: `同一页面在手机上 · ${reference.config} ${reference.display.width}x${reference.display.height}`, path: join(refShot.dir, 'screen.png')}] : []),
      ];
      log(`评审 ${page} · ${device.config}`);
      const text = (await ask({page, config: device.config, images, notes, earlier: earlier.map(({round, verdict, text}) => ({round, verdict, text}))})).trim();
      // Keep what this round looked at: the next verification overwrites the screenshot.
      const shot = join(codeDir, '.dag/verify/rounds', safeName(page), device.config, `${(history[page]?.length ?? 0) + 1}.png`);
      await mkdir(dirname(shot), {recursive: true});
      await copyFile(join(now.dir, 'screen.png'), shot);
      reviews.push({config: device.config, verdict: verdictOf(text), text, shot});
    }
    const seen = reviews.filter(r => r.verdict !== 'unseen');
    const verdict = !seen.length ? 'unseen' : seen.every(r => r.verdict === 'pass') ? 'pass' : 'revise';
    if (seen.length) (history[page] ??= []).push({at: new Date().toISOString(), commit: report.commit, state, verdict, reviews: seen});
    return {page, verdict, rounds: history[page]?.length ?? 0, reviews,
      referenceChanged: reference?.results.some(r => r.page === page && r.compare && !r.compare.same) ?? false};
  })));
  await mkdir(dirname(historyFile), {recursive: true});
  await writeFile(historyFile, JSON.stringify(history, null, 2) + '\n');
  return {maxRounds, verification: report, results: out};
}

export function formatReview(result) {
  const lines = [];
  for (const r of result.results) {
    if (r.verdict === 'settled') { lines.push(`## ${r.page}：已通过评审`, '这一页上次评审通过后代码没有再变化，不需要重新评审，可以提交。', ''); continue; }
    if (r.verdict === 'limit') { lines.push(`## ${r.page}：已评审 ${r.rounds} 次，达到上限`, '不要再为评审意见修改这一页。把上一次评审中仍未解决的问题原样写进交付摘要，然后提交。', ''); continue; }
    if (r.verdict === 'unseen') { lines.push(`## ${r.page}：无法评审`, ...r.reviews.map(v => `- ${v.config}：${v.text}`), '这一页在设备上截不到，评审不了。按代码判断完成修改，在交付摘要里注明“未经设备确认和评审”。', ''); continue; }
    lines.push(`## ${r.page}：${r.verdict === 'pass' ? '评审通过' : '需要修改'}（第 ${r.rounds}/${result.maxRounds} 次评审）`);
    for (const v of r.reviews) lines.push(`### ${v.config}`, v.text, '');
    if (r.referenceChanged) lines.push('注意：这一页在参照设备上与改动前不一致，请确认不是本次修改造成的。', '');
    if (r.verdict === 'pass') lines.push('这一页已通过。之后没有再改动它的代码就不要重复评审；改动过才需要重新评审。', '');
    if (r.verdict === 'revise') lines.push(r.rounds >= result.maxRounds
      ? '这是最后一次评审。按上面的意见做完能做的修改后直接提交，并把没有解决的问题写进交付摘要。'
      : '按上面的意见修改代码，编译通过后再次调用 review_page。评审意见里明显与事实不符的条目可以不改，但要在交付摘要里逐条说明理由。', '');
  }
  if (result.verification) lines.push('---', formatVerify(result.verification));
  return lines.join('\n');
}
