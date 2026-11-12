<p align="center">
  <img src="docs/readme/hero.svg" alt="Maestro — mission control for Claude Code" width="100%">
</p>

<p align="center">
  <img alt="Node 22+" src="https://img.shields.io/badge/node-%E2%89%A522-3ddc84">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6">
  <img alt="Tests" src="https://img.shields.io/badge/tests-632%20passing-3ddc84">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows-0078d4">
</p>

**Maestro turns one written brief into a team of Claude Code sessions.**
A *conductor* session plans the work, Maestro runs every task in its own git worktree — independent tasks in
parallel — routes every question to one inbox, and merges the results back into your branch when you approve.

Maestro does no AI work itself. It is an orchestrator and a window onto the `claude` CLI you already use.

---

## ▶ See it run

A real mission, recorded from Maestro's terminal (condensed). The brief: *"add `capitalize`, `clamp`, an index
file and a README"*. Two tasks run in parallel, get reviewed, then the third task builds on both.

<p align="center">
  <img src="docs/readme/terminal.svg" alt="Animated terminal: Maestro plans 3 tasks, runs T1 and T2 in parallel, reviews them, runs T3, and merges into main" width="100%">
</p>

What the user did during that whole mission: **typed `y` a handful of times, and `m` once to merge.**

| Result of the run | |
|---|---|
| Tasks run | 5 (3 implementer + 2 spec-reviewer) |
| Tests on `main` after merge | **7 / 7 passing** |
| Prompts to the user | 10 (plan approval, permissions, merge) |
| Conductor used Claude's built-in subagents | **0** — every subagent became a visible Maestro task |

Full log: [`docs/superpowers/runs/2026-10-29-e2e.md`](docs/superpowers/runs/2026-10-29-e2e.md)

---

## 🧭 How it works

```mermaid
flowchart TB
    U([🧑 You write a brief]) --> C

    subgraph M["Maestro"]
        direction TB
        C["🎼 Conductor — a Claude Code session<br/>plans the mission"] -- "submit_plan" --> P["📋 Plan: tasks + dependencies"]
        P -- "✅ you approve" --> S["⚙️ Scheduler"]
        S --> T1["T1 · implementer<br/>own worktree"] & T2["T2 · implementer<br/>own worktree"]
        T1 & T2 --> R["T1-review · T2-review<br/>spec-reviewer"]
        R --> T3["T3 · implementer<br/>own worktree"]
        T3 --> I["🔀 Mission branch"]
    end

    M -. "questions & permissions" .-> INBOX{{"📥 Needs you — one inbox"}}
    I -- "you choose: merge / keep" --> MAIN[("main")]

    style C fill:#183a2a,stroke:#3ddc84,color:#e8fff2
    style INBOX fill:#3a2f10,stroke:#ffd75f,color:#fff6d6
    style MAIN fill:#0d1117,stroke:#3ddc84,color:#e8fff2
```

1. **You write a brief** — plain Markdown, a few lines is enough.
2. **The conductor plans it.** A long-lived Claude Code session runs the *superpowers* workflow
   (understand → plan → build → finish) and submits a plan through Maestro's bridge tools.
3. **You approve the plan** — or type a note and it re-plans.
4. **Maestro runs the tasks.** Each task is its own `claude` process, with its own role, in its own git worktree.
   Tasks with no unmet dependencies run at the same time (`--parallel N`).
5. **Every task's work is merged** into a mission branch as it finishes; later tasks build on it.
6. **You decide the ending:** merge the mission branch into `main`, or keep it for review.

---

## 📋 A plan is just Markdown — Maestro turns it into a graph

<table>
<tr>
<td width="48%" valign="top">

**What the conductor writes**

```markdown
### Task 1: Survey repo, auth & schema
Depends on: none
Agent: researcher

### Task 2: Dashboard UX & states
Depends on: none
Agent: designer
Owns: docs/design/**

### Task 3: API contract (OpenAPI)
Depends on: T1
Agent: architect
Owns: docs/api/**

### Task 4: Spike: churn query at scale
Depends on: T1
Agent: implementer
Owns: db/**

### Task 5: Contract tests from the spec
Depends on: T3
Agent: test-author

### Task 6: API endpoints (test-first)
Depends on: T3, T4
Agent: implementer

### Task 7: Dashboard pages on mock API
Depends on: T2, T3
Agent: implementer
```

</td>
<td width="52%" valign="top">

**What Maestro schedules**

