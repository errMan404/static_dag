import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { lstat, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parseDag } from './dag.js';
import { runnerHooks } from './dag_run/plugin.js';
import { enableWorkspaces } from './runtime/local-gitea.js';
import { tool } from '@opencode-ai/plugin';
import { capturePages, formatCapture, parseCaptureArgs } from './capture.js';
import { verifyPages, formatVerify } from './verify.js';
import { pagesBrief } from './dag-pages.js';
import { reviewPages, formatReview, verdictOf } from './review.js';
import { registry } from './dag_run/index.js';
import { parsePages } from './prepare.js';
import { patchFiles, replaceAdded } from './patch.js';

const loaded = globalThis[Symbol.for('static-dag.v2.instances')] ??= new Map();
const fileKey = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const normalize = path => path.replaceAll('\\', '/');
const loadPrompt = name => readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8').trim();
const render = (text, values) => text.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key]);

export default async function DagPlugin({ client, directory, worktree, serverUrl, experimental_workspace }) {
  const key = `${serverUrl?.origin ?? 'local'}|${fileKey(directory)}`;
  if (loaded.has(key)) return {};
  const root = resolve(worktree && worktree !== '/' ? worktree : directory);
  const dagPath = join(root, '.dag', 'dag.json'), pagesPath = join(root, '.dag', 'pages.json');
  const system = loadPrompt('planner'), command = loadPrompt('command'), pagesCommand = loadPrompt('dag_pages');
  const active = new Map();
  const runner = runnerHooks({ client, root, experimental_workspace });
  const toast = async (message, variant = 'info') => {
    try { await client?.tui?.showToast({ body: { title: 'DAG', message, variant } }); } catch { /* UI must not interrupt generation. */ }
  };
  async function checkTarget() {
    for (const path of [join(root, '.dag'), dagPath]) {
      try { if ((await lstat(path)).isSymbolicLink()) throw new Error(`DAG 目标不能是符号链接：${path}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  // What earlier rounds said about the same page on the same device, so that this round continues from them.
  const earlierOpinions = earlier => !earlier.length ? '' : `\n\n这是对这一页的第 ${earlier.length + 1} 轮评审。此前各轮在同一台设备上的评审意见如下，请按“后续轮次”的规则评审。\n\n` +
    earlier.map(r => `—— 第 ${r.round} 轮（${r.verdict === 'pass' ? '通过' : '需修改'}）——\n${r.text}`).join('\n\n');
  // One fresh session per review, with the reviewer agent and nothing but the screenshots: the reviewer must not
  // inherit the task's conversation, or it would be judging the task's story instead of the screen.
  async function askReviewer({ page, config, images, notes, earlier = [] }, workerSession) {
    const check = value => { const error = value.error ?? value.data?.info?.error; if (error || !value.data) throw new Error(`评审请求失败：${JSON.stringify(error ?? '宿主返回空结果')}`); return value.data; };
    const query = { directory: root };
    // Inside a DAG run the review is recorded on the task, so the dashboard can show it as a node under that task.
    const worker = registry.workers.get(workerSession);
    const session = check(await client.session.create({ query, body: { title: `评审 ${page} · ${config}` } }));
    const record = worker && { session: session.id, page, config, round: (worker.task.reviews ?? []).filter(r => r.page === page && r.config === config).length + 1 };
    if (record) { (worker.task.reviews ??= []).push(record); await worker.run.save(); await worker.run.progress?.update(`节点 ${worker.task.id} · 评审 ${page}`); }
    const parts = [{ type: 'text', text: `页面：${page}。下面按顺序给出 ${images.length} 张截图。` + (notes ? `\n\n这个项目的补充评审要求：\n${notes}` : '') + earlierOpinions(earlier) }];
    for (const image of images) {
      parts.push({ type: 'text', text: `【${image.label}】` });
      parts.push({ type: 'file', mime: 'image/png', filename: `${image.label}.png`, url: pathToFileURL(image.path).href });
    }
    const reply = check(await client.session.prompt({ path: { id: session.id }, query, body: { agent: 'dag-reviewer', parts } }));
    const text = (reply.parts ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n').trim();
    if (!text) throw new Error('评审没有返回文字');
    if (record) { record.verdict = verdictOf(text); await worker.run.save(); await worker.run.progress?.update(`节点 ${worker.task.id} · 评审 ${page}：${record.verdict === 'pass' ? '通过' : '需修改'}`); }
    return text;
  }
  const hooks = {
    config: async config => {
      config.command ??= {}; config.agent ??= {};
      runner.config(config);
      if (config.command.dag || config.agent['dag-planner']) throw new Error('/dag 或 dag-planner 已被其他配置占用');
      config.command.dag = { description: '分析需求并生成 .dag/dag.json（只规划）', template: '$ARGUMENTS', agent: 'dag-planner' };
      if (config.command.dag_pages) throw new Error('/dag_pages 已被其他配置占用');
      // Same planner and the same validated write as /dag; only the request is built from the page list.
      config.command.dag_pages = { description: '按 .dag/pages.json 把多设备适配拆成按页面并行的任务，生成 .dag/dag.json（用法：/dag_pages [页面名…] [补充要求]）', template: '$ARGUMENTS', agent: 'dag-planner' };
      if (config.command.prepare) throw new Error('/prepare 已被其他配置占用');
      // Runs in the user's current agent: it needs skills, edit and shell access, unlike the read-only planner.
      config.command.prepare = { description: '为全部页面注册自定义网址直达入口并生成 .dag/pages.json', template: loadPrompt('prepare') };
      if (config.command.capture) throw new Error('/capture 已被其他配置占用');
      // The agent only relays one tool call; opening pages and dumping layouts is done by code.
      config.command.capture = { description: '按 .dag/pages.json 逐页冷启动并导出组件树到 .dag/captures/<config>/（用法：/capture [device=序列号] [config=名称] [页面名…]）', template: loadPrompt('capture') };
      if (config.agent['dag-reviewer']) throw new Error('dag-reviewer 已被其他配置占用');
      // The reviewer only looks. Its model can be set apart from the workers' with "reviewerModel" in .dag/runner.json.
      let reviewerModel;
      try { reviewerModel = JSON.parse(readFileSync(join(root, '.dag', 'runner.json'), 'utf8')).reviewerModel; } catch { /* optional */ }
      config.agent['dag-reviewer'] = { description: '宽屏适配界面评审（只看截图）', mode: 'subagent', hidden: true, prompt: loadPrompt('reviewer'),
        permission: { '*': 'deny' }, ...(typeof reviewerModel === 'string' && reviewerModel && { model: reviewerModel }) };
      if (config.agent['dag-stage']) throw new Error('dag-stage 已被其他配置占用');
      // Runs a pipeline stage (such as /prepare) unattended: nobody is there to answer a permission prompt.
      // A primary agent: a command bound to a subagent is run through the Task tool, which a child session may not nest.
      config.agent['dag-stage'] = { description: '一多适配流程的阶段执行', mode: 'primary', hidden: true,
        prompt: '你在一条无人值守的流程里执行其中一个阶段。严格按本轮消息的要求完成，如实报告结果；遇到无法完成的情况直接说明原因并结束，不要向用户提问。',
        permission: { '*': 'allow', task: 'deny' } };
      config.agent['dag-planner'] = { description: 'DAG 任务规划', mode: 'primary', hidden: true, prompt: system,
        permission: { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow',
          edit: { '*': 'deny', '.dag/dag.json': 'allow', [normalize(dagPath)]: 'allow' } } };
    },
    'command.execute.before': async (input, output) => {
      if (input.command !== 'dag' && input.command !== 'dag_pages') return;
      const requirement = input.arguments.trim();
      if (input.command === 'dag_pages') {
        // OpenCode logs an error thrown here but shows nothing in the TUI, so say it in a toast first.
        const brief = await pagesBrief({ root, input: requirement }).catch(async error => { await toast(error.message, 'error'); throw error; });
        active.set(input.sessionID, { pending: new Map(), saved: false });
        const files = output.parts.filter(p => p.type !== 'text');
        output.parts.splice(0, output.parts.length, { type: 'text', text: `/dag_pages ${requirement}`.trim() }, ...files,
          { type: 'text', synthetic: true, text: render(pagesCommand, { brief: brief.text, extra: brief.extra || '无', directory, worktree: root, dag_path: dagPath }) });
        return;
      }
      if (!requirement) throw new Error('用法：/dag 需求描述');
      active.set(input.sessionID, { pending: new Map(), saved: false });
      const attachments = output.parts.filter(p => p.type !== 'text');
      // OpenCode keeps this array by reference. Replacing output.parts is ignored.
      output.parts.splice(0, output.parts.length, { type: 'text', text: `/dag ${requirement}` }, ...attachments,
        { type: 'text', synthetic: true, text: render(command, { requirement, directory, worktree: root, dag_path: dagPath }) });
    },
    'chat.message': async input => {
      if (input.agent !== 'dag-planner') active.delete(input.sessionID);
      else if (!active.has(input.sessionID)) active.set(input.sessionID, { pending: new Map(), saved: false });
    },
    'tool.execute.before': async (input, output) => {
      await runner.before(input, output);
      // The page list is the contract between /prepare and every later stage, so it is checked where it is
      // written, in any session: an invalid list never reaches disk and the agent gets the reason back.
      const target = output.args?.filePath;
      if (typeof target === 'string' && fileKey(resolve(directory, target)) === fileKey(pagesPath)) {
        if (input.tool === 'write') output.args.content = JSON.stringify(parsePages(String(output.args.content ?? '')), null, 2) + '\n';
        else if (['edit', 'multiedit', 'patch'].includes(input.tool)) throw new Error('.dag/pages.json 只能用 write 提交完整内容，插件在写入前校验');
      }
      // Models that are given apply_patch have no write tool: for them a whole file arrives as an added file.
      const patch = input.tool === 'apply_patch' && typeof output.args?.patchText === 'string' ? patchFiles(output.args.patchText) : [];
      const at = path => patch.find(f => fileKey(resolve(directory, f.path)) === fileKey(path));
      const submit = async (file, path, label, parse) => {
        if (file.op !== 'add') throw new Error(`${label} 只能整份提交：在 apply_patch 里用 "*** Add File: ${file.path}" 写入完整内容，插件在写入前校验`);
        const value = parse(file.content);
        output.args.patchText = replaceAdded(output.args.patchText, file.path, JSON.stringify(value, null, 2));
        return async () => { await rm(path, { force: true }); return value; }; // an added file must not exist yet; this one replaces it
      };
      if (at(pagesPath)) await (await submit(at(pagesPath), pagesPath, '.dag/pages.json', parsePages))();
      const run = active.get(input.sessionID);
      if (!run) return;
      if (['read', 'glob', 'grep'].includes(input.tool)) return;
      if (input.tool === 'apply_patch') {
        if (patch.length !== 1 || !at(dagPath)) throw new Error(`唯一允许写入的路径是 ${dagPath}`);
        const replace = await submit(patch[0], dagPath, 'DAG', parseDag);
        await checkTarget();
        run.pending.set(input.callID, JSON.stringify(await replace()));
        return;
      }
      if (input.tool !== 'write') throw new Error('DAG 规划仅允许只读探索和 write 提交目标文件');
      const path = output.args.filePath;
      if (typeof path !== 'string' || !isAbsolute(path) || fileKey(path) !== fileKey(dagPath)) throw new Error(`唯一允许写入的路径是 ${dagPath}`);
      const dag = parseDag(output.args.content);
      await checkTarget();
      output.args.filePath = dagPath;
      output.args.content = JSON.stringify(dag, null, 2) + '\n';
      run.pending.set(input.callID, JSON.stringify(dag));
    },
    'tool.execute.after': async (input, output) => {
      await runner.after(input);
      const run = active.get(input.sessionID);
      const expected = run?.pending.get(input.callID);
      if (!['write', 'apply_patch'].includes(input.tool) || !expected) return;
      run.pending.delete(input.callID);
      const dag = parseDag(await readFile(dagPath, 'utf8'));
      if (JSON.stringify(dag) !== expected) throw new Error('DAG 写入结果与校验内容不一致，请重新提交');
      run.saved = true;
      output.title = `DAG 已生成 · ${dag.tasks.length} 个任务`;
      output.output += `\nDAG 校验及写入确认通过。任务数：${dag.tasks.length}；文件：${dagPath}`;
      output.metadata = { ...output.metadata, dagPath, taskCount: dag.tasks.length, dagValidated: true };
    },
    event: async ({ event }) => {
      await runner.event(event);
      if (!['session.idle', 'session.error', 'session.deleted'].includes(event.type)) return;
      const sessionID = event.properties?.sessionID ?? event.properties?.info?.id;
      const run = active.get(sessionID);
      if (!run) return;
      active.delete(sessionID);
      if (!run.saved && event.type === 'session.idle') await toast('本轮未成功写入有效 DAG，请查看 Agent 输出；旧文件不代表本轮完成。', 'warning');
    },
    'chat.params': input => runner.params(input),
    tool: { ...runner.tool,
      capture_pages: tool({ description: '按页面清单逐页冷启动应用、执行到达步骤并导出组件树和截图。确定性执行，不修改工程源码。',
        args: { input: tool.schema.string().describe('原样传入 /capture 后的参数：device=<序列号> config=<名称> 及页面名，可为空') },
        execute: async (args, context) => {
          const options = parseCaptureArgs(args.input);
          return formatCapture(await capturePages({ root, ...options,
            log: message => context.metadata?.({ title: `采集 · ${message}` }) }));
        } }),
      // Works from a task worktree as well as the main checkout: the directory comes from the calling session.
      verify_page: tool({ description: '在设备上查看当前工作目录的改动效果：编译当前目录，按设备排队安装，打开指定页面并导出组件树和截图，同时给出改动前的基准供对比。设备由多个任务共用，这是使用设备的唯一途径；排队和释放由工具完成，可能需要等待几分钟。',
        args: { input: tool.schema.string().describe('要查看的页面名（.dag/pages.json 里的 name），多个用空格分隔') },
        execute: async (args, context) => formatVerify(await verifyPages({ codeDir: context.directory ?? root,
          pages: args.input.trim().split(/\s+/).filter(Boolean),
          log: message => context.metadata?.({ title: `验证 · ${message}` }) })) }),
      review_page: tool({ description: '取得独立评审意见：重新编译并截取指定页面，由另一个只看截图的评审给出“通过”或“需修改”及具体问题。提交前对本任务的每个页面调用；每个页面最多评审 3 次。',
        args: { input: tool.schema.string().describe('要评审的页面名（.dag/pages.json 里的 name），多个用空格分隔') },
        execute: async (args, context) => formatReview(await reviewPages({ codeDir: context.directory ?? root,
          pages: args.input.trim().split(/\s+/).filter(Boolean), ask: request => askReviewer(request, context.sessionID),
          log: message => context.metadata?.({ title: `评审 · ${message}` }) })) }) },
    dispose: async () => { active.clear(); await runner.dispose(); if (loaded.get(key) === hooks) loaded.delete(key); }
  };
  if (process.platform === 'win32') await enableWorkspaces().catch(() => {});
  loaded.set(key, hooks);
  return hooks;
}
