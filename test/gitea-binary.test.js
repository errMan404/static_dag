import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureMacGitea } from '../src/runtime/gitea-binary.js';

const unsupported = process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch);

test('macOS Gitea 不安装截断或超出官方大小的下载并清理临时文件', {skip: unsupported}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'deveco-dag-gitea-binary-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const download = t.mock.method(globalThis, 'fetch', async () =>
    new Response('incomplete', {headers: {'content-length': '999999999'}})
  );
  await assert.rejects(ensureMacGitea(root), /响应的文件大小与发布清单不一致/);
  download.mock.mockImplementation(async () => new Response('incomplete'));
  await assert.rejects(ensureMacGitea(root), /下载大小与官方文件不一致/);

  assert.deepEqual(await readdir(join(root, 'bin')), []);
  assert.equal((await stat(join(root, 'bin'))).mode & 0o777, 0o700);
  assert.equal(download.mock.callCount(), 2);
});
