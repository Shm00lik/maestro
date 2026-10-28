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

/** pid itself (if running) followed by all descendants; [] when pid is not running. */
export function listTreePids(pid: number): number[] {
  const r = spawnSync('powershell', PS_ARGS, { windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) return [];
  return treeFromJson(r.stdout, pid);
}

/** Async variant of listTreePids (does not block the event loop); never rejects. */
export function listTreePidsAsync(pid: number): Promise<number[]> {
  return new Promise(resolve => {
    try {
      execFile('powershell', PS_ARGS, { windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 26 }, (err, stdout) => {
        resolve(err ? [] : treeFromJson(stdout, pid));
      });
    } catch { resolve([]); }
  });
}
