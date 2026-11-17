import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm, rename, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git } from '../src/dag_run/git.js';
import { parseWorkerInput } from './worker-fixture.js';

const parentPath = join(tmpdir(), 'dag-execution-tests'); await mkdir(parentPath, { recursive: true });
const parent = await realpath(parentPath);
const testUx = process.env.DAG_TEST_UX === '1';
let uxRunReport;
const uxCards = JSON.parse(await readFile(new URL('../assets/ux/full-app-cards.json', import.meta.url), 'utf8'));
const uxIds = ['UX.APP.SHELL', 'UX.SHOP.GRID', 'UX.CAR.BROWSE', 'UX.WINDOW.CONTEXT.STATE'];
async function prepareUx(tasks) {
  if (!testUx) return;
  await writeFile(join(repo, '.dag/ux.json'), JSON.stringify({version: 1, cardsFile: 'ux-assets/cards.json', device: null,
    requirements: ['保留原有业务状态'], nodes: tasks.map(task => ({taskId: task.id, cardIds: [uxIds[task.id - 1]], requirements: []}))}));
}
const fixture = await mkdtemp(join(parent, 'run-')), repo = join(fixture, 'repo'), remote = join(fixture, 'remote.git'), integrator = join(fixture, 'integrator');
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
const model = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const part of req) raw += part; const body = JSON.parse(raw), names = body.tools?.map(t => t.function.name) ?? [];
    requestCount++; if (requestCount > 65) throw new Error('测试模型检测到异常循环');
    assert.ok(!names.includes('dag_next'), '模型不应看到 dag_next 工具');
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
const child = spawn(process.env.OPENCODE_BIN ?? 'D:\\APP\\node_js\\node_modules\\opencode-ai\\bin\\opencode.exe', ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
  XDG_CONFIG_HOME: join(fixture, 'config'), XDG_DATA_HOME: join(fixture, 'data'), XDG_STATE_HOME: join(fixture, 'state'), XDG_CACHE_HOME: join(fixture, 'cache'), OPENCODE_CONFIG_DIR: join(fixture, 'config/opencode'),
  OPENCODE_EXPERIMENTAL_WORKSPACES: 'true', OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_SERVER_PASSWORD: 'fixture-password', OPENCODE_SERVER_USERNAME: 'fixture', GITEA_TOKEN: 'fixture-token' } });
let logs = ''; child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
try {
  let origin; for (let i = 0; i < 600; i++) { origin = logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (origin) break; await new Promise(r => setTimeout(r, 50)); }
  assert.ok(origin, logs.slice(-1000));
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(origin + path + '?directory=' + encodeURIComponent(repo), { method, headers: { authorization: 'Basic ' + Buffer.from('fixture:fixture-password').toString('base64'), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90000) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
  };
  const failedSource = await api('/session', 'POST', { title: 'DAG preflight error fixture' });
  const control = (sessionID, action) => api(`/session/${sessionID}/message`, 'POST', {noReply: true,
    parts: [{type: 'text', synthetic: true, ignored: true, text: '/dag_run', metadata: {dagControl: {action, root: repo, requestId: crypto.randomUUID(), issuedAt: Date.now()}}}]});
  async function until(read, condition, timeout = 90000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await read(); if (condition(value)) return value; await new Promise(r => setTimeout(r, 100)); }
    throw new Error('等待 DAG 自动执行超时');
  }
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
  if (process.env.DAG_TUI_SMOKE === '1') {
    console.log(JSON.stringify({tuiFixture: fixture, repo, origin, sessionID: source.id}));
    while (true) { try { await readFile(join(fixture, 'ui.done')); break; } catch { await new Promise(r => setTimeout(r, 250)); } }
  }
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
} catch (error) { console.error(error.stack, '\nSERVER', logs.slice(-2500)); process.exitCode = 1; }
finally {
  child.kill(); if (child.exitCode === null) await new Promise(r => child.once('close', r));
  model.closeAllConnections(); provider.closeAllConnections(); await Promise.all([new Promise(r => model.close(r)), new Promise(r => provider.close(r))]);
  const wtRoot = join(parent, '.dag-worktrees', 'repo');
  if (relative(parent, fixture).startsWith('..') || relative(parent, wtRoot).startsWith('..')) throw new Error('清理路径越界');
  await rm(wtRoot, { recursive: true, force: true }); await rm(fixture, { recursive: true, force: true });
}
