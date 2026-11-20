import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tool } from '@opencode-ai/plugin';
import { validateDag } from '../dag.js';
import { nextToolActivity } from '../dag_run/progress.js';
import { guardReadPaths, readTools, rememberSkillDirectory } from '../runtime/skill-files.js';
import { checkIdsInTask, targetKey, validateChecklist, validateTargetNames } from './contracts.js';
import { resumeOneDuo, startOneDuo } from './index.js';

const plannerAgent = 'dag-one-duo-planner';
const repairAgent = 'dag-one-duo-repair-planner';
const repairTools = [...readTools, 'skill', 'devecocli', 'submit_plan'];
const planningTools = [...repairTools, 'submit_checklist'];
const abortedFinish = new Set(['tool-calls', 'length', 'content-filter', 'error', 'unknown']);
const prompt = readFileSync(new URL('./planner.md', import.meta.url), 'utf8').trim();
const s = tool.schema;

export function parseOneDuoArgs(args) {
  const requirement = args.trim();
  if (!requirement) throw new Error('用法：/one_duo 用自然语言描述需求和要适配的目标设备');
  if (/^--targets(?:\s|$)/u.test(requirement)) {
    const match = requirement.match(/^--targets[ \t]+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))\s+([\s\S]+)$/u);
    if (!match) throw new Error('用法：/one_duo --targets "目标设备 A,目标设备 B" 需求描述');
    const [, doubleQuoted, singleQuoted, bare, description] = match;
    const targets = validateTargetNames((doubleQuoted ?? singleQuoted ?? bare).split(/[,，、]/u));
    return {targets, requirement: description.trim()};
  }
  return {requirement};
}

function submittedTargets(plan, suggested) {
  if (!plan.targets) {
    if (!suggested) throw new Error('请在 targets 中提交原始需求明确指定的目标设备名称');
    return validateTargetNames(suggested, plan.requirement);
  }
  if (suggested) {
    const names = validateTargetNames(suggested);
    const expected = new Set(plan.targets.map(targetKey));
    if (names.length !== expected.size || names.some(name => !expected.has(targetKey(name)))) {
      throw new Error('targets 必须与用户指定的设备清单一致');
    }
  }
  return plan.targets;
}

const taskSchema = s.object({
  id: s.number().int().positive(),
  title: s.string().min(1),
  description: s.string().min(1),
  details: s.string().optional(),
  testStrategy: s.string().min(1),
  dependencies: s.array(s.number().int().positive()),
  priority: s.enum(['high', 'medium', 'low']).optional(),
  status: s.literal('pending').optional()
}).strict();

const itemSchema = s.object({
  id: s.string().min(1),
  target: s.string().min(1),
  steps: s.array(s.string().min(1)).min(1),
  expected: s.string().min(1)
}).strict();

function planningPart(plan, input) {
  const title = plan.initial ? '首次开发规划' : '修复规划';
  return {
    type: 'text', ...(plan.initial ? {synthetic: true} : {}),
    text: `阶段：${title}\n当前工作区：${plan.root}\n本轮规划输入：\n${JSON.stringify(input, null, 2)}`,
    metadata: { oneDuoPlanRequest: plan.requestId }
  };
}

function confirmedPlan(plan, info) {
  plan.signal.throwIfAborted();
  if (!plan.messageID || info?.role !== 'assistant' || info.parentID !== plan.messageID ||
      info.error || !info.time?.completed || !info.finish || abortedFinish.has(info.finish)) {
    throw new Error('规划会话未正常完成');
  }
  plan.finished = true;
  if (!plan.dag) throw new Error('本轮规划未通过 submit_plan 提交有效 DAG');
  if (plan.initial && !plan.checklist) throw new Error('首轮规划未通过 submit_checklist 提交验收清单');
  return plan.initial ? {dag: plan.dag, checklist: plan.checklist, targets: plan.targets} : plan.dag;
}

async function persistInitialPlan(plan) {
  if (plan.dag && plan.checklist) await plan.workflow.savePlan(plan);
}

