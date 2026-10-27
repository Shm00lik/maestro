// Throwaway spike R1/R6 runner.
//   npx tsx run.ts conductor <label> [conductor.md]
//   npx tsx run.ts r6 <label> <waitMinutes> [ENV=VAL ...]
import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const [mode, label, ...rest] = process.argv.slice(2);
const DIR = import.meta.dirname;
const REPO = path.join(os.tmpdir(), 'maestro-spike-repo');
const EXE = path.join(process.env.APPDATA!, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const TSX = path.resolve(DIR, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const OUT = path.join(DIR, `out-${label}.jsonl`);
const CALLS = path.join(DIR, `calls-${label}.jsonl`);
const RUNLOG = path.join(DIR, `run-${label}.log`);
for (const f of [OUT, CALLS, RUNLOG]) fs.rmSync(f, { force: true });
const t0 = Date.now();
const log = (...a: unknown[]) => { const s = `[+${((Date.now() - t0) / 1000).toFixed(1)}s] ` + a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s); fs.appendFileSync(RUNLOG, s + '\n'); };

const bridgeEnv: Record<string, string> = { CALLS_LOG: CALLS };
const childEnv: Record<string, string> = { ...process.env as Record<string, string> };
let args: string[];
let giveUpMs: number;
if (mode === 'conductor') {
  const conductor = path.resolve(DIR, rest[0] ?? 'conductor.md');
  fs.copyFileSync(path.join(DIR, 'sample-plan.md'), path.join(REPO, 'sample-plan.md'));
  bridgeEnv.WAIT_MS = '5000';
  if (rest[1]) bridgeEnv.HANDOFF = rest[1];
  args = ['-p', 'Execute sample-plan.md using superpowers:subagent-driven-development', '--model', 'opus', '--max-turns', '40',
    '--append-system-prompt-file', conductor, '--permission-mode', 'default',
    '--allowedTools', 'mcp__maestro__*', 'Skill', 'Read', 'Glob', 'Grep', 'TodoWrite'];
  giveUpMs = 30 * 60_000;
  log('conductor file', conductor);
} else if (mode === 'r6') {
  const mins = Number(rest[0]);
  bridgeEnv.WAIT_MS = String(mins * 60_000);
  for (const kv of rest.slice(1)) { const [k, v] = kv.split('='); if (k.startsWith('BRIDGE_')) bridgeEnv[k.slice(7)] = v; else childEnv[k] = v; }
  args = ['-p', 'Call the mcp__maestro__wait_for_tasks tool exactly once with task_refs ["ref-T1-1"] and mode "all". Do not call any other tool. Then reply with exactly the text it returned (or the exact error).',
    '--model', 'haiku', '--max-turns', '3', '--permission-mode', 'default', '--allowedTools', 'mcp__maestro__*'];
  giveUpMs = (mins + 15) * 60_000;
} else throw new Error('mode?');

const cfg = path.join(DIR, `bridge-${label}.json`);
fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { maestro: { command: process.execPath, args: [TSX, path.join(DIR, 'bridge.ts')], env: bridgeEnv } } }));
args.push('--mcp-config', cfg, '--output-format', 'stream-json', '--verbose');
log('args', args);
log('env overrides', Object.fromEntries(Object.entries(childEnv).filter(([k]) => /MCP/.test(k))));
const child = spawn(EXE, args, { cwd: REPO, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: childEnv });
log('spawned pid', child.pid);
let buf = '';
const toolUses: { name: string; parent: string | null; input: any }[] = [];
child.stdout!.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue;
    fs.appendFileSync(OUT, l + '\n');
    let e: any; try { e = JSON.parse(l); } catch { log('nonjson', l.slice(0, 200)); continue; }
    if (e.type === 'system' && e.subtype === 'init') {
      log('init model', e.model, 'perm', e.permissionMode, 'maestro mcp', e.mcp_servers?.filter((m: any) => m.name === 'maestro'));
      log('init plugins', e.plugins);
      log('init superpowers skills', (e.skills ?? []).filter((s: string) => /superpowers/.test(s)));
      log('init has Task/Agent tool', (e.tools ?? []).filter((t: string) => t === 'Task' || t === 'Agent' || /maestro/.test(t)));
    } else if (e.type === 'assistant') {
      for (const b of e.message.content) {
        if (b.type === 'tool_use') { toolUses.push({ name: b.name, parent: e.parent_tool_use_id, input: b.input }); log('tool_use', b.name, 'parent=' + e.parent_tool_use_id, JSON.stringify(b.input).slice(0, 300)); }
        else if (b.type === 'text') log('text', b.text.slice(0, 300));
      }
    } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) if (b.type === 'tool_result') log('tool_result', b.is_error ? 'ERROR' : 'ok', JSON.stringify(b.content).slice(0, 400));
    } else if (e.type === 'result') {
      log('result', e.subtype, 'turns', e.num_turns, 'cost', e.total_cost_usd, 'denials', e.permission_denials, 'text', String(e.result ?? '').slice(0, 300), 'errors', e.errors);
    } else if (e.type === 'system') log('system', e.subtype);
    else if (e.type !== 'rate_limit_event') log('event', e.type, l.slice(0, 200));
  }
});
child.stderr!.on('data', (d) => log('stderr', d.toString().slice(0, 1000)));
const timer = setTimeout(() => { log('GIVE UP, killing', child.pid); spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); }, giveUpMs);
child.on('exit', (c, s) => {
  clearTimeout(timer);
  log('exit', c, s);
  const top = toolUses.filter((t) => t.parent === null);
  const count = (pred: (t: any) => boolean, arr = top) => arr.filter(pred).length;
  log('SUMMARY top-level dispatch_task', count((t) => t.name === 'mcp__maestro__dispatch_task'),
    'wait_for_tasks', count((t) => t.name === 'mcp__maestro__wait_for_tasks'),
    'ask_user', count((t) => t.name === 'mcp__maestro__ask_user'),
    'Task/Agent', top.filter((t) => t.name === 'Task' || t.name === 'Agent').map((t) => ({ subagent_type: t.input.subagent_type, description: t.input.description })),
    'nested tool_uses', toolUses.length - top.length,
    'all top-level names', top.map((t) => t.name));
  if (fs.existsSync(CALLS)) log('calls:\n' + fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => { const c = JSON.parse(l); return `${c.t} ${c.tool} ${c.phase} ${JSON.stringify(c.data).slice(0, 200)}`; }).join('\n'));
  process.exit(0);
});
