import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm, rename, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, join, resolve, relative, dirname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateDag } from '../src/dag.js';
import { git } from '../src/dag_run/git.js';
import { validateChecklist } from '../src/one-duo/contracts.js';
import { parseWorkerInput } from './worker-fixture.js';

const parentPath = join(tmpdir(), 'dag-execution-tests'); await mkdir(parentPath, { recursive: true });
const parent = await realpath(parentPath);
const testUx = process.env.DAG_TEST_UX === '1';
const resumeFrom = process.env.DAG_TEST_ONE_DUO_RESUME;
if (resumeFrom && !['planned', 'merged'].includes(resumeFrom)) throw new Error('DAG_TEST_ONE_DUO_RESUME 须为 planned 或 merged');
const testOneDuo = process.env.DAG_TEST_ONE_DUO === '1' || Boolean(resumeFrom);
const testDeviceOverride = process.env.DAG_TEST_ONE_DUO_DEVICE_OVERRIDE === '1';
const tuiSmoke = process.env.DAG_TUI_SMOKE === '1';
let uxRunReport;
const uxCards = JSON.parse(await readFile(new URL('../assets/ux/full-app-cards.json', import.meta.url), 'utf8'));
const uxIds = ['UX.APP.SHELL', 'UX.SHOP.GRID', 'UX.CAR.BROWSE', 'UX.WINDOW.CONTEXT.STATE'];
async function prepareUx(tasks) {
  if (!testUx) return;
  await writeFile(join(repo, '.dag/ux.json'), JSON.stringify({version: 1, cardsFile: 'ux-assets/cards.json', device: null,
    requirements: ['保留原有业务状态'], nodes: tasks.map(task => ({taskId: task.id, cardIds: [uxIds[task.id - 1]], requirements: []}))}));
}
const fixture = await mkdtemp(join(parent, 'run-')), repo = join(fixture, `repo-${basename(fixture)}`), remote = join(fixture, 'remote.git'), integrator = join(fixture, 'integrator');
await mkdir(repo); execFileSync('git', ['init', '-q', '-b', 'main', repo]);
for (const [key, value] of [['user.name', 'DAG fixture'], ['user.email', 'dag@example.invalid']]) await git(repo, ['config', key, value]);
await writeFile(join(repo, '.gitignore'), '.dag/\n'); await writeFile(join(repo, 'shared.txt'), 'base\n');
if (testUx) {await mkdir(join(repo, 'ux-assets')); await writeFile(join(repo, 'ux-assets/cards.json'), JSON.stringify(uxCards));}
await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'initial']);
await git(repo, ['clone', '--bare', repo, remote]); await git(repo, ['remote', 'add', 'origin', remote]);
await git(repo, ['push', '-u', 'origin', 'main']); await git(repo, ['clone', remote, integrator]);
for (const [key, value] of [['user.name', 'Integrator'], ['user.email', 'merge@example.invalid']]) await git(integrator, ['config', key, value]);
const initialCommit = await git(repo, ['rev-parse', 'HEAD']);
await writeFile(join(repo, 'remote-only.txt'), 'Old remote main content must not return after a local reset.\n');
await git(repo, ['add', 'remote-only.txt']); await git(repo, ['commit', '-qm', 'old work on remote main']);
const oldRemoteMain = await git(repo, ['rev-parse', 'HEAD']);
await git(repo, ['push', 'origin', 'main']);
await git(repo, ['reset', '--hard', initialCommit]);
const repositories = new Map(); let prCount = 0, injected = false, actualConflict = false;
const provider = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const part of req) raw += part; const body = raw ? JSON.parse(raw) : {};
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.method === 'GET' && req.url === '/api/v1/user') return send(200, {login: 'test'});
    if (req.method === 'POST' && req.url === '/api/v1/user/repos') {
      assert.equal(body.private, true); assert.equal(body.auto_init, false);
      if (repositories.has(body.name)) return send(409, {message: 'repository exists'});
      const remote = join(fixture, body.name + '.git');
      await git(repo, ['init', '--bare', remote]);
      await git(integrator, ['remote', 'add', body.name, remote]);
      const value = {name: body.name, owner: {login: 'test'}, clone_url: remote, html_url: `http://fixture/test/${body.name}`};
      repositories.set(body.name, {remote, gitRemote: body.name, prs: new Map(), value});
      return send(201, value);
    }
    const entry = repositories.get(req.url.match(/\/repos\/test\/([^/]+)\//)?.[1]);
    if (!entry) return send(404, {message: 'unknown run repository'});
    if (req.method === 'POST' && req.url.endsWith('/pulls')) {
      prCount++; const p = { number: entry.prs.size + 1, ...body, merged: false }; entry.prs.set(p.number, p); return send(201, p);
    }
    const match = req.url.match(/\/pulls\/(\d+)(\/merge)?$/); if (!match) return send(404, {});
    const pr = entry.prs.get(Number(match[1]));
    if (req.method === 'GET') return send(200, pr);
    await git(integrator, ['fetch', entry.gitRemote, pr.base]);
    await git(integrator, ['checkout', '-B', pr.base, `${entry.gitRemote}/${pr.base}`]);
    if (pr.head.endsWith('task-2') && !injected) {
      injected = true; await writeFile(join(integrator, 'shared.txt'), 'upstream change\n');
      await git(integrator, ['add', '.']); await git(integrator, ['commit', '-qm', 'upstream during node execution']);
      await git(integrator, ['push', entry.gitRemote, `HEAD:refs/heads/${pr.base}`]);
    }
    await git(integrator, ['fetch', entry.gitRemote, pr.head]);
    try { await git(integrator, ['merge', '--no-ff', '-m', 'merge PR', `${entry.gitRemote}/${pr.head}`]); }
    catch { actualConflict = true; await git(integrator, ['merge', '--abort']); return send(409, { message: 'merge failed because of conflict' }); }
    await git(integrator, ['push', entry.gitRemote, `HEAD:refs/heads/${pr.base}`]);
    pr.merged = true; pr.merge_commit_sha = await git(integrator, ['rev-parse', 'HEAD']); return send(200, pr);
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ message: error.message })); }
});
await new Promise(r => provider.listen(0, '127.0.0.1', r));
const tasks = [[], [1], [1], [2, 3]].map((dependencies, i) => ({ id: i + 1, title: `fixture-${i + 1}`, description: '开发测试文件', details: '按任务写文件并提交', testStrategy: '文件内容核对', dependencies }));
await mkdir(join(repo, '.dag'));
await writeFile(join(repo, '.dag/dag.json'), JSON.stringify({ tasks }));
await prepareUx(tasks);
await writeFile(join(repo, '.dag/runner.json'), JSON.stringify({ remote: 'origin', baseBranch: 'main', modelRequestsPerMinute: 600, gitea: { url: `http://127.0.0.1:${provider.address().port}`, owner: 'test', repo: 'fixture' } }));
const oneDuoRequirement = '这是直板屏的鸿蒙工程。请适配到以下设备：Pura X Max、三折叠，优化商城导航。';
const oneDuoTargets = ['Pura X Max', '三折叠'];
const oneDuoDevices = {
  'Pura X Max': `WideFold-${basename(fixture)}`,
  '三折叠': `TripleFold-${basename(fixture)}`
};
const oneDuoItems = [
  { id: 'MALL-PURA', target: 'Pura X Max', steps: ['打开商城'], expected: '保留商城分类与返回行为' },
  { id: 'MALL-TRIFOLD', target: '三折叠', steps: ['展开设备后打开商城'], expected: '宽屏内容不超出窗口' }
];
const trifoldFailure = '三折叠展开时右侧内容超出窗口';
const stoppedBeforeResume = '续跑测试的历史记录';
const oneDuoRuns = join(repo, '.dag/one-duo');
async function seedOneDuoCheckpoint(developmentSession) {
  const id = crypto.randomUUID(), dir = join(oneDuoRuns, id);
  const checklist = validateChecklist(oneDuoItems, oneDuoTargets);
  const dag = validateDag({tasks: [{...tasks[0], title: '开发商城适配'}]});
  const state = {id, status: 'cancelled', phase: 'finished', detail: stoppedBeforeResume, round: 1,
    requirement: oneDuoRequirement, targets: oneDuoTargets, initialCommit, branch: 'main', rounds: []};
  const writeJson = (path, data) => writeFile(path, JSON.stringify(data));
  await mkdir(dir, {recursive: true});
  if (resumeFrom === 'planned') {
    await writeJson(join(dir, 'plan.json'), {baseline: initialCommit, targets: oneDuoTargets, checklist, dag});
    await writeJson(join(dir, 'state.json'), state);
    return {id};
  }
  const directory = join(dir, 'round-1');
  const oldWorktree = join(directory, 'worktrees', 'device-1');
  const oldEvidence = join(directory, 'evidence', '1', 'old.txt');
  await writeFile(join(repo, 'mall.txt'), 'layout=broken\n');
  await git(repo, ['add', 'mall.txt']);
  await git(repo, ['commit', '-m', 'development checkpoint']);
  const commit = await git(repo, ['rev-parse', 'HEAD']);
  await mkdir(dirname(oldEvidence), {recursive: true});
  await writeFile(oldEvidence, '旧评测记录');
  await git(repo, ['worktree', 'add', '--detach', oldWorktree, commit]);
  const developmentWorktree = join(fixture, 'saved-developer-worktree');
  state.checklistId = checklist.id;
  state.checkCount = checklist.items.length;
  state.rounds = [{round: 1, baseCommit: initialCommit, change: 'done', commit, changeTasks: [
    {...dag.tasks[0], status: 'done', commit, mergeCommit: commit, pr: 1, session: developmentSession, worktree: developmentWorktree}
  ], evaluationTasks: []}];
  await Promise.all([
    writeJson(join(directory, 'inputs.json'), {requirement: state.requirement, targets: state.targets, baseline: initialCommit, checklist}),
    writeJson(join(directory, 'change-dag.json'), dag),
    writeJson(join(dir, 'checklist.json'), checklist)
  ]);
  await writeJson(join(dir, 'state.json'), state);
  return {id, commit, oldWorktree, oldEvidence};
}
const fixtureSkill = 'fixture-adaptive-qa';
const skillDirectory = join(fixture, 'config', 'opencode', 'skills', fixtureSkill);
const skillReference = join(skillDirectory, 'references', 'checks.md');
const childEnv = {...process.env};
if (testOneDuo) {
  if (testDeviceOverride) await writeFile(join(repo, '.dag/one-duo.json'), JSON.stringify({
    devices: {'Pura X Max': oneDuoDevices['Pura X Max']}
  }));
  const bin = join(fixture, 'bin');
  await mkdir(bin);
  await mkdir(dirname(skillReference), {recursive: true});
  await writeFile(join(skillDirectory, 'SKILL.md'), `---\nname: ${fixtureSkill}\ndescription: Supplemental adaptive layout checks.\n---\n# Fixture skill for adaptive layout\nRead references/checks.md for the fixture check.\n`);
  await writeFile(skillReference, '# Fixture reference for adaptive layout');
  const emulators = [
    {name: 'Phone', productModel: 'Pura X View', deviceType: 'phone', isRunning: 'false'},
    {name: oneDuoDevices['Pura X Max'], productModel: 'Pura X Max', deviceType: 'widefold', isRunning: 'true', 'hw.hdc.port': '41121'},
    {name: oneDuoDevices['三折叠'], deviceType: 'triplefold', isRunning: 'false'}
  ];
  const connected = [{name: oneDuoDevices['Pura X Max'], serial: '127.0.0.1:41121', kind: 'emulator', deviceType: 'widefold'}];
  const cliFixture = `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args === 'emulator list --details') console.log(JSON.stringify(${JSON.stringify(emulators)}));
else if (args === 'device list --format json') console.log(JSON.stringify(${JSON.stringify(connected)}));
else if (args === '--version') console.log('Fixture DevEco CLI 1.0');
else if (${JSON.stringify(Object.values(oneDuoDevices).map(id => `run --device ${id}`))}.includes(args)) console.log('Fixture launch: ' + args);
else { console.error('Unexpected fixture DevEco command'); process.exitCode = 2; }
`;
  await writeFile(join(bin, 'devecocli'), cliFixture, {mode: 0o755});
  if (process.platform === 'win32') {
    const cliPackage = join(bin, 'node_modules', '@deveco', 'deveco-cli');
    await mkdir(cliPackage, {recursive: true});
    await writeFile(join(cliPackage, 'package.json'), JSON.stringify({name: '@deveco/deveco-cli', bin: {devecocli: 'bin.cjs'}}));
    await writeFile(join(cliPackage, 'bin.cjs'), cliFixture);
    await writeFile(join(bin, 'devecocli.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0devecocli" %*\r\n`);
  }
  const pathKey = Object.keys(childEnv).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  childEnv[pathKey] = [bin, childEnv[pathKey]].filter(Boolean).join(delimiter);
}
const steps = new Map(), workerDirectories = new Map(), repairs = new Map(); let failure, completed = false, requestCount = 0;
const testRateLimit = process.env.DAG_TEST_RATE_LIMIT === '1';
let limitedRequests = 0, recoveredRateLimit = false;
const workerRequestTimes = [];
const progressSnapshots = [];
let holdWorker = false;
const heldWorkers = new Set(), stoppedWorkers = new Set(), parallelWorkers = new Set();
let releaseParallel;
const parallelBarrier = new Promise(resolve => releaseParallel = resolve);
const text = content => typeof content === 'string' ? content : (content ?? []).map(p => p.text ?? '').join('\n');
const call = (name, args) => ({ tool_calls: [{ id: 'call-' + Math.random().toString(36).slice(2), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function reply(res, value) {
  res.writeHead(200, { 'content-type': 'text/event-stream' }); const base = { id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'fake' };
  res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: value.tool_calls ? { role: 'assistant', tool_calls: value.tool_calls.map((t, index) => ({ ...t, index })) } : { role: 'assistant', content: value.content }, finish_reason: null }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: value.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\n'); res.end('data: [DONE]\n\n');
}
const assessment = new Map();
const trifoldReported = Promise.withResolvers();
let initialPlans = 0, repairPlans = 0, submittedChecklist = false;
let assertPlanningProgress;
async function waitForPeer(promise, description) {
  let timer;
  try {
    await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(description)), 12000);
      timer.unref();
    })]);
  } finally { clearTimeout(timer); }
}
async function oneDuoModel(body, names, res) {
  const input = body.messages.filter(message => message.role === 'user').map(message => text(message.content)).join('\n');
  const toolOutputs = body.messages.filter(message => message.role === 'tool').map(message => text(message.content));
  assert.ok(names.includes('skill') && names.includes('devecocli'), '所有节点均应接收 Skill 和 DevEco CLI 工具');
  if (!toolOutputs.length) return reply(res, call('skill', {name: fixtureSkill}));
  assert.match(toolOutputs[0], /Fixture skill for adaptive layout/);
  if (toolOutputs.length === 1) return reply(res, call('read', {filePath: skillReference}));
  assert.match(toolOutputs[1], /Fixture reference for adaptive layout/);
  if (toolOutputs.length === 2) return reply(res, call('devecocli', {args: ['--version']}));
  assert.match(toolOutputs[2], /Fixture DevEco CLI 1\.0/);
  assert.doesNotMatch(toolOutputs[2], /observation:/, '工具版本不能用作设备验收证据');
  const outputs = toolOutputs.slice(3);
  if (names.includes('submit_plan')) {
    assert.ok(!names.includes('submit_task') && !names.includes('bash'), '规划会话不应开发或启动设备');
    const repair = input.includes('阶段：修复规划');
    assert.ok(repair || input.includes('阶段：首次开发规划'));
    if (resumeFrom) assert.ok(repair, '续跑不得重新执行首次规划');
    assert.ok(input.includes(oneDuoRequirement), '规划必须收到原始自然语言需求');
    if (repair) {
      assert.ok(input.includes(trifoldFailure), '失败报告必须进入修复规划');
      assert.match(input, /"reportPath": "[^"]*round-1[/\\]+results\.json"/);
      const [baseline] = assessment.keys();
      assert.ok(baseline && input.includes(baseline), '修复必须针对已评测提交');
      if (!outputs.length) await assertPlanningProgress(2, {tool: 'devecocli'});
      if (names.includes('submit_checklist') && !outputs.length) {
        return reply(res, call('submit_checklist', { items: oneDuoItems.map(item => ({ ...item, expected: '试图替换首轮验收条件' })) }));
      }
      const rejectedMutation = names.includes('submit_checklist') ? 1 : 0;
      if (outputs.length === rejectedMutation) {
        if (rejectedMutation) assert.match(outputs[0], /只允许在初次规划时提交/);
        repairPlans++;
        return reply(res, call('submit_plan', { tasks: [{ ...tasks[0], title: '修复宽屏内容溢出', details: '处理验收项 MALL-TRIFOLD' }] }));
      }
      await assertPlanningProgress(2, {taskCount: 1});
      return reply(res, { content: '修复任务已规划' });
    }
    if (!outputs.length) {
      assert.ok(names.includes('submit_checklist'));
      assert.ok(oneDuoTargets.every(target => input.includes(target)), '用户指定的目标必须进入规划');
      initialPlans++;
      const extraTarget = { id: 'MALL-EXTRA', target: '额外平板', steps: ['打开商城'], expected: '商城可访问' };
      return reply(res, call('submit_checklist', {
        targets: [...oneDuoTargets, extraTarget.target], items: [...oneDuoItems, extraTarget]
      }));
    }
    if (outputs.length === 1) {
      assert.match(outputs[0], /目标设备须使用用户原文中的名称/);
      return reply(res, call('submit_checklist', { targets: oneDuoTargets, items: oneDuoItems }));
    }
    if (outputs.length === 2) {
      submittedChecklist = true;
      await assertPlanningProgress(1, {checkCount: oneDuoItems.length});
      return reply(res, call('submit_plan', { tasks: [{ ...tasks[0], title: '开发商城适配' }] }));
    }
    return reply(res, { content: '开发任务和验收清单已规划' });
  }
  if (names.includes('record_check_result')) {
    assert.ok(!names.includes('submit_task') && !names.includes('write'), '评测会话不应通过开发工具提交代码');
    const commit = input.match(/被测提交：([a-f0-9]{40,64})/)?.[1];
    const target = input.match(/设备类型：([^\r\n]+)/)?.[1]?.trim();
    const worktree = input.match(/工作目录：([^\r\n]+)/)?.[1]?.trim();
    const item = oneDuoItems.find(item => item.target === target);
    assert.ok(commit && item && worktree, '评测会话须绑定设备目标、提交及工作区');
    assert.ok(input.includes(item.id));
    const peer = oneDuoItems.find(candidate => candidate.target !== target);
    assert.ok(!peer || !input.includes(peer.id), '节点只收到自己负责的验收项');
    if (!assessment.has(commit)) assessment.set(commit, { targets: new Set(), worktrees: new Map(), started: Promise.withResolvers() });
    const review = assessment.get(commit);
    const round = [...assessment.keys()].indexOf(commit) + 1;
    assert.ok(round <= 2, '首次失败后只应修复并复测一次');
    const configuredDevice = testDeviceOverride && target === 'Pura X Max';
    if (configuredDevice) {
      assert.ok(input.includes('指定设备：' + oneDuoDevices[target]), '显式设备映射应保留优先级');
    } else {
      assert.ok(names.includes('list_evaluation_devices') && names.includes('reserve_evaluation_device'), '评测节点须可自行选择设备');
      if (!outputs.length) return reply(res, call('list_evaluation_devices', {}));
      const inventory = JSON.parse(outputs[0]);
      assert.equal(inventory.target, target);
      const matches = inventory.devices.filter(device => target === 'Pura X Max'
        ? device.model === target : device.deviceType === 'triplefold');
      assert.deepEqual(matches.map(device => device.id), [oneDuoDevices[target]], '从实机清单按型号或形态选择唯一实例');
      assert.equal(inventory.devices.filter(device => device.serial === '127.0.0.1:41121').length, 1, '运行中的模拟器只应被列出一次');
      if (outputs.length === 1) return reply(res, call('reserve_evaluation_device', {device: matches[0].id}));
      assert.equal(JSON.parse(outputs[1]).id, oneDuoDevices[target], '占用确认应返回设备实例的稳定标识');
    }
    const observations = configuredDevice ? outputs : outputs.slice(2);
    if (!observations.length) {
      review.targets.add(target);
      review.worktrees.set(target, worktree);
      if (review.targets.size === 2) review.started.resolve();
      await waitForPeer(review.started.promise, '两个独立设备节点没有并行取得设备并进入评测');
      return reply(res, call('bash', { command: 'git rev-parse HEAD --show-toplevel', description: '核对实际被测提交和工作树' }));
    }
    assert.ok(observations[0].includes(commit), '评测 worktree 的真实 HEAD 须与输入一致');
    assert.ok(observations[0].split(/\r?\n/).some(line => line && relative(worktree, line) === ''), '评测工具的实际 Git 工作树须与分配路径一致');
    if (observations.length === 1) return reply(res, call('bash', { command: 'git show HEAD:mall.txt', description: '核对集成版本的测试数据' }));
    assert.match(observations[1], round === 1 ? /layout=broken/ : /layout=fixed/);
    if (observations.length === 2) return reply(res, call('devecocli', {args: ['run', '--device', oneDuoDevices[target]]}));
    assert.ok(observations[2].includes('Fixture launch: run --device ' + oneDuoDevices[target]));
    if (observations.length === 3) {
      const failed = round === 1 && target === '三折叠';
      if (round === 1 && target === 'Pura X Max') await waitForPeer(trifoldReported.promise, 'Pura X Max 评测须能等待三折叠缺陷先完成提交');
      const evidence = observations.map(output => output.match(/observation:[A-Za-z0-9_-]+/)?.[0]);
      assert.ok(evidence.every(Boolean), '评测现场命令应返回可引用的证据编号');
      return reply(res, call('record_check_result', {
        id: item.id, status: failed ? 'failed' : 'passed', actual: failed ? trifoldFailure : item.expected, evidence
      }));
    }
    const [workflowId] = relative(oneDuoRuns, worktree).split(sep);
    const state = JSON.parse(await readFile(join(oneDuoRuns, workflowId, 'state.json'), 'utf8'));
    const evaluation = state.rounds.at(-1).evaluationTasks.find(task => task.target === target);
    assert.equal(evaluation.status, 'running', '评测结束前即更新节点进度');
    assert.deepEqual(evaluation.checkProgress, {submitted: 1, lastId: item.id});
    assert.equal(evaluation.activity?.tool, 'devecocli');
    assert.ok(evaluation.activity?.finishedAt >= evaluation.activity?.startedAt, '最近完成的工具须记录起止时间');
    if (round === 1 && target === '三折叠') trifoldReported.resolve();
    return reply(res, { content: '评测结果已提交' });
  }
  assert.ok(names.includes('submit_task'), '工作流本轮缺少预期的 Agent 工具');
  if (resumeFrom === 'merged') assert.ok(repairPlans > 0, '续跑已合并断点不得重新执行首次开发');
  const request = body.messages.filter(message => message.role === 'user').map(message => text(message.content)).findLast(content => /^任务 \d+：/m.test(content));
  const { worktree } = parseWorkerInput(request);
  assert.ok(oneDuoTargets.every(target => request.includes(target)));
  assert.ok(!request.includes(oneDuoRequirement) && !request.includes(oneDuoItems[0].id));
  if (repairPlans) {
    assert.ok(request.includes(trifoldFailure) && request.includes(oneDuoItems[1].steps[0]));
    assert.match(request, /评测报告：[^\r\n]*round-1[/\\]+results\.json/);
  } else assert.ok(!request.includes(oneDuoItems[1].id));
  const contents = repairPlans ? 'layout=fixed\n' : 'layout=broken\n';
  const operations = [
    call('write', { filePath: join(worktree, 'mall.txt'), content: contents }),
    call('git', { args: ['add', 'mall.txt'] }),
    call('git', { args: ['commit', '-m', repairPlans ? 'fix tri-fold layout' : 'develop mall layout'] }),
    call('submit_task', { summary: '变更和本地检查完成' })
  ];
  if (outputs.length < operations.length) return reply(res, operations[outputs.length]);
  assert.match(outputs[3], /merged/);
  return reply(res, { content: '本轮代码已合入' });
}
const model = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const part of req) raw += part; const body = JSON.parse(raw), names = body.tools?.map(t => t.function.name) ?? [];
    requestCount++; if (requestCount > (testOneDuo ? 100 : 65)) throw new Error('测试模型检测到异常循环');
    assert.ok(!names.includes('dag_next'), '模型不应看到 dag_next 工具');
    if (testOneDuo && names.some(name => ['submit_plan', 'record_check_result', 'submit_task'].includes(name))) {
      return await oneDuoModel(body, names, res);
    }
    if (!names.includes('submit_task')) return reply(res, { content: 'DAG runner test' });
    workerRequestTimes.push(Date.now());
    const originalTask = body.messages.filter(m => m.role === 'user').map(m => text(m.content)).findLast(content => /^任务 \d+：/m.test(content));
    const input = parseWorkerInput(originalTask), id = input.id, cwd = input.worktree;
    if (testUx) {
      const packet = originalTask.split('本节点 UX 资产（本次分配优先于 Fork 历史中的其他节点资产）\n')[1];
      assert.ok(packet, '实际模型请求必须收到 UX 资产');
      const ux = JSON.parse(packet.split('\n先阅读本节点卡片')[0]);
      assert.deepEqual(ux.cardIds, [uxIds[id - 1]]);
      assert.deepEqual(ux.cards, [uxCards.cards.find(card => card.id === uxIds[id - 1])]);
      assert.equal(ux.reason, 'no-device');
    }
    if (holdWorker) {
      heldWorkers.add(id);
      await new Promise(resolve => res.once('close', resolve));
      stoppedWorkers.add(id);
      return;
    }
    if ((id === 2 || id === 3) && !steps.has(id)) {
      parallelWorkers.add(id);
      if (parallelWorkers.size === 2) releaseParallel();
      await Promise.race([parallelBarrier, new Promise((_, reject) => {const timer = setTimeout(() => reject(new Error('节点 2、3 未同时进入模型执行')), 25000); timer.unref();})]);
    }
    if (!workerDirectories.has(id)) await assert.rejects(readFile(join(cwd, 'remote-only.txt')), {code: 'ENOENT'});
    workerDirectories.set(id, cwd);
    const file = join(cwd, id === 2 ? 'shared.txt' : `node-${id}.txt`);
    if (testRateLimit && id === 2 && steps.get(id) === 2 && !recoveredRateLimit) {
      const [runId] = await readdir(join(repo, '.dag/runs'));
      const current = JSON.parse(await readFile(join(repo, '.dag/runs', runId, 'state.json'), 'utf8'));
      if (!current.tasks[1].retry?.attempt) {
        limitedRequests++;
        res.writeHead(429, {'content-type': 'application/json', 'retry-after-ms': '1'});
        res.end(JSON.stringify({error: {message: 'Fixture rate limit', type: 'rate_limit_error'}}));
        return;
      }
      recoveredRateLimit = true;
    }
    const n = steps.get(id) ?? 0; steps.set(id, n + 1);
    if (n === 4 && id === 2) {
      const result = JSON.parse(text(body.messages.at(-1).content));
      assert.equal(result.status, 'conflict', '冲突必须原样反馈给同一个Agent');
      assert.equal(result.repairCommands.length, 2, '冲突发生时才提供本轮修复命令');
      repairs.set(id, result.repairCommands);
    }
    const operations = [call('write', { filePath: file, content: `node ${id} in ${cwd}\n` }), call('git', { args: ['add', '.'] }), call('git', { args: ['commit', '-m', `task ${id}`] }), call('submit_task', { summary: `任务 ${id}，测试文件已核对` })];
    if (id === 2) operations.push(call('git', { args: repairs.get(id)?.[0] ?? [] }),
      call('git', { args: repairs.get(id)?.[1] ?? [] }), call('write', { filePath: file, content: 'node 2 and upstream reconciled\n' }), call('git', { args: ['add', '.'] }), call('git', { args: ['commit', '-m', 'resolve conflict'] }), call('submit_task', { summary: '冲突已修复，重新验证文件内容' }));
    if (n < operations.length) return reply(res, operations[n]);
    assert.ok(text(body.messages.at(-1).content).includes('merged'), text(body.messages.at(-1).content));
    reply(res, { content: `任务 ${id} 提交并合入完成。` });
  } catch (error) { failure = error; res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })); }
});
await new Promise(r => model.listen(0, '127.0.0.1', r));
const config = { plugin: [pathToFileURL(resolve(process.env.DAG_PLUGIN_PATH ?? 'src/plugin.js')).href], model: 'fixture/fake', small_model: 'fixture/fake', enabled_providers: ['fixture'], autoupdate: false,
 provider: { fixture: { name: 'test', npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture' }, models: { fake: { name: 'fake', limit: { context: 64000, output: 4000 } } } } } };
const child = spawn(process.env.OPENCODE_BIN ?? 'D:\\APP\\node_js\\node_modules\\opencode-ai\\bin\\opencode.exe', ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...childEnv,
  XDG_CONFIG_HOME: join(fixture, 'config'), XDG_DATA_HOME: join(fixture, 'data'), XDG_STATE_HOME: join(fixture, 'state'), XDG_CACHE_HOME: join(fixture, 'cache'), OPENCODE_CONFIG_DIR: join(fixture, 'config/opencode'),
  OPENCODE_EXPERIMENTAL_WORKSPACES: 'true', OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_SERVER_PASSWORD: 'fixture-password', OPENCODE_SERVER_USERNAME: 'fixture', GITEA_TOKEN: 'fixture-token' } });
let logs = ''; child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
async function verify() {
  let origin; for (let i = 0; i < 600; i++) { origin = logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (origin) break; await new Promise(r => setTimeout(r, 50)); }
  assert.ok(origin, logs.slice(-1000));
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(origin + path + '?directory=' + encodeURIComponent(repo), { method, headers: { authorization: 'Basic ' + Buffer.from('fixture:fixture-password').toString('base64'), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90000) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  };
  const control = (sessionID, action) => api(`/session/${sessionID}/message`, 'POST', {noReply: true,
    parts: [{type: 'text', synthetic: true, ignored: true, text: action === 'resume-one-duo' ? '/one_duo_resume' : '/dag_run',
      metadata: {dagControl: {action, root: repo, requestId: crypto.randomUUID(), issuedAt: Date.now()}}}]});
  async function until(read, condition, timeout = 90000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await read(); if (condition(value)) return value; await new Promise(r => setTimeout(r, 100)); }
    throw new Error('等待 DAG 自动执行超时');
  }
  async function holdForTui(sessionID) {
    if (!tuiSmoke) return;
    const configDir = join(fixture, 'config', 'opencode');
    await mkdir(configDir, {recursive: true});
    const plugin = pathToFileURL(resolve('dist/tui.js')).href;
    await writeFile(join(configDir, 'tui.json'), JSON.stringify({plugin: [plugin]}));
    console.log(JSON.stringify({tuiFixture: fixture, configDir, repo, origin, sessionID}));
    await until(() => readFile(join(fixture, 'ui.done')).then(() => true, () => false), Boolean, 300000);
  }
  if (testOneDuo) {
    if (!testDeviceOverride) await assert.rejects(readFile(join(repo, '.dag/one-duo.json')), {code: 'ENOENT'});
    const source = await api('/session', 'POST', { title: 'One Duo end-to-end fixture' });
    const planningSessions = new Map();
    assertPlanningProgress = async (round, {tool, taskCount, checkCount}) => {
      const readPlanning = async () => {
        const messages = await api(`/session/${source.id}/message`);
        return messages.flatMap(message => message.parts).find(part => part.metadata?.dagView?.workflow)?.metadata.dagView.workflow.planning;
      };
      const planner = await until(readPlanning, plan => plan?.round === round && plan.status === 'running' && !!plan.session &&
        (!tool || plan.activity?.tool === tool && plan.activity.finishedAt >= plan.activity.startedAt) &&
        (taskCount === undefined || plan.taskCount === taskCount) && (checkCount === undefined || plan.checkCount === checkCount), 12000);
      const previous = planningSessions.get(round);
      if (previous) assert.equal(planner.session, previous, '同阶段的进度必须绑定同一个规划会话');
      planningSessions.set(round, planner.session);
      if (round === 1) assert.equal(planner.session, source.id);
      else assert.equal((await api(`/session/${planner.session}`)).parentID, source.id, '看板须链接实际修复规划子会话');
    };
    let seed;
    if (resumeFrom) {
      const oldWorker = resumeFrom === 'merged' ? await api('/session', 'POST', {title: '已完成的历史开发节点'}) : undefined;
      seed = await seedOneDuoCheckpoint(oldWorker?.id);
      await control(source.id, 'resume-one-duo');
    } else await api(`/session/${source.id}/command`, 'POST', { command: 'one_duo', arguments: oneDuoRequirement });
    const [id] = await until(() => readdir(oneDuoRuns).catch(() => []), entries => entries.length === 1);
    if (seed) assert.equal(id, seed.id, '续跑沿用原工作流目录');
    const dir = join(oneDuoRuns, id);
    const state = await until(async () => {
      if (failure) throw failure;
      try { return JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')); }
      catch { return undefined; }
    }, value => value && value.detail !== stoppedBeforeResume && ['done', 'paused', 'failed', 'cancelled'].includes(value.status), 45000);
    assert.equal(state.status, 'done', JSON.stringify(state, null, 2));
    assert.equal(initialPlans, resumeFrom ? 0 : 1);
    assert.equal(repairPlans, 1);
    assert.equal(submittedChecklist, !resumeFrom);
    assert.equal(prCount, resumeFrom === 'merged' ? 1 : 2, '已合并断点只为新修复创建 PR，评测交报告');
    if (resumeFrom === 'merged') assert.equal(repositories.size, 1, '续跑不为已合并的开发创建仓库');
    assert.equal(state.rounds.length, 2);
    assert.deepEqual(state.targets, oneDuoTargets, '提取目标名称时不应将来源直板屏加入评测范围');
    const checklist = JSON.parse(await readFile(join(dir, 'checklist.json'), 'utf8'));
    assert.deepEqual(checklist.items, oneDuoItems);
    const report = async round => JSON.parse(await readFile(join(dir, `round-${round}`, 'results.json'), 'utf8'));
    const first = await report(1), second = await report(2);
    if (seed?.oldEvidence) {
      assert.equal(first.commit, seed.commit, '从已合并的代码提交直接进入评测');
      assert.equal(await readFile(seed.oldEvidence, 'utf8'), '旧评测记录');
      assert.equal(await git(seed.oldWorktree, ['rev-parse', 'HEAD']), seed.commit, '保留原评测工作树');
      assert.ok(Object.values(first.results).every(result => result.evidence.length &&
        result.evidence.every(path => path.startsWith('evaluation-attempts/'))));
    }
    const statuses = result => Object.fromEntries(Object.entries(result.results).map(([id, value]) => [id, value.status]));
    assert.deepEqual(statuses(first), { 'MALL-PURA': 'passed', 'MALL-TRIFOLD': 'failed' });
    assert.deepEqual(statuses(second), { 'MALL-PURA': 'passed', 'MALL-TRIFOLD': 'passed' });
    assert.equal(first.checklistId, checklist.id);
    assert.equal(second.checklistId, checklist.id);
    assert.equal(first.commit, state.rounds[0].commit);
    assert.equal(second.commit, state.rounds[1].commit);
    assert.equal(state.rounds[1].baseCommit, first.commit, '修复必须从有缺陷的评测提交开始');
    const worktrees = state.rounds.flatMap(round => [
      ...round.changeTasks.map(task => task.worktree), ...assessment.get(round.commit).worktrees.values()
    ]);
    assert.equal(worktrees.length, 6);
    assert.ok(worktrees.every(path => path && path !== repo), '开发、修复和评测任务不能使用主工作树');
    assert.equal(new Set(worktrees).size, worktrees.length, '各节点和轮次必须使用独立工作树');
    const repairInput = JSON.parse(await readFile(join(dir, 'round-2', 'inputs.json'), 'utf8'));
    assert.equal(repairInput.baseline, first.commit);
    assert.deepEqual(JSON.parse(await readFile(repairInput.reportPath, 'utf8')), first);
    assert.notEqual(first.commit, second.commit);
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), second.commit);
    for (const [round, result] of [first, second].entries()) {
      for (const item of Object.values(result.results)) {
        assert.equal(item.device, oneDuoDevices[item.target], '评测结果须记录实际占用的设备');
        const evidence = await Promise.all(item.evidence.map(path => readFile(join(dir, `round-${round + 1}`, path), 'utf8')));
        assert.ok(evidence.some(value => value.includes(result.commit)), '报告证据必须能追溯至被测提交');
        assert.ok(evidence.some(value => value.includes(round === 0 ? 'layout=broken' : 'layout=fixed')));
        assert.ok(evidence.some(value => JSON.parse(value).command === 'devecocli run --device ' + item.device), '评测报告须保留实际运行的 DevEco CLI 命令');
      }
    }
    const finalView = await until(async () => {
      const messages = await api(`/session/${source.id}/message`);
      return messages.flatMap(message => message.parts).find(part => part.metadata?.dagView?.status === 'done')?.metadata.dagView;
    }, Boolean);
    assert.deepEqual(finalView.workflow.targets, oneDuoTargets);
    assert.equal(finalView.workflow.checkCount, checklist.items.length);
    assert.deepEqual(finalView.workflow.rounds.map(round => round.result.action), ['repair', 'finish']);
    const repairPlanning = finalView.workflow.rounds[1].planning;
    assert.equal(repairPlanning?.status, 'done');
    assert.equal(repairPlanning.session, planningSessions.get(2));
    assert.equal(repairPlanning.taskCount, 1);
    if (!resumeFrom) {
      const initialPlanning = finalView.workflow.rounds[0].planning;
      assert.equal(initialPlanning?.status, 'done');
      assert.equal(initialPlanning.session, source.id);
      assert.equal(initialPlanning.taskCount, 1);
      assert.equal(initialPlanning.checkCount, checklist.items.length);
    }
    for (const round of finalView.workflow.rounds) {
      assert.equal(round.changeTasks.length, 1);
      assert.ok(round.changeTasks[0].session);
      assert.deepEqual(round.evaluationTasks.map(task => task.target).sort(), oneDuoTargets);
      assert.ok(round.evaluationTasks.every(task => task.session && task.status === 'done'));
      assert.ok(round.evaluationTasks.every(task => task.device === oneDuoDevices[task.target]), '面板应显示每个节点占用的设备');
      assert.ok(round.evaluationTasks.every(task => task.checkProgress?.submitted === task.itemCount), '面板快照保留各设备已提交项数量');
    }
    for (const entry of assessment.values()) assert.deepEqual([...entry.targets].sort(), oneDuoTargets);
    await until(async () => {
      try { await readFile(join(repo, '.dag/run.lock')); return false; }
      catch (error) { return error.code === 'ENOENT'; }
    }, Boolean);
    console.log(JSON.stringify({ one_duo_passed: true, natural_language_targets: state.targets, native_opencode: true, real_git: true, mock_device_checks: true,
      device_sessions_parallel: true, isolated_worktrees: worktrees.length, device_discovery: true, configured_device_override: testDeviceOverride,
      failed_report_triggered_repair: true, same_checklist: true, rounds: 2, ...(resumeFrom && {resumed_from: resumeFrom}) }));
    await holdForTui(source.id);
    return;
  }
  const failedSource = await api('/session', 'POST', { title: 'DAG preflight error fixture' });
  await rename(join(repo, '.dag/dag.json'), join(repo, '.dag/dag.saved.json'));
  let diagnostics;
  try {
    await control(failedSource.id, 'start');
    diagnostics = await until(async () => (await api(`/session/${failedSource.id}/message`)).flatMap(m => m.parts),
      parts => parts.some(p => p.metadata?.dagProgress && /启动失败/.test(p.text)));
  }
  finally { await rename(join(repo, '.dag/dag.saved.json'), join(repo, '.dag/dag.json')); }
  assert.ok(diagnostics.some(p => p.metadata?.dagProgress && /启动失败/.test(p.text) && /不存在 .dag\/dag.json/.test(p.text)), '启动失败也应持久化显示，不得只有日志');
  const source = await api('/session', 'POST', { title: 'DAG execution fixture' });
  // Observe the same native message events consumed by the TUI while command is pending.
  const eventAbort = new AbortController();
  const eventResponse = await fetch(origin + '/event?directory=' + encodeURIComponent(repo), {
    headers: {authorization: 'Basic ' + Buffer.from('fixture:fixture-password').toString('base64')}, signal: eventAbort.signal });
  const events = (async () => {
    let buffer = '';
    try { for await (const bytes of eventResponse.body) {
      buffer += new TextDecoder().decode(bytes);
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        for (const line of frame.split('\n')) if (line.startsWith('data:')) {
          const event = JSON.parse(line.slice(5)), part = event.properties?.part;
          if (part?.metadata?.dagProgress && part.sessionID === source.id) progressSnapshots.push(part.text);
        }
      }
    } } catch (error) { if (!eventAbort.signal.aborted) throw error; }
  })();
  try {
    await control(source.id, 'start');
    await until(async () => {
      try { const [id] = await readdir(join(repo, '.dag/runs')); return JSON.parse(await readFile(join(repo, '.dag/runs', id, 'state.json'), 'utf8')); }
      catch { return null; }
    }, state => state && state.status !== 'running');
    await until(async () => (await api(`/session/${source.id}/message`)).flatMap(m => m.parts),
      parts => parts.some(p => p.metadata?.dagView?.status === 'done'));
  } finally { eventAbort.abort(); await events; }
  if (failure) throw failure;
  const [runId] = await readdir(join(repo, '.dag/runs')); const state = JSON.parse(await readFile(join(repo, '.dag/runs', runId, 'state.json'), 'utf8'));
  assert.equal(state.status, 'done', JSON.stringify(state.tasks.map(t => ({ id: t.id, status: t.status, error: t.error }))));
  if (testUx) {
    const report = JSON.parse(await readFile(join(repo, '.dag/runs', runId, 'ux-report.json'), 'utf8'));
    assert.equal(report.delivery, 'partial'); assert.equal(report.acceptance, 'unverified');
    assert.equal(report.reason, 'no-device'); assert.ok(report.tasks.every(task => task.execution === 'done'));
    await readFile(join(repo, '.dag/runs', runId, 'ux-input.json'));
    uxRunReport = report;
    console.log(JSON.stringify({ux_assets_in_real_model_requests: true, no_device_dag_completed: true, ux_acceptance: report.acceptance, delivery: report.delivery}));
  }
  assert.ok(actualConflict); assert.equal(prCount, 4); assert.equal(workerDirectories.size, 4);
  assert.equal(state.initialCommit, initialCommit);
  assert.equal(state.maxConcurrency, 20);
  if (testRateLimit) {
    assert.ok(limitedRequests >= 1); assert.ok(recoveredRateLimit);
    assert.ok(state.tasks[1].retry.attempt >= 1);
    const history = await api(`/session/${state.tasks[1].session}/message`);
    assert.equal(history.flatMap(message => message.parts).filter(part => part.type === 'tool' && part.tool === 'write' &&
      part.state.input?.filePath?.replaceAll('\\', '/').endsWith('/shared.txt')).length, 2,
      '首次开发与冲突修复各写一次，429 不能从头重复工具');
    assert.ok(progressSnapshots.some(text => /限流 429/.test(text)));
    assert.ok(workerRequestTimes.slice(1).every((time, index) => time - workerRequestTimes[index] >= 80),
      '原生模型调用也必须经过共享 RPM 队列（测试设置每 100ms 一次）');
    console.log(JSON.stringify({rateLimitRecovered: true, sameSessionAndWorktree: true, noRepeatedDevelopment: true, siblingsCompleted: true, limitedRequests}));
  }
  assert.equal(state.localBranch, 'main');
  assert.equal(state.integrationBranch, `dag/${runId}/integration`);
  const firstRepository = repositories.get(state.gitea.repo);
  assert.ok([...firstRepository.prs.values()].every(pr => pr.base === state.integrationBranch));
  assert.equal(state.tasks[0].pr, 1);
  assert.equal(await git(remote, ['rev-parse', 'refs/heads/main']), oldRemoteMain, '远端旧 main 不得被修改');
  assert.equal(await git(repo, ['rev-parse', 'HEAD']), await git(firstRepository.remote, ['rev-parse', `refs/heads/${state.integrationBranch}`]));
  assert.equal(await git(repo, ['remote', 'get-url', 'origin']), remote);
  await assert.rejects(readFile(join(repo, 'remote-only.txt')), {code: 'ENOENT'});
  await assert.rejects(git(repo, ['merge-base', '--is-ancestor', oldRemoteMain, 'HEAD']), '旧远端提交不得进入本轮历史');
  assert.equal(state.tasks[1].forkedFrom, state.tasks[0].session); assert.equal(state.tasks[2].forkedFrom, state.tasks[0].session); assert.equal(state.tasks[3].forkedFrom, null);
  assert.equal(parallelWorkers.size, 2);
  assert.ok(state.tasks[1].startedAt < state.tasks[2].finishedAt && state.tasks[2].startedAt < state.tasks[1].finishedAt);
  assert.ok(state.tasks[3].startedAt >= Math.max(state.tasks[1].finishedAt, state.tasks[2].finishedAt));
  for (const task of state.tasks) { assert.equal(task.status, 'done'); assert.equal(await git(task.worktree, ['branch', '--show-current']), task.branch); }
  assert.equal((await readFile(join(repo, 'shared.txt'), 'utf8')).trim(), 'node 2 and upstream reconciled');
  const messages = await api(`/session/${source.id}/message`);
  const progress = messages.flatMap(m => m.parts).filter(p => p.metadata?.dagProgress);
  assert.equal(progress.length, 1, '进度应更新同一消息，不刷屏');
  assert.equal(progress[0].ignored, true); assert.match(progress[0].text, /所有节点已完成/);
  assert.equal(progress[0].synthetic, true);
  assert.equal(messages.flatMap(m => m.parts).filter(p => p.type === 'text' && !p.synthetic).length, 0, '主聊天不得显示控制命令或状态块');
  const handled = messages.flatMap(m => m.parts).find(p => p.metadata?.dagControl);
  assert.equal(handled.metadata.dagControlHandled, true);
  await api(`/session/${source.id}/message/${handled.messageID}/part/${handled.id}`, 'PATCH', {...handled, synthetic: true});
  assert.ok(progressSnapshots.some(text => /执行中/.test(text) && /git/.test(text)), 'TUI 应收到节点执行期间的原生进度事件');
  assert.ok(progressSnapshots.some(text => /conflict/.test(text)), '冲突应显示在进度中');
  console.log(JSON.stringify({ passed: true, tasks: 4, real_opencode: true, real_git: true, mock_gitea_api: true, local_reset_respected: true,
    old_remote_main_unchanged: true, all_prs_target_run_branch: true, fork_directory_verified: true, conflict_repaired: true, concurrent_forks_2_and_3: true, join_waits_for_both: true, progress_events: progressSnapshots.length, requests: requestCount }));
  await holdForTui(source.id);
  // A second successful /dag_run creates another repository and PR #1, without
  // clearing the first run's records or resetting already-merged local code.
  const nextBaseline = await git(repo, ['rev-parse', 'HEAD']);
  steps.clear(); workerDirectories.clear();
  await writeFile(join(repo, '.dag/dag.json'), JSON.stringify({tasks: [tasks[0]]}));
  await prepareUx([tasks[0]]);
  const secondSource = await api('/session', 'POST', {title: 'DAG independent repository fixture'});
  await control(secondSource.id, 'start');
  const secondParts = await until(async () => (await api(`/session/${secondSource.id}/message`)).flatMap(m => m.parts),
    parts => parts.some(p => p.metadata?.dagView?.status === 'done' || p.metadata?.dagView?.status === 'failed'));
  const secondView = secondParts.find(p => p.metadata?.dagView)?.metadata.dagView;
  const secondState = JSON.parse(await readFile(join(repo, '.dag/runs', secondView.id, 'state.json'), 'utf8'));
  assert.equal(secondState.status, 'done', JSON.stringify(secondState));
  assert.notEqual(secondState.gitea.repo, state.gitea.repo);
  assert.notEqual(secondState.gitRemote, state.gitRemote);
  assert.equal(secondState.initialCommit, nextBaseline);
  assert.equal(secondState.tasks[0].pr, 1);
  assert.equal(firstRepository.prs.size, 4);
  assert.equal(repositories.get(secondState.gitea.repo).prs.size, 1);
  assert.equal(await git(remote, ['rev-parse', 'refs/heads/main']), oldRemoteMain);
  console.log(JSON.stringify({independent_run_repositories: true, first_pr_each_run: [state.tasks[0].pr, secondState.tasks[0].pr], previous_prs_retained: true}));
  // A real idle/running native child must be aborted; no downstream task or PR
  // may start just because the controlling parent has no active model turn.
  holdWorker = true;
  await writeFile(join(repo, '.dag/dag.json'), JSON.stringify({tasks: tasks.slice(0, 3).map((task, index) => ({...task, dependencies: index === 2 ? [1, 2] : []}))}));
  await prepareUx(tasks.slice(0, 3));
  const cancelledSource = await api('/session', 'POST', {title: 'DAG cancellation fixture'});
  await control(cancelledSource.id, 'start');
  await until(async () => heldWorkers.size, value => value === 2);
  await control(cancelledSource.id, 'cancel');
  const cancelledParts = await until(async () => (await api(`/session/${cancelledSource.id}/message`)).flatMap(m => m.parts),
    parts => parts.some(p => p.metadata?.dagView?.status === 'cancelled'));
  const cancelled = cancelledParts.find(p => p.metadata?.dagView)?.metadata.dagView;
  assert.ok(cancelled.tasks.slice(0, 2).every(task => task.status === 'cancelled'));
  await until(async () => stoppedWorkers.size, value => value === 2);
  assert.ok(cancelled.tasks.slice(2).every(task => task.status === 'blocked' && !task.session));
  assert.equal(prCount, 5, '取消不能产生后续 PR');
  console.log(JSON.stringify({cancellation_verified: true, downstream_started: false}));
  if (testUx && process.env.DAG_TEST_REPORT) await writeFile(resolve(process.env.DAG_TEST_REPORT), JSON.stringify({
    scope: 'real OpenCode 1.19.5 + real Git + fixture model + mock Gitea API; no device UX validation',
    checks: {nodeAssetInjection: true, forkAndJoin: true, parallelExecution: true, prMerge: true,
      conflictRepair: true, independentRuns: true, cancellation: true, noDeviceContinues: true}, report: uxRunReport}, null, 2));
}
try { await verify(); }
catch (error) { console.error(error.stack, '\nSERVER', logs.slice(-2500)); process.exitCode = 1; }
finally {
  child.kill(); if (child.exitCode === null) await new Promise(r => child.once('close', r));
  model.closeAllConnections(); provider.closeAllConnections(); await Promise.all([new Promise(r => model.close(r)), new Promise(r => provider.close(r))]);
  const wtRoot = join(parent, '.dag-worktrees', basename(repo));
  if (relative(parent, fixture).startsWith('..') || relative(parent, wtRoot).startsWith('..')) throw new Error('清理路径越界');
  await rm(wtRoot, { recursive: true, force: true }); await rm(fixture, { recursive: true, force: true });
}
