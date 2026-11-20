#!/usr/bin/env node
import {localGitea, enableWorkspaces} from '../src/runtime/local-gitea.js';

const command = process.argv[2];
try {
  if (command === 'setup') {
    const enabled = await enableWorkspaces();
    const runtime = await localGitea();
    console.log(`Local Gitea ready: ${runtime.url}\nData: ${runtime.dataRoot}`);
    if (!enabled) console.log(process.platform === 'win32'
      ? 'Workspace enabled for your Windows user. Close and reopen your terminal application before starting OpenCode.'
      : 'Start OpenCode with: OPENCODE_EXPERIMENTAL_WORKSPACES=true opencode');
  } else if (command === 'status') {
    const status = await localGitea('status');
    console.log(JSON.stringify(status, null, 2));
  } else {
    console.log('DevEco DAG for OpenCode 1.19.5 (macOS and Windows x64)\n\ndeveco-dag setup   Initialize/start local Gitea\ndeveco-dag status  Show local Gitea status\n\nIn OpenCode: /one_duo <requirement>, or /dag then /dag_run');
    if (command && !['--help', '-h'].includes(command)) process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
