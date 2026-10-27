# Maestro Plan 1 — Foundation & Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Maestro's pure core (plan parser, plan validation, dependency graph, task and mission state machines, scheduler, SQLite store), and run the spikes that settle how Maestro talks to the `claude` CLI.

**Architecture:** A Node + TypeScript package. `src/core/**` holds pure functions with no I/O. `src/store/**` wraps SQLite. `spikes/**` holds throwaway scripts whose only output is a findings document. Plan 2 (session runner, bridge, worktrees, inbox) and Plan 3 (UI) build on the interfaces defined here and on the spike findings.

**Tech Stack:** Node.js 22 LTS, TypeScript 5 (strict, ESM), Vitest 2, better-sqlite3 11, picomatch 4 (glob checks), @modelcontextprotocol/sdk (R1/R6 spike only), tsx (to run spike scripts).

**Spec:** `docs/superpowers/specs/2026-10-28-maestro-design.md`

## Global Constraints

- Platform: Windows 11 first-class. Every path operation uses `node:path`, and tests must pass on Windows (CRLF input, backslash paths).
- Local only: no network listeners in this plan. Nothing reads or stores credentials.
- Usage is tokens only: no dollar or cost fields anywhere (`tokens_in`, `tokens_out` only).
- Agent roles (exact strings): `researcher`, `architect`, `designer`, `implementer`, `test-author`, `debugger`, `spec-reviewer`, `code-reviewer`, `qa`.
- Task keys are `T<n>`, taken from plan headings `### Task <n>: <title>`.
- Parallel limits: per mission default 3 (range 1–8); global default 6.
- Rate-limit backoff: 1, 2, 4, 8, 16 minutes, capped at 30 minutes.
- Merging into the base branch always asks the user (Plan 2; nothing in this plan merges).
- Conventional Commits messages. Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Plans written on Windows (CRLF line endings, trailing spaces).** They must parse exactly like LF plans. Test: Task 1, `parses CRLF plans identically`.
2. **"No dependencies" written in different ways** (`none`, `None`, `-`, `—`, an empty value, or the line left out). All mean no dependencies, never an error. Test: Task 1, `treats none/dash/empty/missing as no dependencies`.
3. **Ownership overlap between a parent folder and a child folder** (`src/**` and `src/api/**`), or between a glob and an exact file. This must count as overlap for parallel tasks. Tasks on the same dependency chain must never be flagged. Test: Task 2, `flags parent/child glob overlap only for parallel tasks`.
4. **Duplicate task numbers or an empty plan.** These must give a clear `duplicate-key` / `empty-plan` error, not a crash or a silently merged task. Test: Task 2, `reports duplicate keys and empty plans`.
5. **A user stops a task while it is waiting on a question** (`needs_you` → `cancelled`), or retries a failed task. These must be legal transitions; anything else must throw a typed error, not corrupt state. Test: Task 4, `allows cancel from every non-terminal state` and `rejects transitions out of terminal states`.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore
src/core/types.ts               shared types (roles, PlanTask, PlanError, states)
src/core/plan/parsePlan.ts      markdown → PlanTask[]
src/core/plan/validatePlan.ts   PlanTask[] → PlanError[]
src/core/plan/graph.ts          depths, waves, critical path, ancestors/descendants
src/core/state/taskMachine.ts   task state transitions
src/core/state/missionMachine.ts mission state transitions
src/core/scheduler/scheduler.ts which ready tasks start now; backoff
src/store/schema.sql            tables from spec §10 (no cost columns)
src/store/db.ts                 openDb(), migrations
src/store/repos.ts              typed repository functions
test/**                         mirrors src/**
test/fixtures/plans/*.md        sample plans
spikes/r1-conductor/…, spikes/r2-stream/…, spikes/r3-permissions/…, spikes/r5-windows/…
docs/superpowers/spikes/2026-10-xx-<id>.md   findings (one per spike)
```

---

### Task 1: Project scaffold and plan parser

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/core/types.ts`, `src/core/plan/parsePlan.ts`
- Create: `test/fixtures/plans/analytics.md`. This is the 12-task plan from the mockups in the §6 format, with the same dependencies as the Task graph screen. Every task has an `Acceptance:` line. Read-only roles (researcher, code-reviewer, spec-reviewer) may leave `Owns:` empty. Parallel tasks own disjoint paths: T5 `test/contract/**`, T6 `src/api/**, test/api/**`, T7 `src/web/**`. The fixture must pass Task 2's validation as-is.
- Test: `test/core/plan/parsePlan.test.ts`

**Interfaces:**
- Produces (`src/core/types.ts`):
  ```ts
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
  ```
- Produces: `parsePlan(markdown: string): PlanTask[]`

- [ ] **Step 1: Scaffold.** Add `package.json` (`"type": "module"`, scripts `test: vitest run`, `typecheck: tsc --noEmit`) and `tsconfig.json` (strict, `module`/`moduleResolution` `NodeNext`, target ES2022). Run `npm i -D typescript vitest tsx @types/node` and `npm i better-sqlite3 picomatch`, plus `npm i -D @types/better-sqlite3 @types/picomatch`. Ignore `node_modules/`, `dist/`, `*.db`.

- [ ] **Step 2: Write failing tests** in `test/core/plan/parsePlan.test.ts`:
  ```ts
  it('parses the analytics fixture into 12 tasks', () => {
    const tasks = parsePlan(read('analytics.md'));
    expect(tasks.map(t => t.key)).toEqual(['T1','T2','T3','T4','T5','T6','T7','T8','T9','T10','T11','T12']);
    const t6 = tasks[5];
    expect(t6).toMatchObject({ title: 'API endpoints (test-first)', dependsOn: ['T3','T4'], agent: 'implementer', owns: ['src/api/**','test/api/**'], estimate: 1 });
    expect(t6.acceptance).toContain('contract tests');
  });
  it('parses CRLF plans identically', () => {
    const md = read('analytics.md');
    expect(parsePlan(md.replace(/\n/g, '\r\n'))).toEqual(parsePlan(md));
  });
  it('treats none/dash/empty/missing as no dependencies', () => {
    for (const v of ['none', 'None', '-', '—', '']) expect(parsePlan(`### Task 1: A\nDepends on: ${v}\nAgent: qa\n`)[0].dependsOn).toEqual([]);
    expect(parsePlan('### Task 1: A\nAgent: qa\n')[0].dependsOn).toEqual([]);
  });
  it('normalises dependency ids', () => {
    expect(parsePlan('### Task 2: B\nDepends on: t1,  Task 3 ,T4\nAgent: qa\n')[0].dependsOn).toEqual(['T1','T3','T4']);
  });
  it('reads Estimate as a number and ignores non-task headings', () => {
    const t = parsePlan('# Plan\n## Context\ntext\n### Task 1: A\nAgent: qa\nEstimate: 3\n');
    expect(t).toHaveLength(1); expect(t[0].estimate).toBe(3);
  });
  ```

- [ ] **Step 3: Run** `npx vitest run test/core/plan/parsePlan.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 4: Implement `parsePlan(markdown: string): PlanTask[]`.** Normalise `\r\n` → `\n`. Split on lines matching `/^###\s+Task\s+(\d+)\s*:\s*(.+?)\s*$/i`; each section runs until the next `##`/`###` heading. Field lines match `/^(Depends on|Agent|Owns|Acceptance|Estimate)\s*:\s*(.*)$/i`. List fields split on commas. A dependency token keeps only its digits → `T<n>`; the tokens `none`, `-`, `—` and empty become an empty list. Field lines are removed from `body`. Unknown or missing values stay raw or empty; validation is Task 2's job.

- [ ] **Step 5: Run** the tests again. Expected: PASS. Run `npm run typecheck`. Expected: no errors.

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(core): scaffold project and plan parser"`

---

### Task 2: Plan validation

**Files:**
- Create: `src/core/plan/validatePlan.ts`
- Test: `test/core/plan/validatePlan.test.ts`

**Interfaces:**
- Consumes: `PlanTask`, `AGENT_ROLES` (Task 1); `ancestors(tasks, key)` (Task 3). Implement Task 3 first, or put a local reachability helper here and switch to Task 3's version when it lands.
- Produces:
  ```ts
  export type PlanErrorCode = 'empty-plan'|'duplicate-key'|'unknown-dependency'|'self-dependency'|'cycle'|'unknown-agent'|'missing-acceptance'|'ownership-overlap';
  export interface PlanError { code: PlanErrorCode; taskKeys: string[]; message: string }
  export function validatePlan(tasks: PlanTask[]): PlanError[]   // [] means valid
  ```

- [ ] **Step 1: Write failing tests.**
  ```ts
  it('accepts the analytics fixture', () => expect(validatePlan(parsePlan(read('analytics.md')))).toEqual([]));
  it('reports duplicate keys and empty plans', () => {
    expect(validatePlan([]).map(e => e.code)).toEqual(['empty-plan']);
    expect(codes(plan('### Task 1: A\nAgent: qa\nAcceptance: x\n### Task 1: B\nAgent: qa\nAcceptance: y\n'))).toContain('duplicate-key');
  });
  it('reports unknown and self dependencies', () => { /* T1 depends on T9 → unknown-dependency [T1]; T1 depends on T1 → self-dependency */ });
  it('reports a cycle naming every task in it', () => {
    const e = validatePlan(plan(cycleOf('T1','T2','T3'))).find(e => e.code === 'cycle')!;
    expect(new Set(e.taskKeys)).toEqual(new Set(['T1','T2','T3']));
  });
  it('reports unknown agents and missing acceptance', () => { /* Agent: wizard → unknown-agent; no Acceptance line → missing-acceptance */ });
  it('flags parent/child glob overlap only for parallel tasks', () => {
    // T1 owns src/**, T2 owns src/api/**, no deps between them → ownership-overlap [T1,T2]
    // the same plus T2 depends on T1 → no error
    // T1 owns src/a.ts, T2 owns src/*.ts, parallel → overlap
    // T1 owns src/api/**, T2 owns src/ui/**, parallel → no error
  });
  ```
  Write each commented case as its own `expect`. The helpers `plan`, `codes` and `cycleOf` live in the test file.

- [ ] **Step 2: Run** `npx vitest run test/core/plan/validatePlan.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `validatePlan`.** If the plan is empty, return only `empty-plan`. Otherwise run every check and collect all errors, ordered by code as listed in `PlanErrorCode`, then by first task key. Find cycles with Tarjan's SCC: each component of size > 1 is one `cycle` error. Two tasks are **parallel** if neither is an ancestor of the other. Two glob patterns overlap if either one matches the other's **static prefix** (the part before the first `*?[{`), or one static prefix is a path-segment prefix of the other. Use `picomatch(pattern)(prefix)` with forward slashes; convert `\` to `/` first.

- [ ] **Step 4: Run** the tests. Expected: PASS.

- [ ] **Step 5: Commit.** `git commit -am "feat(core): validate plans (deps, cycles, roles, ownership)"`. Add the new files first.

---

### Task 3: Dependency graph — waves and critical path

**Files:**
- Create: `src/core/plan/graph.ts`
- Test: `test/core/plan/graph.test.ts`

**Interfaces:**
- Consumes: `PlanTask` (Task 1). Inputs are assumed valid (Task 2).
- Produces:
  ```ts
  export interface PlanGraph {
    depth: Record<string, number>;     // roots = 1
    waves: string[][];                  // waves[i] = keys with depth i+1, in key order
    criticalPath: string[];             // root → sink
    children: Record<string, string[]>;
  }
  export function buildGraph(tasks: PlanTask[]): PlanGraph
  export function ancestors(tasks: PlanTask[], key: string): Set<string>
  export function descendants(tasks: PlanTask[], key: string): Set<string>
  ```

- [ ] **Step 1: Write failing tests** against the analytics fixture, using the spec and mockup values:
  ```ts
  const g = buildGraph(parsePlan(read('analytics.md')));
  expect(g.waves).toEqual([['T1','T2'],['T3','T4'],['T5','T6','T7'],['T8','T9','T10'],['T11'],['T12']]);
  expect(g.criticalPath).toEqual(['T1','T3','T6','T8','T11','T12']);
  expect([...ancestors(tasks,'T8')].sort()).toEqual(['T1','T2','T3','T4','T6','T7']);
  expect([...descendants(tasks,'T4')].sort()).toEqual(['T10','T12','T6','T8','T9','T11'].sort());
  // estimates: a heavier side branch becomes the critical path
  ```
  Add `tie-breaks to the lower key` (without estimates, T6 and T7 tie as T8's longest predecessor, and so do T3 and T4 for T6; the expected path above already encodes picking T6 and T3). Add `estimates change the critical path`: with `Estimate: 5` on T7, expect `['T1','T3','T7','T8','T11','T12']` (sum 10, against 6 via T6 and 9 via T2).

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement.** Depth = 1 + the largest depth among dependencies, computed in topological order (Kahn). Critical path = the path with the largest summed `estimate`, found by DP over the topological order. Ties go to the predecessor with the lower numeric key, so the result is deterministic. Wave keys are sorted by number (`T2` before `T10`).

- [ ] **Step 4: Run.** Expected: PASS. If Task 2 used a local reachability helper, switch it to `ancestors` now and re-run the Task 2 tests.

- [ ] **Step 5: Commit.** `feat(core): plan graph waves and critical path`

---

### Task 4: Task state machine

**Files:**
- Create: `src/core/state/taskMachine.ts`
- Test: `test/core/state/taskMachine.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type TaskState = 'waiting'|'ready'|'running'|'needs_you'|'done'|'failed'|'cancelled';
  export type TaskEvent = 'deps_met'|'start'|'needs_user'|'answered'|'complete'|'fail'|'cancel'|'retry';
  export class InvalidTransition extends Error { constructor(public from: string, public event: string) }
  export function nextTaskState(from: TaskState, event: TaskEvent): TaskState  // throws InvalidTransition
  export const TERMINAL_TASK_STATES: ReadonlySet<TaskState>  // done, cancelled
  ```

- [ ] **Step 1: Write failing tests**, table-driven over this exact transition table:

  | from | event | to |
  |---|---|---|
  | waiting | deps_met | ready |
  | ready | start | running |
  | running | needs_user | needs_you |
  | needs_you | answered | running |
  | running | complete | done |
  | running, needs_you | fail | failed |
  | failed | retry | waiting |
  | waiting, ready, running, needs_you | cancel | cancelled |

  Tests: `follows every row of the table`, `allows cancel from every non-terminal state`, `rejects transitions out of terminal states` (every event from `done`/`cancelled` throws `InvalidTransition`), and `rejects start from waiting`.

- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** as a lookup table `Record<TaskState, Partial<Record<TaskEvent, TaskState>>>`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(core): task state machine`

