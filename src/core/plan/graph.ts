import type { PlanTask } from '../types.js';

export interface PlanGraph {
  depth: Record<string, number>;
  waves: string[][];
  criticalPath: string[];
  children: Record<string, string[]>;
}

const num = (k: string) => parseInt(k.replace(/\D+/g, ''), 10);
const byKey = (a: string, b: string) => num(a) - num(b);

export function buildGraph(tasks: PlanTask[]): PlanGraph {
  const keys = tasks.map(t => t.key).sort(byKey);
  const task = new Map(tasks.map(t => [t.key, t]));
  const children: Record<string, string[]> = {};
  for (const k of keys) children[k] = [];
  for (const t of tasks) for (const d of t.dependsOn) children[d]?.push(t.key);
  for (const k of keys) children[k].sort(byKey);

  // Kahn topological order (ties by key)
  const indeg = new Map(keys.map(k => [k, task.get(k)!.dependsOn.length]));
  const ready = keys.filter(k => indeg.get(k) === 0);
  const order: string[] = [];
  while (ready.length) {
    ready.sort(byKey);
    const k = ready.shift()!;
    order.push(k);
    for (const c of children[k]) {
      indeg.set(c, indeg.get(c)! - 1);
      if (indeg.get(c) === 0) ready.push(c);
    }
  }

  const depth: Record<string, number> = {};
  const best: Record<string, number> = {};
  const prev: Record<string, string | undefined> = {};
  for (const k of order) {
    const t = task.get(k)!;
    let d = 0, p: string | undefined, pb = -Infinity;
    for (const dep of [...t.dependsOn].sort(byKey)) {
      d = Math.max(d, depth[dep]);
      if (best[dep] > pb) { pb = best[dep]; p = dep; }
    }
    depth[k] = d + 1;
    best[k] = t.estimate + (p === undefined ? 0 : pb);
    prev[k] = p;
  }

  const waves: string[][] = [];
  for (const k of keys) (waves[depth[k] - 1] ??= []).push(k);

  let sink: string | undefined;
  for (const k of keys) if (sink === undefined || best[k] > best[sink]) sink = k;
  const criticalPath: string[] = [];
  for (let k = sink; k !== undefined; k = prev[k]) criticalPath.unshift(k);

  return { depth, waves, criticalPath, children };
}

function walk(next: (k: string) => string[], key: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...next(key)];
  while (stack.length) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    stack.push(...next(k));
  }
  return seen;
}

export function ancestors(tasks: PlanTask[], key: string): Set<string> {
  const m = new Map(tasks.map(t => [t.key, t.dependsOn]));
  return walk(k => m.get(k) ?? [], key);
}

export function descendants(tasks: PlanTask[], key: string): Set<string> {
  return walk(k => tasks.filter(t => t.dependsOn.includes(k)).map(t => t.key), key);
}
