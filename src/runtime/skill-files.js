import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const readTools = ['read', 'glob', 'grep'];

function inside(directory, file) {
  const rel = relative(directory, file);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}

export async function rememberSkillDirectory(session, output) {
  const directory = output.metadata?.dir;
  if (typeof directory !== 'string' || !isAbsolute(directory)) return;
  const canonical = await realpath(directory).catch(() => undefined);
  if (canonical) (session.skillDirectories ??= new Set()).add(canonical);
}

export async function guardReadPaths(session, args, cwd, ...scope) {
  const directories = await Promise.all(scope.map(directory => realpath(directory).catch(() => directory)));
  for (const key of ['filePath', 'path']) {
    if (typeof args[key] !== 'string') continue;
    const path = resolve(cwd, args[key]);
    const canonical = await realpath(path).catch(() => undefined);
    const allowed = canonical
      ? directories.some(directory => inside(directory, canonical)) ||
        [...(session.skillDirectories ?? [])].some(directory => inside(directory, canonical))
      : scope.some(directory => inside(directory, path));
    if (!allowed) {
      throw new Error('只能读取节点工作区、允许的产物目录和本会话加载的技能文件');
    }
    args[key] = canonical ?? path;
  }
}
