// Windows process-tree control. Never SIGINT / child.kill(): they orphan grandchildren (R5 spike).
import { spawnSync } from 'node:child_process';

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

/** pid itself (if running) followed by all descendants; [] when pid is not running. */
export function listTreePids(pid: number): number[] {
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 1 << 26 },
  );
  if (r.status !== 0 || !r.stdout?.trim()) return [];
  const parsed = JSON.parse(r.stdout) as Row | Row[];
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
