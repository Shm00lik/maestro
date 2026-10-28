// `maestro run`: drives one mission from the terminal. Prints one line per engine event and turns every inbox entry
// (permission, question, plan approval, merge decision) into a numbered prompt answered on stdin.
//   npm run maestro -- run --project <path> --brief <file> [--title <t>] [--quick] [--base main] [--parallel 3] [--db <path>]
// Exit code: 0 when the mission ends done, 1 when it is stopped or failed (or cannot start).
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { openDb, type Db } from '../store/db.js';
import { missions, normalizePath, projects, tasks, type EventRow, type Mission } from '../store/repos.js';
import { TERMINAL_MISSION_STATES } from '../core/state/missionMachine.js';
import { MissionEngine } from '../engine/missionEngine.js';
import { resolveClaudeCommand } from '../claude/exe.js';
import { LineReader } from './lineReader.js';
import { Prompter } from './prompter.js';
import { formatEvent, tokenLine } from './format.js';
import { loadTestHooks } from './testConductor.js';

const USAGE = `Usage: npm run maestro -- run --project <path> --brief <file> [options]

Options:
  --project <path>   the git repository to work in (required)
  --brief <file>     a text or Markdown file with the mission brief (required)
  --title <title>    mission title (default: the brief's first "# " heading, else its file name)
  --quick            quick planning depth (skip the understanding step)
  --base <branch>    base branch (default: main)
  --parallel <n>     tasks running at the same time (default: 3)
  --db <path>        database file (default: %APPDATA%\\Maestro\\maestro.db; logs then go to <db folder>\\logs)
`;

export interface RunArgs {
  project: string; brief: string; title?: string; quick: boolean; base: string; parallel: number; db?: string;
  conductorScript?: string;
}

export function parseRunArgs(argv: string[]): RunArgs {
  const [cmd, ...rest] = argv;
  if (cmd !== 'run') throw new Error(cmd ? `Unknown command: ${cmd}` : 'Missing command');
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true, strict: true,
    options: {
      project: { type: 'string' }, brief: { type: 'string' }, title: { type: 'string' }, quick: { type: 'boolean' },
      base: { type: 'string' }, parallel: { type: 'string' }, db: { type: 'string' },
      'conductor-script': { type: 'string' },
    },
  });
  if (positionals.length > 0) throw new Error(`Unexpected argument: ${positionals[0]}`);
  if (!values.project) throw new Error('--project is required');
  if (!values.brief) throw new Error('--brief is required');
  const parallel = values.parallel === undefined ? 3 : Number(values.parallel);
  if (!Number.isInteger(parallel) || parallel < 1 || parallel > 16) throw new Error('--parallel must be a whole number from 1 to 16');
  return {
    project: values.project, brief: values.brief, title: values.title, quick: values.quick ?? false,
    base: values.base ?? 'main', parallel, db: values.db, conductorScript: values['conductor-script'],
  };
}

