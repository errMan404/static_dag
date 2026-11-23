import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ensureMacGitea } from './gitea-binary.js';

const execute = promisify(execFile);
const owner = 'dag-agent';
const host = '127.0.0.1';
const tokenPattern = /^[a-fA-F0-9]{40,128}$/u;
const shell = ['-c', 'umask 077; exec "$@"', 'deveco-dag-gitea'];
// Node does not expose Darwin's exclusive open flag from the macOS SDK.
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h
const darwinExclusiveLock = 0x20;
const childEnvNames = ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ', 'USER'];
const environment = () => ({
  PATH: [process.env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin'].filter(Boolean).join(':'),
  ...Object.fromEntries(childEnvNames.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
});

async function privateDirectory(path, create) {
  if (create) await mkdir(path, {recursive: true, mode: 0o700});
  const info = await lstat(path).catch(error => {
    if (error.code !== 'ENOENT' || create) throw error;
  });
  if (!info) return false;
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error(`Gitea 数据目录必须是当前用户的私有目录（0700）：${path}`);
  }
  return true;
}

async function readPrivate(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!file) return;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) {
      throw new Error(`Gitea 文件必须仅允许当前用户访问（0600）：${path}`);
    }
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

async function writePrivate(path, content) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, {mode: 0o600, flag: 'wx'});
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function bootstrapLock(root) {
  const path = join(root, 'bootstrap.lock');
  const deadline = Date.now() + 180000;
  const flags = constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | darwinExclusiveLock;
  for (;;) {
    let file;
    try {
      file = await open(path, flags, 0o600);
    } catch (error) {
      if (error.code !== 'EAGAIN' && error.code !== 'EWOULDBLOCK') {
        throw new Error(`无法打开本地 Gitea 初始化锁（${error.code}）：${path}`);
      }
      if (Date.now() >= deadline) throw new Error(`等待另一个进程初始化本地 Gitea 超时：${path}`);
      await delay(200);
      continue;
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) {
        throw new Error(`Gitea 初始化锁必须仅允许当前用户访问（0600）：${path}`);
      }
      // The lock belongs to this open descriptor. Keep the inode in place so
      // the next caller can acquire it even if this process is killed.
      return () => file.close();
    } catch (error) {
      await file.close();
      throw error;
    }
  }
}

function cliArgs(root, command) {
  return ['--work-path', root, '--custom-path', join(root, 'custom'), '--config', join(root, 'custom/conf/app.ini'), ...command];
}

async function cli(root, executable, command, description) {
  try {
    const {stdout} = await execute('/bin/sh', [...shell, executable, ...cliArgs(root, command)], {
      cwd: root, env: environment(), encoding: 'utf8', timeout: 120000
    });
    return stdout.trim();
  } catch {
    // Account creation and token generation can print secrets. Do not include
    // the child streams or the original execFile error in a surfaced failure.
    throw new Error(`本地 Gitea${description}失败，请检查数据目录中的配置和日志：${root}`);
  }
}

function portFor(root, port = 0) {
  return new Promise((res, rej) => {
    const server = createServer();
    server.once('error', error => rej(new Error(port ? `本地 Gitea 的端口 ${port} 不可用，已保留原地址：${root}`
      : `无法为本地 Gitea 分配回环端口（${error.code}）`)));
    server.listen({host, port}, () => {
      const boundPort = server.address().port;
      server.close(error => error ? rej(error) : res(boundPort));
    });
  });
}

async function readRuntime(path) {
  const content = await readPrivate(path);
  if (content === undefined) return;
  let value;
  try { value = JSON.parse(content); } catch { throw new Error(`Gitea 运行记录不是有效 JSON：${path}`); }
  const port = typeof value?.url === 'string' && Number(value.url.match(/^http:\/\/127\.0\.0\.1:(\d+)$/u)?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !Number.isSafeInteger(value.pid) || value.pid < 0 || typeof value.executable !== 'string' || !isAbsolute(value.executable)) {
    throw new Error(`Gitea 运行记录无效：${path}`);
  }
  return {port, url: value.url, pid: value.pid, executable: value.executable};
}

async function processMatches(root, runtime) {
  if (!runtime?.pid) return false;
  const expected = [runtime.executable, ...cliArgs(root, ['web'])].join(' ');
  try {
    const {stdout} = await execute('/bin/ps', ['-ww', '-p', String(runtime.pid), '-o', 'command='], {timeout: 2500});
    return stdout.trim() === expected;
  } catch { return false; }
}

async function ownsListener(runtime) {
  try {
    const {stdout} = await execute('/usr/sbin/lsof', ['-nP', '-a', '-p', String(runtime.pid),
      '-iTCP:' + runtime.port, '-sTCP:LISTEN', '-Fn'], {timeout: 2500});
    return stdout.split('\n').includes(`n${host}:${runtime.port}`);
  } catch { return false; }
}

