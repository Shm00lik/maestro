// Bridge tools: the MCP tools the conductor (all five) and task sessions (ask_user only) call.
// The dispatch_task, wait_for_tasks and ask_user descriptions are copied verbatim from
// spikes/r1-conductor/bridge.ts: they are part of the R1-tested design (spec §7.2). Changing them requires
// re-running the R1 compliance check.
import { z } from 'zod';
import type { PlanError } from '../core/plan/validatePlan.js';

export interface ToolDef { name: string; description: string; inputSchema: z.ZodObject<z.ZodRawShape> }

export interface DispatchInput { task_id: string; agent: string; prompt: string; depends_on: string[]; owns: string[] }

export interface TaskSummary {
  task_ref: string;
  key: string;
  /** blocked: waiting on a dependency that failed or was cancelled (failure_reason names it). */
  status: 'done' | 'failed' | 'cancelled' | 'running' | 'blocked';
  handoff: string | null;
  branch: string | null;
  commits: string[];
  failure_reason: string | null;
}

export interface BridgeHandlers {
  submitPlan(missionId: string, planPath: string): Promise<{ errors: PlanError[] } | { approved: true } | { approved: false; note: string }>;
  dispatchTask(missionId: string, d: DispatchInput): Promise<{ task_ref: string } | { error: string }>;
  waitForTasks(missionId: string, refs: string[], mode: 'all' | 'any', onProgress: () => void): Promise<TaskSummary[]>;
  askUser(missionId: string, taskId: string | null, q: { question: string; options?: string[]; context?: string }): Promise<string>;
  finishMission(missionId: string, summary: string): Promise<'merge' | 'keep'>;
}

// Schemas: same shapes as the spike (optional fields stay optional; the spike's ask_user `blocking` flag is
// accepted and ignored so the schema the model saw is unchanged).
export const submitPlanSchema = z.object({ plan_path: z.string() });
export const dispatchTaskSchema = z.object({
  task_id: z.string(), agent: z.string(), prompt: z.string(),
  depends_on: z.array(z.string()).optional(), owns: z.array(z.string()).optional(),
});
export const waitForTasksSchema = z.object({ task_refs: z.array(z.string()), mode: z.enum(['all', 'any']).optional() });
export const askUserSchema = z.object({
  question: z.string(), options: z.array(z.string()).optional(), context: z.string().optional(), blocking: z.boolean().optional(),
});
export const finishMissionSchema = z.object({ summary: z.string() });

// Not part of the R1-tested set: written in the spike's style, stating blocking behaviour.
const submitPlan: ToolDef = {
  name: 'submit_plan',
  description: 'Submit the plan file for validation and user approval. Returns validation errors right away, or blocks until the user approves or sends a re-plan note.',
  inputSchema: submitPlanSchema,
};
// R1-tested (verbatim from spikes/r1-conductor/bridge.ts).
const dispatchTask: ToolDef = {
  name: 'dispatch_task',
  description: 'Start a task as its own Maestro session (use instead of a subagent). Returns a task_ref immediately.',
  inputSchema: dispatchTaskSchema,
};
// R1-tested (verbatim).
const waitForTasks: ToolDef = {
  name: 'wait_for_tasks',
  description: 'Block until the given tasks finish. Returns status and handoff note per task.',
  inputSchema: waitForTasksSchema,
};
// R1-tested (verbatim).
const askUser: ToolDef = {
  name: 'ask_user',
  description: 'Ask the user a question and return their answer.',
  inputSchema: askUserSchema,
};
// Not part of the R1-tested set: written in the spike's style, stating blocking behaviour.
const finishMission: ToolDef = {
  name: 'finish_mission',
  description: 'Finish the mission and ask the user to merge or keep the branch. Blocks until the user chooses, then returns their choice.',
  inputSchema: finishMissionSchema,
};

export const CONDUCTOR_TOOLS: ToolDef[] = [submitPlan, dispatchTask, waitForTasks, askUser, finishMission];
export const TASK_TOOLS: ToolDef[] = [askUser];

/** Tools whose calls can block for hours (the HTTP route and stdio helper must not time out). */
export const LONG_TOOLS: ReadonlySet<string> = new Set(['submit_plan', 'wait_for_tasks', 'ask_user', 'finish_mission']);

/** Runs a validated tool call against the handlers; returns the text the MCP tool result carries. */
export async function runTool(
  h: BridgeHandlers, name: string, missionId: string, taskId: string | null, args: unknown, onProgress: () => void,
): Promise<string> {
  const json = (v: unknown) => JSON.stringify(v);
  switch (name) {
    case 'submit_plan': {
      const a = submitPlanSchema.parse(args);
      return json(await h.submitPlan(missionId, a.plan_path));
    }
    case 'dispatch_task': {
      const a = dispatchTaskSchema.parse(args);
      return json(await h.dispatchTask(missionId, {
        task_id: a.task_id, agent: a.agent, prompt: a.prompt, depends_on: a.depends_on ?? [], owns: a.owns ?? [],
      }));
    }
    case 'wait_for_tasks': {
      const a = waitForTasksSchema.parse(args);
      return json(await h.waitForTasks(missionId, a.task_refs, a.mode ?? 'all', onProgress));
    }
    case 'ask_user': {
      const a = askUserSchema.parse(args);
      const q: { question: string; options?: string[]; context?: string } = { question: a.question };
      if (a.options !== undefined) q.options = a.options;
      if (a.context !== undefined) q.context = a.context;
      return await h.askUser(missionId, taskId, q);
    }
    case 'finish_mission': {
      const a = finishMissionSchema.parse(args);
      return await h.finishMission(missionId, a.summary);
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
