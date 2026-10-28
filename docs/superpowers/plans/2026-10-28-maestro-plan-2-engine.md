# Maestro Plan 2 — Engine (sessions, bridge, worktrees, inbox) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Maestro run a real mission end to end from the command line. A conductor plans the mission, and Maestro runs the dispatched tasks as live `claude.exe` sessions in worktrees, with permissions, questions, stop and crash recovery, all through an inbox.

**Architecture:** This plan adds three groups of modules:
- **Claude I/O** (`src/claude/**`): a pure stream protocol plus a session wrapper around `claude.exe`.
- **Engine** (`src/engine/**`): the task runner, inbox, throttle, mission engine and recovery. They use the Plan 1 core and store.
- **Bridge** (`src/bridge/**`): an MCP stdio helper that forwards tool calls to a token-protected localhost endpoint in the engine.

It also adds a git worktree manager (`src/git/**`) and a CLI driver (`src/cli/**`). Everything except Task 1 and Task 14 is tested against a `fake-claude` script, so tests never spend usage.

**Tech Stack:** Node ≥22 (dev: 25), TypeScript 7 (ESM, NodeNext), Vitest 4, better-sqlite3 13, @modelcontextprotocol/sdk 1.x (moved to `dependencies`), picomatch, tsx (to run the CLI and fake-claude).

**Spec:** `docs/superpowers/specs/2026-10-28-maestro-design.md` (v2). Exact wire shapes are in `docs/superpowers/spikes/2026-10-28-{r1-conductor,r2-stream,r3-permissions,r5-windows}.md`. The executor reads these, not this plan, for the JSON shapes.

## Global Constraints

- Windows 11 is first-class. Spawn `claude.exe` with `shell:false, windowsHide:true`. Never use `child.kill()` or SIGINT on a claude process. Kill with `taskkill /PID <pid> /T /F`.
- Every session uses `-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --permission-prompt-tool stdio`, with env `MCP_TOOL_TIMEOUT=86400000`.
- Interrupt with the stdin `control_request` `{subtype:"interrupt"}`. Fallback: force-kill after **5 s** with no `result`.
- The bridge tool descriptions are copied **verbatim** from `spikes/r1-conductor/bridge.ts`. `prompts/conductor.md` starts as a copy of `spikes/r1-conductor/conductor.md`.
- Task keys: `T<n>` for plan tasks; ad-hoc keys match `^[A-Za-z0-9-]{1,24}$`. Sort them with `compareTaskKeys`.
- Worktree paths must stay **< 200 characters**, with a hashed folder name as the fallback. Set `core.longpaths=true` only in the project repo, never globally.
- Usage is tokens only. Drop `total_cost_usd`/`costUSD` at the parser.
- Merging into the base branch happens only on the user's Merge answer. Mission endings are `merged` | `kept`.
- "Always allow" is mission-scoped: tool name plus an exact Bash command prefix. Never reply with `permission_suggestions`.
- Parallel limits: 3 per mission (1–8), 6 global. Throttle until `resetsAt`, falling back to 1→30 min backoff.
- The bridge HTTP endpoint binds `127.0.0.1` only and requires a random per-run token header (`x-maestro-token`).
- Conventional Commits. Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Claude sends an event type, subtype or key Maestro has never seen.** It must be logged and ignored, never crash a session. Test: Task 2, `ignores unknown types, subtypes and extra keys`.
2. **The user answers a permission or question after its task was cancelled, or its process died.** The answer must be rejected as expired, and nothing is written to a dead stdin. Test: Task 9, `rejects answers to expired entries without touching the session`.
3. **The user double-clicks Stop, or stops while a permission request is pending.** Maestro must send exactly one interrupt and one kill at most, with no "write after end" errors, and the pending entry expires. Test: Task 10, `stop is idempotent and expires pending permissions`.
4. **Maestro restarts mid-mission.** No task restarts from scratch: live sessions are resumed with `--resume`, and tasks whose session can't be resumed are marked failed with a reason. Test: Task 13, `resumes running tasks after restart and never re-dispatches done ones`.
5. **The project path contains spaces or non-ASCII characters** (e.g. `C:\Users\Yoav Levy\Projets été`). Spawn, cwd, worktree and merge must all work. Tests: Task 4 `spawns in a cwd with spaces and accents`, Task 8 `creates and merges worktrees under a path with spaces`.

---

## File Structure

