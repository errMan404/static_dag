// One lock per device, held only while a package is installed and its pages are captured.
// The lock is a directory: mkdir is atomic, so it works whether tasks share a process or not.
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// Runs `work` while holding the lock for `key` under `dir`. A lock whose owner process is gone, or that is
// older than `staleMs`, is taken over so a crashed task cannot block the others forever.
export async function withLock(dir, key, work, {holder = '', waitMs = 15 * 60_000, staleMs = 10 * 60_000, pollMs = 1500, log = () => {}} = {}) {
  const path = join(dir, key.replace(/[^\w.-]+/g, '_')), ownerFile = join(path, 'owner.json');
  const deadline = Date.now() + waitMs;
  await mkdir(dir, {recursive: true});
  let announced = false;
  for (;;) {
    try { await mkdir(path); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    let owner;
    try { owner = JSON.parse(await readFile(ownerFile, 'utf8')); } catch { /* the owner is between mkdir and writing its record */ }
    const age = owner ? Date.now() - owner.at : 0;
    if (owner && (!alive(owner.pid) || age > staleMs)) { log(`接管失效的锁 ${key}（原持有者 ${owner.holder || owner.pid}）`); await rm(path, {recursive: true, force: true}); continue; }
    if (Date.now() >= deadline) throw new Error(`等待 ${key} 超过 ${Math.round(waitMs / 1000)} 秒仍被占用${owner?.holder ? `（持有者：${owner.holder}）` : ''}`);
    if (!announced) { log(`${key} 正被${owner?.holder ? ` ${owner.holder} ` : '其他任务'}占用，排队等待`); announced = true; }
    await sleep(pollMs);
  }
  try {
    await writeFile(ownerFile, JSON.stringify({pid: process.pid, at: Date.now(), holder}));
    return await work();
  } finally {
    await rm(path, {recursive: true, force: true});
  }
}
