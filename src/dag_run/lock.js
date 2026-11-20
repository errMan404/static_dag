import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

async function openRunLock(path, workflowId) {
  try { return await open(path, 'wx'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const occupied = new Error('存在 .dag/run.lock；请确认无其他运行后再处理残留锁。');
  if (!workflowId) throw occupied;
  const recoveryPath = path + '.recovery';
  const recovery = await open(recoveryPath, 'wx').catch(error => {
    if (error.code === 'EEXIST') throw new Error('存在 .dag/run.lock.recovery；请确认没有其他恢复操作');
    throw error;
  });
  try {
    let current, stat;
    try {
      stat = await lstat(path);
      if (!stat.isFile()) throw occupied;
      current = JSON.parse(await readFile(path, 'utf8'));
    }
    catch (error) {
      if (error.code === 'ENOENT') return await open(path, 'wx');
      throw occupied;
    }
    if (current?.workflowId !== workflowId || !Number.isInteger(current.pid) || current.pid < 1 || current.pid > 0x7fffffff) throw occupied;
    try { process.kill(current.pid, 0); }
    catch (error) {
      if (error.code !== 'ESRCH') throw occupied;
      const latest = await lstat(path);
      if (latest.ino !== stat.ino || latest.dev !== stat.dev || latest.mtimeMs !== stat.mtimeMs) throw occupied;
      await unlink(path);
      return await open(path, 'wx');
    }
    throw occupied;
  } finally {
    await recovery.close();
    await unlink(recoveryPath);
  }
}

export async function acquireRunLock(root, owner, {resume = false} = {}) {
  const path = join(root, '.dag/run.lock');
  const handle = await openRunLock(path, resume ? owner.workflowId : undefined);
  try {
    await handle.writeFile(JSON.stringify({pid: process.pid, ...owner}));
  } catch (error) {
    await handle.close();
    await unlink(path);
    throw error;
  }
  return {
    async release() {
      await handle.close();
      await unlink(path);
    }
  };
}
