// Git config forced through the environment for every git process Maestro runs and every task session (spec §8.1):
// hooks come from an empty Maestro-owned folder (so the repo's own hooks, which an agent could edit, never run) and
// fsmonitor is off (a nested .git/config could name any program as its fsmonitor). Environment config
// (GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n, git >= 2.31) wins over every config file and is
// inherited by child git processes, e.g. the ones `git status` starts for submodules.
import { mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The empty hooks folder: `<maestro>/.maestro-empty-hooks` (git-ignored). */
export const EMPTY_HOOKS_DIR = fileURLToPath(new URL('../../.maestro-empty-hooks/', import.meta.url)).replace(/[\\/]$/, '');

/** Creates the empty hooks folder; throws when something put files in it (then no git call runs). */
export function ensureEmptyHooksDir(dir: string = EMPTY_HOOKS_DIR): string {
  mkdirSync(dir, { recursive: true });
  const entries = readdirSync(dir);
  if (entries.length > 0) throw new Error(`Maestro's empty hooks folder is not empty (${entries.join(', ')}): ${dir}`);
  return dir;
}

/** The config pairs Maestro forces. */
export function safeGitConfig(hooksDir: string = ensureEmptyHooksDir()): [string, string][] {
  return [
    ['core.hooksPath', hooksDir],
    ['core.fsmonitor', 'false'],
    // No inline submodule diffs or recursion: they run git inside a nested repo, under that repo's own config
    // (e.g. a planted diff.external).
    ['diff.submodule', 'short'],
    ['submodule.recurse', 'false'],
  ];
}

/**
 * `base` (default process.env) plus the forced config, appended after any GIT_CONFIG_* pairs already in `base` so
 * that ours come last and win.
 */
export function gitSafeEnv(base: NodeJS.ProcessEnv = process.env, hooksDir?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  let i = Number.isInteger(n) && n > 0 ? n : 0;
  for (const [k, v] of safeGitConfig(hooksDir)) {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
    i++;
  }
  env.GIT_CONFIG_COUNT = String(i);
  return env;
}
