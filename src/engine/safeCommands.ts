// The pre-approved safe list (spec §9): shell commands a task session may run without asking the user. Pure and
// deliberately narrow: anything it does not recognise goes to the user's inbox as before. Written for both shells the
// claude CLI offers (Bash, PowerShell), so it rejects every character either of them treats specially, whatever the
// quoting, except the exact separator " && " and the inside of a quoted commit message.

/**
 * 'task': every entry. 'reviewer' (roles without edit tools, e.g. spec-reviewer, code-reviewer): the test runners
 * (without any `--` arguments) and git status/diff/log/show only; no git add/commit, no mkdir, no ls/pwd.
 */
export type SafeScope = 'task' | 'reviewer';

export interface SafeOptions {
  scope?: SafeScope;
  /**
   * Test runners (npm/pnpm/yarn test, node --test) are on the list only when the mission opted in (autoRunTests,
   * default false): running tests runs code that an edit-capable task can change.
   */
  runTests?: boolean;
  /** The worktree has its own package.json (else npm/pnpm/yarn would walk up to another project). */
  packageJson?: boolean;
}

const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];

/** True for a role with no tool list (every tool) or a list with an edit tool. */
export function hasEditTools(tools: readonly string[] | undefined): boolean {
  return tools === undefined || tools.some(t => EDIT_TOOLS.includes(t));
}

/** The scope follows the role's tools: no edit tools means the reviewer scope. */
export function safeScopeFor(tools: readonly string[] | undefined): SafeScope {
  return hasEditTools(tools) ? 'task' : 'reviewer';
}

const MAX_LENGTH = 1000;
const MAX_SEGMENTS = 8;
const SEPARATOR = ' && ';
/**
 * Anywhere in the command, quoted or not: anything outside printable ASCII (newlines, tabs, NBSP and other Unicode
 * spaces, the smart quotes PowerShell treats as quotes), and ; | ` > < ( ) $ \ { }. '&' is checked after the split.
 */