```
src/claude/exe.ts            resolveClaudeExe(): path to claude.exe (R5 order)
src/claude/processTree.ts    killTree(pid), listTreePids(pid)
src/claude/protocol.ts       parseEvent(line) → StreamEvent; encode* for stdin messages (pure)
src/claude/session.ts        ClaudeSession: spawn, events, send, interrupt, answerPermission, close, kill
src/git/worktrees.ts         worktree/branch create, merge, remove; path guard
src/engine/inbox.ts          inbox + permission rules; routes answers to sessions
src/engine/throttle.ts       rate_limit_event → throttledUntil; usage window cache
src/engine/taskRunner.ts     one task's session lifecycle
src/engine/missionEngine.ts  conductor session, bridge handlers, scheduling loop, finishing
src/engine/recovery.ts       restart recovery, stuck detection
src/bridge/tools.ts          tool names, schemas, VERBATIM descriptions
src/bridge/http.ts           localhost endpoint (token) → engine handlers
src/bridge/stdio.ts          MCP stdio helper (entry point spawned by claude via bridge.json)
src/cli/maestro.ts           `maestro run` CLI driver
prompts/conductor.md         copied from spikes/r1-conductor/conductor.md
agents/<role>.md             9 role files (model, denied tools, skills, handoff rules)
test/fake-claude/fake-claude.ts + test/fixtures/stream/*.jsonl + test/fixtures/scenarios/*.json
docs/superpowers/spikes/2026-10-28-r7-r9.md   Task 1 findings
```

---

### Task 1: Spike R7–R9 (verify before building)

**Files:** `spikes/r7-r9/run.ts`, `docs/superpowers/spikes/2026-10-28-r7-r9.md`

This is a spike, run like Plan 1's spikes: throwaway code, a scratch repo at `%TEMP%\maestro-spike-repo`, `--model haiku`, ≤ 6 invocations. The findings doc has the sections Question / What I ran / Observed (verbatim, run-labelled) / Decision for Plan 2 / Fallback needed?

- [ ] **Step 1 (R7):** Run `--permission-mode acceptEdits --disallowedTools "Edit,Write,NotebookEdit"` and ask it to edit a file. Record whether the edit is blocked. If it isn't, try `--tools` with an explicit list, and record that too.
- [ ] **Step 2 (R8):** In one long-lived stream-json process, run two turns. Compare `result.usage`/`modelUsage` across them to see whether they are cumulative or per-turn. Record both `result` lines.
- [ ] **Step 3 (R9):** Run `--permission-mode acceptEdits --permission-prompt-tool stdio` and trigger a Bash permission. Then, while that request is pending, send the interrupt `control_request`. Record what arrives: does the pending request get cancelled, or does a `result` arrive?
- [ ] **Step 4:** Write the Decision. For each of R7/R8/R9, state the exact behaviour Tasks 8–10 must implement. Commit with message `docs(spike): R7-R9 tool restriction, usage, acceptEdits+stdio`.

The controller rules on the Decision and passes it into Tasks 2, 9 and 10.

---

### Task 2: Stream protocol (pure) + recorded fixtures

**Files:** Create `src/claude/protocol.ts`, `test/fixtures/stream/{init,assistant,user-echo,user-tool,result-ok,result-interrupted,control-response,can-use-tool,rate-limit,unknown}.jsonl`. Test: `test/claude/protocol.test.ts`.

**Interfaces — Produces:**
```ts
export type StreamEvent =
  | { kind: 'init'; sessionId: string; model: string; cwd: string; tools: string[]; permissionMode: string; cliVersion?: string }
  | { kind: 'assistant'; text: string; toolUses: { id: string; name: string; input: unknown }[]; parentToolUseId: string | null }
  | { kind: 'user-echo'; text: string }
  | { kind: 'tool-result'; toolUseId: string; isError: boolean }
  | { kind: 'interrupt-marker' }
  | { kind: 'result'; ok: boolean; subtype: string; terminalReason: string | null; text: string | null; sessionId: string; usage: TokenUsage }
  | { kind: 'permission-request'; requestId: string; toolName: string; input: unknown; toolUseId: string; description: string | null }
  | { kind: 'control-response'; requestId: string; ok: boolean }
  | { kind: 'rate-limit'; status: string; resetsAt: number | null; fiveHour: UsageWindow | null; sevenDay: UsageWindow | null }
  | { kind: 'unknown'; type: string; subtype: string | null };
export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface UsageWindow { utilization: number; resetsAt: number }
export function parseEvent(line: string): StreamEvent | null   // null for blank/invalid JSON
export function encodeUserMessage(text: string): string        // one JSON line + '\n'
export function encodeInterrupt(requestId: string): string
export function encodePermissionAllow(requestId: string, input: unknown): string
export function encodePermissionDeny(requestId: string, message: string): string
export function lastHandoff(text: string): string | null       // body of the last "## Handoff" section
```

