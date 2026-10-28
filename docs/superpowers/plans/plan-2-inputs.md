# Inputs for Plan 2 (from Plan 1's final review, 2026-10-28)

Decisions Plan 2 must make explicitly, where spike findings contradict or extend the spec. Sources: `docs/superpowers/spikes/2026-10-28-*.md`.

1. **Tool restriction:** `--allowedTools` did not restrict tools (R2: Glob ran under `--allowedTools Bash`). Spec §8.1/§13 rely on it for role tool lists. Use `--disallowedTools` / `--tools` and verify read-only roles can't edit under `acceptEdits`.
2. **Stop/pause:** SIGINT on Windows kills only the root and orphans the tool tree (R5). Replace with the stdin `control_request` interrupt (R2), `taskkill /PID <pid> /T /F` as fallback. Pick one fallback delay (R2 suggests 5 s, spec §8.3 says 10 s). Tree cleanup after interrupt is unverified — the runner checks its own tree.
3. **Interrupted state:** task machine has no `interrupted`/`paused` state; spec §8.3 "Pause now" and §12 "stuck → Interrupt" need one (R2: interrupted process stays alive). Decide: keep process idle, or kill + `--resume`.
4. **`waiting` is overloaded:** "not dispatched yet" vs "deps not done". R1: the conductor decides when to dispatch. Add a `planned` state or dispatched flag, and decide whose prompt wins (plan body vs `dispatch_task` prompt).
5. **Ad-hoc task IDs** (R1: `T1-review`, `final-review`) vs "Task keys are T<n>": tasks without a plan version, ownership checks for mid-run dispatch, worktree path length (R5: < ~200 chars).
6. **Re-plans:** spec §6 keeps Done tasks Done; `insertPlan` inserts everything as `waiting` — carry Done over by key.
7. **Rate limits:** `api_retry` never observed; R2 found `rate_limit_event` with `status`, `resetsAt`, `unifiedWindows`. Use `resetsAt` as `throttledUntil`, exponential backoff only as fallback. Update spec §3: Home CAN show the 5-hr figure.
8. **Usage accounting:** define whether `tokens_in` includes cache creation/read tokens; verify whether `usage`/`modelUsage` are cumulative across results in a long-lived process (`model_usage_since_last_result` exists) before `addUsage` per result; parser drops `total_cost_usd`/`costUSD`.
9. **Task completion:** a `result` ends a turn, not the session. Define "complete" (e.g. successful `result` with `## Handoff`, then Maestro closes stdin). Don't assume one result per message.
10. **Permission inbox:** add expired/dismissed inbox state (cancelled task, dead process); multiple open requests per task (derive `needs_you` from open entries); store "always allow for this mission" in Maestro, not via `permission_suggestions` (may write `.claude/settings.local.json` into the worktree); verify stdio prompts with `acceptEdits` and interrupt-while-pending.
11. **Task-session questions:** spec §5.2 says `ask_user` puts a task in NeedsYou, but §8.1 starts tasks without `--mcp-config`. Give task sessions the bridge, or define task questions as permission requests/messages only.
12. **Conductor permissions:** give the conductor `--permission-prompt-tool stdio` too (R1's Bash calls were auto-denied), inbox entries with `task_id NULL`. `MCP_TOOL_TIMEOUT` (set explicitly, large) also covers `submit_plan`; make `submit_plan` and `wait_for_tasks` idempotent for re-calls after a timeout.
13. **Ending a mission:** add a "finished without merge" event (keep branch); trigger `finishing` from a conductor signal, not `all_tasks_done` (ad-hoc review/fix tasks come after plan tasks).
14. **`ask_user` with options** must return exactly one option (R1); inbox UI and stored answer enforce it.
15. **R1 re-check:** re-run the 3-run compliance check once the real bridge returns real handoffs, before relying on GO; keep the bridge tool descriptions from `spikes/r1-conductor/bridge.ts` verbatim.
16. **Dependency versions:** installed TypeScript ^7, Vitest ^4, better-sqlite3 ^13 (plan said 5/2/11); run the suite once on Node 22 LTS. `schema.sql`/migrations must ship with any `dist/` build.
