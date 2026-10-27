# R3: Permission routing

## Question
Sessions run in `acceptEdits` mode; any other permission request (e.g. `Bash(npm --version)` not in `--allowedTools`) must reach Maestro's inbox and wait for the user. Which mechanism delivers the request, lets the session wait, and takes an allow/deny answer: (A) a `PermissionRequest` hook, (B) an MCP `--permission-prompt-tool`, or (C) `--permission-prompt-tool stdio` over stream-json? (Spec section 15, R3.)

## What I ran
claude 2.1.312 (model `claude-haiku-5-5`), Node v25.2.1, Windows 11, spawned as `claude.exe` with `shell:false` (as in R5). Scratch repo `%TEMP%\maestro-spike-repo`. Prompt in every run: "Use the Bash tool to run exactly: npm --version . Then reply with the version only." with `--permission-mode default`, no `--allowedTools`, `--model haiku`. **Six claude invocations**:
1. `c.ts allow`: Option C. Args `-p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio --permission-mode default --model haiku`; replies allow immediately.
2. `c.ts deny`: same, replies deny immediately.
3. `c.ts wait 125`: same, replies allow after 125 s.
4. `a.ts 10`: Option A. Scratch repo `.claude/settings.json` (written by the script, removed after; verified gone) with a `PermissionRequest` command hook (`hook.mjs`) that appends the stdin payload to `perm.log`, polls for `allow.flag`/`deny.flag`, then prints the decision JSON. Plain `-p ... --output-format stream-json --verbose`, stdin ignored. `allow.flag` written 10 s after start.
5. `b.ts allow`: Option B. `@modelcontextprotocol/sdk` (devDependency) stdio server `mcp-server.mjs` with tool `approve`, `--mcp-config` + `--permission-prompt-tool mcp__spike__approve`, plain `-p`. Returns allow.
6. `b.ts deny`: same, returns deny.

Scripts: `spikes/r3-permissions/{c.ts,a.ts,hook.mjs,b.ts,mcp-server.mjs}`; raw output `out-c-*.jsonl` is git-ignored. Every observation is a **single run** per cell; nothing was repeated.

## Observed
**Option C, run 1 (allow).** Fires: a `control_request` appears on stdout in the same second as the `tool_use` assistant event (+3.0 s) and the session blocks on it:
```
{"type":"control_request","request_id":"3cc5aaf3-b82f-4fdd-8799-f1f21a4c99f0","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"npm --version","description":"Print npm version"},"description":"Print npm version","permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"npm --version"}],"behavior":"allow","destination":"localSettings"}],"decision_reason":"This command requires approval","decision_reason_type":"other","tool_use_id":"toolu_011KaH6NJWkFfeMdWytcaQp3"}}
```
Allow response written to stdin (one line):
```
{"type":"control_response","response":{"subtype":"success","request_id":"3cc5aaf3-b82f-4fdd-8799-f1f21a4c99f0","response":{"behavior":"allow","updatedInput":{"command":"npm --version","description":"Print npm version"}}}}
```
Then the tool ran (`tool_result` "11.7.0 ... is_error:false"), the assistant replied, `result success` with `"permission_denials":[]`, exit 0 after I ended stdin.

**Option C, run 2 (deny).** Response sent:
```
{"type":"control_response","response":{"subtype":"success","request_id":"a8573964-…","response":{"behavior":"deny","message":"Denied by Maestro spike"}}}
```
0.1 s later: `{"type":"tool_result","content":"Denied by Maestro spike","is_error":true,"tool_use_id":"toolu_012WAs9C…"}`; the model then said the command was denied and did not retry; `result success`, exit 0. The `message` is surfaced to the model as the tool_result text.

**Option C, run 3 (wait 125 s).** Request at +3.0 s, reply sent at +128.0 s (2 min 5 s of waiting), no timeout; tool ran at +130.1 s with output `11.7.0`, `result success` at +133.4 s, exit 0 at +134.0 s. Longer waits were not tried; no upper limit was found up to 125 s.

