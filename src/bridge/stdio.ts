// The bridge's stdio MCP server, run by claude from bridge.json:
//   node --import <tsx loader> src/bridge/stdio.ts
// Env: MAESTRO_BRIDGE_PORT, MAESTRO_BRIDGE_TOKEN, MAESTRO_MISSION_ID, MAESTRO_TASK_ID (task bridges),
//      MAESTRO_BRIDGE_TOOLS ("conductor" | "task"), MAESTRO_BRIDGE_PROGRESS_MS (tests only; default 60000).
// Each tool call is forwarded to the engine's HTTP endpoint (src/bridge/http.ts). While a call is pending, an
// MCP progress notification is sent every interval (when the client gave a progressToken), and also whenever
// the engine reports progress.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CONDUCTOR_TOOLS, TASK_TOOLS, type ToolDef } from './tools.js';
import { TOKEN_HEADER } from './http.js';

export interface StdioBridgeOptions {
  port: number;
  token: string;
  missionId: string;
  taskId: string | null;
  tools: 'conductor' | 'task';
  progressIntervalMs: number;
}

interface CallOutcome { isError: boolean; text: string }

/** POSTs one tool call; no timeout (calls may block for hours). Calls onProgress for each progress line. */
function forward(o: StdioBridgeOptions, tool: string, args: unknown, signal: AbortSignal, onProgress: () => void): Promise<CallOutcome> {
  const body = JSON.stringify({ missionId: o.missionId, taskId: o.taskId, args });
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: o.port, path: `/tool/${tool}`, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), [TOKEN_HEADER]: o.token },
    }, (res) => {
      res.setEncoding('utf8');
      let buf = '';
      let last: CallOutcome | null = null;
      res.on('data', (chunk: string) => {
        buf += chunk;
        if (res.statusCode !== 200) return;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const v = JSON.parse(line) as { progress?: boolean; isError?: boolean; text?: string };
            if (v.progress) onProgress();
            else last = { isError: v.isError === true, text: String(v.text ?? '') };
          } catch { /* ignore malformed line */ }
        }
      });
      res.on('end', () => {
        if (res.statusCode !== 200) resolve({ isError: true, text: `Maestro bridge error ${res.statusCode}: ${buf.trim()}` });
        else resolve(last ?? { isError: true, text: 'Maestro bridge: no result' });
      });
      res.on('error', (e) => resolve({ isError: true, text: `Maestro bridge: ${e.message}` }));
    });
    req.on('error', (e) => resolve({ isError: true, text: signal.aborted ? 'aborted' : `Maestro bridge unreachable: ${e.message}` }));
    if (signal.aborted) { req.destroy(); return; }
    signal.addEventListener('abort', () => req.destroy(), { once: true });
    req.end(body);
  });
}

export function createStdioBridge(o: StdioBridgeOptions): McpServer {
  const server = new McpServer({ name: 'maestro', version: '0.1.0' });
  const defs: ToolDef[] = o.tools === 'task' ? TASK_TOOLS : CONDUCTOR_TOOLS;
  for (const def of defs) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.inputSchema.shape }, async (args, extra) => {
      const progressToken = extra._meta?.progressToken;
      let p = 0;
      const sendProgress = () => {
        if (progressToken === undefined) return;
        p++;
        extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: p, message: 'still running' } }).catch(() => {});
      };
      const timer = progressToken !== undefined ? setInterval(sendProgress, o.progressIntervalMs) : undefined;
      try {
        const out = await forward(o, def.name, args, extra.signal, sendProgress);
        return { content: [{ type: 'text' as const, text: out.text }], isError: out.isError };
      } finally {
        if (timer) clearInterval(timer);
      }
    });
  }
  return server;
}

function optionsFromEnv(env: NodeJS.ProcessEnv): StdioBridgeOptions {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`maestro bridge: ${k} is not set`);
    return v;
  };
  const tools = need('MAESTRO_BRIDGE_TOOLS');
  if (tools !== 'conductor' && tools !== 'task') throw new Error(`maestro bridge: bad MAESTRO_BRIDGE_TOOLS ${tools}`);
  const interval = Number(env.MAESTRO_BRIDGE_PROGRESS_MS ?? 60_000);
  return {
    port: Number(need('MAESTRO_BRIDGE_PORT')),
    token: need('MAESTRO_BRIDGE_TOKEN'),
    missionId: need('MAESTRO_MISSION_ID'),
    taskId: env.MAESTRO_TASK_ID || null,
    tools,
    progressIntervalMs: Number.isFinite(interval) && interval > 0 ? interval : 60_000,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createStdioBridge(optionsFromEnv(process.env));
  await server.connect(new StdioServerTransport());
}
