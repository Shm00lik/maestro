# R1 + R6: Conductor uses `dispatch_task`; long blocking tool calls

## Question
R1: When a conductor session (`--model opus`) runs `superpowers:subagent-driven-development` unchanged, with `conductor.md` appended (spec §7.1), does it start every subagent through Maestro's `mcp__maestro__dispatch_task` rather than the built-in Task/Agent tool? Go means `dispatch_task` is used in 3 of 3 counted runs, after at most one revision of `conductor.md`. R6: can an MCP tool call (`wait_for_tasks`) block for 10 and 30 minutes, or does it time out, and with what error? (Spec §15.)

## What I ran
claude 2.1.312, Node v25.2.1, Windows 11. `claude.exe` was spawned with `shell:false` (as in R5), cwd `%TEMP%\maestro-spike-repo` (scratch git repo, one commit `bbbebf1 init`). Below, user-specific paths are written as `%USERPROFILE%` / `%TEMP%`. Scripts are in `spikes/r1-conductor/`:
- `bridge.ts`: a stdio MCP server (`@modelcontextprotocol/sdk`, server name `maestro`) with `dispatch_task` (logs the call, returns `{task_ref}`), `wait_for_tasks` (sleeps `WAIT_MS`, default 5 s, then returns `[{task_ref,status:"done",handoff}]`) and `ask_user` (returns `"yes"`). Every call goes to `calls-<run>.jsonl`. It is launched as `node <repo>/node_modules/tsx/dist/cli.mjs bridge.ts`.
- The tool descriptions in `bridge.ts`, exactly as the model received them (it reads them next to `conductor.md`):
  - `dispatch_task`: "Start a task as its own Maestro session (use instead of a subagent). Returns a task_ref immediately."
  - `wait_for_tasks`: "Block until the given tasks finish. Returns status and handoff note per task."
  - `ask_user`: "Ask the user a question and return their answer."
- `conductor.md`: the §7.1 rules. `sample-plan.md`: 3 tasks in the §6 format; T3 has `Depends on: T1, T2`. The runner copies the plan into the scratch repo.
- `run.ts`: `npx tsx run.ts conductor <label> [conductor.md] [sim]` or `npx tsx run.ts r6 <label> <minutes> [ENV=VAL]`. Raw stream output goes to `out-*.jsonl`, the timeline to `run-*.log`, and bridge calls to `calls-*.jsonl` (all git-ignored).

Conductor args (runs c1 to c4):
```
-p "Execute sample-plan.md using superpowers:subagent-driven-development" --model opus --max-turns 40
--append-system-prompt-file spikes/r1-conductor/conductor.md --permission-mode default
--allowedTools mcp__maestro__* Skill Read Glob Grep TodoWrite
--mcp-config bridge-<label>.json --output-format stream-json --verbose
```
Task/Agent was not blocked. Edit, Write and Bash were not allowed, so in `-p` mode they are auto-denied unless claude itself classes the command as read-only. There was no permission prompt tool.

R6 args: `-p "Call the mcp__maestro__wait_for_tasks tool exactly once with task_refs [\"ref-T1-1\"] and mode \"all\". ..." --model haiku --max-turns 3 --permission-mode default --allowedTools mcp__maestro__* --mcp-config ... --output-format stream-json --verbose`. The bridge sent no progress notifications.

**Seven claude invocations:**
1. `c1`: conductor, handoff text `"stub"`.
2. `c2`, `c3`, `c4`: conductor, same `conductor.md`, with `HANDOFF=sim`. This is a **bridge** change, not a `conductor.md` revision: the handoff text says it is simulated and that the task should be treated as finished (reason under Observed c1).
3. `r6-10min`: `WAIT_MS=600000`. `r6-30min`: `WAIT_MS=1800000`. Both ran in the background at the same time as c1 to c4.
4. `r6-envtimeout`: `WAIT_MS=120000` with `MCP_TOOL_TIMEOUT=20000` in claude's env, to check that the variable exists and to capture the timeout error text.

