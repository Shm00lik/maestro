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