---

### Task 5: Mission state machine

**Files:**
- Create: `src/core/state/missionMachine.ts`
- Test: `test/core/state/missionMachine.test.ts`

**Interfaces:**
- Consumes: `InvalidTransition` (Task 4).
- Produces:
  ```ts
  export type MissionState = 'draft'|'understanding'|'planning'|'awaiting_approval'|'running'|'paused'|'finishing'|'done'|'stopped'|'failed';
  export type MissionEvent = 'start'|'start_quick'|'understood'|'plan_submitted'|'approve'|'replan'|'pause'|'resume'|'all_tasks_done'|'merged'|'stop'|'fail';
  export function nextMissionState(from: MissionState, event: MissionEvent): MissionState
  ```
  **Note (deviation from the spec diagram, intentional):** "Needs you" is not a mission state. It is derived from open inbox entries (Plan 2), so a mission can be both `running` and have something waiting on you.

- [ ] **Step 1: Write failing table-driven tests:**

  | from | event | to |
  |---|---|---|
  | draft | start | understanding |
  | draft | start_quick | planning |
  | understanding | understood | planning |
  | planning | plan_submitted | awaiting_approval |
  | awaiting_approval | approve | running |
  | awaiting_approval, running | replan | planning |
  | running | pause | paused |
  | paused | resume | running |
  | running | all_tasks_done | finishing |
  | finishing | merged | done |
  | any non-terminal | stop | stopped |
  | any non-terminal | fail | failed |

  Terminal states: `done`, `stopped`, `failed`. Every event from them throws.

