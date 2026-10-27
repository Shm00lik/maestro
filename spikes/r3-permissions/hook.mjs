// Option A hook: logs stdin payload to perm.log, waits for allow.flag / deny.flag, prints decision JSON.
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const log = (s) => fs.appendFileSync(path.join(dir, 'perm.log'), `[${new Date().toISOString()}] ${s}\n`);
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  log('HOOK PAYLOAD ' + input.replace(/\n/g, ' '));
  const allow = path.join(dir, 'allow.flag'), deny = path.join(dir, 'deny.flag');
  while (!fs.existsSync(allow) && !fs.existsSync(deny)) await new Promise((r) => setTimeout(r, 500));
  const ok = fs.existsSync(allow);
  const out = ok
    ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
    : { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied by hook spike' } } };
  log('HOOK RESPOND ' + JSON.stringify(out));
  process.stdout.write(JSON.stringify(out));
});
