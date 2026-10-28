// Locates the native claude.exe on Windows (see docs/superpowers/spikes/2026-10-28-r5-windows.md).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class ClaudeNotFound extends Error {
  constructor(message = 'claude.exe not found. Install it with: npm i -g @anthropic-ai/claude-code (or set MAESTRO_CLAUDE_EXE).') {
    super(message);
    this.name = 'ClaudeNotFound';
  }
}

export interface ResolveOpts {
  override?: string;
  /** Runs `where <cmd>` and returns the output lines (empty when nothing is found). */
  whereOutput?: (cmd: string) => string[];
  readFile?: (p: string) => string;
  exists?: (p: string) => boolean;
}

function defaultWhere(cmd: string): string[] {
  try {
    const out = execFileSync('where', [cmd], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Extracts the claude.exe path from the text of an npm claude.cmd shim, or undefined. */
function exeFromShim(text: string, shimDir: string): string | undefined {
  const line = text.split(/\r?\n/).find(l => /claude\.exe/i.test(l));
  if (!line) return undefined;
  const m = /"([^"]*claude\.exe)"/i.exec(line) ?? /(\S*claude\.exe)/i.exec(line);
  if (!m) return undefined;
  const dir = shimDir.replace(/[\\/]+$/, '');
  // %dp0% / %~dp0 stand for the shim dir plus a trailing backslash; swallow any following slashes to avoid doubling.
  return m[1]!.replace(/%~?dp0%?[\\/]*/gi, () => dir + '\\');
}

export function resolveClaudeExe(opts: ResolveOpts = {}): string {
  const where = opts.whereOutput ?? defaultWhere;
  const read = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const exists = opts.exists ?? existsSync;

  const override = opts.override ?? process.env.MAESTRO_CLAUDE_EXE;
  if (override) return override;

  const cmd = where('claude').find(l => l.toLowerCase().endsWith('.cmd'));
  if (cmd) {
    try {
      const exe = exeFromShim(read(cmd), dirname(cmd));
      if (exe && exists(exe)) return exe;
    } catch { /* unreadable shim: fall through */ }
  }

  const direct = where('claude.exe').find(l => l.toLowerCase().endsWith('claude.exe') && exists(l));
  if (direct) return direct;

  throw new ClaudeNotFound();
}

/** Executable plus args to prepend before the claude args (tests point this at fake-claude). */
export function resolveClaudeCommand(): { exe: string; prefixArgs: string[] } {
  const exe = resolveClaudeExe();
  const raw = process.env.MAESTRO_CLAUDE_EXE_ARGS;
  let prefixArgs: string[] = [];
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`MAESTRO_CLAUDE_EXE_ARGS must be a JSON array of strings: ${(e as Error).message}`);
    }
    if (!Array.isArray(parsed) || !parsed.every(a => typeof a === 'string')) {
      throw new Error('MAESTRO_CLAUDE_EXE_ARGS must be a JSON array of strings');
    }
    prefixArgs = parsed;
  }
  return { exe, prefixArgs };
}