- [ ] **Step 2: Run.** Expected: FAIL. **Step 3:** implement as a table. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(core): mission state machine`

---

### Task 6: Scheduler

**Files:**
- Create: `src/core/scheduler/scheduler.ts`
- Test: `test/core/scheduler/scheduler.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ReadyTask { id: string; missionId: string; onCriticalPath: boolean; readyAt: number }
  export interface SchedulerInput {
    ready: ReadyTask[];
    runningByMission: Record<string, number>;
    maxParallelByMission: Record<string, number>;  // clamp to 1..8, default 3 when missing
    globalMax: number;                              // default 6
    throttledUntil: number | null;
    now: number;
  }
  export function pickTasksToStart(input: SchedulerInput): string[]
  export function nextBackoffMs(previousMs: number | null): number
  export const DEFAULT_MISSION_PARALLEL = 3, DEFAULT_GLOBAL_PARALLEL = 6;
  ```

- [ ] **Step 1: Write failing tests:**
  - `starts critical-path tasks first, then oldest ready`
  - `respects per-mission and global limits` (mission A limit 3 with 2 running and 4 ready → 1 start; global 6 with 5 running → 1 start in total)
  - `returns nothing while throttled` (`throttledUntil > now` → `[]`; `throttledUntil <= now` → normal)
  - `clamps mission limits to 1..8 and defaults to 3`
  - `backoff doubles from 1 minute and caps at 30`: `nextBackoffMs(null) === 60_000`, then 120_000, 240_000, 480_000, 960_000, then `1_800_000` and staying there.
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3:** implement (sort, then fill per-mission and global capacity greedily). **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(core): scheduler and rate-limit backoff`

