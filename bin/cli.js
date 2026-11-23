#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parsePages, summarizePages} from '../src/prepare.js';
import {localGitea, enableWorkspaces} from '../src/runtime/local-gitea.js';

const command = process.argv[2];
try {
  if (command === 'setup') {
    const enabled = await enableWorkspaces();
    const runtime = await localGitea();
    console.log(`Local Gitea ready: ${runtime.url}\nData: ${runtime.dataRoot}`);
    if (!enabled) console.log('Workspace enabled for your Windows user. Close and reopen your terminal application before starting OpenCode.');
  } else if (command === 'status') {
    const status = await localGitea('status');
    console.log(JSON.stringify(status, null, 2));
  } else if (command === 'pages') {
    const file = resolve(process.argv[3] ?? '.dag/pages.json');
    const manifest = parsePages(await readFile(file, 'utf8'));
    console.log(`页面清单校验通过：${file}\n共 ${manifest.pages.length} 页 ${JSON.stringify(summarizePages(manifest))}`);
  } else {
    console.log('DevEco DAG for OpenCode 1.19.5 (Windows x64)\n\ndeveco-dag setup   Initialize/start bundled local Gitea\ndeveco-dag status  Show local Gitea status\ndeveco-dag pages [file]  Validate the page manifest written by /prepare (default .dag/pages.json)\n\nIn OpenCode: /dag <requirement>, then /dag_run');
    if (command && !['--help', '-h'].includes(command)) process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
