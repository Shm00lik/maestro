import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  MAX_WORKTREE_PATH, worktreeDirFor, ensureMissionBranch, createTaskWorktree,
  mergeTaskBranch, branchCommits, removeWorktree, removeIntegrationWorktree,
} from '../../src/git/worktrees.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim();
const gitOr = (cwd: string, fallback: string, ...args: string[]) => {
  try { return git(cwd, ...args); } catch { return fallback; }
};

const roots: string[] = [];
function makeRepo(prefix = 'maestro-wt-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'a.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'init');
  return root;
}
function commitIn(dir: string, file: string, content: string, msg: string): void {
  writeFileSync(join(dir, file), content);
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', msg);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      const wts = git(root, 'worktree', 'list', '--porcelain').split('\n')
        .filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9).trim()).slice(1);
      for (const w of wts) { try { git(root, 'worktree', 'remove', '--force', w); } catch { /* ignore */ } }
    } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

const MID = 'abcdef12-3456-7890-abcd-ef1234567890';

describe('worktrees', () => {
  it('uses a hashed folder when the path would exceed 200 chars', () => {
    const short = worktreeDirFor('C:\\proj', MID, 'T1');
    expect(short).toContain('abcdef12-T1');
    const root = 'C:\\' + 'x'.repeat(100);
    const key = 'k'.repeat(80);
    const dir = worktreeDirFor(root, MID, key);
    expect(dir.length).toBeLessThan(MAX_WORKTREE_PATH);
    expect(dir).toMatch(/abcdef12-[0-9a-f]{8}$/);
    expect(() => worktreeDirFor('C:\\' + 'y'.repeat(190), MID, 'k')).toThrow(/y{20}/);
  });

  it('creates a task worktree on its own branch from the mission branch', async () => {
    const root = makeRepo();
    await ensureMissionBranch(root, 'main', 'mission/m1');
    await ensureMissionBranch(root, 'main', 'mission/m1'); // no-op
    const dir = worktreeDirFor(root, MID, 'T1');
    await createTaskWorktree(root, 'mission/m1', 'task/T1', dir);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('task/T1');
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(git(root, 'rev-parse', 'mission/m1'));
    expect(git(root, 'status', '--porcelain')).toBe('');
    await removeWorktree(root, dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('merges a task branch with --no-ff and returns the commit', async () => {
    const root = makeRepo();
    await ensureMissionBranch(root, 'main', 'mission/m1');
    const dir = worktreeDirFor(root, MID, 'T1');
    await createTaskWorktree(root, 'mission/m1', 'task/T1', dir);
    commitIn(dir, 'b.txt', 'b\n', 'add b');
    const r = await mergeTaskBranch(root, 'mission/m1', 'task/T1', 'merge T1', MID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.commit).toBe(git(root, 'rev-parse', 'mission/m1'));
    expect(git(root, 'rev-list', '--parents', '-n1', r.commit).split(' ')).toHaveLength(3);
    expect(git(root, 'log', '-1', '--format=%s', 'mission/m1')).toBe('merge T1');
    expect(await branchCommits(root, 'main', 'task/T1')).toHaveLength(1);
    await removeIntegrationWorktree(root, MID);
    expect(existsSync(worktreeDirFor(root, MID, 'integration'))).toBe(false);
  });

  it('reports conflicts and leaves the mission branch unchanged', async () => {
    const root = makeRepo();
    await ensureMissionBranch(root, 'main', 'mission/m1');
    const d1 = worktreeDirFor(root, MID, 'T1');
    const d2 = worktreeDirFor(root, MID, 'T2');
    await createTaskWorktree(root, 'mission/m1', 'task/T1', d1);
    await createTaskWorktree(root, 'mission/m1', 'task/T2', d2);
    commitIn(d1, 'a.txt', 'one\n', 'one');
    commitIn(d2, 'a.txt', 'two\n', 'two');
    expect((await mergeTaskBranch(root, 'mission/m1', 'task/T1', 'm1', MID)).ok).toBe(true);
    const before = git(root, 'rev-parse', 'mission/m1');
    const r = await mergeTaskBranch(root, 'mission/m1', 'task/T2', 'm2', MID);
    expect(r).toEqual({ ok: false, reason: 'conflict', files: ['a.txt'] });
    expect(git(root, 'rev-parse', 'mission/m1')).toBe(before);
    const integ = worktreeDirFor(root, MID, 'integration');
    expect(git(integ, 'status', '--porcelain')).toBe('');
  });

  it("never changes the user's checked-out branch", async () => {
    const root = makeRepo();
    await ensureMissionBranch(root, 'main', 'mission/m1');
    const dir = worktreeDirFor(root, MID, 'T1');
    await createTaskWorktree(root, 'mission/m1', 'task/T1', dir);
    commitIn(dir, 'b.txt', 'b\n', 'add b');
    await mergeTaskBranch(root, 'mission/m1', 'task/T1', 'merge', MID);
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(existsSync(join(root, 'b.txt'))).toBe(false);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('creates and merges worktrees under a path with spaces', async () => {
    const root = makeRepo('maestro wt \u00e9 ');
    await ensureMissionBranch(root, 'main', 'mission/m1');
    const dir = worktreeDirFor(root, MID, 'T1');
    await createTaskWorktree(root, 'mission/m1', 'task/T1', dir);
    commitIn(dir, 'b.txt', 'b\n', 'add b');
    const r = await mergeTaskBranch(root, 'mission/m1', 'task/T1', 'merge', MID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(git(root, 'merge-base', '--is-ancestor', r.commit, 'mission/m1')).toBe('');
    expect(git(root, 'rev-parse', 'mission/m1')).toBe(r.commit);
  });

  it('throws a clear error when the integration worktree is on another branch', async () => {
    const root = makeRepo();
    await ensureMissionBranch(root, 'main', 'mission/m1');
    const dir = worktreeDirFor(root, MID, 'T1');
    await createTaskWorktree(root, 'mission/m1', 'task/T1', dir);
    commitIn(dir, 'b.txt', 'b\n', 'add b');
    await mergeTaskBranch(root, 'mission/m1', 'task/T1', 'merge', MID);
    git(worktreeDirFor(root, MID, 'integration'), 'checkout', '-b', 'other');
    await expect(mergeTaskBranch(root, 'mission/m1', 'task/T1', 'again', MID)).rejects.toThrow(/integration worktree.*other.*mission\/m1/);
  });

  it('hints when the mission branch is checked out in another worktree', async () => {
    const root = makeRepo();
    await ensureMissionBranch(root, 'main', 'mission/m1');
    const dir = worktreeDirFor(root, MID, 'T1');
    await createTaskWorktree(root, 'mission/m1', 'task/T1', dir);
    git(root, 'checkout', 'mission/m1');
    await expect(mergeTaskBranch(root, 'mission/m1', 'task/T1', 'm', MID))
      .rejects.toThrow('the mission branch mission/m1 is checked out in another worktree; switch that checkout to another branch');
  });

  it('recognises a registered integration worktree given a differently written project path', async () => {
    const root = makeRepo();
    await ensureMissionBranch(root, 'main', 'mission/m1');
    const dir = worktreeDirFor(root, MID, 'T1');
    await createTaskWorktree(root, 'mission/m1', 'task/T1', dir);
    commitIn(dir, 'b.txt', 'b\n', 'add b');
    expect((await mergeTaskBranch(root, 'mission/m1', 'task/T1', 'one', MID)).ok).toBe(true);
    const alt = root.replace(/\\/g, '/').toUpperCase();
    commitIn(dir, 'c.txt', 'c\n', 'add c');
    expect((await mergeTaskBranch(alt, 'mission/m1', 'task/T1', 'two', MID)).ok).toBe(true);
  });

  it('sets core.longpaths only in the repo config', async () => {
    const root = makeRepo();
    const globalBefore = gitOr(root, '', 'config', '--global', '--get', 'core.longpaths');
    await ensureMissionBranch(root, 'main', 'mission/m1');
    await createTaskWorktree(root, 'mission/m1', 'task/T1', worktreeDirFor(root, MID, 'T1'));
    expect(git(root, 'config', '--local', '--get', 'core.longpaths')).toBe('true');
    expect(gitOr(root, '', 'config', '--global', '--get', 'core.longpaths')).toBe(globalBefore);
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('.claude/worktrees/');
  });
});