function defaultTitle(brief: string, file: string): string {
  const h = brief.split(/\r?\n/).map(l => /^#\s+(.+)$/.exec(l.trim())?.[1]?.trim()).find(Boolean);
  return h ?? basename(file, extname(file));
}

function ensureProject(db: Db, path: string): string {
  const key = normalizePath(path);
  const found = projects.list(db).find(p => normalizePath(p.path) === key);
  return found ? found.id : projects.add(db, { name: basename(path), path }).id;
}

/** A prompt waiting for its answer: lines printed meanwhile go above it, and the prompt is shown again. */
let openPrompt: string | null = null;
const out = (line: string): void => {
  if (openPrompt === null) { process.stdout.write(`${line}\n`); return; }
  process.stdout.write(`\n${line}\n${openPrompt}`);
};
const showPrompt = (text: string): void => { openPrompt = text; process.stdout.write(text); };
const promptDone = (): void => { openPrompt = null; };

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let args: RunArgs;
  let hooks: ReturnType<typeof loadTestHooks>;
  try {
    args = parseRunArgs(argv);
    hooks = loadTestHooks(env, args.conductorScript);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}`);
    return 1;
  }

  const projectPath = resolve(args.project);
  if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
    process.stderr.write(`Project folder not found: ${projectPath}\n`);
    return 1;
  }
  let briefText: string;
  try { briefText = readFileSync(resolve(args.brief), 'utf8'); }
  catch (e) { process.stderr.write(`Cannot read the brief: ${(e as Error).message}\n`); return 1; }
  if (!briefText.trim()) { process.stderr.write('The brief is empty\n'); return 1; }

  let command: { exe: string; prefixArgs: string[] };
  try { command = resolveClaudeCommand(); }
  catch (e) { process.stderr.write(`${(e as Error).message}\n`); return 1; }

  const appData = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  const dbPath = args.db ? resolve(args.db) : join(appData, 'Maestro', 'maestro.db');
  const logDir = join(dirname(dbPath), 'logs');
  mkdirSync(logDir, { recursive: true });
  out(`Database: ${dbPath}`);
  out(`Logs: ${logDir}`);

  const db = openDb(dbPath);
  const engine = new MissionEngine({ db, logDir, command, conductorEnv: hooks.conductorEnv });
  const reader = new LineReader(process.stdin);

  let missionId: string | null = null;
  let prompter: Prompter | null = null;
  let finished = false;
  let resolveEnd!: (code: number) => void;
  const ended = new Promise<number>(r => { resolveEnd = r; });
  const end = (code: number): void => {
    if (finished) return;
    finished = true;
    prompter?.close();
    resolveEnd(code);
  };

  // ---- events ----
  const titles = new Map<string, string>();
  const label = (id: string): string => {
    if (id === missionId) return '';
    if (!titles.has(id)) titles.set(id, missions.get(db, id)?.title ?? id.slice(0, 8));
    return `{${titles.get(id)}} `;
  };
  const buffered: EventRow[] = [];
  const printEvent = (ev: EventRow): void => {
    const line = formatEvent(db, ev);
    if (line) out(`${label(ev.missionId)}${line}`);
  };
  const checkEnded = (): void => {
    if (!missionId || finished) return;
    const m = missions.get(db, missionId);
    if (!m || !TERMINAL_MISSION_STATES.has(m.state)) return;
    printSummary(db, m);
    end(m.state === 'done' ? 0 : 1);
  };
  engine.on('event', (ev: EventRow) => {
    if (finished) return;
    if (missionId === null) { buffered.push(ev); return; }
    printEvent(ev);
    if (ev.missionId === missionId && ev.type === 'state' && !ev.taskId) setImmediate(checkEnded);
  });
  engine.on('mission', (m: Mission) => { if (m.id === missionId) setImmediate(checkEnded); });

  // ---- stopping ----
  let stopRequested = false;
  /** Ctrl+C: stop the mission; a second Ctrl+C quits at once (the mission is recovered on the next start). */
  const requestStop = (why: string, escalate: boolean): void => {
    if (finished) return;
    if (stopRequested) {
      if (!escalate) return;
      out('Quitting without waiting for the stop. The mission is recovered the next time Maestro starts.');
      end(1);
      return;
    }
    stopRequested = true;
    out(`${why}: stopping the mission… (press Ctrl+C again to quit at once)`);
    if (missionId) doStop(missionId);
  };
  const doStop = (id: string): void => {
    engine.stop(id).then(() => { checkEnded(); end(1); }, e => { out(`Stop failed: ${(e as Error).message}`); end(1); });
  };
  const onSigint = (): void => requestStop('Ctrl+C', true);
  process.on('SIGINT', onSigint);

  try {
    const report = await engine.recover();
    const recovered = report.conductorsResumed.length + report.resumed.length + report.restarted.length;
    if (recovered > 0 || report.missionsFailed.length > 0) {
      out(`Recovered from an earlier run: ${report.conductorsResumed.length} conductors and ${report.resumed.length + report.restarted.length} tasks resumed, `
        + `${report.missionsFailed.length} missions failed.`);
    }
    if (stopRequested) { end(1); }
    else {
      const projectId = ensureProject(db, projectPath);
      const title = args.title?.trim() || defaultTitle(briefText, args.brief);
      const m = await engine.startMission({
        projectId, title, brief: briefText, depth: args.quick ? 'quick' : 'thorough', baseBranch: args.base,
        missionBranch: '', isolation: 'worktree', maxParallel: args.parallel, quick: args.quick,
      });
      missionId = m.id;
      out(`Mission "${m.title}" (${m.id}) on branch ${m.missionBranch}, base ${m.baseBranch}, up to ${m.maxParallel} tasks at a time`);
      out(`Conductor log: ${join(logDir, 'missions', m.id, 'conductor.log')}`);
      for (const ev of buffered.splice(0)) printEvent(ev);

      prompter = new Prompter({
        db, engine, missionId: m.id, reader, echo: !process.stdin.isTTY,
        out, prompt: showPrompt, promptDone,
        onEof: () => requestStop('Input ended while an answer was needed', false),
      });
      const p = prompter;
      engine.on('inbox', () => p.refresh());
      p.refresh();
      if (hooks.runConductor) {
        hooks.runConductor(engine, m.id, out).catch(e => out(`[test-conductor] ended: ${(e as Error).message}`));
      }
      if (stopRequested) doStop(m.id);
      checkEnded();
    }
  } catch (e) {
    out(`Could not start the mission: ${(e as Error).message}`);
    end(1);
  }

  const code = await ended;
  process.off('SIGINT', onSigint);
  process.on('SIGINT', () => { /* shutting down: ignore further Ctrl+C */ });
  reader.close();
  await engine.shutdown().catch(e => out(`Shutdown: ${(e as Error).message}`));
  db.close();
  return code;
}

function printSummary(db: Db, m: Mission): void {
  out('');
  out(`Mission ${m.state}${m.outcome ? ` (${m.outcome})` : ''}: ${m.title}`);
  const list = tasks.listByMission(db, m.id).filter(t => t.dispatchedAt !== null || t.state !== 'planned');
  for (const t of list) out(`   ${t.taskKey}  ${t.state}  ${tokenLine(t)}`);
  const sum = list.reduce((a, t) => ({
    tokensIn: a.tokensIn + t.tokensIn, tokensOut: a.tokensOut + t.tokensOut,
    tokensCacheRead: a.tokensCacheRead + t.tokensCacheRead, tokensCacheWrite: a.tokensCacheWrite + t.tokensCacheWrite,
  }), { tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 });
  out(`   Total (tasks): ${tokenLine(sum)}`);
  if (m.outcome === 'kept') out(`   The work is on branch ${m.missionBranch}.`);
  if (m.outcome === 'merged') out(`   ${m.missionBranch} was merged into ${m.baseBranch}.`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).then(code => process.exit(code), e => {
    process.stderr.write(`${(e as Error).stack ?? e}\n`);
    process.exit(1);
  });
}
