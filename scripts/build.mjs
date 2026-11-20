import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {transformAsync} from '@babel/core';
import solid from 'babel-preset-solid';

if (process.platform === 'win32' || process.argv.includes('--verify-bundled-gitea')) {
  const manifest = JSON.parse(await readFile(new URL('../vendor/gitea/manifest.json', import.meta.url), 'utf8'));
  const binary = await readFile(new URL('../vendor/gitea/' + manifest.file, import.meta.url));
  if (createHash('sha256').update(binary).digest('hex') !== manifest.sha256) throw new Error('Bundled Gitea SHA-256 mismatch');
  console.log('Verified bundled Gitea ' + manifest.version + ' (Windows x64)');
}
await mkdir(new URL('../dist/', import.meta.url), {recursive: true});
const source = await readFile(new URL('../src/dag_run/dashboard.tsx', import.meta.url), 'utf8');
const result = await transformAsync(source, {filename: 'dashboard.tsx', babelrc: false, configFile: false,
  presets: [[solid, {generate: 'universal', moduleName: '@opentui/solid'}]], comments: false});
await writeFile(new URL('../dist/dashboard.js', import.meta.url), result.code.replace("'./panel-model.js'", "'../src/dag_run/panel-model.js'").replace('"./panel-model.js"', '"../src/dag_run/panel-model.js"') + '\n');
const entry = (await readFile(new URL('../src/dag_run/tui.js', import.meta.url), 'utf8'))
  .replace('./dashboard.tsx', './dashboard.js').replace('./tui-controller.js', '../src/dag_run/tui-controller.js');
await writeFile(new URL('../dist/tui.js', import.meta.url), entry);
console.log('Built TUI');
