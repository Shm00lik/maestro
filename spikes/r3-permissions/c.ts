// Throwaway spike R3 option C: --permission-prompt-tool stdio. Usage: npx tsx c.ts <allow|deny|wait> [waitSeconds]
import { spawn, spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
const mode = process.argv[2];
const waitS = Number(process.argv[3] ?? 0);
const REPO = path.join(os.tmpdir(), 'maestro-spike-repo');
const EXE = path.join(process.env.APPDATA!, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const t0 = Date.now();
const log = (...a: unknown[]) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const out = fs.createWriteStream(path.join(import.meta.dirname, `out-c-${mode}.jsonl`));
const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default', '--model', 'haiku'];
const child = spawn(EXE, args, { cwd: REPO, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
log('pid', child.pid);
const send = (o: unknown) => { const s = JSON.stringify(o); log('SEND', s); child.stdin!.write(s + '\n'); };
let buf = '';
child.stdout!.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!l.trim()) continue;
    out.write(l + '\n');
    const e = JSON.parse(l);
    log('event', e.type, e.subtype ?? '', e.type === 'assistant' || e.type === 'user' ? JSON.stringify(e.message.content).slice(0, 200) : '');
    if (e.type === 'control_request') {
      log('CONTROL_REQUEST FULL', l);
      const reply = () => {
        const response = mode === 'deny'
          ? { behavior: 'deny', message: 'Denied by Maestro spike' }
          : { behavior: 'allow', updatedInput: e.request.input };
        send({ type: 'control_response', response: { subtype: 'success', request_id: e.request_id, response } });
      };
      if (mode === 'wait') setTimeout(reply, waitS * 1000); else reply();
    }
    if (e.type === 'result') { log('RESULT FULL', l.slice(0, 1500)); child.stdin!.end(); }
  }
});
child.stderr!.on('data', (d) => log('stderr', d.toString().slice(0, 500)));
child.on('exit', (c, s) => { log('exit', c, s); process.exit(0); });
setTimeout(() => { log('GIVE UP'); spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); process.exit(1); }, (waitS + 120) * 1000);
send({ type: 'user', message: { role: 'user', content: 'Use the Bash tool to run exactly: npm --version . Then reply with the version only.' }, parent_tool_use_id: null });
