import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireDevice, evaluate, evaluationTasks } from '../src/one-duo/evaluation.js';

function fixture(t) {
  const device = 'test-device-' + randomUUID();
  const hash = createHash('sha256').update(device).digest('hex');
  const path = join(tmpdir(), 'deveco-dag-device-' + hash + '.lock');
  t.after(() => rm(path, {force: true}));
  return {device, path};
}

test('遗留设备锁报告实例名和已退出进程，保留锁文件', async t => {
  const {device, path} = fixture(t);
  const pid = 12345;
  const record = JSON.stringify({device, pid});
  await writeFile(path, record, {flag: 'wx'});
  const check = t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('No such process'), {code: 'ESRCH'});
  });
  await assert.rejects(acquireDevice(device, AbortSignal.timeout(4000), {}),
    error => error.code === 'DAG_STALE_DEVICE_LOCK' && error.message.includes(device) &&
      error.message.includes(String(pid)) && error.message.includes(path));
  assert.deepEqual(check.mock.calls.map(call => call.arguments), [[pid, 0]]);
  assert.equal(await readFile(path, 'utf8'), record);
});

test('设备被活动进程占用时只报告一次等待，释放后继续申请', async t => {
  const {device, path} = fixture(t);
  const signal = AbortSignal.timeout(4000);
  const current = await acquireDevice(device, signal, {});
  const waits = [];
  const waiting = Promise.withResolvers();
  const requested = acquireDevice(device, signal, {}, wait => {
    waits.push(wait);
    waiting.resolve(wait);
  });
  try {
    const event = await Promise.race([waiting.promise, requested.then(() => assert.fail('设备仍在占用'))]);
    assert.deepEqual(event, {device, pid: process.pid});
    assert.equal((JSON.parse(await readFile(path, 'utf8'))).pid, process.pid);
    await delay(400);
  } finally {
    await current.release(true);
  }
  const acquired = await requested;
  assert.deepEqual(waits, [{device, pid: process.pid}]);
  await acquired.release(true);
});

test('指定设备残留锁会记为未验证并在报告中说明原因', async t => {
  const {device, path} = fixture(t);
  const pid = 12345;
  await writeFile(path, JSON.stringify({device, pid}), {flag: 'wx'});
  t.mock.method(process, 'kill', () => {
    throw Object.assign(new Error('No such process'), {code: 'ESRCH'});
  });
  const checklist = {id: 'checklist', items: [{id: 'check', target: '折叠屏'}]};
  const tasks = evaluationTasks(checklist, {'折叠屏': device});
  const report = await evaluate({checklist, tasks, signal: AbortSignal.timeout(4000)});
  assert.equal(tasks[0].status, 'done');
  assert.equal(tasks[0].waitingDevice, undefined);
  assert.equal(report.results.check.status, 'unverified');
  assert.equal(report.results.check.actual, tasks[0].deviceLockError);
  assert.ok(report.results.check.actual.includes(path));
});