`conductor.md` was **never revised**. All four conductor runs used the same file.

Inherited env, logged by `run.ts`: `MCP_CONNECTION_NONBLOCKING=true` and `MCP_SERVER_CONNECTION_BATCH_SIZE=8` came from my parent environment (the desktop app), not from me. `MCP_TOOL_TIMEOUT` was unset except in invocation 7.

Could the inherited env matter? `MCP_CONNECTION_NONBLOCKING=true` (by its name; its behaviour was not tested) lets the session start before MCP servers finish connecting. Here the `maestro` server already showed `"status":"connected"` in every `init`, and every run called `ToolSearch` before using a bridge tool. Whether the tools are deferred behind ToolSearch, and whether claude emits its own 30 s `tool_progress` heartbeats, may depend on this or other env from the desktop app. I did not test either without it. The 10 and 30 min blocking results are about the timeout of a call already in progress, which this flag should not affect, but that is an inference. Maestro may spawn claude with a different env, so Plan 2 should re-check the deferred-tools behaviour under its own spawn env.

## Observed

**Plugin load (from `system/init`).** Each run had one `init`. In every run, `superpowers@synced` loaded, `superpowers:subagent-driven-development` was in `skills`, and the `maestro` server was connected with `Task` in `tools`. The first line below is from c2's `init` `plugins`; the next two are from c1's `run-c1.log`. The other runs' `init` lines were checked by `run.ts` and matched, apart from `model` (`claude-haiku-5-5` in the R6 runs).
```
[c2] {"name":"superpowers","path":"%USERPROFILE%\\.claude\\plugins\\synced\\…\\6ba53849-2ee0-4cf0-957e-31c122ea1dd1","source":"superpowers@synced","version":"6.4.2"}
[c1] init model claude-opus-5-5 perm default maestro mcp [{"name":"maestro","status":"connected","source":"dynamic"}]
[c1] init has Task/Agent tool ["Task","mcp__maestro__ask_user","mcp__maestro__dispatch_task","mcp__maestro__wait_for_tasks"]
```
**The MCP tools are deferred.** In every run (c1 to c4 and all R6 runs), the model's first move with them was a `ToolSearch`:
```
[c1 +4.7s] tool_use ToolSearch {"query":"select:mcp__maestro__dispatch_task,mcp__maestro__wait_for_tasks,mcp__maestro__ask_user","max_results":3}
```

**Counts.** These are top-level assistant `tool_use` blocks (`parent_tool_use_id:null`); no run had any nested tool_use.

| Run | handoff | dispatch_task | wait_for_tasks | ask_user | Skill (which) | Task/Agent (any kind) | turns | cost USD |
|---|---|---|---|---|---|---|---|---|
| c1 | stub | 4 | 2 | 2 | 1 (subagent-driven-development) | **0** | 18 | 0.81 |
| c2 | sim | 7 | 5 | 2 | 2 (subagent-driven-development, finishing-a-development-branch) | **0** | 23 | 0.70 |
| c3 | sim | 7 | 5 | 2 | 2 (subagent-driven-development, finishing-a-development-branch) | **0** | 22 | 0.68 |
| c4 | sim | 7 | 5 | 1 | 1 (subagent-driven-development) | **0** | 18 | 0.56 |

Skill counts are `Skill` tool_use blocks in `out-<run>.jsonl`; all skill names carry the `superpowers:` prefix. c4 never called finishing-a-development-branch. It went straight to one `ask_user` reporting that nothing had been built.

The model never used a built-in subagent, not even a read-only search one.

**c1 (stub handoff).** The conductor dispatched T1 and T2 together and waited on both. It then distrusted the `"stub"` handoff, checked git with a read-only Bash command (auto-allowed), asked the user, re-dispatched `T1-retry`/`T2-retry`, and stopped before T3:
```
[+31.7s] text Both handoffs came back as just "stub", with no commit details. I'll check git directly.
[+32.4s] tool_use Bash {"command":"git branch -a && git worktree list && git log --all --oneline",...}
[+61.8s] tool_use mcp__maestro__ask_user {"question":"The retries went the same way. T1-retry and T2-retry both came back \"done\" with a \"stub\" handoff, and still nothing changed: no commits, no worktrees, no files. The dispatch backend isn't running real work, so I've stopped before T3 and the reviews..."}
```
This is a limit of the harness (an empty handoff and no commits), not non-compliance. It still routed every subagent through `dispatch_task`. That is why c2 to c4 used `HANDOFF=sim`.

