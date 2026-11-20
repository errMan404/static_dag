import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, realpath, stat, copyFile, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, relative, isAbsolute} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
const execute = promisify(execFile);
const mode = process.argv[2];
if (!mode) throw new Error('用法：node test/package-smoke.mjs <tarball|--source>');
const artifact = mode === '--source' ? undefined : resolve(mode);
const fixture = await mkdtemp(join(tmpdir(), 'dag packaged-'));
const install = join(fixture, 'install'), repo = join(fixture, 'repo');
const dataRoot = join(fixture, "runtime user's 中文");
const mac = process.platform === 'darwin';
const keep = process.env.DAG_KEEP_PACKAGE_FIXTURE === '1';
const cachedMacBinary = mac && process.env.DAG_SMOKE_GITEA_BINARY;
let runtime, run, localGitea, passed = false;
const evidence = [];

async function installArtifact() {
  await mkdir(install);
  await writeFile(join(install, 'package.json'), '{"private":true}');
  const npmCli = process.env.npm_execpath ??
    (process.platform === 'win32' ? resolve(process.execPath, '../node_modules/npm/bin/npm-cli.js') : undefined);
  const command = npmCli ? process.execPath : 'npm';
  const args = [...(npmCli ? [npmCli] : []), 'install', artifact, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'];
  await execute(command, args, {cwd: install, windowsHide: true, timeout: 180000});
  return join(install, 'node_modules/deveco-dag');
}

async function stopOwnedRuntime(instance) {
  const status = await localGitea('status');
  if (!status.running) return;
  const recorded = JSON.parse((await readFile(join(instance.dataRoot, 'runtime.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(await realpath(instance.dataRoot), await realpath(dataRoot), '仅停止本次夹具初始化的服务');
  assert.equal(recorded.pid, instance.pid);
  assert.equal(recorded.url, instance.url);
  assert.equal(status.pid, instance.pid);
  if (mac) {
    const {stdout} = await execute('/bin/ps', ['-ww', '-p', String(instance.pid), '-o', 'command=']);
    assert.ok(stdout.includes(recorded.executable) && stdout.includes(instance.dataRoot), 'PID 必须属于本次夹具的 Gitea 进程');
  }
  process.kill(instance.pid);
  const deadline = Date.now() + 6000;
  do {
    await delay(150);
    if (!(await localGitea('status')).running) return;
  } while (Date.now() < deadline);
  throw new Error('夹具 Gitea 在收到退出信号后仍运行');
}

try {
  await mkdir(repo);
  const packageRoot = artifact ? await installArtifact() : fileURLToPath(new URL('../', import.meta.url));
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'deveco-dag');
  if (artifact) {
    await assert.rejects(readFile(join(packageRoot, '.opencode/plugins/static-dag.js')), {code: 'ENOENT'});
    await assert.rejects(readFile(join(packageRoot, '.npmrc')), {code: 'ENOENT'});
  }
  ({localGitea} = await import(pathToFileURL(join(packageRoot, 'src/runtime/local-gitea.js'))));
  const {DagRun} = await import(pathToFileURL(join(packageRoot, 'src/dag_run/index.js')));
  const {git} = await import(pathToFileURL(join(packageRoot, 'src/dag_run/git.js')));
  process.env.DEVECO_DAG_DATA_DIR = dataRoot;
  process.env.OPENCODE_EXPERIMENTAL_WORKSPACES = 'true';
  process.env.GITEA_TOKEN = 'deliberately-wrong-global-token';
  if (cachedMacBinary) {
    const release = JSON.parse(await readFile(join(packageRoot, 'vendor/gitea/macos.json'), 'utf8'));
    const bin = join(dataRoot, 'bin');
    await mkdir(bin, {recursive: true, mode: 0o700});
    const staged = join(bin, release.binaries[process.arch].file);
    await copyFile(resolve(cachedMacBinary), staged);
    await chmod(staged, 0o700);
  }
  const starts = await Promise.allSettled([localGitea(), localGitea()]);
  runtime = starts.find(result => result.status === 'fulfilled')?.value;
  const failed = starts.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  assert.equal(starts[0].value.pid, starts[1].value.pid);
  assert.equal(starts[0].value.url, starts[1].value.url);
  assert.ok(runtime.token, '初始化后必须有可用令牌');
  if (mac) {
    const secret = join(runtime.dataRoot, 'secrets/token');
    assert.equal((await stat(runtime.dataRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(secret)).mode & 0o777, 0o600);
    assert.ok((await readFile(secret, 'utf8')).trim() === runtime.token, '运行时须读取同一份私有令牌文件');
  } else {
    const encrypted = await readFile(join(runtime.dataRoot, 'secrets/token.xml'), 'utf8');
    assert.ok(!encrypted.includes(runtime.token), '令牌文件不得包含明文令牌');
  }
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.name', 'Packaged DAG smoke']); await git(repo, ['config', 'user.email', 'package@example.invalid']);
  await writeFile(join(repo, '.gitignore'), '.dag/\n'); await writeFile(join(repo, 'README.md'), '# Packaged fixture\n');
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'baseline']);
  await mkdir(join(repo, '.dag'));
  await writeFile(join(repo, '.dag/dag.json'), JSON.stringify({tasks: [{id: 1, title: 'Task', description: 'Task', dependencies: [], testStrategy: 'Verify task output'}]}));
  await assert.rejects(readFile(join(repo, '.dag/runner.json')), {code: 'ENOENT'});
  let baseline = await git(repo, ['rev-parse', 'HEAD']);
  for (let round = 1; round <= 2; round++) {
    run = await DagRun.start(repo, `packaged-${round}`, {});
    assert.equal(run.state.initialCommit, baseline);
    assert.equal(run.state.gitea.url, runtime.url);
    await run.initializeIntegration();
    const task = run.state.tasks[0];
    Object.assign(task, {baseCommit: run.state.initialCommit, branch: `dag/${run.state.id}/task-1`, worktree: join(fixture, `task-${round}`), status: 'running'});
    await git(repo, ['worktree', 'add', '-b', task.branch, task.worktree, task.baseCommit]);
    await writeFile(join(task.worktree, 'result.txt'), `Result for run ${round}\n`);
    await git(task.worktree, ['add', '.']); await git(task.worktree, ['commit', '-qm', 'Task result']);
    let submission;
    for (let attempt = 0; attempt < 10; attempt++) {
      submission = await run.submit(task, 'Bundled Gitea and repository credential helper smoke test');
      if (submission.status === 'merged') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal(submission.status, 'merged', JSON.stringify(submission));
    assert.equal(task.pr, 1);
    assert.equal(await git(repo, ['rev-parse', 'HEAD']), submission.mergeCommit);
    baseline = submission.mergeCommit;
    await run.complete();
    assert.equal(run.state.status, 'done');
    evidence.push({repo: run.state.gitea.repo, pr: task.pr});
  }
  assert.notEqual(evidence[0].repo, evidence[1].repo);
  await assert.rejects(readFile(join(repo, '.dag/runner.json')), {code: 'ENOENT'});
  const gitConfig = await readFile(join(repo, '.git/config'), 'utf8');
  assert.ok(!gitConfig.includes(runtime.token));
  if (mac) {
    const previous = runtime;
    await stopOwnedRuntime(previous);
    runtime = await localGitea();
    assert.equal(runtime.url, previous.url, '重新启动后应继续使用同一个端口');
    assert.ok(runtime.token === previous.token, '重新启动后应继续使用同一份凭据');
    const response = await fetch(`${runtime.url}/api/v1/repos/${encodeURIComponent(runtime.owner)}/${encodeURIComponent(evidence[0].repo)}`,
      {headers: {Authorization: `token ${runtime.token}`}, signal: AbortSignal.timeout(5000)});
    assert.equal(response.status, 200, '重新启动须保留之前创建的私有仓库');
    assert.equal((await response.json()).private, true);
  }
  const cliStatus = await execute(process.execPath, [join(packageRoot, 'bin/cli.js'), 'status'], {cwd: repo, timeout: 10000});
  assert.ok(!cliStatus.stdout.includes(runtime.token) && !cliStatus.stderr.includes(runtime.token), 'CLI 状态不得显示令牌');
  const status = JSON.parse(cliStatus.stdout);
  assert.equal(status.running, true);
  assert.equal(status.url, runtime.url);
  assert.ok(!Object.hasOwn(status, 'token'));
  console.log(JSON.stringify({passed: true, ...(artifact ? {installedArtifact: artifact} : {sourceRuntime: true}),
    firstUseAutomatic: true, sharedInstance: true, realGitea: true, ...(mac ? {privateCredentialFile: true, stablePortAfterRestart: true, stagedBinary: Boolean(cachedMacBinary)} : {encryptedCredentials: true}),
    tokenAbsentFromCliAndGitConfig: true, pathWithSpacesApostropheAndUnicode: true, evidence, packageRoot}, null, 2));
  if (keep) console.log('Fixture retained: ' + fixture);
  passed = true;
} finally {
  await run?.release();
  if (!keep) {
    if (runtime) await stopOwnedRuntime(runtime);
    if (passed) {
      const path = relative(tmpdir(), fixture);
      if (!path || path.startsWith('..') || isAbsolute(path)) throw new Error('Unsafe fixture cleanup');
      await rm(fixture, {recursive: true, force: true});
    } else console.error('Failed fixture retained:', fixture);
  }
}
