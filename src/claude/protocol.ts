export interface TokenUsage { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface UsageWindow { utilization: number; resetsAt: number }

export type StreamEvent =
  | { kind: 'init'; sessionId: string; model: string; cwd: string; tools: string[]; permissionMode: string; cliVersion?: string }
  | { kind: 'assistant'; text: string; toolUses: { id: string; name: string; input: unknown }[]; parentToolUseId: string | null }
  | { kind: 'user-echo'; text: string }
  | { kind: 'tool-result'; toolUseId: string; isError: boolean }
  | { kind: 'interrupt-marker' }
  | { kind: 'result'; ok: boolean; subtype: string; terminalReason: string | null; text: string | null; sessionId: string; usage: TokenUsage }
  | { kind: 'permission-request'; requestId: string; toolName: string; input: unknown; toolUseId: string; description: string | null }
  | { kind: 'permission-cancel'; requestId: string }
  | { kind: 'control-response'; requestId: string; ok: boolean }
  | { kind: 'rate-limit'; status: string; resetsAt: number | null; fiveHour: UsageWindow | null; sevenDay: UsageWindow | null }
  | { kind: 'unknown'; type: string; subtype: string | null };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function tokenUsage(r: Obj): TokenUsage {
  const since = r.model_usage_since_last_result;
  if (isObj(since)) {
    const t: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const m of Object.values(since)) {
      if (!isObj(m)) continue;
      t.input += num(m.inputTokens);
      t.output += num(m.outputTokens);
      t.cacheRead += num(m.cacheReadInputTokens);
      t.cacheWrite += num(m.cacheCreationInputTokens);
    }
    return t;
  }
  const u = isObj(r.usage) ? r.usage : {};
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
  };
}

function window(v: unknown): UsageWindow | null {
  if (!isObj(v) || typeof v.utilization !== 'number' || typeof v.resetsAt !== 'number') return null;
  return { utilization: v.utilization, resetsAt: v.resetsAt };
}

const INTERRUPT_TEXT = '[Request interrupted by user';

/** Parse one stream-json stdout line. Returns null for blank or invalid JSON; never throws. */
export function parseEvent(line: string): StreamEvent | null {
  if (line.trim() === '') return null;
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!isObj(raw) || typeof raw.type !== 'string') return null;
  const type = raw.type;
  const subtype = strOrNull(raw.subtype);
  const unknown: StreamEvent = { kind: 'unknown', type, subtype };

  switch (type) {
    case 'system': {
      if (subtype !== 'init') return unknown;
      const ev: StreamEvent = {
        kind: 'init',
        sessionId: str(raw.session_id),
        model: str(raw.model),
        cwd: str(raw.cwd),
        tools: arr(raw.tools).filter((t): t is string => typeof t === 'string'),
        permissionMode: str(raw.permissionMode),
      };
      const v = strOrNull(raw.claude_code_version);
      if (v) ev.cliVersion = v;
      return ev;
    }
    case 'assistant': {
      const msg = isObj(raw.message) ? raw.message : {};
      let text = '';
      const toolUses: { id: string; name: string; input: unknown }[] = [];
      for (const b of arr(msg.content)) {
        if (!isObj(b)) continue;
        if (b.type === 'text' && typeof b.text === 'string') text += b.text;
        else if (b.type === 'tool_use') toolUses.push({ id: str(b.id), name: str(b.name), input: b.input });
      }
      return { kind: 'assistant', text, toolUses, parentToolUseId: strOrNull(raw.parent_tool_use_id) };
    }
    case 'user': {
      const content = isObj(raw.message) ? raw.message.content : undefined;
      if (typeof content === 'string') return { kind: 'user-echo', text: content };
      for (const b of arr(content)) {
        if (!isObj(b)) continue;
        if (b.type === 'tool_result') return { kind: 'tool-result', toolUseId: str(b.tool_use_id), isError: b.is_error === true };
      }
      for (const b of arr(content)) {
        if (isObj(b) && b.type === 'text' && str(b.text).startsWith(INTERRUPT_TEXT)) return { kind: 'interrupt-marker' };
      }
      return unknown;
    }
    case 'result': {
      return {
        kind: 'result',
        ok: subtype === 'success' && raw.is_error !== true,
        subtype: subtype ?? '',
        terminalReason: strOrNull(raw.terminal_reason),
        text: strOrNull(raw.result),
        sessionId: str(raw.session_id),
        usage: tokenUsage(raw),
      };
    }
    case 'control_request': {
      const req = raw.request;
      if (!isObj(req) || req.subtype !== 'can_use_tool') return unknown;
      return {
        kind: 'permission-request',
        requestId: str(raw.request_id),
        toolName: str(req.tool_name),
        input: req.input,
        toolUseId: str(req.tool_use_id),
        description: strOrNull(req.description),
      };
    }
    case 'control_cancel_request':
      return { kind: 'permission-cancel', requestId: str(raw.request_id) };
    case 'control_response': {
      const r = isObj(raw.response) ? raw.response : {};
      return { kind: 'control-response', requestId: str(r.request_id), ok: r.subtype === 'success' };
    }
    case 'rate_limit_event': {
      const info = isObj(raw.rate_limit_info) ? raw.rate_limit_info : {};
      const w = isObj(info.unifiedWindows) ? info.unifiedWindows : {};
      return {
        kind: 'rate-limit',
        status: str(info.status),
        resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : null,
        fiveHour: window(w.five_hour),
        sevenDay: window(w.seven_day),
      };
    }
    default:
      return unknown;
  }
}

export function encodeUserMessage(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }) + '\n';
}

export function encodeInterrupt(requestId: string): string {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } }) + '\n';
}

export function encodePermissionAllow(requestId: string, input: unknown): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput: input } },
  }) + '\n';
}

export function encodePermissionDeny(requestId: string, message: string): string {
  return JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message } },
  }) + '\n';
}

/** Body of the last "## Handoff" section (to the next "## " heading or end), ignoring fenced code. */
export function lastHandoff(text: string): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let fence: string | null = null;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (/^## Handoff\s*$/.test(line)) { start = i; end = lines.length; }
    else if (start >= 0 && /^## /.test(line) && end === lines.length) end = i;
  }
  if (start < 0) return null;
  return lines.slice(start + 1, end).join('\n').trim();
}
