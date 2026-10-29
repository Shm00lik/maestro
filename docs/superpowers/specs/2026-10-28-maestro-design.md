# Maestro — Design Spec

- **Date:** 2026-10-28 · **v2:** 2026-10-28, updated with what the Plan 1 spikes found
- **Status:** v1 approved. v2's product decisions were answered by the user on 2026-10-28 (§17). The technical changes are waiting for the user's later review.
- **Mockups:** [Maestro UI Concepts v2](https://claude.ai/artifact/MkiLHvsCJoP6ZphxbWFkFA) (7 screens)
- **Evidence:** `docs/superpowers/spikes/2026-10-28-{r1-conductor,r2-stream,r3-permissions,r5-windows}.md`

## What changed in v2
- **Talking to Claude (§3, §8):** Maestro drives one long-lived `claude.exe` per session over stream-json. It interrupts through a stdin control message, with a forced kill of the process tree as the fallback. SIGINT is gone (on Windows it orphans child processes).
- **Permissions (§9):** permission requests now go through `--permission-prompt-tool stdio`, not hooks or an MCP tool.
- **Usage (§3, §11):** the 5-hour and 7-day usage windows are available from `rate_limit_event`, so Home shows "5-hr usage left".
- **Rate limits (§8.2):** throttling uses `resetsAt` from that event. Backoff is only the fallback.
- **New task states (§5.2):** `planned` (in the plan, not dispatched yet). (Pause was dropped from v1.)
- **Mission endings and new tool (§5.1, §7.2):** a mission can now finish without merging, and there is a new bridge tool, `finish_mission`.
- **Ad-hoc tasks (§6):** task keys are no longer only `T<n>`. The conductor creates tasks such as `T1-review`.
- **Tool lists (§3, §8.1):** read-only roles get an explicit `--tools` allow-list plus `--strict-mcp-config`, because `--allowedTools` did not restrict tools (R7).
- **Data model (§10):** schema migrations, constraints, cache-token columns, inbox `expired` state, and mission-scoped "always allow" rules.
- **Risks (§15):** R1–R8 are resolved; R9–R11 are new or open.
- **Synced with the Plan 2 implementation (§17 technical calls 10–16):** there is no auto-approve mode; a mission can end with Keep branch; `finish_mission` is refused while dispatched tasks are active (blocked tasks excepted); leftovers a task did not commit are auto-committed and the files listed; usage comes from `model_usage_since_last_result`, else `usage`; "always allow" applies to task sessions only.

## 1. Summary

Maestro is a local mission-control app that runs on top of Claude Code. You describe a **mission**. A **conductor** Claude session runs the superpowers workflow for it: understand, plan, build, finish. Every subagent the conductor sends out becomes a visible **task**: its own Claude Code session in its own git worktree. Maestro shows how the tasks depend on each other, runs independent tasks in parallel, sends every question to one inbox, and merges the results.

Maestro does no AI work itself. It is an orchestrator and a window onto Claude Code.

### Goals
1. Turn one brief into a plan built for that mission, with tasks that depend on each other, without the user choosing the steps.
2. Run independent tasks in parallel, each isolated in its own worktree.
3. Make every task visible and controllable: watch it, message it, retry it, stop it.
4. Put everything that needs the user (questions, approvals, permission requests) in one inbox.
5. Use real development practice by default: test-first building, independent reviews, verification with evidence.

### Non-goals (v1)
- No users, accounts, hosting or remote access. Single user, one Windows machine.
- No AI calls of Maestro's own. All model work goes through the `claude` CLI.
- No custom `maestro:*` skills. The existing superpowers and engineering skills are used.
- No driving the Claude Desktop app. It has no automation interface.
- No cross-machine sync, mobile UI or team sharing.

## 2. Terms

| Term | Meaning |
|---|---|
| **Project** | A local folder (normally a git repo) that Maestro has been told about. |
| **Mission** | One user brief in one project. Owns one conductor session, one mission branch, and its tasks. |
| **Conductor** | The long-running Claude Code session that runs the superpowers workflow for a mission. |
| **Task** | One unit of work. A *plan task* comes from the approved plan (`T<n>`). An *ad-hoc task* is dispatched by the conductor during the run (e.g. `T1-review`, `final-review`, `T3-fix`). Each runs as its own Claude Code session with its own agent role and worktree. |
| **Task key** | A task's ID within a mission: `T<n>` for plan tasks, or any `[A-Za-z0-9-]{1,24}` for ad-hoc tasks. Keys sort naturally (`T1`, `T1-review`, `T2`, `T10`, `final-review`). |
| **Agent role** | A named setup (model, tools, skills, instructions) a task runs as, e.g. implementer or spec-reviewer. |
| **Wave** | Tasks with the same dependency depth. Everything in a wave can run at the same time. Used for display only, never for scheduling. |
| **Critical path** | The longest chain of dependent tasks. It sets the earliest possible finish time. |
| **Turn** | One request/response cycle inside a session. It ends with a `result` event. A session lives across many turns. |
| **Handoff note** | A `## Handoff` section a task writes at the end. Later tasks and the conductor read it. |
| **Inbox ("Needs you")** | Every question, approval and permission request waiting for the user, across all missions. |

## 3. Constraints and verified facts

Checked against the Claude Code docs (2026-10-27) and in the Plan 1 spikes (claude 2.1.312, superpowers 6.4.2, Windows 11):

- **The Desktop app can't be automated.** Maestro drives the `claude` CLI.
- **Use the native binary, not the npm shim.** Maestro spawns `claude.exe` with `shell:false`. It finds the exe by reading the npm `claude.cmd` shim, then falls back to `where claude.exe`, and fails with a clear message if neither works. Never spawn `claude.cmd` with `shell:false`. (R5)
- **One process per session, kept alive between turns.** Every session uses:
  `-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --permission-prompt-tool stdio`
  - **Messages in:** user messages go to stdin as JSON lines.
  - **Messages out:** events come back as JSON lines on stdout.
  - **One result per turn:** a `result` event ends a turn, not the process.
  - **Follow-ups:** a message sent mid-turn may be folded into the same turn. (R2)
- **Auth:** Maestro starts the user's own logged-in `claude` CLI and never handles credentials. The Agent SDK is out of scope, because its policy asks third-party products to use API keys.
- **Plugins and skills load in headless runs.** User and project settings, installed plugins (superpowers) and CLAUDE.md all load, which `system/init` confirms. (R1)
- **Usage window:** the undocumented `rate_limit_event.rate_limit_info.unifiedWindows.{five_hour,seven_day}` carries `{utilization (0..1), resetsAt, status}`. It is only emitted during turns. (R2/R4)
- **Tool restriction:** `--allowedTools` did **not** stop other tools from running (Glob ran under `--allowedTools Bash`); it only pre-approves. Read-only roles are restricted with an explicit `--tools` allow-list (`Read,Glob,Grep`), and every task session runs with `--strict-mcp-config`, so only Maestro's bridge MCP server loads (R7).
- **Long tool calls:** MCP tool calls can block for 30 min or more. `MCP_TOOL_TIMEOUT` must be set explicitly, because an inherited small value would apply. (R6)

## 4. Architecture

```
┌──────────────────────── Maestro (one local process) ─────────────────────────┐
│  Web UI (React) ◄── WebSocket events ── Core ── SQLite (maestro.db)           │
│        └──── HTTP commands ──────────────►│                                   │
│                                           ├── Mission engine (state machines) │
│                                           ├── Plan parser + graph             │
│                                           ├── Scheduler                       │
│                                           ├── Session runner ──► claude.exe (conductor)
│                                           │                  └─► claude.exe (task × N)
│                                           ├── Worktree manager ──► git        │
│                                           └── Bridge MCP server ◄── sessions  │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Components

| Component | Responsibility | Depends on |
|---|---|---|
| **Web UI** | The screens from the mockups. Read-only view of state, plus commands. | Core HTTP + WebSocket |
| **Core API** | HTTP commands (create mission, approve plan, answer, message task, stop/retry) and a WebSocket event feed. Untrusted input is validated before it reaches the state machines. | Mission engine, Store |
| **Mission engine** | Mission and task state machines (§5). Records each change and publishes it as an event. | Store, Scheduler, Session runner |
| **Plan parser + graph** | Plan markdown → tasks; validation; waves; critical path. Pure functions. *(Built in Plan 1.)* | — |
| **Scheduler** | Picks which dispatched, ready tasks start, within the parallel limits and throttle. Pure. *(Built in Plan 1.)* | — |
| **Stream protocol** | Pure parse and serialise of stream-json events and control messages (§8.4). Tolerates unknown types, subtypes and keys. | — |
| **Session runner** | Spawns and supervises `claude.exe` processes; feeds the stream protocol; sends messages, interrupts and permission answers; kills process trees. | OS, Stream protocol |
| **Worktree manager** | Creates and removes worktrees and branches (with a path-length guard), and merges task branches into the mission branch. | git CLI |
| **Bridge MCP server** | The conductor's tools (`submit_plan`, `dispatch_task`, `wait_for_tasks`, `ask_user`, `finish_mission`) and the task sessions' `ask_user`. Maps each call to a Mission engine command. | Mission engine |
| **Store** | SQLite with versioned migrations (§10) plus raw session logs. *(Built in Plan 1, extended in Plan 2.)* | — |

### 4.2 Technology
- Node.js (≥22; the dev machine runs 25) and TypeScript 7, all in one process. Tests use Vitest 4.
- The UI is React, served on `127.0.0.1:<port>` and opened in the browser (decided 2026-10-28).
- Storage is better-sqlite3 in `%APPDATA%\Maestro\maestro.db`, with migrations through `PRAGMA user_version`. Raw session logs go to `…\Maestro\logs\<session>.jsonl`. The schema SQL ships with any build output.
- MCP uses the official TypeScript SDK over stdio. A per-mission `bridge.json` starts a small stdio helper that forwards calls to Core over localhost HTTP.

## 5. Lifecycles

### 5.1 Mission states

`draft → understanding → planning → awaiting_approval → running → finishing → done`, plus `stopped`, `failed`.

| From | Event | To |
|---|---|---|
| draft | `start` / `start_quick` | understanding / planning |
| understanding | `understood` | planning |
| planning | `plan_submitted` | awaiting_approval |
| awaiting_approval | `approve` | running |
| awaiting_approval, running | `replan` | planning |
| running | `finish_requested` (the conductor called `finish_mission`) | finishing |
| finishing | `merged` | done (outcome `merged`) |
| finishing | `kept` | done (outcome `kept`) — the branch is left for the user (decided by user, 2026-10-28) |
| any non-terminal | `stop` / `fail` | stopped / failed |

- **"Needs you" is not a state.** It is derived from open inbox entries, so a running mission can need the user at the same time.
- **Finishing starts on a signal from the conductor, not when all tasks are done.** The conductor adds ad-hoc review and fix tasks after the plan's tasks complete, so "all plan tasks done" is the wrong trigger.
- **`finish_requested` is refused while dispatched tasks are active** (`waiting`, `ready`, `running`, `needs_you`; blocked tasks excepted, §5.2). The conductor gets a tool error naming them. Never-dispatched `planned` tasks do not block.
- **A failed base merge keeps the mission `finishing`** and asks again with a new merge decision (with the reason, and a conflict notice when files conflict).

### 5.2 Task states

| From | Event | To | Notes |
|---|---|---|---|
| — | plan approved | `planned` | Plan tasks exist but the conductor hasn't dispatched them. |
| planned | `dispatch` | waiting | The conductor called `dispatch_task`. Ad-hoc tasks are created straight into `waiting`. |
| waiting | `deps_met` | ready | Every dependency is `done`. |
| ready | `start` | running | The scheduler gave it a slot. |
| running | `needs_user` / needs_you `answered` | needs_you / running | Entered when the task has ≥1 open inbox entry; left when the last one is answered. |
| running | `complete` | done | Ended with a valid handoff (§8.1). |
| running, needs_you | `fail` | failed | |
| failed | `retry` | waiting | |
| planned, waiting, ready, running, needs_you | `cancel` | cancelled | |

Terminal states are `done` and `cancelled`. `failed` is not terminal, because it can be retried.

**Blocked (derived, not a state):** a `waiting` task with a dependency that is `failed`, `cancelled` or itself blocked. `wait_for_tasks` resolves it with status `blocked` and `failure_reason` `dependency <KEY> <state>`; it is not counted as active by `finish_mission`, and it is cancelled when the mission ends (merged or kept). Retrying the dependency unblocks it.

## 6. Plan format and graph

The conductor is told to write its plan in the normal superpowers format, plus this header on each task:

```markdown
### Task 6: API endpoints (test-first)
Depends on: T3, T4
Agent: implementer
Owns: src/api/**, test/api/**
Acceptance: all contract tests in test/contract pass; new unit tests pass
```

The parser (Plan 1):
- strips a BOM and normalises CRLF;
- ignores headings and field lines inside fenced code;
- accepts `none`, `-`, `—` or an empty value for "no dependencies";
- takes every number in the `Depends on:` value.

Validation returns these errors to the conductor through `submit_plan`, so the user never sees an invalid plan:

| Error | Meaning |
|---|---|
| `empty-plan` | The plan has no tasks. |
| `duplicate-key` | Two tasks share a key. |
| `unknown-dependency` | A task depends on a key that doesn't exist. |
| `self-dependency` | A task depends on itself. |
| `cycle` | Tasks depend on each other in a loop. |
| `unknown-agent` | The agent role isn't one of the defined roles. |
| `missing-acceptance` | A task has no acceptance criteria. |
| `ownership-overlap` | Two parallel tasks own the same files. The check is case-insensitive, ignores `./`, and leans cautious. |

**Waves** come from the longest dependency path. The **critical path** is the longest path by estimate (default 1).

- **Ad-hoc tasks:** `dispatch_task` may create tasks that aren't in the plan, depending on any existing key. Maestro adds them to the graph, recomputes waves and the critical path, and checks their `owns` against the tasks running at that moment. An overlap is returned as a tool error, so the conductor adds a dependency or narrows `owns`.
- **Re-plans:** a re-plan creates a new plan version. Tasks already `done` carry over by key and stay `done`.
  - **Applied on approval.** `submit_plan` validates the plan and pre-checks key conflicts (returned as errors at once), then only creates the approval entry. The plan version is created and the tasks are inserted or updated in one transaction when the user approves. A rejected re-plan changes no task rows.
  - A `planned` task with the same key is updated in place (title, agent, prompt, body, dependencies, plan version). A `waiting` or `ready` task gets the new body, dependencies and plan version, but keeps its dispatched prompt: the prompt is updated only while the task is `planned`.
  - A task whose key is no longer in the plan becomes `cancelled`, unless it is running. A running task is left alone and reported to the conductor. Ad-hoc tasks are never touched by a re-plan.
  - A plan key that matches an ad-hoc task's key or a cancelled task's key is a plan error (`duplicate-key`, "conflicts with an existing task; rename it").
  - Keys are unique per mission **ignoring case** (they name worktree folders, and Windows ignores case), in plans, in conflicts and in `dispatch_task`. The ad-hoc keys `integration` and `*-integration` are reserved (the mission's integration worktree).

## 7. Conductor and bridge

### 7.1 Conductor session
```
claude.exe -p --model opus
  --mcp-config <logDir>/missions/<id>/bridge.json
  --append-system-prompt-file <maestro>/prompts/conductor.md
  --input-format stream-json --output-format stream-json --verbose --replay-user-messages
  --permission-prompt-tool stdio --permission-mode default --allowedTools mcp__maestro__*
cwd = <project root>; env MCP_TOOL_TIMEOUT=86400000
```
- The mission brief and settings are the **first stdin message** (not a `-p` argument). `--allowedTools mcp__maestro__*` only pre-approves the bridge's own tools (as in R1); every other tool still prompts.
- **Plain-text turns become inbox questions.** The user cannot see the conductor's replies, so when the conductor ends a turn (an ok `result`) while the mission is live and none of its bridge calls is pending, its last text (cut to about 2000 characters) becomes one free-text `question` entry (`task_id` NULL; never more than one open). The answer is sent to the conductor as a user message. The CLI also prints the conductor's text as `[conductor] …` lines.
- `prompts/conductor.md` starts from `spikes/r1-conductor/conductor.md`. That is the version that passed 4 of 4 compliance runs.
- The conductor's permission requests go to the inbox like any task's, with `task_id` NULL.
- A built-in `Task`/`Agent` tool_use in the conductor stream is counted and shown in the UI as a warning.

### 7.2 Bridge tools

**The tool descriptions in `spikes/r1-conductor/bridge.ts` are part of the tested design and ship verbatim.** Changing them, or `conductor.md`, requires re-running the 3-run compliance check (R1).

| Tool | Input | Result |
|---|---|---|
| `submit_plan` | `{ plan_path }` | Validation errors right away, or it blocks until the user approves (→ `{approved:true}`) or sends a re-plan note (→ `{approved:false, note}`). **Idempotent:** after a timeout, calling again with the same plan resumes the wait. |
| `dispatch_task` | `{ task_id, agent, prompt, depends_on[], owns[] }` | `{ task_ref }` straight away. A plan task moves from `planned` to `waiting` and uses the dispatched `prompt`; the plan body becomes the task's "Plan" tab. A new ID creates an ad-hoc task. Re-dispatching a task that is not failed returns its existing `task_ref`. |
| `wait_for_tasks` | `{ task_refs[], mode: "all" \| "any" }` | Blocks, sending an MCP progress notification about every 60 s. Returns each task's status, handoff note, branch, commits and test-evidence summary. **Idempotent:** a re-call after a timeout keeps waiting. Tasks keep running regardless. |
| `ask_user` | `{ question, options[]?, context? }` | Blocks until the user answers. With `options`, the answer is always exactly one of them (the UI enforces it). |
| `finish_mission` | `{ summary }` | Moves the mission to `finishing` and creates a `merge_decision` inbox entry (Merge / Keep branch). Returns the user's choice. |

**Task sessions get a bridge with `ask_user` only** (decided by user, 2026-10-28), so a task can ask the user a question directly (→ `needs_you`) instead of failing or guessing. A task bridge's calls to any conductor tool are refused with HTTP 403.

- `wait_for_tasks` returns, per task: `status` (`done`, `failed`, `cancelled`, `running` or `blocked`, §5.2), `handoff`, `branch`, `commits` and `failure_reason` (the failure reason, or `dependency <KEY> <state>` for a blocked task).
- The `dispatch_task`, `wait_for_tasks` and `ask_user` descriptions ship verbatim from the R1 spike (R1); `submit_plan` and `finish_mission` are written in the same style.

## 8. Task execution

### 8.1 Starting and completing a task
```
claude.exe -p --model <role.model> [--tools <role.tools>] [--disallowedTools <role.denied>]
  --append-system-prompt-file <logDir>/missions/<id>/tasks/<key>-<8>.system.md   (the role body)
  --strict-mcp-config --mcp-config <logDir>/tasks/<taskId>/bridge.json
  --input-format stream-json --output-format stream-json --verbose --replay-user-messages
  --permission-prompt-tool stdio --permission-mode <acceptEdits, or default for roles without edit tools>
cwd = <project>/.claude/worktrees/<mission8>-<key>   env MCP_TOOL_TIMEOUT=86400000
```
- **The prompt** (task prompt, upstream handoff notes, acceptance criteria, handoff instructions) is the **first stdin message**, not a `-p` argument.
- **Worktree and branch:** branch `<missionBranch>--<key>`, cut from the mission branch tip. A first run never reuses a branch it did not make: if that name is taken (a leftover), it uses `<missionBranch>--<key>-<task8>`, and fails with a clear reason when both exist. Only a retry (the task already recorded its branch) reuses its branch and worktree.
  - The worktree folder is `<first 8 chars of mission id>-<key>`.
  - Before `git worktree add`, the full path is checked against a 200-character limit. If it is longer, the folder becomes a short hash.
  - `core.longpaths=true` is set in the project repo only. It is never set globally.
- **Roles without edit tools** run with an explicit allow-list (`--tools`, R7) and `--permission-mode default`, because acceptEdits would also auto-approve filesystem shell commands such as mkdir, mv or cp:
  - **researcher:** `Read,Glob,Grep`.
  - **spec-reviewer, code-reviewer:** `Read,Glob,Grep,Bash`, so they can run the project's tests and read git history (decided by user, 2026-10-29). PowerShell is not included: claude used the Bash tool for all shell work on Windows (R5, the 2026-10-29 run), and one shell keeps the surface small. Their role text says to run the tests and never modify files, and their task prompt says not to change, stage or commit any file (other roles are told to commit). Only the reviewer safe list (§9) is auto-allowed for them. Any other command goes to the user. A role without edit tools never gets its leftovers committed (see Completion).
  - Every task runs with `--strict-mcp-config`. If `system/init` lists any tool outside the role's allow-list (for a reviewer, e.g. PowerShell, Edit or Write), or any `mcp__*` tool not from Maestro's bridge, the task fails at once with reason `unsafe-tools: <tools>`.
- **Edit-capable roles** (implementer, test-author, debugger) are told in their role text to create and edit files with the Edit and Write tools (auto-approved in their worktree by acceptEdits), not with shell redirection or heredocs. They are also told to run tests and git as simple commands without pipes, so that the commands stay on the safe list (§9).
- **No repo hooks, no fsmonitor** (security review, 2026-10-29). Every task session's environment and every git command Maestro runs (worktree setup, leftover commits, status checks, merges in the integration worktree and into the base branch, `branchCommits`) get `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` with `core.hooksPath=<maestro>/.maestro-empty-hooks` (an empty folder Maestro owns; git calls refuse to run if it is not empty), `core.fsmonitor=false`, `diff.submodule=short` and `submodule.recurse=false` (inline submodule diffs and recursion run git inside a nested repo under that repo's own config, e.g. a planted `diff.external`). Environment config wins over every config file and reaches the git processes git itself starts (e.g. for submodules). So **the user's repository hooks (pre-commit, commit-msg, post-checkout, post-merge, ...) do not run inside tasks or in Maestro's own git operations**: an agent could change a tracked hook (e.g. `.husky/`) or plant a nested repo whose `.git/config` names any program as its fsmonitor. Maestro's own `git status` calls also pass `--ignore-submodules=all`. Run the project's hooks yourself after merging if you rely on them.
- **Completion.** When a turn ends with `result.subtype = success`:
  1. If the last assistant message has a `## Handoff` section, Maestro closes stdin and waits for the process to exit (else stops it). **It merges only after the exit is confirmed**; if the process cannot be confirmed gone, the task fails with reason `process-did-not-exit` and nothing is merged.
  2. Anything the agent left uncommitted in its worktree is **auto-committed** (`git add -A`, each git command bounded by 60 s); the committed files are listed in the task's `merged` event and the CLI line. Then Maestro merges the task branch into the mission branch with `--no-ff` (in the mission's integration worktree) and the task becomes `done`.
     **Roles without edit tools** (reviewers, researcher) are never auto-committed: if their worktree has changes, Maestro unstages and discards them in that worktree only (`git reset -q`, `git checkout -- .`, `git clean -fd`), records a `read-only-changes-discarded` warning event listing the files (the CLI prints a WARNING line), and the task ends `no-changes` unless it made commits the user approved.
  3. If there is no handoff, Maestro sends one follow-up: "Finish with a ## Handoff section." If that turn also ends without one, the task becomes `failed` with reason `no-handoff`. The reminder (and the failure) apply only to turns Maestro started (the prompt, the reminder, a resume nudge), never to a reply to the user's own message.
  4. **Merge conflict:** the merge is aborted, the task becomes `failed` with reason `conflict`, and the conductor decides what to do.
- **Usage:** recorded per `result`, from `model_usage_since_last_result` when present, else from `usage` (R8), split into input, output, cache-read and cache-write tokens. The parser drops every cost field.

### 8.2 Scheduling
- A dispatched task becomes `ready` once every dependency is `done`. Ready tasks start critical-path first, then oldest first.
- **Parallel limits:** per mission (default 3, range 1–8) plus a global limit (default 6).
- **Throttling:** on a `rate_limit_event` with `status` ≠ `allowed`, new starts pause globally until `resetsAt`. If no `resetsAt` is available, Maestro falls back to exponential backoff of 1, 2, 4 … minutes, capped at 30. Running sessions are left alone. Home shows "Throttled — resuming at HH:MM".

### 8.3 Talking to running sessions
- **Messages:** the user's messages go to the session's stdin as JSON lines. A message sent mid-turn may be answered in the same turn, so Maestro never assumes one `result` per message.
- **No pause in v1** (decided by user, 2026-10-28). Missions and tasks can be stopped, not paused.
- **Stop** ends the session for good:
  1. Maestro snapshots the session's process tree.
  2. If the session is mid-turn, Maestro writes a `control_request` interrupt and waits up to 5 s for the `result`.
  3. Once the snapshot has settled, Maestro closes stdin and waits up to 5 s for the process to exit. If it is still alive, Maestro force-kills the tree (`taskkill /PID <pid> /T /F`).
  4. Maestro kills any process from the snapshot that is still alive, by PID (no `/T`).
  5. The task becomes `cancelled`. Its open inbox entries expire, and its worktree is kept until the user cleans it up.
- **Worktree cleanup** when a mission ends: a done task's folder is removed with plain `git worktree remove` (no `--force`), so git's own check keeps any worktree with modified or untracked files; a refusal is logged and the folder stays.
- **`--resume <session_id>`** is used only for crash recovery (§12). Maestro re-reads `session_id` from `system/init` after every resume.
- **Never use SIGINT or `child.kill()`.** On Windows they kill only the root process and orphan its tool processes (R5).
- **Sessions are not unref'd and are isolated from console Ctrl+C**: on Windows the child runs in its own hidden console (CREATE_NO_WINDOW via `windowsHide` + piped stdio; never `detached`, as DETACHED_PROCESS would give claude's own children visible console windows); on other platforms it gets its own process group. Either way a Ctrl+C in Maestro's terminal reaches Maestro only. Maestro then stops its sessions itself as above.

### 8.4 Stream protocol
- Events are dispatched on `type`, then `subtype`. Unknown types, subtypes and keys are ignored and logged, never fatal.
- **Handled events:** `system/init` (may repeat), `assistant`, `user` (`isReplay` echoes, `tool_result`, interrupt marker), `result`, `control_request/can_use_tool`, `control_response`, `rate_limit_event`.
- **`api_retry`:** optional, because it was never observed.
- The exact shapes are in `docs/superpowers/spikes/2026-10-28-r2-stream.md`. Fixtures recorded from the spikes become the parser's tests and the fake CLI's script.

## 9. Permissions and the inbox

- **Requests:** permission requests arrive as `control_request` with `subtype:"can_use_tool"`, carrying `request_id`, `tool_name`, `input`, `tool_use_id` and `description`. Each becomes a `permission` inbox entry, and the session stays blocked until it is answered.
  - **Allow:** `{"behavior":"allow","updatedInput":<input>}`
  - **Deny:** `{"behavior":"deny","message":"<text>"}`
  - Both go back on stdin as a `control_response` with the same `request_id`. (R3)
- **"Always allow for this mission"** (decided by user, 2026-10-28) stores a rule in Maestro and auto-answers matching requests in that mission. **Task sessions only:** the conductor's requests are never auto-answered and offer only allow once / deny.
  - **Bash and PowerShell:** the rule is the command's first two words, matched as a word prefix. A command with shell operators (`;`, `&`, `|`, `` ` ``, `>`, `$(`, `<(`, `>(`, a newline) never gets a rule and never matches one.
  - **Other tools:** the rule allows any input for that tool.
- **Pre-approved safe list** (decided by user, 2026-10-29; `src/engine/safeCommands.ts`). It is checked first, before rules and before prompting. It covers **task sessions only, never the conductor**, and only the Bash and PowerShell tools. A safe command is allowed exactly as a user's "allow once" would allow it (`updatedInput` = the input). No inbox entry is made, and an `auto-allowed` event `{taskId, command}` is recorded. The CLI prints `[T1] auto-allowed: <command>`. A command is safe only if all of these hold:
  - It is printable ASCII. It has no newline and none of `;` `|` `` ` `` `>` `<` `(` `)` `$` `\` `{` `}`, and no `&` except in the exact separator ` && ` (so no `||`). This holds inside quotes too. Non-ASCII is rejected because PowerShell treats smart quotes and Unicode spaces as syntax.
  - Every ` && `-separated segment matches one entry by whole leading words: `npm test`, `npm run test`, `npm t`, `pnpm test`, `yarn test` (optionally `--silent`, then `-- <args>` without `--watch*`, `-w`, `--ui*` or `--coverage*`, which hang or write files) and `node --test [relative paths]`, **only when the mission opted in to test runs (below)**, and npm/pnpm/yarn only when the task worktree has its own `package.json` (otherwise npm walks up to another project); `git status|diff|log|show [flags, revisions, relative paths]`; `git add <relative paths, -A or -u>`; `git commit [-q -a -s -n -v ...] -m "<message>"` (or `'<message>'`, repeatable); `mkdir [-p] <relative paths>`; `ls [flags] [relative paths]`; `pwd`.
  - No argument is absolute (`/`, `\`, `C:`, `~`), contains `..`, is a glob, or is a git global option (`-C`, `-c`, `--git-dir`, `--work-tree`). No git long option that writes files or runs configured programs (`--output`, `--ext-diff`, `--textconv`, `--no-index` and others, including their abbreviations). No `push`, `pull`, `fetch`, `checkout`, `reset`, `rebase`, `merge`, `branch`, `remote`, `config` or `clean`. Commit flags such as `--amend`, `-F` and `--author`, and add flags such as `-p` and `-f`, are not on the list.
  - **Reviewer scope:** a role whose tool list has no edit tool (Edit, Write, NotebookEdit, MultiEdit), today spec-reviewer and code-reviewer, gets only the test runners, with no `--` arguments at all, and `git status/diff/log/show`. It gets no `git add`, `git commit`, `mkdir`, `ls` or `pwd`. The scope comes from the role's tools, not its name.
  - **The request itself:** the tool input may hold only `command`, `description`, `timeout` and `run_in_background`; any other key (e.g. `dangerouslyDisableSandbox`) sends it to the user.
  - **Pinned to the worktree:** the command sent back as `updatedInput` always starts in the task's worktree: Bash gets `cd -- '<worktree>' && <command>` (forward slashes), PowerShell `Set-Location -LiteralPath '<worktree>'; <command>`. A worktree path with a single quote (including PowerShell's smart quotes) or a control character gets no auto-allow. The `auto-allowed` event records the command as the agent wrote it.
  - **Directory changes (second layer):** once a `cd` (also PowerShell's `cd..`), `chdir`, `pushd`, `popd`, `Set-Location` (`sl`), `Push-Location`, `Pop-Location`, `eval`, `iex` / `Invoke-Expression`, `source` or `. <script>` command has been allowed in a task session (by the user or an "always allow" rule), that session gets no more auto-allows: its cwd or shell state may no longer be what Maestro expects. A restarted session starts in the worktree again.
  - **Submodules and .git paths:** no git option starting `--sub` (`--submodule=diff` would run git inside a nested repo the agent planted, with its own `diff.external`), and no `git add` path with a `.git` segment (any case, trailing dots or spaces).
  - Anything else, or any doubt, goes to the user as before.
  - **Test runs are an informed per-mission opt-in, off by default** (decided by user, 2026-10-29: "ask once per mission"). Running tests runs code, and a task that can edit files can change that code (test script, npm/yarn/pnpm config, test files), so it could run any program on the machine as the user without a prompt. At mission start the CLI explains this and asks once: "Let tasks run tests unattended for this mission? (y/n)". End of input counts as no. The answer is stored as `autoRunTests` in `settings_json` (default false). `--auto-run-tests` / `--no-auto-run-tests` skip the question; with `--no-auto-allow` it is not asked. The git, `mkdir`, `ls` and `pwd` entries stay pre-approved whenever `autoAllow` is on.
  - **Off switch:** `maestro run --no-auto-allow` (engine option `autoAllow`, default true). The value is stored per mission in `settings_json` as `autoAllow`, and commands are auto-allowed only when it is `true`. Per-project defaults are for the future UI. Maestro never reads this setting from a file inside the project repository, because an agent could edit it.
- **Accepted residual (security re-review, 2026-10-29):** filter (clean/smudge), textconv and merge drivers that the user configured in their own git config can be triggered by an agent's `.gitattributes` (for example in `git add`, `git diff` or Maestro's merges). They are the user's own programs, so this is not an escalation. Drivers planted in a nested repo's config are not reachable (see above).
- Apart from the safe list and "always allow" rules there is no auto-approve mode: every other request is answered by the user. Maestro never answers with `permission_suggestions`, because that could write settings files into a worktree, which would then be merged.
- **Inbox entry types:** `question`, `plan_approval`, `permission`, `review_decision`, `merge_decision`.
- **Inbox states:** `open`, `answered`, `expired`. An entry expires when its task is cancelled or its process dies, or when its request no longer applies.
- **Answering:** an answer applies exactly once (a second click gets `AlreadyAnswered`). A task can have several open entries at once, for example parallel tool calls.
- **Snooze** hides an entry for 1 hour.
- **Sort order:** Home sorts the inbox by age, with critical-path items first.

## 10. Data model (SQLite, versioned migrations)

Plan 1's baseline (migration 1) plus Plan 2's migration 2:

```
projects(id, name, path UNIQUE(normalised), created_at, last_used_at)
missions(id, project_id→, title, brief, state CHECK, outcome NULL CHECK('merged','kept'), depth, base_branch,
         mission_branch, isolation, max_parallel, conductor_session_id, settings_json, created_at, ended_at)
plan_versions(id, mission_id→, version, plan_path, plan_md, approved_at, UNIQUE(mission_id, version))
tasks(id, mission_id→, plan_version_id→ NULL (ad-hoc), task_key, title, agent, prompt, plan_body, state CHECK,
      depends_on_json, owns_json, acceptance, depth, on_critical_path, dispatched_at,
      session_id, worktree_path, branch, handoff_md, failure_reason, started_at, ended_at,
      tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, UNIQUE(mission_id, task_key))
inbox(id, mission_id→, task_id→ NULL, kind CHECK, request_id NULL, payload_json, state CHECK('open','answered','expired'),
      answer_json, created_at, answered_at, snoozed_until)
permission_rules(id, mission_id→, tool_name, input_prefix, created_at)
sessions(id, mission_id→, task_id→ NULL, role, claude_session_id, pid, state, log_path, started_at, ended_at)
usage_window(id=1, five_hour_utilization, five_hour_resets_at, seven_day_utilization, seven_day_resets_at, seen_at)
events(id, mission_id→, task_id→ NULL, ts, type, data_json)
```

Task keys are unique per mission, rather than per plan version, so ad-hoc tasks and re-plans share one key space.

## 11. Screens (from the mockups)

| # | Screen | Shows / does |
|---|---|---|
| 1 | **Home** | The inbox first. Running missions, each with a per-task progress bar and its own outline. Recently finished missions. **5-hr usage left** (last value with its age) and tokens today. |
| 2 | **New mission** | Project cards, the brief, optional "always require" constraints, planning depth, models, base branch, isolation, parallel limit, and when to stop and ask. |
| 3 | **Plan review** | Tasks grouped by wave. The mission's outline, why this shape, the quality gates, the conductor's questions, a re-plan note, and approve. |
| 4 | **Task graph** | The dependency graph with live status, including ad-hoc tasks. Click a task to trace what it waits for and unblocks. Critical-path toggle. |
| 5 | **Mission live** | The wave view with live status. The selected task's activity, tests, changes, plan and handoff. A message box, and stop. |
| 6 | **Tasks board** | All tasks across missions in Planned / Waiting / Ready / Running / Needs you / Done columns. |
| 7 | **Team & skills** | The agent roles and their skills. The role files can be edited. |

The Stats page is out of scope for v1.

## 12. Error handling and recovery

| Failure | Behaviour |
|---|---|
| A task process exits unexpectedly | The task becomes `failed` with the last 50 log lines. Its open inbox entries expire. The conductor sees the failure in `wait_for_tasks` and decides what to do. |
| No events for N minutes (default 20) | An inbox entry, "T6 seems stuck", with Stop task / Keep waiting. |
| An interrupt gets no `result` within 5 s | Force-kill the tree (§8.3). |
| The conductor exits unexpectedly | Its open questions and permission requests expire, then it is restarted with `--resume <conductor_session_id>`, at most once per engine run. If that fails, the mission becomes `failed`: its live tasks are stopped (cancelled), and their worktrees and branches are kept. |
| Base merge (Merge chosen) | In the main checkout when it is on the base branch and clean (untracked files ignored); else in a temporary worktree when the base branch is checked out nowhere; else the user is asked again ("Check out … or commit your changes"). |
| A bridge call times out | The conductor gets a timeout error and calls again. Tasks are unaffected, because the calls are idempotent. |
| Maestro restarts | Live sessions whose PID is gone are resumed with `--resume`; the conductor is resumed once per engine run. A running task that never got a Claude session goes back to `ready`. A mission left `finishing` without a merge decision is recorded as merged if the mission branch is already in the base branch, else half-done merges are aborted and the user is asked again. Nothing restarts silently from scratch. |
| A merge conflict into the mission branch | See §8.1. |
| An invalid plan, or an ad-hoc overlap | Returned to the conductor as a tool error. |
| `claude.exe` not found, or logged out | A blocking banner with the fix. |
| A worktree path is too long | A hashed short folder name (§8.1). |

## 13. Security and safety
- The HTTP server binds to `127.0.0.1` only, with a random per-run token on every request, shared by all sessions of that run. The Bridge helper gets the token through the `bridge.json` MCP config files under the logs folder (`<logDir>/missions/<id>/bridge.json`, `<logDir>/tasks/<taskId>/bridge.json`), which set its environment.
- Maestro never reads, stores or sends credentials.
- Task sessions are confined by their cwd (the worktree), the tools their role denies, and stdio permission prompts for anything else, apart from the narrow safe list (§9; test runs only after the per-mission opt-in).
- Git hooks and fsmonitor are off in task sessions and in all of Maestro's git commands (§8.1).
- `permission_suggestions` are never used, so no settings files are written into worktrees.
- Merging into the base branch only happens when the user clicks Merge.

## 14. Testing strategy
- **Unit:**
  - the plan parser, validation and graph, the state machines, the scheduler and the store (Plan 1, 67 tests);
  - the stream protocol, against fixtures recorded from the spikes;
  - the worktree-path guard.
- **Integration with a fake CLI:** a `fake-claude` script that replays recorded stream-json. It covers init, turns, a mid-turn message, a stop (interrupt then exit), `can_use_tool`, a rate-limit event, a crash and resume. Runner, bridge, inbox and recovery are tested without spending usage.
- **Bridge contract tests:** each tool's schema, blocking, idempotency and progress pings.
- **End-to-end:** one real 3-task mission on a scratch repo, run by hand before each release. It also re-runs the R1 compliance check.
- **UI:** component tests for the graph and the inbox, and Playwright smoke tests over the fake CLI.

## 15. Risks

| # | Risk | Status |
|---|---|---|
| R1 | The conductor uses the built-in Task tool instead of `dispatch_task` | **Resolved: GO.** 4 of 4 runs used `dispatch_task`, with no Task/Agent calls. Re-check when the bridge returns real handoffs. |
| R2 | Stream-json follow-ups and interrupts | **Resolved.** stdin messages and the `control_request` interrupt both work. |
| R3 | Routing permission prompts | **Resolved.** `--permission-prompt-tool stdio` works. |
| R4 | Usage window | **Resolved.** Use `rate_limit_event`. |
| R5 | Windows process control | **Resolved.** Spawn `claude.exe`, force-kill with `taskkill /T /F`, keep paths under 200 characters. |
| R6 | Long blocking MCP calls | **Resolved.** Calls of 30 min or more work; set `MCP_TOOL_TIMEOUT`. |
| R7 | `--disallowedTools` really restricts read-only roles | **Resolved.** Read-only roles use the `--tools` allow-list plus `--strict-mcp-config`, and `init` is checked (`unsafe-tools`). |
| R8 | Whether `result.usage` is cumulative over a long-lived process | **Resolved.** Not cumulative; usage is read from `model_usage_since_last_result`, else `usage`. |
| R9 | stdio permission prompts combined with `acceptEdits`, and an interrupt while a request is pending | **Open.** Verify early in Plan 2. |
| R10 | Behaviour changes in undocumented events (`rate_limit_event`, `can_use_tool`) across CLI versions | **Open.** Record the CLI version in every session, and keep the parser tolerant. |
| R11 | Spawn environment differs from the desktop app (e.g. `MCP_CONNECTION_NONBLOCKING`) | **Open.** Maestro sets its own explicit env and re-checks deferred-tool loading. |

## 16. Build order
- **Plan 1 (done):** the pure core, the store, spikes R1–R6.
- **Plan 2:**
  1. verify R7–R9;
  2. the stream protocol and fake CLI;
  3. the session runner;
  4. the worktree manager;
  5. migration 2 and the new states;
  6. the bridge (verbatim descriptions);
  7. inbox and permissions;
  8. scheduling and throttling;
  9. recovery;
  10. a command-line driver that runs a real mission end to end, with the R1 re-check.
- **Plan 3:** the HTTP and WebSocket API, then the React UI (7 screens).

## 17. Decisions
**Made by the user (2026-10-28):**
1. A local web page, opened in the browser.
2. The final merge into the base branch always asks first.
3. Usage is shown in tokens only, with no dollar figures. (v2 adds the 5-hour usage window, a percentage that comes from Claude itself.)

4. **No pause in v1.** Missions and tasks can only be stopped. (This replaces the earlier "Pause now keeps the process alive" decision.)
5. **A mission can end with Merge or Keep branch** (`done`, with outcome `merged` or `kept`).
6. **Task sessions can ask the user questions** directly, through a bridge that has only `ask_user`.
7. **"Always allow" is mission-scoped**, stored in Maestro, and limited to the tool name plus an exact command prefix.

**Technical calls (Claude, for later review):**
8. **The interrupt fallback is 5 s**, then a forced kill. In the spike the interrupt answered in about 0.1 s.
9. **A missing handoff gets one reminder**, then the task fails with reason `no-handoff`.
10. **No auto-approve mode.** Every permission request not covered by the safe list (decision 17) or an "always allow" rule is answered by the user. Both apply to task sessions only, never to the conductor.
11. **Keep branch** ends the mission `done` (outcome `kept`) and removes the integration worktree, so the user can check the branch out.
12. **`finish_mission` is refused while dispatched tasks are active**; blocked tasks (§5.2) do not count and are cancelled when the mission ends.
13. **Leftovers are auto-committed** before a task's merge, and the files are listed; the merge waits for the process's confirmed exit.
14. **Usage** is read from `model_usage_since_last_result`, else `usage` (R8).
15. **Re-plans are applied on approval**; keys are case-insensitive and `integration` / `*-integration` are reserved.
16. **Plain-text conductor turns become inbox questions**, and claude sessions run in their own hidden console on Windows (own process group elsewhere), so Ctrl+C reaches Maestro only.

**Made by the user (2026-10-29, after the first real run, where 7 of 10 prompts were routine task commands):**

17. **Pre-approve a safe list** of task-session shell commands: read-only git, `git add`, `git commit -m`, `mkdir`, `ls` and `pwd`, plus test runs after the opt-in in decision 19 (§9). Task sessions only, never the conductor. `--no-auto-allow` turns it off for a mission.
18. **Reviewers run tests.** spec-reviewer and code-reviewer get Bash (not PowerShell, no edit tools) and run in the default permission mode. Only plain test runs (after the opt-in) and read-only git are auto-allowed for them, and their leftover changes are discarded, never committed (§8.1, §9).
19. **Running tests unattended: ask once per mission, off by default.** The user makes an informed choice per mission after Maestro explains that tests run code a task can change; the answer is stored as `autoRunTests` (§9).

**Technical calls after the 2026-10-29 security review (Claude, for later review):**

20. **Repo hooks and fsmonitor never run** in task sessions or Maestro's git commands (§8.1); the user's own hooks therefore do not run on Maestro's commits and merges.
21. **Auto-allowed commands are pinned to the worktree** (`cd -- '<worktree>' &&` / `Set-Location -LiteralPath '<worktree>';`). Auto-allow also stops for a session after an allowed `cd`, `eval`, `iex` or `source`, refuses tool inputs with unexpected keys, and needs a `package.json` in the worktree for npm/pnpm/yarn test (§9).
22. **Done task worktrees are removed without `--force`**, so git keeps any with changes (§8.1).
23. **No submodule diffs:** `--sub*` git options and `git add` of `.git` paths are off the safe list, and Maestro's git env forces `diff.submodule=short` and `submodule.recurse=false` (§8.1, §9). The user's own configured filter, textconv and merge drivers stay reachable through `.gitattributes` (accepted, §9).