**Option A, run 4.** The hook fires in `-p` mode with `permission_mode:"default"`; the session waited (no tool_result until after the flag): `tool_use` at +3.7 s, `allow.flag` at +10.0 s, `tool_result` at +12.6 s, `result success` at +14.8 s. Hook stdin payload (`perm.log`, one line, abbreviated):
```
{"session_id":"56c44392-…","transcript_path":"C:\\Users\\yoavl\\.claude\\projects\\…\\56c44392-….jsonl","cwd":"C:\\Users\\yoavl\\AppData\\Local\\Temp\\maestro-spike-repo","scratchpad_dir":"…","prompt_id":"3e4bbdc1-…","permission_mode":"default","effort":{"level":"medium"},"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"npm --version","description":"Print npm version"},"permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"npm --version"}],"behavior":"allow","destination":"localSettings"}]}
```
Hook stdout that allowed it: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`. The deny shape (`"decision":{"behavior":"deny","message":"..."}`) is in `hook.mjs` but **was not run**. The payload has no `tool_use_id`. Only a 10 s wait was tested; the hook timeout was **not** tested (no `timeout` set in settings).

**Option B, run 5 (allow).** `init` listed `{"name":"spike","status":"connected","source":"dynamic"}`. The tool received (MCP log):
```
APPROVE INPUT {"tool_name":"Bash","input":{"command":"npm --version","description":"Print npm version"},"tool_use_id":"toolu_017oYKhi6LArGvs8vDS1RhEN"}
APPROVE RESPOND {"behavior":"allow","updatedInput":{"command":"npm --version","description":"Print npm version"}}
```
returned as `{"content":[{"type":"text","text":"<that JSON as a string>"}]}`. Tool ran, `result success`.

**Option B, run 6 (deny).** Returned text `{"behavior":"deny","message":"Denied by MCP spike"}`; `tool_result` `"Denied by MCP spike"`, `is_error:true`; no retry. Wait time for B was not tested beyond an immediate reply, and the MCP tool-call timeout was not probed.

## Decision for Plan 2
**Use Option C (`--permission-prompt-tool stdio`)**, since the runner already owns stdio. Add `--permission-prompt-tool stdio` to the spawn args from R2 (`-p --input-format stream-json --output-format stream-json --verbose --replay-user-messages ... --permission-mode acceptEdits`).
- Request (stdout): `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"can_use_tool","tool_name","display_name","input":{…},"description","permission_suggestions":[…],"decision_reason","decision_reason_type","tool_use_id"}}`. Store `request_id`, `tool_use_id`, `tool_name`, `input` in the inbox; the session is blocked until answered.
- Allow (stdin): `{"type":"control_response","response":{"subtype":"success","request_id":"<same>","response":{"behavior":"allow","updatedInput":<input object, echoed or edited>}}}`
- Deny (stdin): `{"type":"control_response","response":{"subtype":"success","request_id":"<same>","response":{"behavior":"deny","message":"<text shown to the model>"}}}`
- Waiting: 125 s worked (single run); the session simply blocks. The real ceiling is unknown, so Plan 2 should either test a longer wait or treat a dead process as failed and offer resume (R2).
- Parser: `control_request` is a new top-level `type`; dispatch on `request.subtype`; only `can_use_tool` was seen. `permission_suggestions` could feed an "always allow" button, but replying with them was **not** tested.
- Not tested for C: `acceptEdits` mode combined with stdio (I only ran `default`), parallel tool calls producing concurrent requests, interrupt while a request is pending, non-Bash tools.

## Fallback needed?
No, Option C worked end to end. If a later claude version breaks it, Option A (hook; payload and allow output above; needs a per-session settings file and a second channel back to Maestro) and Option B (MCP; input and text-JSON response above; needs a server process) each worked in a single run. Neither was tested with a long wait, and A's hook timeout is unknown.
