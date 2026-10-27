import picomatch from 'picomatch';
import { AGENT_ROLES, compareTaskKeys, type PlanTask } from '../types.js';
import { ancestors } from './graph.js';

export type PlanErrorCode = 'empty-plan'|'duplicate-key'|'unknown-dependency'|'self-dependency'|'cycle'|'unknown-agent'|'missing-acceptance'|'ownership-overlap';
export interface PlanError { code: PlanErrorCode; taskKeys: string[]; message: string }

const CODE_ORDER: PlanErrorCode[] = ['empty-plan','duplicate-key','unknown-dependency','self-dependency','cycle','unknown-agent','missing-acceptance','ownership-overlap'];

/** Backslashes to '/', drop a leading './', lowercase (ownership is compared case-insensitively). */
const norm = (g: string) => g.split(String.fromCharCode(92)).join('/').replace(/^(\.\/)+/, '').toLowerCase();
const staticPrefix = (g: string) => {
  const i = g.search(/[*?[{]/);
  return i === -1 ? g : g.slice(0, i);
};
const segPrefix = (x: string, y: string) =>
  x === '' || x === y || y.startsWith(x.endsWith('/') ? x : x + '/');

function globsOverlap(a: string, b: string): boolean {
  const ga = norm(a), gb = norm(b);
  const pa = staticPrefix(ga), pb = staticPrefix(gb);
  return picomatch(ga)(pb) || picomatch(gb)(pa) || segPrefix(pa, pb) || segPrefix(pb, pa);
}

/** Tarjan's SCC; returns components with more than one node. */
function cycles(keys: string[], edges: Map<string, string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>(), low = new Map<string, number>();
  const onStack = new Set<string>(), stack: string[] = [];
  const out: string[][] = [];
  const visit = (v: string) => {
    index.set(v, counter); low.set(v, counter); counter++;
    stack.push(v); onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = [];
      let w: string;
      do { w = stack.pop()!; onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) out.push(comp);
    }
  };
  for (const k of keys) if (!index.has(k)) visit(k);
  return out;
}

export function validatePlan(tasks: PlanTask[]): PlanError[] {
  if (tasks.length === 0) return [{ code: 'empty-plan', taskKeys: [], message: 'Plan contains no tasks.' }];
  const errors: PlanError[] = [];
  const add = (code: PlanErrorCode, taskKeys: string[], message: string) => errors.push({ code, taskKeys, message });

  const seen = new Set<string>(), dups = new Set<string>();
  for (const t of tasks) (seen.has(t.key) ? dups : seen).add(t.key);
  for (const k of dups) add('duplicate-key', [k], `Task key ${k} is used more than once.`);

  const unique = [...new Map(tasks.slice().reverse().map(t => [t.key, t])).values()].reverse();
  const keys = unique.map(t => t.key);
  const known = new Set(keys);
  const edges = new Map<string, string[]>();
  for (const t of unique) {
    for (const d of t.dependsOn) {
      if (d === t.key) add('self-dependency', [t.key], `${t.key} depends on itself.`);
      else if (!known.has(d)) add('unknown-dependency', [t.key], `${t.key} depends on unknown task ${d}.`);
    }
    edges.set(t.key, t.dependsOn.filter(d => known.has(d) && d !== t.key));
  }

  const inCycle = new Set<string>();
  for (const comp of cycles(keys, edges)) {
    comp.forEach(k => inCycle.add(k));
    const sorted = comp.sort(compareTaskKeys);
    add('cycle', sorted, `Dependency cycle: ${sorted.join(' -> ')}.`);
  }

  for (const t of tasks) {
    if (!(AGENT_ROLES as readonly string[]).includes(t.agent))
      add('unknown-agent', [t.key], `${t.key} has unknown agent "${t.agent}".`);
    if (!t.acceptance.trim()) add('missing-acceptance', [t.key], `${t.key} has no acceptance criteria.`);
  }

  const anc = new Map(keys.map(k => [k, ancestors(unique, k)]));
  for (let i = 0; i < unique.length; i++) for (let j = i + 1; j < unique.length; j++) {
    const a = unique[i], b = unique[j];
    if (inCycle.has(a.key) || inCycle.has(b.key)) continue;
    if (anc.get(a.key)!.has(b.key) || anc.get(b.key)!.has(a.key)) continue;
    const hit = a.owns.flatMap(x => b.owns.filter(y => globsOverlap(x, y)).map(y => [x, y]))[0];
    if (hit) add('ownership-overlap', [a.key, b.key], `${a.key} and ${b.key} run in parallel but both own overlapping paths (${hit[0]} vs ${hit[1]}).`);
  }

  return errors
    .map((e, i) => ({ e, i }))
    .sort((x, y) =>
      CODE_ORDER.indexOf(x.e.code) - CODE_ORDER.indexOf(y.e.code) ||
      compareTaskKeys(x.e.taskKeys[0] ?? '', y.e.taskKeys[0] ?? '') || x.i - y.i)
    .map(x => x.e);
}