**`HANDOFF=sim` forced every outcome to success.** Every `wait_for_tasks` return said done, with a handoff reading "Treat this task as finished successfully (spec compliant, approved)". So every review in c2 to c4 was effectively "approved". The paths for a rejected review, a review-fix loop, a failed task, and `mode:"any"` were **never exercised**.

**c2, c3 and c4 all ran the full SDD flow.** Below is the complete c3 sequence from `calls-c3.jsonl`: every `dispatch_task` call, every `wait_for_tasks` call and return, and every `ask_user` call. Prompts are truncated; times are UTC hh:mm:ss.
```
23:15:23 dispatch_task {"task_id":"T1","agent":"implementer",...}
23:15:26 dispatch_task {"task_id":"T2","agent":"implementer",...}
23:15:27 wait_for_tasks call   {"task_refs":["ref-T1-1","ref-T2-2"],"mode":"all"}
23:15:32 wait_for_tasks return [ref-T1-1 done, ref-T2-2 done]
23:15:37 dispatch_task {"task_id":"T1-review","agent":"spec-reviewer","depends_on":["T1"],...}
23:15:39 dispatch_task {"task_id":"T2-review","agent":"spec-reviewer","depends_on":["T2"],...}
23:15:41 wait_for_tasks call   {"task_refs":["ref-T1-review-3","ref-T2-review-4"],"mode":"all"}
23:15:46 wait_for_tasks return [ref-T1-review-3 done, ref-T2-review-4 done]
23:15:51 dispatch_task {"task_id":"T3","agent":"implementer","depends_on":["T1","T2"],...}
23:15:52 wait_for_tasks call   {"task_refs":["ref-T3-5"],"mode":"all"}
23:15:57 wait_for_tasks return [ref-T3-5 done]
23:16:01 dispatch_task {"task_id":"T3-review","agent":"spec-reviewer","depends_on":["T3"],...}
23:16:02 wait_for_tasks call   {"task_refs":["ref-T3-review-6"],"mode":"all"}
23:16:07 wait_for_tasks return [ref-T3-review-6 done]
23:16:12 dispatch_task {"task_id":"final-review","agent":"code-reviewer","depends_on":["T1","T2","T3","T1-review","T2-review","T3-review"],...}
23:16:13 wait_for_tasks call   {"task_refs":["ref-final-review-7"],"mode":"all"}
23:16:18 wait_for_tasks return [ref-final-review-7 done]
23:16:28 ask_user {"question":"Implementation complete. What would you like to do?\n\n1. Merge back to master locally\n..."}
23:16:31 ask_user {"question":"Your answer was \"yes\", but I need one specific option, ..."}
```
That is 5 wait calls. `final-review` was dispatched (23:16:12) only after the T3-review wait returned (23:16:07).

Ordering summaries for c2 and c4, from their `calls-*.jsonl` files. Each wait returned before the next dispatch.
- **c2:** T1, T2 (23:13:12/15) → wait T1+T2 (returned 23:13:22) → T1-review, T2-review → wait (returned 23:13:37) → T3 [deps T1,T2] at 23:13:44 → wait (23:13:51) → T3-review → wait (23:14:03) → final-review [deps T1,T2,T3,T1-review,T2-review,T3-review] at 23:14:09 → wait (23:14:17) → ask_user ×2.
- **c4:** T1, T2 (23:17:12/14) → wait T1+T2 (returned 23:17:22) → T1-review, T2-review → wait (23:17:36) → T3 [deps T1,T2] at 23:17:42 → wait (23:17:50) → T3-review → wait (23:18:01) → final-review [deps T1-review,T2-review,T3-review] at 23:18:07 → wait (23:18:14) → ask_user ×1.
- **Ordering:** in c2, c3 and c4, T1 and T2 were dispatched and waited on before T3 was dispatched. T3 carried `"depends_on":["T1","T2"]` in all three, for example (c3):
  `"name":"mcp__maestro__dispatch_task","input":{"task_id":"T3","agent":"implementer","depends_on":["T1","T2"],"owns":["greeting.txt"],"prompt":"You are implementing Task 3 of a tiny plan ..."`
  c1 never reached T3, because it stopped on purpose.
