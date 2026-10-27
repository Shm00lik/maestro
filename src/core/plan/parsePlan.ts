import type { PlanTask } from '../types.js';

const TASK_HEADING = /^###\s+Task\s+(\d+)\s*:\s*(.+?)\s*$/i;
const ANY_HEADING = /^#{2,3}\s/;
const FIELD = /^(Depends on|Agent|Owns|Acceptance|Estimate)\s*:\s*(.*)$/i;

function splitList(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

const NO_DEPS = /^(none|-|\u2014)?$/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Every digit run in the value becomes T<n>, de-duplicated, in order of appearance. */
function parseDeps(value: string): string[] {
  if (NO_DEPS.test(value)) return [];
  const out: string[] = [];
  for (const m of value.matchAll(/\d+/g)) {
    const key = `T${Number(m[0])}`;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

export function parsePlan(markdown: string): PlanTask[] {
  const lines = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const tasks: PlanTask[] = [];
  let current: PlanTask | null = null;
  let body: string[] = [];

  const finish = () => {
    if (current) {
      current.body = body.join('\n').trim();
      tasks.push(current);
    }
    current = null;
    body = [];
  };

  let fence: string | null = null; // opening fence run (e.g. "```") while inside a fenced block

  for (const line of lines) {
    if (fence !== null) {
      // Inside a fence: everything is body; close on the same char with at least the same length.
      const close = FENCE.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && line.trim() === close[1]) fence = null;
      if (current) body.push(line);
      continue;
    }
    const open = FENCE.exec(line);
    if (open) {
      fence = open[1];
      if (current) body.push(line);
      continue;
    }
    const heading = TASK_HEADING.exec(line);
    if (heading) {
      finish();
      current = {
        key: `T${Number(heading[1])}`,
        title: heading[2],
        body: '',
        dependsOn: [],
        agent: '',
        owns: [],
        acceptance: '',
        estimate: 1,
      };
      continue;
    }
    if (ANY_HEADING.test(line)) {
      finish();
      continue;
    }
    if (!current) continue;
    const field = FIELD.exec(line);
    if (!field) {
      body.push(line);
      continue;
    }
    const value = field[2].trim();
    switch (field[1].toLowerCase()) {
      case 'depends on': current.dependsOn = parseDeps(value); break;
      case 'agent': current.agent = value; break;
      case 'owns': current.owns = splitList(value); break;
      case 'acceptance': current.acceptance = value; break;
      case 'estimate': {
        const n = Number(value);
        if (value !== '' && Number.isFinite(n)) current.estimate = n;
        break;
      }
    }
  }
  finish();
  return tasks;
}