---

### Task 7: SQLite store

**Files:**
- Create: `src/store/schema.sql`, `src/store/db.ts`, `src/store/repos.ts`
- Test: `test/store/repos.test.ts`

**Interfaces:**
- Consumes: `PlanTask`, `TaskState`, `MissionState`, `nextTaskState`, `nextMissionState`.
- Produces:
  ```ts
  export function openDb(file: string): Database        // ':memory:' in tests; runs schema.sql; WAL mode
  export const projects: { add(db, {name, path}): Project; list(db): Project[] }
  export const missions: { create(db, m: NewMission): Mission; get(db, id): Mission | undefined; transition(db, id, ev: MissionEvent): Mission }
  export const tasks: { insertPlan(db, missionId, planVersionId, planTasks: PlanTask[], graph: PlanGraph): Task[];
                        transition(db, id, ev: TaskEvent): Task; listByMission(db, missionId): Task[];
                        addUsage(db, id, tokensIn: number, tokensOut: number): void }
  export const inbox:  { add(db, e: NewInboxEntry): InboxEntry; answer(db, id, answer: unknown): InboxEntry;
                         listOpen(db, now: number): InboxEntry[] }   // excludes answered and snoozed_until > now
  export const events: { append(db, e: NewEvent): void; list(db, missionId, opts?: {taskId?: string; limit?: number}): EventRow[] }
  ```
  Tables and columns are exactly as in spec §10. IDs are `crypto.randomUUID()`. JSON columns are stored as text and parsed in repos. `inbox.kind` is one of `question|plan_approval|permission|review_decision|merge_decision`.