```mermaid
flowchart TB
    subgraph W1["Wave 1"]
        T1["T1 · researcher<br/>Survey repo"]
        T2["T2 · designer<br/>Dashboard UX"]
    end
    subgraph W2["Wave 2"]
        T3["T3 · architect<br/>API contract"]
        T4["T4 · implementer<br/>Query spike"]
    end
    subgraph W3["Wave 3"]
        T5["T5 · test-author<br/>Contract tests"]
        T6["T6 · implementer<br/>API endpoints"]
        T7["T7 · implementer<br/>Dashboard pages"]
    end
    T1 --> T3
    T1 --> T4
    T3 --> T5
    T3 --> T6
    T4 --> T6
    T2 --> T7
    T3 --> T7

    linkStyle 0,3 stroke:#e5534b,stroke-width:3px
    style T1 stroke:#e5534b,stroke-width:3px
    style T3 stroke:#e5534b,stroke-width:3px
    style T6 stroke:#e5534b,stroke-width:3px
```

<sub>🔴 Critical path: **T1 → T3 → T6** — the earliest the mission can finish.</sub>

</td>
</tr>
</table>

The plan is validated before you see it: unknown dependencies, cycles, unknown agent roles and two tasks claiming
the same files (`Owns:`) are all rejected, and the conductor has to fix them.

Waves are for display only — the scheduler starts each task **the moment its own dependencies are done**, not
when the whole wave is.

---

## 🎭 Agent roles

Every task runs as a role: a model, a tool list and a set of skills. Read-only roles cannot edit files at all.

| Role | Model | Can edit? | Typical job |
|---|---|:---:|---|
| 🔎 `researcher` | Haiku | ❌ read-only | Survey a codebase, write findings into the handoff note |
| 🏛️ `architect` | Opus | ✅ | System design, API contracts, ADRs |
| 🎨 `designer` | Opus | ✅ | UX, states, wireframes |
| 🧪 `test-author` | Sonnet | ✅ | Write failing tests from the spec |
| 🛠️ `implementer` | Sonnet | ✅ | Build it test-first |
| ✅ `spec-reviewer` | Sonnet | ❌ (can run tests) | Does the work match the task's acceptance criteria? |
| 🧐 `code-reviewer` | Opus | ❌ (can run tests) | Correctness, security, quality |
| 🐞 `debugger` | Opus | ✅ | Systematic debugging of a failure |
| 🚦 `qa` | Sonnet | ✅ | Verify end to end, with evidence |

Roles live in [`agents/`](agents) as Markdown files — add your own.

---

## 🔄 Lifecycles

<table>
<tr>
<td width="50%" valign="top">

**A mission**

```mermaid
stateDiagram-v2
    direction TB
    [*] --> draft
    draft --> understanding
    draft --> planning: --quick
    understanding --> planning
    planning --> awaiting_approval: plan submitted
    awaiting_approval --> planning: re-plan note
    awaiting_approval --> running: ✅ approved
    running --> planning: re-plan
    running --> finishing: finish_mission
    finishing --> done: merged / kept
    done --> [*]
```

</td>
<td width="50%" valign="top">

**A task**

```mermaid
stateDiagram-v2
    direction TB
    [*] --> planned
    planned --> waiting: dispatched
    waiting --> ready: dependencies done
    ready --> running: slot free
    running --> needs_you: question / permission
    needs_you --> running: you answered
    running --> done: ✅ merged
    running --> failed
    failed --> waiting: retry
    done --> [*]
```

</td>
</tr>
</table>

Any mission or task can also be stopped. If Maestro or the machine dies mid-mission, the next start **recovers**
it: live sessions are resumed, and questions that can no longer be answered are expired instead of hanging.

---

## 📥 One inbox for everything that needs you

Five parallel Claude sessions do not mean five terminals to babysit. Everything that needs a human lands in one
queue, numbered, with who is asking:

| Kind | Example | Your answer |
|---|---|---|
| **Plan approval** | `#1 Plan approval (version 1)` + tasks, waves, critical path | `y`, or a note → re-plan |
| **Permission** | `#2 Permission request from T2 — Bash: npm test` | `y` once · `a` always for this mission · `n` deny |
| **Question** | `#4 Question from conductor: Postgres or SQLite?` | pick an option |
| **Merge decision** | `#10 Mission finished — merge decision` | `m` merge · `k` keep branch |

Routine, harmless commands inside a task's own worktree (`git status`, `git add`, `git commit`, …) are
auto-allowed from a pinned safe list, so the prompts you *do* see are the ones worth reading.

---

## 🛡️ Safe by design

```mermaid
flowchart LR
    subgraph repo["Your repository"]
        MAIN[("main<br/>untouched until you merge")]
        MB["maestro/mission-name<br/>integration worktree"]
        W1["…--T1 worktree"]
        W2["…--T2 worktree"]
        W3["…--T3 worktree"]
    end
    W1 -- merge --> MB
    W2 -- merge --> MB
    W3 -- merge --> MB
    MB -. "only on [m]" .-> MAIN
```

