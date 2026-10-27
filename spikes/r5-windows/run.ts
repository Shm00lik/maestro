// Throwaway spike R5: Windows process control. Usage: npx tsx run.ts <mode>
// modes: spawncmd | shim | sigint | taskkill | hardkill | longpath [longpaths|nolp] [claude] (env WT_LEN=target path length) | cleanup
// NOTE: child stdin is closed immediately (-p needs none), so SIGINT with stdin open was never tested.
// Early-finish repro of the original "count to 50" prompt: mode earlyfinish (1 claude call).
import { spawn, spawnSync, execSync, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const REPO = path.join(os.tmpdir(), 'maestro-spike-repo');
const NPM = path.join(process.env.APPDATA!, 'npm');
const EXE = path.join(NPM, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const CMD = path.join(NPM, 'claude.cmd');
const TOOLPROMPT = 'Use the Bash tool to run exactly this command: ping -n 60 127.0.0.1 . Then reply done.';
const ARGS = ['-p', TOOLPROMPT, '--allowedTools', 'Bash', '--output-format', 'stream-json', '--verbose', '--model', 'haiku'];
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function procs(): { pid: number; ppid: number; name: string }[] {
  const out = execSync(
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"',
    { encoding: 'utf8', maxBuffer: 1 << 26 },
  );
  return (JSON.parse(out) as any[]).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name }));
}
function tree(root: number) {
  const all = procs();
  const res: { pid: number; ppid: number; name: string }[] = [];
  const walk = (pid: number) => {
    const me = all.find((p) => p.pid === pid);
    if (me) res.push(me);
    all.filter((p) => p.ppid === pid).forEach((c) => walk(c.pid));
  };
  walk(root);
  return res;
}
function alive(pid: number) {
  return procs().some((p) => p.pid === pid);
}

type Run = { child: ChildProcess; events: any[]; lines: string[]; exit: Promise<{ code: number | null; signal: string | null }> };
function start(cmdline: string, args: string[], opts: any = {}): Run {
  const child = spawn(cmdline, args, { cwd: REPO, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...opts });
  const events: any[] = [];
  const lines: string[] = [];
  let buf = '';
  child.stdout!.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!l.trim()) continue;
      try {
        const e = JSON.parse(l);
        events.push(e);
        const txt = e.type === 'assistant' ? JSON.stringify(e.message?.content)?.slice(0, 80) : '';
        log('event', e.type, e.subtype ?? '', e.is_error ?? '', txt);
      } catch {
        lines.push(l);
        log('nonjson', l.slice(0, 100));
      }
    }
  });
  child.stderr!.on('data', (d) => log('stderr', d.toString().slice(0, 200)));
  child.stdin!.end(); // -p does not need stdin
  const exit = new Promise<any>((res) => child.on('exit', (code, signal) => { log('exit', code, signal); res({ code, signal }); }));
  child.on('error', (e: any) => log('spawn error', e.code, e.message));
  return { child, events, lines, exit };
}
async function waitForAssistant(r: Run, n = 1, timeout = 60000) {
  const s = Date.now();
  while (r.events.filter((e) => e.type === 'assistant').length < n && Date.now() - s < timeout) await sleep(200);
}
const leftovers = (pids: number[]) => procs().filter((p) => pids.includes(p.pid));
const claudeProcs = () => procs().filter((p) => /claude/i.test(p.name));

