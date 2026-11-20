import { tool } from '@opencode-ai/plugin';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { git } from '../dag_run/git.js';
import { nextToolActivity } from '../dag_run/progress.js';
import { schedule as scheduleDag } from '../dag_run/schedule.js';
import { isDevEcoCliReferenceCommand } from '../runtime/deveco-cli-tool.js';
import { MAX_TIMEOUT_MS } from './contracts.js';
import { listEvaluationDevices } from './devices.js';
import { guardReadPaths, readTools, rememberSkillDirectory } from '../runtime/skill-files.js';

const agent = 'dag-device-evaluator';
const sessions = globalThis[Symbol.for('static-dag.evaluation-sessions')] ??= new Map();
const tools = [...readTools, 'skill', 'devecocli', 'bash', 'list_evaluation_devices', 'reserve_evaluation_device', 'record_check_result'];
const statuses = ['passed', 'failed', 'unverified'];
const deviceCommands = ['run', 'debug', 'device', 'ui', 'testing', 'verify', 'log'];
const emulatorActions = ['shake', 'power', 'rotate', 'volume', 'fold', 'battery', 'geolocation', 'scene', 'sensor'];
const asReference = path => path.split(sep).join('/');

function inside(base, path) {
  const rel = relative(base, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}

export function configureEvaluation(config) {
  if (config.agent[agent]) throw new Error(agent + ' 已存在');
  config.agent[agent] = {
    mode: 'subagent', hidden: true,
    description: '在指定设备上验证固定验收项',
    prompt: readFileSync(new URL('./evaluation.md', import.meta.url), 'utf8').trim(),
    permission: {'*': 'deny', ...Object.fromEntries(tools.map(name => [name, 'allow'])), external_directory: 'allow'}
  };
}

export function guardEvaluationPrompt(input) {
  if (input.agent !== agent) return;
  const session = sessions.get(input.sessionID);
  if (!session) throw new Error('设备验收 Agent 只能由运行中的验收节点调用');
  session.signal.throwIfAborted();
}

export function observeEvaluationEvent(event) {
  if (event.type !== 'message.part.updated') return;
  const {part} = event.properties;
  if (part?.type !== 'tool' || part.tool === 'record_check_result' || !tools.includes(part.tool)) return;
  const session = sessions.get(part.sessionID);
  if (!session || session.signal.aborted) return;
  const activity = nextToolActivity(part, session.task.activity);
  if (!activity) return;
  session.task.activity = activity;
  void session.onUpdate().catch(() => {});
}

export async function guardEvaluationTool(input, args) {
  const session = sessions.get(input.sessionID);
  if (!session) return;
  session.signal.throwIfAborted();
  if (!tools.includes(input.tool)) throw new Error('验收会话仅允许检查、运行验证及提交验收结果');
  if (input.tool === 'bash') {
    if (!session.lease) throw new Error('请先查找与目标匹配的设备，并通过 reserve_evaluation_device 取得占用权');
    const workdir = resolve(session.worktree, args.workdir ?? session.worktree);
    if (!inside(session.worktree, workdir)) throw new Error('验收命令必须在分配的工作目录内运行');
    args.workdir = workdir;
  } else if (readTools.includes(input.tool)) await guardReadPaths(session, args, session.worktree, session.worktree, session.evidenceDir);
}

async function verifyEvidenceRoot(session) {
  if (relative(await realpath(session.evidenceDir), session.evidenceDir)) throw new Error('证据目录已被移动或替换');
}

export async function observeEvaluationTool(input, output) {
  const session = sessions.get(input.sessionID);
  if (!session) return;
  if (input.tool === 'skill') return rememberSkillDirectory(session, output);
  const cliArgs = input.args?.args ?? [];
  if (input.tool !== 'bash' && (input.tool !== 'devecocli' || !session.lease ||
      isDevEcoCliReferenceCommand(cliArgs) || isDeviceInventoryCommand(cliArgs))) return;
  session.signal.throwIfAborted();
  await verifyEvidenceRoot(session);
  const number = ++session.sequence;
  const receipt = 'observation:' + number;
  const path = join(session.evidenceDir, 'observation-' + number + '.json');
  const observation = {
    command: (input.tool === 'devecocli' ? 'devecocli ' + cliArgs.join(' ') : String(input.args?.command ?? '')).slice(0, 8000),
    exitCode: output.metadata?.exit,
    output: String(output.output ?? '').slice(0, 32000)
  };
  await writeFile(path, JSON.stringify(observation, null, 2) + '\n', {flag: 'wx'});
  session.observations.set(receipt, path);
  output.output += '\n验收记录：' + receipt;
}

async function evidenceReference(session, value) {
  await verifyEvidenceRoot(session);
  if (value.startsWith('observation:') && !session.observations.has(value)) throw new Error('验收记录编号无效：' + value);
  if (!session.observations.has(value) && (isAbsolute(value) || value.split(/[\\/]/).some(part => part === '..'))) {
    throw new Error('证据使用本节点证据目录的相对路径或有效的 observation 编号');
  }
  const path = session.observations.get(value) ?? resolve(session.evidenceDir, value);
  const file = await realpath(path).catch(() => undefined);
  if (!file || !inside(session.evidenceDir, file) || !(await lstat(file)).isFile()) throw new Error('证据文件不存在或不在本节点证据目录：' + value);
  return asReference(relative(session.directory, file));
}

function evaluationSession(context) {
  const session = sessions.get(context.sessionID);
  if (!session || relative(session.worktree, resolve(context.directory))) throw new Error('仅允许当前验收会话在被测工作区调用设备评测工具');
  session.signal.throwIfAborted();
  return session;
}

export function evaluationDevEcoContext(context) {
  if (context.agent === agent) return evaluationSession(context);
}

function isDeviceInventoryCommand(args) {
  return ['emulator', 'device'].includes(args[0]) && args[1] === 'list';
}

export function guardEvaluationDevEcoCli(session, args) {
  if (isDeviceInventoryCommand(args)) return;
  if (!session.lease) throw new Error('请先查找并占用目标设备，再用 DevEco CLI 执行验收');
  const [command, action] = args;
  if (['build', 'check'].includes(command)) return;
  if (command === 'verify' && ['log', 'screenshot'].includes(action)) return;
  const device = session.inventory?.find(entry => entry.id === session.device.id) ?? session.device;
  const selectors = new Set([device.id, device.name, device.serial].filter(Boolean));
  if (command === 'emulator' && ['start', 'stop'].includes(action)) {
    if (args.length === 3 && selectors.has(args[2])) return;
  } else if (deviceCommands.includes(command) || (command === 'emulator' && emulatorActions.includes(action))) {
    const selected = args.flatMap((arg, index) => {
      const match = /^(?:--device|--target|--sn|-t)(?:=(.*))?$/u.exec(arg);
      return match ? [match[1] ?? args[index + 1]] : [];
    });
    if (selected.length === 1 && selectors.has(selected[0])) return;
  }
  throw new Error('请使用支持的评测命令并显式指定本节点占用的设备：' + [...selectors].join('、'));
}

const s = tool.schema;
export const evaluationTools = {
  list_evaluation_devices: tool({
    description: '列出本机可用的模拟器实例及已连接设备，供当前验收节点依据用户指定的型号或屏幕形态选用。',
    args: {},
    async execute(_args, context) {
      const session = evaluationSession(context);
      const result = await listEvaluationDevices(session.worktree, session.signal);
      session.signal.throwIfAborted();
      session.inventory = result.devices;
      return JSON.stringify({target: session.target, ...result});
    }
  }),
  reserve_evaluation_device: tool({
    description: '使用 list_evaluation_devices 返回的 id 申请占用与本任务目标匹配的设备。有其他节点占用时等待。',
    args: {device: s.string().trim().min(1)},
    async execute({device}, context) {
      const session = evaluationSession(context);
      if (session.lease) {
        if (session.device.id !== device) throw new Error('当前节点已绑定设备：' + session.device.id);
        return JSON.stringify(session.device);
      }
      const candidate = session.inventory?.find(entry => entry.id === device);
      if (!candidate) throw new Error('请先列出设备，并使用设备清单中的 id');
      if (session.reserving) throw new Error('正在等待设备占用，请等待本次申请结束');
      session.reserving = (async () => {
        try {
          session.lease = await acquireDevice(candidate.id, session.signal, session.owner, async waiting => {
            session.task.waitingDevice = waiting;
            await session.onUpdate();
          });
          session.signal.throwIfAborted();
          session.device = candidate;
          session.task.device = candidate.id;
          delete session.task.deviceLockError;
        } catch (error) {
          if (error.code === 'DAG_STALE_DEVICE_LOCK') session.task.deviceLockError = error.message;
          throw error;
        } finally {
          delete session.task.waitingDevice;
          await session.onUpdate();
        }
      })();
      try { await session.reserving; }
      finally { session.reserving = undefined; }
      return JSON.stringify(candidate);
    }
  }),
  record_check_result: tool({
    description: '提交本验收会话中一项实际检查的结果。evidence 填本节点证据目录下的文件相对路径或工具返回的 observation 编号。',
    args: {
      id: s.string().trim().min(1),
      status: s.enum(statuses),
      actual: s.string().trim().min(1),
      evidence: s.array(s.string().trim().min(1))
    },
    async execute({id, status, actual, evidence}, context) {
      const session = evaluationSession(context);
      if (!session.items.has(id)) throw new Error('验收项不属于当前节点：' + id);
      if (!statuses.includes(status) || typeof actual !== 'string' || !actual.trim() || !Array.isArray(evidence)) throw new Error('缺少有效的验收状态、实际表现或证据数组');
      if (status !== 'unverified' && (!session.lease || !evidence.length || !session.observations.size)) throw new Error('通过或失败都须取得设备占用、实际执行验收，并提供对应证据');
      const references = await Promise.all(evidence.map(path => evidenceReference(session, path)));
      session.signal.throwIfAborted();
      const result = {status, actual, evidence: [...new Set(references)], target: session.target,
        device: session.device?.id, sessionId: context.sessionID};
      const saved = session.results.get(id);
      if (saved && JSON.stringify(saved) !== JSON.stringify(result)) throw new Error('验收项已有结果：' + id);
      if (!saved) {
        session.results.set(id, result);
        session.task.checkProgress = {submitted: session.results.size, lastId: id};
        await session.onUpdate().catch(() => {});
      }
      return JSON.stringify({id, status, evidence: result.evidence});
    }
  })
};

function lockKey(device) {
  return device.trim().toLowerCase();
}

async function lockOwnerPid(path, device) {
  try {
    const owner = JSON.parse(await readFile(path, 'utf8'));
    if (typeof owner?.device === 'string' && lockKey(owner.device) === lockKey(device) &&
        Number.isInteger(owner.pid) && owner.pid > 0 && owner.pid <= 0x7fffffff) return owner.pid;
  } catch (error) {
    // Locks may disappear on release or be observed before their owner writes the record.
    if (error.code === 'ENOENT') return null;
  }
}

function ownerExited(pid) {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

export async function acquireDevice(device, signal, owner, onWait = () => {}) {
  const key = createHash('sha256').update(lockKey(device)).digest('hex');
  const path = join(tmpdir(), 'deveco-dag-device-' + key + '.lock');
  let waiting;
  for (;;) {
    signal.throwIfAborted();
    let file;
    try { file = await open(path, 'wx'); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = await lockOwnerPid(path, device);
      signal.throwIfAborted();
      if (pid === null) continue;
      if (ownerExited(pid)) {
        const stale = new Error(`设备 ${device} 被残留锁占用，OpenCode 进程 ${pid} 已退出。确认该设备无残留操作后，清理锁文件再重试：${path}`);
        stale.code = 'DAG_STALE_DEVICE_LOCK';
        throw stale;
      }
      if (!waiting || waiting.pid !== pid) {
        waiting = pid === undefined ? {device} : {device, pid};
        await onWait(waiting);
      }
      await delay(350, undefined, {signal});
      continue;
    }
    try { await file.writeFile(JSON.stringify({device, pid: process.pid, ...owner})); }
    catch (error) { await file.close(); await unlink(path); throw error; }
    return {path, async release(reusable) {
      await file.close();
      if (reusable) await unlink(path);
    }};
  }
}

function unwrap(response, message) {
  if (response.error || !response.data) throw new Error(message);
  return response.data;
}

async function openSession(client, root, parent, task, worktree, commit, signal) {
  const workspace = unwrap(await client._client.post({
    url: '/experimental/workspace', query: {directory: root}, signal,
    body: {type: 'dag-task', branch: commit, extra: {directory: worktree}}
  }), '无法为验收创建 Workspace');
  const query = {directory: worktree, workspace: workspace.id};
  const headers = {'x-opencode-directory': encodeURIComponent(worktree)};
  const session = unwrap(await client.session.create({
    query, headers, signal, body: {title: task.title, parentID: parent}
  }), '无法创建验收会话');
  unwrap(await client._client.post({url: '/sync/steal', query, headers, signal,
    body: {sessionID: session.id}}), '无法绑定验收 Workspace');
  const path = {id: session.id};
  const bound = unwrap(await client.session.get({path, query, headers, signal}), '无法核对验收 Workspace');
  if (bound.workspaceID !== workspace.id) throw new Error('验收会话未绑定到被测工作区');
  return {path, query, headers};
}

async function promptEvaluation(client, request, input, session, ownership) {
  const signal = session.signal;
  signal.throwIfAborted();
  const transport = new AbortController();
  let stopping, drainTimer;
  const stop = () => {
    if (stopping) return;
    drainTimer = setTimeout(() => transport.abort(new Error('等待验收会话退出超时')), 10000);
    stopping = Promise.resolve().then(() =>
      client.session.abort({...request, signal: AbortSignal.timeout(5000)})
    ).then(result => result.data === true && !result.error, () => false);
  };
  signal.addEventListener('abort', stop, {once: true});
  let returned = false;
  try {
    signal.throwIfAborted();
    const response = await client.session.prompt({...request, signal: transport.signal,
      body: {agent, parts: [{type: 'text', text: input}]}});
    returned = Boolean(response.data && !response.error);
    signal.throwIfAborted();
    const info = unwrap(response, '验收会话异常退出').info;
    if (info?.role !== 'assistant' || info.error || !info.time?.completed || !info.finish ||
        ['tool-calls', 'length', 'content-filter', 'error', 'unknown'].includes(info.finish)) throw new Error('验收会话未正常完成');
  } finally {
    signal.removeEventListener('abort', stop);
    if (signal.aborted || !returned) stop();
    if (stopping && (!(await stopping) || !returned)) ownership.reusable = false;
    clearTimeout(drainTimer);
  }
}

function unverified(task, actual) {
  return {status: 'unverified', actual, evidence: [], target: task.target, device: task.device, sessionId: task.session};
}

export function evaluationTasks(checklist, devices) {
  const groups = Map.groupBy(checklist.items, item => item.target);
  return [...groups].map(([target, items], index) => ({
    id: index + 1, title: '设备评测 · ' + target, target, items, itemCount: items.length,
    device: Object.hasOwn(devices, target) ? devices[target] : undefined,
    dependencies: [], status: 'pending'
  }));
}

export async function evaluate({
  root, client, parent, commit, checklist, round, directory, signal, timeoutMs = MAX_TIMEOUT_MS,
  onTask = () => {}, maxConcurrency = 20, tasks
}) {
  const reports = new Map();

  async function runTask(task) {
    signal.throwIfAborted();
    task.status = 'running';
    await onTask(task);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const lifetime = new AbortController();
    const ownership = {reusable: true};
    const owner = {commit, round, directory};
    let absentReason;
    let lease, worktree, workspaceCreated = false, session;
    try {
      if (task.device) {
        lease = await acquireDevice(task.device, deadline, owner, async waiting => {
          task.waitingDevice = waiting;
          await onTask(task);
        });
        delete task.waitingDevice;
      }
      const evidenceRoot = join(directory, 'evidence');
      await mkdir(evidenceRoot, {recursive: true});
      const evidenceDir = join(evidenceRoot, String(task.id));
      await mkdir(evidenceDir);
      const worktrees = join(directory, 'worktrees');
      await mkdir(worktrees, {recursive: true});
      worktree = join(await realpath(worktrees), 'device-' + task.id);
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)) throw new Error('无效的被测提交 SHA');
      // Do not interrupt Git between creating the worktree and recording its registration.
      deadline.throwIfAborted();
      await git(root, ['worktree', 'add', '--detach', worktree, commit]);
      workspaceCreated = true;
      const request = await openSession(client, root, parent, task, worktree, commit, deadline);
      task.session = request.path.id;
      await onTask(task);
      const actualEvidenceDir = await realpath(evidenceDir);
      const actualDirectory = await realpath(directory);
      if (!inside(actualDirectory, actualEvidenceDir)) throw new Error('证据目录必须位于本轮记录目录内');
      session = {signal: AbortSignal.any([deadline, lifetime.signal]), worktree, evidenceDir: actualEvidenceDir, directory: actualDirectory,
        target: task.target, device: task.device ? {id: task.device} : undefined, lease, task, owner, onUpdate: async () => onTask(task),
        items: new Set(task.items.map(item => item.id)),
        results: new Map(), observations: new Map(), sequence: 0};
      sessions.set(task.session, session);
      const prompt = [
        '设备类型：' + task.target,
        task.device ? '指定设备：' + task.device : '设备选择：按本任务的目标型号或屏幕形态，查找并申请占用匹配的实例。',
        '被测提交：' + commit,
        '工作目录：' + worktree, '证据目录：' + actualEvidenceDir,
        '本节点固定验收项：\n' + JSON.stringify(task.items, null, 2)
      ].join('\n');
      await promptEvaluation(client, request, prompt, session, ownership);
      if (await git(worktree, ['rev-parse', 'HEAD']) !== commit ||
          await git(worktree, ['status', '--porcelain', '--untracked-files=no'])) throw new Error('本轮验收工作区的被测提交或受版本控制的文件发生变化');
      for (const [id, report] of session.results) {
        try {
          await Promise.all(report.evidence.map(path => evidenceReference(session, relative(session.evidenceDir, join(session.directory, path)))));
          reports.set(id, report);
        } catch { reports.set(id, unverified(task, '验收结束时证据文件缺失或无效')); }
      }
    } catch (error) {
      if (error.code === 'DAG_STALE_DEVICE_LOCK') task.deviceLockError = error.message;
      absentReason = deadline.aborted && !signal.aborted ? '等待设备或验收超时' : error.message;
    } finally {
      lifetime.abort();
      await session?.reserving?.catch(() => {});
      lease ??= session?.lease;
      absentReason ??= task.deviceLockError ??
        (lease ? '验收会话未提交该项结果' : '验收会话未锁定与目标匹配的设备：' + task.target);
      if (!ownership.reusable && lease) absentReason += '；未确认会话停止，保留设备锁：' + lease.path;
      if (task.session) sessions.delete(task.session);
      if (workspaceCreated && ownership.reusable) {
        // A dirty worktree can contain debugging evidence. Leave it intact if Git refuses removal.
        try { await git(root, ['worktree', 'remove', worktree]); }
        catch { task.retainedWorktree = worktree; }
      }
      if (lease) {
        try { await lease.release(ownership.reusable); }
        catch (error) { task.cleanupError = '无法释放设备锁：' + error.message; }
      }
      for (const item of task.items) {
        if (!reports.has(item.id)) reports.set(item.id, unverified(task, absentReason));
      }
      task.status = signal.aborted ? 'cancelled' : 'done';
      task.finishedAt = Date.now();
      delete task.waitingDevice;
      await onTask(task);
    }
    signal.throwIfAborted();
  }

  await scheduleDag({tasks, maxConcurrency, signal, runTask});
  signal.throwIfAborted();
  return {
    checklistId: checklist.id, commit,
    results: Object.fromEntries(checklist.items.map(item => [
      item.id, reports.get(item.id) ?? {status: 'unverified', actual: '验收节点未执行', evidence: [], target: item.target}
    ]))
  };
}
