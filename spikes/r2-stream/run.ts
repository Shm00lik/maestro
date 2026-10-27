// Throwaway spike R2/R4: stream-json input, interrupts, usage. Usage: npx tsx run.ts <mode> [sessionId]
// modes: multi | intctl | closestdin | resume <sid>
import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const REPO = path.join(os.tmpdir(), 'maestro-spike-repo');
const EXE = path.join(process.env.APPDATA!, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const mode = process.argv[2];
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const user = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }) + '\n';

const PING = 'Use the Bash tool to run exactly this command: ping -n 60 127.0.0.1 . Then reply done.';
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--replay-user-messages', '--model', 'haiku', '--allowedTools', 'Bash'];
if (mode === 'resume') args.push('--resume', process.argv[3]);

const out = fs.createWriteStream(path.join(import.meta.dirname, `out-${mode}.jsonl`));
const child = spawn(EXE, args, { cwd: REPO, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
log('pid', child.pid);
const events: any[] = [];
let buf = '';
const waiters: { pred: (e: any) => boolean; res: (e: any) => void }[] = [];
child.stdout!.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!l.trim()) continue;
    out.write(l + '\n');
    try {
      const e = JSON.parse(l); events.push(e);
      log('event', e.type, e.subtype ?? '', JSON.stringify(e.message?.content ?? e.response ?? '').slice(0, 90));
      for (let k = waiters.length - 1; k >= 0; k--) if (waiters[k].pred(e)) waiters.splice(k, 1)[0].res(e);
    } catch { log('NONJSON', l.slice(0, 100)); }
  }
});
child.stderr!.on('data', (d) => log('stderr', d.toString().slice(0, 300)));
const exited = new Promise<any>((r) => child.on('exit', (code, sig) => { log('exit', code, sig); r({ code, sig }); }));
const waitFor = (pred: (e: any) => boolean, ms: number) =>
  new Promise<any>((res) => { waiters.push({ pred, res }); setTimeout(() => res(null), ms); });
const isResult = (e: any) => e.type === 'result';
const isToolUse = (e: any) => e.type === 'assistant' && JSON.stringify(e.message?.content).includes('tool_use');
const hardKill = () => { const r = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8' }); log('taskkill', r.status); };
const send = (s: string) => { log('SEND', s.slice(0, 150).trim()); child.stdin!.write(s); };

(async () => {
  if (mode === 'multi') {
    send(user('List the files here, then wait.'));
    await waitFor((e) => e.type === 'assistant', 60000);
    send(user('Now count the lines in each file.'));
    const r1 = await waitFor(isResult, 60000);
    log('first result', !!r1);
    const r2 = await waitFor((e) => isResult(e) && e !== r1, 40000);
    log('second result', !!r2);
    child.stdin!.end();
  } else if (mode === 'intctl' || mode === 'closestdin') {
    send(user(PING));
    await waitFor(isToolUse, 60000);
    await sleep(3000);
    if (mode === 'intctl') send(JSON.stringify({ type: 'control_request', request_id: 'int-1', request: { subtype: 'interrupt' } }) + '\n');
    else child.stdin!.end();
    const r = await waitFor(isResult, 20000);
    log('result after stop?', !!r);
    if (mode === 'intctl' && r) {
      // does the process remain usable for another turn?
      send(user('Say the word pong.'));
      const r2 = await waitFor((e) => isResult(e) && e !== r, 30000);
      log('follow-up result?', !!r2);
      child.stdin!.end();
    }
  } else if (mode === 'resume') {
    send(user('What was my earlier request about, in under 15 words? Do not use tools.'));
    await waitFor(isResult, 60000);
    child.stdin!.end();
  }
  const ex = await Promise.race([exited, sleep(15000).then(() => 'TIMEOUT')]);
  if (ex === 'TIMEOUT') { log('still alive after 15s -> hard kill'); hardKill(); await exited; }
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  log('SESSION', init?.session_id);
  out.end();
})();
