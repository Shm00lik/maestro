// Scenario-driven stand-in for claude.exe (stream-json over stdio). See test/fake-claude/fake-claude.test.ts.
// Run: node --import tsx test/fake-claude/fake-claude.ts <claude args...>
// Env: FAKE_CLAUDE_SCENARIO=<scenario json>, FAKE_CLAUDE_LOG=<jsonl log path>.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

export type Step =
  | { emit: Record<string, unknown>; templated?: boolean }
  | { waitFor: 'user' | 'interrupt' | 'permission-answer' | 'stdin-close'; timeoutMs?: number }
  | { sleepMs: number }
  | { spawnChild: 'ping' }
  /** Writes a file relative to the cwd; `$SESSION` in the path is replaced by the session id. */
  | { writeFile: string; content?: string }
  /** Runs git with these args in the cwd and the session's env (like an approved Bash call); logs the exit code. */
  | { git: string[] }
  | { exit: number };
export interface Scenario { steps: Step[] }

const argv = process.argv.slice(2);
const logPath = process.env.FAKE_CLAUDE_LOG;
const log = (obj: unknown): void => {
  if (logPath) appendFileSync(logPath, JSON.stringify(obj) + '\n');
};
const scenarioPath = process.env.FAKE_CLAUDE_SCENARIO;
const scenario: Scenario = scenarioPath
  ? JSON.parse(readFileSync(scenarioPath, 'utf8'))
  : { steps: [{ waitFor: 'stdin-close' }] };

const resumeIdx = argv.indexOf('--resume');
const resumeId = resumeIdx >= 0 ? argv[resumeIdx + 1] : undefined;
let sessionId = resumeId ?? randomUUID();
let lastRequestId = '';

log({ argv });

// ---- stdin as a queue of parsed lines -------------------------------------
interface Msg { obj: any }
const queue: Msg[] = [];
let stdinEnded = false;
let wake: (() => void) | null = null;
const notify = (): void => { const w = wake; wake = null; w?.(); };

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', raw => {
  if (raw.trim() === '') return;
  let obj: any = null;
  try { obj = JSON.parse(raw); } catch { /* logged below */ }
  log(obj ?? { unparsable: raw });
  if (obj && typeof obj.request_id === 'string') lastRequestId = obj.request_id;
  else if (obj?.response && typeof obj.response.request_id === 'string') lastRequestId = obj.response.request_id;
  queue.push({ obj });
  notify();
});
rl.on('close', () => { stdinEnded = true; notify(); });

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const writeRaw = (s: string): Promise<void> => new Promise(r => { process.stdout.write(s, () => r()); });
// One whole JSON object per write call, so lines never interleave.
const write = (obj: unknown): Promise<void> => writeRaw(JSON.stringify(obj) + '\n');

async function exit(code: number): Promise<never> {
  await writeRaw(''); // drain stdout before exiting
  process.exit(code);
}

const matchers: Record<string, (o: any) => boolean> = {
  'user': o => o?.type === 'user',
  'interrupt': o => o?.type === 'control_request' && o.request?.subtype === 'interrupt',
  'permission-answer': o => o?.type === 'control_response',
};

const park = (ms: number): Promise<void> =>
  new Promise<void>(res => { wake = res; if (ms !== Infinity) setTimeout(res, ms).unref(); });

/** Waits for next matching stdin message; non-matching lines are ignored (already logged). null = stdin ended. */
async function take(kind: string, timeoutMs: number): Promise<Msg | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    while (queue.length) {
      const m = queue.shift()!;
      if (matchers[kind](m.obj)) return m;
    }
    if (stdinEnded) return null;
    const left = deadline - Date.now();
    if (left <= 0) { process.stderr.write(`fake-claude: timeout waiting for ${kind}\n`); await exit(3); }
    await park(left);
  }
}

function substitute(v: unknown): unknown {
  if (typeof v === 'string') return v.split('$SESSION').join(sessionId).split('$REQUEST_ID').join(lastRequestId);
  if (Array.isArray(v)) return v.map(substitute);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x)]));
  return v;
}

async function run(): Promise<void> {
  let firstInit = true;
  for (const step of scenario.steps) {
    if ('emit' in step) {
      const obj: any = step.templated ? substitute(step.emit) : { ...step.emit };
      if (obj.type === 'system' && obj.subtype === 'init') {
        if (firstInit && resumeId) obj.session_id = resumeId;
        else if (typeof obj.session_id !== 'string') obj.session_id = sessionId;
        sessionId = obj.session_id;
        firstInit = false;
      }
      await write(obj);
    } else if ('waitFor' in step) {
      const timeout = step.timeoutMs ?? 30000;
      if (step.waitFor === 'stdin-close') {
        const deadline = Date.now() + timeout;
        while (!stdinEnded) {
          queue.length = 0;
          const left = deadline - Date.now();
          if (left <= 0) { process.stderr.write('fake-claude: timeout waiting for stdin-close\n'); await exit(3); }
          await park(left);
        }
      } else {
        const m = await take(step.waitFor, timeout);
        if (!m) return exit(0); // stdin closed while waiting (idle): exit cleanly
        if (step.waitFor === 'user') {
          await write({
            type: 'user', message: m.obj.message, session_id: sessionId, parent_tool_use_id: null,
            uuid: randomUUID(), timestamp: new Date().toISOString(), isReplay: true,
          });
        } else if (step.waitFor === 'interrupt') {
          await write({ type: 'control_response', response: { subtype: 'success', request_id: m.obj.request_id, response: { still_queued: [] } } });
        }
      }
    } else if ('sleepMs' in step) {
      await sleep(step.sleepMs);
    } else if ('spawnChild' in step) {
      const child = spawn('ping', ['-n', '120', '127.0.0.1'], { stdio: 'ignore', windowsHide: true });
      child.on('error', () => { /* ignore */ });
      log({ spawnedChild: child.pid });
    } else if ('writeFile' in step) {
      const p = resolve(process.cwd(), step.writeFile.split('$SESSION').join(sessionId));
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, step.content ?? 'fake\n');
      log({ wroteFile: p });
    } else if ('git' in step) {
      const r = spawnSync('git', step.git, { cwd: process.cwd(), windowsHide: true, encoding: 'utf8' });
      log({ git: step.git, status: r.status, stderr: r.stderr });
    } else if ('exit' in step) {
      return exit(step.exit);
    }
  }
  // Script finished: like the real CLI, stay alive until stdin closes.
  while (!stdinEnded) { queue.length = 0; await park(Infinity); }
  await exit(0);
}

run().catch(e => { process.stderr.write(`fake-claude: ${e?.stack ?? e}\n`); process.exit(1); });
