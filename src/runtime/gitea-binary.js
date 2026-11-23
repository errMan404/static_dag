import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

const manifest = new URL('../../vendor/gitea/macos.json', import.meta.url);
const privateExecutable = 0o700;
const noFollow = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

async function ensureCacheDirectory(directory) {
  await mkdir(directory, {recursive: true, mode: 0o700});
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid()) {
    throw new Error('Gitea 缓存必须是当前用户拥有的目录：' + directory);
  }
  if ((info.mode & 0o777) !== 0o700) await chmod(directory, 0o700);
}

async function verifyCache(path, artifact) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size !== artifact.bytes || info.uid !== process.getuid()) return false;
    const hash = createHash('sha256');
    let size = 0;
    // Read at most the claimed asset size plus one byte, even if the file grows.
    for await (const chunk of createReadStream(path, {flags: noFollow, end: artifact.bytes})) {
      hash.update(chunk);
      size += chunk.length;
    }
    if (size !== artifact.bytes || hash.digest('hex') !== artifact.sha256) return false;
    if ((info.mode & 0o777) !== privateExecutable) await chmod(path, privateExecutable);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') return false;
    throw error;
  }
}

async function* verifiedDownload(response, artifact) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > artifact.bytes) throw new Error('Gitea 下载超过官方文件大小');
    hash.update(chunk);
    yield chunk;
  }
  if (size !== artifact.bytes) throw new Error('Gitea 下载大小与官方文件不一致');
  if (hash.digest('hex') !== artifact.sha256) throw new Error('Gitea 下载未通过 SHA-256 校验');
}

export async function ensureMacGitea(dataRoot) {
  const release = JSON.parse(await readFile(manifest, 'utf8'));
  const artifact = release.binaries[process.arch];
  if (process.platform !== 'darwin' || !artifact) throw new Error('Gitea 本地下载仅适用于 macOS ARM64 和 Intel');

  const cache = resolve(dataRoot, 'bin');
  await ensureCacheDirectory(cache);
  const target = join(cache, artifact.file);
  if (await verifyCache(target, artifact)) return target;

  const staging = await mkdtemp(join(cache, '.gitea-download-'));
  try {
    const signal = AbortSignal.timeout(180000);
    const response = await fetch(artifact.source, {signal, redirect: 'error', headers: {'accept-encoding': 'identity'}});
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Gitea 官方下载失败（HTTP ' + response.status + '）');
    }
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== artifact.bytes) {
      await response.body.cancel();
      throw new Error('Gitea 官方响应的文件大小与发布清单不一致');
    }

    const temporary = join(staging, 'gitea');
    await pipeline(verifiedDownload(response, artifact), createWriteStream(temporary, {flags: 'wx', mode: 0o600}), {signal});
    await chmod(temporary, privateExecutable);
    await rename(temporary, target);
    return target;
  } finally {
    await rm(staging, {recursive: true, force: true});
  }
}
