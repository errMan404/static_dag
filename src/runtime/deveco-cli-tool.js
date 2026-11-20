import { spawn } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tool } from '@opencode-ai/plugin';

const cli = 'devecocli';
const cliPackage = '@deveco/deveco-cli';
const maxOutput = 16 * 1024;
const help = new Set(['--help', '-h']);
const version = new Set(['--version', '-V', '-v']);
const docs = new Set(['catalog', 'search', 'read']);

export function isDevEcoCliReferenceCommand(args) {
  if (args.length === 0) return true;
  if (args.length === 1) return help.has(args[0]) || version.has(args[0]);
  if (help.has(args.at(-1)) && args.slice(0, -1).every(arg => /^[a-z][a-z0-9-]*$/u.test(arg))) return true;
  return args[0] === 'docs' && docs.has(args[1]);
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}

async function windowsCommand(args) {
  // npm's .cmd shim relays to the package bin. Find that bin and invoke Node directly to preserve argv boundaries.
  const paths = (process.env.PATH ?? '').split(delimiter).map(path => path.replace(/^"|"$/gu, ''));
  for (const path of paths.filter(isAbsolute)) {
    const executable = join(path, cli + '.exe');
    if (await exists(executable)) return [executable, args];
    if (!await exists(join(path, cli + '.cmd'))) continue;
    for (const modules of [join(path, 'node_modules'), resolve(path, '..')]) {
      const base = join(modules, cliPackage);
      const manifest = await readFile(join(base, 'package.json'), 'utf8').catch(() => undefined);
      if (!manifest) continue;
      const pkg = JSON.parse(manifest);
      const bin = pkg.bin?.[cli];
      if (pkg.name !== cliPackage || typeof bin !== 'string' || isAbsolute(bin)) continue;
      const packageRoot = await realpath(base);
      const entry = await realpath(resolve(base, bin)).catch(() => undefined);
      if (!entry) continue;
      const rel = relative(packageRoot, entry);
      if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) continue;
      const bundledNode = join(path, 'node.exe');
      return [await exists(bundledNode) ? bundledNode : 'node.exe', [entry, ...args]];
    }
  }
  throw new Error('找不到 DevEco CLI。请确认 OpenCode 的 PATH 包含已安装的 devecocli。');
}

function outputTail(stream) {
  let tail = Buffer.alloc(0);
  let truncated = false;
  stream.on('data', chunk => {
    const buffer = Buffer.concat([tail, chunk]);
    truncated ||= buffer.length > maxOutput;
    tail = buffer.subarray(Math.max(0, buffer.length - maxOutput));
  });
  return () => (truncated ? '[输出过长，仅保留末尾]\n' : '') + tail.toString('utf8');
}

async function execute(args, directory, signal) {
  signal.throwIfAborted();
  const [command, argv] = process.platform === 'win32' ? await windowsCommand(args) : [cli, args];
  signal.throwIfAborted();
  const env = {...process.env, DEVECO_CLI_DISABLE_UPDATE: 'check', DEVECO_CLI_DISABLE_TELEMETRY: '1'};
  delete env.GITEA_TOKEN;
  delete env.OPENCODE_SERVER_PASSWORD;
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {cwd: directory, signal, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    const stdout = outputTail(child.stdout);
    const stderr = outputTail(child.stderr);
    let drain;
    const end = (exit, reason) => {
      clearTimeout(drain);
      child.stdout.destroy();
      child.stderr.destroy();
      if (signal.aborted) reject(signal.reason);
      else resolve({exit, signal: reason, stdout: stdout(), stderr: stderr()});
    };
    child.once('error', error => {
      clearTimeout(drain);
      if (signal.aborted) reject(signal.reason);
      else if (error.code === 'ENOENT') reject(new Error('找不到 DevEco CLI 或其项目目录。请检查 OpenCode 的 PATH 和当前工作区。'));
      else reject(new Error('DevEco CLI 启动失败' + (error.code ? `（${error.code}）` : '')));
    });
    child.once('close', end);
    child.once('exit', (exit, reason) => {
      // SDK daemons can inherit stdout/stderr even after the CLI has exited.
      drain = setTimeout(() => end(exit, reason), 250);
    });
  });
}

export function createDevEcoCliTool(authorize) {
  return tool({
    description: '在当前节点工作目录执行一条 DevEco CLI 命令。args 填命令参数数组，无需包含 devecocli。输出包含退出码、标准输出和错误输出。',
    args: {args: tool.schema.array(tool.schema.string()).max(128)},
    async execute({args}, context) {
      const {directory, signal = context.abort} = await authorize(args, context);
      const result = await execute(args, directory, signal);
      const output = [result.exit === null ? `进程退出信号：${result.signal ?? '未知'}` : `退出码：${result.exit}`];
      if (result.stdout) output.push('stdout:\n' + result.stdout);
      if (result.stderr) output.push('stderr:\n' + result.stderr);
      return {title: 'DevEco CLI', output: output.join('\n\n'), metadata: {exit: result.exit}};
    }
  });
}