async function main() {
  const mode = process.argv[2];
  log('mode', mode, 'node', process.version);
  if (mode === 'shim') { log('claude.cmd exe line:', fs.readFileSync(CMD, 'utf8').split('\n').filter((l) => l.includes('claude.exe')).join(' | ')); return; }
  if (mode === 'earlyfinish') {
    const r = start(EXE, ['-p', 'count to 50 slowly, one number per line', '--output-format', 'stream-json', '--verbose', '--model', 'haiku']);
    await waitForAssistant(r, 1);
    await sleep(1500);
    log('child.kill(SIGINT) ->', r.child.kill('SIGINT'));
    log('exit', JSON.stringify(await Promise.race([r.exit, sleep(10000).then(() => 'TIMEOUT')])), 'result events:', r.events.filter((e) => e.type === 'result').length);
    return;
  }
  if (mode === 'spawncmd') {
    // no claude invocation: just see what spawning .cmd / shim does
    for (const [label, file, opts] of [
      ['claude.cmd shell:false', CMD, { shell: false }],
      ['claude (extensionless shim) shell:false', path.join(NPM, 'claude'), { shell: false }],
      ['claude.cmd shell:true', CMD, { shell: true }],
      ['claude.exe shell:false', EXE, { shell: false }],
    ] as const) {
      await new Promise<void>((res) => {
        try {
          const c = spawn(file, ['--version'], { ...opts, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
          let o = '';
          c.stdout!.on('data', (d) => (o += d));
          c.on('error', (e: any) => { log(label, 'ERROR', e.code, e.message); res(); });
          c.on('exit', (code) => { log(label, 'OK pid', c.pid, 'exit', code, o.trim()); res(); });
        } catch (e: any) { log(label, 'THROW', e.code, e.message); res(); }
      });
    }
    return;
  }
  if (mode === 'sigint' || mode === 'taskkill' || mode === 'hardkill') {
    const r = start(EXE, ARGS);
    const pid = r.child.pid!;
    log('spawned pid', pid);
    { const s0 = Date.now(); while (!r.events.some((e) => e.type === 'assistant' && JSON.stringify(e.message?.content).includes('tool_use')) && Date.now() - s0 < 60000) await sleep(100); }
    await sleep(3000);
    const t = tree(pid);
    log('PID tree', JSON.stringify(t));
    const all = t.map((p) => p.pid);
    log('claude-named procs', JSON.stringify(claudeProcs()));
    if (mode === 'sigint') {
      log('child.kill(SIGINT) ->', r.child.kill('SIGINT'));
    } else if (mode === 'taskkill') {
      const o = spawnSync('taskkill', ['/PID', String(pid), '/T'], { encoding: 'utf8' });
      log('taskkill /T status', o.status, (o.stdout + o.stderr).trim());
    } else {
      const o = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
      log('taskkill /T /F status', o.status, (o.stdout + o.stderr).trim());
    }
    const res = await Promise.race([r.exit, sleep(15000).then(() => 'TIMEOUT')]);
    log('exit result', JSON.stringify(res));
    await sleep(1000);
    log('result event?', JSON.stringify(r.events.filter((e) => e.type === 'result')).slice(0, 400));
    log('leftover from tree', JSON.stringify(leftovers(all)));
    log('claude-named procs after', JSON.stringify(claudeProcs()));
    if (res === 'TIMEOUT') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
      log('cleanup force-killed');
    }
    return;
  }
  if (mode === 'longpath') {
    const base = path.join(os.tmpdir(), 'maestro-spike-wt');
    const target = Number(process.env.WT_LEN || 275); const long = (() => { const head = path.join(base, 'x'); const pad = Math.max(1, target - head.length - 1 - 4); return path.join(base, 'x'.repeat(Math.min(pad, 100)), 'y'.repeat(Math.max(1, pad - 100)), 'wt'); })();
    log('worktree path length', long.length);
    const g = (args: string[]) => {
      const o = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8' });
      log('git', args.join(' ').slice(0, 60), 'status', o.status, (o.stdout + o.stderr).trim().slice(0, 300));
      return o;
    };
    g(['config', '--local', '--get', 'core.longpaths']);
    if (process.argv[3] === 'longpaths') g(['config', 'core.longpaths', 'true']);
    if (process.argv[3] === 'nolp') g(['config', '--unset', 'core.longpaths']);
    fs.mkdirSync(path.dirname(long), { recursive: true });
    g(['worktree', 'add', '-b', 'spike-long', long]);
    if (fs.existsSync(long)) {
      // deep file inside worktree pushing beyond 260 + 200
      const deep = path.join(long, 'd'.repeat(70), 'e'.repeat(70));
      try { fs.mkdirSync(deep, { recursive: true }); fs.writeFileSync(path.join(deep, 'deep.txt'), 'x'); log('deep file len', path.join(deep, 'deep.txt').length, 'written ok'); }
      catch (e: any) { log('deep write FAIL', e.code); }
      g(['-C', long, 'status', '--short']);
      if (process.argv[4] === 'claude') {
        const c = start(EXE, ['-p', 'say ok', '--output-format', 'stream-json', '--verbose', '--model', 'haiku'], { cwd: long });
        const x = await Promise.race([c.exit, sleep(90000).then(() => 'TIMEOUT')]);
        log('claude in long cwd exit', JSON.stringify(x), 'result:', JSON.stringify(c.events.filter((e) => e.type === 'result')).slice(0, 300));
      }
    }
    return;
  }
  if (mode === 'cleanup') {
    const g = (args: string[]) => log('git', args.join(' '), spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).stderr.trim());
    const base = path.join(os.tmpdir(), 'maestro-spike-wt');
    const target = Number(process.env.WT_LEN || 275); const long = (() => { const head = path.join(base, 'x'); const pad = Math.max(1, target - head.length - 1 - 4); return path.join(base, 'x'.repeat(Math.min(pad, 100)), 'y'.repeat(Math.max(1, pad - 100)), 'wt'); })();
    g(['worktree', 'remove', '--force', long]);
    g(['branch', '-D', 'spike-long']);
    g(['worktree', 'prune']);
    g(['config', '--unset', 'core.longpaths']);
    fs.rmSync(base, { recursive: true, force: true });
    log('base exists', fs.existsSync(base));
  }
}
main();
