// Throwaway spike R7-R9. Usage: npx tsx run.ts <r7a|r7b|r8|r9>
import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
const mode = process.argv[2];
const REPO = path.join(os.tmpdir(), 'maestro-spike-repo');
const EXE = path.join(process.env.APPDATA!, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const TARGET = path.join(REPO, 'target.txt');
const ORIGINAL = 'alpha\nbeta\ngamma\n';
fs.writeFileSync(TARGET, ORIGINAL);
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const out = fs.createWriteStream(path.join(import.meta.dirname, `out-${mode}.jsonl`));
const base = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku'];
const EDIT = 'Edit the file target.txt in the current directory: change the line "beta" to "BETA-EDITED". Do it now.';
const msgs: string[] = [];
let extra: string[] = [];
if (mode === 'r7a') { extra = ['--permission-mode', 'acceptEdits', '--disallowedTools', 'Edit,Write,NotebookEdit']; msgs.push(EDIT); }
else if (mode === 'r7b') { extra = ['--permission-mode', 'acceptEdits', '--tools', 'Read,Glob,Grep']; msgs.push(EDIT); }
else if (mode === 'r8') { extra = ['--permission-mode', 'acceptEdits']; msgs.push('Reply with exactly: one', 'Reply with exactly: two'); }
else if (mode === 'r9') { extra = ['--permission-mode', 'acceptEdits', '--permission-prompt-tool', 'stdio']; msgs.push('Do two things in order. First use the Edit tool on target.txt to change the line "beta" to "BETA-EDITED". Second use the Bash tool to run exactly: npm --version . Then reply done.'); }
const child = spawn(EXE, [...base, ...extra], { cwd: REPO, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
log('pid', child.pid, 'args', [...base, ...extra].join(' '));
const send = (o: unknown) => { const s = JSON.stringify(o); log('SEND', s); child.stdin!.write(s + '\n'); };
const sendUser = (t: string) => send({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null });
const kill = () => spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
let buf = '', results = 0, interrupted = false, sawEdit = false;
child.stdout!.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!l.trim()) continue;
    out.write(l + '\n');
    const e = JSON.parse(l);
    log('EVENT', l.length > 700 ? l.slice(0, 700) + '…' : l);
    if (e.type === 'control_request' && mode === 'r9') {
      const tn = e.request?.tool_name;
      if (tn === 'Bash' && !interrupted) {
        interrupted = true; log('Bash permission pending; NOT answering; interrupt in 2s');
        setTimeout(() => send({ type: 'control_request', request_id: 'int-1', request: { subtype: 'interrupt' } }), 2000);
        setTimeout(() => { log('observe window over; ending'); child.stdin!.end(); setTimeout(() => { kill(); }, 8000); }, 20000);
      } else if (tn !== 'Bash') { sawEdit = true; log('NON-BASH PERMISSION REQUEST (not answering)', tn); }
    }
    if (e.type === 'result') {
      results++; log('RESULT#' + results, l);
      if (mode === 'r8' && results === 1) sendUser(msgs[1]);
      else if (mode !== 'r9') child.stdin!.end();
    }
  }
});
child.stderr!.on('data', (d) => log('stderr', d.toString().slice(0, 500)));
child.on('exit', (c, s) => { log('exit', c, s, 'target.txt=', JSON.stringify(fs.readFileSync(TARGET, 'utf8'))); process.exit(0); });
setTimeout(() => { log('GIVE UP'); kill(); process.exit(1); }, 150000);
sendUser(msgs[0]);
