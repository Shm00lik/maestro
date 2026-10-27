// Throwaway spike R1/R6: stub Maestro bridge (stdio MCP server).
// Env: CALLS_LOG (jsonl path), WAIT_MS (wait_for_tasks sleep, default 5000), PROGRESS_MS (optional: send progress notifications every N ms while waiting).
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const LOG = process.env.CALLS_LOG ?? 'calls.jsonl';
const WAIT_MS = Number(process.env.WAIT_MS ?? 5000);
const PROGRESS_MS = Number(process.env.PROGRESS_MS ?? 0);
const log = (tool: string, phase: string, data: unknown) =>
  fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), tool, phase, data }) + '\n');
let n = 0;
const server = new McpServer({ name: 'maestro', version: '0.0.1' });

server.tool('dispatch_task', 'Start a task as its own Maestro session (use instead of a subagent). Returns a task_ref immediately.',
  { task_id: z.string(), agent: z.string(), prompt: z.string(), depends_on: z.array(z.string()).optional(), owns: z.array(z.string()).optional() },
  async (args) => {
    const task_ref = `ref-${args.task_id}-${++n}`;
    log('dispatch_task', 'call', args);
    log('dispatch_task', 'return', { task_ref });
    return { content: [{ type: 'text', text: JSON.stringify({ task_ref }) }] };
  });

server.tool('wait_for_tasks', 'Block until the given tasks finish. Returns status and handoff note per task.',
  { task_refs: z.array(z.string()), mode: z.enum(['all', 'any']).optional() },
  async (args, extra) => {
    log('wait_for_tasks', 'call', { ...args, wait_ms: WAIT_MS });
    const token = extra._meta?.progressToken;
    let timer: NodeJS.Timeout | undefined;
    if (PROGRESS_MS > 0 && token !== undefined) {
      let p = 0;
      timer = setInterval(() => {
        p++;
        extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: p, message: 'still running' } }).catch(() => {});
        log('wait_for_tasks', 'progress', { p });
      }, PROGRESS_MS);
    }
    log('wait_for_tasks', 'progressToken', { token: token ?? null });
    const aborted = await new Promise<boolean>((res) => {
      const t = setTimeout(() => res(false), WAIT_MS);
      extra.signal.addEventListener('abort', () => { clearTimeout(t); res(true); });
    });
    if (timer) clearInterval(timer);
    if (aborted) { log('wait_for_tasks', 'aborted', { reason: String(extra.signal.reason ?? '') }); return { content: [{ type: 'text', text: 'aborted' }] }; }
    // After run c1 the conductor stopped because handoff 'stub' + no commits looked like a broken backend.
    // HANDOFF=sim makes the stub say plainly that it is a simulation (bridge change, not a conductor.md change).
    const handoff = process.env.HANDOFF === 'sim'
      ? 'SIMULATED by the Maestro spike harness: no real session ran and no files or commits were made. Treat this task as finished successfully (spec compliant, approved) and continue the workflow as if its report said so.'
      : 'stub';
    const out = args.task_refs.map((r) => ({ task_ref: r, status: 'done', handoff }));
    log('wait_for_tasks', 'return', out);
    return { content: [{ type: 'text', text: JSON.stringify(out) }] };
  });

server.tool('ask_user', 'Ask the user a question and return their answer.',
  { question: z.string(), options: z.array(z.string()).optional(), context: z.string().optional(), blocking: z.boolean().optional() },
  async (args) => {
    log('ask_user', 'call', args);
    return { content: [{ type: 'text', text: 'yes' }] };
  });

process.on('exit', () => log('bridge', 'exit', {}));
log('bridge', 'start', { pid: process.pid, WAIT_MS, PROGRESS_MS });
await server.connect(new StdioServerTransport());
