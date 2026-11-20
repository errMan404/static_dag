import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile, rename, unlink, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, basename, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {git} from '../dag_run/git.js';
import {macLocalGitea} from './local-gitea-mac.js';

const execute = promisify(execFile);
const windowsEnvironment = () => {const env = {...process.env}; delete env.PSModulePath; return env;};
function bootstrap(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, {windowsHide: true, env: windowsEnvironment(), stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', value => {stdout += value;}); child.stderr.on('data', value => {stderr += value;});
    const timer = setTimeout(() => {child.kill(); reject(new Error('Gitea bootstrap timed out'));}, 180000);
    child.once('error', error => {clearTimeout(timer); reject(error);});
    // Start-Process can pass inherited pipe handles to Gitea on Windows. Finish
    // when PowerShell exits, not when the persistent service closes those pipes.
    child.once('exit', code => setImmediate(() => {
      clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy();
      if (code === 0) resolve({stdout}); else reject(Object.assign(new Error('Bootstrap failed'), {stderr}));
    }));
  });
}
const manifestUrl = new URL('../../vendor/gitea/manifest.json', import.meta.url);
const script = fileURLToPath(new URL('./local-gitea.ps1', import.meta.url));
export function localDataRoot() {
  if (process.env.DEVECO_DAG_DATA_DIR) return resolve(process.env.DEVECO_DAG_DATA_DIR);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'DevecoDAG', 'gitea');
  if (!process.env.LOCALAPPDATA) throw new Error('Windows LOCALAPPDATA is unavailable');
  return join(process.env.LOCALAPPDATA, 'DevecoDAG', 'gitea');
}
export function repositoryPrefix(root) {
  const value = basename(root).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 40);
  return value || `project-${createHash('sha256').update(root).digest('hex').slice(0, 10)}`;
}
export async function localGitea(action = 'start') {
  if (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)) return macLocalGitea(action, localDataRoot());
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('本地 Gitea 支持 macOS（Apple Silicon 或 Intel）和 Windows x64；其他平台可在 .dag/runner.json 配置外部 Gitea');
  }
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const binary = fileURLToPath(new URL(`../../vendor/gitea/${manifest.file}`, import.meta.url));
  try {
    const {stdout} = await bootstrap(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-DataRoot', localDataRoot(), '-BinaryPath', binary, '-ExpectedHash', manifest.sha256, '-Action', action]);
    return JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
  } catch (error) {
    // execFile error messages include stdout; stdout can contain a token.
    const reason = String(error.stderr ?? '').trim().slice(0, 500);
    throw new Error(`本地 Gitea 初始化失败${reason ? '：' + reason : '，请查看用户数据目录中的 log'}`);
  }
}
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";

async function macCredentialCommand(runtime) {
  const helper = join(runtime.dataRoot, 'git-credential.sh');
  const source = await readFile(new URL('./git-credential-mac.sh', import.meta.url));
  const installed = await readFile(helper).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!installed?.equals(source)) {
    const temporary = helper + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, source, {mode: 0o600, flag: 'wx'});
      await rename(temporary, helper);
    } finally { await unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;}); }
  }
  return `!/bin/sh ${shellQuote(helper)} ${shellQuote(runtime.url)} ${shellQuote(runtime.owner)}`;
}

export async function configureLocalGit(root, runtime) {
  // Keep the helper stable across package updates and narrowly scoped to this URL.
  const command = process.platform === 'darwin'
    ? await macCredentialCommand(runtime)
    : `!powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${shellQuote(join(runtime.dataRoot, 'git-credential.ps1').replaceAll('\\', '/'))}`;
  const key = `credential.${runtime.url}.helper`;
  await git(root, ['config', '--local', '--replace-all', key, '']);
  await git(root, ['config', '--local', '--add', key, command]);
}
export async function loadRunnerConfig(root) {
  let config;
  try { config = JSON.parse(await readFile(join(root, '.dag/runner.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('.dag/runner.json 不是有效 JSON，请修正后重试'); config = {}; }
  if (config.gitea?.url) return {config};
  const runtime = await localGitea();
  await configureLocalGit(root, runtime);
  config.gitea = {url: runtime.url, owner: runtime.owner, repoPrefix: config.gitea?.repoPrefix ?? repositoryPrefix(root)};
  return {config, token: runtime.token};
}
export async function enableWorkspaces() {
  const value = process.env.OPENCODE_EXPERIMENTAL_WORKSPACES ?? process.env.OPENCODE_EXPERIMENTAL;
  if (['true', '1'].includes(value?.toLowerCase())) return true;
  if (process.platform !== 'win32') return false;
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "[Environment]::SetEnvironmentVariable('OPENCODE_EXPERIMENTAL_WORKSPACES', 'true', 'User')"], {windowsHide: true, env: windowsEnvironment(), timeout: 10000});
  return false; // Host reads this flag before plugin loading. A restart is required.
}

export async function requireWorkspaces() {
  if (await enableWorkspaces()) return;
  if (process.platform === 'win32') {
    throw new Error('已为当前 Windows 用户保存 Workspace 开关。请退出 OpenCode，在 PowerShell 中执行 $env:OPENCODE_EXPERIMENTAL_WORKSPACES="true" 后重启 OpenCode，再运行命令。');
  }
  throw new Error('当前 OpenCode 进程未启用 Workspace。请退出后用 OPENCODE_EXPERIMENTAL_WORKSPACES=true opencode <项目路径> 重启，再运行命令。');
}