- [ ] **Step 1: Write the fixtures.** Copy the canonical lines from the r2/r3 spike docs into the fixture files. Fill elided values with plausible ones and keep every key.
- [ ] **Step 2: Write failing tests.**
  - `parses every fixture into its kind`. The init fixture gives `sessionId`. `result-interrupted` gives `ok:false, terminalReason:'aborted_tools'`. `rate-limit` gives `fiveHour.utilization === 0.48`.
  - `drops cost fields`: `JSON.stringify(parseEvent(resultOk))` does not match `/cost/i`.
  - `ignores unknown types, subtypes and extra keys`. The `unknown` fixture becomes `{kind:'unknown'}`. A `system` event with `subtype:'hook_started'` becomes `unknown`. Extra keys never throw.
  - `returns null for blank or invalid lines`.
  - `encodes stdin messages exactly as the spikes recorded` (deep-equal after `JSON.parse`, and the line ends with `\n`).
  - `lastHandoff finds the last ## Handoff section and ignores one inside a code fence`.
- [ ] **Step 3: Run** `npx vitest run test/claude/protocol.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement.** Dispatch on `type`, then `subtype`. The R8 decision from Task 1 sets the usage semantics; `usage` is read from `result.usage`.
- [ ] **Step 5: Run.** Expected: PASS. Then commit: `feat(claude): stream-json protocol`.

---

### Task 3: fake-claude

**Files:** Create `test/fake-claude/fake-claude.ts`, `test/fixtures/scenarios/*.json`. Test: `test/fake-claude/fake-claude.test.ts`.

**Interfaces — Produces:**
- Run it as `node --import tsx test/fake-claude/fake-claude.ts <claude args…>`.
- The env var `FAKE_CLAUDE_SCENARIO=<path to scenario json>` selects the script.
- A scenario is `{ steps: Step[] }`, where `Step` is one of:
  - `{emit: object}`
  - `{waitFor: 'user'|'interrupt'|'permission-answer'|'stdin-close', timeoutMs?}`
  - `{sleepMs}`
  - `{spawnChild: 'ping'}` (starts a long-running child process, so tree kills can be tested)
  - `{exit: code}`
- `--resume <id>` is honoured: it emits `init` with that session id.
- Every received stdin line is appended to `FAKE_CLAUDE_LOG` as JSONL.

- [ ] **Step 1:** Write the failing tests. They spawn the fake with scenarios and assert:
  - `emits init then result`
  - `echoes a user message with isReplay`
  - `answers an interrupt with control_response then an aborted_tools result`
  - `blocks on a can_use_tool request until the answer arrives`
  - `exits 0 when stdin closes while idle`
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run. Expected: PASS. **Step 5:** Commit: `test: fake-claude scenario player`.

---

### Task 4: claude.exe resolution and process-tree kill

**Files:** Create `src/claude/exe.ts`, `src/claude/processTree.ts`. Test: `test/claude/exe.test.ts`, `test/claude/processTree.test.ts`.

**Interfaces — Produces:**
```ts
export function resolveClaudeExe(opts?: { override?: string; whereOutput?: (cmd: string) => string[]; readFile?: (p: string) => string; exists?: (p: string) => boolean }): string
export class ClaudeNotFound extends Error {}
export function killTree(pid: number): { ok: boolean; output: string }      // spawnSync('taskkill',['/PID',pid,'/T','/F'])
export function listTreePids(pid: number): number[]                        // CIM query; root + descendants
```
- The env var `MAESTRO_CLAUDE_EXE` overrides the lookup. `MAESTRO_CLAUDE_EXE_ARGS` is a JSON array of arguments prepended before the claude args.
- Tests set `MAESTRO_CLAUDE_EXE=process.execPath` and `MAESTRO_CLAUDE_EXE_ARGS=["--import","tsx","test/fake-claude/fake-claude.ts"]` to run fake-claude.
- Add `export function resolveClaudeCommand(): { exe: string; prefixArgs: string[] }`, which wraps `resolveClaudeExe` and reads both env vars.

- [ ] **Step 1:** Write the failing tests.
  - `reads the exe path from the claude.cmd shim with %dp0% substituted`. The shim text comes from the R5 doc's excerpt.
  - `falls back to where claude.exe`.
  - `throws ClaudeNotFound with an install hint`.
  - `honours the override`.
  - `killTree kills a spawned process tree with no survivors`. Spawn `cmd /c ping -n 60 127.0.0.1`; after the kill, `listTreePids` of the old root is empty.
  - `spawns in a cwd with spaces and accents`. Create `%TEMP%\maestro test\été\` and spawn the fake there. The fake's `init.cwd` equals that path.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS. **Step 5:** Commit: `feat(claude): exe resolution and tree kill`.

---

### Task 5: ClaudeSession

**Files:** Create `src/claude/session.ts`. Test: `test/claude/session.test.ts` (uses fake-claude).

**Interfaces — Consumes:** Task 2 (`parseEvent`, `encode*`), Task 4 (`resolveClaudeExe`, `killTree`, `listTreePids`). **Produces:**
```ts
export interface SessionOptions { args: string[]; cwd: string; env?: Record<string,string>; logPath: string; command?: { exe: string; prefixArgs: string[] } }   // default: resolveClaudeCommand()
export type SessionStatus = 'starting' | 'busy' | 'idle' | 'exited';
export class ClaudeSession extends EventEmitter {   // events: 'event'(StreamEvent), 'exit'({code, killed}), 'error'(Error)
  static start(opts: SessionOptions): ClaudeSession
  readonly pid: number; status: SessionStatus; sessionId: string | null
  send(text: string): void                                   // throws SessionClosed if exited
  stop(timeoutMs = 5000): Promise<'exited' | 'killed'>   // spec §8.3 Stop; one in-flight stop, repeats await the same promise
  answerPermission(requestId: string, decision: { allow: true; input: unknown } | { allow: false; message: string }): void
  close(): void                                              // end stdin when idle
  kill(): Promise<void>                                      // killTree + await exit; idempotent
}
export class SessionClosed extends Error {}
```
Behaviour:
- Base args are prepended: the Global Constraints session flags plus `MCP_TOOL_TIMEOUT`.
- Raw stdout lines are appended to `logPath`.
- `status` becomes `busy` on send and `idle` on `result`.
- `stop` follows spec §8.3: snapshot the tree; if busy, write one interrupt and wait ≤ timeoutMs for `result`; end stdin and wait ≤ timeoutMs for exit; else killTree; then kill any snapshot PID still alive. No pause, no keep-alive after interrupt (pause dropped from v1).

- [ ] **Step 1:** Write the failing tests:
  - `emits parsed events and records sessionId from init`
  - `send while exited throws SessionClosed`
  - `stop on a busy session interrupts, closes stdin and resolves exited`
  - `stop falls back to kill after timeout` (the scenario ignores the interrupt and stdin end; short timeout)
  - `concurrent stops send one control_request` (check `FAKE_CLAUDE_LOG` count === 1)
  - `stop kills a tool child left behind`
  - `kill is idempotent`
  - `answerPermission writes the exact control_response`
- [ ] **Step 2–4:** RED, implement, GREEN. **Step 5:** Commit: `feat(claude): ClaudeSession`.

---

### Task 6: State machines v2

**Files:** Modify `src/core/state/taskMachine.ts`, `src/core/state/missionMachine.ts` and their tests.

**Interfaces — Produces:**
- `TaskState` adds `'planned'`.
- `TaskEvent` adds `'dispatch'`.
- `MissionEvent` replaces `'all_tasks_done'` with `'finish_requested'`, and adds `'kept'`.
- Add `export type MissionOutcome = 'merged' | 'kept'`.

- [ ] **Step 1:** Update the table-driven tests to the exact tables in spec §5.1 and §5.2. This includes `planned —dispatch→ waiting`, `cancel` from every non-terminal state including `planned`, and NO pause/resume/interrupted (dropped from v1; remove `pause`/`resume`/`paused` from the mission machine too), `running —finish_requested→ finishing`, and `finishing —kept→ done`. Keep the exhaustive complement test and the inherited-key tests.
- [ ] **Step 2–4:** RED, implement, GREEN. **Step 5:** Commit: `feat(core): state machines v2`.

---

### Task 7: Store migration 2 and repos

**Files:** Modify `src/store/db.ts` (append migration 2), `src/store/repos.ts`. Test: `test/store/repos.v2.test.ts`.

**Interfaces — Consumes:** Task 6 states. **Produces:**
- **Migration 2** implements spec §10:
  - **missions:** add `outcome`.
  - **tasks:**
    - add `plan_body`, `dispatched_at`, `tokens_cache_read` and `tokens_cache_write`;
    - make `plan_version_id` NULLable;
    - replace `UNIQUE(plan_version_id, task_key)` with `UNIQUE(mission_id, task_key)`;
    - widen the state CHECK for the new states.
  - **inbox:** add `request_id`, and widen the state CHECK to `open | answered | expired`.
  - **projects:** a unique normalised path.
  - **new tables:** `permission_rules` and `usage_window`.
  - SQLite can't alter CHECKs, so the affected tables are rebuilt in the migration.
- New and changed repo functions:
```ts
tasks.insertPlan(db, missionId, planVersionId, planTasks, graph): Task[]        // now inserts state 'planned', plan_body = body
tasks.applyReplan(db, missionId, planVersionId, planTasks, graph): { cancelled: string[]; runningUnplanned: string[] }  // spec §6 re-plan rules
tasks.dispatch(db, missionId, d: { key: string; agent: string; prompt: string; dependsOn: string[]; owns: string[] }): { task: Task; created: boolean }
tasks.getByKey(db, missionId, key): Task | undefined
tasks.setRuntime(db, id, r: Partial<{ sessionId: string; worktreePath: string; branch: string; handoffMd: string; failureReason: string }>): void
tasks.addUsage(db, id, u: TokenUsage): void                                     // replaces (in, out) signature
missions.setOutcome(db, id, outcome: MissionOutcome): void
missions.setConductorSession(db, id, sessionId: string): void
inbox.add(db, e: NewInboxEntry & { requestId?: string }): InboxEntry
inbox.expireForTask(db, taskId): InboxEntry[]                                   // open → expired
inbox.answer(...)                                                               // also throws Expired (new) for expired entries
permissionRules.add(db, { missionId, toolName, inputPrefix }): void; permissionRules.match(db, missionId, toolName, input: unknown): boolean
sessions.start(db, s): SessionRow; sessions.end(db, id, state): void; sessions.listLive(db): SessionRow[]
usageWindow.save(db, w: { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null; seenAt: number }): void; usageWindow.get(db)
inbox.openCountForTask(db, taskId): number
export interface SessionRow { id: string; missionId: string; taskId: string | null; role: string; claudeSessionId: string | null; pid: number | null; state: 'live' | 'ended' | 'failed'; logPath: string; startedAt: number; endedAt: number | null }
```
- `permissionRules.match` rules:
  - For Bash, the tool name must match and `input.command` must start with `inputPrefix`.
  - For other tools, the tool name must match and `inputPrefix` must be `''`.

- [ ] **Step 1:** Write the failing tests:
  - `migrates a version-1 db to version 2 keeping rows`. Open with only migration 1, insert data, re-open, and check the rows are intact and `user_version` is 2.
  - `dispatch moves a planned task to waiting and creates ad-hoc tasks`
  - `dispatch of an existing non-failed task returns created:false`
  - `applyReplan keeps done tasks, updates planned ones, cancels removed ones, reports running ones`
  - `expired entries cannot be answered`
  - `permission rules match by tool and exact command prefix`
  - `usage accumulates all four token kinds`
  - `project paths are unique after normalisation` (`C:\X\` and `c:/x` collide)
- [ ] **Step 2–4:** RED, implement, GREEN. Re-run the Plan 1 store tests, which must still pass after updating them for the `planned` start state. **Step 5:** Commit: `feat(store): migration 2 and v2 repos`.

---

### Task 8: Worktree manager

**Files:** Create `src/git/worktrees.ts`. Test: `test/git/worktrees.test.ts` (real git in temp repos).

**Interfaces — Produces:**
```ts
export const MAX_WORKTREE_PATH = 200;
export function worktreeDirFor(projectRoot: string, missionId: string, key: string): string   // <root>/.claude/worktrees/<mission8>-<key>, or <mission8>-<sha1(key)[0..8]> if too long
export async function ensureMissionBranch(projectRoot: string, baseBranch: string, missionBranch: string): Promise<void>
export async function createTaskWorktree(projectRoot: string, missionBranch: string, taskBranch: string, dir: string): Promise<void>   // also sets core.longpaths=true locally once
export async function mergeTaskBranch(projectRoot: string, missionBranch: string, taskBranch: string, message: string): Promise<{ ok: true; commit: string } | { ok: false; reason: 'conflict'; files: string[] }>   // --no-ff; aborts on conflict
export async function branchCommits(projectRoot: string, base: string, branch: string): Promise<string[]>
export async function removeWorktree(projectRoot: string, dir: string): Promise<void>
```
Merges run in a dedicated integration worktree for the mission branch, so the user's own checkout is never switched.

- [ ] **Step 1:** Write the failing tests:
  - `uses a hashed folder when the path would exceed 200 chars`
  - `creates a task worktree on its own branch from the mission branch`
  - `merges a task branch with --no-ff and returns the commit`
  - `reports conflicts and leaves the mission branch unchanged`
  - `never changes the user's checked-out branch`
  - `creates and merges worktrees under a path with spaces`
  - `sets core.longpaths only in the repo config`
- [ ] **Step 2–4:** RED, implement (`git` via `execFile`, no shell), GREEN. **Step 5:** Commit: `feat(git): worktree manager`.

---

### Task 9: Inbox and permissions service

**Files:** Create `src/engine/inbox.ts`. Test: `test/engine/inbox.test.ts`.

**Interfaces — Consumes:** Task 5 (`ClaudeSession.answerPermission`, `send`), Task 7 repos. **Produces:**
```ts
export interface SessionRegistry { get(sessionRowId: string): ClaudeSession | undefined }
export class InboxService extends EventEmitter {   // events: 'changed'
  constructor(db: Db, sessions: SessionRegistry)
  onPermissionRequest(missionId: string, taskId: string | null, sessionRowId: string, ev: Extract<StreamEvent,{kind:'permission-request'}>): void   // auto-allow by rule, else inbox entry
  ask(missionId: string, taskId: string | null, question: string, options?: string[]): Promise<string>   // resolves when answered; rejects with Expired
  answerPermission(entryId: string, a: { allow: true; always?: boolean } | { allow: false; message?: string }): void
  answerQuestion(entryId: string, answer: string): void            // must be one of options when options exist
  expireForTask(taskId: string): void                              // also rejects pending ask() promises
}
```

- [ ] **Step 1:** Write the failing tests (fake sessions record calls):
  - `auto-allows a request that matches a mission rule without an inbox entry`
  - `creates a permission entry and answers the session exactly once`
  - `always-allow stores the first two whitespace-separated words of a Bash command as the prefix (one word if the command has only one)`: `npm install pg` gives `npm install`; `ls` gives `ls`. Non-Bash tools store prefix `''`.
  - `ask resolves with the answer and rejects non-option answers`
  - `rejects answers to expired entries without touching the session`
- [ ] **Step 2–4:** RED, implement, GREEN. **Step 5:** Commit: `feat(engine): inbox and permissions`.

---

### Task 10: Task runner

**Files:** Create `src/engine/taskRunner.ts`, `agents/*.md` (9 roles). Test: `test/engine/taskRunner.test.ts` (fake-claude + temp git repo).

**Interfaces — Consumes:** Tasks 5, 7, 8, 9; `agents/<role>.md` front matter `{ model, denied_tools }`. **Produces:**
```ts
export interface TaskRunnerDeps { db: Db; inbox: InboxService; projectRoot: string; missionBranch: string; bridgeAskConfig: (taskId: string) => string; logDir: string; exe?: string }
export class TaskRunner extends EventEmitter {   // events: 'state'(Task), 'finished'({ taskId, outcome: 'done'|'failed', reason? })
  constructor(deps: TaskRunnerDeps)
  start(taskId: string, upstreamHandoffs: { key: string; handoff: string }[]): Promise<void>
  message(taskId: string, text: string): void
  resumeAfterCrash(taskId: string): Promise<void>   // used by recovery only: new process with --resume <sessionId>
  stop(taskId: string): Promise<void>       // interrupt → close → kill; 'cancelled'; expires inbox
}
export function buildTaskArgs(role: RoleConfig, prompt: string, bridgeConfigPath: string, resumeSessionId?: string): string[]
export interface RoleConfig { name: AgentRole; model: 'opus' | 'sonnet' | 'haiku'; deniedTools: string[]; body: string }   // parsed from agents/<role>.md front matter + body
export function loadRole(name: AgentRole, dir?: string): RoleConfig
```
Behaviour:
- **Worktree:** created via Task 8.
- **Prompt:** the dispatched prompt, plus upstream handoffs, plus acceptance criteria, plus the instruction to end with `## Handoff` (listing what was made, decisions, and test evidence).
- **Args:** the role's model and `--disallowedTools` (per the Task 1 R7 decision). Permission requests go to `InboxService`.
- **Usage:** `result.usage` is added per the R8 decision.
- **Completion** follows spec §8.1: one reminder for a missing handoff, then the task fails with `no-handoff`. A successful merge sets `done`; a conflict sets `failed:conflict`.
- **Stop** follows spec §8.3 (via `ClaudeSession.stop`) and the R9 decision (a cancelled permission request expires its inbox entry).
- **Needs you:** when an inbox entry for the task opens, the task fires `needs_user`. When `inbox.openCountForTask` drops to 0, it fires `answered`. InboxService emits `changed` with `{ taskId }`, and the runner listens.

Add these tests: `opening a permission entry moves the task to needs_you and answering it returns it to running`, and `two open entries need two answers before running`.

- [ ] **Step 1:** Write the failing tests:
  - `runs to done, stores handoff, usage and merge commit`
  - `sends one handoff reminder then fails with no-handoff`
  - `resumeAfterCrash starts a new process with --resume <sessionId>` (check fake-claude's argv log)
  - `stop is idempotent and expires pending permissions`
  - `process crash marks the task failed with the last 50 log lines`
  - `read-only roles get --disallowedTools Edit,Write,NotebookEdit`
- [ ] **Step 2–4:** RED, implement, GREEN. **Step 5:** Commit: `feat(engine): task runner and role files`.

---

### Task 11: Bridge (MCP + localhost endpoint)

**Files:** Create `src/bridge/tools.ts`, `src/bridge/http.ts`, `src/bridge/stdio.ts`. Move `@modelcontextprotocol/sdk` to `dependencies`. Test: `test/bridge/bridge.test.ts`.

**Interfaces — Produces:**
```ts
// tools.ts — names, zod schemas, and DESCRIPTIONS copied verbatim from spikes/r1-conductor/bridge.ts (+ submit_plan, finish_mission written in the same style)
export const CONDUCTOR_TOOLS: ToolDef[]; export const TASK_TOOLS: ToolDef[]   // TASK_TOOLS = [ask_user]
export interface BridgeHandlers {
  submitPlan(missionId: string, planPath: string): Promise<{ errors: PlanError[] } | { approved: true } | { approved: false; note: string }>
  dispatchTask(missionId: string, d: DispatchInput): Promise<{ task_ref: string } | { error: string }>
  waitForTasks(missionId: string, refs: string[], mode: 'all'|'any', onProgress: () => void): Promise<TaskSummary[]>
  askUser(missionId: string, taskId: string | null, q: { question: string; options?: string[]; context?: string }): Promise<string>
  finishMission(missionId: string, summary: string): Promise<'merge' | 'keep'>
}
export interface ToolDef { name: string; description: string; inputSchema: z.ZodTypeAny }
export interface DispatchInput { task_id: string; agent: string; prompt: string; depends_on: string[]; owns: string[] }
export interface TaskSummary { task_ref: string; key: string; status: 'done' | 'failed' | 'cancelled' | 'running'; handoff: string | null; branch: string | null; commits: string[]; failure_reason: string | null }
export function startBridgeHttp(h: BridgeHandlers): Promise<{ port: number; token: string; close(): Promise<void> }>   // 127.0.0.1, x-maestro-token
export function writeBridgeConfig(dir: string, o: { port: number; token: string; missionId: string; taskId?: string; tools: 'conductor'|'task' }): string   // bridge.json path
```
`stdio.ts`:
- It is the MCP server entry, run by claude with `node --import tsx src/bridge/stdio.ts` (from bridge.json, with env set to port, token, missionId and taskId).
- It forwards each call to the HTTP endpoint.
- While a call is pending it sends `notifications/progress` every 60 s.

- [ ] **Step 1:** Write the failing tests:
  - `tool descriptions match spikes/r1-conductor/bridge.ts verbatim` (read the spike file and compare strings)
  - `rejects requests without the token`
  - `binds 127.0.0.1 only`
  - `forwards a dispatch_task call end to end through a real stdio MCP client` (use the SDK client over stdio)
  - `wait_for_tasks sends progress while blocking` (use a fake timer or a 60 s interval injected as 50 ms)
  - `task bridge exposes only ask_user`
- [ ] **Step 2–4:** RED, implement, GREEN. **Step 5:** Commit: `feat(bridge): MCP tools and localhost endpoint`.

---

### Task 12: Throttle + mission engine

**Files:** Create `src/engine/throttle.ts`, `src/engine/missionEngine.ts`, `prompts/conductor.md`. Test: `test/engine/throttle.test.ts`, `test/engine/missionEngine.test.ts`.

**Interfaces — Consumes:** everything above, plus Plan 1's `parsePlan`, `validatePlan`, `buildGraph` and `pickTasksToStart`. **Produces:**
```ts
// throttle.ts
export class Throttle { onRateLimit(ev, now): void; onRateLimitedWithoutReset(now): void; throttledUntil(now): number | null }
// missionEngine.ts
export class MissionEngine extends EventEmitter implements BridgeHandlers {   // events: 'event'(EventRow), 'inbox'(), 'mission'(Mission)
  constructor(o: { db: Db; logDir: string; exe?: string })
  startMission(m: NewMission & { quick?: boolean }): Promise<Mission>   // mission branch, bridge, conductor session
  approvePlan(missionId: string): void; replan(missionId: string, note: string): void
  stop(missionId: string): Promise<void>
  readonly inbox: InboxService
}
```
Behaviour:
- **Conductor:** started per spec §7.1. Its built-in `Task`/`Agent` tool_use count is recorded as an event (`conductor-subagent-warning`). Its `permission-request` events go to `InboxService.onPermissionRequest` with `taskId: null`.
- **`submitPlan`** runs parse, then validate, then stores a plan version (`insertPlan` / `applyReplan`), then creates a `plan_approval` inbox entry. It blocks until the user approves or re-plans, and is idempotent.
- **`dispatchTask`** validates the ad-hoc key, checks `owns` against running tasks, and calls `tasks.dispatch`.
- **Scheduling loop:** on every state change and on a 1 s tick, it calls `pickTasksToStart` with the throttle and limits, then `TaskRunner.start`.
- **`waitForTasks`** resolves from TaskRunner `finished` events and includes the handoff, branch, commits and test evidence.
- **`finishMission`** fires `finish_requested`, then a `merge_decision` entry. On merge, it merges the mission branch into the base branch in the integration worktree, then fires `merged`. On keep, it fires `kept`. It returns the choice.
- **Usage window:** `rate-limit` events update `Throttle` and `usageWindow.save`.

- [ ] **Step 1:** Write the failing tests:
  - `throttles until resetsAt and falls back to backoff`
  - `submit_plan rejects invalid plans with errors and blocks valid ones until approve`
  - `submit_plan re-call after timeout resumes the same wait`
  - `dispatch_task rejects ownership overlap with a running task`
  - `runs a 3-task mission on fake-claude to finishing and merges on Merge` (conductor scenario: submit_plan → dispatch T1, T2 → wait → dispatch T3 → wait → finish_mission)
  - `keep ends the mission done with outcome kept and base branch untouched`
  - `records a warning when the conductor uses the built-in Task tool`
- [ ] **Step 2–4:** RED, implement, GREEN. **Step 5:** Commit: `feat(engine): mission engine and throttle`.

---

### Task 13: Recovery and stuck detection

**Files:** Create `src/engine/recovery.ts`. Test: `test/engine/recovery.test.ts`.

**Interfaces — Produces:**
```ts
export function recoverOnStartup(engine: MissionEngine, db: Db, isPidAlive: (pid: number) => boolean): Promise<{ resumed: string[]; failed: { taskId: string; reason: string }[] }>
export function checkStuck(db: Db, now: number, stuckAfterMs = 20 * 60_000): string[]   // task ids; engine raises a 'question' inbox entry "T6 seems stuck" with options Stop task / Keep waiting
```

- [ ] **Step 1:** Write the failing tests:
  - `resumes running tasks after restart and never re-dispatches done ones`
  - `marks tasks failed with reason 'unrecoverable' when --resume fails`
  - `resumes the conductor once, then fails the mission`
  - `flags tasks with no events for 20 minutes once`
- [ ] **Step 2–4:** RED, implement, GREEN. **Step 5:** Commit: `feat(engine): recovery and stuck detection`.

---

### Task 14: CLI driver + real end-to-end run

**Files:** Create `src/cli/maestro.ts`, `package.json` script `"maestro": "tsx src/cli/maestro.ts"`, `docs/superpowers/runs/2026-10-28-e2e.md`.

**Interfaces — Produces:**
- `npm run maestro -- run --project <path> --brief <file> [--quick] [--base main] [--parallel 3]`
- **Output:** one line per event (`[T6 running] …`).
- **Interaction:** inbox entries are shown as numbered prompts in the terminal (permission y/n/a, questions with numbered options, plan approval y/replan-note, merge/keep).
- **Exit codes:** 0 on done; 1 on stopped or failed. Ctrl+C stops the mission cleanly through `engine.stop`.

- [ ] **Step 1:** Write a failing test, `cli runs the fake 3-task mission with scripted answers` (stdin-driven, using fake-claude via `MAESTRO_CLAUDE_EXE`).
- [ ] **Step 2–4:** RED, implement, GREEN. Commit: `feat(cli): maestro run`.
- [ ] **Step 5: Real run (uses real usage).** Run on a scratch copy of a tiny repo: a brief with 3 small tasks (two independent, one depending on both) and `--parallel 2`. Record in `docs/superpowers/runs/2026-10-28-e2e.md`:
  - every inbox prompt;
  - the dispatch/wait order;
  - the conductor's Task/Agent count (the R1 re-check with real handoffs: GO only if it is 0);
  - the final merge result and token totals.

  Commit: `docs: first real end-to-end mission`.

---

## After this plan
Plan 3 covers the HTTP/WebSocket API over `MissionEngine` and the React UI for the 7 screens.
