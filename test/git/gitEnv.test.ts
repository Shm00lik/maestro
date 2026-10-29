import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_HOOKS_DIR, ensureEmptyHooksDir, gitSafeEnv } from '../../src/git/gitEnv.js';
import { isSafeTaskCommand } from '../../src/engine/safeCommands.js';

describe('nested-repo diff driver (security re-review, reproduced chain)', () => {
  it("a planted sub/.git with diff.external does not run under Maestro's env; --submodule=diff is not safe", () => {
    const base = mkdtempSync(join(tmpdir(), 'maestro-subdiff-'));
    try {
      const fwd = (p: string) => p.replace(/\\/g, '/');
      const payload = join(base, 'payload-ran.txt');
      const script = join(base, 'ext.sh');
      writeFileSync(script, `#!/bin/sh\necho ran >> "${fwd(payload)}"\n`, { mode: 0o755 });
      const root = join(base, 'repo');
      mkdirSync(root);
      const run = (cwd: string, args: string[], env?: NodeJS.ProcessEnv) =>
        execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e', ...args], { cwd, env, windowsHide: true, stdio: 'pipe' });
      run(root, ['init', '-q', '-b', 'main']);
      writeFileSync(join(root, 'a.txt'), 'a\n');
      run(root, ['add', '.']);
      run(root, ['commit', '-qm', 'init']);
      // What the agent plants: a nested repo whose own config names its payload as the external diff driver.
      const sub = join(root, 'sub');
      mkdirSync(sub);
      run(sub, ['init', '-q']);
      writeFileSync(join(sub, 'b.txt'), 'b\n');
      run(sub, ['add', '.']);
      run(sub, ['commit', '-qm', 's']);
      run(sub, ['config', 'diff.external', fwd(script)]);
      run(root, ['add', 'sub']); // the gitlink
      run(root, ['commit', '-qm', 'gitlink']);
      writeFileSync(join(sub, 'b.txt'), 'changed\n');
      // Config that would turn inline submodule diffs on by default (not agent-writable, but the env must win anyway).
      run(root, ['config', 'diff.submodule', 'diff']);
      run(root, ['config', 'submodule.recurse', 'true']);

      const safe = gitSafeEnv();
      for (const args of [['diff'], ['log', '-p'], ['show'], ['status', '--porcelain']]) {
        run(root, args, safe);
        expect(existsSync(payload), args.join(' ')).toBe(false);
      }
      // The chain is real: without Maestro's env a plain git diff runs the payload.
      run(root, ['diff'], process.env);
      expect(existsSync(payload)).toBe(true);
      // And the explicit option, which beats any config, is not on the safe list.
      for (const cmd of ['git diff --submodule=diff', 'git show --submodule=diff', 'git log -p --submodule']) {
        expect(isSafeTaskCommand(cmd), cmd).toBe(false);
      }
    } finally {
      rmSync(base, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe('gitSafeEnv', () => {
  it('adds core.hooksPath (an empty Maestro folder) and core.fsmonitor=false through GIT_CONFIG_*', () => {
    const env = gitSafeEnv({ PATH: 'p' });
    expect(env).toMatchObject({
      PATH: 'p', GIT_CONFIG_COUNT: '4',
      GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: EMPTY_HOOKS_DIR,
      GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false',
    });
  });

  it('appends after config pairs already in the environment, so its own come last and win', () => {
    const env = gitSafeEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: 'evil' });
    expect(env.GIT_CONFIG_COUNT).toBe('5');
    expect(env.GIT_CONFIG_VALUE_0).toBe('evil');
    expect([env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1]).toEqual(['core.hooksPath', EMPTY_HOOKS_DIR]);
    expect([env.GIT_CONFIG_KEY_2, env.GIT_CONFIG_VALUE_2]).toEqual(['core.fsmonitor', 'false']);
  });

  it('refuses a hooks folder that is not empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'maestro-hooks-'));
    expect(ensureEmptyHooksDir(dir)).toBe(dir);
    writeFileSync(join(dir, 'pre-commit'), 'x');
    expect(() => ensureEmptyHooksDir(dir)).toThrow(/not empty/);
    expect(() => gitSafeEnv({}, undefined)).not.toThrow();
  });
});
