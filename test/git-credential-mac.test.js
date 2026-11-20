import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('macOS 凭据助手仅对指定回环地址返回令牌且忽略写入请求', {skip: process.platform === 'win32'}, async () => {
  const root = await mkdtemp(join(tmpdir(), "gitea user's "));
  const helper = join(root, 'git-credential.sh');
  const token = 'a'.repeat(40);
  try {
    await mkdir(join(root, 'secrets'));
    await writeFile(join(root, 'secrets/token'), token + '\n', {mode: 0o600});
    await copyFile(new URL('../src/runtime/git-credential-mac.sh', import.meta.url), helper);
    const result = (action, protocol, host) => spawnSync('/bin/sh',
      [helper, 'http://127.0.0.1:42910', 'dag-agent', action],
      {input: `protocol=${protocol}\nhost=${host}\n\n`, encoding: 'utf8'}).stdout;
    assert.equal(result('get', 'http', '127.0.0.1:42910'), `username=dag-agent\npassword=${token}\n\n`);
    assert.equal(result('get', 'http', '127.0.0.1:42911'), '');
    assert.equal(result('get', 'https', '127.0.0.1:42910'), '');
    assert.equal(result('get', 'http', 'example.invalid:42910'), '');
    assert.equal(result('store', 'http', '127.0.0.1:42910'), '');
    assert.equal(result('erase', 'http', '127.0.0.1:42910'), '');
  } finally { await rm(root, {recursive: true}); }
});
