// The engine side of the bridge: a token-protected HTTP endpoint on 127.0.0.1 that the stdio MCP helper
// (src/bridge/stdio.ts) forwards each tool call to.
//
// Protocol: POST /tool/<name>, header x-maestro-token, JSON body {missionId, taskId, args} (≤ 1 MB).
// The response is 200 with newline-delimited JSON: zero or more {"progress":true} lines (from the handler's
// onProgress), then one {"isError":boolean,"text":string} line. Errors before the call starts use plain status
// codes: 401 bad token, 404 unknown tool, 403 tool not allowed for a task bridge, 413 body too large, 400 bad JSON.
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { CONDUCTOR_TOOLS, TASK_TOOLS, runTool, type BridgeHandlers } from './tools.js';

export const TOKEN_HEADER = 'x-maestro-token';
export const MAX_BODY_BYTES = 1024 * 1024;

export interface BridgeHttp { port: number; token: string; address: string; close(): Promise<void> }

const CONDUCTOR_NAMES = new Set(CONDUCTOR_TOOLS.map((t) => t.name));
const TASK_NAMES = new Set(TASK_TOOLS.map((t) => t.name));

function tokenOk(given: string | string[] | undefined, expected: Buffer): boolean {
  if (typeof given !== 'string') return false;
  const g = Buffer.from(given, 'utf8');
  if (g.length !== expected.length) {
    timingSafeEqual(expected, expected); // keep timing similar on length mismatch
    return false;
  }
  return timingSafeEqual(g, expected);
}

function errorText(e: unknown): string {
  if (e instanceof ZodError) return `invalid arguments: ${e.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`;
  return e instanceof Error ? e.message : String(e);
}

export function startBridgeHttp(h: BridgeHandlers): Promise<BridgeHttp> {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(token, 'utf8');

  const reply = (res: http.ServerResponse, status: number, text: string) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
    res.end(text);
  };

  const server = http.createServer((req, res) => {
    // Drain (never buffer) bodies of requests we reject, so the client can read the response.
    const reject = (status: number, text: string) => { req.resume(); reply(res, status, text); };

    if (!tokenOk(req.headers[TOKEN_HEADER], expected)) return reject(401, 'unauthorized');
    if (req.method !== 'POST') return reject(405, 'method not allowed');
    const m = /^\/tool\/([a-z_]+)$/.exec(req.url ?? '');
    const name = m?.[1];
    if (!name || !CONDUCTOR_NAMES.has(name)) return reject(404, 'unknown tool');

    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      if (tooBig) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) { tooBig = true; chunks.length = 0; return; }
      chunks.push(c);
    });
    req.on('error', () => res.destroy());
    req.on('end', () => {
      if (tooBig) return reply(res, 413, 'body too large');
      let body: { missionId?: unknown; taskId?: unknown; args?: unknown };
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(res, 400, 'bad json'); }
      if (!body || typeof body !== 'object' || typeof body.missionId !== 'string') return reply(res, 400, 'missionId required');
      const taskId = typeof body.taskId === 'string' ? body.taskId : null;
      if (taskId !== null && !TASK_NAMES.has(name)) return reply(res, 403, 'tool not available to task sessions');

      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.flushHeaders();
      const write = (v: unknown) => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(v) + '\n'); };
      const onProgress = () => write({ progress: true });
      // The caller may disconnect (e.g. claude's tool timeout); the handler keeps running regardless.
      runTool(h, name, body.missionId, taskId, body.args ?? {}, onProgress).then(
        (text) => ({ isError: false, text }),
        (e: unknown) => ({ isError: true, text: errorText(e) }),
      ).then((out) => {
        if (res.writableEnded || res.destroyed) return;
        res.end(JSON.stringify(out) + '\n');
      });
    });
  });

  // Calls like wait_for_tasks / ask_user can stay open for hours.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.timeout = 0;
  server.keepAliveTimeout = 5_000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const addr = server.address();
      if (!addr || typeof addr === 'string') { reject(new Error('bridge: no address')); return; }
      resolve({
        port: addr.port,
        token,
        address: addr.address,
        close: () => new Promise<void>((r) => {
          server.close(() => r());
          server.closeAllConnections();
        }),
      });
    });
  });
}

const STDIO_ENTRY = fileURLToPath(new URL('./stdio.ts', import.meta.url));

/** Writes `<dir>/bridge.json` (an MCP config with one `maestro` server) and returns its path. The token is passed in env only. */
export function writeBridgeConfig(
  dir: string, o: { port: number; token: string; missionId: string; taskId?: string; tools: 'conductor' | 'task' },
): string {
  const env: Record<string, string> = {
    MAESTRO_BRIDGE_PORT: String(o.port),
    MAESTRO_BRIDGE_TOKEN: o.token,
    MAESTRO_MISSION_ID: o.missionId,
  };
  if (o.taskId !== undefined) env.MAESTRO_TASK_ID = o.taskId;
  env.MAESTRO_BRIDGE_TOOLS = o.tools;
  const cfg = {
    mcpServers: {
      maestro: {
        command: process.execPath,
        // Absolute loader URL: a bare `tsx` would not resolve from a worktree cwd.
        args: ['--import', import.meta.resolve('tsx'), STDIO_ENTRY],
        env,
      },
    },
  };
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'bridge.json');
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  return p;
}
