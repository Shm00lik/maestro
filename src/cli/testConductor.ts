// TEST-ONLY. A fake conductor (test/fake-claude) cannot call MCP tools, so CLI tests drive the conductor side with a
// JSON script that calls the engine's bridge handlers in order. Everything here is inert unless MAESTRO_TEST=1:
// without it, --conductor-script is refused and MAESTRO_TEST_CONDUCTOR_SCENARIO is ignored.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { MissionEngine } from '../engine/missionEngine.js';

export type ConductorStep =
  | { op: 'submit_plan'; plan: string }
  | { op: 'dispatch'; task_id: string; agent?: string; prompt?: string; depends_on?: string[]; owns?: string[] }
  | { op: 'wait'; tasks: string[]; mode?: 'all' | 'any' }
  | { op: 'ask_user'; question: string; options?: string[]; context?: string }
  | { op: 'finish'; summary: string };

export interface TestHooks {
  /** Extra env for the conductor session only (a different fake-claude scenario than the tasks). */
  conductorEnv?: Record<string, string>;
  /** Runs the conductor script against the engine. */
  runConductor?(engine: MissionEngine, missionId: string, log: (line: string) => void): Promise<void>;
}

export const testMode = (env: NodeJS.ProcessEnv): boolean => env.MAESTRO_TEST === '1';

/** Returns the test hooks, or throws when --conductor-script is given outside test mode. */
export function loadTestHooks(env: NodeJS.ProcessEnv, scriptPath: string | undefined): TestHooks {
  if (!testMode(env)) {
    if (scriptPath !== undefined) throw new Error('Unknown option --conductor-script');
    return {};
  }
  const hooks: TestHooks = {};
  if (env.MAESTRO_TEST_CONDUCTOR_SCENARIO) {
    hooks.conductorEnv = { FAKE_CLAUDE_SCENARIO: env.MAESTRO_TEST_CONDUCTOR_SCENARIO };
  }
  if (scriptPath !== undefined) {
    const abs = resolve(scriptPath);
    const steps = JSON.parse(readFileSync(abs, 'utf8')) as ConductorStep[];
    if (!Array.isArray(steps)) throw new Error('--conductor-script must be a JSON array of steps');
    hooks.runConductor = (engine, missionId, log) => runScript(engine, missionId, steps, dirname(abs), log);
  }
  return hooks;
}

async function runScript(
  engine: MissionEngine, missionId: string, steps: ConductorStep[], baseDir: string, log: (line: string) => void,
): Promise<void> {
  const refs = new Map<string, string>();
  const ref = (key: string): string => {
    const r = refs.get(key);
    if (!r) throw new Error(`test conductor: ${key} was not dispatched`);
    return r;
  };
  for (const s of steps) {
    switch (s.op) {
      case 'submit_plan': {
        const path = resolve(baseDir, s.plan);
        for (;;) {
          const r = await engine.submitPlan(missionId, path);
          if ('errors' in r) throw new Error(`plan errors: ${r.errors.map(e => e.message).join('; ')}`);
          if (r.approved) { log('[test-conductor] plan approved'); break; }
          log(`[test-conductor] re-plan requested: ${r.note}`);
        }
        break;
      }
      case 'dispatch': {
        const r = await engine.dispatchTask(missionId, {
          task_id: s.task_id, agent: s.agent ?? 'implementer', prompt: s.prompt ?? `Do ${s.task_id}.`,
          depends_on: s.depends_on ?? [], owns: s.owns ?? [],
        });
        refs.set(s.task_id, r.task_ref);
        break;
      }
      case 'wait': {
        const done = await engine.waitForTasks(missionId, s.tasks.map(ref), s.mode ?? 'all', () => undefined);
        log(`[test-conductor] wait -> ${done.map(d => `${d.key}:${d.status}`).join(', ')}`);
        break;
      }
      case 'ask_user': {
        const a = await engine.askUser(missionId, null, { question: s.question, options: s.options, context: s.context });
        log(`[test-conductor] ask_user -> ${a}`);
        break;
      }
      case 'finish': {
        const a = await engine.finishMission(missionId, s.summary);
        log(`[test-conductor] finish_mission -> ${a}`);
        break;
      }
      default:
        throw new Error(`test conductor: unknown step ${JSON.stringify(s)}`);
    }
  }
}