- [ ] **Step 1: Write failing tests:**
  - `creates the schema and round-trips a project and mission`
  - `insertPlan stores depth and on_critical_path from the graph` (analytics fixture: T6 depth 3, critical; T7 not critical)
  - `transition goes through the state machine` (invalid → throws `InvalidTransition`, row unchanged)
  - `addUsage accumulates tokens`
  - `listOpen hides answered and snoozed entries`
  - `has no cost columns` (`PRAGMA table_info(tasks)` has no column matching `/cost/i`)
- [ ] **Step 2: Run.** Expected: FAIL. **Step 3:** implement. Wrap each `transition` in a transaction: read, call `next*State`, update, and append an `events` row `{type: 'state', data: {from, to, event}}`. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5: Commit.** `feat(store): sqlite schema and repositories`

---

## Spikes

Each spike answers one question from spec §15. The scripts under `spikes/` are throwaway code. They are not imported by `src/`, and they have no tests. The deliverable is a findings file at `docs/superpowers/spikes/<date>-<id>.md` with these exact sections: **Question**, **What I ran** (commands), **Observed** (raw excerpts), **Decision for Plan 2**, **Fallback needed?** Spikes use real Claude usage, so keep prompts tiny. Use a scratch repo at `%TEMP%\maestro-spike-repo` with one file, never a real project.

