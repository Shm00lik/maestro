import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPTY_HOOKS_DIR, ensureEmptyHooksDir, gitSafeEnv } from '../../src/git/gitEnv.js';

describe('gitSafeEnv', () => {
  it('adds core.hooksPath (an empty Maestro folder) and core.fsmonitor=false through GIT_CONFIG_*', () => {
    const env = gitSafeEnv({ PATH: 'p' });
    expect(env).toMatchObject({
      PATH: 'p', GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: EMPTY_HOOKS_DIR,
      GIT_CONFIG_KEY_1: 'core.fsmonitor', GIT_CONFIG_VALUE_1: 'false',
    });
  });

  it('appends after config pairs already in the environment, so its own come last and win', () => {
    const env = gitSafeEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: 'evil' });
    expect(env.GIT_CONFIG_COUNT).toBe('3');
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