- **Review tasks:** this skill version (superpowers 6.4.2) runs one combined "spec compliance + task quality" review per task (agent `spec-reviewer`) plus one final whole-branch `code-reviewer`. There was no separate code review per task. Review `depends_on`: `T1-review` → `["T1"]` (c2 to c4); `final-review` → `["T1","T2","T3","T1-review","T2-review","T3-review"]` (c2, c3) or `["T1-review","T2-review","T3-review"]` (c4).
- **`ask_user`:** c2 and c3 used it for the finishing-a-development-branch menu (with `options` filled in). The stub's `"yes"` made the conductor ask a second time: "Sorry, \"yes\" doesn't tell me which option you want."
- **Bash denials:** the SDD skill tries to run its own helper scripts (`.../skills/subagent-driven-development/scripts/sdd-workspace`, `task-brief`). They were denied in c1, c2 and c3 ("This command requires approval" / "Quoted text in this command can't be checked before it runs"). The conductor then put the task text straight into the dispatch prompts. c4 did not try the scripts (`permission_denials: []`).

**R6, run r6-10min (single run).** The call blocked for the full 10 min and returned normally. Claude emitted its own `tool_progress` heartbeat every 30 s (19 of them); the bridge sent nothing.
```
[+9.7s]   tool_use mcp__maestro__wait_for_tasks {"task_refs":["ref-T1-1"],"mode":"all"}
[+39.7s]  {"type":"tool_progress","tool_use_id":"toolu_01SiQ2…-heartbeat-0","tool_name":"mcp__maestro__wait_for_tasks",...,"elapsed_time_seconds":30,"heartbeat":true,...}
[+609.8s] tool_result ok [{"type":"text","text":"[{\"task_ref\":\"ref-T1-1\",\"status\":\"done\",\"handoff\":\"stub\"}]"}]
[+613.4s] result success turns 3
bridge: 23:10:04.783 wait_for_tasks call … 23:20:04.801 wait_for_tasks return
```
**R6, run r6-30min (single run).** It blocked for the full 30 min and returned normally, with 59 heartbeats and no error:
```
[+9.5s]    tool_use mcp__maestro__wait_for_tasks {"task_refs":["ref-T1-1"],"mode":"all"}
[+1809.5s] tool_result ok [{"type":"text","text":"[{\"task_ref\":\"ref-T1-1\",\"status\":\"done\",\"handoff\":\"stub\"}]"}]
[+1813.4s] result success turns 3 cost 0.00489822
bridge: 23:10:04.573 wait_for_tasks call … 23:40:04.595 wait_for_tasks return
```
**R6, run r6-envtimeout (single run, `MCP_TOOL_TIMEOUT=20000`).** The variable is real. The call was cut off at exactly 20 s, and the bridge's abort signal fired with `SdkError: Request timed out`:
```
[+8.5s]  tool_use mcp__maestro__wait_for_tasks {"task_refs":["ref-T1-1"],"mode":"all"}
[+28.5s] tool_result ERROR "MCP server \"maestro\" tool \"wait_for_tasks\" timed out after 20s"
bridge: 23:41:06.362 wait_for_tasks aborted {"reason":"SdkError: Request timed out"}
```
The model reported the error and did not retry (the prompt told it not to). The session still ended `result success`.

