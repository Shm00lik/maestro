import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  parseEvent, encodeUserMessage, encodeInterrupt, encodePermissionAllow, encodePermissionDeny, lastHandoff,
  type StreamEvent,
} from '../../src/claude/protocol.js';

const lines = (name: string): string[] =>
  readFileSync(new URL(`../fixtures/stream/${name}.jsonl`, import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n').split('\n').filter(l => l.trim() !== '');
const first = (name: string): StreamEvent => parseEvent(lines(name)[0])!;
const all = (name: string): StreamEvent[] => lines(name).map(l => parseEvent(l)!);

describe('parseEvent', () => {
  it('parses every fixture into its kind', () => {
    const expected: Record<string, string[]> = {
      'init': ['init'],
      'assistant': ['assistant', 'assistant', 'assistant'],
      'user-echo': ['user-echo'],
      'user-tool': ['tool-result', 'tool-result', 'interrupt-marker'],
      'result-ok': ['result'],
      'result-usage-only': ['result'],
      'result-interrupted': ['result'],
      'control-response': ['control-response'],
      'can-use-tool': ['permission-request'],
      'permission-cancel': ['permission-cancel'],
      'rate-limit': ['rate-limit'],
      'unknown': ['unknown', 'unknown', 'unknown', 'unknown'],
    };
    for (const [name, kinds] of Object.entries(expected)) expect(all(name).map(e => e.kind), name).toEqual(kinds);
  });

  it('init', () => {
    expect(first('init')).toEqual({
      kind: 'init', sessionId: '3b637c25-ffcc-4605-99f5-d6f4c9075042', model: 'claude-haiku-5-5',
      cwd: 'C:\\Users\\yoavl\\AppData\\Local\\Temp\\maestro-spike-repo',
      tools: ['Task', 'Artifact', 'Bash', 'Glob', 'Read', 'Write'], permissionMode: 'default', cliVersion: '2.1.312',
    });
  });

  it('assistant text and tool uses', () => {
    const [thinking, toolTurn, text] = all('assistant');
    expect(thinking).toEqual({ kind: 'assistant', text: '', toolUses: [], parentToolUseId: null });
    expect(toolTurn).toEqual({
      kind: 'assistant', text: 'Listing files.', parentToolUseId: null,
      toolUses: [{ id: 'toolu_018vtQoAyayacZn6K97RaGFZ', name: 'Glob', input: { pattern: '*', path: 'C:\\repo' } }],
    });
    expect(text).toMatchObject({ text: 'Done.' });
  });

  it('user echo, tool results and interrupt marker', () => {
    expect(first('user-echo')).toEqual({ kind: 'user-echo', text: 'List the files here, then wait.' });
    const [ok, err, marker] = all('user-tool');
    expect(ok).toEqual({ kind: 'tool-result', toolUseId: 'toolu_018vtQoAyayacZn6K97RaGFZ', isError: false });
    expect(err).toEqual({ kind: 'tool-result', toolUseId: 'toolu_01Bu1V3C', isError: true });
    expect(marker).toEqual({ kind: 'interrupt-marker' });
  });

  it('result ok sums model_usage_since_last_result over models', () => {
    expect(first('result-ok')).toEqual({
      kind: 'result', ok: true, subtype: 'success', terminalReason: 'completed',
      text: 'Line counts for all 29 files.\n\n## Handoff\nDone.',
      sessionId: '3b637c25-ffcc-4605-99f5-d6f4c9075042',
      usage: { input: 6, output: 1348, cacheRead: 96237, cacheWrite: 50579 },
    });
  });

  it('result falls back to result.usage and never uses iterations', () => {
    expect(first('result-usage-only')).toMatchObject({
      ok: true, usage: { input: 2, output: 246, cacheRead: 31784, cacheWrite: 14955 },
    });
  });

  it('result with missing numbers counts 0', () => {
    const e = parseEvent(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's', usage: { input_tokens: 3 } }));
    expect(e).toMatchObject({ kind: 'result', text: null, terminalReason: null, usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 } });
  });

  it('result interrupted', () => {
    expect(first('result-interrupted')).toMatchObject({
      kind: 'result', ok: false, subtype: 'error_during_execution', terminalReason: 'aborted_tools', text: null,
      sessionId: '7397b5e7-a801-442e-98f0-bfaad9f6e960',
    });
  });

  it('permission request, cancel, control response, rate limit', () => {
    expect(first('can-use-tool')).toEqual({
      kind: 'permission-request', requestId: '3cc5aaf3-b82f-4fdd-8799-f1f21a4c99f0', toolName: 'Bash',
      input: { command: 'npm --version', description: 'Print npm version' },
      toolUseId: 'toolu_011KaH6NJWkFfeMdWytcaQp3', description: 'Print npm version',
    });
    expect(first('permission-cancel')).toEqual({ kind: 'permission-cancel', requestId: 'c92c218f-42d8-4342-ac21-07dff2740f7f' });
    expect(first('control-response')).toEqual({ kind: 'control-response', requestId: 'int-1', ok: true });
    expect(first('rate-limit')).toEqual({
      kind: 'rate-limit', status: 'allowed', resetsAt: 1793143200,
      fiveHour: { utilization: 0.48, resetsAt: 1793143200 }, sevenDay: { utilization: 0.21, resetsAt: 1793401200 },
    });
  });

  it('drops cost fields', () => {
    for (const n of ['result-ok', 'result-usage-only', 'result-interrupted']) {
      expect(JSON.stringify(first(n)), n).not.toMatch(/cost/i);
    }
  });

  it('ignores unknown types, subtypes and extra keys', () => {
    expect(all('unknown')).toEqual([
      { kind: 'unknown', type: 'task_summary', subtype: null },
      { kind: 'unknown', type: 'tool_progress', subtype: null },
      { kind: 'unknown', type: 'system', subtype: 'hook_started' },
      { kind: 'unknown', type: 'system', subtype: 'thinking_tokens' },
    ]);
    expect(parseEvent('{"type":"stream_event","event":{}}')).toEqual({ kind: 'unknown', type: 'stream_event', subtype: null });
    expect(parseEvent('{"type":"system","subtype":"api_retry"}')).toEqual({ kind: 'unknown', type: 'system', subtype: 'api_retry' });
    expect(() => parseEvent('{"type":"assistant","extra":1}')).not.toThrow();
    expect(() => parseEvent('{"type":"result"}')).not.toThrow();
    expect(() => parseEvent('{"type":"control_request","request":null}')).not.toThrow();
    expect(parseEvent('{"type":"control_request","request":{"subtype":"other"}}')).toMatchObject({ kind: 'unknown' });
  });

  it('returns null for blank or invalid lines', () => {
    for (const l of ['', '   ', '\n', 'not json', '{"type":', '[1]', '42', 'null', '{}']) {
      expect(parseEvent(l), JSON.stringify(l)).toBeNull();
    }
  });
});

