import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && Boolean(value.trim());
const key = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const sha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
export const MAX_TIMEOUT_MS = 10 * 60 * 60 * 1000;
export const targetKey = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();

export function checkIdsInTask(task) {
  const text = [task.title, task.description, task.details, task.testStrategy].join('\n');
  return new Set(text.match(/[A-Za-z0-9][A-Za-z0-9_-]*/g));
}

export function validateTargetNames(values, requirement) {
  if (!Array.isArray(values) || !values.length ||
      values.some(value => !text(value) || value.trim().length > 100 || /[\p{Cc},，、]/u.test(value))) {
    throw new Error('请在需求中明确列出要适配或回归的设备名称');
  }
  const names = values.map(value => value.trim());
  const keys = names.map(targetKey);
  if (new Set(keys).size !== names.length) throw new Error('目标设备名称必须互不重复');
  if (requirement !== undefined) {
    const original = targetKey(requirement);
    const absent = names.filter((_, index) => !original.includes(keys[index]));
    if (absent.length) throw new Error(`目标设备须使用用户原文中的名称：${absent.join('、')}`);
  }
  return names;
}

export function validateChecklist(items, targets) {
  if (!Array.isArray(items) || !items.length || items.length > 200) throw new Error('验收清单需要 1 到 200 项');
  const targetNames = new Map(targets.map(name => [targetKey(name), name]));
  const ids = new Set();
  const covered = new Set();
  const normalized = items.map(item => {
    const target = typeof item?.target === 'string' ? targetNames.get(targetKey(item.target)) : undefined;
    if (!object(item) || !text(item.id) || !key.test(item.id) || ids.has(item.id) || !target) {
      throw new Error('验收项需要唯一编号及用户指定的目标设备');
    }
    if (!Array.isArray(item.steps) || !item.steps.length || !item.steps.every(text) || !text(item.expected)) {
      throw new Error(`验收项 ${item.id} 需要操作步骤和明确的通过条件`);
    }
    ids.add(item.id);
    covered.add(target);
    return {id: item.id, target, steps: item.steps.map(step => step.trim()), expected: item.expected.trim()};
  });
  const missing = targets.filter(target => !covered.has(target));
  if (missing.length) throw new Error(`以下目标设备缺少验收项：${missing.join('、')}`);
  const id = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  return {id, items: normalized};
}

export async function loadOneDuoConfig(root) {
  let config;
  try { config = JSON.parse(await readFile(join(root, '.dag/one-duo.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('无法读取 .dag/one-duo.json，请检查 JSON 配置', {cause: error});
    config = {};
  }
  if (!object(config)) throw new Error('.dag/one-duo.json 必须是 JSON 对象');
  const {devices = {}, maxRounds = 8, timeoutMs = MAX_TIMEOUT_MS, maxConcurrency = 20} = config;
  if (!object(devices) || Object.values(devices).some(value => !text(value))) {
    throw new Error('devices 必须将目标设备名称映射到非空的模拟器标识');
  }
  const names = Object.keys(devices);
  if (names.length) validateTargetNames(names);
  for (const [name, value, upper] of [
    ['maxRounds', maxRounds, 200], ['timeoutMs', timeoutMs, MAX_TIMEOUT_MS], ['maxConcurrency', maxConcurrency, 100]
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > upper) throw new Error(`${name} 必须是 1 到 ${upper} 之间的整数`);
  }
  return {devices, maxRounds, timeoutMs, maxConcurrency};
}

export function devicesForTargets(devices, targets) {
  const available = new Map(Object.entries(devices).map(([name, device]) => [targetKey(name), device.trim()]));
  return Object.fromEntries(targets.flatMap(name => {
    const device = available.get(targetKey(name));
    return device ? [[name, device]] : [];
  }));
}

export function validateEvaluation(checklist, commit, report) {
  if (!sha.test(commit) || report?.commit !== commit || report.checklistId !== checklist.id || !object(report.results)) {
    throw new Error('评测报告不属于本轮集成提交或验收清单');
  }
  if (Object.keys(report.results).length !== checklist.items.length) throw new Error('评测报告没有覆盖固定清单');
  for (const item of checklist.items) {
    const result = Object.hasOwn(report.results, item.id) ? report.results[item.id] : undefined;
    if (!object(result) || result.target !== item.target ||
        !['passed', 'failed', 'unverified'].includes(result.status) || !text(result.actual) || !Array.isArray(result.evidence) ||
        !result.evidence.every(text) || (result.status !== 'unverified' && !result.evidence.length)) {
      throw new Error(`验收项 ${item.id} 的结果不合法`);
    }
  }
  return report;
}

export function nextStep(current, previous) {
  const entries = Object.entries(current.results);
  const failed = entries.filter(([, result]) => result.status === 'failed').map(([id]) => id);
  const unverified = entries.filter(([, result]) => result.status === 'unverified').map(([id]) => id);
  if (unverified.length) return {action: 'pause', reason: 'unverified', ids: unverified};
  if (!failed.length) return {action: 'finish'};
  if (!previous) return {action: 'repair', ids: failed};
  const regressions = failed.filter(id => previous.results[id].status === 'passed');
  if (regressions.length) return {action: 'pause', reason: 'regression', ids: regressions};
  const fixed = entries.some(([id, result]) => result.status === 'passed' && previous.results[id].status === 'failed');
  if (!fixed) return {action: 'pause', reason: 'no-progress', ids: failed};
  return {action: 'repair', ids: failed};
}