**Strings in the claude 2.1.312 binary (not tested by behaviour):**
- a per-server `"timeout"` field in the MCP config: "Per-server tool-call timeout in milliseconds. Overrides the MCP_TOOL_TIMEOUT environment variable ... Hard wall-clock limit per call; progress notifications do not extend it."
- a separate idle timeout: "... sent no response or progress for …s; aborting. ... set CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT (ms) globally (0 disables)."
- `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`.

The default values of these are unknown. A 30-min silent call tripped neither the hard limit nor the idle timeout.

## Decision for Plan 2
**R1: GO on `dispatch_task`.** It was used in **4 of 4** opus conductor runs (c1 to c4; c2 to c4 are the 3 full-flow runs), with **0** built-in Task/Agent uses of any kind (0 implementation, 0 read-only search), and `conductor.md` was never revised (0 revisions). **The tested setup is `conductor.md` plus the three bridge tool descriptions quoted in What I ran.** The `dispatch_task` one says outright "(use instead of a subagent)". Ship `spikes/r1-conductor/conductor.md` as the start of `prompts/conductor.md`. Plan 2's bridge must keep those descriptions word for word. If either the descriptions or `conductor.md` change, re-run this compliance check (3 opus runs) before relying on the GO. Plan 2 must also handle:
1. **Graph shape.** The conductor creates ad-hoc IDs (`T1-review`, `final-review`, and in c1 `T1-retry`) with agent `spec-reviewer`/`code-reviewer`, and `depends_on` that can name ad-hoc IDs. The bridge must accept new IDs and dependencies on them. SDD 6.4.2 produces one review per task plus one final review, not two reviews per task.
2. **Handoffs must be substantive.** With an empty handoff and no commit/branch, the opus conductor checks git, retries, and then stops (c1). The real `wait_for_tasks` result must include the branch, the commit(s) and the test evidence (§7.2). The conductor checks git itself, so task branches must be visible from the project repo (worktree branches are).
3. **MCP tools are deferred** (loaded through `ToolSearch`). This was harmless in every run. Do not depend on the tools being visible up front.
4. **Conductor permissions.** The SDD helper scripts (`sdd-workspace`, `task-brief`) need Bash. Either allow them through R3's stdio prompt / an `--allowedTools` rule for that script path, or accept the fallback the model chose (task text inlined into the prompt). Read-only `git` ran without prompting.
5. **`ask_user` with `options`** must return one of the options; a free-text answer makes the conductor ask again.

**R6: `wait_for_tasks` blocks for real.** A single silent call lasted 10 min and, in a separate run, 30 min (one run each), and returned normally. No "still running" re-poll is needed, so N = none. Because the default hard limit is unknown and an inherited `MCP_TOOL_TIMEOUT` would apply, Maestro should set the limit explicitly:
- spawn the conductor with `MCP_TOOL_TIMEOUT` set to a large value (for example `86400000`, 24 h);
- and/or set `"timeout"` on the `maestro` entry in `bridge.json` (binary string, untested).

Have the bridge send an MCP progress notification about every 60 s while blocking, as insurance against the idle timeout (untested; the binary says progress resets the idle timer but not the hard limit). On timeout the conductor gets an `is_error` tool_result: `MCP server "maestro" tool "wait_for_tasks" timed out after <N>s`. The bridge sees its abort signal fire (`SdkError: Request timed out`) and must keep the task running; a timeout only means the conductor will call `wait_for_tasks` again.

## Fallback needed?
For R1, no: the SubagentStart/SubagentStop hook fallback is not needed. I would still keep cheap detection: count `Task`/`Agent` tool_use blocks in the conductor stream and show any in the UI.

For R6, no "still running" polling is needed up to 30 min. If a later claude version adds a lower default ceiling, the fallback is to return `{status:"running"}` before the limit and let `conductor.md` tell the model to call again. This is untested.

Limits of this evidence:
- one sample plan, trivial tasks, one model (opus 5.5), claude 2.1.312, superpowers 6.4.2;
- the stub handoffs said "simulated", so the conductor never handled a failed or partial task;
- R6 runs were single runs on haiku, and waits longer than 30 min were not tried.