### Task 8: Spike R5 — Windows process control

**Files:** `spikes/r5-windows/run.ts`, `docs/superpowers/spikes/2026-10-28-r5-windows.md`

- [ ] **Step 1:** Write `run.ts`. It starts `claude -p "count to 50 slowly, one number per line" --output-format stream-json --verbose` with `child_process.spawn` (`shell: false`; find `claude.cmd` versus `claude.exe` with `where claude`). It logs the PIDs of the process and its children.
- [ ] **Step 2:** Try to stop it gracefully: `child.kill('SIGINT')`, writing an interrupt control message to stdin (if R2 already found the format), and `taskkill /PID <pid> /T` without `/F`. Record which one ends the turn cleanly with a final `result` event.
- [ ] **Step 3:** Try a hard kill: `taskkill /PID <pid> /T /F`. Confirm no orphan `node`/`claude` processes remain (`tasklist | findstr claude`).
- [ ] **Step 4:** Run in a worktree path longer than 200 characters. Record whether git or claude fails. Record whether `git config core.longpaths true` is needed.
- [ ] **Step 5:** Write the findings. The **Decision** must name the exact stop and kill calls the session runner will use.
- [ ] **Step 6: Commit** `spikes/r5-windows` and the findings file. Message: `docs(spike): R5 windows process control`.

### Task 9: Spike R2 + R4 — stream-json input, interrupts, usage data

**Files:** `spikes/r2-stream/run.ts`, `docs/superpowers/spikes/2026-10-28-r2-stream.md`