const FORBIDDEN = /[^\x20-\x7e]|[;|`><()$\\{}]/;

/** Git words that never belong in a safe command, even as an argument. */
const GIT_BANNED_WORDS: ReadonlySet<string> = new Set([
  'push', 'pull', 'fetch', 'checkout', 'reset', 'rebase', 'merge', 'branch', 'remote', 'config', 'clean',
]);
/**
 * Long git options that write files, run configured programs or leave the repository. Git accepts unique prefixes of
 * long options, so a flag is rejected when it is a prefix of one of these (or has one as a prefix).
 */
const GIT_DANGEROUS_LONG = [
  'output', 'ext-diff', 'textconv', 'exec-path', 'git-dir', 'work-tree', 'namespace', 'config-env', 'super-prefix',
  'no-index', 'open-files-in-pager', 'paginate',
];

/** A relative path: no leading '-', no '..', no '/' at the start (the charset has no ':', '~', '\', '*' or '?'). */
const PATH_RE = /^[A-Za-z0-9_.+,/][A-Za-z0-9_.+,/@=-]*$/;
/** git status/diff/log/show arguments: revisions (HEAD~1, HEAD^, HEAD:path), paths and flags. */
const GIT_ARG_RE = /^[A-Za-z0-9_.+,/=%:~^@-]+$/;
/** Arguments passed after `--` to a test script (npm runs scripts through cmd.exe on Windows: no % ^ ! here). */
const TEST_ARG_RE = /^[A-Za-z0-9_.+,/=-]+$/;
/** An unquoted commit message (one word). */
const BARE_MESSAGE_RE = /^[A-Za-z0-9_.:,+=/][A-Za-z0-9_.:,+=/-]*$/;

interface Token { value: string; quoted: boolean }

/** Space-separated tokens; a quoted token is a whole token ("..." or '...'); null when quoting is anything else. */
function tokenize(segment: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < segment.length) {
    if (segment[i] === ' ') { i++; continue; }
    const q = segment[i];
    if (q === '"' || q === "'") {
      const close = segment.indexOf(q, i + 1);
      if (close < 0) return null;
      if (close + 1 < segment.length && segment[close + 1] !== ' ') return null; // "a""b", "a"b
      out.push({ value: segment.slice(i + 1, close), quoted: true });
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < segment.length && segment[j] !== ' ') j++;
    const value = segment.slice(i, j);
    if (value.includes('"') || value.includes("'")) return null;
    out.push({ value, quoted: false });
    i = j;
  }
  return out;
}

/** True when a value (or any '='-separated part of it) is absolute, home-relative, a drive path or contains '..'. */
function escapesWorktree(v: string): boolean {
  if (v.includes('..')) return true;
  for (const part of v.split('=')) {
    if (/^[/~]/.test(part) || /^[A-Za-z]:/.test(part)) return true;
    if (/:[/~]/.test(part)) return true;
  }
  return false;
}

const isPath = (t: Token): boolean => !t.quoted && PATH_RE.test(t.value) && !escapesWorktree(t.value);

function startsWith(tokens: Token[], words: string[]): boolean {
  return words.every((w, i) => tokens[i] !== undefined && !tokens[i].quoted && tokens[i].value === w);
}

// ---- entries -----------------------------------------------------------------

const TEST_RUNNERS: string[][] = [
  ['npm', 'test'], ['npm', 'run', 'test'], ['npm', 't'], ['pnpm', 'test'], ['yarn', 'test'],
];

/** Test-runner flags that hang (watch mode, a UI server) or write files (coverage). */
const TEST_FLAG_DENY = /^(--watch|--ui|--coverage|-w$)/i;

/**
 * `npm test [--silent|-s] [-- <args>]`: no runner flags besides --silent (e.g. no --script-shell, --prefix). The
 * reviewer scope allows no `--` arguments at all.
 */
function testRunnerArgs(rest: Token[], scope: SafeScope): boolean {
  let i = 0;
  while (i < rest.length && !rest[i].quoted && (rest[i].value === '--silent' || rest[i].value === '-s')) i++;
  if (i === rest.length) return true;
  if (scope === 'reviewer') return false;
  if (rest[i].quoted || rest[i].value !== '--') return false;
  return rest.slice(i + 1).every(t =>
    !t.quoted && TEST_ARG_RE.test(t.value) && !escapesWorktree(t.value) && !TEST_FLAG_DENY.test(t.value));
}

/** `node --test [relative test paths]`. */
function nodeTestArgs(rest: Token[]): boolean {
  return rest.every(isPath);
}

function gitLongFlagIsDangerous(flag: string): boolean {
  const name = flag.slice(2).split('=')[0];
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return true;
  return GIT_DANGEROUS_LONG.some(d => d.startsWith(name) || name.startsWith(d));
}

/** git status/diff/log/show: flags (not -c/-C, not a dangerous long option), revisions and relative paths. */
function gitReadArgs(rest: Token[]): boolean {
  return rest.every(t => {
    if (t.quoted || !GIT_ARG_RE.test(t.value) || t.value.startsWith('@')) return false;
    if (GIT_BANNED_WORDS.has(t.value)) return false;
    const v = t.value;
    if (v === '--') return true;
    if (v.startsWith('--')) return !gitLongFlagIsDangerous(v) && !escapesWorktree(v);
    if (v.startsWith('-')) return /^-[A-Za-z0-9]+$/.test(v) && !/[cC]/.test(v);
    return !escapesWorktree(v);
  });
}

/** git add flags that select what to add. */
const GIT_ADD_TARGET_FLAGS: ReadonlySet<string> = new Set(['-A', '--all', '-u', '--update']);
const GIT_ADD_OTHER_FLAGS: ReadonlySet<string> = new Set(['-v', '--verbose', '--']);

/** `git add <relative paths>` (or -A / -u); no -p/-i/-e/-f or other flags. */
function gitAddArgs(rest: Token[]): boolean {
  let targets = 0;
  for (const t of rest) {
    if (!t.quoted && GIT_ADD_OTHER_FLAGS.has(t.value)) continue;
    if (!t.quoted && GIT_ADD_TARGET_FLAGS.has(t.value)) { targets++; continue; }
    if (!isPath(t) || t.value.startsWith('-') || GIT_BANNED_WORDS.has(t.value)) return false;
    targets++;
  }
  return targets > 0;
}

const COMMIT_SHORT = 'qasnv';
const COMMIT_LONG: ReadonlySet<string> = new Set(['--quiet', '--all', '--signoff', '--no-verify', '--allow-empty', '--no-edit']);

/** A commit message: quoted (any printable text without its own quote char; the forbidden set already applies) or one plain word. */
function isMessage(t: Token | undefined): boolean {
  if (!t) return false;
  return t.quoted || BARE_MESSAGE_RE.test(t.value);
}

/** `git commit [-q -a -s -n -v ...] -m "<message>" [-m "<more>"]`; no --amend, -F, --author, ... */
function gitCommitArgs(rest: Token[]): boolean {
  let messages = 0;
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t.quoted) return false;
    const v = t.value;
    if (COMMIT_LONG.has(v)) continue;
    const cluster = /^-([a-z]+)$/.exec(v);
    if (!cluster) return false;
    const letters = cluster[1];
    const body = letters.endsWith('m') ? letters.slice(0, -1) : letters;
    if (![...body].every(ch => COMMIT_SHORT.includes(ch))) return false;
    if (letters.endsWith('m')) {
      if (!isMessage(rest[i + 1])) return false;
      i++;
      messages++;
    }
  }
  return messages > 0;
}

/** `mkdir [-p] <relative paths>`. */
function mkdirArgs(rest: Token[]): boolean {
  const paths = rest.length > 0 && !rest[0].quoted && rest[0].value === '-p' ? rest.slice(1) : rest;
  return paths.length > 0 && paths.every(t => isPath(t) && !t.value.startsWith('-'));
}

/** `ls [-flags] [relative paths]` (no ':' in paths: PowerShell drives such as env: are not paths here). */
function lsArgs(rest: Token[]): boolean {
  return rest.every(t => !t.quoted && (/^-[A-Za-z1]+$/.test(t.value) || (isPath(t) && !t.value.startsWith('-'))));
}

function segmentIsSafe(tokens: Token[], o: Required<SafeOptions>): boolean {
  const scope = o.scope;
  for (const words of TEST_RUNNERS) {
    if (startsWith(tokens, words)) return o.runTests && o.packageJson && testRunnerArgs(tokens.slice(words.length), scope);
  }
  if (startsWith(tokens, ['node', '--test'])) return o.runTests && nodeTestArgs(tokens.slice(2));
  for (const sub of ['status', 'diff', 'log', 'show']) {
    if (startsWith(tokens, ['git', sub])) return gitReadArgs(tokens.slice(2));
  }
  if (scope === 'reviewer') return false;
  if (startsWith(tokens, ['git', 'add'])) return gitAddArgs(tokens.slice(2));
  if (startsWith(tokens, ['git', 'commit'])) return gitCommitArgs(tokens.slice(2));
  if (startsWith(tokens, ['mkdir'])) return mkdirArgs(tokens.slice(1));
  if (startsWith(tokens, ['ls'])) return lsArgs(tokens.slice(1));
  if (startsWith(tokens, ['pwd'])) return tokens.length === 1;
  return false;
}

/**
 * True when every ` && `-separated segment of `cmd` is on the safe list for `opts` (default: task scope, no test
 * runs). Any doubt is false: the request then goes to the user as before.
 */
export function isSafeTaskCommand(cmd: unknown, opts: SafeOptions = {}): boolean {
  const o: Required<SafeOptions> = { scope: opts.scope ?? 'task', runTests: opts.runTests ?? false, packageJson: opts.packageJson ?? false };
  if (typeof cmd !== 'string' || cmd.length === 0 || cmd.length > MAX_LENGTH) return false;
  if (FORBIDDEN.test(cmd)) return false;
  const segments = cmd.split(SEPARATOR);
  if (segments.length > MAX_SEGMENTS) return false;
  for (const raw of segments) {
    if (raw.includes('&')) return false; // '&', '&&' without the exact spaces, '||' is caught by '|'
    const seg = raw.trim();
    if (seg === '') return false;
    const tokens = tokenize(seg);
    if (!tokens || tokens.length === 0) return false;
    if (!segmentIsSafe(tokens, o)) return false;
  }
  return true;
}
