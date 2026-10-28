# How to run the first real mission (Plan 2, Task 14 step 5)

This run uses your real Claude usage. You run it yourself and answer every prompt at the terminal. Maestro never
approves a permission on its own. Afterwards, write the results to `docs/superpowers/runs/2026-10-28-e2e.md` (see
"What to collect" below). That file also holds the R1 re-check: **GO only if the conductor used Task/Agent 0 times.**

All commands are for Windows PowerShell.

## 0. Before you start

```powershell
claude --version                 # the claude CLI is installed and logged in
cd D:\Desktop\Programming\maestro
npm install
npm test                         # should be green
```

- Close other Maestro runs. Use a separate database for this run (see `--db` below) so your real one stays clean.
- Ctrl+C once stops the mission cleanly: tasks and the conductor are stopped, and the exit code is 1. Press Ctrl+C a
  second time to quit at once without waiting. The mission then stays recoverable on the next start.
- If stdin ends while an answer is needed (for example, Ctrl+Z then Enter), the mission is stopped the same way.

## 1. Create the scratch repo

Always start from a fresh folder. Branches left over from an earlier, aborted run (`maestro/<slug>--T1`, ...) make the
new tasks fail when they create their worktrees.

```powershell
$scratch = "$env:TEMP\maestro-e2e"
$data    = "$env:TEMP\maestro-e2e-data"
Remove-Item -Recurse -Force $scratch, $data -ErrorAction SilentlyContinue
New-Item -ItemType Directory $scratch | Out-Null
Set-Location $scratch
git init -b main
git config user.name  "Maestro E2E"
git config user.email "e2e@example.invalid"
# WriteAllText writes UTF-8 with no BOM (Set-Content in PowerShell 5.1 would add one).
[IO.File]::WriteAllText("$scratch\package.json", @'
{
  "name": "maestro-e2e-scratch",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
'@)
[IO.File]::WriteAllText("$scratch\README.md", "# Tiny utils`n`nA scratch repo for the first Maestro mission.`n")
git add .
git commit -m "init"
```

## 2. Write the brief

Keep the brief outside the repo, so the main checkout stays clean:

```powershell
[IO.File]::WriteAllText("$env:TEMP\maestro-e2e-brief.md", @'
# Tiny utils

Add three small things to this repo. Keep every change minimal. Use plain JavaScript ES modules and Node's built-in
test runner (`node --test`). Add no dependencies.

1. `src/strings.js` exporting `capitalize(s)`: the first character upper-cased, the rest unchanged; '' stays ''.
   Add `test/strings.test.js`.
2. `src/numbers.js` exporting `clamp(n, min, max)`. Add `test/numbers.test.js`.
3. `src/index.js` re-exporting `capitalize` and `clamp`, plus a short "Usage" section in README.md.

Tasks 1 and 2 are independent of each other. Task 3 depends on both 1 and 2. Plan exactly these three tasks.
Each task commits its own work and runs `npm test` before it finishes.
'@)
```

## 3. Start the mission

```powershell
cd D:\Desktop\Programming\maestro
npm run maestro -- run --project "$env:TEMP\maestro-e2e" --brief "$env:TEMP\maestro-e2e-brief.md" --title "Tiny utils" --quick --parallel 2 --db "$env:TEMP\maestro-e2e-data\maestro.db"
```

- `--quick` skips the understanding step, so the conductor goes straight to planning and asks fewer questions. Leave
  it out if you also want to see that step.
- `--parallel 2` lets T1 and T2 run at the same time.
- `--db` keeps this run apart from your real database. The logs then go to `$env:TEMP\maestro-e2e-data\logs`.
- At the start, Maestro prints the database path, the log folder, the mission id and branch (`maestro/tiny-utils`),
  and the **conductor log path**. Copy the conductor log path: you need it in step 5.

From then on you get one line per event, for example:

```
[mission] planning -> awaiting_approval
[plan] 3 tasks in 2 waves
[conductor] dispatched T1 (implementer)
[T1 running] Strings
[T1 needs_you] Strings
[T1 merged] into the mission branch (1b49123)
[T1 done] Strings — tokens in 1,234 / out 567 / cache read 89,000 / cache write 12,000
```

A `[conductor] WARNING: used the built-in Task tool ...` line means the conductor used a subagent instead of
`dispatch_task`. That counts against R1. Note it, but let the mission continue.

## 4. The prompts and what to answer

Every inbox entry becomes a numbered prompt (`#1`, `#2`, ...), one at a time, oldest first. Invalid input shows
`Invalid answer: ...` and asks again. Copy every prompt and your answer into the run record (or collect them from
the database afterwards, see step 5).

| Prompt | What it means | What to type |
|---|---|---|
| `#n Permission request from <who> — <Tool>: <command or input>` | A session (the `conductor` or a task such as `T1`) wants to use a tool that needs approval. Tasks run in `acceptEdits` mode, so mostly their Bash commands ask. The conductor runs in `default` mode, so it may ask for things like Skill, Write (to save the plan file) or Bash. | `y` = allow once. `a` = always allow for this mission: for Bash, every command that starts with the same two words (commands with `;`, `&`, `\|`, `>`, a backtick or `$(` are only ever allowed once); for any other tool, **every** use of that tool. `n` = deny, then type an optional reason (or press Enter). **Suggested:** `y` or `a` for `npm test`, `node --test`, `git status/diff/log/add/commit` and reads in the scratch repo; `y` for the conductor's Skill and plan file Write; `n` for anything outside the scratch repo, network access, `git push`, deletes outside the repo, or anything you don't understand. Use `a` sparingly, especially for tools other than Bash. |
| `#n Question from <who>: ...` with numbered options | The conductor (`ask_user`) or a task asks you to choose. "`<KEY>` seems stuck" questions also look like this. | The option's number, for example `1`. |
| `#n Question from <who>: ...` with no options | A free-text question. | Your answer on one line (it can't be empty). |
| `[plan] N tasks in W waves` + `#n Plan approval` | The conductor submitted its plan. Maestro shows each task with its agent, dependencies and owned files, then the waves and the critical path. | **Expected:** 3 tasks; T1 and T2 with `depends on: none` in wave 1; T3 with `depends on: T1, T2` in wave 2. If it matches, type `y`. Anything else you type goes back to the conductor as a re-plan note (for example `T3 must depend on T1 and T2`), and the revised plan comes back as a new prompt. |
| `#n Mission finished — merge decision` | `finish_mission`: all the work is on the mission branch. Shows the conductor's summary. | `m` = merge the mission branch into `main` (`git merge --no-ff`). `k` = keep the branch and leave `main` untouched. **Suggested:** `m`, since it is a scratch repo and the merge result is part of the record. If it says `Check out main or commit your changes`, the conductor left a file (often the plan) uncommitted in the main checkout. Commit or remove it in `$env:TEMP\maestro-e2e`, and you are asked again. Or answer `k`. |

The process exits 0 when the mission ends `done` (merged or kept), and 1 when it is stopped or failed. The last lines
show the outcome, each task's state and tokens, and the task token total.

## 5. What to collect afterwards (for `2026-10-28-e2e.md`)

Set the paths first. `$cond` is the conductor log path that was printed at the start (it is
`<logs>\missions\<mission id>\conductor.log`):

```powershell
$scratch = "$env:TEMP\maestro-e2e"
$db      = "$env:TEMP\maestro-e2e-data\maestro.db"
$cond    = "<paste the conductor log path>"
cd D:\Desktop\Programming\maestro
```

### 5a. R1: tool use counts in the conductor log

Counts every assistant `tool_use` block by name (a nested one, with a `parent_tool_use_id`, is counted separately),
then prints the order of the `maestro` bridge calls (that gives the dispatch and wait order):

```powershell
@'
const fs = require('fs');
const file = process.argv[process.argv.length - 1];
const counts = {};
const calls = [];
for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  if (!line.startsWith('{')) continue;
  let o; try { o = JSON.parse(line); } catch { continue; }
  if (o.type !== 'assistant') continue;
  for (const b of (o.message && o.message.content) || []) {
    if (b.type !== 'tool_use') continue;
    const k = (o.parent_tool_use_id ? 'nested ' : '') + b.name;
    counts[k] = (counts[k] || 0) + 1;
    if (b.name.startsWith('mcp__maestro__')) {
      const i = b.input || {};
      const arg = i.task_id || (i.task_refs && i.task_refs.join(',') + ' ' + (i.mode || '')) || i.plan_path || i.question || '';
      calls.push(`${b.name.replace('mcp__maestro__', '')} ${arg}`.trim());
    }
  }
}
const n = k => counts[k] || 0;
console.log(counts);
console.log(`dispatch_task: ${n('mcp__maestro__dispatch_task')}`);
console.log(`Task + Agent (top level): ${n('Task') + n('Agent')}   Task + Agent (nested): ${n('nested Task') + n('nested Agent')}`);
console.log('Bridge calls in order:');
for (const c of calls) console.log('  ' + c);
'@ | node - $cond
```

Record: the `dispatch_task` count, the Task + Agent count (**R1 is GO only if this is 0**), and the bridge call order.
`wait_for_tasks` calls list task refs (UUIDs). Match them to keys with the task table from 5b.

### 5b. Mission, tasks, tokens, every prompt, event order

Read-only queries on the run's database (needs `better-sqlite3`, so run it from the Maestro folder):

```powershell
@'
const Database = require('better-sqlite3');
const db = new Database(process.argv[process.argv.length - 1], { readonly: true });
const m = db.prepare('SELECT * FROM missions ORDER BY created_at DESC LIMIT 1').get();
console.log(`Mission: ${m.title} | state ${m.state} | outcome ${m.outcome} | ${m.mission_branch} -> ${m.base_branch}`);
console.log('\nTasks:');
const ts = db.prepare('SELECT * FROM tasks WHERE mission_id = ? ORDER BY rowid').all(m.id);
const tot = { i: 0, o: 0, r: 0, w: 0 };
for (const t of ts) {
  console.log(`  ${t.task_key} ${t.id} ${t.agent} ${t.state} deps=${t.depends_on_json} in=${t.tokens_in} out=${t.tokens_out} cacheRead=${t.tokens_cache_read} cacheWrite=${t.tokens_cache_write}${t.failure_reason ? ' reason=' + t.failure_reason : ''}`);
  tot.i += t.tokens_in; tot.o += t.tokens_out; tot.r += t.tokens_cache_read; tot.w += t.tokens_cache_write;
}
console.log(`  TOTAL (tasks) in=${tot.i} out=${tot.o} cacheRead=${tot.r} cacheWrite=${tot.w}`);
console.log('\nInbox (every prompt, in order):');
for (const e of db.prepare('SELECT * FROM inbox WHERE mission_id = ? ORDER BY created_at, rowid').all(m.id)) {
  const t = e.task_id ? db.prepare('SELECT task_key FROM tasks WHERE id = ?').get(e.task_id).task_key : 'conductor';
  console.log(`  ${new Date(e.created_at).toISOString()} ${e.kind} from ${t} [${e.state}] ${e.payload_json.slice(0, 160)} => ${e.answer_json}`);
}
console.log('\nDispatch / state order:');
for (const ev of db.prepare("SELECT * FROM events WHERE mission_id = ? AND type IN ('state','merged','conductor-subagent-warning','mission-failed') ORDER BY id").all(m.id)) {
  const t = ev.task_id ? db.prepare('SELECT task_key FROM tasks WHERE id = ?').get(ev.task_id).task_key : 'mission';
  console.log(`  ${new Date(ev.ts).toISOString()} ${t} ${ev.type} ${ev.data_json}`);
}
const warn = db.prepare("SELECT COUNT(*) AS n FROM events WHERE mission_id = ? AND type = 'conductor-subagent-warning'").get(m.id).n;
console.log(`\nconductor-subagent-warning events (Task/Agent used by the conductor): ${warn}`);
'@ | node - $db
```

The conductor's own token use is not in the task table. Take it from the last `result` line of the conductor log
(its `usage` and `total_cost_usd`):

```powershell
Get-Content $cond | Where-Object { $_ -like '{"type":"result"*' } | Select-Object -Last 1
```

### 5c. Git graph and the merge result

```powershell
git -C $scratch log --graph --oneline --all --decorate
git -C $scratch worktree list
git -C $scratch status --short
git -C $scratch show --stat main          # after Merge: "Maestro: Tiny utils"
cd $scratch; npm test; cd D:\Desktop\Programming\maestro
```

### 5d. What goes into `docs/superpowers/runs/2026-10-28-e2e.md`

1. The setup: claude version (`claude --version`), date, the brief, and the exact command line.
2. Every inbox prompt with your answer (from the terminal, or the "Inbox" list in 5b).
3. The dispatch and wait order: the bridge call order from 5a, plus the task state order from 5b. Check that T1 and T2
   ran at the same time, and that T3 started only after both were done.
4. R1: the `dispatch_task` count and the Task/Agent count (top level and nested), plus the
   `conductor-subagent-warning` count. **GO only if Task/Agent is 0.**
5. Task outcomes: each task's state, failure reason (if any) and handoff (`tasks.handoff_md`).
6. The outcome (`merged` or `kept`), the `git log --graph` output, and whether `npm test` passes on the result.
7. Tokens: per task and the task total (5b), plus the conductor's usage and cost (its last `result` line).
8. Anything odd: warnings, re-prompts, stuck questions, crashes, and anything you had to work around.

Then commit it: `git add docs/superpowers/runs/2026-10-28-e2e.md; git commit -m "docs: first real end-to-end mission"`.

## Where things are

- Database: the `--db` path (by default `%APPDATA%\Maestro\maestro.db`).
- Logs: `<db folder>\logs\missions\<mission id>\conductor.log` (the conductor's raw stream-json, with `[stderr]` and
  `[session]` lines mixed in), `...\missions\<mission id>\tasks\*.log` (each task session), and
  `<db folder>\logs\tasks\<task id>\bridge.json`.
- Worktrees: `<project>\.claude\worktrees\<mission8>-<task key>` (git-excluded). Task branches are
  `maestro/<slug>--<task key>`.
