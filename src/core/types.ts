export const AGENT_ROLES = ['researcher','architect','designer','implementer','test-author','debugger','spec-reviewer','code-reviewer','qa'] as const;
export type AgentRole = typeof AGENT_ROLES[number];

export interface PlanTask {
  key: string;            // "T6"
  title: string;
  body: string;           // markdown under the heading, minus the field lines
  dependsOn: string[];    // ["T3","T4"]
  agent: string;          // raw; validated in Task 2
  owns: string[];         // glob strings, trimmed
  acceptance: string;
  estimate: number;       // default 1
}

/**
 * Natural order for task keys: by the number in the first digit run ("T2" < "T10"),
 * keys without digits after keys with digits, then by full string.
 */
export function compareTaskKeys(a: string, b: string): number {
  const na = /\d+/.exec(a), nb = /\d+/.exec(b);
  if (na && !nb) return -1;
  if (!na && nb) return 1;
  if (na && nb) {
    const d = Number(na[0]) - Number(nb[0]);
    if (d !== 0) return d;
  }
  return a.localeCompare(b, 'en');
}
