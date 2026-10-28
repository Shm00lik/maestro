// Windows process-tree control. Never SIGINT / child.kill(): they orphan grandchildren (R5 spike).
import { execFile, spawnSync } from 'node:child_process';

export function killTree(pid: number): { ok: boolean; output: string } {
  try {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
    if (r.error) return { ok: false, output: output || r.error.message };
    const gone = r.status === 128 && /not found/i.test(output);
    return { ok: r.status === 0 || gone, output };
  } catch (e) {
    return { ok: false, output: (e as Error).message };
  }
}

interface Row { ProcessId: number; ParentProcessId: number }

const PS_ARGS = ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId | ConvertTo-Json -Compress'];

function treeFromJson(stdout: string | undefined | null, pid: number): number[] {
  if (!stdout?.trim()) return [];
  let parsed: Row | Row[];
  try { parsed = JSON.parse(stdout) as Row | Row[]; } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (!rows.some(p => p.ProcessId === pid)) return [];
  const result: number[] = [];
  const seen = new Set<number>();
  const walk = (p: number): void => {
    if (seen.has(p)) return;
    seen.add(p);
    result.push(p);
    for (const c of rows) if (c.ParentProcessId === p) walk(c.ProcessId);
  };
  walk(pid);
  return result;
}

/** Bound for the async helpers: a hung taskkill/PowerShell must not hang its caller (timeout -> error branch). */
export const ASYNC_TIMEOUT_MS = 10_000;

function taskkillAsync(args: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    try {
      execFile('taskkill', args, { windowsHide: true, encoding: 'utf8', timeout: timeoutMs }, (err, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
        const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        const gone = code === 128 && /not found/i.test(output);
        resolve({ ok: code === 0 || gone, output: output || (err ? err.message : '') });
      });
    } catch (e) { resolve({ ok: false, output: (e as Error).message }); }
  });
}

/** Async killTree (taskkill /T /F); same ok rules, never rejects; ok:false on timeout. */
export function killTreeAsync(pid: number, timeoutMs = ASYNC_TIMEOUT_MS): Promise<{ ok: boolean; output: string }> {
  return taskkillAsync(['/PID', String(pid), '/T', '/F'], timeoutMs);
}

/** Kills one pid only (taskkill /F, no /T); same ok rules as killTreeAsync. */
export function killPidAsync(pid: number, timeoutMs = ASYNC_TIMEOUT_MS): Promise<{ ok: boolean; output: string }> {
  return taskkillAsync(['/PID', String(pid), '/F'], timeoutMs);
}

/** pid itself (if running) followed by all descendants; [] when pid is not running. */
export function listTreePids(pid: number): number[] {
  const r = spawnSync('powershell', PS_ARGS, { windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) return [];
  return treeFromJson(r.stdout, pid);
}

/** Async variant of listTreePids (does not block the event loop); never rejects; [] on timeout. */
export function listTreePidsAsync(pid: number, timeoutMs = ASYNC_TIMEOUT_MS): Promise<number[]> {
  return new Promise(resolve => {
    try {
      execFile('powershell', PS_ARGS, { windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 26, timeout: timeoutMs }, (err, stdout) => {
        resolve(err ? [] : treeFromJson(stdout, pid));
      });
    } catch { resolve([]); }
  });
}