describe('encoders', () => {
  const rt = (s: string): unknown => {
    expect(s.endsWith('\n')).toBe(true);
    expect(s.slice(0, -1)).not.toContain('\n');
    return JSON.parse(s);
  };
  it('encodes stdin messages exactly as the spikes recorded', () => {
    expect(rt(encodeUserMessage('hi\nthere'))).toEqual({ type: 'user', message: { role: 'user', content: 'hi\nthere' }, parent_tool_use_id: null });
    expect(rt(encodeInterrupt('int-1'))).toEqual({ type: 'control_request', request_id: 'int-1', request: { subtype: 'interrupt' } });
    const input = { command: 'npm --version', description: 'Print npm version' };
    expect(rt(encodePermissionAllow('r1', input))).toEqual({
      type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'allow', updatedInput: input } },
    });
    expect(rt(encodePermissionDeny('r1', 'Denied'))).toEqual({
      type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'deny', message: 'Denied' } },
    });
  });
});

describe('lastHandoff', () => {
  it('finds the last ## Handoff section and ignores one inside a code fence', () => {
    const text = [
      '## Handoff', 'first', '',
      '## Other', 'x', '',
      '## Handoff', 'second line', 'more', '',
      '```md', '## Handoff', 'fenced', '```', '',
      '~~~', '## Done', '~~~',
      '## Next', 'after',
    ].join('\n');
    expect(lastHandoff(text)).toBe('second line\nmore\n\n```md\n## Handoff\nfenced\n```\n\n~~~\n## Done\n~~~');
  });
  it('runs to the end when no later heading, handles CRLF, null when absent', () => {
    expect(lastHandoff('intro\n## Handoff\r\nbody\r\nend')).toBe('body\nend');
    expect(lastHandoff('no heading\n```\n## Handoff\nx\n```')).toBeNull();
    expect(lastHandoff('')).toBeNull();
  });
});
