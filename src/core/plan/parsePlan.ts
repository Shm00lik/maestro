import type { PlanTask } from '../types.js';

const TASK_HEADING = /^###\s+Task\s+(\d+)\s*:\s*(.+?)\s*$/i;
const ANY_HEADING = /^#{2,3}\s/;
const FIELD = /^(Depends on|Agent|Owns|Acceptance|Estimate)\s*:\s*(.*)$/i;

function splitList(value: string): string[] {
  return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

function parseDeps(value: string): string[] {
  const out: string[] = [];
  for (const token of splitList(value)) {
    const digits = token.replace(/\D/g, '');
    if (digits === '') continue; // none, -, — and other non-numeric tokens
    out.push(`T${Number(digits)}`);
  }
  return out;
}

export function parsePlan(markdown: string): PlanTask[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
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

  for (const line of lines) {
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