export function oneDuoPlanning({root, directory, client}) {
  const plans = new Map();
  const query = {directory};
  function registered(context) {
    const plan = plans.get(context.sessionID);
    if (!plan || !plan.messageID || plan.finished || context.agent !== plan.agent) {
      throw new Error('该工具只允许当前流程的规划会话调用');
    }
    plan.signal.throwIfAborted();
    context.abort?.throwIfAborted();
    return plan;
  }

  async function abortSession(sessionID) {
    await client.session.abort({path: {id: sessionID}, query, signal: AbortSignal.timeout(5000)}).catch(() => {});
  }

  async function planRepair(workflow, input) {
    const timeout = AbortSignal.timeout(workflow.config.timeoutMs);
    const signal = AbortSignal.any([workflow.controller.signal, timeout]);
    const session = await client.session.create({
      query, signal,
      body: {title: '按评测报告规划修复', parentID: workflow.parent}
    });
    signal.throwIfAborted();
    if (session.error || !session.data?.id) throw new Error('无法创建修复规划会话');
    const id = session.data.id;
    const failedCheckIds = Object.keys(input.report.results).filter(id => input.report.results[id].status === 'failed');
    const round = workflow.state.round + 1;
    const plan = {initial: false, agent: repairAgent, root, signal, failedCheckIds, requestId: randomUUID(), workflow, round,
      save: dag => workflow.savePlan({dag, targets: input.targets, checklist: input.checklist}, input.commit, workflow.state.round)};
    plans.set(id, plan);
    workflow.updatePlanning(round, {session: id});
    try {
      const response = await client.session.prompt({
        path: {id}, query, signal,
        body: {agent: repairAgent, parts: [planningPart(plan, {
          requirement: workflow.requirement, targets: input.targets,
          commit: input.commit, checklist: input.checklist, reportPath: input.reportPath, report: input.report
        })]}
      });
      if (response.error) throw new Error('修复规划请求失败');
      return confirmedPlan(plan, response.data?.info);
    } catch (error) {
      if (timeout.aborted && !workflow.controller.signal.aborted) throw new Error('修复规划超时');
      throw error;
    } finally {
      if (signal.aborted) await abortSession(id);
      plans.delete(id);
    }
  }

  return {
    configure(config) {
      if (config.command.one_duo || config.agent[plannerAgent] || config.agent[repairAgent]) {
        throw new Error('/one_duo 或其规划 Agent 已被其他配置占用');
      }
      config.command.one_duo = {
        description: '规划并运行开发、评测和按报告修复的流程', template: '$ARGUMENTS', agent: plannerAgent
      };
      config.agent[plannerAgent] = {
        description: '规划开发或修复并确认首轮验收清单',
        mode: 'primary', hidden: true, prompt,
        permission: {'*': 'deny', ...Object.fromEntries(planningTools.map(name => [name, 'allow'])), external_directory: 'allow'}
      };
      config.agent[repairAgent] = {
        description: '根据当前版本的评测报告规划修复',
        mode: 'subagent', hidden: true, prompt,
        permission: {'*': 'deny', ...Object.fromEntries(repairTools.map(name => [name, 'allow'])), external_directory: 'allow'}
      };
    },
    async command(input, output) {
      const original = {...parseOneDuoArgs(input.arguments), parent: input.sessionID};
      const plan = {initial: true, round: 1, agent: plannerAgent, root, requirement: original.requirement,
        targets: original.targets, requestId: randomUUID()};
      const workflow = await startOneDuo({
        root, directory, client, ...original,
        planRepair,
        abortInitial: async () => {
          if (plan.messageID && !plan.finished) await abortSession(input.sessionID);
        }
      });
      plan.workflow = workflow;
      plan.signal = workflow.controller.signal;
      plan.signal.throwIfAborted();
      plans.set(input.sessionID, plan);
      const cleanup = () => {
        if (plans.get(input.sessionID) === plan) plans.delete(input.sessionID);
      };
      void workflow.background.then(cleanup, cleanup);
      const attachments = output.parts.filter(part => part.type !== 'text');
      output.parts.splice(0, output.parts.length,
        {type: 'text', text: `/one_duo ${input.arguments.trim()}`},
        ...attachments,
        planningPart(plan, {requirement: original.requirement, targets: original.targets}));
    },
    resume({sessionID, workflowId}) {
      return resumeOneDuo({root, directory, client, parent: sessionID, workflowId, planRepair});
    },
    message(input, output) {
      const plan = plans.get(input.sessionID);
      if (!plan || input.agent !== plan.agent) return;
      if (output?.parts?.some(part => part.metadata?.oneDuoPlanRequest === plan.requestId)) {
        plan.messageID ??= output.message?.id ?? input.messageID;
      }
    },
    guardPrompt(input) {
      const plan = plans.get(input.sessionID);
      if (!plan && input.agent !== plannerAgent && input.agent !== repairAgent) return;
      if (!plan || !plan.messageID || plan.finished || input.agent !== plan.agent || input.message?.id !== plan.messageID) {
        throw new Error('仅允许当前流程的规划消息执行');
      }
      plan.signal.throwIfAborted();
    },
    async guardTool(input, args) {
      const plan = plans.get(input.sessionID);
      if (!plan) return;
      plan.signal.throwIfAborted();
      if (plan.finished || !(plan.initial ? planningTools : repairTools).includes(input.tool)) {
        throw new Error('规划会话只能读取工程和提交当前阶段的规划产物');
      }
      if (readTools.includes(input.tool)) await guardReadPaths(plan, args, directory, root);
    },
    async observeTool(input, output) {
      const plan = plans.get(input.sessionID);
      if (input.tool === 'skill' && plan) await rememberSkillDirectory(plan, output);
    },
    event(event) {
      if (event.type === 'message.part.updated') {
        const part = event.properties?.part;
        if (part?.type !== 'tool' || !planningTools.includes(part.tool)) return;
        const plan = plans.get(part.sessionID);
        if (!plan || plan.finished || plan.signal.aborted) return;
        const activity = nextToolActivity(part, plan.workflow.state.planning?.activity);
        if (activity) plan.workflow.updatePlanning(plan.round, {activity});
        return;
      }
      if (!['session.idle', 'session.error', 'session.deleted'].includes(event.type)) return;
      const id = event.properties?.sessionID ?? event.properties?.info?.id;
      const plan = plans.get(id);
      if (!plan?.initial || plan.settling || plan.finished) return;
      if (!plan.messageID && event.type !== 'session.deleted') return;
      plan.settling = true;
      if (event.type !== 'session.idle') {
        plans.delete(id);
        plan.workflow.firstPlan.reject(new Error('首轮规划会话中断'));
        return;
      }
      void (async () => {
        const messages = await client.session.messages({
          path: {id}, query, signal: AbortSignal.any([plan.signal, AbortSignal.timeout(10000)])
        });
        if (messages.error) throw new Error('无法读取首轮规划会话结果');
        const answer = messages.data?.findLast(item =>
          item.info?.role === 'assistant' && item.info.parentID === plan.messageID);
        plan.workflow.firstPlan.resolve(confirmedPlan(plan, answer?.info));
      })().catch(error => plan.workflow.firstPlan.reject(error)).finally(() => {
        if (plans.get(id) === plan) plans.delete(id);
      });
    },
    tools: {
      submit_checklist: tool({
        description: '提交首轮固定验收清单，每条验收项只能属于一个用户指定的目标设备类型。',
        args: { items: s.array(itemSchema).min(1), targets: s.array(s.string().min(1)).min(1).optional() },
        async execute({items, targets}, context) {
          const plan = registered(context);
          if (!plan.initial || plan.checklist) throw new Error('验收清单只允许在初次规划时提交一次');
          const accepted = submittedTargets(plan, targets);
          plan.checklist = validateChecklist(items, accepted);
          const previousTargets = plan.targets;
          plan.targets = accepted;
          try { await persistInitialPlan(plan); }
          catch (error) {
            delete plan.checklist;
            plan.targets = previousTargets;
            throw error;
          }
          plan.workflow.updatePlanning(plan.round, {checkCount: plan.checklist.items.length});
          return `验收清单已通过校验，共 ${plan.checklist.items.length} 项`;
        }
      }),
      submit_plan: tool({
        description: '提交当前规划阶段的开发任务 DAG。',
        args: { tasks: s.array(taskSchema).min(1) },
        async execute({tasks}, context) {
          const plan = registered(context);
          if (plan.dag) throw new Error('当前会话已经提交有效的开发 DAG');
          const dag = validateDag({tasks});
          if (!plan.initial) {
            const uncovered = new Set(plan.failedCheckIds);
            for (const task of dag.tasks) {
              const ids = checkIdsInTask(task);
              const related = plan.failedCheckIds.filter(id => ids.has(id));
              if (!related.length) throw new Error(`修复任务 ${task.id} 须标注对应的失败验收项编号`);
              for (const id of related) uncovered.delete(id);
            }
            if (uncovered.size) throw new Error('修复计划未覆盖失败验收项：' + [...uncovered].join('、'));
          }
          plan.dag = dag;
          try {
            if (plan.initial) await persistInitialPlan(plan);
            else await plan.save(dag);
          } catch (error) {
            delete plan.dag;
            throw error;
          }
          plan.workflow.updatePlanning(plan.round, {taskCount: dag.tasks.length});
          return `开发 DAG 已通过校验，共 ${plan.dag.tasks.length} 个任务`;
        }
      })
    }
  };
}