- **Isolation** — every task gets its own branch and worktree; tasks cannot step on each other or on your checkout.
- **Nothing reaches `main` without you** — the final merge is always your explicit choice.
- **Real tool restriction** — read-only roles run with an explicit `--tools` allow-list and `--strict-mcp-config`
  (we verified `--allowedTools` alone does *not* restrict tools).
- **No surprise code execution** — git hooks, `fsmonitor` and diff drivers are disabled inside tasks; running tests
  (which runs code) is an informed, per-mission opt-in, off by default.
- **Your own login** — Maestro starts *your* logged-in `claude` CLI and never touches credentials.
- **Clean stop** — `Ctrl+C` stops the conductor and every task (whole process trees, Windows-safe).

---

## 🏗️ Architecture

```mermaid
flowchart TB
    CLI["⌨️ CLI — maestro run<br/>event lines + numbered prompts"]
    subgraph core["Maestro (one local Node process)"]
        ENG["Mission engine<br/>state machines"]
        PLAN["Plan parser + graph<br/>validation, waves, critical path"]
        SCH["Scheduler<br/>parallel slots, rate-limit throttle"]
        RUN["Session runner"]
        GIT["Worktree manager"]
        BR["Bridge MCP server<br/>submit_plan · dispatch_task · wait_for_tasks<br/>ask_user · finish_mission"]
        DB[("SQLite<br/>maestro.db")]
    end
    CLI <--> ENG
    ENG --- PLAN & SCH & DB
    SCH --> RUN
    RUN -- "stream-json over stdio" --> CC["claude.exe — conductor"]
    RUN -- "stream-json over stdio" --> CT["claude.exe — task × N"]
    CC -- "MCP tool calls" --> BR
    BR --> ENG
    ENG --> GIT --> REPO[("git")]
```

- One long-lived `claude` process per session, driven over **stream-json** on stdin/stdout.
- Permission requests come back through `--permission-prompt-tool stdio` and go to the inbox.
- The conductor never uses Claude's built-in subagents — it calls Maestro's bridge tools, so every piece of work is
  a visible, controllable task.
- 5-hour / 7-day usage windows are read from Claude's rate-limit events and used to throttle new work.

---

## 🚀 Quick start

Requires **Node 22+**, **git**, and the **Claude Code CLI** installed and logged in.

```bash
npm install
```

```bash
npm test
```

```bash
npm run maestro -- run --project C:\path\to\repo --brief brief.md --parallel 3
```

| Option | Meaning |
|---|---|
| `--project <path>` | the git repository to work in (required) |
| `--brief <file>` | Markdown brief; the first `# ` heading becomes the title (required) |
| `--quick` | skip the understanding step, go straight to planning |
| `--parallel <n>` | tasks running at the same time (default 3, max 16) |
| `--base <branch>` | branch to build on and merge into (default `main`) |
| `--db <path>` | database file (default `%APPDATA%\Maestro\maestro.db`) |
| `--no-auto-allow` | ask about every task shell command, including the safe list |
| `--auto-run-tests` / `--no-auto-run-tests` | answer the start-up "may tasks run tests?" question up front |

Exit code `0` when the mission finishes, `1` if it is stopped or fails. A step-by-step first run is in
[`HOW-TO-RUN-E2E.md`](docs/superpowers/runs/HOW-TO-RUN-E2E.md).

---

## 🗺️ Roadmap: the web UI

The engine and CLI work today. Next is a local web UI on top of the same engine. Early wireframes:

<table>
<tr>
<td align="center"><img src="mockups/projects.png" alt="Projects screen wireframe" width="100%"><br/><sub><b>Projects</b> — your repos, start a mission</sub></td>
<td align="center"><img src="mockups/missions.png" alt="Missions screen wireframe" width="100%"><br/><sub><b>Missions</b> — running and finished</sub></td>
<td align="center"><img src="mockups/tasks.png" alt="Tasks screen wireframe" width="100%"><br/><sub><b>Tasks</b> — Ready · Running · Needs You · Finished</sub></td>
</tr>
</table>

---

## 📁 Project layout

```
src/
  core/      plan parser + graph, scheduler, mission & task state machines
  engine/    mission engine, task runner, inbox, recovery, safe-command list, throttle
  claude/    finding claude.exe, stream-json protocol, sessions, process-tree kill
  bridge/    MCP server the conductor talks to (submit_plan, dispatch_task, …)
  git/       worktrees, locked-down git environment
  store/     SQLite schema, migrations, repositories
  cli/       `maestro run`: event formatting and terminal prompts
agents/      role definitions (model, tools, skills, instructions)
prompts/     the conductor's system prompt
test/        632 tests, incl. a fake `claude` that replays recorded stream-json
docs/        design spec, implementation plans, spike reports, real-run logs
```

The full design — every decision and the evidence behind it — is in
[`docs/superpowers/specs/2026-10-28-maestro-design.md`](docs/superpowers/specs/2026-10-28-maestro-design.md).
