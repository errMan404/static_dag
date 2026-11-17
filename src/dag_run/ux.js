import {readFile, realpath, writeFile} from 'node:fs/promises';
import {resolve, relative, isAbsolute, join} from 'node:path';
import {createHash} from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => {throw new Error(`UX 输入错误：${message}`);};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim());

// One explicit protocol. Absence means a normal development DAG, not an older UX format.
export async function loadUx(root, tasks) {
  let bytes;
  try {bytes = await readFile(join(root, '.dag/ux.json'));}
  catch (error) {if (error.code === 'ENOENT') return; throw error;}
  const config = JSON.parse(bytes.toString('utf8'));
  if (!object(config) || config.version !== 1 || Object.keys(config).some(key =>
    !['version', 'cardsFile', 'device', 'requirements', 'nodes'].includes(key))) fail('需要 version=1 的 UX 清单');
  if (config.device !== null && !(typeof config.device === 'string' && config.device.trim())) fail('device 必须是设备标识或 null');
  if (!strings(config.requirements) || !Array.isArray(config.nodes)) fail('requirements/nodes 不合法');
  if (typeof config.cardsFile !== 'string' || !config.cardsFile.trim() || isAbsolute(config.cardsFile)) fail('cardsFile 必须是工程内相对路径');
  const base = await realpath(root), file = await realpath(resolve(root, config.cardsFile));
  const rel = relative(base, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) fail('cardsFile 越出工程目录');
  const cardBytes = await readFile(file), assets = JSON.parse(cardBytes.toString('utf8'));
  if (!object(assets) || !Array.isArray(assets.cards) || !assets.cards.length) fail('卡片包为空');
  const cards = new Map();
  for (const card of assets.cards) {
    if (!object(card) || typeof card.id !== 'string' || !card.id.trim() || cards.has(card.id)) fail('卡片 ID 为空或重复');
    cards.set(card.id, card);
  }
  const nodes = new Map(), ids = new Set(tasks.map(task => task.id));
  for (const node of config.nodes) {
    if (!object(node) || Object.keys(node).some(key => !['taskId', 'cardIds', 'requirements'].includes(key)) ||
      !ids.has(node.taskId) || nodes.has(node.taskId)) fail('节点 ID 未知或重复');
    if (!strings(node.cardIds) || !node.cardIds.length || new Set(node.cardIds).size !== node.cardIds.length ||
      node.cardIds.some(id => !cards.has(id)) || !strings(node.requirements)) fail(`节点 ${node.taskId} 的卡片或要求不合法`);
    nodes.set(node.taskId, {cardIds: node.cardIds, cards: node.cardIds.map(id => cards.get(id)), requirements: node.requirements});
  }
  if (nodes.size !== tasks.length) fail('每个 DAG 节点必须显式分配 UX 资产');
  return {version: 1, manifestDigest: hash(bytes), cardsDigest: hash(cardBytes),
    device: config.device, requirements: config.requirements, nodes: Object.fromEntries(nodes)};
}

export function nodeUx(ux, id) {
  if (!ux) return;
  return {version: ux.version, cardsDigest: ux.cardsDigest, device: ux.device,
    ...ux.nodes[id], requirements: [...ux.requirements, ...ux.nodes[id].requirements],
    acceptance: 'unverified', reason: ux.device === null ? 'no-device' : 'device-evidence-not-reviewed'};
}

export function uxInput(ux) {
  if (!ux) return '';
  return '\n\n本节点 UX 资产（本次分配优先于 Fork 历史中的其他节点资产）\n' +
    JSON.stringify(ux, null, 2) + '\n先阅读本节点卡片与实际源码，将选卡理由、布局、状态保持和验收步骤写入 ux-plans/task-<本节点编号>.json，再改业务代码。\n' +
    (ux.device === null ? '本轮未提供设备。继续设计、改码和可执行的本地检查；设备/交互/视觉验收必须标为 unverified，原因 no-device，不尝试安装或操作其他设备。\n' :
      '本最小版本尚未集成设备证据验证器。设备标识仅限定目标，不能据此宣称 UX 通过；不要并发操作设备。\n') +
    '在提交摘要中分别说明代码检查结果、未验证项和原因；PR 合并不代表 UX 验收通过。';
}

export async function writeUxReport(run) {
  if (!run.state.ux) return;
  const report = {version: 1, runId: run.state.id, execution: run.state.status,
    integrationCommit: run.state.syncedCommit, ...run.state.ux,
    delivery: run.state.status === 'done' ? 'partial' : 'incomplete',
    tasks: run.state.tasks.map(task => ({id: task.id, execution: task.status, commit: task.commit,
      mergeCommit: task.mergeCommit, cardIds: task.ux.cardIds, acceptance: task.ux.acceptance, reason: task.ux.reason}))};
  await writeFile(join(run.dir, 'ux-report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(join(run.dir, 'ux-report.md'), `# UX DAG 运行结果\n\nRichard，代码执行状态：${report.execution}；交付：${report.delivery}。\n\n` +
    `UX 验收：unverified；原因：${report.reason}。${report.reason === 'no-device' ? '本轮没有设备，未执行设备、交互与视觉验收。' : '设备证据尚未独立核验。'}\n\n` +
    `集成提交：${report.integrationCommit}\n\n` + report.tasks.map(task => `- 任务 ${task.id}：代码 ${task.execution}；UX ${task.acceptance}（${task.reason}）`).join('\n') + '\n');
}
