import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { resolve, dirname, isAbsolute } from 'node:path';
import { mkdirSync, existsSync, realpathSync, readFileSync, appendFileSync } from 'node:fs';

const execFileP = promisify(execFile);

/** Worktree directories must stay shorter than this many characters (see the R5 Windows spike). */
export const MAX_WORKTREE_PATH = 200;

const EXCLUDE_LINE = '.claude/worktrees/';

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    const err = e as Error & { stderr?: string };
    const stderr = (err.stderr ?? '').toString().trim();
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr || err.message}`);
  }
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const mission8 = (missionId: string) => missionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
const safeKey = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '-');

export function worktreeDirFor(projectRoot: string, missionId: string, key: string): string {
  const base = resolve(projectRoot, '.claude', 'worktrees');
  const m = mission8(missionId);
  const full = resolve(base, `${m}-${safeKey(key)}`);
  if (full.length < MAX_WORKTREE_PATH) return full;
  const hashed = resolve(base, `${m}-${sha1(key).slice(0, 8)}`);
  if (hashed.length < MAX_WORKTREE_PATH) return hashed;
  throw new Error(
    `Project path is too long for git worktrees on Windows (worktree path would be ${hashed.length} chars, limit ${MAX_WORKTREE_PATH - 1}): ${projectRoot}. Move the project to a shorter path.`,
  );
}

export async function branchExists(projectRoot: string, branch: string): Promise<boolean> {
  try {
    await git(projectRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export async function ensureMissionBranch(projectRoot: string, baseBranch: string, missionBranch: string): Promise<void> {
  if (await branchExists(projectRoot, missionBranch)) return;
  await git(projectRoot, ['branch', missionBranch, baseBranch]);
}

async function ensureExcluded(projectRoot: string): Promise<void> {
  let p = await git(projectRoot, ['rev-parse', '--git-path', 'info/exclude']);
  if (!isAbsolute(p)) p = resolve(projectRoot, p);
  const current = existsSync(p) ? readFileSync(p, 'utf8') : '';
  if (current.split(/\r?\n/).some((l) => l.trim() === EXCLUDE_LINE)) return;
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, (current === '' || current.endsWith('\n') ? '' : '\n') + EXCLUDE_LINE + '\n');
}

async function prepare(projectRoot: string): Promise<void> {
  await git(projectRoot, ['config', '--local', 'core.longpaths', 'true']);
  await ensureExcluded(projectRoot);
}

export async function createTaskWorktree(
  projectRoot: string, missionBranch: string, taskBranch: string, dir: string,
): Promise<void> {
  await prepare(projectRoot);
  mkdirSync(dirname(dir), { recursive: true });
  await git(projectRoot, ['worktree', 'add', '-b', taskBranch, dir, missionBranch]);
}

/** Adds a worktree at dir for a branch that already exists (e.g. a retried task whose folder was removed). */
export async function addExistingBranchWorktree(projectRoot: string, branch: string, dir: string): Promise<void> {
  await prepare(projectRoot);
  mkdirSync(dirname(dir), { recursive: true });
  await git(projectRoot, ['worktree', 'add', dir, branch]);
}

export async function pruneWorktrees(projectRoot: string): Promise<void> {
  await git(projectRoot, ['worktree', 'prune']);
}

export async function isRegisteredWorktree(projectRoot: string, dir: string): Promise<boolean> {
  return (await listWorktrees(projectRoot)).some((w) => norm(w) === norm(dir));
}

async function listWorktrees(projectRoot: string): Promise<string[]> {
  const out = await git(projectRoot, ['worktree', 'list', '--porcelain']);
  return out.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9).trim());
}

function norm(p: string): string {
  let r = resolve(p);
  try { r = realpathSync.native(r); } catch { /* does not exist: keep resolved path */ }
  return r.replace(/\\/g, '/').toLowerCase();
}

async function ensureIntegrationWorktree(
  projectRoot: string, missionBranch: string, missionId: string,
): Promise<string> {
  const dir = worktreeDirFor(projectRoot, missionId, 'integration');
  const known = (await listWorktrees(projectRoot)).some((w) => norm(w) === norm(dir));
  if (known && existsSync(dir)) {
    const head = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (head !== missionBranch) {
      throw new Error(`The integration worktree ${dir} is on branch ${head}, expected ${missionBranch}. Switch it back or remove it.`);
    }
    return dir;
  }
  await prepare(projectRoot);
  mkdirSync(dirname(dir), { recursive: true });
  if (known) await git(projectRoot, ['worktree', 'prune']);
  try {
    await git(projectRoot, ['worktree', 'add', dir, missionBranch]);
  } catch (e) {
    const msg = (e as Error).message;
    if (/already (checked out|used by worktree)/i.test(msg)) {
      throw new Error(`the mission branch ${missionBranch} is checked out in another worktree; switch that checkout to another branch (${msg})`);
    }
    throw e;
  }
  return dir;
}

/** Merges taskBranch into missionBranch with --no-ff inside the mission's integration worktree (named by missionId). */
export async function mergeTaskBranch(
  projectRoot: string, missionBranch: string, taskBranch: string, message: string, missionId: string,
): Promise<{ ok: true; commit: string } | { ok: false; reason: 'conflict'; files: string[] }> {
  const dir = await ensureIntegrationWorktree(projectRoot, missionBranch, missionId);
  try {
    await git(dir, ['merge', '--no-ff', '-m', message, taskBranch]);
  } catch (e) {
    const files = (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).split(/\r?\n/).filter(Boolean);
    try { await git(dir, ['merge', '--abort']); } catch { /* nothing to abort */ }
    if (files.length === 0) throw e;
    return { ok: false, reason: 'conflict', files };
  }
  return { ok: true, commit: await git(dir, ['rev-parse', 'HEAD']) };
}

export async function branchCommits(projectRoot: string, base: string, branch: string): Promise<string[]> {
  const out = await git(projectRoot, ['rev-list', '--reverse', `${base}..${branch}`]);
  return out.split(/\r?\n/).filter(Boolean);
}

export async function removeWorktree(projectRoot: string, dir: string): Promise<void> {
  await git(projectRoot, ['worktree', 'remove', '--force', dir]);
}

export async function removeIntegrationWorktree(projectRoot: string, missionId: string): Promise<void> {
  const dir = worktreeDirFor(projectRoot, missionId, 'integration');
  if (!(await listWorktrees(projectRoot)).some((w) => norm(w) === norm(dir))) return;
  await removeWorktree(projectRoot, dir);
}
