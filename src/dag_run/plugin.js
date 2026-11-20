import { tool } from '@opencode-ai/plugin';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { git } from './git.js';
import { DagRun, registry, guardWorker } from './index.js';
import { Progress } from './progress.js';
const prompt = name => readFileSync(new URL(`./${name}.md`, import.meta.url), 'utf8');
export function runnerHooks({ client, root, experimental_workspace, resumeOneDuo }) {
  experimental_workspace?.register('dag-task', {
    name: 'DAG task worktree', description: 'Existing Git worktree owned by DAG runtime',
    configure(info) { return { ...info, directory: resolve(info.extra.directory) }; },
    async create() {}, async remove() {}, target(info) { return { type: 'local', directory: info.directory }; }
  });
  const s = tool.schema;
  const hooks = {
    config(config) {
      if (config.agent['dag-worker']) throw new Error('dag-worker 已存在');
      config.agent['dag-worker'] = { mode: 'subagent', hidden: true, prompt: prompt('worker'),
        permission: { '*': 'allow', skill: 'allow', devecocli: 'allow', task: 'deny', submit_plan: 'deny', submit_checklist: 'deny',
          list_evaluation_devices: 'deny', reserve_evaluation_device: 'deny', record_check_result: 'deny' } };
    },
    tool: {
      submit_task: tool({ description: '已测试并 git commit 后提交本节点PR。冲突直接作为返回值，解决冲突并重新测试提交后重试。', args: { summary: s.string().min(1) }, execute: async (args, context) => {
        const worker = registry.workers.get(context.sessionID); if (!worker) throw new Error('submit_task 仅允许 DAG 节点会话调用');
        return JSON.stringify(await worker.run.submit(worker.task, args.summary));
      } }),
      git: tool({ description: '在当前 DAG 节点 worktree 中执行 git，参数为字符串数组，不使用Shell拼接。', args: { args: s.array(s.string()).min(1) }, execute: async (args, context) => {
        const worker = registry.workers.get(context.sessionID); if (!worker) throw new Error('git 工具仅允许 DAG 节点使用');
        if (resolve(context.directory) !== resolve(worker.task.worktree)) throw new Error('宿主工具执行目录与节点 worktree 不一致');
        if (args.args.some(a => a.startsWith('-C') || a.startsWith('--git-dir') || a.startsWith('--work-tree') || a.startsWith('-c') || a.startsWith('--config-env'))) throw new Error('不能改变 Git 工作目录或执行配置');
        return git(worker.task.worktree, args.args, context.abort);
      } })
    },
    async params(input) {
      const worker = registry.workers.get(input.sessionID);
      if (!worker || worker.run.state.status !== 'running') return;
      await worker.run.modelGate.acquire(worker.run.controller.signal);
      if (worker.task.retry?.waiting) {
        worker.task.retry.waiting = false;
        await worker.run.save();
        await worker.run.progress?.update(`节点 ${worker.task.id} · 继续原 Agent 会话`, input.sessionID);
      }
    },
    async control(input) {
      if (input.action === 'resume-one-duo') {
        try { await resumeOneDuo({sessionID: input.sessionID, workflowId: input.workflowId}); }
        catch (error) { await new Progress(client, root, input.sessionID).toast(error.message, 'error'); }
        return;
      }
      const existing = registry.runs.get(input.sessionID);
      const active = registry.roots.get(root);
      const workflow = registry.workflows.get(root);
      if (workflow && input.action === 'start') {
        await workflow.progress.toast('当前 worktree 已有 /one_duo 在执行');
        return;
      }
      if (workflow?.parent === input.sessionID) {
        if (input.action === 'cancel') await workflow.cancel();
        if (input.action === 'status') await workflow.progress.update();
        return;
      }
      if (input.action === 'start' && active) {
        if (active.parent === input.sessionID) { await active.progress?.update('当前 DAG 已在运行'); return; }
        const notice = new Progress(client, root, input.sessionID);
        notice.status = '启动失败';
        await notice.open(); await notice.finish('当前 worktree 已有 DAG 在其他 session 运行，请切换到原 session 查看。');
        return;
      }
      if (input.action === 'cancel') { await existing?.cancel(); return; }
      if (input.action === 'status' && existing) { await existing.progress?.update(); return; }
      if (input.action === 'status') {
        const result = await client.session.messages({path: {id: input.sessionID}, query: {directory: root}});
        const part = result.data?.flatMap(message => message.parts).findLast(part => part.metadata?.dagView?.root === root);
        if (part) {
          const view = part.metadata.dagView;
          if (['running', '启动检查'].includes(view.status)) {
            const detail = '当前服务器没有活动调度器。以下是最后记录，不表示任务仍在执行，也不会自动恢复。';
            await client._client.patch({url: `/session/${input.sessionID}/message/${part.messageID}/part/${part.id}`,
              query: {directory: root}, body: {...part, synthetic: true, ignored: true, text: 'DAG 历史记录\n' + detail,
                metadata: {...part.metadata, dagView: {...view, status: '历史记录', detail}}}, headers: {'Content-Type': 'application/json'}});
          }
          return;
        }
      }
      const progress = new Progress(client, root, input.sessionID);
      await progress.open();
      if (input.action === 'status') { progress.status = '未运行'; await progress.finish('此会话没有活动 DAG，历史记录不会自动恢复执行'); return; }
      if (input.action !== 'start') return;
      try {
        const run = await DagRun.start(root, input.sessionID, client);
        progress.attach(run);
        await progress.update(`DAG 已加载，共 ${run.state.tasks.length} 个节点，由框架自动调度`);
        run.background = run.execute().catch(async error => {
          run.state.status = 'failed'; run.state.error = error.message;
          await Promise.allSettled([run.release(), progress.finish(error.message)]);
        });
      } catch (error) {
        const message = error.code === 'ENOENT' ? '当前 worktree 下不存在 .dag/dag.json，请先运行 /dag 生成 DAG。' : error.message;
        progress.status = '启动失败';
        await progress.finish(message);
        await progress.toast(message, 'error');
        throw new Error(message);
      }
    },
    async before(input, output) {
      guardWorker(input.sessionID, input.tool, output.args);
      const worker = registry.workers.get(input.sessionID);
      await worker?.run.progress?.update(`节点 ${worker.task.id} · ${input.tool} · 执行中`, input.sessionID);
    },
    async after(input) {
      const worker = registry.workers.get(input.sessionID);
      await worker?.run.progress?.update(`节点 ${worker.task.id} · ${input.tool} · 已返回`, input.sessionID);
    },
    async event(event) {
      const part = event.properties?.part, control = part?.metadata?.dagControl;
      if (event.type === 'message.part.updated' && part?.type === 'text' && part.ignored && control &&
          part.metadata.dagControlHandled !== true && typeof control.requestId === 'string' &&
          Number.isFinite(control.issuedAt) && Math.abs(Date.now() - control.issuedAt) < 300000 &&
          ['start', 'status', 'cancel', 'resume-one-duo'].includes(control.action) && typeof control.root === 'string' && resolve(control.root).toLowerCase() === root.toLowerCase()) {
        const seen = registry.controls ??= new Set();
        const key = `${part.sessionID}:${part.id}`;
        if (seen.has(key)) return;
        seen.add(key);
        // Persist consumption before dispatch. Cosmetic edits and historical
        // replay must never re-run an old command, even after a server restart.
        void (async () => {
          const result = await client._client.patch({url: `/session/${part.sessionID}/message/${part.messageID}/part/${part.id}`,
            query: {directory: root}, body: {...part, synthetic: true, ignored: true,
              metadata: {...part.metadata, dagControlHandled: true}}, headers: {'Content-Type': 'application/json'}, signal: AbortSignal.timeout(5000)});
          if (result.error) throw new Error('保存 DAG 控制消息处理标记失败');
          await hooks.control({sessionID: part.sessionID, action: control.action, workflowId: control.workflowId});
        })().catch(() => {});
      }
      if (event.type === 'session.deleted') {
        const id = event.properties?.info?.id;
        const workflow = registry.workflows.get(root);
        if (workflow?.parent === id) await workflow.cancel();
        else await registry.runs.get(id)?.cancel();
      }
    },
    async dispose() {
      const workflow = registry.workflows.get(root);
      if (workflow) { await workflow.cancel(); await workflow.background; }
      const runs = [...registry.roots.values()].filter(run => run.root === root);
      await Promise.allSettled(runs.map(async run => { await run.cancel(); await run.background; }));
    }
  };
  return hooks;
}