- [ ] **Step 1:** Start `claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages`. Write the first user message as one JSON line, `{"type":"user","message":{"role":"user","content":"List the files here, then wait."},"parent_tool_use_id":null}`, and save every output line to `out.jsonl`.
- [ ] **Step 2:** While it runs, write a second user message ("Now count the lines in each file."). Record whether it is queued, answered in the same session, and echoed.
- [ ] **Step 3:** Test an interrupt mid-tool-call (whatever R5 found works). Then resume with `--resume <session_id>` from the `system/init` event. Record whether the context survives.
- [ ] **Step 4 (R4):** From `out.jsonl`, record the full shape of the `result` event (`usage`, `modelUsage`) and look for any `rate_limits` / usage-window field in any event. Record what exists. The **Decision** must say whether Home can show "5-hr usage left" in v1. If it can't, Home shows "tokens today" instead.
- [ ] **Step 5:** Write the findings. The **Decision** must give the exact JSON shapes the parser in Plan 2 will handle: `system/init`, `assistant`, `user`, `result`, `api_retry`, plus the input message shape.
- [ ] **Step 6: Commit.** `docs(spike): R2/R4 stream-json input and usage`

### Task 10: Spike R3 — permission routing

**Files:** `spikes/r3-permissions/*`, `docs/superpowers/spikes/2026-10-28-r3-permissions.md`

- [ ] **Step 1:** Option A. Write a `PermissionRequest` hook script in the scratch repo's `.claude/settings.json` that appends the request to `perm.log` and holds until a file `allow.flag` exists, then allows the call. Run a `-p` session that wants `Bash(npm --version)` without it being in `--allowedTools`. Record whether the hook fires, whether the session waits, and how long it can wait before timing out.
- [ ] **Step 2:** Option B. Build a tiny stdio MCP server exposing `approve` and use `--permission-prompt-tool mcp__spike__approve`. Record the input it receives and the exact response format that allows or denies the call.
- [ ] **Step 3:** Write the findings. The **Decision** picks A or B for Plan 2 and states its exact payload and response formats.
- [ ] **Step 4: Commit.** `docs(spike): R3 permission routing`

### Task 11: Spike R1 + R6 — conductor uses `dispatch_task`; long blocking tool calls

**Files:** `spikes/r1-conductor/bridge.ts`, `spikes/r1-conductor/conductor.md`, `spikes/r1-conductor/sample-plan.md`, `docs/superpowers/spikes/2026-10-28-r1-conductor.md`

- [ ] **Step 1:** Write `bridge.ts`, a stdio MCP server (`@modelcontextprotocol/sdk`) with:
  - `dispatch_task({task_id, agent, prompt, depends_on, owns})`: logs the call and returns `{task_ref}`;
  - `wait_for_tasks({task_refs, mode})`: sleeps a configurable time (default 5 s), then returns `{status: 'done', handoff: 'stub'}` for each task;
  - `ask_user({question})`: returns `"yes"`.

  Every call is logged to `calls.jsonl`.
- [ ] **Step 2:** Write `conductor.md` with the rules from spec §7.1, and `sample-plan.md`: 3 tasks in the §6 format, where T3 depends on T1 and T2.
- [ ] **Step 3:** Run the conductor 5 times: `claude -p "Execute sample-plan.md using superpowers:subagent-driven-development" --mcp-config bridge.json --append-system-prompt-file conductor.md --output-format stream-json --verbose`. For each run, count `dispatch_task` calls versus built-in `Task` tool uses (the latter from the stream). Record whether T1 and T2 were dispatched before T3 was waited on.
- [ ] **Step 4 (R6):** Set the `wait_for_tasks` sleep to 10 minutes, then 30 minutes. Record whether the call survives or times out, and the timeout error text.
- [ ] **Step 5:** Write the findings. Go if `dispatch_task` is used in at least 5 of 5 runs, after at most one prompt revision. Otherwise the **Decision** adopts the spec's fallback (observe the built-in subagents through SubagentStart/SubagentStop hooks). For R6, state whether `wait_for_tasks` blocks for real or returns "still running" every N minutes, and give N.
- [ ] **Step 6: Commit.** `docs(spike): R1/R6 conductor bridge`

---

## After this plan

- Plan 2 (session runner, stream parser, bridge, worktree manager, inbox, recovery, fake CLI) is written from the spike decisions.
- Plan 3 (React UI for the 7 screens) is written after Plan 2's API is fixed.
