import http from 'node:http';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, readdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {git} from '../src/dag_run/git.js';
import {parseWorkerInput} from './worker-fixture.js';

const packageRoot = resolve(process.argv[2]);
const tempRoot = await realpath(tmpdir());
const fixture = await mkdtemp(join(tempRoot, 'dag-managed-host-')), repo = join(fixture, 'repo'), data = join(fixture, 'local runtime');
await mkdir(repo); await git(repo, ['init', '-q', '-b', 'main']);
await git(repo, ['config', 'user.name', 'Managed runtime fixture']); await git(repo, ['config', 'user.email', 'managed@example.invalid']);
await writeFile(join(repo, '.gitignore'), '.dag/\n'); await writeFile(join(repo, 'README.md'), '# Managed host fixture\n');
await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'baseline']); await mkdir(join(repo, '.dag'));
await writeFile(join(repo, '.dag/dag.json'), JSON.stringify({tasks: [[], [1], [1], [2, 3]].map((dependencies, i) => ({id: i + 1, title: `Task ${i + 1}`, description: 'Write a task file', dependencies, testStrategy: 'Check output file'}))}));
const steps = new Map(), parallelWorkers = new Set(); let failure, releaseParallel;
const parallelBarrier = new Promise(resolve => releaseParallel = resolve);
const model = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const bytes of req) raw += bytes;
    const body = JSON.parse(raw), names = body.tools?.map(x => x.function.name) ?? [];
    let delta = {role: 'assistant', content: 'Managed Gitea fixture'};
    if (names.includes('submit_task')) {
      const content = body.messages.findLast(m => m.role === 'user').content;
      const input = parseWorkerInput(typeof content === 'string' ? content : content.map(x => x.text ?? '').join('\n'));
      const id = input.id, n = steps.get(id) ?? 0;
      if ((id === 2 || id === 3) && n === 0) {
        parallelWorkers.add(id); if (parallelWorkers.size === 2) releaseParallel();
        await Promise.race([parallelBarrier, new Promise((_, reject) => {const timer = setTimeout(() => reject(new Error('Real Gitea fixture did not run both forks concurrently')), 25000); timer.unref();})]);
      }
      steps.set(id, n + 1);
      assert.ok(n < 15, 'Unexpected worker retry loop');
      const operations = [['write', {filePath: join(input.worktree, `task-${id}.txt`), content: `Task ${id}\n`}],
        ['git', {args: ['add', '.']}], ['git', {args: ['commit', '-m', `Task ${id}`]}], ['submit_task', {summary: 'Managed runtime test'}]];
      const last = body.messages.at(-1).content;
      const text = typeof last === 'string' ? last : JSON.stringify(last);
      if (n >= 4 && text.includes('merged')) delta = {role: 'assistant', content: 'Task merged.'};
      else {
        const [name, args] = operations[Math.min(n, 3)];
        delta = {role: 'assistant', tool_calls: [{index: 0, id: `call-${id}-${n}`, type: 'function', function: {name, arguments: JSON.stringify(args)}}]};
      }
    }
    res.writeHead(200, {'content-type': 'text/event-stream'});
    const common = {id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fake'};
    res.write('data: ' + JSON.stringify({...common, choices: [{index: 0, delta, finish_reason: null}]}) + '\n\n');
    res.end('data: ' + JSON.stringify({...common, choices: [{index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}}) + '\n\ndata: [DONE]\n\n');
  } catch (error) {failure = error; res.writeHead(500); res.end('{}');}
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const config = {plugin: [pathToFileURL(join(packageRoot, 'src/plugin.js')).href], model: 'fixture/fake', small_model: 'fixture/fake', enabled_providers: ['fixture'], autoupdate: false,
  provider: {fixture: {npm: '@ai-sdk/openai-compatible', options: {baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture'}, models: {fake: {name: 'fake', limit: {context: 64000, output: 4000}}}}}};
const host = spawn(process.env.OPENCODE_BIN ?? 'D:/APP/node_js/node_modules/opencode-ai/bin/opencode.exe', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: {...process.env, XDG_CONFIG_HOME: join(fixture, 'config'), XDG_DATA_HOME: join(fixture, 'host-data'), XDG_STATE_HOME: join(fixture, 'state'), XDG_CACHE_HOME: join(fixture, 'cache'), OPENCODE_CONFIG_DIR: join(fixture, 'config/opencode'),
    DEVECO_DAG_DATA_DIR: data, OPENCODE_EXPERIMENTAL_WORKSPACES: 'true', GITEA_TOKEN: 'wrong-global-token', OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_SERVER_USERNAME: 'fixture', OPENCODE_SERVER_PASSWORD: 'fixture'}});
let logs = '', passed = false;
host.stdout.on('data', x => logs += x); host.stderr.on('data', x => logs += x);
const until = async (read, valid, timeout = 180000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {let value; try {value = await read();} catch {} if (valid(value)) return value; await new Promise(r => setTimeout(r, 100));}
  throw new Error('Managed host test timed out');
};
try {
  const url = await until(() => logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0], Boolean, 30000);
  const api = async (path, body) => {
    const r = await fetch(url + path + '?directory=' + encodeURIComponent(repo), {method: body ? 'POST' : 'GET', headers: {Authorization: 'Basic ' + Buffer.from('fixture:fixture').toString('base64'), 'content-type': 'application/json'}, body: body ? JSON.stringify(body) : undefined});
    assert.ok(r.ok); return r.json();
  };
  const parent = await api('/session', {title: 'Real managed Gitea + OpenCode'});
  await api(`/session/${parent.id}/message`, {noReply: true, parts: [{type: 'text', text: '/dag_run', synthetic: true, ignored: true,
    metadata: {dagControl: {action: 'start', root: repo, requestId: crypto.randomUUID(), issuedAt: Date.now()}}}]});
  let parallelViewObserved = false;
  const state = await until(async () => {
    const [id] = await readdir(join(repo, '.dag/runs'));
    const current = JSON.parse(await readFile(join(repo, '.dag/runs', id, 'state.json'), 'utf8'));
    if (!parallelViewObserved && current.tasks[1].status === 'running' && current.tasks[2].status === 'running') {
      const messages = await api(`/session/${parent.id}/message`);
      parallelViewObserved = messages.flatMap(message => message.parts).some(part => {
        const view = part.metadata?.dagView;
        return view?.maxConcurrency === 20 && [2, 3].every(id => view.tasks.some(task => task.id === id && task.status === 'running'));
      });
    }
    return current;
  }, x => x && x.status !== 'running');
  if (failure) throw failure;
  assert.equal(state.status, 'done', JSON.stringify(state));
  assert.equal(state.maxConcurrency, 20); assert.equal(parallelWorkers.size, 2);
  assert.equal(parallelViewObserved, true, '看板数据应同时显示节点 2 和 3 执行中');
  assert.equal(state.tasks[0].pr, 1); assert.equal(state.tasks[3].pr, 4);
  assert.deepEqual(state.tasks.map(task => task.pr).sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.equal(state.tasks[1].forkedFrom, state.tasks[0].session);
  assert.equal(state.tasks[2].forkedFrom, state.tasks[0].session); assert.equal(state.tasks[3].forkedFrom, null);
  assert.ok(state.tasks[3].startedAt >= Math.max(state.tasks[1].finishedAt, state.tasks[2].finishedAt));
  for (const task of state.tasks) assert.equal((await readFile(join(repo, `task-${task.id}.txt`), 'utf8')).trim(), `Task ${task.id}`);
  assert.equal(await git(repo, ['rev-parse', 'HEAD']), state.tasks[3].mergeCommit);
  console.log(JSON.stringify({passed: true, nativeOpenCode: true, managedGiteaFirstUse: true, noRunnerConfig: true,
    nativeWorkerGitCredentials: true, forkedAcrossWorktrees: true, concurrentForks: true, dashboardShowsBothRunning: true, joinWaitsForBoth: true, prs: state.tasks.map(x => x.pr)}));
  if (process.env.DAG_TUI_SMOKE === '1') {
    console.log(JSON.stringify({tuiFixture: fixture, repo, origin: url, sessionID: parent.id}));
    await until(() => readFile(join(fixture, 'ui.done')), Boolean, 600000);
  }
  passed = true;
} catch (error) {console.error(error.stack, logs.slice(-1000)); process.exitCode = 1;}
finally {
  try {const metadata = JSON.parse((await readFile(join(data, 'runtime.json'), 'utf8')).replace(/^\uFEFF/, '')); if (metadata.pid) process.kill(metadata.pid);} catch {}
  host.kill(); if (host.exitCode === null) await new Promise(resolve => host.once('exit', resolve));
  host.stdout.destroy(); host.stderr.destroy(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  if (passed) {const path = relative(tempRoot, fixture); if (!path || path.startsWith('..') || isAbsolute(path)) throw new Error('Unsafe cleanup'); await rm(fixture, {recursive: true, force: true});}
  else console.error('Fixture retained:', fixture);
}
