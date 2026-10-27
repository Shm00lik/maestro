# Maestro — Design Spec

- **Date:** 2026-10-28
- **Status:** Draft, waiting for review
- **Mockups:** [Maestro UI Concepts v2](https://claude.ai/artifact/MkiLHvsCJoP6ZphxbWFkFA) (7 screens)

## 1. Summary

Maestro is a local mission-control app that runs on top of Claude Code. You describe a **mission**. A **conductor** Claude session runs the superpowers workflow for it: understand, plan, build, finish. Every subagent the conductor sends out becomes a visible **task**: its own Claude Code session in its own git worktree. Maestro shows how the tasks depend on each other, runs independent tasks in parallel, sends every question to one inbox, and merges the results.

Maestro does no AI work itself. It is an orchestrator and a window onto Claude Code.

### Goals
1. Turn one brief into a plan built for that mission, with tasks that depend on each other, without the user choosing the steps.
2. Run independent tasks in parallel, each isolated in its own worktree.
3. Make every task visible and controllable: watch it, message it, pause it, retry it, stop it.
4. Put everything that needs the user (questions, approvals, permission requests) in one inbox.
5. Use real development practice by default: test-first building, independent reviews, verification with evidence.

### Non-goals (v1)
- No users, accounts, hosting or remote access. Single user, one Windows machine.
- No AI calls of Maestro's own. All model work goes through the `claude` CLI.
- No custom `maestro:*` skills. The existing superpowers and engineering skills are used.
- No driving the Claude Desktop app. It has no automation interface.
- No cross-machine sync, no mobile UI, no team sharing.

## 2. Terms

| Term | Meaning |
|---|---|
| **Project** | A local folder (normally a git repo) that Maestro has been told about. |
| **Mission** | One user brief in one project. Owns one conductor session, one mission branch, and its tasks. |
| **Conductor** | The long-running Claude Code session that runs the superpowers workflow for a mission. |
| **Task** | One unit of work the conductor sends out. It runs as its own Claude Code session, with its own agent role and its own worktree. |
| **Agent role** | A named setup (model, tools, skills, instructions) a task runs as, e.g. Implementer or Spec reviewer. |
| **Wave** | Tasks with the same dependency depth. Everything in a wave can run at the same time. Used for display only, never for scheduling. |
| **Critical path** | The longest chain of dependent tasks. It sets the earliest possible finish time. |
| **Handoff note** | A short summary a task writes when it finishes. Later tasks read it. |
| **Inbox ("Needs you")** | Every question, approval and permission request waiting for the user, across all missions. |

## 3. Constraints and verified facts

These were checked against the Claude Code docs on 2026-10-27 (research agent, sources in the session):

- **The Desktop app can't be automated.** Maestro must drive the `claude` CLI.
- **Headless mode:** `claude -p` with `--output-format stream-json --input-format stream-json --verbose` streams every event. In streaming input mode the session can receive more user messages while it runs.
- **Useful flags:** `--resume <id>` / `--session-id <uuid>`, `--model`, `--permission-mode`, `--allowedTools`, `--append-system-prompt-file`, `--mcp-config`, `--agents`, `--max-turns`.
- **Plugins load in headless runs.** User and project settings, installed plugins (superpowers) and CLAUDE.md load in `-p` sessions unless `--bare` is passed.
- **Auth:** the Agent SDK docs say third-party products should use API keys, not claude.ai login. **Decision:** Maestro starts the user's own installed `claude` CLI, which is already logged in to their subscription. Maestro never handles credentials. The Agent SDK is out of scope for v1.
- **Usage data:** each session's final `result` event reports token usage and estimated cost. The 5-hour and 7-day usage windows are documented only for the status line; no headless API for them was found (see risk R4).
- **Rate limits:** `api_retry` events with category `rate_limit` show when the account is being throttled.

## 4. Architecture

```
┌──────────────────────── Maestro (one local process) ─────────────────────────┐
│                                                                               │
│  Web UI (React) ◄── WebSocket events ── Core ── SQLite (maestro.db)           │
│        │                                  │                                   │
│        └──── HTTP commands ──────────────►│                                   │
│                                           ├── Mission engine (state machines) │
│                                           ├── Plan parser + graph             │
│                                           ├── Scheduler                       │
│                                           ├── Session runner ──► claude -p (conductor)
│                                           │                  └─► claude -p (task × N)
│                                           ├── Worktree manager ──► git        │
│                                           └── Bridge MCP server ◄── conductor │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Components

Each component has one job and talks to the others through a narrow interface.

| Component | Responsibility | Depends on |
|---|---|---|
| **Web UI** | The screens from the mockups. Read-only view of state, plus commands. | Core HTTP + WebSocket |
| **Core API** | HTTP commands (create mission, approve plan, answer, message task, pause/stop) and a WebSocket event feed. | Mission engine, Store |
| **Mission engine** | Mission and task state machines (§5). Records each change and publishes it as an event. | Store, Scheduler, Session runner |
| **Plan parser + graph** | Turns the conductor's plan markdown into tasks and dependencies. Checks it, computes waves and the critical path. Pure functions. | — |
| **Scheduler** | Decides which ready tasks start, respecting the parallel limit and rate-limit backoff. Pure decision logic plus a tick loop. | Mission engine |
| **Session runner** | Starts and supervises `claude` processes, parses their stream-json output into typed events, writes user messages to their input, handles interrupt and kill. | OS processes |
| **Worktree manager** | Creates and removes worktrees and branches, and merges task branches into the mission branch. | git CLI |
| **Bridge MCP server** | The local tools the conductor calls: `dispatch_task`, `wait_for_tasks`, `ask_user`, `submit_plan`. Maps each call to a Mission engine command. | Mission engine |
| **Store** | SQLite tables (§9) plus the raw event log per session. | — |

### 4.2 Technology (proposed, for review)

- **Language:** Node.js + TypeScript for everything. One process.
- **UI:** React, served by the same process on `127.0.0.1:<port>`, opened in the user's browser. Wrapping it in Electron or Tauri later stays possible.
- **Storage:** SQLite (`better-sqlite3`) in `%APPDATA%\Maestro\maestro.db`. Raw session logs go to `…\Maestro\logs\<session>.jsonl`.
- **MCP:** the official MCP TypeScript SDK, over stdio. Maestro writes a per-mission `bridge.json` MCP config that starts a small stdio helper, which forwards calls to Core over localhost HTTP.
- **Why:** one language end to end, the MCP SDK is first-class in TypeScript, and the mockups are already HTML and React-shaped.

## 5. Lifecycles

### 5.1 Mission states

```
Draft ─► Understanding ─► Planning ─► AwaitingApproval ─► Running ─► Finishing ─► Done
            │  ▲             │  ▲            │   │           │  ▲         │
            ▼  │             ▼  │            │   └─(re-plan)─┘  │         ▼
         NeedsYou         NeedsYou           └──► Planning     Paused   NeedsYou
Any state ─► Stopped (user) │ Failed (conductor exits non-zero and can't be resumed)
```

- **Understanding:** the conductor runs `superpowers:brainstorming`. Its questions go to the inbox through `ask_user`. In Quick depth this step is minimal.
- **Planning:** the conductor runs `superpowers:writing-plans` with the plan-format rule (§6), then calls `submit_plan`.
- **AwaitingApproval:** the Plan review screen. The user can approve, edit tasks, or send a re-plan note, which goes back to the conductor as a user message.
- **Running:** the conductor runs `subagent-driven-development` / `dispatching-parallel-agents`, sending tasks through `dispatch_task`.
- **Finishing:** the conductor runs requesting-code-review, verification-before-completion and finishing-a-development-branch. The merge into the base branch always goes to the user as a `merge_decision` inbox entry.

### 5.2 Task states

`Waiting → Ready → Running → (NeedsYou ⇄ Running) → Done | Failed | Cancelled`

- **Waiting:** some dependency is not Done.
- **Ready:** every dependency is Done, but no parallel slot is free.
- **NeedsYou:** an `ask_user` call or a permission request is open.
- **Failed:** the process exited with an error, or the task reported it couldn't meet its acceptance criteria. The conductor is told and decides: retry, send a Debugger, or re-plan.

## 6. Plan format and graph

The conductor is told to write its plan in the normal superpowers format, plus this header on each task:

```markdown
### Task 6: API endpoints (test-first)
Depends on: T3, T4
Agent: implementer
Owns: src/api/**, test/api/**
Acceptance: all contract tests in test/contract pass; new unit tests pass
```

`submit_plan(path)` hands the plan file to Maestro. The parser:
1. Pulls out the tasks (`id`, title, body, `dependsOn[]`, `agent`, `owns[]` globs, `acceptance`).
2. **Checks** for: unknown dependency IDs, cycles, unknown agent roles, and parallel tasks (no dependency path between them) whose `owns` globs overlap. Any error goes back to the conductor as the tool result, and it fixes the plan. The user never sees an invalid plan.
3. Computes `depth` (longest path from a root) to group tasks into **waves**, and the **critical path** (longest chain). Each task counts as 1 unless the plan gives an estimate.

The approved plan is a snapshot. Re-plans create a new plan version, and tasks that are already Done stay Done.

## 7. Conductor and bridge

### 7.1 Conductor session
```
claude -p "<mission brief + settings>" --model opus
  --mcp-config <mission>/bridge.json
  --append-system-prompt-file <maestro>/prompts/conductor.md
  --output-format stream-json --input-format stream-json --verbose
  --permission-mode default
cwd = <project root>
```
`conductor.md` tells it to:
- use the superpowers workflow;
- use the plan format in §6;
- call `ask_user` for every question to the user;
- **call `dispatch_task` wherever a skill says to start a subagent, and never use the built-in Task tool to implement anything** (read-only search subagents are allowed);
- make sure every task ends with a handoff note.

### 7.2 Bridge tools

| Tool | Input | Result |
|---|---|---|
| `submit_plan` | `{ plan_path }` | `{ ok, errors[] }` — `ok` moves the mission to AwaitingApproval. The tool call blocks until the user approves or sends a re-plan note, and returns that decision. |
| `dispatch_task` | `{ task_id, agent, prompt, depends_on[], owns[] }` (`task_id` from the plan, or a new ad-hoc ID) | `{ task_ref }` straight away. The task goes Waiting or Ready. |
| `wait_for_tasks` | `{ task_refs[], mode: "all" \| "any" }` | Blocks until done. Returns each task's status, handoff note, branch, and test evidence summary. |
| `ask_user` | `{ question, options[]?, context?, blocking: bool }` | Blocks when `blocking` is true. Returns the user's answer. |

Review passes from subagent-driven-development (spec review, then code review) are dispatched as tasks with agent `spec-reviewer` / `code-reviewer`, depending on the implementation task they review. They appear in the graph the same way.

## 8. Task execution

### 8.1 Starting a task
```
claude -p "<task prompt + upstream handoff notes + acceptance criteria>"
  --model <role.model>
  --allowedTools <role.tools>
  --append-system-prompt-file <maestro>/agents/<role>.md
  --output-format stream-json --input-format stream-json --verbose
  --permission-mode acceptEdits
cwd = <project>/.claude/worktrees/<mission-slug>-<task-id>
```
- **Worktree and branch:** `maestro/<mission-slug>/<task-id>`, branched from the **mission branch** `maestro/<mission-slug>` at its current tip. Upstream work is already merged into the mission branch when a dependent task starts.
- **Agent role files:** `<maestro>/agents/*.md`, one per role from screen 7: researcher, architect, designer, implementer, test-author, debugger, spec-reviewer, code-reviewer, qa. Each names its model, tools and the skills to use. These ship with Maestro and the user can edit them.
- **When a task finishes:** Maestro reads the handoff note (the final `## Handoff` section of the last assistant message), records the `result` event's usage, and merges the task branch into the mission branch with `git merge --no-ff`. If the merge conflicts, the merge is aborted, the task is marked Failed (reason: conflict), and the conductor decides, usually by sending a task to resolve it.

### 8.2 Scheduling
- A task becomes Ready when every dependency is Done. Ready tasks start oldest first, critical-path tasks first.
- The **parallel limit** is per mission (default 3, range 1–8), plus a global limit (default 6) across all missions.
- **Rate limits:** on an `api_retry` / `rate_limit` event, the scheduler pauses new starts globally for a backoff that grows exponentially (1, 2, 4… minutes, capped at 30). Running sessions are left alone. The Home screen shows "Throttled — resuming in N min".

### 8.3 Talking to running sessions
- **Messages from the user** (the "Message this task" box, inbox answers that are not `ask_user` replies) are written to the session's input as stream-json user messages.
- **Pause:** stop scheduling new tasks for the mission. Running tasks continue unless the user picks "Pause now", which interrupts them (SIGINT). They are resumed later with `--resume`.
- **Stop:** interrupt, then kill after 10 s, and mark Cancelled. Worktrees are kept until the user cleans them up.

## 9. Permissions and the inbox

- **Task sessions** run in `acceptEdits` inside their own worktree. Any other tool call that needs approval is sent to Maestro (through a `PermissionRequest` hook or `--permission-prompt-tool`, see R3). It shows up in the inbox as "T6 wants to run `npm install pg`" with Allow once / Always allow for this mission / Deny.
- **Inbox entries** are typed: `question`, `plan_approval`, `permission`, `review_decision`, `merge_decision`. Each one links to its mission and task. Answering one resumes the waiting session. Snooze hides an entry for 1 hour.
- **The Home screen** sorts the inbox by age, with critical-path items first, because those block the finish.

## 10. Data model (SQLite)

```
projects(id, name, path, created_at, last_used_at)
missions(id, project_id, title, brief, state, depth, base_branch, mission_branch,
         isolation, max_parallel, conductor_session_id, settings_json, created_at, ended_at)
plan_versions(id, mission_id, version, plan_path, plan_md, approved_at)
tasks(id, mission_id, plan_version_id, task_key, title, agent, prompt, state,
      depends_on_json, owns_json, acceptance, depth, on_critical_path,
      session_id, worktree_path, branch, handoff_md, failure_reason,
      started_at, ended_at, tokens_in, tokens_out)
inbox(id, mission_id, task_id NULL, kind, payload_json, state, answer_json,
      created_at, answered_at, snoozed_until)
sessions(id, mission_id, task_id NULL, role, claude_session_id, pid, state,
         log_path, started_at, ended_at)
events(id, mission_id, task_id NULL, ts, type, data_json)   -- what the UI's activity log reads
```

## 11. Screens (from the mockups)

| # | Screen | Shows / does |
|---|---|---|
| 1 | **Home** | Inbox first; running missions with a per-task progress bar and each mission's own outline; recently finished missions; usage. |
| 2 | **New mission** | Project cards, brief, optional "always require" constraints, planning depth, models, base branch, isolation, parallel limit, when to stop and ask. |
| 3 | **Plan review** | Tasks grouped by wave; the mission's outline; why this shape; quality gates; the conductor's questions; re-plan note; approve. |
| 4 | **Task graph** | Dependency graph with live status; click to trace what a task waits for and unblocks; critical-path toggle. |
| 5 | **Mission live** | Wave view with live status; selected task's activity / tests / changes / handoff; message box; pause and stop. |
| 6 | **Tasks board** | Every task across missions in Waiting / Ready / Running / Needs you / Done columns; filters; "only what needs me". |
| 7 | **Team & skills** | Agent roles and their skills; edit role files. |

The Stats page is out of scope for v1. Basic numbers (tasks in flight, average parallelism, tokens per mission) appear on Home. The New mission screen drops the "before merging" checkbox, since merging always asks.

## 12. Error handling and recovery

| Failure | Behaviour |
|---|---|
| A task process exits with an error | Task → Failed with the last 50 log lines. The conductor sees it in `wait_for_tasks` and decides (retry, debugger, re-plan). |
| A task makes no progress for N minutes (default 20 with no events) | Inbox entry: "T6 seems stuck", with Interrupt / Keep waiting. |
| The conductor exits unexpectedly | Restart with `--resume <conductor_session_id>` once. If that fails, the mission → Failed. The tasks and worktrees are kept for manual recovery. |
| Maestro restarts | On boot, Running sessions whose PID is gone are resumed with `--resume`. Tasks are never restarted from scratch silently. |
| A merge conflict into the mission branch | See §8.1. |
| An invalid plan | Errors are returned to the conductor through `submit_plan`, never shown to the user as a broken plan. |
| `claude` CLI missing or logged out | Blocking banner with the exact command to fix it (`npm i -g @anthropic-ai/claude-code`, `claude` to log in). |
| Disk or worktree errors | Task → Failed with reason. The worktree path is shown so the user can inspect it. |

## 13. Security and safety

- The HTTP server binds to `127.0.0.1` only, with a random per-run token required on every request. The Bridge helper gets the token through an environment variable.
- Maestro never reads, stores or sends credentials. Auth is whatever the user's `claude` CLI already has.
- Task sessions are limited to their worktree (cwd) and their role's tool list. Anything outside is a permission request to the user.
- Merging into the user's **base** branch only happens when the user clicks Merge. There is no automatic merge in v1.

## 14. Testing strategy

- **Unit:** plan parser (valid plans, cycles, overlapping ownership, unknown roles), wave and critical-path maths, scheduler decisions, state-machine transitions. Pure functions, written test-first.
- **Integration with a fake CLI:** a `fake-claude` script that replays recorded stream-json transcripts, including a question, a permission request, a rate-limit retry and a failure. It covers the session runner, the bridge, inbox round trips and recovery without spending usage.
- **Contract tests for the bridge:** each MCP tool's schema and blocking behaviour.
- **End-to-end:** one scripted real run against a tiny sample repo (a 3-task mission), run by hand before releases because it uses real usage.
- **UI:** component tests for the graph and the inbox, and Playwright smoke tests over the fake CLI.

## 15. Risks and spikes (do first)

| # | Risk | Spike to settle it |
|---|---|---|
| R1 | The conductor uses the built-in Task tool instead of `dispatch_task`. | Run subagent-driven-development on a sample plan with `conductor.md`; measure how often it complies. Fallback: let it use Task and observe the subagents through SubagentStart/Stop hooks, shown as tasks without worktrees. |
| R2 | The exact stream-json input format for follow-up messages to a `-p` session. | Send a mid-run message and an interrupt; record the wire format. |
| R3 | Routing permission prompts from headless sessions to Maestro. | Try a `PermissionRequest` hook versus `--permission-prompt-tool` pointing at a Bridge tool. |
| R4 | No headless source for the 5-hour / 7-day usage window. | Check whether `-p` sessions expose `rate_limits` anywhere; otherwise show only Maestro's own usage totals and throttle events. |
| R5 | Windows process control: SIGINT equivalents, killing process trees, long paths in worktrees. | Spike the session runner on Windows first. |
| R6 | Blocking MCP tool calls (`wait_for_tasks`, `submit_plan`) may time out after hours. | Test long blocking calls. Fallback: return "still running" every N minutes and let the conductor call again. |

## 16. Build order (for the implementation plan)

1. Spikes R1, R2, R3, R5. Go or no-go on the conductor bridge.
2. Session runner, stream-json parser, fake CLI.
3. Store, mission and task state machines.
4. Plan parser and graph.
5. Bridge MCP server, conductor prompt.
6. Worktree manager and scheduler.
7. Inbox and permissions.
8. UI: Home, New mission, Plan review, Mission live.
9. UI: Task graph, Tasks board, Team & skills.
10. Recovery, throttling, polish.

## 17. Decisions (answered 2026-10-28)

1. **App shell:** a local web page (Node + TypeScript + React on `127.0.0.1`, opened in the browser). A desktop window can wrap it later.
2. **Final merge into the base branch:** always ask the user first. Maestro shows the summary and diff, and merges only when the user clicks Merge.
3. **Usage display:** tokens only, per task and per mission. No dollar estimates anywhere in the UI.