function health(runtime) {
  return new Promise(resolve => {
    const request = get(runtime.url + '/api/healthz', {timeout: 1000}, response => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once('error', () => resolve(false));
    request.once('timeout', () => request.destroy());
  });
}

async function ready(runtime) {
  return await health(runtime) && await ownsListener(runtime);
}

async function waitForReady(runtime, child) {
  const deadline = Date.now() + 30000;
  do {
    if (child && (child.exitCode !== null || child.signalCode !== null)) break;
    if (await ready(runtime)) return;
    await delay(200);
  } while (Date.now() < deadline);
  throw new Error('本地 Gitea 未就绪，请检查数据目录下的 log/server.log');
}

function ini(runtime) {
  const secret = () => randomBytes(32).toString('hex');
  const username = userInfo().username;
  if (/[\r\n]/u.test(username)) throw new Error('macOS 当前账号不能用于 Gitea 初始化');
  return [
    'APP_NAME = DevEco DAG Local Gitea', `RUN_USER = ${username}`, 'RUN_MODE = prod',
    '[database]', 'DB_TYPE = sqlite3', 'PATH = data/gitea.db',
    '[repository]', 'ROOT = data/repositories', 'DEFAULT_PRIVATE = private', 'DEFAULT_BRANCH = main',
    '[server]', `DOMAIN = ${host}`, `HTTP_ADDR = ${host}`, `HTTP_PORT = ${runtime.port}`, `ROOT_URL = ${runtime.url}/`,
    'APP_DATA_PATH = data', 'DISABLE_SSH = true', 'LFS_START_SERVER = false', 'OFFLINE_MODE = true',
    '[security]', 'INSTALL_LOCK = true', `SECRET_KEY = ${secret()}`, `INTERNAL_TOKEN = ${secret()}`,
    '[service]', 'DISABLE_REGISTRATION = true', 'REQUIRE_SIGNIN_VIEW = true', 'ENABLE_NOTIFY_MAIL = false',
    '[mailer]', 'ENABLED = false', '[actions]', 'ENABLED = false', '[oauth2]', `JWT_SECRET = ${secret()}`,
    '[log]', 'MODE = console', 'LEVEL = Info', ''
  ].join('\n');
}

async function provisionToken(root, executable, tokenFile) {
  await cli(root, executable, ['migrate'], '数据库初始化');
  const users = await cli(root, executable, ['admin', 'user', 'list'], '账号检查');
  if (!/^\s*\d+\s+dag-agent\s/mu.test(users)) {
    await cli(root, executable, ['admin', 'user', 'create', '--username', owner, '--email',
      'dag-agent@localhost.invalid', '--random-password', '--random-password-length', '32',
      '--must-change-password=false'], '账号创建');
  }
  const existing = await readPrivate(tokenFile);
  if (existing !== undefined) return checkedToken(existing);
  const token = checkedToken(await cli(root, executable, ['admin', 'user', 'generate-access-token',
    '--username', owner, '--token-name', 'dag-runtime-' + randomUUID(), '--scopes', 'write:repository,write:user', '--raw'], '令牌生成'));
  await writePrivate(tokenFile, token + '\n');
  return token;
}

function checkedToken(value) {
  const token = value?.trim();
  if (!token || !tokenPattern.test(token)) throw new Error('本地 Gitea 令牌缺失或无效，请检查数据目录下的 secrets/token');
  return token;
}

async function launch(root, runtime, runtimeFile) {
  const log = await open(join(root, 'log/server.log'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let child;
  try {
    child = spawn('/bin/sh', [...shell, runtime.executable, ...cliArgs(root, ['web'])], {
      cwd: root, env: environment(), detached: true, stdio: ['ignore', log.fd, log.fd]
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    runtime.pid = child.pid;
    await writePrivate(runtimeFile, JSON.stringify(runtime) + '\n');
    await waitForReady(runtime, child);
    child.unref();
  } catch {
    if (child?.pid && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    child?.unref();
    throw new Error('本地 Gitea 启动失败，请检查数据目录下的 log/server.log');
  } finally { await log.close(); }
}

export async function macLocalGitea(action, dataRoot) {
  if (action !== 'start' && action !== 'status') throw new Error('未知的 Gitea 操作');
  dataRoot = resolve(dataRoot);
  if (!await privateDirectory(dataRoot, action === 'start')) return {running: false, dataRoot};
  dataRoot = await realpath(dataRoot);
  const runtimeFile = join(dataRoot, 'runtime.json');
  if (action === 'status') {
    const runtime = await readRuntime(runtimeFile);
    const running = await processMatches(dataRoot, runtime) && await ready(runtime);
    return {running, dataRoot, url: runtime?.url, pid: runtime?.pid || undefined};
  }

  const release = await bootstrapLock(dataRoot);
  try {
    const tokenFile = join(dataRoot, 'secrets/token');
    let runtime = await readRuntime(runtimeFile);
    if (await processMatches(dataRoot, runtime)) {
      await waitForReady(runtime);
      return {url: runtime.url, owner, token: checkedToken(await readPrivate(tokenFile)), pid: runtime.pid, dataRoot};
    }
    const executable = await realpath(await ensureMacGitea(dataRoot));
    for (const name of ['data', 'secrets', 'log', 'custom', 'custom/conf']) {
      await privateDirectory(join(dataRoot, name), true);
    }
    const iniPath = join(dataRoot, 'custom/conf/app.ini');
    const existing = await readPrivate(iniPath);
    if (existing !== undefined && !runtime) throw new Error(`缺少原 Gitea 的运行记录，无法安全选择新端口：${runtimeFile}`);
    const port = await portFor(dataRoot, runtime?.port);
    runtime = {port, url: `http://${host}:${port}`, pid: 0, executable};
    // Persist the original URL before creating the config or starting the server.
    await writePrivate(runtimeFile, JSON.stringify(runtime) + '\n');
    if (existing === undefined) await writePrivate(iniPath, ini(runtime));
    const token = await provisionToken(dataRoot, executable, tokenFile);
    await launch(dataRoot, runtime, runtimeFile);
    return {url: runtime.url, owner, token, pid: runtime.pid, dataRoot};
  } finally { await release(); }
}
