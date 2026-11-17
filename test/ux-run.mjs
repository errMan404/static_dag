import {existsSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
process.env.DAG_TEST_UX = '1';
process.env.OPENCODE_BIN ??= resolve('.test-tmp/host/node_modules/opencode-windows-x64/bin/opencode.exe');
if (!existsSync(process.env.OPENCODE_BIN)) throw new Error('先安装隔离测试宿主：npm install --prefix .test-tmp/host --ignore-scripts opencode-ai@1.19.5，或设置 OPENCODE_BIN 指向 1.19.5');
mkdirSync(resolve('.test-tmp'), {recursive: true});
process.env.DAG_TEST_REPORT ??= resolve('.test-tmp/ux-flow-result.json');
await import('./run-integration.mjs');
